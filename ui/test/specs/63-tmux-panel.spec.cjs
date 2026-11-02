// 63 tmux 面板（一标签多 tmux 会话）：快接钮「＋面板」把其他 tmux 会话并入本标签
// （同连接附加交互通道，主视图零扰动）。覆盖：paneGrid 网格几何真值表（直连 .mjs）、
// 开格首屏积压补放、格子输出/输入与主视图分流（demo 回显循环）、Ctrl 控制字符经
// 窗口捕获层改投格子、防呆矩阵（同名格/撞主视图/未知会话/反向 attach）、格内右键
// 关格（detach 语义 + 旧快照不闪回）、掉线保留蒙灰 + 重连原位换装（pane_id 更新）、
// 面板在场时断线横幅缩半宽、远端结束摘格。demo 镜像：demo_tmux_fixture 造多会话
// 清单、demo_pane_exit 造远端结束（用户在格子里 exit / C-b d）。
const SID = "s-demo-0001";

/** 逐行扫终端缓冲（xterm 走 WebGL 画布，DOM 文本读不到——只能读 buffer）。 */
const bufHas = (page, which, key, needle) =>
  page.evaluate(({ which, key, needle }) => {
    const m = which === "pane" ? window.__t_pane_terms : window.__t_terms;
    const t = m && m.get(key);
    if (!t) return false;
    const b = t.buffer.active;
    for (let i = Math.max(0, b.length - 300); i < b.length; i++) {
      if ((b.getLine(i)?.translateToString(true) ?? "").includes(needle)) return true;
    }
    return false;
  }, { which, key, needle });

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

const cellOf = (page, name) =>
  page.evaluate((n) => {
    const c = document.querySelector(`.tmux-cell[data-tmux="${n}"]`);
    return c ? { id: c.dataset.paneId, shown: c.style.display === "flex", dead: c.classList.contains("dead") } : null;
  }, name);

const invokeErr = (page, cmd, args) =>
  page.evaluate(async ({ cmd, args }) => {
    try { await window.__demoInvoke(cmd, args); return null; }
    catch (e) { return String(e?.message ?? e); }
  }, { cmd, args });

/** 主视图元素相对 #term 的宽占比（网格 slot 0 几何断言用） */
const mainWidthFrac = (page) =>
  page.evaluate((sid) => {
    const el = document.querySelector(`.term-session[data-sid="${sid}"]`);
    const box = document.getElementById("term")?.getBoundingClientRect();
    if (!el || !box || box.width === 0) return -1;
    return el.getBoundingClientRect().width / box.width;
  }, SID);

module.exports = {
  title: "tmux 面板：网格几何/开格/分流/Ctrl 改投/防呆/右键关格/掉线换装/横幅/远端结束",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    // ── 0. paneGrid 真值表（直连 ui/src/terminal/pane-grid.mjs，与 App 布局同一实现）──
    const { paneGrid } = await import("../../src/terminal/pane-grid.mjs");
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const g1 = paneGrid(1), g2 = paneGrid(2), g3 = paneGrid(3), g4 = paneGrid(4), g5 = paneGrid(5), g6 = paneGrid(6);
    ck.check("paneGrid n=1：单格全幅", g1.length === 1 && near(g1[0].width, 1) && near(g1[0].height, 1), JSON.stringify(g1));
    ck.check("paneGrid n=2：左右两半", near(g2[0].width, 0.5) && near(g2[1].left, 0.5) && near(g2[1].height, 1), JSON.stringify(g2));
    ck.check("paneGrid n=3：两列，末行一格均分整行", near(g3[1].left, 0.5) && near(g3[2].top, 0.5) && near(g3[2].width, 1), JSON.stringify(g3));
    ck.check("paneGrid n=4：2×2 田字", near(g4[3].left, 0.5) && near(g4[3].top, 0.5) && near(g4[3].width, 0.5), JSON.stringify(g4));
    ck.check("paneGrid n=5：三列，末行两格各占一半", near(g5[0].width, 1 / 3) && near(g5[3].top, 0.5) && near(g5[3].width, 0.5) && near(g5[4].left, 0.5), JSON.stringify(g5));
    ck.check("paneGrid n=6：3×2 满格", near(g6[5].left, 2 / 3) && near(g6[5].top, 0.5) && near(g6[5].width, 1 / 3), JSON.stringify(g6));
    ck.check("paneGrid 非法入参兜底为单格", paneGrid(0).length === 1 && paneGrid(NaN).length === 1, "");

    // ── A. prod-1：远端清单扩成三会话（work/logs/build）──
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs", "build"] }), SID);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(800);
    ck.check("快接菜单展开", await openQuickMenu(page), "");
    ck.check("菜单三会话行，每行带「＋面板」钮",
      await poll(page, () => document.querySelectorAll('[data-testid="tmux-quick-menu"] .tmux-quick-row').length === 3
        && document.querySelectorAll('[data-testid^="tmux-pane-add-"]').length === 3, null, 4000), "");

    // ── B. 主视图 attach work（造「主视图占用」），等 3s 清单下发 tmux_attached（坑 82）──
    await page.click('[data-testid="tmux-quick-item-work"]');
    ck.check("主视图 attach work（恢复现场 toast）", await waitToast(page, "已恢复现场（tmux work"), "");
    ck.check("快接钮面换装为 tmux:work（随 3s 清单轮询下发）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work"), null, 6000), "");
    await openQuickMenu(page);
    ck.check("防呆：主视图占用的 work 行「＋面板」禁用，logs 行可用",
      await page.evaluate(() => document.querySelector('[data-testid="tmux-pane-add-work"]')?.disabled === true
        && document.querySelector('[data-testid="tmux-pane-add-logs"]')?.disabled === false), "");

    // ── C. 并入 logs：开格 + 首屏积压补放 + 网格几何 ──
    await page.click('[data-testid="tmux-pane-add-logs"]');
    ck.check("开格 toast：已并入面板：logs", await waitToast(page, "已并入面板：logs"), "");
    ck.check("格子出现且可见（display:flex）", await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"]')?.style.display === "flex", null, 5000), "");
    const c1 = await cellOf(page, "logs");
    const k1 = `${SID}:${c1?.id}`;
    ck.check("首屏积压补放：attach 标题行进格子缓冲", await bufHas(page, "pane", k1, "tmux -u attach -t '=logs'"), k1);
    ck.check("输出分流：主视图缓冲不含格子首屏", !(await bufHas(page, "main", SID, "tmux -u attach -t '=logs'")), "");
    const wf = await mainWidthFrac(page);
    ck.check("网格几何：主视图压到左半（slot 0）", Math.abs(wf - 0.5) < 0.02, `frac=${wf.toFixed(3)}`);
    ck.check("#term 标 has-tmux-panes", await page.evaluate(() => document.getElementById("term").classList.contains("has-tmux-panes")), "");

    // ── D. 格子输入直达格子通道；Ctrl 控制字符经窗口捕获层改投格子 ──
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), k1);
    await page.waitForTimeout(200);
    await page.keyboard.type("echo hi");
    await page.keyboard.press("Enter");
    ck.check("格子输入回显在格子（[演示] logs: echo hi）",
      await pollAsync(() => bufHas(page, "pane", k1, "[演示] logs: echo hi"), 4000, page), "");
    ck.check("主视图无该输入（不经主会话 send_keys）", !(await bufHas(page, "main", SID, "[演示] logs: echo hi")), "");
    await page.keyboard.press("Control+c");
    ck.check("Ctrl+C 改投格子（格子回显 ^C）", await pollAsync(() => bufHas(page, "pane", k1, "^C"), 3000, page), "");

    // ── E. 防呆矩阵（核心侧口径，demo 逐条镜像）──
    const dupErr = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "logs" });
    ck.check("防呆：同名格拒绝", (dupErr ?? "").includes("面板已包含会话 logs"), dupErr ?? "未拒绝");
    const mainErr = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "work" });
    ck.check("防呆：撞主视图拒绝（同一会话不做两路视图）", (mainErr ?? "").includes("两路视图"), mainErr ?? "未拒绝");
    const ghostErr = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "nope" });
    ck.check("防呆：未知会话拒绝", (ghostErr ?? "").includes("tmux 会话不存在"), ghostErr ?? "未拒绝");
    const revErr = await invokeErr(page, "tmux_attach", { sid: SID, session: "logs" });
    ck.check("反向防呆：已在格子里的会话不挂主视图", (revErr ?? "").includes("已在面板窗格中"), revErr ?? "未拒绝");
    await openQuickMenu(page);
    ck.check("菜单：logs 行标「面板中」且主项与「＋面板」均禁用",
      await page.evaluate(() => {
        const item = document.querySelector('[data-testid="tmux-quick-item-logs"]');
        return !!item && item.disabled === true && (item.textContent ?? "").includes("面板中")
          && document.querySelector('[data-testid="tmux-pane-add-logs"]')?.disabled === true;
      }), "");
    await page.keyboard.press("Escape");

    // ── F. 格内右键 → 关闭窗格（detach 语义；旧快照不闪回）──
    const hdr = await page.evaluate(() => {
      const r = document.querySelector('.tmux-cell[data-tmux="logs"] .tmux-cell-head').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 3), y: Math.round(r.y + r.height / 2) };
    });
    await page.mouse.click(hdr.x, hdr.y, { button: "right" });
    ck.check("格内右键菜单（含「关闭窗格」）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-cell-menu"]')?.textContent ?? "").includes("关闭窗格"), null, 2000), "");
    await page.click('[data-testid="tmux-cell-menu-close"]');
    ck.check("关格 toast：tmux 会话仍在运行", await waitToast(page, "已关闭窗格：logs（tmux 会话仍在运行）"), "");
    ck.check("格子移除、主视图回全幅",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 4000)
      && Math.abs((await mainWidthFrac(page)) - 1) < 0.02, "");
    await page.waitForTimeout(3500);
    ck.check("跨一轮 3s 快照：格子不闪回", !(await cellOf(page, "logs")), "");

    // ── G. 掉线保留蒙灰 + 重连原位换装 ──
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-pane-add-logs"]');
    await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"]')?.style.display === "flex", null, 5000);
    const before = (await cellOf(page, "logs"))?.id;
    await page.evaluate((sid) => window.__demoInvoke("demo_drop_session", { sid, recoverOnAttempt: 0 }), SID);
    ck.check("掉线：格子保留且蒙灰（dead）",
      await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"]')?.classList.contains("dead") === true, null, 8000), "");
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), `${SID}:${before}`);
    await page.keyboard.type("z");
    ck.check("掉线格子拦截键入（窗格已断开——键入未发送）",
      await pollAsync(() => bufHas(page, "pane", `${SID}:${before}`, "窗格已断开——键入未发送"), 3000, page), "");

    // ── H. 面板在场时断线横幅缩半宽居右（格子不被整盖）──
    await page.evaluate((sid) => window.__demoInvoke("stop_auto_reconnect", { sid }), SID);
    ck.check("断线横幅缩半宽居右",
      await poll(page, () => {
        const ov = document.querySelector(".dead-overlay");
        return !!ov && getComputedStyle(ov).justifyContent === "flex-end";
      }, null, 6000), "");
    await page.evaluate((sid) => window.__demoInvoke("reconnect_session", { sid }), SID);
    ck.check("重连：原位换装（pane_id 更新、格子仍标 logs、不再蒙灰）",
      await poll(page, (b) => {
        const c = document.querySelector('.tmux-cell[data-tmux="logs"]');
        return !!c && c.dataset.paneId !== b && !c.classList.contains("dead");
      }, before, 9000), `before=${before} after=${(await cellOf(page, "logs"))?.id}`);
    const after = (await cellOf(page, "logs"))?.id;
    ck.check("换装后新格首屏标「重连后原位重建」",
      await pollAsync(() => bufHas(page, "pane", `${SID}:${after}`, "重连后原位重建"), 4000, page), "");

    // ── I. 远端结束摘格（用户在格子里 exit / C-b d：核心 exited 臂）──
    // 真机走查实锤：旧对账给所有格子按出生算 6s 宽限，重建换装出的新格（此刻刚出生）
    // 一结束要挂到「出生 6s + 下一轮 3s 轮询」才收。现=流终结信号即刻对账 + 快照请求
    // 时刻判定缺席，1.2s 内必须收掉（宽限回归时此处确定性转红：该格出生不足 6s）。
    await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: Number(id) }), { sid: SID, id: after });
    ck.check("远端结束：格子即刻摘除（流终结信号 + 快照请求时刻判定，不挂 6s 宽限）",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 1200), "");

    // ── J. 会话关闭：格子随之全部收起（流终结信号逐格到达）──
    await page.evaluate((sid) => window.__demoInvoke("tmux_pane_open", { sid, session: "logs", cols: 80, rows: 24 }), SID);
    ck.check("关会话前：格子经快照对账建出",
      await poll(page, () => !!document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 5000), "");
    await page.evaluate((sid) => window.__demoInvoke("close_session", { sid }), SID);
    ck.check("关会话：格子 1.2s 内全部收起",
      await poll(page, () => document.querySelectorAll(".tmux-cell").length === 0, null, 1200), "");
  },
};
