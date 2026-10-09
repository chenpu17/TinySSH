// 10 主机管理与 ssh_config 导入：新增、编辑、收藏、删除确认、导入预览（§6.1 / §5 迁移表）。

const cardByName = (page, name) => page.$(`.host-card:has(.host-name:text-is("${name}"))`);
const hostNames = (page) => page.$$eval(".host-card .host-name", (els) => els.map((e) => e.textContent.trim()));

module.exports = {
  title: "主机增删改与 ssh_config 导入",
  async run({ page, ck }) {
    // ── 新增 ──
    await page.click('.hostbar button[title="添加主机"]');
    await page.waitForTimeout(500);
    const inputs = await page.$$(".hostbar input");
    // 表单 DOM 顺序：0=搜索 1=名称 2=地址 3=端口 4=用户名 5=标签 6=密码
    await inputs[1].fill("r45-new");
    await inputs[2].fill("r45.example.com");
    await inputs[3].fill("2200");
    await inputs[4].fill("deploy");
    await inputs[6].fill("s3cret");
    await page.evaluate(() => [...document.querySelectorAll(".hostbar button")].find((b) => b.textContent.trim() === "仅保存").click());
    await page.waitForTimeout(900);
    ck.check("「仅保存」后新主机出现在列表", (await hostNames(page)).includes("r45-new"), (await hostNames(page)).join(" / "));

    // ── 收藏 ──
    const c1 = await cardByName(page, "r45-new");
    await c1.hover();
    await page.waitForTimeout(300);
    await (await c1.$('button[title^="收藏"]')).click();
    await page.waitForTimeout(600);
    ck.check("收藏后出现「收藏」分组", await page.evaluate(() => document.querySelector(".hostbar").innerText.includes("收藏")), "");
    const groupText = await page.evaluate(() => document.querySelector(".hostbar").innerText.replace(/\n+/g, " | ").slice(0, 120));
    ck.check("收藏分组内含 r45-new", groupText.includes("r45-new") || (await hostNames(page))[0] === "r45-new", groupText);

    // ── 编辑 ──
    const c2 = await cardByName(page, "prod-1");
    await c2.hover();
    await page.waitForTimeout(300);
    await (await c2.$('button[title^="编辑主机"]')).click();
    await page.waitForTimeout(500);
    const vals = await page.$$eval(".hostbar input", (els) => els.map((e) => e.value));
    ck.check("编辑表单预填 prod-1", vals.includes("prod-1"), vals.slice(0, 6).join(" / "));
    ck.check("编辑表单预填地址 10.0.0.11", vals.includes("10.0.0.11"), "");
    ck.check("编辑表单预填用户 ops", vals.includes("ops"), "");
    const editInputs = await page.$$(".hostbar input");
    await editInputs[1].fill("prod-1-renamed");
    await page.evaluate(() => [...document.querySelectorAll(".hostbar button")].find((b) => b.textContent.trim() === "保存修改").click());
    await page.waitForTimeout(900);
    ck.check("编辑后主机改名生效", (await hostNames(page)).includes("prod-1-renamed"), (await hostNames(page)).join(" / "));

    // ── 删除确认：取消 ──
    const c3 = await cardByName(page, "r45-new");
    await c3.hover();
    await page.waitForTimeout(300);
    await (await c3.$('button[title="删除主机"]')).click();
    await page.waitForTimeout(500);
    const dlg = await page.evaluate(() => {
      const d = document.querySelector(".confirm-dialog");
      return d ? d.innerText.replace(/\n+/g, " | ") : null;
    });
    ck.check("删除弹确认对话框", !!dlg && dlg.includes("删除主机"), dlg || "(无)");
    ck.check("确认框说明会话不受影响", !!dlg && dlg.includes("已建立的会话不受影响"), "");
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "取消").click());
    await page.waitForTimeout(500);
    ck.check("取消后主机仍在", (await hostNames(page)).includes("r45-new"));

    // ── 删除确认：确认 ──
    const c4 = await cardByName(page, "r45-new");
    await c4.hover();
    await page.waitForTimeout(300);
    await (await c4.$('button[title="删除主机"]')).click();
    await page.waitForTimeout(500);
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")].find((b) => b.textContent.trim() === "删除").click());
    await page.waitForTimeout(800);
    ck.check("确认后主机从列表移除", !(await hostNames(page)).includes("r45-new"), (await hostNames(page)).join(" / "));

    // ── ssh_config 导入预览 ──
    await page.click('.hostbar button[title^="导入"]');
    await page.waitForTimeout(900);
    const imp = await page.evaluate(() => document.querySelector(".hostbar").innerText.replace(/\n+/g, " | "));
    ck.check("导入面板标题「从 ~/.ssh/config 导入」", imp.includes("从 ~/.ssh/config 导入"), "");
    ck.check("预览列出 web-1", imp.includes("web-1"));
    ck.check("预览列出 db-1（含非 22 端口 2222）", imp.includes("db-1") && imp.includes("2222"));
    ck.check("阻断项（proxyjump）标出并给「转手工表单」", imp.includes("阻断") && imp.includes("转手工表单"), "");
    ck.check("缺用户项（nouser）标出并给「转手工表单」", imp.includes("nouser") && imp.includes("未指定登录用户"), "");
    ck.check("已存在主机（prod-1）标为可覆盖", imp.includes("已在主机列表"), "");
  },
};
