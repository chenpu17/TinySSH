//! core-session：SessionApi 实现（L1 §2/§3.1）。
//! 双前端（GUI/MCP）唯一核心；审批在门面之后强制挂接（L0 ADR-5）。

mod brief;
mod handle;

pub use handle::{is_whitelisted, DecisionMsg, SessionHandle};

use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::transport::ChannelHandle;
use session_api::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tinyssh_approval::ApprovalEngine;
use tokio::sync::{broadcast, oneshot};
use transport_pty::LocalPtyChannel;
use transport_ssh::SshChannel;

/// 审批中心：跨会话共享的引擎、条目表、决策通道、持久化。
pub struct ApprovalCenter {
    pub engine: ApprovalEngine,
    pub items: StdMutex<HashMap<ApprovalId, ApprovalItem>>,
    pub decisions: StdMutex<HashMap<ApprovalId, oneshot::Sender<DecisionMsg>>>,
    pub approvals_tx: broadcast::Sender<ApprovalEvent>,
    pub vault: Arc<tinyssh_vault::Vault>,
    pub audit: Arc<tinyssh_audit::AuditStore>,
}

pub struct SessionManager {
    sessions: StdMutex<HashMap<SessionId, Arc<SessionHandle>>>,
    pub center: Arc<ApprovalCenter>,
    approvals_rx_gen: StdMutex<()>,
    pub data_dir: PathBuf,
}

impl SessionManager {
    pub fn open(db_path: &Path) -> Result<Arc<Self>> {
        let vault = Arc::new(tinyssh_vault::Vault::open(db_path)?);
        let audit = Arc::new(tinyssh_audit::AuditStore::open(db_path)?);
        let (approvals_tx, _) = broadcast::channel(256);
        let center = Arc::new(ApprovalCenter {
            engine: ApprovalEngine::new()?,
            items: StdMutex::new(HashMap::new()),
            decisions: StdMutex::new(HashMap::new()),
            approvals_tx,
            vault,
            audit,
        });
        Ok(Arc::new(Self {
            sessions: StdMutex::new(HashMap::new()),
            center,
            approvals_rx_gen: StdMutex::new(()),
            data_dir: db_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
        }))
    }

    pub fn audit(&self) -> &tinyssh_audit::AuditStore {
        &self.center.audit
    }

    /// MCP 端点描述（serve 由 CLI/壳负责；此处提供提示文本）。
    pub fn mcp_endpoint(&self) -> String {
        "http://127.0.0.1:8722/mcp（被占递增；以 serve 输出为准）".into()
    }

    /// 创建本地会话用的隐式主机记录。
    fn ensure_local_host(&self) -> Result<Host> {
        if let Some(h) = self
            .center
            .vault
            .list_hosts()?
            .into_iter()
            .find(|h| h.id == "local")
        {
            return Ok(h);
        }
        let draft = HostDraft {
            id: Some("local".into()),
            name: "本机".into(),
            address: "local".into(),
            port: Some(0),
            username: std::env::var("USER").unwrap_or_else(|_| "user".into()),
            auth: AuthDraft::None,
            tags: vec![],
        };
        self.center.vault.upsert_host(&draft)?;
        Ok(Host {
            id: "local".into(),
            name: "本机".into(),
            address: "local".into(),
            port: 0,
            username: draft.username,
            auth_type: AuthType::Key,
            identity_id: None,
            tags: vec![],
        })
    }

    async fn wait_create_session_approval(
        &self,
        actor: &Actor,
        client: &AgentClientId,
        host: &Host,
    ) -> Result<()> {
        let eval = tinyssh_approval::Evaluation {
            verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
            segments: vec![SegmentReport {
                segment: format!("create_session {}", host.name),
                verdict: "pending: 远程会话默认必审".into(),
            }],
        };
        let item = ApprovalItem {
            id: format!("a-{}", uuid::Uuid::new_v4()),
            session_id: String::new(),
            agent_id: client.clone(),
            command: format!("create_session host={}", host.name),
            edited_command: None,
            target_summary: "建立远程会话".into(),
            segment_report: eval.segments.clone(),
            session_busy: false,
            created_at: chrono::Utc::now(),
            status: ApprovalStatus::Pending,
        };
        let (tx, rx) = oneshot::channel();
        self.center.decisions.lock().unwrap().insert(item.id.clone(), tx);
        self.center.items.lock().unwrap().insert(item.id.clone(), item.clone());
        let _ = self.center.vault.save_approval(&item);
        let _ = self.center.approvals_tx.send(ApprovalEvent::New(item.clone()));
        let _ = self.center.audit.append(
            actor, "approval_requested", None, Some(&item.command), serde_json::json!({}), Some(&item.id));

        match tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx).await {
            Ok(Ok(DecisionMsg::Decide(Decision::Approve))) => {
                if let Some(it) = self.center.items.lock().unwrap().get_mut(&item.id) {
                    it.status = ApprovalStatus::Approved;
                }
                Ok(())
            }
            Ok(Ok(DecisionMsg::Decide(Decision::ApproveEdited(_)))) => Ok(()),
            Ok(Ok(DecisionMsg::Decide(Decision::Deny))) => {
                if let Some(it) = self.center.items.lock().unwrap().get_mut(&item.id) {
                    it.status = ApprovalStatus::Denied;
                }
                Err(Error::ApprovalDenied { reason: DeniedReason::Denied })
            }
            Ok(Ok(DecisionMsg::Voided)) | Ok(Err(_)) => {
                Err(Error::ApprovalDenied { reason: DeniedReason::Denied })
            }
            Err(_) => Err(Error::ApprovalDenied { reason: DeniedReason::ApprovalTimeout }),
        }
    }
}

fn spawn_pump(h: Arc<SessionHandle>, mut rx: tokio::sync::broadcast::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        loop {
            let mut lost = false;
            loop {
                match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                    Ok(Ok(data)) => {
                        {
                            let mut s = h.screen.lock().await;
                            s.feed(&data);
                        }
                        let _ = h.output_tx.send(OutputEvent::Raw { sid: h.id.clone(), data });
                    }
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                        let _ = h.output_tx.send(OutputEvent::Resync { sid: h.id.clone() });
                    }
                    Ok(Err(broadcast::error::RecvError::Closed)) => {
                        lost = true;
                        break;
                    }
                    Err(_timeout) => {
                        if !h.channel.is_alive().await {
                            lost = true;
                            break;
                        }
                    }
                }
            }
            let _ = lost;
            // 通路关闭：本地 = 进程退出；SSH = 断线 → 重连 + 重确认
            if h.kind != "ssh" {
                *h.state.lock().await = SessionState::Disconnected;
                return;
            }
            h.on_transport_reconnect().await;
            if *h.state.lock().await == SessionState::Disconnected {
                return;
            }
            // 先订阅新通道、再注入集成：远端回显与首个标记提示符不得落入
            // 无订阅者窗口（broadcast 无接收者即丢——并发回归中标记迟到 10s 的根因）
            rx = h.channel.subscribe_output();
            h.reinject_integration().await;
            // 外层循环：以新订阅继续泵
        }
    });
}

/// SSH 远端 shell 集成注入片段（bash/zsh 自动探测；OSC 133 + OSC 7）。
pub fn ssh_integration_snippet() -> String {
    let bash = r#"if [ -n "$BASH_VERSION" ]; then
  __t_prompt(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  PROMPT_COMMAND="__t_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS1="\[\033]133;B\007\]$PS1"
  PS0="\[\033]133;C\007\]$PS0"
fi"#;
    let zsh = r#"if [ -n "$ZSH_VERSION" ]; then
  __t_precmd(){ __rc=$?; printf '\033]7;file://%s%s\007' "$HOST" "$PWD"; printf '\033]133;D;%s\007' "$__rc"; printf '\033]133;A\007'; printf '\033]133;B\007'; }
  __t_preexec(){ printf '\033]133;C\007'; }
  precmd_functions=(__t_precmd $precmd_functions)
  preexec_functions=(__t_preexec $preexec_functions)
fi"#;
    // 末尾清屏：抹掉上面几行在远端 PTY 的回显（否则用户首连看到满屏集成代码）；
    // printf 是 shell 内建，不依赖外部 clear 二进制。
    format!("{bash}\n{zsh}\nprintf '\\033[2J\\033[H'\n")
}

#[async_trait::async_trait]
impl SessionApi for SessionManager {
    // ---- 主机与凭据 ----
    async fn list_hosts(&self, _ctx: &Actor) -> Result<Vec<Host>> {
        self.ensure_local_host()?;
        self.center.vault.list_hosts()
    }

    async fn upsert_host(&self, ctx: &Actor, host: HostDraft) -> Result<HostId> {
        let id = self.center.vault.upsert_host(&host)?;
        let _ = self.center.audit.append(
            ctx, "host_upsert", None, None,
            serde_json::json!({"host": id, "name": host.name}), None);
        Ok(id)
    }

    async fn delete_host(&self, ctx: &Actor, id: HostId) -> Result<()> {
        self.center.vault.delete_host(&id)?;
        let _ = self.center.audit.append(ctx, "host_delete", None, None, serde_json::json!({"host": id}), None);
        Ok(())
    }

    async fn list_identities(&self, _ctx: &Actor) -> Result<Vec<IdentityMeta>> {
        self.center.vault.list_identities()
    }

    async fn create_identity(&self, ctx: &Actor, req: IdentityReq) -> Result<IdentityMeta> {
        let meta = self.center.vault.create_identity(&req)?;
        let _ = self.center.audit.append(ctx, "identity_create", None, None, serde_json::json!({"id": meta.id, "kind": format!("{:?}", meta.kind)}), None);
        Ok(meta)
    }

    async fn delete_identity(&self, ctx: &Actor, id: IdentityId) -> Result<()> {
        self.center.vault.delete_identity(&id)?;
        let _ = self.center.audit.append(ctx, "identity_delete", None, None, serde_json::json!({"id": id}), None);
        Ok(())
    }

    // ---- 会话 ----
    async fn list_sessions(&self, _ctx: &Actor) -> Result<Vec<SessionInfo>> {
        let handles: Vec<Arc<SessionHandle>> = {
            let sessions = self.sessions.lock().unwrap();
            sessions.values().cloned().collect()
        };
        let mut out = Vec::new();
        for h in handles {
            out.push(SessionInfo {
                id: h.id.clone(),
                host_id: h.host.id.clone(),
                host_name: h.host.name.clone(),
                kind: h.kind.clone(),
                state: *h.state.lock().await,
                control_owner: *h.owner.lock().await,
                created_at: chrono::Utc::now(),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    async fn create_session(&self, ctx: &Actor, req: CreateSessionReq) -> Result<SessionId> {
        let (host, kind) = if req.host_id == "local" {
            (self.ensure_local_host()?, "local".to_string())
        } else {
            let host = self
                .center
                .vault
                .list_hosts()?
                .into_iter()
                .find(|h| h.id == req.host_id)
                .ok_or(Error::SessionNotFound)?;
            (host, "ssh".to_string())
        };

        // Agent 建远程会话：默认必审（L1 §4）
        if let Actor::Agent { client_id } = ctx {
            if kind == "ssh" {
                self.wait_create_session_approval(ctx, client_id, &host).await?;
            }
        }

        let sid = format!("s-{}", uuid::Uuid::new_v4());
        let cols = 120u16;
        let rows = 32u16;

        let channel: Arc<dyn ChannelHandle> = if kind == "local" {
            let (ch, _cleanup) = transport_pty::spawn_local_pty(cols, rows).await?;
            ch
        } else {
            let (auth_type, secret) = self.center.vault.host_secret(&host)?;
            let target = transport_ssh::SshTarget {
                address: host.address.clone(),
                port: host.port,
                username: host.username.clone(),
                auth_type,
                secret: secret.to_string(),
                host_key_check: None, // TOFU 记录在 SshChannel 内（测试/试点默认首连信任）
            };
            SshChannel::connect(target, cols, rows).await?
        };

        let screen = term_core::Screen::new(term_core::ScreenConfig::default());
        let handle = SessionHandle::new(sid.clone(), host.clone(), kind.clone(), channel, screen, self.center.clone());
        // 先订阅再注入：远端回显/首个标记提示符不得落入无订阅者窗口
        // （broadcast 无接收者即丢——并发回归中集成标记迟到 10s+ 的根因）
        let pump_rx = handle.channel.subscribe_output();
        spawn_pump(handle.clone(), pump_rx);
        self.sessions.lock().unwrap().insert(sid.clone(), handle.clone());

        // 远端注入 shell 集成（本地已在 PTY 启动时注入）
        if kind == "ssh" {
            let snippet = ssh_integration_snippet();
            let mut bytes = snippet.into_bytes();
            bytes.push(b'\n');
            {
                let mut s = handle.screen.lock().await;
                s.register_outgoing(&bytes, term_core::BlockSource::Human);
            }
            handle.channel.write(&bytes).await?;
            let _ = self.center.audit.append(
                ctx, "shell_integration_inject", Some(&sid), Some("OSC133+OSC7"), serde_json::json!({}), None);
        }

        // 等待集成生效（最多 10s；失败不阻断——Shell 模式将自动降级 Fresh）。
        // 窗口须覆盖全量回归时编译与测试争抢 CPU 的首个提示符延迟（实测 5s 不够）。
        for _ in 0..200 {
            if handle.screen.lock().await.shell_integration_present() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        self.center.vault.record_session(&sid, &host.id, &kind)?;
        let _ = self.center.audit.append(
            ctx, "session_created", Some(&sid), None,
            serde_json::json!({"host": host.id, "kind": kind}), None);
        Ok(sid)
    }

    async fn close_session(&self, ctx: &Actor, sid: SessionId) -> Result<()> {
        let h = self
            .sessions
            .lock()
            .unwrap()
            .get(&sid)
            .cloned()
            .ok_or(Error::SessionNotFound)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        *h.state.lock().await = SessionState::Closed;
        h.channel.close().await?;
        self.sessions.lock().unwrap().remove(&sid);
        self.center.vault.close_session_row(&sid)?;
        let _ = self.center.audit.append(ctx, "session_closed", Some(&sid), None, serde_json::json!({}), None);
        Ok(())
    }

    async fn resize(&self, _ctx: &Actor, sid: SessionId, cols: u16, rows: u16) -> Result<()> {
        let h = self.get(&sid)?;
        {
            let mut s = h.screen.lock().await;
            s.resize(cols, rows);
        }
        h.channel.resize(cols, rows).await
    }

    // ---- exec ----
    async fn exec(
        &self,
        ctx: &Actor,
        sid: SessionId,
        cmd: &str,
        opts: ExecOpts,
    ) -> Result<ExecResult> {
        let h = self.get(&sid)?;
        // Agent 策略刷新（vault → 引擎）
        if let Actor::Agent { client_id } = ctx {
            let policy = self.center.vault.load_policy(client_id);
            self.center.engine.set_policy(client_id, policy);
        }
        h.exec(ctx, cmd, opts).await
    }

    async fn cancel_exec(&self, ctx: &Actor, sid: SessionId, exec_id: ExecId) -> Result<()> {
        let h = self.get(&sid)?;
        let found = h.live_execs.lock().unwrap().get(&exec_id).map(|c| c.clone());
        match found {
            Some(c) => {
                c.cancel();
                let _ = self.center.audit.append(ctx, "exec_cancel", Some(&sid), None, serde_json::json!({"exec": exec_id}), None);
                Ok(())
            }
            None => Err(Error::InvalidInput("exec not found or finished".into())),
        }
    }

    // ---- 交互式 ----
    async fn read_screen(&self, _ctx: &Actor, sid: SessionId) -> Result<ScreenSnapshot> {
        let h = self.get(&sid)?;
        let s = h.screen.lock().await;
        let (row, col) = s.cursor();
        Ok(ScreenSnapshot {
            cols: s.config().cols,
            rows: s.config().rows,
            text: s.screen_only_text(),
            cursor_row: row,
            cursor_col: col,
            alt_screen: s.alt_screen(),
        })
    }

    async fn send_keys(&self, ctx: &Actor, sid: SessionId, keys: &str) -> Result<()> {
        let h = self.get(&sid)?;
        match ctx {
            Actor::Human => {
                *h.last_human_input.lock().await = Some(std::time::Instant::now());
                // 人类键入同样要登记：否则 B→C 键入捕获缺失，命令块 command 为空（简报/交接失明）
                {
                    let mut s = h.screen.lock().await;
                    s.register_outgoing(keys.as_bytes(), term_core::BlockSource::Human);
                }
                h.channel.write(keys.as_bytes()).await
            }
            Actor::Agent { client_id } => {
                if *h.owner.lock().await == ControlOwner::Human {
                    return Err(Error::ControlTakenByHuman);
                }
                // 重确认期间 Agent 仅开放 exec 白名单核实（与 exec 同口径，L1 §3.1）
                if *h.state.lock().await == SessionState::Reconfirming {
                    return Err(Error::ReconfirmingPending);
                }
                // 会话级授权：一次审批，接管或会话结束失效
                if !h.send_keys_auth.lock().unwrap().contains(client_id) {
                    let eval = tinyssh_approval::Evaluation {
                        verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                        segments: vec![SegmentReport {
                            segment: format!("send_keys {keys:?}"),
                            verdict: "pending: 会话级授权（一次审批，本次会话内有效）".into(),
                        }],
                    };
                    let (trace, _) = h
                        .wait_approval(ctx, client_id, &"send_keys".to_string(), &format!("send_keys {keys:?}"), &eval, CancellationToken::new())
                        .await?;
                    let _ = trace;
                    h.send_keys_auth.lock().unwrap().insert(client_id.clone());
                    // 授权后本次按键照常执行（逐次写入留痕）
                }
                // 人类输入优先：2s 内有人类输入 → 延迟排队
                let wait = {
                    let last = *h.last_human_input.lock().await;
                    match last {
                        Some(t) => HUMAN_INPUT_PRIORITY_WINDOW
                            .checked_sub(t.elapsed())
                            .unwrap_or_default(),
                        None => std::time::Duration::ZERO,
                    }
                };
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                let _ = self.center.audit.append(
                    ctx, "send_keys", Some(&sid), Some(keys), serde_json::json!({}), None);
                h.channel.write(keys.as_bytes()).await
            }
        }
    }

    async fn wait_output(&self, _ctx: &Actor, sid: SessionId, opts: WaitOpts) -> Result<OutputChunk> {
        let h = self.get(&sid)?;
        let timeout_d = opts.timeout.unwrap_or(DEFAULT_WAIT_TIMEOUT);
        let quiet_ms = opts.quiet_ms.unwrap_or(DEFAULT_QUIET_MS);
        let re = match &opts.regex {
            Some(r) => Some(
                regex::Regex::new(r)
                    .map_err(|e| Error::InvalidInput(format!("bad regex: {e}")))?,
            ),
            None => None,
        };
        let deadline = tokio::time::Instant::now() + timeout_d;
        let (watermark, notify) = {
            let s = h.screen.lock().await;
            (s.lossless_len(), s.lossless_notify())
        };
        loop {
            {
                let s = h.screen.lock().await;
                let wm = watermark.min(s.lossless_len());
                let text = s.text_since(wm);
                let matched = re.as_ref().map(|r| r.is_match(&text)).unwrap_or(false);
                if matched {
                    return Ok(OutputChunk { text, matched: true, truncated_to_cap: false });
                }
                let quiet = std::time::Duration::from_millis(quiet_ms);
                let is_quiet = s
                    .tail_ts()
                    .map(|t| (chrono::Utc::now() - t).to_std().unwrap_or_default() >= quiet)
                    .unwrap_or(false);
                if is_quiet && !text.is_empty() {
                    return Ok(OutputChunk { text, matched: false, truncated_to_cap: false });
                }
            }
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                _ = tokio::time::sleep_until(deadline) => return Err(Error::ExecTimeout),
            }
        }
    }

    async fn set_control(
        &self,
        ctx: &Actor,
        sid: SessionId,
        owner: ControlOwner,
        opts: ControlOpts,
    ) -> Result<TakeoverReport> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let h = self.get(&sid)?;
        match owner {
            ControlOwner::Human => h.takeover(opts).await,
            ControlOwner::Agent => h.handback().await,
        }
    }

    // ---- 传输 ----
    async fn upload(&self, ctx: &Actor, sid: SessionId, local: &Path, remote: &str) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), true).await
    }

    async fn download(&self, ctx: &Actor, sid: SessionId, remote: &str, local: &Path) -> Result<TransferHandle> {
        self.transfer(ctx, sid, local.to_path_buf(), remote.to_string(), false).await
    }

    async fn cancel_transfer(&self, _ctx: &Actor, t: TransferId) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        for h in sessions.values() {
            if let Some(c) = h.transfers.lock().unwrap().get(&t) {
                c.cancel();
                return Ok(());
            }
        }
        Err(Error::InvalidInput("transfer not found".into()))
    }

    // ---- 审批 ----
    async fn list_approvals(&self, _ctx: &Actor, f: ApprovalFilter) -> Result<Vec<ApprovalItem>> {
        let items = self.center.items.lock().unwrap();
        Ok(items
            .values()
            .filter(|it| {
                f.session_id.as_ref().map(|s| &it.session_id == s).unwrap_or(true)
                    && f.agent_id.as_ref().map(|a| &it.agent_id == a).unwrap_or(true)
                    && (!f.pending_only || it.status == ApprovalStatus::Pending)
            })
            .cloned()
            .collect())
    }

    fn subscribe_approvals(&self) -> broadcast::Receiver<ApprovalEvent> {
        self.center.approvals_tx.subscribe()
    }

    async fn decide_approval(&self, ctx: &Actor, id: ApprovalId, d: Decision) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let status = self.center.vault.approval_status(&id)?;
        if matches!(status, Some(ApprovalStatus::Voided)) {
            return Err(Error::InvalidInput("审批已作废（接管），不可再生效".into()));
        }
        let tx = self.center.decisions.lock().unwrap().remove(&id);
        match tx {
            Some(tx) => {
                let _ = self.center.audit.append(
                    ctx, "approval_decision", None, None, serde_json::json!({"decision": format!("{d:?}")}), Some(&id));
                tx.send(DecisionMsg::Decide(d))
                    .map_err(|_| Error::Storage("decision receiver dropped".into()))
            }
            None => Err(Error::InvalidInput("no pending approval with this id".into())),
        }
    }

    // ---- 审计 ----
    async fn query_audit(&self, _ctx: &Actor, f: AuditFilter) -> Result<AuditPage> {
        self.center.audit.query(&f)
    }

    async fn export_audit(&self, _ctx: &Actor, f: AuditFilter, to: &Path) -> Result<()> {
        self.center.audit.export(&f, to)?;
        Ok(())
    }

    // ---- 简报 ----
    async fn get_session_brief(&self, _ctx: &Actor, sid: SessionId) -> Result<SessionBrief> {
        let h = self.get(&sid)?;
        Ok(brief::compute(&h).await)
    }

    fn subscribe_output(&self, sid: SessionId) -> Result<broadcast::Receiver<OutputEvent>> {
        let h = self.get(&sid)?;
        Ok(h.output_tx.subscribe())
    }
}

impl SessionManager {
    fn get(&self, sid: &str) -> Result<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap()
            .get(sid)
            .cloned()
            .ok_or(Error::SessionNotFound)
    }

    async fn transfer(
        &self,
        ctx: &Actor,
        sid: SessionId,
        local: PathBuf,
        remote: String,
        is_upload: bool,
    ) -> Result<TransferHandle> {
        let h = self.get(&sid)?;
        if !ctx.is_human() && *h.owner.lock().await == ControlOwner::Human {
            return Err(Error::ControlTakenByHuman);
        }
        // 重确认期间 Agent 动作被拒（L1 §3.1：普通动作不开放）
        if !ctx.is_human() && *h.state.lock().await == SessionState::Reconfirming {
            return Err(Error::ReconfirmingPending);
        }
        // Agent 传输必审（L1 §4）
        let mut edited: Option<String> = None;
        if let Actor::Agent { client_id } = ctx {
            let op = if is_upload { "upload" } else { "download" };
            let eval = tinyssh_approval::Evaluation {
                verdict: tinyssh_approval::SegmentVerdict::NeedsApproval,
                segments: vec![SegmentReport {
                    segment: format!("{op} → {remote}"),
                    verdict: "pending: 传输必审".into(),
                }],
            };
            let (trace, e) = h
                .wait_approval(ctx, client_id, &"transfer".to_string(), &format!("{op} {local:?} → {remote}"), &eval, CancellationToken::new())
                .await?;
            let _ = trace;
            let _ = e;
        }
        let _ = edited.take();

        let tid = format!("t-{}", uuid::Uuid::new_v4());
        let handle = TransferHandle {
            id: tid.clone(),
            session_id: sid.clone(),
            kind: if is_upload { TransferKind::Upload } else { TransferKind::Download },
            local: local.clone(),
            remote: remote.clone(),
        };
        let cancel = CancellationToken::new();
        h.transfers.lock().unwrap().insert(tid.clone(), cancel.clone());

        // 执行任务（串行化并入 exec 队列之外的独立通道；MVP 直接执行）
        let h2 = h.clone();
        let sid2 = sid.clone();
        let tid2 = tid.clone();
        let ctx2 = ctx.clone();
        let gen = h.generation.load(std::sync::atomic::Ordering::SeqCst);
        let remote2 = remote.clone();
        let local2 = local.clone();
        tokio::spawn(async move {
            if h2.generation.load(std::sync::atomic::Ordering::SeqCst) != gen {
                let _ = h2.center.audit.append(
                    &ctx2, "transfer_voided", Some(&sid2), Some(&remote2),
                    serde_json::json!({"reason": "voided_by_handback"}), None);
                h2.transfers.lock().unwrap().remove(&tid2);
                return;
            }
            let r = if is_upload {
                h2.channel.upload(&local2, &remote2, &cancel).await
            } else {
                h2.channel.download(&remote2, &local2, &cancel).await
            };
            match r {
                Ok(bytes) => {
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_done", Some(&sid2), Some(&remote2),
                        serde_json::json!({"bytes": bytes}), None);
                }
                Err(e) => {
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"error": e.to_string()}), None);
                }
            }
            h2.transfers.lock().unwrap().remove(&tid2);
        });
        Ok(handle)
    }
}
