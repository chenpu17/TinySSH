# R45 原生 GUI 冒烟补跑（R43 / R44 原生面）

- **缘起**：R45 主体（浏览器 demo 域）见上级目录 `README.md`。该轮**未跑**原生冒烟——
  锁屏时 WKWebView 冻结不可见窗口的页面 JS，注入驱动不执行。解锁后于 **2026-10-10 08:0x–08:2x**
  补跑，本目录为原始证据。
- **同时兑现 R45 的原生面义务**（交付文档 §6.1）：原生方式参照 `scripts/native-smoke/README`，
  **更新后不得依赖旧布局坐标**（§六 给出可复核的检索结论）。

## 〇、二进制判别：本次冒烟加载的是哪套前端

同一份 Rust 源码、同一个二进制路径，**是否内嵌前端由 cargo feature 决定**：

| 构建方式 | `custom-protocol` | 窗口加载 | 本次用途 |
|---|---|---|---|
| `cargo build --release` | 无（`src-tauri/Cargo.toml` 未声明该 feature） | **devUrl `http://localhost:5183/`** | R43 r43a/r43b |
| `scripts/ui-switch.sh build --no-bundle`（内部 `cargo tauri build --config …`；脚本第 75 行**未**显式传 feature，`custom-protocol` 来自 tauri CLI 的 build 默认行为） | 有 | **内嵌资源 `tauri://localhost`** | R44 旧 UI |

这不是推测，是两份启动日志里的原样字段：

- `app-r43a.log` / `app-r43b.log`：`window url: … { scheme: "http", … port: Some(5183), path: "/" … }`
- `app-autoconnect.log` / `app-live.log`：`window url: … { scheme: "tauri", … host: Some(Domain("localhost")) … }`

因此：**R43 冒烟必须有 vite dev server 在 5183 上**（否则白屏、驱动拿不到 DOM）；R44 旧 UI
冒烟**不能有** dev server 参与（否则加载的是 devUrl 上的新 UI）。这一点此前是「为什么原生
冒烟要 dev server」的困惑来源，此处登记为可复核事实。

## 一、R43 原生冒烟（协作启停 C9）

驱动：`src-tauri/src/main.rs` 的 `r43_smoke_script`，经
`TINYSSH_SMOKE=1 TINYSSH_SMOKE_MODE=r43a|r43b TINYSSH_RUN_ID=<id>` 注入。
驱动为**纯 webview 内 DOM + `__TAURI_INTERNALS__.invoke`**，无 CGEvent / System Events 击键；
睡眠原语是 `fetch('http://127.0.0.1:15199/w/<ms>')`（beacon 服务端睡眠——WKWebView 会节流
`setTimeout`）。

环境：`TINYSSH_DB=/tmp/smoke-r43/tinyssh.db`、`TINYSSH_MASTER_PASSPHRASE=…`（口令 env 路径，
**不碰 OS 钥匙串**）、真容器 `ssh://127.0.0.1:2222`（`ssh -p 2222`，banner `SSH-2.0-OpenSSH_9.7`）。

### r43a：新装停用 → 显式启用 → 签发 → 委托 → 停用 → 重启用（12 标记全过）

原文见 `beacon-r43a.txt`（`/t/r43a-r1|<标记>` 行，末尾 `/t/r43a-DONE`）：

| # | 标记 | 断言要点 |
|---|---|---|
| 1 | `r43a-fresh-ok` | 新装停用协作，无自动 MCP 端点 |
| 2 | `r43a-disabled-guidance-ok` | 停用态协作面板=一次性指引，无空审批区 |
| 3 | `r43a-settings-disabled-ok` | 停用态设置无 MCP 配置/端点，仅「启用」钮 |
| 4 | `r43a-enable-ok` | 显式启用后端点运行 `http://127.0.0.1:8722/mcp` |
| 5 | `r43a-issue-ok` | 真命令签发 Agent 并落库 |
| 6 | `r43a-panel-close-ok` | 关协作面板不改变控制权（D08） |
| 7 | `r43a-delegate-ok` | 真核心委托，`owner=Agent` |
| 8 | `r43a-indicators-ok` | 「已配置」与「有活动请求」分别显示 |
| 9 | `r43a-preview-ok` | 停用预览：受影响会话/待审批/已配置齐备 |
| 10 | `r43a-cancel-ok` | 取消停用不改状态 |
| 11 | `r43a-disable-ok` | 原子封 admission + 会话转 Human + 端点停止；**Token 保留** |
| 12 | `r43a-reenable-ok` | 重新启用端点回来，**旧会话不复活** |

落库对账（`sqlite3 /tmp/smoke-r43/tinyssh.db`）：

- `user_version = 7`
- `settings.collab.enabled = 1`（r43a 收尾在「重启用」态）
- `agents` 行：`id=r43-agent`、`label=R43 冒烟 Agent`、`approval_mode=per_command`、`revoked_at` 空
- 审计尾：`… collab_enabled(8) → handback(9) → session_delegated(10) → collab_disabled(11) → collab_enabled(12) → session_closed(13) → session_created(14) → session_closed(15)`

启动日志原样对照（C9 的两侧）：

```
app-r43a.log: [app] collab disabled (fresh install or user-disabled) —— MCP endpoint not started
app-r43b.log: [app] MCP endpoint in-process: http://127.0.0.1:8722/mcp
```

### r43b：V6 旧库升级 → 保留「MCP 默认开启」（4 标记全过）

`r43-driver.sh` 先把库降到 V6，再以 r43b 模式启动，验证升级路径不把用户原有的
「协作开启」意图丢掉。原文见 `beacon-r43b.txt`：

| # | 标记 | 断言要点 |
|---|---|---|
| 1 | `r43b-upgrade-enabled-ok` | 旧版库升级保留「MCP 默认开启」，端点自启 `http://127.0.0.1:8722/mcp` |
| 2 | `r43b-agent-preserved-ok` | 已配置 Agent / Token 跨升级保留 |
| 3 | `r43b-badge-ok` | 升级后已配置 → 协作徽标出现 |
| 4 | `r43b-delegate-entry-ok` | 升级后协作可用，委托入口出现 |

### 首跑发现的两处驱动缺陷（补档 = 首次真跑，脚本断言与后续契约漂移）

两处均为**驱动脚本**的错，非产品缺陷；修法是把驱动对齐到 demo 探针
（`2026-10-09-r43/r43-demo-probe.js`）已验证的顺序/双路。改动在
`src-tauri/src/main.rs`（`r43_smoke_script`）：

**缺陷 1 — 无会话时开协作面板必失败。** 协作是**会话工作区**下的同级入口：面板入口
`tools-collab` 渲染在会话工具栏里，而该工具栏整体包在 `{sid && …}` 中——没有会话时钮不在 DOM。
原脚本先 `openCollab()` 后 `connect()`，必得 `FAIL-open-collab`。修：把连接块前移到首次
开面板之前（与 demo 探针「先 `connectHost` 再 `openCollab`」一致），连接后再补验
「仍无徽标 / 无委托入口」：

```js
await markSync('r43a-fresh-ok（新装停用协作，无自动 MCP 端点）');
if (cnt('[data-testid="collab-entry"]') !== 0) return title('FAIL-badge-shown');
if (cnt('[data-testid="delegate-open"]') !== 0) return title('FAIL-delegate-shown');
// §3.2：协作是**会话工作区**下的同级入口——面板入口（tools-collab）在会话工具栏里，
// 没有会话时该钮不在 DOM。故必须先连真容器取得会话，面板才可达。
// （补档首次实跑发现：原顺序在无会话时开面板，必得 FAIL-open-collab；与 demo 探针
//  「先 connectHost 再 openCollab」一致，已更正。）
if (!connect('r43-a')) return title('FAIL-connect-a');
await trust();
if (!await waitFor(async () => (await activeSess('r43-a'))?.state === 'Connected' ? true : null, 150)) return title('FAIL-conn-a');
const sess = await activeSess('r43-a');
await sleep(400);
// 连接后仍无徽标/委托入口（未配置 Agent 且无 Agent 活动）
if (cnt('[data-testid="collab-entry"]') !== 0) return title('FAIL-badge-shown2');
if (cnt('[data-testid="delegate-open"]') !== 0) return title('FAIL-delegate-shown2');
```

**缺陷 2 — `openAgentSettings` 缺兜底路径。** 原实现只点 `collab-open-settings`，而该入口只
存在于**停用/未配置态**的协作面板内；签发 Agent 后重开设置时它不在，必得
`FAIL-open-settings2`。修：加 `.hb-settings` 主机栏设置钮 + 切 Agent 分类的兜底（同 demo 探针双路）：

```js
const openAgentSettings = async () => {
  if (document.querySelector('[data-testid="settings-cat-agent"]')) return true;
  // 停用/未配置态：协作面板内有「打开设置 → Agent 接入」入口
  await openCollab();
  click('[data-testid="collab-open-settings"]');
  if (!await waitFor(() => (document.querySelector('[data-testid="settings-cat-agent"]') ? true : null), 40)) {
    // 完整面板态（已签发 Agent 后）没有「打开设置」入口 → 走主机栏设置钮 + 切 Agent 分类
    click('.hb-settings');
    await waitFor(() => (document.querySelector('[data-testid="settings-close"]') ? true : null), 40);
    click('[data-testid="settings-cat-agent"]');
  }
  return !!(await waitFor(() => (document.querySelector('[data-testid="settings-cat-agent"]') ? true : null), 40));
};
```

两处修好后 r43a/r43b 一次跑绿，**无重试、无跳过标记**。

## 二、R44 原生冒烟：旧 UI 内嵌在**新核心**上

R44 的主张是「`TINYSSH_UI_V2` 只切前端，核心不变」。内嵌资源键判别见上级
`2026-10-10-r44/ui-switch-embed.txt`（同一 target 两次构建，旧/新资源键互斥命中）。本节补的是
**运行时**半边：把 `TINYSSH_UI_V2=0` 构建的旧 UI 二进制跑起来，看它读的是不是新核心的真数据。

### 证据

| 文件 | 内容（2026-10-10 经 vis-r45-native 复验后更正） |
|---|---|
| `old-ui-on-newcore.png` | 旧三栏 UI 空态首屏（左 主机/会话/Agent 接入 · 中 终端空态 hero · 右 审批/远程文件/传输/端口转发/任务目标/现场简报/操作记录） |
| `old-ui-hosts.png` | 旧 UI 读到**新核心**的真主机行（`demo-a` / `本机` / `demo-b`），**并渲染新核心的 TOFU 指纹门**（「首次连接确认 demo-b（127.0.0.1:2222）」+ 指纹 `SHA256:CY+Y9tof0…`） |
| `old-ui-session.png` | 旧 UI 在**信任已发生、建会话尚未发生**时刻的状态（操作记录顶两条 = `08:14:49 信任主机指纹 demo-b` / `指纹确认决定 demo-b`；**无对话框、无指纹**） |
| `old-ui-live.png` | 旧 UI 上的**真实 SSH 会话**：终端标签 `● demo-b`、左栏会话卡 `demo-b · 已连接  s-c63bfea4-6  [断开]`、主机行绿色「1」徽标、操作记录 `08:15:29 · demo-b 我 连接主机` |
| `app-autoconnect.log` | 旧 UI 进程启动日志（`tauri://localhost`，autoconnect） |
| `app-live.log` | 旧 UI 上真实会话建立后的日志 |

**「这是旧 UI」的判据**（vis-r45-native 更正了本节初稿的错误判据）：初稿称「旧 UI 窗口标题含
『工作台』后缀、新 UI 无」——**不成立**，四点反证：① 截图里**根本没有窗口标题**
（`src-tauri/tauri.conf.json:20` `titleBarStyle: "Overlay"`）；② `tauri.conf.json:15` 的窗口标题
在 HEAD 与 tag 完全相同，都是 `TinySSH — 人机协同 SSH`（**两处都没有「工作台」**）；
③ 无会话时新旧 UI 都把 `document.title` 设为同一字符串（HEAD `ui/src/App.tsx:2197` ≡
tag `App.tsx:1308`）；④ 中栏 hero 的「人机协同 SSH 工作台」文案在新旧 UI 里**逐字相同**
（HEAD `App.tsx:3993` ≡ tag `App.tsx:2064`）。

**真正可用的判据**（本目录采用）：
- 结构：左栏有 `主机 / 会话` 面包屑（新 UI 无此串）、右栏是**常驻**的
  审批/远程文件/传输/端口转发/任务目标/现场简报/操作记录。**「常驻 vs 按需」已核**：新 UI 有
  `rightPanel` 状态且可回到 `null`（`ui/src/App.tsx:1692` `if (rightPanel === null) { … }`），
  各入口以 `setRightPanel(rightPanel === "x" ? null : "x")` 开关（`:3310/:3897/:3903`）；
  旧 UI 的 `ui/src/App.tsx` 里 **`rightPanel` 零命中**，其右栏是静态渲染（截图上七个分区同时可见）；
- 几何：像素实测左栏 **220** / 右栏 **280** 逻辑 px，与 tag `ui/src/styles.css:164` 的
  `grid-template-columns: 220px minmax(0,1fr) 280px` 精确吻合（新 UI 主机栏默认 **224px**）；
- 文案：`暂无会话。点主机右侧的「连接」建立会话。`、底栏 `先在左侧连接一台主机，这里才能执行命令`
  在**新 UI 的 `ui/src/` 里 0 命中**。

### 会话与审计（`sqlite3 /tmp/smoke-r44/tinyssh.db`）

- `user_version = 7`
- 真实会话：`s-c63bfea4-6dc4-4f40-97de-907160c5c69a`，主机 `h-c6a54842-2894-472e-9cbd-b91cdcd3bcfd`（`demo-b`），
  `session_created` payload `{"host":"h-c6a54842-…","kind":"ssh","owner":"Human"}`
- 审计链（时间本地时区）：

| seq | 时刻 | 主体 | 动作 | 载荷要点 |
|---|---|---|---|---|
| 1 | 08:10:59 | human | `host_upsert` | `demo-a` |
| 2 | 08:12:09 | human | `host_key_confirm_requested` | `demo-a`，`issue=FirstSeen` |
| 3 | 08:12:51 | human | `host_upsert` | `demo-b` |
| 4 | 08:12:59 | human | `host_key_confirm_requested` | `demo-b`，指纹 `SHA256:CY+Y9tof0nknE4b6tUAujb6udp35ePMysakEtSLWlRw` |
| 5 | 08:14:49 | human | `host_key_decision` | `accept=true`，同指纹 |
| 6 | 08:14:49 | human | `host_key_trusted` | 同指纹 |
| 7 | 08:15:29 | human | `session_created` | `s-c63bfea4-…`，`kind=ssh`，`owner=Human` |

`app-live.log` 原样：`[app] autoconnect h-c6a54842-2894-472e-9cbd-b91cdcd3bcfd -> s-c63bfea4-6dc4-4f40-97de-907160c5c69a`

**结论**：旧 UI 前端（tag `old-ui-baseline-g0` 的产物）在**新核心**上完成了「列主机 → 首次
连接指纹门 → 信任 → 真实 SSH 会话」全链路，且审计落库为新核心的 hash 链格式。这是 R44
「核心不变、只换前端」主张的运行时佐证。

**口径限定（vis-r45-native 低 C）**：`old-ui-live.png` 的**像素**只证到「会话已建立且状态为
已连接」——图中**终端窗格并未接入**（中栏仍是 hero 空态，文案「已有 1 个会话未接入终端」），
像素上没有任何 SSH 交互输出。「会话是**真实**的（真容器 `127.0.0.1:2222`）」由库里的
`sessions` 行（`state=connected`、host=demo-b）+ `app-live.log` 的 autoconnect 行支撑，
**不是由像素支撑**。两者合起来才是本节的主张。

### 一次失败留证（如实）

`app-autoconnect.log` 里 autoconnect **失败过一次**：

```
[app] autoconnect h-c6a54842-… failed: 连接失败: connect timeout（10s 内未完成 TCP/banner 交换）
```

查明：**不是网络问题**——同刻 `nc -z 127.0.0.1 2222` 通、banner 0.01s 返回。真因是
`create_session` 停在**未被回答的 TOFU 提示**上（旧 UI 那次没点「信任」，10s 超时）。
用一次合成点击把 TOFU 信任掉之后，同一命令即成功（`app-live.log` 的 `-> s-c63bfea4-…`）。
登记为**驱动侧操作顺序**问题，非产品缺陷。

## 三、写锁复验（含一次**陈旧二进制**导致的自相矛盾，已查明）

R44 主张「写锁保证同一 vault 只有一个实例」（`ui-switch-embed.txt` 引作新旧 UI 不会各起一套
端点的依据）。本节独立复验，并更正本轮一次**错误读数**。

**更正过程（如实记录）**：复验初期我用 `./target/release/tinyssh host list` 在 GUI 持锁时
**成功**，据此一度以为「CLI 不取写锁」。核对二进制 mtime 才发现
`target/release/tinyssh` 是 **2026-10-09 13:24** 的产物，而 `VaultLock` 由 R44 提交
（`git log -S VaultLock -- crates/vault/src/lib.rs` 唯一命中 `28fe843`，2026-10-10）才引入——
**该 CLI 二进制根本没有写锁代码**。`cargo build --release` 重编后复验，结论与最初观察一致：

```
# 实例 A（GUI）持有写锁时
$ tinyssh host list      → exit 1  Error: 存储错误: 另一个 TinySSH 实例正在使用该库（写锁 … 被占用）
$ tinyssh host add …     → exit 1  同上
$ tinyssh vault version  → exit 0  库 …：schema 版本 7（本程序支持 7）
# A 退出后
$ tinyssh host add …     → exit 0  host h-ec0a7669-d430-40d0-a83f-b78de2b69ef6 added
```

以上四行的**命令与 UUID** 取自归档件 `write-lock-reverify.txt`（该次运行的库在
`/tmp/r45-lock5/`）；**错误串与库路径按 `…` 省略**，`→ exit 1/0` 的退出码标注为**本文所加**
（归档件把退出码放在单独一行括注里）。rev-r45-native 指出本文初稿此处误引了**另一次运行**
（`/tmp/r45-lock4/`）的 host UUID `h-f804a6e3-…`，属「两次运行的拼接被当作原文」——已改正。

同时确认**第二个 GUI 实例被拒**（`src-tauri/src/main.rs:1021` panic，同一条写锁消息），
而**同机 flock 跨进程确实互斥**（`fcntl.flock` 对照实验：子进程 `Errno 35`）。

**观察（非缺陷，登记待议）**：CLI 对**纯只读**的 `host list` 也走 `Vault::open` 取排他写锁，
因而在 GUI 运行时被一并拒掉；只有 `vault version` 走 `read_schema_version` 不取锁。这与
§10.2「灰度期同一 vault 只允许一个实例持有写锁」**取向一致**，但「只读查询也需先关 GUI」
是否合意，留给后续裁定。`Vault::open_shared`（不取锁）目前仅被 vault 测试使用。

**工艺教训**：以 CLI 行为为证据前，先核对二进制 mtime / 重编——否则测的是上一轮的代码。

## 四、R45 §6.1 原生工具检查：不依赖旧布局坐标

检索范围：`scripts/native-smoke/**` 与注入的冒烟脚本（`src-tauri/src/main.rs` 的
`r4*_smoke_script`；按函数跨度计〔自签名行至其闭合 `}`，4 个函数〕共 **905 行**）。
检索旧布局特征：`.layout`、`220`、`280`、`780`、`三栏`。

结论：`.layout` **0**、`三栏` **0**；三个数字按**独立 token**（词边界）检索 **0 命中**。
唯一一处**朴素子串**命中是 `port: 2200`（`r41` 冒烟夹具里的 SSH 端口号，`220` 只是它的前缀），
**不是布局坐标**——此处如实标出，以免「零命中」被读成检索口径被偷偷放宽。

`scripts/native-smoke/` 只有 `beacon.py`（beacon 服务端）、`ev.py`（通用 CGEvent 原语，
`click(x, y)` / `move(x, y)` 的坐标**由调用方给**，文件内不内置任何布局常量）、`t44_agent.py`、
`README.md`（T40 配方 + 5 条坑）与 `__pycache__/`（Python 字节码缓存，非源码）。
本轮 r43a/r43b 的驱动是纯 DOM 选择器 + `invoke`，
`r4*_smoke_script` 段内**无一处屏幕绝对坐标**（`CGEvent` / `osascript` / `System Events` /
`screenX|Y` / `clientX` / `elementFromPoint` / `getBoundingClientRect` 在 r43 驱动中**全 0**）。

`beacon.py` 本轮被真实使用（r43a/r43b 的 `fetch` 睡眠原语都打到它）。

## 五、独立复核（作者自查不算数）

| 审核者 | 范围 | 结论 |
|---|---|---|
| **vis-r45-native**（视觉复验） | 四张截图 ↔ 本文主张是否相符；未重跑冒烟 | **图能支撑核心主张**，但本文初稿**两处文字有误**，已更正 |
| **rev-r45-native**（代码/证据审核） | `src-tauri/src/main.rs` 两处改动是否「对齐契约」而非放水；beacon/DB/日志/写锁/工具检查逐条复现 | **可签**（0 高 / 0 中 / 7 低），见下 |

### vis-r45-native 的发现与处置

| 级别 | 发现 | 处置 |
|---|---|---|
| **中 A** | 本文初稿的「这是旧 UI」判据——「窗口标题含『工作台』后缀、新 UI 无」——**不成立**（四点反证见 §二「判据」段）。若真发生新旧 UI 混淆，该检查抓不住 | **采纳并换判据**：改用「`主机 / 会话` 面包屑 + 旧 UI 专属文案在新 UI `ui/src/` 零命中（作者已复验：三条串各 0 命中 / tag 各 1 命中）+ 像素几何 220/280 对 tag `styles.css:164`」 |
| **中 B** | `old-ui-hosts.png` 与 `old-ui-session.png` 的**描述互换**：实际 hosts 图含 TOFU 指纹门，session 图是「信任已发生、建会话未发生」且无对话框无指纹 | **采纳**：作者重读两图确认后按实际内容更正 |
| 低 C | `old-ui-live.png` 的「真实 SSH 会话」在像素上无终端输出（终端窗格未接入） | **采纳**：§二结论处加口径限定，区分「像素证到的」与「库/日志证到的」 |
| 低 D | 首屏图只含 demo-a，未说明与 demo-b 于 08:12:51 才新增的时间关系 | 已在审计表（seq3）体现，首屏行不再列主机名 |
| 低 E | 括注「新 UI 改为按需展开的任务面板」审核者未核 | **作者自行核验成立**（新 UI `rightPanel` 可回 `null`：`App.tsx:1692` / `:3310` / `:3897` / `:3903`；旧 UI `rightPanel` 零命中），已补证据。**限定**：这三条行号是**作者自核**，vis-r45-native 声明未独立复读该证据——按「作者自查不算数」的口径，此处如实标为**未经独立复核**，如需可另立一项 |

vis 另确认：四图**互相自洽、同一轮运行**（几何一致、内容按时间单调演进、操作记录与 audit seq1–7 逐条对齐、归档 PNG 与 `/tmp/smoke-r44/` 原始件 md5 byte-identical），且**无空壳/白屏/假数据**。

### rev-r45-native 的核验（7 条主张，逐条成立）

**结论：可签**（0 高 / 0 中 / 7 低）。其对本文的 7 条主张的判定：

1. **两处驱动修复是「对齐契约」而非放水——成立。** 独立逐行 diff 得出：`markSync` 调用
   HEAD 12+4 个 → 工作树**逐字相同**；`title('…')` 断言点 **52 → 54**，**removed titles = 空**，
   新增只有 `FAIL-badge-shown2` / `FAIL-delegate-shown2`。两条新断言**非恒假**：闸门条件
   （`collab-entry` 需 `collabConfigured || collabActive`，`ui/src/App.tsx:3304`；
   `delegate-open` 需 `sid && collabConfigured && owner==='Human'`，`:3863`）与 beacon
   中紧随其后标记已到达，共同证明它们确实执行过。**证伪点**（审核者自拟）：把 `collabActive`
   改为「有会话即真」→ 连接前的 `FAIL-badge-shown` 抓不住，**`FAIL-badge-shown2` 会红**；
   摘掉 `delegate-open` 的 `collabConfigured` → 连接前 `sid` 为 null 故旧断言恒不触发，
   **新断言会红**。⇒ 净增覆盖。前提也核了：`tools-collab` 整体包在
   `{current && (<div className="session-toolbar">)}`（`App.tsx:3839`），故 HEAD 的
   「先 openCollab 后 connect」是**确定性失败**，本文归因成立。
2. **r43a/r43b 标记数**——URL-decode 后 12 / 4 条，与本文两表逐条同序同名；`FAIL`/`JS-ERROR`/
   `JS-REJECT` **0 行**；各恰一条 `-DONE`（无重试无跳过）。
3. **落库对账**——独立自跑 `sqlite3` 全符；`handback(9)` 早于 `session_delegated(10)` 不矛盾
   （`crates/core-session/src/lib.rs:1851` 先 `handback` 再 `:1856` append `session_delegated`）。
4. **R44 会话与审计**——7 行逐条复现，时刻换算全对。**并给出超出本文的独立旁证**：三张图的
   右栏「操作记录」条目与 audit seq1–7 **一一对齐**，`old-ui-hosts.png` 的 TOFU 门指纹 = 库里
   seq4 payload 指纹——**像素与库互锁**，比本文自证口径更强。
5. **二进制判别**——两份日志的 `scheme`/`port` 字段符；`Cargo.toml` 无 `[features]` 块、
   `git log -S custom-protocol` 零命中。
6. **写锁复验**——审核者在 `/tmp/rev-r45-lock` 用**自己的口令**全量重跑，**行为与报错文案**
   与归档件一致（含第二个 GUI `exit=101` 与 `main.rs:1021`）。**限定**：锁路径随库路径而变
   （审核者那次印的是 `/tmp/rev-r45-lock/tinyssh.db.lock`），末尾 host UUID 每次新生成
   （审核者得 `h-6ece0b22-…`），故是「行为与文案一致」而非「输出逐字一致」。
   审核者另独立复核「陈旧二进制更正」**诚实、无掩饰**。
7. **§6.1 工具检查**——独立复算 `0` 命中；另核**关键词选得对不对**（`220`/`280` 确为 tag
   `styles.css:164` 的旧布局常量，新 UI 主机栏 224px），并核了范围外 `r14/r21/r22/r23` 里的
   `280` 命中全是「§280」规范条目号 ⇒ 限定到 `r4*` **没有藏东西**。

### rev-r45-native 的 7 条低级发现与处置

| # | 发现 | 处置 |
|---|---|---|
| 低-1 | 兜底路径**放松**了原生域对「停用态必须经 `collab-open-settings` 进入」的强断言：该钮若坏，会被 `.hb-settings` 救活 | **登记不修**（理由见下） |
| 低-2 | §〇 称 ui-switch.sh「显式 `--features tauri/custom-protocol`」不准（脚本第 75 行未显式传，来自 tauri CLI 默认） | **已改**（措辞更正） |
| 低-3 | R44 旧 UI 二进制**未归档**，`/tmp/r44-oldui-target` 已被 V2=1 增量构建覆盖；「跑的是哪次构建」只能推断 | **已登记进 §六 未主张** |
| 低-4 | 陈旧 CLI 二进制的 mtime 已不可再核（产物已被 08:21 重编覆盖） | **已登记进 §六** |
| 低-5 | §三 引用块里的 host UUID 取自**另一次运行**（`h-f804a6e3` 属 `/tmp/r45-lock4`），归档件是 `h-ec0a7669`（`/tmp/r45-lock5`）——两次运行拼接被当作原文 | **已按归档件改正**并注明来源 |
| 低-6 | §四 文件清单漏 `__pycache__/` | **已补** |
| 低-7 | 审核者初报「§四『共 905 行』不可复现，按更宽跨度得 921」 | **审核者已撤回**：复查后确认其 921 系**自身边界取错**——用「下一个 `fn r4X_smoke_script` 签名行」当函数尾，把 r42/r43 的**文档注释块**（4303–4311 九行、4516–4522 七行，合计 16）算进了上一个函数。作者按「签名行 → 闭合 `}`」计的 **905 正确**。本行保留以存审核记录 |
| 低-8 | §三 称「以上四行**逐字**取自归档件」略超——错误串被截为 `（写锁 … 被占用）`、库路径略为 `库 …`，`→ exit 1/0` 系本文所加 | **已改**：改述为「**命令与 UUID** 取自归档件；错误串与路径按 `…` 省略，退出码标注为本文所加」 |
| 低-9 | §五 主张 6 称审核者重跑「输出与归档件**逐字一致**」略超——行为与文案一致，但锁路径随库路径而变、host UUID 每次新生成 | **已改**：改述为「**行为与报错文案**一致」并写明两处必然不同之处 |
| 低-10 | 上级 README 称审核者「独立**自跑** beacon/DB/写锁/工具检查全符」——beacon 是**清点**而非「跑」 | **已改**：上级 README 改为「独立**复算 beacon 标记** + 自跑 DB / 写锁 / 工具检查，全符」 |

**低-1 为何登记不修**：修它要给 `openAgentSettings` 加「停用态下 `collab-open-settings`
不可达即判失败」的分支并**重跑 r43a**，从而改动 `src-tauri/src/main.rs`——那会使本次对
`main.rs` 的签署（哈希 `7910ac99…`）失效。权衡：① 审核者定级为**低**且明确「非阻断」；
② 该元素在**视觉域仍有覆盖**（作者复核：`vis-r43-report.md:49` 给出包围盒
`(931, 206.4, 154×31)` 且 `elementFromPoint` 命中自身，`:223` 记「按钮不可达（被遮挡）：无」；
`vis-r43-evidence.json` 的 `hitTestid="collab-open-settings"` 两处 `ok:true`）；且
`vis-r43-report.md:82/:255` **早已把「完整面板态没有该入口，须走主机栏 `.hb-settings` +
`settings-cat-agent`」登记为契约**；③ 本原生驱动是**开发期工装**，按 G4 退出条件随
`TINYSSH_UI_V2` / `.worktrees/old-ui` 在 **G5 发布候选构建一并移除**，生命周期只剩一轮。
故按「证据不得超出主张」登记为**原生域覆盖净减**，**不主张**该路径在原生域被强断言；
建议若 G5 前还有原生轮次，补一条「停用态必须经 `collab-open-settings` 进入」的独立断言。

**审核期间树漂移（审核者主动报出，本文照录）**：`src-tauri/src/main.rs` 与全部原始证据
（beacon / db-reconcile / write-lock-reverify / 四张 PNG / `app-*.log`）在审核期内**哈希或
mtime 未变**；但本文 README 在审核期内改过两次（08:25:37 / 08:34:22），08:34 那次正好修掉了
审核者**独立发现**的两处（中 A 判据不成立、中 B 描述互换）。因此审核者的「可签」**只对
08:34:22 那一版有效**；本次又按低-2/5/6/7 再改，**已另行提请复审**（见文末签署状态）。
> **补记**：此后本文又按低-8/9/10 更正措辞、追加 §七、并按审核者意见把三处行号收紧，
> 版本**不止两次**——完整版本与签署锚点见 §七；本段「两次」是当时的照录，不再更新。

## 六、口径与未主张

- 本目录主张的是**原生 GUI 面**：R43 协作启停两模式、R44 旧 UI × 新核心、写锁互斥、
  原生工具无旧布局坐标。浏览器 demo 域的 236 项断言见上级 `README.md`。
- **未主张**：`ui-switch.sh` 的三种模式未各自重跑（只重跑其中 `build --no-bundle` 的
  `TINYSSH_UI_V2=0`）；原生窗口红绿灯 / 真实拖动 / 原生选择器（NSOpenPanel）仍未覆盖
  （后者已由 `docs/ux/` 登记为**不可自动化**，待人工确认）。
- **未主张（rev-r45-native 低-3）**：R44 那台旧 UI 二进制的**产物本身未归档**——
  `/tmp/r44-oldui-target/release/tinyssh-app` 已被 `TINYSSH_UI_V2=1` 的增量构建覆盖（现装新 UI
  资源键），08:11 那次运行用的二进制又被 08:21 的 `cargo build --release` 覆盖。可佐证的只有
  `.worktrees/old-ui/ui/dist/assets/` 于 08:07 重建出与 `ui-switch-embed.txt` 首建**同哈希**的
  `index-yP7p5Ktu.js` / `index-CaT58Wfd.css`，加上截图确为旧三栏外壳。故「跑的是哪次构建」
  属**推断而非产物实证**，如实登记。
- **未主张（rev-r45-native 低-4）**：§三 那个陈旧 CLI 二进制的 mtime 已**不可再核**（产物已被
  08:21 重编覆盖）；该更正的依据是 `git log -S VaultLock`（唯一命中 `28fe843`）的推理自洽。
- **未主张（rev-r45-native 低-1）**：原生域对「停用态必须经 `collab-open-settings` 进入」
  的强断言被兜底路径放松（详见 §五 低-1 处置），**不主张**该路径在原生域被强断言。
- 本目录的 `app-*.log`、`beacon-*.txt` 为原始日志；`db-reconcile.txt`、`write-lock-reverify.txt`
  为可重放的落库对账与写锁复验原文（命令写在文件里）。
- 复跑提示：`target/release/tinyssh-app` 现为 `cargo build --release` 产物（加载 devUrl），
  跑原生冒烟前须先起 5183 上的 vite dev server。

## 七、签署状态

| 版本 | 审核者 | 结论 |
|---|---|---|
| `08:34:22`（288 行） | rev-r45-native | **可签**——其后本文按低-2/5/6/7 再改，该签署按审核者规则失效 |
| `70a40a8d…`（364 行） | rev-r45-native | **可签**（并撤回其自报的低-7） |
| `b9cdf581…`（388 行） | rev-r45-native | **可签**（0 高 / 0 中 / 低若干）——审核者已逐条核 §七、三个收紧行号（`App.tsx:3304` / `:3863` / `:3839`）与低-1 理由段引用；**其后仅修两处文字 nit**（§二 编号 `低-1`→`低 C`、§五 漂移段补记）**并回填本行，无主张变更** |

`src-tauri/src/main.rs` 自审核开始起**未再改动**（哈希 `7910ac99c9eddf48ed393c12319ac8396ff40551dd0211df71198614b6f65b89`），
故对驱动本身的签署持续有效；原始证据（beacon / db-reconcile / write-lock-reverify / 四张 PNG /
`app-*.log`）在审核期内 mtime 未变。

**审核者自纠记录（如实留存）**：rev-r45-native 初报「§四 905 行不可复现（其数 921）」，
复查后确认系**其自身边界取错**（把 r42/r43 的文档注释块算进上一个函数，+16），已撤回——
本文的 905 口径正确。此条与作者侧的低-5 一并说明：本轮两边的记录都出过错，均经对方核出并更正。
