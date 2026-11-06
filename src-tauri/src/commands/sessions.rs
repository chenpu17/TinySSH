//! 会话生命周期、连接尝试、日志开关与状态流。

use super::*;

#[tauri::command]
pub(crate) async fn list_sessions(state: ApiState<'_>) -> CmdResult<Vec<SessionInfo>> {
    state
        .api
        .list_sessions(&human())
        .await
        .map_err(WireError::from)
}

/// R41（§6.6/S09）连接详情：连接时身份快照（地址/端口/用户/认证/指纹/编码）+ 真实创建时刻。
#[tauri::command]
pub(crate) async fn session_detail(
    state: ApiState<'_>,
    sid: String,
) -> CmdResult<session_api::SessionDetail> {
    state
        .api
        .session_detail(&human(), sid)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn create_session(state: ApiState<'_>, host_id: String) -> CmdResult<SessionId> {
    state
        .api
        .create_session(&human(), CreateSessionReq { host_id })
        .await
        .map_err(WireError::from)
}

// ---- C1 建连尝试（R19；camelCase 入参 / snake_case 出参同 v1 命令口径）----

#[tauri::command]
pub(crate) async fn begin_connection(
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

/// 十七轮「快速连接」：不落 vault 直接建连（主机/凭据/TOFU 信任仅内存，重启即失）。
#[tauri::command]
pub(crate) async fn begin_connection_draft(
    state: ApiState<'_>,
    draft: session_api::HostDraft,
    opts: Option<BeginConnectionOpts>,
) -> CmdResult<AttemptInfo> {
    state
        .api
        .begin_connection_draft(&human(), draft, opts.unwrap_or_default())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn connection_status(
    state: ApiState<'_>,
    attempt_id: String,
) -> CmdResult<AttemptInfo> {
    state
        .api
        .connection_status(&human(), attempt_id)
        .await
        .map_err(WireError::from)
}

/// 十八轮「会话日志」：开关（开启返回日志路径供 toast）与路径查询（供打开文件夹）。
#[tauri::command]
pub(crate) async fn set_session_logging(
    state: ApiState<'_>,
    sid: String,
    enabled: bool,
) -> CmdResult<Option<String>> {
    state
        .api
        .set_session_logging(&human(), sid, enabled)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn session_log_path(
    state: ApiState<'_>,
    sid: String,
) -> CmdResult<Option<String>> {
    state
        .api
        .session_log_path(&human(), sid)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn cancel_connection(
    state: ApiState<'_>,
    attempt_id: String,
) -> CmdResult<CancelOutcome> {
    state
        .api
        .cancel_connection(&human(), attempt_id)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn close_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    // 会话关闭同步撤内嵌 agent 的槽位与转写（运行中的先发取消，自然收尾）
    state.agent_host.close(&sid);
    state
        .api
        .close_session(&human(), sid)
        .await
        .map_err(WireError::from)
}

/// 断线会话一键重连（T13）：仅 Disconnected 会话；成功后进入重确认。
#[tauri::command]
pub(crate) async fn reconnect_session(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state
        .api
        .reconnect_session(&sid)
        .await
        .map_err(WireError::from)
}

/// R26（§6.4「可停止重试」）：停止自动重连（≤250ms 内落 Disconnected）。
/// 幂等：非重连期为合法 no-op。
#[tauri::command]
pub(crate) async fn stop_auto_reconnect(state: ApiState<'_>, sid: String) -> CmdResult<()> {
    state
        .api
        .stop_auto_reconnect(&sid)
        .await
        .map_err(WireError::from)
}

/// R26：会话状态快照（demo/兜底轮询面；真实 UI 走 session-state 事件）。
#[tauri::command]
pub(crate) async fn session_state_feed(state: ApiState<'_>) -> CmdResult<Vec<SessionStateEvent>> {
    let list = state
        .api
        .list_sessions(&Actor::Human)
        .await
        .map_err(WireError::from)?;
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
