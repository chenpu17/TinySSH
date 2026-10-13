// WCAG 色板全量校验（2026-10-11 主题色板批次）：解析 src/styles.css 的 :root /
// [data-chrome=light] / [data-theme]×[data-chrome] 变量块，按继承链合成 10 个
// 「色板×深浅」态，对全部文本档跑对比度断言。判据沿用 R40/R41 口径：
// 正文/语义文本 ≥4.5:1（AA），装饰 dim/focus ≥3:1。
// 用法：node test/wcag-themes.mjs   （退出码非 0 = 有不达标档）
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, ""); // 去注释，防注释文本混进选择器

// ---- 提取顶层块（本文件无嵌套花括号的 :root 块；@media 内层也会被匹配但按前缀过滤掉）----
const blocks = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(css))) {
  const sel = m[1].replace(/\s+/g, " ").trim();
  if (!sel.startsWith(":root")) continue;
  const vars = {};
  for (const line of m[2].split(";")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  blocks.push({ sel, vars });
}

const themeRe = /^:root\[data-theme="([a-z]+)"]\[data-chrome="(dark|light)"]$/;
const rootBlock = blocks.find((b) => b.sel === ":root");
const lightBlock = blocks.find((b) => b.sel === ':root[data-chrome="light"]');
const themeBlocks = blocks.filter((b) => themeRe.test(b.sel));
// 二十一轮：色板 5→9 族（每族深浅两态=16 块），加 graphite 双态共 18 态
const EXPECTED_THEMES = 16;
if (!rootBlock || !lightBlock || themeBlocks.length !== EXPECTED_THEMES) {
  console.error(`解析失败：root=${!!rootBlock} light=${!!lightBlock} theme块=${themeBlocks.length}/${EXPECTED_THEMES}`);
  process.exit(2);
}

// ---- 色值工具 ----
function parseColor(s) {
  s = s.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const p = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [0, 1, 2].map((i) => parseInt(p.slice(i * 2, i * 2 + 2), 16) / 255).concat([1]);
  }
  const rgba = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(",").map((x) => parseFloat(x));
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] : 1];
  }
  return null;
}
// color-mix(in srgb, var(--x) N%, transparent) → { base, alpha }
const mixRe = /^color-mix\(in srgb, var\((--[a-z-]+)\) (\d+)%, transparent\)$/;
function resolveColor(vars, name, depth = 0) {
  if (depth > 4) return null;
  let v = vars[name];
  if (v === undefined) return null;
  const ref = v.match(/^var\((--[a-z-]+)\)$/);
  if (ref) return resolveColor(vars, ref[1], depth + 1);
  const mix = v.match(mixRe);
  if (mix) return { mixBase: mix[1], alpha: Number(mix[2]) / 100 };
  const c = parseColor(v);
  return c ? { c } : null;
}
// 实色合成：fg（可带 alpha/color-mix）叠到 bg 实色上
function over(vars, fgName, bgColor) {
  const r = resolveColor(vars, fgName);
  if (!r) return null;
  if (r.mixBase) {
    const base = resolveColor(vars, r.mixBase);
    if (!base?.c) return null;
    return base.c.map((ch, i) => (i < 3 ? ch * r.alpha + bgColor[i] * (1 - r.alpha) : 1));
  }
  return r.c.map((ch, i) => (i < 3 ? ch * r.c[3] + bgColor[i] * (1 - r.c[3]) : 1));
}
function lum(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---- 合成 10 个态并断言 ----
const states = [["graphite", "dark", rootBlock], ["graphite", "light", lightBlock]];
for (const b of themeBlocks) {
  const [, id, chrome] = b.sel.match(themeRe);
  states.push([id, chrome, b]);
}
const rows = [];
let fail = 0;
for (const [theme, chrome, block] of states) {
  const vars = { ...rootBlock.vars, ...(chrome === "light" ? lightBlock.vars : {}), ...block.vars };
  const solid = (n) => resolveColor(vars, n)?.c ?? null;
  const label = `${theme}/${chrome}`;
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
    ["on-accent/accent", solid("--on-accent"), solid("--accent"), 4.5],
    ["on-accent/grad-a", solid("--on-accent"), solid("--grad-a"), 4.5],
    ["on-accent/grad-b", solid("--on-accent"), solid("--grad-b"), 4.5],
    ["on-danger/danger", solid("--on-danger"), solid("--danger"), 4.5],
    ["on-warn/warn", solid("--on-warn"), solid("--warn"), 4.5],
    ["on-accent/hover底", solid("--on-accent"), solid("--accent-hover"), 4.5],
    ["on-danger/hover底", solid("--on-danger"), solid("--danger-hover"), 4.5],
    ["on-warn/hover底", solid("--on-warn"), solid("--warn-hover"), 4.5],
    ["focus/bg(非文本)", solid("--focus"), bg, 3],
  ];
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
console.log(fail === 0 ? `\n✓ ${states.length} 态 × 23 档全部达标` : `\n✗ ${fail} 项不达标`);
process.exit(fail === 0 ? 0 : 1);
