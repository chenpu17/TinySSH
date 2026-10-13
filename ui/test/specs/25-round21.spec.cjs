// 25 二十一轮：下载「另存为」模式 + 九族主题色板 + 设置面板大气化。
// 另存为模式：工具行开关（默认关）——开启后行内下载/下载所选/路径下载/菜单「下载」
// 全部弹保存对话框（demo 桩路径可断言），取消=不建卡；右键「另存为…」显式直通不受开关影响。
// 色板：9 族芯片在场（新增 aurora/celadon/sakura/obsidian），切换即时生效且 KV 持久。
// 设置面板：宽幅 + 图标导航（带描述）+ 卡片分区（外观 3 卡 / 终端 3 卡）。
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
const closeViaMenu = async (page, namePart) => {
  const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
  if (!has) return;
  await rightClickTab(page, namePart);
  await clickItem(page, "关闭会话");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};
// 确定性关闭：确认框渲染竞态会吞掉一次关闭——重试到标签消失为止
const closeTab = async (page, namePart) => {
  for (let i = 0; i < 3; i++) {
    const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
    if (!has) return;
    await closeViaMenu(page, namePart);
  }
};
const openFiles = async (page) => {
  await page.click('.session-toolbar button[title^="文件"]');
  await page.waitForTimeout(900);
};
const openQueue = async (page) => {
  await page.click("[data-testid=sb-transfer]");
  await page.waitForTimeout(500);
};
// upsertTransfer 前插新卡——DOM 第一行是最新传输卡
const lastDownLocal = (page) => page.evaluate(() => {
  const last = document.querySelector(".xfer-row");
  if (!last) return null;
  const subs = last.querySelectorAll(".xfer-sub");
  const t = subs[subs.length - 1]?.textContent ?? "";
  return t.includes("→") ? t.split("→").pop().trim() : t.trim();
});
const cardCount = (page) => page.evaluate(() => document.querySelectorAll(".xfer-row").length);

module.exports = {
  title: "二十一轮：另存为模式 / 九族色板 / 设置面板大气化",
  async run({ page, ck }) {
    await closeTab(page, "prod-1");
    await closeTab(page, "staging-1");
    await connect(page, "本机");
    await openFiles(page);

    // ── A. 另存为模式 ──
    const toggle = () => page.evaluate(() => {
      const b = document.querySelector('[data-testid="sftp-saveas-toggle"]');
      return b ? { present: true, on: b.getAttribute("aria-pressed") === "true" } : { present: false, on: false };
    });
    let tg = await toggle();
    ck.check("工具行有「另存为」开关且默认关", tg.present && !tg.on, JSON.stringify(tg));

    // 模式关：行内下载 → 核心默认目录（demo 桩 ~/Downloads/<名>）
    await page.click('.sftp-row[data-name="access.log"] .sftp-dl');
    await page.waitForTimeout(900);
    await openQueue(page);
    ck.check("模式关：下载落核心默认目录", (await lastDownLocal(page)) === "~/Downloads/access.log",
      await lastDownLocal(page));

    // 模式开：行内下载 → 保存对话框（demo 桩 /Users/demo/Downloads/<名>）
    await page.click('[data-testid="sftp-saveas-toggle"]');
    await page.waitForTimeout(300);
    tg = await toggle();
    ck.check("开关点后进入另存为模式", tg.on, JSON.stringify(tg));
    await page.click('.sftp-row[data-name="access.log"] .sftp-dl');
    await page.waitForTimeout(900);
    ck.check("模式开：行内下载弹对话框选位置", (await lastDownLocal(page)) === "/Users/demo/Downloads/access.log",
      await lastDownLocal(page));

    // 模式开 + 用户取消：不建卡不传输
    const before = await cardCount(page);
    await page.evaluate(() => window.__demoInvoke?.("demo_pick_result", { path: "" }));
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".sftp-dl")].find((b) => b.closest(".sftp-row")?.dataset.name === "error.log");
      if (!btn) throw new Error("error.log row button not found");
      btn.click();
    });
    await page.waitForTimeout(800);
    ck.check("对话框取消：不建传输卡", (await cardCount(page)) === before, `${before} → ${await cardCount(page)}`);
    await page.evaluate(() => window.__demoInvoke?.("demo_pick_result", {}));

    // 显式「另存为…」（双击动作菜单）直通：模式**关**时仍弹对话框、可自选文件名
    await page.click('[data-testid="sftp-saveas-toggle"]');
    await page.waitForTimeout(300);
    tg = await toggle();
    ck.check("开关再点退出另存为模式", !tg.on, JSON.stringify(tg));
    await page.dblclick('.sftp-row[data-name="access.log"]');
    await page.waitForTimeout(500);
    await page.click('[data-testid="sftp-menu-saveas"]');
    await page.waitForTimeout(900);
    ck.check("菜单「另存为…」显式直通", (await lastDownLocal(page)) === "/Users/demo/Downloads/access.log",
      await lastDownLocal(page));

    // ── B/C. 设置面板：九族色板 + 大气化结构 ──
    await page.click(".hb-settings");
    await page.waitForTimeout(700);
    const pals = ["graphite", "ember", "ocean", "violet", "noir", "aurora", "celadon", "sakura", "obsidian"];
    const chipCount = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="chrome-palette-${id}"]`)).length, pals);
    ck.check("九族色板芯片在场", chipCount === 9, `${chipCount}/9`);
    const navDescs = await page.evaluate(() =>
      [...document.querySelectorAll(".settings-nav .set-nav-desc")].map((e) => e.textContent.trim()));
    ck.check("导航五类各带一句定位", navDescs.length === 5 && navDescs.every((d) => d.length > 0), JSON.stringify(navDescs));
    // 二十二轮：外观两卡（应用外观/字号与缩放——终端配色卡随主题统一退役）
    const cardCounts = await page.evaluate(() => document.querySelectorAll(".settings-pane .set-card").length);
    ck.check("外观分类两卡片分区", cardCounts === 2, `实得 ${cardCounts}`);
    const dlgBox = () => page.evaluate(() => {
      const d = document.querySelector(".term-settings.settings-wide");
      return d ? { h: d.clientHeight, w: d.clientWidth } : null;
    });
    const boxA = await dlgBox();
    ck.check("设置面板定高（固定尺寸）", !!boxA && boxA.h > 400, JSON.stringify(boxA));

    await page.evaluate(() => document.querySelector('[data-testid="chrome-palette-aurora"]').click());
    await page.waitForTimeout(400);
    ck.check("切换极光：data-theme 即时生效",
      await page.evaluate(() => document.documentElement.dataset.theme === "aurora"), "");
    // 二十二轮主题统一：色板切换后活动终端主题随之派生（底色=当前 --bg resolved 值）
    ck.check("极光下终端配色随之派生（统一主题）", await page.evaluate(() => {
      const scratch = document.createElement("span");
      scratch.style.color = "var(--bg)";
      document.body.appendChild(scratch);
      const want = getComputedStyle(scratch).color;
      scratch.remove();
      const terms = window.__t_terms;
      if (!terms) throw new Error("__t_terms probe missing (dev only)");
      // map 的 value 就是 xterm Terminal 本体（十四轮教训：含死会话残留，须过滤活实例）
      const live = [...terms.values()].filter((t) => t.element && t.element.isConnected && t.element.getBoundingClientRect().height > 0);
      return live.length > 0 && live.every((t) => t.options.theme.background === want);
    }), "");
    await page.evaluate(() => document.querySelector('[data-testid="chrome-palette-obsidian"]').click());
    await page.waitForTimeout(400);
    ck.check("切换曜石：即时生效", await page.evaluate(() => document.documentElement.dataset.theme === "obsidian"), "");
    ck.check("色板选择 KV 持久（ui.palette）",
      await page.evaluate(() => localStorage.getItem("ui.palette") === "obsidian"), "");

    // 终端分类单卡三行；面板盒子尺寸恒定（分类切换只换内容不换盒子——用户反馈跳变）
    await page.click('[data-testid="settings-cat-terminal"]');
    await page.waitForTimeout(400);
    ck.check("终端分类单卡三设置行",
      (await page.evaluate(() => document.querySelectorAll(".settings-pane .set-card").length)) === 1, "");
    const boxT = await dlgBox();
    ck.check("分类切换后面板尺寸恒定", !!boxT && boxT.h === boxA.h && boxT.w === boxA.w,
      `${JSON.stringify(boxA)} → ${JSON.stringify(boxT)}`);
    await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
    await page.waitForTimeout(300);

    // reload 后色板持久（启动 KV 回放）
    await page.reload();
    await page.waitForTimeout(1500);
    ck.check("reload 后色板仍为曜石", await page.evaluate(() => document.documentElement.dataset.theme === "obsidian"), "");

    // 收尾：本地会话 reload 后不回归，SSH 预置标签若残留则逐个关（重试式）
    for (let i = 0; i < 4; i++) {
      const n = await page.evaluate(() => document.querySelectorAll(".tab").length);
      if (n === 0) break;
      const name = await page.evaluate(() => document.querySelector(".tab")?.textContent.trim() ?? "");
      if (name) await closeTab(page, name);
    }
    ck.check("收尾清空会话", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
  },
};
