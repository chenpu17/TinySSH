// R50 / E06 —— 窄窗长审批 / 双分屏协作「用完整视图」/ 通知不抢焦点（**浏览器域**）。
//
// 范围（本探针**只**主张这些）：
//   A. **窄窗（640×800）下的长审批**：打开协作面板，确认面板走 `.task-panel.tp-full`
//      （「空间不足——完整视图，终端仍在运行」），且审批卡的「批准/编辑后批准/拒绝」
//      **仍在视口内、尺寸达标、面板无横向溢出**。
//   B. **双分屏协作**：两会话分屏后打开协作面板 ⇒ 面板一律走中央完整视图（App.tsx:1695
//      `if (splitPanes) setTpFull(true)`）；**关掉面板后分屏仍在**（分屏不拆）。
//   C. **通知**：toast 有 `aria-live`（err=assertive，其余=polite，App.tsx:5317）；
//      出现时不抢焦点（activeElement 不被夺走）、`.toast-stack` 不拦截指针（不盖操作）。
//   D. **后台完成只提醒**：让页面**失去窗口焦点**（`document.hasFocus() === false`，造法见
//      D 段注释）后再连接一台主机 ⇒ 完成路径走 `App.tsx:3011-3013`「只更新标签态，不切视图
//      不抢焦点」，toast 文案含「点击标签进入」，且**活动会话不变**；**同一次连接动作在保持
//      前台时作对照**（应切视图、无「点击标签进入」）——证明差异来自焦点而非触发写法。
//
// 不主张：原生窗口下的通知/焦点行为（真窗口人工观察，见 README §5）；人眼最终判定。
//
// 夹具：demo 内置主机（`本机` / `prod-1`）与 demo 种子的 2 条待审批（`demo.ts`），
// 无需播种。全部经真实 UI 操作。

const path = require("node:path");
const fs = require("node:fs");
const UI_TEST = path.join(__dirname, "../../../../../ui/test");
const { chromium } = require(require.resolve("playwright-core", { paths: [UI_TEST] }));
const { resolveBrowser } = require(path.join(UI_TEST, "browser.cjs"));

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const REPO = path.join(__dirname, "../../../../..");
const SHOT_DIR = path.join(__dirname, "screenshots");
const ATTEMPTS_FILE = path.join(__dirname, ".run-attempts");
const NARROW = { width: 640, height: 800 };
const WIDE = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连接一台内置主机（悬停卡 → 点连接），返回是否点到了连接钮。 */
async function connectHost(page, name) {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) return { ok: false, why: `找不到主机卡 ${name}` };
  await card.hover();
  await sleep(250);
  const btn = await card.$('button[title^="连接"]');
  if (!btn) return { ok: false, why: "找不到连接钮" };
  await btn.click();
  await sleep(1800);
  return { ok: true };
}

/** 打开协作面板并等审批渲染。 */
async function openCollab(page) {
  await page.click("[data-testid=tools-collab]");
  await sleep(900);
}

/**
 * 连接一台内置主机，但**用 `page.evaluate` 对真实连接按钮派发 `click()`**（不经指针事件）。
 * 理由见 D 段注释：Playwright 的指针事件会把页面重新置前，破坏「失焦」前提。
 * 命中的是同一个 React onClick 处理器；只是触发方式不同。
 */
async function connectSynthetic(page, name) {
  return page.evaluate((n) => {
    const card = [...document.querySelectorAll(".host-card")]
      .find((c) => c.querySelector(".host-name")?.textContent.trim() === n);
    if (!card) return { ok: false, why: `找不到主机卡 ${n}` };
    const btn = card.querySelector('button[title^="连接"]');
    if (!btn) return { ok: false, why: "找不到连接钮" };
    btn.click();
    return { ok: true };
  }, name);
}

/** 面板内每条审批卡的「拒绝」按钮的几何与可达性。 */
const approvalGeom = () => {
  const de = document.documentElement;
  const vw = de.clientWidth, vh = de.clientHeight;
  const cards = [...document.querySelectorAll("[data-testid=ap-group]")];
  const items = cards.map((g) => {
    const btns = [...g.querySelectorAll("button")].filter((b) => ["批准", "编辑后批准", "拒绝"].includes(b.textContent.trim()));
    return btns.map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent.trim(),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        inViewport: r.x >= 0 && r.y >= 0 && r.x + r.width <= vw + 0.5 && r.y + r.height <= vh + 0.5,
        sizeOk: r.width >= 20 && r.height >= 20 };
    });
  }).flat();
  const panel = document.querySelector(".task-panel");
  const pr = panel ? panel.getBoundingClientRect() : null;
  return { groups: cards.length, items,
    panelTpFull: !!document.querySelector(".task-panel.tp-full"),
    panelHint: (document.querySelector(".task-panel.tp-full .dim") || {}).textContent || null,
    panelOverflowX: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
    docOverflowX: de.scrollWidth > de.clientWidth,
    panelBox: pr ? { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) } : null,
    viewport: { w: vw, h: vh },
    allItemsReachable: items.length > 0 && items.every((i) => i.inViewport && i.sizeOk),
  };
};

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  let attempts = 0;
  try { attempts = parseInt(fs.readFileSync(ATTEMPTS_FILE, "utf8").trim(), 10) || 0; } catch { /* 首次 */ }
  attempts += 1; fs.writeFileSync(ATTEMPTS_FILE, String(attempts));

  const { path: executablePath, source } = resolveBrowser();
  const out = {
    base: BASE, browser: source,
    headSha: fs.existsSync(path.join(REPO, ".git"))
      ? require("node:child_process").execSync("/usr/bin/git rev-parse HEAD", { cwd: REPO }).toString().trim() : null,
    run: { attempts, startedAt: new Date().toISOString(),
      probeSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex") },
    narrow: {}, split: {}, notify: {}, background: {}, notes: [],
  };

  const browser = await chromium.launch({ executablePath, headless: true });

  // ══ A. 窄窗长审批 ══
  {
    const context = await browser.newContext({ viewport: NARROW, locale: "zh-CN" });
    const page = await context.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await sleep(600);
    const c = await connectHost(page, "本机");
    out.narrow.connect = c;
    await openCollab(page);
    out.narrow.geom = await page.evaluate(approvalGeom);
    // 再复测一次，确认不是瞬态
    await sleep(600);
    out.narrow.geomStable = await page.evaluate(approvalGeom);
    await page.screenshot({ path: path.join(SHOT_DIR, "narrow-approval.png") });
    out.notes.push({ section: "A", pageErrors: errs.slice(0, 3) });
    await context.close();
  }

  // ══ B. 双分屏协作 ══
  {
    const context = await browser.newContext({ viewport: WIDE, locale: "zh-CN" });
    const page = await context.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await sleep(600);
    out.split.connectA = await connectHost(page, "本机");
    out.split.connectB = await connectHost(page, "prod-1");
    await sleep(600);
    // 打开分屏菜单 → 选「在右侧显示已有会话」里的另一台
    await page.click('button[title^="分屏"]');
    await sleep(400);
    const menuOpen = await page.evaluate(() => !!document.querySelector(".split-menu"));
    out.split.menuOpen = menuOpen;
    out.split.panesBefore = await page.evaluate(() => ({
      left: document.querySelectorAll(".pane-left").length,
      right: document.querySelectorAll(".pane-right").length,
      active: document.querySelectorAll(".term-session.active").length,
    }));
    if (menuOpen) {
      await page.evaluate(() => {
        const it = [...document.querySelectorAll(".split-menu button.sm-item")]
          .find((b) => !/在右侧新建会话/.test(b.textContent));
        it?.click();
      });
      await sleep(1200);
    }
    out.split.panesAfter = await page.evaluate(() => ({
      left: document.querySelectorAll(".pane-left").length,
      right: document.querySelectorAll(".pane-right").length,
      focused: document.querySelectorAll(".pane-focused").length,
      exitBtn: !!document.querySelector('button[title^="退出分屏"]'),
    }));
    await page.screenshot({ path: path.join(SHOT_DIR, "split-two-panes.png") });
    // 分屏下打开协作面板 ⇒ 应走 tp-full
    await openCollab(page);
    out.split.panelInSplit = await page.evaluate(() => ({
      tpFull: !!document.querySelector(".task-panel.tp-full"),
      hint: (document.querySelector(".task-panel.tp-full .dim") || {}).textContent || null,
    }));
    await page.screenshot({ path: path.join(SHOT_DIR, "split-collab-tpfull.png") });
    // 关闭面板 ⇒ 分屏应恢复（分屏不拆）
    await page.evaluate(() => {
      // 面板头部关闭钮：找 aria-label 或 title 含「关闭」的按钮
      const b = [...document.querySelectorAll(".task-panel button")].find((x) =>
        /关闭/.test(x.getAttribute("title") || "") || /关闭/.test(x.getAttribute("aria-label") || ""));
      b?.click();
    });
    await sleep(900);
    out.split.afterClosePanel = await page.evaluate(() => ({
      panelGone: !document.querySelector(".task-panel"),
      left: document.querySelectorAll(".pane-left").length,
      right: document.querySelectorAll(".pane-right").length,
      exitBtn: !!document.querySelector('button[title^="退出分屏"]'),
    }));
    await page.screenshot({ path: path.join(SHOT_DIR, "split-restored.png") });
    out.notes.push({ section: "B", pageErrors: errs.slice(0, 3) });
    await context.close();
  }

  // ══ C. 通知：aria-live / 不抢焦点 / 不盖操作 ══
  {
    const context = await browser.newContext({ viewport: WIDE, locale: "zh-CN" });
    const page = await context.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await sleep(600);
    await connectHost(page, "本机");
    // 用一个会 pushToast("info") 的真实交互触发通知：分屏菜单「在右侧新建会话…」
    await page.click('button[title^="分屏"]');
    await sleep(350);
    const focusBefore = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, cls: String(el.className || "").slice(0, 30), text: (el.textContent || "").trim().slice(0, 20) } : null;
    });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".split-menu button.sm-item")].find((x) => /在右侧新建会话/.test(x.textContent));
      b?.click();
    });
    await sleep(500);
    out.notify = await page.evaluate(() => {
      const toasts = [...document.querySelectorAll(".toast")];
      const stack = document.querySelector(".toast-stack");
      const el = document.activeElement;
      const cs = stack ? getComputedStyle(stack) : null;
      return {
        toastCount: toasts.length,
        toastTexts: toasts.map((t) => t.textContent.slice(0, 40)),
        toastAriaLive: toasts.map((t) => t.getAttribute("aria-live")),
        toastKinds: toasts.map((t) => String(t.className).replace("toast ", "")),
        // 通知是否可被聚焦（若可被 Tab 到就是「抢焦点」面）
        toastTabIndex: toasts.map((t) => t.tabIndex),
        // 通知层是否拦截指针（pointer-events:none ⇒ 不盖操作）
        stackPointerEvents: cs ? cs.pointerEvents : null,
        stackPosition: cs ? cs.position : null,
        // 出现通知后，焦点是否仍在用户原来所在处
        activeAfter: el ? { tag: el.tagName, cls: String(el.className || "").slice(0, 30), text: (el.textContent || "").trim().slice(0, 20) } : null,
      };
    });
    out.notify.focusBefore = focusBefore;
    // 再断言：焦点**没有**跑到 toast 上
    out.notify.focusNotStolen = await page.evaluate(() =>
      !document.activeElement || !document.activeElement.classList.contains("toast"));
    await page.screenshot({ path: path.join(SHOT_DIR, "notify-toast.png") });
    out.notes.push({ section: "C", pageErrors: errs.slice(0, 3) });
    await context.close();
  }

  // ══ D. 后台完成只提醒（窗口失焦）══
  //
  // 怎么造「窗口不在前台」——实测（见 README §2 的配方表）：
  //   · headless Chromium 里 document.hasFocus() 默认恒为 true；
  //   · **指针事件会把页面重新置前**：`hover()`/`click()` 之后 hasFocus() 又变回 true，
  //     所以「先失焦再点连接」不成立（实测：点完 hasFocus 回到 true ⇒ 走了前台分支）；
  //   · `page2.bringToFront()` **不可靠**（同一写法两次实验一真一假），不采用；
  //   · 可用配方 = **另开一页**（`page2`，只需存在，**无需** bringToFront）
  //     + 对本页发 CDP `Emulation.setFocusEmulationEnabled({enabled:false})`
  //     ⇒ document.hasFocus() 稳定变 false。**第二页是必需的**：单页时同一 CDP 调用无效（实测）。
  //   · 该信号正是 `App.tsx:3008` 判定「后台完成」所用的 `document.hasFocus()`。
  //
  // 因此连接动作用 `page.evaluate` 对**真实连接按钮**派发 `click()`（同一个 onClick 处理器，
  // 只是不经指针事件）——**这是探针的实现选择，如实登记**。为证明「差异来自焦点而非该写法」，
  // 本段跑**两遍**：D1 失焦（期望后台分支）、D2 同写法但保持前台（对照，期望前台分支）。
  const activeLabel = () => {
    const t = document.querySelector(".tab-active") || document.querySelector(".term-session.active");
    return t ? (t.textContent || "").trim().slice(0, 24) : null;
  };
  const readAfter = () => {
    const toasts = [...document.querySelectorAll(".toast")];
    const t = document.querySelector(".tab-active") || document.querySelector(".term-session.active");
    return {
      toastTexts: toasts.map((x) => x.textContent.slice(0, 40)),
      toastAriaLive: toasts.map((x) => x.getAttribute("aria-live")),
      hasClickToEnter: toasts.some((x) => /点击标签进入/.test(x.textContent)),
      activeAfter: t ? (t.textContent || "").trim().slice(0, 24) : null,
      tabTexts: [...document.querySelectorAll(".tab")].map((x) => x.textContent.trim().slice(0, 16)),
      attachedCount: document.querySelectorAll(".term-session.active, .pane-focused").length,
    };
  };
  for (const [key, loseFocus] of [["background", true], ["foregroundControl", false]]) {
    const context = await browser.newContext({ viewport: WIDE, locale: "zh-CN" });
    const page = await context.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await sleep(600);
    await connectHost(page, "本机");            // 前台建立会话 A（真实指针点击，此时应在前台）
    await sleep(700);
    const sec = (out.background[key] = {});
    sec.activeBefore = await page.evaluate(activeLabel);
    sec.hasFocusBefore = await page.evaluate(() => document.hasFocus());
    if (loseFocus) {
      const page2 = await context.newPage();     // 第二页：CDP 关焦点生效的前提
      await page2.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await sleep(300);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await sleep(400);
    }
    sec.hasFocusAfter = await page.evaluate(() => document.hasFocus());
    sec.hiddenAfter = await page.evaluate(() => document.hidden);
    sec.connect = await connectSynthetic(page, "prod-1");   // 对真实按钮派发 click()
    sec.hasFocusAtClick = await page.evaluate(() => document.hasFocus());
    await sleep(1000);                                     // toast 存在期内采样（TTL 约 2.6s）
    sec.after = await page.evaluate(readAfter);
    sec.activeUnchanged = sec.after.activeAfter === sec.activeBefore;
    await page.screenshot({ path: path.join(SHOT_DIR, `${key}.png`) });
    out.notes.push({ section: `D/${key}`, pageErrors: errs.slice(0, 3) });
    await context.close();
  }

  out.run.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "e06-raw.json"), JSON.stringify(out, null, 1));
  await browser.close();
  console.log(JSON.stringify({
    ok: true, attempts,
    narrowTpFull: out.narrow.geom?.panelTpFull, narrowReachable: out.narrow.geom?.allItemsReachable,
    splitTwoPanes: out.split.panesAfter, splitPanelTpFull: out.split.panelInSplit?.tpFull,
    splitRestored: out.split.afterClosePanel,
    notifyLive: out.notify.toastAriaLive, notifyNotStolen: out.notify.focusNotStolen,
    bgFocusAfter: out.background.background?.hasFocusAfter,
    bgClickToEnter: out.background.background?.after?.hasClickToEnter,
    bgActiveUnchanged: out.background.background?.activeUnchanged,
    fgControlFocusAfter: out.background.foregroundControl?.hasFocusAfter,
    fgControlClickToEnter: out.background.foregroundControl?.after?.hasClickToEnter,
    fgControlActiveAfter: out.background.foregroundControl?.after?.activeAfter,
  }, null, 1));
})().catch((e) => { console.error("probe failed:", e.message, "\n", e.stack); process.exit(2); });
