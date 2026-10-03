// T38 细节控视觉回归走查：列表态/会话三栏/任务目标区/Toast/浅色主题/Timeline
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const OUT = "/tmp";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const shot = (n) => page.screenshot({ path: `${OUT}/pv_polish_${n}.png` });

  await page.goto("http://localhost:5183", { waitUntil: "domcontentloaded" });

  // --- 1. skeleton 首载占位：尽快截一帧
  const skelCountEarly = await page.locator(".skel, .skeleton, [class*='skel']").count();
  await shot("01_skeleton");
  console.log("skeleton early count:", skelCountEarly);

  await page.waitForSelector(".host-card", { timeout: 8000 });
  await page.waitForTimeout(400);
  const skelAfter = await page.locator(".skel, .skeleton, [class*='skel']").count();
  console.log("skeleton after load:", skelAfter);
  await shot("02_list_initial");

  // hover 主机行 → 操作组浮现
  const row = page.locator(".host-card").first();
  await row.hover();
  await page.waitForTimeout(300);
  await shot("03_list_hover");
  // 移开 hover → 应恢复干净
  await page.mouse.move(640, 60);
  await page.waitForTimeout(300);
  await shot("04_list_unhover");

  // --- 2. 接入会话 prod-1
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForSelector(".goal-input", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector(".goal-input").value.length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await shot("05_session_dark");

  // 三栏宽度实测
  const cols = await page.evaluate(() => {
    const pick = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : null; };
    return {
      left: pick(".side, .sidebar, .hosts-pane, [class*='side']"),
      right: pick(".brief, .right-pane, [class*='brief']"),
      goalTitle: !!document.querySelector(".goal-input"),
    };
  });
  console.log("columns:", JSON.stringify(cols));

  // --- 3. 任务目标输入框：聚焦态 + placeholder 对比度（先清空看 placeholder）
  const goalInput = page.locator(".goal-input");
  await goalInput.click();
  await page.waitForTimeout(200);
  await shot("06_goal_focus_filled");

  // placeholder 对比度：清空后测 ::placeholder 颜色 vs 输入框底色
  await page.locator("button", { hasText: /^清除$/ }).click().catch(() => {});
  await page.waitForTimeout(500);
  await goalInput.click();
  await page.waitForTimeout(200);
  const contrast = await page.evaluate(() => {
    const el = document.querySelector(".goal-input");
    if (!el) return null;
    const ph = getComputedStyle(el, "::placeholder").color;
    const bg = getComputedStyle(el).backgroundColor;
    const lum = (c) => {
      const m = c.match(/[\d.]+/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const L1 = lum(ph), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    return { ph, bg, ratio: Math.round(ratio * 100) / 100 };
  });
  console.log("placeholder contrast:", JSON.stringify(contrast));
  await shot("07_goal_placeholder");

  // 保存/清除按钮层级截图（输入内容让两按钮同屏）
  await goalInput.fill("核实 /var/log/nginx 磁盘占用，超过 90% 就归档旧日志");
  await page.waitForTimeout(200);
  await shot("08_goal_buttons");

  // --- 4. Toast：接管 → 右下角 toast；保存目标 → 第二条 toast 堆叠
  const takeoverBtn = page.locator("button", { hasText: /^接管$/ }).first();
  const hasTakeover = await takeoverBtn.count();
  console.log("takeover btn:", hasTakeover);
  if (hasTakeover) {
    await takeoverBtn.click();
    // 可能有确认弹窗
    const confirm = page.locator("button", { hasText: /确认|确定|接管/ }).last();
    await page.waitForTimeout(400);
    await shot("09_takeover_dialog_or_toast");
  }
  // 保存目标 → toast
  const saveBtn = page.locator("button", { hasText: /^保存$/ });
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(250);
    await shot("10_toast_stacked");
    const toastCount = await page.locator(".toast").count();
    console.log("toast count right after save:", toastCount);
    // 等自动消失
    await page.waitForTimeout(3200);
    const toastAfter = await page.locator(".toast").count();
    console.log("toast count after 3.2s:", toastAfter);
    await shot("11_toast_gone");
  }

  // --- 6. Timeline：更新任务目标条目
  const tlGoal = await page.locator(".tl-row", { hasText: "更新任务目标" }).count();
  console.log("timeline goal rows:", tlGoal);
  // 滚动右栏到底部让 Timeline 可见
  await page.evaluate(() => {
    const els = document.querySelectorAll(".tl-row");
    if (els.length) els[els.length - 1].scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
  await shot("12_timeline");

  // --- 5. 浅色主题：显示设置 → 浅色
  await page.locator("button[aria-label='显示设置']").click();
  await page.waitForTimeout(300);
  await shot("13_settings_pop");
  const lightOpt = page.locator(".ts-opt", { hasText: /^浅色$/ }).first();
  if (await lightOpt.count()) {
    await lightOpt.click();
    await page.waitForTimeout(500);
    await shot("14_light_session");
    // 浅色下 placeholder 对比度
    const contrastL = await page.evaluate(() => {
      const el = document.querySelector(".goal-input");
      if (!el) return null;
      const ph = getComputedStyle(el, "::placeholder").color;
      const bg = getComputedStyle(el).backgroundColor;
      return { ph, bg };
    });
    console.log("light placeholder colors:", JSON.stringify(contrastL));
    // 回列表看浅色列表态
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator("button[aria-label='显示设置']").click().catch(() => {}); // 关弹层
    await page.waitForTimeout(200);
    await shot("15_light_after");
  } else {
    console.log("light theme option NOT FOUND");
  }

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
