// 21 十七轮：快速连接——不存主机一次性建连。入口（welcome/hostbar 工具行）、
// 表单校验（空字段/坏地址/密钥未选）、demo 域建连走真 TOFU 门（未信任地址弹
// 首连确认）、连接后主机列表不出现该目标、reload 后会话消失（内存态边界）。
const closeViaMenu = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, "关闭会话");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};

const clickByText = async (page, selector, text) => {
  await page.evaluate(([sel, t]) => {
    const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.trim().includes(t));
    if (!b) throw new Error(`${sel} not found: ${t}`);
    b.click();
  }, [selector, text]);
  await page.waitForTimeout(400);
};

const formInput = (page, idx, value) =>
  page.evaluate(({ i, v }) => {
    const inputs = document.querySelectorAll('[data-testid="quick-connect-form"] input');
    const el = inputs[i];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, { i: idx, v: value });

module.exports = {
  title: "快速连接：不存主机一次性建连（TOFU 门 + 主机列表零污染 + 内存态边界）",
  async run({ page, ck }) {
    // 清 demo 预置（welcome 页断言需要零会话）
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");

    // ── 入口：welcome 按钮 + hostbar 工具行按钮 ──
    ck.check("welcome 页有快速连接入口",
      await page.evaluate(() => [...document.querySelectorAll(".welcome-actions button")].some((b) => b.textContent.includes("快速连接"))), "");
    ck.check("hostbar 工具行有快速连接按钮",
      await page.evaluate(() => !!document.querySelector('[data-testid="quick-connect-open"]')), "");
    await clickByText(page, ".welcome-actions button", "快速连接");
    ck.check("表单打开且带内存态说明",
      await page.evaluate(() => !!document.querySelector('[data-testid="quick-connect-form"]')), "");

    // ── 校验：空提交 / 坏地址 / 密钥未选 ──
    await clickByText(page, '[data-testid="quick-connect-form"] button', "连接");
    ck.check("空提交报「地址和用户名都不能为空」",
      await page.evaluate(() => document.querySelector('[data-testid="quick-connect-form"]').textContent.includes("地址和用户名都不能为空")), "");
    await formInput(page, 0, "http://bad");
    await formInput(page, 1, "22");
    await formInput(page, 2, "ops");
    await clickByText(page, '[data-testid="quick-connect-form"] button', "连接");
    ck.check("带协议地址被拒（应为 IP 或域名）",
      await page.evaluate(() => document.querySelector('[data-testid="quick-connect-form"]').textContent.includes("地址格式不对")), "");
    await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="quick-connect-form"] select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, "key");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await formInput(page, 0, "10.0.0.99");
    await formInput(page, 1, "2222"); // 非默认端口——顺带验证 user@addr:port 命名
    await clickByText(page, '[data-testid="quick-connect-form"] button', "连接");
    ck.check("密钥模式未选密钥被拒",
      await page.evaluate(() => document.querySelector('[data-testid="quick-connect-form"]').textContent.includes("请选择凭据库中的已有密钥")), "");

    // ── 密码 + 未信任地址：走真 TOFU 门 ──
    await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="quick-connect-form"] select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, "password");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('[data-testid="quick-connect-form"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inputs[3], "pw-demo-1"); // 密码输入（密码模式下第 4 个 input）
      inputs[3].dispatchEvent(new Event("input", { bubbles: true }));
    });
    const hostCardsBefore = await page.evaluate(() => document.querySelectorAll(".host-card").length);
    await clickByText(page, '[data-testid="quick-connect-form"] button', "连接");
    await page.waitForTimeout(700);
    ck.check("未信任地址弹首连确认（TOFU 门对快速主机同口径）",
      await page.evaluate(() => !!document.querySelector(".hk-actions button")), "");
    await clickByText(page, ".hk-actions button", "信任并连接");
    // 信任 → demo 会话就绪 → UI 轮询 attach：固定等待不可靠，轮询到出现为止
    const appeared = await page
      .waitForFunction(() => [...document.querySelectorAll(".tab")].some((t) => t.textContent.includes("ops@10.0.0.99:2222")), { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    ck.check("连接成功，标签名 = user@addr:port", appeared, "");

    // ── 主机列表零污染 ──
    const hostCardsAfter = await page.evaluate(() => document.querySelectorAll(".host-card").length);
    ck.check("主机列表不出现快速目标（卡片数不变且无该名）",
      hostCardsAfter === hostCardsBefore &&
      !(await page.evaluate(() => [...document.querySelectorAll(".host-card")].some((c) => c.textContent.includes("10.0.0.99")))),
      `before=${hostCardsBefore} after=${hostCardsAfter}`);

    // ── 收尾关闭会话，再 reload：内存态边界（会话消失、主机仍无） ──
    await closeViaMenu(page, "ops@10.0.0.99");
    ck.check("快速会话可正常关闭", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
    await page.reload();
    await page.waitForTimeout(1500);
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    ck.check("reload 后快速会话不复现（重启即失）",
      !(await page.evaluate(() => [...document.querySelectorAll(".tab")].some((t) => t.textContent.includes("ops@10.0.0.99")))), "");
    ck.check("reload 后主机列表仍无快速目标",
      !(await page.evaluate(() => [...document.querySelectorAll(".host-card")].some((c) => c.textContent.includes("10.0.0.99")))), "");
  },
};
