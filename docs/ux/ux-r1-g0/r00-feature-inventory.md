# R00 功能盘点：重构前（7c4502e）用户可见能力全量清单 + §5 迁移表核对

> 日期：2026-10-06 · 基线：`7c4502e`（UX-R1 设计包基线，代码同 `8491d06`）
> 方法：通读 `ui/src/App.tsx`（2964 行全读）、`ui/src/demo.ts`、`ui/src/icons.tsx`、`ui/src/styles.css`（选择器结构）、`src-tauri/src/main.rs`、`src-tauri/tauri.conf.json`；core-session 交叉验证（本地终端路径、事件桥）。
> 用途：R00 冻结「逐项核对主文 §5；用户可见能力有新入口」的输入。§5 表 17 行全部可对应；**8 项 GAP**（§5 未直接覆盖）与 **2 项 STALE**（§5 前提与现状不符）需要冻结单登记；**8 项悬空问题**待 PM/Core 决定。

## ① IPC / 事件清单总表

### Tauri 命令（main.rs `invoke_handler` L904-916，共 39 个）

| 命令 | 用途 | UI 调用点 | demo shim |
|---|---|---|---|
| `list_hosts` | 主机列表 | App.tsx:508 | ✅ |
| `upsert_host` | 新增/编辑主机（auth: Password/Key/Agent/Keep） | App.tsx:2735 | ✅ |
| `delete_host` | 删除主机 | App.tsx:1217 | ✅ |
| `create_identity` | 凭据创建（Import/Generate/Password，回元数据+指纹） | App.tsx:2674,2690 | ✅ |
| `list_identities` | 凭据列表 | **无 UI 调用（死命令）** | ✅(空) |
| `ssh_config_preview` | ~/.ssh/config 预览 | App.tsx:2883 | ✅ |
| `ssh_config_import` | 按勾选导入 | App.tsx:2896 | ✅ |
| `list_sessions` | 会话列表 | App.tsx:507 | ✅ |
| `create_session` | 建连（host_id="local" 走本地 PTY） | App.tsx:1553 | ✅(TOFU/2FA 演示) |
| `close_session` | 关闭会话 | App.tsx:1150 | ✅ |
| `reconnect_session` | 断线重连（进 Reconfirming） | App.tsx:1575 | ✅ |
| `resize` | PTY 尺寸 | App.tsx:597,885 | ✅(no-op) |
| `subscribe_output` | 输出订阅（Channel 桥，Raw 字节直通） | App.tsx:1079 | ✅ |
| `read_screen` | 屏幕快照（回放+光标归位 / resize 对账） | App.tsx:593,1064,1076,245 | ✅ |
| `send_keys` | 键入直发 | App.tsx:759,801,829,2207,2263 | ✅ |
| `exec_human` | 命令框执行（人类旁路，不经审批） | App.tsx:2249 | ✅ |
| `set_control` | 接管/交还（stop_running→BestEffort） | App.tsx:1589,1599,1607 | ✅ |
| `session_brief` | 现场简报 | App.tsx:524 | ✅ |
| `set_session_goal` | 任务目标设置/清除 | App.tsx:560 | ✅ |
| `list_approvals` | 审批列表（pending_only=false 全量） | App.tsx:510 | ✅ |
| `decide_approval` | approve/deny/edit(ApproveEdited) | App.tsx:1617 | ✅ |
| `audit_query` | 审计分页（列表轮询+传输对账） | App.tsx:513,1496 | ✅ |
| `pending_host_keys` | 指纹待决列表 | App.tsx:621,630 | ✅ |
| `decide_host_key` | 指纹信任/拒绝 | App.tsx:1317 | ✅ |
| `pending_auth_prompts` | 2FA 提示待决列表 | App.tsx:624,633 | ✅ |
| `answer_auth_prompt` | 2FA 应答（空串=取消） | App.tsx:651 | ✅ |
| `upload_file` | SFTP 上传 | App.tsx:1353 | ❌ 显式报错 |
| `download_file` | SFTP 下载（local 缺省 ~/Downloads） | App.tsx:1368 | ❌ 显式报错 |
| `cancel_transfer` | 取消传输 | App.tsx:2456 | ✅(no-op) |
| `sftp_list` | 目录浏览（人类旁路） | App.tsx:1388 | ✅(演示树) |
| `list_forwards` | 转发列表 | App.tsx:1419 | ✅ |
| `start_forward` | 建转发（-L/-R/-D 外部标签 spec） | App.tsx:1463 | ✅ |
| `stop_forward` | 停转发 | App.tsx:1484 | ✅ |
| `get_setting` / `set_setting` | 偏好 KV（ui.font_size/ui.theme） | App.tsx:923,967 | ✅(localStorage) |
| `open_url` | 打开链接（http/https 白名单） | App.tsx:677,691 | ✅(window.open) |
| `issue_agent` | Agent Token 签发 | 仅 smoke 注入脚本用（main.rs:724） | ❌ |
| `mcp_status` | MCP 端点+Agent 列表 | App.tsx:574 | ✅ |
| `note_terminal` | 终端聚焦上报（native Ctrl 拦截依据） | App.tsx:839,1031,1110,1031 等 | ✅(no-op) |
| `bench_mode` / `bench_start` / `bench_report` | SPIKE-1 IPC 吞吐基准（TINYSSH_BENCH=1 门控） | App.tsx:223-252,575 | ✅(false/no-op) |

### 后端 → 前端事件（window.emit）

| 事件 | 发射点 | 前端监听 | 备注 |
|---|---|---|---|
| `approval-event` | main.rs:802（订阅广播桥） | App.tsx:609 | 触发 refreshLists |
| `forward-event` | main.rs:815 | App.tsx:1436 | 会话匹配才刷新 |
| `hostkey-event` | main.rs:827 | App.tsx:638 | 队列去重 |
| `authprompt-event` | main.rs:841 | App.tsx:642 | 队列去重 |
| `menu-settings` | main.rs:782（原生菜单「设置…⌘,」） | App.tsx:915 | |
| `resync` | main.rs:221,224（subscribe_output 的 Resync/Lagged 分支） | **无任何监听 —— 断链** | channel 内 `msg.includes("resync")` 分支（App.tsx:1063）真实路径不可达：subscribe_output 只发 Raw，Resync 走 window.emit。失步后 UI 无自动恢复 |
| `tauri://drag-*` | main.rs:871-874（TINYSSH_TEST_DRAG 门控） | onDragDropEvent 同构 | dev 走查钩子 |

### 前端轮询（事件兜底/对账）

| 轮询 | 周期 | 位置 |
|---|---|---|
| 列表+简报+PTY 尺寸对账 | 3s | App.tsx:581-603 |
| 转发列表（事件兜底） | 3s | App.tsx:1429 |
| 传输终态审计对账（有 running 卡时） | 800ms | App.tsx:1494-1507 |
| 指纹/2FA 待决（仅非 Tauri demo） | 500ms | App.tsx:620-627 |

## ② 功能盘点总表

### A. 左栏（220px 固定，styles.css:164）

| # | 功能 | 入口/实现 | IPC | 持久化 | 键盘 |
|---|---|---|---|---|---|
| A1 | 标题栏行融合（红绿灯位/整行拖拽） | App.tsx:1657, styles.css:.head-left | — | — | — |
| A2 | 导入开关按钮 | App.tsx:1660 | — | — | 有（按钮 focus） |
| A3 | 添加主机开关按钮 | App.tsx:1664 | — | — | 有 |
| A4 | SSH config 导入面板：预览勾选/已导入标记/逐条结果 | App.tsx:2875-2963 | ssh_config_preview/import | vault 主机 | 有 |
| A5 | 添加主机表单：名称/地址/端口/用户名/认证（密码/私钥/Agent）/编码 | App.tsx:2649-2871 | upsert_host | vault | 有 |
| A6 | 私钥粘贴/文件导入/生成 ed25519 → 指纹确认后绑定 | App.tsx:2669-2699,2833-2854 | create_identity | vault 凭据库 | 有 |
| A7 | 编辑主机：Keep 凭据/显式换密码/TOFU 信任状态与指纹出示 | App.tsx:2721-2725,2793-2813 | upsert_host(auth=Keep) | vault | 有 |
| A8 | 「保存并连接」/「仅保存」双提交 | App.tsx:2858-2866 | upsert_host+create_session | vault | 有 |
| A9 | 主机卡：GBK/在线计数/认证徽章、地址行、上次失败标记 | App.tsx:1709-1737 | — | — | title 提示 |
| A10 | 主机卡智能点击：有会话切最近会话，无则连接 | App.tsx:1716-1719 | — | — | — |
| A11 | 主机卡 hover 操作：编辑/删除 | App.tsx:1740-1743 | — | — | 无专用键 |
| A12 | 主机「连接」按钮（连接中 spinner；**连接中全局禁用所有主机按钮**） | App.tsx:1745-1748 | create_session | — | 有 |
| A13 | 会话卡：主机名+状态+sid 前 12 位、重连/断开按钮 | App.tsx:1759-1788 | reconnect/close_session | — | Enter/Space 可达 |
| A14 | Agent 接入区：端点+Agent 列表+三步接入说明（CLI 签发 token） | App.tsx:1790-1820 | mcp_status | vault(Agent 表) | 有 |

### B. 中栏（弹性终端）

| # | 功能 | 入口/实现 | IPC | 键盘 |
|---|---|---|---|---|
| B1 | 面板标题：主机名+sid+OSC 标题+状态标签 | App.tsx:1826-1836 | — | — |
| B2 | 控制权徽标（我控制中/Agent 控制中/手动控制三态） | App.tsx:1838-1843 | — | — |
| B3 | 接管 / 接管并停止任务（停止结果逐条横幅） / 交还 Agent | App.tsx:1846-1864,1952-1969 | set_control | 有 |
| B4 | 双接管语义说明 notice-bar；Reconfirming 警示条 | App.tsx:1882-1892 | — | — |
| B5 | 标签栏：状态点/主机名/分屏钮/关闭钮；溢出滚动钮+隐藏计数；活动标签滚入视野 | App.tsx:1896-1942,402-437 | — | Enter/Space、⌘⇧[ ] |
| B6 | 退出分屏按钮 / 标签栏「＋」新建连接 | App.tsx:1940-1941 | — | 有 |
| B7 | 连接失败常驻横幅（可行动文案） | App.tsx:1943-1951,1550-1568 | — | — |
| B8 | 断开会话确认弹层 / 删除主机确认弹层（死会话直接关） | App.tsx:1970-1993,1207-1228 | close_session/delete_host | — |
| B9 | 指纹确认弹窗（首见/变更双形态，队列逐个出示） | App.tsx:1994-2030,613-647 | pending_host_keys/decide_host_key | — |
| B10 | 2FA 认证弹窗（echo/password 输入、取消认证） | App.tsx:2031-2058,648-652 | pending_auth_prompts/answer_auth_prompt | — |
| B11 | 欢迎页（四步说明+添加主机+导入+已有会话提示） | App.tsx:2060-2082 | — | — |
| B12 | 断线 dead-overlay：画面保留声明+输入拦截+重连恢复 | App.tsx:2084-2099,750-757 | reconnect_session | — |
| B13 | 拖拽上传：覆盖层+目标目录（正在浏览目录优先，否则简报 cwd） | App.tsx:2100-2107,1336-1359,1523-1548 | upload_file | — |
| B14 | attach 提示条（会话已接入） | App.tsx:2108-2110,1083-1084 | — | — |
| B15 | 终端内搜索浮层：计数/上下导航/Esc 关闭/焦点保护 | App.tsx:2111-2150,1279-1284 | — | ⌘F、⇧⏎ |
| B16 | 显示设置面板：字号 +/−/重置（9-28）、四主题预设（chrome 跟随+原生窗口外观同步）、版本号 | App.tsx:2152-2186,905-972 | get/set_setting | vault settings | ⌘= ⌘− ⌘0 |
| B17 | xterm 终端交互：每会话独立实例、快照回放+光标归位、订阅/失步 resync（见悬空-1）、fit+PTY 对账、scrollback 5000 | App.tsx:655-764,860-903,1049-1085 | read_screen/subscribe_output/resize | — |
| B18 | 键盘保真：Ctrl+C/D/L 控制字符、⌥Meta 序列（词跳/tmux）、⌘C/V/A/F、IME 规避（native Ctrl 拦截 main.rs:459-504）、死会话输入拦截警示 | App.tsx:702-746,786-855 | send_keys/note_terminal | ✅ |
| B19 | OSC8/URL 链接点击（http/https 白名单经系统浏览器） | App.tsx:675-693 | open_url | — |
| B20 | 窗口标题跟随会话主机 | App.tsx:1305-1311 | setTitle | — |
| B21 | 命令框：执行（❯ 回显）、↑↓ 历史、Ctrl+C 清空/空输入中断、死会话拦截 | App.tsx:2189-2255,492-494 | exec_human/send_keys | ✅ |
| B22 | 中断按钮（SIGINT 前台进程） | App.tsx:2256-2270 | send_keys(\x03) | — |
| B23 | 分屏：双窗格 50/50、焦点/布局解耦、pane 名牌、attach 替换主 pane、副 pane 关闭焦点回落 | App.tsx:1002-1144 | — | — |

### C. 右栏（280px 固定）

| # | 功能 | 入口/实现 | IPC |
|---|---|---|---|
| C1 | 审批队列：目标主机上下文/分段报告/风险分级（全段 pending + 高危形态正则）+ 批准二次确认/编辑后批准（editable 门控）/拒绝 | App.tsx:2281-2332,1616-1635 | list_approvals/decide_approval |
| C2 | 最近处理折叠行（六态标签：批准/编辑后批准/拒绝/超时/作废+原因） | App.tsx:2333-2348,95-101 | 同上 |
| C3 | 远程文件浏览器：路径框/上级/刷新、骨架、空目录、条目（目录/文件/大小/日期）、文件下载按钮 | App.tsx:2353-2423,1383-1398 | sftp_list/download_file |
| C4 | 按路径下载输入框（存 ~/Downloads） | App.tsx:2427-2437 | download_file |
| C5 | 传输卡：方向/状态四态/完成字节数/取消；完成/失败 toast | App.tsx:2441-2463,1492-1520 | cancel_transfer/audit_query |
| C6 | 端口转发：类型选择+监听端口+目标两行表单、启动（Failed 不清输入）、列表（路线/状态含 Degraded 释义/停止） | App.tsx:2466-2521,1414-1489 | list/start/stop_forward |
| C7 | 任务目标：textarea 自动增高、保存/清除、按会话草稿暂存（切标签不丢） | App.tsx:2523-2549,477-570 | set_session_goal |
| C8 | 现场简报卡：cwd/运行中/最近命令+退出码/控制权变迁、认知徽标三态 | App.tsx:2551-2556,2591-2646 | session_brief |
| C9 | 操作记录时间线：时间+主机+actor+29 动作中文映射+命令；隐藏内部事件 | App.tsx:2558-2575,134-184 | audit_query |
| C10 | Toast：右下角 2.6s、err assertive 其余 polite | App.tsx:2579-2583,456-463 | — |

### D. 全局 / 原生层

| # | 功能 | 位置 |
|---|---|---|
| D1 | 快捷键全集：⌘1-9 切会话、⌘W 关标签（确认门）、⌘⇧[ ] 循环、⌘F 搜索、⌘=/−/0 字号、Esc 逐层关浮层（不劫持终端） | App.tsx:978-998,1231-1276,1289-1303 |
| D2 | macOS 原生菜单：TinySSH/编辑/显示/窗口，中文标签，设置…⌘,，无 ⌘W 关窗项（标签语义占用） | main.rs:515-561 |
| D3 | native Ctrl 键拦截（IME 229 规避，虚拟键码→C0 表，终端聚焦门控） | main.rs:409-504 |
| D4 | MCP 端点进程内装配（8722 起端口递增，失败降级「未启动」） | main.rs:587-608 |
| D5 | 四路事件桥（审批/转发/指纹/2FA） | main.rs:794-842 |
| D6 | 窗口：1280×800、min 960×600、Overlay 标题栏、暗色底 | tauri.conf.json |
| D7 | 错误文案映射：auth/refused/timeout/dns/keychain/decrypt/取消 2FA 分类（friendlyError） | App.tsx:204-221 |
| D8 | 浏览器演示模式：种子数据（主机/会话/审批/审计）、TOFU/2FA 挂起演示、SFTP 演示树、转发注册表、审批 PascalCase 归一 | demo.ts 全文件 |

### E. 开发工具（非用户功能，R00 需登记去留）

| # | 功能 | 位置 |
|---|---|---|
| E1 | SPIKE-1 IPC 吞吐基准（TINYSSH_BENCH=1；写 /tmp/tinyssh-spike1.json 后 exit） | main.rs:332-384, App.tsx:223-252 |
| E2 | TINYSSH_SMOKE=1 注入冒烟脚本（**依赖旧 DOM 选择器**：`aria-label="添加主机"`、`.add-host`、`.hk-dialog` 等 → R45 需重写） | main.rs:619-770 |
| E3 | TINYSSH_AUTOCONNECT 启动即建连 | main.rs:844-857 |
| E4 | TINYSSH_TEST_DRAG 触发器文件模拟拖拽（dev+门控双保险） | main.rs:863-901 |
| E5 | ui/ 下 20+ 个 pv_*/recheck_* 走查脚本（写死个人浏览器路径，交付 §6.1 已登记 R45 整合） | ui/*.cjs |

## ③ GAP 清单：代码有用户可见能力、§5 迁移表未直接覆盖（R00 冻结单须给出去向）

| ID | 能力 | 证据 | 建议去向 | 严重度 |
|---|---|---|---|---|
| GAP-1 | OSC8/URL 链接点击打开（http/https 白名单） | App.tsx:675-693 | §1.3 范围表「OSC 链接」保留列已含；冻结单登记入 S05 终端能力清单，验收归 B03 | 低 |
| GAP-2 | GBK/UTF-8 编码选择（表单字段+主机卡徽章+解码链路） | App.tsx:2656,2786-2792,1725 | §1.3 范围表「UTF-8/GBK」保留列已含；并入连接表单「更多设置」（§6.1 已含编码），验收归 A04 | 低 |
| GAP-3 | 窗口级拖拽上传及其目标目录规则（浏览目录优先→简报 cwd→无 cwd 失败卡） | App.tsx:1336-1359,1523-1548 | §6.5 上传入口已有完整新设计（含目标确认），冻结单确认迁移映射即可 | 中 |
| GAP-4 | 主机/会话卡辅助 affordance：上次连接失败标记、在线会话计数徽章、sid 摘要、attach 提示条、死会话拦截警示文案 | App.tsx:1734-1736,1726-1729,1773,2108,750-757 | §6.1/§6.4 已定新行为（聚焦最近会话/画面保留）；「失败标记」「计数徽章」去留在冻结单明确（标签态可承载） | 中 |
| GAP-5 | 审批卡前端风险分级与二次确认（全段 pending 提示 + DANGER_SHAPE_RE 高危形态 + 「再次点击确认批准」） | App.tsx:1627-1635,2317-2324 | §6.7 审批详情未提前端风险提示层；**需决议：保留前端减速带 or 后移至核心/契约** | 中 |
| GAP-6 | SPIKE-1 bench 命令三件套（bench_mode/start/report） | main.rs:332-384 | 内部工具；冻结单决议：保留（性能基线 R04/R51 还要用）or V2 移除 | 低 |
| GAP-7 | dev harness：TINYSSH_AUTOCONNECT / TINYSSH_TEST_DRAG（SMOKE 已被交付 §6.1 覆盖但依赖旧 DOM 选择器） | main.rs:619-901 | AUTOCONNECT/TEST_DRAG 保留为走查基建并列入 R45 更新清单（新选择器） | 低 |
| GAP-8 | 窗口标题跟随会话主机 | App.tsx:1305-1311 | 登记入 S05 终端工作区行为 | 低 |

## ④ STALE 清单：§5 前提与代码现状不符

| ID | §5 表述 | 现状 | 处理建议 |
|---|---|---|---|
| STALE-1 | 「首次委托、审批、接管、交还 → 协作入口…显式转交会话控制权」列为**现有功能迁移** | 「审批/接管/交还」存在；**「首次委托（交给 Agent）」不存在**——现状是人类 `create_session` 即 Agent-owned（core-session handle.rs:108），无显式委托动作 | 冻结单把「首次委托」标为**新增行为**（D09/C2/R42），不是迁移；避免 G01 核对时误把现状当回归基线 |
| STALE-2 | 「本地终端 → 新标签菜单 → 本地终端」按现有功能迁移 | 核心能力存在（core-session/lib.rs:458-483：host_id="local" 走 transport_pty；ensure_local_host 自动建 local 主机），**但 GUI 无任何创建入口**（仅 demo.ts 种子主机 id="local"） | §5 行定性改为「核心已有、GUI 新增入口」；R20（欢迎页/新标签菜单）排入此能力；demo 种子与真实入口对齐 |

## ⑤ 悬空问题列表（需 PM/Core 决定，不闭合不得签 G0 相关项）

| ID | 问题 | 证据 | 影响任务 |
|---|---|---|---|
| Q1 | **输出失步 resync 断链**：subscribe_output 的 Resync/Lagged 走 `window.emit("resync")`，前端无任何 listen；channel 内 resync 分支真实路径不可达。高频输出丢字节后 UI 无自动恢复 | main.rs:221-225 vs App.tsx:609,915,638,642,1436（listen 全集）、1063（死分支） | R11/C10；建议按现存 bug 记录并在 V2 修复中验证 |
| Q2 | `list_identities` 死命令：vault 能力在，UI 无消费 | main.rs:57, demo.ts:206 | R15/R27（凭据管理）：启用或删除 |
| Q3 | 凭据生命周期：create_identity 后取消主机表单，凭据已落库但无界面可见/删除/复用（仅审计可见 identity_create） | App.tsx:2669-2699 | §6.1 已给目标（设置→凭据+未绑定标记）；冻结单确认 V1 凭据列表管理范围 |
| Q4 | bench 与 TINYSSH_* 钩子去留（V2 是否保留 SPIKE-1 命令面）；SMOKE 脚本依赖旧 DOM 选择器 | E1/E2/E3/E4 | R04/R51（bench 是基线工具）、R45（清理清单） |
| Q5 | 审批前端风险分级（GAP-5）保留位置：前端 vs 核心/契约 | App.tsx:1627-1635 | R42/R03 |
| Q6 | 「手动控制」徽标态（无 Agent 时 owner=Agent 的显示文案）在 C2 Human 默认后语义失效 | App.tsx:1838-1843 | R24/R42 文案决议 |
| Q7 | 命令框移除后的 exec_human 去向：§5 已定「保留供协议/调试」，但 V2 需明确调试入口形态（隐藏快捷键？移除 UI 仅留 CLI/MCP？） | App.tsx:2189-2255 | R45 |
| Q8 | 连接中全局禁用（`disabled={connecting !== null}`）与 §6.2「一个主机连接中不能禁用其他主机」直接冲突——现状行为需在行为变更清单登记（V2 改造点，非悬空功能） | App.tsx:1745 | R19/R21 |

## 附：已批准的行为变更（§5/§6 已明确，R00 冻结单直接引用，不重复论证）

三栏→默认两区+按需面板；会话卡→顶部标签；命令框→移除（默认直接输入）；Human 默认控制（C2）；「断开」→统一「关闭会话」语义（成功移除标签）；连接/导入/设置→独立对话框；文件/转发→完整表单与队列；协作→按需入口+全局审批待办；传输→核心任务注册表（C5，替代 800ms 审计对账轮询）；导入→逐项诊断（C7）；偏好→`ui.v2.*`（C8，旧 ui.theme/ui.font_size 迁移映射）。

## 汇总口径

- 功能项：A14 + B23 + C10 + D8 = **55 项用户可见功能**（不含 E 类开发工具 5 项）。
- IPC：**39 命令 + 7 事件**（含 1 断链事件、1 死命令、3 bench 命令）。
- GAP **8**、STALE **2**、悬空问题 **8**（Q8 实为行为变更登记项）。
