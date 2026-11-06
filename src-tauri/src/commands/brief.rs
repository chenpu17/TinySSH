//! 会话简报、命令块、触发器与会话目标。

use super::*;

#[tauri::command]
pub(crate) async fn session_brief(state: ApiState<'_>, sid: String) -> CmdResult<SessionBrief> {
    state
        .api
        .get_session_brief(&human(), sid)
        .await
        .map_err(WireError::from)
}

/// FR-10 V2（P1-b）：命令块查询（最近 N 条旧→新）。人类侧只读面板数据面；
/// Agent 侧走 MCP 简报（最近 6 块），不开独立工具（V2 交接引用块先在人类侧）。
#[tauri::command]
pub(crate) async fn read_blocks(
    state: ApiState<'_>,
    sid: String,
    limit: Option<u32>,
) -> CmdResult<Vec<BlockInfo>> {
    state
        .api
        .read_blocks(&human(), sid, limit.unwrap_or(50))
        .await
        .map_err(WireError::from)
}

// P2-b 输出触发器：人类专属设置读写（Agent 无 API——规则能自动请求键序发送）
#[tauri::command]
pub(crate) async fn read_triggers(state: ApiState<'_>) -> CmdResult<Vec<session_api::TriggerRule>> {
    state
        .api
        .read_triggers(&human())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn save_triggers(
    state: ApiState<'_>,
    rules: Vec<session_api::TriggerRule>,
) -> CmdResult<Vec<session_api::TriggerRule>> {
    state
        .api
        .save_triggers(&human(), rules)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn set_session_goal(
    state: ApiState<'_>,
    sid: String,
    goal: Option<String>,
) -> CmdResult<()> {
    state
        .api
        .set_session_goal(&human(), sid, goal)
        .await
        .map_err(WireError::from)
}
