# R50 / E05 —— `prefers-reduced-motion` 的可自动化部分

日期：2026-10-10　HEAD：`11ce7389a26f96c22a8844bfad0b6090fe572a94`　证据目录：`2026-10-10-11ce738-r50-e05/`

## 1. 范围

E05 行级要求含 **VoiceOver 朗读**与 **reduced-motion** 两块。**VoiceOver 完全手工**
（读什么、什么顺序、是否逐字节播报需人耳），本档**不涉及**。本档只覆盖
**reduced-motion 的可自动化部分**。

**与行级验收的关系（须先讲清，免误读）**：交付文档 `docs/ux/ssh-client-ux-refactor-delivery.md:214`
的 E05 行，其「必须观察到的结果」是「label/状态可读，模态语义正确；不播报每个输出字节」、
验收层级是「**原生手工**」——**那是 VoiceOver 那半边**，本档（CSS 动画覆盖）**不等于**该行验收。
授权本档「浏览器域先行」的是执行状态表 `docs/ux/ux-r1-execution-status.md:74`（R50 行：
「E02/E03/E05(reduced-motion)/E06 浏览器域可先行」）；本档所依据的**动效口径**取自
`docs/ux/ssh-client-ux-refactor.md:445`（「动效 120–180ms，优先 opacity；不对终端宽度做
缓慢弹性动画；**支持 reduced-motion**」）。本档**只**主张后两者的可自动化部分。

**被测对象**：`ui/src/styles.css` 里的 `@media (prefers-reduced-motion: reduce)` 规则
与它们所覆盖/未覆盖的动效，经 dev server（`http://localhost:5183`）在 headless Chromium
中测量。

## 2. 方法（探针 `probe-e05-reduced-motion.cjs`）

两段互补证据，缺一不可：

- **A 完备性（CSSOM）**：枚举页面样式表里**所有带动画（`animation:`）的选择器**与
  **所有带过渡（`transition:`）的选择器**，各自与**所有被 reduced-motion 规则关掉
  动画/过渡的选择器**取差集 ⇒ 「有动效但没有 reduced-motion 覆盖」的候选。
  **两个方向都要扫**：初版只扫了 `animation:`，漏掉 `transition:` 那一类
  （即 `.host-card`、`.host-card-side` 这种「有过渡、无覆盖」的选择器）。
- **B 有效性（computed style，双口径）**：对候选表里每个选择器，分别在
  `reducedMotion: "no-preference"` 与 `"reduce"` 两个浏览器上下文里读 computed
  `animationName` / `transitionDuration`。**只报一侧 = 无法判定**；两侧**相同**说明规则
  没有咬住（写了但被覆盖，或压根没写），两侧**不同**才算规则生效。

**元素来源与前提**：**只有 `.host-card` / `.host-card-side` 用页面真实元素**（主机栏常驻）；
其余 **8 个**——`button`、`.tab`、`.toast`、`.spin`、`.skeleton`、`.collab-badge.hot`、
`.sftp-row .sftp-dl`、`.attach-hint`——用**注入的等价 DOM**读 computed style，读完即弃。
对应关系见探针 `targets` 表：前 8 项映射到 `#p-*` 注入节点，后 2 项映射到真实选择器。
**关于 `button` / `.tab` 为何也走注入**：这是探针的实现选择，**不是**因为首屏没有它们——
首屏其实**有**标签栏（demo 预置两个会话 prod-1 / staging-1，故 `.tabbar` ×1、真实 `.tab` ×2）；
`button` 更是遍地。注入只是沿用统一的 `#p-*` 写法。**该选择已在真实元素上复测，且已归档为可复算证据**：
见 `probe-e05-real-elements.cjs`（读数 `e05-real-elements.json`，`run.attempts === 1` 自证单次干净运行）。
它在首屏**真实元素**上读同样两个量（computed `transitionDuration` / `transitionProperty`），双口径各一次：

| 真实元素 | 身份 | `no-preference` | `reduce` |
|---|---|---|---|
| `button`（首屏首个） | `BUTTON.ghost.icon-btn` | `0.12s ×5` / `background-color, border-color, color, box-shadow, opacity` | `0s` / `none` |
| `.tab`（首屏首个） | `DIV.tab`（`role="tab"`） | 同上 | 同上 |
| `button.ghost` | `BUTTON.ghost.icon-btn` | 同上 | 同上 |
| `.host-connect-btn` | `BUTTON.host-connect-btn` | 同上 | 同上 |

与 `e05-raw.json` 的注入件读数**逐字段比对**（`button` 与 `.tab` × 两个口径 = 四组）
**全部逐字相同** ⇒ B 表前两行有真实元素双重确认。该探针另读出 `counts`
（`{tabbar:1, tab:2, hostCard:7, hostCardSide:7, connectBtn:7}`）与 `allTabs`
（两个 `DIV.tab[role=tab]`：prod-1 / staging-1，class 恰为 `"tab"`）——**故上面「`.tabbar` ×1、
真实 `.tab` ×2」与「真实 `.tab` 是 `div` 不是 `button`、class 不含 `tab-active`/`tab-pane`」
也一并成为可复算**。该探针有**状态依赖**（`.tab` 只在 demo 预置 2 会话的首屏存在），
已在探针头注与 identity 中写明。
注入的**前提是「注入节点的 class 集合覆盖真实元素的**动效相关** class」**——这一点由人工
核对保证，脚本无法自证。核对结论：注入节点带的就是**选择器命中的那部分** class；真实元素
多出来的 class 都是**非动效 class**，已逐条核对**不声明 `animation`/`transition`**：
`ico`（`ui/src/icons.tsx:18` 的 `Svg` 把 `className` 拼成 `"ico " + className`；
`styles.css:305` 仅 `flex:none`）、`ghost`（`styles.css:279/289/587`）、
`.toast.ok|.err|.info`（`styles.css:344-346`）、`tab-active`（`:422`）、`tab-pane`（`:423`）、
`ts-open`（`:497`）、`sftp-sk`（`App.tsx:4877` 真实元素是 `<div className="skeleton sftp-sk">`；
`styles.css` 中**不存在** `sftp-sk` 规则）。**真实 `.tab` 是 `<div className={"tab" + …}>`
（`App.tsx:3591-3595`，`role="tab"`，是 `div` 不是 `button`）；首屏那两个真实 `.tab` 的 class
恰为 `"tab"`，不含 `tab-active`/`tab-pane`；全仓无任何 `<button class="tab">`。**因选择器都是
类选择器（不绑标签名），标签差异（`div` vs `svg` vs `button`）不影响规则匹配。**这一点必须
写明**，否则「注入 DOM 测出的结论能代表真实组件」就是未声明的跳跃。
**本段只验证「CSS 规则对该选择器是否生效」，不验证「该组件在真实运行态下是否动画」**
——后者本档不主张。

### 探针自身的两处静默漏检（已修，登记在此以免误信）

初版用 `r.style.cssText` 正则 + `animationDuration === "0s"` 判「动画被关掉」，**漏掉了
全部 4 条 `animation: none` 规则**，于是把 `.toast` / `.skeleton` / `.collab-badge.hot`
也报成「无覆盖」——**那是假红**。实测 Chrome 的行为是：

| 写法 | `cssText` | `style.animationName` | `style.animationDuration` |
|---|---|---|---|
| `animation: none` | `animation: auto ease 0s 1 normal none running none;` | `"none"` | **`"auto"`**（不是 `0s`） |

⇒ cssText 里**没有** `animation: none` 子串；`animationDuration` 也不是 `0s`。
修正为**只看 `animationName === "none"`** 后，A 段列出的覆盖集与源文件里 6 条
`@media (prefers-reduced-motion: reduce)` 块（`styles.css:157/271/348/349/810/949`）
**逐条对齐**。下表读数均取自修正后的探针。

> **口径说明**：「初版漏检 / 假红」这一段是**修复过程的历史陈述**，**不能从本证据包
> 里的任何产物复算出来**——包里只有修正后的探针与读数。审核者若要验证，只能自己把
> 探针改回旧写法重跑；**本档不主张这段历史可被独立复核**，只把它作为「为什么当前读数
> 值得信」的背景登记。

## 3. 结果

**A. 完备性（两个方向）**

| 集合 | 选择器 |
|---|---|
| 带动画（基础规则） | `.attach-hint`、`.collab-badge.hot`、`.skeleton`、`.spin`、`.toast` |
| 带过渡（基础规则，共 8 条） | `button`、`input`、`select`、`textarea`、`.tab`、`.sftp-row .sftp-dl`、`.host-card`、`.host-card-side` |
| reduced 覆盖 | `.collab-badge.hot`、`.sftp-row .sftp-dl`、`.skeleton`、`.spin`、`.tab`、`.toast`、`button`、`input`、`select`、`textarea` |
| **动画差集** | **`.attach-hint`** |
| **过渡差集** | **`.host-card`、`.host-card-side`** |

**B. 有效性（双口径）**

| 选择器 | `no-preference` | `reduce` | 判定 |
|---|---|---|---|
| `button` | `transition 0.12s ×5` | `0s`（`property: none`） | 规则生效 |
| `.tab` | `transition 0.12s ×5` | `0s`（`property: none`） | 规则生效 |
| `.toast` | `animationName: toast-in` | `none` | 规则生效 |
| `.skeleton` | `animationName: shimmer` | `none` | 规则生效 |
| `.collab-badge.hot` | `animationName: collab-pulse` | `none` | 规则生效 |
| `.sftp-row .sftp-dl` | `transition 0.12s` | `0s`（`property: none`） | 规则生效 |
| **`.spin`** | `animationName: spin` | **`spin`（未变）** | **规则未咬**（E05-1） |
| **`.attach-hint`** | `animationName: attach-hint-fade` | **`attach-hint-fade`（未变）** | **无规则**（E05-2） |
| **`.host-card`** | `transition 0.12s / background-color` | **`0.12s / background-color`（未变）** | **无规则**（E05-3） |
| **`.host-card-side`** | `transition 0.12s / opacity` | **`0.12s / opacity`（未变）** | **无规则**（E05-3） |

原始读数：`e05-raw.json`（含 `run.attempts` 与 `run.probeSha256`，见 §5.6）；
探针 stderr：`e05-err.txt`（空 = 无页面异常）。

## 4. 发现（登记，本档不修）

**E05-1（中）`styles.css:349` 的 `.spin` reduced-motion 规则是死规则**

- 规则：`@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }`（`:349`，
  注释写「spinner 停转只留图形」）。
- 但基础规则 `.spin { animation: spin 0.9s linear infinite; }` 在 **`:686`**——**更晚**，
  且与前者**同特异性**（都是单类），故在 `reduce` 下由它胜出。
- 实测：`reduce` 下 `.spin` 的 computed `animationName` 仍为 `spin`（`e05-raw.json`
  `cases[".spin"].reduce`）。
- 影响面：`.spin` 用在连接中的 loader（`ui/src/App.tsx:3456`
  `<IconLoader size={11} className="spin" />`，该按钮在连接中 `disabled`，而
  `.host-card-side:has(.host-connect-btn:disabled)` 会显形 ⇒ spinner 真实可见且在转），
  **旋转是位移类动效**，正是 `prefers-reduced-motion` 要抑制的。⇒ 声明与行为不一致。
  声明的**原始出处**在 `ui/src/icons.tsx:135` 的注释：「旋转在 `.spin`，**reduced-motion
  下停转只留图形**」——白纸黑字写了却没生效。
- **在生产打包产物里同样成立**（排除「只是 dev server 顺序不同」）：打包 CSS
  `ui/dist/assets/index-O54pqTGs.css`（sha256 前 16 `59d25cb11c133292`，mtime 2026-10-10
  15:05，`index.html` 确引用该文件）中，reduce 规则块（`@media`）起于**字符/字节偏移 15583**、
  其内 `.spin` 选择器在 **15623**、基础规则在 **27165**（该文件纯 ASCII，字符偏移 == 字节偏移）
  ——三个偏移量都远小于 27165，**仍是基础规则在后**。（本档早前把「15623」写作 reduce 规则
  的起点，实为块内 `.spin` 选择器的位置；两个数各自都对，只是所指不同，不影响结论。）
- 建议（不在本档实施）：把该 `animation: none` 覆盖移到 `.spin` 基础规则**之后**
  （或提到文件尾统一收口）。

**E05-2（低）`.attach-hint` 无 reduced-motion 覆盖**

- `styles.css:1057` 起 `.attach-hint` 块，`:1063` `animation: attach-hint-fade 6s ease forwards;`；
  全文件**没有**对应的 `@media (prefers-reduced-motion: reduce)` 块（A 段动画差集仅此一项）。
- 实测：`reduce` 下仍为 `attach-hint-fade`（6 s）。
- **不是死代码**：`App.tsx:4069` 确有 `<div className="attach-hint">会话已接入——点击终端区
  直接打字，或用下方命令框</div>`（`attachHint && sid` 时渲染）。
- **需注意**：该 keyframes 只改 `opacity`（`styles.css:1065`
  `@keyframes attach-hint-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }`），
  **不含 transform**。`prefers-reduced-motion` 的规范目标是**位移/缩放类**动效，
  纯淡出通常被认为可接受 ⇒ **本档按「低」登记，不主张它是缺陷**；但同项目对**含位移**的
  `.toast`（`toast-in` 带 `translateY(6px)`）是关掉的，两者口径不一致，供发布前决定。

**E05-3（低）`.host-card` / `.host-card-side` 的过渡无 reduced-motion 覆盖**（A 段过渡差集）

- `.host-card { transition: background-color 0.12s ease; }`（`styles.css:969`）；
  `.host-card-side { transition: opacity 0.12s ease; }`（`styles.css:984`）。
- 实测：两处 `reduce` 下与 `no-preference` **完全相同**（0.12s，属性分别为
  `background-color` / `opacity`）⇒ 没有任何 reduced-motion 规则咬住它们。
- **本档不主张这是缺陷**：两条过渡都只改**颜色/透明度**，不含位移/缩放，属于
  `prefers-reduced-motion` 通常认为可接受的一类（与 E05-2 同理）。
- 登记理由：A 段差集是**完备性证据**，差集里有什么就必须写出来，不能因为「看起来不严重」
  就隐去——否则差集表会显得比实际干净。供发布前与 `.toast`/`.attach-hint` 一起定口径。

## 5. 口径与未做

1. **VoiceOver 朗读完全未做**——需人耳，见 §1。
2. **只测了 CSS 层**：不主张「所有动效都被 reduced-motion 覆盖」以外的任何事；本档没有
   测原生窗口动画。**JS 驱动的动效：全仓 `ui/src` 下 `requestAnimationFrame`/`.animate(`
   零命中，唯一一处平滑滚动是标签栏左右滚动**——`ui/src/App.tsx:533` 定义的
   `scrollTabs = (dir) => …`，其 `el.scrollBy({ left: …, behavior: "smooth" })` 在 **`:535`**
   （由 `.tab-scroll` 按钮触发）。`behavior:"smooth"` 属 `prefers-reduced-motion` 常规管辖的
   平滑滚动，本档 **未测**（探针只读 CSSOM/computed style，不驱动该按钮），**如实登记为
   未覆盖项**；另 `App.tsx:520`/`:2697` 的 `scrollIntoView` 未传 `behavior`（默认 instant），
   无动效。
3. **注入 DOM 的边界**：见 §2——验证的是**规则**而非**运行态组件**，且依赖「注入 class
   集合**覆盖**真实元素的动效相关 class」这一**人工核对**的前提（脚本不自证）。若审核者要求
   「必须用真实运行态元素」，则需先把 demo 驱动到 `.toast`/`.spin`/`.skeleton`/
   `.collab-badge.hot`/`.sftp-row .sftp-dl`/`.attach-hint` 各自出现的状态再复测；
   该分歧点如实登记。
4. **E05-1 引用的打包产物 `ui/dist/` 被 gitignore**（`.gitignore:3` 的 `dist/` 规则命中
   `ui/dist`），**不在版本库里** ⇒ 该佐证**无法从干净检出复现**，需本地 `cd ui && npm run
   build` 重新生成（文件名哈希会随构建而变，届时偏移量须重算）。本档保留它作为
   「dev 与 prod 一致」的**一次性旁证**，不作为可复算证据。
5. **三处发现均未修复**（本档是验证任务，改产品代码不在范围内）。
6. **单次干净自证**：归档目录在正式跑前清空（连 `.run-attempts` sidecar 一起删），故
   `e05-raw.json.run.attempts === 1` 即证明读数只来自一次运行；`run.probeSha256` 把读数
   钉死在当前那一版探针上（`probe-e05-reduced-motion.cjs` 的 sha256 全值）。
   **补档的真实元素探针另有独立 sidecar** `.run-attempts-realelem`（`e05-real-elements.json.
   run.attempts === 1`），与主探针的 `.run-attempts` 分开计数 ⇒ 主探针的单次干净自证不受其影响。
7. 探针在 `docs/` 下，`playwright-core` 装在 `ui/` 下，故用 `require.resolve(..., {paths})`
   显式解析；不依赖调用者 cwd。
