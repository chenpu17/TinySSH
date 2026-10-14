// 主题变量公共解析库（wcag-themes / semantic-hues 共用，防两套解析漂移）：
// 解析 src/styles.css 的 :root / [data-chrome=light] / [data-theme]×[data-chrome]
// 变量块，按继承链合成「色板×深浅」态；附 sRGB/OKLCH 色值工具。
export function loadThemeCss(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, ""); // 去注释，防注释文本混进选择器

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
  if (!rootBlock || !lightBlock) throw new Error("解析失败：root 或 light 基准块缺失");
  // graphite 双态走 :root / [data-chrome=light]；其余每板深浅两态显式双条件
  const states = [{ theme: "graphite", chrome: "dark", vars: { ...rootBlock.vars } },
                  { theme: "graphite", chrome: "light", vars: { ...rootBlock.vars, ...lightBlock.vars } }];
  for (const b of themeBlocks) {
    const [, id, chrome] = b.sel.match(themeRe);
    states.push({ theme: id, chrome, vars: { ...rootBlock.vars, ...(chrome === "light" ? lightBlock.vars : {}), ...b.vars } });
  }
  return { states, themeCount: themeBlocks.length };
}

// ---- 色值工具 ----
export function parseColor(s) {
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
export function resolveColor(vars, name, depth = 0) {
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
export function over(vars, fgName, bgColor) {
  const r = resolveColor(vars, fgName);
  if (!r) return null;
  if (r.mixBase) {
    const base = resolveColor(vars, r.mixBase);
    if (!base?.c) return null;
    return base.c.map((ch, i) => (i < 3 ? ch * r.alpha + bgColor[i] * (1 - r.alpha) : 1));
  }
  return r.c.map((ch, i) => (i < 3 ? ch * r.c[3] + bgColor[i] * (1 - r.c[3]) : 1));
}
export function lum(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---- OKLCH（Björn Ottosson 官方矩阵）——语义撞色检测用 ----
export function oklch(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const C = Math.sqrt(a * a + b2 * b2);
  let H = (Math.atan2(b2, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}
// 色相环最短距离（0–180）
export function hueDist(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}
