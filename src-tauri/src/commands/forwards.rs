//! 端口转发。

use super::*;

/// 端口转发（T42 FR-8）：列/建/停（人类 GUI 入口；Agent 侧留 MCP 审批版）。
#[tauri::command]
pub(crate) async fn list_forwards(state: ApiState<'_>, sid: String) -> CmdResult<Vec<ForwardInfo>> {
    state
        .api
        .list_forwards(&human(), sid)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn start_forward(
    state: ApiState<'_>,
    sid: String,
    spec: ForwardSpec,
) -> CmdResult<ForwardId> {
    state
        .api
        .start_forward(&human(), sid, spec)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn stop_forward(state: ApiState<'_>, sid: String, id: String) -> CmdResult<()> {
    state
        .api
        .stop_forward(&human(), sid, id)
        .await
        .map_err(WireError::from)
}
