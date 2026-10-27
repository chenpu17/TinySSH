# 2026-10-27 macOS 产物 DOA 修复轮 · UX 台账

v0.10.2 发布后用户真机反馈「mac 很难用」：Gatekeeper 拦截 → 设置允许 → 钥匙串弹窗 → 最后启动还是失败。按约定让用户在 mac 上跑 `xattr -cr` + 直启二进制抓 stderr，实锤死因。

## P0：macOS 产物启动即崩（v0.10.0–0.10.2 全部携带，mac 版从未成功启动过）

- **现象**（用户 MacBook Pro 直启 stderr）：
  `Failed to setup app: a webview with label 'main' already exists` → `panic in a function that cannot unwind` → abort。日志里 `setup: windows=["main"]` 即罪证——setup 钩子开跑前窗口已存在。
- **根因**：平台覆盖层的 `app.windows` 数组**整体替换**基础配置（非合并）。`cbd8c80`（可测试性轮）把窗口创建移入 setup 钩子、基础配置 main 窗口标 `create:false`；十轮 `a9e4ec4`（mac 字段平台分离）新增 `tauri.macos.conf.json`，但覆盖层条目**丢了 `label` 和 `create:false`**——Tauri 按默认值解析（label 默认 "main"、create 默认 true）启动期自动建了一个 main 窗口，setup 再程序化建第二个 → 撞 label → setup hook panic → tauri 2.12 `Failed to setup app` → did_finish_launching 不可展开 → abort。Windows 不炸是因为 `tauri.windows.conf.json` 条目带了 `create:false`；Linux 无覆盖层文件，走基础配置也安全——**唯独 mac 覆盖层是有人手写又无人启动过的**。
- **为什么三轮发布都没发现**：三路全盲的平台变体——UI 套件跑 vite（demo 域）、cargo test 不跑 bin、CI/Release 只构建不启动。Windows 有真机启动冒烟，mac 没有任何人与任何机器启动过产物。
- **修复**：`tauri.macos.conf.json` 补 `"label":"main"` + `"create":false`（titleBarStyle/hiddenTitle 等 mac 专属样式保留，setup 的 `from_config` 会读合并后配置）；哨兵 `tauri_conf_sentinel.rs` 新增 `main_window_must_not_autocreate_on_any_platform`——三个 conf 各自 app.windows 恰一条、label=main、create=false。

## 同批加固

- **mac 启动失败可见化**：`show_fatal_dialog` 非 Windows 分支原来只有 `eprintln!`（Finder 启动的 .app 无控制台，任何启动期致命错误都表现为「Dock 弹一下就退出」）。macOS 分支走零依赖 `osascript display dialog`（转义 `\` 和 `"`）弹原生错误框，与 Windows 的 MessageBoxW 对齐；Linux 保持 eprintln。
- **release.yml mac 任务加启动冒烟**：解包 arm64 `.app.zip` 真启动，15s 进程存活 + 日志无 panic + 走到 `setup: windows=` 三条件全过才继续；失败 `::error` + 全量日志，挡在 artifact 上传之前。`TINYSSH_MASTER_KEY` 环境变量绕开钥匙串（runner 上避免 ACL 交互挂起）。此步本可同时拦住 updater DOA（v0.10.1）与本次 mac DOA。
- **发布说明 mac 行扩写**：Finder 拖入 /Applications（防隔离转存致钥匙串反复弹窗）→ 右键打开 → `xattr -cr` 兜底 → 钥匙串弹窗点「允许」（凭据加密主密钥存于钥匙串，`crates/vault/src/lib.rs:245`）。

## 用户侧死因排查备忘（本轮实测有效）

```bash
xattr -cr /Applications/TinySSH.app
/Applications/TinySSH.app/Contents/MacOS/TinySSH   # stderr 直出启动错误
```

本轮由此排除钥匙串/vault 嫌疑（vault 开库成功、MCP 端点已起，崩在 Tauri setup）。

## 验证

- 哨兵 `cargo test -p tinyssh-app --test tauri_conf_sentinel` **2/2 绿**（新契约直接钉住本次 bug 形态）；release.yml 经 js-yaml 语法校验过；`cargo fmt` 清账。
- **真 mac 端到端验证待下次发版闭环**：本机无 macOS；release.yml 的 mac 启动冒烟会在 CI 里真启动产物（这正是本轮补上的盲区），用户下载新版实测为最终验收。
- Windows 零影响：改动只在 macos conf / 非 Windows cfg 分支 / CI mac 任务。

## 未竟

- **Gatekeeper + 钥匙串的根治 = Apple Developer ID 签名 + 公证**（$99/年，用户决策未拍板）：签名后 Gatekeeper 静默通过、钥匙串 ACL 绑定稳定身份、「始终允许」生效。未签名分发的缓解（文档 + 冒烟 + 可见报错）本轮已做。
- 发版：本批随 **v0.10.3** 三源升版 + tag 触发 release.yml——mac 产物首次在 CI 真启动冒烟把关后才出货；用户 macOS 端到端验收以下载新版为准。Apple Developer ID 签名/公证仍待用户注册（secrets 配好后下版自动生效）。
