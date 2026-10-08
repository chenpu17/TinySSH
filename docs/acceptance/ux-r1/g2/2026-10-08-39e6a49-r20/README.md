# UX-R1 G2 · R20 主机搜索/收藏/最近连接/标签/键盘焦点/欢迎页（commit 39e6a49 工作树，2026-10-08）

契约依据：docs/ux/ssh-client-ux-refactor.md R20 节 + A01/A02 验收项；数据面复用 R15 已签核的
C8（set_host_favorite / list_host_metadata / list_recent_hosts / upsert_host tags）。

## 变更面（ui/ 四文件，纯 FE）

- `ui/src/App.tsx`：hostMeta/recents/tagFilter 状态与 refreshLists 接线；toggleFavorite
  （乐观翻转 + 失败回读）；派生块（多字段搜索 name/address/username/tags 大小写不敏感
  includes、标签 chip 筛选交集、过滤后 localeCompare("zh") 稳定排序、收藏/其他主机分组
  ——无收藏回退「全部主机」单组）；主机卡 renderHostCard 收敛（tabIndex=0 + role=button +
  Enter/Space activate + aria-label、星标钮 aria-pressed + stopPropagation、标签徽章
  slice(0,2)+more、在线徽章/lastFailed/title 指纹提示等既有行为保留）；欢迎页「打开本地
  终端」钮 + .welcome-recents（sessions.length===0 且 recents>0 时渲染，上限 5，点击建连）；
  「无匹配主机」空态补直接添加入口；AddHostForm 标签输入（中英文逗号分隔、trim、去重）。
- `ui/src/icons.tsx`：IconStar。
- `ui/src/styles.css`：hb-tags/hb-tag、host-tags/host-tag(+more)、fav-btn(.on)、
  host-card:focus-visible、welcome-recents 四类——全部走既有 token（--accent/--border/--dim）。
- `ui/src/demo.ts`：tags 透传（新建/编辑/类型放宽），与真实 HostDraft 语义同构（trim/去空）。

## 契约取向（登记）

- 最近连接按 §259/§261 放欢迎页（避免每次连接使侧栏重排），非侧栏常驻。
- §263 双击连接语义未采纳：保持已验证的单击直连，键盘以 Enter 等价补齐。
- 标签以筛选 chip 呈现，非列表分组。
- light 主题验证经 `ui.theme` 旧键驱动；chrome blob 消费面归 R27（vis L2 登记）。

## 证据

### 1. demo 探针（真实 Chromium 127.0.0.1:5183）

`r20-demo-probe.js` → `demo-probe-result.txt`：26/26 PASS，零 JS 错误。覆盖：搜索三字段
（名称/地址/标签）、标签 chip 筛选与徽章、收藏切换+置顶分组、欢迎页本地终端钮+recents、
键盘 Tab 可达+focus-visible 外圈+Enter 建连（A02）、20 主机负载（26 卡渲染、过滤
33ms<50ms 门、长中文名/IPv6 不破版）、recents 契约（排除 local、≤5）、零 JS 错误。
实现 fork 与主线各独立复跑一轮均 26/26。

### 2. 类型检查

npx tsc --noEmit → 0 错误（fork 与主线各跑一轮）。

### 3. 视觉独立复验 vis-r20（`vis/` 目录归档）

裁定**视觉可签**（15/15 PASS，无阻断项）：
- 功能断言 15 项：星标在位/on 态类/分组标题/样式同源、chip 排序与 on 态 token 逐值
  （--accent/--accent-soft 实算 rgb 对账）、点击过滤生效、徽章 slice(0,2)+more、
  focus-visible 规则在案、light 主题真实生效（bodyBg/accent 翻转/星标填色跟随）、
  W1024/W960 主机栏 224px 无溢出、零 console 错误。
- 零回归面：git worktree @39e6a49 基线 + 双 vite 实例（5183 新端 vs 5184 基线）同操作
  截图，title/statusbar 双态逐像素 0 差；tabbar/center 微小差异经同端连拍自差对照甄别为
  xterm 光标闪烁相位/次像素 AA 瞬态（噪声底以内，非回归）——方法学与数据归档
  `vis/region-diff.txt`。
- vis 登记（非阻断）：L1 跨端逐像素 diff 应先测同端噪声底再判 violation（方法学）；L2
  light 主题经旧键、chrome blob 归 R27。

## 原生冒烟裁定

不另适用：本任务全部为 FE 内部渲染面（主机栏/欢迎页/表单），demo 探针（真实 Chromium）
+ vis-r20（双端逐像素）已覆盖；唯一 demo 不可达面 .welcome-recents（demo 死会话标签永驻
致 sessions.length===0 不可达，r14 双端语义既定）——原生侧本轮未覆盖（**登记**：
r24a 冒烟未驱动该面，承诺落空即行更正；该断言归 R23 前置清单，随下一次原生冒烟补齐）。

## 审核登记

rev-r20 独立对抗审核（真实 Chromium 活体实证）：**1 高 1 中 6 低，处置后可签**。

- **H1 键盘冒泡劫持（实证）**：host-card 外层 onKeyDown 对冒泡 Enter/Space 一律
  preventDefault+activate()——聚焦星标/编辑/删除钮按键被吞掉默认激活且误触连接
  （rev 实证：星标 Enter 收藏不翻转 + 新建会话；鼠标对照正常）。A02 核心缺陷。
  **修**：处理器首行 `if (e.target !== e.currentTarget) return;` + 探针 D4-D6
  （星标 Enter 翻转收藏不建会话不开门 / 编辑钮 Enter 开表单不建会话——修复前路径零覆盖）。
- **M1 幽灵标签死态**：tagFilter 指向的标签经编辑/删除在全部主机上消失后 chip 不再渲染、
  筛选仍生效 → 列表恒空且无清除入口。**修**：派生块重排，`activeTag`（失效自动 null）
  统一消费；探针 D7 判别性用例（chip 激活→编辑清空标签→列表自动恢复 27 卡，
  旧代码该处恒空必 FAIL）。
- **L1** 渲染期原地 `.sort()` state 数组——修（`[...].sort()` 拷贝后排序）。
- **L2/L5 顺带修**（同类一行可见毛刺，超出 rev 建议最小面已声明）：空「其他主机」节头
  条件渲染；welcome-recents 行全失效不渲染空标题块。
- **L3 登记**（乐观收藏与 3s 轮询回闪竞态，毫秒窗）；**L4 登记**（role=button 嵌交互
  后代 ARIA 反模式，H1 修复后可接受）；**L6 登记**（§261 契约明文形状）。

处置复跑：tsc 0 错误；demo 探针 **31/31 PASS**（原 26 + rev 处置增补 5：D4/D5/D6/D7a/D7，
结果归档 demo-probe-result.txt）。vis 不复跑：五处修改均不在正常路径渲染面（事件守卫/
坏死态/空态毛刺），正常态像素与 vis-r20 已签基线一致。

**终裁：可签（rev-r20 复核二轮）。** 处置经 rev-r20 独立复证（自有探针 :5199 非作者
脚本）：星标钮 Enter 翻转收藏且不建会话（修复前同法基线=不翻转+误建会话 2→3）、
编辑钮 Enter 开表单、卡片本体 Enter 主路径未误伤、幽灵标签清空后 5 卡全恢复无死态；
作者 31/31 与 rev 独立结果互证，tsc rev 复跑 0 错误。L3/L4/L6 登记不阻断。
