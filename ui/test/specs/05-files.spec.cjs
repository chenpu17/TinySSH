// 05 远程文件：面包屑、列表、进入目录、选中条、下载菜单、传输队列（§6.6 / S09）。

const openFiles = async (page) => {
  await page.click('.session-toolbar button[title^="文件"]');
  await page.waitForTimeout(900);
};

const names = (page) => page.$$eval(".sftp-row .sftp-name", (els) => els.map((e) => e.textContent.trim()));
const crumbs = (page) => page.evaluate(() => {
  const c = document.querySelector("[data-testid=sftp-crumbs]");
  return c ? c.innerText.replace(/\s+/g, " ").trim() : null;
});

module.exports = {
  title: "远程文件浏览与传输入口",
  async run({ page, ck }) {
    const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
    await card.hover();
    await page.waitForTimeout(200);
    await (await card.$('button[title^="连接"]')).click();
    await page.waitForTimeout(1300);
    await openFiles(page);

    ck.check("文件面板有上传入口", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-upload-btn]")));
    ck.check("文件面板有「按路径」入口", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-by-path-btn]")));

    const c0 = await crumbs(page);
    ck.check("面包屑起始于简报 cwd（/var/log/nginx）", !!c0 && c0.includes("var") && c0.includes("log") && c0.includes("nginx"), `实得「${c0}」`);

    const n0 = await names(page);
    ck.check("列出目录内容（≥4 项）", n0.length >= 4, `实得 ${n0.length}：${n0.join(" / ")}`);
    ck.check("含目录项 archive", n0.includes("archive"));
    ck.check("含文件项 access.log", n0.includes("access.log"));

    // 选中一行 → 选中条出现
    await page.click('.sftp-row[data-name="access.log"]');
    await page.waitForTimeout(350);
    const selbar = await page.evaluate(() => {
      const e = document.querySelector("[data-testid=sftp-selbar]");
      return e ? e.innerText.replace(/\s+/g, " ").trim() : null;
    });
    ck.check("选中后出现选中条", !!selbar, selbar || "(无)");
    ck.check("选中条含「下载」", !!selbar && selbar.includes("下载"), selbar || "");

    // 选中条可下载所选
    ck.check("选中条有「下载所选」按钮", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-sel-download]")));
    // 清除选择（点选中条的 ✕）——点完必须**真的**清掉选中条（此前包在 if 里，找不到 ✕ 会静默跳过）
    const hadClear = await page.evaluate(() => {
      const bar = document.querySelector("[data-testid=sftp-selbar]");
      const x = bar && [...bar.querySelectorAll("button")].find((b) => b.textContent.trim() === "✕");
      if (x) x.click();
      return !!x;
    });
    ck.check("选中条有清除选择按钮 ✕", hadClear);
    await page.waitForTimeout(300);
    ck.check("清除后选中条消失", await page.evaluate(() => !document.querySelector("[data-testid=sftp-selbar]")));

    // 双击文件 → 行内动作菜单（下载 / 另存为…）
    await page.dblclick('.sftp-row[data-name="access.log"]');
    await page.waitForTimeout(500);
    ck.check("双击文件弹出动作菜单 sftp-menu", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-menu]")));
    ck.check("菜单含「下载」", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-menu-download]")));
    ck.check("菜单含「另存为…」", await page.evaluate(() => !!document.querySelector("[data-testid=sftp-menu-saveas]")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    ck.check("Escape 关闭动作菜单", await page.evaluate(() => !document.querySelector("[data-testid=sftp-menu]")));

    // 双击目录进入
    await page.dblclick('.sftp-row.dir[data-name="archive"]');
    await page.waitForTimeout(800);
    const c1 = await crumbs(page);
    ck.check("双击目录后面包屑加深（含 archive）", !!c1 && c1.includes("archive"), `实得「${c1}」`);

    // 传输队列抽屉
    ck.check("状态条有传输入口（sb-transfer）", await page.evaluate(() => !!document.querySelector("[data-testid=sb-transfer]")));
    await page.click("[data-testid=sb-transfer]");
    await page.waitForTimeout(500);
    ck.check("传输抽屉可打开（queue-drawer）", await page.evaluate(() => !!document.querySelector("[data-testid=queue-drawer]")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  },
};
