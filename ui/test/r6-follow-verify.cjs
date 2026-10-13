// 二十二轮主题统一验证（原 UX 六轮联动脚本，双轨退役后改义）：终端配色**恒**由
// 色板×深浅派生——切色板/翻深浅，断言终端 theme（底/前景/光标）派生自当下 chrome
// tokens 且 ANSI 沿用基础预设；无开关、无独立终端预设清单；截图目验。
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const OUT = process.env.SHOT_DIR || "D:/workspace/tiny-ssh/.ux-shots/r6";
require("fs").mkdirSync(OUT, { recursive: true });

const termProbe = (page) => page.evaluate(() => {
  const active = document.querySelector(".term-session.active");
  const sid = active?.dataset.sid;
  const map = window.__t_terms;
  // map 的 value 就是 term 本身（audit-shots 同款用法），不是 {term, el} 包装
  const term = (sid && map?.get(sid)) || (map && map.size === 1 ? [...map.values()][0] : undefined);
  const scratch = document.createElement("span");
  scratch.style.color = "var(--bg)";
  document.body.appendChild(scratch);
  const bgNow = getComputedStyle(scratch).color;
  scratch.remove();
  return {
    mapSize: map?.size, sid, termFound: !!term,
    bg: term?.options?.theme?.background,
    cursor: term?.options?.theme?.cursor,
    ansiKept: term?.options?.theme?.blue,
    sessionBg: active?.style.background,
    chromeBgResolved: bgNow,
    chrome: document.documentElement.dataset.chrome,
    theme: document.documentElement.dataset.theme,
  };
});

(async () => {
  const { path: executablePath, source } = resolveBrowser();
  console.log(`browser: ${source} ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  await page.goto("http://localhost:5183/?fresh", { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 10000 });

  // 连接「本机」（与 audit-shots 同款 hover+连接）
  const c = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1500);

  // 切 ember 色板（点真按钮走 changePalette 派生路径）——无开关，恒派生
  await page.click(".hb-settings");
  await page.waitForTimeout(400);
  await page.click('[data-testid="chrome-palette-ember"]');
  await page.waitForTimeout(500);
  const t1 = await termProbe(page);
  const bgMatches = t1.bg === t1.chromeBgResolved || t1.bg?.replace(/ /g, "") === t1.chromeBgResolved?.replace(/ /g, "");
  console.log("ember 派生:", JSON.stringify(t1, null, 2));
  console.log(`终端底色随板: ${bgMatches ? "PASS" : "FAIL"}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await shot("unified-ember-dark");

  // 翻深色 → 浅色各一次：终端应随外观翻转派生（深/浅基础预设 + 对应板色）
  await page.click(".hb-settings");
  await page.waitForTimeout(400);
  const flip = async (label) => {
    for (const b of await page.$$(".ts-appearance button")) {
      if ((await b.textContent()) === label) await b.click();
    }
    await page.waitForTimeout(500);
    return termProbe(page);
  };
  const tDark = await flip("深色");
  console.log("翻深色:", JSON.stringify(tDark));
  await shot("unified-ember-dark");
  const tLight = await flip("浅色");
  console.log("翻浅色:", JSON.stringify(tLight));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await shot("unified-ember-light");

  // 双轨退役面：设置里不再有独立终端预设清单与联动开关
  await page.click(".hb-settings");
  await page.waitForTimeout(400);
  const legacy = await page.evaluate(() => ({
    solarized: document.querySelector(".settings-pane").innerText.includes("Solarized"),
    followToggle: !!document.querySelector('[data-testid="theme-follow"]'),
    followKv: localStorage.getItem("ui.theme.follow"),
  }));
  console.log("双轨退役:", JSON.stringify(legacy),
    !legacy.solarized && !legacy.followToggle ? "PASS" : "FAIL");
  await page.keyboard.press("Escape");

  console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
