// T44 视觉独立验证：转发行 Degraded（降级）状态展示。
// 前置：demo.ts 已临时注入（1 Listening + 3 Degraded：短 error / 60+ 字长 error / error=null），
//       该注入只为本脚本存在，验证后 demo.ts 还原（git diff ui/src/demo.ts 须为空）。
// 验项：
//  1. Degraded 行渲染 span.warn ⚠ + "降级："文案；error=null 走缺省文案；Listening 行不受影响
//  2. computed style：⚠ 的 color 解析值 == 该主题 --warn 实际值（非字面量断言，三套 chrome 各验一次）
//  3. 长文案布局：不横向溢出行容器、不换行撑高（ellipsis 截断链生效）、⚠ 不被挤出
//  4. 深色 / 浅色 / Solarized 浅色三套 chrome 截图，Degraded 行清晰可辨
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const SHOT_DIR = "../docs/acceptance/screenshots";

// "#d0b07a" | "rgb(208, 176, 122)" → "208,176,122"
const normColor = (c) => {
  const s = String(c).trim();
  const hex = s.match(/^#([0-9a-f]{6})$/i);
  if (hex) return hex[1].match(/../g).map((x) => parseInt(x, 16)).join(",");
  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) return rgb[1].split(",").slice(0, 3).map((x) => Math.round(parseFloat(x))).join(",");
  return s;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
  const fwdSec = () => page.locator('.section:has(h4:text("端口转发"))');

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 10000 });

  // 连本机（demo 注入随会话建立生效）
  await page.click('.host-card:has-text("本机") .host-card-main', { position: { x: 12, y: 12 } });
  await page.waitForSelector('.tab:has-text("本机")', { timeout: 10000 });
  await page.waitForSelector(".fwd-row", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll(".fwd-row").length === 4, null, { timeout: 10000 });

  // ── 1. 行渲染 ──
  const rows = await page.$$eval(".fwd-row", (els) => els.map((e) => ({
    text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
    title: e.getAttribute("title") ?? "",
  })));
  const degRows = rows.filter((r) => r.text.includes("降级："));
  // 注入的短 error 自带「…失败：…」字样——状态前缀才是分支判据（error 透传任意文案）
  const subTexts = await page.$$eval(".fwd-row .xfer-sub", (els) => els.map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim()));
  check("row-count-4", rows.length === 4, `rows=${rows.length}`);
  check("degraded-rows-3", degRows.length === 3, `deg=${degRows.length}`);
  check("listening-row-unaffected", rows.some((r) => r.text.includes("监听中")) && rows.some((r) => r.text.includes("✓")) && !subTexts.some((t) => t.startsWith("失败：")));

  const icons = await page.$$eval(".fwd-row span.warn", (els) => els.map((e) => ({
    glyph: (e.textContent ?? "").trim(),
    row: (e.closest(".fwd-row").textContent ?? "").replace(/\s+/g, " ").slice(0, 30),
  })));
  check("warn-icon-glyph", icons.length === 3 && icons.every((i) => i.glyph === "⚠"), `n=${icons.length} glyphs=${JSON.stringify(icons.map((i) => i.glyph))}`);
  const errIcons = await page.$$eval(".fwd-row span.err", (els) => els.length);
  check("no-err-icon-on-degraded", errIcons === 0, `errIcons=${errIcons}（Degraded 不得落 ✕ 分支）`);

  check("custom-error-shown", rows.some((r) => r.text.includes("降级：通道建立失败：目标 10.0.0.6:8080 拒绝连接")));
  check("long-error-shown", rows.some((r) => r.text.includes("降级：远端 10.0.0.9:443 连接超时（15 秒无响应）")));
  check("null-error-fallback-text", rows.some((r) => r.text.includes("降级：隧道暂不可用（重连/目标恢复后自动恢复）")));
  // T44 视觉审低危修复锁：Degraded 行 title 与可见文案同源（状态槽"· 降级："，不得误报"· 失败："；
  // 种子错误文案自身可含「失败：」字样，故判据用分隔符定位状态槽而非裸子串）
  check("degraded-title-in-sync", degRows.every((r) => r.title.includes("· 降级：") && !r.title.includes("· 失败：")), JSON.stringify(degRows.map((r) => r.title.slice(-18))));

  // ── 2. computed color：⚠ color == 当前 chrome 的 --warn 实际值 ──
  const probeColor = () => page.evaluate(() => {
    const icon = document.querySelector(".fwd-row span.warn");
    const rootWarn = getComputedStyle(document.documentElement).getPropertyValue("--warn");
    return {
      chrome: document.documentElement.dataset.chrome ?? "(unset)",
      iconColor: getComputedStyle(icon).color,
      rootWarn: rootWarn.trim(),
      subColor: getComputedStyle(icon.closest(".fwd-row").querySelector(".xfer-sub")).color,
    };
  });
  const cDark = await probeColor();
  check("warn-color-dark", normColor(cDark.iconColor) === normColor(cDark.rootWarn),
    `chrome=${cDark.chrome} icon=${cDark.iconColor} vs --warn=${cDark.rootWarn}`);
  results.push(`INFO sub-text-color（降级文案走 dim，非 warn）: ${cDark.subColor}`);

  // ── 3. 布局：长文案不溢出 / 不换行撑高 / ⚠ 不被挤出 ──
  const layout = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".fwd-row")];
    return rows.map((r) => {
      const sub = r.querySelector(".xfer-sub");
      const icon = r.querySelector("span.ok, span.warn, span.err");
      const rr = r.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      const ir = icon.getBoundingClientRect();
      const cs = getComputedStyle(sub);
      return {
        label: (r.querySelector(".xfer-name").textContent ?? "").slice(0, 26),
        deg: (r.textContent ?? "").includes("降级"),
        rowH: rr.height,
        subSingleLineH: sr.height,
        subRightInRow: sr.right <= rr.right + 0.5,
        subClipped: sub.scrollWidth > sub.clientWidth,
        ellipsisChain: cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap" && cs.overflow === "hidden",
        iconBox: { w: ir.width, h: ir.height },
        iconInRow: ir.right <= rr.right + 0.5 && ir.left >= rr.left - 0.5,
      };
    });
  });
  const heights = layout.map((l) => l.rowH);
  check("row-heights-uniform", Math.max(...heights) - Math.min(...heights) < 2,
    `heights=${heights.map((h) => h.toFixed(1)).join("/")}（换行会撑高 Degraded 行）`);
  check("sub-single-line", layout.every((l) => l.subSingleLineH < 20),
    `subH=${layout.map((l) => l.subSingleLineH.toFixed(1)).join("/")}`);
  check("sub-no-visual-overflow", layout.every((l) => l.subRightInRow), "文案右缘均未越出 .fwd-row");
  const longRow = layout.find((l) => l.label.includes("11080"));
  check("long-text-ellipsis-truncated", !!longRow && longRow.subClipped && longRow.ellipsisChain,
    `长文案行截断=${longRow?.subClipped} ellipsis链=${longRow?.ellipsisChain}`);
  check("warn-icon-visible-in-row", layout.filter((l) => l.deg).every((l) => l.iconBox.w > 0 && l.iconBox.h > 0 && l.iconInRow),
    `icon=${JSON.stringify(layout.filter((l) => l.deg).map((l) => [l.iconBox.w.toFixed(0), l.iconBox.h.toFixed(0), l.iconInRow]))}`);

  // 采集（非断言）：Degraded 行 hover title 完整串（T44 修复后与行内同源，展示"· 降级："）
  results.push(`INFO degraded-row-title: ${JSON.stringify(degRows.map((r) => r.title.slice(0, 44)))}`);

  // ── 4. 三套 chrome 截图 + 各自 color 复验 ──
  const switchTheme = async (label) => {
    await page.click('button[aria-label="显示设置"]');
    await page.waitForSelector(".ts-themes .ts-opt", { timeout: 5000 });
    await page.click(`.ts-opt:text-is("${label}")`);
    await page.waitForTimeout(150); // chrome 切换即 CSS 变量层，瞬时；稍候渲染稳定
    await page.click('button[aria-label="关闭显示设置"]');
  };

  await fwdSec().screenshot({ path: `${SHOT_DIR}/t44_degraded_dark.png` });

  await switchTheme("浅色");
  const cLight = await probeColor();
  check("warn-color-light", normColor(cLight.iconColor) === normColor(cLight.rootWarn),
    `chrome=${cLight.chrome} icon=${cLight.iconColor} vs --warn=${cLight.rootWarn}`);
  await fwdSec().screenshot({ path: `${SHOT_DIR}/t44_degraded_light.png` });

  await switchTheme("Solarized 浅色");
  const cSolar = await probeColor();
  check("warn-color-solar-light", normColor(cSolar.iconColor) === normColor(cSolar.rootWarn),
    `chrome=${cSolar.chrome} icon=${cSolar.iconColor} vs --warn=${cSolar.rootWarn}`);
  await page.screenshot({ path: `${SHOT_DIR}/t44_degraded_solar_light.png` });

  // 右栏转発区特写（solar-light 下，元素级裁剪）
  await fwdSec().screenshot({ path: `${SHOT_DIR}/t44_degraded_solar_light.png` });

  // 还原现场：切回深色（默认）
  await switchTheme("深色（默认）");
  const cBack = await probeColor();
  check("theme-restore-dark", cBack.chrome === "dark" && normColor(cBack.iconColor) === normColor(cBack.rootWarn), `chrome=${cBack.chrome}`);

  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} PASS / ${fails} FAIL`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("VERIFY ERROR:", e.message); process.exit(1); });
