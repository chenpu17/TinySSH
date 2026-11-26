// 105 触屏点按终端（KI-132）：xterm 6.1 起终端触摸滚动改由内置手势层驱动，它在 document
// 上取消 touchstart/touchmove/touchend 的默认行为；点按被一并取消后浏览器不再合成兼容
// 鼠标事件，于是点终端不聚焦（手机上不出软键盘）、点链接没有浮条、单击不清选区。
//
// 桌面 Chrome 上复现：开真触屏环境（hasTouch 让 xterm 手势层激活），用真实触摸事件
// （Playwright touchscreen / CDP 触摸注入，不是 DOM 合成事件）点按，断言点按放行后这些
// 行为回来，且手势滚动仍由手势层接管（touchmove 照旧被取消、拖动能回看历史）。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

// 取可见终端与几何：.xterm-screen 矩形 + cell 尺寸（与 addon-fit 同源）
const geom = (page) => page.evaluate(() => {
  const t = window.__t_terms && [...window.__t_terms.values()].find((x) =>
    x.element && x.element.isConnected && x.element.getBoundingClientRect().height > 0);
  if (!t) return null;
  window.__t = t;
  const r = t.element.querySelector(".xterm-screen").getBoundingClientRect();
  const cell = t._core?._renderService?.dimensions?.css?.cell;
  return { left: r.left, top: r.top, w: cell?.width ?? 0, h: cell?.height ?? 0, rows: t.rows };
});

const focused = (page) => page.evaluate(() => {
  const ae = document.activeElement;
  return !!ae && ae.classList.contains("xterm-helper-textarea") && !!window.__t.element.contains(ae);
});

const viewport = (page) => page.evaluate(() => {
  const b = window.__t.buffer.active;
  return { y: b.viewportY, base: b.baseY, len: b.length };
});

module.exports = {
  title: "触屏点按终端：聚焦、清选区、链接浮条回来，手势滚动不受影响",
  async run({ browser, ck, BASE }) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
    const cdp = await ctx.newCDPSession(page);
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1300);
      const env = await page.evaluate(() => ({
        touch: ("ontouchstart" in window) && navigator.maxTouchPoints > 0,
      }));
      ck.check("处于真触屏环境（xterm 手势层据此激活）", env.touch, JSON.stringify(env));
      await connectLocal(page);

      // 事件取证：窗口捕获阶段留下最近一次 touch 事件对象，事后读 defaultPrevented
      await page.evaluate(() => {
        window.__tl = {};
        for (const ty of ["touchstart", "touchmove", "touchend"]) {
          window.addEventListener(ty, (ev) => { window.__tl[ty] = ev; }, { capture: true, passive: true });
        }
      });
      await page.evaluate(() => {
        const live = [...window.__t_terms.values()].find((t) =>
          t.element && t.element.isConnected && t.element.getBoundingClientRect().height > 0);
        live.write("\x1b[2J\x1b[3J\x1b[H");
        live.write("hello world alpha\r\nsee https://example.com/tiny for details\r\n\r\n\r\n");
        for (let i = 0; i < 150; i++) live.write(`line ${String(i).padStart(3, "0")} ${"-".repeat(40)}\r\n`);
      });
      await page.waitForTimeout(500);
      const g = await geom(page);
      ck.check("终端可见且能取到 cell 尺寸", !!g && g.w > 0 && g.h > 0, JSON.stringify(g));
      if (!g || !(g.w > 0)) return;
      const pt = (col, vrow) => ({ x: g.left + (col + 0.5) * g.w, y: g.top + (vrow + 0.5) * g.h });
      const toBottom = async () => {
        await page.evaluate(() => window.__t.scrollToBottom());
        await page.waitForTimeout(120);
      };
      await toBottom();

      // ── 点按聚焦：终端失焦后，真实触摸点按终端 → xterm 的 textarea 持焦点 ──
      const unfocus = async () => {
        await page.evaluate(() => { document.activeElement?.blur?.(); });
        await page.waitForTimeout(80);
      };
      await unfocus();
      ck.check("前置：终端已失焦", !(await focused(page)), "");
      const blank = pt(2, g.rows - 2); // 屏幕最下方第二行：line 输出的「li」附近，无链接
      await page.touchscreen.tap(blank.x, blank.y);
      await page.waitForTimeout(250);
      ck.check("触摸点按终端后 xterm 的 textarea 持焦点（手机上才会出软键盘）", await focused(page),
        JSON.stringify(await page.evaluate(() => ({ ae: document.activeElement?.className || document.activeElement?.tagName,
          prevented: Object.fromEntries(Object.entries(window.__tl).map(([k, v]) => [k, v.defaultPrevented])) }))));

      // ── 放行的是点按（touchstart/touchend），不是 touchmove ──
      const flags = await page.evaluate(() => ({
        start: window.__tl.touchstart?.defaultPrevented, end: window.__tl.touchend?.defaultPrevented,
      }));
      ck.eq("点按时 touchstart 不再被取消", flags.start, false);
      ck.eq("点按时 touchend 不再被取消", flags.end, false);

      // ── 单击清选区（xterm 单击语义）──
      // 与上一次点按隔开 xterm 的双击窗口（500ms 内同格再按会按双击选词）
      await page.waitForTimeout(650);
      await page.evaluate(() => { const t = window.__t; const b = t.buffer.active; t.select(0, b.viewportY + 2, 4); });
      ck.check("前置：已有选区", await page.evaluate(() => window.__t.hasSelection()), "");
      await page.touchscreen.tap(blank.x, blank.y);
      await page.waitForTimeout(250);
      ck.check("触摸单击清掉选区", !(await page.evaluate(() => window.__t.hasSelection())), "");

      // ── 链接点按弹浮条（KI-052 的移动端路径，依赖兼容鼠标事件）──
      await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
      await page.waitForTimeout(650);
      // 移动端判定下 chrome 高度会变（终端矩形下移），坐标按新几何重取
      const gm = await geom(page);
      ck.check("移动端判定下终端仍可见", !!gm && gm.w > 0, JSON.stringify(gm));
      if (!gm || !(gm.w > 0)) return;
      const pm = (col, vrow) => ({ x: gm.left + (col + 0.5) * gm.w, y: gm.top + (vrow + 0.5) * gm.h });
      // 清屏后从缓冲区顶部写起：回到顶部后第 0/1 行就是含链接的两行
      await page.evaluate(() => window.__t.scrollToTop());
      await page.waitForTimeout(200);
      const link = pm(8, 1); // "see https://example.com/tiny …" 第 1 行第 8 列（https 内）
      // 手指先落到别处再落到链接：xterm Linkifier 只在格变化时重新识别链接
      await page.touchscreen.tap(pm(2, 3).x, pm(2, 3).y);
      await page.waitForTimeout(200);
      await page.touchscreen.tap(link.x, link.y);
      await page.waitForTimeout(350);
      const bar = await page.evaluate(() => {
        const b = document.querySelector("[data-testid=touch-bar]");
        return b ? [...b.querySelectorAll("[data-testid]")].map((x) => x.dataset.testid) : null;
      });
      ck.check("触摸点按链接弹出浮条（打开/复制链接）", !!bar && bar.includes("touch-link-open") && bar.includes("touch-link-copy"),
        JSON.stringify({ bar, toasts: await page.evaluate(() => [...document.querySelectorAll(".toast")].map((x) => x.textContent.slice(0, 40))) }));
      await page.evaluate(() => window.__tinysshBack?.());
      await page.waitForTimeout(200);

      // ── 手势滚动不受影响：拖动回看历史，touchmove 仍被手势层取消 ──
      await page.evaluate(() => { window.__tl = {}; });
      await toBottom();
      const before = await viewport(page);
      ck.eq("前置：视口停在底部", before.y, before.base);
      const x = gm.left + gm.w * 10;
      const y0 = gm.top + gm.h * 4, y1 = gm.top + gm.h * (gm.rows - 6); // 手指下移 = 回看历史
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0, id: 1 }] });
      for (let i = 1; i <= 14; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * i / 14, id: 1 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
      const after = await viewport(page);
      ck.check("触摸拖动仍能回看历史（手势滚动生效）", after.y < after.base - 3, JSON.stringify({ before, after }));
      ck.eq("拖动时 touchmove 仍被手势层取消（浏览器不接管滚动）",
        await page.evaluate(() => window.__tl.touchmove?.defaultPrevented), true);

      // 触屏上下文是本 spec 自建的，harness 的页面错误断言只看主页面，这里自己收
      ck.check("触屏上下文全程无页面 JS 错误", errors.length === 0, errors.slice(0, 3).join(" | "));
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};
