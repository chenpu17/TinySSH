//! 原生 Ctrl 拦截、菜单与致命错误对话框。

use super::*;

/// macOS 虚拟键码 → Ctrl 组合的 C0 控制字符（与真实终端 / 前端 ctrlCharOf 同表）。
#[cfg(target_os = "macos")]
pub(crate) fn ctrl_char_of_keycode(code: u64) -> Option<&'static str> {
    Some(match code {
        0 => "\x01",  // a
        11 => "\x02", // b
        8 => "\x03",  // c
        2 => "\x04",  // d
        14 => "\x05", // e
        3 => "\x06",  // f
        5 => "\x07",  // g
        4 => "\x08",  // h
        34 => "\x09", // i
        38 => "\x0a", // j
        40 => "\x0b", // k
        37 => "\x0c", // l
        46 => "\x0d", // m
        45 => "\x0e", // n
        31 => "\x0f", // o
        35 => "\x10", // p
        12 => "\x11", // q
        15 => "\x12", // r
        1 => "\x13",  // s
        17 => "\x14", // t
        32 => "\x15", // u
        9 => "\x16",  // v
        13 => "\x17", // w
        7 => "\x18",  // x
        16 => "\x19", // y
        6 => "\x1a",  // z
        33 => "\x1b", // [
        42 => "\x1c", // backslash
        30 => "\x1d", // ]
        22 => "\x1e", // 6
        27 => "\x1f", // -
        44 => "\x1f", // /
        49 => "\x00", // space
        19 => "\x00", // 2
        20 => "\x1b", // 3
        21 => "\x1c", // 4
        23 => "\x1d", // 5
        26 => "\x1f", // 7
        28 => "\x7f", // 8 (DEL)
        _ => return None,
    })
}

/// native 层 Ctrl+字符 接管（仅 macOS）：中文输入法在 WKWebView 里会把 Ctrl+字母
/// 送进拼音组合（keydown 到达 DOM 时 ctrl 标志已被剥掉、keyCode=229），任何 JS 层
/// 修复都无法区分「Ctrl+C」和「拼音里的 c」。NSEvent local monitor 在 IME 之前
/// 看到原始事件（修饰键完整），终端聚焦时编码控制字符直发后端并吞掉事件。
#[cfg(target_os = "macos")]
pub(crate) fn install_native_ctrl_intercept(core: Arc<SessionManager>, input: Arc<TerminalInput>) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::ptr::NonNull;

    let block = block2::RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
        // ObjC block 边界不能 unwind：任何 panic 一律吞掉并放行事件，绝不 abort 应用。
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ev = unsafe { ev.as_ref() };
            if ev.r#type() != NSEventType::KeyDown {
                return None;
            }
            let flags = ev.modifierFlags();
            // ⌘/⌥ 组合不劫持；⇧ 允许（ctrl+⇧+字母与 ctrl+字母同义）
            if !flags.contains(NSEventModifierFlags::Control)
                || flags
                    .intersects(NSEventModifierFlags::Command.union(NSEventModifierFlags::Option))
            {
                return None;
            }
            if !*input.focused.lock().unwrap() {
                return None; // 终端未聚焦（命令框等输入控件保留自身编辑语义）
            }
            let sid = input.sid.lock().unwrap().clone()?;
            let pane = *input.pane_id.lock().unwrap();
            let keycode = ev.keyCode() as u64;
            ctrl_char_of_keycode(keycode).map(|cc| (sid, pane, cc))
        }));
        match handled {
            Ok(Some((sid, pane, cc))) => {
                let core = core.clone();
                tauri::async_runtime::spawn(async move {
                    // tmux 面板格子焦点：控制字符进该格通道（主会话 send_keys 绝不代收）
                    match pane {
                        Some(pid) => {
                            let _ = core.tmux_pane_input(&sid, pid, cc).await;
                        }
                        None => {
                            let _ = core.send_keys(&Actor::Human, sid, cc).await;
                        }
                    }
                });
                std::ptr::null_mut() // 吞掉事件：IME 与 WebKit 都不再看到
            }
            _ => ev.as_ptr(),
        }
    });

    let monitor: Option<Retained<AnyObject>> = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };
    // 监视器与应用同生命周期，故意常驻。
    std::mem::forget(monitor);
    eprintln!("[app] native ctrl-key intercept installed");
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install_native_ctrl_intercept(
    _core: Arc<SessionManager>,
    _input: Arc<TerminalInput>,
) {
}

/// T34：原生菜单栏定制（替换 Tauri 默认英文菜单）。预定义角色项显式传中文标签——
/// 系统语言非中文时默认标签会是英文，与应用全中文 UI 混排（真机走查实修：本机系统
/// 语言为英文，「About tinyssh-app」与「编辑」混排且 app 名取进程名）。随系统语言
/// 动态本地化列为 V1。不设「关闭窗口 ⌘W」——该键已被应用内标签页语义占用；
/// 「重新加载」不进菜单（会整页刷新杀死全部会话 UI 状态）。
#[cfg(target_os = "macos")]
pub(crate) fn install_native_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
    let version = app.package_info().version.to_string();
    let app_sub = SubmenuBuilder::new(app, "TinySSH")
        .item(&PredefinedMenuItem::about(
            app,
            Some("关于 TinySSH"),
            Some(AboutMetadata {
                name: Some("TinySSH".into()),
                version: Some(version.clone()),
                credits: Some(
                    "主机凭据与 Agent 令牌经本机钥匙串加密存储，协作与审计链完整留存于本机。"
                        .into(),
                ),
                ..Default::default()
            }),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "settings",
            "设置…",
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("隐藏 TinySSH"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
        .separator()
        // ⌘Q 不能用 PredefinedMenuItem::quit：macOS 预定义 quit 是 NSApp terminate，
        // tao 只接 applicationWillTerminate → 直接销毁事件循环，不经 RunEvent::ExitRequested，
        // 退出确认被整条绕过（KI-011）。改普通菜单项 + 快捷键，由 on_menu_event 统一
        // 武装确认；Dock「退出」/系统注销仍是 NSApp 直终止（见 known-issues 登记）。
        .item(&MenuItem::with_id(
            app,
            "quit",
            "退出 TinySSH",
            true,
            Some("CmdOrCtrl+Q"),
        )?)
        .build()?;
    let edit_sub = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("拷贝"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        // ⌘A 不能走 PredefinedMenuItem::select_all：NSMenu 会在 WebView 之前消费
        // 快捷键，预定义 selectAll 只会全选 xterm 的隐藏 textarea，终端缓冲没有选区。
        // 改发前端事件，按当前焦点分派「终端全选 / 输入框全选」。
        .item(&MenuItem::with_id(
            app,
            "select-all",
            "全选",
            true,
            Some("CmdOrCtrl+A"),
        )?)
        .build()?;
    let view_sub = SubmenuBuilder::new(app, "显示")
        .item(&PredefinedMenuItem::fullscreen(app, Some("全屏"))?)
        .build()?;
    let window_sub = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(
            app,
            Some("前置全部"),
        )?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_sub, &edit_sub, &view_sub, &window_sub])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install_native_menu(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// 启动期致命错误的原生对话框：windows_subsystem 构建无控制台，panic/eprintln
/// 全部不可见（双开/库损坏曾表现为「点了没反应」）。零依赖直调 user32。
#[cfg(windows)]
pub(crate) fn show_fatal_dialog(msg: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let t = wide(msg);
    let c = wide("TinySSH");
    unsafe { MessageBoxW(0, t.as_ptr(), c.as_ptr(), 0x10) }; // MB_ICONERROR
}
#[cfg(not(windows))]
pub(crate) fn show_fatal_dialog(msg: &str) {
    // macOS：Finder 启动的 .app 无控制台，eprintln 全部不可见——此前任何启动期
    // 致命错误都表现为「Dock 弹一下就退出」（mac 双建 webview 崩死三版无人知）。
    // 零新依赖走 osascript 弹原生对话框（Linux 无 osascript，保持 eprintln）。
    #[cfg(target_os = "macos")]
    {
        let esc = msg.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display dialog \"{}\" with title \"TinySSH\" buttons {{\"好\"}} default button 1 with icon stop",
            esc
        );
        let _ = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status();
    }
    eprintln!("{msg}");
}
