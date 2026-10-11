// UX 五轮字体探针：验证内置 Inter / MiSans VF / JetBrains Mono 在页面里真实加载。
// MiSans 是 uni-range 分片、按需加载——必须带中文字符探 document.fonts.check，并以
// canvas 测宽对照：MiSans 生效则「中文」宽度 ≠ 微软雅黑 / 系统 fallback 栈宽。
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://localhost:5183";

(async () => {
  const { path: executablePath, source } = resolveBrowser();
  console.log(`browser: ${source} ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    // fonts.check 不触发懒加载——终端字族只在会话渲染时被使用，先显式 load 再断言
    const jbmTerm = await document.fonts.load('13px "JetBrains Mono Term"', "─│┌┘→")
      .then((faces) => faces.length > 0)
      .catch(() => false);
    const jbmTermBold = await document.fonts.load('bold 13px "JetBrains Mono Term"', "─│┌┘")
      .then((faces) => faces.length > 0)
      .catch(() => false);
    const c = document.createElement("canvas").getContext("2d");
    const w = (font) => { c.font = font; return Math.round(c.measureText("中文界面 TinySSH").width * 100) / 100; };
    return {
      inter: document.fonts.check('13px "Inter"'),
      misans: document.fonts.check('13px "MiSans VF"', "中文"),
      misansLoaded: [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "MiSans VF" && f.status === "loaded").length,
      jbm: document.fonts.check('13px "JetBrains Mono"'),
      jbmTerm,
      jbmTermBold,
      wMisans: w('20px "MiSans VF"'),
      wYahei: w('20px "Microsoft YaHei"'),
      wSans: w('20px sans-serif'),
      bodyStack: getComputedStyle(document.body).fontFamily,
    };
  });
  const fontOk = r.inter && r.misans && r.jbm && r.jbmTerm && r.jbmTermBold;
  const widthOk = r.wMisans !== r.wYahei && r.wMisans !== r.wSans;
  console.log(JSON.stringify(r, null, 2));
  console.log(`fonts ${fontOk ? "OK" : "FAIL"} · MiSans 宽度 ${widthOk ? "≠ 系统栈（生效：" + r.wMisans + " vs 雅黑 " + r.wYahei + " / sans " + r.wSans + "）" : "== 系统栈（未生效！）"}`);
  console.log("pageErrors:", pageErrors.length ? pageErrors : "none");
  await browser.close();
  process.exit(fontOk && widthOk && pageErrors.length === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
