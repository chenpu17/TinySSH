// 语义撞色检测（主题①轮）：对 18 态的语义四色 {accent, danger, ok, warn} 两两算
// OKLCH 色相环最短距离。WCAG 对比度只管亮暗差，不管色相差——同一底上两个 4.5:1
// 达标但色相只差 5° 的橙/金，普通用户分不开（暖烬暗 a↔dg 13°、鎏金暗 a↔wr 5° 实测）。
// 判据：任一对 < 15° 判不达标；任一方 chroma < 0.03（近无彩，曜石银 accent）跳过——
// 无彩色没有可辨色相，与任何色相都不构成撞色。--blue 为装饰档不计门。
// 用法：node test/semantic-hues.mjs   （退出码非 0 = 有撞色档）
import { readFileSync } from "node:fs";
import { loadThemeCss, resolveColor, oklch, hueDist } from "./theme-vars.mjs";

const MIN_GAP = 15;
const ACHROMATIC_C = 0.03;

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const { states } = loadThemeCss(css);

const SEMANTIC = ["accent", "danger", "ok", "warn"];
const NAME = { accent: "a", danger: "dg", ok: "ok", warn: "wr" };
let fail = 0;
const worstOverall = [];

for (const { theme, chrome, vars } of states) {
  const label = `${theme}/${chrome}`;
  const cols = {};
  for (const n of SEMANTIC) {
    const r = resolveColor(vars, `--${n}`);
    if (!r?.c) { console.error(`✗ ${label} --${n}: 色值缺失`); fail++; continue; }
    cols[n] = oklch(r.c);
  }
  const gaps = [];
  for (let i = 0; i < SEMANTIC.length; i++) {
    for (let j = i + 1; j < SEMANTIC.length; j++) {
      const x = SEMANTIC[i], y = SEMANTIC[j];
      const a = cols[x], b = cols[y];
      if (!a || !b) continue;
      if (a.C < ACHROMATIC_C || b.C < ACHROMATIC_C) continue; // 近无彩跳过
      const d = hueDist(a.H, b.H);
      gaps.push({ pair: `${NAME[x]}↔${NAME[y]}`, d });
    }
  }
  gaps.sort((p, q) => p.d - q.d);
  worstOverall.push(...gaps.slice(0, 1).map((g) => ({ label, ...g })));
  const bad = gaps.filter((g) => g.d < MIN_GAP);
  for (const g of bad) { console.error(`✗ ${label}  ${g.pair}  ${g.d.toFixed(1)}° < ${MIN_GAP}°`); fail++; }
  console.log(`${label.padEnd(16)} 最紧3对：${gaps.slice(0, 3).map((g) => `${g.pair} ${g.d.toFixed(0)}°`).join(" · ")}`);
}

worstOverall.sort((a, b) => a.d - b.d);
console.log(`\n全局最紧5档：${worstOverall.slice(0, 5).map((w) => `${w.label} ${w.pair} ${w.d.toFixed(1)}°`).join(" · ")}`);
console.log(fail === 0 ? `✓ ${states.length} 态语义色相间距全部 ≥ ${MIN_GAP}°` : `✗ ${fail} 项撞色（门限 ${MIN_GAP}°）`);
process.exit(fail === 0 ? 0 : 1);
