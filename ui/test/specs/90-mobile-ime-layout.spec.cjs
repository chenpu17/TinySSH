// 90 移动端软键盘挤压（横屏必现）：Android 把 IME inset 折成 WebView 底部内边距后，
// 横屏只剩 ~160 CSS px——标题栏 + 标签行 + 工具栏 + 状态条加起来超过可用高度，flex 会把
// 终端压成 0 行（0.12.16 模拟器实测，用户截图同态）。矮视口下标题栏/页脚状态条让位给
// 终端，26px 状态栏兜底挪到 shell 上；正常横屏（411px 高）仍保留完整 chrome。
// 同组还钉住：移动端 DOM 层禁系统选词（长按终端时系统 Copy/Share/Select all/Read aloud
// 菜单会与我们的选区浮条同屏重叠），输入框仍可选中。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

const chromeState = (page) => page.evaluate(() => {
  const cs = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el) : null;
  };
  const title = cs(".titlebar");
  const status = cs(".statusbar");
  const toolbar = cs(".session-toolbar");
  const shell = cs(".app-shell");
  const screen = document.querySelector(".xterm-screen");
  const content = document.querySelector(".content");
  const ta = document.querySelector(".xterm-helper-textarea");
  return {
    titleDisplay: title?.display ?? null,
    statusDisplay: status?.display ?? null,
    toolbarDisplay: toolbar?.display ?? null,
    shellPaddingTop: shell?.paddingTop ?? null,
    shellUserSelect: shell?.webkitUserSelect ?? shell?.userSelect ?? null,
    taUserSelect: ta ? (getComputedStyle(ta).webkitUserSelect ?? getComputedStyle(ta).userSelect) : null,
    termH: screen ? screen.getBoundingClientRect().height : 0,
    contentH: content ? content.getBoundingClientRect().height : 0,
    docOverflow: document.documentElement.scrollHeight - window.innerHeight,
  };
});

module.exports = {
  title: "移动端矮视口（横屏+软键盘）：chrome 让位给终端、页面不滚动、系统选词被禁",
  async run({ page, ck }) {
    // 进入移动端世界（宽度 914 走桌面三栏，与手机横屏一致）
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await connectLocal(page);
    ck.check("连上本机会话（有 .statusbar 与终端）", await page.evaluate(() =>
      !!document.querySelector(".statusbar") && !!document.querySelector(".xterm-screen")));

    // ── 正常横屏（411px 高，模拟器实测）：完整 chrome 仍在 ──
    await page.setViewportSize({ width: 914, height: 411 });
    await page.waitForTimeout(300);
    const normal = await chromeState(page);
    ck.eq("正常横屏：标题栏保留", normal.titleDisplay, "flex");
    ck.eq("正常横屏：页脚状态条保留", normal.statusDisplay, "flex");
    ck.check("正常横屏：终端有可用行高", normal.termH > 100, JSON.stringify(normal.termH));

    // ── 专注模式藏标题栏后，26px 状态栏兜底必须挂到 shell（否则标签条钻到时钟底下） ──
    await page.click('[data-testid="focus-toggle"]');
    await page.waitForTimeout(300);
    const focused = await chromeState(page);
    ck.eq("专注态：标题栏让位", focused.titleDisplay, "none");
    ck.eq("专注态：状态栏兜底挂到 shell", focused.shellPaddingTop, "26px");
    // 移动端专注态标签条默认收起（#45/KI-075），专注图标随之不在屏上——出口走助力球面板。
    ck.eq("专注态：标签条让位给助力球", await page.locator(".tabbar-row").evaluate((el) => getComputedStyle(el).display), "none");
    await page.click('[data-testid="assist-ball"]');
    await page.click('[data-testid="assist-menu"] [role="menuitem"]:has-text("退出专注模式")');
    await page.waitForTimeout(300);
    const unfocused = await chromeState(page);
    ck.eq("退出专注：shell 兜底撤销（标题栏自带内边距）", unfocused.shellPaddingTop, "0px");
    ck.eq("退出专注：标题栏回来", unfocused.titleDisplay, "flex");

    // ── 软键盘挤压（横屏 + IME ≈ 300px 高）：标题栏/状态条让位，终端不再被压成 0 行 ──
    await page.setViewportSize({ width: 914, height: 300 });
    await page.waitForTimeout(300);
    const squeezed = await chromeState(page);
    ck.eq("挤压态：标题栏让位", squeezed.titleDisplay, "none");
    ck.eq("挤压态：页脚状态条让位", squeezed.statusDisplay, "none");
    ck.eq("挤压态：会话工具栏让位（容器过矮时终端不重算尺寸）", squeezed.toolbarDisplay, "none");
    ck.eq("挤压态：26px 状态栏兜底转移到 shell", squeezed.shellPaddingTop, "26px");
    ck.check("挤压态：终端仍有可键入的高度（不再为 0）", squeezed.termH > 60, JSON.stringify(squeezed.termH));
    ck.check("挤压态：终端已按容器重算（光标行不被裁到视口外）",
      squeezed.termH <= squeezed.contentH + 1 && squeezed.contentH - squeezed.termH <= 48,
      JSON.stringify({ termH: squeezed.termH, contentH: squeezed.contentH }));
    ck.check("挤压态：页面不滚动（标题栏不会被滚出视口）", squeezed.docOverflow <= 1, JSON.stringify(squeezed.docOverflow));

    // ── Gboard 横屏全高（模拟器实测 innerHeight≈150）：终端必须缩到容器内，光标行可见 ──
    await page.setViewportSize({ width: 914, height: 150 });
    await page.waitForTimeout(400);
    const ultra = await chromeState(page);
    ck.eq("Gboard 全高：会话工具栏同样让位", ultra.toolbarDisplay, "none");
    ck.check("Gboard 全高：终端缩到容器内（不再比容器高、光标行被裁掉）",
      ultra.termH <= ultra.contentH, JSON.stringify({ termH: ultra.termH, contentH: ultra.contentH }));
    ck.check("Gboard 全高：终端仍有可用行（至少 3 行）", ultra.termH >= 40, JSON.stringify(ultra.termH));

    // ── 移动端系统选词抑制：shell 继承 none，终端输入代理仍是 text ──
    ck.eq("移动端 shell 禁系统选词（长按不再弹系统菜单）", squeezed.shellUserSelect, "none");
    ck.eq("终端输入代理保留可选中（复制链不受影响）", squeezed.taUserSelect, "text");

    // ── 回桌面视口：chrome 全部回来（判据按平台+高度，桌面零影响） ──
    await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    const desktop = await chromeState(page);
    ck.eq("桌面：标题栏保留", desktop.titleDisplay, "flex");
    ck.eq("桌面：状态条保留", desktop.statusDisplay, "flex");
    ck.check("桌面：不继承移动端选词抑制", desktop.shellUserSelect !== "none", JSON.stringify(desktop.shellUserSelect));
  },
};
