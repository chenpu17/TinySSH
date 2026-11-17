// 92 移动端助力球（GitHub #40 / #45）：远程桌面场景没有鼠标滚轮，标签条与工具栏
// 在手机上又吃空间。右缘悬浮球（⇅）展开动作面板：上翻 / 下翻 / 回到底部（xterm
// 本地 scrollback，不进 PTY），专注态还能唤出/收起标签与工具栏、退出专注。
// 同时钉住 #45 的「专注态标签条碍事」：移动端专注态标签条与工具栏默认不渲染，
// 只有助力球面板的「标签与工具栏」能把它们叫回来——桌面专注模式不受影响。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

/** 找到活动终端实例（demo 里 __t_terms 是会话 sid → Terminal 的 dev 探针）。 */
const termInfo = (page) => page.evaluate(() => {
  const entries = [...(window.__t_terms?.entries?.() ?? [])]
    .filter(([, t]) => t.element && t.element.isConnected);
  if (!entries.length) return null;
  const [sid, t] = entries[entries.length - 1];
  const b = t.buffer.active;
  return { sid, baseY: b.baseY, viewportY: b.viewportY, rows: t.rows };
});

const openBall = async (page) => {
  await page.click('[data-testid="assist-ball"]');
  await page.waitForSelector('[data-testid="assist-menu"]');
};

/** 真机触摸路径：Chrome Android 的序列是 pointerdown → pointerup → click
 *  （pointerdown 被 preventDefault 也不会吞掉 click，实测如此），助力球靠
 *  pointerup 激活、700ms 内忽略随后的 click——否则一次点按会开了又关。
 *  菜单项执行后面板要晚一拍（setTimeout 0）才卸载：尾随 click 若在卸载后
 *  才派发，会穿过面板落到终端画布上，xterm 拿焦点把软键盘顶起来。这里补
 *  click 正是在验证这一拍（click 落在仍在的面板项上、被去重吃掉）。
 *  三个事件必须在同一个任务里派发（浏览器就是这么发的）；拆成三次
 *  dispatchEvent 会各走一轮往返，收起定时器先跑，click 便没有目标了。 */
const touchTap = async (page, selector, clickAfter = true) =>
  page.evaluate(({ selector, clickAfter }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`touchTap: 找不到 ${selector}`);
    const types = clickAfter ? ["pointerdown", "pointerup", "click"] : ["pointerdown", "pointerup"];
    for (const type of types) {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true,
      }));
    }
  }, { selector, clickAfter });
/** 菜单项按文案定位——面板可能已收起，必须同一次 evaluate 里找并派发。 */
const touchTapMenu = async (page, text) =>
  page.evaluate((text) => {
    const el = [...document.querySelectorAll('[data-testid="assist-menu"] .assist-item')]
      .find((b) => b.textContent.includes(text));
    if (!el) throw new Error(`touchTapMenu: 找不到「${text}」`);
    for (const type of ["pointerdown", "pointerup", "click"]) {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true,
      }));
    }
  }, text);

const chrome = (page) => page.evaluate(() => {
  const cs = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el) : null;
  };
  return {
    tabbarDisplay: cs(".tabbar-row")?.display ?? null,
    toolbarDisplay: cs(".session-toolbar")?.display ?? null,
    focusMode: document.querySelector(".app-shell")?.classList.contains("focus-mode") ?? null,
  };
});

module.exports = {
  title: "移动端助力球：翻页/回到底部 + 专注态唤出标签与工具栏",
  async run({ page, ck }) {
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await connectLocal(page);
    await page.setViewportSize({ width: 914, height: 411 });
    await page.waitForTimeout(300);

    // ── 悬浮球在移动端出现，且不与右下角「回到底部」胶囊叠 ──
    ck.eq("移动端出现助力球", await page.locator('[data-testid="assist-ball"]').count(), 1);
    const ballBox = await page.locator('[data-testid="assist-ball"]').boundingBox();
    ck.check("助力球在右缘可点（≥40px 见方）",
      ballBox && ballBox.width >= 40 && ballBox.height >= 40, JSON.stringify(ballBox));

    // ── 造 scrollback：底部写 120 行，视口停在底 ──
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write(Array.from({ length: 120 }, (_, i) => `assist-line-${i}`).join("\r\n") + "\r\n");
    });
    await page.waitForTimeout(400);
    const atBottom = await termInfo(page);
    ck.check("终端已有可滚动历史", atBottom && atBottom.baseY > 5, JSON.stringify(atBottom?.baseY));
    ck.eq("写入后视口仍在底部", atBottom.viewportY, atBottom.baseY);

    // ── 触摸路径（真机回归）：触摸的 click 被 pointerdown preventDefault 抑制，
    //    激活必须由 pointerup 补上；否则球在手机上点了没反应 ──
    await touchTap(page, '[data-testid="assist-ball"]');
    await page.waitForTimeout(200);
    ck.eq("触摸点球能展开面板", await page.locator('[data-testid="assist-menu"]').count(), 1);
    // 菜单项触摸 + 尾随 click：click 落到仍挂着的面板项上被去重，只翻一页
    await touchTapMenu(page, "上翻一页");
    await page.waitForTimeout(250);
    const touchUp = await termInfo(page);
    const touchDelta = atBottom.viewportY - touchUp.viewportY;
    ck.check("触摸菜单项只执行一次（尾随 click 不翻两页）",
      touchDelta > 0 && touchDelta <= touchUp.rows, `移动 ${touchDelta} 行，页高 ${touchUp.rows}`);
    ck.eq("触摸动作后面板收起", await page.locator('[data-testid="assist-menu"]').count(), 0);
    await openBall(page);
    await touchTapMenu(page, "回到底部");
    await page.waitForTimeout(250);
    const touchBack = await termInfo(page);
    ck.eq("触摸回到底部：视口回到最新行", touchBack.viewportY, touchBack.baseY);

    // ── 键盘已被返回键收起（data-ime='0'）但终端仍持焦点：触摸按钮不能
    //    preventDefault，否则 Chrome 会把键盘重新弹起（真机实测）。data-ime
    //    由原生 MainActivity 的 IME inset 监听推送。 ──
    const guard = await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea");
      const root = document.documentElement;
      const probe = () => {
        const ev = new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true,
        });
        document.querySelector('[data-testid="assist-ball"]').dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      ta.focus();
      root.dataset.ime = "0";
      const dismissed = probe();
      root.dataset.ime = "1";
      ta.focus();
      const visible = probe();
      delete root.dataset.ime;
      return { dismissed, visible };
    });
    ck.check("键盘收起且终端持焦点：触摸球不 preventDefault（否则键盘重弹）",
      guard.dismissed === false, JSON.stringify(guard));
    ck.check("键盘可见时仍 preventDefault（保住焦点与键盘）",
      guard.visible === true, JSON.stringify(guard));

    // ── 上翻一页：菜单动作只动本地视口 ──
    await openBall(page);
    ck.check("面板展开（上/下翻/回到底部三项）",
      (await page.locator('[data-testid="assist-menu"] [role="menuitem"]').count()) >= 3);
    await page.click('[data-testid="assist-menu"]:has-text("上翻一页") [role="menuitem"]:has-text("上翻一页")');
    await page.waitForTimeout(300);
    const afterUp = await termInfo(page);
    ck.check("上翻一页后视口离开底部", afterUp.viewportY < atBottom.viewportY,
      `底 ${atBottom.viewportY} → ${afterUp.viewportY}`);
    ck.eq("动作后自动收起面板", await page.locator('[data-testid="assist-menu"]').count(), 0);

    // 上翻后「回到底部」胶囊出现：球必须让开它（否则点不到）
    const pillBox = await page.locator(".term-scroll-bottom:not([hidden])").first().boundingBox().catch(() => null);
    ck.check("助力球与回到底部胶囊不重叠",
      !pillBox || !ballBox || ballBox.y + ballBox.height <= pillBox.y,
      JSON.stringify({ ball: ballBox, pill: pillBox }));

    // ── 下翻一页：往回走一页 ──
    await openBall(page);
    await page.click('[data-testid="assist-menu"]:has-text("下翻一页") [role="menuitem"]:has-text("下翻一页")');
    await page.waitForTimeout(300);
    const afterDown = await termInfo(page);
    ck.check("下翻一页后视口回移", afterDown.viewportY > afterUp.viewportY,
      `${afterUp.viewportY} → ${afterDown.viewportY}`);

    // ── 回到底部：无视当前滚动位置 ──
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.scrollToTop();
    });
    await page.waitForTimeout(200);
    const atTop = await termInfo(page);
    ck.check("已滚到顶（前置）", atTop.viewportY < atBottom.viewportY);
    await openBall(page);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("回到底部")');
    await page.waitForTimeout(300);
    const backTail = await termInfo(page);
    ck.eq("回到底部：视口回到最新行", backTail.viewportY, backTail.baseY);

    // ── 点遮罩关闭面板，不误触动作 ──
    await openBall(page);
    await page.click('[data-testid="assist-scrim"]', { position: { x: 40, y: 40 } });
    await page.waitForTimeout(200);
    ck.eq("点遮罩收起面板", await page.locator('[data-testid="assist-menu"]').count(), 0);
    const afterScrim = await termInfo(page);
    ck.eq("遮罩点击不触发滚动", afterScrim.viewportY, backTail.viewportY);

    // ── 竖屏（411×914）几何：球锚 workspace、胶囊锚终端容器，页脚更高时球
    //    曾压在胶囊右端（真机 27×23px 重叠、胶囊文字被切）；移动端胶囊左移
    //    让列后须仍不重叠。 ──
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.scrollToTop();
    });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 411, height: 914 });
    await page.waitForTimeout(300);
    const pBall = await page.locator('[data-testid="assist-ball"]').boundingBox();
    const pPill = await page.locator(".term-scroll-bottom:not([hidden])").first().boundingBox().catch(() => null);
    ck.check("竖屏：助力球不压回到底部胶囊",
      !pPill || !pBall || pBall.x + pBall.width <= pPill.x || pPill.x + pPill.width <= pBall.x
        || pBall.y + pBall.height <= pPill.y || pPill.y + pPill.height <= pBall.y,
      JSON.stringify({ ball: pBall, pill: pPill }));
    await page.setViewportSize({ width: 914, height: 411 });
    await page.waitForTimeout(300);

    // ── 专注态（#45）：标签条/工具栏默认收起，助力球唤出 ──
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(300);
    const focused = await chrome(page);
    ck.eq("专注态进入", focused.focusMode, true);
    ck.eq("移动端专注态：标签条默认收起", focused.tabbarDisplay, "none");
    ck.eq("移动端专注态：工具栏默认收起", focused.toolbarDisplay, "none");

    await openBall(page);
    ck.check("专注态面板多出「标签与工具栏」",
      await page.locator('[data-testid="assist-menu"] [role="menuitem"]:has-text("标签与工具栏")').count() === 1);
    ck.check("专注态面板多出「退出专注模式」",
      await page.locator('[data-testid="assist-menu"] [role="menuitem"]:has-text("退出专注模式")').count() === 1);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("标签与工具栏")');
    await page.waitForTimeout(300);
    const chromed = await chrome(page);
    ck.check("唤出后标签条可见", chromed.tabbarDisplay !== "none", chromed.tabbarDisplay);
    ck.eq("唤出后工具栏可见", chromed.toolbarDisplay, "flex");

    // 再开面板：同一项应变成「收起」
    await openBall(page);
    const collapseItem = page.locator('[data-testid="assist-menu"] [role="menuitem"]:has-text("收起标签与工具栏")');
    ck.eq("唤出后面板该项变为「收起标签与工具栏」", await collapseItem.count(), 1);
    await collapseItem.click();
    await page.waitForTimeout(300);
    const reclosed = await chrome(page);
    ck.eq("收起后标签条再次让位", reclosed.tabbarDisplay, "none");
    ck.eq("收起后工具栏再次让位", reclosed.toolbarDisplay, "none");

    // ── 退出专注模式 ──
    await openBall(page);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("退出专注模式")');
    await page.waitForTimeout(300);
    const exited = await chrome(page);
    ck.eq("面板可退出专注模式", exited.focusMode, false);
    ck.check("退出后标签条回来", exited.tabbarDisplay !== "none", exited.tabbarDisplay);
    ck.eq("退出工具栏回来", exited.toolbarDisplay, "flex");

    // ── 回桌面：助力球不渲染（桌面零影响） ──
    await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.click('[data-testid="focus-toggle"]'); // 触发一次重渲染，isMobilePlatform 重新求值
    await page.waitForTimeout(300);
    ck.eq("桌面不渲染助力球", await page.locator('[data-testid="assist-ball"]').count(), 0);
    const desktop = await chrome(page);
    ck.check("桌面专注态标签条仍在（不受移动端规则影响）", desktop.tabbarDisplay !== "none", desktop.tabbarDisplay);
    await page.click('[data-testid="focus-toggle"]');
  },
};
