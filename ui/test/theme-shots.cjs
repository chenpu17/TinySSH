// 主题色板批次：全色板×深浅截图（2x）。data-theme 由页面内直设（等价 changePalette 的
// DOM 效果），输出 .ux-shots/themes/<palette>-<chrome>-<view>.png
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");
const fs = require("fs");

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";
const OUT = process.env.SHOT_DIR || ".ux-shots/themes";
fs.mkdirSync(OUT, { recursive: true });

// 主题⑤轮起全量 15 族（缺 neon/ink 的历史截图可按需单独补）
const PALETTES = [
  "graphite", "ember", "ocean", "violet", "noir",
  "aurora", "celadon", "sakura", "obsidian", "neon",
  "ink", "nord", "gruvbox", "tokyo", "mocha",
];

// 真实感终端输出（同 audit-shots，截断版）
function payload() {
  const L = [];
  for (let i = 230; i <= 240; i++) L.push(`\x1b[90m${String(i).padStart(4)}\x1b[0m  history filler line`);
  L.push("\x1b[1;32m➜\x1b[0m  \x1b[1;36m~/deploy\x1b[0m  \x1b[31mmain\x1b[0m \x1b[33m✚2\x1b[0m");
  L.push("$ ls -la --color=auto");
  L.push("drwxr-xr-x  \x1b[34m.\x1b[0m          drwxr-xr-x  root  4.0K \x1b[90mOct 10 09:12\x1b[0m");
  L.push("-rwxr-xr-x  \x1b[1;32mdeploy.sh\x1b[0m   \x1b[33m8.4K\x1b[0m \x1b[90mOct  9 22:41\x1b[0m");
  L.push("drwxr-xr-x  \x1b[1;34m中文目录名\x1b[0m  root  4.0K  \x1b[90mOct  9 21:03\x1b[0m");
  L.push("$ git log --oneline --graph -3");
  L.push("\x1b[33m*\x1b[0m \x1b[36ma66a950\x1b[0m UX-R1 G5 证据归档");
  L.push("\x1b[33m*\x1b[0m \x1b[36m11ce738\x1b[0m 清理 .gitignore 残留");
  L.push("CPU \x1b[32m███████████\x1b[90m░░░░░░░\x1b[0m 58%   MEM \x1b[33m██████\x1b[90m░░░░░░░░░░\x1b[0m 34%");
  L.push("┌─ \x1b[1mdeploy plan\x1b[0m ─────────────────────────┐");
  L.push("│  host   prod-1   canary \x1b[32mok\x1b[0m    │");
  L.push("│  host   prod-2   canary \x1b[31mfail\x1b[0m  │");
  L.push("└────────────────────────────────┘");
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
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

  for (const pal of PALETTES) {
    // 深色：欢迎 / 会话 / 设置
    await page.goto(`${BASE}/?fresh`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.evaluate((p) => {
      document.documentElement.dataset.chrome = "dark";
      document.documentElement.dataset.theme = p;
    }, pal);
    await page.waitForTimeout(350);
    await shot(`${pal}-dark-welcome`);

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hostbar", { timeout: 10000 });
    await page.evaluate((p) => {
      document.documentElement.dataset.chrome = "dark";
      document.documentElement.dataset.theme = p;
    }, pal);
    await page.waitForTimeout(500);
    await page.click('.tab .tab-label:text-is("prod-1")').catch(() => {});
    await page.waitForTimeout(900);
    await page.evaluate((payload) => {
      const sid = document.querySelector(".term-session.active")?.dataset.sid;
      const term = sid && window.__t_terms?.get(sid);
      if (term) term.write(payload);
    }, payload());
    await page.waitForTimeout(800);
    await shot(`${pal}-dark-session`);

    await page.click(".hb-settings").catch(() => {});
    await page.waitForTimeout(500);
    await shot(`${pal}-dark-settings`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    // 浅色：欢迎 / 会话
    await page.evaluate((p) => {
      document.documentElement.dataset.chrome = "light";
      document.documentElement.dataset.theme = p;
    }, pal);
    await page.waitForTimeout(400);
    await shot(`${pal}-light-session`);
    await page.goto(`${BASE}/?fresh`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.evaluate((p) => {
      document.documentElement.dataset.chrome = "light";
      document.documentElement.dataset.theme = p;
    }, pal);
    await page.waitForTimeout(350);
    await shot(`${pal}-light-welcome`);
    console.log(`✓ ${pal}`);
  }
  console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
  await browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
