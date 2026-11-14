//! TinySSH 应用壳（L1 §1）：装配各 crate、Tauri commands、Channel 桥。
//! GUI 与 MCP 双前端对等：本 crate 只依赖 session-api 契约 + core-session 装配。
//!
//! 本 crate 同时是 lib（`staticlib`/`cdylib`/`rlib`）与 bin：移动端（Android）
//! 由 JNI 直接加载 lib 里的 `mobile_entry_point`，桌面 bin 只是 [`run`] 的薄壳。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use tauri::{Emitter, State};

mod agent_bridge;
mod commands;
mod diagnostics;
mod metrics;
mod smoke_scripts;
mod updater;
mod wire;
use agent_bridge::{AgentPromptAssets, AgentSshOps};
use commands::*;
use diagnostics::{export_diagnostics, APP_STARTED};
use metrics::{read_host_metrics, read_npu_metrics, read_self_metrics, SelfMeter};
use smoke_scripts::*;
#[cfg(windows)]
use updater::cleanup_update_leftovers;
#[cfg(not(feature = "mobile"))]
use updater::updater_pubkey;
use updater::{check_update, updater_info, updater_install};
use wire::{ApiState, CmdResult, WireError};

struct AppState {
    api: Arc<SessionManager>,
    /// C9（R43）：应用拥有的 MCP 端点关闭句柄。停用协作时据以停止监听器；
    /// 重新启用时重新起端点并回填。None = 端点未运行。
    mcp_endpoint: std::sync::Mutex<Option<tinyssh_mcp_server::EndpointHandle>>,
    /// 内置 Agent 宿主（接真模型轮）：每会话一个 agent，工具经 AgentSshOps
    /// 桥回 SessionManager（审批/审计在 core-session 层自动继承）。
    agent_host: Arc<tinyssh_agent_host::AgentHost>,
}

/// 终端聚焦状态（native Ctrl 键接管依据：只有 xterm textarea 聚焦时才劫持）。
/// pane_id：焦点在 tmux 面板格子里时非空——控制字符改投该格通道，不进主会话。
#[derive(Default)]
struct TerminalInput {
    sid: std::sync::Mutex<Option<String>>,
    focused: std::sync::Mutex<bool>,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pane_id: std::sync::Mutex<Option<u32>>,
}

#[tauri::command]
fn note_terminal(
    state: State<'_, Arc<TerminalInput>>,
    sid: Option<String>,
    focused: bool,
    pane_id: Option<u32>,
) -> CmdResult<()> {
    *state.sid.lock().unwrap() = sid;
    *state.focused.lock().unwrap() = focused;
    *state.pane_id.lock().unwrap() = pane_id;
    Ok(())
}

fn human() -> Actor {
    Actor::Human
}

/// 平台能力装配——「一份内核 + 两条装配」的唯一分叉点：
/// 桌面 = OS 钥匙串 + portable-pty 本地终端；移动端由 platform-android 注入
/// （当前是明确失败的桩，不静默降级）。
#[cfg(not(feature = "mobile"))]
fn app_platform() -> tinyssh_platform_api::Platform {
    tinyssh_platform_api::Platform::new(
        tinyssh_vault::desktop_secret_store(),
        Arc::new(transport_pty::PortablePty),
    )
}

#[cfg(feature = "mobile")]
fn app_platform() -> tinyssh_platform_api::Platform {
    tinyssh_platform_android::platform()
}

/// 应用入口：桌面 bin 直接调用；Android 由 `mobile_entry_point` 生成的 JNI 符号调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 运行时长锚点（诊断包用）：装配最前记一次
    let _ = APP_STARTED.set(std::time::Instant::now());
    eprintln!(
        "[app] starting, bench={}",
        std::env::var("TINYSSH_BENCH").unwrap_or_default()
    );
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = std::env::var("TINYSSH_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| default_db_path());
    // 稳定轮：启动期不再 panic——windows_subsystem 下 panic 不可见，双开（vault
    // 独占锁）/库损坏/路径异常的用户只会看到「点了没反应」。失败给原生对话框。
    // 便携自更新轮：TINYSSH_UPDATE_RELAUNCH=1 = 更新重启拉起的新实例——旧实例
    // 退出释放 vault 锁有延迟，此处限时重试等锁（最长 15s）；无旗标的正常双开
    // 路径零改动（首次失败即弹窗）。
    match db.parent() {
        Some(p) => {
            std::fs::create_dir_all(p).ok();
        }
        None => {} // db 在盘根（如 TINYSSH_DB=C:\）：无需建目录
    }
    let relaunch_wait = if std::env::var("TINYSSH_UPDATE_RELAUNCH").ok().as_deref() == Some("1") {
        Some(std::time::Instant::now() + std::time::Duration::from_secs(15))
    } else {
        None
    };
    let api = loop {
        match SessionManager::open_with(&db, app_platform()) {
            Ok(a) => {
                // 成为唯一实例后才清扫上一轮更新的 .old/.new（仍有进程以其为
                // 映像时删除会失败，尽力而为静默留给下次启动）。
                #[cfg(windows)]
                cleanup_update_leftovers();
                break a;
            }
            Err(e) => {
                if relaunch_wait.is_some_and(|d| std::time::Instant::now() < d) {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    continue;
                }
                let msg = format!(
                    "TinySSH 存储库打开失败，无法启动：\n{e}\n\n常见原因：\n· 另一个 TinySSH 实例正在运行（同时只能运行一个）\n· 数据库文件损坏或被占用\n\n路径：{}",
                    db.display()
                );
                show_fatal_dialog(&msg);
                std::process::exit(101);
            }
        }
    };
    let terminal_input: Arc<TerminalInput> = Arc::default();

    // T43（§6-7 进程模型收口）：MCP 端点装配进 GUI 进程——与 tauri 命令共享同一
    // SessionManager 实例，Agent 的审批卡直接进本进程队列（GUI 即见即决），人类
    // 决定即醒同一进程内的 Agent 等待。此前 GUI 只嵌核心不嵌端点，Agent 需另起
    // `tinyssh serve`（跨进程审批不在 thin-slice 范围）。端口被占则递增（L1 §3.5）。
    // C9（R43）：**仅当协作已启用**（持久化期望态；新装默认关闭 → 无自动 MCP 监听）。
    let mcp_endpoint_handle: std::sync::Mutex<Option<tinyssh_mcp_server::EndpointHandle>> = {
        let enabled = api.center.vault.collab_enabled().unwrap_or(false);
        if !enabled {
            api.set_mcp_endpoint(String::new());
            // rev-r47：上次异常退出可能留下陈旧 endpoint 文件——端点未运行即删
            refresh_endpoint_file(&api, None);
            eprintln!("[app] collab disabled (fresh install or user-disabled) —— MCP endpoint not started");
            std::sync::Mutex::new(None)
        } else {
            let resolver: tinyssh_mcp_server::TokenResolver = {
                let vault = api.center.vault.clone();
                Arc::new(move |t: &str| vault.resolve_token(t))
            };
            let api2 = api.clone();
            let data_dir = api.data_dir.clone();
            // bind 失败降级不 panic（审核中-1）：打包后 stderr 无人接，全损的是
            // 「应用打不开」；端点面板已有「未启动」兜底，如实降级可诊断
            let bound = tauri::async_runtime::block_on(async move {
                tinyssh_mcp_server::spawn_endpoint_full(api2, resolver, 8722, Some(data_dir)).await
            });
            match bound {
                Ok((port, handle)) => {
                    let url = format!("http://127.0.0.1:{port}/mcp");
                    api.set_mcp_endpoint(url.clone());
                    refresh_endpoint_file(&api, Some(&url));
                    eprintln!("[app] MCP endpoint in-process: {url}");
                    std::sync::Mutex::new(Some(handle))
                }
                Err(e) => {
                    api.set_mcp_endpoint(String::new());
                    refresh_endpoint_file(&api, None);
                    eprintln!("[app] MCP endpoint bind failed (8722..8753): {e} —— Agent 接入不可用，其余功能不受影响");
                    std::sync::Mutex::new(None)
                }
            }
        }
    };

    // 内置 Agent 宿主装配（接真模型轮）：rt 句柄经 block_on 从共享运行时取
    //（builder 装配线程不在运行时上下文内，直接 Handle::current() 会 panic）
    let agent_rt: tokio::runtime::Handle =
        tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
    let agent_host = tinyssh_agent_host::AgentHost::new_arc_with(
        Arc::new(AgentSshOps {
            api: api.clone(),
            rt: agent_rt,
        }),
        Some(Arc::new(AgentPromptAssets { api: api.clone() })),
    );
    // 会话状态桥的 Closed 分支要用：外部 MCP/CLI 关闭会话时撤内置 Agent 槽位
    // （Tauri close_session 自己也会显式 close；重复调用幂等）。
    let agent_host_for_state = agent_host.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    // 自动更新（桌面通道）：注册期不校验公钥，占位符构建启动零风险；
    // check/install 时的验签失败在 updater_install 里如实回报。移动端随商店
    // 分发，不注册插件（命令面保留，调用时如实报不支持）。
    #[cfg(not(feature = "mobile"))]
    let builder = builder.plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(updater_pubkey())
            .build(),
    );
    let app = builder
        .manage(AppState { api: api.clone(), mcp_endpoint: mcp_endpoint_handle, agent_host })
        .manage(terminal_input.clone())
        .manage(SelfMeter::default())
        .manage(Arc::new(CloseGuard::default()))
        .on_page_load(|webview, payload| {
            eprintln!("[app] page load event: {:?} {:?}", payload.event(), webview.label());
            // dev harness：TINYSSH_SMOKE=1 时页面就绪后注入驱动脚本，走完
            // 「私钥导入→指纹确认→保存→TOFU 信任→建连」全流程（原生冒烟用；
            // 进度写进 document.title，外部用 CGWindowList 轮询窗口标题对账）
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false)
                && webview.label() == "main"
            {
                let key = std::env::var("TINYSSH_SMOKE_KEY")
                    .ok()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .unwrap_or_default();
                // 私钥内容内联进脚本（base64/ASCII 行，无反引号；仍做转义兜底）
                let key_js = key.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
                // R04 Q-04：采样运行标识（仅注入脚本使用，产品行为无关）——
                // 共享信标日志的每条打点可精确归因到本次运行，杜绝跨轮污染
                let run_id = std::env::var("TINYSSH_RUN_ID").unwrap_or_else(|_| "norun".into());
                let mode = std::env::var("TINYSSH_SMOKE_MODE").unwrap_or_default();
                let script: String = if mode == "r11" {
                    r11_smoke_script(&run_id)
                } else if mode == "r12" {
                    r12_smoke_script(&run_id)
                } else if mode == "r13" {
                    r13_smoke_script(&run_id)
                } else if mode == "r14" {
                    r14_smoke_script(&run_id)
                } else if mode == "p2" {
                    p2_smoke_script(&run_id)
                } else if mode == "p6" {
                    p6_smoke_script(&run_id)
                } else if mode == "r15" {
                    r15_smoke_script(&run_id)
                } else if mode == "r19" {
                    r19_smoke_script(&run_id)
                } else if mode == "r24" {
                    r24_smoke_script(&run_id)
                } else if mode == "r21" {
                    r21_smoke_script(&run_id)
                } else if mode == "r22" {
                    r22_smoke_script(&run_id)
                } else if mode == "r23" {
                    r23_smoke_script(&run_id)
                } else if mode == "r25" {
                    r25_smoke_script(&run_id)
                } else if mode == "r26" {
                    r26_smoke_script(&run_id)
                } else if mode == "r27" {
                    r27_smoke_script(&run_id)
                } else if mode == "r30" {
                    r30_smoke_script(&run_id)
                } else if mode.starts_with("r32") {
                    r32_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r33") {
                    r33_smoke_script(&run_id)
                } else if mode.starts_with("r34") {
                    r34_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r40") {
                    r40_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r41") {
                    r41_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r42") {
                    r42_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r43") {
                    r43_smoke_script(&run_id, &mode)
                } else if mode.starts_with("r31") {
                    r31_smoke_script(&run_id)
                } else {
                    format!(
                    r#"(function() {{
  // sleep 原语走 beacon 服务端延时：等待期间页面事件循环自由运转（React 可渲染），
  // 又不依赖 WKWebView 对注入脚本可能节流的 timer
  const sleep = (ms) => fetch('http://127.0.0.1:15199/w/' + ms).catch(() => {{}});
  const RUN = '{run_id}';
  // mark：仅写信标（不改窗口标题），带运行标识；用于采样打点（P1 列表就绪等）
  const mark = (s) => fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(RUN + '|' + s)).catch(() => {{}});
  // R10 调试：启动链未捕获错误/渲染失败直写信标（FAIL-* 归因用，产品路径无关）
  window.addEventListener('error', (ev) => mark('JS-ERROR|' + String(ev.message).slice(0, 300)));
  window.addEventListener('unhandledrejection', (ev) => mark('JS-REJECT|' + String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason).slice(0, 300)));
  const title = (s) => {{
    document.title = 'SMOKE|' + s;
    fetch('http://127.0.0.1:15199/t/' + encodeURIComponent(s)).catch(() => {{}});
  }};
  const setVal = (el, v) => {{
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  }};
  const setSel = (el, v) => {{
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};
  const waitFor = async (fn, tries) => {{
    for (let i = 0; i < tries; i++) {{ const v = fn(); if (v) return v; await sleep(100); }}
    return null;
  }};
  (async () => {{
    try {{
      title('s1-opening');
      // R04 Q-04：主机列表就绪直打点——直接观测「种子主机卡片全部渲染」，
      // 不再由表单阶段信标相减推断。20 = P1 基线种子主机数；主机行类为 .host-card。
      mark('list-wait-begin');
      const cardN = await waitFor(() => {{
        const n = document.querySelectorAll('.host-card').length;
        return n >= 20 ? n : 0;
      }}, 100);
      mark(cardN ? 's2-list-ready|cards=' + cardN : 'FAIL-no-list|cards=0');
      // 等 React 挂载完成（page-load Finished 早于 bundle 执行完）再点
      const openBtn = await waitFor(() => document.querySelector('button[aria-label="添加主机"]'), 60);
      if (!openBtn) {{ title('FAIL-no-open-btn'); return; }}
      openBtn.click();
      await sleep(400);
      const sel = await waitFor(() => document.querySelectorAll('.add-host select')[0], 20);
      if (!sel) {{
        title('FAIL-no-form|cards=' + document.querySelectorAll('.card').length
          + '|ah=' + document.querySelectorAll('.add-host').length
          + '|sel=' + document.querySelectorAll('select').length
          + '|btns=' + [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.slice(0, 6)).join(',').slice(0, 120));
        return;
      }}
      setSel(sel, 'key');
      await sleep(300);
      title('s2-key-mode');
      const ta = await waitFor(() => document.querySelector('.add-host textarea'), 20);
      if (!ta) {{ title('FAIL-no-textarea'); return; }}
      setVal(ta, `{key_js}`);
      title('s3-pasted');
      const imp = await waitFor(() => [...document.querySelectorAll('.add-host button')]
        .find(b => b.textContent.includes('导入并确认指纹')), 20);
      if (!imp) {{ title('FAIL-no-import-btn'); return; }}
      imp.click();
      const trust = await waitFor(() => document.querySelector('.add-host .trust-row .fp'), 40);
      if (!trust) {{ title('FAIL-import'); return; }}
      title('s4-bound|' + (trust.textContent || '').trim().slice(0, 30));
      // DOM 顺序：名称/地址/端口/用户名（口令类 input 排除）
      const fields = [...document.querySelectorAll('.add-host input')].filter(i => i.type !== 'password');
      if (fields.length < 4) {{ title('FAIL-fields'); return; }}
      setVal(fields[0], 't40-真机密钥');
      setVal(fields[1], '127.0.0.1');
      setVal(fields[2], '2222');
      setVal(fields[3], 'root');
      title('s5-filled');
      const save = await waitFor(() => [...document.querySelectorAll('.add-host button')]
        .find(b => b.textContent.includes('保存并连接')), 20);
      if (!save) {{ title('FAIL-no-save'); return; }}
      save.click();
      title('s6-saving');
      const trustBtn = await waitFor(() => [...document.querySelectorAll('.hk-dialog button')]
        .find(b => b.textContent.includes('信任并连接')), 80);
      if (!trustBtn) {{ title('FAIL-no-tofu'); return; }}
      title('s7-tofu-dialog');
      trustBtn.click();
      const term = await waitFor(() => {{
        const t = document.querySelector('#term .xterm-rows');
        return t && (t.textContent || '').length > 5 ? t : null;
      }}, 150);
      if (!term) {{ title('FAIL-no-term'); return; }}
      title('s8-term-alive');
      const focus = document.querySelector('.xterm-helper-textarea');
      if (focus) focus.focus();
      // T41：真实 app 的 SFTP 浏览器命令实证（直调 internals invoke，绕开 UI 交互）
      const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
      const ses = await inv('list_sessions', {{}});
      const cur = (ses && ses[0] && ses[0].id) || '';
      if (cur) {{
        const es = await inv('sftp_list', {{ sid: cur, path: '/root' }});
        title('sftp|n=' + es.length + '|' + es.slice(0, 3).map((e) => (e.is_dir ? 'D:' : 'F:') + e.name).join(','));
      }}
      // T43：进程内 MCP 端点实证——mcp_status 应回真实绑定地址（含实际端口），
      // 仍是占位文案（含「递增」字样）即 FAIL（审核低-3：占位回归要被门拦住）
      const ms = await inv('mcp_status', {{}});
      const ep = (ms && ms.endpoint) || '';
      if (!ep || ep.includes('递增')) {{ title('FAIL-mcp-placeholder|' + ep); return; }}
      title('mcp|' + ep);
      // 补口（T43 增记）：签发真实 token 经 beacon 交给 shell 侧，由外部带 token
      // 发 MCP initialize——补齐「真 token 经内嵌端点握手成功」的真机直接证据
      // （token 仅落隔离 DB /tmp/smoke + 本机 beacon，跑完即弃）
      const tok = await inv('issue_agent', {{ id: 'smoke-agent', label: '真机冒烟 Agent' }});
      title('agent-token|' + (tok || 'NONE'));
      // T44（真机）：Agent 转发审批链——shell 侧 Agent 持真实 token 经内嵌
      // MCP 端点发 forward_start/forward_stop（阻塞等人工），本脚本扮演人工：
      // 轮询待批卡→批准，同时观测转发状态机（Listening→停止→Degraded）。
      // 卡→批→banner→停卡→批→空→坏目标→Degraded 全部经 beacon 行对账；
      // 转发/停止卡 editable=false 也是 T44 修复批的真机断言点。
      title('session-id|' + cur);
      const approvedIds = new Set();
      let lastSig = '\u0000';
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {{
        const cards = await inv('list_approvals', {{ pendingOnly: true }});
        const c = cards && cards[0];
        if (c && !approvedIds.has(c.id)) {{
          approvedIds.add(c.id);
          title('fwd-card|' + (c.command || '').slice(0, 48) + '|editable=' + (c.editable === true));
          try {{
            await inv('decide_approval', {{ id: c.id, decision: 'approve' }});
            title('fwd-approved|' + String(c.id).slice(0, 8));
          }} catch (e) {{
            title('fwd-approve-err|' + e);
          }}
        }}
        const fs = cur ? await inv('list_forwards', {{ sid: cur }}) : [];
        const sig = (fs || []).map((f) => String(f.id).slice(0, 8) + ':' + f.state).join(',');
        if (sig !== lastSig) {{
          lastSig = sig;
          const err0 = (fs && fs[0] && fs[0].error) || '';
          title('fwd-state|' + sig + (err0 ? '|err=' + String(err0).slice(0, 48) : ''));
        }}
        const done = await fetch('http://127.0.0.1:15199/q/AGENT-DONE')
          .then((r) => r.ok).catch(() => false);
        if (done) break;
        await sleep(400);
      }}
      title('DONE');
    }} catch (e) {{
      title('FAIL|' + e);
    }}
  }})();
}})();"#
                )
                };
                std::fs::write("/tmp/t40_smoke/last_smoke_script.js", &script).ok();
                let r = webview.eval(&script);
                eprintln!("[app] smoke script injected: {r:?}");
            }
        })
        .setup(move |app| {
            use tauri::Manager as _;
            eprintln!("[app] setup: windows={:?}", app.webview_windows().keys().collect::<Vec<_>>());
            // 窗口创建移入 setup（tauri.conf create:false）：为了在创建期按环境变量
            // 注入 WebView 附加参数。wry 程序化参数优先级高于 WEBVIEW2_ADDITIONAL_
            // BROWSER_ARGUMENTS 环境变量（实测被忽略），CDP 自动化验收（远程调试口）
            // 只能走这里。未设 TINYSSH_WEBVIEW_ARGS 时复刻 wry 默认参数，行为零变化。
            // 移动端不建窗：webview 由 Android/iOS 宿主创建，这里再建会冲突。
            #[cfg(desktop)]
            {
                let wcfg = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .cloned()
                    .ok_or("tauri.conf 缺 main 窗口")?;
                let mut b = tauri::webview::WebviewWindowBuilder::from_config(app.handle(), &wcfg)?;
                if let Ok(extra) = std::env::var("TINYSSH_WEBVIEW_ARGS") {
                    if !extra.trim().is_empty() {
                        b = b.additional_browser_args(&format!(
                            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {extra}"
                        ));
                    }
                }
                b.build()?;
            }
            // SMOKE 冒烟专用：窗口置顶聚焦。WKWebView 会冻结不可见窗口的页面 JS
            //（信标停摆的根因），冒烟运行约 20s 即被外部终止，产品路径不受影响。
            #[cfg(desktop)]
            if std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.set_always_on_top(true);
                }
            }
            install_native_ctrl_intercept(api.clone(), terminal_input.clone());
            // T34：原生菜单栏 + 「设置…⌘,」→ 前端事件（打开显示设置面板）
            #[cfg(desktop)]
            if let Err(e) = install_native_menu(app.handle()) {
                eprintln!("[app] native menu install failed: {e}");
            }
            // R13 冒烟：menu-settings→统一分发的 FE 半链路实证。NSMenu 项命中与
            // ⌘, 加速器最终都走 app.emit("menu-settings")（上一行 on_menu_event）。
            // 冒烟模式轮询信标日志等脚本 armed 后补发同一事件（rev-r13 低-5：
            // 定时 emit 与冷启动进度有竞态；信标日志每轮按规程清空，无误触）。
            #[cfg(desktop)]
            if std::env::var("TINYSSH_SMOKE").map(|v| v == "1").unwrap_or(false)
                && std::env::var("TINYSSH_SMOKE_MODE").map(|v| v == "r13").unwrap_or(false)
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
                    loop {
                        if std::time::Instant::now() > deadline { break; }
                        if let Ok(s) = std::fs::read_to_string("/tmp/t40_smoke/beacon.log") {
                            if s.contains("r13-armed-menu") {
                                let _ = handle.emit("menu-settings", ());
                                break;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                });
            }
            // 原生菜单只在桌面装配；移动端没有菜单栏，事件源不存在。
            #[cfg(desktop)]
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    let _ = app.emit("menu-settings", ());
                    eprintln!("[app] menu: settings requested");
                } else if event.id() == "select-all" {
                    // 原生菜单已消费 ⌘A；由前端按焦点决定全选终端缓冲还是输入框。
                    let _ = app.emit("menu-select-all", ());
                } else if event.id() == "quit" {
                    // 菜单项不再是预定义 quit（那会直接 NSApp terminate 绕过确认）：
                    // 与窗口关闭共用同一道退出确认。
                    arm_close_guard(app);
                }
            });
            if let Some(w) = app.get_webview_window("main") {
                let r = w.eval("window.__TINYSSH_PROBE__ = 'set-by-rust'; 'ok';");
                eprintln!("[app] eval probe: {r:?}");
                let url = w.url();
                eprintln!("[app] window url: {url:?}");
            } else {
                eprintln!("[app] NO main window!");
            }
            // 审批事件 → 前端
            let handle = app.handle().clone();
            let rx = api.subscribe_approvals();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle.emit("approval-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 转发状态事件 → 前端（T44 真机冒烟补口：WKWebView 节流 timer 时
            // UI 的 3s 盲轮询挂起，Agent 建的转发对人工不可见——事件驱动补数据面可见性）
            let handle_fwd = app.handle().clone();
            let fwd_rx = api.subscribe_forwards();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(fwd_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_fwd.emit("forward-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 主机指纹待决事件 → 前端（路线图⑤）
            let handle_hk = app.handle().clone();
            let hk_rx = api.subscribe_host_keys();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(hk_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_hk.emit("hostkey-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // 2FA 认证提示事件 → 前端（路线图⑩）
            let handle_ap = app.handle().clone();
            let ap_rx = api.subscribe_auth_prompts();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(ap_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_ap.emit("authprompt-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C1 建连尝试事件 → 前端（R19，沿 approval-event 桥模式）
            let handle_conn = app.handle().clone();
            let conn_rx = api.subscribe_connections();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(conn_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_conn.emit("connection-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C3 shell 集成状态事件 → 前端（R24，同桥模式）
            let handle_shell = app.handle().clone();
            let shell_rx = api.subscribe_shell_integration();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(shell_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_shell.emit("shell-integration-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // R26（§6.4）：会话状态事件（断线/自动重连次数/重确认）即时推送——
            // 3s 列表轮询只做兜底对账，横幅与重试计数不进盲窗。
            let handle_state = app.handle().clone();
            let state_rx = api.center.state_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(state_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        // 会话已关闭（无论关闭入口是 GUI、MCP 还是 CLI）：撤内置
                        // Agent 槽位/转写并取消在途运行，避免后台继续烧 token。
                        if ev.state == SessionState::Closed {
                            agent_host_for_state.close(&ev.session_id);
                        }
                        let _ = handle_state.emit("session-state", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // P2-b：输出触发器命中事件 → 前端 toast/铃（同桥模式）
            let handle_trigger = app.handle().clone();
            let trigger_rx = api.center.trigger_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(trigger_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_trigger.emit("trigger-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // C5（R32）：传输任务事件（进度/状态，revision 单调）即时推送——
            // 任务卡不进轮询盲窗；漏收由 list_transfers 查询对账兜底。
            let handle_xfer = app.handle().clone();
            let xfer_rx = api.transfer_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = tokio_stream::wrappers::BroadcastStream::new(xfer_rx);
                while let Some(ev) = stream.next().await {
                    if let Ok(ev) = ev {
                        let _ = handle_xfer.emit("transfer-event", serde_json::to_value(ev).unwrap_or_default());
                    }
                }
            });
            // dev harness：TINYSSH_AUTOCONNECT=host_id[,host_id] 启动即建会话（原生走查用）
            if let Ok(list) = std::env::var("TINYSSH_AUTOCONNECT") {
                let api2 = api.clone();
                tauri::async_runtime::spawn(async move {
                    for host_id in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                        match api2
                            .create_session(&Actor::Human, CreateSessionReq { host_id: host_id.to_string() })
                            .await
                        {
                            Ok(sid) => eprintln!("[app] autoconnect {host_id} -> {sid}"),
                            Err(e) => eprintln!("[app] autoconnect {host_id} failed: {e}"),
                        }
                    }
                });
            }
            // T20 走查辅助（仅 dev 构建 + TINYSSH_TEST_DRAG=1 双重门禁）：OS 级拖拽投递
            // （Finder→WKWebView 的 NSDraggingSession）在双屏+多 Space 环境无法脚本化驱动
            // （§5.14 披露），此钩子监听 /tmp/t20_drag_{enter,over,drop,leave} 触发器文件，
            // 发出与 WKWebView 拖拽回调载荷完全同构的事件；事件之后的整条链路（UI 处理器 →
            // upload_file 命令 → core-session → russh-sftp → 远端落盘 → 审计）全部真实执行。
            if cfg!(debug_assertions)
                && std::env::var("TINYSSH_TEST_DRAG").map(|v| v == "1").unwrap_or(false)
            {
                let handle_td = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        for (name, event) in [
                            ("enter", "tauri://drag-enter"),
                            ("over", "tauri://drag-over"),
                            ("leave", "tauri://drag-leave"),
                            ("drop", "tauri://drag-drop"),
                        ] {
                            let p = std::path::PathBuf::from(format!("/tmp/t20_drag_{name}"));
                            if !p.exists() {
                                continue;
                            }
                            let mut paths: Vec<String> = Vec::new();
                            if name == "enter" || name == "drop" {
                                paths = std::fs::read_to_string(&p)
                                    .unwrap_or_default()
                                    .lines()
                                    .filter(|l| !l.trim().is_empty())
                                    .map(str::to_string)
                                    .collect();
                            }
                            let _ = std::fs::remove_file(&p);
                            let payload = serde_json::json!({
                                "paths": paths,
                                "position": { "x": 0.0, "y": 0.0 },
                            });
                            if let Some(w) = handle_td.get_webview_window("main") {
                                let _ = w.emit(event, payload);
                                eprintln!("[app] test drag {name} paths={paths:?}");
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts, upsert_host, delete_host, create_identity, list_identities, delete_identity,
            ssh_config_preview, ssh_config_import,
            list_sessions, session_detail, create_session, begin_connection, begin_connection_draft, connection_status, cancel_connection, set_session_logging, session_log_path,
            close_session, reconnect_session, stop_auto_reconnect, tmux_probe, tmux_wall_snapshot, tmux_wall_input, tmux_wall_fit, tmux_wall_fit_restore, tmux_session_create, tmux_restore,
            tmux_attach, tmux_detach, tmux_pane_open, tmux_pane_close, tmux_pane_resize, tmux_pane_input,
            tmux_pane_subscribe, session_state_feed, resize, subscribe_output,
            unsubscribe_output, resync_output, debug_subscriptions,
            open_url,
            upload_file, download_file, cancel_transfer, list_transfers, retry_transfer, reveal_path, open_path, submit_collision_decision, reject_expired_decision, verify_transfer_outcome, sftp_list, sftp_resolve_path, sftp_stat, sftp_delete, sftp_rename,
            pick_upload_files, pick_save_file, pick_save_dir,
            list_forwards, start_forward, stop_forward,
            get_setting, set_setting, get_workspace, set_workspace, set_host_favorite,
            scan_paste_danger,
            list_host_metadata, list_recent_hosts,
            read_screen, pty_size, send_keys, exec_human, read_host_metrics, read_npu_metrics, read_self_metrics, set_control, delegate_session, session_brief, set_session_goal, read_blocks, read_triggers, save_triggers, read_restore,
            get_build_time,
            check_update, export_diagnostics, updater_info, updater_install,
            agent_model_get, agent_model_set, agent_send, agent_cancel, agent_cancel_model, agent_history,
            shell_capability,
            list_local_shells,
            list_approvals, decide_approval, remember_approval, audit_query, issue_agent, revoke_agent, mcp_status, set_autonomy, autonomy_list, query_records, export_records,
            collab_status, collab_disable_preview, collab_disable, collab_enable,
            pending_host_keys, decide_host_key, pending_auth_prompts, answer_auth_prompt,
            bench_start, bench_report, bench_mode, note_terminal,
            quit_app, cancel_app_close,
        ])
        .on_window_event(move |window, event| {
            use tauri::Manager as _;
            // R23 §6.4 退出契约：主窗口关闭=请求退出，交 FE 汇总确认（活动会话/转发/
            // 未知传输），不引入「窗口已关但后台仍跑」的新模式
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                arm_close_guard(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle: &tauri::AppHandle, event| {
        // KI-011：macOS 菜单 ⌘Q 的预定义 quit 会直接 NSApp terminate（不经本事件），
        // 已改为普通菜单项 + on_menu_event 武装同一道确认（见 commands/native.rs）。
        // 这里保留 ExitRequested 兜底：窗口全部销毁（code=None）等系统级退出仍须确认；
        // 带退出码的一律放行——quit_app 的 app.exit(0)、Windows 便携更新的
        // app.exit(0)、mac 更新的 restart（RESTART_EXIT_CODE）都是程序化受控退出。
        // confirmed 是二次保险，防止将来出现不带 code 的受控退出口被误拦。
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            use tauri::Manager as _;
            let guard = app_handle.state::<Arc<CloseGuard>>();
            if code.is_some() || guard.confirmed.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            arm_close_guard(app_handle);
        }
    });
}

/// 武装退出确认并启动看护线程：主窗口关闭与系统级退出（macOS ⌘Q/菜单）共用，
/// 避免两处判定与兜底各写一份而漂移。调用方负责先 prevent_close/prevent_exit。
fn arm_close_guard(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let guard = app.state::<Arc<CloseGuard>>();
    // 新一次用户退出请求：清掉上一次的受控放行标记，避免「置 confirmed 却没退成」
    // 的残留让后续 ⌘Q 静默绕过确认。
    guard
        .confirmed
        .store(false, std::sync::atomic::Ordering::SeqCst);
    // pending 存「当前请求代际」，0=空闲：fetch_max 同时完成「顶替旧请求」与
    // 「代际只增不减」——并发请求不会把更大的代际覆盖回较小值，旧看护线程据
    // 代际不匹配自然退出，不存在 bool 与 gen 分离时旧线程清新代 pending 的窗口。
    let gen = guard.gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let _ = guard
        .pending
        .fetch_max(gen, std::sync::atomic::Ordering::SeqCst);
    // 每次请求都亮窗并重新发事件：首次 emit 可能落在 webview 尚未挂 listen 的
    // 冷启动窗口里（或窗口最小化/隐藏时被节流），若因为「已在等待」而吞掉后续
    // 请求，确认框会永远不出现，直到看护线程 90s 超时才恢复。
    if let Some(wv) = app.get_webview_window("main") {
        let _ = wv.show();
        // 只 show 不够：⌘M 最小化时 macOS makeKeyAndOrderFront 不会把窗口
        // 拉出 Dock，set_focus 在 isMiniaturized 时也会被跳过，确认框不可见。
        #[cfg(desktop)]
        let _ = wv.unminimize();
        let _ = wv.set_focus();
    }
    let _ = app.emit("app-close-requested", ());
    // 兜底看护（稳定轮余量项）：webview 死亡时 FE 永远收不到事件、quit_app 永远
    // 不会被调——应用就永远退不掉。看护线程每 2s 用 eval 探活：webview 死（eval
    // 报错）即强退；确认对话超 90s 无人应答则解除 pending（人在犹豫，不强杀活
    // 会话），下次退出请求重新武装。
    let g = guard.inner().clone();
    let w = app.get_webview_window("main");
    std::thread::spawn(move || {
        for _ in 0..45 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if g.pending.load(std::sync::atomic::Ordering::SeqCst) != gen {
                return;
            }
            let alive = match &w {
                Some(wv) => wv.eval("void 0").is_ok(),
                None => false,
            };
            if !alive {
                // eval 已越过上面的代际检查才失败时，用户可能刚点了确认（更新器
                // 重启正在 teardown）：再看一眼 confirmed，并用 CAS 抢占本代。
                // confirm/cancel 都会把 pending 清零，CAS 失败说明已有受控退出/
                // 取消在进行——此处强退会抢在 restart 前 exit(0)，mac 更新就只
                // 退不重启。成功抢占才说明确实是「webview 死且无人应答」。
                if g.confirmed.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                if g.pending
                    .compare_exchange(
                        gen,
                        0,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    tracing::error!("webview 已死且退出确认无应答——强制退出");
                    std::process::exit(0);
                }
                return;
            }
        }
        // 只清自己这一代：compare_exchange 失败说明已被新请求顶替/已取消
        let _ = g.pending.compare_exchange(
            gen,
            0,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        );
    });
}

/// 标记本次退出为受控退出：`quit_app`（FE 确认后）与更新器重启在退出前置位，
/// ExitRequested 守卫据此放行。程序化退出本就带 code，confirmed 只是二次保险。
pub(crate) fn confirm_controlled_exit(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let guard = app.state::<Arc<CloseGuard>>();
    // 先置 confirmed 再清 pending：看护线程在 eval 返回后会先看 confirmed、
    // 再 CAS pending，两步之间任何交错都能看到「已受控」而不强退；反过来先清
    // pending 则存在「看护已越过确认检查、尚未退出的窗口」。同时解除看护：
    // 确认后 teardown 可能让 eval 探活失败，旧逻辑会抢在 restart/cleanup 前
    // process::exit(0)，mac 更新就只退不重启。
    guard
        .confirmed
        .store(true, std::sync::atomic::Ordering::SeqCst);
    guard.pending.store(0, std::sync::atomic::Ordering::SeqCst);
}

/// 窗口关闭确认态（稳定轮·窗口关闭兜底）：pending=当前退出请求代际（0=空闲）；
/// gen=代际发号器（每次退出请求递增，看护线程据此识别被顶替的请求）；
/// confirmed=受控退出已获 FE 确认（ExitRequested 守卫放行依据，见
/// `confirm_controlled_exit`）。
#[derive(Default)]
struct CloseGuard {
    pending: std::sync::atomic::AtomicU64,
    gen: std::sync::atomic::AtomicU64,
    confirmed: std::sync::atomic::AtomicBool,
}

/// FE 用户在退出确认对话框点了「取消」：解除关闭看护（webview 存活即继续用）。
/// webview 死亡时 FE 到不了这里——由看护线程的 eval 探活强制退出兜底。
#[tauri::command]
fn cancel_app_close(guard: tauri::State<'_, Arc<CloseGuard>>) {
    guard.pending.store(0, std::sync::atomic::Ordering::SeqCst);
}

/// R23：FE 汇总确认「结束会话并退出」后的受控退出（不用 destroy 绕过窗口事件）。
/// rev-r47：退出前撤下端点自发现文件（进程退出后端点不复存在，陈旧文件误导 Agent）。
/// P3：退出前采集会话现场快照（C10 checkpoint 裁尾入 vault KV，加密；下次启动
/// 欢迎页「恢复上次现场」数据源）——强杀/崩溃来不及快照，如实只覆盖受控退出。
#[tauri::command]
async fn quit_app(app: tauri::AppHandle, state: ApiState<'_>) -> CmdResult<()> {
    refresh_endpoint_file(&state.api, None);
    let n = state.api.capture_restore_snapshots().await;
    if n > 0 {
        tracing::info!("退出快照：已存 {n} 个会话现场");
    }
    // 稳定轮（余量项）：退出前主动收口会话——远端 shell 干净断开、审批作废/
    // 会话行收口走同一 close_session 口径；卡住的会话按 shutdown_all 内部
    // 预算强制摘表，退出不被网络悬挂拖住。
    let closed = state.api.shutdown_all().await;
    if closed > 0 {
        tracing::info!("退出收口：已关闭 {closed} 个会话");
    }
    // KI-011：先置 confirmed 再 exit——否则 ExitRequested 守卫会把它当成用户发起
    // 的退出再次拦截，确认对话打完却退不出去。
    confirm_controlled_exit(&app);
    app.exit(0);
    Ok(())
}

/// P3：读会话现场快照条目（欢迎页恢复入口数据源）。损坏/缺省如实给空表。
#[tauri::command]
async fn read_restore(state: ApiState<'_>) -> CmdResult<Vec<core_session::restore::RestoreEntry>> {
    Ok(state.api.read_restore_snapshots().await)
}

// ── 内置 Agent（接真模型轮）：模型服务配置 + 会话内对话 ──

pub(crate) fn dirs_or_home() -> std::path::PathBuf {
    // Windows 原生环境（Explorer/开始菜单启动）通常无 HOME——只认 HOME 会回退 "."，
    // DB/下载目录变成相对 CWD（装进 Program Files 即不可写、启动即 open storage 失败；
    // 审计 W1）。回退 USERPROFILE 与 CLI 侧 dirs::home_dir() 同义，GUI/CLI 必须同库。
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// 默认存储库路径：桌面 = 家目录；移动端 = 应用私有 files 目录。
///
/// Android 进程没有 HOME，CWD 是只读的 `/`，回退 "." 会直接开库失败。私有目录
/// 只能经 JNI 的 `Context.getFilesDir()` 拿（多用户/工作资料下路径不是固定的）。
fn default_db_path() -> std::path::PathBuf {
    #[cfg(feature = "mobile")]
    {
        if let Some(dir) = android_files_dir() {
            return dir.join(".tinyssh").join("tinyssh.db");
        }
    }
    dirs_or_home().join(".tinyssh").join("tinyssh.db")
}

/// Android 应用私有 files 目录（`/data/user/<uid>/<pkg>/files`）。
#[cfg(feature = "mobile")]
fn android_files_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "android")]
    {
        // SAFETY: Tauri/wry 的 JNI 入口在调用 run() 前初始化 ndk-context，
        // 其中保存的是进程生命期有效的全局引用。
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
        let mut env = vm.attach_current_thread().ok()?;
        let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let file = env
            .call_method(context, "getFilesDir", "()Ljava/io/File;", &[])
            .ok()?
            .l()
            .ok()?;
        let path = env
            .call_method(&file, "getAbsolutePath", "()Ljava/lang/String;", &[])
            .ok()?
            .l()
            .ok()?;
        let path: jni::objects::JString = path.into();
        let path = env.get_string(&path).ok()?.to_string_lossy().into_owned();
        Some(std::path::PathBuf::from(path))
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

#[cfg(test)]
mod wire_error_tests {
    use super::WireError;
    use session_api::Error as E;

    /// R10 验收「wire 枚举一致」：session-api::Error 全变体 → kind 稳定映射。
    /// 新增变体漏配时 match 非穷尽即编译失败；本测试钉住 kind 字符串契约值。
    #[test]
    fn every_variant_maps_to_stable_kind() {
        let e = E::Io("x".into());
        assert_eq!(WireError::from(e).kind, "io");
        assert_eq!(WireError::from(E::Storage("s".into())).kind, "storage");
        assert_eq!(
            WireError::from(E::InvalidInput("i".into())).kind,
            "invalid_input"
        );
        assert_eq!(WireError::from(E::InvalidActor).kind, "invalid_actor");
        let qb = WireError::from(E::QueueBusy { position: 3 });
        assert_eq!(qb.kind, "queue_busy");
        assert_eq!(qb.detail.as_ref().unwrap()["position"], 3);
        assert_eq!(WireError::from(E::Cancelled).kind, "cancelled");
        assert_eq!(WireError::from(E::ExecTimeout).kind, "exec_timeout");
        assert_eq!(
            WireError::from(E::HostKeyRejected("fp".into())).kind,
            "host_key_rejected"
        );
        let cf = WireError::from(E::ConnectFailed("refused".into()));
        assert_eq!(cf.kind, "connect_failed");
        assert_eq!(cf.detail.as_ref().unwrap()["reason"], "refused");
        assert_eq!(WireError::from(E::AuthFailed).kind, "auth_failed");
        assert_eq!(WireError::from(E::SessionClosed).kind, "session_closed");
        assert_eq!(
            WireError::from(E::SessionNotFound).kind,
            "session_not_found"
        );
        assert_eq!(
            WireError::from(E::ReconfirmingPending).kind,
            "reconfirming_pending"
        );
        assert_eq!(
            WireError::from(E::ControlTakenByHuman).kind,
            "control_taken_by_human"
        );
        assert_eq!(
            WireError::from(E::VoidedByHandback {
                brief: Box::new(session_api::SessionBrief {
                    cwd: None,
                    env_summary: String::new(),
                    facts: Vec::new(),
                    running: Vec::new(),
                    pending_approvals: Vec::new(),
                    screen_summary: String::new(),
                    goal: None,
                }),
            })
            .kind,
            "voided_by_handback"
        );
        assert_eq!(
            WireError::from(E::ApprovalDenied {
                reason: session_api::DeniedReason::Denied,
            })
            .kind,
            "approval_denied"
        );
        // 人话文案保留（friendlyError 依赖 message）
        let m = WireError::from(E::AuthFailed).message;
        assert!(!m.is_empty());
        // 壳层直造错误走 invalid_input / io
        assert_eq!(WireError::from("bad".to_string()).kind, "invalid_input");
        assert_eq!(WireError::from(std::io::Error::other("no")).kind, "io");
        // serde 序列化形态：{kind, message[, detail]}
        let v = serde_json::to_value(WireError::from(E::AuthFailed)).unwrap();
        assert_eq!(v["kind"], "auth_failed");
        assert!(v.get("detail").is_none());
    }
}
