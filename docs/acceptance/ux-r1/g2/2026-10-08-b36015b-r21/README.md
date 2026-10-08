# UX-R1 G2 · R21 连接表单与认证（commit b36015b 工作树，2026-10-08）

契约依据：docs/ux/ssh-client-ux-refactor.md §238/§265/§267/§268/§269/§280/§6.3/§304/§306。
C1 事件消费面（attempt 原位替换标签/取消竞态/后台完成焦点深化）归 R23，本轮不主张。

## 变更面（ui/ 五文件 + src-tauri 命令桥；crates/ 零改动）

- **§280 并发连接解禁**：`connectingIds: Set<string>` 逐主机连接态（原全局单值禁用
  所有主机连接钮）——createSession finally 精确移除本主机；连接钮只禁本主机、卡片
  activate/cursor 只挡本主机；一主机建连（含门挂起）期间其他主机连接钮可用。
- **§6.3 后台完成不抢焦点（focus generation）**：focusGenRef 代际——浮层 union
  （search/settings/addhost/import/tools/tabsMenu/rightPanel/confirm）的**打开沿**推进
  （关闭沿不推进：用户刚回当前会话属已知意图，此后完成的连接仍不得抢当前会话焦点）+
  window blur 推进；TOFU/2FA 门**不**入列（属连接自身流程，置位会误伤前台「信任后落
  终端」）。createSession/reconnectSession 快照点击时 gen0；完成时 gen 未变且窗口前台
  → attach+focus（原路径）；否则只 toast「已连接 X——点击标签进入」，不切视图不抢焦。
- **凭据基础管理（§238/§267）**：设置弹窗新增「凭据库」section——list_identities
  列表（label/kind 中文/指纹）、「使用中/未绑定」徽章（referencedIdentityIds 由
  Host.identity_id 派生的 UI 对账面，核心删除侧引用检查兜底）、删除走 confirm 弹窗
  → delete_identity（新增 tauri 命令包装核心既有 trait 方法，WireError 映射）→
  IdentityInUse 人话列占用主机名（parseWireError detail.host_names）；空态文案。
- **§265 已有密钥绑定**：表单 key 模式新增「已有密钥（凭据库）」选择器
  （knownIdentities=mount 时 list_identities 过滤密码凭据；submit 分支 picked 优先；
  genKey/importPem 成功清 picked=新生成接管表单）——取消表单后的未绑定凭据可在此
  回收绑定，不再只能重建。名称自地址生成（onBlur 地址非空且名称空时预填，可编辑）。
- demo mock：identities 内存域 + ident_id 绑定 + list_hosts 暴露 identity_id +
  delete_identity 同语义（IdentityInUse host_names 载荷）+ otp2.demo echo=false
  演示主机（§306 输入遮蔽面）；errors.ts apiError 增可选 detail（向后兼容）。

## 契约取向（登记）

1. **门卡不入焦点代际，但完成检查含他主机门**：hk/ap 模态属连接自身流程不推进代际
   （否则误伤前台「信任后落终端」）；他主机门挂起时本连接完成转后台 toast
   （rev-r21 M2，防验证码 keystroke 误落）。深化的 attempt 级 current-selection
   判定仍归 R23 C1 消费。
2. **§268 已保存连接失败**：既有路径已满足（conn-error 横幅 + 主机卡 lastFailed
   保留 + 重试复用既有主机行不重建），本轮未改。
3. **§305 算法展示**：PendingHostKey 无算法字段（仅 SHA256 指纹），展示面缺「算法」
   项——契约勘误候选，登记（核心改动归后续）。
4. **§280 标签原位替换**：v1 create_session 无 attempt 标签承载，归 R23 C1 消费。
5. **§306 attempt 绑定**：应答按 prompt id 路由（与主机卡无交叉），多轮经订阅排队能力
   既有；demo/原生按主机名驱动验证。

## 证据

### 1. 测试

`cargo test --workspace` → 128 passed / 0 failed（crates/ 零改动回归层）；
`cargo check -p tinyssh-app` 零新增警告（6 条既有均在他 crate）。

### 2. demo 探针（真实 Chromium 127.0.0.1:5183）

`r21-demo-probe.js` → `demo-probe-result.txt`：**18/18 PASS，零 JS 错误**。
F1 名称自地址生成；A1-A3 §280（otp-1 TOFU/2FA 门挂起期间 prod-1 连接钮 disabled=false
——旧全局禁用代码下 A2 必红）；B1-B2 前台完成 attach+终端持焦；C1-C3 后台完成不切
视图（合成 window blur 推进代际）+ 可寻 toast + 点击标签进入（旧无条件 attach 下 C1
必红）；D1 echo=false 输入 type=password 不回显（§306）；E1-E7 凭据全链（生成指纹
确认→取消未绑定不默默删除→已有密钥选择器绑定→使用中→引用检查拒删列出主机名
（无检查时必红）→删主机解绑→删除成功）；Z1 零 JS 错误。

### 3. 原生冒烟（release 终版二进制 + 隔离 DB + 共享 docker sshd）

- `beacon-r21a.txt`（处置前轮，RUN_ID=r21a）：全链 11 打点 DONE——真实 vault 凭据链
  （gen→unbound→bound→inuse→reject→deleted）+ §280 并发解禁 + 真建连 + §6.3 后台
  noattach/点标签进入；零 JS 错误零残留。
- `beacon-r21b.txt`（rev 处置 M1/M2/L1 后代码 + 重建 dist，RUN_ID=r21b）：
  同链路复跑全绿 11 打点 DONE；零 JS-ERROR/JS-REJECT；退出 pgrep 零残留。
- `beacon-r21c.txt`（**终签轮**，vis 凭据行两行布局修复并入后重建，RUN_ID=r21c）：
  同链路复跑全绿 11 打点 DONE；零 JS-ERROR/JS-REJECT；退出 pgrep 零残留。

**不主张**：真实键盘交互认证（2FA 原生面核心测试覆盖）；echo 遮蔽原生（demo D1 承担）；
WKWebView 真实 blur 投递（两轮均合成事件驱动——rev L3 登记归 R23 实证）。

### 4. 视觉独立复验 vis-r21（`vis/` 目录归档）

初判**不可签**（1 项新面缺陷）：280px 设置面板内 .cred-row 单行布局将 .cred-label
压至零宽、.cred-kind 与指纹叠印 37.7px（DOM 盒测量实证，暗/亮 × 未绑定/使用中四态
复现）；通过面 31/31 结构探针 + 零回归全绿（settings 原区逐位 bytes_diff=0、表单
0/79074、欢迎页 MAIN 0/843200、主机栏差异全归因 otp-2 插卡位移、终端 3px AA 噪声）。

**修**：凭据行改两行布局（首行 label 弹性+徽章+删除钮，次行 kind+指纹弹性截断，
.cred-main 删除）。**终裁：视觉可签**——缺陷面四态复测 21/21（label 渲染宽
0→159.6px 可见、kind 与指纹盒不相交 6px gap）、结构探针 31/31、零回归数字与修复前
一致；修复前证据 prefix-* 保全、region-diff.txt 第五/六节在案。签前轮 r21c 以终代码
复跑全绿（见上）。

## 执行插曲（入档）

r21a 三轮迭代：①已有密钥选择器查找误命中认证方式 select（以「存在非空值选项」判定
失当）——改按「选项值非枚举」判定；②删主机确认框关闭晚于脚本点 .hb-settings（invoke+
refreshLists 后才 setConfirm(null)），点击被遮罩吞——openSettings 增遮罩等待+点击重试；
③upsert 后 400ms 固定等待未敌 3s 轮询——改 waitFor 卡片出现。三轮均脚本侧修复，
产品代码零改动。另：beacon 服务以启动参数固定日志路径，r21a/r21b 两轮共用一文件、
各以 RUN_ID 前缀区分；归档时 r21b 段抽取为 beacon-r21b.txt（r21a 段在处置前已先行
归档为 beacon-r21a.txt）。

## 审核登记

rev-r21 独立对抗审核：**处置后可签（0 高 2 中 5 低）**。

- **M1 应用内导航不推进焦点代际（必改，已修）**：慢建连期间点标签/pane/⌘N 切到
  他会话，完成时 gen 未变 → attach 抢回视图，违 §6.3「期间没有转移到其他输入目标」。
  **修**：focusSession 与 attachSession 入口推进 gen（完成检查先于 attach 调用，
  前台路径不受扰；并发双完成第二个自动转后台 toast）。
- **M2 完成检查不含门开状态（必改，已修）**：主机 A 的 2FA 门挂起中（输入框
  autoFocus、遮罩不持 DOM 焦）他主机完成 → term.focus() 抢走门输入焦点，后续验证码
  keystroke 误落他主机远端 shell——原登记#1「遮罩持焦输入无害」与事实不符。
  **修**：完成检查增 `hostKeyQueue/authPromptQueue 无他主机门`（队列 ref 实时镜像；
  本主机门在 create_session resolve 前必已闭——应答先同步 splice 队列再 invoke，
  实证不伤 B/C 探针路径）；README 危害描述随修更正。
- **L1 credErr 开沿清理（已修）**；**L2 真实 vault 密码主机的 Password identity 行
  渲染未覆盖（登记，下轮原生补看）**；**L3 WKWebView 真实 blur 投递未证（登记，
  R23 原生 Cmd-Tab 实证或 visibilitychange 兜底）**；**L4 冒烟 credBadge 首行断言
  脆（dev 脚本面，登记）**；**L5 并发 createSession 互清 connError（卡片 lastFailed
  兜底，登记）**。

处置复跑：tsc 0 错误；demo 探针 **18/18**（B/C 路径在 M1/M2 后仍绿——应答先 splice
语义实证）；原生 **r21b 终签轮**（处置后代码 + 重建 dist）全链 11 打点 DONE、零 JS
错误、零残留。核对无误项：§280 逐主机隔离（A1-A3 旧码必红）、凭据删除分层（UI 仅
标记/核心 identity 引用兜底/口径同源 identity_id）、§265-269 无回归、demo mock 同构、
探针判别力、crates/ 零 diff、范围干净。

**终裁：可签（rev-r21 复核二轮，独立复跑处置后代码：探针 18/18 + beacon-r21b + tsc
逐项核实 M1/M2/L1 修法与登记改写）。** 复核新登记 **L6**：gatesBusy 按 host_name
匹配（PendingAuthPrompt wire 无 host_id 不能自造；PendingHostKey 有 host_id 可半侧
精确化）——同名双主机时他机门被误判为自有门，归 R23/契约勘误一并。签发附条件
vis-r21 视觉裁定已落地：**视觉可签**（凭据行两行布局修复复测通过，见视觉节），
终签轮 r21c 全绿。**R21 审核闭环。**
