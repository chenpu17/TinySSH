//! core-session：SessionApi 实现（L1 §2/§3.1）。
//! 双前端（GUI/MCP）唯一核心；审批在门面之后强制挂接（L0 ADR-5）。

mod brief;
mod charset;
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
    /// 主机指纹待决（路线图⑤ TOFU）：pending 表 + 决策通道 + 事件推送。
    pub hk_pending: StdMutex<HashMap<String, PendingHostKey>>,
    pub hk_decisions: StdMutex<HashMap<String, oneshot::Sender<bool>>>,
    pub hk_tx: broadcast::Sender<PendingHostKey>,
    /// 2FA 人工应答待决（路线图⑩）：pending 表（含应答通道）+ 事件推送。
    pub ap_pending: StdMutex<HashMap<String, (PendingAuthPrompt, oneshot::Sender<String>)>>,
    pub ap_tx: broadcast::Sender<PendingAuthPrompt>,
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
        let (hk_tx, _) = broadcast::channel(16);
        let (ap_tx, _) = broadcast::channel(16);
        let center = Arc::new(ApprovalCenter {
            engine: ApprovalEngine::new()?,
            items: StdMutex::new(HashMap::new()),
            decisions: StdMutex::new(HashMap::new()),
            approvals_tx,
            hk_pending: StdMutex::new(HashMap::new()),
            hk_decisions: StdMutex::new(HashMap::new()),
            hk_tx,
            ap_pending: StdMutex::new(HashMap::new()),
            ap_tx,
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
            charset: Charset::Utf8,
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
            fingerprint: None,
            charset: Charset::Utf8,
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

/// TOFU 主机指纹门（路线图⑤）：vault 已信任且一致 → 静默放行；
/// 首连 → 确认弹窗；不一致 → 变更红色告警。人类放行后指纹入库。
/// 拒绝/超时返回 HostKeyRejected（经 russh 透传为 create_session 的错误）。
async fn host_key_gate(
    center: &Arc<ApprovalCenter>,
    ctx: &Actor,
    host: &Host,
    fp: &str,
) -> Result<bool> {
    let stored = center.vault.host_fingerprint(&host.id)?;
    if stored.as_deref() == Some(fp) {
        return Ok(true);
    }
    let issue = if stored.is_some() {
        HostKeyIssue::Changed
    } else {
        HostKeyIssue::FirstSeen
    };
    let item = PendingHostKey {
        id: format!("hk-{}", uuid::Uuid::new_v4()),
        host_id: host.id.clone(),
        host_name: host.name.clone(),
        address: host.address.clone(),
        port: host.port,
        issue,
        fingerprint: fp.to_string(),
        previous_fingerprint: stored,
        created_at: chrono::Utc::now(),
    };
    let _ = center.audit.append(
        ctx, "host_key_confirm_requested", None, Some(&host.name),
        serde_json::json!({"id": item.id, "issue": format!("{issue:?}"), "fingerprint": fp}), None);
    let (tx, rx) = oneshot::channel();
    center.hk_decisions.lock().unwrap().insert(item.id.clone(), tx);
    center.hk_pending.lock().unwrap().insert(item.id.clone(), item.clone());
    let _ = center.hk_tx.send(item.clone());
    match tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(true)) => {
            center.vault.set_host_fingerprint(&host.id, fp)?;
            let _ = center.audit.append(
                ctx, "host_key_trusted", None, Some(&host.name),
                serde_json::json!({"fingerprint": fp}), None);
            Ok(true)
        }
        // 拒绝 / 待决项消失 / 超时：pending 表仅超时需自清（decide 已自清）
        Ok(Ok(false)) => Err(Error::HostKeyRejected("用户拒绝连接".into())),
        Ok(Err(_)) => Err(Error::HostKeyRejected("确认通道已关闭".into())),
        Err(_) => {
            center.hk_pending.lock().unwrap().remove(&item.id);
            Err(Error::HostKeyRejected("确认超时".into()))
        }
    }
}

/// 2FA 人工应答门（路线图⑩）：keyboard-interactive 非密码类提示挂起等人类。
/// 应答串经 oneshot 送回 transport；取消/超时返回 None（transport 侧终止认证）。
async fn auth_prompt_gate(
    center: &Arc<ApprovalCenter>,
    ctx: &Actor,
    host: &Host,
    prompt: &str,
    echo: bool,
) -> Result<Option<String>> {
    let item = PendingAuthPrompt {
        id: format!("ap-{}", uuid::Uuid::new_v4()),
        host_name: host.name.clone(),
        name: String::new(),
        instructions: String::new(),
        prompt: prompt.to_string(),
        echo,
        created_at: chrono::Utc::now(),
    };
    let _ = center.audit.append(
        ctx, "auth_prompt_requested", None, Some(&host.name),
        serde_json::json!({"id": item.id, "prompt": prompt, "echo": echo}), None);
    let (tx, rx) = oneshot::channel();
    center.ap_pending.lock().unwrap().insert(item.id.clone(), (item.clone(), tx));
    let _ = center.ap_tx.send(item.clone());
    match tokio::time::timeout(DEFAULT_APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(answer)) => {
            let _ = center.audit.append(
                ctx, "auth_prompt_answered", None, Some(&host.name),
                serde_json::json!({"id": item.id, "answer_len": answer.chars().count()}), None);
            if answer.is_empty() { Ok(None) } else { Ok(Some(answer)) }
        }
        // 取消（空应答通道关闭）/ 待决项消失 / 超时：pending 仅超时需自清
        Ok(Err(_)) => Ok(None),
        Err(_) => {
            center.ap_pending.lock().unwrap().remove(&item.id);
            Ok(None)
        }
    }
}

fn spawn_pump(h: Arc<SessionHandle>, mut rx: tokio::sync::broadcast::Receiver<Vec<u8>>) {
    tokio::spawn(async move {
        // 会话级流式解码器（GBK）：多字节序列可跨 chunk 切开，须全程同一实例；
        // 解码后屏态与订阅广播只见 UTF-8（GBK 尾字节撞 ASCII，裸喂会腐蚀屏态）
        let mut decoder = charset::CharsetDecoder::new(h.host.charset);
        loop {
            let mut lost = false;
            loop {
                match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                    Ok(Ok(data)) => {
                        let data = decoder.feed(&data);
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
                        // 通路关闭：冲刷悬空的半个多字节序列（尾字节永远不到 → U+FFFD 落屏）
                        let tail = decoder.flush();
                        if !tail.is_empty() {
                            h.screen.lock().await.feed(&tail);
                            let _ = h.output_tx.send(OutputEvent::Raw { sid: h.id.clone(), data: tail });
                        }
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
            // TOFU 指纹门（路线图⑤）：闭包只捕获 ApprovalCenter，避免回指 SessionManager
            let center = self.center.clone();
            let gate_host = host.clone();
            let gate_ctx = ctx.clone();
            let gate: transport_ssh::HostKeyCheck = Arc::new(move |fp| {
                let center = center.clone();
                let host = gate_host.clone();
                let ctx = gate_ctx.clone();
                let fp = fp.to_string(); // owned 后再装箱：future 不借入参（HRTB 约束）
                Box::pin(async move { host_key_gate(&center, &ctx, &host, &fp).await })
            });
            // 2FA 人工应答门（路线图⑩）：kb 非密码提示 → 挂起等人类（同指纹门模式）
            let kb_center = self.center.clone();
            let kb_host = host.clone();
            let kb_ctx = ctx.clone();
            let kb_gate: transport_ssh::KbPromptCheck = Arc::new(move |prompt, echo| {
                let center = kb_center.clone();
                let host = kb_host.clone();
                let ctx = kb_ctx.clone();
                let prompt = prompt.to_string(); // owned 后再装箱（HRTB 约束，同上）
                Box::pin(async move { auth_prompt_gate(&center, &ctx, &host, &prompt, echo).await })
            });
            let target = transport_ssh::SshTarget {
                address: host.address.clone(),
                port: host.port,
                username: host.username.clone(),
                auth_type,
                secret: secret.to_string(),
                host_key_check: Some(gate),
                kb_prompt_check: Some(kb_gate),
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

        // 远端注入 shell 集成（本地已在 PTY 启动时注入）。
        // 登记用原 UTF-8（屏态吃泵侧解码后的回显）；snippet 纯 ASCII，GBK 下编码恒等。
        if kind == "ssh" {
            let snippet = ssh_integration_snippet();
            let mut text = snippet.to_string();
            text.push('\n');
            {
                let mut s = handle.screen.lock().await;
                s.register_outgoing(text.as_bytes(), term_core::BlockSource::Human);
            }
            handle.channel.write(&charset::encode(handle.host.charset, &text)).await?;
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
                // 人类键入同样要登记：否则 B→C 键入捕获缺失，命令块 command 为空（简报/交接失明）。
                // ESC 开头的 meta/导航序列（⌥← 发 \x1bb、⌥⌫ 发 \x17 等）不是命令文本——
                // 登记的话裸 ESC 后的字母会残留在简报里（"…ddd"+\x1bb+Z 显示成 "dddbZ"）。
                if !keys.contains('\x1b') {
                    let mut s = h.screen.lock().await;
                    s.register_outgoing(keys.as_bytes(), term_core::BlockSource::Human);
                }
                h.channel.write(&charset::encode(h.host.charset, keys)).await
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
                h.channel.write(&charset::encode(h.host.charset, keys)).await
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

    // 人类浏览远端目录（FR-7）：只读、不经审批、不入审计（浏览非动作）；
    // Agent 无此入口（MCP 无 list 工具——上传下载仍走 upload/download 必审口径）
    async fn sftp_list(&self, ctx: &Actor, sid: SessionId, path: &str) -> Result<Vec<DirEntryS>> {
        if !ctx.is_human() {
            return Err(Error::InvalidInput("sftp_list 仅人类浏览入口".into()));
        }
        let h = self.get(&sid)?;
        h.channel.list_dir(path).await
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
                // 审计必须自证「实际放行了什么」：编辑后批准以 edited 文本为准，
                // 否则时间线上只有「审批决定」四个字，追责时无从核对（PV R1）。
                let item = self.center.items.lock().unwrap().get(&id).cloned();
                let (sid, cmd, decision_key) = match &d {
                    Decision::Approve => (
                        item.as_ref().map(|i| i.session_id.clone()),
                        item.as_ref().map(|i| i.command.clone()),
                        "approve",
                    ),
                    Decision::ApproveEdited(c) => (
                        item.as_ref().map(|i| i.session_id.clone()),
                        Some(c.clone()),
                        "approve_edited",
                    ),
                    Decision::Deny => (item.as_ref().map(|i| i.session_id.clone()), None, "deny"),
                };
                let _ = self.center.audit.append(
                    ctx, "approval_decision",
                    sid.as_deref(), cmd.as_deref(),
                    serde_json::json!({"decision": decision_key}), Some(&id));
                tx.send(DecisionMsg::Decide(d))
                    .map_err(|_| Error::Storage("decision receiver dropped".into()))
            }
            None => Err(Error::InvalidInput("no pending approval with this id".into())),
        }
    }

    // ---- 主机指纹门（路线图⑤ TOFU）----
    async fn pending_host_keys(&self, _ctx: &Actor) -> Result<Vec<PendingHostKey>> {
        Ok(self
            .center
            .hk_pending
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect())
    }

    fn subscribe_host_keys(&self) -> broadcast::Receiver<PendingHostKey> {
        self.center.hk_tx.subscribe()
    }

    async fn decide_host_key(&self, ctx: &Actor, id: &str, accept: bool) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let tx = self.center.hk_decisions.lock().unwrap().remove(id);
        let item = self.center.hk_pending.lock().unwrap().remove(id);
        match (tx, item) {
            (Some(tx), Some(item)) => {
                let _ = self.center.audit.append(
                    ctx, "host_key_decision", None, Some(&item.host_name),
                    serde_json::json!({"accept": accept, "issue": format!("{:?}", item.issue), "fingerprint": item.fingerprint}), None);
                tx.send(accept)
                    .map_err(|_| Error::Storage("host key gate receiver dropped".into()))
            }
            _ => Err(Error::InvalidInput("no pending host key with this id".into())),
        }
    }

    // ---- 2FA 人工应答门（路线图⑩）----
    async fn pending_auth_prompts(&self, _ctx: &Actor) -> Result<Vec<PendingAuthPrompt>> {
        Ok(self
            .center
            .ap_pending
            .lock()
            .unwrap()
            .values()
            .map(|(item, _)| item.clone())
            .collect())
    }

    fn subscribe_auth_prompts(&self) -> broadcast::Receiver<PendingAuthPrompt> {
        self.center.ap_tx.subscribe()
    }

    async fn answer_auth_prompt(&self, ctx: &Actor, id: &str, answer: &str) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let (item, tx) = self
            .center
            .ap_pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| Error::InvalidInput("no pending auth prompt with this id".into()))?;
        // 空串 = 取消：oneshot 关闭让 gate 返回 None；非空送应答
        if answer.is_empty() {
            let _ = self.center.audit.append(
                ctx, "auth_prompt_answered", None, Some(&item.host_name),
                serde_json::json!({"id": item.id, "cancelled": true}), None);
            drop(tx);
            Ok(())
        } else {
            tx.send(answer.to_string())
                .map_err(|_| Error::Storage("auth prompt gate receiver dropped".into()))
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

    // ---- 任务目标/交接留言（R9：人类→Agent 委托入口）----
    async fn set_session_goal(&self, ctx: &Actor, sid: SessionId, goal: Option<String>) -> Result<()> {
        if !ctx.is_human() {
            return Err(Error::InvalidActor);
        }
        let h = self.get(&sid)?;
        // 空串归一 None（清除语义）
        let goal = goal.and_then(|g| {
            let t = g.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
        *h.goal.lock().unwrap() = goal.clone();
        let _ = self.center.audit.append(
            ctx,
            "goal_set",
            Some(&sid),
            goal.as_deref(),
            serde_json::json!({ "cleared": goal.is_none() }),
            None,
        );
        h.note_transition(match &goal {
            Some(_) => "人类更新任务目标（Agent 读简报可见）",
            None => "人类清除任务目标",
        })
        .await;
        Ok(())
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

    /// 手动重连（GUI「重连」按钮；不在 SessionApi/MCP 面——断线恢复是人的基础设施动作）。
    /// 前置：会话处于 Disconnected（pump 已退出，自动重连 3 次均已失败或本地 shell 已死）。
    /// 与自动重连同构，但泵已不在：先订阅（broadcast 不因重连更换，UI 既有订阅继续有效）
    /// → 重建传输（SSH 原地重连保留 TOFU 指纹；本地重启新 shell）→ 重启泵 → 现场重置 → 重注入。
    pub async fn reconnect_session(&self, sid: &str) -> Result<()> {
        let h = self.get(sid)?;
        {
            let st = *h.state.lock().await;
            match st {
                SessionState::Disconnected => {
                    *h.state.lock().await = SessionState::Reconnecting;
                }
                SessionState::Reconnecting => {
                    return Err(Error::InvalidInput("重连已在进行中".into()));
                }
                _ => return Err(Error::InvalidInput("会话未处于断开状态，无需重连".into())),
            }
        }
        h.note_transition("手动重连：重建连接").await;
        // 先订阅：新传输的输出不得落入无订阅者窗口（§6.1-11 同源根因）
        let rx = h.channel.subscribe_output();
        let mut last_err = None;
        for attempt in 1..=3 {
            match h.channel.reconnect().await {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    tracing::warn!(session = %sid, attempt, "manual reconnect: {e}");
                    last_err = Some(e);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
        if let Some(e) = last_err {
            *h.state.lock().await = SessionState::Disconnected;
            h.note_transition("手动重连失败（仍断开，可再试）").await;
            return Err(e);
        }
        h.reset_scene_after_reconnect().await;
        spawn_pump(h.clone(), rx);
        if h.kind == "ssh" {
            h.reinject_integration().await;
        } else {
            // 本地重连 = 新 shell（rcfile 已带集成，无需注入）；现场事实同样降级
            h.verification_hits
                .store(0, std::sync::atomic::Ordering::SeqCst);
            *h.state.lock().await = SessionState::Reconfirming;
            h.note_transition("重连成功，进入重确认（仅内置只读白名单可用）")
                .await;
        }
        let _ = self.center.audit.append(
            &Actor::Human,
            "session_reconnect",
            Some(sid),
            None,
            serde_json::json!({}),
            None,
        );
        Ok(())
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
                    serde_json::json!({"transfer": tid2, "reason": "voided_by_handback"}), None);
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
                        serde_json::json!({"transfer": tid2, "bytes": bytes}), None);
                }
                Err(e) => {
                    let _ = h2.center.audit.append(
                        &ctx2, "transfer_failed", Some(&sid2), Some(&remote2),
                        serde_json::json!({"transfer": tid2, "error": e.to_string()}), None);
                }
            }
            h2.transfers.lock().unwrap().remove(&tid2);
        });
        Ok(handle)
    }
}

// ---------------------------------------------------------------------------
// ~/.ssh/config 导入（路线图⑨）：CLI 与 GUI 共用的组合逻辑。
// 解析在 vault::sshcfg（纯函数）；这里做路径解析、与现有主机对账、
// 身份落库（IdentityFile → Key）或 ssh-agent 引用（无 IdentityFile → Agent）。
// ---------------------------------------------------------------------------

impl SessionManager {
    fn ssh_config_path(explicit: Option<&Path>) -> PathBuf {
        match explicit {
            Some(p) => p.to_path_buf(),
            None => std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join(".ssh/config"))
                .unwrap_or_else(|| PathBuf::from(".ssh/config")),
        }
    }

    fn load_entries(explicit: Option<&Path>) -> Result<Vec<tinyssh_vault::sshcfg::SshConfigEntry>> {
        let path = Self::ssh_config_path(explicit);
        let content = std::fs::read_to_string(&path).map_err(|e| {
            Error::InvalidInput(format!("读取 {} 失败: {e}", path.display()))
        })?;
        let mut entries = tinyssh_vault::sshcfg::parse_ssh_config(&content);
        // 同名 Host 块会被 ssh 合并；去重避免重复导入
        entries.dedup_by(|a, b| a.name == b.name);
        Ok(entries)
    }

    fn default_username(entry: &tinyssh_vault::sshcfg::SshConfigEntry) -> String {
        entry
            .username
            .clone()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_else(|| "root".into())
    }

    /// 预览：解析 + 与现有主机对账（同名或同 address+port+user 视为已导入）。
    pub async fn ssh_config_preview(
        &self,
        path: Option<&Path>,
    ) -> Result<Vec<SshConfigPreview>> {
        let entries = Self::load_entries(path)?;
        let existing = self.list_hosts(&Actor::Human).await?;
        Ok(entries
            .into_iter()
            .map(|e| {
                let username = Self::default_username(&e);
                let port = e.port.unwrap_or(22);
                SshConfigPreview {
                    already_imported: existing.iter().any(|h| {
                        h.name == e.name
                            || (h.address == e.address
                                && h.port == port
                                && h.username == username)
                    }),
                    has_identity: e.identity_path.is_some(),
                    name: e.name,
                    address: e.address,
                    port,
                    username,
                }
            })
            .collect())
    }

    /// 勾选导入。逐条出结果，单条失败不阻塞其余（UI 逐行展示）。
    /// 有 IdentityFile 且可读 → 私钥入 vault（Key）；否则走本机 ssh-agent（Agent）。
    pub async fn ssh_config_import(
        &self,
        ctx: &Actor,
        path: Option<&Path>,
        names: &[String],
    ) -> Vec<SshImportOutcome> {
        let mut out = Vec::new();
        let entries = match Self::load_entries(path) {
            Ok(e) => e,
            Err(e) => {
                return names
                    .iter()
                    .map(|n| SshImportOutcome {
                        name: n.clone(),
                        host_id: None,
                        error: Some(e.to_string()),
                    })
                    .collect();
            }
        };
        for name in names {
            let Some(entry) = entries.iter().find(|e| &e.name == name) else {
                out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some("配置中找不到该条目".into()),
                });
                continue;
            };
            let r = async {
                let auth = match &entry.identity_path {
                    Some(p) => {
                        let pem = tokio::fs::read_to_string(p).await.map_err(|e| {
                            Error::InvalidInput(format!("读取私钥 {} 失败: {e}", p.display()))
                        })?;
                        let meta = self
                            .create_identity(
                                ctx,
                                IdentityReq::Import {
                                    label: name.clone(),
                                    pem,
                                    passphrase: None,
                                },
                            )
                            .await
                            .map_err(|e| match e {
                                // 加密私钥无口令解不开：明说，不静默降级
                                Error::InvalidInput(m) if m.contains("passphrase") => {
                                    Error::InvalidInput("私钥有口令，请先在应用内手工导入".into())
                                }
                                other => other,
                            })?;
                        AuthDraft::Key { identity_id: meta.id }
                    }
                    None => AuthDraft::Agent,
                };
                self.upsert_host(
                    ctx,
                    HostDraft {
                        id: None,
                        name: name.clone(),
                        address: entry.address.clone(),
                        port: Some(entry.port.unwrap_or(22)),
                        username: Self::default_username(entry),
                        auth,
                        tags: vec!["ssh-config".into()],
                        charset: Charset::Utf8,
                    },
                )
                .await
            }
            .await;
            match r {
                Ok(hid) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: Some(hid),
                    error: None,
                }),
                Err(e) => out.push(SshImportOutcome {
                    name: name.clone(),
                    host_id: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        out
    }
}
