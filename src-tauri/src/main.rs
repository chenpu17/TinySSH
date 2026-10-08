//! TinySSH 应用壳（L1 §1）：装配各 crate、Tauri commands、Channel 桥。
//! GUI 与 MCP 双前端对等：本 crate 只依赖 session-api 契约 + core-session 装配。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use tauri::{Emitter, State};

struct AppState {
    api: Arc<SessionManager>,
}

/// 终端聚焦状态（native Ctrl 键接管依据：只有 xterm textarea 聚焦时才劫持）。
#[derive(Default)]
struct TerminalInput {
    sid: std::sync::Mutex<Option<String>>,
    focused: std::sync::Mutex<bool>,
}

#[tauri::command]
fn note_terminal(state: State<'_, Arc<TerminalInput>>, sid: Option<String>, focused: bool) -> CmdResult<()> {
    *state.sid.lock().unwrap() = sid;
    *state.focused.lock().unwrap() = focused;
    Ok(())
}

fn human() -> Actor {
    Actor::Human
}

type ApiState<'a> = State<'a, AppState>;

/// wire 错误信封（R10 统一错误映射）：不再把 session-api::Error 拍平成中文字符串，
/// 而是结构化 `{ kind, message, detail }` 过桥。kind 为稳定 snake_case 契约值——
/// 现有 16 变体逐一映射 + 前向预留 r03-contracts §11 ADR-15 的 11 个新 kind
/// （后端未实现前不会出现，FE parser 按开放集合接收）。message 保留 thiserror
/// 人话文案，UI 现有 friendlyError 行为不变。
#[derive(Debug, Clone, serde::Serialize)]
struct WireError {
    kind: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

impl WireError {
    fn simple(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.to_string(), message: message.into(), detail: None }
    }
}

impl From<String> for WireError {
    fn from(s: String) -> Self {
        Self::simple("invalid_input", s)
    }
}

impl From<std::io::Error> for WireError {
    fn from(e: std::io::Error) -> Self {
        Self::simple("io", e.to_string())
    }
}

impl From<session_api::Error> for WireError {
    fn from(e: session_api::Error) -> Self {
        // kind/detail 单点映射归核心 Error::wire_parts（C1 三端一致，R19 起）；
        // 这里只补 message
        let (kind, detail) = e.wire_parts();
        Self { kind: kind.to_string(), message: e.to_string(), detail }
    }
}

type CmdResult<T> = std::result::Result<T, WireError>;

#[tauri::command]
async fn list_hosts(state: ApiState<'_>) -> CmdResult<Vec<Host>> {
    state.api.list_hosts(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn upsert_host(state: ApiState<'_>, host: HostDraft) -> CmdResult<HostId> {
    state.api.upsert_host(&human(), host).await.map_err(WireError::from)
}

#[tauri::command]
async fn delete_host(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state.api.delete_host(&human(), id).await.map_err(WireError::from)
}

#[tauri::command]
async fn create_identity(state: ApiState<'_>, req: IdentityReq) -> CmdResult<IdentityMeta> {
    state.api.create_identity(&human(), req).await.map_err(WireError::from)
}

#[tauri::command]
async fn list_identities(state: ApiState<'_>) -> CmdResult<Vec<IdentityMeta>> {
    state.api.list_identities(&human()).await.map_err(WireError::from)
}

/// R21 凭据基础管理：删除前核心侧引用检查（被主机引用 → IdentityInUse{host_names}）
#[tauri::command]
async fn delete_identity(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state.api.delete_identity(&human(), id).await.map_err(WireError::from)
}

/// ~/.ssh/config 导入：解析预览（path 缺省 = ~/.ssh/config）
#[tauri::command]
async fn ssh_config_preview(
    state: ApiState<'_>,
    path: Option<String>,
) -> CmdResult<Vec<SshConfigPreview>> {
    state
        .api
        .ssh_config_preview(path.as_deref().map(std::path::Path::new))
        .await
        .map_err(WireError::from)
}

/// ~/.ssh/config 导入：按勾选条目落库
#[tauri::command]
async fn ssh_config_import(
    state: ApiState<'_>,
    path: Option<String>,
    names: Vec<String>,
    overwrite: Option<bool>,
) -> CmdResult<Vec<SshImportOutcome>> {
    Ok(state
        .api
        .ssh_config_import(
            &human(),
            path.as_deref().map(std::path::Path::new),
            &names,
            overwrite.unwrap_or(false),
        )
        .await)
}

#[tauri::command]
async fn list_sessions(state: ApiState<'_>) -> CmdResult<Vec<SessionInfo>> {
    state.api.list_sessions(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn create_session(state: ApiState<'_>, host_id: String) -> CmdResult<SessionId> {
    state
        .api
        .create_session(&human(), CreateSessionReq { host_id })
        .await
        .map_err(WireError::from)
}

// ---- C1 建连尝试（R19；camelCase 入参 / snake_case 出参同 v1 命令口径）----

#[tauri::command]
async fn begin_connection(
    state: ApiState<'_>,
    host_id: String,
    opts: Option<BeginConnectionOpts>,
) -> CmdResult<AttemptInfo> {
    state
        .api
        .begin_connection(&human(), host_id, opts.unwrap_or_default())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn connection_status(state: ApiState<'_>, attempt_id: String) -> CmdResult<AttemptInfo> {
    state
        .api
        .connection_status(&human(), attempt_id)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn cancel_connection(state: ApiState<'_>, attempt_id: String) -> CmdResult<CancelOutcome> {
    state
        .api
        .cancel_connection(&human(), attempt_id)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn close_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.close_session(&human(), sid).await.map_err(WireError::from)
}

/// 断线会话一键重连（T13）：仅 Disconnected 会话；成功后进入重确认。
#[tauri::command]
async fn reconnect_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.reconnect_session(&sid).await.map_err(WireError::from)
}

/// R26（§6.4「可停止重试」）：停止自动重连（≤250ms 内落 Disconnected）。
/// 幂等：非重连期为合法 no-op。
#[tauri::command]
async fn stop_auto_reconnect(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.stop_auto_reconnect(&sid).await.map_err(WireError::from)
}

/// R26：会话状态快照（demo/兜底轮询面；真实 UI 走 session-state 事件）。
#[tauri::command]
async fn session_state_feed(state: ApiState<'_>) -> CmdResult<Vec<SessionStateEvent>> {
    let list = state.api.list_sessions(&Actor::Human).await.map_err(WireError::from)?;
    Ok(list
        .into_iter()
        .map(|s| SessionStateEvent {
            session_id: s.id,
            state: s.state,
            attempt: None,
            max_attempts: None,
            detail: None,
        })
        .collect())
}

/// SFTP 上传（T20）：本地绝对路径 → 远端路径。人类直传（Agent 侧走 MCP 工具且必审），
/// 结果经审计 transfer_done/transfer_failed 广播（payload 带 transfer id 供 UI 对账）。
#[tauri::command]
async fn upload_file(state: ApiState<'_>, sid: String, local: String, remote: String) -> CmdResult<TransferHandle> {
    state
        .api
        .upload(&human(), sid, std::path::Path::new(&local), &remote)
        .await
        .map_err(WireError::from)
}

/// SFTP 下载（T20）：远端路径 → 本地。local 省略时存入 ~/Downloads/<远端文件名>。
#[tauri::command]
async fn download_file(
    state: ApiState<'_>,
    sid: String,
    remote: String,
    local: Option<String>,
) -> CmdResult<TransferHandle> {
    let dest = match local {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let name = remote.rsplit('/').find(|s| !s.is_empty()).unwrap_or("download").to_string();
            dirs_or_home().join("Downloads").join(name)
        }
    };
    state
        .api
        .download(&human(), sid, &remote, &dest)
        .await
        .map_err(WireError::from)
}

/// 取消进行中的传输（取消语义：传输任务收到 Cancelled，审计记 transfer_failed/已取消）。
#[tauri::command]
async fn cancel_transfer(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state.api.cancel_transfer(&human(), id).await.map_err(WireError::from)
}

/// C5（R32）：任务注册表查询——UI 重挂对账与事件漏收兜底（创建倒序全量）。
#[tauri::command]
async fn list_transfers(state: ApiState<'_>) -> CmdResult<Vec<TransferTask>> {
    state.api.list_transfers(&human()).await.map_err(WireError::from)
}

/// SFTP 目录浏览（T41 FR-7）：只读 readdir，人类专属入口（不经审批）。
#[tauri::command]
async fn sftp_list(state: ApiState<'_>, sid: String, path: String) -> CmdResult<Vec<DirEntryS>> {
    state.api.sftp_list(&human(), sid, &path).await.map_err(WireError::from)
}

/// C4（R30）：路径规范化。path=None → 连接初始目录（SFTP "."）。
#[tauri::command]
async fn sftp_resolve_path(
    state: ApiState<'_>,
    sid: String,
    path: Option<String>,
) -> CmdResult<PathResolved> {
    state
        .api
        .sftp_resolve_path(&human(), sid, path)
        .await
        .map_err(WireError::from)
}

/// C4（R30）：条目元数据（kind/symlink/未知字段语义见 EntryStat）。
#[tauri::command]
async fn sftp_stat(state: ApiState<'_>, sid: String, path: String) -> CmdResult<EntryStat> {
    state.api.sftp_stat(&human(), sid, path).await.map_err(WireError::from)
}

/// 端口转发（T42 FR-8）：列/建/停（人类 GUI 入口；Agent 侧留 MCP 审批版）。
#[tauri::command]
async fn list_forwards(state: ApiState<'_>, sid: String) -> CmdResult<Vec<ForwardInfo>> {
    state.api.list_forwards(&human(), sid).await.map_err(WireError::from)
}

#[tauri::command]
async fn start_forward(state: ApiState<'_>, sid: String, spec: ForwardSpec) -> CmdResult<ForwardId> {
    state.api.start_forward(&human(), sid, spec).await.map_err(WireError::from)
}

#[tauri::command]
async fn stop_forward(state: ApiState<'_>, sid: String, id: String) -> CmdResult<()> {
    state.api.stop_forward(&human(), sid, id).await.map_err(WireError::from)
}

/// 打开终端里的链接（T16 OSC8/URL）：仅 http/https，走系统默认浏览器。
/// scheme 白名单防「open file://…」或自定义 scheme 被外部处理器利用。
/// UI 偏好读取（路线图⑥：字号/主题；管理面直连 vault，§6.9 既有先例）
#[tauri::command]
fn get_setting(state: ApiState<'_>, key: String) -> CmdResult<Option<String>> {
    state.api.center.vault.get_setting(&key).map_err(WireError::from)
}

#[tauri::command]
fn set_setting(state: ApiState<'_>, key: String, value: String) -> CmdResult<()> {
    state.api.center.vault.set_setting(&key, &value).map_err(WireError::from)
}

// ---- C8 偏好与主机元数据（R15；经 SessionApi 走 Human 通道与审计）----
#[tauri::command]
async fn get_workspace(state: ApiState<'_>) -> CmdResult<Workspace> {
    state.api.get_workspace(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn set_workspace(state: ApiState<'_>, ws: Workspace) -> CmdResult<Workspace> {
    state
        .api
        .set_workspace(&human(), ws)
        .await
        .map_err(WireError::from)?;
    state.api.get_workspace(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn set_host_favorite(state: ApiState<'_>, host_id: String, favorite: bool) -> CmdResult<()> {
    state
        .api
        .set_host_favorite(&human(), host_id, favorite)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn list_host_metadata(state: ApiState<'_>) -> CmdResult<Vec<HostMeta>> {
    state.api.list_host_metadata(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn list_recent_hosts(state: ApiState<'_>) -> CmdResult<Vec<RecentHost>> {
    state.api.list_recent_hosts(&human()).await.map_err(WireError::from)
}

#[tauri::command]
async fn open_url(url: String) -> CmdResult<()> {    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(WireError::simple("invalid_input", "仅支持 http/https 链接"));
    }
    tokio::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(WireError::from)?;
    Ok(())
}

#[tauri::command]
async fn resize(state: ApiState<'_>, sid: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.api.resize(&human(), sid, cols, rows).await.map_err(WireError::from)
}

/// 输出流订阅：Channel 桥（可丢 broadcast + 失步 resync，L0 ADR-2/7；C10 R11）。
/// 返回订阅身份 + 检查点 + 水位；Raw 帧加 8 字节 LE seq 帧头（UI 剥头取 seq）。
/// 桥 task 绑定订阅身份：send 失败（订阅端通道已关）或 broadcast 关闭即兜底退订。
#[tauri::command]
async fn subscribe_output(
    state: ApiState<'_>,
    sid: String,
    on_event: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    window: tauri::Window<tauri::Wry>,
) -> CmdResult<AttachOutput> {
    let (attach, mut rx, mut cancel) = state
        .api
        .subscribe_output_channel(sid.clone())
        .await
        .map_err(WireError::from)?;
    let sub = attach.subscription_id.clone();
    let api = state.api.clone();
    let emit_sid = sid.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.changed() => break, // 显式退订：转发终结
                ev = rx.recv() => {
                    match ev {
                        Ok(OutputEvent::Raw { seq, data, .. }) => {
                            // L0 SPIKE-1 结论：原始字节直通（JSON 数字数组会使吞吐降一个量级）
                            let mut frame = Vec::with_capacity(8 + data.len());
                            frame.extend_from_slice(&seq.to_le_bytes());
                            frame.extend_from_slice(&data);
                            if on_event.send(tauri::ipc::InvokeResponseBody::Raw(frame)).is_err() {
                                break;
                            }
                        }
                        Ok(OutputEvent::Resync { .. }) => {
                            let _ = window.emit(
                                "resync",
                                serde_json::json!({
                                    "session_id": emit_sid, "from_seq": null, "subscription_id": sub,
                                }),
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = window.emit(
                                "resync",
                                serde_json::json!({
                                    "session_id": emit_sid, "from_seq": null, "subscription_id": sub,
                                }),
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        // 兜底清理（DF10.5）：桥 task 退出即退订；幂等，会话已关亦 Ok
        let _ = api.unsubscribe_output(emit_sid, &sub).await;
    });
    Ok(attach)
}

/// 显式退订（主清理路径）：UI 关闭终端实例时必须调用；幂等 no-op。
#[tauri::command]
async fn unsubscribe_output(state: ApiState<'_>, sid: String, subscription_id: String) -> CmdResult<()> {
    state
        .api
        .unsubscribe_output(sid, &subscription_id)
        .await
        .map_err(WireError::from)
}

/// resync（DF10.3）：from_seq=UI 最后已应用序号，None 请求检查点。
#[tauri::command]
async fn resync_output(
    state: ApiState<'_>,
    sid: String,
    subscription_id: String,
    from_seq: Option<u64>,
) -> CmdResult<ResyncOutput> {
    state
        .api
        .resync_output(sid, &subscription_id, from_seq)
        .await
        .map_err(WireError::from)
}

/// P6 测量口径：活跃订阅计数。
#[tauri::command]
fn debug_subscriptions(state: ApiState<'_>) -> DebugSubscriptions {
    state.api.debug_subscriptions()
}

#[tauri::command]
async fn read_screen(state: ApiState<'_>, sid: String) -> CmdResult<ScreenSnapshot> {
    state.api.read_screen(&human(), sid).await.map_err(WireError::from)
}

#[tauri::command]
async fn send_keys(state: ApiState<'_>, sid: String, keys: String) -> CmdResult<()> {
    state.api.send_keys(&human(), sid, &keys).await.map_err(WireError::from)
}

#[tauri::command]
async fn exec_human(state: ApiState<'_>, sid: String, command: String) -> CmdResult<ExecResult> {
    state
        .api
        .exec(&human(), sid, &command, ExecOpts::default())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn set_control(
    state: ApiState<'_>,
    sid: String,
    owner: ControlOwner,
    stop_running: Option<bool>,
) -> CmdResult<TakeoverReport> {
    let opts = ControlOpts {
        stop_running: if stop_running.unwrap_or(false) {
            StopPolicy::BestEffort
        } else {
            StopPolicy::None
        },
    };
    state.api.set_control(&human(), sid, owner, opts).await.map_err(WireError::from)
}

#[tauri::command]
async fn delegate_session(
    state: ApiState<'_>,
    sid: String,
    goal: Option<String>,
) -> CmdResult<()> {
    state.api.delegate_session(&human(), sid, goal).await.map_err(WireError::from)
}

#[tauri::command]
async fn shell_capability(state: ApiState<'_>, sid: String) -> CmdResult<ShellCapability> {
    state.api.shell_capability(&human(), sid).await.map_err(WireError::from)
}

#[tauri::command]
async fn session_brief(state: ApiState<'_>, sid: String) -> CmdResult<SessionBrief> {
    state.api.get_session_brief(&human(), sid).await.map_err(WireError::from)
}

#[tauri::command]
async fn set_session_goal(state: ApiState<'_>, sid: String, goal: Option<String>) -> CmdResult<()> {
    state.api.set_session_goal(&human(), sid, goal).await.map_err(WireError::from)
}

#[tauri::command]
async fn list_approvals(state: ApiState<'_>, pending_only: bool) -> CmdResult<Vec<ApprovalItem>> {
    state
        .api
        .list_approvals(&human(), ApprovalFilter { pending_only, ..Default::default() })
        .await
        .map_err(WireError::from)
}

#[tauri::command]
async fn decide_approval(state: ApiState<'_>, id: String, decision: String, edited: Option<String>) -> CmdResult<()> {
    let d = match decision.as_str() {
        "approve" => Decision::Approve,
        "deny" => Decision::Deny,
        "edit" => Decision::ApproveEdited(edited.unwrap_or_default()),
        _ => return Err(WireError::simple("invalid_input", "bad decision")),
    };
    state.api.decide_approval(&human(), id, d).await.map_err(WireError::from)
}

#[tauri::command]
async fn audit_query(state: ApiState<'_>, sid: Option<String>, limit: i64) -> CmdResult<AuditPage> {
    state
        .api
        .query_audit(&human(), AuditFilter { session_id: sid, limit, ..Default::default() })
        .await
        .map_err(WireError::from)
}

/// 主机指纹待决列表（路线图⑤ TOFU：首连确认/变更告警）。
#[tauri::command]
async fn pending_host_keys(state: ApiState<'_>) -> CmdResult<Vec<PendingHostKey>> {
    state.api.pending_host_keys(&human()).await.map_err(WireError::from)
}

/// 人类对指纹确认作出决定；accept=true 时指纹入库并放行连接。
#[tauri::command]
async fn decide_host_key(state: ApiState<'_>, id: String, accept: bool) -> CmdResult<()> {
    state.api.decide_host_key(&human(), &id, accept).await.map_err(WireError::from)
}

/// 2FA 认证提示待决列表（路线图⑩：keyboard-interactive 非密码类提示）。
#[tauri::command]
async fn pending_auth_prompts(state: ApiState<'_>) -> CmdResult<Vec<PendingAuthPrompt>> {
    state.api.pending_auth_prompts(&human()).await.map_err(WireError::from)
}

/// 人类应答认证提示；answer 为空串视为取消（认证终止）。
#[tauri::command]
async fn answer_auth_prompt(state: ApiState<'_>, id: String, answer: String) -> CmdResult<()> {
    state.api.answer_auth_prompt(&human(), &id, &answer).await.map_err(WireError::from)
}

/// SPIKE-1：是否处于基准模式。
#[tauri::command]
async fn bench_mode() -> CmdResult<bool> {
    let v = std::env::var("TINYSSH_BENCH").map(|x| x == "1").unwrap_or(false);
    eprintln!("[bench] bench_mode called -> {v}");
    Ok(v)
}

/// SPIKE-1：IPC Channel 吞吐基准——Rust → WebView 原始字节推送。
#[tauri::command]
async fn bench_start(on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> CmdResult<()> {
    eprintln!("[bench] bench_start called");
    tokio::spawn(async move {
        let chunk = vec![b'a'; 1024 * 1024];
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        let mut i: u64 = 0;
        while tokio::time::Instant::now() < deadline {
            for _ in 0..4 {
                i += 1;
                if on_chunk.send(tauri::ipc::InvokeResponseBody::Raw(chunk.clone())).is_err() {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            if i % 4800 == 0 {
                let _ = on_chunk.send(tauri::ipc::InvokeResponseBody::Json(
                    "{\"type\":\"resync\"}".into(),
                ));
            }
        }
        eprintln!("[bench] stream done, sending done marker");
        let _ = on_chunk.send(tauri::ipc::InvokeResponseBody::Json(
            "{\"type\":\"done\"}".into(),
        ));
    });
    Ok(())
}

/// SPIKE-1：WebView 回报收到的字节数并退出。
#[tauri::command]
async fn bench_report(bytes: u64, resyncs: u32, seconds: u64) -> CmdResult<()> {
    eprintln!("[bench] report: bytes={bytes} resyncs={resyncs} seconds={seconds}");
    let out = serde_json::json!({
        "bytes": bytes,
        "seconds": seconds,
        "mbps": (bytes as f64) / (seconds as f64) / (1024.0 * 1024.0),
        "resyncs": resyncs,
    });
    let path = std::path::PathBuf::from("/tmp/tinyssh-spike1.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).ok();
    println!("SPIKE-1 result: {out}");
    std::process::exit(0);
}

/// Agent Token 签发（仅展示一次）。
#[tauri::command]
async fn issue_agent(state: ApiState<'_>, id: String, label: String) -> CmdResult<String> {
    state
        .api
        .center
        .vault
        .create_agent(&id, &label)
        .map_err(WireError::from)
}

/// MCP 端点状态（端口展示，L1 §3.5）。
#[tauri::command]
async fn mcp_status(state: ApiState<'_>) -> CmdResult<serde_json::Value> {
    eprintln!("[app] mcp_status invoked (frontend alive)");
    Ok(serde_json::json!({
        "endpoint": state.api.mcp_endpoint(),
        "agents": state.api.center.vault.list_agents().unwrap_or_default(),
    }))
}

/// macOS 虚拟键码 → Ctrl 组合的 C0 控制字符（与真实终端 / 前端 ctrlCharOf 同表）。
#[cfg(target_os = "macos")]
fn ctrl_char_of_keycode(code: u64) -> Option<&'static str> {
    Some(match code {
        0 => "\x01",   // a
        11 => "\x02",  // b
        8 => "\x03",   // c
        2 => "\x04",   // d
        14 => "\x05",  // e
        3 => "\x06",   // f
        5 => "\x07",   // g
        4 => "\x08",   // h
        34 => "\x09",  // i
        38 => "\x0a",  // j
        40 => "\x0b",  // k
        37 => "\x0c",  // l
        46 => "\x0d",  // m
        45 => "\x0e",  // n
        31 => "\x0f",  // o
        35 => "\x10",  // p
        12 => "\x11",  // q
        15 => "\x12",  // r
        1 => "\x13",   // s
        17 => "\x14",  // t
        32 => "\x15",  // u
        9 => "\x16",   // v
        13 => "\x17",  // w
        7 => "\x18",   // x
        16 => "\x19",  // y
        6 => "\x1a",   // z
        33 => "\x1b",  // [
        42 => "\x1c",  // backslash
        30 => "\x1d",  // ]
        22 => "\x1e",  // 6
        27 => "\x1f",  // -
        44 => "\x1f",  // /
        49 => "\x00",  // space
        19 => "\x00",  // 2
        20 => "\x1b",  // 3
        21 => "\x1c",  // 4
        23 => "\x1d",  // 5
        26 => "\x1f",  // 7
        28 => "\x7f",  // 8 (DEL)
        _ => return None,
    })
}

/// native 层 Ctrl+字符 接管（仅 macOS）：中文输入法在 WKWebView 里会把 Ctrl+字母
/// 送进拼音组合（keydown 到达 DOM 时 ctrl 标志已被剥掉、keyCode=229），任何 JS 层
/// 修复都无法区分「Ctrl+C」和「拼音里的 c」。NSEvent local monitor 在 IME 之前
/// 看到原始事件（修饰键完整），终端聚焦时编码控制字符直发后端并吞掉事件。
#[cfg(target_os = "macos")]
fn install_native_ctrl_intercept(core: Arc<SessionManager>, input: Arc<TerminalInput>) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::ptr::NonNull;

    let block = block2::RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
        // ObjC block 边界不能 unwind：任何 panic 一律吞掉并放行事件，绝不 abort 应用。
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ev = unsafe { ev.as_ref() };
            if ev.r#type() != NSEventType::KeyDown {
                return None;
            }
            let flags = ev.modifierFlags();
            // ⌘/⌥ 组合不劫持；⇧ 允许（ctrl+⇧+字母与 ctrl+字母同义）
            if !flags.contains(NSEventModifierFlags::Control)
                || flags.intersects(NSEventModifierFlags::Command.union(NSEventModifierFlags::Option))
            {
                return None;
            }
            if !*input.focused.lock().unwrap() {
                return None; // 终端未聚焦（命令框等输入控件保留自身编辑语义）
            }
            let sid = input.sid.lock().unwrap().clone()?;
            let keycode = ev.keyCode() as u64;
            ctrl_char_of_keycode(keycode).map(|cc| (sid, cc))
        }));
        match handled {
            Ok(Some((sid, cc))) => {
                let core = core.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = core.send_keys(&Actor::Human, sid, cc).await;
                });
                std::ptr::null_mut() // 吞掉事件：IME 与 WebKit 都不再看到
            }
            _ => ev.as_ptr(),
        }
    });

    let monitor: Option<Retained<AnyObject>> = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    // 监视器与应用同生命周期，故意常驻。
    std::mem::forget(monitor);
    eprintln!("[app] native ctrl-key intercept installed");
}

#[cfg(not(target_os = "macos"))]
fn install_native_ctrl_intercept(_core: Arc<SessionManager>, _input: Arc<TerminalInput>) {}

/// T34：原生菜单栏定制（替换 Tauri 默认英文菜单）。预定义角色项显式传中文标签——
/// 系统语言非中文时默认标签会是英文，与应用全中文 UI 混排（真机走查实修：本机系统
/// 语言为英文，「About tinyssh-app」与「编辑」混排且 app 名取进程名）。随系统语言
/// 动态本地化列为 V1。不设「关闭窗口 ⌘W」——该键已被应用内标签页语义占用；
/// 「重新加载」不进菜单（会整页刷新杀死全部会话 UI 状态）。
#[cfg(target_os = "macos")]
fn install_native_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
    let version = app.package_info().version.to_string();
    let app_sub = SubmenuBuilder::new(app, "TinySSH")
        .item(&PredefinedMenuItem::about(
            app,
            Some("关于 TinySSH"),
            Some(AboutMetadata {
                name: Some("TinySSH".into()),
                version: Some(version.clone()),
                credits: Some("主机凭据与 Agent 令牌经本机钥匙串加密存储，协作与审计链完整留存于本机。".into()),
                ..Default::default()
            }),
        )?)
        .separator()
        .item(&MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("隐藏 TinySSH"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("退出 TinySSH"))?)
        .build()?;
    let edit_sub = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("拷贝"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .build()?;
    let view_sub = SubmenuBuilder::new(app, "显示")
        .item(&PredefinedMenuItem::fullscreen(app, Some("全屏"))?)
        .build()?;
    let window_sub = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, Some("前置全部"))?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_sub, &edit_sub, &view_sub, &window_sub])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_native_menu(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

fn main() {
    eprintln!("[app] starting, bench={}", std::env::var("TINYSSH_BENCH").unwrap_or_default());
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = std::env::var("TINYSSH_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_or_home().join(".tinyssh").join("tinyssh.db")
        });
    std::fs::create_dir_all(db.parent().unwrap()).ok();
    let api = SessionManager::open(&db).expect("open storage");
    let terminal_input: Arc<TerminalInput> = Arc::default();

    // T43（§6-7 进程模型收口）：MCP 端点装配进 GUI 进程——与 tauri 命令共享同一
    // SessionManager 实例，Agent 的审批卡直接进本进程队列（GUI 即见即决），人类
    // 决定即醒同一进程内的 Agent 等待。此前 GUI 只嵌核心不嵌端点，Agent 需另起
    // `tinyssh serve`（跨进程审批不在 thin-slice 范围）。端口被占则递增（L1 §3.5）。
    {
        let resolver: tinyssh_mcp_server::TokenResolver = {
            let vault = api.center.vault.clone();
            Arc::new(move |t: &str| vault.resolve_token(t))
        };
        let api2 = api.clone();
        // bind 失败降级不 panic（审核中-1）：打包后 stderr 无人接，全损的是
        // 「应用打不开」；端点面板已有「未启动」兜底，如实降级可诊断
        let bound = tauri::async_runtime::block_on(async move {
            tinyssh_mcp_server::spawn_endpoint(api2, resolver, 8722).await
        });
        match bound {
            Ok(port) => {
                api.set_mcp_endpoint(format!("http://127.0.0.1:{port}/mcp"));
                eprintln!("[app] MCP endpoint in-process: http://127.0.0.1:{port}/mcp");
            }
            Err(e) => {
                api.set_mcp_endpoint(String::new());
                eprintln!("[app] MCP endpoint bind failed (8722..8753): {e} —— Agent 接入不可用，其余功能不受影响");
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { api: api.clone() })
        .manage(terminal_input.clone())
        .on_page_load(|webview, payload| {
            eprintln!("[app] page load event: {:?} {:?}", payload.event(), webview.label());
            // dev harness：TINYSSH_SMOKE=1 时页面就绪后注入驱动脚本，走完
            // 「私钥导入→指纹确认→保存→TOFU 信任→建连」全流程（原生冒烟用；
            // 进度写进 document.title，外部用 CGWindowList 轮询窗口标题对账）
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false)
                && webview.label() == "main"
            {
                let key = std::env::var("TINYSSH_SMOKE_KEY")
                    .ok()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .unwrap_or_default();
                // 私钥内容内联进脚本（base64/ASCII 行，无反引号；仍做转义兜底）
                let key_js = key.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
                // R04 Q-04：采样运行标识（仅注入脚本使用，产品行为无关）——
                // 共享信标日志的每条打点可精确归因到本次运行，杜绝跨轮污染
                let run_id = std::env::var("TINYSSH_RUN_ID").unwrap_or_else(|_| "norun".into());
                let mode = std::env::var("TINYSSH_SMOKE_MODE").unwrap_or_default();
                let script: String = if mode == "r11" {
                    r11_smoke_script(&run_id)
                } else if mode == "r12" {
                    r12_smoke_script(&run_id)
                } else if mode == "r13" {
                    r13_smoke_script(&run_id)
                } else if mode == "r14" {
                    r14_smoke_script(&run_id)
                } else if mode == "p2" {
                    p2_smoke_script(&run_id)
                } else if mode == "p6" {
                    p6_smoke_script(&run_id)
                } else if mode == "r15" {
                    r15_smoke_script(&run_id)
                } else if mode == "r19" {
                    r19_smoke_script(&run_id)
                } else if mode == "r24" {
                    r24_smoke_script(&run_id)
                } else if mode == "r21" {
                    r21_smoke_script(&run_id)
                } else if mode == "r22" {
                    r22_smoke_script(&run_id)
                } else if mode == "r23" {
                    r23_smoke_script(&run_id)
                } else if mode == "r25" {
                    r25_smoke_script(&run_id)
                } else if mode == "r26" {
                    r26_smoke_script(&run_id)
                } else if mode == "r27" {
                    r27_smoke_script(&run_id)
                } else if mode == "r30" {
                    r30_smoke_script(&run_id)
                } else if mode.starts_with("r32") {
                    r32_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r33") {
                    r33_smoke_script(&run_id)
                } else if mode.starts_with("r31") {
                    r31_smoke_script(&run_id)
                } else {
                    format!(
                    r#"(function() {{
  // sleep 原语走 beacon 服务端延时：等待期间页面事件循环自由运转（React 可渲染），
  // 又不依赖 WKWebView 对注入脚本可能节流的 timer
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {{}});
  const RUN = '{run_id}';
  // mark：仅写信标（不改窗口标题），带运行标识；用于采样打点（P1 列表就绪等）
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {{}});
  // R10 调试：启动链未捕获错误/渲染失败直写信标（FAIL-* 归因用，产品路径无关）
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = (s) => {{
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {{}});
  }};
  const setVal = (el, v) => {{
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  }};
  const setSel = (el, v) => {{
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};
  const waitFor = async (fn, tries) => {{
    for (let i = 0; i < tries; i++) {{ const v = fn(); if (v) return v; await sleep(100); }}
    return null;
  }};
  (async () => {{
    try {{
      title('s1-opening');
      // R04 Q-04：主机列表就绪直打点——直接观测「种子主机卡片全部渲染」，
      // 不再由表单阶段信标相减推断。20 = P1 基线种子主机数；主机行类为 .host-card。
      mark('list-wait-begin');
      const cardN = await waitFor(() => {{
        const n = document.querySelectorAll('.host-card').length;
        return n >= 20 ? n : 0;
      }}, 100);
      mark(cardN ? 's2-list-ready|cards=' + cardN : 'FAIL-no-list|cards=0');
      // 等 React 挂载完成（page-load Finished 早于 bundle 执行完）再点
      const openBtn = await waitFor(() => document.querySelector('button[aria-label="添加主机"]'), 60);
      if (!openBtn) {{ title('FAIL-no-open-btn'); return; }}
      openBtn.click();
      await sleep(400);
      const sel = await waitFor(() => document.querySelectorAll('.add-host select')[0], 20);
      if (!sel) {{
        title('FAIL-no-form|cards=' + document.querySelectorAll('.card').length
          + '|ah=' + document.querySelectorAll('.add-host').length
          + '|sel=' + document.querySelectorAll('select').length
          + '|btns=' + [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.slice(0, 6)).join(',').slice(0, 120));
        return;
      }}
      setSel(sel, 'key');
      await sleep(300);
      title('s2-key-mode');
      const ta = await waitFor(() => document.querySelector('.add-host textarea'), 20);
      if (!ta) {{ title('FAIL-no-textarea'); return; }}
      setVal(ta, `{key_js}`);
      title('s3-pasted');
      const imp = await waitFor(() => [...document.querySelectorAll('.add-host button')]
        .find(b => b.textContent.includes('导入并确认指纹')), 20);
      if (!imp) {{ title('FAIL-no-import-btn'); return; }}
      imp.click();
      const trust = await waitFor(() => document.querySelector('.add-host .trust-row .fp'), 40);
      if (!trust) {{ title('FAIL-import'); return; }}
      title('s4-bound|' + (trust.textContent || '').trim().slice(0, 30));
      // DOM 顺序：名称/地址/端口/用户名（口令类 input 排除）
      const fields = [...document.querySelectorAll('.add-host input')].filter(i => i.type !== 'password');
      if (fields.length < 4) {{ title('FAIL-fields'); return; }}
      setVal(fields[0], 't40-真机密钥');
      setVal(fields[1], '127.0.0.1');
      setVal(fields[2], '2222');
      setVal(fields[3], 'root');
      title('s5-filled');
      const save = await waitFor(() => [...document.querySelectorAll('.add-host button')]
        .find(b => b.textContent.includes('保存并连接')), 20);
      if (!save) {{ title('FAIL-no-save'); return; }}
      save.click();
      title('s6-saving');
      const trustBtn = await waitFor(() => [...document.querySelectorAll('.hk-dialog button')]
        .find(b => b.textContent.includes('信任并连接')), 80);
      if (!trustBtn) {{ title('FAIL-no-tofu'); return; }}
      title('s7-tofu-dialog');
      trustBtn.click();
      const term = await waitFor(() => {{
        const t = document.querySelector('#term .xterm-rows');
        return t && (t.textContent || '').length > 5 ? t : null;
      }}, 150);
      if (!term) {{ title('FAIL-no-term'); return; }}
      title('s8-term-alive');
      const focus = document.querySelector('.xterm-helper-textarea');
      if (focus) focus.focus();
      // T41：真实 app 的 SFTP 浏览器命令实证（直调 internals invoke，绕开 UI 交互）
      const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
      const ses = await inv('list_sessions', {{}});
      const cur = (ses && ses[0] && ses[0].id) || '';
      if (cur) {{
        const es = await inv('sftp_list', {{ sid: cur, path: '/root' }});
        title('sftp|n=' + es.length + '|' + es.slice(0, 3).map((e) => (e.is_dir ? 'D:' : 'F:') + e.name).join(','));
      }}
      // T43：进程内 MCP 端点实证——mcp_status 应回真实绑定地址（含实际端口），
      // 仍是占位文案（含「递增」字样）即 FAIL（审核低-3：占位回归要被门拦住）
      const ms = await inv('mcp_status', {{}});
      const ep = (ms && ms.endpoint) || '';
      if (!ep || ep.includes('递增')) {{ title('FAIL-mcp-placeholder|' + ep); return; }}
      title('mcp|' + ep);
      // 补口（T43 增记）：签发真实 token 经 beacon 交给 shell 侧，由外部带 token
      // 发 MCP initialize——补齐「真 token 经内嵌端点握手成功」的真机直接证据
      // （token 仅落隔离 DB /tmp/smoke + 本机 beacon，跑完即弃）
      const tok = await inv('issue_agent', {{ id: 'smoke-agent', label: '真机冒烟 Agent' }});
      title('agent-token|' + (tok || 'NONE'));
      // T44（真机）：Agent 转发审批链——shell 侧 Agent 持真实 token 经内嵌
      // MCP 端点发 forward_start/forward_stop（阻塞等人工），本脚本扮演人工：
      // 轮询待批卡→批准，同时观测转发状态机（Listening→停止→Degraded）。
      // 卡→批→banner→停卡→批→空→坏目标→Degraded 全部经 beacon 行对账；
      // 转发/停止卡 editable=false 也是 T44 修复批的真机断言点。
      title('session-id|' + cur);
      const approvedIds = new Set();
      let lastSig = '\u0000';
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {{
        const cards = await inv('list_approvals', {{ pendingOnly: true }});
        const c = cards && cards[0];
        if (c && !approvedIds.has(c.id)) {{
          approvedIds.add(c.id);
          title('fwd-card|' + (c.command || '').slice(0, 48) + '|editable=' + (c.editable === true));
          try {{
            await inv('decide_approval', {{ id: c.id, decision: 'approve' }});
            title('fwd-approved|' + String(c.id).slice(0, 8));
          }} catch (e) {{
            title('fwd-approve-err|' + e);
          }}
        }}
        const fs = cur ? await inv('list_forwards', {{ sid: cur }}) : [];
        const sig = (fs || []).map((f) => String(f.id).slice(0, 8) + ':' + f.state).join(',');
        if (sig !== lastSig) {{
          lastSig = sig;
          const err0 = (fs && fs[0] && fs[0].error) || '';
          title('fwd-state|' + sig + (err0 ? '|err=' + String(err0).slice(0, 48) : ''));
        }}
        const done = await fetch('http://127.0.0.1:15199/q/AGENT-DONE')
          .then((r) => r.ok).catch(() => false);
        if (done) break;
        await sleep(400);
      }}
      title('DONE');
    }} catch (e) {{
      title('FAIL|' + e);
    }}
  }})();
}})();"#
                )
                };
                std::fs::write("/tmp/t40_smoke/last_smoke_script.js", &script).ok();
                let r = webview.eval(&script);
                eprintln!("[app] smoke script injected: {r:?}");
            }
        })
        .setup(move |app| {
            use tauri::Manager as _;
            eprintln!("[app] setup: windows={:?}", app.webview_windows().keys().collect::<Vec<_>>());
            // SMOKE 冒烟专用：窗口置顶聚焦。WKWebView 会冻结不可见窗口的页面 JS
            //（信标停摆的根因），冒烟运行约 20s 即被外部终止，产品路径不受影响。
            if std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.set_always_on_top(true);
                }
            }
            install_native_ctrl_intercept(api.clone(), terminal_input.clone());
            // T34：原生菜单栏 + 「设置…⌘,」→ 前端事件（打开显示设置面板）
            if let Err(e) = install_native_menu(app.handle()) {
                eprintln!("[app] native menu install failed: {e}");
            }
            // R13 冒烟：menu-settings→统一分发的 FE 半链路实证。NSMenu 项命中与
            // ⌘, 加速器最终都走 app.emit("menu-settings")（上一行 on_menu_event）。
            // 冒烟模式轮询信标日志等脚本 armed 后补发同一事件（rev-r13 低-5：
            // 定时 emit 与冷启动进度有竞态；信标日志每轮按规程清空，无误触）。
            if std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false)
                && std::env::var("TINYSSH_SMOKE_MODE").map(|v| v == "r13").unwrap_or(false)
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
                    loop {
                        if std::time::Instant::now() > deadline { break; }
                        if let Ok(s) = std::fs::read_to_string("/tmp/t40_smoke/beacon.log") {
                            if s.contains("r13-armed-menu") {
                                let _ = handle.emit("menu-settings", ());
                                break;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                });
            }
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    let _ = app.emit("menu-settings", ());
                    eprintln!("[app] menu: settings requested");
                }
            });
            if let Some(w) = app.get_webview_window("main") {
                let r = w.eval("window.__TINYSSH_PROBE__ = 'set-by-rust'; 'ok';");
                eprintln!("[app] eval probe: {r:?}");
                let url = w.url();
                eprintln!("[app] window url: {url:?}");
            } else {
                eprintln!("[app] NO main window!");
            }
            // 审批事件 → 前端
            let handle = app.handle().clone();
            let mut rx = api.subscribe_approvals();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle.emit("approval-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 转发状态事件 → 前端（T44 真机冒烟补口：WKWebView 节流 timer 时
            // UI 的 3s 盲轮询挂起，Agent 建的转发对人工不可见——事件驱动补数据面可见性）
            let handle_fwd = app.handle().clone();
            let mut fwd_rx = api.subscribe_forwards();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(fwd_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_fwd.emit("forward-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 主机指纹待决事件 → 前端（路线图⑤）
            let handle_hk = app.handle().clone();
            let mut hk_rx = api.subscribe_host_keys();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(hk_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_hk.emit("hostkey-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 2FA 认证提示事件 → 前端（路线图⑩）
            let handle_ap = app.handle().clone();
            let mut ap_rx = api.subscribe_auth_prompts();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(ap_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_ap.emit("authprompt-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C1 建连尝试事件 → 前端（R19，沿 approval-event 桥模式）
            let handle_conn = app.handle().clone();
            let mut conn_rx = api.subscribe_connections();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(conn_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_conn.emit("connection-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C3 shell 集成状态事件 → 前端（R24，同桥模式）
            let handle_shell = app.handle().clone();
            let mut shell_rx = api.subscribe_shell_integration();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(shell_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_shell.emit("shell-integration-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // R26（§6.4）：会话状态事件（断线/自动重连次数/重确认）即时推送——
            // 3s 列表轮询只做兜底对账，横幅与重试计数不进盲窗。
            let handle_state = app.handle().clone();
            let mut state_rx = api.center.state_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(state_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_state.emit("session-state", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C5（R32）：传输任务事件（进度/状态，revision 单调）即时推送——
            // 任务卡不进轮询盲窗；漏收由 list_transfers 查询对账兜底。
            let handle_xfer = app.handle().clone();
            let mut xfer_rx = api.transfer_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(xfer_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_xfer.emit("transfer-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // dev harness：TINYSSH_AUTOCONNECT=host_id[,host_id] 启动即建会话（原生走查用）
            if let Ok(list) = std::env::var("TINYSSH_AUTOCONNECT") {
                let api2 = api.clone();
                tauri::async_runtime::spawn(async move {
                    for host_id in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                        match api2
                            .create_session(&Actor::Human, CreateSessionReq { host_id: host_id.to_string() })
                            .await
                        {
                            Ok(sid) => eprintln!("[app] autoconnect {host_id} -> {sid}"),
                            Err(e) => eprintln!("[app] autoconnect {host_id} failed: {e}"),
                        }
                    }
                });
            }
            // T20 走查辅助（仅 dev 构建 + TINYSSH_TEST_DRAG=1 双重门禁）：OS 级拖拽投递
            // （Finder→WKWebView 的 NSDraggingSession）在双屏+多 Space 环境无法脚本化驱动
            // （§5.14 披露），此钩子监听 /tmp/t20_drag_{enter,over,drop,leave} 触发器文件，
            // 发出与 WKWebView 拖拽回调载荷完全同构的事件；事件之后的整条链路（UI 处理器 →
            // upload_file 命令 → core-session → russh-sftp → 远端落盘 → 审计）全部真实执行。
            if cfg!(debug_assertions)
                && std::env::var("TINYSSH_TEST_DRAG").map(|v| v == "1").unwrap_or(false)
            {
                let handle_td = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        for (name, event) in [
                            ("enter", "tauri://drag-enter"),
                            ("over", "tauri://drag-over"),
                            ("leave", "tauri://drag-leave"),
                            ("drop", "tauri://drag-drop"),
                        ] {
                            let p = std::path::PathBuf::from(format!("/tmp/t20_drag_{name}"));
                            if !p.exists() {
                                continue;
                            }
                            let mut paths: Vec<String> = Vec::new();
                            if name == "enter" || name == "drop" {
                                paths = std::fs::read_to_string(&p)
                                    .unwrap_or_default()
                                    .lines()
                                    .filter(|l| !l.trim().is_empty())
                                    .map(str::to_string)
                                    .collect();
                            }
                            let _ = std::fs::remove_file(&p);
                            let payload = serde_json::json!({
                                "paths": paths,
                                "position": { "x": 0.0, "y": 0.0 },
                            });
                            if let Some(w) = handle_td.get_webview_window("main") {
                                let _ = w.emit(event, payload);
                                eprintln!("[app] test drag {name} paths={paths:?}");
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts, upsert_host, delete_host, create_identity, list_identities, delete_identity,
            ssh_config_preview, ssh_config_import,
            list_sessions, create_session, begin_connection, connection_status, cancel_connection,
            close_session, reconnect_session, stop_auto_reconnect, session_state_feed, resize, subscribe_output,
            unsubscribe_output, resync_output, debug_subscriptions,
            open_url,
            upload_file, download_file, cancel_transfer, list_transfers, sftp_list, sftp_resolve_path, sftp_stat,
            pick_upload_files, pick_save_file,
            list_forwards, start_forward, stop_forward,
            get_setting, set_setting, get_workspace, set_workspace, set_host_favorite,
            list_host_metadata, list_recent_hosts,
            read_screen, send_keys, exec_human, set_control, delegate_session, session_brief, set_session_goal,
            shell_capability,
            list_approvals, decide_approval, audit_query, issue_agent, mcp_status,
            pending_host_keys, decide_host_key, pending_auth_prompts, answer_auth_prompt,
            bench_start, bench_report, bench_mode, note_terminal,
            quit_app,
        ])
        .on_window_event(|window, event| {
            // R23 §6.4 退出契约：主窗口关闭=请求退出，交 FE 汇总确认（活动会话/转发/
            // 未知传输），不引入「窗口已关但后台仍跑」的新模式
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.emit("app-close-requested", ());
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// R23：FE 汇总确认「结束会话并退出」后的受控退出（不用 destroy 绕过窗口事件）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// R33 §353 上传入口：原生文件选择器（多选）。对话框必须在非主线程跑——
/// blocking_* 变体放 spawn_blocking；取消返回空数组（FE 据此静默收场）。
#[tauri::command]
async fn pick_upload_files(app: tauri::AppHandle) -> std::result::Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = tauri_plugin_dialog::DialogExt::dialog(&app)
            .file()
            .add_filter("所有文件", &["*"])
            .blocking_pick_files();
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// R33 §354 下载「另存为」：原生保存对话框（默认文件名/目录可给）；取消返回 None。
#[tauri::command]
async fn pick_save_file(
    app: tauri::AppHandle,
    default_name: String,
    default_dir: Option<String>,
) -> std::result::Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = tauri_plugin_dialog::DialogExt::dialog(&app).file();
        b = b.set_file_name(&default_name);
        if let Some(d) = default_dir {
            b = b.set_directory(d);
        }
        Ok(b.blocking_pick_file().map(|p| p.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// P2 探针注入脚本（TINYSSH_SMOKE_MODE=p2；dev 门控）：同一 release 会话切换 100 次
/// （click→tab-active，rAF 粒度）+ 本地可见回显 100 次（合成 keydown→xterm onData→
/// core 本地 PTY 回显→输出→term.write→DOM，MutationObserver 计时）。P95 门槛
/// 切换 ≤100ms / 回显 ≤50ms（远端 RTT 单列，不混入本地口径）。
fn p2_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__P2_INJECTED__) return;
  window.__P2_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => { document.title = 'SMOKE|' + s; try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {} };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
  // 非活动终端 display:none（styles.css .term-session）——「可见回显」口径按 offsetParent 定位活动终端
  const visTerm = () => [...document.querySelectorAll('.xterm-helper-textarea')].filter((t) => t.offsetParent !== null)[0] || null;
  const visRows = () => [...document.querySelectorAll('.xterm-rows')].filter((r) => r.offsetParent !== null)[0] || null;
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.ceil(s.length * 0.95) - 1]; };
  // 回显 N 次：活动终端 textarea 合成 keydown+keypress → PTY 回显 → 该终端 .xterm-rows 任意行变化
  const echoN = async (n) => {
    const ta = visTerm();
    const rows = visRows();
    if (!ta || !rows) return null;
    ta.focus();
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const out = [];
    for (let i = 0; i < n; i++) {
      const ch = chars[i % 26];
      // 观测=该终端 .xterm-rows 内任意行内容变化（p2i 诊断实证：回显落在光标行，光标行不必然是
      // 视口末行——末行增长假设会全部误判 -1）；keydown+keypress 双发（真实键序列语义，
      // p2i 实证进 PTY 回显核心屏；InputEvent 路径在原生 WKWebView 实测不通 p2d/p2f）。
      const dt = await new Promise((res) => {
        let done = false;
        const mo = new MutationObserver(() => {
          if (!done) { done = true; mo.disconnect(); res(performance.now() - t0); }
        });
        const t0 = performance.now();
        mo.observe(rows, { childList: true, subtree: true, characterData: true });
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true, cancelable: true }));
        ta.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true, cancelable: true }));
        setTimeout(() => { if (!done) { done = true; mo.disconnect(); res(-1); } }, 800);
      });
      out.push(Math.round(dt * 10) / 10);
    }
    return out;
  };
  (async () => {
    try {
      await title('p2-open');
      await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!(await waitFor(() => document.querySelectorAll('.tabbar .tab').length >= 1 || null, 100))) return title('FAIL-no-tab');
      // 第二个本地会话（另开连接钮）→ 双标签
      const conn = document.querySelector('.host-card .host-connect-btn');
      if (!conn) return title('FAIL-no-connect');
      conn.click();
      if (!(await waitFor(() => document.querySelectorAll('.tabbar .tab').length >= 2 || null, 50))) return title('FAIL-second-tab');
      const tabs = () => [...document.querySelectorAll('.tabbar .tab')];
      // ---- 会话切换 ×100（P95 ≤ 100ms 门）----
      const sw = [];
      for (let i = 0; i < 100; i++) {
        const target = tabs()[i % 2];
        const t0 = performance.now();
        target.click();
        const dt = await new Promise((res) => {
          const tick = () => (target.classList.contains('tab-active') ? res(performance.now() - t0) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
          setTimeout(() => res(-1), 2000);
        });
        sw.push(Math.round(dt * 10) / 10);
      }
      const swOk = sw.filter((x) => x >= 0);
      if (swOk.length < 100) return title('FAIL-sw-n:' + swOk.length);
      if (p95(swOk) > 100) return title('FAIL-sw-gate:' + p95(swOk));
      await markSync('p2-sw-p95|' + p95(swOk) + '|n=' + swOk.length + '|max=' + Math.max(...swOk));
      await markSync('p2-sw-raw|' + sw.join(','));
      // ---- 输入→本地可见回显 ×100（P95 ≤ 50ms 门，活动终端口径）----
      tabs()[0].click();
      if (!(await waitFor(() => tabs()[0].classList.contains('tab-active') ? true : null, 20))) return title('FAIL-refocus');
      const ec = await echoN(100);
      if (!ec) return title('FAIL-no-vis-term');
      const ecOk = ec.filter((x) => x >= 0);
      if (ecOk.length < 100) return title('FAIL-ec-n:' + ecOk.length);
      if (p95(ecOk) > 50) return title('FAIL-ec-gate:' + p95(ecOk));
      await markSync('p2-ec-p95|' + p95(ecOk) + '|n=' + ecOk.length + '|max=' + Math.max(...ecOk));
      await markSync('p2-ec-raw|' + ec.join(','));
      // ---- 远端 RTT 单列（真实 SSH 会话回显 ×100；信息列不设门，网络 RTT 另计）----
      let hid;
      try {
        hid = await inv('upsert_host', { host: { id: null, name: 'p2-sshd', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      } catch (e) { return title('FAIL-upsert:' + String(e).slice(0, 120)); }
      if (!hid) return title('FAIL-upsert-empty');
      const card = await waitFor(() => [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('p2-sshd')) || null, 50);
      if (!card) return title('FAIL-no-card');
      card.querySelector('.host-card-main').click();
      let trusted = false;
      for (let i = 0; i < 40 && !trusted; i++) {
        await sleep(300);
        const tbtn = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接'));
        if (tbtn) { tbtn.click(); trusted = true; }
      }
      const connS = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return ss.find((x) => x.host_id === hid && x.state === 'Connected') ? true : null;
      }, 150);
      if (!connS) return title('FAIL-ssh-connected');
      const sshTab = await waitFor(() => tabs().find((t) => t.textContent.includes('p2-sshd')) || null, 50);
      if (!sshTab) return title('FAIL-ssh-tab');
      sshTab.click();
      if (!(await waitFor(() => sshTab.classList.contains('tab-active') ? true : null, 20))) return title('FAIL-ssh-focus');
      const rt = await echoN(100);
      if (!rt) return title('FAIL-no-vis-term-rt');
      const rtOk = rt.filter((x) => x >= 0);
      if (rtOk.length < 100) return title('FAIL-rt-n:' + rtOk.length);
      await markSync('p2-rt-ec-p95|' + p95(rtOk) + '|n=' + rtOk.length + '|max=' + Math.max(...rtOk) + '|gate=none(informational)');
      await markSync('p2-rt-ec-raw|' + rt.join(','));
      await title('p2-DONE');
    } catch (e) { await title('FAIL-exception:' + String(e).slice(0, 140)); }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// P6 探针注入脚本（TINYSSH_SMOKE_MODE=p6；dev 门控）：100 次会话创建/关闭（UI 连接钮
/// → 标签+终端实例出现 → 标签 ×关闭 → 回收）、200 次标签切换、50 次面板变化；
/// 不变量=每存活会话 ≤1 输出订阅（debug_subscriptions）+ 终端实例数回收 + 零 JS 错误。
/// 进程级 RSS 曲线由外部采样器采集（进程级证据口径，与 G0 修订轮 P6 降级决议同构）。
fn p6_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__P6_INJECTED__) return;
  window.__P6_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason).slice(0, 200)));
  const title = async (s) => { document.title = 'SMOKE|' + s; try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {} };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
  const jsErrors = [];
  window.addEventListener('error', (ev) => jsErrors.push(String(ev.message)));
  window.addEventListener('unhandledrejection', (ev) => jsErrors.push('reject:' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 80)));
  (async () => {
    try {
      await title('p6-open');
      await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!(await waitFor(() => document.querySelectorAll('.tabbar .tab').length >= 1 || null, 100))) return title('FAIL-no-tab');
      // 激活首个标签：AUTOCONNECT 会话在欢迎态（sid=null）不挂载终端（p6c 实证基线永不成）——
      // 点击标签驱动 makeTerm，再等「tab 数===xterm 数且 ≥1」取稳定基线（p6b 实证 xterm0=0 假基线）
      document.querySelector('.tabbar .tab').click();
      if (!(await waitFor(() => {
        const t = document.querySelectorAll('.tabbar .tab').length;
        const x = document.querySelectorAll('.xterm').length;
        return t >= 1 && x === t ? true : null;
      }, 100))) return title('FAIL-baseline');
      const tabs0 = document.querySelectorAll('.tabbar .tab').length;
      const xterm0 = document.querySelectorAll('.xterm').length;
      // ---- 100 创建/关闭 ----
      let cycMax = 0, subsViol = 0;
      for (let i = 0; i < 100; i++) {
        const t0 = performance.now();
        document.querySelector('.host-card .host-connect-btn').click();
        const created = await waitFor(() => document.querySelectorAll('.tabbar .tab').length === tabs0 + 1 ? document.querySelectorAll('.xterm').length === xterm0 + 1 : null, 50);
        if (!created) return title('FAIL-cycle-open:' + i);
        const subs = await inv('debug_subscriptions', {});
        const live = (await inv('list_sessions', {})).length;
        const perOk = (subs.per_session || []).every((x) => x.subscription_ids.length <= 1);
        if (subs.active_count > live || !perOk) subsViol++;
        document.querySelector('.tabbar .tab:last-child .tab-x').click();
        // 连接中会话 close 先确认（requestCloseSession）——弹窗则点「断开连接」，无弹窗（秒关）直接继续
        const cf = await waitFor(() => {
          const c = document.querySelector('.confirm-mask button.danger');
          if (c) return c;
          return document.querySelectorAll('.tabbar .tab').length === tabs0 ? 'closed' : null;
        }, 50);
        if (cf && cf !== 'closed') cf.click();
        const closed = await waitFor(() => document.querySelectorAll('.tabbar .tab').length === tabs0 && document.querySelectorAll('.xterm').length === xterm0 ? true : null, 50);
        if (!closed) {
          const dg = { tabs: document.querySelectorAll('.tabbar .tab').length, xt: document.querySelectorAll('.xterm').length, mask: !!document.querySelector('.confirm-mask'), t0: tabs0, x0: xterm0 };
          return title('FAIL-cycle-close:' + i + ':' + JSON.stringify(dg));
        }
        cycMax = Math.max(cycMax, performance.now() - t0);
        if ((i + 1) % 25 === 0) await markSync('p6-cyc|' + (i + 1) + '|subsViol=' + subsViol);
      }
      if (subsViol > 0) return title('FAIL-subs:' + subsViol);
      await markSync('p6-cycles-ok|100|subsViol=' + subsViol + '|cycMaxMs=' + Math.round(cycMax));
      // ---- 200 标签切换 ----
      const tabs = () => [...document.querySelectorAll('.tabbar .tab')];
      if (tabs().length < 2) { await (async () => { document.querySelector('.host-card .host-connect-btn').click(); await waitFor(() => tabs().length >= 2 || null, 50); })(); }
      if (tabs().length < 2) return title('FAIL-need2tabs');
      let swBad = 0, retried = 0;
      for (let i = 0; i < 200; i++) {
        const target = tabs()[i % 2];
        target.click();
        let okNow = await waitFor(() => target.classList.contains('tab-active') ? true : null, 20);
        if (!okNow) {
          // 单次重试（p6d 实证偶发 >2s 慢拍一次，GC/渲染排队量级；真实用户语义=再点一次）
          retried++;
          target.click();
          okNow = await waitFor(() => target.classList.contains('tab-active') ? true : null, 20);
        }
        if (!okNow) swBad++;
      }
      if (swBad > 0) return title('FAIL-switch:' + swBad);
      await markSync('p6-switch-ok|200|retried=' + retried);
      // ---- 50 面板变化 ----
      let panelBad = 0;
      for (let i = 0; i < 50; i++) {
        const btn = document.querySelector('.session-toolbar .st-file');
        if (!btn) { panelBad++; continue; }
        btn.click();
        const want = btn.getAttribute('aria-pressed') !== 'true';
        const okNow = await waitFor(() => (btn.getAttribute('aria-pressed') === 'true') === want ? true : null, 20);
        if (!okNow) panelBad++;
      }
      if (panelBad > 0) return title('FAIL-panel:' + panelBad);
      await markSync('p6-panel-ok|50');
      const subsFin = await inv('debug_subscriptions', {});
      const liveFin = (await inv('list_sessions', {})).length;
      const perOkFin = (subsFin.per_session || []).every((x) => x.subscription_ids.length <= 1);
      if (subsFin.active_count > liveFin || !perOkFin)
        return title('FAIL-subs-final:' + JSON.stringify(subsFin).slice(0, 160));
      if (document.querySelectorAll('.xterm').length !== xterm0 + 1) return title('FAIL-xterm-leak');
      if (jsErrors.length > 0) return title('FAIL-jserr:' + jsErrors[0].slice(0, 80));
      await title('p6-DONE');
    } catch (e) { await title('FAIL-exception:' + String(e).slice(0, 140)); }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R14 基础真实垂直流程探针注入脚本（TINYSSH_SMOKE_MODE=r14；dev 门控，产品路径无关）：
/// 新工作区对共享 docker sshd（root@127.0.0.1:2222，凭据 upsert_host 真路径加密落库）
/// 建立真实 SSH 会话：UI 点卡 → TOFU 信任门 → Connected → send_keys/read_screen
/// 输入输出闭环 → local↔ssh 双标签切换 → 工具菜单关闭会话确认流 → 订阅存在性先证。
/// 键盘注入走 send_keys invoke 级（CGEvent 注入受 P2 冻结协议约束，与 r13 同口径）。
fn r14_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R14_INJECTED__) return; // WKWebView Finished 双触发防护
  window.__R14_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  (async () => {
    try {
      await title('r14-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // tabs0 等首个标签出现后再取（AUTOCONNECT 标签可能晚于主机卡渲染——rev-r14 低-1）
      const tabs0 = (await waitFor(() => document.querySelectorAll('.tabbar .tab').length || null, 100)) ?? 0;
      // 1) 真实 SSH 主机经 wire 真路径创建（密码凭据核心加密落库）
      let hid;
      try {
        hid = await inv('upsert_host', { host: { id: null, name: 'r14-sshd', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      } catch (e) { return title('FAIL-upsert:' + String(e).slice(0, 120)); }
      if (!hid) return title('FAIL-upsert-empty');
      await markSync('r14-host-ok');
      // 2) UI 点卡建连（Human 真路径）→ TOFU 门 → 信任
      const card = await waitFor(() => [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('r14-sshd')) || null, 50);
      if (!card) return title('FAIL-no-card');
      const main = card.querySelector('.host-card-main');
      if (!main) return title('FAIL-card-main');
      main.click();
      let maskHandled = false;
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        const tbtn = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接'));
        if (tbtn) { tbtn.click(); maskHandled = true; continue; }
        const authInput = document.querySelector('.hk-mask input');
        if (authInput) {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(authInput, 'testpass');
          authInput.dispatchEvent(new Event('input', { bubbles: true }));
          const sub = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('提交验证'));
          if (sub) { sub.click(); maskHandled = true; continue; }
        }
        if (!document.querySelector('.hk-mask') && maskHandled) break;
      }
      // 3) 等真实 SSH 会话 Connected（共享 sshd 需 banner/认证时间）
      const sess = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return ss.find((s) => s.host_id === hid && s.state === 'Connected') || null;
      }, 80);
      if (!sess) {
        const ss = await inv('list_sessions', {});
        return title('FAIL-not-connected:' + JSON.stringify(ss.map((s) => [s.host_name, s.state])));
      }
      await markSync('r14-ssh-connected');
      // 4) 输入/输出闭环（send_keys invoke 级）
      const MK = 'R14MARK' + RUN;
      await inv('send_keys', { sid: sess.id, keys: 'echo ' + MK + '\r' });
      const seen = await waitFor(async () => {
        const snap = await inv('read_screen', { sid: sess.id });
        return snap && snap.text && snap.text.includes(MK) ? snap : null;
      }, 60);
      if (!seen) {
        const snap = await inv('read_screen', { sid: sess.id });
        return title('FAIL-no-echo:' + String(snap && snap.text).slice(-140));
      }
      await markSync('r14-io-ok');
      // 5) 双标签切换（local AUTOCONNECT + ssh）
      // 按主机名定位标签（AUTOCONNECT 晚至时会话列表序不稳定，索引法曾误关 local——r14b 实证）
      if (document.querySelectorAll('.tabbar .tab').length < 2) return title('FAIL-tabs');
      const tabByHost = (name) => [...document.querySelectorAll('.tabbar .tab')].find((t) => t.textContent.includes(name));
      const sshTab = tabByHost('r14-sshd');
      if (!sshTab) return title('FAIL-ssh-tab');
      sshTab.click();
      if (!(await waitFor(() => tabByHost('r14-sshd')?.classList.contains('tab-active') || null, 30))) return title('FAIL-tab-ssh');
      const otherTab = [...document.querySelectorAll('.tabbar .tab')].find((t) => !t.textContent.includes('r14-sshd'));
      if (!otherTab) return title('FAIL-other-tab');
      otherTab.click();
      if (!(await waitFor(() => otherTab.classList.contains('tab-active') || null, 30))) return title('FAIL-tab-other');
      sshTab.click();
      if (!(await waitFor(() => tabByHost('r14-sshd')?.classList.contains('tab-active') || null, 30))) return title('FAIL-tab-ssh2');
      await markSync('r14-tabs-ok');
      // 6) 订阅存在性先证：close 后 debug_subscriptions 只遍历存活会话表，已移除会话
      // 恒不出现——事后断言结构性恒真（rev-r14 中-1），故订阅存在必须在 close 前断言
      const subsPre = JSON.stringify(await inv('debug_subscriptions', {}));
      if (!subsPre.includes(sess.id)) return title('FAIL-sub-missing:' + subsPre.slice(0, 200));
      await markSync('r14-sub-live');
      const toolsBtn = document.querySelector('.session-toolbar button[aria-haspopup="menu"]');
      if (!toolsBtn) return title('FAIL-tools-btn');
      toolsBtn.click();
      await sleep(300);
      const closeItem = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('关闭会话'));
      if (!closeItem) return title('FAIL-close-item');
      closeItem.click();
      await sleep(300);
      const danger = document.querySelector('.confirm-mask button.danger');
      if (!danger) return title('FAIL-confirm');
      danger.click();
      const closed = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        const s = ss.find((x) => x.id === sess.id);
        const gone = !s || s.state === 'Disconnected';
        const tabN = document.querySelectorAll('.tabbar .tab').length;
        return gone && tabN === tabs0 ? true : null;
      }, 40);
      if (!closed) {
        const ss = await inv('list_sessions', {});
        return title('FAIL-close:' + JSON.stringify(ss.map((s) => [s.host_name, s.state])) + '|tabs=' + document.querySelectorAll('.tabbar .tab').length);
      }
      await markSync('r14-close-ok');
      // 订阅生命周期证据分工（rev-r14 中-1）：close 前 r14-sub-live 证订阅存在；FE 显式
      // 退订归零由 R11 e2e 覆盖；close 后 debug_subscriptions 只遍历存活会话表（结构性
      // 不含已移除 sid），不在此重复断言
      await title('r14-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R21 连接表单与认证探针注入脚本（TINYSSH_SMOKE_MODE=r21；dev 门控，产品路径无关）：
/// E) 凭据基础管理全链（真实 vault）：表单生成 ed25519（create_identity 真路径）→
///    取消表单 → 设置凭据库「未绑定」（§267 不默默删除）→ 已有密钥选择器绑定保存
///    （真实 Key 身份绑定）→「使用中」→ 删除拒删（真实 IdentityInUse 列主机名）→
///    UI 删主机解绑 → 未绑定复得 → 删除成功（真实 delete_identity 命令）；
/// A) §280：真 TOFU 门挂起期间其他主机连接钮不禁用；
/// F) §6.3 焦点代际：门挂起期间 window blur（合成事件）→ 门应答完成后会话
///    Connected 但视图不切换不抢焦（toast 可寻），点标签进入。
fn r21_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R21_INJECTED__) return; // WKWebView Finished 双触发防护
  window.__R21_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const setInput = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const q = (sel) => document.querySelector(sel);
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connectBtnState = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
  };
  const openSettings = async () => {
    // r21a 插曲：删主机确认框关闭（invoke+refreshLists 后才 setConfirm(null)）可能晚于
    // 本点击——先等遮罩消失，点击带重试
    await waitFor(() => (!q('.confirm-mask') ? true : null), 40);
    for (let i = 0; i < 5 && !q('.term-settings'); i++) {
      const btn = q('.hb-settings');
      if (btn) btn.click();
      await sleep(400);
    }
    if (!q('.term-settings')) return false;
    await sleep(300); // identities 拉取
    return true;
  };
  const closeSettings = async () => { q('.term-settings button[aria-label="关闭显示设置"]').click(); await sleep(200); };
  const credBadge = () => {
    const r = q('.cred-row');
    return r ? (r.querySelector('.cred-bound, .cred-unbound') || {}).textContent || '' : null;
  };
  const upsert = (name) => inv('upsert_host', { host: { id: null, name, address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
  (async () => {
    try {
      await title('r21-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // ---- E) 凭据基础管理全链（真实 vault） ----
      // E1 表单生成 ed25519（真实 create_identity）
      q('button[aria-label="添加主机"]').click();
      await waitFor(() => q('.add-host'), 30);
      // 认证方式 select = 表单内第一个 select
      const authSel = q('.add-host select');
      authSel.value = 'key';
      authSel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(150);
      const genBtn = [...q('.add-host').querySelectorAll('button')].find((b) => b.textContent.includes('生成新密钥'));
      if (!genBtn) return title('FAIL-no-genbtn');
      genBtn.click();
      const trustRow = await waitFor(() => q('.add-host .trust-row'), 60);
      if (!trustRow) return title('FAIL-gen-fp');
      await markSync('r21-gen-ok');
      // E2 取消表单 → 设置凭据库未绑定（§267 不默默删除）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      if (q('.add-host')) return title('FAIL-form-not-closed');
      if (!(await openSettings())) return title('FAIL-open-settings');
      const badge1 = credBadge();
      if (badge1 !== '未绑定') return title('FAIL-unbound:' + badge1);
      const fp1 = q('.cred-row .cred-fp');
      if (!fp1) return title('FAIL-no-fp');
      await markSync('r21-unbound-ok');
      await closeSettings();
      // E3 已有密钥选择器绑定保存（真实 Key 身份绑定）
      q('button[aria-label="添加主机"]').click();
      await waitFor(() => q('.add-host'), 30);
      const sel1 = q('.add-host select');
      sel1.value = 'key';
      sel1.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250); // list_identities 拉取
      // 已有密钥选择器 = 选项值非枚举（password/key/agent/utf-8/gbk）的 select——
      // r21a 插曲：误以「存在非空值选项」判定，命中了认证方式 select 本身
      const ENUM = ['password', 'key', 'agent', 'utf-8', 'gbk', ''];
      const pickSel = [...document.querySelectorAll('.add-host select')].find((s) => [...s.options].some((o) => !ENUM.includes(o.value)));
      if (!pickSel) return title('FAIL-no-picker');
      const opt = [...pickSel.options].find((o) => o.value !== '');
      pickSel.value = opt.value;
      pickSel.dispatchEvent(new Event('change', { bubbles: true }));
      const nameIn = q('.add-host input[placeholder*="我的服务器"]');
      const addrIn = q('.add-host input[placeholder*="192.168"]');
      const userIn = q('.add-host input[placeholder*="ops 或 root"]');
      setInput(nameIn, 'r21-k1'); setInput(addrIn, '127.0.0.1'); setInput(userIn, 'root');
      const portIn = q('.add-host input');
      // 端口是第一行第三个输入——按表单内全部 input 顺序找值恰为 '22' 的那个
      for (const el of q('.add-host').querySelectorAll('input')) { if (el.value === '22') { setInput(el, '2222'); break; } }
      const saveOnly = [...q('.add-host').querySelectorAll('button')].find((b) => b.textContent.includes('仅保存'));
      if (!saveOnly) return title('FAIL-no-saveonly');
      saveOnly.click();
      const gone = await waitFor(() => (!q('.add-host') ? true : null), 60);
      if (!gone) return title('FAIL-form-still-open');
      const sess0 = await inv('list_sessions', {});
      if ((sess0 || []).some((x) => x.host_name === 'r21-k1')) return title('FAIL-saveonly-connected');
      await markSync('r21-bound-ok');
      if (!(await openSettings())) return title('FAIL-open-settings');
      const badge2 = credBadge();
      if (badge2 !== '使用中') return title('FAIL-inuse:' + badge2);
      await markSync('r21-inuse-ok');
      // E4 引用检查拒删（真实 IdentityInUse）
      q('.cred-row button[aria-label^="删除凭据"]').click();
      await waitFor(() => q('.confirm-dialog'), 30);
      [...q('.confirm-dialog').querySelectorAll('button')].find((b) => b.textContent.includes('删除凭据')).click();
      const errEl = await waitFor(() => q('.term-settings .err'), 30);
      if (!errEl || !errEl.textContent.includes('r21-k1')) return title('FAIL-reject:' + (errEl ? errEl.textContent : 'none'));
      await markSync('r21-inuse-reject-ok');
      await closeSettings();
      // E5 UI 删主机解绑
      const delBtn = cardBtn('r21-k1', '.host-del');
      if (!delBtn) return title('FAIL-no-k1card');
      delBtn.click();
      await waitFor(() => q('.confirm-dialog'), 30);
      [...q('.confirm-dialog').querySelectorAll('button')].find((b) => b.textContent.trim() === '删除').click();
      await waitFor(async () => ((await inv('list_hosts', {})).find((x) => x.name === 'r21-k1') ? null : true), 60);
      if (!(await openSettings())) return title('FAIL-open-settings');
      const badge3 = credBadge();
      if (badge3 !== '未绑定') return title('FAIL-unbound-again:' + badge3);
      // E6 未绑定删除成功（真实 delete_identity）
      q('.cred-row button[aria-label^="删除凭据"]').click();
      await waitFor(() => q('.confirm-dialog'), 30);
      [...q('.confirm-dialog').querySelectorAll('button')].find((b) => b.textContent.includes('删除凭据')).click();
      const noCred = await waitFor(() => (!q('.cred-row') ? true : null), 40);
      if (!noCred) return title('FAIL-del-failed');
      await markSync('r21-deleted-ok');
      await closeSettings();
      // ---- A) §280：真 TOFU 门挂起期间其他主机连接钮不禁用 ----
      await upsert('r21-ssh');
      await upsert('r21-ssh2');
      // 卡片经 3s 轮询刷出——waitFor 而非固定 sleep（r21a 插曲：400ms 固定等待落空）
      const c1 = await waitFor(() => cardBtn('r21-ssh', '.host-connect-btn'), 40);
      if (!c1) return title('FAIL-no-r21ssh');
      c1.click();
      const mask = await waitFor(() => q('.hk-mask'), 60);
      if (!mask) return title('FAIL-no-tofu');
      const other = connectBtnState('r21-ssh2');
      if (!other || other.disabled) return title('FAIL-concurrent-disabled:' + JSON.stringify(other));
      await markSync('r21-concurrent-ok');
      // 信任 → 真实 Connected
      const tbtn = [...q('.hk-mask').querySelectorAll('button')].find((b) => b.textContent.includes('信任并连接'));
      tbtn.click();
      const s1 = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return ss.find((x) => x.host_name === 'r21-ssh' && x.state === 'Connected') || null;
      }, 100);
      if (!s1) return title('FAIL-conn1');
      await markSync('r21-conn1-ok');
      // ---- F) §6.3 焦点代际：blur 后完成不切视图不抢焦 ----
      const c2 = await waitFor(() => cardBtn('r21-ssh2', '.host-connect-btn'), 40);
      if (!c2) return title('FAIL-no-r21ssh2');
      c2.click();
      const mask2 = await waitFor(() => q('.hk-mask'), 60);
      if (!mask2) return title('FAIL-no-tofu2');
      window.dispatchEvent(new Event('blur')); // 用户离开窗口 → 焦点代际推进
      await sleep(150);
      const tbtn2 = [...q('.hk-mask').querySelectorAll('button')].find((b) => b.textContent.includes('信任并连接'));
      tbtn2.click();
      const s2 = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return ss.find((x) => x.host_name === 'r21-ssh2' && x.state === 'Connected') || null;
      }, 100);
      if (!s2) return title('FAIL-conn2');
      await sleep(600); // 完成路径（attach 或后台 toast）落定
      const activeTxt = (q('.tabbar .tab.tab-active') || {}).textContent || '';
      if (activeTxt.includes('r21-ssh2')) return title('FAIL-bg-stole-focus:' + activeTxt);
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|');
      if (!toasts.includes('r21-ssh2') || !toasts.includes('点击标签进入')) return title('FAIL-bg-toast:' + toasts.slice(-120));
      await markSync('r21-bg-noattach-ok');
      // 点标签进入
      const tab2 = [...document.querySelectorAll('.tabbar .tab')].find((x) => x.textContent.includes('r21-ssh2'));
      tab2.click();
      await sleep(400);
      const activeTxt2 = (q('.tabbar .tab.tab-active') || {}).textContent || '';
      if (!activeTxt2.includes('r21-ssh2')) return title('FAIL-bg-entry:' + activeTxt2);
      await markSync('r21-bg-entry-ok');
      // 回收
      await inv('close_session', { sid: s1.id });
      await inv('close_session', { sid: s2.id });
      await markSync('r21-DONE');
      await title('r21-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R22 C7 SSH config 导入诊断探针注入脚本（TINYSSH_SMOKE_MODE=r22；dev 门控，产品路径无关）：
/// 语义链（真实 vault + 真实解析器，合成 config 显式 path——UI 面板 path:null 指向
/// 用户真实 config，数据不可控，其默认勾选/分级徽章/转手工表单渲染归 demo 探针）：
/// A) 预览：通配符/Match 跳过；ok1 警告级 unsupported + 可直接导入；blocked
///    ProxyJump 阻断级 + directly_importable=false；nouser user_specified=false；
///    溯源 source_line 非零；
/// B) 导入（overwrite=false）：ok1 落库；blocked/nouser skipped=Blocked；
///    预置同名主机 dupx（username=old）→ skipped=Duplicate；
/// C) 显式覆盖（overwrite=true）：dupx 以既有 id 覆盖，username 来自 config；
/// D) 面板冒烟：打开/收起真实 ~/.ssh/config 预览不抛错（弱断言）。
/// 合成 config 由冒烟驱动脚本预先写入 /tmp/smoke-r22/config。
fn r22_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R22_INJECTED__) return; // WKWebView Finished 双触发防护
  window.__R22_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const CFG = '/tmp/smoke-r22/config';
  const byName = (xs, n) => xs.find((x) => x.name === n) || null;
  (async () => {
    try {
      await title('r22-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // 预置重复主机（username=old——覆盖后应以 config 的 root 为准）
      await inv('upsert_host', { host: { id: null, name: 'r22-dupx', address: '10.9.0.9', port: 22, username: 'old', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => ((await inv('list_hosts', {})).some((x) => x.name === 'r22-dupx') ? true : null), 40);
      // ---- A) 预览分级 + 溯源（真实解析器，合成 config） ----
      const pv = await inv('ssh_config_preview', { path: CFG });
      if (!Array.isArray(pv)) return title('FAIL-preview-type');
      const names = pv.map((x) => x.name);
      // 通配符与 Match 块自身不出现；条目按文件序；末尾 Match 影子阻断条目在列
      if (JSON.stringify(names) !== JSON.stringify(['r22-ok1', 'r22-blocked', 'r22-nouser', 'r22-dupx', 'r22-mblocked'])) return title('FAIL-names:' + names.join(','));
      const mb = byName(pv, 'r22-mblocked');
      // rev-r22 H1 原生实证：前置 Match 段的 User 遮蔽后续条目 → 阻断不可直接导入
      if (!mb || mb.directly_importable || !(mb.unsupported || []).some((u) => u.directive === 'user' && u.level === 'Blocking')) return title('FAIL-match-shadow:' + JSON.stringify(mb));
      const ok1 = byName(pv, 'r22-ok1');
      if (!ok1 || !ok1.directly_importable || !ok1.user_specified) return title('FAIL-ok1:' + JSON.stringify(ok1));
      const w = (ok1.unsupported || []).find((u) => u.directive === 'serveraliveinterval');
      if (!w || w.level !== 'Warning' || !(w.line > 0)) return title('FAIL-warn:' + JSON.stringify(ok1.unsupported));
      if (!ok1.source_file || !(ok1.source_line > 0)) return title('FAIL-src:' + ok1.source_file + ':' + ok1.source_line);
      const blocked = byName(pv, 'r22-blocked');
      const bj = (blocked.unsupported || []).find((u) => u.directive === 'proxyjump');
      if (!blocked || blocked.directly_importable || !bj || bj.level !== 'Blocking') return title('FAIL-blocked:' + JSON.stringify(blocked));
      const nouser = byName(pv, 'r22-nouser');
      if (!nouser || nouser.user_specified || nouser.directly_importable) return title('FAIL-nouser:' + JSON.stringify(nouser));
      // rev-r22 M2 核心形状：无 User 条目 username 兜底当前用户（非空），
      // UI 预填须按 user_specified 置空而非透传兜底值
      if (!nouser.username) return title('FAIL-nouser-usernameshape:' + JSON.stringify(nouser));
      const dupx = byName(pv, 'r22-dupx');
      if (!dupx || !dupx.already_imported) return title('FAIL-dupx-pv:' + JSON.stringify(dupx));
      await markSync('r22-preview-ok');
      // ---- B) 导入跳过语义（overwrite=false） ----
      const outs = await inv('ssh_config_import', { path: CFG, names: ['r22-ok1', 'r22-blocked', 'r22-nouser', 'r22-dupx'], overwrite: false });
      const byo = (n) => outs.find((o) => o.name === n) || null;
      if (!byo('r22-ok1') || !byo('r22-ok1').host_id) return title('FAIL-ok1-imp:' + JSON.stringify(outs));
      if (byo('r22-blocked').skipped_reason !== 'Blocked') return title('FAIL-blocked-skip:' + JSON.stringify(byo('r22-blocked')));
      if (byo('r22-nouser').skipped_reason !== 'Blocked') return title('FAIL-nouser-skip:' + JSON.stringify(byo('r22-nouser')));
      if (byo('r22-dupx').skipped_reason !== 'Duplicate' || byo('r22-dupx').host_id) return title('FAIL-dup-skip:' + JSON.stringify(byo('r22-dupx')));
      await markSync('r22-skip-ok');
      // ---- C) 显式覆盖（overwrite=true）：既有 id + config 值写入 ----
      const hosts1 = await inv('list_hosts', {});
      const pre = hosts1.find((x) => x.name === 'r22-dupx');
      const outs2 = await inv('ssh_config_import', { path: CFG, names: ['r22-dupx'], overwrite: true });
      if (!outs2[0] || outs2[0].host_id !== pre.id) return title('FAIL-ow-id:' + JSON.stringify(outs2));
      const hosts2 = await inv('list_hosts', {});
      const after = hosts2.filter((x) => x.name === 'r22-dupx');
      if (after.length !== 1 || after[0].username !== 'root') return title('FAIL-ow-val:' + JSON.stringify(after));
      await markSync('r22-overwrite-ok');
      // ---- D) 面板冒烟（真实 ~/.ssh/config，弱断言：开/关无错） ----
      const impBtn = document.querySelector('button[aria-label="导入 ~/.ssh/config"]');
      if (!impBtn) return title('FAIL-no-impbtn');
      impBtn.click();
      const panel = await waitFor(() => ([...document.querySelectorAll('.card')].find((c) => c.textContent.includes('从 ~/.ssh/config 导入')) || null), 30);
      if (!panel) return title('FAIL-no-panel');
      await sleep(400); // 预览拉取
      const rows = panel.querySelectorAll('.sshcfg-row').length;
      const empty = panel.textContent.includes('没有可导入的条目');
      if (rows === 0 && !empty) return title('FAIL-panel-empty');
      await markSync('r22-panel-ok|rows=' + rows);
      const closeBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '收起');
      if (closeBtn) closeBtn.click();
      await sleep(200);
      // ---- 回收：删除导入/预置主机与身份 ----
      for (const n of ['r22-ok1', 'r22-dupx']) {
        const h = (await inv('list_hosts', {})).find((x) => x.name === n);
        if (h) await inv('delete_host', { id: h.id });
      }
      for (const i of (await inv('list_identities', {}))) {
        try { await inv('delete_identity', { id: i.id }); } catch {}
      }
      await markSync('r22-DONE');
      await title('r22-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R23 C1 消费/关闭/退出契约探针注入脚本（TINYSSH_SMOKE_MODE=r23；dev 门控，产品路径
/// 无关）。共享 docker sshd 真路径：
/// A) begin_connection 相位 UI 呈示（等待指纹确认）+ §302 取消入口；
/// B) TOFU 挂起期卡上取消 → 终态 Cancelled：卡复位+已取消 toast+门消散+无隐藏会话；
/// C) rev-r21 L3 真实 blur 投递实证：TOFU 门挂起 + osascript 激活他应用（驱动侧）→
///    document.hasFocus()=false 实证 → 信任完成不抢视图（toast 点标签进入）；
///    同时 §280/gatesBusy host_id：他主机门挂起中 r23-a 连接完成不切视图；
/// D) §6.4 关闭契约：确认框统一「关闭会话」+ 影响行（转发可查/任务未知如实）→
///    关闭成功标签移除、无死会话；
/// E) R20 前置闭环：.welcome-recents 原生呈现（真会话历史）；
/// F) §6.4 退出契约：真实窗口关闭（驱动 osascript）→ 汇总确认 → 取消存活；
///    再次关闭 → 结束会话并退出 → quit_app 退出进程（驱动核验零残留）。
fn r23_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R23_INJECTED__) return;
  window.__R23_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const btnText = (name) => cardBtn(name, '.host-connect-btn')?.textContent.trim() ?? null;
  const maskText = () => document.querySelector('.hk-mask')?.textContent ?? '';
  const cancelCard = (name) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    const b = [...(card?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '取消');
    if (!b) return false;
    b.click();
    return true;
  };
  const activeTab = () => document.querySelector('.tabbar .tab.tab-active')?.textContent.trim() ?? '';
  const tabCount = (name) => [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes(name)).length;
  const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|');
  (async () => {
    try {
      await title('r23-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // connection-event 订阅（内部通道 best-effort）
      const evs = [];
      try {
        if (typeof window.__TAURI_INTERNALS__.transformCallback === 'function') {
          const cb = window.__TAURI_INTERNALS__.transformCallback((e) => { if (e && e.payload) evs.push(e.payload); });
          await inv('plugin:event|listen', { event: 'connection-event', target: { kind: 'Any' }, handler: cb });
        }
      } catch {}
      await inv('upsert_host', { host: { id: null, name: 'r23-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await inv('upsert_host', { host: { id: null, name: 'r23-b', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r23-a', '.host-connect-btn') ? true : null), 40);
      // ---- A: 相位呈示 + 取消入口 ----
      if (!connect('r23-a')) return title('FAIL-connect-a');
      const tofu = await waitFor(() => (maskText().includes('首次连接确认') ? true : null), 60);
      if (!tofu) return title('FAIL-no-tofu');
      const phaseTxt = btnText('r23-a');
      const cancelBtn = (() => {
        const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('r23-a'));
        return !!([...(card?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '取消'));
      })();
      if (phaseTxt !== '等待指纹确认' || !cancelBtn) return title('FAIL-phase:' + phaseTxt + '|cancel=' + cancelBtn);
      await markSync('r23a-phase-ok');
      // ---- A2: 信任 → Connected（前台 attach）+ 事件相位 ----
      [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
      const s1 = await waitFor(async () => ((await inv('list_sessions', {})).find((x) => x.host_name === 'r23-a' && x.state === 'Connected') || null), 100);
      if (!s1) return title('FAIL-conn-a');
      await sleep(400);
      if (!activeTab().includes('r23-a')) return title('FAIL-attach-a:' + activeTab());
      const phases = evs.map((e) => e.phase);
      if (!phases.includes('Ready')) return title('FAIL-ev-ready:' + JSON.stringify(phases));
      await markSync('r23a-conn-ok');
      // ---- B: TOFU 挂起期卡上取消（§302）→ 无隐藏会话 ----
      if (!connect('r23-b')) return title('FAIL-connect-b');
      await waitFor(() => (maskText().includes('首次连接确认') ? true : null), 60);
      if (!cancelCard('r23-b')) return title('FAIL-no-cancel-btn');
      const cancelled = await waitFor(() => (!document.querySelector('.hk-mask') && btnText('r23-b') === '连接' ? true : null), 60);
      if (!cancelled) return title('FAIL-cancel-settle:' + btnText('r23-b'));
      if (!toasts().includes('已取消连接')) return title('FAIL-cancel-toast:' + toasts().slice(-80));
      const sessB = (await inv('list_sessions', {})).filter((x) => x.host_name === 'r23-b');
      if (sessB.length !== 0) return title('FAIL-hidden-session:' + sessB.length);
      await markSync('r23a-cancel-ok');
      // ---- C: 真实 blur（驱动侧 osascript 激活他应用）+ gatesBusy host_id ----
      if (!connect('r23-b')) return title('FAIL-connect-b2');
      await waitFor(() => (maskText().includes('首次连接确认') ? true : null), 60);
      await markSync('r23a-blur-wait');
      await sleep(6000); // 驱动在此窗口执行 osascript 激活 Finder（真实失焦）
      if (document.hasFocus()) return title('FAIL-blur-not-delivered');
      await markSync('r23a-blur-delivered');
      // 门挂起中他主机（r23-a 已信任）连接：§280 可点 + gatesBusy（host_id 不同）不切视图
      if (!connect('r23-a')) return title('FAIL-280-disabled');
      const s2 = await waitFor(async () => ((await inv('list_sessions', {})).filter((x) => x.host_name === 'r23-a' && x.state === 'Connected').length >= 2 ? true : null), 100);
      if (!s2) return title('FAIL-conn-a2');
      await sleep(500);
      // 判别器是 toast（压制分支标记）：视图可能本来就停在 r23-a（A2 attach 过），不算抢
      if (!toasts().includes('r23-a') || !toasts().includes('点击标签进入')) return title('FAIL-gatesbusy-toast:' + toasts().slice(-100));
      await markSync('r23a-gatesbusy-ok');
      // 信任 r23-b → 完成；blur 已推进代际 → 不抢视图，点标签进入
      [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
      const s3 = await waitFor(async () => ((await inv('list_sessions', {})).find((x) => x.host_name === 'r23-b' && x.state === 'Connected') || null), 100);
      if (!s3) return title('FAIL-conn-b');
      await sleep(500);
      if (activeTab().includes('r23-b')) return title('FAIL-bg-attach:' + activeTab());
      const tabB = [...document.querySelectorAll('.tabbar .tab')].find((t) => t.textContent.includes('r23-b'));
      tabB.click();
      await sleep(400);
      if (!activeTab().includes('r23-b')) return title('FAIL-tab-entry:' + activeTab());
      await markSync('r23a-blur-noattach-ok');
      // ---- D: §6.4 关闭契约 ----
      const xb = [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes('r23-b'))[0].querySelector('.tab-x');
      xb.click();
      const dlg = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
      if (!dlg || !dlg.includes('关闭与 r23-b') || !dlg.includes('将受影响的转发') || !dlg.includes('状态未知')) return title('FAIL-close-dlg:' + (dlg ?? 'null').slice(0, 120));
      [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '关闭会话').click();
      const goneB = await waitFor(async () => (tabCount('r23-b') === 0 ? true : null), 60);
      if (!goneB) return title('FAIL-close-tab:' + tabCount('r23-b'));
      await markSync('r23a-close-ok');
      // ---- E: .welcome-recents 原生呈现（R20 前置闭环）----
      // gatesbusy 段压制的后台会话（r23-a #2）也渲染标签——循环全关才见欢迎页
      for (let i = 0; i < 5; i++) {
        const x = document.querySelector('.tabbar .tab .tab-x');
        if (!x) break;
        x.click();
        const d2 = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
        if (!d2) return title('FAIL-close-dlg2-' + i);
        [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '关闭会话').click();
        await sleep(300);
      }
      await waitFor(() => (document.querySelector('.welcome-actions') ? true : null), 60);
      const recents = await waitFor(() => {
        const r = document.querySelector('.welcome-recents');
        return r && r.textContent.includes('r23-a') && r.textContent.includes('r23-b') ? r.textContent : null;
      }, 60);
      if (!recents) return title('FAIL-recents:' + (document.querySelector('.welcome-recents')?.textContent.slice(0, 80) ?? 'null'));
      await markSync('r23a-recents-ok');
      // ---- F: §6.4 退出契约（驱动协同：真实窗口关闭 ×2）----
      await markSync('r23a-quit-wait');
      await sleep(15000);
      const qdlg = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
      if (!qdlg || !qdlg.includes('退出 TinySSH')) return title('FAIL-quit-dlg:' + (qdlg ?? 'null').slice(0, 120));
      if (!qdlg.includes('活动会话') || !qdlg.includes('转发') || !qdlg.includes('结束会话并退出')) return title('FAIL-quit-summary:' + qdlg.slice(0, 150));
      [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '取消').click();
      await sleep(500);
      if (document.querySelector('.confirm-dialog')) return title('FAIL-quit-cancel');
      await markSync('r23a-quit-cancel-ok');
      await markSync('r23a-quit-wait2');
      await sleep(15000);
      const qdlg2 = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
      if (!qdlg2 || !qdlg2.includes('退出 TinySSH')) return title('FAIL-quit-dlg2');
      await markSync('r23a-quit-confirming');
      [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.includes('结束会话并退出')).click();
      await markSync('r23a-DONE');
      await title('r23-DONE'); // quit_app 随后退出进程；驱动核验零残留
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R25 搜索/复制粘贴/分屏 探针注入脚本（TINYSSH_SMOKE_MODE=r25；dev 门控，产品路径无关）：
/// A) r25-a/r25-b 双真机会话 → 菜单复用建立分屏（左主/右副名牌）→ pane mousedown 换焦
///    → 退出分屏两会话存活（§322/§324）；
/// —— alt-screen 搜索作用域不在本脚本：原生面 checkpoint/重放与 alt 交换互作使
///    normal buffer 读数不可靠（R11 已原生实证 alt 屏检查点），demo 探针 F 段直控覆盖；
/// C) 原生粘贴：剪贴板由驱动 pbcopy 预置（单行 + 多行）——单行直发回显；多行在远端
///    bracketed paste 开启时直发无确认框（无 bracketed 确认路径由 demo 探针 B1/B2 覆盖）；
/// D) §6.4 退出链（驱动协同：真实窗口关闭 ×2 → 摘要取消 → 确认退出 → 零残留）。
fn r25_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R25_INJECTED__) return;
  window.__R25_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const activeTab = () => document.querySelector('.tabbar .tab.tab-active')?.textContent.trim() ?? '';
  const tabCount = (name) => [...document.querySelectorAll('.tabbar .tab')].filter((t) => t.textContent.includes(name)).length;
  const paneInfo = () => ({
    left: document.querySelector('.pane-left .pane-tag')?.textContent ?? null,
    right: document.querySelector('.pane-right .pane-tag')?.textContent ?? null,
  });
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  const activeTextarea = () => document.querySelector('.term-session.active textarea');
  const rowsText = () => [...document.querySelectorAll('.term-session.active .xterm-rows')].map((r) => r.textContent).join('');
  const sendKey = (key, meta) => activeTextarea()?.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: !!meta, bubbles: true, cancelable: true }));
  const typeIntoSearch = async (text) => {
    const inp = document.querySelector('.term-search input');
    inp.focus();
    document.execCommand('insertText', false, text);
  };
  (async () => {
    try {
      await title('r25-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r25-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await inv('upsert_host', { host: { id: null, name: 'r25-b', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r25-a', '.host-connect-btn') ? true : null), 40);
      // ---- A: 双机连接 → 菜单复用建立分屏 ----
      if (!connect('r25-a')) return title('FAIL-connect-a');
      await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
      [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
      const s1 = await waitFor(async () => (await activeSess('r25-a'))?.state === 'Connected' ? true : null, 150);
      if (!s1) return title('FAIL-conn-a');
      await sleep(400);
      if (!connect('r25-b')) return title('FAIL-connect-b');
      await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
      [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
      const s2 = await waitFor(async () => (await activeSess('r25-b'))?.state === 'Connected' ? true : null, 150);
      if (!s2) return title('FAIL-conn-b');
      await sleep(400);
      await markSync('r25a-conns-ok');
      // 分屏菜单：复用 r25-b 入右副 pane
      const splitBtn = [...document.querySelectorAll('.session-toolbar button')].find((x) => (x.title ?? '').startsWith('分屏：'));
      if (!splitBtn) return title('FAIL-no-split-btn:tb=' + !!document.querySelector('.session-toolbar') + '|tab=' + activeTab() + '|focus=' + document.hasFocus());
      splitBtn.click();
      const menu = await waitFor(() => document.querySelector('.split-menu') || null, 30);
      if (!menu) return title('FAIL-no-split-menu');
      const reuseItem = [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('r25-a'));
      if (!reuseItem) return title('FAIL-no-reuse-item:' + menu.textContent.slice(0, 80));
      reuseItem.click();
      const panes = await waitFor(() => (document.querySelector('.pane-left') && document.querySelector('.pane-right') ? paneInfo() : null), 50);
      if (!panes || panes.left !== 'r25-b' || panes.right !== 'r25-a') return title('FAIL-split-panes:' + JSON.stringify(panes));
      await markSync('r25a-split-ok');
      // pane mousedown 换焦（点击只切焦点不交换——§322）
      document.querySelector('.pane-right')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep(300);
      if (!document.querySelector('.pane-right.pane-focused')) return title('FAIL-pane-focus');
      await markSync('r25a-panefocus-ok');
      // 退出分屏：两会话仍 Connected（§324 退出分屏不断开）
      const exitBtn = [...document.querySelectorAll('.session-toolbar button')].find((x) => x.title === '退出分屏（会话保留不断开）');
      if (!exitBtn) return title('FAIL-no-exit-btn');
      exitBtn.click();
      await sleep(400);
      const after = await inv('list_sessions', {});
      const alive = after.filter((x) => (x.host_name === 'r25-a' || x.host_name === 'r25-b') && x.state === 'Connected').length;
      if (document.querySelector('.pane-left') || alive !== 2 || tabCount('r25-') < 2) return title('FAIL-exit-split:' + alive + '|' + tabCount('r25-'));
      await markSync('r25a-exitsplit-ok');
      // ---- C: 原生粘贴（驱动分段 pbcopy：单行 → 多行，wait 标记对齐换料）----
      await markSync('r25a-paste1-wait');
      await sleep(3000);
      sendKey('v', true);
      const p1 = await waitFor(() => (rowsText().includes('r25pastemark') ? true : null), 60);
      if (!p1) return title('FAIL-paste-single:' + rowsText().slice(0, 60));
      await markSync('r25a-paste-single-ok');
      await markSync('r25a-paste2-wait');
      await sleep(3000);
      sendKey('v', true);
      const dlg = document.querySelector('.paste-dialog');
      const p2 = await waitFor(() => (rowsText().includes('r25ml-one') && rowsText().includes('r25ml-two') ? true : null), 80);
      if (!p2 || dlg) return title('FAIL-paste-multi:dlg=' + !!dlg);
      await markSync('r25a-paste-multi-ok');
      // ---- D: §6.4 退出链（驱动协同）----
      await markSync('r25a-quit-wait');
      await sleep(15000);
      const qdlg = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
      if (!qdlg || !qdlg.includes('退出 TinySSH')) return title('FAIL-quit-dlg:' + (qdlg ?? 'null').slice(0, 120));
      if (!qdlg.includes('活动会话') || !qdlg.includes('转发') || !qdlg.includes('结束会话并退出')) return title('FAIL-quit-summary:' + qdlg.slice(0, 150));
      [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === '取消').click();
      await sleep(500);
      if (document.querySelector('.confirm-dialog')) return title('FAIL-quit-cancel');
      await markSync('r25a-quit-cancel-ok');
      await markSync('r25a-quit-wait2');
      await sleep(15000);
      const qdlg2 = await waitFor(() => (document.querySelector('.confirm-dialog')?.textContent ?? null), 30);
      if (!qdlg2 || !qdlg2.includes('退出 TinySSH')) return title('FAIL-quit-dlg2');
      await markSync('r25a-quit-confirming');
      [...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.includes('结束会话并退出')).click();
      await markSync('r25a-DONE');
      await title('r25-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}
/// R26（§6.4 断线/重试/重确认/重连）原生冒烟：真 sshd 容器由驱动 docker stop/start
/// 协同——周期1 停容器 → 自动重连计数横幅（第 N/3 次）→ 3 次耗尽 Disconnected +
/// dead-overlay + 键入拦截；周期2 再断 →「停止重试」提前落 Disconnected；周期3
/// 驱动启容器 → 手动重连 → Reconfirming 横幅（已重连；旧现场待核实）+ 人类键入恢复；
/// r26-b 集成关主机命令框 → Shell 拒绝 + Fresh 指引两行（R24-L5）；周期4 断开标签
/// 直接关不询问（§6.4）。事件面 session-state 真实通道驱动横幅。
/// R27 原生冒烟（外观/终端设置/可访问性；无 sshd 依赖——纯 UI/偏好面）：
/// 阶段1（新库）：真实 macOS 深浅切换（驱动 osascript）→ WKWebView prefers-color-scheme
/// 实时跟随（新装默认 system）；设置面板三态+终端配色解耦（原生面）+ blob chrome 落库
/// （get_workspace 对账）+ ⌘= 字号键；阶段2（驱动杀进程→DB 回卷 user_version=4+删 blob
/// +写旧键 ui.theme=solar-light→重启）：V5 迁移映射消费——chrome=light + 终端 Solarized
/// 浅色在位，随后「跟随系统」归位（self-consistent 断言 matchMedia 解析）。
fn r27_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R27_INJECTED__) return;
  window.__R27_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const chromeAttr = () => document.documentElement.dataset.chrome ?? null;
  const pressedAppearance = () => {
    const g = document.querySelector('[role="group"][aria-label="应用外观"]');
    if (!g) return null;
    const on = [...g.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') === 'true');
    return on ? on.textContent : null;
  };
  const clickAppearance = async (label) => {
    const ok = await waitFor(() => {
      const g = document.querySelector('[role="group"][aria-label="应用外观"]');
      if (!g) return null;
      const b = [...g.querySelectorAll('button')].find((x) => x.textContent === label);
      if (!b) return null;
      b.click();
      return true;
    }, 30);
    return ok;
  };
  (async () => {
    try {
      // 二阶段（驱动以 RUN_ID=<run>-p2 重启 + 已回卷 DB + 写旧键 ui.theme=solar-light）：
      // 验 V5 迁移映射消费——chrome=light + 终端 Solarized 浅色在位
      const PHASE2 = /-p2$/.test(RUN);
      if (PHASE2) {
        await title('r27-p2-open');
        const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
        if (!cards) return title('FAIL-p2-no-cards');
        await sleep(600); // 偏好载入链（get_workspace/get_setting）落地
        const ch = await waitFor(() => (chromeAttr() === 'light' ? true : null), 40);
        if (!ch) return title('FAIL-p2-chrome:' + chromeAttr() + ' (solar-light 应映射 light)');
        const pal = await waitFor(() => {
          document.querySelector('.hb-settings')?.click();
          return document.querySelector('.term-settings') ? true : null;
        }, 40);
        if (!pal) return title('FAIL-p2-no-settings');
        const solar = [...document.querySelectorAll('.ts-opt')].find((b) => b.textContent.includes('Solarized 浅色'));
        if (!solar || !solar.classList.contains('ts-active')) return title('FAIL-p2-palette:' + (solar ? 'not-active' : 'missing'));
        await markSync('r27a-migr-ok');
        // 「跟随系统」归位：chrome 应实时解析为当前系统外观（与 in-page matchMedia 自洽）
        if (!await clickAppearance('跟随系统')) return title('FAIL-p2-no-system-btn');
        await sleep(300);
        const sysRes = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        if (chromeAttr() !== sysRes) return title('FAIL-p2-system:' + chromeAttr() + '!=' + sysRes);
        await markSync('r27a-system-restore-ok');
        await markSync('r27a-DONE');
        return title('r27-DONE');
      }
      await title('r27-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await sleep(600);
      // ---- 新装默认跟随系统：chrome = 当前系统外观 ----
      const chrome0 = chromeAttr();
      if (chrome0 !== 'dark' && chrome0 !== 'light') return title('FAIL-chrome0:' + String(chrome0));
      const sysRes0 = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      if (chrome0 !== sysRes0) return title('FAIL-chrome0-mismatch:' + chrome0 + '!=' + sysRes0);
      await markSync('r27a-chrome0=' + chrome0);
      // ---- 驱动 osascript 切系统深浅 → 实时跟随（原生面证据；demo 只能 emulate）----
      await markSync('r27a-sys-wait');
      const flipped = await waitFor(() => (chromeAttr() && chromeAttr() !== chrome0 ? true : null), 300);
      if (!flipped) return title('FAIL-no-sys-follow:' + chromeAttr() + ' vs ' + chrome0);
      if (chromeAttr() !== (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) return title('FAIL-sys-follow-mismatch');
      await markSync('r27a-sysfollow-ok');
      // ---- 设置面板：三态 + 解耦 + 落库 + ⌘= 字号 ----
      const opened = await waitFor(() => (document.querySelector('.hb-settings')?.click(), document.querySelector('.term-settings') ? true : null), 40);
      if (!opened) return title('FAIL-no-settings');
      if (pressedAppearance() !== '跟随系统') return title('FAIL-p1-pressed:' + pressedAppearance());
      const tablist = document.querySelector('.tabbar')?.getAttribute('role') === 'tablist';
      if (!tablist) return title('FAIL-no-tablist');
      if (!await clickAppearance('深色')) return title('FAIL-no-dark-btn');
      await sleep(250);
      if (chromeAttr() !== 'dark') return title('FAIL-dark-noapply:' + chromeAttr());
      // 解耦：切终端配色 Solarized 深色 → 应用 chrome 不动
      const solarDark = [...document.querySelectorAll('.ts-opt')].find((b) => b.textContent.includes('Solarized 深色'));
      if (!solarDark) return title('FAIL-no-solardark');
      solarDark.click();
      await sleep(250);
      if (chromeAttr() !== 'dark') return title('FAIL-palette-couples-chrome:' + chromeAttr());
      if (!solarDark.classList.contains('ts-active')) return title('FAIL-palette-not-active');
      await markSync('r27a-decouple-ok');
      // 显式浅色 → chrome=light；blob chrome 落库对账
      if (!await clickAppearance('浅色')) return title('FAIL-no-light-btn');
      await sleep(250);
      if (chromeAttr() !== 'light') return title('FAIL-light-noapply:' + chromeAttr());
      const ws = await inv('get_workspace', {});
      if (!ws || ws.chrome !== 'light') return title('FAIL-blob-chrome:' + String(ws && ws.chrome));
      await markSync('r27a-appear-ok');
      // ⌘= 字号键（应用级 keydown 同一 action 语义）
      const val0 = Number(document.querySelector('.ts-val')?.textContent?.trim() ?? '0');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true }));
      await sleep(300);
      const val1 = Number(document.querySelector('.ts-val')?.textContent?.trim() ?? '0');
      if (val1 !== val0 + 1) return title('FAIL-font-key:' + val0 + '->' + val1);
      await markSync('r27a-font-ok(14->' + val1 + ')');
      // ---- 交给驱动：杀进程 → DB 回卷 V4+旧键 ui.theme=solar-light → 重启 ----
      await markSync('r27a-relaunch-wait');
      await sleep(120000); // 驱动在此窗口内完成回卷与重启；本进程随后被杀
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R30（C4 路径/元数据/过期保护）原生冒烟：真机 sshd。驱动预置 /tmp/r30dir
/// （sub/ a.txt b.txt alink→a.txt slink→sub dangling→missing），脚本：
/// A invoke 契约面（resolve 初始目录+归一+不存在可区别 / list kind / stat 三态）；
/// B UI 面（canonical 导航、行渲染 kind、符号链接点击进入目录、不存在路径可读错误）。
fn r30_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R30_INJECTED__) return;
  window.__R30_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const trust = async () => {
    await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
    [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  // React 受控输入：execCommand 走真实编辑路径（直赋 el.value 被 React tracker 去重丢 onChange）
  const setInput = (el, v) => { el.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, v); };
  (async () => {
    try {
      await title('r30-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r30-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r30-a', '.host-connect-btn') ? true : null), 40);
      if (!connect('r30-a')) return title('FAIL-connect');
      await trust();
      const c1 = await waitFor(async () => (await activeSess('r30-a'))?.state === 'Connected' ? true : null, 150);
      if (!c1) return title('FAIL-conn');
      await sleep(400);
      const sid = (await activeSess('r30-a')).id;
      // ---- A. invoke 契约面（C4）----
      const r0 = await inv('sftp_resolve_path', { sid, path: null });
      if (!r0 || typeof r0.canonical !== 'string' || !r0.canonical.startsWith('/')) return title('FAIL-resolve-null:' + JSON.stringify(r0));
      await markSync('r30a-resolve-init=' + r0.canonical);
      const r1 = await inv('sftp_resolve_path', { sid, path: '/tmp/../tmp/r30dir' });
      if (r1.canonical !== '/tmp/r30dir') return title('FAIL-resolve-norm:' + JSON.stringify(r1));
      // 「不存在」判别面在 list（read_dir）/stat（lstat）——二者必查存在；
      // resolve 的 realpath 实现服务端依赖（OpenSSH 宽容：词法归一即成功）
      let caught = null;
      try { await inv('sftp_list', { sid, path: '/tmp/r30-missing' }); } catch (e) { caught = e; }
      if (!caught || caught.kind !== 'sftp_path_not_found') return title('FAIL-list-miss-kind:' + JSON.stringify(caught));
      caught = null;
      try { await inv('sftp_stat', { sid, path: '/tmp/r30-missing' }); } catch (e) { caught = e; }
      if (!caught || caught.kind !== 'sftp_path_not_found') return title('FAIL-stat-miss-kind:' + JSON.stringify(caught));
      const es = await inv('sftp_list', { sid, path: '/tmp/r30dir' });
      const byName = (n) => es.find((x) => x.name === n);
      if (!byName('sub') || byName('sub').kind !== 'dir') return title('FAIL-list-sub:' + JSON.stringify(es));
      if (!byName('alink') || byName('alink').kind !== 'symlink') return title('FAIL-list-link:' + JSON.stringify(es));
      if (!byName('a.txt') || byName('a.txt').kind !== 'file' || byName('a.txt').size !== 6) return title('FAIL-list-file:' + JSON.stringify(byName('a.txt')));
      const st1 = await inv('sftp_stat', { sid, path: '/tmp/r30dir/a.txt' });
      if (st1.kind !== 'file' || st1.size !== 6 || st1.canonical !== '/tmp/r30dir/a.txt' || st1.symlink_target !== null) return title('FAIL-stat-file:' + JSON.stringify(st1));
      const st2 = await inv('sftp_stat', { sid, path: '/tmp/r30dir/alink' });
      if (st2.kind !== 'symlink' || st2.symlink_target !== 'a.txt' || st2.size !== 6 || st2.canonical !== '/tmp/r30dir/a.txt') return title('FAIL-stat-link:' + JSON.stringify(st2));
      const st3 = await inv('sftp_stat', { sid, path: '/tmp/r30dir/dangling' });
      if (st3.kind !== 'symlink' || st3.symlink_target !== 'missing') return title('FAIL-stat-dangling:' + JSON.stringify(st3));
      if (st3.canonical !== null && st3.canonical !== '/tmp/r30dir/missing') return title('FAIL-stat-dangling-canon:' + JSON.stringify(st3));
      await markSync('r30a-contract-ok');
      // ---- B. UI 浏览器面 ----
      const stBtn = await waitFor(() => document.querySelector('.st-file') || null, 100);
      if (!stBtn) return title('FAIL-no-files-btn:tabs=' + document.querySelectorAll('.tabbar .tab').length + ',cards=' + document.querySelectorAll('.host-card').length + ',view=' + (document.querySelector('.term-session') ? 'term' : 'welcome'));
      stBtn.click();
      const inp = await waitFor(() => document.querySelector('.sftp-path input') || null, 40);
      if (!inp) return title('FAIL-no-sftp-input');
      await sleep(700); // 首载链（cwd）落地，避免与手动导航竞速误判
      // canonical 导航：../ 输入归一后才列目录
      setInput(inp, '/tmp/../tmp/r30dir');
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const atDir = await waitFor(() => (document.querySelector('.sftp-path input')?.value === '/tmp/r30dir' ? true : null), 60);
      if (!atDir) return title('FAIL-canonical-nav:' + (document.querySelector('.sftp-path input')?.value ?? 'null'));
      const rowsSel = '.sftp-list .sftp-row';
      const rowsTxt = () => [...document.querySelectorAll(rowsSel)].map((r) => r.textContent).join(' || ');
      const rows = await waitFor(() => (rowsTxt().includes('a.txt') ? rowsTxt() : null), 60);
      if (!rows) return title('FAIL-no-rows:' + rowsTxt().slice(0, 80));
      if (!rows.includes('目录') || !rows.includes('链接')) return title('FAIL-row-kinds:' + rows.slice(0, 160));
      const aRow = [...document.querySelectorAll(rowsSel)].find((r) => r.textContent.includes('a.txt'));
      if (!aRow || !aRow.textContent.includes('6 B')) return title('FAIL-size-6B:' + (aRow ? aRow.textContent : 'null'));
      await markSync('r30a-ui-ok');
      // 符号链接点击进入目录（slink → sub；stat 探明 is_dir 后导航）
      const slRow = [...document.querySelectorAll(rowsSel + ' .sftp-name')].find((b) => b.textContent === 'slink');
      if (!slRow || slRow.tagName !== 'BUTTON') return title('FAIL-no-slink-btn:' + (slRow ? slRow.tagName : 'null'));
      slRow.click();
      // FE 保留请求路径（列的是跟随后的内容；demo B8 同语义 '/root/current'）
      const atSub = await waitFor(() => (document.querySelector('.sftp-path input')?.value === '/tmp/r30dir/slink' ? true : null), 60);
      if (!atSub) return title('FAIL-slink-nav:' + (document.querySelector('.sftp-path input')?.value ?? 'null'));
      if (document.querySelector('.section .err')) return title('FAIL-slink-err:' + document.querySelector('.section .err').textContent.slice(0, 80));
      await markSync('r30a-symlink-nav-ok');
      // 不存在路径 → 可读错误（不猜路径不假跳转）
      setInput(inp, '/tmp/r30-missing');
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const err = await waitFor(() => {
        const el = document.querySelector('.section .err');
        return el && el.textContent.includes('不存在') ? el.textContent : null;
      }, 60);
      if (!err) return title('FAIL-no-missing-err:' + (document.querySelector('.section .err')?.textContent ?? 'null').slice(0, 100));
      await markSync('r30a-missing-err-ok');
      await markSync('r30a-DONE');
      await title('r30-DONE');
      await sleep(120000); // 驱动收尾窗口；本进程随后被杀
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R32（C5 传输注册表）三阶段原生冒烟：r32a=主链（上传进度/终态/真机写穿/下载/
/// 失败注入/取消/未知取消/UI 卡片）；r32b=大文件上传在途（驱动杀进程制造
/// 「重启时中断」）；r32c=重启恢复对账（journal 活动行 → Failed + 说明 → UI 可见）。
fn r32_smoke_script(run_id: &str, mode: &str) -> String {
    let phase_a = r#"(function() {
  if (window.__R32_INJECTED__) return;
  window.__R32_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const trust = async () => {
    await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
    [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  // 轮询注册表直至指定任务终态（C5：查询是权威对账面）
  const waitTerminal = async (tid, tries) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const list = await inv('list_transfers', {});
      last = list.find((t) => t.id === tid) || null;
      if (last && ['Succeeded', 'Failed', 'Cancelled', 'OutcomeUnknown'].includes(last.status)) return last;
      await sleep(200);
    }
    return last;
  };
  (async () => {
    try {
      await title('r32a-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r32-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r32-a', '.host-connect-btn') ? true : null), 40);
      if (!connect('r32-a')) return title('FAIL-connect');
      await trust();
      const c1 = await waitFor(async () => (await activeSess('r32-a'))?.state === 'Connected' ? true : null, 150);
      if (!c1) return title('FAIL-conn');
      await sleep(400);
      const sid = (await activeSess('r32-a')).id;
      // ---- A. 注册表契约面 ----
      const list0 = await inv('list_transfers', {});
      if (!Array.isArray(list0)) return title('FAIL-list-shape:' + JSON.stringify(list0));
      await markSync('r32a-list-empty-ok');
      // 上传 2MB：创建先注册（handle 返回即 Queued/Running 可查）
      const h = await inv('upload_file', { sid, local: '/tmp/r32up.bin', remote: '/tmp/r32dir/up.bin' });
      if (!h || !h.id) return title('FAIL-upload-handle:' + JSON.stringify(h));
      const row0 = (await inv('list_transfers', {})).find((t) => t.id === h.id);
      if (!row0) return title('FAIL-not-registered:' + JSON.stringify(row0));
      if (row0.kind !== 'Upload' || row0.source !== '/tmp/r32up.bin' || row0.dest !== '/tmp/r32dir/up.bin') return title('FAIL-row-fields:' + JSON.stringify(row0));
      await markSync('r32a-registered-ok');
      const done1 = await waitTerminal(h.id, 150);
      if (!done1 || done1.status !== 'Succeeded') return title('FAIL-upload-terminal:' + JSON.stringify(done1));
      if (done1.bytes_done !== 2097152 || done1.total !== 2097152) return title('FAIL-upload-bytes:' + JSON.stringify(done1));
      if (!done1.finished_at || done1.revision < 2) return title('FAIL-upload-meta:' + JSON.stringify(done1));
      await markSync('r32a-upload-ok');
      // 真机写穿：SFTP stat 远端文件字节数一致
      const st = await inv('sftp_stat', { sid, path: '/tmp/r32dir/up.bin' });
      if (!st || st.size !== 2097152) return title('FAIL-remote-size:' + JSON.stringify(st));
      await markSync('r32a-remote-write-ok');
      // 下载（默认落 ~/Downloads）：终态 + 字节数
      const hd = await inv('download_file', { sid, remote: '/tmp/r32dir/up.bin', local: null });
      const doneD = await waitTerminal(hd.id, 150);
      if (!doneD || doneD.status !== 'Succeeded' || doneD.bytes_done !== 2097152) return title('FAIL-download:' + JSON.stringify(doneD));
      if (doneD.kind !== 'Download' || doneD.source !== '/tmp/r32dir/up.bin') return title('FAIL-download-fields:' + JSON.stringify(doneD));
      await markSync('r32a-download-ok');
      // 失败注入：本地不存在 → Failed + 真实错误文本（不吞不猜）
      const hf = await inv('upload_file', { sid, local: '/tmp/r32-missing.bin', remote: '/tmp/r32dir/never.bin' });
      const doneF = await waitTerminal(hf.id, 100);
      if (!doneF || doneF.status !== 'Failed' || !(doneF.error || '').includes('open')) return title('FAIL-failed-inject:' + JSON.stringify(doneF));
      await markSync('r32a-failed-ok');
      // 取消：400MB 上传在途（bytes≥1MB）→ cancel → Cancelling|Cancelled 即现 → 终态 Cancelled/已取消/部分字节
      const hb = await inv('upload_file', { sid, local: '/tmp/r32big.bin', remote: '/tmp/r32dir/big.bin' });
      let saw = null;
      for (let i = 0; i < 100; i++) {
        const list = await inv('list_transfers', {});
        saw = list.find((t) => t.id === hb.id);
        if (saw && saw.bytes_done >= 1048576) break;
        await sleep(100);
      }
      if (!saw || saw.bytes_done < 1048576) return title('FAIL-big-no-progress:' + JSON.stringify(saw));
      await markSync('r32a-progress-seen=' + saw.bytes_done);
      await inv('cancel_transfer', { id: hb.id });
      const soon = (await inv('list_transfers', {})).find((t) => t.id === hb.id);
      if (!soon || !['Cancelling', 'Cancelled'].includes(soon.status)) return title('FAIL-cancel-visible:' + JSON.stringify(soon));
      const doneC = await waitTerminal(hb.id, 100);
      if (!doneC || doneC.status !== 'Cancelled' || doneC.error !== '已取消') return title('FAIL-cancel-terminal:' + JSON.stringify(doneC));
      // rev-r32 中-1 处置后：取消不抹账——终态保留在途字节（取消前已见 ≥1MB）
      if (doneC.bytes_done < 1048576 || doneC.bytes_done >= doneC.total) return title('FAIL-cancel-bytes:' + JSON.stringify(doneC));
      await markSync('r32a-cancel-ok');
      // 未知取消 → 可区别错误
      let caught = null;
      try { await inv('cancel_transfer', { id: 't-nope' }); } catch (e) { caught = e; }
      if (!caught || caught.kind !== 'invalid_input') return title('FAIL-cancel-unknown:' + JSON.stringify(caught));
      await markSync('r32a-cancel-unknown-ok');
      // ---- B. UI 卡片面（事件/轮询驱动 + 面板重开对账）----
      const stBtn = await waitFor(() => document.querySelector('.st-file') || null, 100);
      if (!stBtn) return title('FAIL-no-files-btn');
      stBtn.click();
      const rows = await waitFor(() => (document.querySelectorAll('.xfer-row').length >= 3 ? true : null), 60);
      if (!rows) return title('FAIL-no-xfer-cards:' + document.querySelectorAll('.xfer-row').length);
      const txt = [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || ');
      if (!txt.includes('完成') || !txt.includes('2.0 MB')) return title('FAIL-done-card:' + txt.slice(0, 200));
      if (!txt.includes('失败')) return title('FAIL-failed-card:' + txt.slice(0, 200));
      if (!txt.includes('已取消')) return title('FAIL-cancelled-card:' + txt.slice(0, 200));
      await markSync('r32a-ui-ok');
      await markSync('r32a-DONE');
      await title('r32-DONE');
      await sleep(120000);
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    let phase_b = r#"(function() {
  if (window.__R32_INJECTED__) return;
  window.__R32_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  (async () => {
    try {
      await title('r32b-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await waitFor(async () => (cardBtn('r32-a', '.host-connect-btn') ? true : null), 40);
      const b = cardBtn('r32-a', '.host-connect-btn');
      if (!b) return title('FAIL-connect');
      b.click();
      await waitFor(async () => (await activeSess('r32-a'))?.state === 'Connected' ? true : null, 150);
      await sleep(600);
      const sid = (await activeSess('r32-a'))?.id;
      if (!sid) return title('FAIL-conn');
      const hb = await inv('upload_file', { sid, local: '/tmp/r32big.bin', remote: '/tmp/r32dir/recovering.bin' });
      if (!hb || !hb.id) return title('FAIL-upload-handle:' + JSON.stringify(hb));
      let saw = null;
      for (let i = 0; i < 100; i++) {
        const list = await inv('list_transfers', {});
        saw = list.find((t) => t.id === hb.id);
        if (saw && saw.bytes_done >= 4194304) break;
        await sleep(100);
      }
      if (!saw || saw.bytes_done < 4194304) return title('FAIL-no-progress:' + JSON.stringify(saw));
      await mark('r32b-TRANSFERRING=' + saw.bytes_done);
      // 在途保持：驱动看到标记后杀进程（journal 应停留 Running/Queued）
      await sleep(60000);
      await title('r32b-still-alive-BAD');
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    let phase_c = r#"(function() {
  if (window.__R32_INJECTED__) return;
  window.__R32_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  (async () => {
    try {
      await title('r32c-open');
      await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      // 重启恢复：上一进程在途任务按「提交前中断」落 Failed（不经任何会话连接）
      const row = await waitFor(async () => {
        const list = await inv('list_transfers', {});
        return list.find((t) => t.dest === '/tmp/r32dir/recovering.bin') || null;
      }, 50);
      if (!row) return title('FAIL-recovery-row-missing');
      if (row.status !== 'Failed') return title('FAIL-recovery-status:' + JSON.stringify(row));
      if (row.error !== '应用重启时传输中断') return title('FAIL-recovery-error:' + JSON.stringify(row));
      if (!row.finished_at) return title('FAIL-recovery-finished:' + JSON.stringify(row));
      await markSync('r32c-recovery-ok');
      // UI 对账：重挂后注册表面在文件面板可见
      const stBtn = await waitFor(() => document.querySelector('.st-file') || null, 100);
      if (!stBtn) return title('FAIL-no-files-btn');
      stBtn.click();
      const txt = await waitFor(() => {
        const t = [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || ');
        return t.includes('应用重启时传输中断') ? t : null;
      }, 60);
      if (!txt) return title('FAIL-recovery-card-missing:' + [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || ').slice(0, 200));
      await markSync('r32c-ui-ok');
      await markSync('r32c-DONE');
      await title('r32c-DONE');
      await sleep(120000);
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    let base = if mode == "r32b" {
        phase_b
    } else if mode == "r32c" {
        phase_c
    } else {
        phase_a
    };
    base.replace("__RUN__", run_id)
}

/// R31（文件面板/完整视图/导航与选择）原生冒烟 r31a：真机 sshd 上走 §348/§350 全链——
/// 面包屑/编辑路径框切换、返回/前进/上一级、隐藏项、名称筛选、排序（目录在前）、
/// 键盘 Enter 进目录、多选下载（真传输落盘）、目录明确信息、双击动作菜单、
/// 选择/路径跨标签恢复（按会话保存）、分屏×面板退完整视图（§186）。
fn r31_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R31_INJECTED__) return;
  window.__R31_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const trust = async () => {
    await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
    [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  const setInput = (el, v) => { el.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, v); };
  const rowNames = () => [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].map((r) => r.dataset.name);
  const selRow = (name, meta) => {
    const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === name);
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: !!meta }));
    return true;
  };
  const crumbsPath = () => document.querySelector('[data-testid="sftp-crumbs"]')?.title || null;
  const clickNav = async (label) => {
    const b = [...document.querySelectorAll('.sftp-nav button')].find((x) => x.getAttribute('aria-label') === label);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const navTo = async (p) => {
    [...document.querySelectorAll('.sftp-nav button')].find((x) => x.getAttribute('aria-label') === '切换路径输入')?.click();
    const inp = await waitFor(() => document.querySelector('[data-testid="sftp-path-input"]') || null, 40);
    if (!inp) return false;
    setInput(inp, p);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const okNav = await waitFor(() => (crumbsPath() === p ? true : null), 60);
    return !!okNav;
  };
  (async () => {
    try {
      await title('r31-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r31-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await inv('upsert_host', { host: { id: null, name: 'r31-b', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r31-a', '.host-connect-btn') ? true : null), 40);
      if (!connect('r31-a')) return title('FAIL-connect-a');
      await trust();
      if (!await waitFor(async () => (await activeSess('r31-a'))?.state === 'Connected' ? true : null, 150)) return title('FAIL-conn-a');
      await sleep(300);
      if (!connect('r31-b')) return title('FAIL-connect-b');
      await trust();
      if (!await waitFor(async () => (await activeSess('r31-b'))?.state === 'Connected' ? true : null, 150)) return title('FAIL-conn-b');
      await sleep(400);
      // 附到 r31-a（第一个标签）
      const tabA = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('r31-a'));
      if (!tabA) return title('FAIL-no-tab-a');
      tabA.click();
      await sleep(400);
      // 打开文件面板：R31 新面 = 面包屑 + 导航行 + 工具行
      const stBtn = await waitFor(() => document.querySelector('.st-file') || null, 100);
      if (!stBtn) return title('FAIL-no-files-btn');
      stBtn.click();
      if (!await waitFor(() => document.querySelector('[data-testid="sftp-crumbs"]') || null, 60)) return title('FAIL-no-crumbs');
      await sleep(700); // 首载链落地
      const initPath = crumbsPath();
      if (!initPath || !initPath.startsWith('/')) return title('FAIL-init-path:' + initPath);
      await markSync('r31a-init=' + initPath);
      // 编辑路径框 → /tmp/r31dir
      if (!await navTo('/tmp/r31dir')) return title('FAIL-nav-edit:' + crumbsPath());
      if (!await waitFor(() => rowNames().includes('a.txt') ? true : null, 60)) return title('FAIL-no-rows:' + rowNames().join(','));
      if (rowNames().includes('.hidden')) return title('FAIL-hidden-default-on');
      await markSync('r31a-nav-edit-ok');
      // 面包屑点击前缀段（tmp）→ /tmp
      const crumbTmp = [...document.querySelectorAll('[data-testid="sftp-crumbs"] .sftp-crumb')].find((b) => b.textContent === 'tmp');
      if (!crumbTmp) return title('FAIL-no-crumb-tmp');
      crumbTmp.click();
      if (!await waitFor(() => (crumbsPath() === '/tmp' ? true : null), 60)) return title('FAIL-crumb-nav:' + crumbsPath());
      // 返回 → /tmp/r31dir；前进 → /tmp；上一级 → /
      if (!await clickNav('返回')) return title('FAIL-back-btn');
      if (!await waitFor(() => (crumbsPath() === '/tmp/r31dir' ? true : null), 60)) return title('FAIL-back:' + crumbsPath());
      if (!await clickNav('前进')) return title('FAIL-fwd-btn');
      if (!await waitFor(() => (crumbsPath() === '/tmp' ? true : null), 60)) return title('FAIL-fwd:' + crumbsPath());
      if (!await clickNav('返回')) return title('FAIL-back2');
      if (!await waitFor(() => (crumbsPath() === '/tmp/r31dir' ? true : null), 60)) return title('FAIL-back2-path');
      if (!await clickNav('上一级')) return title('FAIL-up-btn');
      if (!await waitFor(() => (crumbsPath() === '/tmp' ? true : null), 60)) return title('FAIL-up:' + crumbsPath());
      if (!await navTo('/tmp/r31dir')) return title('FAIL-renav');
      await markSync('r31a-nav-history-ok');
      // 隐藏项开/关
      const hidBtn = [...document.querySelectorAll('.sftp-tools button')].find((b) => (b.title || '').includes('隐藏项'));
      if (!hidBtn) return title('FAIL-no-hidden-btn');
      hidBtn.click();
      if (!await waitFor(() => (rowNames().includes('.hidden') ? true : null), 40)) return title('FAIL-hidden-show');
      hidBtn.click();
      if (!await waitFor(() => (!rowNames().includes('.hidden') ? true : null), 40)) return title('FAIL-hidden-hide');
      await markSync('r31a-hidden-ok');
      // 名称筛选
      const filter = document.querySelector('.sftp-filter');
      if (!filter) return title('FAIL-no-filter');
      setInput(filter, 'big');
      if (!await waitFor(() => (rowNames().length === 1 && rowNames()[0] === 'big.txt' ? true : null), 40)) return title('FAIL-filter:' + rowNames().join(','));
      setInput(filter, '');
      await sleep(200);
      await markSync('r31a-filter-ok');
      // 排序：大小升序（目录在前，文件 6B<2K<100K）；再点降序翻转发
      const sizeBtn = [...document.querySelectorAll('.sftp-tools button')].find((b) => b.textContent.startsWith('大小'));
      if (!sizeBtn) return title('FAIL-no-size-btn');
      sizeBtn.click();
      const filesAsc = await waitFor(() => {
        const n = rowNames();
        const files = n.filter((x) => !['sub'].includes(x));
        return (files.join(',') === '.hidden,a.txt,b.txt,big.txt' || files.join(',') === 'a.txt,b.txt,big.txt') ? files : null;
      }, 40);
      if (!filesAsc) return title('FAIL-sort-asc:' + rowNames().join(','));
      sizeBtn.click();
      const filesDesc = await waitFor(() => {
        const n = rowNames();
        const files = n.filter((x) => !['sub'].includes(x));
        return (files.join(',') === 'big.txt,b.txt,a.txt,.hidden' || files.join(',') === 'big.txt,b.txt,a.txt') ? files : null;
      }, 40);
      if (!filesDesc) return title('FAIL-sort-desc:' + rowNames().join(','));
      [...document.querySelectorAll('.sftp-tools button')].find((b) => b.textContent.startsWith('名称'))?.click();
      await sleep(200);
      await markSync('r31a-sort-ok');
      // 键盘：聚焦列表 → Home 到首行（sub 目录）→ Enter 进入
      const list = document.querySelector('[data-testid="sftp-list"]');
      if (!list || list.getAttribute('tabindex') === null) return title('FAIL-list-not-focusable');
      list.focus();
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      if (!await waitFor(() => (crumbsPath() === '/tmp/r31dir/sub' ? true : null), 60)) return title('FAIL-kbd-enter:' + crumbsPath());
      if (!await clickNav('返回')) return title('FAIL-back3');
      if (!await waitFor(() => (crumbsPath() === '/tmp/r31dir' ? true : null), 60)) return title('FAIL-back3-path');
      await markSync('r31a-kbd-ok');
      // 多选下载：a.txt + ⌘b.txt → 下载所选 → 两张卡都到完成（真传输）
      if (!selRow('a.txt')) return title('FAIL-no-a-row');
      selRow('b.txt', true);
      const selbar = await waitFor(() => document.querySelector('[data-testid="sftp-selbar"]'), 40);
      if (!selbar || !selbar.textContent.includes('已选 2 项')) return title('FAIL-selbar:' + (selbar?.textContent ?? 'null'));
      [...selbar.querySelectorAll('button')].find((b) => b.textContent.includes('下载所选'))?.click();
      const doneTxt = await waitFor(() => {
        const t = [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || ');
        return (t.includes('完成') && (t.match(/完成/g) || []).length >= 2) ? t : null;
      }, 150);
      if (!doneTxt) return title('FAIL-multidl:' + [...document.querySelectorAll('.xfer-row')].map((r) => r.textContent).join(' || ').slice(0, 200));
      await markSync('r31a-multidl-ok');
      // 目录进选择 → 明确信息（不静默跳过）
      selRow('sub', true);
      await sleep(200);
      [...document.querySelectorAll('[data-testid="sftp-selbar"] button')].find((b) => b.textContent.includes('下载所选'))?.click();
      const toast = await waitFor(() => {
        const t = [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|');
        return t.includes('目录') && t.includes('不支持直接下载') ? t : null;
      }, 40);
      if (!toast) return title('FAIL-dir-info:' + [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|'));
      await markSync('r31a-dir-info-ok');
      // 双击文件 → 动作菜单（不直接执行）→ 菜单下载
      const fRow = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'big.txt');
      fRow.querySelector('.sftp-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 600, clientY: 300 }));
      const menu = await waitFor(() => document.querySelector('[data-testid="sftp-menu"]') || null, 40);
      if (!menu) return title('FAIL-no-menu');
      const cardsBefore = document.querySelectorAll('.xfer-row').length;
      [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('下载'))?.click();
      if (!await waitFor(() => document.querySelectorAll('.xfer-row').length > cardsBefore ? true : null, 60)) return title('FAIL-menu-dl');
      await markSync('r31a-menu-ok');
      // 定位到终端目录：cwd 可达则点按可达（shell 集成未启用时按钮禁用=登记为 skip）
      if (!await navTo('/tmp')) return title('FAIL-nav-tmp');
      const locBtn = [...document.querySelectorAll('.sftp-nav button')].find((b) => b.getAttribute('aria-label') === '定位到终端目录');
      if (!locBtn) return title('FAIL-no-locate');
      if (locBtn.disabled) {
        await markSync('r31a-locate-skip（无集成主机无可信 cwd，显式定位按钮按设计禁用；demo 域已判别）');
      } else {
        locBtn.click();
        const dest = await waitFor(() => (crumbsPath() && crumbsPath() !== '/tmp' ? crumbsPath() : null), 60);
        if (!dest) return title('FAIL-locate-noop');
        await markSync('r31a-locate=' + dest);
      }
      if (!await navTo('/tmp/r31dir')) return title('FAIL-nav-back');
      // 跨标签恢复（按会话保存）：选中 a.txt → 切 r31-b → 切回：路径+选择俱在
      selRow('a.txt');
      await sleep(200);
      const tabB = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('r31-b'));
      tabB.click();
      await sleep(600);
      const bCrumbs = crumbsPath();
      if (!bCrumbs || !bCrumbs.startsWith('/')) return title('FAIL-tab-b-crumbs:' + bCrumbs);
      if (bCrumbs === '/tmp/r31dir') return title('FAIL-cross-tab-leak');
      const tabA2 = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('r31-a'));
      tabA2.click();
      const restored = await waitFor(() => {
        const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'a.txt');
        return (crumbsPath() === '/tmp/r31dir' && row?.classList.contains('sel')) ? true : null;
      }, 60);
      if (!restored) return title('FAIL-restore:' + crumbsPath() + '|' + rowNames().join(','));
      await markSync('r31a-restore-ok');
      // 分屏 × 面板 → 完整视图（§186）；关面板恢复分屏
      [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('分屏：在右侧显示已有会话'))?.click();
      const smItem = await waitFor(() => [...document.querySelectorAll('.split-menu .sm-item')].find((b) => b.textContent.includes('r31-b')) || null, 40);
      if (!smItem) return title('FAIL-no-sm-item');
      smItem.click();
      const full = await waitFor(() => (document.querySelector('.task-panel')?.classList.contains('tp-full') ? true : null), 40);
      if (!full) return title('FAIL-split-not-full');
      await markSync('r31a-split-full-ok');
      document.querySelector('.tp-head button[aria-label="关闭任务面板"]')?.click();
      await sleep(400);
      const panes = document.querySelectorAll('.term-session.pane-left, .term-session.pane-right').length;
      if (panes !== 2) return title('FAIL-split-restored:' + panes);
      await markSync('r31a-split-restore-ok');
      await markSync('r31a-DONE');
      await title('r31-DONE');
      await sleep(120000);
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R33 原生冒烟注入脚本（TINYSSH_SMOKE_MODE=r33a；dev 门控，产品路径无关）：
/// 上传下载入口真实对话框链路——面板「上传」→ NSOpenPanel（驱动 GoTo+⌘A+Return）
/// → 多选上传真传输落容器；动作菜单「另存为…」→ NSSavePanel（驱动 GoTo+Return）
/// → 真落盘 /tmp/r33save + blob transfers.download_dir 记忆；普通下载 → 落上次目录。
/// 原生拖拽通道无法诚实合成（Finder 拖入）——分区/确认卡判别归 demo 域（登记）。
fn r33_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R33_INJECTED__) return;
  window.__R33_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const trust = async () => {
    await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
    [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  const crumbsPath = () => document.querySelector('[data-testid="sftp-crumbs"]')?.title || null;
  const rowNames = () => [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].map((r) => r.dataset.name);
  const navTo = async (p) => {
    [...document.querySelectorAll('.sftp-nav button')].find((x) => x.getAttribute('aria-label') === '切换路径输入')?.click();
    const inp = await waitFor(() => document.querySelector('[data-testid="sftp-path-input"]') || null, 40);
    if (!inp) return false;
    inp.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, p);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const okNav = await waitFor(() => (crumbsPath() === p ? true : null), 60);
    return !!okNav;
  };
  const tasksTerminal = async () => {
    const l = await inv('list_transfers', {});
    return l.length > 0 && l.every((t) => ['Succeeded', 'Failed', 'Cancelled'].includes(t.status)) ? l : null;
  };
  (async () => {
    try {
      await title('r33-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r33-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      await waitFor(async () => (cardBtn('r33-a', '.host-connect-btn') ? true : null), 40);
      if (!connect('r33-a')) return title('FAIL-connect-a');
      await trust();
      if (!await waitFor(async () => (await activeSess('r33-a'))?.state === 'Connected' ? true : null, 150)) return title('FAIL-conn-a');
      await sleep(400);
      // 打开文件面板 → 导航到 /tmp/r33dir（远端容器树）
      const stBtn = await waitFor(() => document.querySelector('.st-file') || null, 100);
      if (!stBtn) return title('FAIL-no-files-btn');
      stBtn.click();
      if (!await waitFor(() => document.querySelector('[data-testid="sftp-crumbs"]') || null, 60)) return title('FAIL-no-crumbs');
      await sleep(700);
      if (!await navTo('/tmp/r33dir')) return title('FAIL-nav:' + crumbsPath());
      if (!await waitFor(() => rowNames().includes('app.txt') ? true : null, 60)) return title('FAIL-no-rows:' + rowNames().join(','));
      // R33 新钮：上传（真实 NSOpenPanel 由驱动键序确认）
      const upBtn = await waitFor(() => document.querySelector('[data-testid="sftp-upload-btn"]') || null, 40);
      if (!upBtn || upBtn.disabled) return title('FAIL-no-upload-btn');
      upBtn.click();
      await markSync('r33a-pick-open');
      const picked = await waitFor(async () => {
        const l = await inv('list_transfers', {});
        return l.filter((t) => t.kind === 'Upload').length >= 3 ? l.filter((t) => t.kind === 'Upload') : null;
      }, 80);
      if (!picked) return title('FAIL-pick-no-upload（NSOpenPanel 未确认或未返回文件）');
      if (!picked.every((t) => t.dest.startsWith('/tmp/r33dir/'))) return title('FAIL-pick-dest:' + picked.map((t) => t.dest).join(','));
      const upDone = await waitFor(async () => (picked.every((t) => t.status === 'Succeeded') ? true : null), 100);
      if (!upDone) return title('FAIL-pick-upload-terminal:' + picked.map((t) => t.status).join(','));
      await markSync('r33a-pick-ok（原生选择器多选上传 ' + picked.length + ' 文件全部 Succeeded）');
      // 另存为：动作菜单 → NSSavePanel（驱动 GoTo /tmp/r33save + Return 确认）
      const row = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'app.txt');
      if (!row) return title('FAIL-no-app-row');
      row.querySelector('.sftp-name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const saveItem = await waitFor(() => document.querySelector('[data-testid="sftp-menu-saveas"]') || null, 40);
      if (!saveItem) return title('FAIL-no-saveas-item');
      saveItem.click();
      await markSync('r33a-save-open');
      const saveTask = await waitFor(async () => {
        const l = await inv('list_transfers', {});
        const t = l.find((x) => x.kind === 'Download' && x.source === '/tmp/r33dir/app.txt');
        return t && t.dest.startsWith('/tmp/r33save/') ? t : null;
      }, 80);
      if (!saveTask) return title('FAIL-saveas-no-card');
      const saveDone = await waitFor(async () => {
        const l = await inv('list_transfers', {});
        return l.find((x) => x.id === saveTask.id)?.status === 'Succeeded' ? true : null;
      }, 100);
      if (!saveDone) return title('FAIL-saveas-terminal:' + saveTask.status);
      // §356 目录记忆：blob transfers.download_dir = /tmp/r33save
      const ws = await inv('get_workspace', {});
      if (ws?.transfers?.download_dir !== '/tmp/r33save') return title('FAIL-dir-memory:' + JSON.stringify(ws?.transfers ?? null));
      await markSync('r33a-saveas-ok（另存为真落盘 ' + saveTask.dest + ' + 目录记忆）');
      // 普通下载 → 落上次下载目录（不再询问）
      const rowB = [...document.querySelectorAll('[data-testid="sftp-list"] .sftp-row')].find((r) => r.dataset.name === 'b.txt');
      if (!rowB) return title('FAIL-no-b-row');
      rowB.querySelector('.sftp-dl')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const dlTask = await waitFor(async () => {
        const l = await inv('list_transfers', {});
        const t = l.find((x) => x.kind === 'Download' && x.source === '/tmp/r33dir/b.txt');
        return t && t.dest.startsWith('/tmp/r33save/') ? t : null;
      }, 80);
      if (!dlTask) return title('FAIL-lastdir:' + JSON.stringify((await inv('list_transfers', {})).find((x) => x.kind === 'Download' && x.source === '/tmp/r33dir/b.txt')?.dest ?? null));
      const dlDone = await waitFor(async () => {
        const l = await inv('list_transfers', {});
        return l.find((x) => x.id === dlTask.id)?.status === 'Succeeded' ? true : null;
      }, 100);
      if (!dlDone) return title('FAIL-lastdir-terminal');
      await tasksTerminal();
      await markSync('r33a-lastdir-ok（普通下载落上次目录 ' + dlTask.dest + '）');
      await markSync('r33a-DONE');
      await title('r33-DONE');
      await sleep(120000);
    } catch (e) {
      await title('FAIL-exception:' + (e && e.kind ? e.kind + '|' + String(e.message).slice(0, 120) : String(e).slice(0, 140)));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

fn r26_smoke_script(run_id: &str) -> String {    let base = r#"(function() {
  if (window.__R26_INJECTED__) return;
  window.__R26_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const cardBtn = (name, sel) => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name));
    return card ? card.querySelector(sel) : null;
  };
  const connect = (name) => {
    const b = cardBtn(name, '.host-connect-btn');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  };
  const trust = async () => {
    await waitFor(() => (document.querySelector('.hk-mask')?.textContent.includes('首次连接确认') ? true : null), 60);
    [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')).click();
  };
  const activeSess = async (name) => (await inv('list_sessions', {})).find((x) => x.host_name === name);
  const rowsText = () => [...document.querySelectorAll('.term-session.active .xterm-rows')].map((r) => r.textContent).join('');
  const errBar = () => [...document.querySelectorAll('.notice-bar.err')].map((x) => x.textContent).join(' || ');
  const maxAttemptSeen = () => {
    const m = errBar().match(/第 (\d+)\/(\d+) 次/);
    return m ? Number(m[1]) : 0;
  };
  const typeChar = (ch) => document.querySelector('.term-session.active textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
  (async () => {
    try {
      await title('r26-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      await inv('upsert_host', { host: { id: null, name: 'r26-a', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      // r26-b：集成显式关（DC3.2 显式变体）——命令框 Fresh 指引面（R24-L5）
      await inv('upsert_host', { host: { id: null, name: 'r26-b', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8', shell_integration: false } });
      await waitFor(async () => (cardBtn('r26-a', '.host-connect-btn') ? true : null), 40);
      // ---- 建连 r26-a ----
      if (!connect('r26-a')) return title('FAIL-connect-a');
      await trust();
      const c1 = await waitFor(async () => (await activeSess('r26-a'))?.state === 'Connected' ? true : null, 150);
      if (!c1) return title('FAIL-conn-a');
      await sleep(400);
      await markSync('r26a-conns-ok');
      // ---- 周期1：容器停（驱动）→ 自动重连计数横幅 → 3 次耗尽 Disconnected ----
      await markSync('r26a-drop-wait1');
      await sleep(4000);
      const banner = await waitFor(() => (errBar().includes('自动重连中') ? errBar() : null), 80);
      if (!banner) return title('FAIL-no-auto-banner:' + errBar().slice(0, 120));
      let maxAtt = 0;
      for (let i = 0; i < 600; i++) {
        maxAtt = Math.max(maxAtt, maxAttemptSeen());
        if (i % 10 === 0) {
          const st = (await inv('list_sessions', {})).find((x) => x.host_name === 'r26-a')?.state ?? 'none';
          mark('r26a-tick|' + i + '|' + st + '|' + (document.querySelector('.dead-overlay') ? 'ovl' : '-') + '|' + errBar().slice(0, 60));
        }
        if (document.querySelector('.dead-overlay')) break;
        await sleep(100);
      }
      if (maxAtt < 1) return title('FAIL-no-attempt-count:' + errBar().slice(0, 120));
      if (!document.querySelector('.dead-overlay')) return title('FAIL-no-dead-overlay:' + maxAtt + '|' + errBar().slice(0, 100));
      const sess = await activeSess('r26-a');
      if (!sess || sess.state !== 'Disconnected') return title('FAIL-not-disc:' + (sess?.state ?? 'null'));
      await markSync('r26a-auto-reconn-max' + maxAtt);
      await markSync('r26a-exhaust-ok');
      // 键入拦截（命令框面——合成 keydown 可达应用级 handler；终端 onData 的
      // 拦截证据由 demo 探针真键盘承担）：命令不进死通道，connError 如实
      const cmdIn0 = document.querySelector('.panel-title input');
      cmdIn0.focus();
      document.execCommand('insertText', false, 'echo shouldnotrun');
      cmdIn0.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const ce = await waitFor(() => (document.querySelector('.conn-error')?.textContent ?? null), 30);
      if (!ce || !ce.includes('会话已断开') || !ce.includes('未发送')) return title('FAIL-input-not-intercepted:' + (ce ?? 'null').slice(0, 80));
      await markSync('r26a-inputblock-ok');
      // ---- 周期2：容器启（驱动）→ 手动重连 → Reconfirming 横幅 + 人类可键入 ----
      await markSync('r26a-start-wait');
      await sleep(4000);
      const reconnBtn = [...document.querySelectorAll('.dead-overlay button')].find((b) => b.textContent.includes('重连恢复'));
      if (!reconnBtn) return title('FAIL-no-reconn-btn');
      reconnBtn.click();
      const rc = await waitFor(() => ([...document.querySelectorAll('.notice-bar.warn')].map((x) => x.textContent).join('').includes('已重连；旧现场待核实') ? true : null), 200);
      if (!rc) return title('FAIL-no-reconfirm-banner');
      await markSync('r26a-reconfirm-ok');
      // 人类可继续操作（合成事件可达命令框；终端 onData 真键入证据由 demo 探针承担）
      const cmdIn1 = document.querySelector('.panel-title input');
      cmdIn1.focus();
      document.execCommand('insertText', false, 'echo post26ok');
      cmdIn1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const echoed = await waitFor(() => (rowsText().includes('post26ok') ? true : null), 60);
      if (!echoed) return title('FAIL-input-after-reconfirm:' + rowsText().slice(-80));
      await markSync('r26a-input-ok');
      // ---- r26-b 集成关主机：命令框 Shell 拒绝 + Fresh 指引（R24-L5）----
      if (!connect('r26-b')) return title('FAIL-connect-b');
      await trust();
      const c2 = await waitFor(async () => (await activeSess('r26-b'))?.state === 'Connected' ? true : null, 150);
      if (!c2) return title('FAIL-conn-b');
      await sleep(600);
      const cmdInput = document.querySelector('.panel-title input');
      if (!cmdInput) return title('FAIL-no-cmd-input');
      cmdInput.focus();
      document.execCommand('insertText', false, 'echo cmdbar26');
      cmdInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const guide = await waitFor(() => (rowsText().includes('shell 集成') && rowsText().includes('Fresh') ? true : null), 60);
      if (!guide) return title('FAIL-no-fresh-guide:' + rowsText().slice(-120));
      await markSync('r26a-cmdbar-ok');
      // ---- 周期3：容器再停（驱动）→ 首个计数出现即「停止重试」→ 提前 Disconnected ----
      await markSync('r26a-drop-wait2');
      await sleep(4000);
      const banner2 = await waitFor(() => (errBar().includes('自动重连中') ? true : null), 80);
      if (!banner2) return title('FAIL-no-auto-banner2:' + errBar().slice(0, 120));
      const stopBtn = [...document.querySelectorAll('.notice-bar.err button')].find((b) => b.textContent.includes('停止重试'));
      if (!stopBtn) return title('FAIL-no-stop-btn:' + errBar().slice(0, 120));
      stopBtn.click();
      const disc2 = await waitFor(async () => {
        const s = await activeSess('r26-a');
        return s && s.state === 'Disconnected' && document.querySelector('.dead-overlay') ? true : null;
      }, 130);
      if (!disc2) return title('FAIL-stop-no-disc');
      const attAtStop = maxAttemptSeen();
      if (attAtStop > 1) return title('FAIL-stop-late:' + attAtStop);
      await markSync('r26a-stop-ok');
      // ---- 周期4：断开标签直接关（§6.4 不询问无意义的断开确认）----
      const closeX = [...document.querySelectorAll('.tabbar .tab')].find((t) => t.textContent.includes('r26-a'))?.querySelector('.tab-x');
      if (!closeX) return title('FAIL-no-tab-close');
      closeX.click();
      await sleep(800);
      if (document.querySelector('.confirm-dialog')) return title('FAIL-asked-confirm-on-dead');
      const gone = await waitFor(async () => ((await activeSess('r26-a')) ? null : true), 30);
      if (!gone) return title('FAIL-tab-still-there');
      await markSync('r26a-closedisc-ok');
      await markSync('r26a-DONE');
      await title('r26-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}
/// 对共享 docker sshd 双主机验证 shell 集成治理与委托：
/// A) r24-on（shell_integration 显式 true）——UI 点卡真路径建连 → TOFU/密码 →
///    integration Ready（事件+list_sessions 双证）→ shell_capability 全真 →
///    exec_human（Shell 模式）成功；
/// B) r24-off（显式 false，DC3.2 新建默认关的显式变体）——建连 → integration
///    Disabled、无注入 → shell_capability host_setting=false → exec_human 拒绝
///    shell_integration_unavailable（available 载荷对账）；
/// C) delegate_session（Human）→ control_owner 翻 Agent + 审计 session_delegated；
/// D) B01：AUTOCONNECT local 会话 owner=Human + 审计 session_created.owner。
/// Fresh 模式放行路径无 tauri 面（exec_human 恒 Shell 模式）——由 core r24_tests
/// B12 覆盖，此处不主张。事件监听同 r19（transformCallback 内部通道，失败降级）。
fn r24_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R24_INJECTED__) return; // WKWebView Finished 双触发防护
  window.__R24_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const upsert = (name, si) => inv('upsert_host', { host: { id: null, name, address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8', shell_integration: si } });
  const connectViaCard = async (name) => {
    const card = await waitFor(() => [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes(name)) || null, 50);
    if (!card) return 'FAIL-no-card:' + name;
    card.querySelector('.host-card-main').click();
    let handled = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const tbtn = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接'));
      if (tbtn) { tbtn.click(); handled = true; continue; }
      const inp = document.querySelector('.hk-mask input');
      if (inp) {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(inp, 'testpass');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        const sub = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('提交验证'));
        if (sub) { sub.click(); handled = true; continue; }
      }
      if (!document.querySelector('.hk-mask') && handled) break;
    }
    const sess = await waitFor(async () => {
      const ss = await inv('list_sessions', {});
      return ss.find((x) => x.host_name === name && x.state === 'Connected') || null;
    }, 80);
    return sess || ('FAIL-not-connected:' + name);
  };
  (async () => {
    try {
      await title('r24-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // 事件监听（内部通道 best-effort）
      const evs = [];
      let evOn = false;
      try {
        if (typeof window.__TAURI_INTERNALS__.transformCallback === 'function') {
          const cb = window.__TAURI_INTERNALS__.transformCallback((e) => { if (e && e.payload) evs.push(e.payload); });
          await inv('plugin:event|listen', { event: 'shell-integration-event', target: { kind: 'Any' }, handler: cb });
          evOn = true;
          await markSync('r24-events-on');
        } else { await markSync('r24-events-na'); }
      } catch (e) { await markSync('r24-events-na:' + String(e).slice(0, 80)); }
      // 主机建档（显式 true/false 双变体）
      let hidOn, hidOff;
      try { hidOn = await upsert('r24-on', true); hidOff = await upsert('r24-off', false); }
      catch (e) { return title('FAIL-upsert:' + String(e).slice(0, 120)); }
      if (!hidOn || !hidOff) return title('FAIL-upsert-empty');
      await markSync('r24-hosts-ok');
      // A) r24-on 建连（UI 真路径：TOFU → 密码）
      const sOn = await connectViaCard('r24-on');
      if (typeof sOn === 'string' && sOn.startsWith('FAIL')) return title(sOn);
      // integration Ready（list_sessions 拉取面）
      const rOn = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        const row = ss.find((x) => x.id === sOn.id);
        return row && row.integration === 'Ready' ? row : null;
      }, 100);
      if (!rOn) {
        const ss = await inv('list_sessions', {});
        return title('FAIL-on-integration:' + JSON.stringify(ss.filter((x) => x.id === sOn.id)));
      }
      await markSync('r24-on-ready');
      // shell_capability（DC3.3）
      const capOn = await inv('shell_capability', { sid: sOn.id });
      if (!capOn.integration_present || !capOn.host_setting) return title('FAIL-on-cap:' + JSON.stringify(capOn));
      await markSync('r24-on-cap-ok');
      // exec_human（Shell 模式默认）在集成主机上成功
      try { await inv('exec_human', { sid: sOn.id, command: 'echo ok' }); }
      catch (e) { return title('FAIL-on-exec:' + String(e).slice(0, 140)); }
      await markSync('r24-on-exec-ok');
      // B) r24-off 建连（同 sshd 新主机行：TOFU 再走一次）
      const sOff = await connectViaCard('r24-off');
      if (typeof sOff === 'string' && sOff.startsWith('FAIL')) return title(sOff);
      const rOff = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        const row = ss.find((x) => x.id === sOff.id);
        return row && row.integration === 'Disabled' ? row : null;
      }, 60);
      if (!rOff) return title('FAIL-off-integration');
      const capOff = await inv('shell_capability', { sid: sOff.id });
      if (capOff.host_setting !== false) return title('FAIL-off-cap:' + JSON.stringify(capOff));
      await markSync('r24-off-disabled');
      // exec_human（Shell 模式）被拒：shell_integration_unavailable + available 载荷
      let denied = null;
      try { await inv('exec_human', { sid: sOff.id, command: 'echo nope' }); }
      catch (e) { denied = e; }
      if (!denied) return title('FAIL-off-exec-allowed');
      const dkind = (denied && denied.kind) || String(denied);
      if (dkind !== 'shell_integration_unavailable') return title('FAIL-off-exec-kind:' + dkind);
      const avail = (denied && denied.detail && denied.detail.available) || {};
      if (avail.host_setting !== false || avail.integration_present !== false) return title('FAIL-off-exec-payload:' + JSON.stringify(denied.detail));
      await markSync('r24-off-rejected');
      // C) 委派（DC2.2）：Human → Agent + 审计
      await inv('delegate_session', { sid: sOff.id, goal: 'r24-smoke-goal' });
      const dl = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        const row = ss.find((x) => x.id === sOff.id);
        return row && row.control_owner === 'Agent' ? row : null;
      }, 30);
      if (!dl) return title('FAIL-delegate-owner');
      const aud = await inv('audit_query', { sid: null, limit: 100 });
      const ev = (aud.events || []).find((x) => x.action === 'session_delegated');
      if (!ev) return title('FAIL-delegate-audit');
      await markSync('r24-delegate-ok');
      // D) B01：AUTOCONNECT local 会话 owner=Human（审计 session_created.owner）
      const cr = (aud.events || []).filter((x) => x.action === 'session_created');
      if (!cr.length || !cr.every((x) => x.payload_json && x.payload_json.owner === 'Human'))
        return title('FAIL-b01-owner:' + JSON.stringify(cr.map((x) => x.payload_json)));
      await markSync('r24-b01-ok');
      // 事件面：r24-on 收到 Ready（监听成功才断言）
      if (evOn) {
        const onEvs = evs.filter((x) => x.session_id === sOn.id).map((x) => x.state);
        await markSync('r24-events:' + onEvs.join(','));
        if (!onEvs.includes('Ready')) return title('FAIL-events:' + onEvs.join(','));
      }
      // 回收（invoke 级）
      await inv('close_session', { sid: sOn.id });
      await inv('close_session', { sid: sOff.id });
      await markSync('r24-DONE');
      await title('r24-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R19 C1 建连尝试探针注入脚本（TINYSSH_SMOKE_MODE=r19；dev 门控，产品路径无关）：
/// 对共享 docker sshd 走 begin_connection 尝试路径（invoke 级，UI 点卡仍是 v1
/// create_session——FE 接线归 R23/R26）：合并幂等（DC1.5）→ TOFU TrustRequired →
/// 信任（UI 真路径）→ Authenticating/ChallengeRequired → Ready 投递 → 迟到取消
/// NotFound（序列 4）→ local 快路径 → 不可达主机受理取消（序列 1/6：Cancelled 无
/// 遗留 + 二次 NotFound）。窗口竞态序列 2/3 依赖 create_session Ok→Ready 微窗，
/// 由 core-session c1_tests 钩子驱动覆盖，此处不主张。
/// 事件交付：经 __TAURI_INTERNALS__ 监听 connection-event（transformCallback 内部
/// 通道，与 @tauri-apps/api listen 同构）——注册失败如实降级 r19-events-na，
/// 不虚标 FAIL（推送面由 demo 探针覆盖，此为信息性增强证据）。
fn r19_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  if (window.__R19_INJECTED__) return; // WKWebView Finished 双触发防护
  window.__R19_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const markSync = async (s) => { try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)); } catch {} };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch {}
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  (async () => {
    try {
      await title('r19-open');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      // 主机（真路径建档）
      let hid;
      try {
        hid = await inv('upsert_host', { host: { id: null, name: 'r19-sshd', address: '127.0.0.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      } catch (e) { return title('FAIL-upsert:' + String(e).slice(0, 120)); }
      if (!hid) return title('FAIL-upsert-empty');
      await markSync('r19-host-ok');
      // 事件监听（内部通道 best-effort；失败降级不 FAIL——推送面 demo 覆盖）
      const evs = [];
      let evOn = false;
      try {
        if (typeof window.__TAURI_INTERNALS__.transformCallback === 'function') {
          const cb = window.__TAURI_INTERNALS__.transformCallback((e) => { if (e && e.payload) evs.push(e.payload); });
          await inv('plugin:event|listen', { event: 'connection-event', target: { kind: 'Any' }, handler: cb });
          evOn = true;
          await markSync('r19-events-on');
        } else { await markSync('r19-events-na'); }
      } catch (e) { await markSync('r19-events-na:' + String(e).slice(0, 80)); }
      const evPhases = (aid) => evs.filter((e) => e.attempt_id === aid).map((e) => e.phase);
      // A) 合并幂等（DC1.5）：同 (host, actor) 活跃 attempt 二次 begin 同 id
      const tabs0 = document.querySelectorAll('.tabbar .tab').length;
      let a1, a2;
      try {
        a1 = await inv('begin_connection', { hostId: hid, opts: {} });
        a2 = await inv('begin_connection', { hostId: hid, opts: {} });
      } catch (e) { return title('FAIL-begin:' + String(e).slice(0, 140)); }
      if (!a1 || !a1.attempt_id) return title('FAIL-begin-empty:' + JSON.stringify(a1).slice(0, 120));
      if (a2.attempt_id !== a1.attempt_id) return title('FAIL-merge:' + a1.attempt_id + '!=' + a2.attempt_id);
      await markSync('r19-merge-ok');
      // B) TOFU 门：尝试停在 TrustRequired（首连无指纹）
      const stTo = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return st.phase === 'TrustRequired' ? st : null;
      }, 60);
      if (!stTo) {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return title('FAIL-no-tofu:' + st.phase);
      }
      await markSync('r19-tofu-phase');
      // 信任（UI 真路径：TOFU 卡 → 信任并连接）
      const tbtn = await waitFor(() => [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('信任并连接')) || null, 60);
      if (!tbtn) return title('FAIL-no-tofu-card');
      tbtn.click();
      await markSync('r19-trust-ok');
      // 认证：Authenticating → ChallengeRequired（密码卡）→ 提交
      const stAu = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return st.phase === 'Authenticating' || st.phase === 'ChallengeRequired' ? st : null;
      }, 60);
      if (!stAu) {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return title('FAIL-no-auth:' + st.phase);
      }
      await markSync('r19-auth-phase:' + stAu.phase);
      const pwInput = await waitFor(() => document.querySelector('.hk-mask input') || null, 60);
      if (pwInput) {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(pwInput, 'testpass');
        pwInput.dispatchEvent(new Event('input', { bubbles: true }));
        const sub = [...document.querySelectorAll('.hk-mask button')].find((b) => b.textContent.includes('提交验证'));
        if (sub) sub.click();
      }
      // Ready 投递：终态携带 session_id；会话 Connected
      const fin = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return st.phase === 'Ready' ? st : (st.phase === 'Failed' || st.phase === 'Cancelled' ? st : null);
      }, 100);
      if (!fin || fin.phase !== 'Ready') {
        const st = await inv('connection_status', { attemptId: a1.attempt_id });
        return title('FAIL-no-ready:' + JSON.stringify(st).slice(0, 200));
      }
      const sid1 = fin.session_id;
      if (!sid1) return title('FAIL-ready-no-sid');
      const sess1 = await inv('list_sessions', {});
      const row1 = sess1.find((x) => x.id === sid1);
      if (!row1 || row1.state !== 'Connected') return title('FAIL-sess-state:' + JSON.stringify(row1 && row1.state));
      await markSync('r19-ready-ok');
      // 序列 4：Ready 后迟到取消 → NotFound 无副作用
      let late;
      try { late = await inv('cancel_connection', { attemptId: a1.attempt_id }); }
      catch (e) { return title('FAIL-late-exc:' + String(e).slice(0, 120)); }
      if (!late || late.outcome !== 'not_found') return title('FAIL-late:' + JSON.stringify(late));
      const sessLate = await inv('list_sessions', {});
      if (!sessLate.find((x) => x.id === sid1)) return title('FAIL-late-side-effect');
      await markSync('r19-late-cancel-ok');
      // 事件交付（注册成功才断言；相位集含门相位）
      if (evOn) {
        const ph = evPhases(a1.attempt_id);
        await markSync('r19-events:' + ph.join(','));
        if (!ph.includes('TrustRequired') || !ph.includes('Ready')) return title('FAIL-events:' + ph.join(','));
      }
      // C) local 快路径（无门）：begin → Ready；迟到取消 NotFound；回收
      let al;
      try { al = await inv('begin_connection', { hostId: 'local', opts: {} }); }
      catch (e) { return title('FAIL-local-begin:' + String(e).slice(0, 120)); }
      const fl = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: al.attempt_id });
        return st.phase === 'Ready' ? st : null;
      }, 60);
      if (!fl || !fl.session_id) return title('FAIL-local-ready:' + JSON.stringify(al).slice(0, 120) + '/' + JSON.stringify(fl && fl.phase));
      let latel;
      try { latel = await inv('cancel_connection', { attemptId: al.attempt_id }); }
      catch (e) { return title('FAIL-local-late-exc:' + String(e).slice(0, 120)); }
      if (!latel || latel.outcome !== 'not_found') return title('FAIL-local-late:' + JSON.stringify(latel));
      await inv('close_session', { sid: fl.session_id });
      await markSync('r19-local-ok');
      // D) 序列 1/6：不可达主机受理取消 → Cancelled 无会话遗留；二次 NotFound
      let hidH;
      try {
        hidH = await inv('upsert_host', { host: { id: null, name: 'r19-hang', address: '10.255.255.1', port: 2222, username: 'root', auth: { Password: { password: 'testpass' } }, tags: [], charset: 'utf-8' } });
      } catch (e) { return title('FAIL-hang-upsert:' + String(e).slice(0, 120)); }
      let ah;
      try { ah = await inv('begin_connection', { hostId: hidH, opts: {} }); }
      catch (e) { return title('FAIL-hang-begin:' + String(e).slice(0, 120)); }
      const stC = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: ah.attempt_id });
        return st.phase === 'Connecting' ? st : null;
      }, 30);
      if (!stC) {
        const st = await inv('connection_status', { attemptId: ah.attempt_id });
        return title('FAIL-hang-phase:' + st.phase);
      }
      let ch;
      try { ch = await inv('cancel_connection', { attemptId: ah.attempt_id }); }
      catch (e) { return title('FAIL-hang-cancel-exc:' + String(e).slice(0, 120)); }
      if (!ch || ch.outcome !== 'cancelled') return title('FAIL-hang-cancel:' + JSON.stringify(ch));
      const finC = await waitFor(async () => {
        const st = await inv('connection_status', { attemptId: ah.attempt_id });
        return st.phase === 'Cancelled' ? st : null;
      }, 100);
      if (!finC) return title('FAIL-hang-term');
      if (finC.session_id) return title('FAIL-hang-sid-left:' + finC.session_id);
      const sessH = await inv('list_sessions', {});
      if (sessH.find((x) => x.host_id === hidH)) return title('FAIL-hang-sess-left');
      let ch2;
      try { ch2 = await inv('cancel_connection', { attemptId: ah.attempt_id }); }
      catch (e) { return title('FAIL-hang-cancel2-exc:' + String(e).slice(0, 120)); }
      if (!ch2 || ch2.outcome !== 'not_found') return title('FAIL-hang-cancel2:' + JSON.stringify(ch2));
      await markSync('r19-cancel-connecting-ok');
      // 回收 B 会话（invoke 级；UI 确认流归 r14 既有证据）
      await inv('close_session', { sid: sid1 });
      const gone = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return !ss.find((x) => x.id === sid1) ? true : null;
      }, 40);
      if (!gone) return title('FAIL-close-r19-sshd');
      await markSync('r19-DONE');
      await title('r19-DONE');
    } catch (e) {
      await title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R15 C8 偏好/元数据探针注入脚本（TINYSSH_SMOKE_MODE=r15；dev 门控，产品路径无关）：
/// 三段 reload 驱动 blob 真实持久化（归一→260 收起断言→224 展开断言）→ 收藏/建连
/// 打点（AUTOCONNECT 真实会话）→ 最近连接 local 排除与上限 → 字号命名空间键 →
/// schemaVersion 核心归一。inv 直调 wire 命令与 UI 同一条 Human 通道。
fn r15_smoke_script(run_id: &str) -> String {
    // epoch 必须进程内稳定：本函数每次注入都会调用，SystemTime 直取会逐载漂移，
    // 导致脚本每次都判「新 run」清掉阶段标记、无限 reload（r15b 实证）
    static EPOCH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let epoch = EPOCH.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
            .to_string()
    });
    let base = r#"(function() {
  if (window.__R15_INJECTED__) return; // WKWebView Finished 双触发防护：每页至多一个执行体
  window.__R15_INJECTED__ = true;
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = async (s) => {
    document.title = 'SMOKE|' + s;
    try { await fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)); } catch { /* 信标瞬断不阻断断言链 */ }
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const WS = (open, width) => ({ schema_version: 1, chrome: 'dark', hostbar: { open, width } });
  (async () => {
    try {
      // 单调步进：step 只增不清——存在性标记会被后段移除、令前段重新获准
      // （r15g 实证：seg2 移除 s2 后 seg1 于第 4 载重跑、260 收起复写）；
      // epoch 失配（换 run / 陈旧残留）时归零重走
      let step = Number.parseInt(localStorage.getItem('ui.r15step') ?? '', 10) || 0;
      if (localStorage.getItem('ui.r15epoch') !== '__EPOCH__') {
        step = 0;
        localStorage.setItem('ui.r15epoch', '__EPOCH__');
      }
      const setStep = (n) => localStorage.setItem('ui.r15step', String(n));
      // 段 0：blob 归一（事实源经 wire 写入 vault）
      if (step === 0) {
        await title('r15-normalize');
        await inv('set_workspace', { ws: WS(true, 224) });
        setStep(1);
        location.reload();
        return;
      }
      // 段 1：blob 持久化生效（224 展开）→ 写 260 收起，reload 进段 2
      if (step === 1) {
        await title('r15-s1');
        const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
        if (!cards) return title('FAIL-no-cards');
        const ws = await inv('get_workspace', {});
        if (!ws || ws.schema_version !== 1) return title('FAIL-ws-version:' + JSON.stringify(ws));
        if (!ws.hostbar || ws.hostbar.open !== true || ws.hostbar.width !== 224)
          return title('FAIL-ws-normalize:' + JSON.stringify(ws.hostbar));
        if (!document.querySelector('.hostbar')) return title('FAIL-hostbar-open');
        const markSync = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
        await markSync(RUN + '|r15-pre|' + JSON.stringify(WS(false, 260)));
        try {
          const back = await inv('set_workspace', { ws: WS(false, 260) });
          await markSync(RUN + '|r15-post|' + JSON.stringify(back && back.hostbar));
        } catch (e) {
          await markSync(RUN + '|r15-inverr|' + String(e).slice(0, 200));
          return title('FAIL-invoke');
        }
        setStep(2);
        location.reload();
        return;
      }
      // 段 2：收起态持久化生效 → 写回 224 展开，reload 进段 3
      if (step === 2) {
        await title('r15-s2');
        if (document.querySelector('.hostbar')) return title('FAIL-hostbar-collapsed');
        const ws = await inv('get_workspace', {});
        await mark(RUN + '|r15-seg2read|' + JSON.stringify(ws && ws.hostbar));
        if (!ws.hostbar || ws.hostbar.open !== false || ws.hostbar.width !== 260)
          return title('FAIL-ws-260:' + JSON.stringify(ws.hostbar));
        await inv('set_workspace', { ws: WS(true, 224) });
        setStep(3);
        location.reload();
        return;
      }
      await title('r15-s3');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards2');
      const tabN = await waitFor(() => document.querySelectorAll('.tabbar .tab').length || null, 100);
      if (!tabN) return title('FAIL-no-tab');
      document.querySelector('.tabbar .tab').click();
      if (!(await waitFor(() => document.querySelector('.session-toolbar'), 100))) return title('FAIL-toolbar-missing');
      if (!document.querySelector('.hostbar')) return title('FAIL-hostbar-reopen');
      await mark(RUN + '|r15-blob-ok');
      // 收藏 + 建连打点（AUTOCONNECT 已真实 create_session → last_connected_at）
      const hosts = await inv('list_hosts', {});
      const localHost = (hosts || []).find((h) => h.id === 'local');
      if (!localHost) return title('FAIL-no-local-host');
      await inv('set_host_favorite', { hostId: 'local', favorite: true });
      const meta = await inv('list_host_metadata', {});
      const localMeta = (meta || []).find((m) => m.host_id === 'local');
      if (!localMeta || localMeta.favorite !== true) return title('FAIL-favorite:' + JSON.stringify(localMeta));
      // AUTOCONNECT（dev 钩子）在第 4 次加载后晚至，打点轮询等待而非硬断言（r15h 实证竞态）
      const touched = await waitFor(async () => {
        const m = (await inv('list_host_metadata', {})).find((x) => x.host_id === 'local');
        return m && m.last_connected_at ? m : null;
      }, 50);
      if (!touched) return title('FAIL-touch:' + JSON.stringify(localMeta));
      // 未知主机收藏 → invalid_input（Tauri v2 拒约载荷为结构化 {kind,message,detail}）
      let unknownRejected = false;
      try { await inv('set_host_favorite', { hostId: 'h-none', favorite: true }); }
      catch (e) {
        const k = e && e.kind ? String(e.kind) : String(e);
        unknownRejected = k.includes('invalid_input') || k.includes('not found');
      }
      if (!unknownRejected) return title('FAIL-fav-unknown');
      await mark(RUN + '|r15-fav-ok');
      // 最近连接（DF8.5）：local 恒排除、上限 5、主机名非空
      const recents = await inv('list_recent_hosts', {});
      if (!Array.isArray(recents)) return title('FAIL-recents-type');
      if (recents.length > 5) return title('FAIL-recents-cap:' + recents.length);
      if (recents.some((r) => r.host_id === 'local')) return title('FAIL-recents-local:' + JSON.stringify(recents));
      if (recents.some((r) => !r.host_name || !r.connected_at)) return title('FAIL-recents-shape');
      await mark(RUN + '|r15-recents-ok|n=' + recents.length);
      // 字号命名空间键（V5 迁移目标）
      await inv('set_setting', { key: 'ui.v2.terminal.font_size', value: '14' });
      const f = await inv('get_setting', { key: 'ui.v2.terminal.font_size' });
      if (f !== '14') return title('FAIL-font-key:' + f);
      // schemaVersion 归一（客户端伪造 99 → 核心落 1）
      const wsBad = await inv('set_workspace', { ws: { schema_version: 99, chrome: 'dark', hostbar: { open: true, width: 224 } } });
      if (!wsBad || wsBad.schema_version !== 1) return title('FAIL-ws-normalize99:' + JSON.stringify(wsBad));
      title('r15-DONE');
    } catch (e) {
      title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id).replace("__EPOCH__", &epoch.to_string())
}

/// R13 统一 action 分发探针注入脚本（TINYSSH_SMOKE_MODE=r13；dev 门控，产品路径无关）：
/// 单一分发语义（⌘1/⌘2/⌘⇧[]/⌘W 各恰一次执行）→ Esc 链 + 焦点回终端 → 模态层吞 ⌘ →
/// IME 组合期不触发 → 表单焦点 ⌘B 不劫持 → 标签 120–220 → 原生菜单事件（Rust 侧
/// 轮询信标 armed 后 emit menu-settings）→ 统一分发开设置面板。合成键盘事件走
/// window 捕获层，与 r12 同口径（真实 CGEvent 注入受 P2 键注入冻结协议约束，不在此列）。
fn r13_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = (s) => {
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {});
  };
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const key = (init) => document.body.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true }, init)));
  const activeIs = (i) => {
    const els = document.querySelectorAll('.tabbar .tab');
    return !!(els[i] && els[i].classList.contains('tab-active'));
  };
  const rowH = () => {
    const r = document.querySelector('.xterm-rows > div');
    return r ? Math.round(parseFloat(getComputedStyle(r).height)) : null;
  };
  const searchVisible = () => {
    const s = document.querySelector('.term-search');
    return !!(s && getComputedStyle(s).display !== 'none');
  };
  (async () => {
    try {
      // localStorage 归一（rev-r12 LOW-5 同款）
      if (!localStorage.getItem('ui.r13fresh')) {
        try {
          localStorage.setItem('ui.hostbar', '1');
          localStorage.setItem('ui.hostbar_w', '224');
          localStorage.setItem('ui.r13fresh', '1');
        } catch (e) {}
        location.reload();
        return;
      }
      try { localStorage.removeItem('ui.r13fresh'); } catch (e) {}
      title('r13-opening');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      const tabN = await waitFor(() => document.querySelectorAll('.tabbar .tab').length || null, 100);
      if (!tabN) return title('FAIL-no-tab');
      document.querySelector('.tabbar .tab').click();
      if (!(await waitFor(() => document.querySelector('.session-toolbar'), 100))) return title('FAIL-toolbar-missing');
      // 第二会话（本机）：两个标签供 ⌘1/⌘2/⌘⇧[]/⌘W 测
      const local = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('本机'));
      if (!local) return title('FAIL-no-local');
      local.querySelector('.host-connect-btn').click();
      if (!(await waitFor(() => document.querySelectorAll('.tabbar .tab').length === 2 || null, 100))) return title('FAIL-second-tab');
      // §320 标签宽界
      const ws = [...document.querySelectorAll('.tabbar .tab')].map((e) => Math.round(e.getBoundingClientRect().width));
      if (!ws.every((w) => w >= 120 && w <= 220)) return title('FAIL-tabwidth:' + ws.join(','));
      mark(RUN + '|r13-tabwidth|' + ws.join(','));
      // ⌘1 / ⌘2 精确切签（单一分发：激活态唯一）
      key({ key: '1', metaKey: true });
      await sleep(350);
      if (!activeIs(0)) return title('FAIL-cmd1');
      key({ key: '2', metaKey: true });
      await sleep(350);
      if (!activeIs(1)) return title('FAIL-cmd2');
      // ⌘⇧] 循环下一根（idx1 → 环绕 idx0）；⌘⇧[ 回 idx1
      key({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
      await sleep(350);
      if (!activeIs(0)) return title('FAIL-cycle-r');
      key({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
      await sleep(350);
      if (!activeIs(1)) return title('FAIL-cycle-l');
      mark(RUN + '|r13-tabs-ok');
      // ⌘W → 危险确认弹窗；Esc 关确认保会话；再 ⌘W → 确认断开 → 单标签
      key({ key: 'w', metaKey: true });
      await sleep(350);
      const dlg = document.querySelector('.confirm-dialog');
      if (!dlg || dlg.textContent.indexOf('断开') < 0) return title('FAIL-cmdw-confirm');
      key({ key: 'Escape' });
      await sleep(350);
      if (document.querySelector('.confirm-dialog')) return title('FAIL-esc-confirm');
      if (document.querySelectorAll('.tabbar .tab').length !== 2) return title('FAIL-esc-kept-tabs');
      key({ key: 'w', metaKey: true });
      await sleep(350);
      const dlg2 = document.querySelector('.confirm-dialog');
      if (!dlg2) return title('FAIL-cmdw-confirm2');
      [...dlg2.querySelectorAll('button')].find((b) => b.textContent.includes('断开连接')).click();
      if (!(await waitFor(() => document.querySelectorAll('.tabbar .tab').length === 1 || null, 100))) return title('FAIL-cmdw-close');
      mark(RUN + '|r13-cmdw-ok');
      // ⌘= 步进恰好 +1（双执行即 +2）；⌘0 复位
      const h0 = rowH();
      key({ key: '=', metaKey: true });
      await sleep(300);
      const h1 = rowH();
      if (h1 === null || h0 === null || h1 - h0 !== 1) return title('FAIL-fontstep:' + h0 + '->' + h1);
      key({ key: '0', metaKey: true });
      await sleep(300);
      if (rowH() !== h0) return title('FAIL-fontreset');
      // ⌘F → 搜索开 + 焦点入搜索框；Esc → 关 + 焦点回终端
      key({ key: 'f', metaKey: true });
      await sleep(300);
      if (!searchVisible()) return title('FAIL-cmdf');
      key({ key: 'Escape' });
      await sleep(300);
      if (searchVisible()) return title('FAIL-esc-search');
      const ae = document.activeElement || {};
      if (!ae.classList || !ae.classList.contains('xterm-helper-textarea')) return title('FAIL-focus-back');
      mark(RUN + '|r13-cmdf-ok');
      // 模态层：确认弹窗吞 ⌘F/⌘=，Esc 关确认
      const toolsBtn = document.querySelector('.session-toolbar .st-tools > button');
      if (!toolsBtn) return title('FAIL-no-toolsbtn');
      toolsBtn.click();
      await sleep(250);
      const closeItem = [...document.querySelectorAll('.tools-menu [role="menuitem"]')].find((i) => i.textContent.includes('关闭会话'));
      if (!closeItem) return title('FAIL-no-closeitem');
      closeItem.click();
      await sleep(350);
      if (!document.querySelector('.confirm-dialog')) return title('FAIL-modal-open');
      key({ key: 'f', metaKey: true });
      await sleep(300);
      if (searchVisible()) return title('FAIL-modal-cmdf');
      key({ key: 'Escape' });
      await sleep(350);
      if (document.querySelector('.confirm-dialog')) return title('FAIL-modal-esc');
      mark(RUN + '|r13-modal-ok');
      // IME 组合期：isComposing / keyCode 229 都不触发
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, isComposing: true, bubbles: true }));
      await sleep(300);
      if (searchVisible()) return title('FAIL-ime-composing');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, keyCode: 229, bubbles: true }));
      await sleep(300);
      if (searchVisible()) return title('FAIL-ime-229');
      // 表单焦点 ⌘B 不劫持（§7.4）
      const hbInput = document.querySelector('.hb-search input');
      if (hbInput) {
        hbInput.focus();
        key({ key: 'b', metaKey: true });
        await sleep(300);
        if (!document.querySelector('.hostbar')) return title('FAIL-inform-cmdb');
        hbInput.blur();
      }
      mark(RUN + '|r13-input-ok');
      // 原生菜单事件（Rust 侧 T+15s emit menu-settings）→ 统一分发开设置面板
      mark(RUN + '|r13-armed-menu');
      const opened = await waitFor(() => document.querySelector('.term-settings'), 300);
      if (!opened) return title('FAIL-menu-settings');
      key({ key: 'Escape' });
      await sleep(300);
      if (document.querySelector('.term-settings')) return title('FAIL-settings-esc');
      title('r13-DONE');
    } catch (e) {
      title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R12 AppShell 探针注入脚本（TINYSSH_SMOKE_MODE=r12；dev 门控，产品路径无关）：
/// 几何断言（标题区 44/主机栏 224/标签 40/会话工具栏 40/状态条 24/拖拽区/红绿灯安全区）→
/// ⌘B 收起展开 → 第二会话与标签切换 → 标签列表菜单 → 文件面板开合 → 工具菜单关闭会话（确认流）。
fn r12_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = (s) => {
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {});
  };
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  };
  const geo = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  (async () => {
    try {
      // WKWebView localStorage 跨启动持久：上轮收起/改宽的残留会污染本轮几何断言
      //（rev-r12 LOW-5）——先归一默认值再重载一次，第二轮才跑正式断言。
      if (!localStorage.getItem('ui.r12fresh')) {
        try {
          localStorage.setItem('ui.hostbar', '1');
          localStorage.setItem('ui.hostbar_w', '224');
          localStorage.setItem('ui.r12fresh', '1');
        } catch (e) {}
        location.reload();
        return;
      }
      try { localStorage.removeItem('ui.r12fresh'); } catch (e) {}
      title('r12-opening');
      const cards = await waitFor(() => document.querySelectorAll('.host-card').length || null, 100);
      if (!cards) return title('FAIL-no-cards');
      const tabN = await waitFor(() => document.querySelectorAll('.tabbar .tab').length || null, 100);
      if (!tabN) return title('FAIL-no-tab');
      // 几何断言（§4.2）：44 / 224 / 40 / 40 / 24。AUTOCONNECT 只建会话不 attach，
      // 工具栏随 sid 附着渲染——先点第一个标签 attach 再等工具栏。
      document.querySelector('.tabbar .tab').click();
      const stEl = await waitFor(() => document.querySelector('.session-toolbar'), 100);
      if (!stEl) return title('FAIL-toolbar-missing');
      const tb = geo('.titlebar'); const hb = geo('.hostbar'); const sb = geo('.statusbar');
      const tbr = geo('.tabbar-row'); const st = geo('.session-toolbar');
      mark(RUN + '|r12-geo|tb=' + JSON.stringify(tb) + ',hb=' + JSON.stringify(hb) + ',sb=' + JSON.stringify(sb)
        + ',tbr=' + JSON.stringify(tbr) + ',st=' + JSON.stringify(st));
      if (!tb || Math.abs(tb.h - 44) > 1) return title('FAIL-titlebar:' + JSON.stringify(tb));
      if (!hb || Math.abs(hb.w - 224) > 2) return title('FAIL-hostbar:' + JSON.stringify(hb));
      if (!tbr || Math.abs(tbr.h - 40) > 1) return title('FAIL-tabbar:' + JSON.stringify(tbr));
      if (!st || Math.abs(st.h - 40) > 1) return title('FAIL-toolbar:' + JSON.stringify(st));
      if (!sb || Math.abs(sb.h - 24) > 1) return title('FAIL-statusbar:' + JSON.stringify(sb));
      if (!document.querySelector('.titlebar[data-tauri-drag-region]')) return title('FAIL-drag');
      if (!document.querySelector('.hb-grip')) return title('FAIL-grip');
      // 红绿灯安全区（macOS Overlay）：native-chrome 类 + 标题区左内边距 84
      if (!document.documentElement.classList.contains('native-chrome')) return title('FAIL-chrome');
      const pl = getComputedStyle(document.querySelector('.titlebar')).paddingLeft;
      if (pl !== '84px') return title('FAIL-safezone:' + pl);
      title('r12-geo-ok');
      // 状态条短状态：本地 · UTF-8
      const sbt = (document.querySelector('.sb-left') || {}).textContent || '';
      if (sbt.indexOf('本地') < 0 || sbt.indexOf('UTF-8') < 0) return title('FAIL-sbtext:' + sbt.trim());
      title('r12-sb-ok');
      // ⌘B 收起 / 展开主机栏
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }));
      await sleep(350);
      if (document.querySelector('.hostbar')) return title('FAIL-collapse');
      if (!document.querySelector('.hb-expand')) return title('FAIL-expandbtn');
      title('r12-collapse-ok');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }));
      await sleep(350);
      if (!document.querySelector('.hostbar')) return title('FAIL-reopen');
      title('r12-reopen-ok');
      // 第二个会话：主机卡「连接」钮强制新建
      const local = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('本机'));
      if (!local) return title('FAIL-no-local');
      const conn = local.querySelector('.host-connect-btn');
      if (!conn) return title('FAIL-no-connbtn');
      conn.click();
      const two = await waitFor(() => document.querySelectorAll('.tabbar .tab').length === 2 || null, 100);
      if (!two) return title('FAIL-second-tab');
      title('r12-second-tab-ok');
      // 标签切换：激活态跟随
      const activeIs = async (i) => {
        const els = document.querySelectorAll('.tabbar .tab');
        return els[i] && els[i].classList.contains('tab-active');
      };
      document.querySelectorAll('.tabbar .tab')[0].click();
      await sleep(300);
      if (!(await activeIs(0))) return title('FAIL-switch-0');
      document.querySelectorAll('.tabbar .tab')[1].click();
      await sleep(300);
      if (!(await activeIs(1))) return title('FAIL-switch-1');
      title('r12-tabswitch-ok');
      // 标签列表菜单：两行会话
      const allBtn = document.querySelector('.tab-all');
      if (!allBtn) return title('FAIL-no-allbtn');
      allBtn.click();
      await sleep(250);
      const rows = document.querySelectorAll('.tools-menu .tm-row').length;
      if (rows !== 2) return title('FAIL-tabsmenu:' + rows);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep(200);
      title('r12-tabsmenu-ok');
      // 会话工具栏「文件」：面板开 → 关
      const fileBtn = [...document.querySelectorAll('.session-toolbar button')].find((b) => b.textContent.includes('文件'));
      if (!fileBtn) return title('FAIL-no-filebtn');
      fileBtn.click();
      await sleep(600);
      const tp = document.querySelector('.task-panel');
      if (!tp || !(await waitFor(() => tp.querySelector('.sftp-list, .side-quiet'), 50))) return title('FAIL-filespanel');
      title('r12-files-ok');
      tp.querySelector('.tp-head button[aria-label="关闭任务面板"]').click();
      await sleep(250);
      if (document.querySelector('.task-panel')) return title('FAIL-panelclose');
      // 工具菜单：三项 → 关闭会话… → 确认断开 → 回到单标签
      const toolsBtn = document.querySelector('.session-toolbar .st-tools > button');
      if (!toolsBtn) return title('FAIL-no-toolsbtn');
      toolsBtn.click();
      await sleep(250);
      const items = [...document.querySelectorAll('.tools-menu [role="menuitem"]')];
      if (items.length !== 3) return title('FAIL-toolsmenu:' + items.length);
      const closeItem = items.find((i) => i.textContent.includes('关闭会话'));
      if (!closeItem) return title('FAIL-no-closeitem');
      closeItem.click();
      await sleep(350);
      const dlg = document.querySelector('.confirm-dialog');
      if (!dlg || dlg.textContent.indexOf('断开') < 0) return title('FAIL-confirm');
      [...dlg.querySelectorAll('button')].find((b) => b.textContent.includes('断开连接')).click();
      const back = await waitFor(() => document.querySelectorAll('.tabbar .tab').length === 1 || null, 100);
      if (!back) return title('FAIL-close-tab');
      title('r12-DONE');
    } catch (e) {
      title('FAIL-exception:' + String(e).slice(0, 140));
    }
  })();
})();
"#;
    base.replace("__RUN__", run_id)
}

/// R11 B11 探针注入脚本（TINYSSH_SMOKE_MODE=r11；dev 门控，产品路径无关）：
/// 会话 attach → 订阅计数 → 3000 行高频输出全缓冲对账（无丢字/重复/零 resync）→
/// resync 接口形状 + 过期订阅拒绝 → alt_screen 检查点导出 → 显式退订归零 + 幂等。
fn r11_smoke_script(run_id: &str) -> String {
    let base = r#"(function() {
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {});
  const RUN = '__RUN__';
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {});
  const title = (s) => {
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {});
  };
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const waitFor = async (fn, tries) => {
    for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch (e) {} await sleep(100); }
    return null;
  };
  const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
  (async () => {
    try {
      title('r11-opening');
      const ses = await waitFor(async () => {
        const ss = await inv('list_sessions', {});
        return (ss || []).find((s) => s.state === 'Connected');
      }, 150);
      if (!ses) { title('FAIL-no-session'); return; }
      const sid = ses.id;
      title('r11-session|' + sid);
      const row = await waitFor(async () => document.querySelector('.card.row div[title]'), 50);
      if (!row) { title('FAIL-no-row'); return; }
      row.click();
      const term = await waitFor(async () => (window.__t_terms && window.__t_terms.get(sid)) || null, 100);
      if (!term) { title('FAIL-no-term'); return; }
      await sleep(800);
      title('r11-attached');
      const dbg = await inv('debug_subscriptions', {});
      const mine = (dbg.per_session || []).find((p) => p.session_id === sid);
      mark('r11-subs|active=' + dbg.active_count + '|mine=' + (mine ? mine.subscription_ids.length : 0));
      if (!mine || mine.subscription_ids.length !== 1) { title('FAIL-subs|' + JSON.stringify(dbg).slice(0, 160)); return; }
      const sub = mine.subscription_ids[0];
      let resyncCount = 0;
      window.addEventListener('resync', () => { resyncCount += 1; });
      mark('r11-flood-begin');
      await inv('send_keys', { sid, keys: "printf 'B11-BEGIN\\n'; seq 1 3000; printf 'B11-END\\n'\r" });
      const bufText = () => {
        const b = term.buffer.active;
        let out = '';
        for (let i = 0; i < b.length; i++) { out += (b.getLine(i) ? b.getLine(i).translateToString(true) : '') + '\n'; }
        return out;
      };
      let ok = false;
      for (let i = 0; i < 100; i++) { if (bufText().includes('B11-END')) { ok = true; break; } await sleep(100); }
      if (!ok) { title('FAIL-flood-timeout'); return; }
      await sleep(500);
      const bt = bufText();
      // 整行匹配：PTY 会回显命令行本身（内含标记子串），substring 计数会双计
      const standalone = (s) => bt.split('\n').filter((l) => l.trim() === s).length;
      const beginN = standalone('B11-BEGIN');
      const endN = standalone('B11-END');
      const numLines = bt.split('\n').filter((l) => /^\s*(\d+)\s*$/.test(l)).map((l) => parseInt(l, 10));
      const uniq = new Set(numLines);
      let missing = 0;
      for (let i = 1; i <= 3000; i++) { if (!uniq.has(i)) missing++; }
      const dup = numLines.length - uniq.size;
      mark('r11-flood|begin=' + beginN + '|end=' + endN + '|missing=' + missing + '|dup=' + dup + '|resync=' + resyncCount);
      if (beginN !== 1 || endN !== 1 || missing !== 0 || dup !== 0 || resyncCount !== 0) {
        title('FAIL-flood|' + beginN + ',' + endN + ',' + missing + ',' + dup + ',' + resyncCount);
        return;
      }
      title('r11-flood-ok');
      let expiredRejected = false;
      try { await inv('resync_output', { sid, subscriptionId: 'sub-bogus', fromSeq: 1 }); } catch (e) { expiredRejected = true; }
      if (!expiredRejected) { title('FAIL-expired-accepted'); return; }
      const rs = await inv('resync_output', { sid, subscriptionId: sub, fromSeq: null });
      if (!rs || !rs.kind || (rs.kind !== 'checkpointed' && rs.kind !== 'replayed')) {
        title('FAIL-resync-shape|' + JSON.stringify(rs).slice(0, 120));
        return;
      }
      mark('r11-resync|kind=' + rs.kind + '|end=' + rs.end_seq);
      title('r11-resync-ok');
      await inv('send_keys', { sid, keys: "printf '\\033[?1049h\\033[HALT-MARK-7Q'\r" });
      await sleep(700);
      const rs2 = await inv('resync_output', { sid, subscriptionId: sub, fromSeq: null });
      const ab = rs2 && rs2.checkpoint ? rs2.checkpoint.active_buffer : -1;
      const altText = rs2 && rs2.checkpoint ? JSON.stringify(rs2.checkpoint.buffers[1]) : '';
      mark('r11-alt|buffer=' + ab + '|has=' + altText.includes('ALT-MARK-7Q'));
      if (ab !== 1 || !altText.includes('ALT-MARK-7Q')) { title('FAIL-alt|' + ab); return; }
      await inv('send_keys', { sid, keys: "printf '\\033[?1049l'\r" });
      await sleep(300);
      title('r11-alt-ok');
      await inv('unsubscribe_output', { sid, subscriptionId: sub });
      const dbg2 = await inv('debug_subscriptions', {});
      const mine2 = (dbg2.per_session || []).find((p) => p.session_id === sid);
      const left = mine2 ? mine2.subscription_ids.length : 0;
      mark('r11-unsub|left=' + left + '|active=' + dbg2.active_count);
      if (left !== 0) { title('FAIL-unsub|' + left); return; }
      await inv('unsubscribe_output', { sid, subscriptionId: sub });
      title('r11-DONE');
    } catch (e) {
      title('FAIL|' + e);
    }
  })();
})();"#
    .replace("__RUN__", run_id);
    base
}

fn dirs_or_home() -> std::path::PathBuf {
    std::env::var("HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from("."))
}


#[cfg(test)]
mod wire_error_tests {
    use super::WireError;
    use session_api::Error as E;

    /// R10 验收「wire 枚举一致」：session-api::Error 全变体 → kind 稳定映射。
    /// 新增变体漏配时 match 非穷尽即编译失败；本测试钉住 kind 字符串契约值。
    #[test]
    fn every_variant_maps_to_stable_kind() {
        let e = E::Io("x".into());
        assert_eq!(WireError::from(e).kind, "io");
        assert_eq!(WireError::from(E::Storage("s".into())).kind, "storage");
        assert_eq!(WireError::from(E::InvalidInput("i".into())).kind, "invalid_input");
        assert_eq!(WireError::from(E::InvalidActor).kind, "invalid_actor");
        let qb = WireError::from(E::QueueBusy { position: 3 });
        assert_eq!(qb.kind, "queue_busy");
        assert_eq!(qb.detail.as_ref().unwrap()["position"], 3);
        assert_eq!(WireError::from(E::Cancelled).kind, "cancelled");
        assert_eq!(WireError::from(E::ExecTimeout).kind, "exec_timeout");
        assert_eq!(WireError::from(E::HostKeyRejected("fp".into())).kind, "host_key_rejected");
        let cf = WireError::from(E::ConnectFailed("refused".into()));
        assert_eq!(cf.kind, "connect_failed");
        assert_eq!(cf.detail.as_ref().unwrap()["reason"], "refused");
        assert_eq!(WireError::from(E::AuthFailed).kind, "auth_failed");
        assert_eq!(WireError::from(E::SessionClosed).kind, "session_closed");
        assert_eq!(WireError::from(E::SessionNotFound).kind, "session_not_found");
        assert_eq!(WireError::from(E::ReconfirmingPending).kind, "reconfirming_pending");
        assert_eq!(WireError::from(E::ControlTakenByHuman).kind, "control_taken_by_human");
        assert_eq!(WireError::from(E::VoidedByHandback {
            brief: Box::new(session_api::SessionBrief {
                cwd: None, env_summary: String::new(), facts: Vec::new(),
                running: Vec::new(), pending_approvals: Vec::new(),
                screen_summary: String::new(), goal: None,
            }),
        }).kind, "voided_by_handback");
        assert_eq!(WireError::from(E::ApprovalDenied {
            reason: session_api::DeniedReason::Denied,
        }).kind, "approval_denied");
        // 人话文案保留（friendlyError 依赖 message）
        let m = WireError::from(E::AuthFailed).message;
        assert!(!m.is_empty());
        // 壳层直造错误走 invalid_input / io
        assert_eq!(WireError::from("bad".to_string()).kind, "invalid_input");
        assert_eq!(WireError::from(std::io::Error::other("no")).kind, "io");
        // serde 序列化形态：{kind, message[, detail]}
        let v = serde_json::to_value(WireError::from(E::AuthFailed)).unwrap();
        assert_eq!(v["kind"], "auth_failed");
        assert!(v.get("detail").is_none());
    }
}
