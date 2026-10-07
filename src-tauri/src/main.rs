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
        use session_api::Error as E;
        let (kind, detail): (&str, Option<serde_json::Value>) = match &e {
            E::ApprovalDenied { reason } => (
                "approval_denied",
                Some(serde_json::json!({ "reason": reason })),
            ),
            E::ControlTakenByHuman => ("control_taken_by_human", None),
            E::VoidedByHandback { .. } => ("voided_by_handback", None),
            E::ReconfirmingPending => ("reconfirming_pending", None),
            E::SessionNotFound => ("session_not_found", None),
            E::SessionClosed => ("session_closed", None),
            E::AuthFailed => ("auth_failed", None),
            E::ConnectFailed(r) => ("connect_failed", Some(serde_json::json!({ "reason": r }))),
            E::HostKeyRejected(_) => ("host_key_rejected", None),
            E::ExecTimeout => ("exec_timeout", None),
            E::Cancelled => ("cancelled", None),
            E::QueueBusy { position } => {
                ("queue_busy", Some(serde_json::json!({ "position": position })))
            }
            E::InvalidActor => ("invalid_actor", None),
            E::InvalidInput(_) => ("invalid_input", None),
            E::IdentityInUse { host_names } => (
                "identity_in_use",
                Some(serde_json::json!({ "host_names": host_names })),
            ),
            E::Storage(_) => ("storage", None),
            E::Io(_) => ("io", None),
        };
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
) -> CmdResult<Vec<SshImportOutcome>> {
    Ok(state
        .api
        .ssh_config_import(&human(), path.as_deref().map(std::path::Path::new), &names)
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

#[tauri::command]
async fn close_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.close_session(&human(), sid).await.map_err(WireError::from)
}

/// 断线会话一键重连（T13）：仅 Disconnected 会话；成功后进入重确认。
#[tauri::command]
async fn reconnect_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.reconnect_session(&sid).await.map_err(WireError::from)
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

/// SFTP 目录浏览（T41 FR-7）：只读 readdir，人类专属入口（不经审批）。
#[tauri::command]
async fn sftp_list(state: ApiState<'_>, sid: String, path: String) -> CmdResult<Vec<DirEntryS>> {
    state.api.sftp_list(&human(), sid, &path).await.map_err(WireError::from)
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
                } else if mode == "r15" {
                    r15_smoke_script(&run_id)
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
            list_hosts, upsert_host, delete_host, create_identity, list_identities,
            ssh_config_preview, ssh_config_import,
            list_sessions, create_session, close_session, reconnect_session, resize, subscribe_output,
            unsubscribe_output, resync_output, debug_subscriptions,
            open_url,
            upload_file, download_file, cancel_transfer, sftp_list,
            list_forwards, start_forward, stop_forward,
            get_setting, set_setting, get_workspace, set_workspace, set_host_favorite,
            list_host_metadata, list_recent_hosts,
            read_screen, send_keys, exec_human, set_control, session_brief, set_session_goal,
            list_approvals, decide_approval, audit_query, issue_agent, mcp_status,
            pending_host_keys, decide_host_key, pending_auth_prompts, answer_auth_prompt,
            bench_start, bench_report, bench_mode, note_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
