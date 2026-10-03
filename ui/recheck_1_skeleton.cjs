// 独立复验 §2：首载 skeleton 实证（此前从未捕到帧的验证缺口）
// 方法：demo shim 的 list_hosts 是内存 Promise（无网络请求可延迟），故对 vite 编译产物
// /src/demo.ts 做 serve 期路由改写——在 case "list_hosts" 前注入 1100ms 延迟（等价于
// 真实后端 Tauri IPC 往返 + 磁盘读的耗时窗），磁盘上的产品代码零改动。
// 另设一组「仅 CPU ×6 节流、不注入延迟」的对照组：考察无人工延迟时骨架帧是否天然存在。
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const out = [];
  const check = (name, ok, detail = "") => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

  // ── A. 注入 1100ms 延迟：连续截图捕骨架帧 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/src/demo.ts", async (route) => {
      const resp = await route.fetch();
      let body = await resp.text();
      if (!body.includes('case "list_hosts":')) {
        await route.fulfill({ response: resp });
        return;
      }
      body = body.replace('case "list_hosts":', 'case "list_hosts": await new Promise((r) => setTimeout(r, 1100));');
      await route.fulfill({ response: resp, body });
    });
    const t0 = Date.now();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    const frames = [];
    let shotIdx = 0;
    while (Date.now() - t0 < 5000) {
      const n = await page.evaluate(() => document.querySelectorAll(".skeleton").length).catch(() => -1);
      const hostCards = await page.evaluate(() => document.querySelectorAll(".host-card").length).catch(() => -1);
      frames.push({ t: Date.now() - t0, sk: n, cards: hostCards });
      if (n > 0 && shotIdx < 3) {
        await page.screenshot({ path: `/tmp/recheck_skeleton_${shotIdx}.png` });
        shotIdx++;
      }
      if (n === 0 && hostCards > 0 && frames.length > 3) break; // 已加载完
      await page.waitForTimeout(120);
    }
    console.log("A frames:", JSON.stringify(frames));
    const withSk = frames.filter((f) => f.sk > 0);
    check("A1-skeleton-frame-captured", withSk.length >= 2, `${withSk.length} 帧 skeleton 在场（t=${withSk.map((f) => f.t).join(",")}ms）`);
    const firstGone = frames.find((f) => f.sk === 0 && f.cards > 0);
    check("A2-skeleton-cleared", !!firstGone, firstGone ? `t=${firstGone.t}ms 起为 0 且主机卡 ${firstGone.cards} 张` : "从未清场");
    // 无残留：加载完 1s 后仍为 0
    await page.waitForTimeout(1000);
    const residual = await page.evaluate(() => document.querySelectorAll(".skeleton").length);
    check("A3-no-residual", residual === 0, `1s 后残留 ${residual}`);
    // 动效：正常态 shimmer 在跑
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(400);
    const animNormal = await page.evaluate(() => {
      // reload 后可能已加载完——改注入再取一次？这里若已无 skeleton 记 none
      const el = document.querySelector(".skeleton");
      return el ? getComputedStyle(el).animationName + "/" + getComputedStyle(el).animationDuration : "(no-skeleton-anymore)";
    });
    await page.close();
    console.log("A animNormal(normal-media):", animNormal);
  }

  // ── B. 注入延迟 + prefers-reduced-motion：shimmer 应禁用 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/src/demo.ts", async (route) => {
      const resp = await route.fetch();
      let body = await resp.text();
      body = body.replace('case "list_hosts":', 'case "list_hosts": await new Promise((r) => setTimeout(r, 1100));');
      await route.fulfill({ response: resp, body });
    });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".skeleton", { timeout: 5000 });
    const st = await page.evaluate(() => {
      const el = document.querySelector(".skeleton");
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration, iter: cs.animationIterationCount };
    });
    check("B1-reduced-motion-disables-shimmer", st.name === "none", `animation=${st.name}/${st.dur}/${st.iter}`);
    await page.screenshot({ path: "/tmp/recheck_skeleton_reduced.png" });
    await page.close();
  }

  // ── C. 对照组：仅 CPU ×6 节流，不注入延迟——骨架帧是否天然可捕 ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    const t0 = Date.now();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    const frames = [];
    while (Date.now() - t0 < 6000) {
      const n = await page.evaluate(() => document.querySelectorAll(".skeleton").length).catch(() => -1);
      frames.push({ t: Date.now() - t0, sk: n });
      if (frames.length > 3 && n === 0) break;
      await page.waitForTimeout(80);
    }
    const withSk = frames.filter((f) => f.sk > 0);
    console.log("C cpu6-only frames:", JSON.stringify(frames.slice(0, 12)));
    console.log("C verdict: cpu-throttle-only 捕到骨架帧", withSk.length, "帧（信息性，不作 PASS/FAIL）");
    await page.close();
  }

  console.log(out.join("\n"));
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
