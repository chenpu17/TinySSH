# TinySSH UX-R1 发布说明（运行版）

本文件登记 UX-R1 重构系列中**面向用户的语义变化**——尤其是「不能笼统宣称协议行为不变」
的那几处。§10.2 要求这类收紧「需版本/发布说明与旧客户端错误路径测试」；错误路径测试见
`crates/session-api/tests/c3_contract.rs`（wire code 与载荷锁定）。

版本号随 `src-tauri/tauri.conf.json` 的 `version`（当前 `0.9.0`）。

---

## C3：Shell 集成的「执行前拒绝」语义收紧（R24 引入，R44 登记）

**变化**：`exec` 以 **shell 模式**执行、而会话**无 shell 集成在场**时，**在执行前拒绝**，
返回 `shell_integration_unavailable`。旧行为是**静默走 Fresh（新起 shell）降级**。

**为何收紧**：静默降级会让「在既有 shell 里执行」与「另起一个 shell 执行」这两种语义
混为一谈——cwd/env/历史都不延续，用户在不知情下拿到错误的执行现场。收紧后语义明确：
要么在有集成的 shell 里跑，要么由调用方**显式**选择 Fresh（走原授权/审批路径）。

**影响面**：

- 目标：**只有**「主机已启用 shell 集成但远端 shell 未给出集成标记（OSC133）」的会话，
  以及「主机未启用集成」的会话上发起的 shell 模式 exec。
- 不受影响：`ExecMode::Fresh` 显式请求（不受该门拦截，走原授权/审批）；local 会话
  （PTY 启动即注入集成，恒 Ready）；已就绪的 SSH 会话。
- **旧客户端**（不认识 shell_integration 的）：不再拿到「静默降级后的成功」，而是拿到
  结构化错误。错误载荷区分两种成因，客户端可据此给出不同指引：
  - `host_setting=false` → 主机设置里就没开集成（用户可自行开启）；
  - `host_setting=true` 且 `integration_present=false` → 主机开了但远端 shell 不支持。

**错误线格式**（稳定，勿改）：

```
kind   = "shell_integration_unavailable"
detail = { "available": { "integration_present": bool,
                          "prompt_ready": bool,
                          "host_setting": bool } }
```

**迁移建议**：客户端应在收到该错误时，向用户明示「该会话当前无法在既有 shell 中执行」，
并提供「新起 shell 执行（Fresh）」作为显式选项——而**不是**自动重试为 Fresh。

---

## 其他登记项

（后续轮次如有新的语义收紧，在此追加。）
