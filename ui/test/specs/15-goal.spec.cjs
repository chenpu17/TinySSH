// 15 任务目标（委托留言）：保存 / 清除 / 跨会话不串台（§4.2 / R9 / 审核 H1）。
//
// H1 是历史缺陷：切到无目标的会话时，输入框必须**立即清空**，不得短暂显示上一个会话的目标。

const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};
const toast = (page) => page.evaluate(() => {
  const t = document.querySelector(".toast");
  return t ? t.innerText : "";
});
/** 等上一条 toast 自消，避免读到上一步的残留（toast 约 3.2s 自消）。 */
const waitToastGone = async (page) => {
  await page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
};
const panelText = (page) => page.evaluate(() => document.querySelector(".task-panel").innerText.replace(/\n+/g, " | "));
const goalValue = (page) => page.evaluate(() => {
  const e = document.querySelector(".task-panel .goal-input");
  return e ? e.value : null;
});

module.exports = {
  title: "任务目标保存/清除与跨会话隔离",
  async run({ page, ck }) {
    await connect(page, "本机");
    await page.click("[data-testid=tools-collab]");
    await page.waitForTimeout(900);

    ck.check("协作面板有「任务目标」小节", (await panelText(page)).includes("任务目标"), (await panelText(page)).slice(0, 120));
    ck.check("有目标输入框 .goal-input", (await goalValue(page)) !== null);

    // 保存
    await page.fill(".task-panel .goal-input", "R45 走查：把日志打包到 /tmp");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".task-panel button")].find((x) => x.textContent.trim() === "保存");
      if (b) b.click();
    });
    await page.waitForTimeout(1000);
    ck.check("保存后提示「任务目标已更新」", (await toast(page)).includes("任务目标已更新"), await toast(page));
    ck.check("保存后出现「清除」按钮", await page.evaluate(() => [...document.querySelectorAll(".task-panel button")].some((b) => b.textContent.trim() === "清除")));

    // 清除（先等上一条 toast 自消，否则读到的是「已更新」）
    await waitToastGone(page);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".task-panel button")].find((x) => x.textContent.trim() === "清除");
      if (b) b.click();
    });
    await page.waitForTimeout(1000);
    ck.check("清除后提示「任务目标已清除」", (await toast(page)).includes("任务目标已清除"), await toast(page));
    ck.eq("清除后输入框为空", await goalValue(page), "");

    // ── 跨会话不串台（H1）──
    // 原缺陷（v1.37 H1）：切到别的会话时，输入框会**短暂显示上一会话的委托**，
    // 随手一存就把 A 的任务写进 B。所以要走**未保存草稿**这条路（已保存的目标会被简报回填覆盖，
    // 抓不到），并且用**标签页切换**（新连接会关掉面板，输入框根本不在，断言会空转）。
    // 判据用高频采样，覆盖切换**整个窗口**的每一帧，而非只看稳态。
    await page.fill(".task-panel .goal-input", "A 会话的草稿");
    await page.waitForTimeout(400);
    ck.eq("A 会话有未保存草稿", await goalValue(page), "A 会话的草稿");

    await page.evaluate(() => {
      window.__goalSamples = [];
      window.__goalTimer = setInterval(() => {
        const e = document.querySelector(".task-panel .goal-input");
        const t = document.querySelector('[role=tab][aria-selected=true] .tab-label');
        window.__goalSamples.push({ goal: e ? e.value : null, hasInput: !!e, active: t ? t.textContent.trim() : null });
      }, 16);
    });

    // 切到已有的 prod-1 标签（面板保持打开，输入框一直在）
    // 点 .tab-label（文本）而非 .tab 整体：tab 内分屏/关闭按钮有 28×28 ::after 扩展
    // 命中区（R27），Windows 字体下标签更窄，.tab 几何中心会落进扩展命中区、被
    // stopPropagation 触发分屏而非切换会话——会话不切走，H1 断言全部空转假红。
    // 点文本中心与真实用户点击标签等价，且对字体度量不敏感。
    await page.click('.tab .tab-label:text-is("prod-1")');
    await page.waitForTimeout(1600);
    const samples = await page.evaluate(() => { clearInterval(window.__goalTimer); return window.__goalSamples; });
    // 只在**活动会话已不是本机**的帧上判泄漏——切换前的帧显示本机的草稿本就合法
    const after = samples.filter((s) => s.active !== null && s.active !== "本机");
    const withInput = after.filter((s) => s.hasInput);
    const leaked = withInput.filter((s) => s.goal === "A 会话的草稿");
    ck.check("切走后输入框一直在（断言不是空转）", withInput.length > 0, `切换后 ${after.length} 帧，其中输入框在场 ${withInput.length} 帧`);
    ck.check("切走后每一帧都不显示上一会话的草稿（H1 瞬态）",
      withInput.length > 0 && leaked.length === 0,
      `切换后 ${withInput.length} 帧，闪现 ${leaked.length} 帧`);

    const bGoal = await goalValue(page);
    ck.check("切到另一会话后目标框已渲染", bGoal !== null, `实得 ${JSON.stringify(bGoal)}`);
    ck.check("切到另一会话后目标框不显示 A 的草稿", bGoal !== "A 会话的草稿", `实得 ${JSON.stringify(bGoal)}`);
  },
};
