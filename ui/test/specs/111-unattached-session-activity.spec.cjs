// 111 没点开过的会话也有活跃度（KI-148）。终端是懒挂载：输出订阅在点开标签时才建，输出帧
// 只发给订阅者——没点开过的已连接会话此前一帧都到不了前端，「正在输出 / 久未输出」两种状态
// 在它身上都错：永不出光环，满 30 分钟必被报「N 分钟无输出」（哪怕一直在输出）。Android
// 活动重建后只回接上次的标签、广播输入里没点开的目标、Agent 建的会话都会碰到。
// 修法：核心在产生每一帧的同一点记「最近一次输出时刻」，前端低频取快照（output_activity）、
// 只给没订阅的会话记账（activity.remote）；点开之后帧接管。断言面：
//   ① 建连即算一次活动，「第一次看到」的时刻以核心报的为准（WebView 重建后闲置时长不从头算）；
//   ② 没点开也出光环（标签条 + 会话菜单行），活跃保持比帧记账多留一个轮询周期，1 秒一行的
//      输出不熄；且不为记账去订阅输出；
//   ③ 久未输出按核心的真值来，不必有帧——WebView 重建（引擎是新的，一帧没见过）与稳态（静满
//      30 分钟）两条路分开测；核心一报输出即刻解除；
//   ④ 核心是真值：前端自己拨旧的记账，下一次快照就被拉回；
//   ⑤ 点开之后帧接管，快照不再过问这个会话（考它的时候页面上另有一个没点开的已连接会话，
//      轮询才在跑）；已断开的会话不因回显而亮；
//   ⑥ 手机切换菜单同样生效（手机没有标签条，没点开过的会话此前完全看不到动静）。
// 读数走 DEV 探针 window.__t_activity（stats / age / forget）与 window.__demoAgeOutput（拨 demo
// 后端的「最近输出时刻」，模拟核心眼里的真值；真实后端没有这个口）。
// 注意 demo 的演示 shell 是逐字符累输入行来认命令的：给没点开的会话打过字之后要起 ping，
// 得先把输入行清掉（Ctrl+U），否则提交的是「xping」。
const SID_AGENT = "s-demo-0001"; // demo 预置 prod-1（Agent 掌控；到 ⑤ 才点开）
const SID_DEAD = "s-demo-0002";  // demo 预置 staging-1（已断开）
const KEY = `s:${SID_AGENT}`;
const MIN = 60_000;
const DESK = ".tools-menu.tm-right";
const MOB = '[data-testid="m-tabs-menu"]';

const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$(".host-connect-btn")).click();
  await page.waitForTimeout(1400);
};

const activeTab = (page) => page.evaluate(() => {
  const t = document.querySelector(".tab.tab-active");
  return t ? { key: t.dataset.key, sid: t.dataset.sid } : null;
});

/** 标签上的活跃度读数：data-live、闲置类、光环动画数、提示文案。 */
const tabOf = (page, key) => page.evaluate((k) => {
  const tab = document.querySelector(`.tab[data-key="${k}"]`);
  if (!tab) return null;
  const ping = tab.querySelector(".tab-ping");
  return {
    live: tab.getAttribute("data-live"),
    idle: tab.classList.contains("tab-idle"),
    active: tab.classList.contains("tab-active"),
    anims: ping?.getAnimations?.().length ?? -1,
    title: tab.getAttribute("title"),
  };
}, key);

/** 会话菜单行读数（桌面「标签列表」与手机切换器共用 sessionMenuRows）。 */
const rowOf = (page, sid, sel) => page.evaluate(({ sid, sel }) => {
  const row = document.querySelector(`${sel} .tm-row[data-sid="${sid}"]`);
  if (!row) return null;
  const dot = row.querySelector(".tab-dot");
  return {
    idle: row.classList.contains("tm-idle"),
    live: row.classList.contains("tm-live"),
    dotBg: dot ? getComputedStyle(dot).backgroundColor : null,
    status: row.querySelector(".tm-main > .mono")?.textContent.trim() ?? null,
  };
}, { sid, sel });

/** 轮询到读数满足条件（或超时，返回最后一次读数）。 */
const waitUntil = async (page, read, pred, timeout = 3000) => {
  const dl = Date.now() + timeout;
  let v = await read();
  while (Date.now() < dl && !pred(v)) {
    await page.waitForTimeout(80);
    v = await read();
  }
  return v;
};

const stats = (page) => page.evaluate(() => window.__t_activity.stats());
const beatsOf = async (page) => (await stats(page)).beats[KEY] ?? 0;
const subsOf = (page) => page.evaluate(() => window.__demoInvoke("debug_subscriptions", {}));
const snapshot = (page) => page.evaluate(() => window.__demoInvoke("output_activity", {}));

/** 只拨后端（demo）的「最近输出时刻」——模拟核心眼里的真值（WebView 重建后前端一帧没见过，
 *  这个会话静了多久只有核心知道）。 */
const ageCore = (page, sid, ms) => page.evaluate(({ sid, ms }) => window.__demoAgeOutput?.(sid, ms) === true, { sid, ms });
/** 只拨前端的记账（探针 __t_activity.age，立即重算闲置表）。 */
const ageFront = (page, sid, ms) => page.evaluate(({ sid, ms }) => {
  const h = window.__t_activity;
  if (typeof h?.age !== "function") return false;
  h.age(sid, ms);
  return true;
}, { sid, ms });

/** 引擎把这个会话忘掉（探针 __t_activity.forget）——模拟 WebView 重建（Android 活动重建）：
 *  前端是新的，一帧没见过、也没对过表，下一次快照就是「第一次对表」。 */
const forget = (page, sid) => page.evaluate((sid) => {
  const h = window.__t_activity;
  if (typeof h?.forget !== "function") return false;
  h.forget(sid);
  return true;
}, sid);

/** 给没点开的会话直接打一帧按键（demo 原样回显，经 pushTo；没有订阅者，只有快照看得到）。 */
const bgKey = (page, sid, keys) => page.evaluate(({ sid, keys }) =>
  window.__demoInvoke("send_keys", { sid, keys }), { sid, keys });

/** 不经界面建一个已连接会话（直接进 demo 的 begin_connection；本机不经过指纹确认），等到
 *  建连就绪返回它的 sid——像 Agent 建的会话：出现在标签列表里，但没人点开。 */
const buildUnopened = async (page) => {
  const a = await page.evaluate(() =>
    window.__demoInvoke("begin_connection", { hostId: "local", opts: { new_session: true } }));
  const info = await waitUntil(page, () => page.evaluate(({ aid }) =>
    window.__demoInvoke("connection_status", { attemptId: aid }), { aid: a.attempt_id }),
  (x) => x?.phase === "Ready", 4000);
  return info;
};

/** 打一帧后每 40ms 采一次样，返回「活跃」在发出后第几毫秒开始、第几毫秒结束（null = 没活跃过
 *  或盯满 maxMs 仍活跃），以及期间看到的光环动画数峰值。what: { tab: key } 或 { row: [sid, 选择器] }。 */
const liveSpan = (page, sid, keys, what, maxMs = 5000) => page.evaluate(({ sid, keys, what, maxMs }) => new Promise((resolve) => {
  const isLive = () => {
    if (what.tab) {
      const tab = document.querySelector(`.tab[data-key="${what.tab}"]`);
      if (!tab) return false;
      const anims = tab.querySelector(".tab-ping")?.getAnimations?.().length ?? 0;
      if (anims > animsMax) animsMax = anims;
      return tab.getAttribute("data-live") === "1";
    }
    return document.querySelector(`${what.row[1]} .tm-row[data-sid="${what.row[0]}"]`)?.classList.contains("tm-live") === true;
  };
  let animsMax = 0;
  let first = null;
  let end = null;
  const t0 = Date.now();
  window.__demoInvoke("send_keys", { sid, keys });
  const step = () => {
    const live = isLive();
    const rel = Date.now() - t0;
    if (live && first === null) first = rel;
    if (!live && first !== null && end === null) end = rel;
    if (end !== null || rel > maxMs) { resolve({ first, end, animsMax }); return; }
    setTimeout(step, 40);
  };
  step();
}), { sid, keys, what, maxMs });

/** 在页面里每 40ms 采一次某标签的 data-live，持续 ms 毫秒；返回采样数与其中「不活跃」的次数。
 *  取样时刻按起点排成网格（不等上一次跑完再加 40ms）——链式 setTimeout 会把每次 evaluate 的
 *  开销累加进去，4 秒只剩 84–90 个样，机器一慢就少。 */
const sampleLive = (page, key, ms) => page.evaluate(({ key, ms }) => new Promise((resolve) => {
  let n = 0;
  let off = 0;
  const started = Date.now();
  const step = () => {
    n += 1;
    if (document.querySelector(`.tab[data-key="${key}"]`)?.getAttribute("data-live") !== "1") off += 1;
    const due = started + n * 40;
    if (due - started >= ms) { resolve({ n, off }); return; }
    setTimeout(step, Math.max(0, due - Date.now()));
  };
  step();
}), { key, ms });

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

/** 开一个手机竖屏上下文并连上本机。 */
const mobileCtx = async (browser, BASE) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: "zh-CN",
    isMobile: true, hasTouch: true, userAgent: ANDROID_UA,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 30000 });
  await page.waitForTimeout(600);
  await connect(page, "本机");
  return { ctx, page, errors };
};

module.exports = {
  title: "没点开过的会话也有活跃度（KI-148）：后端快照记账——输出出光环、闲置按真值、点开后让位给帧",
  async run({ browser, page, ck, BASE }) {
    await connect(page, "本机");
    await page.waitForSelector(`.tab[data-key="${KEY}"]`);

    // ── ① 建连即算一次活动，「第一次看到」以核心报的为准 ──
    const st0 = await waitUntil(page, () => stats(page), (x) => typeof x.lastOut[SID_AGENT] === "number", 3000);
    ck.check("没点开的已连接会话也有「最近输出」记账", typeof st0.lastOut[SID_AGENT] === "number", JSON.stringify(st0.lastOut));
    ck.check("记账来自后端快照", st0.remote.includes(SID_AGENT), JSON.stringify(st0.remote));
    ck.eq("第一次对表：「看到」的时刻以核心报的为准", st0.seen[SID_AGENT], st0.lastOut[SID_AGENT]);
    const snap0 = await snapshot(page);
    ck.check("快照列出全部在册会话（含已断开的，不按状态筛）",
      snap0.length >= 3 && snap0.some((r) => r.session_id === SID_DEAD), JSON.stringify(snap0));
    ck.between("尚无输出：距建连算起（秒级——不是 0，也不是「自古以来」）",
      snap0.find((r) => r.session_id === SID_AGENT)?.idle_ms, 1000, 60_000);
    const pre = await tabOf(page, KEY);
    ck.check("前置：没输出时既不活跃也不闲置", pre.live === null && !pre.idle, JSON.stringify(pre));

    // ── ② 没点开也出光环 ──
    const beats0 = await beatsOf(page);
    const a = await liveSpan(page, SID_AGENT, "x", { tab: KEY });
    ck.check("没点开的会话有输出：标签进入活跃（data-live）", a.first !== null, JSON.stringify(a));
    ck.check("最晚一个轮询周期加一拍就被看到", a.first !== null && a.first <= 1000, `first=${a.first}`);
    ck.check("状态点放光环", a.animsMax >= 1, `animsMax=${a.animsMax}`);
    ck.between("活跃保持比帧记账多留一个轮询周期（1800ms；帧记账是 1300ms）", a.end, 1650, 2400);
    ck.eq("孤立的一帧只出一圈", await beatsOf(page), beats0 + 1);
    const subs2 = await subsOf(page);
    ck.check("不为记账去订阅输出（它仍然没有订阅者）",
      !subs2.per_session.some((p) => p.session_id === SID_AGENT), JSON.stringify(subs2));

    // 1 秒一行的 ping（demo 每行一帧，走同一条 pushTo）：两次轮询之间刚出的行要隔一个周期
    // 才被看到，活跃保持不留余量的话每秒都会熄一下。Ctrl+U 先清掉上面那一帧留下的输入行
    await bgKey(page, SID_AGENT, "\x15ping\r");
    await page.waitForTimeout(1300); // 表头之后第一行输出已到、标签已活跃
    const pb0 = await beatsOf(page);
    const s1 = await sampleLive(page, KEY, 4000);
    ck.check("1 秒一行的输出：光环不熄（4 秒内每 40ms 采样全活跃）", s1.n >= 95 && s1.off === 0, JSON.stringify(s1));
    ck.check("连续输出按节拍出圈", (await beatsOf(page)) - pb0 >= 2, `${pb0} → ${await beatsOf(page)}`);
    // 桌面「标签列表」的行同步（ping 还在跑，行应当亮着）
    await page.click(".st-tools.tabbar-admin .tab-all");
    await page.waitForSelector(DESK);
    const r1 = await waitUntil(page, () => rowOf(page, SID_AGENT, DESK), (x) => x && x.live);
    ck.check("会话菜单行同步挂 tm-live", r1.live, JSON.stringify(r1));
    ck.eq("状态列仍报已连接", r1.status, "已连接");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await bgKey(page, SID_AGENT, "\x03"); // 停表：统计两行是最后的输出
    const off = await waitUntil(page, () => tabOf(page, KEY), (x) => x.live === null, 5000);
    ck.eq("输出停下后回到静止", off.live, null);

    // ── ③ 久未输出按核心的真值来，不必有帧 ──
    // WebView 重建（Android 活动重建）就是这样：前端是新的，一帧没见过，它静了多久只有核心知道。
    // 模拟：核心记录拨旧 31 分钟 + 引擎把这个会话忘掉（下一次快照就是「第一次对表」）
    ck.check("探针：只拨后端的记录", await ageCore(page, SID_AGENT, 31 * MIN));
    ck.check("探针：引擎忘掉这个会话", await forget(page, SID_AGENT));
    const c1 = await waitUntil(page, () => tabOf(page, KEY), (x) => x.idle, 2500);
    ck.check("WebView 重建：核心报 31 分钟没输出，没有任何帧也进入闲置", c1.idle && !c1.active, JSON.stringify(c1));
    ck.check("提示报「31 分钟无输出」", /已连接 · 31 分钟无输出 · /.test(c1.title), c1.title);
    await bgKey(page, SID_AGENT, "y");
    const c2 = await waitUntil(page, () => tabOf(page, KEY), (x) => !x.idle && x.live === "1", 3000);
    ck.check("核心一报输出：闲置解除并进入活跃", !c2.idle && c2.live === "1", JSON.stringify(c2));
    ck.check("提示里不再有「无输出」", !c2.title.includes("无输出"), c2.title);

    // ── ④ 核心是真值：前端自己拨旧的记账，下一次快照就被拉回 ──
    ck.check("探针：只拨前端的记账", await ageFront(page, SID_AGENT, 31 * MIN));
    const d0 = await waitUntil(page, () => tabOf(page, KEY), (x) => x.idle, 2000);
    ck.check("刚拨完：闲置表照拨", d0.idle && /31 分钟无输出/.test(d0.title), d0.title);
    const d1 = await waitUntil(page, () => tabOf(page, KEY), (x) => !x.idle, 3000);
    ck.check("下一次快照按核心的真值把它拉回：闲置解除", !d1.idle, JSON.stringify(d1));
    ck.check("提示里不再有「无输出」", !d1.title.includes("无输出"), d1.title);

    // 稳态（页面没重建过）：这个会话静满 30 分钟——引擎手里的记账是新的，核心说旧了，
    // 闲置与否翻转，不必等 15 秒一次的低频重算
    ck.check("探针：只拨后端的记录", await ageCore(page, SID_AGENT, 31 * MIN));
    const c3 = await waitUntil(page, () => tabOf(page, KEY), (x) => x.idle, 2500);
    ck.check("静满 30 分钟：没有任何帧也进入闲置", c3.idle && c3.live === null, JSON.stringify(c3));
    ck.check("提示报「31 分钟无输出」", /已连接 · 31 分钟无输出 · /.test(c3.title), c3.title);

    // ── ⑤ 点开之后帧接管，快照不再过问这个会话 ──
    // 先不经界面再建一个已连接会话。prod-1 点开之后，靠它轮询才继续跑——「快照不碰已订阅
    // 的会话」这才真的被考到：页面上已经没有没订阅的已连接会话时轮询本来就停了，
    // 那道筛选写不写都看不出来（首轮变异检验就是这样漏掉一组的）
    const local = await activeTab(page);
    const built = await buildUnopened(page);
    const SID_EXTRA = built?.session_id;
    ck.check("探针：后台建连就绪", typeof SID_EXTRA === "string" && SID_EXTRA !== local.sid, JSON.stringify(built));
    await page.waitForSelector(`.tab[data-sid="${SID_EXTRA}"]`, { timeout: 8000 }); // 列表 3 秒一轮
    ck.check("新会话进了标签列表，当前标签没变（没人点开它）", (await activeTab(page)).sid === local.sid);
    const ex = await waitUntil(page, () => stats(page), (x) => x.remote.includes(SID_EXTRA), 3000);
    ck.check("它同样归快照记账", ex.remote.includes(SID_EXTRA), JSON.stringify(ex.remote));
    ck.check("且没有输出订阅",
      !(await subsOf(page)).per_session.some((p) => p.session_id === SID_EXTRA));

    await page.click(`.tab[data-sid="${SID_AGENT}"]`);
    await page.waitForTimeout(600);
    await page.click(`.tab[data-key="${local.key}"]`); // 切回本机：prod-1 转后台，但输出订阅已经在了
    await page.waitForTimeout(400);
    await bgKey(page, SID_AGENT, "z"); // 这一帧有订阅者，走帧记账
    const st5 = await waitUntil(page, () => stats(page), (x) => !x.remote.includes(SID_AGENT), 2000);
    ck.check("点开并收到帧之后：不再归快照记账", !st5.remote.includes(SID_AGENT), JSON.stringify(st5.remote));
    ck.check("点开才有输出订阅", (await subsOf(page)).per_session.some((p) => p.session_id === SID_AGENT));
    ck.eq("快照记账里只剩没点开的那个", JSON.stringify(st5.remote), JSON.stringify([SID_EXTRA]));
    ck.check("探针：只拨后端的记录", await ageCore(page, SID_AGENT, 31 * MIN));
    await page.waitForTimeout(1300); // 两三个轮询周期
    ck.check("只拨后端：对点开过的会话不起作用（帧说了算）", !(await tabOf(page, KEY)).idle);
    ck.check("也没被拉进快照记账", !(await stats(page)).remote.includes(SID_AGENT));
    ck.check("探针：只拨前端的记账", await ageFront(page, SID_AGENT, 31 * MIN));
    ck.check("只拨前端：点开过的会话照拨", (await waitUntil(page, () => tabOf(page, KEY), (x) => x.idle, 2000)).idle);
    await page.waitForTimeout(1300);
    ck.check("且不会被快照拉回", (await tabOf(page, KEY)).idle);

    // 已断开的会话不归快照记账（活跃与闲置都只说已连接的）
    await bgKey(page, SID_DEAD, "x"); // demo 对已断开的会话照样回显一帧
    await page.waitForTimeout(1100);
    const st6 = await stats(page);
    const deadTab = await tabOf(page, `s:${SID_DEAD}`);
    ck.check("已断开的会话回显一帧也不亮、不进快照记账",
      deadTab?.live === null && !st6.remote.includes(SID_DEAD), JSON.stringify({ deadTab, remote: st6.remote }));

    // ── ⑥ 手机切换菜单：手机没有标签条，没点开过的会话此前完全看不到动静 ──
    {
      const { ctx, page: mp, errors } = await mobileCtx(browser, BASE);
      try {
        const stm = await waitUntil(mp, () => stats(mp), (x) => typeof x.lastOut[SID_AGENT] === "number", 3000);
        ck.check("手机：没点开的会话同样有快照记账",
          typeof stm.lastOut[SID_AGENT] === "number" && stm.remote.includes(SID_AGENT), JSON.stringify(stm.remote));
        await mp.click('[data-testid="m-tabswitch"]');
        await mp.waitForSelector(MOB);
        const m1 = await liveSpan(mp, SID_AGENT, "x", { row: [SID_AGENT, MOB] });
        ck.check("手机：没点开的会话有输出，切换菜单行挂 tm-live", m1.first !== null, JSON.stringify(m1));
        ck.between("手机：活跃保持同样多留一个轮询周期", m1.end, 1650, 2400);
        ck.check("探针：只拨后端的记录", await ageCore(mp, SID_AGENT, 31 * MIN));
        ck.check("探针：引擎忘掉这个会话", await forget(mp, SID_AGENT)); // 手机活动重建：引擎是新的
        const m2 = await waitUntil(mp, () => rowOf(mp, SID_AGENT, MOB), (x) => x && x.idle, 2500);
        await mp.waitForTimeout(300); // 状态点底色有过渡：等它换完再读
        const m2s = await rowOf(mp, SID_AGENT, MOB);
        ck.check("手机：核心报久未输出，行挂 tm-idle", m2.idle, JSON.stringify(m2));
        ck.eq("手机：状态列报无输出时长", m2s.status, "31 分钟无输出");
        ck.eq("手机：实心点变空心", m2s.dotBg, "rgba(0, 0, 0, 0)");
        await bgKey(mp, SID_AGENT, "y");
        const m3 = await waitUntil(mp, () => rowOf(mp, SID_AGENT, MOB), (x) => x && !x.idle && x.live, 3000);
        ck.check("手机：核心一报输出，闲置解除并活跃", !m3.idle && m3.live, JSON.stringify(m3));
        ck.eq("无页面 JS 错误（手机）", errors.length, 0);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  },
};
