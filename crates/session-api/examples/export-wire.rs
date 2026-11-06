//! 契约代码生成 PoC：从 `session-api` 的 Rust 类型生成 TypeScript 声明。
//!
//! 用法（默认构建不依赖 ts-rs）：
//! ```bash
//! cargo run -p session-api --features ts --example export-wire
//! ```
//! 输出：`ui/src/adapter/generated/wire.generated.ts`
//!
//! 当前覆盖 Host/HostDraft/AuthDraft/AuthType/Charset 五个类型，已接入
//! `wire.ts` 的对应声明；其余类型仍以手写为准。

#[cfg(feature = "ts")]
fn main() -> std::io::Result<()> {
    let out = session_api::ts_export::render_wire_bindings();
    let out_dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/adapter/generated");
    std::fs::create_dir_all(&out_dir)?;
    let path = out_dir.join("wire.generated.ts");
    std::fs::write(&path, out)?;
    println!("wrote {}", path.display());
    Ok(())
}

#[cfg(not(feature = "ts"))]
fn main() {
    eprintln!("需要启用 ts feature：cargo run -p session-api --features ts --example export-wire");
    std::process::exit(1);
}
