// 分屏⑥轮实拍：真实点击路径走「连会话 → 右键分屏 → 拖拽 → 旋转」，截左右/上下
// 分屏与菜单方向行的实貌。单发页面（避免复用竞态）、1x（xterm canvas 不玩 2x）。
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");
const fs = require("fs");
const BASE = process.env.TINYSSH_UI_BASE || "http://127.0.0.1:5183";
const OUT = ".ux-shots/split-r7";
fs.mkdirSync(OUT, { recursive: true });

function payload(tag) {
  const L = [];
  L.push(`$ ssh ${tag}  # \x1b[90m分屏对照\x1b[0m`);
  L.push("$ ls -la --color=auto");
  L.push("drwxr-xr-x  \x1b[34m.\x1b[0m  \x1b[90mOct 17\x1b[0m");
  L.push("-rwxr-xr-x  \x1b[1;32mdeploy.sh\x1b[0m  \x1b[33m8.4K\x1b[0m");
  L.push("$ echo \x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[33myellow\x1b[0m \x1b[34mblue\x1b[0m \x1b[35mmagenta\x1b[0m \x1b[36mcyan\x1b[0m");
  L.push(`\x1b[1;32m➜\x1b[0m  \x1b[1;36m~/${tag}\x1b[0m `);
  return L.join("\r\n");
}

(async () => {
  const { path: executablePath } = resolveBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN", colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });

  // 分屏菜单全景（方向行 + 会话列表）——先连本机让工具栏出现
  await page.click('.host-card:has(.host-name:text-is("本机")) button[title^="连接"]').catch(async () => {
    await page.hover('.host-card:has(.host-name:text-is("本机"))');
    await page.click('.host-card:has(.host-name:text-is("本机")) button[title^="连接"]');
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".session-toolbar button")].find((x) => (x.getAttribute("title") || "").includes("分屏"));
    b.click();
  });
  await page.waitForTimeout(400);
  await shot("01-split-menu-direction");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // 写主格负载（本机 = 活动会话）
  await page.evaluate((p) => {
    const sid = document.querySelector(".term-session.active")?.dataset.sid;
    window.__t_terms?.get(sid)?.write(p);
  }, payload("local"));
  await page.waitForTimeout(400);

  // 右键 staging-1 → 与当前会话分屏（默认左右）
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("staging-1"));
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 420, clientY: 130 }));
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("与当前会话分屏"));
    b.click();
  });
  await page.waitForTimeout(900);
  await page.evaluate((p) => {
    const sid = document.querySelector(".pane-right")?.dataset.sid;
    window.__t_terms?.get(sid)?.write(p);
  }, payload("staging"));
  await page.waitForTimeout(700);
  await shot("02-lr-split");

  // 拖分割条到 62%
  const c = await page.evaluate(() => {
    const r = document.querySelector(".pane-div").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: document.getElementById("term").getBoundingClientRect().width };
  });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + c.w * 0.12, c.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot("03-lr-dragged-62");

  // 旋转为上下分屏
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("staging-1"));
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 420, clientY: 130 }));
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("改为上下分屏"));
    b.click();
  });
  await page.waitForTimeout(900);
  await shot("04-tb-rotated");

  console.log("pageErrors:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
