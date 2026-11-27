// 107 KI-137：重连成功进入「已重连 · 待核实」后不再常驻整行横幅——用户反馈
// 「这个重连好了也一直在显示，占用显示空间」。此前横幅把标签条与终端整体压矮
// 27px，直到用户提交第一条命令才让位。断言面：
//   ① 进入重确认后页面没有重确认横幅，标签条与终端顶边不动（无压矮、无重排）；
//   ② 进入的那一拍弹一条 toast（文案同原横幅，含 Agent 暂停说明），随后自动消失；
//   ③ 状态全程可见：标签琥珀点 + 工具栏状态胶囊「已重连 · 待核实」，title 为同一句；
//   ④ 终端回车提交后转回「已连接」，胶囊 title 清空；再次重连会再弹一次（每轮一次）；
//   ⑤ 人类掌控的会话文案不带「Agent 已暂停」。

const SID = "s-demo-0001";
const NOTE = "已重连；旧现场待核实——你可以继续操作";
const AGENT_TAIL = "；Agent 已暂停（普通变更仍受限）";
const CLS = ["ok", "warn", "err", "dim"];

const stateOf = (page) => page.evaluate(({ sid, cls }) => {
  const pick = (el) => (el ? [...el.classList].find((c) => cls.includes(c)) ?? null : null);
  const tab = document.querySelector(`.tab[data-sid="${sid}"] .tab-dot`);
  const chip = document.querySelector(".session-toolbar .st-state");
  const top = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().top) : null;
  };
  return {
    dot: pick(tab),
    chip: chip?.textContent ?? null,
    chipCls: pick(chip),
    chipTitle: chip?.getAttribute("title") ?? null,
    reconfirmBar: !!document.querySelector(".notice-bar.warn"),
    bars: document.querySelectorAll(".notice-bar").length,
    tabRowTop: top(".tabbar-row"),
    termTop: top(".term-session.active"),
  };
}, { sid: SID, cls: CLS });

const pollFor = async (page, pred, timeout = 6000) => {
  const dl = Date.now() + timeout;
  let s = await stateOf(page);
  while (Date.now() < dl && !pred(s)) {
    await page.waitForTimeout(100);
    s = await stateOf(page);
  }
  return s;
};

const noticeToasts = (page, text) => page.evaluate((needle) =>
  // toast 的 textContent 连带 ✕ 钮的「×」：正文取「整串去掉 ✕」
  [...document.querySelectorAll(".toast")]
    .map((e) => {
      const x = e.querySelector(".toast-x");
      const body = x ? (e.textContent ?? "").replace(x.textContent, "") : (e.textContent ?? "");
      return { text: body, cls: e.className, closable: !!x };
    })
    .filter((t) => !needle || t.text === needle), text ?? null);

const focusTerm = (page) => page.evaluate(() =>
  (document.querySelector(".term-session.active .xterm-helper-textarea")
    ?? document.querySelector(".xterm-helper-textarea"))?.focus());

const drop = (page) => page.evaluate((sid) =>
  window.__demoInvoke("demo_drop_session", { sid, recoverOnAttempt: 1 }), SID);

const waitToastGone = async (page, timeout = 9000) => {
  const dl = Date.now() + timeout;
  while (Date.now() < dl) {
    if ((await noticeToasts(page)).length === 0) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

module.exports = {
  title: "重确认提示：不占行的一次性 toast + 工具栏状态胶囊（KI-137）",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    await page.evaluate((sid) => document.querySelector(`.tab[data-sid="${sid}"]`)?.click(), SID);
    await page.waitForTimeout(500);
    const base = await stateOf(page);
    ck.eq("前置：prod-1 为活动会话且已连接", base.dot, "ok");
    ck.eq("前置：没有重确认 toast", (await noticeToasts(page)).length, 0);
    ck.check("前置：prod-1 由 Agent 掌控（工具栏有「接管」钮）", await page.evaluate(() =>
      !!document.querySelector('.session-toolbar button[title^="接管会话："]')));

    // ---- 第 1 轮：自动重连第 1 次成功 → Reconfirming ----
    await drop(page);
    const rc = await pollFor(page, (s) => !!s.chip?.includes("已重连 · 待核实"));
    ck.eq("进入重确认：工具栏胶囊「已重连 · 待核实」", rc.chip, "已重连 · 待核实");
    // 等红色重连条撤场再量布局（重连进行中的条本来就该在）
    const settled = await pollFor(page, (s) => s.bars === 0, 4000);
    ck.check("重确认期间页面没有重确认横幅（此刻也没有任何状态条）", !settled.reconfirmBar && settled.bars === 0,
      `bar=${settled.reconfirmBar} bars=${settled.bars}`);
    ck.eq("标签条顶边不动（不压矮）", settled.tabRowTop, base.tabRowTop);
    ck.eq("终端顶边不动（不重排）", settled.termTop, base.termTop);
    ck.eq("标签状态点为琥珀 warn", settled.dot, "warn");
    ck.eq("工具栏胶囊为 warn 色", settled.chipCls, "warn");
    ck.eq("胶囊 title 是完整说明（Agent 掌控时点名 Agent 暂停）", settled.chipTitle, NOTE + AGENT_TAIL + "。");

    const toasts = await noticeToasts(page);
    ck.eq("进入重确认的那一拍弹一条说明 toast", toasts.length, 1);
    ck.eq("toast 文案同原横幅（含 Agent 暂停说明）", toasts[0]?.text ?? null, NOTE + AGENT_TAIL + "。");
    ck.check("toast 为 info 级（不是错误红）", !!toasts[0] && toasts[0].cls.includes("toast info") && !toasts[0].cls.includes("err"),
      JSON.stringify(toasts));
    ck.check("toast 带 ✕ 可手动关掉", !!toasts[0]?.closable);

    // toast 自动消失：不常驻
    ck.check("说明 toast 自动消失（≤9s）", await waitToastGone(page));
    const still = await stateOf(page);
    ck.eq("toast 消失后状态仍可见：胶囊还是「已重连 · 待核实」", still.chip, "已重连 · 待核实");
    ck.eq("toast 消失后状态仍可见：标签还是琥珀点", still.dot, "warn");

    // ---- 回车提交 → 回到已连接 ----
    await focusTerm(page);
    await page.keyboard.type("ls", { delay: 30 });
    await page.keyboard.press("Enter");
    const ok = await pollFor(page, (s) => s.dot === "ok");
    ck.eq("终端回车后标签变绿", ok.dot, "ok");
    ck.eq("终端回车后胶囊「已连接」", ok.chip, "已连接");
    ck.eq("已连接后胶囊不再带重确认 title", ok.chipTitle, null);

    // ---- 第 2 轮：再次重连 → 再弹一次（每轮一次，不因上一轮弹过而哑） ----
    await page.waitForTimeout(600);
    await drop(page);
    await pollFor(page, (s) => !!s.chip?.includes("已重连 · 待核实"));
    await page.waitForTimeout(300);
    const again = await noticeToasts(page);
    ck.eq("再次重连再弹一次说明 toast", again.length, 1);
    ck.eq("第 2 轮 toast 文案不变", again[0]?.text ?? null, NOTE + AGENT_TAIL + "。");
    // 切走再切回：同一轮重确认里不重复弹（只认状态迁移的那一拍）
    await page.evaluate(() => document.querySelector('.tab[data-sid="s-demo-0002"]')?.click());
    await page.waitForTimeout(400);
    await page.evaluate((sid) => document.querySelector(`.tab[data-sid="${sid}"]`)?.click(), SID);
    await page.waitForTimeout(400);
    ck.eq("同一轮重确认里切走再切回不重复弹", (await noticeToasts(page)).length, 1);
    await focusTerm(page);
    await page.keyboard.press("Enter");
    ck.eq("第 2 轮回车后标签变绿", (await pollFor(page, (s) => s.dot === "ok")).dot, "ok");

    // ---- 人类掌控的会话：文案不带 Agent 暂停 ----
    await page.waitForTimeout(600);
    await page.evaluate((sid) => window.__demoInvoke("set_control", { sid, owner: "Human" }), SID);
    // 控制权经列表轮询（3s）进界面：等「接管」钮撤掉再断线
    let handoverSeen = false;
    for (let i = 0; i < 50 && !handoverSeen; i++) {
      handoverSeen = await page.evaluate(() => !document.querySelector('.session-toolbar button[title^="接管会话："]'));
      if (!handoverSeen) await page.waitForTimeout(100);
    }
    ck.check("前置：控制权已交到人类（「接管」钮撤掉）", handoverSeen);
    await drop(page);
    const human = await pollFor(page, (s) => !!s.chip?.includes("已重连 · 待核实"));
    ck.eq("人类掌控：胶囊 title 不带 Agent 暂停", human.chipTitle, NOTE + "。");
    await page.waitForTimeout(300);
    const humanToasts = await noticeToasts(page, NOTE + "。");
    ck.eq("人类掌控：toast 文案不带 Agent 暂停", humanToasts.length, 1);
    await focusTerm(page);
    await page.keyboard.press("Enter");
    ck.eq("第 3 轮回车后标签变绿", (await pollFor(page, (s) => s.dot === "ok")).dot, "ok");
  },
};
