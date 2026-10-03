// 交班专家走查（T38 R9）：任务目标/委托留言全链路 + 简报可读性
// 截图输出 /tmp/pv_handoff_*.png
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

const shot = (page, name) => page.screenshot({ path: `/tmp/pv_handoff_${name}.png` });
const log = (id, verdict, note) => console.log(`[${id}] ${verdict} :: ${note}`);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:5183", { waitUntil: "networkidle" });

  // ============ 任务1：接入 prod-1 种子会话，任务目标区出现 + 种子留言回填 ============
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForSelector(".goal-input", { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector(".goal-input").value.length > 0, null, { timeout: 5000 });
  await page.waitForTimeout(400);

  const goalSection = await page.locator(".section h4", { hasText: "任务目标" }).count();
  log("T1-section", goalSection > 0 ? "PASS" : "FAIL", `右栏「任务目标」区块 count=${goalSection}`);

  const seedGoal = await page.locator(".goal-input").inputValue();
  const seedOk = seedGoal.includes("old-build") && seedGoal.includes("build.tgz");
  log("T1-seed-backfill", seedOk ? "PASS" : "FAIL", `种子留言回填=「${seedGoal}」`);

  const sideNote = await page.locator(".goal-input").locator("..").locator(".side-quiet").textContent().catch(() => "");
  log("T1-side-note", "INFO", `辅助文案=「${(sideNote || "").trim()}」`);

  // 初始态保存按钮应为禁用（内容未变）
  const saveBtn = page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^保存$/ });
  const disabledInitial = await saveBtn.isDisabled();
  log("T2-save-disabled-initial", disabledInitial ? "PASS" : "FAIL", `内容未变时保存按钮 disabled=${disabledInitial}`);

  // 初始态清除按钮应出现（有种子目标）
  const clearBtn = page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^清除$/ });
  log("T4-clear-btn-visible-with-goal", (await clearBtn.count()) === 1 ? "PASS" : "FAIL", `有目标时清除按钮 count=${await clearBtn.count()}`);

  await shot(page, "01_seeded");

  // ============ 任务2：编辑并保存 → toast 即时反馈；保存后按钮回到禁用 ============
  const newGoal = "核实 /var/log/nginx 磁盘占用，超过 90% 就归档旧日志，完事交还控制权";
  await page.locator(".goal-input").fill(newGoal);
  const disabledAfterEdit = await saveBtn.isDisabled();
  log("T2-save-enabled-after-edit", !disabledAfterEdit ? "PASS" : "FAIL", `编辑后保存按钮 disabled=${disabledAfterEdit}`);

  await saveBtn.click();
  // toast 2.6s 自消，必须快取
  await page.waitForSelector(".toast", { timeout: 3000 }).catch(() => {});
  const toastText = await page.locator(".toast").last().textContent().catch(() => "");
  const toastCls = await page.locator(".toast").last().getAttribute("class").catch(() => "");
  log("T2-save-toast", (toastText || "").includes("任务目标已更新") ? "PASS" : "FAIL", `toast[${toastCls}]=「${(toastText || "").trim()}」`);

  await page.waitForTimeout(300);
  const savedVal = await page.locator(".goal-input").inputValue();
  log("T2-saved-value", savedVal === newGoal ? "PASS" : "FAIL", `保存后输入框=「${savedVal}」`);

  const disabledAfterSave = await saveBtn.isDisabled();
  log("T2-save-disabled-after-save", disabledAfterSave ? "PASS" : "FAIL", `保存成功后按钮回到 disabled=${disabledAfterSave}（防重复保存）`);

  await shot(page, "02_saved");

  // ============ 任务3：操作记录时间线出现「更新任务目标」条目 ============
  await page.waitForSelector(".tl-row", { timeout: 5000 }).catch(() => {});
  const goalRows = page.locator(".tl-row", { hasText: "更新任务目标" });
  const goalRowCount = await goalRows.count();
  log("T3-audit-row", goalRowCount > 0 ? "PASS" : "FAIL", `时间线「更新任务目标」条目数=${goalRowCount}`);
  if (goalRowCount > 0) {
    const rowText = (await goalRows.first().textContent() || "").trim();
    const rowTitle = await goalRows.first().getAttribute("title");
    log("T3-audit-row-content", "INFO", `条目文本=「${rowText}」 title=「${rowTitle}」`);
    // 时间线是否带 actor 与时间戳
    const hasActor = /我|Agent/.test(rowText);
    const hasTs = await goalRows.first().locator(".tl-meta").count();
    log("T3-audit-readability", hasActor && hasTs > 0 ? "PASS" : "FAIL", `含 actor=${hasActor} 含时间戳行=${hasTs > 0}`);
  }

  // ============ 任务5 前段：切到另一会话标签再切回，留言是否还在 ============
  // 先新建一个会话（点主机卡）作为第二个标签
  const tabsBefore = await page.locator(".tab").count();
  // 主机卡右侧悬浮操作组会遮挡点击，点卡片左侧主机名区域
  await page.locator(".host-card-main").first().click({ position: { x: 30, y: 15 } });
  await page.waitForTimeout(800);
  const tabsAfter = await page.locator(".tab").count();
  log("T5-new-session-tab", tabsAfter > tabsBefore ? "PASS" : "FAIL", `新建会话标签 ${tabsBefore}→${tabsAfter}`);

  // 新会话目标应为空 + 清除按钮不出现
  await page.waitForSelector(".goal-input", { timeout: 5000 });
  await page.waitForTimeout(600);
  const newGoalVal = await page.locator(".goal-input").inputValue();
  log("T5-new-session-goal-empty", newGoalVal === "" ? "PASS" : "FAIL", `新会话目标=「${newGoalVal}」`);
  const clearBtnNew = await page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^清除$/ }).count();
  log("T4-clear-btn-hidden-no-goal", clearBtnNew === 0 ? "PASS" : "FAIL", `无目标时清除按钮 count=${clearBtnNew}`);

  // 在新会话里打到一半的草稿（不保存）
  await page.locator(".goal-input").fill("（未保存草稿）待办：先看看磁盘");
  await shot(page, "03_draft_unsaved");

  // 切回种子会话标签 → 保存过的留言应还在
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForFunction(() => document.querySelector(".goal-input").value.length > 0, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const backGoal = await page.locator(".goal-input").inputValue();
  log("T5-goal-persists-across-tabs", backGoal === newGoal ? "PASS" : "FAIL", `切回种子会话后留言=「${backGoal}」`);

  // 再切到新会话标签 → 未保存草稿行为（报告实际行为）
  const otherTab = page.locator(".tab").nth(1);
  await otherTab.click();
  await page.waitForTimeout(600);
  const draftAfter = await page.locator(".goal-input").inputValue();
  log("T5-unsaved-draft-behavior", "INFO", `切走再回来后未保存草稿=「${draftAfter}」${draftAfter === "" ? "（草稿被丢弃，输入框恢复为已保存值空）" : "（草稿保留）"}`);
  await shot(page, "04_draft_after_switch");

  // 切回种子会话继续任务4
  await page.locator(".tab", { hasText: "prod-1" }).first().click();
  await page.waitForFunction(() => document.querySelector(".goal-input").value.length > 0, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  // ============ 任务4：清除目标 ============
  const clearBtn2 = page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^清除$/ });
  log("T4-clear-btn-before-clear", (await clearBtn2.count()) === 1 ? "PASS" : "FAIL", `清除前清除按钮 count=${await clearBtn2.count()}`);
  await clearBtn2.click();
  await page.waitForSelector(".toast", { timeout: 3000 }).catch(() => {});
  const clearToast = await page.locator(".toast").last().textContent().catch(() => "");
  log("T4-clear-toast", (clearToast || "").includes("任务目标已清除") ? "PASS" : "FAIL", `清除 toast=「${(clearToast || "").trim()}」`);
  await page.waitForTimeout(400);
  const clearedVal = await page.locator(".goal-input").inputValue();
  log("T4-cleared-input", clearedVal === "" ? "PASS" : "FAIL", `清除后输入框=「${clearedVal}」`);
  const clearBtnAfter = await page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^清除$/ }).count();
  log("T4-clear-btn-gone-after", clearBtnAfter === 0 ? "PASS" : "FAIL", `清除后清除按钮 count=${clearBtnAfter}`);
  const goalRowsAfterClear = await page.locator(".tl-row", { hasText: "更新任务目标" }).count();
  log("T4-clear-audit", goalRowsAfterClear >= 2 ? "PASS" : "FAIL", `清除留痕后「更新任务目标」条目数=${goalRowsAfterClear}（应≥2：保存+清除）`);
  // 清除后保存按钮：空 vs 空 → 应禁用
  const saveDisabledAfterClear = await page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^保存$/ }).isDisabled();
  log("T4-save-disabled-after-clear", saveDisabledAfterClear ? "PASS" : "FAIL", `清除后内容未变，保存按钮 disabled=${saveDisabledAfterClear}`);
  await shot(page, "05_cleared");

  // 恢复种子留言（保持现场，方便后续复核）——顺带验证再次保存链路
  await page.locator(".goal-input").fill("把 /tmp/old-build 清理掉并重新打包 dist 到 /tmp/build.tgz");
  await page.locator(".section", { has: page.locator(".goal-input") }).locator("button", { hasText: /^保存$/ }).click();
  await page.waitForTimeout(500);

  // ============ 任务6：现场简报长文本换行可读（R7） ============
  const briefSection = page.locator(".section", { has: page.locator("h4", { hasText: "现场简报" }) });
  const factBlocks = briefSection.locator(".fact, .brief-fact, [class*='fact']");
  const factCount = await factBlocks.count();
  log("T6-fact-count", "INFO", `简报 fact 块数量=${factCount}`);
  // 找「重确认」那条
  const recheck = briefSection.locator("text=重确认").first();
  const recheckVisible = await recheck.isVisible().catch(() => false);
  let clipInfo = "未找到重确认条目";
  if (recheckVisible) {
    const metrics = await recheck.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { scrollH: el.scrollHeight, clientH: el.clientHeight, overflow: cs.overflow, ws: cs.whiteSpace, text: el.textContent };
    });
    const clipped = metrics.scrollH > metrics.clientH + 2;
    clipInfo = `scrollH=${metrics.scrollH} clientH=${metrics.clientH} white-space=${metrics.ws} clipped=${clipped} 文本=「${(metrics.text || "").trim()}」`;
    log("T6-long-text-wrap", !clipped ? "PASS" : "FAIL", clipInfo);
  } else {
    log("T6-long-text-wrap", "FAIL", `重确认条目不可见 visible=${recheckVisible}`);
  }
  await shot(page, "06_brief");

  // ============ 任务7 补充观察：textarea 高度 vs 长留言 ============
  await page.locator(".goal-input").fill("第一步先 df -h 看磁盘；第二步 du -sh /var/log/* 找大户；第三步把 30 天前的日志打包移到 /data/archive；每步前都在操作记录里留痕，遇到任何写操作先停下来问我。");
  const ta = await page.locator(".goal-input").evaluate((el) => ({ rows: el.getAttribute("rows"), scrollH: el.scrollHeight, clientH: el.clientHeight }));
  log("T7-textarea-long", "INFO", `textarea rows=${ta.rows} scrollH=${ta.scrollH} clientH=${ta.clientH}（长留言需滚动查看）`);
  await shot(page, "07_long_draft");

  await browser.close();
  console.log("DONE");
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
