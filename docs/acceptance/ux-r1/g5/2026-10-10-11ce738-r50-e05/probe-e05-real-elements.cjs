// R50 / E05 —— 真实元素对照（注入等价性的**可复算**佐证）。
//
// 主张（本探针**只**主张这些）：
//   `probe-e05-reduced-motion.cjs` 用**注入的等价 DOM**（`#p-*`）读 computed style。
//   本探针在**首屏真实元素**上读同样的两个量（computed `transitionDuration` /
//   `transitionProperty`），在 `reducedMotion: "no-preference"` 与 `"reduce"` 两个上下文里
//   各读一次，用来证明：对 `button` 与 `.tab` 这两行，**注入件与真实元素的读数逐字相同**
//   （no-preference `0.12s ×5`、reduce `0s / property:none`）。
//
// 不主张：任何动画类读数（`.spin`/`.toast`/… 首屏不一定渲染，本探针不测）；运行态行为。
//
// 状态依赖（复跑前须知）：被测对象是 **dev server 首屏**（`http://localhost:5183/`，demo 种子态）。
//   - 需存在 `.hostbar`；`button` / `button.ghost` / `.host-connect-btn` 取自**主机栏**；
//   - `.tab` 取自**标签栏**——demo 预置 2 个会话（prod-1 / staging-1）时才有；
//   - 无硬编码坐标；`counts` 段把上述元素个数一并读出，便于对账首屏是否同一状态。
//
// 与 `probe-e05-reduced-motion.cjs` 同样的解析约定：playwright-core 装在 `ui/` 下，
// 本探针在 `docs/` 下，故按 `__dirname` 相对定位 `ui/test`，不依赖调用者 cwd。

const path = require("node:path");
const fs = require("node:fs");
const UI_TEST = path.join(__dirname, "../../../../../ui/test");
const { chromium } = require(require.resolve("playwright-core", { paths: [UI_TEST] }));
const { resolveBrowser } = require(path.join(UI_TEST, "browser.cjs"));

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
// 与主探针的 `.run-attempts` **分开计数**，避免互相干扰单次干净自证。
const ATTEMPTS_FILE = path.join(__dirname, ".run-attempts-realelem");

/** 真实元素盘点 + 双口径读数（一次 evaluate 内取完，避免两次采样间 DOM 变化）。 */
const READ = () => {
  const read = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e);
    return {
      tag: e.tagName,
      cls: e.className,
      transitionDuration: cs.transitionDuration,
      transitionProperty: cs.transitionProperty,
    };
  };
  const tabs = [...document.querySelectorAll(".tab")].map((e) => {
    const cs = getComputedStyle(e);
    return { tag: e.tagName, cls: e.className, role: e.getAttribute("role"),
      text: (e.textContent || "").slice(0, 24),
      transitionDuration: cs.transitionDuration, transitionProperty: cs.transitionProperty };
  });
  return {
    counts: {
      tabbar: document.querySelectorAll(".tabbar").length,
      tab: document.querySelectorAll(".tab").length,
      hostCard: document.querySelectorAll(".host-card").length,
      hostCardSide: document.querySelectorAll(".host-card-side").length,
      connectBtn: document.querySelectorAll(".host-connect-btn").length,
    },
    // 与主探针 B 表前两行对应的真实元素读数
    firstButton: read("button"),
    ghostButton: read("button.ghost"),
    hostConnectBtn: read(".host-connect-btn"),
    firstTab: read(".tab"),
    allTabs: tabs,
  };
};

(async () => {
  let attempts = 0;
  try { attempts = parseInt(fs.readFileSync(ATTEMPTS_FILE, "utf8").trim(), 10) || 0; } catch { /* 首次 */ }
  attempts += 1; fs.writeFileSync(ATTEMPTS_FILE, String(attempts));

  const { path: executablePath, source } = resolveBrowser();
  const out = { base: BASE, browser: source, cases: {}, notes: [],
    run: { attempts, startedAt: new Date().toISOString(),
      probeSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex") } };

  for (const pref of ["no-preference", "reduce"]) {
    const browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      reducedMotion: pref,
    });
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await page.waitForTimeout(500);
    out.cases[pref] = await page.evaluate(READ);
    out.notes.push({ pref, pageErrors: errs.slice(0, 3) });
    await browser.close();
  }

  out.run.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(2);
});
