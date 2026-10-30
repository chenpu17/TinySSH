# tmux 联动第一轮：恢复现场（「远端现场，断线也丢不了」）

日期：2026-10-29　状态：已落地（未提交，等指示）
前置讨论：本会话两轮产品推演——从「能做什么」收敛到「用户在哪个瞬间疼」；
对用户的唯一承诺是**断线也丢不了的远端现场**。tmux 只是兑现路径，不是功能面板。

## 产品设计（评审定稿）

- **不做** tmux 替代品、不做常驻 tmux 面板、不做 tmux.conf 分发、不做 tmuxinator 式模板、
  不做 tmux -CC 控制模式（远期独立立项，半吊子比没有更伤）。
- **界面零新增**：全部寄生在既有界面——断线遮罩、toast、⌘K、主机表单。
- **教学只在最疼的时刻出现一次**：断线时静默探测发现远端 tmux 会话仍在运行，
  横幅教一次；点「仅重连」= 30 天内不再问；点过「恢复现场」后永远按老手呈现。
- **文案讲结果不讲机制**：「恢复现场」，tmux 是括号里的注脚。

## 用户可见行为

1. **断线横幅三态**（`current.state === "Disconnected"` 时）：
   - 单键恢复（有 last 记忆或唯一会话）：`恢复现场` + `仅重连` + `下次断线自动恢复现场` 勾选；
   - 多会话/首次教学：内联挑选列表（每会话一键）+ 仅重连；
   - 无 tmux / 30 天压制：原样「重连恢复」。
2. **恢复现场 = 一次点击**：重连全机器 → `tmux capture-pane -p -e -S -400` 抓目标窗格近史 →
   写入本地 scrollback（\r\n 归一）→ PTY 注入 `tmux attach -t '<sel>'` → toast
   「已恢复现场（tmux work · 2 个窗口）」。二段式在前端：先补史再 attach（attach 后
   tmux 立即重绘整屏，顺序在前端才成立）。
3. **下次自动**：勾选后（vault KV `tmux.v1.prefs` 单键 JSON：auto/last/declined），
   断线→重连成功即静默恢复，仅在失败时打扰；核心侧 auto 注入带 2s 敲键守卫
   （与 fish 补写同纪律，绝不插队进用户正在输入的命令行）。
4. **⌘K 按需切换**：当前主机有 tmux 清单时出现「切换到 tmux 会话：work（2 窗口）」；
   已挂过 tmux 的会话自动改 `switch-client`（$TMUX 守卫）。无 tmux 时一个字不多。
5. **主机表单「连接后执行的命令」**：通用原语不做 tmux 专属开关；惯用法
   `tmux new -A -s work`（attach-or-create 一条命令）。建连后于提示符处执行、
   回显可见；行进 exec 门控清单（防污染首命令捕获窗）。

## 实现

### Rust（core-session / session-api / vault / src-tauri）

- `session-api`：`TmuxSession/TmuxStatus/TmuxRestorePlan` 契约；`SessionInfo.tmux`
  （serde default，仅 SSH 下发）；`Host/HostDraft.startup_command`（None=未设置/清除，空串归一）。
- `SessionHandle`：`tmux: StdMutex<TmuxStatus>`（**探测失败保留上次结果**——断线后
  exec_fresh 必失败，而横幅要展示的恰是断线前仍在运行的清单）+ `tmux_attached`（只跟踪
  自己注入的 attach，用户手动 attach 不猜测）。
- 三命令（GUI 专用面，同 reconnect_session 口径不进 SessionApi/MCP）：
  - `tmux_probe`：`exec_fresh` 独立通道跑 `tmux -V; tmux ls -F '名\t窗\t附'`——
    刻意零重定向零复合（Windows 远端 cmd 会把 `2>/dev/null` 当文件创建）；
    解析失败=无 tmux；`parse_tmux_probe` 容忍 stderr 噪音/坏行（单测钉）。
  - `tmux_restore`：Disconnected 先走既有手动重连全机器（事件照常推进）→ 探针 →
    capture-pane（`-e` 失败退朴素捕获，丢色不丢史）→ 返回计划；attach 由前端二段式下发。
  - `tmux_attach`：PTY 注入（人类归属）；行首空格防进 history（HISTCONTROL 尽力而为）；
    `tmux_selector` 版本自适应——≥3.1 用 `=name` 精确匹配防前缀误中（work≠workshop），
    老版本退普通名（单测钉 1.8/3.0/3.1/3.2a/4.0）。
- `inject_startup_command`：建连（集成批次后）与重连（reinject 内）共用；未开集成也注入。
- vault **V9 迁移**：`hosts.startup_command TEXT`；列存在性守卫同 V8（退版库裸 ALTER 必炸）。

### 前端（App.tsx / add-host / bridge / wire / i18n / demo 全镜像）

- 断线横幅 IIFE 三态；`restoreTmuxScene/attachTmux`（tmuxRestoringRef 在飞去重）；
- 自动恢复双钩子：`reconnectSession` 成功路径（**确定性路径**）+ `applyStateEvent`
  事件钩子（真实域泵自动重连；tauri 事件即时到达 prev 可靠）。
- 偏好 `tmux.v1.prefs` 单键 JSON 双域持久化；⌘K 条目；探测每会话静默一次
  （Connected/Reconfirming 窗口，`tmuxProbedRef` 防重）。
- i18n：新词条 EN 齐全；「恢复现场」复用既有键（坑 67 同键冲突择一存活）。

## 过程坑（新增）

- **坑 75：demo 主机卡连接走 `begin_connection`（attempt 路径），不走 `create_session`**
  ——镜像必须两处同构；只改 create_session 会让 spec 建连回显永远缺失。
- **坑 76：demo 域 300ms 轮询的 prev 竞态**——重连 invoke 完成后的 refreshLists 先把
  sessionsRef 更新成 Reconfirming，轮询事件再应用时 prev 已非断线态，事件钩子整窗错过。
  修法：手动重连的确定性触发放 reconnectSession 内，事件钩子只兜真实域泵路径。
- **坑 77：残留 toast 假绿**——toast 驻留 2.6s，waitToast 会命中上一步的同类 toast；
  断言自动恢复必须验终端缓冲（switch-client 回显）而非仅 toast。
- vault 退版库测试（c9 迁移）构造 version=6 但列已存在 → 裸 ALTER 炸；
  V9 照 V8 加 pragma_table_info 守卫。
- vite 缓存/多文件同名：无。TSX CRLF / heredoc 反斜杠老坑未再踩（全程 Edit/Write）。

## 验证

- cargo check --workspace --exclude tinyssh-app（含 --tests）全绿；cargo fmt 清账。
- cargo test workspace（exclude tinyssh-app）：48 个测试目标全绿（含新增
  parse_tmux_probe / tmux_selector 单测；c9 迁移退版库修复后过）。
- UI：tsc 零错 + vite build 绿；**spec 61 全新 22 断言全绿；全套 867/867**。
- 未验（如实）：真实远端 tmux 主机（attach/capture-pane/switch-client 实链路）——
  待真机走查；demo fixture 覆盖全部 UI 分支。

## 未做/另案

- tmux -CC 控制模式（远期独立 spike）；Agent 分身窗格（下一轮）；
- Zellij/Screen 探测；capture-pane 深度可配（现钉 400 行）；老 tmux(<3.1) 无 `=` 精确匹配。

## 加映：工具栏 tmux 快接钮（2026-10-29 用户验证反馈，未提交等指示）

用户实测踩中边界：关标签→重连是**全新会话**，不经断线态、无横幅；手敲 `tmux attach`
应用不感知（tmux_attached 只有走 tmux_attach 命令才置位）——「主动接入」当时唯一入口
是 ⌘K。本轮在会话工具栏（搜索钮与协作钮之间）加常驻快接钮：

- 渲染门控：`current.kind==="ssh" && current.tmux?.available`——无 tmux 的主机一个
  像素都不多（v2 红线）；未 attach 显 `tmux`，已 attach 显 `tmux:<会话名>`。
- 点开菜单列远端会话清单（`{0}（{1} 窗口）`，当前接入项标「当前」），**点开即重探
  一发**（静默探测每会话只打一发，清单会陈旧；exec_fresh 零屏污染）；点选走
  restoreTmuxScene 同链路（补史→attach/switch-client，prefs.last 同步记录）。
- 接线七处照 splitMenu 既有范式：state+ref/外部 mousedown 关闭/Esc 浮层链/modal
  门控/refreshTmuxList+pickTmuxSession/props。复用 IconTerminal 与 .tools-menu。
- i18n：3 词条（"接入 tmux 会话…"、"tmux：已接入 {0}…"、"{0}（{1} 窗口）"）；
  「当前」已有词条沿用。
- **坑 82：tmux_attached 随会话清单 3s 轮询下发**（demo 300ms 只是状态事件通道）——
  spec 断言钮面换装只等 600ms 必假红；evaluate 内轮询等 6s（坑 55 口径）。真实域
  钮面更新同理有 ≤3s 延迟，属可接受。
- 验证：tsc/build 绿；spec 61 升 28 断言（G 段 6 项：钮出现/菜单列清单/点选恢复
  toast/钮面 tmux:work/菜单标当前/Esc 关）+ spec 62 = 38/38 全绿。

### 坑 83：真域静默探针死锁（快接钮验证轮揪出，demo 镜像盲区第二例）

用户真机验证快接钮「没看到」→ 顺藤摸出 R1 检测链（横幅清单/⌘K/快接钮）在真实域
**从未工作过**：真实核心对 SSH 会话**无条件**回 `Some(TmuxStatus)`（未探测=
available:false 默认值，handle.rs:339 初始化即默认值），而静默探针门控写的是
`if (s.tmux) continue`——真值恒成立、探针一次不发。demo 镜像 list_sessions 对未
探测会话回 `null`（625 行 `s.tmux ?? null`），探针照跑、fixture 照落，38 断言全绿
纯属镜像语义差异（坑 74「mock 假绿」同族：**镜像形状必须逐字段对齐真核心**）。

修一行：门控改 `if (s.tmux?.available) continue`（核心已有**可用**清单才跳过）；
每会话只探一次由 tmuxProbedRef 守卫（available=false 探过亦不重发），断线保留
上次结果的语义不动。探针本体会落库（tmux_probe 写 h.tmux），3s 轮询不会回灌旧值。
⌘K 与横幅本就判 available、无恙；全库唯一真值门控即此一处。

教训入账：**wire 字段在「未发生」时 Rust 侧给不出 null 的（非 Option/无条件
Some），前端判真值就是判「永远发生过」——门控一律判语义位（available/len≥1），
镜 像 demo 要照抄「未探测」形状（null）而非省成真值。**

## 坑 84：切换注入被前台程序吃掉 → 改型 switch-client -c 零注入（2026-10-30 用户实测，未提交）

用户在 attach 会话里跑 claude code，用快接钮切会话：注入的明文
`tmux switch-client -t '=infer-02'` 被 claude code 当成用户输入吃掉，它还试图自己
执行（被它自己的 [Tmux Self Drive] 规则拦下）并回错话。注入机制的设计盲区：
**PTY 注入只能送达「当前前台读输入者」，shell 提示符只是恰好最常见**。

排查十一轮（v3–v13）得到的工具与方法论（比结论更值钱）：
- **capture-pane 证明不了 client 落点**——它跟的是 tmux_attached（我们自己记的
  名字），v3–v5 的「切换生效」全是验证方法自欺。落点铁证=list-clients 或
  `[detached (from session X)]` 消息。
- **read_screen 一旦 tmux_attached 非空就永不回 PTY**（capture 失败才兜底）——
  主 shell 的取证输出被 capture 盖掉，v6 空手而归的根因；取证要走文件、先杀
  会话让 capture 失败再读。
- **SessionLogFile 是 PTY 透视镜**（v10）：客户端画的每一帧（状态行/提示符/
  报错）都在原始字节流里，release 无 __t_terms 时的唯一窗口。
- **命令提示符注入被证伪**：原子写入 `\x02:` 前缀根本不生效（文本直落 pane）；
  分段写入提示符能打开但 ~400ms 内自灭换回普通状态行（字节流 v10 实录）。两态
  都不可靠，弃用。
- **终态机制**：`tmux switch-client -c <client> -t <target>` 从独立 SSH 通道
  （exec_fresh，同探针通路）指挥服务器切，**零注入、前台任何程序无扰**。client
  定位=list-clients 只列已 attach 会话上的客户端，**唯一才动**；多客户端（可能
  含他机同会话）绝不代切，报「切换需在 tmux 内直接进行（C-b s）」交还用户。
  v13 三断言真机过：cat 占前台切换生效/标记落 wtest2/wtest1 零字节泄漏。
- 首次 attach 仍走明文注入（PTY 此刻在提示符——断线重连后必在提示符）；「live
  会话前台是交互程序时的首次 attach」立案未修（罕见路径，横幅恢复不受影响）。
- demo 镜像不镜像注入机制（tmux_attach 只置态+演示回显），spec 61 的
  switch-client 回显断言验的是前端流，真域零回显是设计使然。
- 验证：workspace 48 目标全绿（fmt 清账）；spec 61+62=38/38；v13 真机 3/3。

## 加映：09:18 用户复验取证——两起「复发」均非本 app 所为（2026-10-30，未提交）

用户复验报两点：①claude code 里仍出现
`tmux list-sessions 2>&1; echo "---"; tmux capture-pane -p -t '=t-01' 2>&1 | tail -60`；
②快接菜单出现「之前其他主机」的会话，像跨主机总集合。

**审计库定案**（tinyssh.db audit_events，hash 链，node:sqlite 只读连 WAL）：

- 运行实例=09:04:26 构建/09:05:31 启动的零注入版；用户点击在 09:18:08。
- 该点击审计仅两行：`tmux_restore(t-01)` + `tmux_attach(t-01)`，无任何注入条目；
  新会话（09:17:38 建）走首次 attach 分支，明文 ` tmux attach -t '=t-01'` 只进
  本标签自己的全新 shell 提示符——claude code 在 tmux 会话内的服务器侧 PTY，
  物理不相交。
- 复合命令 grep 全库+全部走查脚本 0 命中；claude code 自己的 shell 命令在远端
  服务器内部执行，根本不经过本 app 的 PTY/审计——它 TUI 里显示的每条命令都是
  它自己跑的（它在盯 t-01 产出，capture-pane 正是监控动作）。清晨 08:19–08:20
  的 9 次切换是**旧二进制**（v1 明文注入版）——claude code 被灌 9 条
  switch-client、事后自己跑 tmux 命令查状态，均发生在 08:52 重启之前。

**菜单「总集合」**：tmux_probe 在该标签自己的 SSH 连接上跑 `tmux ls`——只可能
列出这一台服务器的会话，跨主机串台在结构上不可能（h.tmux 每 handle 一份、
SessionInfo 按会话下发、前端整表刷新）。审计实锤：08:19 一个连接探到 4 个会话
并成功 attach infer-01/02/03/04 全部四个（restore 按名在探针清单中查找，不存在
则 attach 不会发生）→ 这四个「infer 主机」实为**同一台服务器上的四个 tmux
会话**；09:18 新连接探到 6 个（t-01+infer-01..04+1）。会话名撞了主机条目命名
风格才读成「总集合」。用户自查一条命令：标签终端跑 `tmux ls`，与菜单逐项对照
必然一致。取证手段沉淀：**审计库=注入指控的金标准**——指控 app 发过什么字节，
先查 audit_events 有无对应条目；claude/agent 类前台程序的 TUI 自显命令不构成
注入证据。
