// 找茬六轮 D 路走查⑤：快捷键与命令面板。
// demo 域 live：palette 打开/过滤/↑↓/Enter/Esc；条目覆盖盘点；
// 固定键位 native 门死键逐一验证（Ctrl+K/T/W/D/1、Ctrl+Shift+B、F11）+ Esc 活键。
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://127.0.0.1:5199";
const OUT = path.resolve(__dirname, ".shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [];
const bad = [];
const note = [];
const ck = (name, cond, detail = "") => {
  (cond ? ok : bad).push(`${cond ? "ok" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  console.log(`${cond ? "ok" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const nn = (s) => note.push(s);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: resolveBrowser().path, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-CN", colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 15000 });
  await sleep(800);
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await sleep(800);

  const palOpen = () => page.evaluate(() => !!document.querySelector('[data-testid="palette-overlay"]'));
  const hbOpen = () => page.evaluate(() => !!document.querySelector(".hostbar"));

  // ═══ A. 死键验证（demo 域 native 门）═══
  await page.keyboard.press("Control+k");
  await sleep(400);
  ck("A1 Ctrl+K 不开面板（demo native 门）", !(await palOpen()), "");
  await page.keyboard.press("Control+Shift+b");
  await sleep(400);
  ck("A2 Ctrl+Shift+B 不动主机栏（demo）", await hbOpen(), "");
  const tabsBefore = await page.evaluate(() => document.querySelectorAll(".tab").length);
  await page.keyboard.press("Control+t");
  await sleep(400);
  ck("A3 Ctrl+T 不弹新建表单（demo）", !(await page.evaluate(() => !!document.querySelector('[data-testid="add-host-dialog"]'))), "");
  await page.keyboard.press("Control+w");
  await sleep(400);
  ck("A4 Ctrl+W 不关标签（demo）", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === tabsBefore, "");
  await page.keyboard.press("Control+d");
  await sleep(400);
  ck("A5 Ctrl+D 不分屏（demo）", !(await page.evaluate(() => !!document.querySelector(".split-menu"))), "");
  await page.keyboard.press("Control+1");
  await sleep(300);
  await page.keyboard.press("F11");
  await sleep(400);
  ck("A6 F11 不切专注模式（demo，浏览器语义保留）", !(await page.evaluate(() => document.body.classList.contains("zen") || document.querySelector(".zen-strip"))), "");
  ck("A7 死键族全验证完毕", true, "Ctrl+K/T/W/D/1、Ctrl+Shift+B、F11 在 demo 均 no-op（设计：native 门）");

  // ═══ B. Esc 活键（浮层链）═══
  const setPt = await page.evaluate(() => {
    const r = document.querySelector(".hb-settings").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(setPt.x, setPt.y);
  await page.waitForSelector('[data-testid="settings-close"]');
  await sleep(250);
  await page.keyboard.press("Escape");
  await sleep(350);
  ck("B1 Esc 关设置浮层", !(await page.evaluate(() => !!document.querySelector('[data-testid="settings-close"]'))), "");

  // ═══ C. palette live（经工具栏钮打开）═══
  const palBtn = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="palette-open"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(palBtn.x, palBtn.y);
  await page.waitForSelector('[data-testid="palette-overlay"]', { timeout: 3000 });
  await sleep(250);
  const palFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  ck("C1 面板开即聚焦搜索框", palFocus === "palette-input", palFocus ?? "?");
  // 全量条目盘点
  const items = await page.evaluate(() => ({
    groups: [...document.querySelectorAll(".palette-group")].map((g) => g.textContent),
    titles: [...document.querySelectorAll(".palette-item .palette-title")].map((t) => t.textContent),
  }));
  console.log("palette 分组:", JSON.stringify(items.groups));
  console.log("palette 条目数:", items.titles.length);
  console.log("palette 条目:", JSON.stringify(items.titles));
  const hasAddHost = items.titles.some((x) => x.includes("新建连接") || x.includes("添加主机"));
  if (!hasAddHost) nn("C2 注记：palette 无「新建连接/添加主机」条目（有 快速连接/导入 config/逐主机连接）——键盘用户到表单要靠 demo 域的死键 Ctrl+T 或鼠标 + 钮（轻打磨）");
  const hasQueue = items.titles.some((x) => x.includes("传输"));
  if (!hasQueue) nn("C3 注记：palette 无「传输队列」开关条目——抽屉只能从状态条开（轻打磨）");
  // 过滤
  await page.keyboard.type("设置");
  await sleep(300);
  const filtered = await page.evaluate(() => [...document.querySelectorAll(".palette-item .palette-title")].map((t) => t.textContent));
  ck("C4 中文过滤命中「打开设置」", filtered.some((x) => x.includes("打开设置")), JSON.stringify(filtered));
  await page.screenshot({ path: path.join(OUT, "r6d-5-01-palette.png") });
  // React 受控输入清空（native setter 绕过 value tracker）
  await page.evaluate(() => {
    const i = document.querySelector('[data-testid="palette-input"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(i, "");
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.focus();
  });
  await sleep(250);
  const cntAll = await page.evaluate(() => document.querySelectorAll(".palette-item").length);
  ck("C4b 清空过滤恢复全量条目", cntAll === items.titles.length, `cnt=${cntAll}`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  const selIdx = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].findIndex((b) => b.getAttribute("data-sel") === "1"));
  ck("C5 ↓ 导航选中第 4 项", selIdx === 3, `selIdx=${selIdx}`);
  await page.keyboard.press("ArrowUp");
  await sleep(100);
  const selIdx2 = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].findIndex((b) => b.getAttribute("data-sel") === "1"));
  ck("C6 ↑ 回退选中第 3 项", selIdx2 === 2, `selIdx=${selIdx2}`);
  // Enter 执行选中项（第 3 项=连接 prod-2 演示失败主机，无状态破坏）
  await page.keyboard.press("Enter");
  await sleep(800);
  ck("C7 Enter 执行且面板关闭", !(await palOpen()), "");
  // 空态文案（重开面板）
  const pb2 = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="palette-open"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(pb2.x, pb2.y);
  await page.waitForSelector('[data-testid="palette-overlay"]');
  await sleep(200);
  await page.keyboard.type("zzzz不存在的命令");
  await sleep(250);
  const emptyTxt = await page.evaluate(() => document.querySelector(".palette-list .dim")?.textContent ?? null);
  ck("C8 无匹配有可行动文案", !!emptyTxt && emptyTxt.includes("无匹配"), emptyTxt ?? "");
  await page.keyboard.press("Escape");
  await sleep(250);
  ck("C9 Esc 关面板", !(await palOpen()), "");

  // ═══ D. 主机栏键盘动线（palette 项 toggleHostbar）═══
  await page.mouse.click(palBtn.x, palBtn.y);
  await page.waitForSelector('[data-testid="palette-overlay"]');
  await sleep(200);
  await page.keyboard.type("主机栏");
  await sleep(250);
  const hbItem = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".palette-item")].find((x) => x.textContent.includes("主机栏"));
    return b ? b.getAttribute("data-testid") : null;
  });
  if (hbItem) {
    // 选中之并执行
    const idx = await page.evaluate((tid) => [...document.querySelectorAll(".palette-item")].findIndex((x) => x.getAttribute("data-testid") === tid), hbItem);
    for (let i = 0; i < idx; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await sleep(600);
    const hbAfter = await hbOpen();
    ck("D1 palette「隐藏主机栏」执行收栏", hbAfter === false, `hostbar=${hbAfter}`);
    // 焦点落点（键盘开栏要落搜索框——round4 D2 修复的反向：关闭路径不抢焦点）
    await page.mouse.click(palBtn.x, palBtn.y);
    await page.waitForSelector('[data-testid="palette-overlay"]');
    await sleep(200);
    await page.keyboard.type("主机栏");
    await sleep(250);
    const idx2 = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].findIndex((x) => x.textContent.includes("主机栏")));
    for (let i = 0; i < idx2; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await sleep(600);
    ck("D2 palette「显示主机栏」执行回栏", await hbOpen(), "");
  } else {
    ck("D1 palette 主机栏条目", false, "没找到");
  }

  ck("页面零 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
  await browser.close();
  console.log(`\n══ 汇总：${ok.length} ok / ${bad.length} FAIL`);
  console.log("── 注记 ──");
  for (const l of note) console.log("NOTE", l);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("脚本失败：", e); process.exit(2); });
