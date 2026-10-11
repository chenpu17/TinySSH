// 独立视觉复验（review）：几何实测 + computed style 断言 + 双主题/ember 截图。
// 只读仓库、只写截图到 .ux-shots/review/。跑法（ui/ 目录下）：
//   TINYSSH_UI_CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" node test/review-verify.cjs
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");
const fs = require("fs");

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const OUT = "D:/workspace/tiny-ssh/.ux-shots/review";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function rec(item, name, pass, detail) {
  results.push({ item, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${item}] ${name} :: ${detail}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// "#rrggbb"/"rgb(...)" → [r,g,b]（用于 box-shadow 颜色与 --accent 精确比对）
const toRgb = (s) => {
  s = s.trim();
  if (s.startsWith("#")) {
    const h = s.length === 4 ? [...s.slice(1)].map((c) => c + c).join("") : s.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  return m ? m[1].split(",").slice(0, 3).map((n) => parseFloat(n)) : null;
};

(async () => {
  const { path: executablePath, source } = resolveBrowser();
  console.log(`browser: ${source} ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE + "/?fresh", { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 15000 });
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.waitForTimeout(500);

  // 连接 demo 主机「本机」（local，UTF-8 默认编码）。
  // 实测：鼠标点卡片中心会落进 hover 才显现的 .host-card-side 操作组（首钮=收藏星标，
  // 207px 窄卡上盖住主行中点）——改走键盘激活（卡片 role=button 自带 "——Enter 连接"）
  await page.locator('.hostbar .host-card[aria-label^="主机 本机"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('.tab-active .tab-label:text-is("本机")', { timeout: 20000 });
  await page.waitForTimeout(900);

  const snap = () => page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      const f = (n) => Math.round(n * 100) / 100;
      return { x: f(b.x), y: f(b.y), w: f(b.width), h: f(b.height), top: f(b.top), bottom: f(b.bottom), left: f(b.left), right: f(b.right) };
    };
    const t = document.querySelector(".tab-active");
    const tb = document.querySelector(".session-toolbar");
    const row = document.querySelector(".tabbar-row");
    const st = document.querySelector(".statusbar");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const ct = cs(t), ctb = cs(tb), crow = cs(row);
    return {
      chrome: document.documentElement.dataset.chrome || "(default)",
      theme: document.documentElement.dataset.theme || "(default)",
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      tab: t ? {
        rect: r(t), label: t.querySelector(".tab-label")?.textContent ?? null,
        bg: ct.backgroundColor,
        radius: { tl: ct.borderTopLeftRadius, tr: ct.borderTopRightRadius, bl: ct.borderBottomLeftRadius, br: ct.borderBottomRightRadius },
        shadow: ct.boxShadow,
      } : null,
      toolbar: tb ? { rect: r(tb), bg: ctb.backgroundColor } : null,
      row: row ? { rect: r(row), bg: crow.backgroundColor, borderBottomWidth: crow.borderBottomWidth, borderBottomStyle: crow.borderBottomStyle } : null,
      ghosts: [...row.querySelectorAll(":scope > .ghost")].map((g) => ({ label: (g.getAttribute("aria-label") || g.textContent || "").trim().slice(0, 12), rect: r(g) })),
      scrolls: [...row.querySelectorAll(".tab-scroll")].map((g) => ({ rect: r(g) })),
      statusbarText: st ? st.innerText.replace(/\s+/g, " ").trim() : null,
      statusbarLeft: st?.querySelector(".sb-left")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      placeholder: document.querySelector(".panel-title input")?.placeholder ?? null,
    };
  });

  // ================= 第 1+2 项（深色） =================
  const d = await snap();
  console.log("SNAP dark:", JSON.stringify(d, null, 2));

  // --- 第 1 项：标签与工具栏一体化 ---
  if (!d.tab || !d.toolbar) {
    rec(1, "激活标签与工具栏存在", false, `tab-active=${!!d.tab} session-toolbar=${!!d.toolbar}`);
  } else {
    rec(1, "①背景色相同", d.tab.bg === d.toolbar.bg,
      `tab bg=${d.tab.bg} toolbar bg=${d.toolbar.bg}`);
    const gap = Math.round((d.toolbar.rect.top - d.tab.rect.bottom) * 100) / 100;
    rec(1, "②底缘相接 ≤1px", near(d.toolbar.rect.top, d.tab.rect.bottom, 1),
      `tab.bottom=${d.tab.rect.bottom} toolbar.top=${d.toolbar.rect.top} 差=${gap}px`);
    const rad = d.tab.radius;
    rec(1, "③上圆角/下直角", /[\d.]+px/.test(rad.tl) && parseFloat(rad.tl) > 0 && parseFloat(rad.tr) > 0 && parseFloat(rad.bl) === 0 && parseFloat(rad.br) === 0,
      `tl=${rad.tl} tr=${rad.tr} bl=${rad.bl} br=${rad.br}`);
    // Chromium 计算值把颜色序列化在最前：`rgb(..) 0px 2px 0px 0px inset`
    const sm = d.tab.shadow.match(/^(rgba?\([^)]*\)|#\w+)\s+0px 2px 0px 0px inset$/);
    const shadowAccent = sm ? toRgb(sm[1]) : null;
    const accentRgb = toRgb(d.accent);
    const sameColor = shadowAccent && accentRgb && shadowAccent.every((v, i) => v === accentRgb[i]);
    rec(1, "④2px 顶部 accent 内描边", !!(sm && sameColor),
      `box-shadow="${d.tab.shadow}" vs --accent=${d.accent} → ${sm ? (sameColor ? "同色 inset 0 2px" : `颜色不符 ${shadowAccent} ≠ ${accentRgb}`) : "不匹配 0px 2px … inset 形"} `);
  }

  // --- 第 2 项：标签条带 ---
  if (!d.row) {
    rec(2, "tabbar-row 存在", false, "未找到 .tabbar-row");
  } else {
    rec(2, "borderBottomWidth=0px", d.row.borderBottomWidth === "0px",
      `borderBottomWidth=${d.row.borderBottomWidth} style=${d.row.borderBottomStyle}`);
    rec(2, "行高 40px", near(d.row.rect.h, 40, 0.5), `height=${d.row.rect.h}`);
    const rowTop = d.row.rect.top;
    for (const g of d.ghosts) {
      const c = Math.round((g.rect.top + g.rect.bottom) / 2 * 100) / 100;
      rec(2, `行内 ghost「${g.label}」垂直居中(顶+20±2)`, near(c, rowTop + 20, 2),
        `center=${c} 期望≈${Math.round((rowTop + 20) * 100) / 100} rect=${JSON.stringify(g.rect)}`);
    }
    const tabBottomGap = Math.round((d.row.rect.bottom - d.tab.rect.bottom) * 100) / 100;
    rec(2, "激活标签底缘贴行底(≤1px)", near(d.row.rect.bottom, d.tab.rect.bottom, 1),
      `row.bottom=${d.row.rect.bottom} tab.bottom=${d.tab.rect.bottom} 差=${tabBottomGap}px`);
  }

  // --- .tab-scroll（溢出滚动钮，仅溢出时渲染）：窄视口强制出现后量垂直居中 ---
  let scrollMeasured = null;
  for (const w of [900, 720, 600, 500, 420, 380]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    const s = await snap();
    if (s.scrolls.length) {
      scrollMeasured = { width: w, snap: s };
      break;
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  if (scrollMeasured) {
    const s = scrollMeasured.snap;
    const c = Math.round((s.scrolls[0].rect.top + s.scrolls[0].rect.bottom) / 2 * 100) / 100;
    rec(2, `.tab-scroll 垂直居中(顶+20±2, 视口${scrollMeasured.width}px)`, near(c, s.row.rect.top + 20, 2),
      `center=${c} row.top=${s.row.rect.top} rowH=${s.row.rect.h}`);
  } else {
    rec(2, ".tab-scroll 垂直居中", false, "660/720/600/500/420/380px 均未出现滚动钮（无溢出），未能实测");
  }

  // --- 第 4 项：状态栏默认编码不上屏 ---
  rec(4, "statusbar 不含 UTF-8", d.statusbarText != null && !d.statusbarText.includes("UTF-8"),
    `innerText="${d.statusbarText}" sb-left="${d.statusbarLeft}"`);

  // --- 第 5 项：命令框提示已简化 ---
  const phOk = d.placeholder === "在 本机 上执行命令";
  rec(5, "placeholder=「在 本机 上执行命令」", phOk,
    `placeholder="${d.placeholder}"${d.placeholder && (d.placeholder.includes("回车执行") || d.placeholder.includes("Ctrl+C")) ? "（含违禁字样！）" : ""}`);

  // --- 深色标签条带裁切图（目验用） ---
  await page.screenshot({ path: `${OUT}/review-tabbar-dark.png`, clip: { x: 0, y: Math.max(0, d.row.rect.top - 6), width: 860, height: d.row.rect.h + d.toolbar.rect.h + 14 } });

  // ================= 第 3 项：浅色主题重复第 1 项 =================
  await page.evaluate(() => { document.documentElement.dataset.chrome = "light"; });
  await page.waitForTimeout(500);
  const l = await snap();
  console.log("SNAP light:", JSON.stringify(l, null, 2));
  if (!l.tab || !l.toolbar) {
    rec(3, "浅色下激活标签与工具栏存在", false, `tab=${!!l.tab} toolbar=${!!l.toolbar}`);
  } else {
    rec(3, "①背景色相同(浅)", l.tab.bg === l.toolbar.bg,
      `tab bg=${l.tab.bg} toolbar bg=${l.toolbar.bg}（深色值为 ${d.tab.bg}，两主题值不同属预期）`);
    rec(3, "②底缘相接 ≤1px(浅)", near(l.toolbar.rect.top, l.tab.rect.bottom, 1),
      `tab.bottom=${l.tab.rect.bottom} toolbar.top=${l.toolbar.rect.top} 差=${Math.round((l.toolbar.rect.top - l.tab.rect.bottom) * 100) / 100}px`);
  }
  await page.screenshot({ path: `${OUT}/review-tabbar-light.png`, clip: { x: 0, y: Math.max(0, l.row.rect.top - 6), width: 860, height: l.row.rect.h + l.toolbar.rect.h + 14 } });
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.waitForTimeout(400);

  // ================= 第 8 项：切换色板回归（ember，R27 解耦） =================
  const termSnap = () => page.evaluate(() => {
    const sid = document.querySelector(".term-session.active")?.dataset.sid ?? null;
    const entry = sid && window.__t_terms ? window.__t_terms.get(sid) : null;
    const term = entry && entry.options ? entry : (entry && entry.term ? entry.term : null);
    const vp = document.querySelector(".term-session.active .xterm-viewport") || document.querySelector(".xterm-viewport");
    return {
      sid,
      termBgOption: term?.options?.theme?.background ?? null,
      viewportBg: vp ? getComputedStyle(vp).backgroundColor : null,
      appBgVar: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      accentVar: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  const t0 = await termSnap();
  await page.evaluate(() => { document.documentElement.dataset.theme = "ember"; });
  await page.waitForTimeout(600);
  const t1 = await termSnap();
  console.log("TERM before:", JSON.stringify(t0), "\nTERM after :", JSON.stringify(t1));
  rec(8, "应用底色变暖（--bg #0a0e14→#121215）", t0.appBgVar === "#0a0e14" && t1.appBgVar === "#121215",
    `before --bg=${t0.appBgVar} after --bg=${t1.appBgVar} (accent ${t0.accentVar}→${t1.accentVar}, body ${t0.bodyBg}→${t1.bodyBg})`);
  rec(8, "终端画布颜色不变（R27 解耦）", t0.termBgOption === t1.termBgOption && t0.viewportBg === t1.viewportBg && t0.termBgOption !== null,
    `term.theme.background ${t0.termBgOption}→${t1.termBgOption}; .xterm-viewport bg ${t0.viewportBg}→${t1.viewportBg}`);
  await page.screenshot({ path: `${OUT}/review-session-ember.png` });
  await page.screenshot({
    path: `${OUT}/review-tabbar-ember.png`,
    clip: { x: 0, y: Math.max(0, l.row.rect.top - 6), width: 860, height: l.row.rect.h + l.toolbar.rect.h + 14 },
  });
  // 还原默认色板，避免污染后续观察
  await page.evaluate(() => { document.documentElement.dataset.theme = ""; });
  await page.waitForTimeout(300);

  console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
  const fails = results.filter((r) => !r.pass);
  console.log(`\n==== 复验汇总: ${results.length - fails.length}/${results.length} PASS ====`);
  for (const f of fails) console.log(`FAIL [${f.item}] ${f.name} :: ${f.detail}`);
  await browser.close();
  process.exit(fails.length || pageErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
