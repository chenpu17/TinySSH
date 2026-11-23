// 92 助力球（GitHub #40 / #45，KI-102 + 功能轮）：远程桌面场景没有鼠标滚轮，标签条与工具栏
// 在手机上又吃空间。右缘悬浮球（⇅）展开动作面板：上翻 / 下翻 / 回到底部 + 常用键排
// （Esc/Tab/^C/↑/↓ 走真实键序），专注态还能唤出/收起标签与工具栏、退出专注。
// 滚动分两条真实通道（KI-102）：正常屏走 xterm 本地 scrollback（不进 PTY）；备用屏
// （tmux/vim 全屏）本地没有历史，旧版翻页是 no-op——改为合成触摸板滚轮事件，tmux
// mouse on 时 xterm 编码成 SGR 报文（64=上/65=下）发给 tmux 滚它自己的历史。
// 功能轮加：粘贴剪贴板项（⌘V 同收口）、扩展键帽 Home/End/PgUp/PgDn/^B、终端字号
// A−/A+（changeFontSize 同通道）、球拖动换位（≥6px 区分拖/点、越界钳制、左半屏
// 面板左对齐、位置持久化）、球径三档 --assist-ball-size（设置 → 助力球大小）。
// 桌面端默认不渲染——手机远程桌面（ToDesk 等）触控控制电脑时经设置「在桌面端显示
// 助力球」开启（远控注入的是鼠标事件，无法可靠自动识别）。同时钉住 #45 的「专注态
// 标签条碍事」：移动端专注态标签条与工具栏默认不渲染，只有助力球面板的「标签与
// 工具栏」能叫回来——桌面专注模式不受影响。
const connectLocal = async (page) => {
  await page.waitForSelector('.host-card:has(.host-name:text-is("本机"))');
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

/** 常用键按整文案精确匹配（键帽只有「↑」「↓」等纯文本，图标走 CSS 不掺文本，
 *  全等匹配不会误中滚动项的「上翻一页」等文案）。 */
const touchTapKey = async (page, label) =>
  page.evaluate((label) => {
    const el = [...document.querySelectorAll('[data-testid="assist-menu"] .assist-key')]
      .find((b) => b.textContent.trim() === label);
    if (!el) throw new Error(`touchTapKey: 找不到「${label}」`);
    for (const type of ["pointerdown", "pointerup", "click"]) {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, isPrimary: true,
      }));
    }
  }, label);

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
  title: "助力球：翻页/回到底部/常用键 + 专注态唤出标签与工具栏 + 桌面开关",
  async run({ page, ck }) {
    // 桌面端开关持久化在 localStorage：先清一次再重载，保证「桌面默认不渲染」
    // 断言不受上轮残留影响（球位/球径同为持久键，一并清）。
    await page.evaluate(() => {
      localStorage.removeItem("ui.assistBall");
      localStorage.removeItem("ui.assistBallSize");
      localStorage.removeItem("ui.assistBallPos");
    });
    await page.reload();
    await page.waitForTimeout(900);
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

    // ── 常用键排（触控无键盘场景）：Esc/Tab/^C/↑/↓ 走真实键序（sendMobileKey，
    //    与键盘同一条路），点键后面板不收（历史上下翻常要连点） ──
    await openBall(page);
    ck.eq("面板含常用键排（两行十键）",
      await page.locator('[data-testid="assist-menu"] .assist-key').count(), 10);
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      window.__keySpy = [];
      t.onData((d) => window.__keySpy.push(d));
    });
    await touchTapKey(page, "Esc");
    await touchTapKey(page, "Tab");
    await touchTapKey(page, "^C");
    await touchTapKey(page, "↑");
    await touchTapKey(page, "↓");
    await page.waitForTimeout(150);
    const keyData = await page.evaluate(() => window.__keySpy.slice());
    ck.eq("常用键发出真实键序（Esc/Tab/^C/↑/↓）",
      JSON.stringify(keyData.slice(0, 5)),
      JSON.stringify(["\x1b", "\t", "\x03", "\x1b[A", "\x1b[B"]));
    ck.eq("点常用键后面板不收（可连点）",
      await page.locator('[data-testid="assist-menu"]').count(), 1);
    // DECCKM：vim/tmux 等全屏应用开应用光标键模式后，方向键必须改发 SS3（ESC O A）
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write("\x1b[?1h");
    });
    await touchTapKey(page, "↑");
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write("\x1b[?1l");
    });
    const ss3 = await page.evaluate(() => window.__keySpy.slice());
    ck.eq("DECCKM 下方向键改发 SS3", ss3[ss3.length - 1], "\x1bOA");
    // 扩展键帽（功能轮）：Home/End/PgUp/PgDn/^B 真实键序；Home/End 与方向键同规
    await page.evaluate(() => { window.__keySpy = []; });
    await touchTapKey(page, "Home");
    await touchTapKey(page, "End");
    await touchTapKey(page, "PgUp");
    await touchTapKey(page, "PgDn");
    await touchTapKey(page, "^B");
    await page.waitForTimeout(150);
    const extData = await page.evaluate(() => window.__keySpy.slice());
    ck.eq("扩展键帽发出真实键序（Home/End/PgUp/PgDn/^B）",
      JSON.stringify(extData.slice(0, 5)),
      JSON.stringify(["\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~", "\x02"]));
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write("\x1b[?1h");
    });
    await touchTapKey(page, "Home");
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write("\x1b[?1l");
    });
    const ss3Home = await page.evaluate(() => window.__keySpy.slice());
    ck.eq("DECCKM 下 Home 也改发 SS3", ss3Home[ss3Home.length - 1], "\x1bOH");
    await page.click('[data-testid="assist-scrim"]', { position: { x: 40, y: 40 } });
    await page.waitForTimeout(200);

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

    // ── 桌面端开关（手机远程桌面触控场景）：设置开启后常显、持久化、可关。
    //    会话视图里主机栏收起，用活动栏常驻的 rail-settings 开设置 ──
    await page.click('[data-testid="rail-settings"]');
    await page.waitForTimeout(700);
    const toggleOn = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="desktop-assist-ball"]');
      if (!el) return { missing: true };
      el.click();
      return { missing: false, on: el.checked };
    });
    ck.check("设置含「在桌面端显示助力球」开关且可开", !toggleOn.missing && toggleOn.on, JSON.stringify(toggleOn));
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);
    ck.eq("开启后桌面渲染助力球", await page.locator('[data-testid="assist-ball"]').count(), 1);
    ck.eq("开关持久化到 localStorage", await page.evaluate(() => localStorage.getItem("ui.assistBall")), "1");
    await openBall(page);
    ck.check("桌面面板同样有翻页与常用键排",
      await page.locator('[data-testid="assist-menu"] [role="menuitem"]:has-text("上翻一页")').count() === 1
        && await page.locator('[data-testid="assist-menu"] .assist-key').count() === 10, "");

    // ── 备用屏（tmux/vim 全屏）翻页（KI-102）：本地没有 scrollback，旧版点
    //    「上翻」是 no-op（用户在 tmux 里毫无反应）。改为合成触摸板滚轮事件派发到
    //    终端根元素——tmux mouse on 时 xterm 把滚轮编码成 SGR 报文（ESC[<64=上 /
    //    65=下;col;rowM）发给 tmux 滚它自己的历史，与用户触摸板完全同一条路。这里
    //    开备用屏 + 鼠标上报协议模拟 tmux，点翻页后 onData 必须收到对应方向的报文。
    //    用独立 __wheelSpy（前面 __keySpy 的监听器仍在，另挂一个推不同数组互不干扰）。
    //    面板此刻已展开（上面 openBall），首个动作直接点、不再 openBall（否则toggle收起）。 ──
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      window.__wheelSpy = [];
      t.onData((d) => window.__wheelSpy.push(d));
      t.write("\x1b[?1049h");            // 进备用屏
      t.write("\x1b[?1000h\x1b[?1006h"); // tmux mouse on 的上报协议
    });
    await page.waitForTimeout(250);
    ck.eq("已进备用屏（前置）", await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      return t.buffer.active.type;
    }), "alternate");

    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("上翻一页")');
    await page.waitForTimeout(1200); // 等 rAF 逐帧派发完（rows 帧 ≈ 一屏轻拂）
    const upReports = await page.evaluate(() => window.__wheelSpy.filter((d) => d.includes("[<64;")).length);
    ck.check("备用屏上翻：合成滚轮发 SGR 上报（64=上，tmux 滚自身历史）", upReports > 0, `${upReports} 条`);

    await page.evaluate(() => { window.__wheelSpy = []; });
    await openBall(page);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("下翻一页")');
    await page.waitForTimeout(1200);
    const downReports = await page.evaluate(() => window.__wheelSpy.filter((d) => d.includes("[<65;")).length);
    ck.check("备用屏下翻：合成滚轮发 SGR 上报（65=下）", downReports > 0, `${downReports} 条`);

    // 回到底部 = 向下强拂三屏（3×rows 帧），报文应多于单页下翻
    await page.evaluate(() => { window.__wheelSpy = []; });
    await openBall(page);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("回到底部")');
    await page.waitForTimeout(1800);
    const bottomReports = await page.evaluate(() => window.__wheelSpy.filter((d) => d.includes("[<65;")).length);
    ck.check("备用屏回到底部：向下强拂三屏（报文多于单页）", bottomReports > downReports,
      `${bottomReports} > ${downReports}`);

    // 退出备用屏与鼠标上报，恢复现场。面板已随「回到底部」动作收起，无需再点遮罩。
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      t.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
    });
    await page.waitForTimeout(200);

    // ── 球拖动换位（功能轮）：位移 ≥6px 进拖动态——激活被抑制（不开面板）、
    //    内联 left/top 落位、localStorage 持久化、拖进左半 → assist-left 面板
    //    左对齐；拖完点按仍能开面板（去重窗只吃尾随 click，不吃下一次点按）。 ──
    const dragInfo = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true,
        clientX: x, clientY: y,
      }));
      fire("pointerdown", cx, cy);
      fire("pointermove", cx - 200, cy + 6);
      fire("pointermove", cx - 450, cy + 12);
      fire("pointerup", cx - 450, cy + 12);
      // 尾随 click（review-spec 缺口 a）：Chrome Android 触摸拖完会补 click——
      // 必须被去重窗吃掉，否则拖一下球面板开了又关
      fire("click", cx - 450, cy + 12);
      return {
        left: wrap.style.left, top: wrap.style.top,
        menuOpen: !!document.querySelector('[data-testid="assist-menu"]'),
        leftAligned: wrap.classList.contains("assist-left"),
        stored: localStorage.getItem("ui.assistBallPos"),
      };
    });
    ck.check("拖球落位（内联坐标 + 持久化 + 拖动态不开面板含尾随 click + 左对齐）",
      !!dragInfo && dragInfo.left !== "" && dragInfo.top !== "" && !dragInfo.menuOpen
        && dragInfo.leftAligned && !!dragInfo.stored, JSON.stringify(dragInfo));

    // 审核轮 review-geo 高危钉住：拖动位移必须恒定加在起始基准上——若实现
    // 把「上一帧落点」当新基准、又拿整段累计 total 去加，小步匀速拖会二次
    // 方跑偏（6 次 move 各 5px 期望 +30 实际 +105）。大位移钳边会掩盖这个
    // bug，必须小步多才抓得到。用 wrap.offsetLeft/Top 读 DOM 真值对比期望。
    const dragSmall = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 10, isPrimary: true,
        clientX: x, clientY: y,
      }));
      const startL = wrap.offsetLeft, startT = wrap.offsetTop;
      fire("pointerdown", cx, cy);
      // 6 次小步各 +5/+0（累计 30px），匀速模拟精拖——bug 会跑出 +105
      for (let i = 1; i <= 6; i++) fire("pointermove", cx + i * 5, cy);
      fire("pointerup", cx + 30, cy);
      return {
        startL, startT,
        endL: wrap.offsetLeft, endT: wrap.offsetTop,
        stored: JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null"),
      };
    });
    ck.check("小步慢拖落点=起点+累计位移（无二次方跑偏）",
      !!dragSmall && Math.abs(dragSmall.endL - (dragSmall.startL + 30)) <= 2
        && Math.abs(dragSmall.endT - dragSmall.startT) <= 2
        && dragSmall.stored && Math.abs(dragSmall.stored.x - dragSmall.endL) <= 1,
      JSON.stringify(dragSmall));

    // 鼠标/触控笔拖完的尾随 click 也必须被去重窗吃掉（审核轮真回归钉住）：
    // 若 dragEnd 只对 touch 置窗，mouse/pen 的 up→click 同步序列会漏过去把
    // 面板误开。用合成 pointerType=mouse/pen 走完 down→move→up→click 序列，
    // 断言菜单没开（合成事件 Chrome 不会自动补 click，手动补一发模拟浏览器）。
    const mouseDrag = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y, pt) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: pt, pointerId: 1, isPrimary: true,
        clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1,
      }));
      // 鼠标拖 50px
      fire("pointerdown", cx, cy, "mouse");
      fire("pointermove", cx - 50, cy, "mouse");
      fire("pointermove", cx - 100, cy, "mouse");
      fire("pointerup", cx - 100, cy, "mouse");
      // 浏览器在 up 后同步派发 click（鼠标/pen 同规）——手动补一发模拟它
      fire("click", cx - 100, cy, "mouse");
      const afterMouse = !!document.querySelector('[data-testid="assist-menu"]');
      // pen 同路径
      const b2 = ball.getBoundingClientRect();
      const c2x = b2.left + b2.width / 2, c2y = b2.top + b2.height / 2;
      fire("pointerdown", c2x, c2y, "pen");
      fire("pointermove", c2x + 30, c2y, "pen");
      fire("pointerup", c2x + 30, c2y, "pen");
      fire("click", c2x + 30, c2y, "pen");
      const afterPen = !!document.querySelector('[data-testid="assist-menu"]');
      return { afterMouse, afterPen };
    });
    ck.check("鼠标拖完尾随 click 被吃（面板不误开）",
      !!mouseDrag && !mouseDrag.afterMouse, JSON.stringify(mouseDrag));
    ck.check("触控笔拖完尾随 click 被吃（面板不误开）",
      !!mouseDrag && !mouseDrag.afterPen, JSON.stringify(mouseDrag));

    // 反向边界（review-spec 缺口钉住）：去重窗只该吃「同一次手势的尾随
    // click」，不能把拖完的下一次真实点按也吞掉。等过 150ms 窗再普通 tap
    // ——面板必须仍能开。这条与「不误开」是同一护栏的两面，缺一则窗要么
    // 形同虚设要么误伤交互。
    await page.waitForTimeout(200);
    await page.click('[data-testid="assist-ball"]');
    await page.waitForTimeout(150);
    ck.eq("拖完 150ms 后普通点按仍开面板（去重窗不吞真实点按）",
      await page.locator('[data-testid="assist-menu"]').count(), 1);
    await page.click('[data-testid="assist-scrim"]', { position: { x: 40, y: 40 } });
    await page.waitForTimeout(200);
    const ballBefore = await page.locator('[data-testid="assist-ball"]').boundingBox();
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    await openBall(page);
    const menuBox = await page.locator('[data-testid="assist-menu"]').boundingBox();
    const ballAfterOpen = await page.locator('[data-testid="assist-ball"]').boundingBox();
    ck.check("落位后开面板球不跳（top 锚不再向下生长推球）",
      Math.abs(ballAfterOpen.x - ballBefore.x) <= 1 && Math.abs(ballAfterOpen.y - ballBefore.y) <= 1,
      JSON.stringify({ closed: ballBefore, open: ballAfterOpen }));
    ck.check("面板完整在视口内（摆位钳制 + 上/下翻）",
      !!menuBox && menuBox.y >= -1 && menuBox.y + menuBox.height <= vp.h + 1
        && menuBox.x >= -1 && menuBox.x + menuBox.width <= vp.w + 1,
      JSON.stringify({ menu: menuBox, vp }));
    await page.click('[data-testid="assist-scrim"]', { position: { x: 40, y: 40 } });
    await page.waitForTimeout(200);

    // ── 终端字号 A−/A+（功能轮）：走设置同一条 changeFontSize（全实例生效），
    //    调字号要看着终端试——面板不收。 ──
    const fontBefore = await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      return t.options.fontSize;
    });
    await openBall(page);
    await page.click('[data-testid="assist-menu"] .assist-fontbtn[title*="增大"]');
    await page.waitForTimeout(250);
    const fontAfter = await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      return { size: t.options.fontSize, menu: !!document.querySelector('[data-testid="assist-menu"]') };
    });
    ck.check("A+ 增大终端字号且面板不收",
      fontAfter.size === fontBefore + 1 && fontAfter.menu, `${fontBefore} → ${fontAfter.size}`);
    await page.click('[data-testid="assist-menu"] .assist-fontbtn[title*="减小"]');
    await page.waitForTimeout(250);
    ck.eq("A− 回到原字号", await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      return t.options.fontSize;
    }), fontBefore);
    await page.click('[data-testid="assist-scrim"]', { position: { x: 40, y: 40 } });
    await page.waitForTimeout(200);

    // ── 粘贴剪贴板（功能轮）：授权后写剪贴板 → 面板粘贴 → onData 收到文本
    //    （pasteTextInto 收口：安全文本直接 term.paste → onData 同通道）。 ──
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("assist-paste-ok"));
    await page.evaluate(() => {
      const t = [...window.__t_terms.values()].find((x) => x.element && x.element.isConnected);
      window.__pasteSpy = [];
      t.onData((d) => window.__pasteSpy.push(d));
    });
    await openBall(page);
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("粘贴剪贴板")');
    await page.waitForTimeout(400);
    const pasteSpy = await page.evaluate(() => (window.__pasteSpy ?? []).join(""));
    ck.check("粘贴剪贴板落进终端数据通道", pasteSpy.includes("assist-paste-ok"),
      JSON.stringify(pasteSpy.slice(-80)));
    ck.eq("粘贴后面板收起（让位给可能的确认框）",
      await page.locator('[data-testid="assist-menu"]').count(), 0);

    // ── 球径三档（功能轮）：设置选「大」→ --assist-ball-size 落地 → 球径 52
    //    + localStorage 持久化（下一轮 spec 启动清理兜底）。 ──
    await page.click('[data-testid="rail-settings"]');
    await page.waitForTimeout(700);
    await page.selectOption('[data-testid="assist-ball-size"]', "l");
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);
    const bigBall = await page.locator('[data-testid="assist-ball"]').boundingBox();
    ck.check("球大小档位生效（52px）", bigBall && Math.round(bigBall.width) === 52, JSON.stringify(bigBall));
    ck.eq("球大小持久化", await page.evaluate(() => localStorage.getItem("ui.assistBallSize")), "l");

    // ── 缩窗重钳（审核轮 review-pointer 中危）：球 l 档（52px）先二次拖到右下
    //    角附近，缩窗到 500 宽——ResizeObserver 重钳进界并回写持久化；还原视口。 ──
    await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 8, isPrimary: true,
        clientX: x, clientY: y,
      }));
      fire("pointerdown", cx, cy);
      fire("pointermove", cx + 650, cy + 80);
      fire("pointerup", cx + 650, cy + 80);
    });
    await page.waitForTimeout(200);
    const beforeShrink = await page.evaluate(() => JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null"));
    await page.setViewportSize({ width: 500, height: 411 });
    await page.waitForTimeout(500);
    const afterShrink = await page.evaluate(() => JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null"));
    ck.check("缩窗后球位重钳进界并回写",
      beforeShrink && beforeShrink.x > 500 - 52 - 6   // 前置：缩窗前确实越界（否则断言空转）
        && afterShrink && afterShrink.x >= 6 && afterShrink.x <= 500 - 52 - 6
        && afterShrink.y >= 6,
      JSON.stringify({ before: beforeShrink, after: afterShrink }));
    await page.setViewportSize({ width: 914, height: 411 });
    await page.waitForTimeout(300);

    // 审核轮 review-geo 中危钉住：拖动中（未松手）缩窗/旋转触发 RO 时，不能
    // 把 wrap 内联样式闪回存储位——拖中坐标由 dragStart+total 实时驱动，回写
    // 旧位会让球瞬移一帧。断言拖中缩窗后 DOM left 仍贴着拖动轨迹（不是存储位）。
    const dragResize = await page.evaluate(async () => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 11, isPrimary: true,
        clientX: x, clientY: y,
      }));
      const stored = JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null");
      fire("pointerdown", cx, cy);
      fire("pointermove", cx - 60, cy);          // 进拖动态
      fire("pointermove", cx - 120, cy);         // 拖到一半（未松手）
      const midL = wrap.offsetLeft;
      return { storedX: stored?.x ?? null, midL, dragActive: true };
    });
    // 拖中（Playwright 侧事件未松）缩窗口——RO 会触发；若实现回写存储位，
    // wrap.offsetLeft 会瞬回 storedX 而非拖中位
    await page.setViewportSize({ width: 700, height: 411 });
    await page.waitForTimeout(400);
    const duringResize = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      return wrap ? { left: wrap.offsetLeft, inlineLeft: wrap.style.left } : null;
    });
    ck.check("拖动中缩窗：球不回跳存储位（RO 让位拖动）",
      !!duringResize && !!dragResize
        && Math.abs(duringResize.left - dragResize.midL) <= 200  // 仍贴拖动轨迹而非存储旧位
        && duringResize.inlineLeft !== "",
      JSON.stringify({ mid: dragResize?.midL, storedX: dragResize?.storedX, during: duringResize }));
    // 松手收尾（pointerup 在缩后的新位置落下——pendingClamp 应补钳进新边界）
    await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const b = ball.getBoundingClientRect();
      ball.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 11, isPrimary: true,
        clientX: b.left + 20, clientY: b.top + 20,
      }));
    });
    await page.waitForTimeout(300);
    const afterDragResize = await page.evaluate(() => JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null"));
    ck.check("拖中缩窗后松手：落点已按新边界补钳",
      !!afterDragResize && afterDragResize.x <= 700 - 52 - 6 + 1,
      JSON.stringify(afterDragResize));
    await page.setViewportSize({ width: 914, height: 411 });
    await page.waitForTimeout(300);

    // ── pointercancel 还原（审核轮 review-pointer 低-4）：清掉落位重载回默认
    //    锚，拖动半途被系统打断（pointercancel）——内联样式必须清空回 CSS 锚、
    //    assist-left 撤下、不落存储。 ──
    //    reload 同时清 ui.v2.workspace 与 ui.hostbar：此前连接时移动端自动收栏已把
    //    hostbar.open=false 写进工作区 blob（事实源，优先于 localStorage），不清的话
    //    reload 后主页主机栏是关的，主机卡压根不在 DOM，connectLocal 必超时。
    await page.evaluate(() => {
      localStorage.removeItem("ui.assistBallPos");
      localStorage.removeItem("ui.v2.workspace");
      localStorage.removeItem("ui.hostbar");
    });
    await page.reload();
    await page.waitForTimeout(900);
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await connectLocal(page);
    await page.waitForTimeout(400);
    const cancelProbe = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: 9, isPrimary: true,
        clientX: x, clientY: y,
      }));
      fire("pointerdown", cx, cy);
      fire("pointermove", cx - 120, cy + 30);
      fire("pointercancel", cx - 120, cy + 30);
      return {
        left: wrap.style.left, top: wrap.style.top,
        leftAligned: wrap.classList.contains("assist-left"),
        stored: localStorage.getItem("ui.assistBallPos"),
      };
    });
    ck.check("pointercancel 未落位球还原默认锚（清内联、撤左对齐、不落存储）",
      !!cancelProbe && cancelProbe.left === "" && cancelProbe.top === ""
        && !cancelProbe.leftAligned && cancelProbe.stored === null, JSON.stringify(cancelProbe));

    // 同一打断在「已有存储位」下的另一支（review-spec 覆盖缺口：旧断言只跑
    // pos=null）。先拖一次落位存进 localStorage，再拖到一半 pointercancel——
    // 必须还原到「某个存储位」（applyWrapPos），不是清回 CSS 默认锚（left 非空、
    // top 非空即排除 clearWrapPos）。实现上 pos 经 useCallback 闭包读取，连拖
    // 两段时第二段的 cancel 拿到的可能是上一渲染的旧 pos——「还原到存储位
    // 之一」是该窗口内的正确语义，不苛求等于最新 localStorage 值。
    const seeded = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b = ball.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const fire = (type, x, y, id) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: id, isPrimary: true,
        clientX: x, clientY: y,
      }));
      // 第一段：拖到 +50/+40 落位（持久化）
      fire("pointerdown", cx, cy, 12);
      fire("pointermove", cx + 50, cy + 40, 12);
      fire("pointerup", cx + 50, cy + 40, 12);
      const stored = JSON.parse(localStorage.getItem("ui.assistBallPos") ?? "null");
      if (!stored) return { fail: "no stored pos" };
      return { stored };
    });
    ck.check("第一段拖球已落位持久化（pointercancel pos≠null 前置）",
      !!seeded && !!seeded.stored, JSON.stringify(seeded));
    // 分两拍：第一段落位后必须等一次渲染，onMoveEnd 的 setState 才会把新 pos
    // 喂进 AssistBall——同一 evaluate 里连发第二段，cancel 拿到的 pos prop 还是
    // null（旧闭包），走的是 clearWrapPos 分支而不是我们要钉的还原分支。
    await page.waitForTimeout(150);
    const seeded2 = await page.evaluate(() => {
      const ball = document.querySelector('[data-testid="assist-ball"]');
      const wrap = document.querySelector('[data-testid="assist-ball-wrap"]');
      if (!ball || !wrap) return null;
      const b2 = ball.getBoundingClientRect();
      const c2x = b2.left + b2.width / 2, c2y = b2.top + b2.height / 2;
      const fire = (type, x, y, id) => ball.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerType: "touch", pointerId: id, isPrimary: true,
        clientX: x, clientY: y,
      }));
      // 第二段：从落点向上拖 -60/-60（避开右边界钳制原地不动的巧合），半途 cancel
      fire("pointerdown", c2x, c2y, 13);
      fire("pointermove", c2x - 60, c2y - 60, 13);
      const midL = wrap.offsetLeft, midT = wrap.offsetTop;
      fire("pointercancel", c2x - 60, c2y - 60, 13);
      return {
        midL, midT,
        afterL: wrap.offsetLeft, afterT: wrap.offsetTop,
        leftStyle: wrap.style.left, topStyle: wrap.style.top,
      };
    });
    ck.check("pointercancel 有存储位：还原到存储位不是回默认锚",
      !!seeded2 && !!seeded?.stored
        && seeded2.leftStyle !== "" && seeded2.topStyle !== ""     // 未清回 CSS 锚
        && Math.abs(seeded2.midL - seeded.stored.x) > 5            // 拖中确实离开过
        && Math.abs(seeded2.afterL - seeded.stored.x) <= 2        // 还原落点=存储位
        && Math.abs(seeded2.afterT - seeded.stored.y) <= 2,
      JSON.stringify({ stored: seeded?.stored, second: seeded2 }));

    // 尾段回到桌面形态再关开关：审核轮后「在桌面端显示助力球」仅桌面渲染
    //（移动端常显无需开关），android 标记下点不到。isMobilePlatform 每次渲染
    // 现读 dataset，删标记后开设置面板即按桌面渲染。
    await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.waitForTimeout(300);
    await page.click('[data-testid="rail-settings"]');
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelector('[data-testid="desktop-assist-ball"]')?.click());
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);
    ck.eq("关掉后彻底隐藏", await page.locator('[data-testid="assist-ball"]').count(), 0);
    ck.eq("关闭也持久化", await page.evaluate(() => localStorage.getItem("ui.assistBall")), "0");
  },
};
