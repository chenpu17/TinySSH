//! 内置 Agent 模型配置、对话与文件选择器。

use super::*;

/// 读模型服务配置（FE 设置卡）。api_key **永不下发**——只回 has_key 事实。
#[tauri::command]
pub(crate) async fn agent_model_get(
    state: ApiState<'_>,
) -> std::result::Result<Option<serde_json::Value>, String> {
    let raw = state.api.get_agent_model().map_err(|e| e.to_string())?;
    Ok(raw
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|mut v| {
            if let Some(o) = v.as_object_mut() {
                let has_key = o
                    .get("api_key")
                    .and_then(|k| k.as_str())
                    .map(|k| !k.is_empty())
                    .unwrap_or(false);
                o.insert("has_key".into(), serde_json::Value::Bool(has_key));
                o.remove("api_key");
            }
            v
        }))
}

/// 写模型服务配置。api_key 缺省 = 保留既有（只改端点/模型）；首次配置必填。
/// 存储走 vault 密封 KV（agent.model.v1，core_session::agent_model）。
#[tauri::command]
pub(crate) async fn agent_model_set(
    state: ApiState<'_>,
    provider: String,
    base_url: Option<String>,
    model: String,
    api_key: Option<String>,
) -> std::result::Result<(), String> {
    if provider != "openai" && provider != "anthropic" {
        return Err("provider 仅支持 openai / anthropic".into());
    }
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    let key = match api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
    {
        Some(k) => k,
        None => {
            let existing = state.api.get_agent_model().map_err(|e| e.to_string())?;
            let existing: serde_json::Value = existing
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);
            existing
                .get("api_key")
                .and_then(|k| k.as_str())
                .filter(|k| !k.is_empty())
                .ok_or("api_key 必填（首次配置）")?
                .to_string()
        }
    };
    let json = serde_json::json!({
        "provider": provider,
        "base_url": base_url.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        "model": model,
        "api_key": key,
    })
    .to_string();
    state.api.set_agent_model(&json).map_err(|e| e.to_string())
}

/// 发送一条用户消息到该会话的内嵌 agent。事件经 `agent-event` 推送
///（{sid, event}），会话串行（上一位在跑则报错）。
#[tauri::command]
pub(crate) async fn agent_send(
    state: ApiState<'_>,
    app: tauri::AppHandle,
    sid: String,
    text: String,
) -> std::result::Result<(), String> {
    let raw = state
        .api
        .get_agent_model()
        .map_err(|e| e.to_string())?
        .ok_or("未配置模型服务——请在设置 → Agent 里配置")?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let cfg = tinyssh_agent_host::ModelConfig {
        provider: v
            .get("provider")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        base_url: v.get("base_url").and_then(|x| x.as_str()).map(String::from),
        model: v
            .get("model")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        api_key: v
            .get("api_key")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    };
    let sink: tinyssh_agent_host::EventSink = Arc::new(move |sid: &str, ev| {
        let _ = app.emit(
            "agent-event",
            serde_json::json!({ "sid": sid, "event": ev }),
        );
    });
    // Fleet 轮补缺（真模型 E2E 实证）：FE 编排视图发的 sid 是固定键 "fleet"，
    // 必须路由到 send_fleet（编排三工具 fleet_sessions/dispatch_task/wait_task +
    // FLEET_SYS_PROMPT）——走通用 send 会装配出绑在 "fleet" 这个不存在会话上的
    // 普通工具面（exec 等全部报「会话不存在」）。演练壳测不到这条，spec 53 只盖 FE。
    let _run_id = if sid == tinyssh_agent_host::FLEET_KEY {
        state.agent_host.send_fleet(&text, &cfg, sink)
    } else {
        state.agent_host.send(&sid, &text, &cfg, sink)
    }?;
    Ok(())
}

/// 请求取消当前运行（工具/轮次间隙生效）。返回是否确有运行在途。
#[tauri::command]
pub(crate) async fn agent_cancel(
    state: ApiState<'_>,
    sid: String,
) -> std::result::Result<bool, String> {
    let model_cancel = state.agent_host.cancel(&sid);
    // 同时取消核心侧在途 exec/传输并作废本 Agent 的待审批卡：只置模型取消位
    // 时，审批等待/长命令/传输会继续跑，停止按钮看起来「没反应」。
    let core_cancel = state
        .api
        .cancel_agent_work(&human(), &sid, tinyssh_agent_host::AGENT_CLIENT_ID)
        .await;
    Ok(model_cancel || core_cancel > 0)
}

/// 接管（仅冻结）时停掉模型生成：工具调用已被冻结，继续流式生成既浪费 token
/// 又让面板看起来「Agent 还在干活」。只置模型取消位，不碰核心侧在途 exec/传输
/// ——停止在跑的命令是「接管并停止」的语义。
#[tauri::command]
pub(crate) async fn agent_cancel_model(
    state: ApiState<'_>,
    sid: String,
) -> std::result::Result<bool, String> {
    Ok(state.agent_host.cancel(&sid))
}

/// 会话对话转写（FE 重挂载重建；最旧在前）。
#[tauri::command]
pub(crate) async fn agent_history(
    state: ApiState<'_>,
    sid: String,
) -> std::result::Result<Vec<tinyssh_agent_host::HostEvent>, String> {
    Ok(state.agent_host.history(&sid))
}

/// R33 §353 上传入口：原生文件选择器（多选）。对话框必须在非主线程跑——
/// blocking_* 变体放 spawn_blocking；取消返回空数组（FE 据此静默收场）。
#[tauri::command]
pub(crate) async fn pick_upload_files(
    app: tauri::AppHandle,
) -> std::result::Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = tauri_plugin_dialog::DialogExt::dialog(&app).file();
        // macOS 的 NSOpenPanel 没有 "*" 通配语义：rfd 把它原样交给
        // setAllowedFileTypes，AppKit 转成一个动态 UTI（dyn.ah62d4rv4ge8wy），
        // 并不等于「所有文件」；不设过滤器才是（rfd 过滤列表为空时根本不调
        // setAllowedFileTypes）。Linux xdg portal 后端特判了 "*"、Windows 会
        // 展开成 "*.*"，这两条按原样保留。
        if !cfg!(target_os = "macos") {
            dialog = dialog.add_filter("所有文件", &["*"]);
        }
        let picked = dialog.blocking_pick_files();
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string())
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// R33 §354 下载「另存为」：原生保存对话框（默认文件名/目录可给）；取消返回 None。
/// 二十一轮真机修正：此前误用 blocking_pick_file（打开对话框——按钮「打开(O)」、
/// 键入不存在的新名报「找不到文件」，无法另存新名）；保存语义必须 save_file。
#[tauri::command]
pub(crate) async fn pick_save_file(
    app: tauri::AppHandle,
    default_name: String,
    default_dir: Option<String>,
) -> std::result::Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = tauri_plugin_dialog::DialogExt::dialog(&app).file();
        b = b.set_file_name(&default_name);
        if let Some(d) = default_dir {
            b = b.set_directory(d);
        }
        Ok(b.blocking_save_file().map(|p| p.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 批量下载「只选一个目录」（0.10.0 轮，用户反馈另存为模式下逐文件弹保存框太繁）：
/// 原生目录选择器，默认目录可给；取消返回 None。与 pick_save_file 同为
/// spawn_blocking（对话框阻塞不能占命令主线程）。
#[tauri::command]
pub(crate) async fn pick_save_dir(
    app: tauri::AppHandle,
    default_dir: Option<String>,
) -> std::result::Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = tauri_plugin_dialog::DialogExt::dialog(&app).file();
        if let Some(d) = default_dir {
            b = b.set_directory(d);
        }
        Ok(b.blocking_pick_folder().map(|p| p.to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}
