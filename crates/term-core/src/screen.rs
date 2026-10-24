//! Screen：会话屏幕真源（网格 + 命令块 + cwd + 无损缓冲 + exec 输出捕获）。
//! 非 Sync；由 core-session 以 Mutex 持有，feed 来自传输 pump 任务。

#[allow(unused_imports)]
use crate::block::BlockPhase;
use crate::block::{BlockIndex, BlockSource};
use crate::osc::{OscEvent, OscScanner};
use crate::render::{cursor_pos, render_screen_only, render_text, GridSize};
use crate::strip_ansi;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte;
use alacritty_terminal::vte::ansi::{Color as VteColor, NamedColor};
use chrono::{DateTime, Utc};
use session_api::{
    cell_flags, BufferCheckpoint, CellRun, ColorSpec, CursorState, ScreenCheckpoint, ScreenModes,
};

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

/// 块输出采集窗（「块输出文本」增量）：C→D 主窗 + D→B 尾窗共用一个**顺序**缓冲。
/// 尾窗与 exec 捕获（CaptureState）同源语义：Windows ConPTY 整帧重绘流序下命令
/// 文本可晚于 D 到达，落在 D 之后、下一提示符 B 之前（提示符文本在 B 之后，天然
/// 切界）；unix 流序输出在 C→D 主窗、尾窗近空。缓冲只保留**末尾 8KB**（报错
/// 堆栈/摘要通常在尾部，头部价值最低）。
#[derive(Debug, Default)]
struct BlockTap {
    buf: String,
    /// D 已过：进入尾窗（B 到达即收口回填到块）。
    tail_active: bool,
    /// 缓冲超上限丢过头部（截断如实标注，不静默伪装完整）。
    clipped: bool,
}

/// 单块输出文本上限：8 KiB，与 BlockInfo.output 的 JSON 契约一致。
const BLOCK_OUTPUT_CAP: usize = 8 * 1024;

impl BlockTap {
    /// 追加一段渲染后文本，超限即保尾裁剪到上限（字符边界对齐，不在多字节
    /// 中间下刀）。逐次裁保证 buf 在任意无锁观察点 ≤ 上限（read_blocks 与 feed
    /// 共享屏锁，投影看到的输出不会超出 JSON 契约）。
    fn absorb(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.buf.push_str(text);
        if self.buf.len() > BLOCK_OUTPUT_CAP {
            let mut cut = self.buf.len() - BLOCK_OUTPUT_CAP;
            while !self.buf.is_char_boundary(cut) {
                cut += 1;
            }
            self.buf.drain(..cut);
            self.clipped = true;
        }
    }
}

#[derive(Debug, Default)]
pub struct TermEventListener;
impl EventListener for TermEventListener {}

/// ConPTY 整帧重绘补偿：把行号高于本端视口的 CUP/HVP 翻译成「定位到底行 +
/// 超出量个 LF」。ConPTY 窗口几何可高于 PTY 请求的视口（滚动协议里 57;1 ≈
/// 其窗口高+1），重绘帧行号随之超界——alacritty 对超界 CUP 钳到底行，超界帧行
/// 逐行覆盖同一行而丢失；底行 LF 则滚动入 scrollback。行号落在视口内（含全部
/// 常规终端输出、alt-screen 应用）序列原样透传；若滚动区域阻止 LF 滚动，翻译
/// 退化为修复前的钳制行为，不劣于此前。
#[derive(Debug, Default)]
struct CupTranslator {
    /// 跨 feed 分片的未完成 ESC[ 序列尾片（终符未到，不能半截翻译）。
    carry: Vec<u8>,
}

/// carry 上限：未终结 CSI 尾片的丢弃阈值（合法参数序列几十字节封顶）。
const CUP_CARRY_CAP: usize = 4096;
/// 超界 CUP 补 LF 的单序列上限：真实 ConPTY 窗口与视口的差值是个位数～几十行，
/// 1024 已是宽裕头寸；`parse_cup` 允许行号到 u32::MAX，不设上限时单条 20 字节
/// 序列曾可产出 ~4.3GB 的 LF（OOM 炸弹），设上限后单序列至多 1KB、单 8KB
/// chunk 至多 ~1MB，内存有界。
const CUP_LF_CAP: u32 = 1024;

impl CupTranslator {
    /// 返回 Borrowed 表示无需改写（无 ESC 的常态路径零拷贝）。
    fn translate<'a>(&mut self, data: &'a [u8], rows: u16) -> Cow<'a, [u8]> {
        if self.carry.is_empty() && !data.contains(&0x1b) {
            return Cow::Borrowed(data);
        }
        let mut input = std::mem::take(&mut self.carry);
        input.extend_from_slice(data);
        let mut out = Vec::with_capacity(input.len());
        let mut i = 0usize;
        while i < input.len() {
            if input[i] != 0x1b {
                out.push(input[i]);
                i += 1;
                continue;
            }
            if i + 1 >= input.len() {
                break; // 尾部裸 ESC：留待下一片
            }
            if input[i + 1] != b'[' {
                out.extend_from_slice(&input[i..i + 2]);
                i += 2;
                continue;
            }
            // CSI：参数字节 0x30–0x3F，终符 0x40–0x7E
            let mut j = i + 2;
            while j < input.len() && (0x30..=0x3f).contains(&input[j]) {
                j += 1;
            }
            if j >= input.len() {
                break; // CSI 未完：整段留待下一片
            }
            let rewritten = if input[j] == b'H' || input[j] == b'f' {
                parse_cup(&input[i + 2..j]).is_some_and(|(r, c)| {
                    if r > rows as u32 {
                        out.extend_from_slice(format!("\x1b[{};{c}H", rows).as_bytes());
                        // 补的 LF 数截到 CUP_LF_CAP：更大的 r 只是多灌空白行
                        // （~4.3GB 炸弹 → ≤1KB）；合法 ConPTY 重绘的超界量
                        // （窗口高于视口的差值）远小于上限，不受影响。
                        for _ in 0..(r - rows as u32).min(CUP_LF_CAP) {
                            out.push(b'\n');
                        }
                        true
                    } else {
                        false
                    }
                })
            } else {
                false
            };
            if !rewritten {
                out.extend_from_slice(&input[i..=j]);
            }
            i = j + 1;
        }
        // carry 上限：永不终结的 CSI 参数流（远端持续输出 ESC[+参数字节，或
        // 二进制数据撞分片边界）曾让 carry 随总输入无界增长。合法 CSI 参数
        // ≤ 几十字节，超限即视为垃圾序列整体丢弃。
        if input.len() - i > CUP_CARRY_CAP {
            self.carry.clear();
        } else {
            self.carry = input[i..].to_vec();
        }
        Cow::Owned(out)
    }
}

/// CUP 参数解析（1 基行列，缺省 1）；含非数字（冒号子参/私有标记）或超两参
/// 的非常规形式不支持，返回 None 走透传。
fn parse_cup(params: &[u8]) -> Option<(u32, u32)> {
    fn part(p: &[u8]) -> Option<u32> {
        if p.is_empty() {
            return Some(1);
        }
        let mut v: u32 = 0;
        for &b in p {
            if !b.is_ascii_digit() {
                return None;
            }
            v = v.checked_mul(10)?.checked_add((b - b'0') as u32)?;
        }
        Some(v)
    }
    let mut parts = params.split(|&b| b == b';');
    let r = part(parts.next()?)?;
    let c = match parts.next() {
        Some(p) => part(p)?,
        None => 1,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((r, c))
}

pub struct Screen {
    config: ScreenConfig,
    term: Term<TermEventListener>,
    processor: vte::ansi::Processor,
    /// ConPTY 超界 CUP 补偿（进解析器前的字节流预翻译）。
    cup_fix: CupTranslator,
    scanner: OscScanner,
    pub blocks: BlockIndex,
    lossless: VecDeque<LosslessChunk>,
    lossless_bytes: usize,
    /// 环淘汰累计数（头 pop 计数）：wait_output 水位用「淘汰基数 + 长度」作绝对
    /// 序号——deque 下标随头部淘汰整体前滑，相对下标水位会把未消费的输出静默
    /// 跳过（漏匹配 → 假超时，十轮）。
    lossless_evicted: usize,
    /// 有新无损内容时 notify。
    lossless_notify: std::sync::Arc<tokio::sync::Notify>,
    cwd: Option<String>,
    cwd_ts: Option<DateTime<Utc>>,
    capture: Option<CaptureState>,
    /// 捕获完成通知（exec_id）。
    capture_tx: tokio::sync::broadcast::Sender<String>,
    /// 当前打开块的输出采集窗（None = 无打开块或已收口）。
    block_tap: Option<BlockTap>,
    /// 曾收到 OSC 133（判断主机是否注入 shell 集成）。
    saw_133: bool,
    /// 重置型就绪信号：重连后等首个 B 标记（见 prompt_ready）。
    saw_prompt: bool,
    last_output_ts: Option<DateTime<Utc>>,
}

use std::borrow::Cow;
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
            cup_fix: CupTranslator::default(),
            scanner: OscScanner::new(),
            blocks: BlockIndex::new(),
            lossless: VecDeque::new(),
            lossless_bytes: 0,
            lossless_evicted: 0,
            lossless_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            cwd: None,
            cwd_ts: None,
            capture: None,
            capture_tx,
            block_tap: None,
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
        // ConPTY 超界 CUP 先翻译再进解析器；其余消费端（OSC 扫描/捕获/无损缓冲）
        // 仍吃原始 data，互不影响。
        let vt = self.cup_fix.translate(data, self.config.rows);
        self.processor.advance(&mut self.term, &vt);
        let current_line = self.last_grid_line();

        let events = self.scanner.feed(data);
        let mut cap_active = self.capture.as_ref().map(|c| c.active).unwrap_or(false);
        let mut cap_tail = self
            .capture
            .as_ref()
            .map(|c| c.tail_active)
            .unwrap_or(false);
        let cap_armed = self.capture.as_ref().map(|c| c.armed).unwrap_or(false);
        let mut last_off = 0usize;

        for (ev, ev_start, ev_end) in events.iter().map(|(e, s, o)| (e.clone(), *s, *o)) {
            // 捕获激活期间：上一事件结束到本事件结束之间的字节属于输出（active→text / tail→tail）
            if cap_active || cap_tail {
                if let Some(cap) = self.capture.as_mut() {
                    let slice = &data[last_off..ev_end.min(data.len())];
                    if cap_active {
                        cap.text.extend_from_slice(slice);
                    } else {
                        cap.tail.extend_from_slice(slice);
                    }
                }
            }
            match ev {
                OscEvent::Cwd { path } => {
                    // cwd 报告可出现在块输出中途：标记前正文归采集窗
                    if let Some(t) = &mut self.block_tap {
                        t.absorb(&strip_ansi(
                            &data[last_off..ev_start.max(last_off).min(data.len())],
                        ));
                    }
                    self.cwd = Some(path);
                    self.cwd_ts = Some(now);
                }
                OscEvent::OutputStart => {
                    self.saw_133 = true;
                    // 新块开采集窗；旧窗（C→D 未走完的残窗）就地作废不回填——
                    // 残窗的块要么已在其 D 回填过主窗，要么从未成块，张冠李戴
                    // 比缺数据更糟（归因不撒谎）。
                    self.block_tap = Some(BlockTap::default());
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
                    // A 在 D 之后 B 之前（尾窗内）：标记前正文归上一块的尾窗
                    if let Some(t) = &mut self.block_tap {
                        t.absorb(&strip_ansi(
                            &data[last_off..ev_start.max(last_off).min(data.len())],
                        ));
                    }
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
                    // C→D 主窗收口：标记前正文进缓冲；转尾窗（D→B 续采）
                    if let Some(t) = &mut self.block_tap {
                        t.absorb(&strip_ansi(
                            &data[last_off..ev_start.max(last_off).min(data.len())],
                        ));
                        t.tail_active = true;
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
                    // 主窗先回填（B 不来——断线/无下一提示符——也有主窗可读）
                    self.attach_block_output();
                    let _ = exit;
                }
                OscEvent::CommandStart => {
                    // 尾窗收口：下一提示符 B 之前的字节都归上一命令（提示符文本在 B 后）
                    if cap_tail {
                        cap_tail = false;
                        if let Some(cap) = self.capture.as_mut() {
                            cap.tail_active = false;
                            let _ = self.capture_tx.send(cap.exec_id.clone());
                        }
                    }
                    // 块输出尾窗收口：B 前正文并入缓冲，主窗+尾窗整体回填后作废
                    let close_tap = matches!(&self.block_tap, Some(t) if t.tail_active);
                    if close_tap {
                        if let Some(t) = &mut self.block_tap {
                            t.absorb(&strip_ansi(
                                &data[last_off..ev_start.max(last_off).min(data.len())],
                            ));
                        }
                        self.blocks.on_osc(&ev, now, current_line);
                        self.attach_block_output();
                        self.block_tap = None;
                    } else {
                        // C→D 途中的 B（流序异常）：不收口，正文照采
                        if let Some(t) = &mut self.block_tap {
                            t.absorb(&strip_ansi(
                                &data[last_off..ev_start.max(last_off).min(data.len())],
                            ));
                        }
                        self.blocks.on_osc(&ev, now, current_line);
                    }
                }
                other => {
                    self.blocks.on_osc(&other, now, current_line);
                }
            }
            last_off = ev_end;
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
        // 块输出采集尾部：本 feed 剩余未接标记的字节属于当前窗
        if let Some(t) = &mut self.block_tap {
            if last_off < data.len() {
                t.absorb(&strip_ansi(&data[last_off..]));
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
                self.lossless_evicted += 1;
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
            .map(|c| c.tail_active && c.tail_since.map(|t| t.elapsed() >= max_age).unwrap_or(true))
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

    /// 把当前采集窗回填到最近一个块（「块输出文本」增量）。
    /// D 时回填主窗、B 时整体回填（主窗+尾窗）——都指向同一个刚收口的块（D 与 B
    /// 之间无新块入账）。命令回显剥离与 exec 捕获同款自门控：Windows 重绘流序下
    /// 回显行随帧混入尾窗，按已知命令文本剥首处（find 不到即无操作，unix 流序
    /// 回显在 C 之前天然不在窗内）；窗口边界的换行噪音一并修剪。
    fn attach_block_output(&mut self) {
        let Some(tap) = self.block_tap.as_ref() else {
            return;
        };
        if tap.buf.is_empty() {
            return;
        }
        let Some(b) = self.blocks.blocks.last_mut() else {
            return;
        };
        let mut text = tap.buf.clone();
        let cmd = b.command.trim_end();
        if !cmd.is_empty() {
            if let Some(idx) = text.find(cmd) {
                text = text[idx + cmd.len()..]
                    .trim_start_matches(['\r', '\n'])
                    .to_string();
            }
        }
        b.output = text
            .trim_start_matches(['\r', '\n'])
            .trim_end_matches(['\r', '\n'])
            .to_string();
        b.output_truncated = tap.clipped;
    }

    /// 断线/重连：强制收尾打开块，并把未回填的采集窗一并落账（尾窗滞留的输出
    /// 不随窗作废丢弃）；随后采集窗作废——旧 shell 已死，窗再无归属。
    pub fn force_close_open(&mut self, now: DateTime<Utc>) {
        self.blocks.force_close_open(now);
        self.attach_block_output();
        self.block_tap = None;
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
        self.open_managed_block(
            &head,
            BlockSource::Replay {
                client_id: client_id.map(|s| s.to_string()),
            },
            exec_id,
        );
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
        let inactive = BufferCheckpoint {
            lines: vec![Vec::new(); rows as usize],
        };
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
            alacritty_terminal::vte::ansi::CursorShape::Underline => {
                (true, "underline".to_string())
            }
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
        // 钳到 ≥1×1：cols/rows 是 u16 直通入参（Tauri 命令/MCP 均无校验），
        // 传 0 会在后续渲染 Column(cols-1) usize 下溢 panic——单点钳住所有调用方
        let cols = cols.max(1);
        let rows = rows.max(1);
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

    /// 无损缓冲当前长度（相对下标；水位请用 [`Self::lossless_abs`]）。
    pub fn lossless_len(&self) -> usize {
        self.lossless.len()
    }

    /// 环淘汰累计数（绝对水位基数）。
    pub fn lossless_evicted(&self) -> usize {
        self.lossless_evicted
    }

    /// 当前绝对水位 = 淘汰基数 + 存活长度。跨淘汰稳定：此后
    /// `text_since_abs(该值)` 恰好取到「该时刻之后」的输出（淘汰越界部分除外，
    /// 调用方以 `lossless_evicted()` 越过水位判定截断）。
    pub fn lossless_abs(&self) -> usize {
        self.lossless_evicted + self.lossless.len()
    }

    /// 自绝对水位以来的存活渲染文本；水位落在已淘汰区间时从头取（saturating）。
    pub fn text_since_abs(&self, abs_watermark: usize) -> String {
        let skip = abs_watermark.saturating_sub(self.lossless_evicted);
        self.lossless
            .iter()
            .skip(skip)
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
    if f.contains(Flags::BOLD) {
        out |= cell_flags::BOLD;
    }
    if f.contains(Flags::DIM) {
        out |= cell_flags::DIM;
    }
    if f.contains(Flags::ITALIC) {
        out |= cell_flags::ITALIC;
    }
    if f.intersects(Flags::ALL_UNDERLINES) {
        out |= cell_flags::UNDERLINE;
    }
    if f.contains(Flags::DOUBLE_UNDERLINE) {
        out |= cell_flags::DOUBLE_UNDERLINE;
    }
    if f.contains(Flags::STRIKEOUT) {
        out |= cell_flags::STRIKEOUT;
    }
    if f.contains(Flags::INVERSE) {
        out |= cell_flags::INVERSE;
    }
    if f.contains(Flags::HIDDEN) {
        out |= cell_flags::HIDDEN;
    }
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
                    runs.push(CellRun {
                        text: std::mem::take(&mut cur_text),
                        fg,
                        bg,
                        flags: fl,
                    });
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
            && (cur_fg.as_ref() != Some(&fg)
                || cur_bg.as_ref() != Some(&bg)
                || cur_flags != Some(fl))
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
        if last.fg.is_none()
            && last.bg.is_none()
            && last.flags == 0
            && last.text.chars().all(|c| c == ' ')
        {
            runs.pop();
        } else {
            break;
        }
    }
    if let Some(last) = runs.last_mut() {
        if last.fg.is_none() && last.bg.is_none() && last.flags == 0 {
            let t = last.text.trim_end_matches(' ').to_string();
            if t.is_empty() {
                runs.pop();
            } else {
                last.text = t;
            }
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

    /// 十轮：环淘汰后绝对水位不漂移——淘汰发生前取的水位，之后仍取到「其后」
    /// 存活文本（旧相对下标水位在此场景把未消费输出静默跳过）；截断经
    /// `lossless_evicted() > 水位` 可感知。
    #[test]
    fn lossless_watermark_survives_eviction() {
        let cfg = ScreenConfig {
            cols: 80,
            rows: 24,
            scrollback: 100,
            lossless_cap: 32,
        };
        let mut s = Screen::new(cfg.clone() /* 每块 22B，环只容 1–2 块 */);
        for i in 0..3 {
            s.feed(format!("chunk-{i}-0123456789\r\n").as_bytes());
        }
        let wm = s.lossless_abs();
        assert_eq!(wm, 3, "绝对水位 = 总推入块数（淘汰计数+存活长度）");
        // 继续喂触发淘汰：水位前块被淘汰后，text_since_abs 只回存活部分
        for i in 3..10 {
            s.feed(format!("chunk-{i}-0123456789\r\n").as_bytes());
        }
        assert!(s.lossless_evicted() > wm, "小环下淘汰数必然越过水位");
        let text = s.text_since_abs(wm);
        assert!(text.contains("chunk-9"), "最新块必须在场：{text:?}");
        assert!(!text.contains("chunk-2"), "水位前块不得混入：{text:?}");
        assert!(s.lossless_evicted() > wm);
        // 截断语义：evicted 越过水位 → 本次返回不含水位处及之前的块
        assert!(!text.contains("chunk-3"));
        // 水位在淘汰面之后的场景（无截断）：新水位起的新块完整可取
        let wm2 = s.lossless_abs();
        s.feed(b"chunk-tail-0123456789\r\n");
        let text2 = s.text_since_abs(wm2);
        assert!(
            text2.contains("chunk-tail"),
            "水位后新块必须完整：{text2:?}"
        );
        assert!(!text2.contains("chunk-9"), "水位前块不得混入：{text2:?}");
    }

    #[test]
    fn shell_mode_capture() {
        let mut s = screen();
        s.arm_capture("e1");
        // 模拟注入 shell：A/B → 命令 → C → 输出 → D →（tail）→ 下一提示符 B 收口
        s.open_managed_block(
            "echo hi",
            BlockSource::Agent {
                client_id: "cc".into(),
            },
            "e1",
        );
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
        assert_eq!(
            blocks[0].source,
            BlockSource::Replay {
                client_id: Some("cc".into())
            }
        );
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
        assert!(
            joined.contains("hello"),
            "checkpoint must contain hello: {joined:?}"
        );
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
        s.feed(
            b"\x1b[1;31mRED\x1b[0m\x1b[48;5;21mB\x1b[0m\x1b[4mU\x1b[0m\x1b[38;2;10;20;30mT\x1b[0m",
        );
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
        let joined: String = alt_lines
            .iter()
            .flatten()
            .map(|r| r.text.as_str())
            .collect();
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
        let joined: String = ck.buffers[0]
            .lines
            .iter()
            .flatten()
            .map(|r| r.text.as_str())
            .collect();
        assert!(
            joined.contains("line-0"),
            "history line-0 must be in checkpoint"
        );
        assert!(joined.contains("line-29"));
        assert!(ck.buffers[0].lines.len() >= 24);
    }

    /// ConPTY（Win32-OpenSSH）对一次性 ~50 行爆发不逐行回传，而是整帧重绘：
    /// `ESC[57;1H`（行号 ≈ ConPTY 窗口高+1，高于本端视口）→ 约 26 个换行 →
    /// `ESC[H` → 按行 CUP 逐行重绘全帧（帧行数可超出本端视口）。屏模型必须把
    /// 超出视口的 CUP 行号落成「底行定位+滚动入 scrollback」而不是钳到底行
    /// 互相覆盖，否则帧头部行被抹掉（登记实测 50 行只剩 29 行，
    /// docs/ux/ux-r1-execution-status.md）。
    #[test]
    fn conpty_full_frame_repaint_keeps_all_lines() {
        let mut s = Screen::new(ScreenConfig {
            cols: 80,
            rows: 32,
            scrollback: 10_000,
            lossless_cap: 1 << 20,
        });
        // 突发前已有 3 行上下文（提示符/命令回显）
        for i in 0..3 {
            s.feed(format!("ctx-{i}\r\n").as_bytes());
        }
        // ConPTY 滚动协议：光标跳 57;1 → 26 个换行 → 归位 → 帧高 56 行逐行 CUP 重绘
        // （帧 row1..3 = ctx，row4..53 = line-1..50，尾部空行不画）
        let mut stream = Vec::new();
        stream.extend_from_slice(b"\x1b[57;1H");
        for _ in 0..26 {
            stream.push(b'\n');
        }
        stream.extend_from_slice(b"\x1b[H");
        for r in 1..=56u32 {
            let text = if r <= 3 {
                format!("ctx-{}", r - 1)
            } else if r <= 53 {
                format!("line-{}", r - 3)
            } else {
                continue;
            };
            stream.extend_from_slice(format!("\x1b[{r};1H{text}").as_bytes());
        }
        // 分片喂入：协议可能跨 chunk 到达，CUP 不能因分片漏翻
        s.feed(&stream[..stream.len() / 2]);
        s.feed(&stream[stream.len() / 2..]);

        let snap = s.snapshot_text();
        for i in 1..=50 {
            assert!(
                snap.contains(&format!("line-{i}\n")),
                "line-{i} 整帧重绘后丢失"
            );
        }
        for i in 0..3 {
            assert!(snap.contains(&format!("ctx-{i}\n")), "ctx-{i} 丢失");
        }
        let first = snap.find("line-1\n").expect("line-1 在场");
        let last = snap.find("line-50\n").expect("line-50 在场");
        assert!(first < last, "帧行序必须保持（line-1 在 line-50 前）");
    }

    /// 翻译器边界：CUP 分片跨 feed 不漏翻；非 CUP（DECSTBM/私有模式/冒号子参）
    /// 与视口内 CUP 原样透传；HVP（f）同待遇。
    #[test]
    fn cup_translator_carries_and_passthrough() {
        fn lfs(n: u32) -> Vec<u8> {
            vec![b'\n'; n as usize]
        }
        let rows = 24u16;
        let mut t = CupTranslator::default();
        let mut tr = |t: &mut CupTranslator, parts: &[&[u8]]| -> Vec<u8> {
            let mut out = Vec::new();
            for p in parts {
                match t.translate(p, rows) {
                    Cow::Owned(v) => out.extend_from_slice(&v),
                    Cow::Borrowed(_) => out.extend_from_slice(p),
                }
            }
            out
        };
        // ESC[57 跨片：carry 后补 1H → 底行定位 + 33 个 LF
        let mut want = b"\x1b[24;1H".to_vec();
        want.extend(lfs(33));
        assert_eq!(tr(&mut t, &[b"\x1b[57", b";1H"]), want);
        assert!(t.carry.is_empty());
        // 非拦截序列原样透传（含跨片的非 CUP）
        let out = tr(&mut t, &[b"\x1b[1;", b"10r\x1b[?1049h\x1b[2J\x1b[1;1:5H"]);
        assert_eq!(out, b"\x1b[1;10r\x1b[?1049h\x1b[2J\x1b[1;1:5H");
        // 视口内 CUP 透传；超界 HVP（f）同 CUP 待遇
        let mut want = b"\x1b[5;3H\x1b[24;7H".to_vec();
        want.extend(lfs(6));
        assert_eq!(tr(&mut t, &[b"\x1b[5;3H", b"\x1b[30;7f"]), want);
        // 尾部未完 CSI 挂起，下一片拼上后照常处理
        let mut want = b"ok\x1b[24;1H".to_vec();
        want.extend(lfs(75));
        assert_eq!(tr(&mut t, &[b"ok\x1b[9", b"9;1H"]), want);
        assert!(t.carry.is_empty());
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

    // ---- 块输出采集（「块输出文本」增量）----

    /// unix 流序：输出在 C→D 主窗；B 收口后整体回填。回显在 C 之前（不采），
    /// 命令文本自门控剥离 find 不到即无操作。
    #[test]
    fn block_output_captured_in_c_to_d_window() {
        let mut s = screen();
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ ");
        s.register_outgoing(b"echo hi\r", BlockSource::Human);
        // 回显行在 C 之前（B→C 键入回显），C 后是输出（strip_ansi 归一 \r\n→\n）
        s.feed(b"echo hi\r\n\x1b]133;C\x07hello\r\nworld\x1b]133;D;0\x07");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert_eq!(b.output, "hello\nworld", "主窗输出照实：{:?}", b.output);
        assert!(!b.output_truncated);
        // 尾窗收口（B 到达）不改变结果
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ ");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert_eq!(b.output, "hello\nworld");
    }

    /// Windows ConPTY 流序：D 先到、命令文本整帧落在 D 后 B 前——尾窗兜住，
    /// 回显行随帧混入按已知命令文本剥首处（与 exec 捕获同款语义）。
    #[test]
    fn block_output_late_text_via_tail_window() {
        let mut s = screen();
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07$ ");
        s.register_outgoing(b"echo late\r", BlockSource::Human);
        s.feed(b"\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07");
        // D 时刻主窗为空也照实（B 不来至少有主窗；此处主窗空则保持空）
        let b = s.blocks.last_blocks(1)[0].clone();
        assert_eq!(b.output, "");
        // 重绘帧整帧晚到：回显 + 输出 + 下一提示符 B，B 收口
        s.feed(b"$ echo late\r\nlate output\r\n\x1b]133;B\x07");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert_eq!(b.output, "late output", "回显剥离+尾窗合并：{:?}", b.output);
        assert!(!b.output_truncated);
    }

    /// 截断：单块超 8KB 保**末尾** 8KB（报错堆栈在尾部），truncated 如实标注。
    #[test]
    fn block_output_truncated_keeps_tail() {
        let mut s = screen();
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07");
        for i in 0..2000 {
            s.feed(format!("line-{i:04}-0123456789\r\n").as_bytes());
        }
        s.feed(b"\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert!(b.output.len() <= 8 * 1024, "≤8KB 上限：{}", b.output.len());
        assert!(b.output_truncated, "头部被丢必须如实标注");
        assert!(b.output.contains("line-1999"), "保尾：最后一行必须在场");
        assert!(!b.output.contains("line-0000"), "头部应被裁掉");
        // UTF-8 边界：多字节字符不在中间下刀（首尾必是完整字符）
        let mut s2 = screen();
        s2.feed(b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07");
        for _ in 0..1200 {
            s2.feed("命令输出中文行\r\n".as_bytes());
        }
        s2.feed(b"\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07");
        let b2 = s2.blocks.last_blocks(1)[0].clone();
        assert!(b2.output.len() <= 8 * 1024, "{}", b2.output.len());
        assert!(b2.output_truncated);
        assert!(b2.output.contains("中文行"), "{:?}", b2.output);
    }

    /// 空输出窗（命令无输出）：空串 + truncated=false——如实，不虚构也不误标。
    #[test]
    fn block_output_empty_window_is_empty_not_fabricated() {
        let mut s = screen();
        s.feed(b"\x1b]133;A\x07\x1b]133;B\x07");
        s.register_outgoing(b"cd /tmp\r", BlockSource::Human);
        s.feed(b"\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert_eq!(b.command, "cd /tmp");
        assert_eq!(b.output, "");
        assert!(!b.output_truncated);
    }

    /// 回放块（Fresh 镜像）：stdout/stderr 在 C→D 窗内照实采集，回放头不混入。
    #[test]
    fn replay_block_captures_output() {
        let mut s = screen();
        s.replay_fresh("docker ps", Some("cc"), "CONTAINER-1\n", "warn…", 0, "e2");
        let b = s.blocks.last_blocks(1)[0].clone();
        assert!(b.output.contains("CONTAINER-1"), "{:?}", b.output);
        assert!(b.output.contains("[stderr] warn…"), "{:?}", b.output);
        assert!(
            !b.output.contains("[agent:cc] $ docker ps"),
            "回放头不混入输出：{:?}",
            b.output
        );
    }

    /// 稳定轮（P0-1）：畸形大行号 CUP 不得产出 LF 炸弹——u32::MAX 行曾逐字节
    /// 补 ~43 亿个 LF（~4.3GB），现在钳到 CUP_LF_CAP（1024）。
    #[test]
    fn cup_huge_row_bounded_output() {
        let mut t = CupTranslator::default();
        for seq in [
            &b"\x1b[4294967295;1H"[..],
            b"\x1b[2147483647;80f",
            b"\x1b[1000000;1H",
        ] {
            let out = t.translate(seq, 24);
            let lfs = out.iter().filter(|&&b| b == b'\n').count();
            assert!(lfs <= CUP_LF_CAP as usize, "seq={:?} 产 {} 个 LF", seq, lfs);
            assert!(out.len() < 1100, "seq={:?} 输出 {} 字节", seq, out.len());
        }
    }

    /// 合法 ConPTY 超界（小差值）语义不变：底行定位 + 超界量个 LF。
    #[test]
    fn cup_small_overflow_keeps_semantics() {
        let mut t = CupTranslator::default();
        let out = t.translate(b"\x1b[57;1H", 50);
        assert!(out.starts_with(b"\x1b[50;1H"), "{:?}", out);
        assert_eq!(out.iter().filter(|&&b| b == b'\n').count(), 7);
    }

    /// 稳定轮（P1-2）：永不终结的 CSI 参数流不得让 carry 无界增长。
    #[test]
    fn cup_carry_capped_on_unterminated_csi() {
        let mut t = CupTranslator::default();
        t.translate(b"\x1b[", 24);
        let junk = vec![b'9'; 8192];
        let _ = t.translate(&junk, 24);
        assert!(t.carry.len() <= CUP_CARRY_CAP, "carry={}", t.carry.len());
        // 丢弃后新序列照常翻译（不卡死在坏态）
        let out = t.translate(b"\x1b[57;1H", 50);
        assert!(out.starts_with(b"\x1b[50;1H"), "{:?}", out);
    }

    /// 稳定轮：resize(0,0) 钳到 1×1——渲染路径 Column(cols-1) 不再 usize 下溢
    /// panic（Tauri 命令/MCP 对 cols/rows 均为 u16 直通无校验）。
    #[test]
    fn resize_zero_clamped_no_panic() {
        let mut s = screen();
        s.feed(b"hello\r\nworld");
        s.resize(0, 0);
        s.feed(b"after");
        let snap = s.snapshot_text();
        assert!(snap.contains("hello"), "钳制后旧内容仍在：{snap:?}");
        assert!(snap.contains("after"));
        // 1×1 网格渲染/检查点路径不 panic
        let _ = s.checkpoint();
    }
}
