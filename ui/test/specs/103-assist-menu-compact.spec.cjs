// 103 助力球面板紧凑版式（2026-11 紧凑改版）：用户走查「移动端在弹出面板里上下滚动
// 很难操作，建议这些快捷功能都能完整显示」。改前竖屏 256px、横屏 166px 都要滚，横屏
// 专注态常用键整排藏在折叠线以下。现在锁三件事：
// ① 常规手机横竖屏整板满铺、不出滚动条，面板高度有上限（命令格图标在上文案在下，
//    键排 + 摇杆并成连点区；宽横屏整板只有两行）。
// ② 三档自适应：常规 → 收紧（.ts-tight，目标 36）→ 图标版（.ts-mini，命令格只剩图标、
//    宽横屏并成单行），按球的上下实测余量切档；软键盘弹出/收起往返后必须回到与初开
//    时完全一致的档位、高度与文案字号；图标版放不下（极窄视口）要整档放弃，不留半截。
// ③ 命令格文案限字号（assist-ball.tsx 的 fitTileLabels 逐行实测）：整行能单行就整行
//    统一缩、同排不分大小；缩不到下限就保持期望字号按词折行，图标与文案末行各自对齐；
//    单词不从中间拆开。
// 行为（翻页通道、真实键序、粘贴收口、拖球、触摸去重）由 92 负责，这里只锁版式与几何。
// 不比对像素截图，只量真实布局边界与计算样式。

/** 开一个页面并展开面板。c：w/h/scale/locale/focus/density/scheme；desktop=true 走
 *  桌面端设置开关（桌面默认不渲染球）。pages 收集页面供收尾统一关闭。 */
const openPanel = async (browser, BASE, c, errors, pages) => {
  const p = await browser.newPage({
    viewport: { width: c.w, height: c.h },
    ...(c.desktop ? {} : { hasTouch: true, isMobile: true }),
    ...(c.scheme ? { colorScheme: c.scheme } : {}),
  });
  pages.push(p);
  p.on("pageerror", (e) => errors.push(`${c.name}: ${String(e).slice(0, 160)}`));
  await p.addInitScript((c) => {
    localStorage.setItem("ui.ui_font_scale", c.scale);
    localStorage.setItem("ui.ui_density", c.density ?? "comfortable");
    localStorage.setItem("ui.v2.locale", c.locale ?? "zh");
    localStorage.removeItem("ui.assistBallPos");
    localStorage.removeItem("ui.assistBallSize");
    // 移动端不要设 ui.assistBall（那是桌面开关；真机上没有这个键）
    if (c.desktop) localStorage.setItem("ui.assistBall", "1");
    else localStorage.removeItem("ui.assistBall");
  }, c);
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  if (!c.desktop) await p.evaluate(() => { document.documentElement.dataset.platform = "android"; });
  await p.waitForSelector('.host-card:has(.host-name:text-is("本机"))');
  const card = await p.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await p.waitForTimeout(200);
  await (await card.$('.host-connect-btn')).click();
  await p.waitForSelector('[data-testid="assist-ball"]', { timeout: 8000 });
  await p.waitForTimeout(500);
  if (c.focus) {
    await p.click('[data-testid="focus-toggle"]');
    await p.waitForSelector(".app-shell.focus-mode");
  }
  await p.click('[data-testid="assist-ball"]');
  await p.waitForSelector('[data-testid="assist-menu"]');
  await p.waitForTimeout(150);
  return p;
};

/** 面板几何快照：档位类、面板盒、每个可点元素的盒与溢出、命令格文案（字号/行数/
 *  被拆的单词数）、命令格按顶边分的行、键排行数、摇杆形态与读数、球的盒。 */
const geo = (p) => p.evaluate(() => {
  const menu = document.querySelector('[data-testid="assist-menu"]');
  if (!menu) return null;
  const round = (n) => Math.round(n * 100) / 100;
  const R = (el) => {
    const b = el.getBoundingClientRect();
    return { x: round(b.left), y: round(b.top), w: round(b.width), h: round(b.height), b: round(b.bottom), r: round(b.right) };
  };
  // 被拆到两行的单词数：逐词取 Range，行矩形顶边不唯一即拆词
  const brokenWords = (label) => {
    const node = label.firstChild;
    if (!node || node.nodeType !== 3) return 0;
    let n = 0;
    for (const m of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) n++;
    }
    return n;
  };
  const items = [...menu.querySelectorAll(".assist-item")].map((el) => {
    const base = {
      cls: el.className.replace("assist-item", "").trim(), text: el.textContent.trim(), ...R(el),
      ovf: el.scrollWidth > el.clientWidth + 1,
    };
    if (!el.classList.contains("assist-cmd")) return base;
    const label = el.querySelector(".assist-label");
    const lcs = getComputedStyle(label);
    return {
      ...base, cmd: true, fs: parseFloat(lcs.fontSize),
      lines: Math.round(label.getBoundingClientRect().height / parseFloat(lcs.lineHeight)),
      broken: brokenWords(label), labelBox: R(label), ico: R(el.querySelector(".assist-ico")),
    };
  });
  const cmds = items.filter((i) => i.cmd);
  const rows = new Map();
  for (const i of cmds) rows.set(Math.round(i.y), [...(rows.get(Math.round(i.y)) ?? []), i]);
  const keys = items.filter((i) => i.cls.includes("assist-key"));
  const step = menu.querySelector(".assist-fontstep");
  const val = step.querySelector(".assist-fontval");
  return {
    vw: innerWidth, vh: innerHeight,
    scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale")) || 1,
    tier: ["ts-tight", "ts-mini"].filter((k) => menu.classList.contains(k)),
    menu: R(menu), clientH: menu.clientHeight, scrollH: menu.scrollHeight, maxH: menu.style.maxHeight,
    items, cmds, rows: [...rows.values()], keys,
    keyRows: new Set(keys.map((k) => Math.round(k.y))).size,
    font: items.filter((i) => i.cls.includes("assist-fontbtn")),
    stepDir: getComputedStyle(step).flexDirection, stepLabel: step.getAttribute("aria-label"),
    val: val.textContent.trim(), valBox: R(val),
    ball: R(document.querySelector('[data-testid="assist-ball"]')),
    docOverflow: document.documentElement.scrollWidth > innerWidth,
  };
});

const tierName = (g) => g.tier.join("+") || "regular";
const rowSizes = (g) => g.rows.map((r) => r.length);
const allInside = (g) => g.items.every((it) => it.y >= g.menu.y - 0.5 && it.b <= g.menu.b + 0.5
  && it.x >= g.menu.x - 0.5 && it.r <= g.menu.r + 0.5);
const inViewport = (g) => g.menu.y >= 0 && g.menu.b <= g.vh && g.menu.x >= 0 && g.menu.r <= g.vw;
const noOverflow = (g) => !g.docOverflow && g.items.every((it) => !it.ovf);
const minH = (g, n) => g.items.every((it) => it.h >= n - 0.5);
/** 两次快照的档位、面板高度、每格文案字号与行数完全一致 */
const sameLayout = (a, b) => a.tier.join() === b.tier.join() && Math.abs(a.menu.h - b.menu.h) < 0.5
  && a.cmds.length === b.cmds.length
  && a.cmds.every((t, i) => t.fs === b.cmds[i].fs && t.lines === b.cmds[i].lines);
const brief = (g) => JSON.stringify({
  tier: tierName(g), n: g.items.length, h: g.menu.h, scroll: `${g.scrollH}/${g.clientH}`,
  rows: rowSizes(g), fs: [...new Set(g.cmds.map((t) => t.fs))], lines: g.cmds.map((t) => t.lines),
  min: Math.min(...g.items.map((i) => i.h)), ovf: g.items.filter((i) => i.ovf).map((i) => i.text),
});

/** 整板可见：条目数对、不出滚动条、面板在视口内、每格都落在面板内、无横向溢出、目标高度达标 */
const fullBoard = (ck, name, g, { count, min = 40 }) => ck.check(`${name}：整板可见不滚动`,
  !!g && g.items.length === count && g.scrollH <= g.clientH + 1 && inViewport(g) && allInside(g)
  && noOverflow(g) && minH(g, min),
  g ? brief(g) : "面板不在场");

const setViewport = async (p, w, h) => {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(350);
};

module.exports = {
  title: "助力球面板紧凑版式：三档自适应 + 命令格文案限字号（整板可见不滚动）",
  async run({ browser, ck, BASE }) {
    const errors = [];
    const pages = [];
    const open = (c) => openPanel(browser, BASE, c, errors, pages);
    const closeAll = async () => { for (const p of pages) await p.close().catch(() => {}); };

    try {
      // ── ① 竖屏 390×844 中文 100%（最常见的形态）：一行四格 + 键排两行各五键 + 右缘竖向摇杆 ──
      {
        const p = await open({ name: "竖屏 390×844 zh 100%", w: 390, h: 844, scale: "1", locale: "zh" });
        const g = await geo(p);
        fullBoard(ck, "竖屏 390×844 zh 100%", g, { count: 16 });
        ck.eq("竖屏：不挂收紧/图标版档位类", tierName(g), "regular");
        ck.check("竖屏：面板高度 ≤ 160px（改前 256）", g.menu.h <= 160, `实得 ${g.menu.h}`);
        ck.eq("竖屏：命令格一行四格", JSON.stringify(rowSizes(g)), JSON.stringify([4]));
        ck.eq("竖屏：常用键两行各五键", JSON.stringify([g.keys.length, g.keyRows]), JSON.stringify([10, 2]));
        // 摇杆盒自带 1px 描边：两钮各从盒沿内缩 1px，所以与键排首行顶/末行底差恰为 1px
        ck.check("竖屏：摇杆在键排右缘与键排等高（不独占一行）、上下两半各 ≥40px",
          g.stepDir === "column" && g.font.length === 2 && g.font[0].text === "A+" && g.font[1].text === "A−"
          && Math.abs(g.font[0].x - g.font[1].x) < 0.5 && g.font[0].h >= 40 && g.font[1].h >= 40
          && Math.abs(Math.abs(g.font[0].y - g.keys[0].y) - 1) < 0.5
          && Math.abs(Math.abs(g.font[1].b - g.keys[g.keys.length - 1].b) - 1) < 0.5,
          JSON.stringify({ dir: g.stepDir, a: g.font.map((f) => [f.text, f.y, f.h]) }));
        ck.check("竖屏：读数在上下两钮之间且等于当前终端字号",
          g.font[0].b <= g.valBox.y + g.valBox.h && g.valBox.y <= g.font[1].y + 1
          && new RegExp(`${g.val}$`).test(g.stepLabel),
          JSON.stringify({ val: g.val, label: g.stepLabel, a: g.font.map((f) => [f.y, f.b]) }));
        const h0 = g.menu.h;
        await p.click('[data-testid="assist-menu"] .assist-fontbtn[title*="增大"]');
        await p.waitForTimeout(200);
        const up = await geo(p);
        ck.check("A+ 后面板不收、读数 +1、版式不变",
          !!up && Number(up.val) === Number(g.val) + 1 && Math.abs(up.menu.h - h0) < 0.5 && tierName(up) === "regular",
          up ? JSON.stringify({ val: up.val, h: up.menu.h }) : "面板已收起");
        await p.click('[data-testid="assist-menu"] .assist-fontbtn[title*="减小"]');
        await p.waitForTimeout(200);
        const down = await geo(p);
        ck.check("A− 后读数回到原字号、版式不变",
          !!down && down.val === g.val && Math.abs(down.menu.h - h0) < 0.5,
          down ? JSON.stringify({ val: down.val, h: down.menu.h }) : "面板已收起");
        // 层次：命令格淡底、键帽实底、摇杆带 accent（三者不撞脸）
        const tone = await p.evaluate(() => {
          // color-mix 的计算值序列化成 color(srgb r g b / a)，实底是 rgb()/color(srgb …) 不带 alpha
          const alpha = (c) => {
            const m = /rgba?\(([^)]+)\)/.exec(c);
            if (m) return (m[1].split(",")[3] ?? "1").trim();
            const n = /^color\(srgb [\d.]+ [\d.]+ [\d.]+(?: \/ ([\d.]+))?\)$/.exec(c);
            return n ? (n[1] ?? "1") : "?";
          };
          const bg = (sel) => { const c = getComputedStyle(document.querySelector(sel)).backgroundColor; return { c, a: parseFloat(alpha(c)) }; };
          const svg = document.querySelector('[data-testid="assist-menu"] .assist-cmd .assist-ico svg').getBoundingClientRect();
          return { cmd: bg('[data-testid="assist-menu"] .assist-cmd'), key: bg('[data-testid="assist-menu"] .assist-key'),
            step: bg('[data-testid="assist-menu"] .assist-fontstep'), ico: [svg.width, svg.height] };
        });
        ck.check("层次：命令格淡底、键帽实底、摇杆另色；命令格图标 18px",
          tone.cmd.a < tone.key.a - 0.3 && tone.step.c !== tone.key.c && tone.ico[0] === 18 && tone.ico[1] === 18,
          JSON.stringify(tone));
        await p.close();
      }

      // ── ② 竖屏 390×844 中文 125% 专注：命令格两行（4 + 两枚宽格），文案全单行；
      //    软键盘压到 420 高走收紧档，收起后回到初开形态 ──
      {
        const p = await open({ name: "竖屏 390×844 zh 125% 专注", w: 390, h: 844, scale: "1.25", locale: "zh", focus: true });
        const g = await geo(p);
        fullBoard(ck, "竖屏 125% 专注", g, { count: 18 });
        ck.check("竖屏 125% 专注：面板高度 ≤ 220px（改前 304）", g.menu.h <= 220, `实得 ${g.menu.h}`);
        ck.eq("竖屏专注：命令格 4 + 2 两行", JSON.stringify(rowSizes(g)), JSON.stringify([4, 2]));
        ck.check("竖屏专注：六格文案都是单行、保持期望字号（没有缩字）",
          g.cmds.every((t) => t.lines === 1 && t.broken === 0 && Math.abs(t.fs - 12.5 * g.scale) < 0.01),
          JSON.stringify(g.cmds.map((t) => [t.text, t.fs, t.lines])));
        ck.check("竖屏专注：第二行两枚界面开关各占半行，比滚动格宽",
          g.rows[1].every((t) => t.w > g.rows[0][0].w + 20), JSON.stringify(g.rows.map((r) => r.map((t) => t.w))));
        // 唤出标签与工具栏：文案变「收起标签与工具栏」（多两个字）仍须单行、面板不长高
        await p.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("标签与工具栏")');
        await p.waitForTimeout(250);
        await p.click('[data-testid="assist-ball"]');
        await p.waitForSelector('[data-testid="assist-menu"]');
        await p.waitForTimeout(150);
        const on = await geo(p);
        const openTile = on.cmds.find((t) => t.text === "收起标签与工具栏");
        ck.check("唤出工具栏后：「收起标签与工具栏」单行、开合态点亮、面板高度不变",
          !!openTile && openTile.lines === 1 && openTile.cls.includes("ts-open") && on.cmds.length === 6
          && Math.abs(on.menu.h - g.menu.h) < 0.5 && on.scrollH <= on.clientH + 1,
          JSON.stringify({ tile: openTile && [openTile.text, openTile.fs, openTile.lines, openTile.cls], h: on.menu.h }));
        await p.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("收起标签与工具栏")');
        await p.waitForTimeout(250);
        // 软键盘：视口压到 420 高 → 收紧档（目标 36），不出滚动条；收起 → 回常规
        await p.click('[data-testid="assist-ball"]');
        await p.waitForSelector('[data-testid="assist-menu"]');
        await p.waitForTimeout(150);
        await setViewport(p, 390, 420);
        const kb = await geo(p);
        fullBoard(ck, "竖屏 125% 专注 + 软键盘（390×420）", kb, { count: 18, min: 36 });
        ck.eq("软键盘下走收紧档、不进图标版", tierName(kb), "ts-tight");
        ck.check("软键盘下面板高度 ≤ 200px", kb.menu.h <= 200, `实得 ${kb.menu.h}`);
        await setViewport(p, 390, 844);
        const back = await geo(p);
        ck.eq("软键盘收起后回到常规档", tierName(back), "regular");
        ck.check("收起后档位/高度/文案字号与初开一致", sameLayout(g, back), `${brief(g)} → ${brief(back)}`);
        await p.close();
      }

      // ── ③ 横屏 914×411 中文 125% 专注（浅色）：命令格单行六格 + 十键单行，整板两行 ──
      {
        const p = await open({ name: "横屏 914×411 zh 125% 专注", w: 914, h: 411, scale: "1.25", locale: "zh", focus: true,
          scheme: "light" });
        const g = await geo(p);
        fullBoard(ck, "横屏 914×411 zh 125% 专注", g, { count: 18 });
        ck.check("横屏：面板高度 ≤ 120px（改前 166 且专注态再折一行）", g.menu.h <= 120, `实得 ${g.menu.h}`);
        ck.eq("横屏：命令格单行六格", JSON.stringify(rowSizes(g)), JSON.stringify([6]));
        ck.eq("横屏：十键单行", JSON.stringify([g.keys.length, g.keyRows]), JSON.stringify([10, 1]));
        ck.check("横屏：六格文案单行、图标顶边与文案底边各成一条线",
          g.cmds.every((t) => t.lines === 1) && new Set(g.cmds.map((t) => Math.round(t.ico.y))).size === 1
          && new Set(g.cmds.map((t) => Math.round(t.labelBox.b))).size === 1,
          JSON.stringify(g.cmds.map((t) => [t.text, t.lines, t.ico.y, t.labelBox.b])));
        const scrollTile = g.cmds.find((t) => t.text === "上翻一页");
        const chromeTile = g.cmds.find((t) => t.text === "标签与工具栏");
        ck.check("横屏：文案更长的两枚界面开关分到更宽的列", chromeTile.w > scrollTile.w * 1.15,
          JSON.stringify([scrollTile.w, chromeTile.w]));
        ck.check("横屏：摇杆立在右缘跨两行（与整板等高）",
          Math.abs(g.font[0].y - g.menu.y - 7) < 1.5 && g.stepDir === "column",
          JSON.stringify({ top: g.font[0].y, menu: g.menu.y }));
        await p.close();
      }

      // ── ④ 小横屏 667×375 英文 100% 紧凑专注：六格文案整行统一缩到刚好单行 ──
      {
        const p = await open({ name: "小横屏 667×375 en 100% 紧凑专注", w: 667, h: 375, scale: "1", locale: "en", focus: true,
          density: "compact" });
        const g = await geo(p);
        fullBoard(ck, "小横屏 667×375 en 100% 紧凑专注", g, { count: 18 });
        ck.eq("小横屏：命令格单行六格", JSON.stringify(rowSizes(g)), JSON.stringify([6]));
        const fs = [...new Set(g.cmds.map((t) => t.fs))];
        const expected = 12.5 * g.scale;
        ck.check("小横屏英文：六格文案全单行、同排字号全等、缩了但没低于期望的 80%",
          g.cmds.every((t) => t.lines === 1 && t.broken === 0) && fs.length === 1 && fs[0] < expected - 0.05
          && fs[0] >= expected * 0.8 - 0.01,
          JSON.stringify({ fs, expected, lines: g.cmds.map((t) => t.lines) }));
        ck.check("小横屏英文：面板高度 ≤ 116px（按期望字号折行是 128）", g.menu.h <= 116, `实得 ${g.menu.h}`);
        // 软键盘：210 高 → 图标版单行；收起后文案字号必须按常规版式重定（回到同一值）
        await setViewport(p, 667, 210);
        const kb = await geo(p);
        fullBoard(ck, "小横屏 + 软键盘（667×210）", kb, { count: 18, min: 36 });
        ck.eq("软键盘下进图标版", tierName(kb), "ts-tight+ts-mini");
        ck.check("图标版：整板单行 ≤ 56px、十键同排、压在球上方",
          kb.menu.h <= 56 && kb.keyRows === 1 && kb.menu.b <= kb.ball.y, JSON.stringify({ h: kb.menu.h, keyRows: kb.keyRows }));
        ck.check("图标版：命令格只剩图标（文案转读屏可见，1px 盒裁切）",
          kb.cmds.every((t) => t.labelBox.w <= 1 && t.labelBox.h <= 1 && t.ico.w > 10),
          JSON.stringify(kb.cmds.map((t) => [t.text, t.labelBox.w, t.labelBox.h])));
        await setViewport(p, 667, 375);
        const back = await geo(p);
        ck.eq("软键盘收起后回到常规档", tierName(back), "regular");
        ck.check("收起后文案回到初开的统一字号、仍全单行", sameLayout(g, back), `${brief(g)} → ${brief(back)}`);
        await setViewport(p, 667, 210);
        ck.eq("再压一次仍进图标版", tierName(await geo(p)), "ts-tight+ts-mini");
        await setViewport(p, 667, 375);
        ck.check("再收一次仍与初开一致（切档可重复，不带上一轮的档位量文案）",
          sameLayout(g, await geo(p)), brief(await geo(p)));
        await p.close();
      }

      // ── ⑤ 分屏半幅 457×411 中文 125% 专注：四字文案整行统一缩，仍单行 ──
      {
        const p = await open({ name: "分屏半幅 457×411 zh 125% 专注", w: 457, h: 411, scale: "1.25", locale: "zh", focus: true });
        const g = await geo(p);
        fullBoard(ck, "分屏半幅 457×411 zh 125% 专注", g, { count: 18 });
        const fs = [...new Set(g.cmds.map((t) => t.fs))];
        const expected = 12.5 * g.scale;
        ck.check("分屏半幅：命令格单行六格、文案全单行、同排字号全等、缩了但没低于期望的 68%",
          rowSizes(g).join() === "6" && g.cmds.every((t) => t.lines === 1) && fs.length === 1
          && fs[0] < expected - 0.05 && fs[0] >= expected * 0.68 - 0.01,
          JSON.stringify({ rows: rowSizes(g), fs, expected, lines: g.cmds.map((t) => t.lines) }));
        ck.check("分屏半幅：面板高度 ≤ 160px", g.menu.h <= 160, `实得 ${g.menu.h}`);
        await p.close();
      }

      // ── ⑥ 极窄横屏 480×320 中文 125% 专注：320 高里也整板可见 ──
      {
        const p = await open({ name: "极窄横屏 480×320 zh 125% 专注", w: 480, h: 320, scale: "1.25", locale: "zh", focus: true });
        const g = await geo(p);
        fullBoard(ck, "极窄横屏 480×320 zh 125% 专注", g, { count: 18 });
        ck.check("480×320：命令格单行六格、文案全单行、同排字号全等、面板 ≤ 160px",
          rowSizes(g).join() === "6" && g.cmds.every((t) => t.lines === 1) && new Set(g.cmds.map((t) => t.fs)).size === 1
          && g.menu.h <= 160, brief(g));
        await p.close();
      }

      // ── ⑦ 竖屏英文 390×844 125% 专注：缩不到 80% 就保持期望字号按词折行 ──
      {
        const p = await open({ name: "竖屏英文 390×844 en 125% 专注", w: 390, h: 844, scale: "1.25", locale: "en", focus: true });
        const g = await geo(p);
        fullBoard(ck, "竖屏英文 390×844 en 125% 专注", g, { count: 18 });
        ck.check("竖屏英文：面板高度 ≤ 236px、命令格 4 + 2 两行", g.menu.h <= 236 && rowSizes(g).join() === "4,2", brief(g));
        ck.check("竖屏英文：没有任何单词被从中间拆开", g.cmds.every((t) => t.broken === 0),
          JSON.stringify(g.cmds.filter((t) => t.broken).map((t) => t.text)));
        ck.check("竖屏英文：折行的格子保持期望字号（宁可两行不缩到 80% 以下）",
          g.cmds.every((t) => Math.abs(t.fs - 12.5 * g.scale) < 0.01) && g.cmds.some((t) => t.lines === 2),
          JSON.stringify(g.cmds.map((t) => [t.text, t.fs, t.lines])));
        ck.check("竖屏英文：同行四格图标顶边一条线、文案末行底边一条线",
          g.rows[0].every((t) => t.lines >= 1) && new Set(g.rows[0].map((t) => Math.round(t.ico.y))).size === 1
          && new Set(g.rows[0].map((t) => Math.round(t.labelBox.b))).size === 1,
          JSON.stringify(g.rows[0].map((t) => [t.text, t.lines, t.ico.y, t.labelBox.b])));
        await p.close();
      }

      // ── ⑧ 极窄竖屏 240×480 英文 100%：最宽的词放不下时只收这一格，单词仍不拆 ──
      {
        const p = await open({ name: "极窄竖屏 240×480 en 100%", w: 240, h: 480, scale: "1", locale: "en" });
        const g = await geo(p);
        fullBoard(ck, "极窄竖屏 240×480 en 100%", g, { count: 16 });
        const back = g.cmds.find((t) => t.text === "Back to bottom");
        ck.check("极窄英文：「Back to bottom」折成整词三行，字号收到词放得下、不低于 9.5px",
          !!back && back.broken === 0 && back.lines === 3 && back.fs < 12.5 * g.scale - 0.05 && back.fs >= 9.5,
          JSON.stringify(back && [back.text, back.fs, back.lines, back.broken]));
        ck.check("极窄英文：四格都没有拆词、没有横向溢出", g.cmds.every((t) => t.broken === 0 && !t.ovf),
          JSON.stringify(g.cmds.map((t) => [t.text, t.fs, t.lines, t.broken])));
        await p.close();
      }

      // ── ⑨ 极窄竖屏 280×653 中文 100%：摇杆降为横排独占一行（键排旁放不下） ──
      {
        const p = await open({ name: "极窄竖屏 280×653 zh 100%", w: 280, h: 653, scale: "1", locale: "zh" });
        const g = await geo(p);
        fullBoard(ck, "极窄竖屏 280×653 zh 100%", g, { count: 16 });
        ck.check("280 宽：面板不超视口宽、命令格一行四格", g.menu.w <= g.vw && rowSizes(g).join() === "4", brief(g));
        ck.check("280 宽：摇杆横排成「A− 读数 A+」、三者在同一行、钮宽 ≥ 30px",
          g.stepDir === "row-reverse" && g.font.length === 2 && g.font[0].text === "A+" && g.font[1].text === "A−"
          && Math.abs(g.font[0].y - g.font[1].y) < 0.5 && g.font[1].r <= g.valBox.x + 0.5 && g.valBox.r <= g.font[0].x + 0.5
          && g.font.every((f) => f.w >= 30),
          JSON.stringify({ dir: g.stepDir, a: g.font.map((f) => [f.text, f.x, f.r, f.w]), val: g.valBox }));
        await p.close();
      }

      // ── ⑩ 小横屏 568×320 英文 125% 专注 + 软键盘（190 高）：键帽字号下限放到 66% 后
      //    这一档也单行放得下（72% 时整档被放弃、退回应急滚动） ──
      {
        const p = await open({ name: "小横屏 568×320 en 125% 专注", w: 568, h: 320, scale: "1.25", locale: "en", focus: true });
        const g = await geo(p);
        fullBoard(ck, "小横屏 568×320 en 125% 专注", g, { count: 18 });
        await setViewport(p, 568, 190);
        const kb = await geo(p);
        fullBoard(ck, "小横屏 en 125% + 软键盘（568×190）", kb, { count: 18, min: 36 });
        ck.eq("软键盘下进图标版（键帽不溢出）", tierName(kb), "ts-tight+ts-mini");
        ck.check("图标版单行 ≤ 56px、键帽文案不溢出、每格触控目标 ≥ 36×22",
          kb.menu.h <= 56 && kb.items.every((k) => !k.ovf && k.h >= 36 && k.w >= 22),
          JSON.stringify({ h: kb.menu.h, keys: kb.keys.map((k) => k.w), minW: Math.min(...kb.items.map((k) => k.w)) }));
        await setViewport(p, 568, 320);
        const back = await geo(p);
        ck.eq("软键盘收起后回到常规档", tierName(back), "regular");
        ck.check("收起后与初开一致", sameLayout(g, back), `${brief(g)} → ${brief(back)}`);
        await p.close();
      }

      // ── ⑪ 溢出保护：200 宽 + 125% 字号时图标版的键帽放不下——整档放弃，退回收紧档的
      //    应急滚动，不留「图标没了键帽又溢出」的半截图标版 ──
      {
        const p = await open({ name: "极窄横屏 200×320 zh 125%", w: 200, h: 320, scale: "1.25", locale: "zh" });
        const g = await geo(p);
        ck.check("200 宽：图标版被整档放弃（不挂 ts-mini）、停在收紧档",
          !!g && !g.tier.includes("ts-mini") && g.tier.includes("ts-tight"), g ? tierName(g) : "面板不在场");
        ck.check("200 宽：应急滚动生效（max-height 落地、内容可滚）、面板完整在视口内",
          !!g && g.scrollH > g.clientH + 1 && /px$/.test(g.maxH) && inViewport(g),
          g ? JSON.stringify({ scroll: `${g.scrollH}/${g.clientH}`, maxH: g.maxH, menu: g.menu, vh: g.vh }) : "");
        ck.check("200 宽：命令格文案仍可见（没有残留图标版的裁切）",
          !!g && g.cmds.every((t) => t.labelBox.w > 1 && t.labelBox.h > 1),
          g ? JSON.stringify(g.cmds.map((t) => [t.text, t.labelBox.w, t.labelBox.h])) : "");
        await p.close();
      }

      // ── ⑫ 桌面端（设置开启球）专注 1440×900：只有一枚界面开关，五格同宽一行，不留半行空位 ──
      {
        const p = await open({ name: "桌面专注 1440×900 zh 100%", w: 1440, h: 900, scale: "1", locale: "zh", focus: true, desktop: true });
        const g = await geo(p);
        fullBoard(ck, "桌面专注 1440×900 zh 100%", g, { count: 17 });
        const scroll = g.cmds.filter((t) => !t.cls.includes("assist-chrome")).map((t) => t.w);
        const chrome = g.cmds.filter((t) => t.cls.includes("assist-chrome")).map((t) => t.w);
        ck.check("桌面专注：四枚滚动/粘贴格同宽、界面开关 1.3 倍宽、同一行、十键单行、面板 ≤ 120px",
          rowSizes(g).join() === "5" && scroll.length === 4 && chrome.length === 1
          && Math.max(...scroll) - Math.min(...scroll) < 0.5 && chrome[0] > scroll[0] * 1.25 && chrome[0] < scroll[0] * 1.35
          && g.keyRows === 1 && g.menu.h <= 120, brief(g));
        ck.eq("桌面专注：面板里有「退出专注模式」、没有「标签与工具栏」（桌面 chrome 本就完整）",
          JSON.stringify(g.cmds.map((t) => t.text)), JSON.stringify(["上翻一页", "下翻一页", "回到底部", "粘贴", "退出专注模式"]));
        await p.close();
      }
    } finally {
      await closeAll();
    }

    ck.eq("全程无页面 JS 错误", errors.length, 0);
  },
};
