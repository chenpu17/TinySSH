// 28 最近连接右键（本轮）：欢迎页最近连接行右键出菜单（连接/编辑主机/从最近
// 连接隐藏/删除主机）；「从最近连接隐藏」= 纯前端偏好（localStorage，后端列表
// 由会话历史派生不动历史语义），重连该主机自动恢复显示。另验 demo 保真度修复：
// sessionHistory 历史表（真实核心关会话不删行=recents 全历史派生，此前 demo 关
// 会话即 splice 使欢迎页最近连接在浏览器域永不可达）。
const tabNames = (page) => page.evaluate(() => [...document.querySelectorAll(".tab .tab-label")].map((x) => x.textContent));
const closeViaMenu = async (page, namePart) => {
  const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
  if (!has) return;
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("关闭会话"));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};
const rowTexts = (page) => page.$$eval('[aria-label="最近连接"] .wr-row .wr-name', (els) => els.map((e) => e.textContent.trim()));
const openRecentsMenu = async (page, namePart) => {
  await page.evaluate((t) => {
    const row = [...document.querySelectorAll(".welcome-recents .wr-row")].find((x) => x.textContent.includes(t));
    if (!row) throw new Error("wr-row not found: " + t);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 500, clientY: 300 }));
  }, namePart);
  await page.waitForTimeout(350);
};
const menuItem = (page, label) => page.evaluate((t) => {
  const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.trim() === t);
  if (b) b.click();
  return !!b;
}, label);

module.exports = {
  title: "最近连接右键：四项菜单+隐藏偏好+重连恢复+demo 历史表保真",
  async run({ page, ck }) {
    // 空场：demo 开机两签（非活动）——欢迎页在场但最近连接块要求 sessions.length===0
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    ck.check("收尾空场（两签已关）", (await tabNames(page)).length === 0, (await tabNames(page)).join(" / "));
    // 历史表派生（保真度修复）：关会话后 recents 仍在——prod-1(13:50) > staging-1(13:40)
    await page.waitForSelector(".welcome-recents .wr-row", { timeout: 5000 }).catch(() => {});
    const rows0 = await rowTexts(page);
    ck.check("关会话后最近连接仍在（历史派生）", rows0.includes("prod-1") && rows0.includes("staging-1"), rows0.join(" / "));
    ck.check("倒序：prod-1 在前", rows0[0] === "prod-1", rows0.join(" / "));

    // ── 右键菜单四项 ──
    await openRecentsMenu(page, "prod-1");
    const menuText = await page.evaluate(() => document.querySelector(".ctx-menu")?.getAttribute("aria-label") ?? null);
    ck.check("菜单 aria-label 指明主机", menuText === "最近连接操作：prod-1", menuText ?? "null");
    const hasConn = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((x) => x.textContent.trim() === "连接（新建会话）"));
    const hasEdit = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((x) => x.textContent.trim() === "编辑主机…"));
    const hasHide = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((x) => x.textContent.trim() === "从最近连接隐藏"));
    const hasDel = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((x) => x.textContent.trim() === "删除主机…"));
    ck.check("四项菜单齐备（连接/编辑/隐藏/删除）", hasConn && hasEdit && hasHide && hasDel, `${hasConn}/${hasEdit}/${hasHide}/${hasDel}`);

    // ── 隐藏：行消失 + localStorage 偏好落盘 ──
    await menuItem(page, "从最近连接隐藏");
    await page.waitForTimeout(500);
    const rows1 = await rowTexts(page);
    ck.check("隐藏后 prod-1 行消失", !rows1.includes("prod-1") && rows1.includes("staging-1"), rows1.join(" / "));
    const stored = await page.evaluate(() => localStorage.getItem("ui.recentsHidden"));
    ck.check("隐藏偏好写入 localStorage", stored === JSON.stringify(["h-prod1"]), stored ?? "null");

    // ── 编辑入口：打开主机编辑表单且预填，Esc 收起 ──
    await openRecentsMenu(page, "staging-1");
    await menuItem(page, "编辑主机…");
    await page.waitForTimeout(500);
    const vals = await page.$$eval(".add-host-dlg input", (els) => els.map((e) => e.value)); // 编辑表单已移居中弹窗
    ck.check("编辑表单预填 staging-1 地址", vals.includes("10.0.0.13"), vals.slice(0, 6).join(" / "));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    ck.check("Esc 收起编辑表单", await page.evaluate(() => !document.querySelector(".add-host-dlg")), "");

    // ── 重连恢复：隐藏的主机重新建连即取消隐藏 ──
    const c = await page.$('.host-card:has(.host-name:text-is("prod-1"))');
    await c.hover();
    await page.waitForTimeout(250);
    await (await c.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1400);
    ck.check("hostbar 重连 prod-1 出签", (await tabNames(page)).some((t) => t.includes("prod-1")), (await tabNames(page)).join(" / "));
    await closeViaMenu(page, "prod-1");
    await page.waitForSelector(".welcome-recents .wr-row", { timeout: 5000 }).catch(() => {});
    const rows2 = await rowTexts(page);
    ck.check("重连后 prod-1 恢复显示（且排首）", rows2[0] === "prod-1", rows2.join(" / "));
    const stored2 = await page.evaluate(() => localStorage.getItem("ui.recentsHidden"));
    ck.check("隐藏偏好已清空", stored2 === "[]" || stored2 === null, stored2 ?? "null");
  },
};
