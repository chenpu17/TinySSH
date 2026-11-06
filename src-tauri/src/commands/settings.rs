//! 设置、工作区、主机元数据、粘贴扫描与构建时间。

use super::*;

/// 编译时间（版本号轮）：build.rs 注入的 env（本地时区 YYYY-MM-DD HH:MM），
/// 关于卡「编译于 …」可溯源。纯编译期常量，不涉任何会话/凭据。
#[tauri::command]
pub(crate) fn get_build_time() -> String {
    env!("TINYSSH_BUILD_TIME").to_string()
}

/// UI 偏好读取（路线图⑥：字号/主题；管理面直连 vault，§6.9 既有先例）。
/// async 化（稳定轮）：同步 command 跑在主线程——偏好读写是高频路径（各面板
/// 挂载即读、设置即写），SQLite 行锁/IO 卡顿会直接冻结 UI 帧。
#[tauri::command]
pub(crate) async fn get_setting(state: ApiState<'_>, key: String) -> CmdResult<Option<String>> {
    state
        .api
        .center
        .vault
        .get_setting(&key)
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn set_setting(state: ApiState<'_>, key: String, value: String) -> CmdResult<()> {
    state
        .api
        .center
        .vault
        .set_setting(&key, &value)
        .map_err(WireError::from)
}

// ---- C8 偏好与主机元数据（R15；经 SessionApi 走 Human 通道与审计）----
#[tauri::command]
pub(crate) async fn get_workspace(state: ApiState<'_>) -> CmdResult<Workspace> {
    state
        .api
        .get_workspace(&human())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn set_workspace(state: ApiState<'_>, ws: Workspace) -> CmdResult<Workspace> {
    state
        .api
        .set_workspace(&human(), ws)
        .await
        .map_err(WireError::from)?;
    state
        .api
        .get_workspace(&human())
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn set_host_favorite(
    state: ApiState<'_>,
    host_id: String,
    favorite: bool,
) -> CmdResult<()> {
    state
        .api
        .set_host_favorite(&human(), host_id, favorite)
        .await
        .map_err(WireError::from)
}

#[tauri::command]
pub(crate) async fn list_host_metadata(state: ApiState<'_>) -> CmdResult<Vec<HostMeta>> {
    state
        .api
        .list_host_metadata(&human())
        .await
        .map_err(WireError::from)
}

/// 粘贴危险形态命中（P0 终端品质轮）：段 + 原因。
#[derive(serde::Serialize)]
pub(crate) struct PasteHit {
    segment: String,
    reason: String,
}

/// 人类粘贴前的危险形态扫描——与 Agent 审批同一张内置 deny 表（approval::scan_dangerous）。
/// UI 侧只在廉价预筛命中时才调它，判定本身完全在 Rust（不做第二份规则）。
/// async 化（稳定轮）：超大粘贴的正则扫描曾整段跑在主线程，UI 随粘贴卡一拍。
#[tauri::command]
pub(crate) async fn scan_paste_danger(
    state: ApiState<'_>,
    text: String,
) -> CmdResult<Vec<PasteHit>> {
    Ok(state
        .api
        .center
        .engine
        .scan_dangerous(&text)
        .into_iter()
        .map(|(segment, reason)| PasteHit { segment, reason })
        .collect())
}

#[tauri::command]
pub(crate) async fn list_recent_hosts(state: ApiState<'_>) -> CmdResult<Vec<RecentHost>> {
    state
        .api
        .list_recent_hosts(&human())
        .await
        .map_err(WireError::from)
}

/// 打开终端里的链接（T16 OSC8/URL）：仅 http/https，走系统默认浏览器。
/// scheme 白名单防「open file://…」或自定义 scheme 被外部处理器利用；
/// scheme 按 RFC 3986 不分大小写（OSC8 里的 `HTTPS://…` 也放行）。
#[tauri::command]
pub(crate) async fn open_url(url: String) -> CmdResult<()> {
    let scheme_ok = url
        .split_once("://")
        .is_some_and(|(s, _)| matches!(s.to_ascii_lowercase().as_str(), "http" | "https"));
    if !scheme_ok {
        return Err(WireError::simple("invalid_input", "仅支持 http/https 链接"));
    }
    // Windows 分支（审计 W2）：原实现硬编码 macOS `open`，Windows 上恒失败。
    // rundll32 直调协议处理器，不经 cmd /c start 的引号再解析层。
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(WireError::from)?;
    }
    #[cfg(windows)]
    {
        tokio::process::Command::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .spawn()
            .map_err(WireError::from)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(WireError::from)?;
    }
    Ok(())
}
