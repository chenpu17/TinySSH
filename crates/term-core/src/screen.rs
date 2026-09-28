//! Screen：会话屏幕真源（网格 + 命令块 + cwd + 无损缓冲 + exec 输出捕获）。
//! 非 Sync；由 core-session 以 Mutex 持有，feed 来自传输 pump 任务。

use crate::block::{BlockIndex, BlockSource};
#[allow(unused_imports)]
use crate::block::BlockPhase;
use crate::osc::{OscEvent, OscScanner};
use crate::render::{GridSize, cursor_pos, render_screen_only, render_text};
use crate::strip_ansi;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct ScreenConfig {
    pub cols: u16,
    pub rows: u16,
    pub scrollback: usize,
    /// 无损环形缓冲上限（字节，渲染后文本）。
    pub lossless_cap: usize,
}

impl Default for ScreenConfig {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 32,
            scrollback: 10_000,
            lossless_cap: 8 * 1024 * 1024,
        }
    }
}

/// 无损缓冲条目：渲染后文本 + 时间戳（wait_output 静默期判定用）。
#[derive(Debug, Clone)]
struct LosslessChunk {
    ts: DateTime<Utc>,
    text: String,
}

/// Shell 模式 exec 的输出捕获状态。
#[derive(Debug)]
struct CaptureState {
    exec_id: String,
    armed: bool,
    active: bool,
    text: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct TermEventListener;
impl EventListener for TermEventListener {}

pub struct Screen {
    config: ScreenConfig,
    term: Term<TermEventListener>,
    processor: vte::ansi::Processor,
    scanner: OscScanner,
    pub blocks: BlockIndex,
    lossless: VecDeque<LosslessChunk>,
    lossless_bytes: usize,
    /// 有新无损内容时 notify。
    lossless_notify: std::sync::Arc<tokio::sync::Notify>,
    cwd: Option<String>,
    cwd_ts: Option<DateTime<Utc>>,
    capture: Option<CaptureState>,
    /// 捕获完成通知（exec_id）。
    capture_tx: tokio::sync::broadcast::Sender<String>,
    /// 曾收到 OSC 133（判断主机是否注入 shell 集成）。
    saw_133: bool,
    /// 重置型就绪信号：重连后等首个 B 标记（见 prompt_ready）。
    saw_prompt: bool,
    last_output_ts: Option<DateTime<Utc>>,
}

use std::collections::VecDeque;

impl Screen {
    pub fn new(config: ScreenConfig) -> Self {
        let size = GridSize {
            cols: config.cols as usize,
            rows: config.rows as usize,
            scrollback: config.scrollback,
        };
        let term = Term::new(Config::default(), &size, TermEventListener);
        let (capture_tx, _) = tokio::sync::broadcast::channel(64);
        Self {
            config,
            term,
            processor: vte::ansi::Processor::new(),
            scanner: OscScanner::new(),
            blocks: BlockIndex::new(),
            lossless: VecDeque::new(),
            lossless_bytes: 0,
            lossless_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            cwd: None,
            cwd_ts: None,
            capture: None,
            capture_tx,
            saw_133: false,
            saw_prompt: false,
            last_output_ts: None,
        }
    }

    pub fn config(&self) -> &ScreenConfig {
        &self.config
    }

    /// 主输入口：pump 任务把传输原始字节送进来。
    pub fn feed(&mut self, data: &[u8]) {
        let now = Utc::now();
        self.processor.advance(&mut self.term, data);
        let current_line = self.last_grid_line();

        let events = self.scanner.feed(data);
        let mut cap_active = self.capture.as_ref().map(|c| c.active).unwrap_or(false);
        let mut cap_armed = self.capture.as_ref().map(|c| c.armed).unwrap_or(false);
        let mut last_off = 0usize;

        for (ev, end_off) in events.iter().map(|(e, o)| (e.clone(), *o)) {
            // 捕获激活期间：上一事件结束到本事件结束之间的字节属于输出
            if cap_active {
                if let Some(cap) = self.capture.as_mut() {
                    cap.text.extend_from_slice(&data[last_off..end_off.min(data.len())]);
                }
            }
            match ev {
                OscEvent::Cwd { path } => {
                    self.cwd = Some(path);
                    self.cwd_ts = Some(now);
                }
                OscEvent::OutputStart => {
                    self.saw_133 = true;
                    if cap_armed && !cap_active {
                        cap_active = true;
                        if let Some(cap) = self.capture.as_mut() {
                            cap.active = true;
                            cap.text.clear();
                        }
                    }
                    self.blocks.on_osc(&ev, now, current_line);
                }
                OscEvent::PromptStart => {
                    self.saw_133 = true;
                    self.saw_prompt = true;
                    self.blocks.on_osc(&ev, now, current_line);
                }
                OscEvent::CommandDone { exit } => {
                    let finishing = cap_active;
                    let done_exec = self.capture.as_ref().map(|c| c.exec_id.clone());
                    if cap_active {
                        cap_active = false;
                        if let Some(cap) = self.capture.as_mut() {
                            cap.active = false;
                            let _ = self.capture_tx.send(cap.exec_id.clone());
                        }
                    }
                    self.blocks.on_osc(&ev, now, current_line);
                    // 捕获归属：把 exec_id 挂到刚闭合的块上，并记录退出码
                    if finishing {
                        if let Some(exec) = done_exec {
                            if let Some(b) = self.blocks.blocks.last_mut() {
                                if b.exec_id.is_none() {
                                    b.exec_id = Some(exec);
                                }
                            }
                        }
                    }
                    let _ = exit;
                }
                other => {
                    self.blocks.on_osc(&other, now, current_line);
                }
            }
            last_off = end_off;
        }

        // 尾部仍激活：剩余字节全是输出
        if cap_active && last_off < data.len() {
            if let Some(cap) = self.capture.as_mut() {
                cap.text.extend_from_slice(&data[last_off..]);
            }
        }
        if cap_active {
            if let Some(cap) = self.capture.as_mut() {
                if cap.text.len() > self.config.lossless_cap {
                    let drop = cap.text.len() / 2;
                    cap.text.drain(..drop);
                }
            }
        }

        // 无损缓冲（渲染后文本）
        let text = strip_ansi(data);
        if !text.is_empty() {
            self.push_lossless(LosslessChunk { ts: now, text });
            self.last_output_ts = Some(now);
            self.lossless_notify.notify_waiters();
        }
    }

    fn push_lossless(&mut self, chunk: LosslessChunk) {
        self.lossless_bytes += chunk.text.len();
        self.lossless.push_back(chunk);
        while self.lossless_bytes > self.config.lossless_cap {
            if let Some(front) = self.lossless.pop_front() {
                self.lossless_bytes -= front.text.len();
            } else {
                break;
            }
        }
    }

    /// 核心向通路写键前的登记：命令文本归因 + B→C 键入捕获。
    pub fn register_outgoing(&mut self, data: &[u8], source: BlockSource) {
        self.blocks.attribute_write(source);
        self.blocks.on_write(data);
    }

    /// Shell 模式 exec：预登记捕获（写入命令前调用）。
    pub fn arm_capture(&mut self, exec_id: &str) {
        self.capture = Some(CaptureState {
            exec_id: exec_id.to_string(),
            armed: true,
            active: false,
            text: Vec::new(),
        });
    }

    /// Shell 模式 exec：直接打开受管块（写入命令同时调用；命令文本受管提供）。
    pub fn open_managed_block(&mut self, command: &str, source: BlockSource, exec_id: &str) {
        let line = self.last_grid_line();
        self.blocks
            .open_managed(command, source, Some(exec_id.to_string()), Utc::now(), line);
    }

    /// 取走某个 exec 的捕获输出（块收尾后调用）。
    pub fn take_capture(&mut self, exec_id: &str) -> Option<Vec<u8>> {
        if let Some(cap) = self.capture.as_ref() {
            if cap.exec_id == exec_id && !cap.active {
                let cap = self.capture.take().unwrap();
                return Some(cap.text);
            }
        }
        None
    }

    pub fn subscribe_capture(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.capture_tx.subscribe()
    }

    /// Fresh 镜像回放：把结构化结果组装为带 Agent 标注的块写入屏幕（L1 §3.1 不可省略）。
    pub fn replay_fresh(
        &mut self,
        command: &str,
        client_id: Option<&str>,
        stdout: &str,
        stderr: &str,
        exit_code: i32,
        exec_id: &str,
    ) {
        let who = match client_id {
            Some(c) => format!("agent:{c}"),
            None => "agent".to_string(),
        };
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x1b]133;A\x07");
        let head = format!("[{who}] $ {command}\r\n");
        bytes.extend_from_slice(head.as_bytes());
        // 打开受管块（command 文本 = 回放首行，带标注）
        self.open_managed_block(&head, BlockSource::Replay { client_id: client_id.map(|s| s.to_string()) }, exec_id);
        bytes.extend_from_slice(b"\x1b]133;C\x07");
        if !stdout.is_empty() {
            bytes.extend_from_slice(stdout.as_bytes());
            if !stdout.ends_with('\n') {
                bytes.push(b'\n');
            }
        }
        if !stderr.is_empty() {
            bytes.extend_from_slice(b"[stderr] ");
            bytes.extend_from_slice(stderr.as_bytes());
            if !stderr.ends_with('\n') {
                bytes.push(b'\n');
            }
        }
        let tail = format!("\x1b]133;D;{exit_code}\x07");
        bytes.extend_from_slice(tail.as_bytes());
        self.feed(&bytes);
    }

    pub fn snapshot_text(&self) -> String {
        render_text(&self.term)
    }

    /// 仅可见屏（不含 scrollback）。read_screen 的语义是"当前屏幕"——
    /// 含历史会把清屏前的旧内容（如集成注入回显）重新带回答户端。
    pub fn screen_only_text(&self) -> String {
        render_screen_only(&self.term)
    }

    pub fn cursor(&self) -> (u16, u16) {
        cursor_pos(&self.term)
    }

    pub fn alt_screen(&self) -> bool {
        use alacritty_terminal::term::TermMode;
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.config.cols = cols;
        self.config.rows = rows;
        let size = GridSize {
            cols: cols as usize,
            rows: rows as usize,
            scrollback: self.config.scrollback,
        };
        self.term.resize(size);
    }

    pub fn cwd(&self) -> Option<&String> {
        self.cwd.as_ref()
    }

    pub fn cwd_ts(&self) -> Option<DateTime<Utc>> {
        self.cwd_ts
    }

    pub fn invalidate_cwd(&mut self) {
        // 重连后：cwd 事实降级（core 决定语义），此处清空 OSC7 缓存
        self.cwd = None;
        self.cwd_ts = None;
    }

    /// 主机是否已注入 OSC 133 shell 集成。
    pub fn shell_integration_present(&self) -> bool {
        self.saw_133
    }

    /// 新 shell 的首个提示符（OSC 133 B）是否已出现。
    /// 重注入的就绪信号：B 晚于清屏字节的执行与渲染，等到它 = 片段已跑完、屏已清、提示符已出。
    /// （C 标记先于清屏执行，只等 C 会截到清屏前的回显尾巴。）
    pub fn prompt_ready(&self) -> bool {
        self.saw_prompt
    }

    /// 重连后重置集成标记：不重置则旧连接的 saw_133 粘滞——重注入的就绪等待
    /// 立即放行（新 shell 未必就绪）、run_shell 也会误判可用。
    pub fn reset_integration_tracking(&mut self) {
        self.saw_133 = false;
        self.saw_prompt = false;
    }

    pub fn last_output_ts(&self) -> Option<DateTime<Utc>> {
        self.last_output_ts
    }

    // ---- wait_output 支撑（无锁协议：core-session 短锁轮询 + notify）----

    /// 无损缓冲当前长度（水位）。
    pub fn lossless_len(&self) -> usize {
        self.lossless.len()
    }

    /// 自水位以来的新增渲染文本。
    pub fn text_since(&self, watermark: usize) -> String {
        self.lossless
            .iter()
            .skip(watermark)
            .map(|c| c.text.as_str())
            .collect()
    }

    /// 缓冲尾时间戳（静默期判定）。
    pub fn tail_ts(&self) -> Option<DateTime<Utc>> {
        self.lossless.iter().next_back().map(|c| c.ts)
    }

    /// 新内容通知句柄（clone 后在锁外 await）。
    pub fn lossless_notify(&self) -> std::sync::Arc<tokio::sync::Notify> {
        self.lossless_notify.clone()
    }

    /// 屏幕末尾几行（简报摘要用）。
    pub fn screen_tail_summary(&self, lines: usize) -> String {
        let text = render_text(&self.term);
        let collected: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = collected.len().saturating_sub(lines);
        collected[start..].join(" | ")
    }

    fn last_grid_line(&self) -> i32 {
        // 光标所在 grid 绝对行号（Line 坐标，0=屏底）
        let p = self.term.renderable_content().cursor.point;
        p.line.0
    }
}

pub fn quiet_dur(quiet_ms: u64) -> std::time::Duration {
    std::time::Duration::from_millis(quiet_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Screen {
        Screen::new(ScreenConfig {
            cols: 80,
            rows: 24,
            scrollback: 100,
            lossless_cap: 1 << 20,
        })
    }

    #[test]
    fn snapshot_renders_text() {
        let mut s = screen();
        s.feed(b"hello world\r\n");
        s.feed(b"second line\r\n");
        let snap = s.snapshot_text();
        assert!(snap.contains("hello world"));
        assert!(snap.contains("second line"));
    }

    #[test]
    fn osc7_cwd_recorded() {
        let mut s = screen();
        s.feed(b"\x1b]7;file://h/tmp/x\x07");
        assert_eq!(s.cwd().map(|s| s.as_str()), Some("/tmp/x"));
    }

    #[test]
    fn shell_mode_capture() {
        let mut s = screen();
        s.arm_capture("e1");
        // 模拟注入 shell：A/B → 命令 → C → 输出 → D
        s.open_managed_block("echo hi", BlockSource::Agent { client_id: "cc".into() }, "e1");
        s.feed(b"\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07");
        // C 到达时块已在 Output 态，捕获激活；D 收尾
        let out = s.take_capture("e1").expect("capture should complete");
        assert_eq!(strip_ansi(&out).trim(), "hi");
    }

    #[test]
    fn replay_fresh_block() {
        let mut s = screen();
        s.replay_fresh("docker ps", Some("cc"), "CONTAINER…", "", 0, "e2");
        let blocks = s.blocks.last_blocks(1);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, BlockSource::Replay { client_id: Some("cc".into()) });
        assert_eq!(blocks[0].exit_code, Some(0));
        assert!(s.snapshot_text().contains("[agent:cc] $ docker ps"));
    }
}
