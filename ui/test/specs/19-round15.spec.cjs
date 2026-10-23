// 19 十五轮三件：选中即复制（设置开关+blob 持久化+划选写剪贴板）、标签拖拽排序
// （HTML5 DnD 换序+⌘序一致）、重连上次会话（blob sessions.last 记忆 + reload 后
// 欢迎页一键恢复——demo 的 workspace 走 localStorage，同上下文 reload 不丢，可全链测）。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};

const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
};

const clickItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};

const tabCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".tab").length);

const tabLabels = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".tab .tab-label")].map((x) => x.textContent));

const blob = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}"));

module.exports = {
  title: "选中即复制/标签拖拽排序/重连上次会话",
  async run({ page, ck }) {
    // ── 清 demo 预置（prod-1/staging-1）——不清则标签数/清单全歪 ──
    const closeViaMenu = async (namePart) => {
      await rightClickTab(page, namePart);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    };
    await closeViaMenu("prod-1");
    await closeViaMenu("staging-1");

    // ── 选中即复制：设置开关 + blob 持久化 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("设置终端分区有「选中即复制」开关", await page.evaluate(() => !!document.querySelector('[data-testid="cos-toggle"]')), "");
    await page.click('[data-testid="cos-toggle"]');
    await page.waitForTimeout(500);
    ck.check("开关点后为选中态", await page.evaluate(() => document.querySelector('[data-testid="cos-toggle"]').checked), "");
    let ws = await blob(page);
    ck.check("blob terminal 域写入 copy_on_select=true", ws?.terminal?.copy_on_select === true, JSON.stringify(ws?.terminal));
    ck.check("同域 paste_guard 不被覆盖（合并写）", ws?.terminal?.paste_guard === true, `paste_guard=${ws?.terminal?.paste_guard}`);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(400);

    // ── 两会话 → blob sessions.last 记忆（去重）──
    await connect(page, "本机");
    await connect(page, "prod-1");
    ck.check("两标签就位", (await tabCount(page)) === 2, `tabs=${await tabCount(page)}`);
    ws = await blob(page);
    const last0 = ws?.sessions?.last ?? [];
    ck.check("blob sessions.last 记了 2 台主机", last0.length === 2, JSON.stringify(last0));
    ck.check("清单含 local 主机", last0.includes("local"), "");

    // ── 划选写剪贴板（demo 域 monkey-patch 捕获 writeText）──
    await page.evaluate(() => {
      const w = window;
      w.__copied = null;
      navigator.clipboard.writeText = (t) => { w.__copied = t; return Promise.resolve(); };
      const terms = w.__t_terms;
      if (!terms) throw new Error("__t_terms probe missing (dev only)");
      const live = [...terms.values()].filter((t) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      });
      live[0].select(0, 0, 12);
    });
    await page.waitForTimeout(400);
    const copied = await page.evaluate(() => window.__copied);
    ck.check("划选即写剪贴板（非空）", typeof copied === "string" && copied.length > 0, JSON.stringify(copied));

    // ── reload：demo 预置会话会重新打开但不武装（armed=用户主动建连），先清掉
    // 让欢迎页可见；blob 的 sessions.last 应原样保留 ──
    await page.reload();
    await page.waitForTimeout(1500);
    await closeViaMenu("prod-1");
    await closeViaMenu("staging-1");
    await page.waitForTimeout(600);
    ws = await blob(page);
    ck.check("reload+清预置后清单未被覆盖", JSON.stringify(ws?.sessions?.last) === JSON.stringify(last0), JSON.stringify(ws?.sessions?.last));
    const btn = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="reconnect-last"]');
      return b ? b.textContent : null;
    });
    ck.check("欢迎页有「重连上次会话」", !!btn, btn || "(无按钮)");
    ck.check("按钮文案带数量（2）", !!btn && btn.includes("（2）"), btn || "");
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("reload 后选中即复制仍开（blob 持久化）", await page.evaluate(() => document.querySelector('[data-testid="cos-toggle"]').checked), "");
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    // ── 一键重连 → 两标签恢复 ──
    await page.evaluate(() => document.querySelector('[data-testid="reconnect-last"]')?.click());
    await page.waitForTimeout(2000);
    ck.check("一键重连恢复 2 标签", (await tabCount(page)) === 2, `tabs=${await tabCount(page)}`);

    // ── 拖拽排序：真鼠标手势。拖拽组合分屏轮起标签拖拽是 pointer 自定义拖拽
    // （HTML5 DnD 在 WebView2 被 wry 的 IDropTarget 接管根本发不起来）——真鼠标
    // 三端一致，demo 即测真路径。第 1 标签按住拖到第 2 标签右半 → 插到其后 → 对调 ──
    const before = await tabLabels(page);
    const pts = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".tab")];
      if (tabs.length < 2) throw new Error("need 2 tabs");
      // 抓标签文字中心（人手抓标签的自然位置，避开常显的分屏/关闭钮）
      const s = tabs[0].querySelector(".tab-label").getBoundingClientRect();
      const d = tabs[1].getBoundingClientRect();
      return { sx: s.left + s.width / 2, sy: s.top + s.height / 2, dx: d.left + d.width * 0.8, dy: d.top + d.height / 2 };
    });
    await page.mouse.move(pts.sx, pts.sy);
    await page.mouse.down();
    await page.mouse.move((pts.sx + pts.dx) / 2, (pts.sy + pts.dy) / 2, { steps: 5 });
    await page.mouse.move(pts.dx, pts.dy, { steps: 5 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const after = await tabLabels(page);
    ck.check("拖拽后标签次序对调", before.length === 2 && after[0] === before[1] && after[1] === before[0],
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    ws = await blob(page);
    const last1 = ws?.sessions?.last ?? [];
    ck.check("拖拽后 sessions.last 跟随新序", last1.length === 2 && last1[0] === last0[1] && last1[1] === last0[0],
      `${JSON.stringify(last0)} → ${JSON.stringify(last1)}`);

    // ── 收尾：不留会话给其他 spec（右键关闭，确认按钮存在才点）──
    for (let i = 0; i < 2; i++) {
      const more = await page.evaluate(() => document.querySelectorAll(".tab").length);
      if (more === 0) break;
      await page.evaluate(() => {
        const tab = document.querySelector(".tab");
        tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
      });
      await page.waitForTimeout(350);
      await clickItem(page, "关闭会话");
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
    }
    ck.check("收尾清空会话", (await tabCount(page)) === 0, `tabs=${await tabCount(page)}`);
  },
};
