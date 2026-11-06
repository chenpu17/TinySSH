//! 主机、身份与 ssh_config 导入。

use super::*;

#[tauri::command]
pub(crate) async fn list_hosts(state: ApiState<'_>) -> CmdResult<Vec<Host>> {
    state
        .api
        .list_hosts(&human())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn upsert_host(state: ApiState<'_>, host: HostDraft) -> CmdResult<HostId> {
    state
        .api
        .upsert_host(&human(), host)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn delete_host(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state
        .api
        .delete_host(&human(), id)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn create_identity(
    state: ApiState<'_>,
    req: IdentityReq,
) -> CmdResult<IdentityMeta> {
    state
        .api
        .create_identity(&human(), req)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn list_identities(state: ApiState<'_>) -> CmdResult<Vec<IdentityMeta>> {
    state
        .api
        .list_identities(&human())
        .await
        .map_err(WireError::from)
}

/// R21 凭据基础管理：删除前核心侧引用检查（被主机引用 → IdentityInUse{host_names}）
#[tauri::command]
pub(crate) async fn delete_identity(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state
        .api
        .delete_identity(&human(), id)
        .await
        .map_err(WireError::from)
}

/// ~/.ssh/config 导入：解析预览（path 缺省 = ~/.ssh/config）
#[tauri::command]
pub(crate) async fn ssh_config_preview(
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
pub(crate) async fn ssh_config_import(
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
