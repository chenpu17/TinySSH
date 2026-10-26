# 2026-10-26 snippets 盘点 + 自动更新轮 · UX 台账

两项合一台账（同批未提交）。

## snippets 盘点（shell 集成注入片段覆盖面审计）

「snippets」在产品里的唯一实体是 shell 集成注入片段（OSC 133/7）。盘点结论——**本地/远端覆盖矩阵**：

| shell | 本地注入（transport-pty） | 远端注入（ssh_integration_snippet） |
|---|---|---|
| bash / zsh | ✅ rcfile/ZDOTDIR 注入 | ✅ 自守哨兵分支 |
| fish | ✅ 事件钩子（`shell_integration_fish`） | ❌ **POSIX sh 语法 fish 解析不了**（见下） |
| powershell / pwsh | ✅ prompt 包装 | ❌（远端 Windows OpenSSH 起的是 cmd/pwsh，V1 边界） |
| cmd / wsl / dash 等 | 如实标「无命令块」 | — |

**远端 fish 的真相**：片段是 POSIX sh 语法（`if ...; then ... fi`），fish 逐行报解析错——但尾清屏 `printf '\033[2J\033[H'` 恰好是 fish 也认的语句，报错被抹掉，集成状态机等 OSC ≤10s 超时如实置 Unavailable。观感无恙、语义诚实，**但不支持就是不支持**。已立案 V2 方案：polyglot printf 探针（`printf '__T=%s' "$BASH_VERSION"` 在 sh/fish/tcsh 都可解析、未定义变量都展开为空）预检登录 shell 类型 → 按型注入对应片段（fish 用 `shell_integration_fish` 同源片段）；触碰集成状态机与时序，须 sshd e2e 护航，另开一轮。

**本轮交付**：`crates/core-session/tests/snippet_audit.rs`（2 测试锁契约——bash/zsh 哨兵自守、POSIX 结构、OSC 133 A/B/C/D + OSC 7 全配齐、尾清屏恒为最后一行、全片段无 CR（CRLF 混入会废掉 handle.rs 的回显自门控））。文档：上表 + V2 立案。

## 自动更新（tauri-plugin-updater，V1）

**形态边界（如实）**：updater 插件在 Windows 只支持 NSIS/MSI 安装形态——**便携单文件 exe 不可自更新**；Linux 通道是 AppImage——仓库无 AppImage 产物。故 V1：**macOS（.app/.dmg）自动更新先行**，Windows 便携 / Linux 保持「check_update 检查 + 发布页下载」并如实说明。

- 后端：注册 `tauri-plugin-updater`（注册期不校验公钥——占位符构建启动零风险）；`updater_info`（configured=编译带真公钥 / supported=macOS 且 configured / platform）+ `updater_install`（check → download_and_install → app.restart()，进度经 `updater-progress` 事件透传；Ok(false)=已是最新；错误结构化 updater_unavailable/updater_failed）。
- 公钥注入：build.rs `rerun-if-env-changed=TAURI_UPDATER_PUBKEY` + rustc-env（**显式 rerun 是防 rust-cache 吐出没带公钥的旧产物**）；端点固定 `…/releases/latest/download/latest.json`。
- UI：设置 → 关于 更新行加「自动更新（下载并重启）」按钮——**只在 updaterCap.supported 时出现**（demo 域恒 null；Windows/Linux/未签名构建不摆无效按钮）；busy 文案「下载中…完成后自动重启」。
- release 工作流：mac 打包出 `.app.tar.gz`（updater 的 mac 更新格式）；配了 `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` 时 `tauri signer sign` + 生成 `latest.json`（darwin-aarch64/darwin-x86_64 双条目，node 校验 JSON 合法）；未配则如实跳过并在 Release notes 说明。上传 glob 条件附 latest.json。
- **用户动作（启用自动更新，三步）**：`npx @tauri-apps/cli signer generate -w tinyssh.key` 生成密钥对 → GitHub secrets 配三个（`TAURI_UPDATER_PUBKEY` 公钥、`TAURI_SIGNING_PRIVATE_KEY`、可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）→ 打 v* tag 发版，之后 mac 用户应用内一键升级。

**验证口径**：Rust 面 cargo check/workspace 测试 + fmt；UI 面 tsc + 全套（demo 域按钮不出现=既有断言不受扰）。**updater 全链路（真下载验签安装）需 macOS runner + secrets 实测，本轮未跑**——工作流与代码按插件 2.14.0 源码核对 API（check 在 Updater 上、build() 空端点报 EmptyEndpoints、download_and_install 签名），如实标注「待首次签名发版实测」。
