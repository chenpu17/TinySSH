# release 打包基线补测清单（R51 对比前执行）

> 依据：签署单 §2/§5 + 交付文档 §构建条件。核心事实：R04 全部旧版基线数据为「release 后端 + Vite dev 前端」（release 二进制按 tauri.conf devUrl 加载 localhost:5183）。
> G5 绝对指标必须在**实际打包的 release 前后端**执行；新旧回归门用**旧版打包产物 vs 新版打包产物同环境对比**。

## 1. 构建产物矩阵

| # | 产物 | 构建点 | 状态 |
|---|---|---|---|
| B1 | 旧版打包 release（tauri build，内嵌资产） | tag `old-ui-baseline-g0`（`ea0b914`） | **已构建**（2026-10-10，见 §1.1） |
| B2 | 新版打包 release | 各阶段退出时点最新 tag | 随阶段产出（G5 候选冻结时构建） |

打包命令与签名配置在 B1 首次构建时固化进本清单（含 tauri build 实际产物路径与 SHA256）。

## 1.1 B1 构建记录（2026-10-10）

**构建点**：`.worktrees/old-ui`，HEAD = `ea0b9148cfa30fa384d7dac344cdce8cc4b5cbf4`（tag `old-ui-baseline-g0`），工作树干净（构建前 `git restore` 掉一处 `ui/package-lock.json` 的 self-version 漂移 0.1.0→0.9.0，使树逐字节等于 `ea0b914`）。

**命令**（在 worktree 根执行；`cargo-tauri 2.10.1`、node v24.18.0、cargo/rustc 1.93.1）：
```
PATH="$HOME/.cargo/bin:$PATH" cargo tauri build
```
`build.frontendDist = ../ui/dist`、`build.beforeBuildCommand = npm run build --prefix ../ui` → 打包时重新构建前端并**内嵌进二进制**（非 devUrl）。构建日志：`/tmp/g5-a4/b1-build.log`（`Finished release in 1m46s`，仅 warning，无 error）。

**产物与 SHA256**：

| 产物 | 路径 | SHA256 |
|---|---|---|
| 裸二进制 | `target/release/tinyssh-app` | `2c3ab20dbc90db7796b23e18f06dbf6262bf2bbd99da2ed92281d28ac5d08de8` |
| .app 内二进制 | `…/TinySSH.app/Contents/MacOS/tinyssh-app` | `2c3ab20dbc90db7796b23e18f06dbf6262bf2bbd99da2ed92281d28ac5d08de8`（与裸二进制同） |
| DMG | `target/release/bundle/dmg/TinySSH_0.9.0_aarch64.dmg` | `a8f4e5745805f599eee274f2d38f7caf8edd27cf22394048afff3f1e2729c15a` |

**§3 规则 2「关闭 vite dev server 状态下启动可用」验证**——以**更强口径**达成（**偏离登记**）：

- 本机 `:5183` 上有**他人工作流的 vite dev server**（PID 31602，主树 `ui/`）及 Chrome 连接；用户长期指令禁止打断用户环境，故**未停该 server**。改为直接证明**打包二进制不依赖它**：
  1. **加载 URL**：以 `TINYSSH_MASTER_KEY=<64 hex> TINYSSH_DB=<fresh>` 直启 `.app` 内二进制，stderr 记 `[app] window url: Ok(Url { scheme: "tauri", host: Domain("localhost") })`——即 `tauri://localhost/`（内嵌资产协议），**非** `http://localhost:5183`（`main.rs:1341` 无条件打印）。
  2. **套接字**：`lsof -a -p <app-pid> -i` 仅见 `localhost:8722 (LISTEN)`（进程内 MCP 端点），**无任何到 :5183 的连接**。
  3. **前端存活**：stderr 见 `[app] page load event: Started/Finished "main"` 与 `[app] mcp_status invoked (frontend alive)`——前端 JS 实际执行并回调 Rust。
  4. **视觉**：`screencapture` 见旧版固定三栏（主机/会话｜终端｜审批）正常渲染，主机列表含 `本机`、MCP 端点 `http://127.0.0.1:8722/mcp`。
- 该口径比「停 server 后能起」更强：**在 dev server 在场时**证明二进制不读它。原始日志 `/tmp/g5-a4/b1-launch.log`、截图 `/tmp/g5-a4/b1-screenshot.png`；正式归档时拷入本次证据包 `protocol/`。

**未做/边界**：B2（新版打包）未构建，待 G5 候选冻结；B1 未做代码签名/公证（`cargo tauri build` 默认 ad-hoc，本地验证够用，发布门需另议）。

## 2. 补测项（B1 上执行，冻结协议与 R04 一致）

| 项 | 协议脚本 | 优先级 | 说明 |
|---|---|---|---|
| P1 启动（列表就绪） | p1_launch.py | 高 | 打包版无 devUrl 依赖；验证 dev 前端条件与打包条件差值，作为 G5 同协议对比的旧版基线 |
| P3 建连 | p3_connect.py | 高 | 30 次，stderr 精确 matcher |
| P6 进程残留 | p6_cycles.py | 中 | 应用级循环（同进程门按 §3.3 冻结定义在受控环境执行） |
| P5 归属试点 | memsample v4.1 / p5_pilot / vmstat_probe | 中 | **前置已清**：采样器 v4→v4.1 收口两条 fail-closed 注记（2026-10-10，独立复核可签）；压力观测采集器 `scripts/perf/vmstat_probe.py` 已实现（签署 §3：vm_stat/只读压力/swap/压缩/页回收同步、预登记频率与失效判据 I1–I8），自测 15/15。独立复核中危项已收口：缺字段/缺基线 → 不可判（I8）、增长类判据 I2/I3/I4 改逐相位相对基线、裁决输入加读取保护、试点校验各相位采集子进程退出码 |
| P2 切换/回显 | p2_switch/p2_echo | 受控 | ev2 定向；专用机/独立测试登录会话（签署 §4 授权范围） |
| P4 传输 / P7 万条目录 | p4_download/p7_list | 受控 | 同上；P4/P7 期限为 G3 开始前 |

## 3. 执行规则

1. 每项补测记录：产物 SHA256、OS、前端条件（打包/无 dev server 进程佐证）、原始数据归档至 `docs/acceptance/ux-r1/<gate>/<date-commit>/`。
2. 打包条件验证：打包后二进制在**关闭 vite dev server**状态下启动可用（与 R04 §4.4 条件互斥确认）。
3. 数值口径沿用 r04-baseline §2（直打点、inclusive P95、无相减推断）；异常值不剔除。
4. 补测结果只替换「旧版基线引用值」用于 G5 对比；不重开 R04 已签关闭的 Q-01~Q-06 处置。
