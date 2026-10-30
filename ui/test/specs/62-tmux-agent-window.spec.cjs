// 62 tmux 联动二（Agent 分窗）：会话 attach 进 tmux 后，agent 的 Shell 模式执行
// 自动落远端专属窗口 tinyssh-agent（后端 run_tmux_window，纯函数单测在
// handle::tests；此处验前端契约面）——SessionInfo.tmux_attached 随列表下发、
// agent 面板一行小字提示（活动会话 attach 才显示 / 无 attach 不显示 / fleet
// 编排者不显示）、界面语言切换即时生效。
// demo 镜像：staging-1 预置 Disconnected + work/logs；恢复现场后 tmux_attached=work。

const waitToast = async (page, substr, timeout = 7000) =>
  page.evaluate(async ({ s, tmo }) => {
    const dl = Date.now() + tmo;
    while (Date.now() < dl) {
      const els = [...document.querySelectorAll(".toast")];
      if (els.some((e) => (e.textContent ?? "").includes(s))) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }, { s: substr, tmo: timeout });

const activateTab = async (page, label) => {
  const ok = await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes(t));
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  if (!ok) throw new Error(`标签不在场：${label}`);
  await page.waitForTimeout(700);
};

const hint = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="agent-tmux-hint"]')?.textContent ?? null);

// tmux_attached 随 3s 清单轮询下发（demo tmux_attach 只改后端不推事件）——提示行
// 出现必须轮询等待；固定短等待是在跟轮询相位赌运气（坑 82 同族，坑 55 禁 waitForFunction）
const waitHint = (page, timeout = 5500) =>
  page.evaluate(async (tmo) => {
    const dl = Date.now() + tmo;
    while (Date.now() < dl) {
      const v = document.querySelector('[data-testid="agent-tmux-hint"]')?.textContent ?? null;
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }, timeout);

module.exports = {
  title: "tmux Agent 分窗：tmux_attached 下发/agent 面板一行提示/无 attach 不显示/fleet 不显示/语言即时切换",
  async run({ page, ck }) {
    // 步 0：清 tmux 偏好（同源 localStorage 跨 spec 存留——61 轮可能写过
    // declined/last，会压掉教学横幅）+ 面板互斥持久键（上轮崩溃残留
    // ui.agentbar=1 会让 reload 后面板自动开、rail 点击语义反转），reload
    // 让 demo 夹具回到预置断线态。
    await page.evaluate(() => {
      localStorage.removeItem("tmux.v1.prefs");
      localStorage.removeItem("ui.agentbar");
      localStorage.removeItem("ui.fleetbar");
      localStorage.removeItem("ui.monitorbar");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);

    // ── A. 恢复现场 → SessionInfo.tmux_attached 随列表下发 ──
    await activateTab(page, "staging-1");
    ck.check("教学横幅在场（清偏好后回教学态）",
      (await page.evaluate(() => document.querySelector(".dead-banner")?.textContent ?? "")).includes("检测到远端有 tmux 会话在运行"),
      await page.evaluate(() => document.querySelector(".dead-banner")?.innerText ?? "无横幅"));
    await page.click('[data-testid="tmux-pick-work"]');
    ck.check("恢复现场 toast", await waitToast(page, "已恢复现场（tmux work"), "");
    await page.waitForTimeout(700);
    const sess = await page.evaluate(() => window.__demoInvoke("list_sessions"));
    const st2 = (sess ?? []).find((s) => s.id === "s-demo-0002");
    ck.check("list_sessions 下发 tmux_attached=work（demo 镜像真实 SessionInfo）",
      st2?.tmux_attached === "work", JSON.stringify(st2?.tmux_attached ?? null));

    // ── B. agent 面板一行小字提示（活动会话已 attach 才显示）──
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(500);
    const zh = await waitHint(page);
    ck.check("agent 面板显示分窗提示（tinyssh-agent）",
      !!zh && zh.includes("tinyssh-agent"), zh ?? "无提示行");
    await activateTab(page, "prod-1");
    ck.check("活动会话未 attach tmux → 提示行消失", (await hint(page)) === null, await hint(page));
    await activateTab(page, "staging-1");
    const zhBack = await waitHint(page);
    ck.check("切回已 attach 会话 → 提示行复现",
      !!zhBack && zhBack.includes("tinyssh-agent"), zhBack ?? "无提示行");

    // ── C. fleet 编排者形态不显示（跨主机不落专窗）──
    await page.click('[data-testid="rail-fleet"]');
    await page.waitForTimeout(600);
    ck.check("fleet 视图无分窗提示", (await hint(page)) === null, await hint(page));
    await page.click('[data-testid="rail-fleet"]');
    await page.waitForTimeout(600);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(500);

    // ── D. 界面语言切 EN 即时生效（locale 是 App state；agent 面板与主机栏
    //        四向互斥——.hb-settings 在主机栏上，收 agent 面板后必须点
    //        rail-hosts 主机栏才回来）──
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    await page.click(".hb-settings");
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="locale-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, "en");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(400);
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(500);
    ck.check("en 下提示行即时变英文（dedicated remote tmux window）",
      ((await hint(page)) ?? "").includes("dedicated remote tmux window"), await hint(page));
    // 还原 zh，避免污染后续 spec 的默认语言断言
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    await page.click(".hb-settings");
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="locale-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, "zh");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(400);
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="rail-agent"]');
    await page.waitForTimeout(500);
    const zhEnd = await hint(page);
    ck.check("切回 zh：提示行复原中文", !!zhEnd && zhEnd.includes("tinyssh-agent"), zhEnd ?? "无提示行");
  },
};
