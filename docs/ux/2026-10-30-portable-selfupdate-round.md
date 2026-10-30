# 便携版自更新轮（Windows 便携 exe 应用内一键升级）

日期：2026-10-30　|　状态：已落地+真机走查正负双路径全过，未提交等指示

## 背景

tauri-plugin-updater 在 Windows 只支持 NSIS/MSI 安装形态，主发货件是便携单文件
exe——此前 Windows 用户只能「检测提示 + 发布页手动下载」。本轮为便携版打通
应用内自动升级，与 macOS 插件通道吃同一份 latest.json。

## 原理

Windows 文件语义：运行中的 exe 不能覆盖/删除，**但能改名**。自替换三步：

1. 下载新 exe → 验签（minisign，公钥编译期注入）→ 写同目录暂存名 `.new` + fsync；
2. 两步改名换身：`TinySSH.exe → TinySSH.exe.old`，`TinySSH.exe.new → TinySSH.exe`；
3. 带旗标 `TINYSSH_UPDATE_RELAUNCH=1` 拉起新版 → 旧进程受控退出。

vault 独占锁的交接竞态（新实例先起、旧实例锁未放）由启动期限时重试兜住：
relaunch 旗标下 `SessionManager::open` 失败重试最长 15s，正常双开路径零改动。
启动期（拿到锁后）清扫 `.old`/`.new` 残留，尽力而为。

## 变更面

- **src-tauri/src/main.rs**：`updater_info` 增 `channel`（plugin/portable/""）、
  `supported` 放开 Windows；`updater_install` Windows 分支走 `portable_update`
  （清单→版本门→流式下载+进度事件→验签→换身），收口复用 quit_app 同款
  （撤端点文件/快照/shutdown_all）再 spawn+exit；mac 分支补 `.pubkey()` 显式覆盖
  （conf 内 pubkey 恒空串，此前 mac 插件通道验签必败的潜在缺口）；
  `check_update` 支持 `TINYSSH_UPDATER_ENDPOINT` 改道（检测/安装同源，真机走查
  本地假源/将来镜像源）；`should_install_portable` 纯函数版本门；启动期 relaunch
  重试 + 残留清扫。单测 6 个（验签契约/清单解析/换身正反路径/安装门方向）。
- **src-tauri/Cargo.toml**：+minisign-verify 0.3、base64 0.22（均在依赖树，零新源码）。
- **release.yml**：windows 作业签名便携 exe + 产 `updater-frag-windows.json` 片段；
  mac 作业改产 `updater-frag-darwin.json` 片段；release 作业合并片段成 latest.json
  （version/pub_date 统一注入）；**顺手修 release 作业空 VER bug**（v0.10.6 发布
  说明实锤 `TinySSH__windows_x64_portable.exe`——VER 只在 build 作业生效）。
- **前端**：wire.ts `UpdaterInfo.channel`；demo.ts `?autoupdater` 场景旗标
  （updater_info/check_update/updater_install 三镜像）；App.tsx 把 check_update/
  updater_info 移出 inTauri 门（此前 demo 域根本不调用，镜像成死代码）；spec 09
  +5 断言（40/40）。
- **测试密钥对**：`tauri signer generate` 真产物钉进契约单测（密钥仅测试用）。

## 坑与教训

- **坑 87：`.sig` 文件本身就是单行 base64**——`tauri signer sign` 产出的 .sig 是
  minisign 文本的 base64 包装（396 字节无换行）。终端 cat 的"多行"是折行视觉
  假象；据此先入为主判 release.yml `sig=$(cat ...)` 是"潜在炸点"要再套一层
  base64——**契约单测当场证伪**（签名解析失败），错误修复被拦在落地前。
  教训：格式契约只信真产物+真验签管线，不信终端肉眼看。
- **坑 88：安装门方向写反**——`compare_versions(current, latest)` 的 Ordering
  语义与 check_update 相同（Less=有更新），首版写成 `Greater => 动手`，单测测
  不到（分支在 async 命令内），真机走查点按钮即「已是最新」当场揪出。修复=
  抽 `should_install_portable` 纯函数+方向单测。教训：比较器语义复用时先对齐
  既有调用点的方向注释；命令内分支抽纯函数才可测。
- **坑 89：cargo build 两次同源产物相同**——build.rs 的 BUILD_TIME 只在包内
  文件变更时重跑，连跑两遍 build 产物哈希不变，"换身前后哈希不同"的断言失效。
  真机走查造差异化载荷要 touch 源文件再编。
- 本机 workspace 全量测试在链接期 LNK1102 内存不足（并行链接多个大测试二进制），
  拆两段跑：`-j 2 --workspace --exclude tinyssh-app` 全绿 + `-p tinyssh-app` 单独
  13+2 全绿。既有坑 66 同族（本机容量问题，非代码问题）。

## 真机走查（本地假源 127.0.0.1:18971 + CDP 18972）

- 正路径：假源 latest.json v99.0.0 + 真签载荷（哈希 f33d3833）→ 更新行/双钮
  出现 → 点「自动更新」→ 下载+验签+换身 → 旧进程退、新进程接棒（vault 锁交接
  无感）、磁盘哈希=载荷、.old/.new 零残留（启动清扫生效）。
- 负路径：载荷翻转 2 字节后（签名不匹配）→ 点更新 → toast「更新包验签失败」
  如实报错、进程不重启、磁盘哈希不动、**零落盘**（验签在写盘之前）。

## 审查轮（三路 subagent 并行 + 全部复验，2026-10-30）

安全/Rust、CI 链路、前端接线三路独立审查，裁决=修后发布；以下全部核实为真并已修：

- **【P1】下载无读停滞超时**（停滞挂死=按钮永久 busy，大陆访问 GitHub 最常见
  故障模式）→ 安装路径专用客户端：连接 10s / 读停滞 30s / 全程 10 分钟封顶；
  清单拉取从 5s 检查预算放宽到 30s。
- **【P2】fsync 静默 no-op**：只读句柄的 FlushFileBuffers 在 Windows 必败 →
  OpenOptions 写句柄 write_all + 同句柄 sync_all，失败如实报错。
- **【P2】mac 分支不吃改道端点**（检测说有新版、安装查 GitHub 说没有的自相
  矛盾）→ `updater_endpoint()` 三通道统一。
- **【P2】mac 进度累加器跨调用不归零**（进程级 static）→ 每次安装局部归零；
  便携通道进度 100ms 节流（事件暂无前端消费方，保留为进度 UI 挂点）。
- **【P2】改道端点安全门**：非 https/loopback 一律忽略回落默认端点
  （`endpoint_override_allowed` 纯函数+8 断言单测+活体验证）。
- **【P2】spawn 失败文案**改为「更新已装好，仅自动重启未成功」（前端会拼
  「自动更新失败：」前缀，原文案自相矛盾）。
- **CI**：片段侧 JSON 自检曾被 `set +e` 废掉 → 全程 set -e（mac 循环的
  `[ ] &&` 短路改 if，免首元素假值误杀）；合并后 `rm -f updater-frag-*.json`
  （否则 `sha256sum *` 收孤儿条目毁 `sha256sum -c`）；`@tauri-apps/cli@2` 锁大版本。
- **前端**：demo 镜像 platform 值 "win32"→"windows"（与 `std::env::consts::OS`
  同源，坑 74 形状保真）；wire.ts 注释同步。

**已接受风险（记录在案）**：①清单未签名→可被改指旧版真签名包=降级，与
tauri-plugin-updater 威胁模型同水位，签名闸保证「最多降级、不能装假包」；
②换身两步改名间崩溃窗口=一次系统调用，现场用户可手动 `.old` 改回；③
`updater-progress` 事件两通道暂无前端消费（busy 文案兜底），进度 UI 另立案；
④改道模式下「打开发布页」按钮实为产物直链（仅走查/镜像源场景）。

## 复验（修复后全链路）

- cargo：tinyssh-app 14+2 全绿（+端点安全门 8 断言），check/fmt 清。
- 前端：build 绿，spec 09 40/40。
- 真机（本地假源+CDP）：安全门活体=非 loopback http 改道被忽略回落 GitHub
  （无更新行）；正路径全链=更新行→点按→下载验签换身→旧进程退新进程接棒、
  磁盘哈希=载荷、零残留。

## 未尽事项

- 大陆可达性（github 直连慢/断）未解——`TINYSSH_UPDATER_ENDPOINT` 改道机制
  已就位，gitee 镜像源另立案。
- mac 插件通道的 `.pubkey()` 修复未经真机验证（无 mac 设备+secrets 未配），
  待首次配 secrets 发版时走查。
- 启用三步不变：signer generate（生产密钥）+ 三 secrets + 打 tag。
