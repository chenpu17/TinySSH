// 独立复验补充：.dim 辅助文字（随会话存亡提示/时间戳）两主题对比度——
// AI 图像分析提到浅色下它们最淡，给定量结论（信息性，dim 属辅助装饰，AA 线不强制）
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";
const utilSrc = `
  (() => {
  const parseC = (s) => { const m = s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/); return m ? [+m[1],+m[2],+m[3],m[4]==null?1:+m[4]] : null; };
  const blend = (t,b) => [t[0]*t[3]+b[0]*(1-t[3]),t[1]*t[3]+b[1]*(1-t[3]),t[2]*t[3]+b[2]*(1-t[3]),1];
  const effBg = (el) => { const chain=[]; let n=el; while(n && n!==document.documentElement){const c=parseC(getComputedStyle(n).backgroundColor); if(c&&c[3]>0)chain.push(c); n=n.parentElement;} const root=parseC(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())||[255,255,255,1]; let a=root; for(let i=chain.length-1;i>=0;i--)a=blend(chain[i],a); return a; };
  const lum = (c) => { const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
  const ratio = (a,b)=>{const x=lum(a),y=lum(b);const[h,l]=x>y?[x,y]:[y,x];return (h+0.05)/(l+0.05);};
  window.__cr = (el) => { const fg=parseC(getComputedStyle(el).color), bg=effBg(el); return +ratio(fg,bg).toFixed(2); };
  })();
`;
(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("ui.theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.click('.tab:has-text("prod-1")');
    await page.waitForSelector(".goal-input");
    await page.evaluate(utilSrc);
    const r = await page.evaluate(() => {
      const goalHint = document.querySelector('.section .dim, .section small, .goal-input ~ *, .section p');
      // 稳妥取法：任务目标 section 内的 .dim 提示 + 时间线首条时间戳
      const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent.includes("任务目标"));
      const dimEl = sec ? sec.querySelector(".side-quiet") : null;
      const tlTime = document.querySelector(".tl-time, .tl-row time, .tl-row .dim");
      const dimVar = getComputedStyle(document.documentElement).getPropertyValue("--dim").trim();
      return {
        dimText: dimEl ? dimEl.textContent.trim().slice(0, 30) : "(未找到)",
        dimRatio: dimEl ? window.__cr(dimEl) : null,
        dimVar,
        tlTimeText: tlTime ? tlTime.textContent.trim() : "(未找到)",
        tlTimeRatio: tlTime ? window.__cr(tlTime) : null,
      };
    });
    console.log(theme, JSON.stringify(r));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
