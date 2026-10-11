// UX 第二轮精修：现状审计截图（2x 渲染，含局部裁切与真实终端内容注入）。
// 输出到 .ux-shots/r2/；每个步骤失败不中断，最后统一报 pageErrors。
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const OUT = process.env.SHOT_DIR || "D:/workspace/tiny-ssh/.ux-shots/r2";
const fs = require("fs");
fs.mkdirSync(OUT, { recursive: true });

// 真实感终端输出：彩色提示符 / ls / git 图 / 进度条 / 框线 / CJK 混排 / 256 色带
function showcasePayload() {
  const L = [];
  for (let i = 1; i <= 240; i++) L.push(`\x1b[90m${String(i).padStart(4)}\x1b[0m  history filler line — scroll me`);
  L.push("\x1b[1;32m➜\x1b[0m  \x1b[1;36m~/deploy\x1b[0m  \x1b[31mmain\x1b[0m \x1b[33m✚2\x1b[0m \x1b[90m⇡1\x1b[0m");
  L.push("$ ls -la --color=auto");
  L.push("drwxr-xr-x  \x1b[34m.\x1b[0m          drwxr-xr-x  root  4.0K \x1b[90mOct 10 09:12\x1b[0m");
  L.push("-rw-r--r--  app.yml       \x1b[33m2.1K\x1b[0m \x1b[90mOct 10 08:57\x1b[0m");
  L.push("-rwxr-xr-x  \x1b[1;32mdeploy.sh\x1b[0m   \x1b[33m8.4K\x1b[0m \x1b[90mOct  9 22:41\x1b[0m");
  L.push("drwxr-xr-x  \x1b[1;34m中文目录名\x1b[0m  root  4.0K  \x1b[90mOct  9 21:03\x1b[0m");
  L.push("$ git log --oneline --graph -6");
  L.push("\x1b[33m*\x1b[0m \x1b[36ma66a950\x1b[0m UX-R1 G5 证据归档");
  L.push("\x1b[33m*\x1b[0m \x1b[36m11ce738\x1b[0m 清理 .gitignore 残留");
  L.push("\x1b[33m*\x1b[0m \x1b[36mf65a8b8\x1b[0m 移除开发期 UI 开关");
  L.push("$ systemctl status tinyshhd");
  L.push("\x1b[1;32m●\x1b[0m tinyshhd.service - \x1b[1mtinyssh demo daemon\x1b[0m");
  L.push("   Active: \x1b[1;32mactive (running)\x1b[0m since Thu 2026-10-10 09:12:41 CST");
  L.push("CPU \x1b[32m███████████\x1b[90m░░░░░░░\x1b[0m 58%   MEM \x1b[33m██████\x1b[90m░░░░░░░░░░\x1b[0m 34%");
  L.push("┌─ \x1b[1mdeploy plan\x1b[0m ─────────────────────────┐");
  L.push("│  host   prod-1   canary \x1b[32mok\x1b[0m    │");
  L.push("│  host   prod-2   canary \x1b[31mfail\x1b[0m  │");
  L.push("└────────────────────────────────┘");
  let grad = "";
  for (let i = 0; i < 48; i++) grad += `\x1b[48;5;${16 + i * 4}m \x1b[0m`;
  L.push(grad);
  L.push("中文与 ASCII 混排 width check：abcdefg 甲乙丙丁 1234567");
  L.push("\x1b[1;32m➜\x1b[0m  \x1b[1;36m~/deploy\x1b[0m ");
  return L.join("\r\n");
}

(async () => {
  const { path: executablePath, source } = resolveBrowser();
  console.log(`browser: ${source} ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });

  // 1) 欢迎页（深色）
  await page.goto(`${BASE}/?fresh`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.waitForTimeout(300);
  await shot("welcome-dark");

  // 2) 主界面（深色）
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.waitForTimeout(500);
  await shot("main-dark");
  const hostCard = await page.$(".hostbar .hb-card, .hostbar .host-card");
  if (hostCard) await shot("crop-hostcard", { clip: await hostCard.boundingBox().then(b => ({ x: b.x - 8, y: b.y - 8, width: Math.min(b.width + 16, 460), height: Math.min(b.height + 16, 320) })) });

  // 3) 会话视图 + 注入内容（深色）
  await page.click('.tab .tab-label:text-is("prod-1")').catch(() => {});
  await page.waitForTimeout(900);
  const wrote = await page.evaluate((payload) => {
    const sid = document.querySelector(".term-session.active")?.dataset.sid;
    const term = sid && window.__t_terms?.get(sid);
    if (!term) return false;
    term.write(payload);
    return true;
  }, showcasePayload());
  console.log(`terminal content injected: ${wrote}`);
  await page.waitForTimeout(800);
  await shot("session-dark");
  const tabbar = await page.$(".tabbar-row");
  if (tabbar) await shot("crop-tabbar", { clip: await tabbar.boundingBox() });
  const tw = await page.$(".term-wrap");
  if (tw) {
    const b = await tw.boundingBox();
    await shot("crop-term-topleft", { clip: { x: b.x, y: b.y, width: Math.min(b.width, 760), height: Math.min(b.height, 420) } });
    await shot("crop-term-bottomright", { clip: { x: b.x + b.width - 560, y: b.y + b.height - 300, width: 560, height: 300 } });
  }

  // 4) 终端内搜索条 + 设置对话框（深色）
  await page.keyboard.press("Control+f").catch(() => {});
  await page.waitForTimeout(400);
  await shot("session-search-dark");
  await page.keyboard.press("Escape").catch(() => {});
  await page.click(".hb-settings").catch(() => {});
  await page.waitForTimeout(500);
  await shot("settings-dark");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // 5) 浅色：主界面 + 会话
  await page.evaluate(() => { document.documentElement.dataset.chrome = "light"; });
  await page.waitForTimeout(400);
  await shot("session-light");
  await shot("main-light");

  console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
  await browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
