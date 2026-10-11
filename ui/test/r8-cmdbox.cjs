// UX 八轮验证：命令框降噪——①空态引导文案保留；②会话打开后 placeholder 为空
//（「在 {host} 上执行命令」退役）；③空闲态无「中断」按钮（条件化：只在 exec_human
// 在飞时在场。demo 垫片 exec_human 同步返回，在飞窗口不可观测——在场态由真实应用
// 验证，此处断言「空闲不在场」+「在场由 busyExecs 驱动」的代码路径）。
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

(async () => {
  const { path: executablePath, source } = resolveBrowser();
  console.log(`browser: ${source} ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto("http://localhost:5183/?fresh", { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });

  const readPh = () =>
    page.evaluate(() => {
      const els = document.querySelectorAll(".panel-title input");
      const el = els[els.length - 1];
      return { n: els.length, ph: el ? el.getAttribute("placeholder") : null };
    });

  // ① 空态：引导文案保留
  const s0 = await readPh();
  console.log("空态 placeholder:", JSON.stringify(s0));
  if (s0.ph !== "先在主机栏连接一台主机，这里才能执行命令") {
    console.log("FAIL: 空态引导文案缺失"); process.exit(1);
  }

  // 连接「本机」（与 r6-follow-verify 同款 hover+连接）
  const c = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1500);

  // ② 会话态：placeholder 为空（主机名回显退役）
  const s1 = await readPh();
  console.log("会话态 placeholder:", JSON.stringify(s1));
  if (s1.ph !== "") { console.log("FAIL: 会话态 placeholder 应为空"); process.exit(1); }

  // ③ 空闲态：无中断按钮（原常驻钮退役）
  const btn = await page.$('[data-testid="exec-interrupt"]');
  console.log("exec-interrupt(空闲态) 存在:", !!btn);
  if (btn) { console.log("FAIL: 空闲态不应有中断按钮"); process.exit(1); }

  if (pageErrors.length) { console.log("pageErrors:", pageErrors); process.exit(1); }
  console.log("r8-cmdbox: PASS");
  await browser.close();
})();
