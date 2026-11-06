// 命令面契约哨兵：src-tauri 的 generate_handler![...] 与前端 bridge.ts 的
// CmdArgs/CmdRet 必须逐名对齐。
//
// 这不是代码生成，只是一道防漂移门：119 个命令靠手工三处同步（Rust handler、
// TS 实参、TS 返回值，另加 demo 实现），最容易漏的是新增命令只改了一边。
// 真正的单一真源应走 ts-rs/specta 生成；在那之前，这个测试先保证“名字”不漂。

use regex::Regex;
use std::collections::BTreeSet;

fn handler_names() -> BTreeSet<String> {
    let src = include_str!("../../../src-tauri/src/main.rs");
    let start = src
        .find("generate_handler![")
        .expect("src-tauri/src/main.rs 缺少 generate_handler![...]");
    let rest = &src[start..];
    let end = rest.find(']').expect("generate_handler![...] 未闭合");
    let block = &rest[..end];
    let re = Regex::new(r"\b([a-z][a-z0-9_]{2,})\b").expect("handler regex");
    re.captures_iter(block)
        .map(|c| c[1].to_string())
        .filter(|n| n != "tauri" && n != "generate_handler")
        .collect()
}

fn ts_interface_keys(interface: &str) -> BTreeSet<String> {
    let src = include_str!("../../../ui/src/adapter/bridge.ts");
    let marker = format!("interface {interface} {{");
    let start = src
        .find(&marker)
        .unwrap_or_else(|| panic!("bridge.ts 缺少 {marker}"));
    let rest = &src[start + marker.len()..];
    let end = rest
        .find("\n}")
        .unwrap_or_else(|| panic!("{interface} 未闭合"));
    let block = &rest[..end];
    let re = Regex::new(r"(?m)^  ([a-z_][a-z0-9_]*)\??:").expect("ts key regex");
    re.captures_iter(block).map(|c| c[1].to_string()).collect()
}

fn report_diff(label: &str, rust: &BTreeSet<String>, ts: &BTreeSet<String>) {
    let only_rust: Vec<_> = rust.difference(ts).cloned().collect();
    let only_ts: Vec<_> = ts.difference(rust).cloned().collect();
    assert!(
        only_rust.is_empty() && only_ts.is_empty(),
        "{label} 漂移：\n  仅 Rust handler: {only_rust:?}\n  仅 TS CmdMap: {only_ts:?}"
    );
}

#[test]
fn tauri_commands_match_frontend_bridge() {
    let handlers = handler_names();
    assert!(
        handlers.len() >= 100,
        "handler 解析只得到 {} 个命令，解析器可能已失效",
        handlers.len()
    );

    let args = ts_interface_keys("CmdArgs");
    let ret = ts_interface_keys("CmdRet");

    report_diff("CmdArgs", &handlers, &args);
    report_diff("CmdRet", &handlers, &ret);
    assert_eq!(
        args, ret,
        "CmdArgs 与 CmdRet 的命令名单必须一致（每个命令都要有实参与返回类型）"
    );
}
