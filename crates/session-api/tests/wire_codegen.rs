//! 契约生成物新鲜度：Rust 类型改了但没重新生成 `wire.generated.ts` 时直接红。
//!
//! 只在显式启用 `ts` feature 时运行：
//! `cargo test -p session-api --features ts --test wire_codegen`

#![cfg(feature = "ts")]

use std::path::Path;

#[test]
fn wire_generated_is_fresh() {
    let expected = session_api::ts_export::render_wire_bindings();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../ui/src/adapter/generated/wire.generated.ts");
    let actual =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}：{e}", path.display()));

    // 生成物统一 LF；兼容 git 在 Windows 上 checkout 成 CRLF 的情况。
    let norm = |s: &str| s.replace("\r\n", "\n");
    assert_eq!(
        norm(&actual),
        norm(&expected),
        "wire.generated.ts 已过期；运行 cargo run -p session-api --features ts --example export-wire 重新生成"
    );
}
