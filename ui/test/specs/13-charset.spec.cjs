// 13 远端编码（GBK）：表单可选 GBK、会话状态条与连接详情同步显示（§5 迁移表 / V4 charset）。

module.exports = {
  title: "远端编码 GBK 全链路",
  async run({ page, ck }) {
    await page.click('.hostbar button[title="添加主机"]');
    await page.waitForTimeout(500);
    const ins = await page.$$(".add-host-dlg input"); // 弹窗内：0=名称 1=地址 2=端口 3=用户名 4=密码
    await ins[0].fill("gbk-host");
    await ins[1].fill("gbk.demo");
    await ins[2].fill("22");
    await ins[3].fill("ops");
    await ins[4].fill("pw");

    const selOpts = await page.$$eval(".add-host-dlg select", (els) => els.map((e) => [...e.options].map((o) => o.value)));
    ck.check("认证方式可选（password/key/agent）", selOpts[0].join(",") === "password,key,agent", selOpts[0].join(","));
    ck.check("编码可选 utf-8 / gbk", selOpts[1].join(",") === "utf-8,gbk", selOpts[1].join(","));

    const sels = await page.$$(".add-host-dlg select");
    await sels[1].selectOption("gbk");
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "仅保存").click());
    await page.waitForTimeout(900);
    ck.check("GBK 主机保存成功", await page.evaluate(() => [...document.querySelectorAll(".host-name")].map((e) => e.textContent).includes("gbk-host")));

    // 连接（首连需信任指纹）
    const c = await page.$('.host-card:has(.host-name:text-is("gbk-host"))');
    await c.hover();
    await page.waitForTimeout(300);
    await (await c.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "信任并连接");
      if (b) b.click();
    });
    await page.waitForTimeout(1600);
    ck.check("GBK 主机建立会话", await page.evaluate(() => !!document.querySelector(".session-toolbar")));

    const sb = await page.evaluate(() => document.querySelector(".statusbar").innerText.replace(/\s+/g, " "));
    ck.check("状态条标为 GBK（而非默认 UTF-8）", sb.includes("GBK") && !sb.includes("UTF-8"), `实得「${sb}」`);

    await page.click('.session-toolbar button:has-text("工具")');
    await page.waitForTimeout(350);
    await page.click("[data-testid=tools-conn-detail]");
    await page.waitForTimeout(600);
    const cs = await page.evaluate(() => {
      const e = document.querySelector("[data-testid=cd-charset]");
      return e ? e.textContent.trim() : null;
    });
    ck.eq("连接详情编码为 GBK", cs, "GBK");
  },
};
