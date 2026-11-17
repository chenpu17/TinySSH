// 93 移动端紧凑标签切换（GitHub #45）：手机上不再铺一整行标签按钮，收成一颗
// 「当前会话 + 数量」下拉，点开列出全部会话（切换 / 重连 / 关闭）。标签不是消失，
// 而是换形态：长按/右键仍能出原会话菜单（重命名/分屏/关闭），重命名输入框就地
// 渲染在切换器的位置。桌面（无 data-platform）标签条与「标签列表」原样。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

const openMenu = async (page) => {
  await page.click('[data-testid="m-tabswitch"]');
  await page.waitForSelector('[data-testid="m-tabs-menu"]');
};

module.exports = {
  title: "移动端紧凑标签切换器：下拉切换/关闭会话、长按菜单与就地重命名",
  async run({ page, ck }) {
    // ── 桌面（未标记移动平台）：标签按钮行与「标签列表」入口原样 ──
    await connectLocal(page);
    ck.check("桌面：标签按钮行可见",
      await page.locator(".tabbar").evaluate((el) => getComputedStyle(el).display) !== "none");
    ck.eq("桌面：不渲染移动切换器", await page.locator('[data-testid="m-tabswitch"]').count(), 0);

    // ── 进入移动端世界（行为/样式裁剪读 data-platform；手动改 dataset 不触发
    //    React 重渲染——开合一次主机栏把 isMobilePlatform() 重新求值。宽度保持
    //    桌面档，避免移动单列下主机栏全屏覆盖挡住待点击控件） ──
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    const tbDisplay = await page.locator(".tabbar-row > .tabbar").evaluate((el) => getComputedStyle(el).display);
    ck.eq("移动端：标签按钮行让位", tbDisplay, "none");
    ck.eq("移动端：切换器出现", await page.locator('[data-testid="m-tabswitch"]').count(), 1);
    const label0 = (await page.locator('[data-testid="m-tabswitch"] .tab-label').innerText()).trim();
    ck.check("切换器显示当前会话名", label0.length > 0, label0);
    ck.eq("桌面「标签列表」入口在移动端让位（与切换器重复）",
      await page.locator(".tabbar-row > .st-tools.tabbar-admin").evaluate((el) => getComputedStyle(el).display), "none");
    // 尾部常用入口仍在：新建连接与快速连接（tabbar-admin 类但不在 .st-tools 里）
    ck.check("移动端尾部常用入口保留（新建连接/快速连接）",
      await page.locator('.tabbar-row > button[title^="新建连接"]').count() === 1 &&
      await page.locator('[data-testid="quick-connect-open"]').count() === 1);

    // ── 标题栏压到系统状态栏高度（#45「标题窗口太占空间」）：竖屏窄档里版本/自监控/
    //    更新/协作徽标本已隐藏，只剩品牌名——品牌让位，行高 53 → 34 ──
    await page.setViewportSize({ width: 411, height: 914 });
    await page.waitForTimeout(300);
    const tb = await page.evaluate(() => ({
      h: Math.round(document.querySelector(".titlebar").getBoundingClientRect().height),
      brand: getComputedStyle(document.querySelector(".app-title")).display,
    }));
    ck.between("手机竖屏标题栏压到状态栏高度", tb.h, 30, 38);
    ck.eq("移动端品牌名让位（信息让给终端）", tb.brand, "none");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    // ── 自动横屏开关（#45「哪怕用户没开旋转也应该支持」）：移动端设置里出现，
    //    桌面不出现；缺省开，关掉写 ui.autoRotate=0（demo 域命令 no-op） ──
    await page.click(".hb-settings");
    await page.waitForTimeout(500);
    ck.eq("移动端设置含自动横屏开关", await page.locator('[data-testid="mobile-auto-rotate"]').count(), 1);
    ck.check("自动横屏缺省开", await page.locator('[data-testid="mobile-auto-rotate"]').isChecked());
    await page.click('[data-testid="mobile-auto-rotate"]');
    await page.waitForTimeout(150);
    ck.eq("关掉自动横屏写入偏好", await page.evaluate(() => localStorage.getItem("ui.autoRotate")), "0");
    await page.click('[data-testid="mobile-auto-rotate"]');
    await page.waitForTimeout(150);
    ck.eq("重新打开自动横屏写回偏好", await page.evaluate(() => localStorage.getItem("ui.autoRotate")), "1");
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);

    // ── 下拉：列出会话，当前行高亮（demo 预置会话数不固定，按实际行数断言） ──
    await openMenu(page);
    const rows0 = await page.locator('[data-testid="m-tabs-menu"] .tm-row').count();
    ck.check("下拉列出全部会话", rows0 >= 1, String(rows0));
    ck.eq("每行都有「关闭」动作",
      await page.locator('[data-testid="m-tabs-menu"] .tm-close').count(), rows0);
    ck.check("当前会话行高亮", await page.locator('[data-testid="m-tabs-menu"] .tm-row.tm-active').count() === 1);
    await page.click('[data-testid="m-tabs-menu"] .tm-active .tm-main');
    await page.waitForTimeout(300);
    ck.eq("选中即收起菜单", await page.locator('[data-testid="m-tabs-menu"]').count(), 0);

    // ── 长按/右键出原会话菜单 → 复制标签页（同主机新会话） ──
    await page.click('[data-testid="m-tabswitch"]', { button: "right" });
    await page.waitForSelector(".ctx-menu");
    ck.check("右键切换器出会话菜单（重命名/分屏/关闭仍在）",
      await page.locator('.ctx-menu button:has-text("重命名标签")').count() === 1 &&
      await page.locator('.ctx-menu button:has-text("关闭会话")').count() === 1);
    await page.click('.ctx-menu button:has-text("复制标签页")');
    await page.waitForTimeout(1200);
    await openMenu(page);
    ck.eq("复制标签页后多出一条会话",
      await page.locator('[data-testid="m-tabs-menu"] .tm-row').count(), rows0 + 1);
    const countBadge = await page.locator('[data-testid="m-tabswitch"] .tab-count').innerText().catch(() => "");
    ck.eq("切换器角标显示会话数", countBadge.trim(), String(rows0 + 1));

    // ── 切换到另一个已连接会话 ──
    const activeSid = await page.locator('[data-testid="m-tabs-menu"] .tm-row.tm-active').getAttribute("data-sid");
    // 优先选「非活动且已连接」的行（断开的行只有「重连」动作）；全都断开时退回第一行
    const otherSid = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="m-tabs-menu"] .tm-row:not(.tm-active)')];
      const connected = rows.find((el) => ![...el.querySelectorAll(".tm-act")]
        .some((b) => b.textContent.includes("重连")));
      return (connected ?? rows[0])?.getAttribute("data-sid") ?? null;
    });
    ck.check("两条会话 id 不同", !!activeSid && !!otherSid && activeSid !== otherSid, `${activeSid} / ${otherSid}`);
    await page.click(`[data-testid="m-tabs-menu"] .tm-row[data-sid="${otherSid}"] .tm-main`);
    await page.waitForTimeout(800);
    await openMenu(page);
    ck.eq("切换后高亮行随之改变",
      await page.locator('[data-testid="m-tabs-menu"] .tm-row.tm-active').getAttribute("data-sid"), otherSid);

    // ── 关闭刚切走的原活动会话（已连接，走确认契约）：行数回落 ──
    await page.click(`[data-testid="m-tabs-menu"] .tm-row[data-sid="${activeSid}"] .tm-close`);
    // 关闭沿用既有确认契约（与标签 ✕ 同语义），不是一键直杀
    await page.waitForSelector(".confirm-dialog");
    ck.check("关闭前列出确认框", true);
    await page.evaluate(() => [...document.querySelectorAll(".confirm-dialog button")]
      .find((b) => b.textContent.trim() === "关闭会话")?.click());
    await page.waitForTimeout(900);
    await openMenu(page);
    ck.eq("关闭后下拉少一条会话",
      await page.locator('[data-testid="m-tabs-menu"] .tm-row').count(), rows0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ── 就地重命名：输入框渲染在切换器位置，Enter 提交后标签更新 ──
    await page.click('[data-testid="m-tabswitch"]', { button: "right" });
    await page.click('.ctx-menu button:has-text("重命名标签")');
    await page.waitForSelector('[data-testid="m-tabswitch-wrap"] input');
    await page.fill('[data-testid="m-tabswitch-wrap"] input', "我的会话");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ck.eq("重命名后切换器标签更新",
      (await page.locator('[data-testid="m-tabswitch"] .tab-label').innerText()).trim(), "我的会话");

    // ── 回桌面：切换器卸载，标签条与「标签列表」回来 ──
    await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    ck.eq("桌面：切换器卸载", await page.locator('[data-testid="m-tabswitch"]').count(), 0);
    ck.check("桌面：标签按钮行回来",
      await page.locator(".tabbar").evaluate((el) => getComputedStyle(el).display) !== "none");
    ck.check("桌面：标签列表入口回来",
      await page.locator(".tabbar-row > .st-tools.tabbar-admin").evaluate((el) => getComputedStyle(el).display) !== "none");
  },
};
