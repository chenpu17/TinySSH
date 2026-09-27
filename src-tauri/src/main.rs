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

fn human() -> Actor {
    Actor::Human
}

type ApiState<'a> = State<'a, AppState>;
type CmdResult<T> = std::result::Result<T, String>;

#[tauri::command]
async fn list_hosts(state: ApiState<'_>) -> CmdResult<Vec<Host>> {
    state.api.list_hosts(&human()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn upsert_host(state: ApiState<'_>, host: HostDraft) -> CmdResult<HostId> {
    state.api.upsert_host(&human(), host).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_host(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state.api.delete_host(&human(), id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_identity(state: ApiState<'_>, req: IdentityReq) -> CmdResult<IdentityMeta> {
    state.api.create_identity(&human(), req).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_identities(state: ApiState<'_>) -> CmdResult<Vec<IdentityMeta>> {
    state.api.list_identities(&human()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(state: ApiState<'_>) -> CmdResult<Vec<SessionInfo>> {
    state.api.list_sessions(&human()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_session(state: ApiState<'_>, host_id: String) -> CmdResult<SessionId> {
    state
        .api
        .create_session(&human(), CreateSessionReq { host_id })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state.api.close_session(&human(), sid).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize(state: ApiState<'_>, sid: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.api.resize(&human(), sid, cols, rows).await.map_err(|e| e.to_string())
}

/// 输出流订阅：Channel 桥（可丢 broadcast + 失步 resync，L0 ADR-2/7）。
#[tauri::command]
async fn subscribe_output(
    state: ApiState<'_>,
    sid: String,
    on_event: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    window: tauri::Window<tauri::Wry>,
) -> CmdResult<()> {
    let mut rx = state.api.subscribe_output(sid.clone()).map_err(|e| e.to_string())?;
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
    state.api.read_screen(&human(), sid).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_keys(state: ApiState<'_>, sid: String, keys: String) -> CmdResult<()> {
    state.api.send_keys(&human(), sid, &keys).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn exec_human(state: ApiState<'_>, sid: String, command: String) -> CmdResult<ExecResult> {
    state
        .api
        .exec(&human(), sid, &command, ExecOpts::default())
        .await
        .map_err(|e| e.to_string())
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
    state.api.set_control(&human(), sid, owner, opts).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn session_brief(state: ApiState<'_>, sid: String) -> CmdResult<SessionBrief> {
    state.api.get_session_brief(&human(), sid).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_approvals(state: ApiState<'_>, pending_only: bool) -> CmdResult<Vec<ApprovalItem>> {
    state
        .api
        .list_approvals(&human(), ApprovalFilter { pending_only, ..Default::default() })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn decide_approval(state: ApiState<'_>, id: String, decision: String, edited: Option<String>) -> CmdResult<()> {
    let d = match decision.as_str() {
        "approve" => Decision::Approve,
        "deny" => Decision::Deny,
        "edit" => Decision::ApproveEdited(edited.unwrap_or_default()),
        _ => return Err("bad decision".into()),
    };
    state.api.decide_approval(&human(), id, d).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn audit_query(state: ApiState<'_>, sid: Option<String>, limit: i64) -> CmdResult<AuditPage> {
    state
        .api
        .query_audit(&human(), AuditFilter { session_id: sid, limit, ..Default::default() })
        .await
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
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

    tauri::Builder::default()
        .manage(AppState { api: api.clone() })
        .on_page_load(|webview, payload| {
            eprintln!("[app] page load event: {:?} {:?}", payload.event(), webview.label());
        })
        .setup(move |app| {
            use tauri::Manager as _;
            eprintln!("[app] setup: windows={:?}", app.webview_windows().keys().collect::<Vec<_>>());
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts, upsert_host, delete_host, create_identity, list_identities,
            list_sessions, create_session, close_session, resize, subscribe_output,
            read_screen, send_keys, exec_human, set_control, session_brief,
            list_approvals, decide_approval, audit_query, issue_agent, mcp_status,
            bench_start, bench_report, bench_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dirs_or_home() -> std::path::PathBuf {
    std::env::var("HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from("."))
}

