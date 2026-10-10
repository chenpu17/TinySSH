# 合成输入投递原语验证：`CGEventPostToPid` vs 全局 HID（2026-10-10）

> 计划「原生窗口 resize 原语、`ev.py` drag 原语均为**新增能力**，本身需验证后再用于
> 取证」。本目录是**投递原语**的同级验证——`scripts/perf/ev2.py` 是 C2/A5/E04/E07
> 全部受控注入的底座，先验它能不能把事件送进被测应用。

归档时 HEAD：`db72d71`。锚点：

| 文件 | md5 |
|---|---|
| `scripts/perf/ev2.py`（**本轮修改**） | `f0e08b39bde6ce2412a2a0245b360f8b` |
| `scripts/native-smoke/ev2_check.py`（本轮新增） | `11666fa10701e608f437510cf5ffba38` |
| `scripts/native-smoke/ev_delivery_probe.py`（本轮新增） | `73a30f0e99f6abc3f24334b93bfb3849` |

> 上表为**本轮定稿版** md5（含独立复核后的修正：`ev2.py` 加 `release_buttons`、
> `ev2_check.py` 记 rc/前置前台核验、`ev_delivery_probe.py` 修 `reset_ui_state`）。
> 归档目录内各原始件另有其运行时的 `run.log`/JSON。

被测二进制 sha256（主树 `target/release/tinyssh-app`）：`3bfecdf0d7934491…`。

## 1. 结论

1. **`CGEventPostToPid`（ev2 原用路径）在本机对 tinyssh-app 静默失效**：鼠标与键盘
   皆然、新旧两棵树皆然、guard 全过、调用返回成功、无任何报错，被测应用**零反应**。
   同一坐标改用 `CGEventPost(kCGHIDEventTap, ev)`（全局 HID）则生效。
2. **但全局 HID 正是 G0 签署 §4 明文禁止的机制**（`docs/ux/ux-r1-g0/g0-signoff.md:50`：
   「只用 ev2 PID 定向投递和逐事件守卫；**不得回退全局 HID 注入**」）。
   ⇒ 本机当前状态是：**签署授权的机制不可用，可用的机制未获授权。**
   **这是 R51/C2 的阻塞项**，须先取得**签署范围修订**（与「用本机」偏离一并登记），
   不得自行降级处理。
3. 因此 `ev2.py` 的修改取**保守**方向：**默认仍是签署授权的 `pid`**；`global` 为
   **fail-closed 开关**——未设 `TINYSSH_EV2_ALLOW_GLOBAL=1` 时 `--deliver global`
   在 guard 之前即 **exit 2 拒绝**，一个事件都不发。该环境变量是审计可见的授权凭据。
4. 即便获授权，global 仍带**三个静默失判陷阱**（§4：首次点击被吞 / 低概率丢事件 /
   焦点漂移），调用方**必须核验效果**，不得假设「投递即生效」。

## 2. 机制级对照（探针：`ev_delivery_probe.py`）

单变量对照：**坐标、应用、会话、时刻完全相同，唯一变量是投递目标**。

1. 启动被测应用，等 1280×800 窗口，置前。
2. 记录「哨兵区域」（左侧面板）基线像素 md5。
3. 每个 mode 前用全局点击把面板**复位到基线**，保证两者起点相同。
4. 以 `pid` / `global` 两种方式点击**同一哨兵点**（`＋`，点击后面板展开），各记前后 md5。
5. 重复 3 轮，要求某 mode 三轮结论一致才采信。

判定：`pid` 三轮全「无变化」且 `global` 三轮全「有变化」→ `pid_delivery_broken`。

### 结果（原始件：`main/`、`b1/`）

| 被测二进制 | sha256（前 16） | 轮次 | pid 变化 | global 变化 | 裁决 |
|---|---|---|---|---|---|
| 主树 `target/release/tinyssh-app` | `3bfecdf0d7934491` | 3/3 | **False ×3** | **True ×3** | `pid_delivery_broken` |
| B1 `.worktrees/old-ui/…`（tag `ea0b914`） | `2c3ab20dbc90db77` | 3/3 | **False ×3** | **True ×3** | `pid_delivery_broken` |

像素证据（`main/`）：基线与 `pid` 点击后 **md5 完全相同**（`4405d4771f…`），
`global` 点击后变为 `5d92b3e56697…`（面板展开）。三轮 md5 逐字相同，无抖动。
`b1/` 同理（`c8f7e62ccd…` → `919f431851…`）。

**不是 TCC 权限问题**：全局 HID 投递本身就需要「辅助功能」授权且**成功**，
说明本进程已获授权；`CGEventPostToPid` 返回成功但事件被静默丢弃。
**不是「窗口未成为 key」问题**：先做全局点击建立 key window，再做 pid 点击，
窗口区域仍**逐像素不变**。

## 3. 工具级验证（`ev2_check.py`，原始件：`ev2-check/`）

机制级对照用的是探针**自建**的投递代码；本节验的是 **ev2 这个工具本体**（`--deliver`
接线、逐事件核验、guard 退出码），一律以 `subprocess` 调 `ev2.py`，不复制其代码。

| 段 | 断言 | 结果 |
|---|---|---|
| A | `--deliver global` 点哨兵 → 面板像素翻转，且每次尝试 **rc=0** | **PASS** 6/6 轮翻转（8 次尝试，含 2 次丢事件，rc 全 0） |
| B | **默认投递**（不传 `--deliver`，即 pid）→ 像素**永不**翻转，且每次尝试 **rc=0** | **PASS** 6/6 轮 0 翻转（18 次尝试，**rc 全 0**） |
| C | 不存在的 pid → exit 2 且不投递 | **PASS**（`stderr` 含 `does not exist`） |
| D | 存在但非前台（`sleep` 子进程）→ exit 2 且不投递 | **PASS**（`stderr` 含 `frontmost`） |

- B 段**刻意不传 `--deliver`**：验的正是「默认值 = 签署授权的 pid」。
- **B 的 `rc=0` 是关键证据**（独立复核 finding #3）：只看「没翻转」无法区分「投了但
  没效果」（= 要证的环境事实）与「guard 拒绝、根本没投」（= 工具坏了却假过）。本轮
  18 次尝试 rc **全 0** ⇒ 事件**确实投了出去**，pid 路径对本应用**无效果**，而非被拒。
- C/D 不打扰任何用户应用（`sleep` 无 UI；不存在的 pid 无副作用）。
- 该次运行 `ev2-check.json`：`A_global.drops=2`（8 次尝试）、`B_default_pid.drops=18`
  ——B 的 18 是「每轮重试耗尽」的计数，即 pid **一次都没生效**，非丢事件。
- 该 JSON 自记 `bin_sha256 = 3bfecdf0d7934491…`（= 上表被测二进制），证据包自证身份。
- **裁决三分**（勿把环境差异误报成工具缺陷，finding #4）：`ev2_delivery_verified`
  （全过）/ `pid_delivery_now_works`（B 翻转 = 本机 pid 恢复可用，属**环境属性变化**）/
  `ev2_delivery_failed`（A 或 C/D 未过）。本轮为前者。

## 4. 三个静默失判陷阱（实测撞到，已写进 `ev2.py` / `ev2_check.py` docstring）

**① 激活后首次点击会被吞。** `activate()` 之后目标窗口尚未成为 key，第一个全局点击
被 macOS 吃掉用于「转 key」，表现为**像素不变**——与「投递失效」症状完全相同。
实测：静置 **2.5s** 后连续 **14 次**点击**全部落地**；静置约 1s 时首次点击被吞。
⇒ `ev2_check.py` 默认 `--settle 2.5`，并在测量前做一次**预热点击**（点完复位），
把转 key 的动作移出测量窗。

**② global 投递会低概率丢事件。** 实测：

| 仪表条件 | 丢事件 |
|---|---|
| 每次点击前后多张 `screencapture`（较重） | 约 1/6 |
| 每次点击仅一张截图、静置 0.75s（较轻） | **0/60** |
| `ev2_check.py` 工具级（含子进程启动） | 2/8、3/9、1/7、0/4 次尝试（四次运行） |

**丢因未定性**，已排除三项：
- **非事件间隔**：`move→down→up` 的 gap 取 0 / 60 / 150 ms，各 20 次，**全无丢失**。
- **非前台漂移**：丢失发生时 `frontmost` 仍等于目标 pid，`check_front` 未触发中止。
- **非「double-toggle 弹回」**：丢失的点击在 +0.12/+0.35/+0.8/+1.5s 四个采样点均停在
  原态，未观察到中间态。

⇒ **给调用方的结论**：用 global 做坐标取证时，**必须核验效果**（轮询状态/像素直到
变化），不得假设「投递即生效」；单次点击触发的计时端点会因丢事件产生**虚假长尾**。

**③ 焦点漂移/残留实例会让「全程 rc=2」伪装成工具缺陷。** 症状：guard 对**每次**调用
都返回 rc=2（什么都不投），但像素仍可能因**他窗口重绘**而「翻转」——于是 B 段假红，
被误报成 `ev2_delivery_failed`（工具缺陷）。本轮实测**撞到两次**：

- 残留 `tinyssh-app` 实例占住库写锁 `/tmp/ev2_check/tinyssh.db.lock` → 新实例
  `panic` 退出 → 探针 20s 内取不到窗口（症状与「应用起不来」无异）；
- 焦点被其他窗口抢占 → 前置核验前全程 rc=2。

缓解（本轮已加入 `ev2_check.py`，均属**把环境问题与工具问题分开**）：
① 清掉陈旧的 `.lock` 锁文件；② 应用早退时**立即**打印 `app.err` 末尾而非白等 20s；
③ **测量前置断言「前台 = 被测应用」**，重试 6 次仍不成立即以 exit 2（**环境问题**）
退出，不继续产出垃圾数据。⇒ 若见 `ev2_delivery_failed`，**先查前台与残留实例**，
再怀疑工具。

## 5. 附带发现：webview localStorage 让原生 UI 布局跨轮漂移

dev 二进制把 UI 状态持久化在 `~/Library/WebKit/tinyssh-app/WebsiteData/LocalStorage/`
（**直接式**布局 `<bundle>/WebsiteData/LocalStorage`；多数 Tauri/WebKit 应用是
`<bundle>/WebsiteData/Default/<hash>/<hash>/LocalStorage` 嵌套式）。实测键
`ui.hostbar` / `ui.hostbar_w` / `ui.r15s1` / `ui.r15epoch` / `ui.r15step`。一次交互把
`ui.hostbar` 置 0（隐藏主机栏）后，**下一轮启动仍是该布局**——于是同一套坐标在两次运行
里指向不同控件，探针会以「两种投递都无变化」**静默失判**（本轮实测到：基线 md5 从
`4405d4771f…` 变成 `2a7b5e1ddf…`，区域全空）。

⇒ 探针加了 `--reset-ui-state`：启动前把匹配到的 `LocalStorage` 目录 **`mv`** 到
`<out>/ui-state-backup/`（可逆，不删）。**任何依赖坐标的原生取证都必须先复位该状态**，
否则「坐标漂移」会被误判成产品缺陷或投递失败。

**勘误（独立复核 finding #1，已修）**：本目录**首版**称该复位「生效」——**当时不成立**。
首版 `reset_ui_state()` 用 4 段 glob `*/WebsiteData/*/*/LocalStorage`，实测匹配 **0** 个
（两型真实布局都不匹配，见上）；即该开关**一直在静默空转**。归档 `main/run.log` 与
`b1/run.log` **首行**那句 `reset ui state: moved 0 LocalStorage dir(s)` 就是证据——
当时未被察觉。修正为：**递归 glob 覆盖任意深度** + **只认 bundle 段恰为 `tinyssh-app`
的那一支**（排除用户可能已安装的 `com.tinyssh.app`；用户长期指令禁止打扰用户应用）+
匹配 0 个时**大声 WARN**（「本轮未复位」与「glob 又写错」症状相同，不能静默）。

- 修正后以 spy 方式（替换 `shutil.move` 只记录不真移）复核：**恰好选中 1 个**目录
  `/Users/chenpu/Library/WebKit/tinyssh-app/WebsiteData/LocalStorage`，
  **未**选中 `com.tinyssh.app`。
- `main/`、`b1/` 归档仍是修正前那次运行（其 `moved 0` 是上述 bug 的指纹）。该次运行的
  机制结论**不受影响**——两次运行基线均为干净的 `4405d4771f…`/`c8f7e62ccd…`，
  pid 无变化、global 有变化，**3/3 轮一致**，受控对照成立。

## 6. 口径与未做（未覆盖项逐条登记，不主张）

- **未取得签署范围修订**：本目录的全部 global 证据都是**未授权偏离的产物**，只作
  **偏离登记**，**不得作为门证据**。§1.2 的阻塞项未解前，C2/A5/E04/E07 的注入类
  取证**不能推进**。
- **键盘段不稳定，默认关闭**：`--with-keyboard` 可开，但实测**复跑不一致**——
  同一序列在两次会话中一次成功（全局注入的文本出现在输入框）一次完全无反应。
  本目录**不**对键盘投递下结论；`pid` 键盘失效仅有一次手工观察（B1：文本框经全局点击
  聚焦、焦点环可见，pid 注入的字符串**未出现**）。键盘须另行设计可复跑的对照。
- **未在第三方应用上验证**：用户长期指令禁止打扰用户环境，故未拿用户应用做对照。
  「本机 pid 投递普遍失效」**不主张**——只主张「对 tinyssh-app 失效」。
- **未定性根因**：是 macOS 版本（本机 27.0.1 / build 26A434）回归、还是本机特定配置，
  **未做**跨版本或跨机器对照。
- **未量化丢事件率**：§4② 的三个数字来自**三次不同仪表条件**的小样本，**不构成**丢
  事件率的估计；只支持「存在低概率丢失、且随仪表条件变化」。丢因未定性。
- **未验证 `drag`**：`ev2.py` 的 `drag` 段（`kCGEventLeftMouseDragged` 插值）本目录
  未涉及；其 pid 路径按 §1.1 **同样失效**，E07 前须先修投递再验。
- 机制级探针裁决只看**鼠标**；`keyboard` 段即便开启也不参与裁决。
- **`ev2.py` 的 `exit 3` 不可达**（本轮更正 docstring）：`guard` 在 pid 不存在时即返回
  拒绝消息 → `exit 2`。代码中无分支产生 `exit 3`。
- **二进制身份**：见 `bin-identity.txt`（三处子归档的二进制路径 + sha256 + mtime；
  两二进制自构建后未重编译）。`ev2-check/ev2-check.json` 亦自记 `bin_sha256`。
- 本目录由作者执行；**独立复核进行中**（复核者 `ev2-delivery-review`，已回报 7 条
  发现，均已处置：`release_buttons` 补抬起 + selftest ⑤ 断言、`ev2_check` 记 rc +
  前置前台核验 + 清锁 + 早退报错、`reset_ui_state` 递归 glob 修正、B 段裁决三分）。
  其完整报告（含视觉复验、主张对证据、审核期变异三节）到达后另立 `review-ev-delivery.md`
  归档；**在报告到达前，本包主张以作者自验为限。**
