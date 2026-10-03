// T41（v1.39）FR-7 SFTP 浏览器走查（浏览器 demo）：
//  1. 会话建立后「远程文件」区出现，首载目录 = 简报 cwd（/var/log/nginx）
//  2. 目录在前名称序；目录行可点进入，路径随之更新
//  3. 「上一级」回到父目录；路径框可手输跳转
//  4. 不存在路径报错；文件行 hover 出「下载」，点击产生诚实失败卡（演示无真实传输）
const { chromium } = require("playwright-core");
const EXE = "/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

  await page.goto("http://localhost:5183/", { waitUntil: "networkidle" });
  await page.waitForSelector(".host-card", { timeout: 8000 });

  // ── 1. 连接本机 → 远程文件区出现并自动加载简报 cwd ──
  await page.click('.host-card:has-text("本机") .host-card-main', { position: { x: 12, y: 12 } });
  await page.waitForSelector('.tab:has-text("本机")', { timeout: 8000 });
  await page.waitForSelector('.section:has(h4:text("远程文件")) .sftp-row', { timeout: 8000 });
  const cwdVal = await page.$eval(".sftp-path input", (el) => el.value);
  check("loads-brief-cwd", cwdVal === "/var/log/nginx", `首载=${cwdVal}`);

  // 无会话态占位（先记文案，本会话已连）
  const rows = await page.$$eval('.section:has(h4:text("远程文件")) .sftp-row', (rs) =>
    rs.map((r) => ({
      name: r.querySelector(".sftp-name")?.textContent ?? "",
      dir: r.classList.contains("dir"),
    })));
  check("dirs-first-sorted", rows.map((r) => r.name).join(",") === "archive,access.log,error.log", rows.map((r) => r.name).join(","));
  check("dir-row-flagged", rows[0].dir === true && rows[1].dir === false);

  // ── 2. 进入目录 ──
  await page.click('.sftp-row.dir:has-text("archive") .sftp-name');
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent === "远程文件");
    const rows = sec ? [...sec.querySelectorAll(".sftp-row")] : [];
    return rows.length === 1 && (rows[0].textContent ?? "").includes("access-202609");
  }, null, { timeout: 8000 }).then(
    () => check("navigate-into-dir", true),
    () => check("navigate-into-dir", false, "archive 目录未进入"),
  );
  const p2 = await page.$eval(".sftp-path input", (el) => el.value);
  check("path-updated", p2 === "/var/log/nginx/archive", p2);

  // ── 3. 上一级 ──
  await page.click('.sftp-path button[title="上一级目录"]');
  await page.waitForFunction(() => (document.querySelector(".sftp-path input") || {}).value === "/var/log/nginx", null, { timeout: 8000 });
  check("parent-nav", true);

  // ── 4. 手输跳转 ──
  await page.fill(".sftp-path input", "/root");
  await page.press(".sftp-path input", "Enter");
  await page.waitForFunction(() => {
    const sec = [...document.querySelectorAll(".section")].find((s) => s.querySelector("h4")?.textContent === "远程文件");
    const rows = sec ? [...sec.querySelectorAll(".sftp-row")] : [];
    return rows.some((r) => (r.textContent ?? "").includes("backup-0930"));
  }, null, { timeout: 8000 }).then(
    () => check("manual-path-jump", true),
    () => check("manual-path-jump", false, "/root 未加载"),
  );

  // ── 5. 不存在路径 ──
  await page.fill(".sftp-path input", "/no/such/dir");
  await page.press(".sftp-path input", "Enter");
  await page.waitForSelector('.section:has(h4:text("远程文件")) .err', { timeout: 8000 }).then(
    () => check("missing-dir-error", true),
    () => check("missing-dir-error", false, "无报错提示"),
  );

  // ── 6. 文件行下载（demo 诚实失败）──
  await page.fill(".sftp-path input", "/root");
  await page.press(".sftp-path input", "Enter");
  await page.waitForSelector('.sftp-row:has-text("readme.md")', { timeout: 8000 });
  await page.hover('.sftp-row:has-text("readme.md")');
  await page.click('.sftp-row:has-text("readme.md") .sftp-dl');
  await page.waitForSelector('.xfer-row:has-text("readme.md")', { timeout: 8000 });
  const xfer = await page.$eval('.xfer-row:has-text("readme.md")', (el) => el.textContent ?? "");
  check("download-honest-failure", xfer.includes("演示模式不提供真实 SFTP 传输"), xfer.slice(0, 50));

  await page.screenshot({ path: "../docs/acceptance/screenshots/t41_sftp_browser.png" });
  console.log(results.join("\n"));
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - fails} PASS / ${fails} FAIL`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("WALKTHROUGH ERROR:", e.message); process.exit(1); });
