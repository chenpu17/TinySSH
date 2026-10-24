# CLAUDE.md

面向 coding agent 的项目工作手册。人读介绍见 [README.zh-CN.md](README.zh-CN.md)；动代码前先读 [L0](docs/architecture/l0-system-design.md)/[L1](docs/architecture/l1-component-design.md) 对应章节。

## 项目是什么

TinySSH：人机协同终端（Tauri v2 桌面应用）——SSH 客户端 + 一等公民本地终端 + 内置 AI Agent（内核为姊妹项目 [TinyAgent](https://github.com/chenpu17/TinyAgent)，git 依赖）。Windows 是第一平台。工作语言：中文（提交信息、文档、注释均中文）。

结构：`src-tauri/`（tauri 壳与命令层）· `crates/core-session`（SessionManager：会话/审批/记录/监控/探针）· `crates/session-api`（SessionApi 契约 + wire 类型）· `crates/transport-ssh|transport-pty` · `crates/term-core`（终端语义）· `crates/approval`（危险形态规则与审批链）· `crates/audit|records|vault` · `crates/mcp-server|shim` · `crates/agent-host`（内嵌 agent 八工具）· `crates/cli`（`tinyssh serve`/`agent`）· `ui/`（React + xterm.js，含 demo 域镜像后端行为）。

## 常用命令

```bash
# 前端 demo（纯浏览器，无需 Rust）
cd ui && npm ci && npm run dev        # http://localhost:5183
npm test                              # UI 套件 47 spec / 769 断言（headless）
npm run build                         # tsc + vite build

# 桌面 / Rust
cargo run -p tinyssh-app                      # dev（需 ui dev server）
cargo test --workspace -j 4                   # 并行过高会页面文件耗尽 os error 1455
cargo build -p tinyssh-app --release --features custom-protocol   # 便携 exe（必须带 feature，否则 localhost 拒连）

# e2e（docker sshd）
TINYSSH_E2E_SSHD=1 cargo test --workspace
```

UI 测试环境：`TINYSSH_UI_CHROME` 指向 Edge/Chrome（如 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`）、`TINYSSH_UI_BASE=http://127.0.0.1:5183`，在 `ui/` 下跑 `node test/run.cjs`。**跑全套前先杀 tinyssh-app（逐帧采样怕负载）；cargo 与 Playwright 永不并发。** `ui/` 唯一依赖是 playwright-core。

真机验证：`TINYSSH_WEBVIEW_ARGS="--remote-debugging-port=<port>"` 起应用，CDP 接入；DEV 构建页面有 `__t_terms` 助手（release 走 `__TAURI_INTERNALS__.invoke`）。

## 硬性约定

- **提交与推送仅在用户明确要求时进行**；`.zcode/` 永不入库（`git add -A && git reset -q -- .zcode/`）。
- **机密纪律**：测试凭据只经 `TINYSSH_LIVE_*` 环境变量传入，绝不写进仓库任何文件（含文档、fixture、探针脚本）。
- **审批链契约**（L1 为准）：Agent 与人类同一条危险形态引擎（粘贴保护 = Agent 审批同一张表）；传输必审；自主模式内存态、重启失效；终端回放/记录归因不撒谎（键序直写 PTY 不记命令块）。
- **终端真源**：终端状态以 term-core 为唯一真源，前端不自行推导。
- **demo 域保真**：`ui/src/demo.ts` 是后端行为的镜像（含 `new_session` 幂等合并等语义）；改后端行为必须同步 demo，否则 47 个 spec 全在错误世界上跑。
- **本机条目**：`local` 主机不可编辑/删除（`LocalHostImmutable`），唯一生成/复活途径是 `ensure_local_host`。
- 改 UI 后先 `npm run build` 再打 release；版本号三源同升（根/tauri.conf/ui package.json，build.rs 注入编译时间）。
- 提交信息风格：一句话中文摘要（可带冒号分类前缀），密度向既有 git log 看齐。

## TinyAgent 依赖

`crates/agent-host` 以 git 依赖钉 rev 引用 TinyAgent 内核（v0.4.2 tag 是 kernel 拆分前的旧单体布局，不含 `crates/core`，故钉 rev；待上游出含 kernel 的 0.4.3 tag 后改钉 tag）。升级流程：改 rev → `cargo update -p tiny-agent-core` → agent-host 与全工作区测试。本机 GitHub https 不通：已配全局 `url."git@github.com:".insteadOf` 覆写 + 仓库 `.cargo/config.toml` 的 `net.git-fetch-with-cli`，cargo 经 ssh 拉取；依赖镜像用 npmmirror/rsproxy。

## CI（.github/workflows/ci.yml）

push/PR 双跑：ubuntu（fmt + clippy + 除 `tinyssh-app` 外全 crate 测试 + ui build——tauri 壳在 linux 需 webkit2gtk 系统库，故排除）与 windows（全工作区测试 + ui build）。tier2（PR/手动）加 UI specs；tier3（手动）docker e2e。本地同款门禁：`scripts/ci/run.sh`。

## 语言与编码坑

- Rust 字节字面量 `b""` 不能含非 ASCII——中文测试数据用 `"…".as_bytes()`。
- PowerShell prompt 读状态码必须首条语句（`$?` 会被赋值语句置 true）。
- wmic `format:list` 的 CommandLine 与 ProcessId 分两行。
- 含反斜杠的代码写文件用工具（Edit/Write），别走 shell heredoc（会被吞一层）。
