//! MCP 工具实现（L1 §4）：rmcp streamable HTTP + per-client Bearer Token。
//! 身份仅来自 Token（协议参数不可指定）；错误映射为 isError 载荷（永不挂起协议层）。

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::common::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, Implementation, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::tool;
use rmcp::tool_handler;
use rmcp::tool_router;
use rmcp::ServerHandler;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_api::{
    Actor, AuditFilter, CollisionDecision, CreateSessionReq, DeniedReason, Error, ExecMode, ExecOpts, SessionApi,
    TargetStat, TransferHandle, TransferStatus, WaitOpts,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Bearer Token 解析器（由装配层注入；mcp-server 只依赖 session-api 契约，L1 §1）。
pub type TokenResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct McpState {
    /// 双前端对等：MCP 面向 SessionApi 门面（L1 §1 依赖规则）
    pub api: Arc<dyn SessionApi>,
    pub resolver: TokenResolver,
}

impl McpState {
    pub fn new(api: Arc<dyn SessionApi>, resolver: TokenResolver) -> Self {
        Self { api, resolver }
    }
}

/// 工具参数结构。
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ListHostsReq {}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ListSessionsReq {}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct CreateSessionReq_ {
    /// 主机 id（"local" = 本机）
    pub host_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ExecReq {
    pub session_id: String,
    pub command: String,
    /// shell（V1 默认，现场延续）/ fresh（独立通道，真实退出码）
    #[serde(default)]
    pub mode: Option<String>,
    /// 秒；自审批放行起算
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct CancelExecReq {
    pub session_id: String,
    pub exec_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct CloseSessionReq {
    pub session_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct SessionRefReq {
    pub session_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ReadScreenReq {
    pub session_id: String,
    /// text（渲染后纯文本）
    #[serde(default)]
    pub style: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct SendKeysReq {
    pub session_id: String,
    pub keys: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct WaitOutputReq {
    pub session_id: String,
    /// 静默期毫秒
    #[serde(default)]
    pub quiet_ms: Option<u64>,
    #[serde(default)]
    pub regex: Option<String>,
    /// 秒
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct QueryAuditReq {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    /// R41（§6.6）：按 actor_kind 过滤（"human" | "agent"）；与 agent_id 正交。
    #[serde(default)]
    pub actor_kind: Option<String>,
    /// R41：按动作名精确过滤（如 "exec" / "forward_start"）。
    #[serde(default)]
    pub action: Option<String>,
    /// R41（「记录连续」）：seq 游标——只取 seq 更早的记录，供翻页。
    #[serde(default)]
    pub before_seq: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct TransferReq {
    pub session_id: String,
    pub local: String,
    pub remote: String,
    /// C6/R34 DF6.2：预冲突处置——缺省 fail（目标已存在 → 结构化 ConflictDetected，
    /// 不建任务）；"skip"=同名即跳过（Skipped 终态）；"overwrite"=显式覆盖（审批卡
    /// 明示「将覆盖已存在目标」；能力不足按 ReplaceUnsupported 结构化失败）。
    #[serde(default)]
    pub collision: Option<String>,
}

/// DF6.2：collision 参数解析（缺省 fail=None 语义）。
fn parse_collision(raw: Option<&str>) -> session_api::Result<Option<CollisionDecision>> {
    match raw {
        None | Some("") => Ok(None),
        Some("skip") => Ok(Some(CollisionDecision::Skip)),
        Some("overwrite") => Ok(Some(CollisionDecision::Overwrite)),
        Some(other) => Err(Error::InvalidInput(format!(
            "collision 仅支持 skip|overwrite|fail（缺省 fail），得到 {other:?}"
        ))),
    }
}

/// DF6.2：预检窗口等待——任务离开 Queued/Running 早期阶段（冲突/跳过在数据
/// 阶段前落定）即结构化返回；长传输即时交还 transfer_id（对账走 transfer_list）。
async fn wait_transfer_preflight(
    api: &Arc<dyn SessionApi>,
    actor: &Actor,
    handle: &TransferHandle,
) -> serde_json::Value {
    for _ in 0..30 {
        if let Ok(list) = api.list_transfers(actor).await {
            if let Some(t) = list.iter().find(|t| t.id == handle.id) {
                match t.status {
                    TransferStatus::Queued | TransferStatus::Running => {}
                    TransferStatus::Committing => {
                        return serde_json::json!({
                            "transfer_id": handle.id, "status": t.status,
                            "note": "传输进行中（提交窗口）；对账走 transfer_list",
                        });
                    }
                    _ => {
                        return serde_json::json!({
                            "transfer_id": handle.id, "status": t.status,
                            "error": t.error,
                            "collision_decision": t.collision_decision,
                        });
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    serde_json::json!({
        "transfer_id": handle.id, "status": "Queued",
        "note": "预检未在窗口内完成（排队/慢链路）；对账走 transfer_list",
    })
}

// ---- 端口转发（T44 V1 收口，FR-8）：McpForwardSpec 复刻 session-api 的
// ForwardSpec 外部标签形态（session-api 无 schemars 依赖，按本 crate 既有
// Req 结构复刻模式），转换即结构对结构。----
#[derive(Serialize, Deserialize, JsonSchema)]
pub enum McpForwardSpec {
    /// 本地转发 -L：本地 listen_addr:listen_port → target_host:target_port
    Local { listen_addr: String, listen_port: u16, target_host: String, target_port: u16 },
    /// 远程转发 -R：服务器 listen_addr:listen_port → 本机 target_host:target_port
    Remote { listen_addr: String, listen_port: u16, target_host: String, target_port: u16 },
    /// 动态转发 -D（SOCKS5）：本地 listen_addr:listen_port
    Dynamic { listen_addr: String, listen_port: u16 },
}

impl From<McpForwardSpec> for session_api::ForwardSpec {
    fn from(s: McpForwardSpec) -> Self {
        match s {
            McpForwardSpec::Local { listen_addr, listen_port, target_host, target_port } =>
                session_api::ForwardSpec::Local { listen_addr, listen_port, target_host, target_port },
            McpForwardSpec::Remote { listen_addr, listen_port, target_host, target_port } =>
                session_api::ForwardSpec::Remote { listen_addr, listen_port, target_host, target_port },
            McpForwardSpec::Dynamic { listen_addr, listen_port } =>
                session_api::ForwardSpec::Dynamic { listen_addr, listen_port },
        }
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ForwardStartReq {
    pub session_id: String,
    pub spec: McpForwardSpec,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ForwardStopReq {
    pub session_id: String,
    pub forward_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ForwardListReq {
    pub session_id: String,
}

pub struct McpServer {
    state: McpState,
    tool_router: ToolRouter<Self>,
}

/// 从 HTTP Parts 提取 Bearer → Actor（身份仅来自 Token，L1 §3.5）。
fn actor_from_parts(parts: &http::request::Parts, state: &McpState) -> Result<Actor, Error> {
    let auth = parts
        .headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(Error::InvalidActor)?;
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .ok_or(Error::InvalidActor)?;
    let client = (state.resolver)(token).ok_or(Error::InvalidActor)?;
    Ok(Actor::Agent { client_id: client })
}

fn result_json(v: impl Serialize) -> CallToolResult {
    let json = serde_json::to_value(v).unwrap_or(serde_json::json!({}));
    CallToolResult::structured(json)
}

fn error_result(e: &Error) -> CallToolResult {
    let payload = serde_json::json!({
        "error": e.to_string(),
        "kind": error_kind(e),
        "detail": error_detail(e),
    });
    CallToolResult::structured_error(payload)
}

fn error_kind(e: &Error) -> &'static str {
    match e {
        Error::ApprovalDenied { reason } => match reason {
            DeniedReason::Denied => "approval_denied",
            DeniedReason::ApprovalTimeout => "approval_timeout",
            DeniedReason::DangerousPattern => "dangerous_pattern",
        },
        Error::ControlTakenByHuman => "control_taken_by_human",
        Error::VoidedByHandback { .. } => "voided_by_handback",
        Error::ReconfirmingPending => "reconfirming_pending",
        Error::SessionNotFound => "session_not_found",
        Error::SessionClosed => "session_closed",
        Error::AuthFailed => "auth_failed",
        Error::ConnectFailed(_) => "connect_failed",
        Error::HostKeyRejected(_) => "host_key_rejected",
        Error::ExecTimeout => "exec_timeout",
        Error::ShellIntegrationUnavailable { .. } => "shell_integration_unavailable",
        Error::Cancelled => "cancelled",
        Error::QueueBusy { .. } => "queue_busy",
        Error::InvalidActor => "invalid_actor",
        Error::InvalidInput(_) => "invalid_input",
        Error::IdentityInUse { .. } => "identity_in_use",
        Error::Storage(_) => "storage",
        Error::Io(_) => "io",
        Error::SftpPathNotFound { .. } => "sftp_path_not_found",
        Error::SftpPermissionDenied { .. } => "sftp_permission_denied",
        Error::ConflictDetected { .. } => "conflict_detected",
        Error::ReplaceUnsupported { .. } => "replace_unsupported",
        Error::StaleDecision { .. } => "stale_decision",
        Error::InvalidTransferState { .. } => "invalid_transfer_state",
        Error::ForwardListenFailed { .. } => "forward_listen_failed",
        Error::CollabDisabled => "collab_disabled",
    }
}

fn error_detail(e: &Error) -> serde_json::Value {
    match e {
        Error::VoidedByHandback { brief } => serde_json::json!({ "brief": brief }),
        Error::IdentityInUse { host_names } => serde_json::json!({ "host_names": host_names }),
        Error::ShellIntegrationUnavailable { available } => {
            serde_json::json!({ "available": available })
        }
        Error::SftpPathNotFound { path } | Error::SftpPermissionDenied { path } => {
            serde_json::json!({ "path": path })
        }
        Error::ConflictDetected {
            target_path,
            target_stat,
        } => serde_json::json!({ "target_path": target_path, "target_stat": target_stat }),
        Error::ReplaceUnsupported { capability } => {
            serde_json::json!({ "capability": capability })
        }
        Error::StaleDecision { expect_revision } => {
            serde_json::json!({ "expect_revision": expect_revision })
        }
        Error::InvalidTransferState { task_id, state } => {
            serde_json::json!({ "task_id": task_id, "state": state })
        }
        Error::ForwardListenFailed { field, reason } => {
            serde_json::json!({ "field": field, "reason": reason })
        }
        _ => serde_json::Value::Null,
    }
}

#[tool_router(router = tool_router)]
impl McpServer {
    pub fn new(state: McpState) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(name = "list_hosts", description = "列出已配置的主机", annotations(read_only_hint = true))]
    pub async fn list_hosts(
        &self,
        Extension(parts): Extension<HttpParts>,
        _p: Parameters<ListHostsReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.list_hosts(&actor).await
        })
        .await
    }

    #[tool(name = "list_sessions", description = "列出活动会话", annotations(read_only_hint = true))]
    pub async fn list_sessions(
        &self,
        Extension(parts): Extension<HttpParts>,
        _p: Parameters<ListSessionsReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.list_sessions(&actor).await
        })
        .await
    }

    #[tool(name = "create_session", description = "建立到主机的共享会话（远程默认需人工审批）")]
    pub async fn create_session(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<CreateSessionReq_>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let sid = api
                .create_session(&actor, CreateSessionReq { host_id: p.0.host_id })
                .await?;
            Ok::<_, Error>(serde_json::json!({"session_id": sid}))
        })
        .await
    }

    #[tool(
        name = "exec",
        description = "在共享会话中执行命令。shell 模式默认：cwd/env 现场延续；危险命令需人工审批",
        annotations(destructive_hint = true)
    )]
    pub async fn exec(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<ExecReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, move |api, actor| async move {
            let mode = match p.0.mode.as_deref() {
                Some("fresh") => ExecMode::Fresh,
                _ => ExecMode::Shell,
            };
            let opts = ExecOpts {
                mode,
                timeout: p.0.timeout.map(Duration::from_secs),
                ..Default::default()
            };
            let r = api.exec(&actor, p.0.session_id, &p.0.command, opts).await?;
            Ok::<_, Error>(serde_json::json!({
                "exec_id": r.exec_id,
                "exit_code": r.exit_code,
                "stdout": r.stdout,
                "stderr": r.stderr,
                "truncated": r.truncated,
                "duration_ms": r.duration.as_millis() as u64,
                "approval": r.approval.outcome,
            }))
        })
        .await
    }

    #[tool(name = "cancel_exec", description = "取消排队或运行中的执行")]
    pub async fn cancel_exec(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<CancelExecReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.cancel_exec(&actor, p.0.session_id, p.0.exec_id).await?;
            Ok::<_, Error>(serde_json::json!({}))
        })
        .await
    }

    #[tool(name = "close_session", description = "关闭会话（控制权在人类时被拒）")]
    pub async fn close_session(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<CloseSessionReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.close_session(&actor, p.0.session_id).await?;
            Ok::<_, Error>(serde_json::json!({}))
        })
        .await
    }

    #[tool(
        name = "get_session_brief",
        description = "读取现场简报（cwd/最近命令/运行中任务/待审批/任务目标 goal；交接核心工件——接管后先读 goal 了解人类委托意图）",
        annotations(read_only_hint = true)
    )]
    pub async fn get_session_brief(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<SessionRefReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.get_session_brief(&actor, p.0.session_id).await
        })
        .await
    }

    #[tool(name = "query_audit", description = "查询审计事件", annotations(read_only_hint = true))]
    pub async fn query_audit(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<QueryAuditReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let page = api
                .query_audit(
                    &actor,
                    AuditFilter {
                        session_id: p.0.session_id,
                        agent_id: p.0.agent_id,
                        actor_kind: p.0.actor_kind,
                        action: p.0.action,
                        before_seq: p.0.before_seq,
                        limit: p.0.limit.unwrap_or(50),
                        ..Default::default()
                    },
                )
                .await?;
            Ok::<_, Error>(serde_json::json!({"total": page.total, "events": page.events}))
        })
        .await
    }

    #[tool(name = "read_screen", description = "读取屏幕快照（渲染后文本，含回滚）", annotations(read_only_hint = true))]
    pub async fn read_screen(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<ReadScreenReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.read_screen(&actor, p.0.session_id).await
        })
        .await
    }

    #[tool(
        name = "send_keys",
        description = "向会话发送按键（需一次会话级授权；控制权在人类时被拒）",
        annotations(destructive_hint = true)
    )]
    pub async fn send_keys(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<SendKeysReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.send_keys(&actor, p.0.session_id, &p.0.keys).await?;
            Ok(serde_json::json!({}))
        })
        .await
    }

    #[tool(name = "wait_output", description = "等待会话出现新输出（静默期或正则命中）", annotations(read_only_hint = true))]
    pub async fn wait_output(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<WaitOutputReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let opts = WaitOpts {
                quiet_ms: p.0.quiet_ms,
                regex: p.0.regex,
                timeout: p.0.timeout.map(Duration::from_secs),
            };
            api.wait_output(&actor, p.0.session_id, opts).await
        })
        .await
    }

    #[tool(name = "upload", description = "上传文件到远程主机", annotations(destructive_hint = true))]
    pub async fn upload(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<TransferReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let collision = parse_collision(p.0.collision.as_deref())?;
            // DF6.2 fail（缺省）：目标已存在 → 不建任务，结构化 ConflictDetected
            //（含目标 stat）；skip/overwrite 交任务预检裁决
            if collision.is_none() {
                match api.sftp_stat(&actor, p.0.session_id.clone(), p.0.remote.clone()).await {
                    Ok(st) => {
                        return Err(Error::ConflictDetected {
                            target_path: p.0.remote.clone(),
                            target_stat: Some(TargetStat { size: st.size, mtime: st.mtime }),
                        });
                    }
                    Err(Error::SftpPathNotFound { .. }) => {}
                    Err(e) => return Err(e),
                }
            }
            let handle = api
                .upload(&actor, p.0.session_id, PathBuf::from(&p.0.local).as_path(), &p.0.remote, collision)
                .await?;
            Ok::<_, Error>(wait_transfer_preflight(&api, &actor, &handle).await)
        })
        .await
    }

    #[tool(name = "download", description = "从远程主机下载文件", annotations(destructive_hint = true))]
    pub async fn download(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<TransferReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let collision = parse_collision(p.0.collision.as_deref())?;
            if collision.is_none() {
                match api.sftp_stat(&actor, p.0.session_id.clone(), p.0.local.clone()).await {
                    Ok(st) => {
                        return Err(Error::ConflictDetected {
                            target_path: p.0.local.clone(),
                            target_stat: Some(TargetStat { size: st.size, mtime: st.mtime }),
                        });
                    }
                    Err(Error::SftpPathNotFound { .. }) => {}
                    Err(e) => return Err(e),
                }
            }
            let handle = api
                .download(&actor, p.0.session_id, &p.0.remote, PathBuf::from(&p.0.local).as_path(), collision)
                .await?;
            Ok::<_, Error>(wait_transfer_preflight(&api, &actor, &handle).await)
        })
        .await
    }

    // ---- 端口转发（T44 V1 收口）：Agent 建隧道/停隧道在 core 层走逐段审批 ----

    #[tool(name = "forward_start", description = "建立端口转发（本地 -L / 远程 -R / SOCKS5 -D；需人工审批）", annotations(destructive_hint = true))]
    pub async fn forward_start(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<ForwardStartReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let fid = api.start_forward(&actor, p.0.session_id, p.0.spec.into()).await?;
            Ok::<_, Error>(serde_json::json!({ "forward_id": fid }))
        })
        .await
    }

    #[tool(name = "forward_stop", description = "停止端口转发（可能中断链路；需人工审批）", annotations(destructive_hint = true))]
    pub async fn forward_stop(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<ForwardStopReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            api.stop_forward(&actor, p.0.session_id, p.0.forward_id).await?;
            Ok::<_, Error>(serde_json::json!({ "stopped": true }))
        })
        .await
    }

    #[tool(name = "forwards_list", description = "列出会话的端口转发及状态（监听中/降级/失败）", annotations(read_only_hint = true))]
    pub async fn forwards_list(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<ForwardListReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let list = api.list_forwards(&actor, p.0.session_id).await?;
            Ok::<_, Error>(serde_json::json!({ "forwards": list }))
        })
        .await
    }

    // ---- C5（R32）：任务注册表查询——进度/终态不靠猜（upload/download 返回
    // transfer_id 后，用本工具对账状态与字节数）----

    #[tool(name = "transfer_list", description = "列出文件传输任务（状态/进度/字节数；含近期已完成任务）", annotations(read_only_hint = true))]
    pub async fn transfer_list(
        &self,
        Extension(parts): Extension<HttpParts>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            let list = api.list_transfers(&actor).await?;
            Ok::<_, Error>(serde_json::json!({ "transfers": list }))
        })
        .await
    }
}

/// 工具调用的统一入口：身份解析 → SessionApi → 结果/错误序列化。
async fn run<F, Fut, T>(state: &McpState, parts: &http::request::Parts, f: F) -> CallToolResult
where
    F: FnOnce(Arc<dyn SessionApi>, Actor) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
    T: Serialize,
{
    let actor = match actor_from_parts(parts, state) {
        Ok(a) => a,
        Err(e) => return error_result(&e),
    };
    match f(state.api.clone(), actor).await {
        Ok(v) => result_json(v),
        Err(e) => error_result(&e),
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("tinyssh-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions("TinySSH 人机协同 SSH：exec 默认 shell 模式（现场延续），审批/接管/简报保障知情与可控")
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        std::borrow::Cow::Borrowed(&[ProtocolVersion::V_2025_03_26, ProtocolVersion::V_2025_06_18])
    }
}

pub use http::request::Parts as HttpParts;

// Re-export for axum assembly
pub use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};

/// 组装 axum 路由：Bearer 认证中间件 + /mcp 端点。
pub fn build_router(state: McpState, config: StreamableHttpServerConfig) -> axum::Router {
    let factory_state = state.clone();
    let service: StreamableHttpService<McpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(McpServer::new(factory_state.clone())),
            Default::default(),
            config,
        );
    let auth_state = state.clone();
    axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            auth_middleware,
        ))
}

/// 端口占用递增绑定（L1 §3.5）：从 `port` 起逐 +1，最多试 32 个。
/// `port = 0` 时由 OS 分配临时端口（测试用）。
pub async fn bind_increment(port: u16) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    let mut actual = port;
    loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", actual)).await {
            Ok(l) => {
                let bound = l.local_addr()?.port();
                return Ok((l, bound));
            }
            Err(_) if port != 0 && actual < port.saturating_add(31) => {
                // 占口提示（审核低-1：cli 重构后提示丢失，端口漂移无从排查）
                eprintln!("[mcp] port {actual} occupied, trying next…");
                actual += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// 进程内起 MCP HTTP 端点（T43 §6-7 收口：GUI 装配用——与 GUI 命令共享同一
/// SessionApi 实例，Agent 卡片直接进本进程审批队列）。返回实际端口。
/// 需在 tokio runtime 上下文中调用（内部 tokio::spawn 承载 axum::serve）。
///
/// **legacy / 测试专用**：无停机语义（句柄被 `mem::forget`，端点长驻、不可停）。
/// C9（R43）起应用侧一律改用 [`spawn_endpoint_with_shutdown`]（停用协作需可停）。
pub async fn spawn_endpoint(
    api: Arc<dyn SessionApi>,
    resolver: TokenResolver,
    port: u16,
) -> std::io::Result<u16> {
    let (actual, handle) = spawn_endpoint_with_shutdown(api, resolver, port).await?;
    // 旧 API 无停机语义：泄漏句柄保持 watch 发送端存活，端点进程内长驻（否则句柄一
    // 落地即触发优雅停机）。需要可停端点请用 spawn_endpoint_with_shutdown。
    std::mem::forget(handle);
    Ok(actual)
}

/// C9（R43）：可停端点句柄。`stop()` 触发 axum **优雅停机**——监听器随即释放
/// （新连接被拒），已接纳连接按各自语义收敛（长流会话不阻塞监听器释放）。
#[derive(Clone)]
pub struct EndpointHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    /// C9（R43）：停机**完成**信号——`axum::serve` 返回（监听器确已释放）后置真。
    /// 供应用侧「确认端点已停止」而非「发信号即当已停」（§9 两层均需确认）。
    stopped: tokio::sync::watch::Receiver<bool>,
    port: u16,
}

impl EndpointHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 触发优雅停机（幂等）。
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// 是否已收到停机信号。
    pub fn is_stopping(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// 是否已确认停机完成（监听器已释放）。
    pub fn is_stopped(&self) -> bool {
        *self.stopped.borrow()
    }

    /// 等待监听器**确实**释放（`axum::serve` 返回）。调用方自行加超时。
    pub async fn wait_stopped(&mut self) {
        if *self.stopped.borrow() {
            return;
        }
        let _ = self.stopped.changed().await;
    }
}

/// C9（R43）：起端点并返回关闭句柄（停用协作时据以停止应用拥有的监听器）。
pub async fn spawn_endpoint_with_shutdown(
    api: Arc<dyn SessionApi>,
    resolver: TokenResolver,
    port: u16,
) -> std::io::Result<(u16, EndpointHandle)> {
    let state = McpState::new(api, resolver);
    let config = StreamableHttpServerConfig::default().with_json_response(true);
    let router = build_router(state, config);
    let (listener, actual) = bind_increment(port).await?;
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let (stopped_tx, stopped_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                // 初始值为 false；收到 true（或发送端 drop）即触发停机。
                let _ = rx.changed().await;
            })
            .await;
        // serve 返回 = 监听器已释放（新连接被拒）
        let _ = stopped_tx.send(true);
    });
    Ok((actual, EndpointHandle { shutdown: tx, stopped: stopped_rx, port: actual }))
}

async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<McpState>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let bearer = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")));
    let ok = bearer.and_then(|t| (state.resolver)(t)).is_some();
    if !ok {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .header("WWW-Authenticate", "Bearer")
            .body(axum::body::Body::from(r#"{"error":"unauthorized"}"#))
            .unwrap();
    }
    next.run(req).await
}
