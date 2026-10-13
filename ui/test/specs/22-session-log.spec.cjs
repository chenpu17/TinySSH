// 22 十八轮：会话日志落盘——标签右键「记录会话日志」开关（toast 带路径）、
// 开启后菜单变「停止记录…」+「打开日志文件夹」浮现、关闭归位、默认关。
// 真实文件写入走 Rust 单测（log_tests）；demo 域为内存态。
const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
};

const clickItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};

module.exports = {
  title: "会话日志：右键开关、toast 带路径、开启态菜单、关闭归位",
  async run({ page, ck }) {
    // 清 demo 预置
    const closeViaMenu = async (namePart) => {
      await rightClickTab(page, namePart);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    };
    await closeViaMenu("prod-1");
    await closeViaMenu("staging-1");

    // 连本机（demo 域秒连）
    const c = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await c.hover();
    await page.waitForTimeout(250);
    await (await c.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1400);

    // 右键菜单：默认有「记录会话日志」，无「打开日志文件夹」
    await rightClickTab(page, "本机");
    ck.check("右键菜单有「记录会话日志」",
      await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((b) => b.textContent.includes("记录会话日志"))), "");
    ck.check("未开启时无「打开日志文件夹」",
      await page.evaluate(() => ![...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((b) => b.textContent.includes("打开日志文件夹"))), "");
    await page.mouse.click(10, 500); // 收右键菜单
    await page.waitForTimeout(300);

    // 工具菜单同源入口：开启并 toast 带路径
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "工具"); if (b) b.click(); });
    await page.waitForTimeout(300);
    ck.check("工具菜单有「记录会话日志」",
      await page.evaluate(() => [...document.querySelectorAll(".tools-menu [role=menuitem]")].some((b) => b.textContent.includes("记录会话日志"))), "");
    await page.evaluate(() => { const b = [...document.querySelectorAll(".tools-menu [role=menuitem]")].find((x) => x.textContent.includes("记录会话日志")); if (b) b.click(); });
    await page.waitForTimeout(400);
    ck.check("开启后 toast 带日志路径",
      await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("已开始记录会话日志") && t.textContent.includes(".log"))), "");

    // 再开菜单：变「停止记录会话日志」+「打开日志文件夹」浮现
    await rightClickTab(page, "本机");
    ck.check("开启后菜单变「停止记录会话日志」",
      await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((b) => b.textContent.includes("停止记录会话日志"))), "");
    ck.check("开启后「打开日志文件夹」在场",
      await page.evaluate(() => [...document.querySelectorAll(".ctx-menu [role=menuitem]")].some((b) => b.textContent.includes("打开日志文件夹"))), "");
    await clickItem(page, "停止记录会话日志");
    await page.waitForTimeout(400);
    ck.check("停止后 toast 提示已停止",
      await page.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("已停止记录会话日志"))), "");
    await rightClickTab(page, "本机");
    ck.check("停止后菜单归位（记录会话日志、无打开文件夹）",
      await page.evaluate(() => {
        const items = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].map((b) => b.textContent);
        return items.some((t) => t.includes("记录会话日志")) && !items.some((t) => t.includes("停止记录")) && !items.some((t) => t.includes("打开日志文件夹"));
      }), "");
    await page.mouse.click(10, 500); // 收菜单（真实点击，不经 evaluate 返回值）
    await page.waitForTimeout(300);

    // 收尾（清理段容错——断言已全部完成；locator 全程，不经 evaluate 返回值）
    let cleanupErr = "";
    try {
      const tab = page.locator(".tab").first();
      await tab.click({ button: "right" });
      await page.waitForTimeout(350);
      await page.locator('.ctx-menu [role=menuitem]', { hasText: "关闭会话" }).first().click();
      await page.waitForTimeout(500);
      const dlg = page.locator(".confirm-dialog button", { hasText: "关闭会话" });
      if (await dlg.count()) { await dlg.first().click(); await page.waitForTimeout(900); }
    } catch (e) {
      cleanupErr = String(e && e.message || e).slice(0, 160);
    }
    const tabsLeft = await page.evaluate(() => document.querySelectorAll(".tab").length);
    ck.check("收尾清空会话", tabsLeft === 0, `left=${tabsLeft} err=${cleanupErr}`);
  },
};
