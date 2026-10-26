// 60 界面语言（i18n 轮）：字典反转 t()——默认 zh（全部既有 spec 的中文断言零扰动）；
// localStorage 预置 en 启动即英文（chrome 断言：设置面板/主机栏/欢迎页/状态栏）；
// 面板内切换 zh↔en 即时生效（App locale state 触发全树重渲染，无 reload）；
// 持久化落 localStorage（demo 域 persistSetting 落点=LS_KEY 同键）。

module.exports = {
  title: "界面语言（zh 默认 / en 切换即时生效 / 持久化）",
  async run({ page, browser, ck, BASE }) {
    // ── A. 默认 zh：既有形态零扰动（harness 已开好 demo 页）──
    await page.waitForTimeout(1200);
    await page.click(".hb-settings");
    await page.waitForTimeout(600);
    ck.check("默认 zh：设置标题为中文",
      (await page.evaluate(() => document.querySelector(".settings-title")?.textContent)) === "设置");
    ck.check("默认 zh：外观分类卡有「应用外观」标题",
      (await page.evaluate(() => !!document.querySelector(".settings-pane")?.textContent.includes("应用外观"))));
    ck.check("默认 zh：界面语言下拉值为 zh",
      (await page.evaluate(() => document.querySelector('[data-testid="locale-select"]')?.value)) === "zh");
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(400);

    // ── B. localStorage 预置 en → 启动即英文（新页 addInitScript 先于应用脚本）──
    const page2 = await browser.newPage();
    await page2.addInitScript(() => localStorage.setItem("ui.v2.locale", "en"));
    await page2.goto(BASE, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(1200);
    const hostTxt2 = await page2.evaluate(() => document.body.innerText);
    ck.check("en 启动：主机栏「本机」节头变 This machine（卡名=主机数据不译）",
      (await page2.evaluate(() => document.querySelector('[data-testid="local-host-section"] h4')?.textContent)) === "This machine",
      await page2.evaluate(() => document.querySelector('[data-testid="local-host-section"]')?.innerText ?? "NO SECTION"));
    ck.check("en 启动：欢迎页主行动钮变 Add host",
      hostTxt2.includes("Add host"), "");
    ck.check("en 启动：状态栏传输 chip 变 Transfers",
      hostTxt2.includes("Transfers"), "");
    await page2.click(".hb-settings");
    await page2.waitForTimeout(600);
    ck.check("en 启动：设置标题变 Settings",
      (await page2.evaluate(() => document.querySelector(".settings-title")?.textContent)) === "Settings",
      await page2.evaluate(() => document.querySelector(".settings-title")?.textContent));
    ck.check("en 启动：分类导航变 Appearance",
      (await page2.evaluate(() => document.querySelector('[data-testid="settings-cat-appearance"]')?.textContent ?? "")).includes("Appearance"));
    ck.check("en 启动：语言下拉值为 en（默认开在外观卡）",
      (await page2.evaluate(() => document.querySelector('[data-testid="locale-select"]')?.value)) === "en");
    await page2.click('[data-testid="settings-cat-terminal"]');
    await page2.waitForTimeout(500);
    ck.check("en 启动：终端行为卡开关变 Copy on select（表内值已译）",
      (await page2.evaluate(() => document.querySelector(".settings-pane")?.textContent ?? "")).includes("Copy on select"));

    // ── C. 面板内切回 zh：即时生效（无 reload——location 未变）──
    await page2.click('[data-testid="settings-cat-appearance"]');
    await page2.waitForTimeout(500);
    await page2.evaluate(() => {
      const sel = document.querySelector('[data-testid="locale-select"]');
      const proto = window.HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(sel, "zh");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page2.waitForTimeout(500);
    ck.check("面板内切回 zh：设置标题即时复原",
      (await page2.evaluate(() => document.querySelector(".settings-title")?.textContent)) === "设置");
    ck.check("切回 zh：localStorage 已更新（demo 域持久化落点）",
      (await page2.evaluate(() => localStorage.getItem("ui.v2.locale"))) === "zh");
    await page2.close();
  },
};
