// 找茬六轮 D 路走查①（续）：主机管理动线剩余段——编辑回填/重名防呆/删除确认/搜索/
// 分组/右键菜单/遮罩语义。Enter 提交重开 bug 已在 walk-r6d-1b/1c 单独立案，
// 本脚本提交一律走鼠标钮，避免污染。
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://127.0.0.1:5199";
const OUT = path.resolve(__dirname, ".shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [];
const bad = [];
const note = [];
const ck = (name, cond, detail = "") => {
  (cond ? ok : bad).push(`${cond ? "ok" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  console.log(`${cond ? "ok" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const nn = (s) => note.push(s);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: resolveBrowser().path, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-CN", colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 15000 });
  await sleep(800);
  const escAll = async () => { for (let i = 0; i < 5; i++) { await page.keyboard.press("Escape"); await sleep(200); } };
  const addBtnPt = async () => page.evaluate(() => {
    const btns = [...document.querySelectorAll(".hb-top .icon-btn")];
    const b = btns[btns.length - 1];
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const trustTofu = async () => {
    const p = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".hk-dialog button")].find((x) => x.textContent.includes("信任并连接"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (p) { await page.mouse.click(p.x, p.y); await sleep(900); }
  };

  // 先建一台测试主机（鼠标点「仅保存」，不触 TOFU）
  let ab = await addBtnPt();
  await page.mouse.click(ab.x, ab.y);
  await page.waitForSelector('[data-testid="add-host-dialog"]');
  await sleep(250);
  await page.keyboard.type("r6d-m1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("10.61.0.1");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("deploy");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("pw-test");
  const onlySave = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const b = [...dlg.querySelectorAll("button")].find((x) => x.textContent.includes("仅保存"));
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(onlySave.x, onlySave.y);
  await sleep(700);
  ck("PREP 测试主机 r6d-m1 已建", await page.evaluate(() => [...document.querySelectorAll(".host-name")].some((e) => e.textContent === "r6d-m1")), "");

  // ═══ E. 编辑主机回填 ═══
  const editBtnPt = async () => page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.querySelector(".host-name")?.textContent === "r6d-m1");
    const btn = card?.querySelector(".host-ops button:nth-child(2)");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  let ep = await editBtnPt();
  await page.mouse.move(ep.x, ep.y);
  await sleep(250);
  await page.mouse.click(ep.x, ep.y);
  await sleep(400);
  const backfill = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const ins = [...dlg.querySelectorAll("input")].map((i) => i.value);
    const sel = dlg.querySelector("select");
    return { ins, selDisabled: sel?.disabled ?? false, head: dlg.querySelector(".dlg-head b")?.textContent };
  });
  ck("E1 编辑对话框打开（head=编辑主机）", backfill.head === "编辑主机", backfill.head ?? "无");
  ck("E2 回填 名称/地址/端口/用户名", backfill.ins[0] === "r6d-m1" && backfill.ins[1] === "10.61.0.1" && backfill.ins[2] === "22" && backfill.ins[3] === "deploy", JSON.stringify(backfill.ins.slice(0, 4)));
  ck("E3 编辑态认证方式锁死", backfill.selDisabled === true, "");
  await page.screenshot({ path: path.join(OUT, "r6d-1-06-edit-backfill.png") });
  // TOFU 状态行（编辑密码主机时出示「更换密码（留空保持不变）」）
  const editHints = await page.evaluate(() => document.querySelector('[data-testid="add-host-dialog"]')?.textContent?.match(/更换密码（留空保持不变）|密码留空保持不变/g) ?? []);
  ck("E4 编辑态密码语义（留空保持不变提示在场）", editHints.length >= 1, JSON.stringify(editHints));
  // 取消按钮收尾
  const cancelBtn = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const b = [...dlg.querySelectorAll("button")].find((x) => x.textContent === "取消");
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(cancelBtn.x, cancelBtn.y);
  await sleep(300);

  // ═══ F. 重名防呆（鼠标提交）═══
  ab = await addBtnPt();
  await page.mouse.click(ab.x, ab.y);
  await page.waitForSelector('[data-testid="add-host-dialog"]');
  await sleep(250);
  await page.keyboard.type("prod-1");
  await page.keyboard.press("Tab");
  await page.keyboard.type("10.62.0.1");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type("ops");
  const saveConn = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const b = [...dlg.querySelectorAll("button")].find((x) => x.textContent.includes("保存并连接"));
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(saveConn.x, saveConn.y);
  await sleep(450);
  const dupErr = await page.evaluate(() => document.querySelector('[data-testid="add-host-dialog"] .err')?.textContent ?? null);
  ck("F1 重名提交被拦且有指名提示", !!dupErr && dupErr.includes("prod-1"), dupErr ?? "无报错");
  // 错误后焦点应在名称框
  const dupFocus = await page.evaluate(() => document.activeElement?.closest(".ah-field")?.querySelector("label")?.textContent?.trim() ?? "?");
  ck("F2 重名报错后焦点回名称框", String(dupFocus).includes("名称"), String(dupFocus));
  await page.screenshot({ path: path.join(OUT, "r6d-1-07-dup-name.png") });
  // 同址不同名 → 地址防呆
  await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const ins = [...dlg.querySelectorAll("input")];
    const set = (el, v) => { el.focus(); };
  });
  const nameBox2 = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const el = [...dlg.querySelectorAll("input")][0];
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  });
  await page.mouse.click(nameBox2.x, nameBox2.y);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("r6d-m2");
  const addrBox = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="add-host-dialog"]');
    const el = [...dlg.querySelectorAll("input")][1];
    const r = el.getBoundingClientRect();
    return { x: r.left + 10, y: r.top + r.height / 2 };
  });
  await page.mouse.click(addrBox.x, addrBox.y);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("10.0.0.11"); // prod-1 的地址
  await page.mouse.click(saveConn.x, saveConn.y);
  await sleep(450);
  const addrErr = await page.evaluate(() => document.querySelector('[data-testid="add-host-dialog"] .err')?.textContent ?? null);
  ck("F3 同址同端口提交被拦并指向既有条目", !!addrErr && addrErr.includes("prod-1"), addrErr ?? "无报错");
  await escAll();

  // ═══ G. 删除主机确认 ═══
  const delBtnPt = async () => page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.querySelector(".host-name")?.textContent === "r6d-m1");
    const btn = card?.querySelector(".host-ops .host-del");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  let dp = await delBtnPt();
  await page.mouse.move(dp.x, dp.y);
  await sleep(250);
  await page.mouse.click(dp.x, dp.y);
  await sleep(400);
  const delDlg = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll(".confirm-dialog")].find((d) => d.textContent.includes("删除主机"));
    return dlg ? dlg.textContent.slice(0, 150) : null;
  });
  ck("G1 删除主机有确认框（指名主机）", !!delDlg && delDlg.includes("r6d-m1"), (delDlg ?? "").slice(0, 80));
  await page.screenshot({ path: path.join(OUT, "r6d-1-08-delete-confirm.png") });
  // Esc 取消
  await page.keyboard.press("Escape");
  await sleep(300);
  const stillThere = await page.evaluate(() => [...document.querySelectorAll(".host-name")].some((e) => e.textContent === "r6d-m1"));
  ck("G2 Esc 取消删除（主机还在）", stillThere, "");
  // 确认删除
  dp = await delBtnPt();
  await page.mouse.move(dp.x, dp.y);
  await sleep(250);
  await page.mouse.click(dp.x, dp.y);
  await sleep(350);
  const confirmBtn = await page.evaluate(() => {
    const dlg = [...document.querySelectorAll(".confirm-dialog")].find((d) => d.textContent.includes("删除主机"));
    const b = [...dlg.querySelectorAll("button")].find((x) => /删除/.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: b.textContent };
  });
  await page.mouse.click(confirmBtn.x, confirmBtn.y);
  await sleep(700);
  const gone = await page.evaluate(() => ![...document.querySelectorAll(".host-name")].some((e) => e.textContent === "r6d-m1"));
  ck("G3 确认后删除生效", gone, "");

  // ═══ H. 搜索过滤（含 Enter 直达）═══
  const searchPt = async () => page.evaluate(() => {
    const el = document.querySelector(".hb-search input");
    const r = el.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2 };
  });
  let sp = await searchPt();
  await page.mouse.click(sp.x, sp.y);
  await page.keyboard.type("prod");
  await sleep(500);
  let names = await page.evaluate(() => [...document.querySelectorAll(".host-name")].map((e) => e.textContent));
  ck("H1 搜索「prod」过滤生效", names.length > 0 && names.filter((n) => n !== "本机").every((n) => n.includes("prod")), JSON.stringify(names));
  await page.keyboard.type("zzz");
  await sleep(500);
  const noMatch = await page.evaluate(() => [...document.querySelectorAll(".hb-scroll .dim")].map((e) => e.textContent));
  ck("H2 无结果态文案可行动（清除筛选/添加）", noMatch.some((d) => d.includes("无匹配")), JSON.stringify(noMatch));
  await page.screenshot({ path: path.join(OUT, "r6d-1-09-search-nomatch.png") });
  const clearBtn = await page.evaluate(() => document.querySelectorAll(".hb-search button").length);
  ck("H3 搜索框无专用清空钮（记录）", clearBtn === 0, "确认无 ✕ 清空钮");
  if (clearBtn === 0) nn("H3 注记：搜索框无清空钮——清空需 Ctrl+A+Delete；对照：SFTP 名称筛选同样没有（小打磨点）");
  // 清空搜索
  sp = await searchPt();
  await page.mouse.click(sp.x, sp.y);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await sleep(400);
  // Enter 直达第一命中（staging-1 无会话 → 新建连接 → TOFU）
  await page.keyboard.type("staging");
  await sleep(450);
  const beforeTabs = await page.evaluate(() => document.querySelectorAll(".tab").length);
  await page.keyboard.press("Enter");
  await sleep(1200);
  const tofuSeen = await page.evaluate(() => !!document.querySelector(".hk-dialog .hk-title"));
  await trustTofu();
  await sleep(600);
  await escAll();
  const afterTabs = await page.evaluate(() => document.querySelectorAll(".tab").length);
  ck("H4 搜索 Enter 直达第一命中主机（staging 建连走 TOFU 门）", tofuSeen && afterTabs > beforeTabs, "tofu=" + tofuSeen + " tabs " + beforeTabs + "→" + afterTabs);
  // 清空恢复
  sp = await searchPt();
  await page.mouse.click(sp.x, sp.y);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await sleep(450);
  names = await page.evaluate(() => [...document.querySelectorAll(".host-name")].map((e) => e.textContent));
  ck("H5 清空搜索列表全量恢复", names.length >= 6, JSON.stringify(names));

  // ═══ I. 分组与收藏 ═══
  const favBtnPt = async () => page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.querySelector(".host-name")?.textContent === "prod-2（演示连接失败）");
    const btn = card?.querySelector(".fav-btn");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  let fp = await favBtnPt();
  if (fp) {
    await page.mouse.move(fp.x, fp.y);
    await sleep(250);
    await page.mouse.click(fp.x, fp.y);
    await sleep(700);
    const sections = await page.evaluate(() => [...document.querySelectorAll(".hb-scroll .section h4")].map((h) => h.textContent));
    ck("I1 收藏后出现「收藏」分组", sections.includes("收藏"), JSON.stringify(sections));
    const hdrInfo = await page.evaluate(() => {
      const h = [...document.querySelectorAll(".hb-scroll .section h4")].find((x) => x.textContent === "收藏");
      return { hasBtn: !!h?.querySelector("button"), cursor: h ? getComputedStyle(h).cursor : null };
    });
    ck("I2 分组头可折叠（有=ok 无=注记）", true, hdrInfo.hasBtn ? "可折叠" : "无折叠功能（cursor=" + hdrInfo.cursor + "，纯标题）");
    if (!hdrInfo.hasBtn) nn("I2 注记：主机栏分组（收藏/其他主机）无折叠/展开——主机多时全靠滚动，长列表管理弱于同类工具");
    // 取消收藏还原
    fp = await favBtnPt();
    await page.mouse.move(fp.x, fp.y);
    await sleep(250);
    await page.mouse.click(fp.x, fp.y);
    await sleep(700);
    const sections2 = await page.evaluate(() => [...document.querySelectorAll(".hb-scroll .section h4")].map((h) => h.textContent));
    ck("I3 取消收藏恢复单组", !sections2.includes("收藏"), JSON.stringify(sections2));
  } else {
    ck("I1 收藏分组", false, "prod-2 卡没找到");
  }

  // ═══ J. 右键菜单全项 ═══
  const ctxPt = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".host-card")].find((c) => c.querySelector(".host-name")?.textContent === "staging-1");
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
  });
  await page.mouse.click(ctxPt.x, ctxPt.y, { button: "right" });
  await sleep(400);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll(".ctx-menu .sm-item")].map((b) => b.textContent));
  console.log("主机右键菜单:", JSON.stringify(menuItems));
  ck("J1 右键菜单含 连接/收藏/编辑/删除", menuItems.some((m) => m.includes("连接（新建会话）")) && menuItems.some((m) => m.includes("收藏")) && menuItems.some((m) => m.includes("编辑主机")) && menuItems.some((m) => m.includes("删除主机")), JSON.stringify(menuItems));
  if (!menuItems.some((m) => m.includes("复制"))) nn("J2 注记：无「复制主机/克隆」条目——批量录同网段主机逐台重敲；对照：标签右键有「复制标签页」");
  // 键盘可达性：开菜单后 ↑↓/Enter
  const focus0 = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 12) ?? "?");
  const focusInMenu = await page.evaluate(() => !!document.activeElement?.closest(".ctx-menu"));
  ck("J3 右键菜单开即聚焦首项（键盘可达）", focusInMenu, focus0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const focus2 = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 12));
  console.log("↓2 后焦点:", focus2);
  await page.keyboard.press("Escape");
  await sleep(250);

  // ═══ K. 遮罩点击语义 ═══
  ab = await addBtnPt();
  await page.mouse.click(ab.x, ab.y);
  await page.waitForSelector('[data-testid="add-host-dialog"]');
  await sleep(250);
  await page.keyboard.type("mask-test");
  await page.mouse.click(8, 400); // 遮罩左缘
  await sleep(350);
  const maskOpen = await page.evaluate(() => !!document.querySelector('[data-testid="add-host-dialog"]'));
  nn(maskOpen
    ? "K1 注记：新建主机遮罩点击不关闭（Esc/✕ 可关）；设置面板 pop-mask 点遮罩即关——两处遮罩语义不一致（对话框防误触 vs 面板快关，可辩护，记录在案）"
    : "K1 注记：新建主机遮罩点击即关（与设置面板一致）");
  ck("K1 遮罩点击行为已记录", true, maskOpen ? "不关" : "关");
  if (maskOpen) { await escAll(); }

  // 清残留标签（关闭本轮建的两个会话）不做了——下个脚本 4 会复用标签
  ck("页面零 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
  await page.screenshot({ path: path.join(OUT, "r6d-1-10-final.png") });
  await ctx.close();
  await browser.close();
  console.log(`\n══ 汇总：${ok.length} ok / ${bad.length} FAIL`);
  console.log("── 注记 ──");
  for (const l of note) console.log("NOTE", l);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("脚本失败：", e); process.exit(2); });
