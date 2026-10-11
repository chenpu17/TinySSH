// 悬停特异度修复的数据级验证：逐个真实 hover（CDP 驱动），断言计算背景色 ≠ --accent-hover。
// 覆盖：collab-badge / hb-settings / tab-x / tab-split / tab-scroll / tools-menu 项 / sftp-crumb / hb-tag
const { freshContext, openDemo } = require("./harness.cjs");

(async () => {
  const ctx = await freshContext();
  const { page } = ctx;
  await openDemo(page);
  await page.evaluate(() => { document.documentElement.dataset.chrome = "dark"; });
  await page.click('.tab .tab-label:text-is("prod-1")').catch(() => {});
  await page.waitForTimeout(600);

  // --accent-hover 的解析色（经临时探针元素取计算值）
  const accentHover = await page.evaluate(() => {
    const p = document.createElement("div");
    p.style.backgroundColor = "var(--accent-hover)";
    document.body.appendChild(p);
    const v = getComputedStyle(p).backgroundColor;
    p.remove();
    return v;
  });
  console.log(`--accent-hover 解析为 ${accentHover}`);

  const results = [];
  const probe = async (name, selector) => {
    const el = await page.$(selector);
    if (!el || !(await el.isVisible())) { results.push([name, "SKIP 不可见", ""]); return; }
    await el.hover();
    await page.waitForTimeout(80);
    const bg = await page.evaluate((sel) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n).backgroundColor : null;
    }, selector);
    const bad = bg === accentHover;
    results.push([name, bad ? "FAIL 仍落 accent-hover" : "ok", bg ?? ""]);
    await page.mouse.move(4, 4); // 移走，避免 hover 串到下一条
    await page.waitForTimeout(60);
  };

  await probe("collab-badge", ".collab-badge");
  await probe("hb-settings", ".hb-settings");
  await probe("tab-x（首个标签关闭钮）", ".tab .tab-x");
  await probe("tab-split（首个标签分屏钮）", ".tab .tab-split");
  await probe("tab-scroll", ".tab-scroll");

  // 工具菜单第一项
  await page.click(".st-tools > button").catch(() => {});
  await page.waitForTimeout(300);
  await probe("tools-menu 首项", ".tools-menu button");
  await page.keyboard.press("Escape").catch(() => {});

  // SFTP 面包屑
  await page.click('.session-toolbar button[title^="文件"]').catch(() => {});
  await page.waitForTimeout(700);
  await probe("sftp-crumb", ".sftp-crumb");
  await page.click('.session-toolbar button[title^="文件"]').catch(() => {}); // 收起

  await probe("hb-tag", ".hb-tag");

  let fails = 0;
  for (const [name, st, bg] of results) {
    if (st.startsWith("FAIL")) fails++;
    console.log(`${st.startsWith("FAIL") ? " FAIL " : st.startsWith("SKIP") ? " skip " : "  ok  "} ${name}${bg ? `  — ${bg}` : ""}${st.startsWith("FAIL") || st.startsWith("SKIP") ? `（${st}）` : ""}`);
  }
  console.log(fails === 0 ? "HOVER PROBE: all pass" : `HOVER PROBE: ${fails} FAIL`);
  await ctx.browser.close();
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
