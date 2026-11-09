// WCAG 色板全量校验（2026-10-11 主题色板批次）：解析 src/styles.css 的 :root /
// [data-chrome=light] / [data-theme]×[data-chrome] 变量块，按继承链合成各族×深浅
// 的全部态（主题③轮起 11 族共 22 态），对全部文本档跑对比度断言。判据沿用 R40/R41 口径：
// 正文/语义文本 ≥4.5:1（AA），装饰 ≥3:1；主题④轮起 --accent-fill 填充档独立成门
// （on-accent 对 fill 系 ≥4.5，fill 对 bg ≥3 非文本）。
// 主题①轮起解析与色值工具走 theme-vars.mjs 公共库（与 semantic-hues 同一套，
// 防两套解析漂移）。主题②轮起增审终端 ANSI 16 色（对终端底 --bg）：12 个彩档
// 是终端正文 ≥4.5:1；「墨色」中性档（暗底 white/brightWhite、亮底 black/
// brightBlack）同为正文 ≥4.5:1；表征档（暗底 black/brightBlack、亮底 white/
// brightWhite）豁免——它们代表「黑/白」本身（Solarized 同理，天生低对比）。
// 2026-11 可达性轮：文本档矩阵扩到「9 档 × bg/panel/panel2/panel3」——--dim
// 也是要读的字（辅助档）按 4.5 判，不再只按装饰 3 放行；新增输入描边
// （--control-border，非文本 3:1）与自主横幅软底（--warn-bg 上 warn/warn-text
// ≥4.5）两门；并静态检查 `var(--x, #…)` 的 --x 必须真有定义（防横幅深棕兜底
// 这类「token 没定义、靠 fallback 蒙混」的浅色事故）。
// 用法：node test/wcag-themes.mjs   （退出码非 0 = 有不达标档）
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadThemeCss, resolveColor, over, contrast } from "./theme-vars.mjs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const { states } = loadThemeCss(css);
// 二十一轮：色板 5→9 族；主题③轮：9→11 族（+霓虹/水墨）；主题⑤轮：11→15 族
// （+诺德/复古/东京夜/摩卡）；主题⑥轮：15→16 族（+墨水屏），加 graphite 双态共 32 态
if (states.length !== 32) {
  console.error(`解析失败：态数 ${states.length}/32`);
  process.exit(2);
}

// 文本档：这些 token 都会落到界面上当字读（--dim 是 10–11px 辅助文字，
// 与 --text-sub 同判据；旧口径把它当装饰只判 3:1，是浅色主题长期漏网的低对比来源）
const TEXT_TIERS = ["--text", "--text-sub", "--dim", "--accent", "--accent-text", "--danger", "--ok", "--warn", "--warn-text"];

const rows = [];
let fail = 0;
for (const { theme, chrome, vars } of states) {
  const label = `${theme}/${chrome}`;
  const solid = (n) => resolveColor(vars, n)?.c ?? null;
  // [说明, 前景(实色), 背景实色, 下限]；软底档把 color-mix 前景叠到宿主面上再比
  const panel2 = solid("--panel2"), panel = solid("--panel"), bg = solid("--bg"), panel3 = solid("--panel3");
  const surfaces = [["bg", bg], ["panel", panel], ["panel2", panel2], ["panel3", panel3]];
  const checks = [
    ["text/bg", solid("--text"), bg, 4.5],
    ["text/panel", solid("--text"), panel, 4.5],
    ["text/panel2", solid("--text"), panel2, 4.5],
    ["text-sub/panel", solid("--text-sub"), panel, 4.5],
    ["text-sub/panel2", solid("--text-sub"), panel2, 4.5],
    ["dim/bg(装饰)", solid("--dim"), bg, 3],
    ["dim/panel2(装饰)", solid("--dim"), panel2, 3],
    ["accent/bg", solid("--accent"), bg, 4.5],
    ["accent/panel2", solid("--accent"), panel2, 4.5],
    ["accent-text/panel3", solid("--accent-text"), panel3, 4.5],
    ["warn-text/panel", solid("--warn-text"), panel, 4.5],
    ["ok/panel2", solid("--ok"), panel2, 4.5],
    ["danger/panel2", solid("--danger"), panel2, 4.5],
    ["warn/panel2", solid("--warn"), panel2, 4.5],
    ["ok@ok-soft⧉panel2", solid("--ok"), over(vars, "--ok-soft", panel2), 4.5],
    ["danger@danger-soft⧉panel2", solid("--danger"), over(vars, "--danger-soft", panel2), 4.5],
    ["warn@warn-soft⧉panel2", solid("--warn"), over(vars, "--warn-soft", panel2), 4.5],
    ["on-accent/grad-a", solid("--on-accent"), solid("--grad-a"), 4.5],
    ["on-accent/grad-b", solid("--on-accent"), solid("--grad-b"), 4.5],
    ["on-danger/danger", solid("--on-danger"), solid("--danger"), 4.5],
    ["on-warn/warn", solid("--on-warn"), solid("--warn"), 4.5],
    // 主题④轮拆档注：on-accent/accent 与 on-accent/hover底 两门随填充面迁移退役——
    // accent 不再充当按钮底（fill 系接管），on-accent 的配对门见下方 fill 四门；
    // fill 别名 var(--accent) 的态数值等价，覆盖不缩水
    // 主题④轮拆档：填充档（按钮底/指示件）独立成门——on-accent 对 fill 系 ≥4.5，
    // fill 对 bg ≥3（非文本 UI 组件判据）；默认别名 var(--accent) 的态由解析器透传
    ["on-accent/fill", solid("--on-accent"), solid("--accent-fill"), 4.5],
    ["on-accent/fill-hover", solid("--on-accent"), solid("--accent-fill-hover"), 4.5],
    ["fill/bg(非文本)", solid("--accent-fill"), bg, 3],
    ["fill-hover/bg(非文本)", solid("--accent-fill-hover"), bg, 3],
    ["on-danger/hover底", solid("--on-danger"), solid("--danger-hover"), 4.5],
    ["on-warn/hover底", solid("--on-warn"), solid("--warn-hover"), 4.5],
    ["focus/bg(非文本)", solid("--focus"), bg, 3],
  ];
  // 新矩阵：全部文本档 × 四个面。深色系最紧面是 panel3（最亮），浅色系是 panel3
  // （最暗）——同一档过 panel3 即四个面全过，但逐面列出便于定位
  for (const tier of TEXT_TIERS) {
    for (const [sname, sv] of surfaces) checks.push([`${tier}/${sname}`, solid(tier), sv, 4.5]);
  }
  // 输入控件常态描边：以 --bg 井底为实际叠底（border 画在元素背景之上），
  // 对四个相邻面都须 ≥3:1（非文本 UI 组件判据）
  const controlBorder = over(vars, "--control-border", bg);
  for (const [sname, sv] of surfaces) checks.push([`control-border/${sname}(非文本)`, controlBorder, sv, 3]);
  // 自主模式横幅：warn 混 panel2 的软底上，主文案与说明行都要读得清
  const warnBg = over(vars, "--warn-bg", panel2);
  checks.push(["warn@warn-bg", solid("--warn"), warnBg, 4.5]);
  checks.push(["warn-text@warn-bg", solid("--warn-text"), warnBg, 4.5]);

  // 主题②轮：终端 ANSI 16 档（值由 ansi-gen.mjs 生成并自验，这里独立复核——
  // 生成器与审计互为对方的外部校验，防一手写一手验的闭环漂移）
  const ansi = (i) => solid(`--ansi-${i}`);
  if (ansi(1) === null) {
    console.error(`✗ ${label} --ansi-*: 色值缺失`);
    fail++;
  } else {
    const inkNeutral = chrome === "dark" ? [7, 15] : [0, 8]; // 该底上当正文用的中性档
    for (let i = 0; i < 16; i++) {
      const isNeutral = [0, 7, 8, 15].includes(i);
      const min = isNeutral ? (inkNeutral.includes(i) ? 4.5 : null) : 4.5;
      if (min) checks.push([`ansi${i}/bg`, ansi(i), bg, min]);
    }
  }
  // 终端选区（本轮 B）：xterm 的 selectionForeground 会覆盖选中单元格前景，故对
  // 「激活/失焦」两种选区底都须 ≥4.5:1；失焦底另须与激活底在 RGB 上可区分——否则
  // 用户看不出选区已失焦（旧实现浅色主题两态几乎同色）。
  const selFg = over(vars, "--term-sel-fg", bg);
  const selBg = over(vars, "--term-sel-bg", bg);
  const selInactive = over(vars, "--term-sel-inactive", bg);
  checks.push(["term-sel-fg@term-sel-bg", selFg, selBg, 4.5]);
  checks.push(["term-sel-fg@term-sel-inactive", selFg, selInactive, 4.5]);
  if (selBg && selInactive) {
    const d = Math.abs(selBg[0] - selInactive[0]) + Math.abs(selBg[1] - selInactive[1])
      + Math.abs(selBg[2] - selInactive[2]);
    if (d < 0.06) { console.error(`✗ ${label} term-sel 激活/失焦底不可区分 Δ=${d.toFixed(3)}`); fail++; }
  }

  const worst = [];
  for (const [name, fg, bgc, min] of checks) {
    if (!fg || !bgc) { console.error(`✗ ${label} ${name}: 色值缺失`); fail++; continue; }
    const c = contrast(fg, bgc);
    rows.push({ label, name: name.split("(")[0], c });
    if (c < min) { console.error(`✗ ${label}  ${name}  ${c.toFixed(2)}:1 < ${min}`); fail++; }
    worst.push({ name: name.split("(")[0].split("@")[0], c });
  }
  worst.sort((a, b) => a.c - b.c);
  console.log(`${label.padEnd(16)} 最紧5档：${worst.slice(0, 5).map((w) => `${w.name} ${w.c.toFixed(2)}`).join(" · ")}`);
}

// ---- 静态检查：带兜底色值的 var(--x, #…) 必须有 --x 定义 ----
// 背景：自主横幅曾用 var(--warn-bg, #4a3208)——token 从未定义，深色下靠兜底遮羞，
// 浅色下直接是突兀黑块。只查「带颜色兜底」的引用；数值兜底（--split-frac, 0.5）
// 允许由 TSX 内联 style 动态设置，不在本门范围。
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const defined = new Set([...noComments.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const fallbackRe = /var\((--[a-z0-9-]+)\s*,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\()/g;
let fallbackRefs = 0;
const checkFallbacks = (where, text) => {
  for (const m of text.matchAll(fallbackRe)) {
    fallbackRefs++;
    if (!defined.has(m[1])) {
      console.error(`✗ ${where}  var(${m[1]}, …) 的 ${m[1]} 未定义`);
      fail++;
    }
  }
};
checkFallbacks("styles.css", noComments);
const srcDir = fileURLToPath(new URL("../src", import.meta.url));
for (const rel of readdirSync(srcDir, { recursive: true })) {
  if (!/\.(tsx?|jsx?)$/.test(rel)) continue;
  checkFallbacks(`src/${rel}`, readFileSync(`${srcDir}/${rel}`, "utf8"));
}
console.log(`静态检查：${fallbackRefs} 处带颜色兜底的 var()，${defined.size} 个 token 定义`);

console.log(fail === 0 ? `\n✓ ${states.length} 态 × ${rows.length / states.length} 档全部达标` : `\n✗ ${fail} 项不达标`);
process.exit(fail === 0 ? 0 : 1);
