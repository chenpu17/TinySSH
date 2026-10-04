// T42（v1.40）FR-8 端口转发走查（浏览器 demo）：
//  1. 无会话占位文案；连本机后表单出现
//  2. 表单校验：非法端口/空主机报 toast，不加行
//  3. 本地 -L / 远程 -R / SOCKS5 -D 三类行渲染（徽标/目标串/监听中/✓）
//  4. -D 时目标主机输入隐藏；启动后表单清空
//  5. 停止：行移除；按 sid 归属——切会话清空、切回恢复
//  6. 审计：forward_start / forward_stop 进时间线
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
  const fwdSec = () => page.locator('.section:has(h4:text("端口转发"))');

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // ── 1. 无会话占位 ──
  const ph = await fwdSec().textContent();
  check("no-session-placeholder", (ph ?? "").includes("连接 SSH 会话后可建本地"), ph?.slice(0, 40));

  // 连接本机
  await page.click('.host-card:has-text("本机") .host-card-main', { position: { x: 12, y: 12 } });
  await page.waitForSelector('.tab:has-text("本机")', { timeout: 8000 });
  await fwdSec().locator("button:has-text(\"启动\")").waitFor({ timeout: 8000 });
  check("form-visible", true);

  // ── 视觉复验 R1/R3 回归锁：-L 表单不挤压（启动按钮与下拉同 y、目标主机框 ≥80px）──
  const geo = await fwdSec().evaluate((sec) => {
    const sel = sec.querySelector("select");
    const btn = [...sec.querySelectorAll("button")].find((b) => b.textContent === "启动");
    const host = sec.querySelector('input[placeholder="目标主机"]');
    const r = (el) => el.getBoundingClientRect();
    return { selY: r(sel).y, btnY: r(btn).y, hostW: r(host).width, selH: r(sel).height, hostH: r(host).height };
  });
  check("form-layout-no-squeeze", Math.abs(geo.selY - geo.btnY) < 4 && geo.hostW >= 80,
    `按钮y差${Math.abs(geo.selY - geo.btnY).toFixed(0)}px 主机框宽${geo.hostW.toFixed(0)}px`);
  check("form-control-height-aligned", Math.abs(geo.selH - geo.hostH) < 1, `select${geo.selH.toFixed(1)} vs input${geo.hostH.toFixed(1)}`);

  // ── 2. 校验：非法端口 → toast，不加行 ──
  const portInput = fwdSec().locator("input").first();
  await portInput.fill("notaport");
  await fwdSec().locator("button:has-text(\"启动\")").click();
  await page.waitForSelector(".toast.err", { timeout: 8000 });
  const t1 = await page.$eval(".toast.err", (el) => el.textContent ?? "");
  check("invalid-port-toast", t1.includes("1–65535"), t1);
  check("no-row-on-invalid", (await fwdSec().locator(".fwd-row").count()) === 0);

  // ── 3. 本地 -L：18080 → 10.0.0.5:80 ──
  await portInput.fill("18080");
  await fwdSec().locator('input[placeholder="目标主机"]').fill("10.0.0.5");
  await fwdSec().locator('input[placeholder="端口"]').fill("80");
  await fwdSec().locator("button:has-text(\"启动\")").click();
  await page.waitForSelector(".fwd-row", { timeout: 8000 });
  const localRow = await page.$eval(".fwd-row", (el) => el.textContent ?? "");
  const localBadge = await page.$eval(".fwd-row .fwd-kind", (el) => el.textContent ?? "");
  // 视觉复验 R2 回归锁：徽标描边真实渲染（--line 未定义曾使 border 整条失效）
  const badgeBorder = await page.$eval(".fwd-row .fwd-kind", (el) => getComputedStyle(el).borderTopWidth);
  check("badge-border-rendered", badgeBorder !== "0px", `borderTopWidth=${badgeBorder}`);
  check("local-row-text", localRow.includes("127.0.0.1:18080 → 10.0.0.5:80"), localRow.replace(/\s+/g, " ").slice(0, 60));
  check("local-row-state", localRow.includes("监听中") && localBadge.trim() === "-L", `${localBadge}/${localRow.includes("监听中")}`);

  // 表单已清空
  const pv = await portInput.inputValue();
  check("form-reset-after-start", pv === "", `残留=${pv}`);

  // ── 4. 远程 -R：2223 → 127.0.0.1:9527 ──
  await fwdSec().locator("select").selectOption("Remote");
  await portInput.fill("2223");
  await fwdSec().locator('input[placeholder="回到本机·主机"]').fill("127.0.0.1");
  await fwdSec().locator('input[placeholder="端口"]').fill("9527");
  await fwdSec().locator("button:has-text(\"启动\")").click();
  await fwdSec().locator(".fwd-row").nth(1).waitFor({ timeout: 8000 });
  const remoteRow = await fwdSec().locator(".fwd-row").nth(1).textContent();
  check("remote-row-text", remoteRow.includes("远端 :2223 → 本地 127.0.0.1:9527"), remoteRow.replace(/\s+/g, " ").slice(0, 60));

  // ── 5. SOCKS5 -D：11080（目标主机输入应隐藏）──
  await fwdSec().locator("select").selectOption("Dynamic");
  await page.waitForTimeout(100);
  const hostInputs = await fwdSec().locator('input[placeholder="目标主机"], input[placeholder="回到本机·主机"]').count();
  check("dynamic-hides-host-input", hostInputs === 0);
  await portInput.fill("11080");
  await fwdSec().locator("button:has-text(\"启动\")").click();
  await fwdSec().locator(".fwd-row").nth(2).waitFor({ timeout: 8000 });
  const dynRow = await fwdSec().locator(".fwd-row").nth(2).textContent();
  const dynBadge = await fwdSec().locator(".fwd-row").nth(2).locator(".fwd-kind").textContent();
  check("dynamic-row-text", dynRow.includes("SOCKS5 127.0.0.1:11080") && dynBadge.trim() === "-D", dynRow.replace(/\s+/g, " ").slice(0, 60));

  // ── 6. 停止 -L：行移除，剩 2 行 ──
  await page.locator('.fwd-row:has-text("127.0.0.1:18080")').locator('button[title="停止转发"]').click();
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent === "端口转发");
    return sec ? [...sec.querySelectorAll(".fwd-row")].length === 2 : false;
  }, null, { timeout: 8000 }).then(
    () => check("stop-removes-row", true),
    () => check("stop-removes-row", false, "停止后行数 ≠ 2"),
  );

  // ── 7. 审计：forward_start / forward_stop 已入时间线 ──
  await page.waitForFunction(() => {
    const tl = [...document.querySelectorAll(".tl-row")];
    return tl.some((r) => (r.getAttribute("title") ?? "").includes("forward_start"))
        && tl.some((r) => (r.getAttribute("title") ?? "").includes("forward_stop"));
  }, null, { timeout: 8000 }).then(
    () => check("audit-forward-events", true),
    () => check("audit-forward-events", false, "时间线无 forward_start/forward_stop"),
  );

  // ── 8. 按 sid 归属：连第二台（prod-1，种子已信任免指纹门）→ 转发清空 ──
  await page.click('.host-card:has-text("prod-1") .host-card-main', { position: { x: 12, y: 12 } });
  await page.waitForSelector('.tab:has-text("prod-1")', { timeout: 8000 });
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent === "端口转发");
    return sec ? [...sec.querySelectorAll(".fwd-row")].length === 0 : false;
  }, null, { timeout: 8000 }).then(
    () => check("sid-ownership-second-session-empty", true),
    () => check("sid-ownership-second-session-empty", false, "切会话后转发未清空"),
  );
  // 切回本机 → 2 行恢复（点 .tab-label：tab 中点会落在分屏图标上误入分屏）
  await page.click('.tab:has-text("本机") .tab-label');
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent === "端口转发");
    return sec ? [...sec.querySelectorAll(".fwd-row")].length === 2 : false;
  }, null, { timeout: 8000 }).then(
    () => check("sid-ownership-switch-back-restored", true),
    () => check("sid-ownership-switch-back-restored", false, "切回后 2 条转发未恢复"),
  );

  await page.screenshot({ path: "../docs/acceptance/screenshots/t42_port_forward.png" });
  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - fails} PASS / ${fails} FAIL`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
