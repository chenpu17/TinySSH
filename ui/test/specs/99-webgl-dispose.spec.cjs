// 99 GitHub #52 相关资源生命周期：addon-webgl 0.19 的 dispose 只摘画布，不显式
// 释放 WebGL context。四条最终销毁路径都必须经 detachWebgl 调 loseContext，否则
// 累计创建/销毁约 16 个后，Chromium 会驱逐仍在使用的旧上下文（错字/空白）。
const PROD = "s-demo-0001";
const STAGING = "s-demo-0002";

const installLossSpy = (page) => page.evaluate(() => {
  window.__webglLosses = 0;
  if (window.__webglLossSpyInstalled) return;
  window.__webglLossSpyInstalled = true;
  const proto = window.WebGL2RenderingContext?.prototype;
  if (!proto) return;
  const original = proto.getExtension;
  const wrapped = new WeakSet();
  proto.getExtension = function (name) {
    const ext = original.call(this, name);
    if (name === "WEBGL_lose_context" && ext && !wrapped.has(ext)) {
      wrapped.add(ext);
      const lose = ext.loseContext.bind(ext);
      ext.loseContext = () => {
        window.__webglLosses = (window.__webglLosses ?? 0) + 1;
        lose();
      };
    }
    return ext;
  };
});

const losses = (page) => page.evaluate(() => window.__webglLosses ?? -1);

const reload = async (page) => {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar");
  await page.waitForTimeout(700);
  await installLossSpy(page);
};

const clickTab = async (page, name) => {
  await page.evaluate((part) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes(part));
    if (!tab) throw new Error("tab not found: " + part);
    tab.click();
  }, name);
  await page.waitForTimeout(1000);
};

const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  if (!card) throw new Error("本机主机卡不存在");
  await card.hover();
  await page.waitForTimeout(250);
  const button = await card.$('button[title^="连接"]');
  if (!button) throw new Error("本机连接按钮不存在");
  await button.click();
  await page.waitForTimeout(1600);
};

module.exports = {
  title: "终端最终销毁：四条路径均显式释放 WebGL context（#52）",
  async run({ page, ck }) {
    await clickTab(page, "prod-1");
    await installLossSpy(page);
    await page.waitForSelector(`.term-session[data-sid="${PROD}"] canvas`, { timeout: 6000 });
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
      tab?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.ctx-menu [role="menuitem"]')].find((x) => x.textContent?.includes("关闭会话"));
      item?.click();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent?.trim() === "关闭会话");
      button?.click();
    });
    await page.waitForTimeout(1000);
    ck.eq("用户关闭标签释放一个 WebGL context", await losses(page), 1);
    ck.check("用户关闭后的终端 DOM 已移除", await page.evaluate((sid) =>
      !document.querySelector(`.term-session[data-sid="${sid}"]`), PROD), "");

    // 2. 先接入 staging，再由 UI 外 close_session；3 秒清单对账必须撤销终端。
    await reload(page);
    await clickTab(page, "staging-1");
    await installLossSpy(page);
    await page.evaluate((sid) => window.__demoInvoke("close_session", { sid }), STAGING);
    await page.waitForTimeout(4500);
    ck.eq("外部关闭对账释放一个 WebGL context", await losses(page), 1);
    ck.check("外部关闭后的终端 DOM 已移除", await page.evaluate((sid) =>
      !document.querySelector(`.term-session[data-sid="${sid}"]`), STAGING), "");

    // 3. tmux 格只是视图，但同样持有独立 WebGL context；关格必须立即释放。
    await reload(page);
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", {
      sid, sessions: ["work", "logs"],
    }), PROD);
    await clickTab(page, "prod-1");
    await page.evaluate(() => document.querySelector('[data-testid="tmux-quick"] button')?.click());
    await page.waitForTimeout(350);
    await page.click('[data-testid="tmux-pane-add-work"]');
    await page.waitForSelector('.tmux-cell[data-tmux="work"]', { timeout: 6000 });
    await page.waitForTimeout(700);
    await installLossSpy(page);
    await page.click('.tmux-cell[data-tmux="work"] [data-testid="tmux-cell-close"]');
    await page.waitForTimeout(900);
    ck.eq("tmux 格销毁释放一个 WebGL context", await losses(page), 1);
    ck.check("主终端在关格后仍保留", await page.evaluate((sid) =>
      !!document.querySelector(`.term-session[data-sid="${sid}"]`), PROD), "");

    // 4. subscribe_output 在 term 登记后失败：半建实例必须完整回滚，且重试可成功。
    await reload(page);
    await page.evaluate(() => window.__demoInvoke("demo_fail_subscribe", { times: 1 }));
    await connectLocal(page);
    ck.eq("输出订阅失败回滚释放一个 WebGL context", await losses(page), 1);
    const failed = await page.evaluate(async () => {
      const sessions = await window.__demoInvoke("list_sessions");
      const local = sessions.find((s) => s.host_id === "local");
      return { sid: local?.id ?? null, dom: local ? !!document.querySelector(`.term-session[data-sid="${local.id}"]`) : null };
    });
    ck.check("订阅失败后不残留半建终端 DOM", failed.sid && failed.dom === false, JSON.stringify(failed));
    await connectLocal(page);
    const retry = await page.evaluate(async () => {
      const activeSid = document.querySelector(".term-session.active")?.dataset.sid ?? null;
      const sessions = await window.__demoInvoke("list_sessions");
      return { activeSid, localReady: sessions.some((s) => s.id === activeSid && s.host_id === "local") };
    });
    ck.check("订阅瞬时失败后可重试并接入本机终端", retry.localReady, JSON.stringify(retry));
    ck.eq("成功重试不额外释放仍在使用的 context", await losses(page), 1);
  },
};
