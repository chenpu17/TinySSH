# 单一二进制发布（Windows 便携 exe）

> 二十三轮落地。产物 = 单个 exe 文件：双击即用，无安装器、无旁置 DLL/资源文件。
> 构建入口：`scripts/dist-portable.sh`；本文件是发布契约（构成、依赖面、核查清单），
> 不重复构建步骤细节（脚本头注释已述）。

## 契约

- 产物名 `TinySSH_<版本>_windows_x64_portable.exe`，归档在
  `dist-portable/<日期>-<commit>/`（附 `SHA256SUMS.txt` + `COMMIT.txt`）。
- 可放到任意可读目录运行（U 盘、只读挂载均可）；**不写 exe 所在目录**——
  全部用户状态落 `~/.tinyssh/`（HOME 或 USERPROFILE，见 main.rs `dirs_or_home`：
  DB、审计、会话日志；下载默认目录 = 家目录 Downloads）。
- 运行期仅依赖两项外部条件：
  1. **系统 WebView2 Runtime**（Win10 1803+/Win11 内置；极老 LTSC/裁剪系统需先装
     Evergreen Runtime——应用不内嵌 WebView2 安装器，缺 runtime 时 Tauri 弹引导窗）。
  2. 用户家目录可写（首次启动建 `~/.tinyssh`）。

## 为什么单文件成立（依赖面清单）

| 依赖 | 处理方式 | 出处 |
| --- | --- | --- |
| 前端资源（React/xterm/字体/样式） | release 构建经 `generate_context!` 把 `ui/dist` **编译期内嵌**进 exe；`devUrl` 仅 dev 生效 | tauri.conf.json `build.frontendDist` |
| SQLite | `rusqlite` bundled 特性，C 源码编译进二进制 | 根 Cargo.toml |
| TLS/加密 | `reqwest` rustls-tls（无 openssl-sys）；SSH 走 russh（ring，NASM 汇编编期内联） | 根 Cargo.toml |
| CRT（VC++ Redist） | vcruntime/msvcp **静态链接**（`.cargo/config.toml` 对 `x86_64-pc-windows-msvc` 加 `+crt-static`）——这两个 DLL 才是 VC++ Redist 的内容，缺失时启动即弹缺 DLL。UCRT（api-ms-win-crt-\* api-set）仍动态导入，但它是 **Win10+ 操作系统自带**组件（ucrtbase 随系统分发），不属 Redist，不构成分发障碍 | 本轮新增 |
| WebView2Loader.dll | MSVC 目标下 webview2-com-sys 静态链接 loader，无需旁置 | 依赖链（PE 导入表核查兜底，见下） |
| 图标/版本/清单资源 | tauri-build 从 `bundle.icon` + workspace version 编期嵌入 exe 资源段 | tauri.conf.json |
| 控制台窗口 | release 下 `windows_subsystem = "windows"`，双击无黑框 | main.rs 首行属性 |

## 构建

前置：Rust MSVC 工具链、Node、**NASM**（aws-lc-sys 在 MSVC 目标要汇编；后台/CI shell
常不带机器级 PATH，脚本对缺失显式挡下）。

```
CARGO_BUILD_JOBS=4 bash scripts/dist-portable.sh   # 低内存机限并行
# 或直接：npm run build --prefix ui && cargo build --release -p tinyssh-app
```

## 发布前核查清单（每版必跑）

1. **导入表核查（每版必跑）**：对 exe 解析 PE 导入表（`objdump -p` 或 python 结构化解析
   ——整文件 `grep "\.dll"` 会把 .rdata 字符串当导入，噪音大不得作准）。0.9.0 基线：
   30 项硬导入，全部为 OS 系统 DLL + UCRT/api-set；**不得出现**
   `VCRUNTIME140*.dll`、`MSVCP140.dll`、`WebView2Loader.dll`、`conpty.dll` 硬导入
   （conpty/dbghelp 仅作为 .rdata 里的运行期 LoadLibrary 探针名存在，有 kernel32
   内建 API 兜底，正常）。
2. **干净目录独立运行**：拷 exe 到空目录启动——UI 完整渲染（前端确系内嵌的最硬证据）、
   资源目录/设置/会话恢复正常、退出无残留。
3. **版本资源**：`(Get-Item <exe>).VersionInfo` 报对 ProductName/Version/图标。
4. SHA256 与 COMMIT 对档（脚本已生成）。

## 边界与非目标

- **安装器（nsis/msi）是另一条路线**，本脚本不产出；`scripts/dist.sh` 是 macOS
  .app/.dmg 路线，二者互不影响。
- macOS 语义上不存在单 exe（GUI 应用必须 .app bundle）；Linux 可后续加 AppImage
  达成同「单文件」语义，未排期。
- 单 exe 不含自动更新器：升级 = 替换 exe 文件（用户数据在 `~/.tinyssh` 不受影响）。
- 防病毒误报：无签名二进制的固有风险，签名（codesign/ Authenticode）属发布工程，未排期。
