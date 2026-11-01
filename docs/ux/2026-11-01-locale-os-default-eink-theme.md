# OS 语言默认 + 墨水屏主题（2026-11-01）

用户两点：①「默认 OS，设置里面可以切换语言」——此前 i18n 缺省写死中文，没有跟随 OS；②「支持一款适合墨水屏幕的主题风格（暗色应该不合适墨水）」——16 族色板全是屏幕审美，没有 e-paper 面。

## 一、界面语言默认跟随 OS

### 设计决定

- **解算规则**（`resolveInitialLocale`，纯函数独立成 `ui/src/locale-resolver.mjs` + `locale-resolver.d.mts` 类型声明）：
  1. 显式存储值（zh/en）最优先——用户选过就尊重，OS 变了也不翻；
  2. OS 语言偏好列表按序匹配：`zh*`→zh、`en*`→en（列表顺序即优先级）；
  3. 有语言信息但都不支持（fr/de/…）→ **en**（两种支持语言里的次优通用语）；
  4. 完全探测不到（老 WebView/异常环境）→ **zh**（历史缺省兜底）。
- **接线点只有一个**：App.tsx 真实域 KV 装载（`get_setting(SETTING_LOCALE)`）无有效值时检测——只落 t() 模块态 + localStorage 即时缓存，**不写 vault KV**：用户在设置里显式选择前保持「跟随系统」语义（OS 变则界面跟着变）；`changeLocale` 才落 KV（钉住）。
- **demo 域固定 zh 缺省、不跟 OS**（关键决定）：`readLocale()` 保持 localStorage→zh 不动。原因=套件确定性基座：harness 对每个上下文固定 `newContext({locale:"zh-CN"})`（复审轮核实——demo 即便跟 OS 也不会打穿中文断言），固定 zh 是 demo/真实两域行为隔离的既有约定；语义差异在 spec 60 有注释钉住。
- **首启闪帧可接受**：第一次启动模块初值 zh → KV 装载异步检测后翻到目标语；`setLocale` 同步写 localStorage，第二次启动起首帧即正确。
- 下拉标签「中文（默认）」→「中文（简体）」（缺省不再是写死的中文，标「默认」反而说谎）；设置描述改「默认跟随系统语言，切换立即生效；未覆盖文案保持中文。」
- README 双语特征行同步（EN：defaults to your system language on first launch）。

### 为什么 resolver 独立成 .mjs

node spec（.cjs）导不进 TS 源；真值表 9 条断言要直连纯函数，故 `ui/src/locale-resolver.mjs`（零依赖）+ `locale-resolver.d.mts`（tsc bundler 解析按同名 .d.mts 配对）+ i18n.ts re-export。spec 60 用 `await import("../../src/locale-resolver.mjs")`（CJS 里动态 import，全 Node 版本可用）。

## 二、墨水屏主题（eink 族）

### 设计

- **族身份在亮面**（沿水墨族先例）：纸白 × 近黑墨字——e-ink 是反射屏，暗色底要整体反相显示（慢刷+残影+费电），纸面墨字才是原生形态；暗面转「夜墨」（暖夜墨底×纸字，accent 即纸色）。
- **低饱和语义色**（墨分五色）：语义色深墨低饱和——灰阶面板以明度分层、彩屏（Kaleido）保色相可辨；accent 取近黑（填充钮=墨面纸字反白）。
- **终端 ANSI**：ansi-gen FAMILY `eink: { dH: {}, cM: 0.42, cBase: 0.11 }`——色相零旋转（终端 8 色语义原样直给）、全线极低饱和；生成器双门（对比 4.5 / 色相距 25°）32 态全过。
- **eink 专项 CSS**（真正的 e-ink 差异在此，光有配色不够）：

  ```css
  :root[data-theme="eink"] *, ::before, ::after {
    box-shadow: none !important;  /* 阴影=抖动灰雾 */
    text-shadow: none !important;
    transition: none !important;  /* 过渡=连续局部刷新 */
    animation: none !important;   /* 动画=反复闪刷+残影堆积 */
  }
  ```

  层次改由加浓实线边框表达（--border 0.26/0.44，常规族约 0.10/0.20）；焦点环走 outline 不受影响；全库 box-shadow 47 处一次铲平，不用逐点改。
- 16 族芯片（设置 → 外观 → 主题）自动出现墨水屏， Appearance 深浅双面即插即用；终端主题由 deriveTerminalTheme 从 `--ansi-0..15`/`--bg`/`--text` 派生，零改动。

### 校验器三连（两处初稿不过，当场修）

| 校验器 | 门 | 结果 |
|---|---|---|
| ansi-gen.mjs | 对比 4.5 + 色相距 25° 双门 | 首跑即过，--write 回写 32 块 |
| wcag-themes.mjs | 42 档对比度 | ①首跑 ansi8/bg 4.37——**不是真失败**：eink 块还没跑生成器，读的是继承的 graphite ANSI；②eink/dark danger@danger-soft 4.15<4.5——danger #c07a68 提亮到 #cf8a78 后过 |
| semantic-hues.mjs | 语义色相距 ≥15° | 过（eink 未进全局最紧榜） |

态数断言 30→32（ansi-gen + wcag-themes 两处，注释同步主题⑥轮 15→16 族）。

## 三、验证

- 三校验器：✓ 32 态 × 16 slot 双门 / ✓ 32 态 × 42 档 / ✓ 语义色相距
- tsc 0 错；vite build ✓ 29.43s
- 定向 spec：09=48/48（+5：芯片存在/点击翻 eink/阴影铲平探针/过渡归零探针/还原 tokyo）、60=25/25（+9：解算真值表）、23=14/14、62=10/10
- **全套 928/928（+14 断言）**——中间过程有两次 57-proxyjump `.hk-dialog` detached 超时（919/920），单跑 13/13 绿，纯净环境下全套复跑全过：负载 flake（坑 66 同族，上轮同款）；另有一次 01-shell「browser has been closed」是**套前 taskkill msedge 误伤 harness 自己启动的浏览器**（harness 也跑 msedge——杀残留进程别在套前做，套后清）
- README 双语：语言行改 OS 默认口径 + 新增主题色板行（含墨水屏）；计数行 909→928

## 四、断言用错的教训（小）

spec 09 首跑两条失败是**我断言拿错属性**：`themeAttr` 读的是 `dataset.chrome`（外观深浅）不是 `dataset.theme`（色板族）——「点墨水屏后 data-theme=eink」的比较对象一直是 chrome 值。补 `paletteAttr` 助手后全绿。写断言先看助手读的是什么。

## 五、不做/立案

- 显式「跟随系统」下拉选项（三态 locale）：本轮语义=「KV 无值即跟随」，用户钉住后想回到跟随系统只能清 KV——如有人提需求再立三态案。
- demo 域跟 OS：不做（测试基座确定性优先，理由见上）。
- e-ink 更深优化（每帧全刷/配 dithering 模式/字体加粗档）：等真机反馈再立案。
