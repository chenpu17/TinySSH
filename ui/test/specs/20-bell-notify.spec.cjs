// 20 十六轮：终端响铃（BEL）——标签闪烁恒开（写 BEL 即闪、6s 自清）、
// 「响铃时系统通知」设置开关（blob terminal.bell_notify 持久化、与同域 copy_on_select
// 合并共存）。通知本体走 OS 通道（native 门），真机验证，不在本 spec。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

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

const blob = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}"));

module.exports = {
  title: "终端响铃：标签闪烁与系统通知开关",
  async run({ page, ck }) {
    // 清 demo 预置（Disconnected 直接关，确认按钮存在才点）
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

    // ── 设置：先开「选中即复制」再开「响铃通知」——同域合并共存 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("终端分区有「响铃通知」开关", await page.evaluate(() => !!document.querySelector('[data-testid="bell-toggle"]')), "");
    ck.check("响铃通知默认关", !(await page.evaluate(() => document.querySelector('[data-testid="bell-toggle"]').checked)), "");
    await page.click('[data-testid="cos-toggle"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="bell-toggle"]');
    await page.waitForTimeout(600);
    let ws = await blob(page);
    ck.check("blob 同域三键合并共存", ws?.terminal?.bell_notify === true && ws?.terminal?.copy_on_select === true && ws?.terminal?.paste_guard === true,
      JSON.stringify(ws?.terminal));
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    // ── 连接后写 BEL → 活动标签闪烁 ──
    await connect(page, "本机");
    await page.evaluate(() => {
      const terms = window.__t_terms;
      if (!terms) throw new Error("__t_terms probe missing (dev only)");
      const live = [...terms.values()].filter((t) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      });
      live[0].write("\x07");
    });
    await page.waitForTimeout(400);
    const flashing = await page.evaluate(() => document.querySelectorAll(".tab-bell").length);
    ck.check("写入 BEL 后标签闪烁", flashing >= 1, `flashing=${flashing}`);

    // ── 6s 自清 ──
    await page.waitForTimeout(6500);
    const cleared = await page.evaluate(() => document.querySelectorAll(".tab-bell").length);
    ck.check("闪烁 6s 后自清", cleared === 0, `flashing=${cleared}`);

    // ── reload 后开关持久 ──
    await page.reload();
    await page.waitForTimeout(1500);
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("reload 后响铃通知仍开", await page.evaluate(() => document.querySelector('[data-testid="bell-toggle"]').checked), "");
    ck.check("reload 后选中即复制仍开", await page.evaluate(() => document.querySelector('[data-testid="cos-toggle"]').checked), "");
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    // 收尾：不留会话
    for (let i = 0; i < 3; i++) {
      const more = await page.evaluate(() => document.querySelectorAll(".tab").length);
      if (more === 0) break;
      await page.evaluate(() => {
        const tab = document.querySelector(".tab");
        tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
      });
      await page.waitForTimeout(350);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    }
    ck.check("收尾清空会话", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
  },
};
