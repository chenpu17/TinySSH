// 版本号哨兵：根 Cargo.toml（workspace.package.version）是唯一真源，
// tauri.conf.json / ui/package.json / package-lock.json 必须与它同升。
//
// 背景：此前版本号散落在多个文件里，靠发版人手工“四源同升”；漏一处时
// 产物版本、前端关于卡与更新清单可能各说各话。这个测试把一致性变成 CI 门。
//
// 放在 session-api（所有 CI 档都会编译/测试的 crate），而不是 tinyssh-app：
// Linux tier1 与 release verify 都排除了桌面壳，放在壳里会被静默跳过。

fn workspace_version() -> String {
    let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml"));
    let mut in_workspace_package = false;
    for line in raw.lines() {
        let line = line.trim();
        if line == "[workspace.package]" {
            in_workspace_package = true;
            continue;
        }
        if in_workspace_package {
            if line.starts_with('[') {
                break;
            }
            if let Some(v) = line.strip_prefix("version = \"") {
                return v.trim_end_matches('"').to_string();
            }
        }
    }
    panic!("根 Cargo.toml 的 [workspace.package] 缺少 version");
}

#[test]
fn version_is_consistent_across_sources() {
    let version = workspace_version();

    let tauri: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src-tauri/tauri.conf.json"
    )))
    .expect("tauri.conf.json 必须是合法 JSON");
    assert_eq!(
        tauri.get("version").and_then(|v| v.as_str()),
        Some(version.as_str()),
        "tauri.conf.json version 必须与根 Cargo.toml 一致"
    );

    let ui: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ui/package.json"
    )))
    .expect("ui/package.json 必须是合法 JSON");
    assert_eq!(
        ui.get("version").and_then(|v| v.as_str()),
        Some(version.as_str()),
        "ui/package.json version 必须与根 Cargo.toml 一致"
    );

    let lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ui/package-lock.json"
    )))
    .expect("ui/package-lock.json 必须是合法 JSON");
    assert_eq!(
        lock.get("version").and_then(|v| v.as_str()),
        Some(version.as_str()),
        "ui/package-lock.json 根 version 必须与根 Cargo.toml 一致"
    );
    assert_eq!(
        lock.pointer("/packages//version").and_then(|v| v.as_str()),
        Some(version.as_str()),
        "ui/package-lock.json packages[\"\"].version 必须与根 Cargo.toml 一致"
    );
}
