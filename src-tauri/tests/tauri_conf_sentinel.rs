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
