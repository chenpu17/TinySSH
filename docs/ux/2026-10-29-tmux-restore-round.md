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
