// README 演示模式截图抓取：浏览器纯 demo 域（无需 Rust 后端），产出 8 张图入 docs/img/。
//   a. readme-terminal.png  主界面：激活 prod-1，往终端敲命令让画面有内容
//   b. readme-agent.png     Agent 演练视图：发送 → 审批卡（待审批）在场
//   c. readme-monitor.png   监控大屏：开通用+NPU 采集，等 ≥8 个采样点曲线饱满
//   d. readme-blocks.png    命令块面板：状态条入口打开，最近块时间线
//   e. readme-md.png        Agent 富渲染：批准后摘要里的 mermaid SVG + KaTeX 公式
//   f. readme-fleet.png     Fleet 编排视图：跨主机编排对话 + 工具卡完成态
//   g. readme-files.png     文件面板：demo /var/log/nginx 目录 + 选中条
//   h. readme-records.png   设置 → 记录审计：会话泳道时间线 + 200 行明细
//
// 复用 harness 的浏览器发现（TINYSSH_UI_CHROME 指定 Edge）与 demo 打开方式；
// 视口 1440×900、deviceScaleFactor=1（=2 会让终端 WebGL 画布空白，一律用 1）。
// 文件 <20KB 视为空白，重试一次。全部画面均为 demo 合成数据，无真实主机信息。
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

/** 等「会话已接入」提示自消（6s 定时），别让它盖在画面上。 */
async function hintGone(page) {
  await page.waitForFunction(() => !document.querySelector(".attach-hint"), null, { timeout: 9000 })
    .catch(() => {});
}

/** 截图 + 空白守卫：<20KB 重试一次，仍小则报错。 */
async function shot(page, file, label) {
  const dest = path.join(OUT, file);
  await page.evaluate(() => document.activeElement?.blur?.());
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
    colorScheme: "dark", // 深色 · 东京夜（出厂色板族 2026-10-27 起 = tokyo）
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

  // ═══ d. 命令块面板（spec 33/40 同款：状态条入口打开）═══
  await page.click('[data-testid="sb-blocks"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="block-row"]').length >= 5,
    null, { timeout: 8000 },
  );
  await sleep(500);
  await shot(page, "readme-blocks.png", "命令块面板");
  // 收面板（状态条 chip 是 toggle；失败不致命，后续视图会盖掉）
  await page.click('[data-testid="sb-blocks"]').catch(() => {});
  await sleep(400);

  // ═══ b. Agent 演练视图 + 审批卡在场（spec 51 同款驱动）═══
  await activateTab(page, "prod-1");
  await sleep(600);
  await page.click('[data-testid="rail-agent"]');
  await sleep(400);
  await page.waitForSelector('[data-testid="agent-view"]', { timeout: 5000 });
  await hintGone(page);
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
  await page.mouse.move(720, 850);
  await shot(page, "readme-agent.png", "Agent 演练·审批卡");

  // ═══ e. 批准 → 摘要流式结束后 mermaid SVG + KaTeX（spec 54 同款）═══
  await page.click('[data-testid="agent-approve"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成") ?? false,
    null, { timeout: 12000 },
  );
  await page.waitForFunction(() => !document.querySelector(".ag-cursor"), null, { timeout: 25000 });
  // mermaid 动态 chunk 首次加载（vite 依赖预构建）可能十几秒——等待从宽
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="agent-md"] .mermaid-wrap.mm-ok svg'),
    null, { timeout: 60000 },
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="agent-md"] .mermaid-wrap')?.scrollIntoView({ block: "center" });
  });
  await sleep(1000);
  await page.mouse.move(720, 850);
  await shot(page, "readme-md.png", "Agent 富渲染·mermaid+KaTeX");

  // ═══ f. Fleet 编排视图：跨主机编排对话 + 工具卡完成态（spec 53 同款）═══
  await page.click('[data-testid="rail-fleet"]');
  await sleep(500);
  await page.waitForSelector('[data-testid="agent-view"]', { timeout: 5000 });
  await hintGone(page);
  await page.fill('[data-testid="agent-input"]', "盘点所有机器的磁盘");
  await page.click('[data-testid="agent-send"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("待审批") ?? false,
    null, { timeout: 12000 },
  );
  await page.click('[data-testid="agent-approve"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-tool"]')?.textContent?.includes("完成") ?? false,
    null, { timeout: 12000 },
  );
  await page.waitForFunction(() => !document.querySelector(".ag-cursor"), null, { timeout: 25000 });
  // 滚到工具卡居中（派发→完成的故事），与 md 图的 mermaid 居中区分
  await page.evaluate(() => {
    document.querySelector('[data-testid="agent-tool"]')?.scrollIntoView({ block: "center" });
  });
  await sleep(600);
  await page.mouse.move(720, 850);
  await shot(page, "readme-fleet.png", "Fleet 编排·跨主机派发");

  // ═══ g. 文件面板：回主机栏连「本机」→ 开文件浏览（spec 05 同款）═══
  await page.click('[data-testid="rail-hosts"]');
  await sleep(600);
  const localCard = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await localCard.hover();
  await sleep(300);
  await (await localCard.$('button[title^="连接"]')).click();
  await sleep(1500);
  await page.click('.session-toolbar button[title^="文件"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".sftp-row").length >= 4,
    null, { timeout: 9000 },
  );
  await hintGone(page);
  await page.click('.sftp-row[data-name="access.log"]');
  await sleep(500);
  await page.mouse.move(720, 850);
  await shot(page, "readme-files.png", "文件面板·浏览+选中条");
  // 收尾：关文件面板、关「本机」标签（避免影响后续大屏卡片构成）
  await page.click('.session-toolbar button[title^="文件"]').catch(() => {});
  await sleep(400);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("本机"));
    tab?.querySelector('[class*="close"], .tab-x, button')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(500);

  // ═══ 前置：把 staging-1 真连一次（spec 55 同款走主机栏），让大屏有多张卡 ═══
  // （放在文件面板之后：避免重复标签提前入镜）
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
    console.log("staging-1 已连接（大屏将多一张卡）");
  } catch (e) {
    console.log("connect staging-1 失败（继续，单卡也成立）：" + e.message);
  }

  // ═══ c. 监控大屏：开通用 + NPU 采集，等曲线饱满 + CPU 环摆离 0%（spec 55 同款）═══
  // demo CPU 忙占比 ∝ cos(t/17)（周期 ~107s，负半相 ~53s 全是 0%）：等相位走到
  // −90° 附近（sin<−0.7 且 cos>0，每周期约 13s 窗口）再开大屏——此后 40–53s 全是
  // 正相位，24s 采样窗拍摂时恰在峰值附近
  await page.waitForFunction(() => {
    const x = Date.now() / 1000 / 17;
    return Math.sin(x) < -0.7 && Math.cos(x) > 0;
  }, null, { timeout: 150000 });
  await page.click('[data-testid="rail-monitor"]');
  await page.waitForSelector('[data-testid="monitor-view"]', { timeout: 5000 });
  await sleep(400);
  if (await page.$('[data-testid="mon-empty"]')) {
    await page.click('[data-testid="mon-sw-general-big"]');
    await sleep(400);
  }
  await page.waitForSelector('[data-testid="mon-card"]', { timeout: 9000 });
  // 等首样网络速率与充分采样点（周期 3s），让环形仪表/折线有形
  await page.waitForFunction(
    () => /(B\/s|KB\/s|MB\/s)/.test(document.querySelector(".mon-card-body")?.textContent ?? ""),
    null, { timeout: 12000 },
  );
  await page.click('[data-testid="mon-sw-npu"]');
  await page.waitForSelector('[data-testid="mon-npu"]', { timeout: 12000 });
  await page.waitForFunction(
    () => (document.querySelector(".mon-spark.cpu polyline")?.points.length ?? 0) >= 8,
    null, { timeout: 35000 },
  ).catch(() => {});
  // demo CPU 是正弦摆动、首样可为 0%——等任一环摆到非零再拍，否则观感像坏了
  await page.waitForFunction(
    () => [...document.querySelectorAll(".mon-ring-num")].some((el) => {
      const t = (el.textContent || "").trim();
      return /^\d+%$/.test(t) && t !== "0%";
    }),
    null, { timeout: 60000 },
  ).catch(() => console.log("  CPU 环 60s 未摆离 0%，按现状拍"));
  await sleep(500);
  await page.mouse.move(720, 300);
  await shot(page, "readme-monitor.png", "监控大屏·多卡+NPU");
  await page.click('[data-testid="monitor-close"]').catch(() => {});
  await sleep(500);

  // ═══ h. 设置 → 记录审计：泳道时间线 + 200 行明细（spec 59 同款）═══
  // 用全新 context：左栏视图开关持久化会让监控大屏在 reload 后自动续开、藏掉
  // 主机栏（.hb-settings 不可达），干净 context 才是 spec 59 的初始态
  const ctx2 = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "dark",
  });
  const page2 = await ctx2.newPage();
  await page2.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page2.waitForSelector(".hostbar", { timeout: 15000 });
  await sleep(800);
  await page2.click(".hb-settings");
  await page2.waitForTimeout(700);
  await page2.click('[data-testid="settings-cat-records"]');
  await page2.waitForFunction(
    () => document.querySelectorAll('[data-testid="records-row"]').length >= 200,
    null, { timeout: 12000 },
  );
  await sleep(800);
  await page2.evaluate(() => document.activeElement?.blur?.());
  await page2.mouse.move(720, 850);
  const recDest = path.join(OUT, "readme-records.png");
  await page2.screenshot({ path: recDest });
  console.log(`ok readme-records.png  ${fs.statSync(recDest).size}B  (记录审计·泳道时间线)`);
  await ctx2.close();

  await browser.close();
  if (errors.length) console.log("页面 JS 异常（仅记录）:", errors.slice(0, 3).join(" | "));
  console.log("done ->", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
