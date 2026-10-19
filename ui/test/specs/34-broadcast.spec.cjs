// 34 广播输入轮（P2-a）：勾选目标会话后，当前会话的键入（onData 字符）同时发往
// 勾选会话——每个目标走既有 send_keys Human 路径（demo 侧逐会话回显即断言面）。
// 断言面：状态条/工具菜单/⌘K 三入口、浮层行（当前标记/Agent 在控徽标/离线态）、
// 扇出正路径（在线目标回显）、离线目标跳过且终端内一次性告示、
// 粘贴不广播（suppress 闸）、勾选集=「额外目标」（当前会话不在集合也接收）。

/** 读某会话终端缓冲区（最近 400 行合一行文本；终端未建返回 null） */
const bufText = (page, sid) =>
  page.evaluate((s) => {
    const t = window.__t_terms && window.__t_terms.get(s);
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - 400); i < b.length; i++) {
      out.push(b.getLine(i) ? b.getLine(i).translateToString(true) : "");
    }
    return out.join("\n");
  }, sid);

/** 向活动会话终端打一行字（focus textarea → 逐键 → Enter） */
const typeLine = async (page, text) => {
  await page.evaluate(() => {
    const ta = document.querySelector(".term-session.active .xterm-helper-textarea")
      ?? document.querySelector(".xterm-helper-textarea");
    if (!ta) throw new Error("xterm textarea 不在场");
    ta.focus();
  });
  await page.keyboard.type(text, { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
};

/** 连接一台主机（demo 建新会话并自动挂上） */
const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

/** 激活某个预置会话标签 */
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

module.exports = {
  title: "广播输入：三入口/勾选扇出/离线跳过告示/粘贴不广播",
  async run({ page, ck }) {
    // ── 先连一台「本机」（Human 所有、在线），再激活预置 prod-1（Agent 在控、在线）
    //     与 staging-1（离线）——三行目标齐了，打字origin定在 prod-1 ──
    await connectHost(page, "本机");
    await activateTab(page, "staging-1");
    await activateTab(page, "prod-1");

    // ── 入口①：状态条 chip → 浮层 ──
    ck.check("状态条广播 chip 在场", await page.evaluate(
      () => !!document.querySelector('[data-testid="sb-broadcast"]')));
    await page.click('[data-testid="sb-broadcast"]');
    await page.waitForTimeout(400);
    ck.check("浮层打开且标题/说明在场", await page.evaluate(() => {
      const p = document.querySelector('[data-testid="broadcast-pop"]');
      return !!p && p.querySelector(".bp-title")?.textContent === "广播输入"
        && (p.querySelector(".bp-note")?.textContent ?? "").includes("粘贴与块重跑只进当前会话");
    }), await page.evaluate(() => document.querySelector('[data-testid="broadcast-pop"]')?.textContent?.slice(0, 120) ?? "(无浮层)"));

    // ── 目标行：三个会话、当前标记、Agent 徽标、离线态 ──
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="broadcast-row"]')].map((r) => ({
        sid: r.dataset.sid, state: r.dataset.state,
        name: r.querySelector(".bp-name")?.textContent,
        owner: !!r.querySelector(".bp-owner"),
      })));
    const localRow = rows.find((r) => r.name?.includes("本机"));
    ck.check("三行目标齐（prod-1/staging-1/本机）", rows.length === 3 && !!localRow, JSON.stringify(rows));
    ck.check("prod-1 行：当前标记 + Agent 在控徽标", (() => {
      const r = rows.find((x) => x.sid === "s-demo-0001");
      return !!r && r.state === "Connected" && r.owner && (r.name ?? "").includes("当前");
    })(), JSON.stringify(rows.find((x) => x.sid === "s-demo-0001")));
    ck.check("staging-1 行：离线态可勾选（勾选后跳过+告示语义）", (() => {
      const r = rows.find((x) => x.sid === "s-demo-0002");
      return !!r && r.state === "Disconnected";
    })(), JSON.stringify(rows.find((x) => x.sid === "s-demo-0002")));
    ck.check("本机行：Human 所有无 Agent 徽标", !!localRow && localRow.state === "Connected" && !localRow.owner,
      JSON.stringify(localRow));

    // ── 勾选 staging-1（离线）+ 本机（在线）→ chip 计数 2 ──
    await page.click('[data-testid="broadcast-row"][data-sid="s-demo-0002"] input');
    await page.click(`[data-testid="broadcast-row"][data-sid="${localRow.sid}"] input`);
    await page.waitForTimeout(300);
    ck.check("chip 计数随勾选更新为 2", await page.evaluate(() =>
      (document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? "").includes("2")),
      await page.evaluate(() => document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? ""));
    await page.click('[data-testid="broadcast-close"]');
    await page.waitForTimeout(300);

    // ── 扇出正/负路径：prod-1 里打字 → 本机回显（在线目标）；staging-1 跳过+一次性告示 ──
    await typeLine(page, "echo bc1");
    const p1 = await bufText(page, "s-demo-0001");
    const loc = await bufText(page, localRow.sid);
    const stg = await bufText(page, "s-demo-0002");
    ck.check("当前会话收到键入回显", !!p1 && p1.includes("echo bc1"), "");
    ck.check("在线目标（本机）收到广播键入", !!loc && loc.includes("echo bc1"), (loc ?? "null").slice(-200));
    ck.check("离线目标（staging-1）不收键入、终端内有广播告示", !!stg && !stg.includes("bc1") && stg.includes("广播") && stg.includes("键入未发送"),
      (stg ?? "null").slice(-200));

    // ── 粘贴不广播：⌘V 安全粘贴只进当前会话 ──
    await page.evaluate(() => {
      const stub = { readText: () => Promise.resolve(window.__pasteText ?? ""), writeText: () => Promise.resolve() };
      try { Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true }); }
      catch { navigator.clipboard.readText = stub.readText; }
      window.__pasteText = "pastehello";
    });
    await page.evaluate(() => {
      const ta = document.querySelector(".term-session.active .xterm-helper-textarea")
        ?? document.querySelector(".xterm-helper-textarea");
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", metaKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(700);
    const p1b = await bufText(page, "s-demo-0001");
    const locB = await bufText(page, localRow.sid);
    ck.check("粘贴进当前会话", !!p1b && p1b.includes("pastehello"), "");
    ck.check("粘贴不广播（本机未收到 pastehello）", !!locB && !locB.includes("pastehello"), "");

    // ── 取消勾选本机 → 后续键入不再扇出到它 ──
    await page.click('[data-testid="sb-broadcast"]');
    await page.waitForTimeout(300);
    await page.click(`[data-testid="broadcast-row"][data-sid="${localRow.sid}"] input`);
    await page.waitForTimeout(200);
    ck.check("取消勾选后 chip 计数为 1", await page.evaluate(() =>
      (document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? "").includes("1")));
    await page.click('[data-testid="broadcast-close"]');
    await page.waitForTimeout(200);
    await typeLine(page, "echo bc2");
    const locC = await bufText(page, localRow.sid);
    ck.check("取消勾选的目标不再接收（本机无 bc2）", !!locC && !locC.includes("bc2"), "");

    // ── 勾选集=「额外目标」：切到本机打字 → 未勾选的 prod-1 不收，staging-1 告示不重复 ──
    await activateTab(page, "本机");
    await typeLine(page, "echo bc3");
    const p1c = await bufText(page, "s-demo-0001");
    const stgC = await bufText(page, "s-demo-0002");
    ck.check("当前会话（本机）收到 bc3", (await bufText(page, localRow.sid) ?? "").includes("bc3"), "");
    ck.check("未勾选的 prod-1 不接收别的会话的键入", !!p1c && !p1c.includes("bc3"), "");
    ck.check("离线告示只写一次（staging-1 不因持续广播刷屏）", !!stgC && (stgC.split("键入未发送").length - 1) === 1, "");

    // ── 入口②：工具菜单 → 广播输入（带计数） ──
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".st-tools button")].find((b) => b.textContent?.includes("工具"));
      btn?.click();
    });
    await page.waitForTimeout(300);
    ck.check("工具菜单项在场且带勾选计数", await page.evaluate(() => {
      const item = document.querySelector('[data-testid="tools-broadcast"]');
      return !!item && (item.textContent ?? "").includes("（1）");
    }), await page.evaluate(() => document.querySelector('[data-testid="tools-broadcast"]')?.textContent ?? "(无菜单项)"));
    await page.click('[data-testid="tools-broadcast"]');
    await page.waitForTimeout(300);
    ck.check("工具菜单可打开浮层", await page.evaluate(
      () => !!document.querySelector('[data-testid="broadcast-pop"]')));
    await page.click('[data-testid="broadcast-clear"]');
    await page.waitForTimeout(200);
    ck.check("全部取消清空勾选（chip 计数消失）", await page.evaluate(() => {
      const c = document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? "";
      return !c.includes("1") && !c.includes("2");
    }), await page.evaluate(() => document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? ""));
    await page.click('[data-testid="broadcast-close"]');
    await page.waitForTimeout(200);

    // ── 入口③：⌘K 面板（专注模式唯一可达入口） ──
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(400);
    await page.fill('[data-testid="palette-input"]', "广播输入");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    ck.check("⌘K「广播输入」动作可打开浮层", await page.evaluate(
      () => !!document.querySelector('[data-testid="broadcast-pop"]')));
  },
};
