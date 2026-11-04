# 监控墙键入 + 面板格子最大化轮（2026-11-03）

用户反馈原话：「我还是希望监控大屏可以用户进行互动操作，虽然小点，但是有时候用起来顺手，另外在tmux 小窗口 x左边增加最大化的按钮来最大化，最大化以后也保留外框，同时具备还原的外框小按钮」。两项都拍板落地。

## 一、定案

**⓪ 交互模型二稿（用户复述需求后定案）：单击小窗=就地键入，不放大；放大=格子右上放大钮/双击。**
一稿把交互做成「单击=放大+键入」，用户复述原话点破偏差（「虽然小点，但是有时候用起来顺手」=小窗直接编辑；「点击还是放大，再点击缩小」=点击不该承担放大）。二稿：单击正文=就地键入（焦点圈 accent 标示）；放大只走**格子右上放大钮**（IconMaximize/Minimize 换装，保留外框、还原钮在框上——与面板格子同款语义）或双击正文；光标 text 提示可编辑。键入机制不变（send-keys 服务端 API）。验证：全套 1104/1104（spec 65=32）、真机快验 16/16 全 PASS（就地键入端到端/Esc=0x1b/放大钮/还原钮/双击往返/放大态键入）。

**① 大屏键入 = tmux send-keys 服务端 API，不是给每格挂活 PTY。**
初想「每格 attach 客户端」被否，决定性理由：tmux 多客户端共用会话时窗口尺寸跟随客户端（默认 latest/smallest 策略），小格（30×10 级）一旦成为尺寸决定者，**外面的真终端一起变形**——监控墙的本质优势（零客户端）会变成全局副作用。send-keys 是 tmux 服务端 API（坑 84 教训的正解：跨程序无扰操作走服务端不走键入），零客户端零尺寸副作用，读侧照旧 2s 节拍快照；写侧发送与单格补拍**同一 exec 一趟往返**，反馈 ~200ms。

- 可见字符 150ms 批量（快打字不炸 exec 频率）；特殊键（Enter/C-c/方向/Ctrl 组合/M-x）冲字面即发——字面捎带同枪，shell 场景等价「打完词按回车」一条命令。
- 键位翻译 keydown→tmux 键名（BSpace/BTab/C-Up/F1-12…）；IME 走 compositionend；粘贴走 paste 事件（字面直送）。
- 白名单+闸门：键名 `字母开头/字母数字短横/≤12`；字面 ≤8192 字符、控制字符只放行 \n\r\t；键数 ≤16。注入面归零。
- Esc 语义重排：**键入焦点在格 → Esc 先发给会话**（vim 可用）；点头部空白退键入后，Esc 才逐级退出（放大→关屏）。头部空白点击=键入态唯一退口（放大态没有空白 body）。
- 选区保护：格内选中文本（复制手势）时单击不放大不夺焦点、Ctrl+C 走浏览器复制；焦点自愈 onBlur 抢回（选区为空才抢）。
- 面板格子（活 PTY 通道）完全不动——「深度操作进格子」的分工不变。

**② 面板格子最大化/还原 = × 左边加钮，放大保留外框。**
`tmux-cell-zoom` 钮在 close 钮左边；放大=整幅只呈一格：主视图/兄弟格暂隐、分隔条撤收、布局树冻结（`paneLayoutLastRef=null`），**格子外框（标题栏）常显**——还原钮就在框上（图标/文案随态换装 maximize-2/minimize-2）。zoom 键按名（与布局树同口径）；`{sid,name}` 单值：换标签不套用（别的标签照常网格），切回自动恢复；格被关/掉线重建不在清单即自然还原（残记就地清掉）。自定义拖拽布局树（paneLayoutRef）原样保留，还原时按原树重排。

## 二、实现面

- **core**：`tmux_wall_selector`（id/名选择器提取共用）、`tmux_wall_key_ok`（键名白名单）、`tmux_wall_input_cmd`（send-keys 链 + 同款帧协议补拍：`-l` 字面 + `--` 终结选项——负号开头的文本不被 getopt 吃成旗标）、`tmux_wall_input`（校验+exec+`parse_tmux_wall(out,1)` 取 0 号格）。`tmux_wall_cmd` 重构用共用选择器（行为不变，单测钉住）。
- **Tauri/bridge**：`tmux_wall_input(sid, target, lit, keys) -> TmuxWallCell` 命令 + CmdArgs/CmdRet。
- **前端 tmux-wall.tsx**：`sendInput` prop；`active` 格键态；隐藏输入框（1px 透明、pointer-events:none，程序化 focus）挂在 active 格内；`sendNow/flushLit/queueLit/sendKeyNow` 键入管线（挂载期才写 frames，卸载回包丢弃）；`specialKeyOf` 翻译表；焦点圈 `.tw-active` accent 边框+标题栏染色。
- **App.tsx zoom**：`paneZoomRef`+`paneRelayoutRef`（建格监听→重排的 ref 间接层）；`layoutTmuxPanes` 三路（zoom 分支/早退/常规）统一 `syncAllZoomBtns()`；主视图 display 显式交还（zoom 曾置 none）。
- **demo 镜像**：`demoWallSnap` 合成器（快照与补拍共用一份——输入返回的新帧=下次节拍会拍到的内容）；输入镜像最小 shell 语义（字面回显/Enter 提交/BSpace 退格/C-c 清行）+ `__wall_inputs` 计数。
- **键位防串**（本轮挖出的真雷）：keymap 分发器补闸——`.tw-input` 聚焦时除 Esc 外不放行任何 action（native 下 Ctrl+W 是 werase 不是关标签、Ctrl+F 是搜索不是开查找；W4 豁免同口径，但 W4 那条只认 xterm-helper-textarea，覆盖不到隐藏输入框）。

## 三、验证

- Rust：core-session **186/186**（新增 `tmux_wall_input_cmd_shape`：构造链序/引号转义/`--`/白名单逐例/老版本退化/纯补拍）。
- UI 全套 **1103/1103**（57 specs；spec 63 +3=112：钮位次/放大态五断言/还原回网格；spec 65 +6=31：solo+焦点在位/字面回显/键入计数/Enter 提交/Ctrl+C 落屏/Esc 先发会话+点空白退键入）；tsc 0；npm build ✓。
- 真机（release 隔离实例）：见走查段。

## 四、真机走查

**二稿快验（wt-wall3，16/16 全 PASS）**：单击小窗就地键入（solo=false+焦点在框）→ `touch` 回显进小格+Enter 远端落地；Esc=0x1b 直达且屏不开放大；放大钮→solo+外框保留+「还原（回到网格）」换装+键入焦点跟入→放大态键入照达→还原钮回网格；双击正文放大/再双击还原。截图 w3-maxcell/w3-grid.png。

**一稿（29/29 全 PASS，交互模型后被二稿替换）**：release 隔离实例（库副本 `wall-db2` + 独立 WebView + CDP 9224），腾讯-广州 tmux 3.4，只动 `tspwt-` 前缀——

- **键入端到端**：单击放大获键入焦点（tw-active+隐藏输入框 focused）→ 字面回显即时进格（补拍 ~400ms）→ `touch /tmp/wall-typed` + Enter **远端文件真落地**（send-keys→shell 全链）→ 执行行进格。
- **负号字面**：`touch /tmp/-wall-dash` 完整送达（`-l --` 终结选项实证，getopt 不吃负号开头文本）。
- **Ctrl+C**：`sleep 30` 真跑再掐断，^C 落屏（capture grep=1）。
- **Esc 字节直达**：`cat > file` 收流态按 Esc → 文件恰 1 字节 `od`=**1b**（Escape 以 0x1b 送达会话），大屏不关不退放大。
- **非放大键入**：退放大后点 w2 格头 → 键入焦点不 solo → `echo > /tmp/wall-head` 照达。
- **Esc 链**：头部空白点击退键入（focus 断）→ Esc 关屏；键入态 Esc 不走关屏链。
- **面板最大化/还原**：zoom 钮在 × 左（head 第一颗钮）→ 放大后整幅只呈一格（几何=全幅、主视图 display:none、分隔条 0 条、**外框标题栏保留**）→ 钮换装「还原窗格（回到网格）」→ 还原后格子回网格、主视图回归、钮换回最大化、分隔条回归。截图 `wall2-focus/typed/zoom/restore.png`。
- 收尾：tspwt-* 全杀（ALL-CLEAN）、隔离库/WebView 目录删除、真实主库 sha256 前后一致（`253a197380…`）、哨兵存活（无页面重载）、页面零 JS 错误（CSP/wasm 既有条件除外）。

**走查自身两课**：①`h.rc` 的标记匹配吃不住「无尾换行输出」（`od|tr -d ' \n'` 把结束标记粘进行内）——rc 断言命令一律补 `; echo`，否则**功能全对、断言假失败**（首轮 4 FAIL 里 3 个是脚本，1 个是这段）；②隐藏输入框 mounted≠focused——键入断言前先验 `document.activeElement`，不在框就重击兜底。

## 六、本轮最大事故：给用户的实例跑的是旧前端（非本特性 bug）

用户复验「还是不能编辑、点击还是放大」——用户实例**确实在跑旧前端**：我上一轮拉起用的是裸 `cargo build --release`（缺 `custom-protocol` feature），exe 静默连去 devUrl（localhost:5183 的 vite dev server，恰好转着）；而 WebView2 磁盘缓存里存的是**开发模式无 hash 模块 URL**，永不失效→用户实例吃缓存的旧模块。走查实例用全新 WEBVIEW2_USER_DATA_FOLDER（无缓存）拉到新源码，29/29 全绿——**走查绿 ≠ 用户看到的构建**。取证：缓存文件里 `grep -ao "vite/dist/client/env.mjs"`（出现=vite dev 前端）+ `netstat` 看 exe PID 是否 ESTABLISHED 到 5183。修复=带 feature 重编+只清 `EBWebView/Default/{Cache,Code Cache,GPUCache}`（Local Storage/IndexedDB 不动，偏好在里面）。**纪律：给用户重启一律 `--features tinyssh-app/custom-protocol`，重启后 netstat 验零连接。**

## 五、教训

1. **「只读墙要互动」有第三条路：读照旧快照、写走服务端 API**——不必在「全活 PTY（贵+尺寸副作用）」与「纯只读」之间二选一。send-keys+单格即拍把互动成本摊薄到每次按键。
2. **多客户端窗口尺寸是 attach 的隐性全局副作用**：监控场景里小格客户端会把会话窗口拽小，殃及所有真终端。给会话「加眼睛」前先问尺寸归谁定。
3. **隐藏输入框是窗口捕获层快捷键的盲区**：W4 豁免只认 xterm-helper-textarea，自己的输入控件要自己补闸（keymap 分发器按 activeElement 类名豁免）。
4. spec 先行捉到实现漏洞（还原钮 title 不同步——常规路径漏挂 syncAllZoomBtns）：三路布局出口统一收口的纪律，漏一条就有残态。
