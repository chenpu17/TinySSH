// 14 凭据库：新建（生成 Ed25519 / 导入私钥）、列出与指纹、删除（§6.7 / S09 / D03 / D08）。

const openCreds = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(600);
  await page.click("[data-testid=settings-cat-credentials]");
  await page.waitForTimeout(700);
};
const paneText = (page) => page.evaluate(() => {
  const a = document.querySelector(".term-settings");
  return a ? a.innerText.replace(/\n+/g, " | ") : "";
});

module.exports = {
  title: "凭据库增删",
  async run({ page, ck }) {
    await openCreds(page);
    ck.check("凭据分区空态提示", (await paneText(page)).includes("还没有凭据"), (await paneText(page)).slice(0, 80));

    // 新建表单
    await page.click("[data-testid=cred-new]");
    await page.waitForTimeout(500);
    const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid^=cred]")].map((e) => e.getAttribute("data-testid")));
    for (const t of ["cred-new-form", "cred-new-label", "cred-new-gen-ed", "cred-new-gen-rsa", "cred-new-pem", "cred-new-pass", "cred-new-import", "cred-new-cancel"]) {
      ck.check(`新建表单含 ${t}`, ids.includes(t));
    }
    ck.check("表单说明「不落半成品」", (await paneText(page)).includes("不会留下半成品"), "");

    // 取消不留痕
    await page.click("[data-testid=cred-new-cancel]");
    await page.waitForTimeout(500);
    ck.check("取消后仍为空态（无半成品）", (await paneText(page)).includes("还没有凭据"), "");

    // 生成 Ed25519
    await page.click("[data-testid=cred-new]");
    await page.waitForTimeout(400);
    await page.fill("[data-testid=cred-new-label]", "r45-key");
    await page.click("[data-testid=cred-new-gen-ed]");
    await page.waitForTimeout(1200);
    ck.check("生成后有落库反馈（已保存 + 指纹）", (await paneText(page)).includes("已保存"), "");

    // 收起新建表单，看列表
    await page.click("[data-testid=cred-new-cancel]");
    await page.waitForTimeout(600);
    const after = await paneText(page);
    ck.check("收起表单后凭据在列表中", after.includes("r45-key"), after.slice(0, 200));
    ck.check("列表显示指纹（SHA256:）", after.includes("SHA256:"), "");
    ck.check("空态提示消失", !after.includes("还没有凭据"), "");
    ck.check("该凭据标注为未绑定", after.includes("未绑定"), after.slice(0, 220));

    // 删除凭据（未被引用 → 直接删）
    const row = await page.$('.term-settings *:has(> *:text-is("r45-key"))');
    if (row) await row.hover().catch(() => {});
    await page.waitForTimeout(300);
    const delBtn = await page.$('button[title^="删除凭据"]');
    ck.check("凭据行有删除按钮", !!delBtn);
    if (delBtn) {
      await delBtn.click();
      await page.waitForTimeout(800);
      // 删除前弹确认框（「删除凭据」/「取消」）
      const dlg = await page.evaluate(() => {
        const d = document.querySelector(".confirm-dialog");
        return d ? d.innerText.replace(/\n+/g, " | ") : null;
      });
      ck.check("删除弹确认框并说明引用检查", !!dlg && dlg.includes("仍被主机引用的凭据会被拒绝"), dlg || "(无)");
      await page.evaluate(() => {
        const d = document.querySelector(".confirm-dialog");
        if (d) {
          const ok = [...d.querySelectorAll("button")].find((b) => b.textContent.trim() === "删除凭据");
          if (ok) ok.click();
        }
      });
      await page.waitForTimeout(900);
      ck.check("删除后回到空态", (await paneText(page)).includes("还没有凭据"), (await paneText(page)).slice(0, 160));
    }
  },
};
