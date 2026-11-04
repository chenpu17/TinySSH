# 工具栏净化 + tmux 一级显眼 + 新建 tmux 会话轮（2026-11-03）

用户反馈原话：「工具栏的 交给agent 协作 文件 按钮似乎没有必要存在，其他地方也有入口了。tmux特性是我们重要的功能，但是好像不够显眼。另外我们能否直接支持创建tmux会话，让用户更加方便。」三项都核实后落地。

## 一、定案

**① 工具栏三钮下线（核实属实）**：交给 Agent/协作/文件三个按钮各有常驻替身——右缘 rb-rail（活动栏轮加映）的 rb-files/rb-collab 就是文件/协作的一级入口，⌘K 命令面板有「交给 Agent…」项、协作面板「委托」小节有 delegate-open-panel。工具栏只留 tmux 快接/搜索/分屏/工具菜单（工具菜单内部仍可切端口转发/命令块/活动记录——setRightPanel prop 保留，只有按钮下线）。

**② tmux 显眼**：快接钮加 `tmux-quick-btn` 类——accent 字色+描边，在一排 ghost 钮里站出来；接入后标签变 `tmux:名` 状态可读。

**③ 新建 tmux 会话（作曲行内嵌快接菜单）**：远端 `tmux new-session -d -s <名>` 分离创建（不抢任何屏幕）；成功即关作曲行+刷清单+走 pickTmuxSession 既有链路接入（创建即进现场，快接钮换装 `tmux:fresh9`）。

## 二、实现面

- **core**：`tmux_session_name_ok`（白名单：字母/数字/下划线开头+`-_`，1–64 字节，数字开头合法；tmux 自身只禁 `:`/`.`，白名单免去一切引号顾虑）、`tmux_session_has_cmd`（`=` 精确选择器预检同名，老版本退普通名；`@@HAS` 标记——compound 的 rc 被 echo 抹平不能靠 exit_code）、`tmux_session_create_cmd`（`-d` 分离 + `@@RC|N` 标记紧贴 `$?`）、`tmux_session_create`（SSH 门/名字校验/预检可读错误「已存在」/rc 兜底竞态）。
- **Tauri/bridge**：`tmux_session_create(sid, name) -> ()` 命令 + CmdArgs/CmdRet。
- **工具栏**：三钮删除；作曲行（输入框 autoFocus + Enter 提交/Esc 取消 stopPropagation、错误就地 role=alert、busy 禁用提交）；成功 toast「已创建并接入 tmux 会话「{0}」」。
- **App**：作曲四态 + `submitTmuxCreate`（失败保行可改可重提）；菜单关闭 effect 弃残态；keymap 分发器补 `.tmux-create-input` 全拦（含 Esc——Esc 在作曲行是「取消」，走浮层链会连菜单一起关）。
- **demo 镜像**：白名单正则/同名/未连接逐条同口径；创建只落清单条目（attached:0）。
- **settings-panel 顺带修**：「在会话工具栏或协作面板点…」→「在协作面板（右缘 rail）点…」（按钮已不存在）。
- **i18n**：新键 7 条；死键 4 条删除（交还会话…/首次委托…/协作：审批…必须可达/文件：远程目录浏览——「交还 Agent」「交给 Agent…」「协作」「文件」短键保留，confirm-dialogs/collab-panel/rb-rail 还在用）。

## 三、验证

- Rust：core-session **187/187**（新增 `tmux_session_create_cmd_shape`：白名单逐例/预检 `=` 选择器/`@@RC` 标记/老版本退化）。测试自己先咬一口：初版白名单把 `9lives` 列进拒绝例（数字开头其实合法）——改测试不改码。
- tsc 0；spec 63 **122/122**（新段 O：净化断言+委托入口+作曲行全流程：非法名/同名预检/Esc 取消菜单不关/Enter 创建 toast/创建即接入换装/清单新行）。
- 全套 + npm build：见下节。

## 四、教训

1. **删入口前先 grep 替身**（用户说「其他地方也有入口」也要核实）：rb-rail 是 `</aside>` 兄弟节点不在 `rightPanel &&` 条件块内=真常驻；⌘K delegate 项、collab-panel delegate-open-panel 都在。核实后删得心安。
2. **删 prop 留神「部分复用」**：setRightPanel 在协作/文件钮里死了，但工具菜单内部三处还用——tsc 一把抓回。删 prop 前全文件 grep。
3. **spec 假设他人前提**：spec 63 的 demo 主机上 `collabConfigured && owner === "Human"` 不成立（spec 08 用的本机）——delegate-open-panel 不渲染。入口存在性归 08，63 只断面板可达。
4. **作曲行 Esc 的焦点竞态**：点击提交钮失败后焦点在钮上，直接按 Esc 走 keymap 浮层链（关菜单）而非输入框 handler——spec 先 focus 输入框再按 Esc。
