// 12 连接门与失败路径：首次连接的指纹确认（TOFU）、取消、信任后建会话、
// 已信任主机直连（§6.1 / §10.1）。demo 里只有 prod-1 预置信任，其余主机首连必弹确认。

const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};
const hkText = (page) => page.evaluate(() => {
  const d = document.querySelector(".hk-dialog");
  return d ? d.innerText.replace(/\n+/g, " | ") : null;
});
const clickText = async (page, t) => {
  await page.evaluate((x) => {
    const b = [...document.querySelectorAll("button")].find((y) => y.textContent.trim() === x);
    if (b) b.click();
  }, t);
  await page.waitForTimeout(1400);
};

module.exports = {
  title: "首次连接指纹门与失败路径",
  async run({ page, ck }) {
    // ── 已信任主机直连，不弹指纹窗 ──
    await connect(page, "prod-1");
    ck.check("已信任主机（prod-1）不弹指纹窗", await page.evaluate(() => !document.querySelector(".hk-dialog")));
    ck.check("prod-1 会话已建立", await page.evaluate(() => !!document.querySelector(".session-toolbar")));

    // ── 未信任主机：首连弹确认 ──
    await connect(page, "prod-2（演示连接失败）");
    const hk = await hkText(page);
    ck.check("未信任主机弹出首次连接确认", !!hk && hk.includes("首次连接确认"), hk || "(无)");
    ck.check("确认框显示主机地址端口", !!hk && hk.includes("10.0.0.12:22"), "");
    ck.check("确认框显示待核对指纹（SHA256:）", !!hk && hk.includes("SHA256:"), "");
    ck.check("有「信任并连接」与「取消」", await page.evaluate(() => {
      const t = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
      return t.includes("信任并连接") && t.includes("取消");
    }));

    // ── 取消：不建会话 ──
    const tabsBefore = await page.evaluate(() => document.querySelectorAll(".tabbar-row button").length);
    await clickText(page, "取消");
    const tabsAfter = await page.evaluate(() => document.querySelectorAll(".tabbar-row button").length);
    ck.check("取消后不新建标签", tabsAfter === tabsBefore, `${tabsBefore} → ${tabsAfter}`);
    const toast = await page.evaluate(() => {
      const t = document.querySelector(".toast");
      return t ? t.innerText : "";
    });
    ck.check("取消给出可识别反馈（已取消连接）", toast.includes("已取消连接"), toast || "(无 toast)");

    // ── 信任：建立会话，状态条转为 SSH ──
    await connect(page, "prod-2（演示连接失败）");
    ck.check("再次连接仍弹确认（取消不改动信任）", await page.evaluate(() => !!document.querySelector(".hk-dialog")));
    await clickText(page, "信任并连接");
    ck.check("信任后建立会话", await page.evaluate(() => !!document.querySelector(".session-toolbar")));
    const sb = await page.evaluate(() => document.querySelector(".statusbar").innerText.replace(/\s+/g, " "));
    ck.check("远程会话状态条标为 SSH（区别于本地）", sb.includes("SSH"), `实得「${sb}」`);
  },
};
