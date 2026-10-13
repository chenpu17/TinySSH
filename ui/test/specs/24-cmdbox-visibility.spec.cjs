// 24 二十轮：命令框可见性——集成可用会话显示且连态有自解释 placeholder；
// 集成关闭（Disabled）会话整条隐藏（必拒收的死条不摆）；随活动会话切换跟随；
// 隐藏不影响功能面（可见时执行照常）。
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
const closeViaMenu = async (page, namePart) => {
  const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
  if (!has) return;
  await rightClickTab(page, namePart);
  await clickItem(page, "关闭会话");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};
const cmdbox = (page) => page.evaluate(() => {
  const el = document.querySelector('.term-col input[placeholder]');
  return el ? { placeholder: el.getAttribute("placeholder") } : null;
});

module.exports = {
  title: "命令框可见性：集成可用显示+自解释 placeholder，关集成隐藏，随活动会话跟随",
  async run({ page, ck }) {
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");

    // 集成可用会话（本机，demo 投影 Ready）：可见 + 连态 placeholder
    await connect(page, "本机");
    let box = await cmdbox(page);
    ck.check("集成可用会话：命令框在场", !!box, JSON.stringify(box));
    ck.check("连态 placeholder 自解释",
      !!box && box.placeholder.includes("执行单条命令") && box.placeholder.includes("焦点自动回终端"),
      box && box.placeholder);

    // 关集成会话（noint-1，demo 投影 Disabled）：整条隐藏（demo 地址未信任 → 先过 TOFU）
    await connect(page, "noint-1（无集成）");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".hk-actions button")].find((x) => x.textContent.includes("信任并连接"));
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
    box = await cmdbox(page);
    ck.check("关集成会话：命令框整条隐藏", box === null, JSON.stringify(box));

    // 切回本机：命令框跟随活动会话回归
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("本机"));
      if (!tab) throw new Error("tab not found");
      tab.click();
    });
    await page.waitForTimeout(500);
    box = await cmdbox(page);
    ck.check("切回集成可用会话：命令框回归", !!box && !!box.placeholder.includes("执行单条命令"), JSON.stringify(box));

    // 功能面：执行照常（demo 域回显 + 演示输出）
    await page.evaluate(() => {
      const el = document.querySelector('.term-col input[placeholder]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "echo via-cmdbox");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => {
      const el = document.querySelector('.term-col input[placeholder]');
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await page.waitForTimeout(600);
    ck.check("命令框执行照常（❯ 回显 + 演示输出）",
      await page.evaluate(() => {
        const terms = window.__t_terms;
        if (!terms) throw new Error("__t_terms probe missing (dev only)");
        const live = [...terms.values()].filter((t) => {
          const el = t.element;
          return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
        });
        return live.some((t) => (t.element.textContent || "").includes("via-cmdbox") && (t.element.textContent || "").includes("（演示输出）"));
      }), "");

    // 收尾
    await closeViaMenu(page, "本机");
    await closeViaMenu(page, "noint-1");
    ck.check("收尾清空会话", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
  },
};
