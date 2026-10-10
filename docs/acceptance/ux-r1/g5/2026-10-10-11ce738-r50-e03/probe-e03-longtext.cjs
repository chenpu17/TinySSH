// R50 / E03 —— 长文本（长中文主机名 / IPv6 / 长路径 / 10+ 标签 / 长错误）。
//
// 范围（本探针**只**主张这些）：
//   A. **长中文主机名 + 长地址 + 12 个标签**：卡片内名称/地址是否按省略号截断、动作组
//      （`.host-card-side` 的收藏/编辑/删除/连接）是否被挤掉、**全称是否可查看**。
//   B. **长错误**：让连接失败的横幅里嵌入一个很长的中文主机名，看横幅是否溢出容器、
//      「关闭」是否仍在视口内。
//   C. **长路径**：文件面板的面包屑在超长路径下的滚动/省略，以及全路径是否可查看
//      （`.sftp-crumbs` 的 title）。
//   D. **键盘**：主机卡与卡片内动作能否用纯键盘到达、焦点是否可见。
//   E. **IPv6**：尝试把 IPv6 字面量填进「添加主机」表单，记录结果。
//
// 不主张：原生窗口下的行为；人眼最终判定（截图供人看）。
//
// 夹具**全部经真实 UI 播种**（填「添加主机」表单 → 仅保存），不直接调 demo 后端——
// 这样「播种」这一动作本身也走产品代码路径。

const path = require("node:path");
const fs = require("node:fs");
const UI_TEST = path.join(__dirname, "../../../../../ui/test");
const { chromium } = require(require.resolve("playwright-core", { paths: [UI_TEST] }));
const { resolveBrowser } = require(path.join(UI_TEST, "browser.cjs"));

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const REPO = path.join(__dirname, "../../../../..");
const SHOT_DIR = path.join(__dirname, "screenshots");
const ATTEMPTS_FILE = path.join(__dirname, ".run-attempts");

// 夹具常量（写死在这里，README 里引用同一份字面量）
const LONG_NAME = "生产环境核心交易数据库主节点（华东一区可用区B）-只读副本-01-夜间批处理专用-禁止重启";
const LONG_ADDR = "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + ".example.internal.corp";
const FAIL_ADDR = "10.0.0.12";       // demo 里唯一会「认证失败」的地址（demo.ts:640）
const TAGS12 = ["华东一区", "生产", "数据库", "只读副本", "核心交易", "高优先级",
  "禁止重启", "值班必看", "夜间维护", "合规审计", "备份源", "监控接入"];
const IPV6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
const LONG_PATH = "/var/log/nginx/archive/" + "very-long-segment-".repeat(8) + "deep";
// 演示 SFTP 树里**最深**的真实目录（demo.ts:1254 的 dirs 集合）；面包屑只能用真实路径行使，
// 因为 navigateTo 失败会留在编辑态、不渲染面包屑（App.tsx:4826）。
const DEEP_REAL_PATH = "/root/releases/v3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 经真实表单播种一台主机。返回表单是否成功关闭（= 保存成功）。 */
async function seedHost(page, { name, address, username = "ops", tags = [], password = "demo-pass", shotOnError = null }) {
  await page.evaluate(() => {
    if (!document.querySelector(".add-host")) document.querySelector('[aria-label="添加主机"]')?.click();
  });
  await sleep(500);
  if (!(await page.$(".add-host"))) return { ok: false, why: "表单未打开" };
  await page.fill('.add-host input[placeholder="例：我的服务器"]', name);
  await page.fill('.add-host input[placeholder="例：192.168.1.10 或 server.example.com"]', address);
  await page.fill('.add-host input[placeholder="例：ops 或 root"]', username);
  if (tags.length) await page.fill('.add-host input[placeholder="例：生产, 数据库"]', tags.join(","));
  if (password) await page.fill(".add-host input[type=password]", password);
  await page.click('.add-host button:has-text("仅保存")');
  await sleep(1400);
  const err = await page.evaluate(() => document.querySelector(".add-host .err")?.textContent ?? null);
  const stillOpen = !!(await page.$(".add-host"));
  // 被拒时表单仍开 ⇒ **必须在收起之前**截图，否则错误态连同表单一起被抹掉。
  // （初版把截图放在 seedHost 之外、收起之后 ⇒ ipv6-reject.png 结构上永远拍不到错误。）
  if (stillOpen && shotOnError) await page.screenshot({ path: shotOnError });
  if (stillOpen) await page.evaluate(() => document.querySelector('[aria-label="收起表单"]')?.click());
  await sleep(300);
  return { ok: !stillOpen, formError: err };
}

/** 找一张卡：按名称子串。 */
const findCard = (page, needle) => page.evaluate((n) => {
  const c = [...document.querySelectorAll(".host-card")].find((e) => e.textContent.includes(n));
  if (!c) return null;
  const box = (e) => { const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), r: +(b.x + b.width).toFixed(1) }; };
  const name = c.querySelector(".host-name"), addr = c.querySelector(".host-addr"), side = c.querySelector(".host-card-side");
  const btns = [...(side?.querySelectorAll("button") ?? [])].map((b) => ({ title: b.title, box: box(b) }));
  return {
    card: box(c), name: box(name), addr: box(addr), side: side ? box(side) : null,
    nameText: name.textContent,
    nameOverflow: name.scrollWidth > name.clientWidth, nameSW: name.scrollWidth, nameCW: name.clientWidth,
    addrOverflow: addr.scrollWidth > addr.clientWidth, addrSW: addr.scrollWidth, addrCW: addr.clientWidth,
    // 「全称可查看」的三条可能路径：元素自身 title / 祖先 title / aria-label
    nameTitle: name.getAttribute("title"),
    mainTitle: c.querySelector(".host-card-main")?.getAttribute("title") ?? null,
    cardTitle: c.getAttribute("title"),
    ariaLabel: c.getAttribute("aria-label"),
    sideButtons: btns,
    sideInsideCard: side ? side.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5 : null,
    tagChips: [...c.querySelectorAll(".host-tag")].map((t) => t.textContent),
    sideOpacity: side ? getComputedStyle(side).opacity : null,
  };
}, needle);

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
    fixtures: { LONG_NAME, LONG_ADDR, FAIL_ADDR, TAGS12, IPV6, LONG_PATH, DEEP_REAL_PATH },
    seed: {}, longHost: {}, longError: {}, longPath: {}, keyboard: {}, ipv6: {}, notes: [],
  };

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.waitForTimeout(600);

  // ── E. IPv6 录入（先测：它决定「长地址」这一维能否用真 IPv6 行使）──
  // 截图由 seedHost 在**收起表单之前**完成（shotOnError）——否则被拒的错误态拍不到。
  out.ipv6.seedAttempt = await seedHost(page, {
    name: "ipv6-探针主机", address: IPV6,
    shotOnError: path.join(SHOT_DIR, "ipv6-reject.png"),
  });
  out.ipv6.rejected = !out.ipv6.seedAttempt.ok;
  out.ipv6.formError = out.ipv6.seedAttempt.formError ?? null;

  // ── A. 长中文名 + 长地址 + 12 标签 ──
  out.seed.longHost = await seedHost(page, { name: LONG_NAME, address: LONG_ADDR, tags: TAGS12 });
  await page.waitForTimeout(500);
  out.longHost = await findCard(page, "只读副本") || { found: false };
  await page.screenshot({ path: path.join(SHOT_DIR, "longhost-default.png") });
  // 悬停态：动作组显形后，名称是否被动作组盖掉
  const cards = await page.$$(".host-card");
  for (const c of cards) {
    const t = await c.textContent();
    if (t && t.includes("只读副本")) { await c.hover(); break; }
  }
  await page.waitForTimeout(400);
  out.longHostHover = await findCard(page, "只读副本") || { found: false };
  await page.screenshot({ path: path.join(SHOT_DIR, "longhost-hover.png") });
  await page.mouse.move(900, 500); await page.waitForTimeout(250);

  // ── D. 键盘：主机卡与卡内动作能否用**真实 Tab 键**到达、焦点指示是否可见 ──
  // 为什么必须用真实按键：programmatic `el.focus()` **不**触发 `:focus-visible`，
  // 会读到一个「无 outline/无 box-shadow」的假红。只有键盘模态下的 Tab 才让
  // `:focus-visible` 命中。故先 `.focus()` 定位，再用 Tab 逐步走。
  out.keyboard = await page.evaluate(async () => {
    const s = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = [...document.querySelectorAll(".host-card")].find((e) => e.textContent.includes("只读副本"));
    if (!target) return { found: false };
    target.focus(); await s(150);
    return { found: true, tabIndex: target.tabIndex, role: target.getAttribute("role"),
      ariaLabel: target.getAttribute("aria-label"),
      cardFocusViaProgrammatic: document.activeElement === target,
      sideOpacityOnCardFocus: getComputedStyle(target.querySelector(".host-card-side")).opacity,
      actionCount: target.querySelectorAll(".host-card-side button").length };
  });
  // 真实 Tab 序列：从卡出发，逐次 Tab，记录每一站的焦点与**指示器**（outline 或 box-shadow）
  const readActive = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "BODY", indicator: false };
    const cs = getComputedStyle(el);
    const card = el.closest ? el.closest(".host-card") : null;
    return { tag: el.tagName, cls: String(el.className || "").slice(0, 40),
      title: (el.getAttribute("title") || "").slice(0, 26),
      inCard: !!card,
      cardName: card ? (card.querySelector(".host-name")?.textContent || "").slice(0, 10) : null,
      outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor,
      boxShadow: cs.boxShadow === "none" ? "none" : cs.boxShadow.slice(0, 36),
      indicator: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" };
  });
  out.keyboard.tabSeq = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(90);
    out.keyboard.tabSeq.push(await readActive());
  }
  // Shift+Tab 回到卡本身，看卡自己的键盘焦点指示
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(90);
  out.keyboard.cardViaTab = await readActive();
  out.keyboard.cardIndicatorViaTab = out.keyboard.cardViaTab.indicator;

  // ── B. 长错误：长名主机 + 会失败的地址 ──
  out.seed.failHost = await seedHost(page, { name: LONG_NAME + "（失败探针）", address: FAIL_ADDR });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll(".host-card")].find((e) => e.textContent.includes("失败探针"));
    c?.querySelector(".host-connect-btn")?.click();
  });
  await page.waitForTimeout(1200);
  // 首次连接 → 指纹确认弹窗 → 信任
  if (await page.$(".hk-dialog")) {
    await page.evaluate(async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const d = document.querySelector(".hk-dialog");
      [...d.querySelectorAll("button")].find((x) => /信任并连接|我已核实/.test(x.textContent))?.click();
      await s(1500);
    });
  }
  await page.waitForTimeout(2000);
  out.longError = await page.evaluate(() => {
    const b = document.querySelector(".conn-error");
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    const close = [...b.querySelectorAll("button")].find((x) => x.textContent.trim() === "关闭");
    const cr = close?.getBoundingClientRect();
    const de = document.documentElement;
    return { found: true, title: b.querySelector("b")?.textContent ?? null,
      detail: b.querySelector(".dim")?.textContent ?? null,
      titleLen: (b.querySelector("b")?.textContent ?? "").length,
      box: { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0), r: +(r.x + r.width).toFixed(0) },
      viewport: { w: de.clientWidth, h: de.clientHeight },
      docOverflowX: de.scrollWidth > de.clientWidth, docSW: de.scrollWidth, docCW: de.clientWidth,
      bannerOverflowX: b.scrollWidth > b.clientWidth, bannerSW: b.scrollWidth, bannerCW: b.clientWidth,
      closeBox: cr ? { x: +cr.x.toFixed(0), r: +(cr.x + cr.width).toFixed(0), y: +cr.y.toFixed(0), h: +cr.height.toFixed(0) } : null,
      closeInViewport: cr ? (cr.x >= 0 && cr.x + cr.width <= de.clientWidth && cr.y >= 0 && cr.y + cr.height <= de.clientHeight) : null,
      closeSizeOk: cr ? (cr.width >= 20 && cr.height >= 20) : null,
    };
  });
  await page.screenshot({ path: path.join(SHOT_DIR, "longerror.png") });

  // ── C. 长路径（文件面板）──
  // 关掉错误横幅，连一台 demo 主机以拿到会话工具栏
  await page.evaluate(() => [...document.querySelectorAll(".conn-error button")].find((b) => b.textContent.trim() === "关闭")?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll(".host-card")].find((e) => e.textContent.includes("prod-1") && e.textContent.includes("10.0.0.11"));
    c?.querySelector(".host-connect-btn")?.click();
  });
  await page.waitForTimeout(2500);
  if (await page.$(".hk-dialog")) {
    await page.evaluate(async () => { const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const d = document.querySelector(".hk-dialog");
      [...d.querySelectorAll("button")].find((x) => /信任并连接|我已核实/.test(x.textContent))?.click(); await s(1500); });
  }
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector(".st-file")?.click());
  await page.waitForTimeout(1500);
  out.longPath.panelOpened = await page.evaluate(() => !!document.querySelector('[data-testid="sftp-crumbs"]'));

  // C1. 进入演示树里最深的真实目录，测面包屑（标题、溢出、段数、键盘可达）
  await page.evaluate(() => document.querySelector('[aria-label="切换路径输入"]')?.click());
  await page.waitForTimeout(350);
  if (await page.$('[data-testid="sftp-path-input"]')) {
    await page.fill('[data-testid="sftp-path-input"]', DEEP_REAL_PATH);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1600);
  }
  out.longPath.crumbs = await page.evaluate((deep) => {
    const c = document.querySelector('[data-testid="sftp-crumbs"]');
    if (!c) return { found: false };
    const r = c.getBoundingClientRect();
    const title = c.getAttribute("title");
    return { found: true, title, text: c.textContent,
      overflowX: c.scrollWidth > c.clientWidth, sw: c.scrollWidth, cw: c.clientWidth,
      box: { w: +r.width.toFixed(0), h: +r.height.toFixed(0) },
      segCount: c.querySelectorAll(".sftp-crumb-seg").length,
      focusableCrumbs: [...c.querySelectorAll("button.sftp-crumb")].length,
      // 「全路径可查看」：title 是否就是当前完整路径（人可悬停读到全称）
      titleEqualsPath: title === deep,
    };
  }, DEEP_REAL_PATH);
  await page.screenshot({ path: path.join(SHOT_DIR, "longpath-crumbs.png") });
  // 面包屑按钮的真实键盘焦点（Tab 模态 → :focus-visible 才可能命中）
  out.longPath.crumbKeyboard = await page.evaluate(() => {
    const b = document.querySelector("button.sftp-crumb");
    if (!b) return { found: false };
    b.focus();
    return { found: true, focused: document.activeElement === b, label: b.textContent,
      title: b.getAttribute("title") };
  });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(90);
  out.longPath.crumbIndicator = await page.evaluate(() => {
    const el = document.activeElement; const cs = getComputedStyle(el);
    return { tag: el.tagName, cls: String(el.className || "").slice(0, 30),
      outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor,
      boxShadow: cs.boxShadow === "none" ? "none" : cs.boxShadow.slice(0, 36),
      indicator: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" };
  });

  // C2. 超长路径输入 → 演示后端按设计拒绝（sftp_path_not_found）→ 留在编辑态 + 长错误 `.err`
  await page.evaluate(() => document.querySelector('[aria-label="切换路径输入"]')?.click());
  await page.waitForTimeout(350);
  if (await page.$('[data-testid="sftp-path-input"]')) {
    await page.fill('[data-testid="sftp-path-input"]', LONG_PATH);
    out.longPath.longInput = await page.evaluate(() => {
      const i = document.querySelector('[data-testid="sftp-path-input"]');
      const r = i.getBoundingClientRect();
      return { valueLen: i.value.length, sw: i.scrollWidth, cw: i.clientWidth,
        box: { w: +r.width.toFixed(0), h: +r.height.toFixed(0) } };
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1600);
    out.longPath.longInput.stillEditing = !!(await page.$('[data-testid="sftp-path-input"]'));
    out.longPath.longPathError = await page.evaluate((longPath) => {
      const e = [...document.querySelectorAll(".err")].find((x) => x.textContent.includes("路径不存在"));
      if (!e) return { found: false };
      const r = e.getBoundingClientRect();
      return { found: true, text: e.textContent,
        echoesFullPath: e.textContent.includes(longPath),
        overflowX: e.scrollWidth > e.clientWidth, sw: e.scrollWidth, cw: e.clientWidth,
        box: { x: +r.x.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0), r: +(r.x + r.width).toFixed(0) },
        inViewport: r.x >= 0 && r.x + r.width <= document.documentElement.clientWidth };
    }, LONG_PATH);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, "longpath-error.png") });

  out.notes.push({ pageErrors: errs.slice(0, 5) });
  out.run.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, "e03-raw.json"), JSON.stringify(out, null, 1));
  await browser.close();
  console.log(JSON.stringify({ ok: true, attempts, ipv6Rejected: out.ipv6.rejected,
    longHost: !!out.longHost?.card, longError: out.longError.found,
    crumbs: !!out.longPath.crumbs?.found, longPathError: !!out.longPath.longPathError?.found,
    cardIndicatorViaTab: out.keyboard.cardIndicatorViaTab }, null, 1));
})().catch((e) => { console.error("probe failed:", e.message, "\n", e.stack); process.exit(2); });
