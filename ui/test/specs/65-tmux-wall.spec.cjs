// 65 tmux 会话大屏（监控墙）：快接菜单「会话大屏…」→ 全部 tmux 会话的快照
// 网格（像监控多路摄像头：2×2/3×3/4×4、单击放大、Esc 还原/关屏、「进格子」去
// 工作台）。与面板格子的分工：格子=活 PTY 可交互；大屏=每 300ms 一拍
// capture-pane 快照（零客户端零 PTY；在飞守卫自适应 RTT）+ **键入走 tmux
// send-keys 服务端 API**（可见字符 150ms 批量、特殊键冲刷即发、发送+单格补拍
// 一趟往返；Esc 在键入焦点下先发给会话）。
// 覆盖：demo 抓取/键入命令契约（按名/按 id 命中、ghost=离线、目标未知名退化失
// 败、坏 sid 拒绝、抓取/键入计数器）、入口与网格规格（数量自适应 + 手动 2/3/4）、
// 快照渲染、轮询节拍与关屏即停、放大+键入焦点/字面回显/Enter 提交/Ctrl+C/Esc
// 先发会话/点空白退键入、进格子（复用面板链路：开格+收屏+防呆 toast）、清单改
// 名跟随、离线遮罩、>9 会话自适应。交互模型（用户拍板）：**单击小窗=就地键入不放大**；
// 放大=格子右上放大钮/双击（保留外框+框上还原钮，与面板格子同款）。
const SID = "s-demo-0001";

/** 大屏格子文本读（ANSI→HTML 直出后无 xterm 缓冲，直接读 .tw-pre 文本）。 */
const wallTextHas = (page, name, needle) =>
  page.evaluate(({ name, needle }) => {
    const el = document.querySelector(`[data-testid="tmux-wall-cell-${name}"] .tw-pre`);
    return el ? (el.textContent ?? "").includes(needle) : false;
  }, { name, needle });

const wallCellCount = (page) =>
  page.evaluate(() => document.querySelectorAll(".tw-cell").length);

const fetches = (page) => page.evaluate(() => window.__wall_fetches ?? 0);

/** Node 侧轮询 evaluate（坑 55：不用 waitForFunction）。 */
const poll = async (page, fn, arg, tmo = 5000) => {
  const dl = Date.now() + tmo;
  while (Date.now() < dl) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await page.waitForTimeout(120);
  }
  return false;
};
const pollAsync = async (probe, tmo = 5000, page) => {
  const dl = Date.now() + tmo;
  while (Date.now() < dl) {
    if (await probe()) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

const waitToast = (page, substr, timeout = 7000) =>
  poll(page, (s) => [...document.querySelectorAll(".toast")].some((e) => (e.textContent ?? "").includes(s)), substr, timeout);

const openQuickMenu = async (page) => {
  await page.evaluate(() => {
    const open = !!document.querySelector('[data-testid="tmux-quick-menu"]');
    const btn = document.querySelector('[data-testid="tmux-quick"] button');
    if (btn && !open) btn.click();
  });
  return poll(page, () => !!document.querySelector('[data-testid="tmux-quick-menu"]'), null, 2000);
};

/** 等快接钮在位（夹具改清单后随 3s 会话轮询下发——坑 82 同族）→ 开菜单 →
 *  等「会话大屏…」入口 → 真鼠标点开 → 等覆盖层在位。 */
const openWall = async (page, rows) => {
  await poll(page, () => !!document.querySelector('[data-testid="tmux-quick"]'), null, 6000);
  if (!await openQuickMenu(page)) return false;
  await poll(page, () => document.querySelectorAll('[data-testid="tmux-quick-menu"] .tmux-quick-row').length === rows, null, 6000);
  await page.click('[data-testid="tmux-wall-open"]');
  return poll(page, () => !!document.querySelector('[data-testid="tmux-wall"]'), null, 4000);
};
const closeWall = async (page) => {
  await page.click('[data-testid="tmux-wall-close"]');
  return poll(page, () => !document.querySelector('[data-testid="tmux-wall"]'), null, 3000);
};
const fixture = (page, names) =>
  page.evaluate(({ sid, names }) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: names }), { sid: SID, names });

/** 元素内一点（fx/fy 元素内相对位）的视口坐标——真鼠标点击用（坑 90）。 */
const ptIn = (page, sel, fx = 0.5, fy = 0.5) =>
  page.evaluate(({ sel, fx, fy }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, { sel, fx, fy });

const gridCols = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="tmux-wall"] .tw-body')?.style.gridTemplateColumns ?? "");

module.exports = {
  title: "tmux 会话大屏（监控墙）：抓取契约/入口/网格规格/快照渲染/轮询与关屏停拍/放大与 Esc/进格子/改名跟随/离线遮罩/超九自适应",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    // ── 0. demo 抓取命令契约（直连 __demoInvoke，UI 未开屏也能验）──
    await fixture(page, ["work", "logs", "build"]);
    const got3 = await page.evaluate(async (sid) => window.__demoInvoke("tmux_wall_snapshot", {
      sid,
      targets: [{ id: "$1", name: "work" }, { id: "", name: "logs" }, { id: "", name: "build" }],
    }), SID);
    ck.check("抓取契约：三目标全 ok，快照文本带会话名",
      Array.isArray(got3) && got3.length === 3 && got3.every((c) => c.ok)
      && (got3[0].text ?? "").includes("work 当前屏快照") && (got3[1].text ?? "").includes("logs 当前屏快照"),
      JSON.stringify(got3)?.slice(0, 120));
    const byId = await page.evaluate(async (sid) => window.__demoInvoke("tmux_wall_snapshot", {
      sid, targets: [{ id: "$2", name: "名字故意的" }],
    }), SID);
    ck.check("抓取契约：id 在手按 id 命中（名字不对也认 id，改名不跟丢的镜像）",
      byId.length === 1 && byId[0].ok && (byId[0].text ?? "").includes("logs 当前屏快照"), JSON.stringify(byId));
    const f0 = await fetches(page);
    const badSid = await page.evaluate(async () => {
      try { await window.__demoInvoke("tmux_wall_snapshot", { sid: "s-none", targets: [] }); return null; }
      catch (e) { return String(e?.message ?? e); }
    });
    ck.check("抓取契约：坏 sid 拒绝且不计数（计数=进入抓取流程的拍数）",
      (badSid ?? "").includes("会话不存在") && (await fetches(page)) === f0, badSid ?? "未拒绝");

    // ── A. 入口与展开：夹具三会话 → 快接菜单「会话大屏…」→ 覆盖层 ──
    await fixture(page, ["work", "logs", "build"]);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    ck.check("大屏展开（覆盖层在位，头副行带主机名与数量）",
      await openWall(page, 3)
      && await poll(page, () => (document.querySelector('[data-testid="tmux-wall"] .tw-sub')?.textContent ?? "").includes("· 3"), null, 2000), "");
    ck.check("网格规格：3 会话自适应 2×2（≤4 走 2 列）", (await gridCols(page)).includes("repeat(2"), await gridCols(page));
    await page.waitForTimeout(400);

    // ── B. 快照渲染：三格、静态 xterm 缓冲可读 ──
    ck.check("三格渲染（cell 数=3）",
      await poll(page, () => document.querySelectorAll(".tw-cell").length === 3, null, 3000)
      && (await wallCellCount(page)) === 3, "");
    ck.check("快照文本进格子 DOM（work 格含演示快照行）",
      await pollAsync(() => wallTextHas(page, "work", "work 当前屏快照"), 3000, page), "");

    // ── C. 轮询节拍：300ms 一拍（v2 轮 2s→300ms——回归网必须能红：1s 窗 ≥2 拍
    // 在 2s 旧节拍下最多 1 拍必失败；≥2 而非 ≥3 留在飞守卫/慢链路余量，坑 66 族）──
    const c0 = await fetches(page);
    await page.waitForTimeout(2400);
    ck.check("轮询节拍：挂载期计数增长（≥1 拍）", (await fetches(page)) > c0, `f=${c0}→${await fetches(page)}`);
    const c1 = await fetches(page);
    await page.waitForTimeout(1000);
    ck.check("节拍 300ms 级（1s 窗 ≥2 拍——2s 旧节拍此断言必红）",
      (await fetches(page)) - c1 >= 2, `f=${c1}→${await fetches(page)}`);

    // ── D. 网格规格手动切 ──
    await page.click('[data-testid="tmux-wall-size-2"]');
    await page.waitForTimeout(150);
    const g2 = await gridCols(page);
    await page.click('[data-testid="tmux-wall-size-4"]');
    await page.waitForTimeout(150);
    const g4 = await gridCols(page);
    await page.click('[data-testid="tmux-wall-size-3"]');
    await page.waitForTimeout(150);
    ck.check("网格规格：手动 2/4/3 列即时切换", g2.includes("repeat(2") && g4.includes("repeat(4") && (await gridCols(page)).includes("repeat(3"),
      `${g2} → ${g4}`);

    // ── E. 就地键入 + 放大钮（用户拍板的交互模型）：**单击小窗=就地键入，不放大**；
    // 可见字符 150ms 批量、Enter/C-c 特殊键冲刷即发；放大只走格子右上放大钮/双击
    // （保留外框，框上还原钮）；Esc 在键入焦点下先发给会话；点头部空白退键入后，
    // Esc 才逐级退出（放大→关屏）──
    const shotLogs = await ptIn(page, '[data-testid="tmux-wall-cell-logs"] .tw-shot');
    const in0 = await page.evaluate(() => window.__wall_inputs ?? 0);
    await page.mouse.click(shotLogs.x, shotLogs.y);
    await page.waitForTimeout(250);
    const act1 = await page.evaluate(() => ({
      solo: document.querySelector('[data-testid="tmux-wall"]')?.classList.contains("solo") ?? false,
      active: !!document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-active'),
      input: !!document.querySelector('[data-testid="tmux-wall-input-logs"]'),
      maxBtn: document.querySelector('[data-testid="tmux-wall-max-logs"]') !== null,
      promoteAfterMax: (() => { const b = [...document.querySelectorAll('[data-testid="tmux-wall-cell-logs"] button')]; return b.length >= 2; })(),
    }));
    ck.check("单击小窗：就地键入（不放大！tw-active + 隐藏输入框在位 + 放大钮在格上）",
      !act1.solo && act1.active && act1.input && act1.maxBtn, JSON.stringify(act1));
    await page.keyboard.type("echo hi");
    await page.waitForTimeout(400); // 150ms 批量冲刷 + 补拍回包
    ck.check("字面键入回显进格子（输入行 [输入中] echo hi）",
      await pollAsync(() => wallTextHas(page, "logs", "[输入中] echo hi"), 2500, page), "");
    ck.check("键入走 send-keys 通道（__wall_inputs +1）",
      (await page.evaluate(() => window.__wall_inputs ?? 0)) === in0 + 1,
      `${in0}→${await page.evaluate(() => window.__wall_inputs ?? 0)}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    ck.check("Enter 提交：输入行清空（[输入中] 消失、屏行 echo hi 保留）",
      await pollAsync(async () =>
        !(await wallTextHas(page, "logs", "[输入中]")) && await wallTextHas(page, "logs", "echo hi"), 2500, page), "");
    // ── E2. 粘贴审批链：墙走 send-keys -l 字面通道（无 bracketed paste），多行
    // 粘贴的换行会被远端立即执行——必须先弹确认卡，取消/确认各走一条路。
    const inPaste = await page.evaluate(() => window.__wall_inputs ?? 0);
    const firePaste = (text) => page.evaluate((txt) => {
      const el = document.querySelector('[data-testid="tmux-wall-input-logs"]');
      const dt = new DataTransfer();
      dt.setData("text/plain", txt);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await firePaste("echo one\necho two");
    await page.waitForTimeout(250);
    const pasteDlg = await page.evaluate(() => !!document.querySelector('[data-testid="paste-dialog-title"]'));
    ck.check("墙多行粘贴先弹确认卡（未发送任何字节）",
      pasteDlg && (await page.evaluate(() => window.__wall_inputs ?? 0)) === inPaste,
      `dlg=${pasteDlg}`);
    await page.click('[data-testid="paste-send"]');
    await page.waitForTimeout(500);
    ck.check("确认后粘贴整段送达（一次 send，回显进格子）",
      (await page.evaluate(() => window.__wall_inputs ?? 0)) === inPaste + 1
      && await pollAsync(() => wallTextHas(page, "logs", "echo one"), 2500, page),
      `${inPaste}→${await page.evaluate(() => window.__wall_inputs ?? 0)}`);
    await page.keyboard.type("tail -f x");
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(400);
    ck.check("Ctrl+C：^C 落屏 + 输入行清空",
      await pollAsync(async () =>
        await wallTextHas(page, "logs", "^C") && !(await wallTextHas(page, "logs", "[输入中]")), 2500, page), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const escKeep = await page.evaluate(() => ({
      open: !!document.querySelector('[data-testid="tmux-wall"]'),
      solo: document.querySelector('[data-testid="tmux-wall"]')?.classList.contains("solo") ?? false,
    }));
    ck.check("键入焦点下 Esc 先发给会话（屏不关、也没放大）",
      escKeep.open && !escKeep.solo
      && (await page.evaluate(() => window.__wall_inputs ?? 0)) === in0 + 5, // echo hi 批量+Enter+粘贴+tail^C+Esc
      JSON.stringify(escKeep));
    // 放大钮：保留外框的 solo（框=标题栏 + 还原钮换装）
    await page.click('[data-testid="tmux-wall-max-logs"]');
    await page.waitForTimeout(250);
    const z1 = await page.evaluate(() => ({
      solo: document.querySelector('[data-testid="tmux-wall"]')?.classList.contains("solo") ?? false,
      cell: !!document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-solo'),
      otherHidden: getComputedStyle(document.querySelector('[data-testid="tmux-wall-cell-work"]') ?? document.body).display === "none",
      headKept: !!document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-solo .tw-cell-head'),
      restoreTitle: document.querySelector('[data-testid="tmux-wall-max-logs"]')?.getAttribute("title") ?? "",
      active: !!document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-active'),
    }));
    ck.check("放大钮：solo 态（他格隐藏、外框标题栏保留、钮换装「还原」、键入焦点跟入）",
      z1.solo && z1.cell && z1.otherHidden && z1.headKept && z1.restoreTitle.includes("还原") && z1.active, JSON.stringify(z1));
    // 还原钮回网格
    await page.click('[data-testid="tmux-wall-max-logs"]');
    await page.waitForTimeout(250);
    const z2 = await page.evaluate(() => ({
      solo: document.querySelector('[data-testid="tmux-wall"]')?.classList.contains("solo") ?? false,
      title0: document.querySelector('[data-testid="tmux-wall-max-logs"]')?.getAttribute("title") ?? "",
      active: !!document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-active'),
    }));
    ck.check("还原钮：回网格、钮换回「放大」、键入焦点不丢", !z2.solo && z2.title0.includes("放大") && z2.active, JSON.stringify(z2));
    await page.click('[data-testid="tmux-wall"] .tw-sub'); // 头部空白（非钮）→ 退键入
    await page.waitForTimeout(200);
    const deact = await page.evaluate(() => !document.querySelector('[data-testid="tmux-wall-cell-logs"].tw-active'));
    ck.check("头部空白点击退键入（tw-active 消失）", deact, String(deact));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    ck.check("无键入焦点 Esc：关屏（覆盖层撤）",
      await poll(page, () => !document.querySelector('[data-testid="tmux-wall"]'), null, 2000), "");

    // ── F. 关屏即停：等至少一拍完成 → 记数 → 关屏 → 2.4s 计数不动 ──
    ck.check("重开大屏（Esc 关屏后入口仍可用）", await openWall(page, 3), "");
    const fBase = await fetches(page);
    // 前置条件必须自己断言：重开实例若一拍都没拍（轮询回归），f1===fBase 且关屏
    // 后计数自然不动——「停拍」恒真，测不到想测的东西（坑 74 族）
    const gotBeat = await pollAsync(async () => (await fetches(page)) > fBase, 3000, page);
    ck.check("重开后至少一拍完成（停拍断言的前置）", gotBeat === true, `fBase=${fBase} got=${gotBeat}`);
    const f1 = await fetches(page);
    ck.check("✕ 钮关屏", await closeWall(page), "");
    await page.waitForTimeout(2400);
    ck.check("关屏即停拍（计数冻结——后台不空开枪）", (await fetches(page)) === f1, `f=${f1}→${await fetches(page)}`);

    // ── F2. pane 贴格子：开屏 400ms 防抖发 fit（差量去重）→ 夹具 wallRows 跟随。
    // contain 对宽高比失衡只能 letterbox（htop 缩块沉底=用户复验的「没全屏」），
    // 贴格子后 pane 长成格子形状、TUI 自己重绘满格 ──
    const fits0 = await page.evaluate(() => (window.__wall_fits ?? []).length);
    ck.check("重开大屏（fit 前置）", await openWall(page, 3), "");
    // pollAsync 恒返布尔（坑 74 族：探针自身口径先对齐），增量数组另行取证
    const fired = await pollAsync(async () =>
      (await page.evaluate(() => (window.__wall_fits ?? []).length)) > fits0, 4000, page);
    const allFits = await page.evaluate(() => window.__wall_fits ?? []);
    ck.check("开屏触发 pane 贴格子（__wall_fits 增量）", fired === true, JSON.stringify(allFits));
    const newFits = allFits.slice(fits0);
    ck.check("fit 只发活格（ghost 离线格不发），尺寸在钳位域（≥12×5）",
      newFits.length >= 1 && newFits.every((f) => f.name !== "ghost" && f.cols >= 12 && f.rows >= 5),
      JSON.stringify(newFits));
    // pane_height 反馈环：fit 的 rows 落进夹具 → 下一拍快照 rows 字段跟随
    const fitWork = newFits.find((f) => f.name === "work");
    ck.check("pane_height 反馈环：work 格 rows 字段=fit 行数",
      !!fitWork && await pollAsync(async () => {
        const r = await page.evaluate(() =>
          Number(document.querySelector('[data-testid="tmux-wall-cell-work"] .tw-pre')?.dataset.rows ?? 0));
        return r === fitWork.rows;
      }, 3000, page), JSON.stringify({ fitWork }));
    // 关墙恢复：卸载把借走的几何+window-size 选项原样交还（resize-window 钉
    // manual 粘住，不还原=用户布局永久变形）；夹具 rows 回 fit 前原值
    const r0 = await page.evaluate(() => (window.__wall_restores ?? []).length);
    ck.check("关墙（恢复前置）", await closeWall(page), "");
    const rFire = await pollAsync(async () =>
      (await page.evaluate(() => (window.__wall_restores ?? []).length)) > r0, 3000, page);
    const allR = await page.evaluate(() => window.__wall_restores ?? []);
    ck.check("关墙触发恢复（__wall_restores 增量）", rFire === true, JSON.stringify(allR));
    const newR = allR.slice(r0);
    ck.check("恢复项原样=fit 前尺寸（work 回 24 行默认、ghost 不在其列）",
      newR.length >= 1 && newR.some((x) => x.name === "work" && x.rows === 24)
        && newR.every((x) => x.name !== "ghost"), JSON.stringify(newR));
    // 恢复反馈环：夹具 rows 已被交还回原值（墙已关，直接抓拍验证——不看 DOM）
    const snapAfter = await page.evaluate(async (sid) => {
      const r = await window.__demoInvoke("tmux_wall_snapshot", { sid, targets: [{ id: "$1", name: "work" }] });
      return r?.[0]?.rows ?? -1;
    }, SID);
    ck.check("恢复反馈环：work 夹具 rows 回 fit 前原值（24）", snapAfter === 24, `rows=${snapAfter}`);

    // ── G. 进格子：复用面板链路（开格 + 收屏）──
    ck.check("重开大屏（进格子前置）", await openWall(page, 3), "");
    await page.click('[data-testid="tmux-wall-promote-logs"]');
    ck.check("进格子 toast（复用 openTmuxPane 的防呆与回执）", await waitToast(page, "已并入面板：logs"), "");
    ck.check("大屏收起、面板格子就位（display:flex）",
      await poll(page, () => !document.querySelector('[data-testid="tmux-wall"]')
        && document.querySelector('.tmux-cell[data-tmux="logs"]')?.style.display === "flex", null, 6000), "");
    // 收拾：退掉 logs 格（demo_pane_exit=远端结束语义），给后续段干净面板
    const logsPane = await page.evaluate(() => {
      const c = document.querySelector('.tmux-cell[data-tmux="logs"]');
      return c ? Number(c.dataset.paneId) : -1;
    });
    if (logsPane >= 0) {
      await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: id }), { sid: SID, id: logsPane });
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 4000);
    }

    // ── H. 清单改名跟随：夹具改名（同序=同 id），大屏标题换新名 ──
    await fixture(page, ["work", "logs2", "build"]);
    ck.check("重开大屏（改名后清单三行）", await openWall(page, 3), "");
    ck.check("改名跟随：新名格在位、旧名格消失",
      await poll(page, () => !!document.querySelector('[data-testid="tmux-wall-cell-logs2"]')
        && !document.querySelector('[data-testid="tmux-wall-cell-logs"]'), null, 6000), "");
    await closeWall(page);

    // ── I. 离线遮罩：ghost（名单在、快照拍不到）→ 遮罩在位，正常格无遮罩 ──
    await fixture(page, ["work", "ghost"]);
    ck.check("重开大屏（ghost 夹具两行）", await openWall(page, 2), "");
    ck.check("离线遮罩：ghost 格带 .tw-off，work 格无遮罩",
      await poll(page, () => !!document.querySelector('[data-testid="tmux-wall-cell-ghost"] .tw-off')
        && !document.querySelector('[data-testid="tmux-wall-cell-work"] .tw-off'), null, 4000), "");
    await closeWall(page);

    // ── J. >9 会话自适应 4 列 ──
    await fixture(page, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"]);
    ck.check("重开大屏（十会话）", await openWall(page, 10), "");
    ck.check("十会话自适应 4 列（repeat(4)，格数=10）",
      (await gridCols(page)).includes("repeat(4")
      && await poll(page, () => document.querySelectorAll(".tw-cell").length === 10, null, 3000), await gridCols(page));
    await closeWall(page);

    // ── 收尾：清空面板与清单，不污染后续 spec ──
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work"] }), SID);
  },
};
