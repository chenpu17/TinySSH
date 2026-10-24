// 09 设置：外观 / 终端 / 凭据 / Agent 接入 / 记录审计 / 关于 分区（§6.7 / §10.1）。

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
    for (const t of ["settings-close", "settings-cat-appearance", "settings-cat-terminal", "settings-cat-credentials", "settings-cat-agent", "settings-cat-records", "settings-cat-about"]) {
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

    // ── 本地终端一等公民轮：本地 Shell 选择 ──
    const shellSel = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="local-shell-select"]');
      if (!el) return null;
      return {
        value: el.value,
        options: [...el.querySelectorAll("option")].map((o) => ({ v: o.value, t: o.textContent })),
      };
    });
    ck.check("本地 Shell 下拉在场且默认系统默认", !!shellSel && shellSel.value === "", JSON.stringify(shellSel));
    ck.check("本地 Shell 列出探测 fixture（5 族 + 系统默认）",
      !!shellSel && shellSel.options.length === 6 &&
      shellSel.options.some((o) => o.t === "Git Bash") && shellSel.options.some((o) => o.t.includes("cmd") && o.t.includes("无命令块")),
      JSON.stringify(shellSel && shellSel.options));
    // 保存回显：选 Git Bash → select 值切换（KV 写走 persistSetting 同路）
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="local-shell-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, "git-bash");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const shellSel2 = await page.evaluate(() => document.querySelector('[data-testid="local-shell-select"]')?.value);
    ck.check("本地 Shell 切换生效（git-bash）", shellSel2 === "git-bash", String(shellSel2));
    // 复位默认（不污染其他用例域；本 spec 域隔离无碍，habit 上收干净）
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="local-shell-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);

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

    // ── rev-r47：GUI 内 Token 生命周期（签发→仅展示一次→吊销二次确认）──
    if (agentIds.includes("agent-issue-form")) {
      ck.check("Agent 分区有接入文档链接（agent-doc-url）", agentIds.includes("agent-doc-url"));
      // 签发：填 id → 点签发 → token 弹层只此一次
      await page.evaluate(() => {
        const inp = document.querySelector('[data-testid=agent-issue-form] input[aria-label="Agent id"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, "spec-agent");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click("[data-testid=agent-issue-btn]");
      await page.waitForTimeout(600);
      ck.check("签发后 token 仅展示一次弹层出现", await page.evaluate(() => !!document.querySelector("[data-testid=agent-token-once]")));
      const onceText = await paneTextOf(page, "agent-token-once");
      ck.check("token 弹层标注仅此一次并给全 token", onceText.includes("仅此一次展示"), onceText.slice(0, 60));
      await page.click("[data-testid=agent-token-close]");
      await page.waitForTimeout(400);
      const rowText = await page.evaluate(() => {
        const row = [...document.querySelectorAll("[data-testid=agent-row]")].find((r) => r.innerText.includes("spec-agent"));
        return row ? row.innerText.replace(/\n+/g, " ") : "";
      });
      ck.check("签发后列表出现新 Agent（含从未使用标注）", rowText.includes("spec-agent") && rowText.includes("从未使用"), rowText.slice(0, 80));
      // 吊销：二次确认才生效
      const revokeBtn = await page.evaluateHandle(() => {
        const row = [...document.querySelectorAll("[data-testid=agent-row]")].find((r) => r.innerText.includes("spec-agent"));
        return row.querySelector("[data-testid=agent-revoke]");
      });
      await revokeBtn.asElement().click();
      await page.waitForTimeout(300);
      ck.check("吊销首次点击只进入确认态", await page.evaluate(() => !!document.querySelector("[data-testid=agent-revoke-confirm]")));
      await page.click("[data-testid=agent-revoke-confirm]");
      await page.waitForTimeout(600);
      const still = await page.evaluate(() => [...document.querySelectorAll("[data-testid=agent-row]")].some((r) => r.innerText.includes("spec-agent")));
      ck.check("确认吊销后 Agent 从列表消失", !still);
    } else {
      ck.check("Agent 分区含接入引导（未启用态）", (await bodyText(page)).includes("接入"));
    }

    // 切到关于分区
    await page.click("[data-testid=settings-cat-about]");
    await page.waitForTimeout(500);
    const aboutPane = await paneTextOf(page, "settings-pane-about");
    ck.check("关于分区显示产品说明（TinySSH / 本地优先）", aboutPane.includes("TinySSH") && aboutPane.includes("本地优先"), aboutPane.slice(0, 80));
    // 版本号轮：0.10.0（演示模式回退 package.json 同源；演示域无编译产物，
    // 「（… 编译）」段自动略去——真机由 get_build_time 注入）
    const ver = await page.textContent("[data-testid=about-version]");
    ck.check("关于分区显示版本号 v0.10.0（无编译时间段）",
      /TinySSH v0\.10\.0/.test(ver ?? "") && !/编译/.test(ver ?? ""), ver ?? "");
    const author = await page.textContent("[data-testid=about-author]");
    ck.check("关于分区署名作者：陈普", author === "作者：陈普", author ?? "");
    // 版本号轮：标题栏应用名右侧常驻版本标签（同源 package.json 回退）
    ck.check("标题栏应用名右侧显示版本标签 v0.10.0",
      await page.evaluate(() =>
        /^v0\.10\.0$/.test(document.querySelector(".titlebar .tb-left .ver-tag")?.textContent.trim() ?? "")));

    // 关闭
    await page.click("[data-testid=settings-close]");
    await page.waitForTimeout(500);
    ck.check("关闭后设置对话框消失", await page.evaluate(() => !document.querySelector("[data-testid=settings-close]")));
  },
};
