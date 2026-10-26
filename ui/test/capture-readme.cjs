// README 演示模式截图抓取：浏览器纯 demo 域（无需 Rust 后端），产出 4 张图入 docs/img/。
//   a. readme-terminal.png  主界面：激活 prod-1，往终端敲命令让画面有内容
//   b. readme-agent.png     Agent 演练视图：发送 → 审批卡（待审批）在场
//   c. readme-monitor.png   监控大屏：开通用+NPU 采集，卡片与环形仪表在场
//   d. readme-blocks.png    命令块面板：状态条入口打开，最近块时间线
//
// 复用 harness 的浏览器发现（TINYSSH_UI_CHROME 指定 Edge）与 demo 打开方式；
// 视口 1440×900、deviceScaleFactor=1（=2 会让终端 WebGL 画布空白，一律用 1）。
// 文件 <20KB 视为空白，重试一次。
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { resolveBrowser } = require("./browser.cjs");

const BASE = process.env.TINYSSH_UI_BASE || "http://127.0.0.1:5199";
const OUT = path.resolve(__dirname, "..", "..", "docs", "img");
const MIN_BYTES = 20 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击文本含 name 的会话标签（demo 预置 prod-1/staging-1）。 */
async function activateTab(page, name) {
  await page.evaluate((n) => {
    const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes(n));
    if (!tab) throw new Error("tab not found: " + n);
    tab.click();
  }, name);
}

/** 截图 + 空白守卫：<20KB 重试一次，仍小则报错。 */
async function shot(page, file, label) {
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest });
  let bytes = fs.statSync(dest).size;
  if (bytes < MIN_BYTES) {
    console.log(`  ${label}: ${bytes}B 太小，疑似空白，重试一次`);
    await sleep(800);
    await page.screenshot({ path: dest });
    bytes = fs.statSync(dest).size;
  }
  if (bytes < MIN_BYTES) throw new Error(`${file} 仍小于 ${MIN_BYTES}B（${bytes}B），疑似空白`);
  console.log(`ok ${file}  ${bytes}B  (${label})`);
  return bytes;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { path: executablePath } = resolveBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // ── 打开 demo 首屏（初始态 = 2 个演示会话 + 欢迎页）──
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".hostbar", { timeout: 15000 });
  await sleep(900);

  // ═══ a. 主界面：终端在前台 + 敲两条命令 ═══
  await activateTab(page, "prod-1");
  await sleep(700);
  // 等「会话已接入——点击终端区直接打字」提示自消（6s 定时），别让它盖在画面上
  await page.waitForFunction(() => !document.querySelector(".attach-hint"), null, { timeout: 9000 })
    .catch(() => {});
  // demo 域是模拟终端：往 xterm 实例写「敲键回显 + 命令输出」（spec 40 同款驱动）
  await page.evaluate(() => {
    const t = window.__t_terms.get("s-demo-0001");
    if (!t) throw new Error("prod-1 term not found");
    t.focus();
    t.write("uptime");
  });
  await sleep(500);
  await page.evaluate(() => {
    const t = window.__t_terms.get("s-demo-0001");
    t.write("\r\n 14:32:11 up 14 days,  3:22,  2 users,  load average: 0.32, 0.28, 0.19\r\nops@prod-1:~$ ");
  });
  await sleep(300);
  await page.evaluate(() => {
    const t = window.__t_terms.get("s-demo-0001");
    t.write("systemctl status nginx");
  });
  await sleep(500);
  await page.evaluate(() => {
    const t = window.__t_terms.get("s-demo-0001");
    t.write(
      "\r\n\u25cf nginx.service - A high performance web server and reverse proxy server\r\n" +
      "     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\r\n" +
      "     Active: \x1b[32mactive (running)\x1b[0m since Tue 2026-10-20 09:12:33 CST; 3 days ago\r\n" +
      "   Main PID: 1180 (nginx)\r\n" +
      "      Tasks: 3 (limit: 4519)\r\n" +
      "     Memory: 12.4M\r\n" +
      "        CPU: 1.204s\r\n" +
      "     CGroup: /system.slice/nginx.service\r\n" +
      "             \u251c\u25001180 nginx: master process /usr/sbin/nginx -g daemon on; master_process on;\r\n" +
      "             \u251c\u25001181 nginx: worker process\r\n" +
      "             \u2514\u25001182 nginx: worker process\r\n" +
      "ops@prod-1:~$ ",
    );
  });
  await sleep(600);
  await shot(page, "readme-terminal.png", "主界面·终端前台");

  // ═══ 前置：把 staging-1 真连一次（大屏开前走主机栏，spec 55 同款），让大屏有两张卡 ═══
  try {
    const card = await page.$('.host-card:has(.host-name:text-is("staging-1"))');
    if (!card) throw new Error("staging-1 host card not found");
    await card.hover();
    await sleep(300);
    await (await card.$('button[title^="连接"]')).click();
    await sleep(800);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".hk-actions button")].find((x) => x.textContent.includes("信任并连接"));
      if (b) b.click();
    });
    await sleep(1400);
    console.log("staging-1 已连接（大屏将有两张卡）");
  } catch (e) {
    console.log("connect staging-1 失败（继续，单卡也成立）：" + e.message);
  }

  // ═══ b. Agent 演练视图 + 审批卡在场（spec 51 同款驱动）═══
  await activateTab(page, "prod-1");
  await sleep(600);
  await page.click('[data-testid="rail-agent"]');
  await sleep(400);
  await page.waitForSelector('[data-testid="agent-view"]', { timeout: 5000 });
  await page.fill('[data-testid="agent-input"]', "检查 nginx 服务与磁盘水位");
  await page.click('[data-testid="agent-send"]');
  await page.waitForFunction(() => document.querySelectorAll(".bubble-user").length >= 1, null, { timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
    null, { timeout: 12000 },
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="agent-tool"]')?.scrollIntoView({ block: "center" });
  });
  await sleep(800);
  await page.evaluate(() => document.activeElement?.blur?.());
  await shot(page, "readme-agent.png", "Agent 演练·审批卡");

  // ═══ c. 监控大屏：开通用 + NPU 采集，等卡片有数据（spec 55 同款驱动）═══
  await page.click('[data-testid="rail-monitor"]');
  await page.waitForSelector('[data-testid="monitor-view"]', { timeout: 5000 });
  await sleep(400);
  if (await page.$('[data-testid="mon-empty"]')) {
    await page.click('[data-testid="mon-sw-general-big"]');
    await sleep(400);
  }
  await page.waitForSelector('[data-testid="mon-card"]', { timeout: 9000 });
  // 等首样网络速率与若干采样点（周期 3s），让环形仪表/折线有形
  await page.waitForFunction(
    () => /(B\/s|KB\/s|MB\/s)/.test(document.querySelector(".mon-card-body")?.textContent ?? ""),
    null, { timeout: 12000 },
  );
  await page.click('[data-testid="mon-sw-npu"]');
  await page.waitForSelector('[data-testid="mon-npu"]', { timeout: 12000 });
  await page.waitForFunction(
    () => (document.querySelector(".mon-spark.cpu polyline")?.points.length ?? 0) >= 4,
    null, { timeout: 12000 },
  ).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.move(720, 300);
  await shot(page, "readme-monitor.png", "监控大屏·双卡+NPU");

  // ═══ d. 命令块面板（spec 33/40 同款：状态条入口打开）═══
  await page.click('[data-testid="monitor-close"]');
  await sleep(400);
  await activateTab(page, "prod-1");
  await sleep(600);
  await page.click('[data-testid="sb-blocks"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="block-row"]').length >= 5,
    null, { timeout: 8000 },
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="blocks-note"]')?.closest(".tp-body, .right-panel, body")
      ?.scrollTo?.(0, 0);
    document.activeElement?.blur?.();
  });
  await sleep(500);
  await shot(page, "readme-blocks.png", "命令块面板");

  await browser.close();
  if (errors.length) console.log("页面 JS 异常（仅记录）:", errors.slice(0, 3).join(" | "));
  console.log("done ->", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
