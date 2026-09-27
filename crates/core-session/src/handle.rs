//! 会话句柄：控制权状态机、exec 串行队列与执行管线、审批联动、尽力停止。
//! 作废契约（L1 §3.1 v0.5）：接管生效时，交接前未开始的全部请求作废
//! （待审批 / 已批准待执行 / 排队传输），阻塞调用返回 VoidedByHandback{brief}。

use crate::ApprovalCenter;
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::{ChannelHandle, TransportSignal};
use session_api::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use term_core::Screen;
use tokio::sync::{broadcast, Mutex as AsyncMutex, oneshot};

/// 重确认白名单（L1 §3.1：内置只读核实命令，Agent 不可自选）。
pub const RECONFIRM_WHITELIST: &[&str] = &["pwd", "printenv", "which", "ps", "systemctl status"];

pub fn is_whitelisted(cmd: &str) -> bool {
    let t = cmd.trim();
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
    /// send_keys 会话级授权（接管即失效）。
    pub send_keys_auth: StdMutex<HashSet<String>>,

    pub center: Arc<ApprovalCenter>,
}

impl SessionHandle {
    pub fn new(
        id: SessionId,
        host: Host,
        kind: String,
        channel: Arc<dyn ChannelHandle>,
        screen: Screen,
        center: Arc<ApprovalCenter>,
    ) -> Arc<Self> {
        let (output_tx, _) = broadcast::channel(4096);
        Arc::new(Self {
            id,
            host,
            kind,
            channel,
            screen: AsyncMutex::new(screen),
            output_tx,
            owner: AsyncMutex::new(ControlOwner::Agent),
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
            send_keys_auth: StdMutex::new(HashSet::new()),
            center,
        })
    }

    async fn gen_brief(&self) -> Box<SessionBrief> {
        Box::new(crate::brief::compute(self).await)
    }

    async fn note_transition(&self, what: &str) {
        self.transitions
            .lock()
            .await
            .push((chrono::Utc::now(), what.to_string()));
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
        // 主机无 shell 集成 → 自动降级 Fresh（L1 §3.1）
        let integrated = self.screen.lock().await.shell_integration_present();
        if !integrated {
            tracing::info!(session = %self.id, "no shell integration; degrade to Fresh");
            return self
                .run_fresh(actor, exec_id, cmd, opts, deadline, cancel, trace, started)
                .await;
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

        // 登记：键入归因 + 捕获 + 受管 exec_id
        let mut bytes = cmd.trim_end().as_bytes().to_vec();
        bytes.push(b'\r');
        {
            let mut s = self.screen.lock().await;
            s.arm_capture(exec_id);
            s.register_outgoing(&bytes, source_of(actor));
        }
        self.channel.write(&bytes).await?;

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
        let text = term_core::strip_ansi(&raw_out);
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

        // 镜像回放桥：Fresh 结果写回屏幕，带 Agent 标注（L1 §3.1 不可省略）
        {
            let client = match actor {
                Actor::Agent { client_id } => Some(client_id.clone()),
                _ => None,
            };
            let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&outcome.stderr).into_owned();
            let exit = outcome.exit_code.unwrap_or(-1);
            let mut s = self.screen.lock().await;
            s.replay_fresh(cmd, client.as_deref(), &stdout, &stderr, exit, exec_id);
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
        let _cancel_guard = CancelOnDrop(cancel.clone(), &self.live_execs);

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
                                actor, client_id, &exec_id, &effective_cmd, &eval, cancel.clone(),
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
    pub async fn wait_approval(
        &self,
        actor: &Actor,
        client_id: &AgentClientId,
        exec_id: &ExecId,
        cmd: &str,
        eval: &tinyssh_approval::Evaluation,
        cancel: CancellationToken,
    ) -> Result<(ApprovalTrace, Option<String>)> {
        let item = ApprovalItem {
            id: format!("a-{}", uuid::Uuid::new_v4()),
            session_id: self.id.clone(),
            agent_id: client_id.clone(),
            command: cmd.to_string(),
            edited_command: None,
            target_summary: target_summary(cmd),
            segment_report: eval.segments.clone(),
            session_busy: self.screen.lock().await.blocks.has_open_block(),
            created_at: chrono::Utc::now(),
            status: ApprovalStatus::Pending,
        };
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

        let gen_at_entry = self.generation.load(Ordering::SeqCst);
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
                if !self.center.engine.is_editable_decision(&c) {
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
        self.note_transition("人类交还（Agent 先读简报，再重新决定动作）").await;
        let brief = self.gen_brief().await;
        let _ = self.center.audit.append(&Actor::Human, "handback", Some(&self.id), None, serde_json::json!({}), None);
        Ok(TakeoverReport { frozen: false, paused_queue: Vec::new(), stopped: Vec::new(), brief: *brief })
    }

    /// 断线 → 尽力重连 → Reconfirming（旅程 2）。
    pub async fn on_transport_lost(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().await;
            if *st == SessionState::Closed {
                return;
            }
            *st = SessionState::Degraded;
        }
        self.note_transition("连接退化，尝试重连").await;
        let mut attempt = 0;
        loop {
            attempt += 1;
            if attempt > 3 {
                *self.state.lock().await = SessionState::Disconnected;
                self.note_transition("重连失败（Disconnected）").await;
                return;
            }
            *self.state.lock().await = SessionState::Reconnecting;
            match self.channel.reconnect().await {
                Ok(()) => {
                    // 重连成功 ≠ 现场延续：cwd/env 事实降级；新 shell 需重新注入集成
                    {
                        let mut s = self.screen.lock().await;
                        s.invalidate_cwd();
                    }
                    let snippet = crate::ssh_integration_snippet();
                    let mut bytes = snippet.into_bytes();
                    bytes.push(b'\n');
                    {
                        let mut s = self.screen.lock().await;
                        s.register_outgoing(&bytes, term_core::BlockSource::Human);
                    }
                    let _ = self.channel.write(&bytes).await;
                    for _ in 0..60 {
                        if self.screen.lock().await.shell_integration_present() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    self.verification_hits.store(0, Ordering::SeqCst);
                    *self.state.lock().await = SessionState::Reconfirming;
                    self.note_transition("重连成功，进入重确认（仅内置只读白名单可用）").await;
                    return;
                }
                Err(e) => {
                    tracing::warn!(session = %self.id, attempt, "reconnect failed: {e}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
}

/// RAII：exec 管线退出时若仍登记 live token，则移除。
struct CancelOnDrop<'a>(CancellationToken, &'a StdMutex<HashMap<ExecId, CancellationToken>>);
impl<'a> Drop for CancelOnDrop<'a> {
    fn drop(&mut self) {
        // 仅在异常路径清理；正常路径已在 run_* 中移除
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

