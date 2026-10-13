// 23 十九轮：命令面板（⌘K）——工具栏入口开面板、条目分组（会话/连接/应用）、
// 过滤、执行动作（连主机/开设置）、Esc 关闭。Ctrl+K 键位 native 门（浏览器 demo
// 不劫持）不在本 spec——真机验证覆盖；面板动作项本身 demo 域全可断言。
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
  title: "命令面板：入口、分组条目、过滤、执行、Esc 关闭",
  async run({ page, ck }) {
    // 清 demo 预置（面板的「会话」组断言需要干净起点）
    const closeViaMenu = async (namePart) => {
      const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
      if (!has) return; // 容忍缺签（收尾循环对已关会话不再硬抛）
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

    // 入口 + 默认条目
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(400);
    ck.check("面板打开（遮罩+输入框在场）",
      await page.evaluate(() => !!document.querySelector('[data-testid="palette-overlay"] input')), "");
    const titles = await page.evaluate(() => [...document.querySelectorAll(".palette-item .palette-title")].map((x) => x.textContent));
    ck.check("应用组条目在场（设置/快速连接/外观/主机栏/导入）",
      titles.some((t) => t.includes("打开设置")) && titles.some((t) => t.includes("快速连接")) &&
      titles.some((t) => t.includes("外观切换为")) && titles.some((t) => t.includes("导入 ~/.ssh/config")),
      titles.join(" | ").slice(0, 200));
    ck.check("连接组条目在场（连接 prod-1 / 打开本地终端）",
      titles.some((t) => t.includes("连接 prod-1")) && titles.some((t) => t.includes("打开本地终端")), "");
    ck.check("零会话时无「会话」组",
      !titles.some((t) => t.includes("切换到")), "");

    // 过滤
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="palette-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "prod");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(250);
    const filtered = await page.evaluate(() => [...document.querySelectorAll(".palette-item .palette-title")].map((x) => x.textContent));
    ck.check("过滤「prod」只剩 prod 主机（无设置/本地终端）",
      filtered.length >= 1 && filtered.every((t) => t.includes("prod")) && !filtered.some((t) => t.includes("打开设置")),
      filtered.join(" | "));

    // 执行：连接 prod-1 → 面板关 + 会话建
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".palette-item")].find((x) => x.textContent.includes("连接 prod-1"));
      if (!b) throw new Error("连接 prod-1 item missing");
      b.click();
    });
    await page.waitForTimeout(1600);
    ck.check("执行后面板关闭",
      await page.evaluate(() => !document.querySelector('[data-testid="palette-overlay"]')), "");
    ck.check("prod-1 会话已建立",
      await page.evaluate(() => [...document.querySelectorAll(".tab")].some((t) => t.textContent.includes("prod-1"))), "");

    // 会话组出现 + 切换目标（本机建成第二会话再切换）
    const c = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await c.hover();
    await page.waitForTimeout(250);
    await (await c.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1400);
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(350);
    const titles2 = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].map((x) => x.textContent));
    ck.check("两会话在场（当前标记 + 切换条目）",
      titles2.filter((t) => t.includes("切换到")).length === 2 && titles2.some((t) => t.includes("关闭会话")), "");
    // 切换到 prod-1
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".palette-item")].find((x) => x.textContent.includes("切换到 prod-1"));
      if (!b) throw new Error("切换条目 missing");
      b.click();
    });
    await page.waitForTimeout(600);
    ck.check("切换执行（活动标签变 prod-1）",
      await page.evaluate(() => document.querySelector(".tab.active, .tab[aria-current]")?.textContent.includes("prod-1") ||
        [...document.querySelectorAll(".tab")].filter((t) => t.className.includes("active")).some((t) => t.textContent.includes("prod-1"))), "");

    // Esc 关闭（浮层链）
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ck.check("Esc 关闭面板",
      await page.evaluate(() => !document.querySelector('[data-testid="palette-overlay"]')), "");

    // 收尾（逐个右键关闭）
    let guard = 0;
    while ((await page.evaluate(() => document.querySelectorAll(".tab").length)) > 0 && guard++ < 4) {
      await closeViaMenu("prod-1");
      await closeViaMenu("本机");
      await closeViaMenu("staging-1");
    }
    ck.check("收尾清空会话", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
  },
};
