# R10 Tauri/demo adapter、统一 DTO 与错误映射——交付与验收证据

> 日期：2026-10-07 · 代码基线：`7d70887`（工作区交付态）· 依赖：R03 冻结契约 + 签署 C10 勘误
> 任务定义：交付文档 G1 表 R10——「提取 Tauri/demo adapter、统一 DTO 与错误映射」
> 验收标准：wire 枚举一致；真实命令通过 adapter；demo 不能特殊绕过校验

## 交付面

| 模块 | 内容 |
|---|---|
| `src-tauri/src/main.rs` | `WireError {kind, message, detail}` 结构化 wire 错误：session-api::Error 15 变体逐一映射稳定 snake_case kind + §11 ADR-15 前向预留；36 处 `.map_err(\|e\| e.to_string())` 字符串拍平全部替换；壳层直造错误（open_url 白名单/decide_approval 参数）走 `invalid_input`；单元测试钉住全部 kind 契约值 |
| `ui/src/adapter/wire.ts` | 前端唯一 wire 类型来源：42 命令面全部 DTO（Host/HostDraft/AuthDraft/IdentityReq/ApprovalItem/AuditEvent/ForwardSpec/StopOutcome…），与 Rust serde 线格式逐字段对齐（PascalCase 单元变体、externally tagged 结构变体、Charset rename） |
| `ui/src/adapter/errors.ts` | `parseWireError/errMsg/apiError`：结构化错误对象/Error/字符串统一归一；kind 开放集合（未知原样保留） |
| `ui/src/adapter/bridge.ts` | `CmdMap` 42 命令登记（实参/返回值全量类型化，tauri v2 camelCase 实参约定入注释）；`invoke` 唯一入口；`MkChannel`/`listen`/`inTauri` 归口 |
| `ui/src/App.tsx` | 全部 ~60 调用点改道 adapter；本地重复类型删除；`friendlyError` 升级 unknown 归一（kind 感知）；审批行入库归一类型化为 `ApprovalRow`（wire PascalCase ↔ UI 小写双层如实建模） |
| `ui/src/demo.ts` | 14 处 throw 全部改 `apiError(kind, message)`——demo 后端与 wire 错误契约同形，不再旁路 |
| SMOKE 仪表（dev 门控） | 注入脚本增补 window error/unhandledrejection 信标直写（e2e 归因用） |

## 验收对照

| 标准 | 证据 |
|---|---|
| wire 枚举一致 | cargo test `every_variant_maps_to_stable_kind`（15 变体 kind 全钉住；match 非穷尽即编译失败）；CmdMap 与 generate_handler 42 命令逐条对齐；tsc 全量校验调用点 |
| 真实命令通过 adapter | [e2e-evidence.txt](e2e-evidence.txt)：种子库启动链 list-ready cards=21 + 会话库 autoconnect 成功 + 零 JS 错误 + 退出零残留；App.tsx 无任何直连 `@tauri-apps/api/core`/demo 残留（仅 adapter/bridge 持有） |
| demo 不能特殊绕过校验 | demo.invoke 经同一 bridge 入口与 CmdMap 类型；错误通道 apiError 同形；浏览器走查 [demo-playwright.json](demo-playwright.json)（5 卡/零错误） |

## 边界与注记

- `friendlyError` 的中文人话映射规则未改（message 保留 thiserror 文案，行为不变）；kind 字段供后续任务按类分流（如 R26 断线重试）。
- **demo 错误文案注记（vis-r10 复验项，已收口）**：认证失败文案恢复原文 `AuthFailed（演示：认证失败）`（保住 friendlyError authfailed 分支命中，demo 用户可见行为与改造前逐字一致）；HostKeyRejected/SessionNotFound 中文化与 `Error: ` 前缀消失为 demo-only 渲染改善（真实 Tauri 错误文本不变），如实登记非回归。
- `ApprovalRow`（UI 入库归一小写）与 wire `ApprovalStatus`（PascalCase）的双层类型如实分开——此前靠注释约定，现由类型系统表达。
- p5_pilot/memsample 等采样脚本不经过此桥（进程外工具），无涉及。
- e2e 期间曾误指 r4_p3 库（2 主机）跑 20 卡阈值 → `FAIL-no-list|cards=0` 为阈值未达的固定失败格式；已用正确种子库（r4_p1）复验。归档以本目录 evidence 为准。
- **独立复核结论（2026-10-07）**：rev-r10 对抗审核**通过**（三标准全 PASS；cargo test wire_error_tests 1/1、tsc 零错、独立 Playwright 走查：指纹拒绝/信任/审批编辑钮/真实终端输出/状态归一全过）+ vis-r10 视觉复验**无回归可签**（主列表页与基线逐像素零差异、几何/computed style 实测一致、双主题正常）。低危注记 4 项收口：①demo 认证文案恢复原文（friendlyError 分支命中）②wire.ts OutputEvent 失实死类型改为实况 OutputChannelMessage（通道仅原始字节、Resync 走 window 事件）③dev server 陈旧 transform 重启修复 ④VoidedByHandback 单测断言补齐 + 错误变体计数 15→16 更正 + ApprovalItem.agent_id 收紧非空。
- **登记的既有映射偏差（非本轮引入，未改）**：vault 层 String 错误（issue_agent/get_setting）统一落 kind=invalid_input（语义偏宽，UI 按 message 展示不受影响；专用错误 kind 需 session-api 枚举扩展，归后续 ADR）；App 未监听 window "resync" 事件（基线 HEAD 即如此，归 R11/R26）。
