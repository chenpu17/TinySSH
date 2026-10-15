// ANSI 16 色按族生成器（主题②轮）。styles.css 各族块写入 --ansi-0..15（终端派生
// 读取，见 App.tsx deriveTerminalTheme），本工具生成这些值并**内建同口径双门自验**：
//   ①对比度门（wcag-themes 同口径）：12 个彩 slot 对终端底 --bg ≥4.5:1（终端彩字
//     是正文）；「墨色」中性档（暗底=white/brightWhite，亮底=black/brightBlack）
//     同为正文 ≥4.5:1；表征档（暗底 black/brightBlack、亮底 white/brightWhite）
//     豁免——它们代表「黑/白」本身（暗底纯黑、亮底纯白天生低对比，Solarized 同理）。
//   ②色相分离门（semantic-hues 同口径）：红绿黄蓝品青 6 族（normal/bright 各一
//     组）两两 OKLCH 色相距 ≥25°，C<0.03 近无彩跳过。
// 家族性格靠色相微旋（dH）与饱和度乘数（cM）表达，不做大角度改相——终端 8 色
// 的语义（ls/vim/grep 的颜色约定）必须保住。用法：
//   node test/ansi-gen.mjs          # 校验 + 预览（不写文件）
//   node test/ansi-gen.mjs --write  # 校验通过后回写 styles.css（幂等，可重跑）
import { readFileSync, writeFileSync } from "node:fs";
import { loadThemeCss, resolveColor, parseColor, contrast, oklch, hueDist } from "./theme-vars.mjs";

const WRITE = process.argv.includes("--write");
const CSS_PATH = new URL("../src/styles.css", import.meta.url);

// ---- OKLCH → sRGB（Björn Ottosson 官方逆矩阵；出域时收敛 C 到域内）----
function oklchToLinear(L, C, H) {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad), b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const EPS = 0.0005;
function inGamut(lin) { return lin.every((v) => v >= -EPS && v <= 1 + EPS); }
function oklchToRgb(L, C, H) {
  let c = C;
  let lin = oklchToLinear(L, c, H);
  while (!inGamut(lin) && c > 0.0005) { c *= 0.97; lin = oklchToLinear(L, c, H); }
  const rgb = lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  });
  return { rgb, cFinal: c };
}
const hex = (rgb) => "#" + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

// ---- 定 L 解对比度：固定 C/H，二分到 contrast(bg) 恰过 target（从安全侧逼近）----
function solveL(bg, C, H, target, dir) {
  const bgL = oklch(bg).L;
  let lo, hi;
  if (dir === "up") { lo = bgL + 0.03; hi = 0.97; } else { lo = 0.03; hi = bgL - 0.03; }
  const ok = (L) => { const { rgb } = oklchToRgb(L, C, H); return contrast(rgb, bg) >= target; };
  // 必然达标的一侧：up=hi（越亮对比越高），down=lo（越暗对比越高）；该侧都不达标
  // 说明 C 出域或 target 过紧
  if (!(dir === "up" ? ok(hi) : ok(lo))) return null;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) { if (dir === "up") hi = mid; else lo = mid; }
    else { if (dir === "up") lo = mid; else hi = mid; }
  }
  // dir=up 取最小达标 L（hi），dir=down 取最大达标 L（lo）
  return dir === "up" ? hi : lo;
}
function solveColor(bg, C, H, target, dir) {
  const L = solveL(bg, C, H, target, dir);
  if (L == null) return null;
  const { rgb, cFinal } = oklchToRgb(L, C, H);
  return { hex: hex(rgb), c: rgb, oklch: oklch(rgb), cWanted: cFinal };
}

// ---- 彩 slot 定义与家族性格 ----
const CHROMATIC = [
  { key: "red", H: 25 }, { key: "green", H: 145 }, { key: "yellow", H: 95 },
  { key: "blue", H: 245 }, { key: "magenta", H: 315 }, { key: "cyan", H: 195 },
];
const C_BASE = 0.12;
const FAMILY = {
  graphite: {},
  // 暖烬：暖相微聚（绿→橄榄、品红→玫瑰），冷档降饱和让位陶土橙
  ember: { dH: { red: -5, green: -12, yellow: -5, blue: 5, magenta: 12, cyan: 5 }, cM: { red: 1.15, green: 0.88, yellow: 1.1, blue: 0.85, magenta: 0.95, cyan: 0.9 }, cBase: 0.13 },
  // 深海：蓝/青提饱和当家，红品向冷收
  ocean: { dH: { red: -8, green: 8, yellow: 0, blue: 5, magenta: -8, cyan: 0 }, cM: { red: 0.9, green: 1.0, yellow: 0.95, blue: 1.15, magenta: 1.0, cyan: 1.15 } },
  // 午夜：品红当家、蓝向紫靠（15°），红转玫瑰（-35°→350°）
  violet: { dH: { red: -35, green: 0, yellow: 0, blue: 15, magenta: 5, cyan: 0 }, cM: { red: 0.95, green: 0.9, yellow: 0.95, blue: 1.1, magenta: 1.2, cyan: 0.95 }, cBase: 0.125 },
  // 鎏金：琥珀黄当家（+饱和），绿→橄榄、蓝降饱和退位
  noir: { dH: { red: 5, green: -15, yellow: 5, blue: 5, magenta: 15, cyan: 0 }, cM: { red: 1.1, green: 0.8, yellow: 1.2, blue: 0.75, magenta: 0.9, cyan: 0.85 }, cBase: 0.13 },
  // 极光：绿/薄荷青当家（+饱和），蓝向电蓝收
  aurora: { dH: { red: 0, green: 5, yellow: 10, blue: -15, magenta: 5, cyan: -10 }, cM: { red: 0.95, green: 1.2, yellow: 1.0, blue: 0.95, magenta: 0.95, cyan: 1.1 } },
  // 青瓷：全线降饱和（釉面灰度），绿向玉青靠
  celadon: { dH: { red: 0, green: 15, yellow: 5, blue: -10, magenta: 10, cyan: -5 }, cM: 0.72 },
  // 绯樱：红转樱红（-15°→10°）、品红向玫瑰聚，其余轻收
  sakura: { dH: { red: -15, green: 5, yellow: -5, blue: 5, magenta: 15, cyan: 5 }, cM: { red: 1.05, green: 0.9, yellow: 0.95, blue: 0.9, magenta: 1.15, cyan: 0.9 } },
  // 曜石：近单色（0.38× 饱和度，残余微彩保持可辨但不出戏）
  obsidian: { dH: {}, cM: 0.38, cBase: 0.12 },
};
const famCfg = (id) => {
  const f = FAMILY[id] ?? {};
  return {
    dH: (k) => f.dH?.[k] ?? 0,
    cM: (k) => (typeof f.cM === "number" ? f.cM : f.cM?.[k] ?? 1),
    cBase: f.cBase ?? C_BASE,
  };
};

// ---- 逐态生成 ----
const css = readFileSync(CSS_PATH, "utf8");
const { states } = loadThemeCss(css);
if (states.length !== 18) { console.error(`态数 ${states.length}/18 不对`); process.exit(2); }

const out = new Map(); // stateKey → { lines, checks }
let fail = 0;

for (const { theme, chrome, vars } of states) {
  const label = `${theme}/${chrome}`;
  const bg = resolveColor(vars, "--bg")?.c;
  if (!bg) { console.error(`✗ ${label} --bg 缺失`); fail++; continue; }
  const dark = chrome === "dark";
  const dir = dark ? "up" : "down";
  const f = famCfg(theme);
  const bgO = oklch(bg);
  const slots = new Array(16);

  // 彩档：normal 目标 5.2、bright 目标 6.6（亮档再+15% 饱和——两 chrome 统一
  // 「bright=更强」而非「bright=更亮」，浅底亮档因此更浓更深，可读性优先）
  for (const { key, H } of CHROMATIC) {
    const hue = (H + f.dH(key) + 360) % 360;
    const normal = solveColor(bg, f.cBase * f.cM(key), hue, 5.2, dir);
    const bright = solveColor(bg, f.cBase * f.cM(key) * 1.15, hue, 6.6, dir);
    if (!normal || !bright) { console.error(`✗ ${label} ${key}: 解不出目标对比度`); fail++; continue; }
    const idx = CHROMATIC.findIndex((c) => c.key === key);
    slots[idx + 1] = normal;   // CHROMATIC 序 0..5 ↔ ANSI 槽 1..6
    slots[idx + 9] = bright;   // bright 同序 ↔ 槽 9..14
  }
  // 表征档（豁免门）：暗底 black/brightBlack = bg 微提亮；亮底 white/brightWhite = bg 微压暗
  const repL = (dL) => Math.min(0.985, Math.max(0.015, bgO.L + (dark ? dL : -dL)));
  if (dark) {
    slots[0] = { hex: hex(oklchToRgb(repL(0.075), Math.max(bgO.C * 0.5, 0.005), bgO.H).rgb) };
    slots[8] = { hex: hex(oklchToRgb(repL(0.21), 0.014, bgO.H).rgb) };
    slots[7] = solveColor(bg, 0.008, bgO.H, 5.5, "up") ?? slots[7];
    slots[15] = { hex: hex(oklchToRgb(0.965, 0.004, bgO.H).rgb) };
  } else {
    slots[7] = { hex: hex(oklchToRgb(repL(0.075), Math.max(bgO.C * 0.5, 0.005), bgO.H).rgb) };
    slots[15] = { hex: hex(oklchToRgb(0.99, 0.002, bgO.H).rgb) };
    slots[0] = solveColor(bg, 0.008, bgO.H, 5.5, "down") ?? slots[0];
    slots[8] = solveColor(bg, 0.016, bgO.H, 4.9, "down") ?? slots[8];
  }

  // ---- 门①对比度（12 彩 + 该底墨档，同 wcag 口径 4.5）----
  const ink = dark ? [7, 15] : [0, 8];
  for (let i = 0; i < 16; i++) {
    if (!slots[i]) continue;
    const isNeutral = [0, 7, 8, 15].includes(i);
    const need = isNeutral ? (ink.includes(i) ? 4.5 : 0) : 4.5;
    if (!need) continue;
    const c = contrast(parseColor(slots[i].hex), bg);
    if (c < need) { console.error(`✗ ${label} ansi${i} ${c.toFixed(2)}:1 < ${need}`); fail++; }
  }
  // ---- 门②色相分离（normal/bright 两组各 15 对，≥25°；C<0.03 跳过）----
  for (const off of [1, 9]) {
    const cols = CHROMATIC.map(({ key }, idx) => {
      const v = slots[idx + off];
      return v ? { name: key[0], ...oklch(parseColor(v.hex)) } : null;
    }).filter(Boolean);
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        if (cols[i].C < 0.03 || cols[j].C < 0.03) continue;
        const d = hueDist(cols[i].H, cols[j].H);
        if (d < 25) { console.error(`✗ ${label} ${cols[i].name}↔${cols[j].name}(bright=${!!off}) ${d.toFixed(1)}° < 25°`); fail++; }
      }
    }
  }

  const lines = [
    "",
    "  /* ANSI 16 按族（主题②轮）：ui/test/ansi-gen.mjs 生成——手改会被覆盖，重跑生成器 */",
    `  --ansi-0: ${slots[0]?.hex}; --ansi-1: ${slots[1]?.hex}; --ansi-2: ${slots[2]?.hex}; --ansi-3: ${slots[3]?.hex};`,
    `  --ansi-4: ${slots[4]?.hex}; --ansi-5: ${slots[5]?.hex}; --ansi-6: ${slots[6]?.hex}; --ansi-7: ${slots[7]?.hex};`,
    `  --ansi-8: ${slots[8]?.hex}; --ansi-9: ${slots[9]?.hex}; --ansi-10: ${slots[10]?.hex}; --ansi-11: ${slots[11]?.hex};`,
    `  --ansi-12: ${slots[12]?.hex}; --ansi-13: ${slots[13]?.hex}; --ansi-14: ${slots[14]?.hex}; --ansi-15: ${slots[15]?.hex};`,
  ];
  out.set(`${theme}|${chrome}`, { lines, slots });
}

if (fail > 0) { console.error(`\n✗ ${fail} 项未过门——不写文件`); process.exit(1); }
for (const [key, { slots }] of out) {
  const miss = slots.map((s, i) => (s?.hex ? null : i)).filter((v) => v !== null);
  if (miss.length) { console.error(`✗ ${key} 槽位缺失：${miss.join(",")}`); process.exit(1); }
}

// ---- 回写（幂等：先剥旧 --ansi 行与生成注释行，再按选择器插回）----
if (WRITE) {
  let cssText = readFileSync(CSS_PATH, "utf8");
  const eol = cssText.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, { lines }] of out) {
    const [theme, chrome] = key.split("|");
    const sel = theme === "graphite"
      ? (chrome === "dark" ? ":root {" : ':root[data-chrome="light"] {')
      : `:root[data-theme="${theme}"][data-chrome="${chrome}"] {`;
    const start = cssText.indexOf(sel);
    if (start < 0) { console.error(`✗ 找不到块：${sel}`); process.exit(1); }
    const end = cssText.indexOf("}", start);
    let body = cssText.slice(start, end);
    body = body.split(eol).filter((l) => !/^\s*--ansi-\d+:/.test(l) && !/^\s*\/\* ANSI 16 按族/.test(l)).join(eol);
    const insert = lines.join(eol);
    cssText = cssText.slice(0, start) + body + insert + cssText.slice(end);
  }
  writeFileSync(CSS_PATH, cssText);
  console.log(`✓ 已回写 ${out.size} 个块 → styles.css`);
} else {
  for (const [key, { lines }] of out) console.log(`\n# ${key}${lines.join("")}`);
}
console.log(`\n✓ 18 态 × 16 slot 全过双门（对比度 4.5 / 色相距 25°）`);
