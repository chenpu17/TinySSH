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

/// 输出流订阅：Channel 桥（可丢 broadcast + 失步 resync，L0 ADR-2/7）。
#[tauri::command]
async fn subscribe_output(
    state: ApiState<'_>,
    sid: String,
    on_event: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    window: tauri::Window<tauri::Wry>,
) -> CmdResult<()> {
    let mut rx = state.api.subscribe_output(sid.clone()).map_err(WireError::from)?;
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(OutputEvent::Raw { sid: _, data }) => {
                    // L0 SPIKE-1 结论：原始字节直通（JSON 数字数组会使吞吐降一个量级）
                    if on_event.send(tauri::ipc::InvokeResponseBody::Raw(data)).is_err() {
                        break;
                    }
                }
                Ok(OutputEvent::Resync { .. }) => {
                    let _ = window.emit("resync", sid.clone());
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = window.emit("resync", sid.clone());
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
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
                let script = format!(
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
                );
                std::fs::write("/tmp/t40_smoke/last_smoke_script.js", &script).ok();
                let r = webview.eval(&script);
                eprintln!("[app] smoke script injected: {r:?}");
            }
        })
        .setup(move |app| {
            use tauri::Manager as _;
            eprintln!("[app] setup: windows={:?}", app.webview_windows().keys().collect::<Vec<_>>());
            install_native_ctrl_intercept(api.clone(), terminal_input.clone());
            // T34：原生菜单栏 + 「设置…⌘,」→ 前端事件（打开显示设置面板）
            if let Err(e) = install_native_menu(app.handle()) {
                eprintln!("[app] native menu install failed: {e}");
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
            open_url,
            upload_file, download_file, cancel_transfer, sftp_list,
            list_forwards, start_forward, stop_forward,
            get_setting, set_setting,
            read_screen, send_keys, exec_human, set_control, session_brief, set_session_goal,
            list_approvals, decide_approval, audit_query, issue_agent, mcp_status,
            pending_host_keys, decide_host_key, pending_auth_prompts, answer_auth_prompt,
            bench_start, bench_report, bench_mode, note_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
