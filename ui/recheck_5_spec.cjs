// 独立复验 §6：规格抽查（docs/ui-redesign-spec.md §五/§六）
//  1) 主机卡 hover 才现操作组 + pointer-events 防幽灵点击 + 几何中心不被拦截
//  2) 控制权徽标 amber（Agent）/ accent（Human）语义
//  3) 连接按钮 loading 态「连接中…」≤400ms 有响应
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const BASE = "http://localhost:5183";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const out = [];
  const check = (name, ok, detail = "") => out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card");

  // ── 1) 主机卡：hover 操作组与幽灵点击防护 ──
  const geo = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.textContent.includes("prod-1"));
    const side = card.querySelector(".host-card-side");
    const main = card.querySelector(".host-card-main");
    const cr = card.getBoundingClientRect(), sr = side.getBoundingClientRect(), mr = main.getBoundingClientRect();
    const cs = getComputedStyle(side);
    const sideCenter = { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 };
    const cardCenter = { x: cr.x + cr.width / 2, y: cr.y + cr.height / 2 };
    return {
      card: { w: +cr.width.toFixed(1), h: +cr.height.toFixed(1) },
      side: { w: +sr.width.toFixed(1), x: +sr.x.toFixed(1) },
      idle: { opacity: cs.opacity, pe: cs.pointerEvents },
      hitSideIdle: (() => { const e = document.elementFromPoint(sideCenter.x, sideCenter.y); return e ? e.tagName + "." + (e.className || "").toString().split(" ")[0] : "none"; })(),
      centerInsideMain: cardCenter.x >= mr.x && cardCenter.x <= mr.x + mr.width && cardCenter.y >= mr.y && cardCenter.y <= mr.y + mr.height,
    };
  });
  check("side-idle-hidden", geo.idle.opacity === "0" && geo.idle.pe === "none", `opacity=${geo.idle.opacity} pointer-events=${geo.idle.pe}`);
  check("side-idle-no-ghost-hit", !/host-card-side|button/i.test(geo.hitSideIdle) || geo.hitSideIdle.includes("host-card-main"),
    `未 hover 时操作组坐标命中=${geo.hitSideIdle}（应为 main 区而非按钮）`);
  check("card-center-in-main", geo.centerInsideMain, `卡片中心 (${geo.card.w / 2 | 0}px 处) 落在 main 区`);
  await page.hover('.host-card:has-text("prod-1")');
  await page.waitForTimeout(250);
  const hovered = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.textContent.includes("prod-1"));
    const side = card.querySelector(".host-card-side");
    const cs = getComputedStyle(side);
    const sr = side.getBoundingClientRect();
    const e = document.elementFromPoint(sr.x + sr.width / 2, sr.y + sr.height / 2);
    const btn = e && e.closest ? e.closest("button") : null;
    return { opacity: cs.opacity, pe: cs.pointerEvents, hit: btn ? "button." + btn.className.toString().split(" ")[0] : (e ? e.tagName + "." + (e.getAttribute("class") || "") : "none") };
  });
  check("side-hover-visible", hovered.opacity === "1" && hovered.pe === "auto", `hover 后 opacity=${hovered.opacity} pointer-events=${hovered.pe} 命中=${hovered.hit}`);
  out.push(`INFO 卡宽 ${geo.card.w}px，操作组宽 ${geo.side.w}px 右缘贴 ${geo.side.x}px（规格：不占布局宽、覆盖右侧）`);

  // ── 2) 控制权徽标 amber/accent 语义 ──
  await page.click('.tab:has-text("prod-1")');
  await page.waitForSelector(".ctl-badge");
  const badgeA = await page.evaluate(() => {
    const b = document.querySelector(".ctl-badge");
    const cs = getComputedStyle(b);
    return {
      cls: b.className, text: b.textContent.trim(), color: cs.color,
      warnVar: getComputedStyle(document.documentElement).getPropertyValue("--warn").trim(),
      accentVar: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    };
  });
  check("badge-agent-amber", /(^|\s)agent(\s|$)/.test(badgeA.cls) && badgeA.color.replace(/\s/g, "") === `rgb(${hex(badgeA.warnVar)})`,
    `Agent 态 text="${badgeA.text}" color=${badgeA.color} vs --warn=${badgeA.warnVar}`);
  await page.click('button:has-text("接管")');
  await page.waitForTimeout(400);
  const badgeH = await page.evaluate(() => {
    const b = document.querySelector(".ctl-badge");
    return { cls: b.className, text: b.textContent.trim(), color: getComputedStyle(b).color };
  });
  check("badge-human-accent", /(^|\s)human(\s|$)/.test(badgeH.cls) && badgeH.color.replace(/\s/g, "") === `rgb(${hex(badgeA.accentVar)})`,
    `Human 态 text="${badgeH.text}" color=${badgeH.color} vs --accent=${badgeA.accentVar}`);
  check("badge-text-semantics", badgeA.text.includes("Agent 控制中") && badgeH.text.includes("我控制中"), `"${badgeA.text}" / "${badgeH.text}"`);
  // 交还回去（恢复现场）
  await page.click('button:has-text("交还 Agent")');
  await page.waitForTimeout(300);

  // ── 3) 连接按钮 loading「连接中…」≤400ms ──
  // prod-2（10.0.0.12）未信任 → TOFU 门内挂起，connecting 稳定在场，可测点击→文案翻转延迟
  await page.hover('.host-card:has-text("prod-2")');
  await page.waitForTimeout(250);
  const latency = await page.evaluate(async () => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.textContent.includes("prod-2"));
    const btn = card.querySelector(".host-connect-btn");
    const t0 = performance.now();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    let dt = -1;
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      if (btn.textContent.includes("连接中") || btn.disabled) { dt = performance.now() - t0; break; }
    }
    return { dt: +dt.toFixed(1), text: btn.textContent, disabled: btn.disabled };
  });
  check("connect-loading-400ms", latency.dt >= 0 && latency.dt <= 400, `点击→「${latency.text}」+disabled=${latency.disabled} 用时 ${latency.dt}ms`);
  // 全部连接钮在连接中禁用（单连接互斥）
  const allDisabled = await page.evaluate(() =>
    [...document.querySelectorAll(".host-connect-btn")].every((b) => b.disabled));
  check("connect-mutex-disabled", allDisabled, "connecting 期间所有连接钮 disabled");
  // 收尾：拒绝 TOFU，恢复现场
  await page.click('.hk-dialog button:has-text("取消")');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    connErr: !!document.querySelector(".conn-error"),
    fail: [...document.querySelectorAll(".host-fail")].length,
  }));
  out.push(`INFO 拒绝后 conn-error 横幅=${after.connErr} 主机卡失败提示=${after.fail}（HostKeyRejected 路径）`);

  function hex(h) {
    return h.replace("#", "").match(/.{2}/g).map((x) => parseInt(x, 16)).join(",");
  }
  console.log(out.join("\n"));
  await browser.close();
})().catch((e) => { console.error("RECHECK ERROR:", e); process.exit(1); });
