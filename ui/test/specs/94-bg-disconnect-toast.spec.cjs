// 94 后台会话断线感知（GitHub #46）：用户盯着当前终端时，另一个标签已经死了
// 也不会发现——反馈里直到画面错乱才意识到连接故障。当前视口内的会话有
// .dead-overlay 就地提示；后台会话掉线必须弹一条可点击的 toast（动作=切过去），
// 且自动重连期间（Reconnecting）不打扰、只报最终 Disconnected。
//
// 用 demo 钩子 demo_drop_session（recoverOnAttempt=0 → 3 次重试耗尽后 Disconnected）
// 制造真实状态流；demo 域 session_state_feed 300ms 轮询与真实事件通道同语义。

const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

const activeSid = (page) => page.evaluate(() => {
  const tab = document.querySelector('.tab[aria-selected="true"]');
  return tab?.dataset.sid ?? null;
});

const toastOf = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll(".toast")]
    .find((e) => e.textContent.includes("会话已断开"));
  if (!el) return null;
  return {
    text: el.textContent,
    action: el.querySelector("[data-testid=toast-action]")?.textContent ?? null,
  };
});

module.exports = {
  title: "后台标签掉线：toast 提示 + 一键切到断线会话",
  async run({ page, ck }) {
    await connectLocal(page);
    // 连接本机把焦点从出厂会话上移开：s-demo-0001（prod-1）成为后台会话。
    const nowActive = await activeSid(page);
    ck.check("前置：已切到本机会话", !!nowActive, nowActive ?? "(无活动标签)");

    // 后台会话断线：Degraded → 3 次 Reconnecting（约 2.1s）→ Disconnected。
    await page.evaluate(() =>
      window.__demoInvoke("demo_drop_session", { sid: "s-demo-0001", recoverOnAttempt: 0 }));

    // 自动重连期间不弹「已断开」（状态还在 Reconnecting）
    await page.waitForTimeout(600);
    ck.check("自动重连期间不误报已断开", !(await toastOf(page)));

    let t = null;
    for (let i = 0; i < 40; i++) {
      t = await toastOf(page);
      if (t) break;
      await page.waitForTimeout(150);
    }
    ck.check("后台会话最终断线弹 toast（含主机名）", !!t && t.text.includes("prod-1"), JSON.stringify(t));
    ck.check("断线 toast 带「切换」动作", !!t && (t.action ?? "").includes("切换"), JSON.stringify(t));
    ck.check("断线 toast 不改变当前活动标签", (await activeSid(page)) === nowActive, await activeSid(page));

    // 点动作：切到断线会话，就地看到 .dead-overlay（重连入口）
    await page.click("[data-testid=toast-action]");
    await page.waitForTimeout(500);
    ck.check("点「切换」跳到断线会话标签", (await activeSid(page)) === "s-demo-0001", await activeSid(page));
    const overlay = await page.evaluate(() => {
      const el = document.querySelector(".dead-overlay");
      return el ? { text: el.textContent, banner: !!el.querySelector(".dead-banner") } : null;
    });
    ck.check("断线会话就地显示断线遮罩（重连入口在位）",
      !!overlay && overlay.banner && overlay.text.includes("会话已断开"), JSON.stringify(overlay && overlay.text.slice(0, 120)));
  },
};
