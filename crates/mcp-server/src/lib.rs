//! MCP 工具实现（L1 §4）：rmcp streamable HTTP + per-client Bearer Token。
//! 身份仅来自 Token（协议参数不可指定）；错误映射为 isError 载荷（永不挂起协议层）。

use core_session::SessionManager;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::common::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::tool;
use rmcp::tool_handler;
use rmcp::tool_router;
use rmcp::ServerHandler;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use session_api::transport::tokio_util_sync::CancellationToken;
use session_api::{
    Actor, ApprovalFilter, AuditFilter, ControlOpts, ControlOwner, CreateSessionReq, Decision,
    DeniedReason, Epistemic, Error, ExecMode, ExecOpts, SessionApi, StopPolicy, WaitOpts,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Bearer Token 解析器（vault 单一事实源；内存缓存可选）。
#[derive(Clone)]
pub struct TokenResolver {
    pub vault: Arc<tinyssh_vault::Vault>,
}

impl TokenResolver {
    pub fn resolve(&self, bearer: &str) -> Option<String> {
        self.vault.resolve_token(bearer)
    }
}

#[derive(Clone)]
pub struct McpState {
    pub api: Arc<SessionManager>,
    pub resolver: TokenResolver,
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
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct TransferReq {
    pub session_id: String,
    pub local: String,
    pub remote: String,
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
    let client = state
        .resolver
        .resolve(token)
        .ok_or(Error::InvalidActor)?;
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
        Error::ExecTimeout => "exec_timeout",
        Error::Cancelled => "cancelled",
        Error::QueueBusy { .. } => "queue_busy",
        Error::InvalidActor => "invalid_actor",
        Error::InvalidInput(_) => "invalid_input",
        Error::Storage(_) => "storage",
        Error::Io(_) => "io",
    }
}

fn error_detail(e: &Error) -> serde_json::Value {
    match e {
        Error::VoidedByHandback { brief } => serde_json::json!({ "brief": brief }),
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
            Ok(api.list_hosts(&actor).await?)
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
            Ok(api.list_sessions(&actor).await?)
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
        description = "读取现场简报（cwd/最近命令/运行中任务/待审批；交接核心工件）",
        annotations(read_only_hint = true)
    )]
    pub async fn get_session_brief(
        &self,
        Extension(parts): Extension<HttpParts>,
        p: Parameters<SessionRefReq>,
    ) -> CallToolResult {
        run(&self.state, &parts, |api, actor| async move {
            Ok(api.get_session_brief(&actor, p.0.session_id).await?)
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
            Ok(api.read_screen(&actor, p.0.session_id).await?)
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
            Ok(api.wait_output(&actor, p.0.session_id, opts).await?)
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
            let handle = api
                .upload(&actor, p.0.session_id, PathBuf::from(&p.0.local).as_path(), &p.0.remote)
                .await?;
            Ok::<_, Error>(serde_json::json!({"transfer_id": handle.id}))
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
            let handle = api
                .download(&actor, p.0.session_id, &p.0.remote, PathBuf::from(&p.0.local).as_path())
                .await?;
            Ok::<_, Error>(serde_json::json!({"transfer_id": handle.id}))
        })
        .await
    }
}

/// 工具调用的统一入口：身份解析 → SessionApi → 结果/错误序列化。
async fn run<F, Fut, T>(state: &McpState, parts: &http::request::Parts, f: F) -> CallToolResult
where
    F: FnOnce(Arc<SessionManager>, Actor) -> Fut,
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
    let ok = bearer
        .and_then(|t| state.resolver.resolve(t))
        .is_some();
    if !ok {
        return axum::response::Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .header("WWW-Authenticate", "Bearer")
            .body(axum::body::Body::from(r#"{"error":"unauthorized"}"#))
            .unwrap();
    }
    next.run(req).await
}
