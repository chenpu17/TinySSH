// 110 会话菜单行的活跃度同步（KI-144）：桌面「标签列表」与移动端切换器共用的
// sessionMenuRows 此前只显连接状态，标签条上的「正在输出 / 久未输出」在菜单里看不到；
// 移动端不显示标签条，这个特性在手机上完全缺席。本 spec 断言菜单行与标签同一口径：
//   ① 久未输出——空心点、非当前行文字退一档、状态列改报「N 分钟无输出」，悬停回常规对比；
//   ② 正在输出——静态辉光（8px），不挂光环载体、不跑动画；输出停下即摘；
//   ③ 活动行 / 已断开行不判闲置；④ 手机竖屏（含 125% 字号）菜单不越视口、无横向溢出。
// 读数走 DEV 探针 window.__t_activity（age 把最近活动往回拨，不必真等 30 分钟）。
const SID_AGENT = "s-demo-0001"; // demo 预置 prod-1（Agent 掌控）
const SID_DEAD = "s-demo-0002";  // demo 预置 staging-1（已断开）
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

/** 菜单行读数：闲置/活跃类、空心点、文字色、状态列文案、提示、有无光环载体。 */
const rowOf = (page, sid, sel) => page.evaluate(({ sid, sel }) => {
  const row = document.querySelector(`${sel} .tm-row[data-sid="${sid}"]`);
  if (!row) return null;
  const dot = row.querySelector(".tab-dot");
  const label = row.querySelector(".tab-label");
  const mono = row.querySelector(".tm-main > .mono");
  const cs = (el) => getComputedStyle(el);
  return {
    idle: row.classList.contains("tm-idle"),
    live: row.classList.contains("tm-live"),
    active: row.classList.contains("tm-active"),
    dotBg: dot ? cs(dot).backgroundColor : null,
    dotShadow: dot ? cs(dot).boxShadow : null,
    dotAnims: dot && dot.getAnimations ? dot.getAnimations().length : -1,
    labelColor: label ? cs(label).color : null,
    status: mono ? mono.textContent.trim() : null,
    title: row.querySelector(".tm-main")?.getAttribute("title") ?? null,
    ping: !!row.querySelector(".tab-ping"),
  };
}, { sid, sel });

/** 菜单上下文里某个主题变量的计算色（临时探针，读完即摘）。 */
const cssVar = (page, sel, name) => page.evaluate(({ sel, n }) => {
  const host = document.querySelector(sel);
  if (!host) return null;
  const probe = document.createElement("span");
  probe.style.color = `var(${n})`;
  host.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, { sel, n: name });

const age = (page, sid, ms) => page.evaluate(({ sid, ms }) => {
  const h = window.__t_activity;
  if (typeof h?.age !== "function") return false;
  h.age(sid, ms);
  return true;
}, { sid, ms });

const bgKey = (page, sid, keys) => page.evaluate(({ sid, keys }) =>
  window.__demoInvoke("send_keys", { sid, keys }), { sid, keys });

/** 菜单几何：是否越视口、有无横向溢出。 */
const menuGeom = (page, sel) => page.evaluate((sel) => {
  const m = document.querySelector(sel);
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return {
    l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom),
    vw: innerWidth, vh: innerHeight, sw: m.scrollWidth, cw: m.clientWidth,
  };
}, sel);

const pollRow = async (page, sid, sel, pred, timeout = 3000) => {
  const dl = Date.now() + timeout;
  let r = await rowOf(page, sid, sel);
  while (Date.now() < dl && !pred(r)) {
    await page.waitForTimeout(80);
    r = await rowOf(page, sid, sel);
  }
  return r;
};

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

/** 开一个手机竖屏上下文并连上本机；fontScale 经首帧前 localStorage 恢复（真实通路）。 */
const mobileCtx = async (browser, BASE, fontScale) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, locale: "zh-CN",
    isMobile: true, hasTouch: true, userAgent: ANDROID_UA,
  });
  if (fontScale) {
    await ctx.addInitScript((v) => { try { localStorage.setItem("ui.ui_font_scale", v); } catch { /* ignore */ } }, String(fontScale));
  }
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
  title: "会话菜单行同步标签活跃度：闲置空心点/无输出时长、输出静态辉光、手机竖屏不溢出",
  async run({ browser, page, ck, BASE }) {
    // ── 桌面「标签列表」 ──
    await connect(page, "本机");
    const activeSid = await page.evaluate(() => document.querySelector(".tab.tab-active")?.dataset.sid ?? null);
    await page.click(".st-tools.tabbar-admin .tab-all");
    await page.waitForSelector(DESK);
    ck.check("桌面标签列表列出会话", await page.locator(`${DESK} .tm-row`).count() >= 3);
    ck.eq("当前会话行高亮", await page.locator(`${DESK} .tm-row.tm-active`).getAttribute("data-sid"), activeSid);
    ck.check("前置：prod-1 行未闲置", !(await rowOf(page, SID_AGENT, DESK)).idle);

    // ① 久未输出
    ck.check("探针：回拨 31 分钟", await age(page, SID_AGENT, 31 * MIN));
    await page.waitForTimeout(300);
    let r = await rowOf(page, SID_AGENT, DESK);
    const dim = await cssVar(page, DESK, "--dim");
    const text = await cssVar(page, DESK, "--text");
    ck.check("久未输出：行挂 tm-idle", r.idle, JSON.stringify(r));
    ck.eq("状态列改报无输出时长", r.status, "31 分钟无输出");
    ck.check("提示同步", (r.title || "").includes("31 分钟无输出"), r.title);
    ck.eq("实心点变空心（背景透明）", r.dotBg, "rgba(0, 0, 0, 0)");
    ck.check("点内留 1.5px 的环", r.dotShadow.includes("1.5px inset"), r.dotShadow);
    ck.eq("非当前行文字退一档", r.labelColor, dim);
    ck.check("活动行不判闲置", !(await rowOf(page, activeSid, DESK)).idle);
    const dead = await rowOf(page, SID_DEAD, DESK);
    ck.check("已断开行不判闲置且仍报已断开", !dead.idle && dead.status === "已断开", JSON.stringify(dead));

    // 悬停回常规对比
    await page.hover(`${DESK} .tm-row[data-sid="${SID_AGENT}"]`);
    await page.waitForTimeout(200);
    ck.eq("悬停闲置行文字回常规对比", (await rowOf(page, SID_AGENT, DESK)).labelColor, text);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(200);
    ck.eq("移开后又退一档", (await rowOf(page, SID_AGENT, DESK)).labelColor, dim);

    // ② 正在输出：静态辉光，不跑光环。终端是懒挂载——点过标签才订阅输出，预置的后台
    //    prod-1 没接入时 send_keys 的回显帧没有订阅者、到不了记账。故先点它的标签接入、
    //    跑 ping 起持续输出，再切回本机让它转后台（与 109 同一条真实输出帧通路）。
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.click(`.tab[data-sid="${SID_AGENT}"]`);
    await page.waitForTimeout(600);
    await bgKey(page, SID_AGENT, "ping\r");
    await page.waitForTimeout(1200); // 等回显窗口之外的第一行输出
    await page.click(`.tab[data-sid="${activeSid}"]`); // 切回本机 → prod-1 转后台
    await page.waitForTimeout(300);
    await page.click(".st-tools.tabbar-admin .tab-all");
    await page.waitForSelector(DESK);
    r = await pollRow(page, SID_AGENT, DESK, (x) => x && x.live);
    ck.check("正在输出：行挂 tm-live", r.live, JSON.stringify(r));
    ck.check("静态辉光 8px", r.dotShadow.includes("0px 0px 8px"), r.dotShadow);
    ck.check("菜单行不挂光环载体", !r.ping);
    ck.eq("状态点不跑动画", r.dotAnims, 0);
    ck.eq("状态列回到已连接", r.status, "已连接");
    ck.check("输出期间不判闲置", !r.idle, JSON.stringify(r));
    // 后台停表（Ctrl+C 直打 demo）：统计行是最后一帧输出，随后辉光自然摘除
    await bgKey(page, SID_AGENT, "\x03");
    await page.waitForTimeout(1600);
    ck.check("输出停下后摘除静态辉光", !(await rowOf(page, SID_AGENT, DESK)).live);

    // 时长格式：满一小时报时分（停表把最近输出重置到现在，再回拨 75 分钟）
    await age(page, SID_AGENT, 75 * MIN);
    await page.waitForTimeout(300);
    ck.eq("满一小时报时分", (await rowOf(page, SID_AGENT, DESK)).status, "1 小时 15 分钟无输出");

    let g = await menuGeom(page, DESK);
    ck.check("桌面菜单无横向溢出", g.sw <= g.cw, JSON.stringify(g));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ── 手机竖屏 100% ──
    {
      const { ctx, page: mp, errors } = await mobileCtx(browser, BASE);
      try {
        ck.eq("移动端判定生效", await mp.evaluate(() => document.documentElement.dataset.platform), "android");
        await mp.click('[data-testid="m-tabswitch"]');
        await mp.waitForSelector(MOB);
        ck.check("移动切换菜单列出会话", await mp.locator(`${MOB} .tm-row`).count() >= 3);
        await age(mp, SID_AGENT, 31 * MIN);
        await mp.waitForTimeout(300);
        const mr = await rowOf(mp, SID_AGENT, MOB);
        const mdim = await cssVar(mp, MOB, "--dim");
        ck.check("手机：闲置行挂 tm-idle", mr.idle, JSON.stringify(mr));
        ck.eq("手机：状态列报无输出时长", mr.status, "31 分钟无输出");
        ck.eq("手机：实心点变空心", mr.dotBg, "rgba(0, 0, 0, 0)");
        ck.eq("手机：非当前行文字退一档", mr.labelColor, mdim);
        let mg = await menuGeom(mp, MOB);
        ck.check("手机竖屏菜单不越视口", mg.r <= mg.vw && mg.b <= mg.vh && mg.l >= 0, JSON.stringify(mg));
        ck.check("手机竖屏菜单无横向溢出", mg.sw <= mg.cw, JSON.stringify(mg));
        // 正在输出在手机上同样有静态辉光。手机没有标签条，接入会话走切换菜单行点击
        //    （tm-main → attachSession）。先点 prod-1 行接入并激活、跑 ping，再点本机行
        //    切回后台，重开菜单核 prod-1 行的静态辉光。
        const localSid = await mp.evaluate((sel) => document.querySelector(`${sel} .tm-row.tm-active`)?.dataset.sid ?? null, MOB);
        await mp.click(`${MOB} .tm-row[data-sid="${SID_AGENT}"] .tm-main`); // 接入并激活 prod-1（菜单随之收起）
        await mp.waitForTimeout(600);
        await bgKey(mp, SID_AGENT, "ping\r");
        await mp.waitForTimeout(1200);
        await mp.click('[data-testid="m-tabswitch"]');
        await mp.waitForSelector(MOB);
        await mp.click(`${MOB} .tm-row[data-sid="${localSid}"] .tm-main`); // 切回本机 → prod-1 转后台
        await mp.waitForTimeout(400);
        await mp.click('[data-testid="m-tabswitch"]');
        await mp.waitForSelector(MOB);
        const ml = await pollRow(mp, SID_AGENT, MOB, (x) => x && x.live);
        ck.check("手机：正在输出挂 tm-live", ml.live, JSON.stringify(ml));
        ck.check("手机：静态辉光 8px", ml.dotShadow.includes("0px 0px 8px"), ml.dotShadow);
        ck.check("手机：不挂光环载体", !ml.ping);
        await bgKey(mp, SID_AGENT, "\x03"); // 停表收尾
        ck.eq("无页面 JS 错误（手机 100%）", errors.length, 0);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ── 手机竖屏 125% 字号：状态列变长仍不溢出 ──
    {
      const { ctx, page: mp, errors } = await mobileCtx(browser, BASE, 1.25);
      try {
        ck.eq("125% 字号已落地", await mp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim()), "1.25");
        await mp.click('[data-testid="m-tabswitch"]');
        await mp.waitForSelector(MOB);
        await age(mp, SID_AGENT, 75 * MIN);
        await mp.waitForTimeout(300);
        const mr = await rowOf(mp, SID_AGENT, MOB);
        ck.eq("125%：长时长文案完整", mr.status, "1 小时 15 分钟无输出");
        const mg = await menuGeom(mp, MOB);
        ck.check("125% 手机菜单不越视口", mg.r <= mg.vw && mg.b <= mg.vh && mg.l >= 0, JSON.stringify(mg));
        ck.check("125% 手机菜单无横向溢出", mg.sw <= mg.cw, JSON.stringify(mg));
        ck.eq("无页面 JS 错误（手机 125%）", errors.length, 0);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  },
};
