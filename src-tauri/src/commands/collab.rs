//! Agent token 签发/吊销、MCP 端点与协作开关。

use super::*;

/// Agent Token 签发（仅展示一次）。
#[tauri::command]
pub(crate) async fn issue_agent(
    state: ApiState<'_>,
    id: String,
    label: String,
    expires_days: Option<u64>,
) -> CmdResult<String> {
    let expires = expires_days.map(|d| chrono::Utc::now() + chrono::Duration::days(d as i64));
    state
        .api
        .center
        .vault
        .create_agent_ex(&id, &label, expires)
        .map_err(WireError::from)
}

/// rev-r47：吊销 Agent（GUI 内完成生命周期管理，不再强制去 CLI）。
#[tauri::command]
pub(crate) async fn revoke_agent(state: ApiState<'_>, id: String) -> CmdResult<()> {
    state
        .api
        .center
        .vault
        .revoke_agent(&id)
        .map_err(WireError::from)
}

/// rev-r47：端点自发现文件维护——Some(url) 写入 / None 删除（幂等）。
/// Agent 配置因端口漂移失效时可读此文件自愈；停用/退出删除避免陈旧误导。
pub(crate) fn refresh_endpoint_file(api: &Arc<SessionManager>, url: Option<&str>) {
    match url {
        Some(u) => {
            if let Err(e) = tinyssh_mcp_server::write_endpoint_file(&api.data_dir, u) {
                eprintln!("[app] endpoint file write failed: {e}");
            }
        }
        None => tinyssh_mcp_server::remove_endpoint_file(&api.data_dir),
    }
}

/// MCP 端点状态（端口展示，L1 §3.5）。
/// R42：`agents` 投影为 `{id,label}`（与 wire/demo 契约一致；vault 内部为三元组，且含已吊销行，
/// 已吊销不算「已接入」）。协作入口/Agent 面板据此判定「有协作配置」。
/// rev-r47：追加 `agents_detail`（最近使用/过期，生命周期管理用）与 `shim_path`
/// （便携安装不在 PATH——接入文档与设置页都给绝对路径）。
#[tauri::command]
pub(crate) async fn mcp_status(state: ApiState<'_>) -> CmdResult<serde_json::Value> {
    eprintln!("[app] mcp_status invoked (frontend alive)");
    let agents: Vec<serde_json::Value> = state
        .api
        .center
        .vault
        .list_agents()
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, _, revoked)| revoked.is_none())
        .map(|(id, label, _)| serde_json::json!({ "id": id, "label": label }))
        .collect();
    let agents_detail: Vec<serde_json::Value> = state
        .api
        .center
        .vault
        .list_agents_detailed()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.revoked_at.is_none())
        .map(|a| {
            serde_json::json!({
                "id": a.id, "label": a.label,
                "last_used_at": a.last_used_at, "expires_at": a.expires_at,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "endpoint": state.api.mcp_endpoint(),
        "agents": agents,
        "agents_detail": agents_detail,
        "shim_path": tinyssh_mcp_server::shim_display_path(),
    }))
}

// ---------------------------------------------------------------------------
// C9（R43）：协作启用生命周期命令
// ---------------------------------------------------------------------------

/// 协作服务状态（状态机 + 已配置 Agent 数 + 有活动请求数 + 端点地址）。
#[tauri::command]
pub(crate) async fn collab_status(state: ApiState<'_>) -> CmdResult<CollabStatus> {
    state
        .api
        .collab_status(&human())
        .await
        .map_err(WireError::from)
}

/// 停用影响预览（确认前展示）。
#[tauri::command]
pub(crate) async fn collab_disable_preview(state: ApiState<'_>) -> CmdResult<DisableImpact> {
    state
        .api
        .collab_disable_preview(&human())
        .await
        .map_err(WireError::from)
}

/// 确认停用：核心**原子**封 admission（拒绝新 Agent 请求）+ 作废未开始请求 +
/// Agent 会话转回 Human；随后停止应用拥有的 MCP 端点。两层均确认后才 Disabled。
#[tauri::command]
pub(crate) async fn collab_disable(state: ApiState<'_>) -> CmdResult<DisableReport> {
    let report = state
        .api
        .collab_disable(&human())
        .await
        .map_err(WireError::from)?;
    // 停止应用拥有的端点（若在运行）。**确认**监听器确已释放后才置 Disabled——
    // 发信号不等于已停（§9「监听器关闭不等于核心 gate 已生效，两层均需确认」）。
    let handle = state.mcp_endpoint.lock().unwrap().take();
    match handle {
        Some(mut h) => {
            h.stop();
            let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), h.wait_stopped())
                .await
                .is_ok();
            if !stopped {
                // 未在时限内确认停机 → 保持封闭（DisableFailed），句柄放回以便重试
                *state.mcp_endpoint.lock().unwrap() = Some(h);
                let _ = state
                    .api
                    .collab_mark_disable_failed(&human(), "MCP 端点未在时限内确认停止".into())
                    .await;
                return Err(WireError::from(session_api::Error::InvalidInput(
                    "停用未收敛：MCP 端点未在时限内确认停止（协作保持封闭，可重试）".into(),
                )));
            }
            state.api.set_mcp_endpoint(String::new());
            // rev-r47：端点确认已停 → 自发现文件一并撤下
            refresh_endpoint_file(&state.api, None);
        }
        None => {
            // 本就没起端点（如新装未启用）→ 视为已停止
            state.api.set_mcp_endpoint(String::new());
            refresh_endpoint_file(&state.api, None);
        }
    }
    state
        .api
        .collab_mark_endpoint_stopped(&human())
        .await
        .map_err(WireError::from)?;
    Ok(report)
}

/// 显式重新启用：核心确认旧停用已收敛后重开 gate，随后确保应用端点运行。
///
/// 顺序：**先起端点再开 gate**——端点起不来就直接失败返回（核心保持停用），
/// 避免出现「已启用但端点未运行」的自相矛盾态（§9：监听器关闭 ≠ gate 生效，
/// 反之亦然；两端不得各自为政）。起端点失败时其句柄被 drop → 触发优雅停机。
#[tauri::command]
pub(crate) async fn collab_enable(state: ApiState<'_>) -> CmdResult<CollabStatus> {
    let need_start = state.mcp_endpoint.lock().unwrap().is_none();
    let mut new_handle: Option<tinyssh_mcp_server::EndpointHandle> = None;
    if need_start {
        let resolver: tinyssh_mcp_server::TokenResolver = {
            let vault = state.api.center.vault.clone();
            Arc::new(move |t: &str| vault.resolve_token(t))
        };
        let api2 = state.api.clone();
        let data_dir = state.api.data_dir.clone();
        match tinyssh_mcp_server::spawn_endpoint_full(api2, resolver, 8722, Some(data_dir)).await {
            Ok((port, handle)) => {
                let url = format!("http://127.0.0.1:{port}/mcp");
                state.api.set_mcp_endpoint(url.clone());
                refresh_endpoint_file(&state.api, Some(&url));
                new_handle = Some(handle);
            }
            Err(e) => {
                state.api.set_mcp_endpoint(String::new());
                refresh_endpoint_file(&state.api, None);
                eprintln!("[app] collab enable: MCP endpoint bind failed: {e}");
                return Err(WireError::from(session_api::Error::InvalidInput(format!(
                    "MCP 端点启动失败（端口被占？）：{e}"
                ))));
            }
        }
    }
    // 核心开门；未收敛（Disabling/DisableFailed）则回滚端点。
    // C9（R43 / rev-r43 F8）：回滚须保证「core 未启用 ⇒ 无应用端点运行」——**无论**端点
    // 是否本次新起。`need_start == false`（既有句柄来自一次超时未收敛的停用）时此前只清
    // 地址、未停既有端点，会留下「端点仍活、地址已清、core 未启用」的潜在不一致（经当前
    // UI 不可达，但语义上不该存在）。此处一律 take 既有句柄并停掉（drop 最后一个 sender
    // 亦触发优雅停机，与 `stop()` 同效）。
    if let Err(e) = state.api.collab_enable(&human()).await {
        state.api.set_mcp_endpoint(String::new());
        drop(new_handle);
        if let Some(h) = state.mcp_endpoint.lock().unwrap().take() {
            h.stop();
            drop(h);
        }
        return Err(WireError::from(e));
    }
    if let Some(h) = new_handle {
        *state.mcp_endpoint.lock().unwrap() = Some(h);
    }
    state
        .api
        .collab_status(&human())
        .await
        .map_err(WireError::from)
}
