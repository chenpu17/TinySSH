# snippets V2 探针轮（2026-10-26）

立案兑现：snippets 盘点轮（同日 971a5ae 批次）立的「远端片段 POSIX-sh-only，fish 报错被尾清屏抹掉、集成如实 Unavailable」→ V2 用 polyglot printf 探针判登录 shell 家族，按型注入。

## 实现（Rust only，零前端改动）

- **探针行** `SSH_SHELL_PROBE`（core-session lib.rs）：`printf '__T=%s|%s|%s\n' "$BASH_VERSION" "$ZSH_VERSION" "$FISH_VERSION"`——sh/zsh/fish 同一行可解析（未定义变量在双引号内展开为空；fish 的 `$FISH_VERSION` 恒在）。**与立案的差异**：不另发独立预检请求，探针行并进注入文本**首行**、与 sh 片段同批执行——执行在钩子安装前（不产生命令块），输出与片段回显一起被既有尾清屏抹掉，bash/zsh 主机零额外延迟、零额外写。格式串以 `\n` 收尾（三路 subagent 审查轮 P0 修正，见下）。
- **判型** `classify_shell_probe()`：扫描输出找 `__T=` 标记，三字段按 `|` 拆分，字段过版本号白名单（`[0-9A-Za-z-.+_()]`）才有效——注入行的**回显**（含 `%s`/引号/空格）天然被拒；取首个有效者。80 字节窗口向回取整到 UTF-8 char 边界（多字节 banner 截半切片会 panic——审查轮 P1 修正）。Bash/Zsh/Fish 之外一律 `Sh`（sh 片段的 if 自守兜底，行为与 V1 完全一致）。
- **旁路判型任务** `spawn_shell_family_probe`（handle.rs）：`inject_integration` 先订阅输出再写（与泵同款纪律，防探针输出落入无订阅者窗口），写完派任务监听 ≤3s，判出 Fish 才补写 fish 片段；判型失败/超时/sh 族静默退出。**防插队守卫**：用户 2s 内敲过键（`last_human_input`）放弃本轮补写，避免补写文本插进正在输入的命令行（下次重连重探）。
- **fish 片段** `ssh_fish_integration_snippet()`：事件钩子制（`--on-event fish_preexec/postexec/prompt`），不覆盖用户自定义 prompt 函数；字段对应 sh 版——preexec→133 C、postexec→133 D;$status、prompt→OSC7+A+B。尾清屏抹补写回显，末行 `commandline -f repaint` 清屏后重画提示符并即刻触发 fish_prompt（首个标记，Ready 提前）。
- **回显自门控扩列**（handle.rs exec 捕获头剥离）：门控行清单 = sh 片段 + 探针行 + fish 补写片段，三者都可能以回显形态落进首命令捕获头；延续提示符行剥 `> ` 后再去前导缩进再比对（fish 函数体全带两空格，不剥则缩进行永远匹配不上——审查轮 P2 修正）。

## 坑

- **坑 73：workspace 全量 vs 单 crate 的特征统一差异 = 「单跑全绿、全量必炸」的 reqwest provider panic**。rmcp 3 内部直依赖 reqwest **0.13.5**（工作区直依赖是 0.12.28，二者并存）；rustls 0.23 在只统一到 ring 一个 provider 时可按 crate 特征自动安装，但 workspace 全量跑时 tauri/updater 栈把 aws-lc-rs 一并统一进来——双 provider 下自动安装失效，reqwest 0.13 建客户端即 panic（6 个 protocol 测试同因全败，症状像负载 flake 实为确定性）。修：mcp-server dev-deps 加 rustls 0.23，两处 `spawn_stack()` setup 显式 `rustls::crypto::ring::default_provider().install_default()`（重复安装静默忽略）。排查抓手：stash 单过滤测过 ≠ 干净——要先复现同构场景（全二进制/workspace）再对照。
- spike3 P95 310ms>300ms 门限：真·负载 flake（坑 66 同族），单跑 127s 绿，不立案。

## 审查轮（升版 0.10.1 前的三路 subagent 审核）

代码深审 / 文档与升版面 / 全量测试三路并行，测试路全绿（workspace 全部测试二进制 0 failed，含 spike3 本轮直接过、坑 73 修复生效）。深审揪出两个必须修的：

- **P0（已修）：探针输出无换行 → 真实主机判型几乎必然回落 Sh，fish 补写生产不可达**。交互 shell 自己回显且下一批输出（下一条命令的回显 / fish 解析报错 / 提示符）直接粘在 printf 输出之后——无换行则三字段白名单（拒空格/冒号/引号）必然失败。首轮测试全绿是 mock 假绿：mock 通道回吐的是「干净、LF 结尾、无回显无粘连」的现实里不存在的流。修：格式串补 `\n`（`probe_contract` 加契约断言防回退；`probe_classify` 补真实 PTY 形态用例：CRLF 收尾+粘连 junk 整体拒绝不误判不 panic）；接线测试 mock 改喂 CRLF 真实形态。
- **P1（已修）：判型 80 字节窗口 `.min(80)` 可切在 UTF-8 多字节中间 → 探针任务 panic（静默丢判型）**。修：`is_char_boundary` 向回取整；`probe_classify` 补「marker 后 ≥80 字节无换行 CJK」回归用例。
- **P2（已修）：exec 捕获头回显 gate 的延续行剥 `> ` 后保留源码缩进，与 trim 过的门控行永不等**——fish 片段函数体全带缩进，扩列后暴露面变大。修：剥提示符后 `trim_start()` 再比对。

**审查轮新立案（记录不阻塞发布）**：①「刚敲过键放弃补写」是一次性的（本会话不再重试，失败面=如实 Unavailable；候补：2s 静默后延迟重探）；②OSC 7 的 `file://$hostname$PWD` 未做百分号编码（V1 沿袭，路径含空格/中文时严格消费者解析错）；③`bash_host_no_fish_topup` 是纯 sleep 负向断言，探针任务早死测不出（候补：可注入窗口时长+完成信号）；④fish 补写在审计账本无条目（register_outgoing/字符集编码路径与主注入一致，唯审计缺账——与「向远端注入必留痕」口径不一致）。

## 验证

- snippet_audit 5/5（探针 polyglot 契约含 `\n` 收尾断言 / fish 片段契约 / 判型解析含回显先行、跨块边界、真实 PTY 粘连流、多字节截断回归）
- r26 接线测试 +2：`fish_host_gets_fish_snippet_topup`（mock 通道回吐 `__T=||3.7.1`（CRLF 真实形态）→ 补写必达且带 repaint 尾）、`bash_host_no_fish_topup`（bash 标记 → 窗口走完保持沉默）
- core-session 全绿（153 lib + 33 集成）；workspace 全部测试二进制 0 failed（坑 73 修复后，spike3 本轮直接过）
- `cargo fmt --all` 清账；Rust 之外的**代码**零改动（demo 域不涉此路径；文档与 lockfile 有同步动）

## 边界与诚实

- **真 fish 远端未实测**（本机无 fish、在手远端主机无 fish）——链路证据=接线级 mock 测试 + fish 片段按官方事件模型核对；与 V1 的 fish/pwsh 本地同口径。真机 fish 验证候补：docker sshd e2e 加 fish 镜像变体。
- tcsh/csh 仍不支持：未定义变量报错 → 输出无有效标记 → 判型 Sh → sh 片段照发（报错被尾清屏抹掉）→ 如实 Unavailable，与 V1 一致。
- Windows OpenSSH 远端（cmd/powershell 登录 shell）：探针行命令不存在报错同样被清屏抹掉，行为同 V1。
- 补写竞态窗：判型期间用户打字 >2s 守卫兜住；重连场景本来就整体重注入，风险面与 V1 相同。
