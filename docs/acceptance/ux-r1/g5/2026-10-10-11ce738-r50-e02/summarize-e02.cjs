// R50 / E02 —— 汇总器：把 `e02-raw.json` 归纳成 `e02-summary.json` + `e02-measurements.csv`。
//
// 为什么要单独一个脚本：README 里每个数字都必须**可被审核者独立重算**。把「哪一行进哪个桶、
// 怎么分组、怎么判不合格」写死在脚本里，审核者跑一遍即可复现，不必相信我口述的口径。
//
// 判据：正文 4.5:1、大字 3.0:1（WCAG AA，取项目既有口径，见 README §1）。
// 大字定义：fontSize ≥ 24px，或 ≥ 18.66px 且 fontWeight ≥ 700。本数据集里只有
// `.welcome-title`（19px / w700，两外观各 1 节点）落进大字档，二者均合格
// （深色 13.68 / 浅色 11.83）——`largeEverExercised` 字段如实记录该支是否被行使。

const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;
const raw = JSON.parse(fs.readFileSync(path.join(DIR, "e02-raw.json"), "utf8"));

const APPS = ["深色", "浅色"];
const THRESH = { normal: 4.5, large: 3.0 };

/** 收集所有桶 → 统一的行数组。每行带 外观/桶/来源键 三个定位字段。 */
function collect() {
  const rows = [];
  const push = (ap, bucket, arr) => {
    for (const r of arr || []) rows.push({ appearance: ap, bucket, ...r, text: r.text != null ? r.text : r.ph });
  };
  for (const ap of APPS) {
    const c = raw.chrome[ap] || {};
    push(ap, "welcome", c.emptyState);       // 空态/欢迎页（连接任何主机之前）
    push(ap, "page", c.page);                // 默认页（已连一个主机）
    push(ap, "ph-page", c.placeholderPage);  // 默认页的 placeholder（属性文本，非文本节点）
    push(ap, "hover", c.hoverHostbar);       // 主机卡悬停（连接钮显形）
    push(ap, "settings", c.settingsDialog);  // 设置弹窗
    push(ap, "ph-settings", c.placeholderSettings); // 设置弹窗的 placeholder
    push(ap, "addhost", c.addHostText);      // 添加主机表单（文本）
    push(ap, "ph-addhost", c.addHostPlaceholder); // 添加主机表单的 placeholder
    const e = raw.errorState[ap] || {};
    push(ap, "hostkey", e.hostkeyDialog);    // 首次连接指纹确认弹窗
    push(ap, "banner", e.errorBanner);       // 连接失败横幅
    push(ap, "afterAll", e.afterAll);        // 收尾整页复扫（用于自证无漏报）
  }
  return rows;
}

const rows = collect();
for (const r of rows) {
  r.threshold = r.large ? THRESH.large : THRESH.normal;
  r.pass = typeof r.ratio === "number" ? r.ratio >= r.threshold : null;
}

// ── 分组：同一 (外观, 桶, 选择器, 前景, 底色, 字号) 归为一组 ──
const groups = new Map();
for (const r of rows) {
  const key = [r.appearance, r.bucket, r.sel, r.fg, r.bg, r.fontSize].join("|");
  if (!groups.has(key)) {
    groups.set(key, { appearance: r.appearance, bucket: r.bucket, sel: r.sel, fg: r.fg, bg: r.bg,
      fontSize: r.fontSize, fontWeight: r.fontWeight, large: r.large, threshold: r.threshold,
      count: 0, ratio: r.ratio, samples: [] });
  }
  const g = groups.get(key);
  g.count += 1;
  if (typeof r.ratio === "number" && r.ratio < g.ratio) g.ratio = r.ratio;   // 组内取**最差**
  if (g.samples.length < 3 && r.text) g.samples.push(r.text.slice(0, 24));
}
const allGroups = [...groups.values()];
const failures = allGroups.filter((g) => g.ratio < g.threshold)
  .sort((a, b) => a.ratio - b.ratio);

// ── 桶级统计 ──
const buckets = [];
for (const ap of APPS) for (const bucket of ["welcome", "page", "ph-page", "hover", "settings", "ph-settings", "addhost", "ph-addhost", "hostkey", "banner", "afterAll"]) {
  const inB = rows.filter((r) => r.appearance === ap && r.bucket === bucket);
  if (!inB.length) continue;
  const f = failures.filter((g) => g.appearance === ap && g.bucket === bucket);
  buckets.push({ appearance: ap, bucket, nodes: inB.length, groups: new Set(inB.map((r) => r.sel)).size,
    failGroups: f.length, failNodes: inB.filter((r) => r.pass === false).length,
    minRatio: inB.reduce((m, r) => (typeof r.ratio === "number" && r.ratio < m ? r.ratio : m), Infinity) });
}
for (const b of buckets) if (!isFinite(b.minRatio)) b.minRatio = null;

const summary = {
  generatedFrom: "e02-raw.json",
  run: raw.run || null,
  headSha: raw.headSha,
  thresholds: THRESH,
  largeEverExercised: rows.some((r) => r.large === true),
  totals: {
    textNodes: rows.length,
    byAppearance: Object.fromEntries(APPS.map((ap) => [ap, rows.filter((r) => r.appearance === ap).length])),
    failGroups: failures.length,
    failNodes: rows.filter((r) => r.pass === false).length,
    minRatio: rows.reduce((m, r) => (typeof r.ratio === "number" && r.ratio < m ? r.ratio : m), Infinity),
  },
  buckets, failures, allGroups,
};
summary.totals.minRatio = isFinite(summary.totals.minRatio) ? summary.totals.minRatio : null;

fs.writeFileSync(path.join(DIR, "e02-summary.json"), JSON.stringify(summary, null, 1));

// ── CSV：逐节点读数（含 afterAll，保证「共测 N」与 CSV 行数一致）──
const head = "appearance,bucket,sel,text,fg,bg,ratio,threshold,large,fontSize,fontWeight,alpha,pass";
const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = [head, ...rows.map((r) => [r.appearance, r.bucket, r.sel, r.text, r.fg, r.bg, r.ratio,
  r.threshold, r.large, r.fontSize, r.fontWeight, r.alpha, r.pass].map(esc).join(","))].join("\n") + "\n";
fs.writeFileSync(path.join(DIR, "e02-measurements.csv"), csv);

console.log(JSON.stringify({ textNodes: summary.totals.textNodes, failGroups: failures.length,
  failNodes: summary.totals.failNodes, minRatio: summary.totals.minRatio,
  buckets: buckets.map((b) => `${b.appearance}/${b.bucket}=${b.nodes}`) }, null, 1));
