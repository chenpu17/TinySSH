// 89 触屏可用性不跟宽度断点走：手机横屏常见 800–915 CSS px，超过 760 后移动布局块
// 整体失效，但触屏依旧没有 hover。此前主机卡操作组（收藏/编辑/删除）、SFTP 行下载钮、
// 终端「回到底部」浮钮都只在 :hover 显形——横屏后入口凭空消失。本 spec 在 1440 宽度
// 下只模拟主指针为触屏，钉住 `@media (hover: none)` 兜底：三类入口无需悬停即可见、可点。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

module.exports = {
  title: "触屏/横屏与标签关闭：无 hover 入口可见，关闭钮直接 hover 反馈完整",
  async run({ page, browser, ck, BASE }) {
    // 手机横屏形态：宽度保持 1440（移动布局的 ≤760 断点不生效），只挂平台标记。
    // 触屏可用性兜底读 :root[data-platform]（与 isMobilePlatform 同一判据）。
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    ck.eq("平台标记已挂上（移动端世界）", await page.evaluate(() =>
      document.documentElement.dataset.platform), "android");
    // opacity 有 0.12s 过渡：等它落定再量，否则读到动画起点的 0
    await page.waitForTimeout(250);

    // ── 主机卡操作组：未悬停即可见可点 ──
    const side = await page.evaluate(() => {
      const el = document.querySelector(".host-card .host-card-side");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, pe: cs.pointerEvents };
    });
    ck.eq("主机卡操作组无需悬停即显形", side?.opacity, "1");
    ck.eq("主机卡操作组可直接点按（不被 pointer-events 挡掉）", side?.pe, "auto");

    await connectLocal(page);
    // 造出可回滚的历史：先写满一屏以上、等解析落地，再滚到顶部（write 是异步的，
    // 写完立刻 scrollToTop 会被随后的解析回落到带动回底部）
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) =>
        x.element && x.element.isConnected && x.element.getBoundingClientRect().height > 0);
      window.__t = t;
      for (let i = 0; i < 80; i++) t.write(`line ${i}\r\n`);
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__t.scrollToTop(); });
    await page.waitForTimeout(400);

    // ── 「回到底部」浮钮：离开底部即显形，且触屏上可点（真正滚回底部）──
    const sb = await page.evaluate(() => {
      const el = document.querySelector("[data-testid=term-scroll-bottom]");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { hidden: el.hidden, opacity: cs.opacity, pe: cs.pointerEvents, text: el.textContent };
    });
    ck.check("滚出底部后浮钮出现（hidden 被取消）", !!sb && !sb.hidden, JSON.stringify(sb));
    ck.eq("无 hover 时浮钮不靠悬停即显形", sb?.opacity, "1");
    ck.eq("无 hover 时浮钮可点", sb?.pe, "auto");
    ck.check("浮钮如实报出下方剩余行数", /下方 \d+ 行/.test(sb?.text ?? ""), sb?.text);
    await page.click("[data-testid=term-scroll-bottom]");
    await page.waitForTimeout(300);
    ck.check("点按浮钮真的滚回底部（隐藏）", await page.evaluate(() => {
      const el = document.querySelector("[data-testid=term-scroll-bottom]");
      return !!el && el.hidden;
    }));

    // ── SFTP 行下载钮：未悬停即可见可点 ──
    await page.click('[data-testid="rb-files"]');
    await page.waitForTimeout(900);
    const dl = await page.evaluate(() => {
      const el = document.querySelector(".sftp-row .sftp-dl");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { opacity: cs.opacity, pe: cs.pointerEvents, w: r.width };
    });
    ck.eq("SFTP 下载钮无需悬停即显形", dl?.opacity, "1");
    ck.eq("SFTP 下载钮可直接点按", dl?.pe, "auto");
    ck.check("下载钮有真实命中区（宽度 > 0）", (dl?.w ?? 0) > 0, JSON.stringify(dl));

    // ── 非当前标签关闭钮：独立桌面页；Android 平台标记会隐藏桌面标签条 ──
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(BASE, { waitUntil: "domcontentloaded" });
    await desktop.waitForTimeout(1300);
    const inactiveTab = desktop.locator('.tab:not(.tab-active)').first();
    await inactiveTab.hover();
    await desktop.waitForTimeout(180);
    const inactiveClose = inactiveTab.locator('.tab-x');
    await inactiveClose.hover();
    await desktop.waitForTimeout(180);
    const closeHover = await inactiveClose.evaluate((el) => ({
      matches: el.matches(':hover'),
      opacity: getComputedStyle(el).opacity,
      background: getComputedStyle(el).backgroundColor,
    }));
    ck.check("非当前标签关闭钮可被直接悬停", closeHover.matches, JSON.stringify(closeHover));
    ck.eq("直接悬停关闭钮透明度到 1（不被父级显形规则压回 0.75）", closeHover.opacity, "1");
    await desktop.close();

    // ── 真触屏媒体环境：不是只挂 data-platform；非当前标签关闭钮无需 hover 即可点 ──
    const touch = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    await touch.goto(BASE, { waitUntil: "domcontentloaded" });
    await touch.waitForTimeout(1300);
    const touchClose = await touch.evaluate(() => {
      const el = document.querySelector('.tab:not(.tab-active) .tab-x');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        hoverNone: matchMedia('(hover: none)').matches,
        anyCoarse: matchMedia('(any-pointer: coarse)').matches,
        opacity: cs.opacity,
        pe: cs.pointerEvents,
      };
    });
    ck.check("触屏探针确实处于无 hover / coarse 环境",
      touchClose?.hoverNone && touchClose?.anyCoarse, JSON.stringify(touchClose));
    ck.eq("真触屏下非当前标签关闭钮常显", touchClose?.opacity, "0.75");
    ck.eq("真触屏下非当前标签关闭钮可直接点按", touchClose?.pe, "auto");
    await touch.close();
  },
};
