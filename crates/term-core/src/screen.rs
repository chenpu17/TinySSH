//! Screen：会话屏幕真源（网格 + 命令块 + cwd + 无损缓冲 + exec 输出捕获）。
//! 非 Sync；由 core-session 以 Mutex 持有，feed 来自传输 pump 任务。

use crate::block::{BlockIndex, BlockSource};
#[allow(unused_imports)]
use crate::block::BlockPhase;
use crate::osc::{OscEvent, OscScanner};
use crate::render::{GridSize, cursor_pos, render_screen_only, render_text};
use crate::strip_ansi;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte;
use alacritty_terminal::vte::ansi::{Color as VteColor, NamedColor};
use session_api::{
    BufferCheckpoint, CellRun, ColorSpec, CursorState, ScreenCheckpoint, ScreenModes,
    cell_flags,
};
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
/// Windows ConPTY 流序（2026-10-12 实测）：conhost 把 OSC 标记即时转发、把文本攒进
/// 渲染缓冲按帧刷出——D 标记可先于命令输出到达（C→D 窗为空，文本落在 D 之后、下一
/// 提示符 B 之前的重绘帧里，回显随帧混入）。故 D 不终结捕获：转 tail 继续收集到下一
/// 个 B（提示符文本在 B 之后，天然切界）；B 不来由 pump 静默兜底收口。取数时 text
/// 非空用 text（unix/快路径，与旧语义一致），text 空 则用 tail（调用方剥回显行）。
#[derive(Debug)]
struct CaptureState {
    exec_id: String,
    armed: bool,
    active: bool,
    text: Vec<u8>,
    tail_active: bool,
    tail: Vec<u8>,
    tail_since: Option<std::time::Instant>,
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
        let mut cap_tail = self.capture.as_ref().map(|c| c.tail_active).unwrap_or(false);
        let cap_armed = self.capture.as_ref().map(|c| c.armed).unwrap_or(false);
        let mut last_off = 0usize;

        for (ev, end_off) in events.iter().map(|(e, o)| (e.clone(), *o)) {
            // 捕获激活期间：上一事件结束到本事件结束之间的字节属于输出（active→text / tail→tail）
            if cap_active || cap_tail {
                if let Some(cap) = self.capture.as_mut() {
                    let slice = &data[last_off..end_off.min(data.len())];
                    if cap_active {
                        cap.text.extend_from_slice(slice);
                    } else {
                        cap.tail.extend_from_slice(slice);
                    }
                }
            }
            match ev {
                OscEvent::Cwd { path } => {
                    self.cwd = Some(path);
                    self.cwd_ts = Some(now);
                }
                OscEvent::OutputStart => {
                    self.saw_133 = true;
                    if cap_armed && !cap_active && !cap_tail {
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
                            // D 不终结捕获：Windows 重绘流序下文本可能尚未到达，转 tail 续采
                            cap.tail_active = true;
                            cap.tail.clear();
                            cap.tail_since = Some(std::time::Instant::now());
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
                OscEvent::CommandStart => {
                    // tail 收口：下一提示符 B 之前的字节都归上一命令（提示符文本在 B 后）
                    if cap_tail {
                        cap_tail = false;
                        if let Some(cap) = self.capture.as_mut() {
                            cap.tail_active = false;
                            let _ = self.capture_tx.send(cap.exec_id.clone());
                        }
                    }
                    self.blocks.on_osc(&ev, now, current_line);
                }
                other => {
                    self.blocks.on_osc(&other, now, current_line);
                }
            }
            last_off = end_off;
        }

        // 尾部仍激活：剩余字节全是输出
        if (cap_active || cap_tail) && last_off < data.len() {
            if let Some(cap) = self.capture.as_mut() {
                let slice = &data[last_off..];
                if cap_active {
                    cap.text.extend_from_slice(slice);
                } else {
                    cap.tail.extend_from_slice(slice);
                }
            }
        }
        if cap_active || cap_tail {
            if let Some(cap) = self.capture.as_mut() {
                let (len, is_active) = if cap_active {
                    (cap.text.len(), true)
                } else {
                    (cap.tail.len(), false)
                };
                if len > self.config.lossless_cap {
                    let drop = len / 2;
                    if is_active {
                        cap.text.drain(..drop);
                    } else {
                        cap.tail.drain(..drop);
                    }
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
            tail_active: false,
            tail: Vec::new(),
            tail_since: None,
        });
    }

    /// 前一 exec 的重绘尾窗是否仍在收集（Windows 流序：文本可晚于 D）。
    pub fn capture_tail_busy(&self) -> bool {
        self.capture
            .as_ref()
            .map(|c| c.tail_active)
            .unwrap_or(false)
    }

    /// 静默兜底：tail 开启超过 max_age 仍无 B（如 exit 后无下一提示符）→ 收口并通知。
    pub fn flush_stale_capture(&mut self, max_age: std::time::Duration) {
        let stale = self
            .capture
            .as_ref()
            .map(|c| {
                c.tail_active
                    && c.tail_since
                        .map(|t| t.elapsed() >= max_age)
                        .unwrap_or(true)
            })
            .unwrap_or(false);
        if stale {
            if let Some(cap) = self.capture.as_mut() {
                cap.tail_active = false;
                let _ = self.capture_tx.send(cap.exec_id.clone());
            }
        }
    }

    /// Shell 模式 exec：直接打开受管块（写入命令同时调用；命令文本受管提供）。
    pub fn open_managed_block(&mut self, command: &str, source: BlockSource, exec_id: &str) {
        let line = self.last_grid_line();
        self.blocks
            .open_managed(command, source, Some(exec_id.to_string()), Utc::now(), line);
    }

    /// 取走某个 exec 的捕获输出（块收口后调用）。
    /// C→D 窗（text）+ D→B 尾窗（tail）拼接返回；标记字节经调用方 strip_ansi 无痕。
    /// Windows 重绘流序下输出整帧落在 tail（含随帧混入的回显行），由调用方按已知
    /// 命令文本自门控剥离（find 不到即无操作，unix 流序回显在 C 之前天然不触发）。
    pub fn take_capture(&mut self, exec_id: &str) -> Option<Vec<u8>> {
        if let Some(cap) = self.capture.as_ref() {
            if cap.exec_id == exec_id && !cap.active && !cap.tail_active {
                let cap = self.capture.take().unwrap();
                let mut raw = cap.text;
                raw.extend_from_slice(&cap.tail);
                return Some(raw);
            }
        }
        None
    }

    pub fn subscribe_capture(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.capture_tx.subscribe()
    }

    /// Fresh 镜像回放：把结构化结果组装为带 Agent 标注的块写入屏幕（L1 §3.1 不可省略）。
    /// 返回实际 feed 的原始字节——调用方（core-session）据此推进 seq/重放环/订阅广播，
    /// 保证回放与传输字节同一线性化机制（C10 断言 1）。
    pub fn replay_fresh(
        &mut self,
        command: &str,
        client_id: Option<&str>,
        stdout: &str,
        stderr: &str,
        exit_code: i32,
        exec_id: &str,
    ) -> Vec<u8> {
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
        bytes
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

    /// 屏幕检查点导出（C10）：从既有 alacritty Term 状态导出带属性网格的恢复载体。
    /// 调用方须持有 screen 锁——与 seq 推进同临界区，水位才与屏幕状态一致。
    ///
    /// 边界（如实登记）：alacritty 0.26 对非活动缓冲无公开只读访问器（swap_alt
    /// 双向均有破坏性副作用），故只导出**活动缓冲**的属性网格；非活动缓冲按行数
    /// 导出空形。基线 read_screen 投影同只覆盖活动缓冲，无回归；vim/top 重建走
    /// 的正是活动（备用）缓冲。
    pub fn checkpoint(&self) -> ScreenCheckpoint {
        use alacritty_terminal::term::TermMode;

        let cols = self.config.cols;
        let rows = self.config.rows;
        let alt = self.alt_screen();
        let mode = |m: alacritty_terminal::term::TermMode| self.term.mode().contains(m);

        let grid = self.term.grid();
        let screen_lines = grid.screen_lines();
        let history = grid.history_size();
        // Line 坐标：0 = 屏底，正数向上到屏顶，负数进历史。自顶向下导出全网格。
        let top = -(history as i32);
        let mut lines: Vec<Vec<CellRun>> = Vec::with_capacity(history + screen_lines);
        for l in top..=(screen_lines as i32 - 1) {
            let row = &grid[Line(l)];
            lines.push(row_runs(&row[..], cols as usize));
        }
        let active = if alt { 1u8 } else { 0 };
        let inactive = BufferCheckpoint { lines: vec![Vec::new(); rows as usize] };
        let active_buf = BufferCheckpoint { lines };
        let buffers = if alt {
            [inactive, active_buf]
        } else {
            [active_buf, inactive]
        };

        // 光标：renderable cursor 源自 grid cursor（Line 0 = 网格屏底，写光标恒在屏区），
        // 换算为 viewport 自顶向下 y；Hidden 形状 = 不显示。
        let rc = self.term.renderable_content().cursor;
        let (visible, style) = match rc.shape {
            alacritty_terminal::vte::ansi::CursorShape::Hidden => (false, "block".to_string()),
            alacritty_terminal::vte::ansi::CursorShape::Underline => (true, "underline".to_string()),
            alacritty_terminal::vte::ansi::CursorShape::Beam => (true, "beam".to_string()),
            _ => (true, "block".to_string()),
        };
        let y = if rc.point.line.0 < 0 {
            0
        } else {
            (screen_lines as u32 - 1).min(rc.point.line.0 as u32)
        };
        let cursor = CursorState {
            x: rc.point.column.0 as u32,
            y,
            visible,
            style,
        };

        let modes = ScreenModes {
            autowrap: mode(TermMode::LINE_WRAP),
            application_cursor: mode(TermMode::APP_CURSOR),
            bracketed_paste: mode(TermMode::BRACKETED_PASTE),
            origin_mode: mode(TermMode::ORIGIN),
        };

        ScreenCheckpoint {
            cols,
            rows,
            buffers,
            active_buffer: active,
            cursor,
            modes,
            title: None,
        }
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

/// 命名色 → wire 颜色规格：默认前景/背景归 None；标准 16 色归 Indexed(0-15)；
/// Dim 系变体降级为默认色（DIM 属性位仍保留）。
fn map_color(c: VteColor, _is_fg: bool) -> Option<ColorSpec> {
    match c {
        VteColor::Named(n) => match n {
            // 默认前景/背景（含反向场景的非常规引用）统一归默认色
            NamedColor::Foreground | NamedColor::Background => None,
            NamedColor::Black => Some(ColorSpec::Indexed(0)),
            NamedColor::Red => Some(ColorSpec::Indexed(1)),
            NamedColor::Green => Some(ColorSpec::Indexed(2)),
            NamedColor::Yellow => Some(ColorSpec::Indexed(3)),
            NamedColor::Blue => Some(ColorSpec::Indexed(4)),
            NamedColor::Magenta => Some(ColorSpec::Indexed(5)),
            NamedColor::Cyan => Some(ColorSpec::Indexed(6)),
            NamedColor::White => Some(ColorSpec::Indexed(7)),
            NamedColor::BrightBlack => Some(ColorSpec::Indexed(8)),
            NamedColor::BrightRed => Some(ColorSpec::Indexed(9)),
            NamedColor::BrightGreen => Some(ColorSpec::Indexed(10)),
            NamedColor::BrightYellow => Some(ColorSpec::Indexed(11)),
            NamedColor::BrightBlue => Some(ColorSpec::Indexed(12)),
            NamedColor::BrightMagenta => Some(ColorSpec::Indexed(13)),
            NamedColor::BrightCyan => Some(ColorSpec::Indexed(14)),
            NamedColor::BrightWhite => Some(ColorSpec::Indexed(15)),
            _ => None,
        },
        VteColor::Indexed(i) => Some(ColorSpec::Indexed(i)),
        VteColor::Spec(rgb) => Some(ColorSpec::Rgb(rgb.r, rgb.g, rgb.b)),
    }
}

fn map_flags(f: Flags) -> u32 {
    let mut out = 0u32;
    if f.contains(Flags::BOLD) { out |= cell_flags::BOLD; }
    if f.contains(Flags::DIM) { out |= cell_flags::DIM; }
    if f.contains(Flags::ITALIC) { out |= cell_flags::ITALIC; }
    if f.intersects(Flags::ALL_UNDERLINES) { out |= cell_flags::UNDERLINE; }
    if f.contains(Flags::DOUBLE_UNDERLINE) { out |= cell_flags::DOUBLE_UNDERLINE; }
    if f.contains(Flags::STRIKEOUT) { out |= cell_flags::STRIKEOUT; }
    if f.contains(Flags::INVERSE) { out |= cell_flags::INVERSE; }
    if f.contains(Flags::HIDDEN) { out |= cell_flags::HIDDEN; }
    out
}

/// 单行网格 → 属性 run 序列。宽字符 spacer 单元格跳过（宽字符本体自带占两格语义）；
/// 行尾默认属性空格裁剪。
fn row_runs(row: &[alacritty_terminal::term::cell::Cell], cols: usize) -> Vec<CellRun> {
    let mut runs: Vec<CellRun> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_fg: Option<Option<ColorSpec>> = None;
    let mut cur_bg: Option<Option<ColorSpec>> = None;
    let mut cur_flags: Option<u32> = None;
    macro_rules! flush {
        () => {
            if let (Some(fg), Some(bg), Some(fl)) = (cur_fg, cur_bg, cur_flags) {
                if !cur_text.is_empty() {
                    runs.push(CellRun { text: std::mem::take(&mut cur_text), fg, bg, flags: fl });
                }
            }
            cur_fg = None;
            cur_bg = None;
            cur_flags = None;
        };
    }
    for c in 0..cols {
        let cell = &row[c];
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
            || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        let fg = map_color(cell.fg, true);
        let bg = map_color(cell.bg, false);
        let fl = map_flags(cell.flags);
        if cur_flags.is_some()
            && (cur_fg.as_ref() != Some(&fg) || cur_bg.as_ref() != Some(&bg) || cur_flags != Some(fl))
        {
            flush!();
        }
        if cur_flags.is_none() {
            cur_fg = Some(fg);
            cur_bg = Some(bg);
            cur_flags = Some(fl);
        }
        cur_text.push(cell.c);
        if let Some(zw) = cell.zerowidth() {
            for ch in zw {
                cur_text.push(*ch);
            }
        }
    }
    flush!();
    // 行尾裁剪：默认属性的全空格 run 弹掉；末 run 的默认属性空格尾修剪
    while let Some(last) = runs.last() {
        if last.fg.is_none() && last.bg.is_none() && last.flags == 0 && last.text.chars().all(|c| c == ' ') {
            runs.pop();
        } else {
            break;
        }
    }
    if let Some(last) = runs.last_mut() {
        if last.fg.is_none() && last.bg.is_none() && last.flags == 0 {
            let t = last.text.trim_end_matches(' ').to_string();
            if t.is_empty() { runs.pop(); } else { last.text = t; }
        }
    }
    runs
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
        // 模拟注入 shell：A/B → 命令 → C → 输出 → D →（tail）→ 下一提示符 B 收口
        s.open_managed_block("echo hi", BlockSource::Agent { client_id: "cc".into() }, "e1");
        s.feed(b"\x1b]133;C\x07hi\r\n\x1b]133;D;0\x07");
        // C 到达时块已在 Output 态，捕获激活；D 转 tail（不终结），B 收口
        assert!(s.capture_tail_busy(), "D 后 tail 应开启");
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ ");
        let out = s.take_capture("e1").expect("capture should complete");
        assert_eq!(strip_ansi(&out).trim(), "hi");
    }

    #[test]
    fn capture_tail_collects_late_text() {
        // Windows 重绘流序：标记先 bursts（C/D/A），文本整帧晚于 D 到达
        let mut s = screen();
        s.arm_capture("e1");
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ ");
        s.register_outgoing(b"echo out\r", BlockSource::Human);
        s.feed(b"\x1b]133;C\x07");
        s.feed(b"\x1b]133;D;0\x07\x1b]133;A\x07");
        assert!(s.capture_tail_busy(), "D 早于文本 → tail 收集");
        s.feed(b"$ echo out\r\nout\r\n\x1b[?2004h\x1b]133;B\x07");
        let raw = s.take_capture("e1").expect("capture should complete");
        assert!(strip_ansi(&raw).contains("out"));
    }

    #[test]
    fn capture_quiet_flush_closes_tail() {
        let mut s = screen();
        s.arm_capture("e1");
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ \x1b]133;C\x07\x1b]133;D;0\x07");
        // 无下一提示符（exit）：到龄兜底收口
        std::thread::sleep(std::time::Duration::from_millis(5));
        s.flush_stale_capture(std::time::Duration::from_millis(1));
        assert!(!s.capture_tail_busy());
        let raw = s.take_capture("e1").expect("capture should complete");
        assert!(strip_ansi(&raw).trim().is_empty());
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

    // ---- C10 检查点导出 ----

    #[test]
    fn checkpoint_basic_text_and_cursor() {
        let mut s = screen();
        s.feed(b"hello\r\nworld");
        let ck = s.checkpoint();
        assert_eq!(ck.cols, 80);
        assert_eq!(ck.rows, 24);
        assert_eq!(ck.active_buffer, 0);
        assert!(ck.title.is_none());
        let lines = &ck.buffers[0].lines;
        // 历史 + 可视：至少可视区两行有内容，网格总行数 = 24
        assert_eq!(lines.len(), 24);
        let joined: String = lines.iter().flatten().map(|r| r.text.as_str()).collect();
        assert!(joined.contains("hello"), "checkpoint must contain hello: {joined:?}");
        assert!(joined.contains("world"));
        // 光标在 "world" 行尾（第 2 行 0 基 y=1, x=5）
        assert_eq!(ck.cursor.y, 1);
        assert_eq!(ck.cursor.x, 5);
        assert!(ck.cursor.visible);
    }

    #[test]
    fn checkpoint_colors_and_attrs() {
        let mut s = screen();
        // 红色粗体 + 256 色背景 + 下划线 + 真彩
        s.feed(b"\x1b[1;31mRED\x1b[0m\x1b[48;5;21mB\x1b[0m\x1b[4mU\x1b[0m\x1b[38;2;10;20;30mT\x1b[0m");
        let ck = s.checkpoint();
        let row0 = &ck.buffers[0].lines[0];
        let red = row0.iter().find(|r| r.text == "RED").expect("RED run");
        assert_eq!(red.fg, Some(ColorSpec::Indexed(1)));
        assert_ne!(red.flags & cell_flags::BOLD, 0);
        let b = row0.iter().find(|r| r.text == "B").expect("B run");
        assert_eq!(b.bg, Some(ColorSpec::Indexed(21)));
        let u = row0.iter().find(|r| r.text == "U").expect("U run");
        assert_ne!(u.flags & cell_flags::UNDERLINE, 0);
        let t = row0.iter().find(|r| r.text == "T").expect("T run");
        assert_eq!(t.fg, Some(ColorSpec::Rgb(10, 20, 30)));
    }

    #[test]
    fn checkpoint_alt_screen_and_modes() {
        let mut s = screen();
        s.feed(b"main content\r\n");
        // 进备用屏 + 应用光标 + 括号粘贴 + 原点模式，写 top 行
        s.feed(b"\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?6h\x1b[?7l");
        s.feed(b"\x1b[2J\x1b[Halt-full-view");
        let ck = s.checkpoint();
        assert_eq!(ck.active_buffer, 1);
        // 活动缓冲（备用）含 alt 内容；主缓冲为空形（行数仍 = rows）
        let alt_lines = &ck.buffers[1].lines;
        assert_eq!(alt_lines.len(), 24);
        let joined: String = alt_lines.iter().flatten().map(|r| r.text.as_str()).collect();
        assert!(joined.contains("alt-full-view"));
        assert!(!joined.contains("main content"));
        assert_eq!(ck.buffers[0].lines.len(), 24);
        assert!(ck.buffers[0].lines.iter().all(|l| l.is_empty()));
        assert!(ck.modes.application_cursor);
        assert!(ck.modes.bracketed_paste);
        assert!(ck.modes.origin_mode);
        assert!(!ck.modes.autowrap);
        // 光标停在 "alt-full-view" 行尾（y=0, x=13）
        assert_eq!((ck.cursor.x, ck.cursor.y), (13, 0));
        // 无损往返：切回主屏后内容仍在
        s.feed(b"\x1b[?1049l");
        assert!(s.snapshot_text().contains("main content"));
    }

    #[test]
    fn checkpoint_history_included_and_watermark_shape() {
        let mut s = screen();
        // 滚出可视区 30 行（rows=24）
        for i in 0..30 {
            s.feed(format!("line-{i}\r\n").as_bytes());
        }
        let ck = s.checkpoint();
        let joined: String = ck.buffers[0].lines.iter().flatten().map(|r| r.text.as_str()).collect();
        assert!(joined.contains("line-0"), "history line-0 must be in checkpoint");
        assert!(joined.contains("line-29"));
        assert!(ck.buffers[0].lines.len() >= 24);
    }

    #[test]
    fn checkpoint_wide_char() {
        let mut s = screen();
        s.feed("\x1b[31m中\x1b[0m文".as_bytes());
        let ck = s.checkpoint();
        let row0 = &ck.buffers[0].lines[0];
        let joined: String = row0.iter().map(|r| r.text.as_str()).collect();
        assert!(joined.contains("中文"));
        // 宽字符 spacer 省略：码点数 = 字符数（2），不因占位格重复
        let total: usize = row0.iter().map(|r| r.text.chars().count()).sum();
        assert_eq!(total, 2);
        // 红「中」与默认「文」分属两个 run（属性不同不合并）
        assert_eq!(row0.len(), 2);
    }
}
