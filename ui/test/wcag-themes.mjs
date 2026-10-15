// WCAG 色板全量校验（2026-10-11 主题色板批次）：解析 src/styles.css 的 :root /
// [data-chrome=light] / [data-theme]×[data-chrome] 变量块，按继承链合成各族×深浅
// 的全部态（主题③轮起 11 族共 22 态），对全部文本档跑对比度断言。判据沿用 R40/R41 口径：
// 正文/语义文本 ≥4.5:1（AA），装饰 dim/focus ≥3:1；主题④轮起 --accent-fill 填充档
// 独立成门（on-accent 对 fill 系 ≥4.5，fill 对 bg ≥3 非文本）。
// 主题①轮起解析与色值工具走 theme-vars.mjs 公共库（与 semantic-hues 同一套，
// 防两套解析漂移）。主题②轮起增审终端 ANSI 16 色（对终端底 --bg）：12 个彩档
// 是终端正文 ≥4.5:1；「墨色」中性档（暗底 white/brightWhite、亮底 black/
// brightBlack）同为正文 ≥4.5:1；表征档（暗底 black/brightBlack、亮底 white/
// brightWhite）豁免——它们代表「黑/白」本身（Solarized 同理，天生低对比）。
// 用法：node test/wcag-themes.mjs   （退出码非 0 = 有不达标档）
import { readFileSync } from "node:fs";
import { loadThemeCss, resolveColor, over, contrast } from "./theme-vars.mjs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const { states } = loadThemeCss(css);
// 二十一轮：色板 5→9 族；主题③轮：9→11 族（+霓虹/水墨），加 graphite 双态共 22 态
if (states.length !== 22) {
  console.error(`解析失败：态数 ${states.length}/22`);
  process.exit(2);
}

const rows = [];
let fail = 0;
for (const { theme, chrome, vars } of states) {
  const label = `${theme}/${chrome}`;
  const solid = (n) => resolveColor(vars, n)?.c ?? null;
  // [说明, 前景(实色), 背景实色, 下限]；软底档把 color-mix 前景叠到宿主面上再比
  const panel2 = solid("--panel2"), panel = solid("--panel"), bg = solid("--bg"), panel3 = solid("--panel3");
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
console.log(fail === 0 ? `\n✓ ${states.length} 态 × ${rows.length / states.length} 档全部达标` : `\n✗ ${fail} 项不达标`);
process.exit(fail === 0 ? 0 : 1);
