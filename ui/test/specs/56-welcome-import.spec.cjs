// 56 欢迎页导入入口：欢迎页空态次级按钮「从 ~/.ssh/config 导入」（welcome-import-btn）
// 复用既有导入面板（取舍记录在 welcome.tsx：不重刻极简对话框，把主机栏挂的
// SshConfigImportPanel 打开并滚到位即是复用）。demo 域 ssh_config 镜像 preview 5 条：
// web-1/db-1 可直接导入、bastion-jump（ProxyJump 阻断）/nouser（无 User）不可勾、
// prod-1 已导入——断言按钮在场（ghost 次级形态）、点击打开既有面板出预览、
// 默认只勾可导入未导入的、导入选中后主机列表出现新主机、重开面板出现
// already_imported（已在主机列表）反馈且默认不勾（防误覆盖）。

module.exports = {
  title: "欢迎页导入入口：按钮在场、复用既有面板、导入落主机列表、重复导入已导入反馈",
  async run({ page, ck }) {
    const vis = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0;
    }, sel);
    // 主机列表是否有同名主机卡（hostbar .host-card > .host-name）
    const hasHostCard = (name) => page.evaluate((n) =>
      [...document.querySelectorAll(".hostbar .host-card")]
        .some((x) => x.querySelector(".host-name")?.textContent === n), name);
    // 导入面板里按名字取一行：勾选态/禁用态/整行文本
    const rowOf = (name) => page.evaluate((n) => {
      const row = [...document.querySelectorAll(".hostbar .add-host .sshcfg-row")]
        .find((x) => x.textContent.includes(n));
      if (!row) return null;
      const cb = row.querySelector('input[type="checkbox"]');
      return { checked: !!cb?.checked, disabled: !!cb?.disabled, text: row.textContent };
    }, name);
    const panelBtn = (text) => page.evaluate((t) => {
      const b = [...document.querySelectorAll(".hostbar .add-host button")]
        .find((x) => x.textContent.trim().includes(t));
      if (!b) throw new Error("panel button not found: " + t);
      b.click();
    }, text);

    // ── 欢迎页空态：按钮在场 + 次级形态 ──
    ck.check("开机在欢迎页空态（.welcome 在场）", await vis(".welcome"));
    ck.check("欢迎页有「从 ~/.ssh/config 导入」按钮（welcome-import-btn）",
      await vis('[data-testid="welcome-import-btn"]'));
    ck.check("该按钮是 ghost 次级形态",
      await page.evaluate(() =>
        document.querySelector('[data-testid="welcome-import-btn"]')?.classList.contains("ghost") ?? false));
    ck.check("导入前主机列表没有 web-1 / db-1",
      !(await hasHostCard("web-1")) && !(await hasHostCard("db-1")));

    // ── 点击 → 复用主机栏既有导入面板（预览载入）──
    await page.click('[data-testid="welcome-import-btn"]');
    await page.waitForSelector(".hostbar .add-host .sshcfg-row", { timeout: 5000 })
      .catch(() => {});
    ck.check("点击后打开主机栏既有导入面板（标题「从 ~/.ssh/config 导入」）",
      await page.evaluate(() =>
        document.querySelector(".hostbar .add-host")?.textContent.includes("从 ~/.ssh/config 导入") ?? false));
    ck.check("预览载入 5 条条目（demo ssh_config 镜像）",
      await page.evaluate(() =>
        document.querySelectorAll(".hostbar .add-host .sshcfg-row").length === 5));

    // ── 默认勾选门：可直接导入且未导入过才勾；阻断/无用户不可勾 ──
    const w = await rowOf("web-1");
    ck.check("web-1 默认勾选且可勾", !!w && w.checked && !w.disabled,
      JSON.stringify(w?.checked) + "/" + JSON.stringify(w?.disabled));
    const d = await rowOf("db-1");
    ck.check("db-1 默认勾选且可勾", !!d && d.checked && !d.disabled);
    const b = await rowOf("bastion-jump");
    ck.check("阻断条目（bastion-jump）不可勾（转手工表单入口在场）",
      !!b && b.disabled && !b.checked && b.text.includes("转手工表单"));
    const n = await rowOf("nouser");
    ck.check("无用户条目（nouser）不可勾", !!n && n.disabled && !n.checked);
    const p = await rowOf("prod-1");
    ck.check("已在主机列表条目带 already_imported 反馈（prod-1）",
      !!p && p.text.includes("已在主机列表"));

    // ── 导入选中：行内结果反馈 + 主机列表出现新主机 ──
    await panelBtn("导入选中");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".hostbar .add-host .ok")]
        .filter((x) => x.textContent.includes("已导入")).length >= 2,
      null, { timeout: 5000 }).catch(() => {});
    ck.check("导入后 2 条行内「✓ 已导入」反馈",
      await page.evaluate(() =>
        [...document.querySelectorAll(".hostbar .add-host .ok")]
          .filter((x) => x.textContent.includes("已导入")).length === 2));
    await page.waitForFunction(
      (nm) => [...document.querySelectorAll(".hostbar .host-card")]
        .some((x) => x.querySelector(".host-name")?.textContent === nm),
      "web-1", { timeout: 5000 }).catch(() => {});
    ck.check("主机列表出现新主机 web-1", await hasHostCard("web-1"));
    ck.check("主机列表出现新主机 db-1", await hasHostCard("db-1"));

    // ── 重复导入：收起重开（面板重挂载重拉预览）→ already_imported 反馈 ──
    await panelBtn("收起");
    await page.waitForTimeout(300);
    ck.check("收起后面板关闭", !(await vis(".hostbar .add-host")));
    await page.click('[data-testid="welcome-import-btn"]');
    await page.waitForSelector(".hostbar .add-host .sshcfg-row", { timeout: 5000 })
      .catch(() => {});
    const w2 = await rowOf("web-1");
    ck.check("重开面板：web-1 转 already_imported 反馈（已在主机列表）",
      !!w2 && w2.text.includes("已在主机列表"),
      (w2?.text ?? "(无行)").slice(0, 80));
    ck.check("重开面板：已导入条目默认不勾（防误覆盖）",
      !!w2 && !w2.checked);
  },
};
