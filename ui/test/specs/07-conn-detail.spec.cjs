// 07 连接详情：字段齐备、内容正确、复制、两种关闭路径（§6.6 尾 / S09）。

const openDetail = async (page) => {
  await page.click('.session-toolbar button:has-text("工具")');
  await page.waitForTimeout(350);
  await page.click("[data-testid=tools-conn-detail]");
  await page.waitForTimeout(600);
};

const field = (page, tid) => page.evaluate((t) => {
  const e = document.querySelector(`[data-testid=${t}]`);
  return e ? e.textContent.trim() : null;
}, tid);

module.exports = {
  title: "连接详情",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await openDetail(page);

    ck.check("详情为浮层（.pop-mask 遮罩存在）", await page.evaluate(() => !!document.querySelector(".pop-mask")));

    const f = {
      host: await field(page, "cd-host"),
      user: await field(page, "cd-user"),
      addr: await field(page, "cd-addr"),
      port: await field(page, "cd-port"),
      auth: await field(page, "cd-auth"),
      charset: await field(page, "cd-charset"),
      sid: await field(page, "cd-sid"),
    };
    ck.eq("主机名", f.host, "本机");
    ck.eq("用户名", f.user, "ops");
    ck.eq("地址", f.addr, "local");
    ck.eq("端口", f.port, "0");
    ck.eq("认证方式", f.auth, "密码");
    ck.eq("编码", f.charset, "UTF-8");
    ck.check("会话 ID 形如 s-*", !!f.sid && f.sid.startsWith("s-"), `实得 ${f.sid}`);

    ck.check("有指纹行（cd-fp）", await page.evaluate(() => !!document.querySelector("[data-testid=cd-fp]")));
    ck.check("有创建时间行（cd-created）", await page.evaluate(() => !!document.querySelector("[data-testid=cd-created]")));
    ck.check("有复制按钮（cd-copy）", await page.evaluate(() => !!document.querySelector("[data-testid=cd-copy]")));

    // 关闭路径 1：关闭钮
    await page.click("[data-testid=cd-close]");
    await page.waitForTimeout(400);
    ck.check("点关闭钮后详情消失", await page.evaluate(() => !document.querySelector("[data-testid=cd-host]")));

    // 关闭路径 2：点遮罩（对话框居中，须点遮罩左上角空白处，中心被对话框盖住）
    await openDetail(page);
    ck.check("可再次打开详情", await page.evaluate(() => !!document.querySelector("[data-testid=cd-host]")));
    await page.locator(".pop-mask").click({ position: { x: 16, y: 16 } });
    await page.waitForTimeout(400);
    ck.check("点遮罩后详情消失", await page.evaluate(() => !document.querySelector("[data-testid=cd-host]")));
  },
};
