// 找茬轮 P0 哨兵：tauri-plugin-updater 2.14 注册即要求 tauri.conf.json 存在
// plugins.updater 段（endpoints/pubkey 均无 serde default，缺段=Tauri 传 Null，
// 启动即 panic PluginInitialization "invalid type: null, expected struct Config"）
// ——v0.10.1 全平台产物因此 DOA。此测试钉住配置段的存在与形状，防止任何
// conf 改写把它再次删掉。
// 「构建绿」≠「能起」：这个 panic 只在真启动时炸，CI 与测试套件都不启动
// 产物，编译期无从发现——配置契约只能靠这类静态哨兵守住。

#[test]
fn tauri_conf_has_updater_plugin_section() {
    let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"));
    let conf: serde_json::Value =
        serde_json::from_str(raw).expect("tauri.conf.json 必须是合法 JSON");
    let updater = conf
        .get("plugins")
        .and_then(|p| p.get("updater"))
        .expect("plugins.updater 段缺失——updater 插件注册会让产物启动即 panic");
    assert!(
        updater
            .get("endpoints")
            .and_then(|e| e.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "plugins.updater.endpoints 必须是非空数组"
    );
    assert!(
        updater.get("pubkey").and_then(|p| p.as_str()).is_some(),
        "plugins.updater.pubkey 必须是字符串（可为空串，运行期 Builder 用 build.rs 注入值覆盖）"
    );
}

// mac 双建 P0 哨兵：平台覆盖层的 app.windows 数组**整体替换**基础配置，条目缺
// label/create 时按默认值解析（label="main"、create=true）——Tauri 启动期自动建
// 一个 main 窗口，setup 钩子（tauri.conf create:false 设计，见 main.rs）再程序化
// 建第二个 → "a webview with label `main` already exists" 启动即崩。ten-round
// a9e4ec4 引入，v0.10.0–0.10.2 三版 mac 产物全 DOA（用户真机实锤）。任何平台
// conf 里的 main 窗口都必须显式 create:false，与 setup 程序化建窗对齐。
#[test]
fn main_window_must_not_autocreate_on_any_platform() {
    for (name, raw) in [
        (
            "tauri.conf.json",
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")),
        ),
        (
            "tauri.windows.conf.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tauri.windows.conf.json"
            )),
        ),
        (
            "tauri.macos.conf.json",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tauri.macos.conf.json"
            )),
        ),
    ] {
        let conf: serde_json::Value =
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name} 不是合法 JSON：{e}"));
        let wins = conf
            .pointer("/app/windows")
            .and_then(|w| w.as_array())
            .unwrap_or_else(|| panic!("{name} 缺 app.windows 数组"));
        assert_eq!(wins.len(), 1, "{name} app.windows 必须恰一个条目");
        let w = &wins[0];
        assert_eq!(
            w.get("label").and_then(|l| l.as_str()),
            Some("main"),
            "{name} 窗口条目必须显式 label:\"main\"（省略时默认也是 main，但显式声明才与 setup 建窗语义对齐）"
        );
        assert_eq!(
            w.get("create"),
            Some(&serde_json::Value::Bool(false)),
            "{name} main 窗口必须 create:false——窗口由 setup 钩子创建，配置期自动创建会与之撞 label，启动即 panic"
        );
    }
}
