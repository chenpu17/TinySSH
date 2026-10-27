# 2026-10-27 v0.10.2 hotfix 轮 · UX 台账

找茬轮（0.10.1 发版后开放式「到处看看、测试测试」）揪出发布级 P0 并当轮修复升版。

## P0：v0.10.1 全平台产物启动即 panic（DOA）

- **现象**：真机冒烟首启即炸——`PluginInitialization("updater", "invalid type: null, expected struct Config")`（main.rs tauri Builder run 处 panic）。CI 构建的 Release 资产同配置同命。
- **根因**：tauri-plugin-updater 2.14.0 注册（`Builder::new().pubkey(...)`）要求 tauri.conf.json **存在 `plugins.updater` 段**；`endpoints`/`pubkey` 均无 serde default，缺段=Tauri 传 `Value::Null` 进反序列化=必炸。Builder 的 `.pubkey()` 只是 setup 期事后覆盖（插件 lib.rs `config.pubkey = pubkey`），不参与反序列化。updater 轮「占位符构建启动零风险」是**没启动过的推断**。
- **三路全盲的教训**：UI 套件跑 vite dev + 浏览器（demo 域），从不启动 Rust app；`cargo test` 不运行 bin 目标；CI/Release 只构建不启动。updater 轮（971a5ae）落地后无人启动过任何构建（target/debug exe 停在 10-19 即物证）。「构建绿」≠「能起」——**发布前真机启动产物冒烟自此为必做步骤**。
- **修复**：tauri.conf.json 补 `plugins.updater`（pubkey 空串占位 + endpoints 指向 latest.json，运行期 Builder 用 build.rs 注入值/固定端点覆盖）；新增 `src-tauri/tests/tauri_conf_sentinel.rs` 静态哨兵（include_str! 解析 conf，钉住段存在与形状，防任何 conf 改写再次删掉）。
- **验证闭环**：补段重建 release → CDP 冒烟 ver-tag/本机卡置顶/本地会话自动开/零控制台错全过（先于落库完成，DOA 不再）。

## 找茬轮其他修复（同批）

- **F1｜Windows OpenSSH 远端注入呕吐永不清除（P1）**：尾清屏是批次内一行 `printf`（lib.rs:2030），cmd/PowerShell 没有 printf——清屏根本不执行，注入源码+报错永留终端、每次重连再吐；cmd 还把探针行裸 `|` 拆管道（本机 cmd 实测 `'%s' 不是内部或外部命令`）。**修**（探针侧检测-自愈，不动 connect 关键路径）：`windows_probe_error`（lib.rs）识别「报错引用 printf」签名——cmd 中文（'printf' 不是内部或外部命令）、cmd 英文（is not recognized as an internal）、PowerShell 全 locale（异常类型名 CommandNotFoundException 不本地化）→ 探针任务发 `cls` 自愈清屏 + 置 `remote_shell_blocked` 旗标 + 集成即刻 Unavailable + `run_shell` 快速拒绝（host_setting 如实传 true：是平台没有可注入 POSIX shell，不是用户没开开关）——该会话「每次 exec 白等 10s」的存量痛一并了结。其余 cmd 语种如实维持旧行为，零呕吐正解（TCP banner 嗅探）立案：russh 0.63 未暴露 remote_sshid，包裹流手术风险不成比例。
- **F2｜探针任务跨重连双写（P2）**：transport 层 broadcast 跨重连存活（transport-ssh:315 channel 不随重连重建），快速断线重连时新旧探针任务同挂一个广播、fish 补写可双写。**修**：`probe_task: StdMutex<Option<JoinHandle>>` 存句柄，inject 前 abort 旧任务；`close_session` 同步收口（10s 窗口下僵尸窗口同步变大）。
- **F3｜探针窗口 3s→10s（P2）**：与同文件重连路径「实测 3s 不够」对齐——慢登录 fish 主机此前判型永远落空且此后每次 exec 罚 10s。
- **i18n｜4 个裸键缺 EN（低）**：`最近使用 {0}`/`从未使用`（设置→Agent 接入）、`未知错误`（agent-view+sftp）、`已取消`（sftp）——字典只有带 ` · ` 前缀的变体键（键不匹配非漏翻译），补裸键。
- **立案未动**：F4 回显门控收窄（门控存在的真因是 ConPTY/慢回显在**首个命令捕获窗**的污染，「收敛到首提示符前」与 run_shell 等待-捕获时序模型冲突，发布日不轻动）；F6 classify 非行首锚定的 motd 误判面（后果有界）；banner 嗅探（见 F1）。

## 验证（本机，2026-10-27）

- clippy `--workspace --exclude tinyssh-app`（CI tier1 同口径）零 error；`cargo fmt --all` 清账。
- workspace 测试 `--exclude tinyssh-app`（CI tier1 同口径）**EXIT=0，48 个 result ok 零失败**；core-session 定向 **155 passed**（含 +2 新接线测试：cmd 阻断自愈、reinject abort 防双写）；哨兵测试 pass。
- UI 全套 **52 spec / 842 断言全绿**（含 v0.10.2 版本断言）。
- release 构建（custom-protocol）3m37s → 真机启动冒烟 **PASS**。
- 本机环境注记：rustc 1.99.1 编译 tinyssh-app **debug** 目标（bin+test unit）连续两次 `STATUS_STACK_BUFFER_OVERRUN` 崩溃（清增量+关增量均现）；同源码在 CI windows 全量绿、本机 release 剖面 3m37s 通过——判定本机 debug 剖面工具链/环境问题而非代码问题，本地按 CI tier1 口径（exclude tinyssh-app）验证 + CI windows 兜底全量。

## 版本与发布

0.10.2 三源同升（workspace Cargo.toml / tauri.conf.json / ui package.json）+ package-lock 两处 + spec 09 断言 + README 双语快照（顺带把过期的「48 spec / 789 断言」修成 52/842）；Cargo.lock 随构建自刷。
