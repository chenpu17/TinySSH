//! 审批、记住授权与自主模式。

use super::*;

#[tauri::command]
pub(crate) async fn list_approvals(
    state: ApiState<'_>,
    pending_only: bool,
) -> CmdResult<Vec<ApprovalItem>> {
    state
        .api
        .list_approvals(
            &human(),
            ApprovalFilter {
                pending_only,
                ..Default::default()
            },
        )
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn decide_approval(
    state: ApiState<'_>,
    id: String,
    decision: String,
    edited: Option<String>,
) -> CmdResult<()> {
    let d = match decision.as_str() {
        "approve" => Decision::Approve,
        "deny" => Decision::Deny,
        "edit" => Decision::ApproveEdited(edited.unwrap_or_default()),
        _ => return Err(WireError::simple("invalid_input", "bad decision")),
    };
    state
        .api
        .decide_approval(&human(), id, d)
        .await
        .map_err(WireError::from)
}

/// 「批准并记住」（审批减摩擦①）：写放行策略（TTL 精确记忆 / 持久 pattern），
/// 返回实际写入的 pattern。前端随后自行走 decide_approval 完成批准。
#[tauri::command]
pub(crate) async fn remember_approval(
    state: ApiState<'_>,
    id: String,
    ttl_minutes: Option<u32>,
    pattern: Option<String>,
) -> CmdResult<Vec<String>> {
    let scope = match (ttl_minutes, pattern) {
        (Some(m), _) => RememberScope::Ttl { minutes: m },
        (None, Some(p)) => RememberScope::Persistent { pattern: p },
        _ => {
            return Err(WireError::simple(
                "invalid_input",
                "需要 ttl_minutes 或 pattern",
            ))
        }
    };
    state
        .api
        .remember_approval(&human(), id, scope)
        .await
        .map_err(WireError::from)
}

/// ② 自主模式：按 Agent 开/关（人类专属）。deny 名单仍硬拦、传输仍逐条审批、
/// 记录/审计照常；重启即失效（授权只存内存）。
#[tauri::command]
pub(crate) async fn set_autonomy(
    state: ApiState<'_>,
    agent_id: String,
    enable: bool,
    ttl_minutes: Option<u32>,
) -> CmdResult<()> {
    state
        .api
        .set_autonomy(&human(), agent_id, enable, ttl_minutes)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn autonomy_list(
    state: ApiState<'_>,
) -> CmdResult<Vec<session_api::AutonomyGrant>> {
    state
        .api
        .autonomy_list(&human())
        .await
        .map_err(WireError::from)
}
