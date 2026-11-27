// 109 标签活跃度（terminal/activity.ts）：标签状态点的两种衍生视觉。用户诉求「后端连接在
// 活跃更新（SSH 屏幕有显示）时，标签按钮上要有视觉体现；长期不活跃也可以有」。断言面：
//   ① 正在输出——输出帧到达后状态点扩散同色光环，连续输出按节拍（BEAT_MS）一圈圈放；
//      切到后台照样转；输出停下后自然收尾（LIVE_HOLD_MS 内摘除、动画不残留、不再出圈）；
//   ② 前台回显静默——屏幕上看得到的终端里，本地输入（键盘、粘贴、控制字符接管、广播扇出）
//      之后 600ms 内到达的帧不记账，不分帧长（shell 逐键重绘整行、长粘贴的回显都算回显；
//      正在打字的标签不自己一圈圈闪）；窗口之外到达的输出照记，活动标签也出圈；后台标签一律记；
//   ③ 久未输出——已连接、且 30 分钟既无输出也没被切到的后台会话：实心点变空心环、文字
//      退一档、提示报「N 分钟无输出」；活动标签 / 已断开的不判；输出一到或切上去即解除；
//   ④ 分屏组标签：任一成员有输出即活跃，全部成员闲置才算闲置；
//   ⑤ tmux 面板格子的输出记在所属会话的标签上，格子里的输入同一条回显规则；
//   ⑥ 减弱动效：不出光环，改为一档更亮的静态辉光；⑦ 英文界面文案。
// 读数走 DEV 探针 window.__t_activity（stats / age；release 构建里没有，本 spec 只在 dev
// server 上跑）。「久未输出」不必真等：age() 把某会话的最近活动往回拨。
const SID_AGENT = "s-demo-0001"; // demo 预置 prod-1（Agent 掌控）
const SID_DEAD = "s-demo-0002";  // demo 预置 staging-1（已断开）
const MIN = 60_000;

const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$(".host-connect-btn")).click();
  await page.waitForTimeout(1400);
};

const focusTerm = (page) => page.evaluate(() =>
  (document.querySelector(".term-session.active .xterm-helper-textarea")
    ?? document.querySelector(".xterm-helper-textarea"))?.focus());

const tabsInfo = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".tab")].map((t) => ({
    key: t.dataset.key,
    gid: t.dataset.gid ?? null,
    sid: t.dataset.sid,
    label: t.querySelector(".tab-label")?.textContent ?? "",
    count: t.querySelector(".tab-count")?.textContent ?? null,
  })));

const activeTab = (page) => page.evaluate(() => {
  const t = document.querySelector(".tab.tab-active");
  return t ? { key: t.dataset.key, sid: t.dataset.sid } : null;
});

/** 标签上的活跃度读数：命令式属性 data-live、闲置类、光环动画、计算样式、提示文案。 */
const tabOf = (page, key) => page.evaluate((k) => {
  const tab = document.querySelector(`.tab[data-key="${k}"]`);
  if (!tab) return null;
  const dot = tab.querySelector(".tab-dot");
  const ping = tab.querySelector(".tab-ping");
  const label = tab.querySelector(".tab-label");
  const cs = (el) => getComputedStyle(el);
  return {
    live: tab.getAttribute("data-live"),
    idle: tab.classList.contains("tab-idle"),
    active: tab.classList.contains("tab-active"),
    anims: ping?.getAnimations?.().length ?? -1,
    ringColor: ping ? cs(ping).borderTopColor : null,
    dotColor: dot ? cs(dot).color : null,
    dotBg: dot ? cs(dot).backgroundColor : null,
    dotShadow: dot ? cs(dot).boxShadow : null,
    labelColor: label ? cs(label).color : null,
    title: tab.getAttribute("title"),
    aria: tab.getAttribute("aria-label"),
    width: Math.round(tab.getBoundingClientRect().width * 10) / 10,
  };
}, key);

/** 标签所在上下文里某个主题变量的计算色（临时探针挂在标签内，读完即摘）。 */
const cssVarIn = (page, key, name) => page.evaluate(({ k, n }) => {
  const tab = document.querySelector(`.tab[data-key="${k}"]`);
  if (!tab) return null;
  const probe = document.createElement("span");
  probe.style.color = `var(${n})`;
  tab.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, { k: key, n: name });

const pollTab = async (page, key, pred, timeout = 4000) => {
  const dl = Date.now() + timeout;
  let t = await tabOf(page, key);
  while (Date.now() < dl && !pred(t)) {
    await page.waitForTimeout(80);
    t = await tabOf(page, key);
  }
  return t;
};

const stats = (page) => page.evaluate(() => window.__t_activity.stats());
const beatsOf = async (page, key) => (await stats(page)).beats[key] ?? 0;
/** 把某会话的最近活动往回拨 ms 并立即重算闲置表（探针；返回钩子在不在）。 */
const age = (page, sid, ms) => page.evaluate(({ sid, ms }) => {
  const h = window.__t_activity;
  if (typeof h?.age !== "function") return false;
  h.age(sid, ms);
  return true;
}, { sid, ms });
/** 给某个（通常在后台的）会话直接打一帧按键——demo 原样回显，走真实输出帧那条路。
 *  直接进 demo 适配器、不过前端的 onData：不算本地输入（不进回显窗口）。 */
const bgKey = (page, sid, keys) => page.evaluate(({ sid, keys }) =>
  window.__demoInvoke("send_keys", { sid, keys }), { sid, keys });
/** 同 bgKey，返回「发出这一帧时，离该会话最近一次本地输入过了多久毫秒」（页面时钟）。 */
const bgKeyAge = (page, sid, keys) => page.evaluate(({ sid, keys }) => {
  window.__demoInvoke("send_keys", { sid, keys });
  const k = window.__t_activity.stats().lastKey[sid];
  return typeof k === "number" ? Date.now() - k : null;
}, { sid, keys });
/** 探针读数：某会话最近一次输出 / 本地输入的时刻（没记过为 undefined）。 */
const lastOutOf = (page, sid) => page.evaluate((s) => window.__t_activity.stats().lastOut[s], sid);
const lastKeyOf = (page, sid) => page.evaluate((s) => window.__t_activity.stats().lastKey[s], sid);
/** 等到某会话最近一次本地输入已经过去 ms（回显窗口之外；时钟取页面里的）。 */
const waitKeyAged = async (page, sid, ms, timeout = 4000) => {
  const dl = Date.now() + timeout;
  while (Date.now() < dl) {
    if (await page.evaluate(({ s, ms }) => {
      const k = window.__t_activity.stats().lastKey[s];
      return typeof k === "number" && Date.now() - k >= ms;
    }, { s: sid, ms })) return true;
    await page.waitForTimeout(60);
  }
  return false;
};

/** 终端缓冲里 needle 的出现次数：最近 300 行不留分隔接成一串再找（长行会在列边界折行，
 *  逐行找会漏掉骑在折行处的串；needle 取够独特的串，免得跨行拼接误配）。
 *  xterm 走 WebGL 画布，DOM 读不到文本——只能读 buffer。 */
const bufCount = (page, which, key, needle) => page.evaluate(({ which, key, needle }) => {
  const m = which === "pane" ? window.__t_pane_terms : window.__t_terms;
  const t = m?.get(key);
  if (!t) return -1;
  const b = t.buffer.active;
  const out = [];
  for (let i = Math.max(0, b.length - 300); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
  return out.join("").split(needle).length - 1;
}, { which, key, needle });

/** 轮询到终端缓冲里出现 needle 为止（帧经节流器到达 = 已过标签活跃度的记账点）。 */
const waitBuf = async (page, which, key, needle, timeout = 5000) => {
  const dl = Date.now() + timeout;
  while (Date.now() < dl) {
    if ((await bufCount(page, which, key, needle)) >= 1) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

/** 某会话主终端光标行的末尾 60 字符（失败诊断用）。 */
const tailOf = (page, sid) => page.evaluate((s) => {
  const t = window.__t_terms?.get(s);
  return t ? (cursorLineText(t)).slice(-60) : null;
  function cursorLineText(term) {
    const b = term.buffer.active;
    return (b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? "").trim();
  }
}, sid);

/** 主终端光标所在行（断言「按键确实到了终端」用，免得静默断言空转）。 */
const cursorLine = (page, sid) => page.evaluate((s) => {
  const t = window.__t_terms?.get(s);
  if (!t) return null;
  const b = t.buffer.active;
  return (b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? "").trim();
}, sid);

const clickTab = async (page, key, wait = 450) => {
  await page.evaluate((k) => {
    const tab = document.querySelector(`.tab[data-key="${k}"]`);
    if (!tab) throw new Error("tab not found: " + k);
    tab.click();
  }, key);
  await page.waitForTimeout(wait);
};

// 鼠标从标签文字拖到 #term 的 (fx, fy) 比例处（同 spec 76 的 dragTab）
const dragTab = async (page, idx, fx, fy) => {
  const pos = await page.evaluate(({ i, x, y }) => {
    const tab = document.querySelectorAll(".tab")[i];
    if (!tab) throw new Error("tab not found: " + i);
    const s = tab.querySelector(".tab-label").getBoundingClientRect();
    const r = document.getElementById("term").getBoundingClientRect();
    return { sx: s.left + s.width / 2, sy: s.top + s.height / 2, tx: r.left + r.width * x, ty: r.top + r.height * y };
  }, { i: idx, x: fx, y: fy });
  await page.mouse.move(pos.sx, pos.sy);
  await page.mouse.down();
  await page.mouse.move((pos.sx + pos.tx) / 2, (pos.sy + pos.ty) / 2, { steps: 4 });
  await page.mouse.move(pos.tx, pos.ty, { steps: 4 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(600);
};

const mouseAway = async (page) => {
  await page.mouse.move(720, 640);
  await page.waitForTimeout(200);
};

const openQuickMenu = async (page) => {
  await page.evaluate(() => {
    const open = !!document.querySelector('[data-testid="tmux-quick-menu"]');
    const btn = document.querySelector('[data-testid="tmux-quick"] button');
    if (btn && !open) btn.click();
  });
  const dl = Date.now() + 2000;
  while (Date.now() < dl) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="tmux-quick-menu"]'))) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

module.exports = {
  title: "标签活跃度：输出光环、前台回显静默、久未输出空心点、分屏组与 tmux 格子（terminal/activity.ts）",
  async run({ page, browser, ck, BASE }) {
    await page.waitForTimeout(1200);
    ck.check("前置：DEV 探针钩子在（window.__t_activity.stats / age）", await page.evaluate(() =>
  typeof window.__t_activity?.stats === "function" && typeof window.__t_activity?.age === "function"));

    // ── 准备：本机（L）+ 新开一个 prod-1（P，活动标签）──
    await connect(page, "本机");
    const L = (await activeTab(page)).sid;
    await connect(page, "prod-1");
    const P = (await activeTab(page)).sid;
    const keyL = `s:${L}`;
    const keyP = `s:${P}`;
    ck.check("准备：连上本机与新开的 prod-1（各占一个标签）",
      !!L && !!P && L !== P && P !== SID_AGENT && L !== SID_AGENT && (await tabsInfo(page)).length === 4,
      JSON.stringify({ L, P }));
    // 建连首屏是订阅时的重放（缓冲补放），直接写屏、不过节流器——不算「正在输出」。
    // 先打一帧真输出把记账走通，后面「lastOut 不动」的比较才有非空基线
    await bgKey(page, P, "seed\x15"); // \x15 = Ctrl+U：demo 的输入行清空，别让 seed 混进后面敲的 ping
    ck.eq("准备：一帧输出到达，活动标签亮起（记账走通）", (await pollTab(page, keyP, (t) => t.live === "1", 1500)).live, "1");
    const quiet = await pollTab(page, keyP, (t) => t.live === null, 5000);
    ck.eq("前置：输出停下后标签回到静止", quiet.live, null);

    // ── A. 前台回显静默：活动标签里敲命令，回显不记账、不出光环 ──
    await focusTerm(page);
    const aBeats0 = await beatsOf(page, keyP);
    const aOut0 = await lastOutOf(page, P);
    ck.check("前置：已有一笔输出记账（lastOut 是个时刻）", typeof aOut0 === "number", String(aOut0));
    await page.keyboard.type("ping", { delay: 60 });
    await page.waitForTimeout(400);
    const a1 = await tabOf(page, keyP);
    ck.check("按键确实到了终端（光标行以 ping 结尾）", (await cursorLine(page, P))?.endsWith("ping") ?? false,
      String(await cursorLine(page, P)));
    ck.eq("活动标签里逐字敲命令（回显帧）：标签不活跃", a1.live, null);
    ck.eq("回显帧不记账（lastOut 不动）", await lastOutOf(page, P), aOut0);
    ck.eq("回显帧：不出光环（圈数不变）", await beatsOf(page, keyP), aBeats0);
    ck.eq("回显帧：没有动画", a1.anims, 0);
    // 回车之后立刻到的三帧：回车回显 + PING 横幅（48 字节——按帧长分不出它和一行输出）。
    // 都紧跟本地输入，是回显：不记账、不出圈
    await page.keyboard.press("Enter");
    ck.check("横幅确实到了终端（PING … 56 data bytes）", await waitBuf(page, "main", P, "56 data bytes", 2000));
    await page.waitForTimeout(150);
    ck.eq("回车后立刻到的横幅（大帧）还在回显窗口内：不记账", await lastOutOf(page, P), aOut0);
    ck.eq("回车 + 横幅：不出圈", await beatsOf(page, keyP), aBeats0);
    ck.eq("回车 + 横幅之后标签仍不活跃", (await tabOf(page, keyP)).live, null);
    // 1 秒后 ping 的第一行才是窗口之外的输出——屏幕上看得到的终端也记、也出圈
    const a2 = await pollTab(page, keyP, (t) => t.live === "1", 2500);
    ck.check("回显窗口之外的输出到达：活动标签也亮（data-live）", a2.live === "1" && a2.active, JSON.stringify(a2));
    ck.eq("命令输出放了一圈光环", await beatsOf(page, keyP), aBeats0 + 1);

    // ── B. 后台持续输出：切到本机，prod-1 的 ping 每秒一行 ──
    await clickTab(page, keyL);
    await mouseAway(page);
    await pollTab(page, keyL, (t) => t.live === null, 5000); // 切过来那一拍若带了输出，等它静下来
    const bLive = await pollTab(page, keyP, (t) => t.anims >= 1, 3000);
    ck.eq("切走后：原标签保持活跃", bLive.live, "1");
    ck.check("切走后：状态点上有一圈光环在放（WAAPI 动画在跑）", bLive.anims >= 1, `anims=${bLive.anims}`);
    ck.eq("光环颜色取状态点自己的颜色（--ok）", bLive.ringColor, await cssVarIn(page, keyP, "--ok"));
    ck.eq("状态点本体颜色不变（光环是衍生的，不改连接状态色）", bLive.dotColor, await cssVarIn(page, keyP, "--ok"));
    const bBeats0 = await beatsOf(page, keyP);
    const bWidth0 = bLive.width;
    await page.waitForTimeout(4200);
    const b2 = await tabOf(page, keyP);
    ck.between("连续输出按节拍放光环（4.2s 内新增圈数）", (await beatsOf(page, keyP)) - bBeats0, 2, 3);
    ck.eq("整段时间保持活跃", b2.live, "1");
    ck.eq("标签宽度不变（光环不占布局）", b2.width, bWidth0);
    const bL = await tabOf(page, keyL);
    ck.eq("当前活动标签（没有输出）不活跃", bL.live, null);
    ck.check("「正在输出」不进提示文案（边沿太频繁，不为一句提示词重渲染）", !b2.title.includes("输出"), b2.title);

    // ── C. 输出停下：短暂保持后摘除，动画自然收尾 ──
    // 在后台停表（Ctrl+C 直打 demo）：^C 与两行统计行是输出，照常记账
    await bgKey(page, P, "\x03");
    ck.check("ping 已停表（终端收到统计行）",
      await waitBuf(page, "main", P, "--- demo ping statistics ---", 3000));
    const c0 = await pollTab(page, keyP, (t) => t.live === "1", 900);
    ck.eq("停表瞬间（统计行刚到）：仍保持短暂活跃", c0.live, "1");
    const c1 = await pollTab(page, keyP, (t) => t.live === null, 3000);
    ck.check("切到后台也不延长：输出停下后 ≤3s 摘除 data-live", c1.live === null, JSON.stringify(c1));
    const cBeats0 = await beatsOf(page, keyP);
    await page.waitForTimeout(2600);
    ck.eq("静止后不再出圈", await beatsOf(page, keyP), cBeats0);
    const cEnd = await tabOf(page, keyP);
    ck.eq("光环动画自然跑完、不残留", cEnd.anims, 0);
    ck.eq("静止标签保持非活跃", cEnd.live, null);

    // ── C2. 回显窗口：按「离上一次本地输入多久」判，不按帧长 ──
    await clickTab(page, keyP);
    await focusTerm(page);
    await pollTab(page, keyP, (t) => t.live === null, 4000);
    // ① 真键盘敲一键，紧跟着到一帧 200 字符的大回显（长粘贴 / shell 整行重绘的形态）
    const wKey0 = await lastKeyOf(page, P);
    const wOut0 = await lastOutOf(page, P);
    const wBeats0 = await beatsOf(page, keyP);
    await page.keyboard.type("e");
    await bgKey(page, P, "x".repeat(200));
    ck.check("大帧确实到了终端", await waitBuf(page, "main", P, "x".repeat(40), 2000));
    await page.waitForTimeout(150);
    const wKey1 = await lastKeyOf(page, P);
    ck.check("键盘输入已报给标签活跃度（lastKey 前进）", typeof wKey1 === "number" && wKey1 > (wKey0 ?? 0),
      `${wKey0} → ${wKey1}`);
    ck.eq("本地输入之后立刻到的大帧（200 字符）不记账", await lastOutOf(page, P), wOut0);
    ck.eq("大回显：不出圈", await beatsOf(page, keyP), wBeats0);
    ck.eq("大回显：标签不活跃", (await tabOf(page, keyP)).live, null);
    // ② 窗口过去之后，同样的大帧就是输出了——活动标签照常出圈
    ck.check("探针：等到回显窗口（600ms）之外", await waitKeyAged(page, P, 950));
    await bgKey(page, P, "y".repeat(200));
    const w1 = await pollTab(page, keyP, (t) => t.live === "1", 1500);
    ck.check("窗口之外到达的大帧照常记账：活动标签亮起", w1.live === "1" && w1.active, JSON.stringify(w1));
    ck.eq("活动标签里的真实输出放了一圈光环", await beatsOf(page, keyP), wBeats0 + 1);
    await pollTab(page, keyP, (t) => t.live === null, 4000);
    // ③ 粘贴一大段（经 xterm 的 onData）：回显不出圈
    const pOut0 = await lastOutOf(page, P);
    const pBeats0 = await beatsOf(page, keyP);
    await page.evaluate(({ sid, text }) => window.__t_terms.get(sid).paste(text), { sid: P, text: "z".repeat(120) });
    ck.check("粘贴内容到了终端", await waitBuf(page, "main", P, "z".repeat(40), 2000));
    await page.waitForTimeout(150);
    ck.eq("粘贴的回显（120 字符）不记账", await lastOutOf(page, P), pOut0);
    ck.eq("粘贴回显：不出圈", await beatsOf(page, keyP), pBeats0);
    ck.eq("粘贴回显：标签不活跃", (await tabOf(page, keyP)).live, null);
    // ④ Ctrl+字母由窗口捕获层直发（不过 xterm 的 onData）：同样算本地输入
    const cKey0 = await lastKeyOf(page, P);
    const cOut0 = await lastOutOf(page, P);
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(250);
    ck.check("控制字符走捕获层直发：同样报了本地输入", (await lastKeyOf(page, P)) > (cKey0 ?? 0),
      `${cKey0} → ${await lastKeyOf(page, P)}`);
    ck.eq("控制字符的回显不记账", await lastOutOf(page, P), cOut0);
    ck.eq("控制字符的回显：不出圈", await beatsOf(page, keyP), pBeats0);
    ck.eq("控制字符的回显：标签不活跃", (await tabOf(page, keyP)).live, null);
    // ⑤ 回显窗口只管看得到的终端：回车后立刻切走，窗口之内到达的帧已经落在后台——照常记账
    await page.keyboard.press("Enter");
    await page.evaluate((k) => document.querySelector(`.tab[data-key="${k}"]`).click(), keyL); // 不等固定时长，立刻切走
    // 标签条的激活态要等 attachSession 回来才挪：先等它落定再送帧——「帧到达时 prod-1 已在后台」
    // 是这条断言的前提，得先量到。原先靠后面等 tick 的工夫顺带掩盖：标签恰好已亮着的变体里
    // 这一帧读得太早，会因「还在活动态」假红。上限 400ms，送出的帧仍在回显窗口内
    const sw0 = await pollTab(page, keyP, (t) => !t.active, 400);
    ck.check("探针：已切走（prod-1 不是活动标签）", !sw0.active, JSON.stringify(sw0));
    const swAge = await bgKeyAge(page, P, "w".repeat(60));
    ck.check("探针：这一帧在回车后 500ms 内送达（落在回显窗口里）", typeof swAge === "number" && swAge < 500, String(swAge));
    const sw1 = await pollTab(page, keyP, (t) => t.live === "1", 1500);
    ck.check("回车后立刻切走：窗口内到达的帧已在后台，照常记账、出圈", sw1.live === "1" && !sw1.active, JSON.stringify(sw1));
    const c2 = await pollTab(page, keyP, (t) => t.live === null, 4000);

    // ── D. 久未输出 ──
    const dim = await cssVarIn(page, keyP, "--dim");
    const text = await cssVarIn(page, keyP, "--text");
    const ok = await cssVarIn(page, keyP, "--ok");
    const regular = c2.labelColor; // 后台标签的常规文字色（继承自药丸）
    ck.check("前置：非闲置时标签文字不是退档色（否则「退一档」没有可视效果）", regular !== dim,
      `label=${regular} dim=${dim}`);
    ck.check("探针：回拨 31 分钟", await age(page, P, 31 * MIN));
    const d1 = await pollTab(page, keyP, (t) => t.idle, 2000);
    await page.waitForTimeout(200); // 文字色 120ms 渐入
    const d1c = await tabOf(page, keyP);
    ck.check("31 分钟无输出：后台标签进入闲置态（.tab-idle）", d1.idle && !d1.active);
    ck.check("提示报「31 分钟无输出」（排在连接状态之后）", /已连接 · 31 分钟无输出 · /.test(d1c.title), d1c.title);
    ck.check("可访问名称同样带上", d1c.aria.includes("，31 分钟无输出"), d1c.aria);
    ck.eq("实心点变空心（背景透明）", d1c.dotBg, "rgba(0, 0, 0, 0)");
    ck.check("点内留 1.5px 的环（inset 阴影描边）", d1c.dotShadow.includes("inset") && d1c.dotShadow.includes("1.5px"), d1c.dotShadow);
    ck.eq("闲置 ≠ 断开：环仍是已连接的绿", d1c.dotColor, ok);
    ck.eq("非活动标签的文字退一档（--dim）", d1c.labelColor, dim);
    ck.eq("闲置 ≠ 活跃：没有 data-live", d1c.live, null);
    ck.eq("闲置：没有光环动画", d1c.anims, 0);
    // 悬停回到常规对比
    const pBox = await page.evaluate((k) => {
      const r = document.querySelector(`.tab[data-key="${k}"] .tab-label`).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, keyP);
    await page.mouse.move(pBox.x, pBox.y);
    await page.waitForTimeout(250);
    ck.eq("悬停闲置标签：文字回到常规对比（--text）", (await tabOf(page, keyP)).labelColor, text);
    await mouseAway(page);
    await page.waitForTimeout(200);
    ck.eq("移开后又退回一档", (await tabOf(page, keyP)).labelColor, dim);

    // 活动标签不判闲置
    await age(page, L, 31 * MIN);
    await page.waitForTimeout(400);
    ck.check("活动标签不判闲置（画面就在眼前）", !(await tabOf(page, keyL)).idle);
    // 已断开的标签不判闲置（断开有自己的琥珀点与「已断开」）
    await age(page, SID_DEAD, 31 * MIN);
    await page.waitForTimeout(400);
    const dDead = await tabOf(page, `s:${SID_DEAD}`);
    ck.check("已断开的标签不判闲置", !!dDead && !dDead.idle && !dDead.title.includes("无输出"), dDead?.title);

    // 输出一到：闲置即刻解除。后台会话哪怕只来 1 个字符也算动静
    const dBeats0 = await beatsOf(page, keyP);
    await bgKey(page, P, "x");
    const d2 = await pollTab(page, keyP, (t) => !t.idle && t.live === "1", 1500);
    ck.check("后台来一帧（1 个字符）：闲置即刻解除", !d2.idle);
    ck.eq("后台小帧也算动静：进入活跃", d2.live, "1");
    ck.eq("孤立的一帧只出一圈", await beatsOf(page, keyP), dBeats0 + 1);
    await page.waitForTimeout(200); // 文字色 120ms 渐变
    ck.eq("闲置解除后文字回到常规色", (await tabOf(page, keyP)).labelColor, regular);
    await page.waitForTimeout(3200);
    ck.eq("1.3s 后回到静止（不常亮）", (await pollTab(page, keyP, (t) => t.live === null, 1500)).live, null);
    ck.eq("3.2s 内没有第二圈", await beatsOf(page, keyP), dBeats0 + 1);

    // 切到它 = 看过了：闲置即刻解除
    await age(page, P, 31 * MIN);
    ck.check("前置：再次闲置", (await pollTab(page, keyP, (t) => t.idle, 2000)).idle);
    await clickTab(page, keyP);
    const d3 = await tabOf(page, keyP);
    ck.check("切到闲置标签：即刻解除", !d3.idle && d3.active);
    // 切走也记一笔：刚离开的标签从离开那一刻重新计时
    await age(page, P, 31 * MIN);
    await page.waitForTimeout(300);
    ck.check("活动中的标签回拨也不闲置", !(await tabOf(page, keyP)).idle);
    await clickTab(page, keyL, 600);
    ck.check("刚切走的标签从离开那一刻重新计时（不会立刻判闲置）", !(await tabOf(page, keyP)).idle);

    // 时长格式与阈值
    await age(page, P, 75 * MIN);
    const d75 = await pollTab(page, keyP, (t) => t.idle, 2000);
    ck.check("满一小时报时分：「1 小时 15 分钟无输出」", d75.title.includes("1 小时 15 分钟无输出"), d75.title);
    ck.check("可访问名称同步", d75.aria.includes("1 小时 15 分钟无输出"), d75.aria);
    await clickTab(page, keyP);
    await clickTab(page, keyL, 600);
    await age(page, P, 29 * MIN);
    await page.waitForTimeout(400);
    ck.check("29 分钟：不到阈值不判闲置", !(await tabOf(page, keyP)).idle);
    await age(page, P, 2 * MIN);
    const d31 = await pollTab(page, keyP, (t) => t.idle, 2000);
    ck.check("再过 2 分钟（累计 30 分钟）才判：报「31 分钟无输出」", d31.idle && d31.title.includes("31 分钟无输出"), d31.title);

    // ── E. 分屏组标签：任一成员有输出即活跃，全部成员闲置才算闲置 ──
    let tabs = await tabsInfo(page);
    const idxL = tabs.findIndex((t) => t.key === keyL);
    await clickTab(page, keyP);
    await dragTab(page, idxL, 0.9, 0.5);
    tabs = await tabsInfo(page);
    const group = tabs.find((t) => t.gid);
    ck.check("准备：prod-1 | 本机 成组（4→3 标签，组标签带窗格数 2）",
      tabs.length === 3 && !!group && group.count === "2", JSON.stringify(tabs));
    const keyG = group.key;
    // 组切到后台（活动标签换成已断开的 staging-1），两格先后回拨
    await clickTab(page, `s:${SID_DEAD}`);
    await age(page, L, 31 * MIN);
    await page.waitForTimeout(500);
    ck.check("组内只有一格闲置：组标签不闲置", !(await tabOf(page, keyG)).idle);
    await age(page, P, 31 * MIN);
    const e1 = await pollTab(page, keyG, (t) => t.idle, 2000);
    ck.check("全部成员都闲置：组标签才闲置", e1.idle);
    ck.check("组标签提示报最近活跃那格的时长", e1.title.includes("31 分钟无输出") && e1.title.includes("2 个窗格"), e1.title);
    const eBeats0 = await beatsOf(page, keyG);
    await bgKey(page, L, "x");
    const e2 = await pollTab(page, keyG, (t) => !t.idle && t.live === "1", 1500);
    ck.check("组内任一格来输出：组标签闲置解除、进入活跃", !e2.idle && e2.live === "1", JSON.stringify(e2));
    ck.eq("组标签放了一圈光环", await beatsOf(page, keyG), eBeats0 + 1);
    await pollTab(page, keyG, (t) => t.live === null, 5000);
    ck.check("输出停下后组标签不再闲置（那一格已经被唤醒）", !(await tabOf(page, keyG)).idle);
    // 广播落点：组上屏（两格都看得到），从本机那格打字、扇出到 prod-1——落点的回显同样不出圈
    await clickTab(page, keyG, 600);
    await pollTab(page, keyG, (t) => t.live === null, 4000);
    const bcOut0 = await lastOutOf(page, P);
    const bcKey0 = await lastKeyOf(page, P);
    const bcBeats0 = await beatsOf(page, keyG);
    const bcRow = `[data-testid="broadcast-row"][data-sid="${P}"] input`;
    await page.click('[data-testid="sb-broadcast"]');
    await page.waitForSelector(bcRow, { timeout: 4000 });
    await page.click(bcRow);
    const bcChip = await page.evaluate(() => document.querySelector('[data-testid="sb-broadcast"]')?.textContent ?? "");
    ck.check("勾选生效：广播 chip 计数为 1", bcChip.includes("1"), bcChip);
    await page.click('[data-testid="broadcast-close"]');
    await page.waitForTimeout(250);
    await page.evaluate((s) => window.__t_terms.get(s).focus(), L);
    await page.waitForTimeout(150);
    await page.keyboard.type("qz7", { delay: 60 });
    const bcHit = await waitBuf(page, "main", P, "qz7", 2000);
    ck.check("广播键入到了另一格（prod-1 的终端收到 qz7）", bcHit,
      JSON.stringify({ loc: (await tailOf(page, L)), prod: (await tailOf(page, P)), focus: await page.evaluate(() => document.activeElement?.className ?? "") }));
    await page.waitForTimeout(150);
    ck.check("广播落点的本地输入同样上报（lastKey 前进）", (await lastKeyOf(page, P)) > (bcKey0 ?? 0),
      `${bcKey0} → ${await lastKeyOf(page, P)}`);
    ck.eq("落点看得到：回显不记账", await lastOutOf(page, P), bcOut0);
    ck.eq("正在打字的组标签不闪（圈数不变）", await beatsOf(page, keyG), bcBeats0);
    ck.eq("组标签不活跃", (await tabOf(page, keyG)).live, null);
    // 收尾：取消勾选，后面的段不再扇出
    await page.click('[data-testid="sb-broadcast"]');
    await page.waitForSelector(bcRow, { timeout: 4000 });
    await page.click(bcRow);
    await page.click('[data-testid="broadcast-close"]');
    await page.waitForTimeout(250);

    // ── F. tmux 面板格子：格子的输出记在所属会话的标签上 ──
    const keyA = `s:${SID_AGENT}`;
    await clickTab(page, keyA);
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs", "build"] }), SID_AGENT);
    await page.waitForTimeout(300);
    ck.check("快接菜单展开", await openQuickMenu(page));
    const dl = Date.now() + 4000;
    let rows3 = false;
    while (Date.now() < dl && !rows3) {
      rows3 = await page.evaluate(() =>
        document.querySelectorAll('[data-testid="tmux-quick-menu"] .tmux-quick-row').length === 3);
      if (!rows3) await page.waitForTimeout(120);
    }
    ck.check("菜单三会话行", rows3);
    await page.click('[data-testid="tmux-pane-add-logs"]');
    const dl2 = Date.now() + 5000;
    let cell = null;
    while (Date.now() < dl2 && !cell) {
      cell = await page.evaluate(() => {
        const c = document.querySelector('.tmux-cell[data-tmux="logs"]');
        return c && c.style.display === "flex" ? { id: c.dataset.paneId } : null;
      });
      if (!cell) await page.waitForTimeout(120);
    }
    ck.check("logs 格子出现且可见", !!cell);
    // 开格的首屏（attach 标题行 + 提示符）走订阅帧、算输出：格子先上屏、这一帧稍后才到，
    // 先等它进了格子缓冲（= 已过记账点），再等那一阵过去取基线
    const paneKey = `${SID_AGENT}:${cell.id}`;
    ck.check("格子首屏已到（attach 标题行）", await waitBuf(page, "pane", paneKey, "tmux -u attach"));
    // 记账在帧到达的那一刻，data-live 要等下一拍（≤250ms）才挂上：先等到它亮起来，
    // 否则「等静止」的第一次采样会撞在亮起之前、把「还没亮」误当成「已经静了」
    ck.eq("开格首屏算输出：标签亮起", (await pollTab(page, keyA, (t) => t.live === "1", 1500)).live, "1");
    const f0 = await pollTab(page, keyA, (t) => t.live === null && t.anims === 0, 6000);
    ck.eq("前置：开格输出停下后标签回到静止", f0.live, null);
    ck.check("前置：首屏那一圈已经放完（取基线）", (await beatsOf(page, keyA)) >= 1, String(await beatsOf(page, keyA)));
    const fBeats0 = await beatsOf(page, keyA);
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), paneKey);
    await page.waitForTimeout(200);
    await page.keyboard.type("echo hello-activity", { delay: 30 });
    await page.waitForTimeout(400);
    const f1 = await tabOf(page, keyA);
    ck.eq("格子里逐字敲命令（回显帧）：标签不活跃", f1.live, null);
    ck.eq("格子的回显帧：圈数不变", await beatsOf(page, keyA), fBeats0);
    // 回车：demo 回一行「[演示] logs: …」+ 提示符，40 多字节的大帧，紧跟本地输入——是回显
    const fOut0 = await lastOutOf(page, SID_AGENT);
    ck.check("前置：开格首屏已记账", typeof fOut0 === "number", String(fOut0));
    await page.keyboard.press("Enter");
    ck.check("格子里命令已提交（demo 回行到了格子）",
      await waitBuf(page, "pane", paneKey, "[演示] logs: echo hello-activity", 2000));
    await page.waitForTimeout(200);
    const f2 = await tabOf(page, keyA);
    ck.eq("格子里提交命令的回显（大帧）不记账", await lastOutOf(page, SID_AGENT), fOut0);
    ck.check("格子回显不出圈：圈数不变、标签不活跃、没有动画",
      (await beatsOf(page, keyA)) === fBeats0 && f2.live === null && f2.anims === 0, JSON.stringify(f2));
    // 格子里按 Ctrl+字母：捕获层改投格子通道（同样不过 xterm 的 onData），也算本地输入
    const fKey0 = await lastKeyOf(page, SID_AGENT);
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(250);
    ck.check("格子里的控制字符走捕获层直发：同样报了本地输入",
      (await lastKeyOf(page, SID_AGENT)) > (fKey0 ?? 0), `${fKey0} → ${await lastKeyOf(page, SID_AGENT)}`);
    ck.eq("格子控制字符的回显不记账", await lastOutOf(page, SID_AGENT), fOut0);
    ck.eq("格子控制字符的回显：不出圈", await beatsOf(page, keyA), fBeats0);

    // ── G. 减弱动效：不出光环，改为一档更亮的静态辉光 ──
    await page.emulateMedia({ reducedMotion: "reduce" });
    const gShadow0 = (await tabOf(page, keyG)).dotShadow;
    const gBeats0 = await beatsOf(page, keyG);
    await bgKey(page, P, "y");
    const g1 = await pollTab(page, keyG, (t) => t.live === "1", 1500);
    ck.eq("减弱动效：仍标记为活跃", g1.live, "1");
    ck.eq("但不出光环动画", g1.anims, 0);
    ck.eq("节拍照常计（只是不画）", await beatsOf(page, keyG), gBeats0 + 1);
    ck.check("状态点改为一档更亮的静态辉光（8px）", g1.dotShadow.includes("0px 0px 8px 0px"), g1.dotShadow);
    ck.check("对比：静止时的常规辉光是 5px", gShadow0.includes("0px 0px 5px 0px"), gShadow0);
    const g2 = await pollTab(page, keyG, (t) => t.live === null, 3000);
    ck.check("静止后回到常规辉光", g2.live === null && g2.dotShadow.includes("0px 0px 5px 0px"), g2.dotShadow);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(3200); // 让上一拍的节拍间隔过去
    await bgKey(page, P, "z");
    const g3 = await pollTab(page, keyG, (t) => t.anims >= 1, 1500);
    ck.check("恢复动效偏好后光环回来", g3.anims >= 1, `anims=${g3.anims}`);

    // ── H. 英文界面：时长提示的文案 ──
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    await p.addInitScript(({ seed }) => {
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    }, { seed: { "ui.v2.locale": "en" } });
    try {
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await p.waitForSelector(".hostbar", { timeout: 30000 });
      await p.waitForTimeout(1200);
      await connect(p, "prod-1");
      const pe = (await activeTab(p)).sid;
      await connect(p, "本机"); // prod-1 落到后台
      const keyPe = `s:${pe}`;
      await age(p, pe, 31 * MIN);
      const h1 = await pollTab(p, keyPe, (t) => t.idle, 2000);
      ck.check("英文：31 min without output", /Connected · 31 min without output · /.test(h1.title), h1.title);
      ck.check("英文：可访问名称整句用半角逗号（此前首分隔写死全角，与其后混排）",
        h1.aria.startsWith("prod-1, Connected, 31 min without output, ") && !h1.aria.includes("，"), h1.aria);
      await age(p, pe, 44 * MIN);
      const h2 = await pollTab(p, keyPe, (t) => t.title.includes("1 h 15 min"), 2000);
      ck.check("英文：1 h 15 min without output", h2.title.includes("1 h 15 min without output"), h2.title);
      ck.check("英文界面无页面 JS 错误", errs.length === 0, errs.slice(0, 3).join(" | "));
    } finally {
      await ctx.close();
    }
  },
};
