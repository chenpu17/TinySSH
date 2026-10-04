// T44 修复批复验（第二项）：审批卡「编辑后批准」按 editable 门控（App.tsx a.editable &&）。
// 用法：node t44_editable_verify.cjs [--docker-editable=false]
//   默认（种子态）期望：两张 pending exec 卡都有编辑钮；
//   --docker-editable=false 期望：docker 卡编辑钮消失，批准/拒绝仍在，rm -rf 对照卡不受影响。
// 前置：docker 卡 editable 由 demo.ts 临时改动控制（验证后还原，git diff 须为空）。
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const SHOT_DIR = "../docs/acceptance/screenshots";
const dockerEditable = !process.argv.includes("--docker-editable=false");

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 10000 });

  // 审批面板在右栏常驻（demo 种子：2 pending exec + 1 voided）
  const rmCard = page.locator('.card:has-text("rm -rf /tmp/old-build")').first();
  const dockerCard = page.locator('.card:has-text("docker system prune")').first();
  await rmCard.waitFor({ timeout: 10000 });
  await dockerCard.waitFor({ timeout: 10000 });

  const cardProbe = (card) => card.evaluate((el) => {
    const btnTexts = [...el.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    return {
      cmd: (el.querySelector(".cmd")?.textContent ?? "").trim(),
      approve: btnTexts.some((t) => t === "批准" || t === "再次点击确认批准"),
      edit: btnTexts.some((t) => t === "编辑后批准"),
      deny: btnTexts.some((t) => t === "拒绝"),
      btns: btnTexts.join("|"),
    };
  });
  const rm = await cardProbe(rmCard);
  const dk = await cardProbe(dockerCard);

  // ① 种子态：两张 pending exec 卡齐备三钮
  check("two-pending-exec-cards", rm.cmd.includes("rm -rf /tmp/old-build") && dk.cmd.includes("docker system prune -f"), `rm="${rm.cmd.slice(0, 24)}" docker="${dk.cmd.slice(0, 24)}"`);
  check("rm-card-pending-buttons", rm.approve && rm.deny, `btns=${rm.btns}`);
  check("docker-card-pending-buttons", dk.approve && dk.deny, `btns=${dk.btns}`);
  check("rm-card-edit-button", rm.edit === true, `btns=${rm.btns}（对照卡）`);
  check("docker-card-edit-gated", dk.edit === dockerEditable, `期望=${dockerEditable} 实际=${dk.edit} btns=${dk.btns}`);
  // editable=false 只遮编辑钮：批准/拒绝必须在（门控不得误伤）
  if (!dockerEditable) {
    check("docker-card-still-decidable", dk.approve && dk.deny, `btns=${dk.btns}`);
  }

  // 截图留证：右栏审批滚动区（页面有多个 .scroll——左栏也用同名类，须从「审批」面板标题锚定）
  const approvalScroll = page.locator('div.col:has(> .panel-title span:text("审批")) > .scroll');
  const shot = dockerEditable ? "t44_editable_default.png" : "t44_editable_docker_false.png";
  await approvalScroll.screenshot({ path: `${SHOT_DIR}/${shot}` });
  results.push(`INFO screenshot: docs/acceptance/screenshots/${shot}`);

  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} PASS / ${fails} FAIL`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("VERIFY ERROR:", e.message); process.exit(1); });
