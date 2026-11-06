//! 主机密钥 TOFU 与认证提示应答。

use super::*;

/// 主机指纹待决列表（路线图⑤ TOFU：首连确认/变更告警）。
#[tauri::command]
pub(crate) async fn pending_host_keys(state: ApiState<'_>) -> CmdResult<Vec<PendingHostKey>> {
    state
        .api
        .pending_host_keys(&human())
        .await
        .map_err(WireError::from)
}

/// 人类对指纹确认作出决定；accept=true 时指纹入库并放行连接。
#[tauri::command]
pub(crate) async fn decide_host_key(
    state: ApiState<'_>,
    id: String,
    accept: bool,
) -> CmdResult<()> {
    state
        .api
        .decide_host_key(&human(), &id, accept)
        .await
        .map_err(WireError::from)
}

/// 2FA 认证提示待决列表（路线图⑩：keyboard-interactive 非密码类提示）。
#[tauri::command]
pub(crate) async fn pending_auth_prompts(state: ApiState<'_>) -> CmdResult<Vec<PendingAuthPrompt>> {
    state
        .api
        .pending_auth_prompts(&human())
        .await
        .map_err(WireError::from)
}

/// 人类应答认证提示；answer 为空串视为取消（认证终止）。
#[tauri::command]
pub(crate) async fn answer_auth_prompt(
    state: ApiState<'_>,
    id: String,
    answer: String,
) -> CmdResult<()> {
    state
        .api
        .answer_auth_prompt(&human(), &id, &answer)
        .await
        .map_err(WireError::from)
}
