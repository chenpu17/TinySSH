//! 终端尺寸/输出订阅、键入、执行、控制权与 Shell 能力。

use super::*;

#[tauri::command]
pub(crate) async fn resize(
    state: ApiState<'_>,
    sid: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state
        .api
        .resize(&human(), sid, cols, rows)
        .await
        .map_err(WireError::from)
}

/// 输出流订阅：Channel 桥（可丢 broadcast + 失步 resync，L0 ADR-2/7；C10 R11）。
/// 返回订阅身份 + 检查点 + 水位；Raw 帧加 8 字节 LE seq 帧头（UI 剥头取 seq）。
/// 桥 task 绑定订阅身份：send 失败（订阅端通道已关）或 broadcast 关闭即兜底退订。
#[tauri::command]
pub(crate) async fn subscribe_output(
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
pub(crate) async fn unsubscribe_output(
    state: ApiState<'_>,
    sid: String,
    subscription_id: String,
) -> CmdResult<()> {
    state
        .api
        .unsubscribe_output(sid, &subscription_id)
        .await
        .map_err(WireError::from)
}

/// resync（DF10.3）：from_seq=UI 最后已应用序号，None 请求检查点。
#[tauri::command]
pub(crate) async fn resync_output(
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
pub(crate) fn debug_subscriptions(state: ApiState<'_>) -> DebugSubscriptions {
    state.api.debug_subscriptions()
}

#[tauri::command]
pub(crate) async fn read_screen(state: ApiState<'_>, sid: String) -> CmdResult<ScreenSnapshot> {
    state
        .api
        .read_screen(&human(), sid)
        .await
        .map_err(WireError::from)
}

// 五轮架构：FE 尺寸对账看门狗专用（每 3s 每 pane）——替代误用的 read_screen
// （整屏网格序列化只为读 cols/rows）。返回 (cols, rows) 元组。
#[tauri::command]
pub(crate) async fn pty_size(state: ApiState<'_>, sid: String) -> CmdResult<(u16, u16)> {
    state
        .api
        .pty_size(&human(), sid)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn send_keys(state: ApiState<'_>, sid: String, keys: String) -> CmdResult<()> {
    state
        .api
        .send_keys(&human(), sid, &keys)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn exec_human(
    state: ApiState<'_>,
    sid: String,
    command: String,
) -> CmdResult<ExecResult> {
    state
        .api
        .exec(&human(), sid, &command, ExecOpts::default())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn set_control(
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
    state
        .api
        .set_control(&human(), sid, owner, opts)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn delegate_session(
    state: ApiState<'_>,
    sid: String,
    goal: Option<String>,
) -> CmdResult<()> {
    state
        .api
        .delegate_session(&human(), sid, goal)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn shell_capability(
    state: ApiState<'_>,
    sid: String,
) -> CmdResult<ShellCapability> {
    state
        .api
        .shell_capability(&human(), sid)
        .await
        .map_err(WireError::from)
}

/// 本机可用 shell 清单（本地终端一等公民轮）。机器信息不走 SessionApi——
/// 与会话无关、无 actor 语义；transport-pty 只做存在性探测不启动进程。
#[tauri::command]
pub(crate) async fn list_local_shells() -> CmdResult<Vec<transport_pty::LocalShellInfo>> {
    Ok(transport_pty::detect_local_shells())
}
