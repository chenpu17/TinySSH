// 独立复验 §4：三栏宽度实测 + placeholder 对比度（WCAG 相对亮度公式，AA 4.5 线）
// 深浅两主题 × 两输入（任务目标 textarea / 命令框 input）
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const out = [];
  const check = (name, ok, detail = "") => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

  // 页内工具：解析 rgb()/rgba()，alpha 合成到不透明底，WCAG 相对亮度与对比度
  const util = `
    (() => {
    const parseC = (s) => {
      const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
      if (!m) return null;
      return [ +m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4] ];
    };
    const blend = (top, bot) => { // top alpha 合成到 bot（均可含 alpha，bot 先视为不透明）
      return [ top[0]*top[3] + bot[0]*(1-top[3]), top[1]*top[3] + bot[1]*(1-top[3]), top[2]*top[3] + bot[2]*(1-top[3]), 1 ];
    };
    const effBg = (el) => { // 沿祖先找第一条非透明背景，逐层合成，兜底 root --bg
      const chain = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseC(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) chain.push(c);
        n = n.parentElement;
      }
      const rootBg = parseC(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) || [255,255,255,1];
      let acc = rootBg;
      for (let i = chain.length - 1; i >= 0; i--) acc = blend(chain[i], acc);
      return acc;
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [x, y] = l1 > l2 ? [l1, l2] : [l2, l1]; return (x + 0.05) / (y + 0.05); };
    window.__contrast = (el) => {
      const cs = getComputedStyle(el, '::placeholder');
      const fg = parseC(cs.color);
      const bg = effBg(el);
      if (!fg) return { err: "unparsed:" + cs.color };
      const fgEff = fg[3] < 1 ? blend(fg, bg) : fg;
      return { fg: cs.color, bg: bg.map(Math.round).join(","), ratio: +ratio(fgEff, bg).toFixed(2) };
    };
    })();
  `;

  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("ui.theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector(".host-card");
    await page.evaluate(util);

    // ── 三栏实测 ──
    const cols = await page.evaluate(() => {
      const layout = document.querySelector(".layout");
      const grid = getComputedStyle(layout).gridTemplateColumns;
      const rects = [...layout.querySelectorAll(":scope > .col")].map((c) => {
        const r = c.getBoundingClientRect();
        return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1) };
      });
      return { grid, rects, vw: innerWidth };
    });
    if (theme === "dark") {
      const [l, m, r] = cols.rects;
      check("cols-3-present", cols.rects.length === 3, JSON.stringify(cols.rects));
      check("col-left-220", Math.abs(l.w - 220) <= 1, `左栏 ${l.w}px（规格 220px 固定）`);
      check("col-right-280", Math.abs(r.w - 280) <= 1, `右栏 ${r.w}px（规格 280px 固定）`);
      check("col-middle-flex", m.w > 500 && m.w < 800, `中栏 ${m.w}px（弹性 1fr，视口 ${cols.vw}）`);
      out.push(`INFO grid-template-columns = ${cols.grid}`);
    }

    // ── placeholder 对比度（先接入会话，命令框才有真实占位态）──
    await page.click('.tab:has-text("prod-1")');
    await page.waitForSelector(".goal-input");
    await page.waitForTimeout(500);
    const goal = await page.evaluate(() => window.__contrast(document.querySelector(".goal-input")));
    const cmd = await page.evaluate(() => {
      const el = document.querySelector('.panel-title input[placeholder*="执行命令"]');
      return el ? window.__contrast(el) : { err: "no el" };
    });
    check(`${theme}-goal-placeholder-AA`, goal.ratio >= 4.5, `任务目标框 fg=${goal.fg} on #${goal.bg}（panel2）→ ${goal.ratio}:1`);
    check(`${theme}-cmd-placeholder-AA`, cmd.ratio >= 4.5, `命令框 fg=${cmd.fg} on rgb(${cmd.bg}) → ${cmd.ratio}:1`);
    await ctx.close();
  }

  console.log(out.join("\n"));
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
