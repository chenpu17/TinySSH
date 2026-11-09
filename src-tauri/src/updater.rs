//! 应用内更新：版本检查、签名清单校验、Windows 便携自替换。
//!
//! 从 main.rs 抽出（第二波结构拆分）：更新链路是独立的安全敏感面
//! （验签、防降级重定向、换身重启），与命令接线分开后更容易单独审阅与测试。

use crate::commands::refresh_endpoint_file;
use crate::{ApiState, CmdResult, WireError};
use tauri::Emitter;

// ---- 应用内更新检查（check_update）：GitHub releases/latest 只读探测 ----

/// 更新检查唯一出处：GitHub API 要求 UA；Accept 走官方 vendor 头。
const RELEASE_API: &str = "https://api.github.com/repos/chenpu17/TinySSH/releases/latest";
/// 总超时（连接+响应全程）：应用内静默检查，5 秒拿不到就当失败静默。
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// releases/latest 响应里用得到的字段（其余忽略；缺字段按解析失败走）。
#[derive(serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
}

/// check_update 过桥结构：任一环节失败都不 Err——has_update=false + error
/// 带一句中文原因，前端据此静默。latest/url 失败时为 null。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    current: String,
    latest: Option<String>,
    has_update: bool,
    url: Option<String>,
    error: Option<String>,
}

impl UpdateCheck {
    fn failed(current: &str, reason: String) -> Self {
        Self {
            current: current.to_string(),
            latest: None,
            has_update: false,
            url: None,
            error: Some(reason),
        }
    }
}

/// 版本分段解析：按「.」切成数字段；出现空段/非数字段即 None
/// （调用方按「无法比较」处理，绝不误报更新；不要求 pre-release 语义，
/// v0.11.0-beta 之类自然落 None）。
fn parse_version_parts(s: &str) -> Option<Vec<u64>> {
    let s = s.trim();
    let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for seg in s.split('.') {
        // 全数字才收（不允许符号/空白/后缀）；段空（"1..2"）同样拒绝
        if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // 已验全数字，不会 parse 失败；u64 溢出的天文数字段同样拒绝
        parts.push(seg.parse::<u64>().ok()?);
    }
    Some(parts)
}

/// 版本比较纯函数：逐段数字比较，缺段视作 0（1.2 < 1.2.1）；任一侧
/// 无法解析 → None。Some(Equal) 即同版本。
fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (pa, pb) = (parse_version_parts(a)?, parse_version_parts(b)?);
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return Some(other),
        }
    }
    Some(std::cmp::Ordering::Equal)
}

/// 拉取并比较最新版本。永不 panic、永不 Err：失败折算成 has_update=false
/// + 中文 error（前端静默，不打扰）。
async fn fetch_latest_release(current: &str) -> UpdateCheck {
    let client = match update_http_client(current) {
        Ok(c) => c,
        Err(e) => return UpdateCheck::failed(current, e),
    };
    let resp = match client
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return UpdateCheck::failed(current, format!("网络请求失败：{e}")),
    };
    if !resp.status().is_success() {
        return UpdateCheck::failed(current, format!("更新服务返回异常状态：{}", resp.status()));
    }
    let release: GhRelease = match resp.json().await {
        Ok(r) => r,
        Err(e) => return UpdateCheck::failed(current, format!("更新信息解析失败：{e}")),
    };
    // tag 形如 v0.10.1：去 v 前缀后与当前版本同口径比较
    let latest = release.tag_name.trim();
    let latest = latest.strip_prefix(['v', 'V']).unwrap_or(latest);
    match compare_versions(current, latest) {
        Some(std::cmp::Ordering::Less) => UpdateCheck {
            current: current.to_string(),
            latest: Some(latest.to_string()),
            has_update: true,
            url: Some(release.html_url),
            error: None,
        },
        Some(_) => UpdateCheck {
            current: current.to_string(),
            latest: Some(latest.to_string()),
            has_update: false,
            url: Some(release.html_url),
            error: None,
        },
        None => UpdateCheck::failed(current, "版本号无法比较（远端版本格式异常）".into()),
    }
}

/// 改道模式（TINYSSH_UPDATER_ENDPOINT）：检测与安装同一出处——hasUpdate 与
/// 可安装的清单就是同一份文件。url 取本平台条目的下载直链（无发布页概念）。
async fn fetch_latest_from_manifest(current: &str, endpoint: &str) -> UpdateCheck {
    let client = match update_http_client(current) {
        Ok(c) => c,
        Err(e) => return UpdateCheck::failed(current, e),
    };
    let resp = match client.get(endpoint).send().await {
        Ok(r) => r,
        Err(e) => return UpdateCheck::failed(current, format!("网络请求失败：{e}")),
    };
    if !resp.status().is_success() {
        return UpdateCheck::failed(current, format!("更新服务返回异常状态：{}", resp.status()));
    }
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return UpdateCheck::failed(current, format!("更新清单下载失败：{e}")),
    };
    let manifest = match UpdateManifest::parse(&body) {
        Ok(m) => m,
        Err(e) => return UpdateCheck::failed(current, e),
    };
    let v = manifest.version.trim();
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    let url = manifest
        .platforms
        .get(UPDATE_PLATFORM_PORTABLE)
        .map(|e| e.url.clone());
    match compare_versions(current, v) {
        Some(std::cmp::Ordering::Less) => UpdateCheck {
            current: current.to_string(),
            latest: Some(v.to_string()),
            has_update: true,
            url,
            error: None,
        },
        Some(_) => UpdateCheck {
            current: current.to_string(),
            latest: Some(v.to_string()),
            has_update: false,
            url,
            error: None,
        },
        None => UpdateCheck::failed(current, "版本号无法比较（远端版本格式异常）".into()),
    }
}

/// 应用内版本检查（版本号轮）：与 GitHub 最新 release 比对。当前版本取
/// package_info（与原生关于卡同一来源——版本展示单一出处）。网络/解析失败
/// 不 Err：返回 has_update=false + error，前端静默。更新通道改道（env）时
/// 检测改从清单端点取，与安装同源。
#[tauri::command]
pub(crate) async fn check_update(app: tauri::AppHandle) -> CmdResult<UpdateCheck> {
    let current = app.package_info().version.to_string();
    if let Some(ep) = updater_endpoint_override() {
        return Ok(fetch_latest_from_manifest(&current, &ep).await);
    }
    Ok(fetch_latest_release(&current).await)
}

// ---- 自动更新（双通道：macOS 插件 / Windows 便携自替换）----
// macOS 走 tauri-plugin-updater（app.tar.gz 安装形态）；Windows 便携单文件 exe
// 不是插件支持的安装形态（仅 NSIS/MSI），走下方自研「下载→验签→改名自替换→
// 带旗标重启」通道。两通道吃同一份 latest.json（CI 生成的 tauri updater 清单），
// supported 只在构建带真公钥时为 true（channel 字段区分通道）；未配公钥的构建
// 与 Linux 走 check_update + 发布页。公钥编译期注入：CI 在 secrets 里有
// TAURI_UPDATER_PUBKEY 时导出给 rustc（option_env!），本地构建/未配密钥时为
// 占位符——占位符下 check/install 会如实报错，但注册与启动零风险（插件注册期
// 不校验公钥）。

const UPDATER_ENDPOINT: &str =
    "https://github.com/chenpu17/TinySSH/releases/latest/download/latest.json";
/// 便携自更新清单里本平台的条目键（tauri updater 清单平台命名）。
const UPDATE_PLATFORM_PORTABLE: &str = "windows-x86_64";
const UPDATER_PUBKEY_PLACEHOLDER: &str = "UNCONFIGURED_UPDATER_PUBKEY";

/// 更新通道改道（真机走查本地假源 / 将来镜像源）：设置后检测（check_update）
/// 与安装（updater_install）都从该端点取同一份清单，看到同一个世界。签名校验
/// 不受改道影响——公钥编译期注入，改道端点给不出有效签名同样装不上（最坏=
/// 降级到旧的真签名版本，与插件未签名清单同一威胁水位）。
/// 安全面：仅接受 https，或 loopback 上的 http（本机走查假源）；其余一律忽略
/// 改道回落默认端点，不静默。
fn updater_endpoint_override() -> Option<String> {
    let v = std::env::var("TINYSSH_UPDATER_ENDPOINT").unwrap_or_default();
    let v = v.trim().to_string();
    if v.is_empty() {
        return None;
    }
    if !endpoint_override_allowed(&v) {
        tracing::warn!("TINYSSH_UPDATER_ENDPOINT={v} 不是 https/loopback，忽略改道");
        return None;
    }
    Some(v)
}

/// 改道端点安全门（纯函数供单测）：https 恒可；http 仅 loopback（127.0.0.1/
/// ::1/localhost）；无法解析的 URL 拒绝。
fn endpoint_override_allowed(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    match u.scheme() {
        "https" => true,
        "http" => {
            // IPv6 的 host_str 带 [ ] 括号（url crate 惯例），剥掉再比
            let host = u.host_str().unwrap_or("").trim_matches(['[', ']']);
            matches!(host, "127.0.0.1" | "::1" | "localhost")
        }
        _ => false,
    }
}

fn updater_endpoint() -> String {
    updater_endpoint_override().unwrap_or_else(|| UPDATER_ENDPOINT.to_string())
}

/// 重定向策略：常规跳转照跟，但 **scheme 跳变一律停**（https→http 降级、
/// 反向的 http→https 也停——更新链路没有合法的换 scheme 理由）。停在降级
/// 跳转时响应是 3xx，后续 `status().is_success()` 检查会如实报错。
fn no_downgrade_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if let Some(prev) = attempt.previous().last() {
            if prev.scheme() != attempt.url().scheme() {
                return attempt.stop();
            }
        }
        attempt.follow()
    })
}

/// 更新通道共用 HTTP 客户端：GitHub API 要求 UA；应用内检查静默 5s 全程超时
/// （启动静默探测的预算；显式点按的安装路径用 install 变体放宽）。
fn update_http_client(current: &str) -> std::result::Result<reqwest::Client, String> {
    update_http_client_with_timeout(current, UPDATE_CHECK_TIMEOUT)
}

/// 安装路径（用户显式点按）变体：清单 30s / 下载在读停滞 30s、全程 10 分钟封顶
/// ——停滞即 Err 如实报错可重试，绝不无限 pending（大陆访问 GitHub 的最常见
/// 故障模式是「连上但不吐数据」）。重定向禁跨 scheme（https→http 降级在
/// Policy 层拦下）：endpoint_override_allowed 只门初始 URL，重定向后的跳变
/// 它看不见。
fn update_http_client_for_install(current: &str) -> std::result::Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("TinySSH/{current}"))
        .redirect(no_downgrade_redirects())
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("网络客户端初始化失败：{e}"))
}

fn update_http_client_with_timeout(
    current: &str,
    total: std::time::Duration,
) -> std::result::Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("TinySSH/{current}"))
        // 与安装路径同策略：端点门只管初始 URL，https→http 降级重定向在此挡
        .redirect(no_downgrade_redirects())
        .timeout(total)
        .build()
        .map_err(|e| format!("网络客户端初始化失败：{e}"))
}

/// build.rs 恒注入（未配密钥=空串）；空串按占位符处理（updater_info.supported=false）。
pub(crate) fn updater_pubkey() -> &'static str {
    let k: &'static str = env!("TAURI_UPDATER_PUBKEY");
    if k.is_empty() {
        UPDATER_PUBKEY_PLACEHOLDER
    } else {
        k
    }
}

/// 自动更新能力面（UI 显隐依据）。
#[derive(serde::Serialize)]
pub(crate) struct UpdaterInfo {
    /// 编译期带上了真公钥（CI 配了签名 secrets 的构建）。
    configured: bool,
    /// 当前构建形态可自动更新（macOS 插件通道 / Windows 便携自替换通道）。
    supported: bool,
    /// 操作系统（std::env::consts::OS：windows/macos/linux——前端文案与边界说明用）。
    platform: String,
    /// 更新通道："plugin"=macOS 插件、"portable"=Windows 便携自替换、
    /// ""=不可用（未配公钥的构建 / Linux）。前端可据此微调文案。
    channel: String,
}

#[tauri::command]
pub(crate) fn updater_info() -> UpdaterInfo {
    let configured = updater_pubkey() != UPDATER_PUBKEY_PLACEHOLDER;
    let channel = if !configured {
        ""
    } else if cfg!(target_os = "macos") {
        "plugin"
    } else if cfg!(target_os = "windows") {
        "portable"
    } else {
        ""
    };
    UpdaterInfo {
        configured,
        supported: !channel.is_empty(),
        platform: std::env::consts::OS.into(),
        channel: channel.into(),
    }
}

/// 安装在飞闸：防连点的后端兜底（前端 disabled+busy 之外的第二道）——两次并发
/// 调用会各自下载、各自换身+spawn 新实例，第二个新实例无锁可等，只能白等 15s
/// 后吃 fatal dialog。命令任何出口经 RAII 抬闸。
static INSTALL_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_IN_FLIGHT.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// 检查并安装更新。Windows：便携自替换（下载→验签→换身→受控重启）；
/// macOS：插件通道（下载 app.tar.gz → 验签安装 → 重启），下载进度经
/// `updater-progress` 事件透传（downloaded/total 字节）；已是最新返回 Ok(false)。
#[tauri::command]
pub(crate) async fn updater_install(app: tauri::AppHandle, state: ApiState<'_>) -> CmdResult<bool> {
    use tauri_plugin_updater::UpdaterExt;
    if !updater_pubkey_configured_guard() {
        return Err(WireError::simple(
            "updater_unavailable",
            "本构建未配置自动更新签名（占位公钥）——请从发布页手动下载",
        ));
    }
    if INSTALL_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err(WireError::simple("updater_busy", "已有一次更新安装在进行"));
    }
    let _install_guard = InstallGuard;
    if cfg!(target_os = "windows") {
        let swapped = portable_update(&app).await?;
        if !swapped {
            return Ok(false);
        }
        // 受控重启：与 quit_app 同一套收口（撤端点文件/现场快照/会话收口），
        // 随后带 relaunch 旗标拉起新版再退出——vault 独占锁的交接竞态由启动期
        // 限时重试兜住（TINYSSH_UPDATE_RELAUNCH=1 时启动等待锁最长 15s）。
        refresh_endpoint_file(&state.api, None);
        let n = state.api.capture_restore_snapshots().await;
        if n > 0 {
            tracing::info!("更新重启：已存 {n} 个会话现场");
        }
        let closed = state.api.shutdown_all().await;
        if closed > 0 {
            tracing::info!("更新重启：已关闭 {closed} 个会话");
        }
        let exe = std::env::current_exe()
            .map_err(|e| WireError::simple("updater_failed", format!("定位自身失败：{e}")))?;
        if let Err(e) = std::process::Command::new(&exe)
            .env("TINYSSH_UPDATE_RELAUNCH", "1")
            .spawn()
        {
            // 换身已完成：原路径已是新版本，本次重启失败只影响「立即用上新版」——
            // 用户下次手动打开即是新版。文案如实区分「已装上」与「没重启」，避免
            // 被前端「自动更新失败」前缀读成装失败。
            return Err(WireError::simple(
                "updater_failed",
                format!("更新已装好，仅自动重启未成功——请手动重新打开 TinySSH（本次运行仍是旧版本）：{e}"),
            ));
        }
        // KI-011：ExitRequested 守卫放行受控退出——即便将来摘掉退出码也不能被拦。
        crate::confirm_controlled_exit(&app);
        app.exit(0);
        return Ok(true);
    }
    let update = app
        .updater_builder()
        // conf 内 pubkey 恒为空串（真公钥走 build.rs 编译期注入）——插件默认从
        // conf 取，不显式覆盖则验签必败。此处与 Rust 侧能力面同源。
        .pubkey(updater_pubkey())
        // 端点同源：改道 env 生效时 mac 与 Windows/检测共用同一清单出处。
        .endpoints(vec![updater_endpoint().parse().map_err(|e| {
            WireError::simple("updater_unavailable", format!("端点无效：{e}"))
        })?])
        .map_err(|e| WireError::simple("updater_unavailable", format!("端点无效：{e}")))?
        .build()
        .map_err(|e| WireError::simple("updater_unavailable", format!("更新器不可用：{e}")))?
        .check()
        .await
        .map_err(|e| WireError::simple("updater_failed", format!("更新检查失败：{e}")))?;
    let Some(u) = update else {
        return Ok(false);
    };
    // 进度累加器每次安装归零（进程级 static 会让重试从上次的值继续累加）。
    let emitter = app.clone();
    let acc = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let acc_in = acc.clone();
    u.download_and_install(
        move |chunk, total| {
            use std::sync::atomic::Ordering;
            let done = acc_in.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
            let _ = emitter.emit(
                "updater-progress",
                serde_json::json!({"downloaded": done, "total": total}),
            );
        },
        || {},
    )
    .await
    .map_err(|e| WireError::simple("updater_failed", format!("下载/安装失败：{e}")))?;
    // KI-011：restart 带 RESTART_EXIT_CODE（prevent_exit 对其本就无效），仍显式
    // 置 confirmed，与 quit_app/便携通道共用同一「受控退出」语义。
    crate::confirm_controlled_exit(&app);
    app.restart(); // -> ! ：安装成功即重启，不返回
}

fn updater_pubkey_configured_guard() -> bool {
    updater_pubkey() != UPDATER_PUBKEY_PLACEHOLDER
}

// ---- 便携自替换通道（Windows）----

/// 单次更新载荷上限（健全性闸）：便携 exe 实际 20MB 量级，512MB 远超任何合理
/// 发版——超限按下载失败处理，防清单被改指到超大文件拖死进程/撑爆内存。
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

/// latest.json 清单（tauri updater 清单格式，mac/Win 两通道共用；未知字段忽略）。
#[derive(serde::Deserialize)]
struct UpdateManifest {
    version: String,
    platforms: std::collections::HashMap<String, UpdateManifestEntry>,
}

#[derive(serde::Deserialize)]
struct UpdateManifestEntry {
    signature: String,
    url: String,
}

impl UpdateManifest {
    fn parse(bytes: &[u8]) -> std::result::Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|e| format!("更新清单解析失败：{e}"))
    }
}

/// minisign 验签（与 tauri-plugin-updater 同一管线）：公钥与签名的输入均为
/// 「minisign 文本文件内容的 base64」——公钥来自 TAURI_UPDATER_PUBKEY（编译期
/// 注入），签名来自清单 signature 字段（CI 用 `tauri signer sign` 产出的 .sig
/// 文件本身就是这层 base64：单行无换行，原文直接内嵌清单即可）。allow_legacy
/// 与插件一致取 true。
fn verify_signature_b64(
    data: &[u8],
    pubkey_b64: &str,
    signature_b64: &str,
) -> std::result::Result<(), String> {
    use base64::Engine as _;
    let decode_text = |label: &str, s: &str| -> std::result::Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .map_err(|e| format!("{label} base64 解码失败：{e}"))?;
        String::from_utf8(raw).map_err(|_| format!("{label} 内容不是 UTF-8 文本").to_string())
    };
    let pub_text = decode_text("公钥", pubkey_b64)?;
    let sig_text = decode_text("签名", signature_b64)?;
    let pk =
        minisign_verify::PublicKey::decode(&pub_text).map_err(|e| format!("公钥解析失败：{e}"))?;
    let sig =
        minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("签名解析失败：{e}"))?;
    pk.verify(data, &sig, true)
        .map_err(|e| format!("签名校验失败：{e}"))
}

/// 换身两步改名：当前程序 → .old 备份，暂存新程序 → 原名。运行中的 exe 不能
/// 覆盖但能改名（Windows 文件语义），这是便携自更新的全部秘密。两次改名背靠背
/// 同步执行，「原路径缺席窗口」只有一次系统调用。失败路径：第二步失败立即把
/// .old 改回原名（尽力回滚），旧版本继续可用。
fn swap_staged_executable(
    current: &std::path::Path,
    staged: &std::path::Path,
    backup: &std::path::Path,
) -> std::result::Result<(), String> {
    if backup.exists() {
        if let Err(e) = std::fs::remove_file(backup) {
            // 多半有进程正以 .old 为映像运行（上一轮更新重启还没退干净）——
            // 此时绝不动当前程序，保持现场完整。
            return Err(format!("残留备份 {} 删除失败：{e}", backup.display()));
        }
    }
    if let Err(e) = std::fs::rename(current, backup) {
        return Err(format!("当前程序改名失败：{e}"));
    }
    if let Err(e) = std::fs::rename(staged, current) {
        let tail = match std::fs::rename(backup, current) {
            Ok(()) => "已回滚，旧版本继续可用".to_string(),
            Err(e2) => format!("回滚也失败（旧版保留在 {}）：{e2}", backup.display()),
        };
        return Err(format!("新版就位失败：{e}；{tail}"));
    }
    Ok(())
}

/// 启动期清扫上一轮更新的尸体：.old（换身成功后的旧版备份）与 .new（写完暂存
/// 还没换身就退出的残留）。尽力而为：仍有进程以这些文件为映像时删除会失败，
/// 静默留给下次启动。只在拿到 vault 独占锁（成为唯一实例）之后调用。
#[cfg(windows)]
pub(crate) fn cleanup_update_leftovers() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    for suffix in [".old", ".new"] {
        let p = std::path::PathBuf::from(format!("{}{suffix}", exe.display()));
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 便携自更新的安装门：清单版本严格新于当前才动手。与 check_update 的
/// has_update 同一比较器同一方向（曾写反成 Greater——真机走查点按钮即
/// 「已是最新」，现由纯函数门钉死方向）。
fn should_install_portable(current: &str, manifest_version: &str) -> bool {
    let v = manifest_version.trim();
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    matches!(compare_versions(current, v), Some(std::cmp::Ordering::Less))
}

/// 便携自更新主流程（Windows）：清单 → 版本比对 → 下载（进度事件）→ 验签 →
/// 落位换身。返回 Ok(true)=换身完成待重启，Ok(false)=已是最新。此函数不动
/// 进程——收口与重启由调用方统一做。
pub(crate) async fn portable_update(
    app: &tauri::AppHandle,
) -> std::result::Result<bool, WireError> {
    let err = |kind: &str, msg: String| WireError::simple(kind, msg);
    let current = app.package_info().version.to_string();
    // 1. 清单（检测/安装同一端点；改道 env 一并在 check_update 生效）。
    //    安装路径放宽到 30s——用户显式点按，不能拿启动静默探测的 5s 预算。
    let client =
        update_http_client_for_install(&current).map_err(|e| err("updater_unavailable", e))?;
    let resp = client
        .get(updater_endpoint())
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| err("updater_failed", format!("更新清单下载失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(err(
            "updater_failed",
            format!("更新清单服务返回异常状态：{}", resp.status()),
        ));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| err("updater_failed", format!("更新清单下载失败：{e}")))?;
    let manifest = UpdateManifest::parse(&body).map_err(|e| err("updater_failed", e))?;
    let entry = manifest
        .platforms
        .get(UPDATE_PLATFORM_PORTABLE)
        .ok_or_else(|| {
            err(
                "updater_failed",
                format!("更新清单缺少 {UPDATE_PLATFORM_PORTABLE} 条目"),
            )
        })?;
    // 2. 版本：清单声明的版本必须严格更新才动手（should_install_portable 纯函数门）
    if !should_install_portable(&current, &manifest.version) {
        return Ok(false);
    }
    // 3. 下载（流式；读停滞 30s/全程 10 分钟封顶——停滞即报错可重试，绝不
    //    无限 pending；进度事件与 mac 插件通道同事件同形状，100ms 节流）。
    //    前端当前不消费该事件（按钮 busy 文案兜底），保留为将来进度 UI 的挂点。
    //    载荷直链同吃端点安全门（纵深：清单有 minisign 验签兜底内容，这里挡
    //    「把用户引去明文端点」的无谓暴露——验签最终会拦，但不该走到那一步）。
    if !endpoint_override_allowed(&entry.url) {
        return Err(err(
            "updater_failed",
            format!(
                "更新包地址不合规（仅 https；http 仅限本机回环）：{}",
                entry.url
            ),
        ));
    }
    let dl = update_http_client_for_install(&current)
        .map_err(|e| err("updater_unavailable", e))?
        .get(&entry.url)
        .timeout(std::time::Duration::from_secs(600));
    let mut resp = dl
        .send()
        .await
        .map_err(|e| err("updater_failed", format!("更新包下载失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(err(
            "updater_failed",
            format!("更新包服务返回异常状态：{}", resp.status()),
        ));
    }
    let total = resp.content_length();
    if let Some(n) = total {
        if n > MAX_UPDATE_BYTES {
            return Err(err(
                "updater_failed",
                format!("更新包体积 {} 超过上限 {MAX_UPDATE_BYTES} 字节", n),
            ));
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut acc: u64 = 0;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| err("updater_failed", format!("更新包下载中断：{e}")))?
    {
        acc += chunk.len() as u64;
        if acc > MAX_UPDATE_BYTES {
            return Err(err(
                "updater_failed",
                format!("更新包超过上限 {MAX_UPDATE_BYTES} 字节"),
            ));
        }
        bytes.extend_from_slice(&chunk);
        // 100ms 节流：逐 chunk 一次 IPC 是纯浪费；收尾一帧必发（acc==total）。
        if last_emit.elapsed() >= std::time::Duration::from_millis(100)
            || total.map_or(false, |t| acc >= t)
        {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "updater-progress",
                serde_json::json!({"downloaded": acc, "total": total}),
            );
        }
    }
    // 4. 验签（安全闸：公钥编译期注入；字节或签名任何不对即拒绝，绝不落盘）
    verify_signature_b64(&bytes, updater_pubkey(), &entry.signature)
        .map_err(|e| err("updater_failed", format!("更新包验签失败：{e}")))?;
    // 5. 落位与换身：新包以写句柄落同目录暂存名，写满后同一句柄 sync_all
    //    （Windows 的 FlushFileBuffers 要求 GENERIC_WRITE 句柄——只读句柄静默
    //    no-op，等于没 fsync），再两步改名。任何一步失败旧包原样在——.old 原地
    //    可回滚，原路径未动。
    let exe =
        std::env::current_exe().map_err(|e| err("updater_failed", format!("定位自身失败：{e}")))?;
    use std::io::Write as _;
    let staged = std::path::PathBuf::from(format!("{}.new", exe.display()));
    let backup = std::path::PathBuf::from(format!("{}.old", exe.display()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&staged)
        .map_err(|e| {
            err(
                "updater_failed",
                format!("更新包写入失败（{}）：{e}", staged.display()),
            )
        })?;
    f.write_all(&bytes).map_err(|e| {
        err(
            "updater_failed",
            format!("更新包写入失败（{}）：{e}", staged.display()),
        )
    })?;
    f.sync_all().map_err(|e| {
        err(
            "updater_failed",
            format!("更新包落盘失败（{}）：{e}", staged.display()),
        )
    })?;
    drop(f);
    swap_staged_executable(&exe, &staged, &backup)
        .map_err(|msg| err("updater_failed", format!("自替换失败：{msg}")))?;
    Ok(true)
}

#[cfg(test)]
mod update_check_tests {
    use super::{compare_versions, parse_version_parts};
    use std::cmp::Ordering::*;

    /// 版本比较门禁：相同 / 更新 / 更旧 / 位数不同 / 非法段，v 前缀剥离同测。
    #[test]
    fn version_compare_matrix() {
        // 相同
        assert_eq!(compare_versions("0.10.0", "0.10.0"), Some(Equal));
        // 更新（远端更大）
        assert_eq!(compare_versions("0.10.0", "0.10.1"), Some(Less));
        assert_eq!(compare_versions("0.9.9", "0.10.0"), Some(Less));
        // 更旧
        assert_eq!(compare_versions("0.10.1", "0.10.0"), Some(Greater));
        // 位数不同：缺段视作 0 → 1.2 < 1.2.1；补零等价
        assert_eq!(compare_versions("1.2", "1.2.1"), Some(Less));
        assert_eq!(compare_versions("1.2", "1.2.0"), Some(Equal));
        assert_eq!(compare_versions("1.2.0.0", "1.2"), Some(Equal));
        // 非法段：空串 / 空段 / 非数字 / 带后缀 / 负数形态一律 None（不误报更新）
        assert_eq!(compare_versions("", "1.0.0"), None);
        assert_eq!(compare_versions("1..2", "1.2.0"), None);
        assert_eq!(compare_versions("1.2.x", "1.2.1"), None);
        assert_eq!(compare_versions("0.10.0-beta", "0.10.0"), None);
        assert_eq!(compare_versions("1.2", "1.2.-3"), None);
        // 解析口径：v 前缀剥离、空白容忍、全数字段成功
        assert_eq!(parse_version_parts("v0.10.1").unwrap(), vec![0, 10, 1]);
        assert_eq!(parse_version_parts("V1.2").unwrap(), vec![1, 2]);
        assert_eq!(parse_version_parts(" 0.10.0 ").unwrap(), vec![0, 10, 0]);
        assert_eq!(parse_version_parts("v"), None);
        assert_eq!(parse_version_parts("1.2.3"), Some(vec![1, 2, 3]));
    }

    /// wire 形状门禁：camelCase（has_update→hasUpdate），字段恒全量出现
    /// （失败侧 latest/url/error 为 null 而非缺键——FE 据此静默）。
    #[test]
    fn update_check_wire_shape_is_camel_case() {
        let ok = super::UpdateCheck {
            current: "0.10.0".into(),
            latest: Some("0.10.1".into()),
            has_update: true,
            url: Some("https://example.invalid".into()),
            error: None,
        };
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["current"], "0.10.0");
        assert_eq!(v["latest"], "0.10.1");
        assert_eq!(v["hasUpdate"], true);
        assert_eq!(v["url"], "https://example.invalid");
        assert!(v.get("error").unwrap().is_null());
        let fail = super::UpdateCheck::failed("0.10.0", "网络请求失败：x".into());
        let v2 = serde_json::to_value(&fail).unwrap();
        assert_eq!(v2["hasUpdate"], false);
        assert!(v2.get("latest").unwrap().is_null());
        assert!(v2.get("url").unwrap().is_null());
        assert!(v2["error"].as_str().unwrap().contains("网络"));
    }
}

#[cfg(test)]
mod portable_update_tests {
    use super::{
        endpoint_override_allowed, should_install_portable, swap_staged_executable,
        verify_signature_b64, UpdateManifest, UPDATE_PLATFORM_PORTABLE,
    };

    /// 改道端点安全门：https 恒可；http 仅 loopback；其他 scheme/解析失败拒绝。
    #[test]
    fn endpoint_override_scheme_gate() {
        assert!(endpoint_override_allowed("https://gitee.com/x/latest.json"));
        assert!(endpoint_override_allowed(
            "http://127.0.0.1:18971/latest.json"
        ));
        assert!(endpoint_override_allowed("http://localhost:1/a.json"));
        assert!(endpoint_override_allowed("http://[::1]:9/x.json"));
        assert!(!endpoint_override_allowed("http://example.com/a.json"));
        assert!(!endpoint_override_allowed("ftp://example.com/a.json"));
        assert!(!endpoint_override_allowed("not a url"));
        assert!(!endpoint_override_allowed(""));
    }

    /// 安装门方向（真机走查揪出 Greater/Less 写反的回归钉）：远端新→装；
    /// 同版/更旧/非法→不装；v 前缀同剥。
    #[test]
    fn install_gate_direction() {
        assert!(should_install_portable("0.10.6", "99.0.0"));
        assert!(should_install_portable("0.10.6", "v0.11.0"));
        assert!(!should_install_portable("0.10.6", "0.10.6"));
        assert!(!should_install_portable("0.10.6", "0.10.5"));
        assert!(!should_install_portable("0.10.6", "not-a-version"));
        assert!(!should_install_portable("0.10.6", ""));
    }

    /// 测试专用签名契约（真 tauri CLI signer generate/sign 产物，密钥对仅测试
    /// 用、无生产价值）：钉死「tauri 包装 = minisign 文本文件内容的 base64」
    /// 这一格式假设——公钥/签名解析或验签管线任何走样在此直接炸出。
    const CONTRACT_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBCMDgxQTk5QzVCMUQ4NEIKUldSTDJMSEZtUm9JQzExWGp1RTEyMVpPUW4wTS9MYjdUczAxanc0MU01RVNPdUViOGxMcSs5cjEK";
    const CONTRACT_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSTDJMSEZtUm9JQzJPWHgxSE8rOHUrb0VySmFjRHJZbnplMWZ6TUhoVXE2UHV0bnZLdnpXOUVBUE9OK0FzcXRINnNDMi9zQ3FWWjJsYWlnOFdDRTZ0NHNnRWhpd01CWEE4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzMzUwNjY5CWZpbGU6cGF5bG9hZC5iaW4KSkRIZUJPR3lySFVOTUFZaERWcFZWUWVJRDVjTDdMK1ExWW1jVXNoR3NrdVdhOVo2OVJ2Rms1elN0bkdQVFhnRGRqRG0zd1ZaSUE2di9lL0c0Ync2Qnc9PQo=";
    const CONTRACT_PAYLOAD: &[u8] = b"tinyssh-portable-update-contract-payload\n";

    /// 验签契约：真签通过；载荷动一个字节即拒；公钥换一个字符即拒。
    #[test]
    fn minisign_contract_verify_and_reject() {
        let r = verify_signature_b64(CONTRACT_PAYLOAD, CONTRACT_PUBKEY, CONTRACT_SIG);
        assert!(r.is_ok(), "真签应通过：{:?}", r.err());
        let mut tampered = CONTRACT_PAYLOAD.to_vec();
        tampered[3] ^= 0x20;
        assert!(verify_signature_b64(&tampered, CONTRACT_PUBKEY, CONTRACT_SIG).is_err());
        let wrong_key = format!("{}L", &CONTRACT_PUBKEY[..CONTRACT_PUBKEY.len() - 1]);
        assert!(verify_signature_b64(CONTRACT_PAYLOAD, &wrong_key, CONTRACT_SIG).is_err());
        // 非 base64 输入如实报错（不 panic）
        assert!(verify_signature_b64(CONTRACT_PAYLOAD, "!!!", CONTRACT_SIG).is_err());
    }

    /// 清单解析：平台条目命中；未知字段容忍；坏 JSON/缺平台如实报错。
    #[test]
    fn manifest_parse_platforms_and_errors() {
        let ok = UpdateManifest::parse(
            br#"{"version":"9.9.9","pub_date":"2026-10-30T00:00:00Z","notes":"x",
                 "platforms":{"windows-x86_64":{"signature":"c2ln","url":"https://x/y.exe"},
                              "darwin-aarch64":{"signature":"ZGFy","url":"https://x/a.tar.gz"}}}"#,
        )
        .unwrap();
        assert_eq!(ok.version, "9.9.9");
        assert_eq!(
            ok.platforms.get(UPDATE_PLATFORM_PORTABLE).unwrap().url,
            "https://x/y.exe"
        );
        assert!(UpdateManifest::parse(br#"{"version":"1.0"}"#)
            .err()
            .is_some_and(|e| e.contains("解析失败")));
        assert!(UpdateManifest::parse(b"not json")
            .err()
            .is_some_and(|e| e.contains("解析失败")));
    }

    /// 唯一临时目录（无 tempfile 依赖，进程 id 隔离并发）。
    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("tinyssh-swap-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 换身正常路径：旧内容落 .old、新内容占原名、暂存名消失。
    #[test]
    fn swap_happy_path() {
        let d = tmpdir("ok");
        let cur = d.join("app.exe");
        let staged = d.join("app.exe.new");
        let backup = d.join("app.exe.old");
        std::fs::write(&cur, b"old-bytes").unwrap();
        std::fs::write(&staged, b"new-bytes").unwrap();
        swap_staged_executable(&cur, &staged, &backup).unwrap();
        assert_eq!(std::fs::read(&cur).unwrap(), b"new-bytes");
        assert_eq!(std::fs::read(&backup).unwrap(), b"old-bytes");
        assert!(!staged.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 换身失败路径：暂存缺失 → 第二步改名失败 → 回滚后原文件原样；残留
    /// .old 无法删除（被占用不可模拟，以只读目录近似「删不掉」在 unix 才成立，
    /// 这里只验主路径报错文案与现场完整）。
    #[test]
    fn swap_rollback_when_staged_missing() {
        let d = tmpdir("rb");
        let cur = d.join("app.exe");
        let staged = d.join("app.exe.new");
        let backup = d.join("app.exe.old");
        std::fs::write(&cur, b"old-bytes").unwrap();
        let msg = swap_staged_executable(&cur, &staged, &backup).unwrap_err();
        assert!(msg.contains("回滚"), "报错应说明回滚结果：{msg}");
        assert_eq!(std::fs::read(&cur).unwrap(), b"old-bytes");
        assert!(!backup.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 换身前置失败：残留 .old 删不掉 → 不动当前程序（现场完整优先）。
    /// 用「.old 是目录」模拟删除失败（remove_file 对目录必败，跨平台成立）。
    #[test]
    fn swap_refuses_when_backup_undeletable() {
        let d = tmpdir("busy");
        let cur = d.join("app.exe");
        let staged = d.join("app.exe.new");
        let backup = d.join("app.exe.old");
        std::fs::write(&cur, b"old-bytes").unwrap();
        std::fs::write(&staged, b"new-bytes").unwrap();
        std::fs::create_dir(&backup).unwrap();
        let msg = swap_staged_executable(&cur, &staged, &backup).unwrap_err();
        assert!(msg.contains("残留备份"), "报错应指向残留备份：{msg}");
        assert_eq!(std::fs::read(&cur).unwrap(), b"old-bytes");
        assert!(staged.exists()); // 暂存未被消费
        let _ = std::fs::remove_dir_all(&d);
    }
}
