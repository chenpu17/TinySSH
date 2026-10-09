// R45：浏览器回归测试的公共骨架。
//
// 设计约束（来自交付文档 §6.1）：
//   - **不写死个人路径**：浏览器由 browser.cjs 发现，基址可用 TINYSSH_UI_BASE 覆盖。
//   - **不依赖旧布局坐标**：断言走 `data-testid` 与语义类名，不写 220/280 这类旧三栏数值。
//   - **可重复运行**：每次跑都从干净页面开始，不依赖上一次的 localStorage（见 freshContext）。
//
// demo 模式：浏览器里没有 Tauri，`adapter/bridge.ts` 自动走 `src/demo.ts` 的内存后端，
// 因此本套件不需要真后端、不需要解锁屏幕（headless Chromium 与原生 WKWebView 无关）。

const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";

/** 断言收集器：每条 check 记录 通过/失败，失败不中断（一次跑完拿到全貌）。 */
class Checker {
  constructor(specName) {
    this.specName = specName;
    this.results = [];
  }
  check(name, cond, detail = "") {
    this.results.push({ name, ok: !!cond, detail: String(detail) });
    const mark = cond ? "  ok  " : " FAIL ";
    const tail = detail ? `  — ${detail}` : "";
    console.log(`${mark} ${name}${tail}`);
    return !!cond;
  }
  /** 断言相等，失败时把期望/实得都打出来。 */
  eq(name, actual, expected) {
    const ok = actual === expected;
    return this.check(name, ok, ok ? `${JSON.stringify(actual)}` : `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
  }
  /** 断言数值在 [lo, hi] 内。 */
  between(name, actual, lo, hi) {
    const ok = typeof actual === "number" && actual >= lo && actual <= hi;
    return this.check(name, ok, `实得 ${actual}（期望 ${lo}–${hi}）`);
  }
  get failed() {
    return this.results.filter((r) => !r.ok);
  }
}

/**
 * 开一个全新浏览器上下文（独立 localStorage，避免上一轮残留影响）。
 * 返回 { browser, context, page, pageErrors }。
 */
async function freshContext(opts = {}) {
  const { viewport = { width: 1440, height: 900 } } = opts;
  const { path: executablePath, source } = resolveBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  return { browser, context, page, pageErrors, browserSource: source };
}

/** 打开 demo 首页并等首屏稳定。 */
async function openDemo(page, { waitMs = 600 } = {}) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.waitForTimeout(waitMs);
}

/** 测试开始前确认 dev server 起着，避免把「服务没开」误报成「断言失败」。 */
async function preflight() {
  let res;
  try {
    res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(4000) });
  } catch (e) {
    throw new Error(
      `连不上 ${BASE}（${e.message}）。请先起前端开发服务器：\n  npm run dev --prefix ui\n` +
        `（或用 TINYSSH_UI_BASE 指向别的地址）`,
    );
  }
  if (!res.ok) throw new Error(`${BASE} 返回 HTTP ${res.status}`);
}

/** 跑一个 spec 函数，统一收尾（关浏览器）并返回结果。 */
async function runSpec(specName, fn) {
  const ck = new Checker(specName);
  let ctx = null;
  try {
    ctx = await freshContext();
    await openDemo(ctx.page);
    await fn({ ...ctx, ck, check: ck.check.bind(ck), BASE });
  } catch (e) {
    ck.check(`spec 抛出异常：${e.message}`, false, e.stack ? e.stack.split("\n")[1].trim() : "");
  } finally {
    if (ctx) {
      // 页面 JS 异常也算失败——demo shim 静默报错是历史踩过的坑。
      if (ctx.pageErrors.length) {
        ck.check("无页面 JS 错误", false, ctx.pageErrors.slice(0, 3).join(" | "));
      } else {
        ck.check("无页面 JS 错误", true);
      }
      await ctx.browser.close().catch(() => {});
    }
  }
  return { specName, results: ck.results, failed: ck.failed };
}

module.exports = { BASE, Checker, freshContext, openDemo, preflight, runSpec };
