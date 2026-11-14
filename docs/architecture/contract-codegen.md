# 契约生成预研（Tauri command / wire 类型）

> 日期：2026-11-06 · 状态：PoC 已落地（5 个 wire 类型）· 相关：`crates/session-api/tests/command_parity.rs`

## 现状

命令面目前靠手工三处同步：

1. `src-tauri/src/commands/*` 的 `#[tauri::command]` 函数；
2. `ui/src/adapter/bridge.ts` 的 `CmdArgs` / `CmdRet`；
3. `ui/src/demo.ts` 的 demo 实现。

`sentinel` 只能保证**命令名**不漂移（119 个命令逐名对齐），但参数结构、可选性、返回类型仍可能单边改动。真正消除漂移需要从 Rust 类型生成 TypeScript。

## 候选方案

| 方案 | 机制 | 优点 | 代价 / 风险 |
|---|---|---|---|
| `ts-rs` | 在 Rust 类型上 `#[derive(TS)]`，生成 `.ts` | 侵入小、可逐步覆盖 wire 类型 | 不感知 Tauri command；命令参数仍需手写或改为结构体 |
| `specta` + `tauri-specta` | 给 command 加 `#[specta::specta]`，`collect_commands!` 生成完整 bindings | 命令名/参数/返回值一次生成，最接近单一真源 | 需要改所有 command 签名与宏；与 Tauri v2 版本/平台兼容需验证；生成文件进入构建链 |
| `typeshare` | 注解 Rust 类型生成多语言绑定 | 简单、成熟 | 同样不覆盖 command 面；对泛型/枚举支持有限 |

## 建议路径

1. **先 wire 类型、后 command 面**：用 `ts-rs` 从 `session-api` 的 `Host`、`SessionInfo`、`TransferTask`、`ApprovalItem` 等纯数据类型生成 `ui/src/adapter/generated/wire.generated.ts`，替换 `bridge.ts` 里手写的同名类型。风险最低，先验证生成文件与现有 `wire.ts` 的差异。
2. **命令参数结构体化**：把多参数 command（如 `begin_connection`、`tmux_pane_open`）收敛为 `XxxReq` 结构体；这一步对前端调用形态是破坏性变更，需要与 UI/demo 同步。
3. **评估 `tauri-specta`**：在 1–2 完成后，用一条命令面做 PoC（例如 `list_hosts` / `create_session`），确认：
   - 生成的 `bindings.ts` 能覆盖 `CmdArgs`/`CmdRet`；
   - `generate_handler!` 与 `collect_commands!` 的重复声明可接受或可合并；
   - Windows/macOS/Linux 构建与 `custom-protocol` 打包不受影响。
4. **切换门禁**：生成文件纳入 CI 校验（`cargo run --bin generate-bindings` 后 `git diff --exit-code`），保留现有 `command_parity` 作为兜底。

## 已落地 PoC（2026-11-06）

- `session-api` 增加可选 feature `ts`（默认关闭，不进入生产构建依赖）；
- `Host` / `HostDraft` / `AuthDraft` / `AuthType` / `Charset` 加 `cfg_attr(feature = "ts", derive(ts_rs::TS))`；
- 生成器：`cargo run -p session-api --features ts --example export-wire`；
- 生成物：`ui/src/adapter/generated/wire.generated.ts`，已由 `wire.ts` 重导出并替换手写声明；
- 新鲜度门：`cargo test -p session-api --features ts --test wire_codegen`，CI tier1 与 release verify 均执行。

PoC 顺带发现并修复了一处真实漂移：手写 `wire.ts` 的 `Host` 缺少后端已有的 `shell_integration` 字段。

## 本轮未覆盖（后续）

- 119 个 command 的签名改造会同时触碰 `commands/*`、`bridge.ts`、`demo.ts` 与全部 UI spec，超出「结构拆分」这一波的风险预算；
- `tauri-specta` 与 Tauri 2.12 / 当前命令宏的兼容性尚未实机验证；
- 先用 `command_parity` + `wire.ts` 手工类型保证名字不漂，等结构稳定后再做代码生成，收益更高。

## 参考

- `crates/session-api/tests/command_parity.rs`：当前命令名哨兵。
- `ui/src/adapter/bridge.ts`：手工 `CmdArgs` / `CmdRet`。
- `src-tauri/src/lib.rs` 的 `generate_handler![...]`：唯一命令注册表（`main.rs` 只是薄壳）。
