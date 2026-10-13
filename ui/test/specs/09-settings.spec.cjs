// 09 设置：外观 / 终端 / 凭据 / Agent 接入 / 关于 五个分区（§6.7 / §10.1）。

const openSettings = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(700);
};

const paneIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")));
const bodyText = (page) => page.evaluate(() => document.querySelector(".content").innerText.replace(/\n+/g, " | "));
/** 指定分区面板的可见文字（用于断言分区**内容**，而非「有字」）。 */
const paneTextOf = (page, testid) => page.evaluate((t) => {
  const e = document.querySelector(`[data-testid=${t}]`);
  return e ? e.innerText.replace(/\n+/g, " | ") : "";
}, testid);
const themeAttr = (page) => page.evaluate(() => document.documentElement.dataset.chrome || "");

module.exports = {
  title: "设置对话框与分区",
  async run({ page, ck }) {
    ck.check("主机栏底部有设置入口", await page.evaluate(() => !!document.querySelector(".hb-settings")));
    await openSettings(page);

    const ids = await paneIds(page);
    for (const t of ["settings-close", "settings-cat-appearance", "settings-cat-terminal", "settings-cat-credentials", "settings-cat-agent", "settings-cat-about"]) {
      ck.check(`设置含 ${t}`, ids.includes(t));
    }
    ck.check("默认打开外观分区（settings-pane-appearance）", ids.includes("settings-pane-appearance"));

    const t0 = await bodyText(page);
    ck.check("外观分区有三档应用外观", t0.includes("跟随系统") && t0.includes("深色") && t0.includes("浅色"));
    // 二十二轮主题统一：独立「终端配色」清单退役（Solarized 等双轨项不再出现），
    // 主题=九族色板单一事实源，终端配色由色板×深浅派生
    ck.check("外观分区无独立终端配色清单（主题统一）", !t0.includes("Solarized") && t0.includes("主题"));

    // 切深色 → 切浅色：主题标记随之翻转
    const before = await themeAttr(page);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "深色");
      if (btns.length) btns[0].click();
    });
    await page.waitForTimeout(600);
    const dark = await themeAttr(page);
    ck.check("点「深色」后主题标记为 dark", dark === "dark", `${before} → ${dark}`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "浅色");
      if (btns.length) btns[0].click();
    });
    await page.waitForTimeout(600);
    const light = await themeAttr(page);
    ck.check("点「浅色」后主题标记为 light", light === "light", `${dark} → ${light}`);

    // 字号
    ck.check("外观分区有字号控件", (await bodyText(page)).includes("字号"));

    // 切到终端分区（断言该分区的实际内容，不是「有字」这种近乎恒真的条件）
    await page.click("[data-testid=settings-cat-terminal]");
    await page.waitForTimeout(500);
    const termPane = await paneTextOf(page, "settings-pane-terminal");
    ck.check("终端分区显示其内容（多行粘贴保护）", termPane.includes("多行粘贴保护"), termPane.slice(0, 80));

    // 切到凭据分区
    await page.click("[data-testid=settings-cat-credentials]");
    await page.waitForTimeout(600);
    const credIds = await paneIds(page);
    ck.check("凭据分区有新建凭据入口（cred-new）", credIds.includes("cred-new"));
    ck.check("凭据分区有空态或列表（cred-empty / cred-uses）", credIds.includes("cred-empty") || credIds.includes("cred-uses"));

    // 切到 Agent 接入分区
    await page.click("[data-testid=settings-cat-agent]");
    await page.waitForTimeout(600);
    const agentIds = await paneIds(page);
    ck.check("Agent 分区有协作状态区（collab-state）", agentIds.includes("collab-state"));
    ck.check("Agent 分区有状态行（collab-state-row）", agentIds.includes("collab-state-row"));

    // 切到关于分区
    await page.click("[data-testid=settings-cat-about]");
    await page.waitForTimeout(500);
    const aboutPane = await paneTextOf(page, "settings-pane-about");
    ck.check("关于分区显示产品说明（TinySSH / 本地优先）", aboutPane.includes("TinySSH") && aboutPane.includes("本地优先"), aboutPane.slice(0, 80));

    // 关闭
    await page.click("[data-testid=settings-close]");
    await page.waitForTimeout(500);
    ck.check("关闭后设置对话框消失", await page.evaluate(() => !document.querySelector("[data-testid=settings-close]")));
  },
};
