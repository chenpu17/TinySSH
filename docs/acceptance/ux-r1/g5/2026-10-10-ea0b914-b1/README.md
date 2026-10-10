# G5 基线 B1（旧版打包 release）证据包

**构建点**：tag `old-ui-baseline-g0` = `ea0b9148cfa30fa384d7dac344cdce8cc4b5cbf4`，worktree `.worktrees/old-ui`。
**用途**：R51「release 性能、稳定性与干扰测试」的**旧版基线**——G5 绝对门与新旧回归门的对比参照。
**补测清单**：`docs/acceptance/ux-r1/g1/2026-10-07-ea0b914-r10prep/release-baseline-checklist.md` §1.1。

## 内容

| 文件 | 说明 |
|---|---|
| `b1-build.log` | `cargo tauri build` 完整日志（`Finished release … in 1m 46s`、`Finished 2 bundles`） |
| `b1-launch.log` | 首次启动留档（窗口 URL 协议、page load event、mcp_status 前端存活） |
| `b1-screenshot.png` | 首次启动截图（旧版固定三栏渲染） |
| `b1-lsof.txt` | `lsof -a -p <pid> -i` 原始输出（2026-10-10 复跑留档，封闭「无档声称」缺口） |
| `b1-lsof-launch.log` | 复跑那一轮（lsof 取证）的启动日志 |

## 打包条件验证口径

清单 §3 规则 2 要求「关闭 vite dev server 状态下启动可用」。本机 `:5183` 上有**他人工作流的 vite dev server**（PID 31602，主树 `ui/`），用户长期指令禁止打断用户环境，故**未停该 server**；改为证明打包二进制**不依赖**它（**偏离登记**，口径更强）：

1. **加载 URL**：`[app] window url: … scheme: "tauri", host: Domain("localhost")` → `tauri://localhost/`（内嵌资产协议），**非** `http://localhost:5183`。
2. **套接字**：`b1-lsof.txt` 仅见 `localhost:8722 (LISTEN)`（进程内 MCP 端点），**无任何到 `:5183` 的连接**。
3. **前端存活**：`page load event: Started/Finished "main"` + `mcp_status invoked (frontend alive)`。
4. **视觉**：`b1-screenshot.png` 见旧版三栏正常渲染。

该口径强于「停 server 后能起」：在 server **在场**时证明二进制不读它。

## 口径与未做

- **B2（新版打包 release）未构建**，待 G5 候选冻结。
- **B1 未做代码签名/公证**（`cargo tauri build` 默认 ad-hoc）；发布门需另议。
- 本包只证明「B1 是内嵌资产的打包产物且不依赖 dev server」，**不构成**任何性能/稳定性结论。
- 构建前 `git restore` 掉一处 `ui/package-lock.json` self-version 漂移（0.1.0→0.9.0）的操作过程**无日志留档**；当前 worktree 树干净且逐字节等于 `ea0b914`。
- 工具链版本（cargo-tauri 2.10.1 / node v24.18.0 / rustc 1.93.1）取自当时环境，`b1-build.log` 内**无版本行**，无法从日志回溯。
- 行号引用归属：`[app] window url` 打印在**主树** `src-tauri/src/main.rs:1341`、**old-ui 树** `src-tauri/src/main.rs:804`（该树该文件共 938 行）。
