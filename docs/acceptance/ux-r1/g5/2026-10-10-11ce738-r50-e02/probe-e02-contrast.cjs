// R50 / E02 —— 深浅外观 × 主要终端配色的对比度测量（可自动化部分）。
//
// 行级要求（交付文档 §E02）：所有文本、选中、错误、弹窗对比度合格，无白底白字/极暗说明。
//
// 本探针**只**主张「可自动化的样式测量」这一半；「视觉」那一半（人眼确认无白底白字）另附截图。
//
// 三段：
//   A. **终端配色**（4 套）× 应用外观（2 种）：逐套切主题，读**实际渲染**的前景/背景
//      （前景取 `.xterm-rows` 的 computed `color`；背景取 `.xterm-viewport` 的 computed
//      `backgroundColor`，并用**截图像素**做地面真值交叉验证），再与源码里声明的
//      `THEMES` 表逐字段对账。对账通过 ⇒ 声明表就是运行中的调色板 ⇒ 才用它对 16 个
//      ANSI 色算对比度（ANSI 色无法在 demo 里渲染出来，见 §口径）。
//   B. **界面文本**（chrome）：两种应用外观下，遍历所有可见文本节点，用 effBg 逐层 alpha
//      合成求实际底色，算对比度；按 WCAG 阈值（正文 4.5 / 大字 3.0）判合格。
//      终端子树（`.xterm`）排除——它由 A 段单独负责。
//   C. **选中**：界面 `::selection` 与终端选中背景。
//
// 探针自身的踩坑（会**静默给出假读数**，登记在此）：
//   1) **终端背景不能用父链 walk 找**。xterm 把主题背景画在 `.xterm-viewport` 上，
//      而它是 `.xterm-screen` 的**兄弟**（绝对定位互相覆盖），不在文本节点的祖先链上。
//      用父链 walk 会一路走到应用底色，把「深色终端」读成浅色底 ⇒ 假的「白底白字」。
//      正确做法 = 直接读 `.xterm-viewport` 的 computed backgroundColor。
//   2) 对比度必须用**实际底色**（alpha 合成后的），不能拿 `backgroundColor` 原样比——
//      半透明底会让比值失真。
//   3) **可见性必须查祖先**。只看元素自身的 `opacity` 会把「祖先 opacity:0」的元素当成
//      可见——本 UI 的 `.host-card-side`（含连接钮）默认 `opacity: 0`，**悬停才显形**。
//      按元素自身判会测到一个根本没画出来的按钮 ⇒ 假的对比度不合格。改用
//      `checkVisibility({checkOpacity, checkVisibilityCSS, contentVisibilityAuto})`，
//      它按祖先链判定。这类元素另在**悬停态**单独测（用户真正看得到它的时刻）。

const path = require("node:path");
const fs = require("node:fs");
const UI_TEST = path.join(__dirname, "../../../../../ui/test");
const { chromium } = require(require.resolve("playwright-core", { paths: [UI_TEST] }));
const { resolveBrowser } = require(path.join(UI_TEST, "browser.cjs"));

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const REPO = path.join(__dirname, "../../../../..");
const SHOT_DIR = path.join(__dirname, "screenshots");
// 单次干净自证：本轮序号存在 sidecar 里。归档目录在**正式跑之前**被 `rm -rf` 清空
// （连本 sidecar 一起删），故最终 `e02-raw.json.run.attempts === 1` 即自证：
// 目录里的每张 PNG / 每个读数都来自**同一次**运行，没有上一轮孤儿文件混入。
const ATTEMPTS_FILE = path.join(__dirname, ".run-attempts");

/** 从源码解析 `THEMES` 表（声明的调色板）。返回 [{id,label,bg,fg,theme:{...}}]。 */
function parseDeclaredThemes() {
  const src = fs.readFileSync(path.join(REPO, "ui/src/App.tsx"), "utf8");
  const start = src.indexOf("const THEMES: ThemePreset[] = [");
  if (start < 0) throw new Error("THEMES 定义未找到");
  const end = src.indexOf("\n];", start);
  const block = src.slice(start, end);
  const out = [];
  // 每个主题对象：{ id: "...", label: "...", bg: "...", fg: "...", theme: { ... } }
  const re = /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*bg:\s*"([^"]+)",\s*fg:\s*"([^"]+)",\s*theme:\s*\{([\s\S]*?)\n?\s*\},?\s*\}/g;
  let m;
  while ((m = re.exec(block))) {
    const theme = {};
    const kv = /(\w+):\s*"(#[0-9a-fA-F]{6})"/g;
    let k;
    while ((k = kv.exec(m[5]))) theme[k[1]] = k[2];
    out.push({ id: m[1], label: m[2], bg: m[3], fg: m[4], theme });
  }
  if (out.length !== 4) throw new Error(`解析到 ${out.length} 套主题，期望 4`);
  return out;
}

// ── 浏览器侧助手（注入一次，页面内复用） ────────────────────────────────
const HELPERS = `
window.__e02 = {
  rgb: (s) => { const m = (s || "").match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; },
  rgba: (s) => { const m = (s || "").match(/[\\d.]+/g); if (!m) return null;
    return { c: m.slice(0, 3).map(Number), a: m.length > 3 ? parseFloat(m[3]) : 1 }; },
  lum: (c) => { const f = c.map((v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; },
  ratio: (fg, bg) => { const L1 = window.__e02.lum(fg), L2 = window.__e02.lum(bg);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2)); },
  hex: (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""),
  /** 从某元素的祖先链求**实际底色**（逐层 alpha 合成，从最外层往里叠）。 */
  effBg: (el) => { const layers = []; let n = el;
    while (n) { const L = window.__e02.rgba(getComputedStyle(n).backgroundColor);
      if (L && L.a > 0) layers.push(L); n = n.parentElement; }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) { const L = layers[i]; out = out.map((v, k) => L.c[k] * L.a + v * (1 - L.a)); }
    return out.map((v) => Math.round(v)); },
  isLarge: (cs) => { const px = parseFloat(cs.fontSize); const w = parseInt(cs.fontWeight, 10) || 400;
    return px >= 24 || (px >= 18.66 && w >= 700); },
  /** 可见性：**按祖先链**判定（自身 opacity:0 与祖先 opacity:0 都不算可见）。 */
  visible: (e) => {
    if (typeof e.checkVisibility === "function") {
      return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    let n = e;                                    // 回退：逐级查 opacity / visibility / display
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
      n = n.parentElement; }
    return true;
  },
  /** 遍历 root 下所有**可见**文本节点，算与自身实际底色的对比度。 */
  sweep: (rootSel, opts) => {
    const root = document.querySelector(rootSel); if (!root) return null;
    const skip = (opts && opts.skip) || [];
    const rows = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = (c.textContent || "").trim();
          if (t.length < 1 || !c.parentElement) continue;
          const e = c.parentElement;
          if (skip.some((s) => e.closest(s))) continue;
          if (!window.__e02.visible(e)) continue;
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          const fg = window.__e02.rgb(cs.color); if (!fg) continue;
          const bg = window.__e02.effBg(e);
          rows.push({ text: t.slice(0, 32), sel: (e.className || e.tagName).toString().slice(0, 40),
            fg: window.__e02.hex(fg), bg: window.__e02.hex(bg),
            ratio: window.__e02.ratio(fg, bg), large: window.__e02.isLarge(cs),
            fontSize: cs.fontSize, fontWeight: cs.fontWeight });
        } else if (c.nodeType === 1) {
          if (skip.some((s) => c.matches && c.matches(s))) continue;
          walk(c);
        }
      }
    };
    walk(root);
    return rows;
  },
  /** 当前**可见**的那个终端（多会话时 .xterm 可能有多个，隐藏的没有尺寸）。 */
  visTerm: () => [...document.querySelectorAll(".xterm")].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null,
  xtermFg: () => { const t = window.__e02.visTerm(); const e = t && t.querySelector(".xterm-rows"); return e ? getComputedStyle(e).color : null; },
  xtermBg: () => { const t = window.__e02.visTerm(); const e = t && t.querySelector(".xterm-viewport"); return e ? getComputedStyle(e).backgroundColor : null; },
  xtermBox: () => { const t = window.__e02.visTerm(); const e = t && t.querySelector(".xterm-screen"); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  /** placeholder 是**属性文本**，不是文本节点 ⇒ 上面的 sweep **扫不到**（见 README 覆盖面边界）。
   *  单独一遍：读 ::placeholder 的 computed color，若带 alpha 则与输入框底色合成后再算比值。 */
  placeholders: (rootSel, opts) => {
    const root = document.querySelector(rootSel); if (!root) return null;
    const skip = (opts && opts.skip) || [];
    const rows = [];
    for (const e of root.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      if (skip.some((s) => e.closest(s))) continue;
      if (e.value) continue;                       // 有值时 placeholder 不显示
      if (!window.__e02.visible(e)) continue;
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(e);
      const ps = getComputedStyle(e, "::placeholder");
      const raw = window.__e02.rgba(ps.color); if (!raw) continue;
      const bg = window.__e02.effBg(e);
      const comp = raw.a < 1 ? raw.c.map((v, i) => Math.round(v * raw.a + bg[i] * (1 - raw.a))) : raw.c;
      rows.push({ sel: (e.className || e.tagName).toString().slice(0, 40), ph: (e.placeholder || "").slice(0, 32),
        rawColor: ps.color, alpha: raw.a, fg: window.__e02.hex(comp), bg: window.__e02.hex(bg),
        ratio: window.__e02.ratio(comp, bg), large: window.__e02.isLarge(cs),
        fontSize: cs.fontSize, fontWeight: cs.fontWeight });
    }
    return rows;
  },
};
`;

const setAppearance = (page, label) => page.evaluate(async (l) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!document.querySelector(".settings-pane")) { document.querySelector(".hb-settings").click(); await sleep(700); }
  const b = [...document.querySelectorAll(".ts-appearance button")].find((x) => x.textContent.trim() === l);
  if (!b) return "no-btn:" + l;
  b.click(); await sleep(500);
  return document.documentElement.dataset.chrome;
}, label);

const setTheme = (page, label) => page.evaluate(async (l) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!document.querySelector(".settings-pane")) { document.querySelector(".hb-settings").click(); await sleep(700); }
  const b = [...document.querySelectorAll(".ts-themes button")].find((x) => x.textContent.includes(l));
  if (!b) return "no-btn:" + l;
  b.click(); await sleep(500);
  return [...document.querySelectorAll(".ts-themes button")].filter((x) => x.className.includes("ts-active")).map((x) => x.textContent.trim())[0];
}, label);

const closeSettings = (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector("[data-testid=settings-close]")?.click(); await sleep(400);
});

const connect = (page, nameFrag) => page.evaluate(async (frag) => {
  const card = [...document.querySelectorAll(".host-card")].find((c) => c.textContent.includes(frag));
  if (!card) return "no-card";
  const b = card.querySelector(".host-connect-btn");
  if (!b) return "no-btn";
  if (b.disabled) return "disabled";
  b.click(); return "ok";
}, nameFrag);

/** 读某元素区域的**主色像素**（地面真值）。返回 {file, stats}。 */
async function dominantPixel(page, clip, outName) {
  const buf = await page.screenshot({ clip });
  fs.writeFileSync(path.join(SHOT_DIR, outName), buf);
  const stats = await pixelStats(page, buf);
  return { file: outName, stats };
}

/** 把截图的 PNG 交回页面用 canvas 解码，出直方图（避免引入 PNG 解码依赖）。 */
async function pixelStats(page, buf) {
  const b64 = buf.toString("base64");
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i] + "," + d[i + 1] + "," + d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, n]) => ({ rgb: k, hex: "#" + k.split(",").map((v) => (+v).toString(16).padStart(2, "0")).join(""), n }));
    return { w: img.width, h: img.height, top };
  }, `data:image/png;base64,${b64}`);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  let attempts = 0;
  try { attempts = parseInt(fs.readFileSync(ATTEMPTS_FILE, "utf8").trim(), 10) || 0; } catch { /* 首次 */ }
  attempts += 1;
  fs.writeFileSync(ATTEMPTS_FILE, String(attempts));
  const startedAt = new Date().toISOString();
  const declared = parseDeclaredThemes();
  const { path: executablePath, source } = resolveBrowser();
  const out = { base: BASE, browser: source, headSha: fs.existsSync(path.join(REPO, ".git"))
      ? require("node:child_process").execSync("/usr/bin/git rev-parse HEAD", { cwd: REPO }).toString().trim() : null,
    run: { attempts, startedAt, probeSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex") },
    declared: declared.map((t) => ({ id: t.id, label: t.label, bg: t.bg, fg: t.fg })),
    termPalette: [], chrome: {}, selection: {}, notes: [] };

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(HELPERS);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.waitForTimeout(600);

  // ── B0. 空态（welcome / 无会话）——**必须先测**：一旦连上主机，欢迎页就被顶掉了 ──
  for (const ap of ["深色", "浅色"]) {
    const chrome = await setAppearance(page, ap);
    await closeSettings(page);
    await page.waitForTimeout(400);
    out.chrome[ap] = { dataChrome: chrome,
      emptyState: await page.evaluate((skip) => window.__e02.sweep("body", { skip }), [".xterm"]) };
    await page.screenshot({ path: path.join(SHOT_DIR, `chrome-welcome-${ap === "深色" ? "dark" : "light"}.png`) });
  }

  // 连一个主机，拿到终端
  out.notes.push({ connect: await connect(page, "prod-1") });
  await page.waitForTimeout(1600);

  // ── A. 终端配色 × 应用外观 ──────────────────────────────────────────
  for (const ap of ["深色", "浅色"]) {
    const chrome = await setAppearance(page, ap);
    await closeSettings(page);
    out.notes.push({ appearance: ap, dataChrome: chrome });
    for (const t of declared) {
      const active = await setTheme(page, t.label);
      await closeSettings(page);
      await page.waitForTimeout(300);
      const fg = await page.evaluate(() => window.__e02.xtermFg());
      const bg = await page.evaluate(() => window.__e02.xtermBg());
      const box = await page.evaluate(() => window.__e02.xtermBox());
      // 像素地面真值：取终端内一块靠下、无文字的区域
      const clip = { x: Math.round(box.x + box.w - 60), y: Math.round(box.y + box.h - 24), width: 40, height: 12 };
      const shot = await dominantPixel(page, clip, `term-${t.id}-${ap === "深色" ? "dark" : "light"}-bg.png`);
      const fgRgb = await page.evaluate((s) => window.__e02.rgb(s), fg);
      const bgRgb = await page.evaluate((s) => window.__e02.rgb(s), bg);
      out.termPalette.push({ appearance: ap, themeId: t.id, activeLabel: active,
        fgComputed: fg, bgComputed: bg, fgHex: fgRgb && await page.evaluate((c) => window.__e02.hex(c), fgRgb),
        bgHex: bgRgb && await page.evaluate((c) => window.__e02.hex(c), bgRgb),
        declaredFg: t.fg, declaredBg: t.bg,
        matchFg: fgRgb ? await page.evaluate((a) => window.__e02.hex(a[0]) === a[1], [fgRgb, t.fg]) : null,
        matchBg: bgRgb ? await page.evaluate((a) => window.__e02.hex(a[0]) === a[1], [bgRgb, t.bg]) : null,
        ratio: fgRgb && bgRgb ? await page.evaluate((a) => window.__e02.ratio(a[0], a[1]), [fgRgb, bgRgb]) : null,
        pixelShot: shot.file, clip,
        // 地面真值：截图里出现最多的颜色必须等于 computed 背景
        bgPixelTop: shot.stats.top,
        matchBgPixel: bgRgb ? shot.stats.top[0].hex === (await page.evaluate((c) => window.__e02.hex(c), bgRgb)) : null });
    }
  }

  // 终端 16 色 + 选中：从**声明表**算（对账已在上面的 matchFg/matchBg 完成）
  const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  out.ansiRatios = declared.map((t) => {
    const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
    const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2)); };
    const bg = hexToRgb(t.bg), fg = hexToRgb(t.fg);
    const selBg = hexToRgb(t.theme.selectionBackground || t.bg);
    return { themeId: t.id, fgOnBg: ratio(fg, bg),
      ansi: ANSI.map((k) => ({ k, hex: t.theme[k], ratioVsBg: ratio(hexToRgb(t.theme[k]), bg) })),
      selBgVsFg: ratio(selBg, fg), selBgVsBg: ratio(selBg, bg), selBg: t.theme.selectionBackground };
  });

  // ── B. 界面文本（chrome）双外观 ──────────────────────────────────────
  const SKIP = [".xterm"];
  for (const ap of ["深色", "浅色"]) {
    const chrome = await setAppearance(page, ap);
    await closeSettings(page);
    await page.waitForTimeout(400);
    const rows = await page.evaluate((skip) => window.__e02.sweep("body", { skip }), SKIP);
    // placeholder（属性文本，sweep 扫不到）单测一遍——它同样是用户要读的字
    const phRows = await page.evaluate((skip) => window.__e02.placeholders("body", { skip }), SKIP);
    // 悬停态：`.host-card-side`（连接钮等）默认 `opacity: 0`，只在悬停时显形——必须单测
    const card = await page.$(".host-card");
    if (card) { await card.hover(); await page.waitForTimeout(350); }
    const hoverRows = await page.evaluate((skip) => window.__e02.sweep(".hostbar", { skip }), SKIP);
    await page.screenshot({ path: path.join(SHOT_DIR, `chrome-hostcard-hover-${ap === "深色" ? "dark" : "light"}.png`) });
    await page.mouse.move(720, 500);   // 移开，避免悬停态渗进后续测量
    await page.waitForTimeout(250);
    // 设置对话框打开态
    await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector(".hb-settings").click(); await s(700); });
    const dlgRows = await page.evaluate((skip) => window.__e02.sweep("[role=dialog]", { skip }), SKIP);
    const phDlg = await page.evaluate((skip) => window.__e02.placeholders("[role=dialog]", { skip }), SKIP);
    await page.screenshot({ path: path.join(SHOT_DIR, `chrome-settings-${ap === "深色" ? "dark" : "light"}.png`) });
    await closeSettings(page);
    // 添加主机表单（`.card.add-host`，在主机栏滚动区内，由 aria-label=添加主机 的按钮开合）
    // ——placeholder 最密集的输入面，必须单独覆盖
    await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[aria-label="添加主机"]')?.click(); await s(600); });
    const addHostText = await page.evaluate((skip) => window.__e02.sweep(".add-host", { skip }), SKIP);
    const addHostPh = await page.evaluate((skip) => window.__e02.placeholders(".add-host", { skip }), SKIP);
    await page.screenshot({ path: path.join(SHOT_DIR, `chrome-addhost-${ap === "深色" ? "dark" : "light"}.png`) });
    await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[aria-label="收起表单"]')?.click(); await s(400); });
    // 合并（不覆盖）B0 已写入的 emptyState
    out.chrome[ap] = { ...out.chrome[ap], dataChrome: chrome, page: rows, placeholderPage: phRows,
      hoverHostbar: hoverRows, settingsDialog: dlgRows, placeholderSettings: phDlg,
      addHostText, addHostPlaceholder: addHostPh };
  }

  // ── B2. 首次连接确认弹窗 + 连接失败横幅（各外观） ────────────────────
  // 弹窗选择器：指纹确认/认证弹窗是 `.hk-dialog`（**没有** role=dialog，不能用 [role=dialog] 抓）
  const DLG = ".hk-dialog, [role=dialog]";
  out.errorState = {};
  for (const ap of ["深色", "浅色"]) {
    const chrome = await setAppearance(page, ap); await closeSettings(page);
    await page.waitForTimeout(300);
    // prod-2 是「演示连接失败」主机：先出「首次连接确认」弹窗，信任后连接失败 → conn-error 横幅
    const st = await connect(page, "prod-2");
    let gotDlg = await page.waitForSelector(".hk-dialog", { timeout: 8000 }).then(() => true).catch(() => false);
    // 指纹一旦被信任就不再弹窗；浅色轮改用另一个**未信任**主机取弹窗读数
    if (!gotDlg) { await connect(page, "otp-1");
      gotDlg = await page.waitForSelector(".hk-dialog", { timeout: 8000 }).then(() => true).catch(() => false); }
    const hk = gotDlg ? await page.evaluate((s) => window.__e02.sweep(s, { skip: [".xterm"] }), DLG) : [];
    if (gotDlg) await page.screenshot({ path: path.join(SHOT_DIR, `chrome-hostkey-${ap === "深色" ? "dark" : "light"}.png`) });
    // 信任并连接 → 走完流程（demo 里 prod-2 会失败）；若本轮弹窗来自 otp-1 则先取消它
    await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const dlg = document.querySelector(".hk-dialog");
      if (!dlg) return;
      const trust = [...dlg.querySelectorAll("button")].find((x) => /信任并连接|我已核实/.test(x.textContent));
      const isProd2 = /prod-2/.test(dlg.textContent);
      (isProd2 ? trust : [...dlg.querySelectorAll("button")].find((x) => /取消/.test(x.textContent)))?.click();
      await s(1500); });
    // 若弹窗来自 otp-1，prod-2 的失败横幅需再触发一次
    if (!(await page.$(".conn-error"))) {
      await page.evaluate(() => [...document.querySelectorAll(".host-card")].find((c) => c.textContent.includes("prod-2"))?.querySelector(".host-connect-btn")?.click());
      await page.waitForTimeout(1800);
    }
    const banner = await page.evaluate((s) => window.__e02.sweep(s, { skip: [".xterm"] }), ".conn-error, .toast.err");
    await page.screenshot({ path: path.join(SHOT_DIR, `chrome-conn-error-${ap === "深色" ? "dark" : "light"}.png`) });
    const after = await page.evaluate((skip) => window.__e02.sweep("body", { skip }), SKIP);
    out.errorState[ap] = { dataChrome: chrome, connectResult: st, hostkeyDialogSeen: gotDlg, hostkeyDialog: hk, errorBanner: banner, afterAll: after };
  }

  // ── C. 选中 ────────────────────────────────────────────────────────
  // C1：界面 `::selection` 规则（若未定义，浏览器用 UA 默认——一并记录）
  out.selection = { chromeSelectionRules: await page.evaluate(() => {
      const r = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.selectorText && /::selection/.test(rule.selectorText))
            r.push({ sel: rule.selectorText, color: rule.style.color, bg: rule.style.backgroundColor });
        }
      }
      return r;
    }) };

  // C2：终端选中背景——真拖选一段终端文本，DOM 读选中层 + **截图像素**双取
  await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector("[data-testid=settings-close]")?.click(); await s(300);
    const tab = document.querySelector(".tabbar .tab"); if (tab) { tab.click(); await s(900); } });
  const tbox = await page.evaluate(() => window.__e02.xtermBox());
  if (tbox) {
    await page.mouse.move(tbox.x + 40, tbox.y + 18);
    await page.mouse.down();
    await page.mouse.move(tbox.x + 320, tbox.y + 18, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const dom = await page.evaluate(() => {
      const layer = document.querySelector(".xterm-selection");
      return { layerExists: !!layer, childCount: layer ? layer.children.length : 0,
        selText: String(window.getSelection().toString()).slice(0, 60) };
    });
    const buf = await page.screenshot({ clip: { x: Math.round(tbox.x), y: Math.round(tbox.y), width: 360, height: 22 } });
    fs.writeFileSync(path.join(SHOT_DIR, "term-selection.png"), buf);
    const stats = await pixelStats(page, buf);
    out.selection.termSelection = { ...dom, shot: "term-selection.png", pixelTop: stats.top };
  } else {
    out.selection.termSelection = null;
  }

  // C3：界面选中——用 Selection API 选中一段界面文本，截图像素取样（选中色由 UA/系统决定，
  //     本档只记录**观测值**，不断言其达标；见 README 口径）
  const selInfo = await page.evaluate(async () => {
    const el = document.querySelector(".host-name") || document.querySelector(".hb-top input");
    if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const b = el.getBoundingClientRect();
    return { box: { x: b.x, y: b.y, w: b.width, h: b.height }, text: el.textContent.slice(0, 20),
      textColor: getComputedStyle(el).color };
  });
  if (selInfo) {
    const buf = await page.screenshot({ clip: { x: Math.round(selInfo.box.x), y: Math.round(selInfo.box.y),
      width: Math.max(4, Math.round(selInfo.box.w)), height: Math.max(4, Math.round(selInfo.box.h)) } });
    fs.writeFileSync(path.join(SHOT_DIR, "chrome-selection.png"), buf);
    const stats = await pixelStats(page, buf);
    out.selection.chromeSelection = { ...selInfo, shot: "chrome-selection.png", pixelTop: stats.top };
  }

  out.notes.push({ pageErrors: errs.slice(0, 5) });
  out.run.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "e02-raw.json"), JSON.stringify(out, null, 1));
  await browser.close();
  console.log(JSON.stringify({ ok: true, attempts, termPalette: out.termPalette.length, chromeKeys: Object.keys(out.chrome), ansi: out.ansiRatios.length }, null, 1));
})().catch((e) => {
  console.error("probe failed:", e.message, "\n", e.stack);
  process.exit(2);
});
