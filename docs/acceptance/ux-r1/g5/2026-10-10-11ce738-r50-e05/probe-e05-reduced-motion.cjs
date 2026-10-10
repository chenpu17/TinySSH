// R50 / E05 —— prefers-reduced-motion 的可自动化部分。
//
// 范围（本探针**只**主张这些）：
//   A. **完备性**（CSSOM 静态）：把 `styles.css` 里所有 `@media (prefers-reduced-motion: reduce)`
//      块的**选择器**列出来；再把所有带 `animation:` 简写的规则列出来，两者取差集 ⇒
//      「有动画但没有 reduced-motion 覆盖」的候选。
//   B. **有效性**（计算样式，双口径）：对 A 里被覆盖的选择器，分别在
//      `no-preference` 与 `reduce` 两种模拟下读 computed style，要求**两侧不同**
//      （即规则真的咬得住，而不是写了个空规则）。只报一侧 = 无法判定。
//   C. **缺口**：A 的差集里的选择器，在 `reduce` 下的 computed animation 是否仍非 none。
//
// 不主张：VoiceOver 朗读（人工）、真实原生窗口下的行为、reduced-motion 之外的动效。
// 元素来源：`.tab` / `button` 用**页面真实元素**；其余（`.toast`/`.spin`/`.skeleton`/
// `.collab-badge.hot`/`.sftp-row .sftp-dl`/`.attach-hint`）在页面里不一定处于渲染态，
// 用**注入的等价 DOM**（同样的 class 与嵌套结构）读 computed style。注入节点只在
// 计算样式时存在，读完即移除——它验证的是「CSS 规则对该选择器是否生效」，
// **不是**「该组件在真实运行态下是否动画」。后者本探针不主张。

const path = require("node:path");
const fs = require("node:fs");
// playwright-core 装在 ui/ 下（与 ui/test/harness.cjs 同一份），本探针在 docs/ 下，
// 故按 ui/test 的解析根显式解析，避免依赖调用者的 cwd。
const UI_TEST = path.join(__dirname, "../../../../../ui/test");
const { chromium } = require(require.resolve("playwright-core", { paths: [UI_TEST] }));
const { resolveBrowser } = require(path.join(UI_TEST, "browser.cjs"));

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
// 单次干净自证：本轮序号存 sidecar。归档目录在正式跑前被清空（连本 sidecar 一起删），
// 故最终 `e05-raw.json.run.attempts === 1` 即自证读数只来自一次运行，无上一轮残留混入。
const ATTEMPTS_FILE = path.join(__dirname, ".run-attempts");

// 注入探针用的等价 DOM（class 与真实结构一致；`.sftp-dl` 必须嵌在 `.sftp-row` 内）
const PROBE_DOM = `
<div id="e05-probe" aria-hidden="true" style="position:fixed;left:-9999px;top:0">
  <button id="p-button">x</button>
  <div class="tab" id="p-tab">t</div>
  <div class="toast" id="p-toast">t</div>
  <div class="spin" id="p-spin"></div>
  <div class="skeleton" id="p-skeleton"></div>
  <div class="collab-badge hot" id="p-collab">c</div>
  <div class="sftp-row"><button class="sftp-dl" id="p-sftpf">d</button></div>
  <div class="attach-hint" id="p-attach">h</div>
</div>`;

/** 读一个元素的关键动画/过渡计算值。 */
const READ_ONE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    animationName: cs.animationName,
    animationDuration: cs.animationDuration,
    transitionDuration: cs.transitionDuration,
    transitionProperty: cs.transitionProperty,
  };
};

/** A. 从 CSSOM 里抽 reduced-motion 覆盖的选择器 + 所有带动画/过渡的选择器。
 *  踩坑记录（两条，都会让本探针**静默漏检**）：
 *   1) 不能用 `r.style.cssText` 做正则：Chrome 把 `animation: none` 序列化成
 *      `animation: auto ease 0s 1 normal none running none;`——cssText 里**没有**
 *      "animation: none" 这个子串，用正则会漏掉全部 animation 类规则。
 *   2) 也不能用 `animationDuration === '0s'` 判「关掉了」：Chrome 对 `animation: none`
 *      返回的 `animationDuration` 是 **`"auto"`**（不是 `0s`）。只用 `animationName`。
 *
 *  **两个方向都要扫**（初版只扫了 `animation:`，漏掉 `transition:` 那一类——
 *  即 `styles.css:969` 的 `.host-card`、`:984` 的 `.host-card-side` 这类
 *  「有过渡但没有 reduced-motion 覆盖」的选择器）：`animated` 收 animation 规则，
 *  `transitioned` 收 transition 规则，两者分别与 `reduced` 取差集。 */
const SCAN_CSSOM = () => {
  const reduced = new Set();
  const animated = new Set();
  const transitioned = new Set();
  const walk = (rules, inReduced) => {
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE) {
        const isReduced = /prefers-reduced-motion\s*:\s*reduce/.test(r.conditionText || r.media?.mediaText || "");
        walk(r.cssRules, inReduced || isReduced);
        continue;
      }
      if (r.type !== CSSRule.STYLE_RULE) continue;
      const sel = r.selectorText;
      const animName = r.style.animationName;
      if (inReduced) {
        const animOff = animName === "none";
        const transOff = r.style.transitionProperty === "none" || r.style.transitionDuration === "0s";
        if (animOff || transOff) sel.split(",").forEach((s) => reduced.add(s.trim()));
        continue;
      }
      if (animName && animName !== "none") sel.split(",").forEach((s) => animated.add(s.trim()));
      // 过渡：`transition: none` 的规则不算「有过渡」；`transition-property` 为 all/具体属性
      // 且时长非 0 才算。简写 `transition` 会被序列化进 transitionProperty/Duration。
      const tp = r.style.transitionProperty, td = r.style.transitionDuration;
      if (tp && tp !== "none" && td && td !== "0s" && td !== "auto")
        sel.split(",").forEach((s) => transitioned.add(s.trim()));
    }
  };
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    walk(rules, false);
  }
  return { reduced: [...reduced].sort(), animated: [...animated].sort(), transitioned: [...transitioned].sort() };
};

async function measure(page, sel) {
  return page.evaluate(READ_ONE, sel);
}

(async () => {
  let attempts = 0;
  try { attempts = parseInt(fs.readFileSync(ATTEMPTS_FILE, "utf8").trim(), 10) || 0; } catch { /* 首次 */ }
  attempts += 1; fs.writeFileSync(ATTEMPTS_FILE, String(attempts));
  const { path: executablePath, source } = resolveBrowser();
  const out = { base: BASE, browser: source, cases: {}, cssom: null, notes: [],
    run: { attempts, startedAt: new Date().toISOString(),
      probeSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex") } };

  const targets = [
    ["button", "#p-button"],
    [".tab", "#p-tab"],
    [".toast", "#p-toast"],
    [".spin", "#p-spin"],
    [".skeleton", "#p-skeleton"],
    [".collab-badge.hot", "#p-collab"],
    [".sftp-row .sftp-dl", "#p-sftpf"],
    [".attach-hint", "#p-attach"],
    // 这两个用**页面真实元素**（主机栏常驻）：它们是「有过渡但可能没覆盖」的候选
    [".host-card", ".host-card"],
    [".host-card-side", ".host-card-side"],
  ];

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
    await page.waitForTimeout(400);
    await page.evaluate((html) => {
      const d = document.createElement("div");
      d.innerHTML = html;
      document.body.appendChild(d.firstElementChild);
    }, PROBE_DOM);

    for (const [name, sel] of targets) {
      out.cases[name] = out.cases[name] || {};
      out.cases[name][pref] = await measure(page, sel);
    }
    if (pref === "reduce") out.cssom = await page.evaluate(SCAN_CSSOM);
    out.notes.push({ pref, pageErrors: errs.slice(0, 3) });
    await browser.close();
  }

  out.run.finishedAt = new Date().toISOString();
  // A 段差集（两个方向）：有动画/有过渡，但没有 reduced-motion 覆盖
  if (out.cssom) {
    const red = new Set(out.cssom.reduced);
    out.cssom.diffAnimated = out.cssom.animated.filter((s) => !red.has(s));
    out.cssom.diffTransitioned = out.cssom.transitioned.filter((s) => !red.has(s));
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(2);
});
