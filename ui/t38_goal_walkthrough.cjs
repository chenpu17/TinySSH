// T38 R9 走查：任务目标（委托留言）全链路——种子目标上屏、编辑保存、toast、审计留痕、清除
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const OUT = "/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/screenshots";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:5183", { waitUntil: "networkidle" });

  // 1. 接入种子会话 s-demo-0001（prod-1 标签页；种子目标随它）
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForSelector(".goal-input", { timeout: 5000 });
  // 等简报回填种子目标（goal-input 先于 brief 出现）
  await page.waitForFunction(() => document.querySelector(".goal-input").value.length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(300);

  // 断言 1：种子目标（s-demo-0001）回填输入框
  const seed = await page.locator(".goal-input").inputValue();
  console.log("ASSERT seed-goal:", seed.includes("old-build") ? "PASS" : `FAIL (${seed})`);

  await page.screenshot({ path: `${OUT}/t38_goal_seeded.png` });

  // 2. 编辑并保存 → toast + 审计事件
  await page.locator(".goal-input").fill("核实 /var/log/nginx 磁盘占用，超过 90% 就归档旧日志");
  await page.locator("button", { hasText: /^保存$/ }).click();
  await page.waitForTimeout(600);
  const toast = await page.locator(".toast.ok").last().textContent().catch(() => "");
  console.log("ASSERT save-toast:", (toast || "").includes("任务目标已更新") ? "PASS" : `FAIL (${toast})`);
  const auditRow = await page.locator(".tl-row", { hasText: "更新任务目标" }).count();
  console.log("ASSERT audit-goal_set:", auditRow > 0 ? "PASS" : "FAIL");

  // 断言 2：简报 goal 字段同步（刷新后输入框=新值）
  const after = await page.locator(".goal-input").inputValue();
  console.log("ASSERT saved-value:", after.includes("磁盘占用") ? "PASS" : `FAIL (${after})`);

  await page.screenshot({ path: `${OUT}/t38_goal_saved.png` });

  // 3. 清除 → toast + 按钮消失
  await page.locator("button", { hasText: /^清除$/ }).click();
  await page.waitForTimeout(600);
  const cleared = await page.locator(".goal-input").inputValue();
  console.log("ASSERT cleared:", cleared === "" ? "PASS" : `FAIL (${cleared})`);
  const clearBtn = await page.locator("button", { hasText: /^清除$/ }).count();
  console.log("ASSERT clear-btn-gone:", clearBtn === 0 ? "PASS" : "FAIL");
  const clearAudit = await page.locator(".tl-row", { hasText: "更新任务目标" }).count();
  console.log("ASSERT clear-audit-count>=2:", clearAudit >= 2 ? "PASS" : `FAIL (${clearAudit})`);

  await browser.close();
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
