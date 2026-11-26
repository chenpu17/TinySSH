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
    // Android 没有 xdg-open：经 JNI 拉起系统浏览器的 ACTION_VIEW（移动端链接点按，
    // KI-052）。必须排在通用 unix 分支之前，否则会落进 xdg-open 恒失败。
    #[cfg(target_os = "android")]
    {
        android_open_url(&url)
            .map_err(|e| WireError::simple("io", format!("打开链接失败：{e}")))?;
    }
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(WireError::from)?;
    }
    Ok(())
}

/// 系统栏图标深浅跟随应用主题（KI-060）：Android 边到边下状态栏/导航栏图标由系统
/// 按系统深浅决定，应用内切主题不会重建 Activity。前端在 App.applyChrome 里按解析
/// 后的深浅调用；非 Android 无系统栏概念，no-op。
/// 同一命令也是「窗口底色对齐页面底色」的触发点：原生侧向页面的 window.__tinysshEdgeBg
/// 取色并涂窗口底色（MainActivity.syncEdgeBackground，导航栏下方那条不再跟系统深浅
/// 走）。页面底色变而深浅不变时（换色板、切视图）前端也会调它，图标深浅幂等。
#[tauri::command]
pub(crate) async fn set_system_bars_light(light: bool) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        android_set_system_bars_light(light)
            .map_err(|e| WireError::simple("io", format!("更新系统栏明暗失败：{e}")))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = light;
    Ok(())
}

/// 移动端自动横屏（GitHub #45）：系统旋转锁打开时应用仍按物理朝向转屏。Android
/// 把开关转发 MainActivity.setAutoOrientation（原生侧用 OrientationEventListener
/// 读物理朝向，再显式请求固定横/竖方向——锁定时只有固定方向请求能绕开）；
/// 非 Android no-op。开关状态由前端持久化并在启动时重放，原生侧不落盘。
#[tauri::command]
pub(crate) async fn set_auto_orientation(enabled: bool) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        android_set_auto_orientation(enabled)
            .map_err(|e| WireError::simple("io", format!("更新自动横屏失败：{e}")))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = enabled;
    Ok(())
}

/// 物理键盘存在性（移动端交互）：前端据此隐藏辅助键条、收紧软键盘避让等。
/// Android 经 JNI 问 MainActivity.hasHardwareKeyboard()（InputManager 非虚拟设备
/// 且带键盘源位、keyboardType 非 NONE；兜底 Configuration.keyboard）。查询失败
/// 或非 Android 一律 false——前端只是少一个布局优化，不该变成错误弹窗。
#[tauri::command]
pub(crate) async fn has_hardware_keyboard() -> CmdResult<bool> {
    #[cfg(target_os = "android")]
    {
        Ok(android_has_hardware_keyboard().unwrap_or(false))
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

/// Android 保活补口（KI-059 v1）：回前台时让 Rust 立即重算并下发一次前台服务
/// 状态——Android 12+ 可能拒绝过后台启动，这里把服务补起来。判定仍读
/// SessionManager 快照（不信前端）；无参无返回，前端 fire-and-forget。非 Android
/// no-op（桌面没有前台服务）。
#[tauri::command]
pub(crate) async fn keepalive_sync(state: ApiState<'_>) -> CmdResult<()> {
    crate::keepalive::sync_now(&state.api).await;
    Ok(())
}

/// Android 把物理键盘查询转发给 MainActivity.hasHardwareKeyboard()。ClassLoader
/// 取法与 setSystemBarsLight 同源（KI-060）：native 线程 FindClass 走 bootstrap
/// ClassLoader 不可靠，必须经 Application context 的 getClassLoader().loadClass。
/// Kotlin 侧 Activity 存在时读 InputManager，否则用 Configuration 兜底。
/// 返回类型 ()Z 对应 JValue::z()（bool）。
#[cfg(target_os = "android")]
fn android_has_hardware_keyboard() -> std::result::Result<bool, String> {
    use jni::objects::{JObject, JValue};

    // SAFETY: 与 open_url 同一前提：Tauri/wry 的 JNI 入口在 run() 前初始化
    // ndk-context，保存的是进程生命期有效的全局引用。
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // JNI 错误路径卫生（KI-072）：任一调用抛 Java 异常（loadClass 的
    // ClassNotFound 等）都要清掉挂起异常，否则这条 native 线程后续调用全部带病。
    let result = (|| -> std::result::Result<bool, String> {
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_name = env
            .new_string("com.tinyssh.app.MainActivity")
            .map_err(|e| e.to_string())?;
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_ref = env.new_global_ref(&class_obj).map_err(|e| e.to_string())?;
        env.call_static_method(&class_ref, "hasHardwareKeyboard", "()Z", &[])
            .map_err(|e| e.to_string())?
            .z()
            .map_err(|e| e.to_string())
    })();
    if result.is_err() {
        crate::android_jni::clear_pending_exception(&mut env);
    }
    result
}

/// Android 把自动横屏开关转发给 MainActivity.setAutoOrientation(Z)。ClassLoader
/// 取法与 setSystemBarsLight 同源（KI-060）；Kotlin 侧经静态 WeakReference 取
/// Activity 并用 view.post 回主线程（传感器注册/方向请求都必须在主线程）。
#[cfg(target_os = "android")]
fn android_set_auto_orientation(enabled: bool) -> std::result::Result<(), String> {
    use jni::objects::{JObject, JValue};

    // SAFETY: 与 open_url 同一前提：Tauri/wry 的 JNI 入口在 run() 前初始化
    // ndk-context，保存的是进程生命期有效的全局引用。
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // JNI 错误路径卫生（KI-072）：同 setSystemBarsLight，失败先清挂起异常。
    let result = (|| -> std::result::Result<(), String> {
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_name = env
            .new_string("com.tinyssh.app.MainActivity")
            .map_err(|e| e.to_string())?;
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_ref = env.new_global_ref(&class_obj).map_err(|e| e.to_string())?;
        env.call_static_method(
            &class_ref,
            "setAutoOrientation",
            "(Z)V",
            &[JValue::Bool(enabled as u8)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        crate::android_jni::clear_pending_exception(&mut env);
    }
    result
}

/// Android 把设置转发给 MainActivity.setSystemBarsLight。native 线程里
/// FindClass("com/tinyssh/app/MainActivity") 走 bootstrap ClassLoader 不可靠，
/// 必须经 Application context 的 getClassLoader().loadClass(...)（KI-060）。
/// 注意 ndk-context 给的是 Application context 不是 Activity——Kotlin 侧经
/// 静态 WeakReference 取 Activity 并用 view.post 回主线程。
#[cfg(target_os = "android")]
fn android_set_system_bars_light(light: bool) -> std::result::Result<(), String> {
    use jni::objects::{JObject, JValue};

    // SAFETY: 与 open_url 同一前提：Tauri/wry 的 JNI 入口在 run() 前初始化
    // ndk-context，保存的是进程生命期有效的全局引用。
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // JNI 错误路径卫生（KI-072）：同 hasHardwareKeyboard，失败先清挂起异常。
    let result = (|| -> std::result::Result<(), String> {
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let class_name = env
            .new_string("com.tinyssh.app.MainActivity")
            .map_err(|e| e.to_string())?;
        let class_obj = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        // call_static_method 的 class 参数要 Desc<JClass>，&JObject 不实现；转全局引用后
        // 可当类引用传入（jni 0.21 对 &GlobalRef 的 Desc<JClass> 实现）。
        let class_ref = env.new_global_ref(&class_obj).map_err(|e| e.to_string())?;
        env.call_static_method(
            &class_ref,
            "setSystemBarsLight",
            "(Z)V",
            &[JValue::Bool(light as u8)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        crate::android_jni::clear_pending_exception(&mut env);
    }
    result
}

/// Android 拉起浏览器（Intent.ACTION_VIEW）。KI-063：隐式 ACTION_VIEW 谁都能接走
/// （任何声明 http/https 的应用），故外层包一层 `Intent.createChooser`——用户明确
/// 选择用哪个应用打开；仍带浏览器默认项，多一层但不是拦截。application context
/// 起 Activity 必须给**最外层**（chooser）带 FLAG_ACTIVITY_NEW_TASK（0x10000000）；
/// Uri.parse 只解析已在上面白名单校验过的 http/https。没有可接收的应用时
/// startActivity 抛 ActivityNotFoundException（JNI 侧表现为 JavaException）——
/// 清掉挂起异常后把错误原文带回前端，由调用点弹「打开链接失败」。
#[cfg(target_os = "android")]
fn android_open_url(url: &str) -> std::result::Result<(), String> {
    use jni::objects::{JObject, JValue};

    // SAFETY: Tauri/wry 的 JNI 入口在 run() 前初始化 ndk-context（与 default_db_path
    // 同一前提），保存的是进程生命期有效的全局引用。
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    // JNI 错误路径卫生（KI-072）：Uri.parse/Intent 构造等同样可能抛 Java 异常，
    // 整段包起来统一清理（startActivity 的异常在外层再 describe 一次原文）。
    let result = (|| -> std::result::Result<(), String> {
        let url_js = env.new_string(url).map_err(|e| e.to_string())?;
        let uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&url_js)],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        let action = env
            .new_string("android.intent.action.VIEW")
            .map_err(|e| e.to_string())?;
        let intent = env
            .new_object(
                "android/content/Intent",
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[JValue::Object(&action), JValue::Object(&uri)],
            )
            .map_err(|e| e.to_string())?;
        // 选择器标题传 null：由系统按当前语言渲染（Rust 侧没有 i18n 上下文）。
        let chooser = env
            .call_static_method(
                "android/content/Intent",
                "createChooser",
                "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
                &[JValue::Object(&intent), JValue::Object(&JObject::null())],
            )
            .map_err(|e| e.to_string())?
            .l()
            .map_err(|e| e.to_string())?;
        env.call_method(
            &chooser,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(0x1000_0000)],
        )
        .map_err(|e| e.to_string())?;
        if let Err(e) = env.call_method(
            &context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&chooser)],
        ) {
            // Java 异常不清会留在这条 native 线程上，后续 JNI 调用全部带病返回。
            if env.exception_check().unwrap_or(false) {
                env.exception_describe().ok();
                let _ = env.exception_clear();
            }
            return Err(e.to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        crate::android_jni::clear_pending_exception(&mut env);
    }
    result
}
