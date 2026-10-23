// 55 监控大屏（大屏轮 / 开关轮修订）：活动栏第四入口——整幅主区覆盖层（终端/
// 标签不卸载，大屏盖在其上），每台**服务器**一张卡（同机多连接去重合一，×N
// 徽标），CPU/内存环形仪表 + 网络折线 + Ascend NPU 芯片行。浏览器域跑 demo
// 后端：prod-1 预置已连（read_npu_metrics 回 2×910B2C 仿真表格）；staging-1
// 开机是 Disconnected，现场真连一次（走 TOFU）验证 NO_NPU 隐藏语义；prod-1
// 再连一条验证去重（2 连接一卡 ×2，采样只走代言会话）。
// 开关轮断言面：通用/NPU 两枚采集开关默认全关 = 未开启空态（零卡片零开销）→
// 开通用卡片立现 → 开 NPU 只在 Ascend 节点出芯片区 → **关大屏等待后台折线仍
// 增长**（采集跟开关走不跟面板走的核心证明）→ 刷新后开关态持久、采集自动续上
// → rail 采集中呼吸点。保留：四向互斥、覆盖层盖终端、去重徽标、环形/折线随
// 采样增长、暂停可切换、点卡片头跳终端并收屏、关连接卡片随退、开主机栏收屏。
// 真实后端侧（npu-smi 通道/超时闸）由 core-session e2e + ascend live 测试覆盖。
const path = require("path");
const vis = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && el.getClientRects().length > 0;
}, sel);
const openCls = (page, tid) => page.evaluate((t) =>
  document.querySelector(`[data-testid="${t}"]`)?.classList.contains("ts-open") ?? false, tid);
const cardSel = (page, key) => page.evaluate((k) => {
  const el = document.querySelector(`[data-testid="mon-card"][data-mon-key="${k}"]`);
  return el ? `[data-testid="mon-card"][data-mon-key="${k}"]` : null;
}, key);
const countText = (page) => page.evaluate(() =>
  document.querySelector('[data-testid="monitor-count"]')?.textContent.replace(/\s+/g, " ") ?? "");
const dashCovers = async (page) => page.evaluate(() => {
  // 覆盖层语义：标签条中心命中的最上层元素落在大屏内（终端/标签被盖住而非卸载）
  const tab = document.querySelector(".tab");
  if (!tab) return false;
  const r = tab.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && !!hit.closest(".mon-dash");
});
const cpuPts = (page, key) => page.evaluate((k) =>
  document.querySelector(`[data-mon-key="${k}"] .mon-spark.cpu polyline`)?.points.length ?? 0, key);
const swOn = (page, tid) => page.evaluate((t) =>
  document.querySelector(`[data-testid="${t}"]`)?.getAttribute("aria-pressed") === "true", tid);
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".hk-actions button")].find((x) => x.textContent.includes("信任并连接"));
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
};
const closeViaMenu = async (page, namePart) => {
  const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
  if (!has) return;
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes("关闭会话"));
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};

module.exports = {
  title: "监控大屏：采集开关 opt-in（空态/后台持续采集/持久化）、覆盖层盖终端、按服务器去重一卡、环形仪表+NPU",
  async run({ page, ck }) {
    const PROD = "ops@10.0.0.11:22";
    const STG = "ops@10.0.0.13:22";

    // ── 解析器校准回归（node 域，不开浏览器）：npu.ts 现场打包后对「旧 ≤24.x
    // 形态 + 真机 25.1rc2 样本（test/fixtures）」断言——CANN 表格再变时这里先红，
    // 不必等真机卡片亮「表头未识别」才发现 ──
    {
      const esbuild = require("esbuild");
      const fs = require("fs");
      const npuOut = path.join(__dirname, ".tmp-npu.cjs");
      esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "src", "npu.ts")], bundle: true, format: "cjs", outfile: npuOut });
      try {
        const { parseNpuInfo } = require(npuOut);
        const real = "==NPU==\n" + fs.readFileSync(path.join(__dirname, "..", "fixtures", "npu-smi-25.1.txt"), "utf8");
        const pr = parseNpuInfo(real);
        ck.check("解析器（真机 25.1rc2）：ok 且只收设备区 3 颗（进程区不误收）",
          pr.state === "ok" && pr.chips.length === 3, JSON.stringify(pr).slice(0, 140));
        ck.check("解析器（真机）：Ascend950DT / HBM 92850/98304",
          pr.chips[0]?.name === "Ascend950DT" && pr.chips[0]?.hbmUsedMB === 92850 && pr.chips[0]?.hbmTotalMB === 98304);
        const po = parseNpuInfo("==NPU==\n" +
          "| 0       910B2C            | OK            | 87.9         53               0    / 0             |\n" +
          "| 0       0                 | 0000:5A:00.0  | 0            0 / 0            41455/ 65536          |\n");
        ck.check("解析器（旧 ≤24.x 形态）：910B2C + HBM 对",
          po.state === "ok" && po.chips[0]?.name === "910B2C" && po.chips[0]?.hbmTotalMB === 65536);
      } finally {
        fs.rmSync(npuOut, { force: true });
      }
    }

    // ── 前置：真连 staging-1（开机 Disconnected；连接必须在主机栏，大屏开前做
    // ——这也是真实用户路径）；再连一次 prod-1 造同机双连接 ──
    await connect(page, "staging-1");
    ck.check("staging-1 已连接（标签在场）",
      await page.evaluate(() => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes("staging-1"))));
    await connect(page, "prod-1");
    ck.check("prod-1 第二条连接已建（同名标签 ≥2）",
      await page.evaluate(() => [...document.querySelectorAll(".tab")].filter((x) => x.textContent.includes("prod-1")).length >= 2));

    // ── 入口与打开：开关默认全关 = 未开启空态 ──
    ck.check("活动栏有第四入口（rail-monitor）", await vis(page, '[data-testid="rail-monitor"]'));
    if (!(await openCls(page, "rail-monitor"))) {
      await page.click('[data-testid="rail-monitor"]');
      await page.waitForTimeout(400);
    }
    ck.check("大屏开：rail-monitor 点亮 + monitor-view 可见",
      (await openCls(page, "rail-monitor")) && (await vis(page, '[data-testid="monitor-view"]')));
    ck.check("覆盖层盖住终端/标签（elementFromPoint 落在大屏内）", await dashCovers(page));
    ck.check("四向互斥：主机栏/Agent/Fleet 全收起",
      !(await openCls(page, "rail-hosts")) && !(await openCls(page, "rail-agent")) && !(await openCls(page, "rail-fleet")));

    // ── 大屏开着时设置必须可开（开关轮修复：设置 pop-mask 41 曾被大屏 46 盖住，
    // 点了看不见=「打不开」；家族抬到 55-58 后命中测试必须落在设置面板内）──
    await page.click('[data-testid="rail-settings"]');
    await page.waitForSelector('[data-testid="settings-close"]', { timeout: 4000 });
    const settingsOnTop = await page.evaluate(() => {
      const el = document.querySelector(".term-settings.settings-wide");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && hit.closest(".term-settings.settings-wide") != null && hit.closest(".mon-dash") == null;
    });
    ck.check("大屏开着：设置面板在最上层（面板中心命中面板而非大屏）", settingsOnTop);
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);
    ck.check("设置可关：大屏仍在场", await vis(page, '[data-testid="monitor-view"]'));
    ck.check("开关默认全关（通用/NPU aria-pressed=false）",
      !(await swOn(page, "mon-sw-general")) && !(await swOn(page, "mon-sw-npu")));
    ck.check("未开启空态在场（大开关卡 ×2）、零卡片",
      await vis(page, '[data-testid="mon-empty"]')
      && await vis(page, '[data-testid="mon-sw-general-big"]')
      && await vis(page, '[data-testid="mon-sw-npu-big"]')
      && !(await page.$('[data-testid="mon-card"]')));
    ck.check("采集全关时 rail 无呼吸点", !(await page.$('[data-testid="rail-monitor-live"]')));
    const cnt0 = await countText(page);
    ck.check("空态也显示服务器计数：2 台服务器 · 3 条连接", cnt0.includes("2 台服务器") && cnt0.includes("3 条连接"), cnt0);

    // ── 开通用监控：卡片立现 + 采样到达 ──
    await page.click('[data-testid="mon-sw-general-big"]');
    await page.waitForTimeout(400);
    ck.check("开通用：开关点亮 + 空态退场 + 两张卡在场",
      (await swOn(page, "mon-sw-general")) && !(await page.$('[data-testid="mon-empty"]'))
      && !!(await cardSel(page, PROD)) && !!(await cardSel(page, STG)));
    ck.check("rail 呼吸点亮起（后台采集中）", await vis(page, '[data-testid="rail-monitor-live"]'));
    const prod = await cardSel(page, PROD);
    const stg = await cardSel(page, STG);
    ck.check("prod-1 卡 ×2 徽标（去重合一）",
      await page.evaluate((sel) =>
        document.querySelector(`${sel} [data-testid="mon-dup"]`)?.textContent.trim() === "×2", prod));
    await page.waitForFunction(
      () => /(B\/s|KB\/s|MB\/s)/.test(document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-card-body')?.textContent ?? ""),
      null, { timeout: 9000 });
    const body1 = await page.evaluate(() =>
      document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-card-body')?.textContent.replace(/\s+/g, " ") ?? "");
    // 环形仪表数字在中心、标签在下（textContent 顺序=数值在前）；demo CPU 按 sin
    // 摆动，首样可能恰为 0%——这里断言格式（数值段在场），动态性由折线增长断言覆盖
    ck.check("CPU 环有百分数",
      await page.evaluate(() =>
        /^\d+%$/.test(document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-ring:nth-child(1) .mon-ring-num')?.textContent.trim() ?? "")));
    ck.check("内存环有 GB 用量", /\d+\.\d{2} \/ \d+\.\d{2} GB/.test(body1), body1);
    ck.check("网络行有收发速率", /↓/.test(body1) && /↑/.test(body1) && /(B\/s|KB\/s|MB\/s)/.test(body1), body1);
    ck.check("磁盘/运行段在场", /磁盘/.test(body1) && /运行/.test(body1), body1);
    ck.check("CPU 环弧线属性在位（dasharray 格式合法）",
      await page.evaluate(() => {
        const d = document.querySelector('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-ring-cpu"]')?.getAttribute("stroke-dasharray") ?? "";
        return /^\d+(\.\d+)? \d+(\.\d+)?$/.test(d);
      }));
    const pts0 = await cpuPts(page, PROD);
    await page.waitForFunction(
      (n) => (document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-spark.cpu polyline')?.points.length ?? 0) > n,
      pts0, { timeout: 9000 });
    ck.check("CPU 折线随采样增长", true, `${pts0} → 增长`);

    // ── CPU 走势图：标签 + 时间轴（此前磁盘下的光秃折线没名没轴，用户认不出）──
    ck.check("折线有标签：CPU 走势",
      await page.evaluate(() =>
        document.querySelector('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-chart-cpu"] .mon-lab')?.textContent.includes("CPU") ?? false));
    const axis0 = await page.evaluate(() =>
      document.querySelector('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-axis-cpu"]')?.textContent.trim() ?? "");
    ck.check("时间轴标注窗口与「现在在最右」", /^近 .+ · 现在在最右$/.test(axis0), axis0);

    // ── NPU 开关：关时无 NPU 区；开后 prod-1（仿真 Ascend）两颗 910B2C，
    //    staging-1（NO_NPU）依旧无 ──
    ck.check("NPU 开关未开：prod-1 无 NPU 区（即便该机有 npu-smi）",
      !(await page.$(`${prod} [data-testid="mon-npu"]`)));
    await page.click('[data-testid="mon-sw-npu"]');
    await page.waitForSelector('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-npu"]', { timeout: 9000 });
    const npuChips = await page.evaluate(() =>
      [...document.querySelectorAll('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-npu-chip"]')]
        .map((n) => n.textContent.replace(/\s+/g, " ")));
    ck.check("prod-1 NPU 区两颗芯片", npuChips.length === 2, JSON.stringify(npuChips));
    ck.check("芯片行含型号/健康/功耗/温度/HBM",
      npuChips.some((t) => t.includes("910B2C") && t.includes("OK") && /W/.test(t) && /°C/.test(t) && /HBM/.test(t)),
      npuChips[0] ?? "null");
    ck.check("Warning 芯片徽标着色（.bad）",
      await page.evaluate(() =>
        [...document.querySelectorAll('[data-mon-key="ops@10.0.0.11:22"] .mon-hbadge')]
          .some((n) => n.textContent === "Warning" && n.classList.contains("bad"))));
    ck.check("staging-1（NO_NPU）无 NPU 区", !(await page.$(`${stg} [data-testid="mon-npu"]`)));

    // ── 开关轮核心证明：关大屏 → 后台折线仍增长 → 重开历史直接在 ──
    const ptsClose = await cpuPts(page, PROD);
    await page.click('[data-testid="monitor-close"]');
    await page.waitForTimeout(300);
    ck.check("大屏已收（rail 熄灭但呼吸点仍在——采集不停）",
      !(await vis(page, '[data-testid="monitor-view"]')) && !(await openCls(page, "rail-monitor"))
      && await vis(page, '[data-testid="rail-monitor-live"]'));
    await page.waitForTimeout(4500); // ≥1 个采样周期（3s），关屏期间至少新增一拍
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(400);
    await page.waitForFunction(
      (n) => (document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-spark.cpu polyline')?.points.length ?? 0) > n,
      ptsClose, { timeout: 2500 });
    ck.check("后台持续采集：重开即见关屏期间新增样本（不从头打点）", true, `${ptsClose} → 重开即 >`);
    // 只开 NPU 的机器：关通用后基础区让位给说明，NPU 区保留
    await page.click('[data-testid="mon-sw-general"]');
    await page.waitForTimeout(400);
    ck.check("只开 NPU：基础区说明 + NPU 区保留",
      await page.evaluate(() =>
        document.querySelector('[data-mon-key="ops@10.0.0.11:22"] .mon-card-body')?.textContent.includes("通用监控未开启") ?? false)
      && !!(await page.$(`${prod} [data-testid="mon-npu"]`)));
    await page.click('[data-testid="mon-sw-general"]');
    await page.waitForTimeout(400);

    // ── 暂停可切换（demo 域只断言开关状态；停采由真实后端验证） ──
    const pressed0 = await page.evaluate(() =>
      document.querySelector('[data-testid="monitor-pause"]')?.getAttribute("aria-pressed"));
    await page.click('[data-testid="monitor-pause"]');
    await page.waitForTimeout(200);
    const pressed1 = await page.evaluate(() =>
      document.querySelector('[data-testid="monitor-pause"]')?.getAttribute("aria-pressed"));
    ck.check("暂停钮 aria-pressed 切换", pressed0 !== pressed1, `${pressed0} → ${pressed1}`);
    await page.click('[data-testid="monitor-pause"]');
    await page.waitForTimeout(200);

    // ── 点卡片头：跳该机终端并收起大屏 ──
    await page.click(`${stg} .mon-card-head`);
    await page.waitForTimeout(400);
    ck.check("点卡片头收起大屏",
      !(await vis(page, '[data-testid="monitor-view"]')) && !(await openCls(page, "rail-monitor")));
    ck.check("活动标签切到 staging-1",
      await page.evaluate(() =>
        [...document.querySelectorAll(".tab.tab-active")].some((x) => x.textContent.includes("staging-1"))));

    // ── 关一条 prod-1 连接：卡片保留、×2 徽标退场（大屏已收——上一步卡头跳出；
    // 同名两条 Connected 关一条走确认框；会话清单 3s 轮询，等计数掉后缀）──
    await closeViaMenu(page, "prod-1");
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(400);
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="monitor-count"]')?.textContent ?? "").includes("3 条连接"),
      null, { timeout: 8000 });
    const cnt1 = await countText(page);
    ck.check("关一条后：2 台服务器（合并数=连接数，无「条连接」后缀）",
      cnt1.includes("2 台服务器") && !cnt1.includes("条连接"), cnt1);
    ck.check("×2 徽标随退（剩一条连接）",
      await page.evaluate((sel) => !document.querySelector(`${sel} [data-testid="mon-dup"]`), prod));

    // ── 关全部 staging-1（开机自带一个 Disconnected 同名标签——逐个关到 absent）：
    // 卡片随退 ──
    await page.click('[data-testid="monitor-close"]');
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      if (!(await page.evaluate(() => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes("staging-1"))))) break;
      await closeViaMenu(page, "staging-1");
    }
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(400);
    await page.waitForFunction(
      () => !document.querySelector('[data-mon-key="ops@10.0.0.13:22"]'),
      null, { timeout: 8000 });
    ck.check("关闭 staging-1 后卡片随退", (await cardSel(page, STG)) === null);
    const cnt2 = await countText(page);
    ck.check("计数回落为 1 台服务器", cnt2.includes("1 台服务器"), cnt2);

    // ── 刷新恢复：ui.monitorbar=1 大屏仍开；采集开关持久（aria-pressed）且
    //    采集自动续上（卡片与 NPU 区随后出现）──
    await page.reload();
    await page.waitForTimeout(900);
    ck.check("刷新后大屏保持打开 + 两开关保持开启",
      (await openCls(page, "rail-monitor")) && (await vis(page, '[data-testid="monitor-view"]'))
      && (await swOn(page, "mon-sw-general")) && (await swOn(page, "mon-sw-npu")));
    await page.waitForFunction(
      () => !!document.querySelector('[data-mon-key="ops@10.0.0.11:22"]'),
      null, { timeout: 8000 });
    ck.check("刷新后采集自动续上：prod-1 卡片回归",
      !!(await cardSel(page, PROD)) && await vis(page, '[data-testid="rail-monitor-live"]'));
    await page.waitForSelector('[data-mon-key="ops@10.0.0.11:22"] [data-testid="mon-npu"]', { timeout: 9000 });
    ck.check("刷新后 NPU 区自动重现（开关驱动而非面板驱动）", true);

    // ── 互斥另一半：点开连接，大屏收起；再点大屏，主机栏收起 ──
    await page.click('[data-testid="rail-hosts"]');
    await page.waitForTimeout(400);
    ck.check("点开连接：大屏收起",
      !(await openCls(page, "rail-monitor")) && (await openCls(page, "rail-hosts")));
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(400);
    ck.check("再点大屏：主机栏收起",
      (await openCls(page, "rail-monitor")) && !(await openCls(page, "rail-hosts")));

    // ── 收尾：点 prod-1 卡头跳出大屏回终端 ──
    await page.click(`${await cardSel(page, PROD)} .mon-card-head`);
    await page.waitForTimeout(400);
    ck.check("卡头跳出：大屏收起且活动标签是 prod-1",
      !(await vis(page, '[data-testid="monitor-view"]')) &&
      await page.evaluate(() => [...document.querySelectorAll(".tab.tab-active")].some((x) => x.textContent.includes("prod-1"))));
  },
};
