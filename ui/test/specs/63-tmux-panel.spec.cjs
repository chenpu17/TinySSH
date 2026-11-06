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

/** 终端缓冲里含 needle 的行数（「告示只出一次」类断言用）。 */
const bufCount = (page, which, key, needle) =>
  page.evaluate(({ which, key, needle }) => {
    const m = which === "pane" ? window.__t_pane_terms : window.__t_terms;
    const t = m && m.get(key);
    if (!t) return -1;
    const b = t.buffer.active;
    let n = 0;
    for (let i = Math.max(0, b.length - 300); i < b.length; i++) {
      if ((b.getLine(i)?.translateToString(true) ?? "").includes(needle)) n++;
    }
    return n;
  }, { which, key, needle });

/** 右键标签 → 菜单项（同 spec 30 的分屏入口）。 */
const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
};
const clickMenuItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};
const clickTab = (page, namePart) =>
  page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes(t));
    if (tab) tab.click();
  }, namePart);

/** 格子 xterm 尺寸与 fitPane 同口径的期望尺寸（正文盒子扣内边距 / 字格宽高）。 */
const paneFit = (page, key) =>
  page.evaluate((k) => {
    const term = window.__t_pane_terms?.get(k);
    const cell = document.querySelector(`.tmux-cell[data-pane-id="${k.split(":")[1]}"]`);
    const body = cell?.querySelector(".tmux-cell-body");
    const cellDims = term?._core?._renderService?.dimensions?.css?.cell;
    if (!term || !body || !cellDims?.width || !cellDims?.height) return null;
    const ps = getComputedStyle(body);
    const padX = (parseFloat(ps.paddingLeft) || 0) + (parseFloat(ps.paddingRight) || 0);
    const padY = (parseFloat(ps.paddingTop) || 0) + (parseFloat(ps.paddingBottom) || 0);
    return {
      want: [Math.max(20, Math.min(400, Math.floor((body.clientWidth - padX) / cellDims.width))),
        Math.max(6, Math.min(200, Math.floor((body.clientHeight - padY) / cellDims.height)))],
      got: [term.cols, term.rows],
    };
  }, key);

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

/** 各格相对 #term 的几何分数：主视图键 ":main"，可见格子按 tmux 会话名。 */
const tileGeo = (page) =>
  page.evaluate((sid) => {
    const box = document.getElementById("term").getBoundingClientRect();
    const out = {};
    const put = (k, el) => {
      const r = el.getBoundingClientRect();
      out[k] = { l: (r.left - box.left) / box.width, t: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
    };
    const main = document.querySelector(`.term-session[data-sid="${sid}"]`);
    if (main) put(":main", main);
    for (const c of document.querySelectorAll(".tmux-cell")) if (c.style.display === "flex") put(c.dataset.tmux, c);
    return out;
  }, SID);
const approx = (a, b, eps = 0.012) => Math.abs(a - b) < eps;
const sameRect = (a, b, eps) => !!a && !!b && approx(a.l, b.l, eps) && approx(a.t, b.t, eps) && approx(a.w, b.w, eps) && approx(a.h, b.h, eps);
const inside = (a, b) => !!a && !!b && a.l >= b.l - 0.01 && a.t >= b.t - 0.01 && a.l + a.w <= b.l + b.w + 0.01 && a.t + a.h <= b.t + b.h + 0.01;
/** 铺满且不重叠：面积和≈1、两两交叠≈0（自定义布局下关格/开格不留洞的判据）。 */
const tiled = (g) => {
  const rs = Object.values(g);
  const sum = rs.reduce((s, r) => s + r.w * r.h, 0);
  let overlap = 0;
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const ox = Math.max(0, Math.min(a.l + a.w, b.l + b.w) - Math.max(a.l, b.l));
      const oy = Math.max(0, Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t));
      overlap += ox * oy;
    }
  }
  return Math.abs(sum - 1) < 0.02 && overlap < 0.005;
};
/** 元素内一点（fx/fy 为元素内相对位置）的视口坐标。 */
const ptIn = (page, sel, fx = 0.5, fy = 0.5) =>
  page.evaluate(({ sel, fx, fy }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, { sel, fx, fy });
/** #term 内分数坐标 → 视口坐标。 */
const termPt = (page, fx, fy) =>
  page.evaluate(({ fx, fy }) => {
    const r = document.getElementById("term").getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, { fx, fy });
/** 找分隔条：dir="v"/"h"，中线（#term 分数）最接近 at、且条身跨过 across 处；返回条身上 across 处的视口坐标。 */
const divAt = (page, dir, at, across) =>
  page.evaluate(({ dir, at, across }) => {
    const box = document.getElementById("term").getBoundingClientRect();
    let best = null;
    for (const d of document.querySelectorAll(`.tmux-div.div-${dir}`)) {
      const r = d.getBoundingClientRect();
      const mid = dir === "v" ? (r.left + r.width / 2 - box.left) / box.width : (r.top + r.height / 2 - box.top) / box.height;
      const lo = dir === "v" ? (r.top - box.top) / box.height : (r.left - box.left) / box.width;
      const hi = dir === "v" ? (r.bottom - box.top) / box.height : (r.right - box.left) / box.width;
      if (across < lo || across > hi) continue;
      const dist = Math.abs(mid - at);
      if (!best || dist < best.dist) best = { dist, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }
    if (!best) return null;
    return dir === "v" ? { x: best.cx, y: box.top + across * box.height } : { x: box.left + across * box.width, y: best.cy };
  }, { dir, at, across });
/** 真鼠标拖拽（坑 90：交互验证一律真坐标）：按下 → 越过 5px 阈值 → 分步移到终点 → mid() 拖动中取证 → 松开。 */
const mouseDrag = async (page, from, to, mid) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  const r = mid ? await mid() : undefined;
  await page.mouse.up();
  await page.waitForTimeout(250);
  return r;
};
/** 拖动中的落点提示框（#term 分数几何 + 落点 + 文案 + 拖动态标记）。 */
const dropHint = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('[data-testid="tile-drop-hint"]');
    const box = document.getElementById("term").getBoundingClientRect();
    if (!h || h.style.display === "none") return null;
    const r = h.getBoundingClientRect();
    return {
      zone: h.dataset.zone, label: h.textContent ?? "",
      rect: { l: (r.left - box.left) / box.width, t: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height },
      src: !!document.querySelector(".tile-drag-src"), body: document.body.classList.contains("tile-dragging"),
    };
  });

module.exports = {
  title: "tmux 面板：网格几何/开格/分流/Ctrl 改投/防呆/右键关格/掉线换装/后台换装 fit/横幅/远端结束/OSC52/上限/分屏互斥/拖拽布局/Ctrl+B 前缀/焦点格指示/前缀后输入法标点还原/改名跟随/新建会话目标（主视图·面板）",
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

    // ── 0b. 拖拽布局树（同一 .mjs）：默认树与 paneGrid 逐格同几何、变换语义、不可变 ──
    const PG = await import("../../src/terminal/pane-grid.mjs");
    const M0 = PG.MAIN_KEY;
    const ks6 = [M0, "a", "b", "c", "d", "e"];
    ck.check("默认布局树 n=1..6 与 paneGrid 逐格同几何（未拖过=原自动平铺）",
      [1, 2, 3, 4, 5, 6].every((n) => {
        const tiles = PG.layoutRects(PG.defaultLayout(ks6.slice(0, n))).tiles;
        const pg = paneGrid(n);
        return tiles.length === n && tiles.every((t, i) => t.key === ks6[i] && near(t.left, pg[i].left) && near(t.top, pg[i].top) && near(t.width, pg[i].width) && near(t.height, pg[i].height));
      }), "");
    const geoOf = (root) => Object.fromEntries(PG.layoutRects(root).tiles.map((t) => [t.key, t]));
    const d3 = PG.defaultLayout([M0, "a", "b"]);
    const sw = geoOf(PG.moveTile(d3, "b", M0, "center"));
    ck.check("树：落中央=互换（各自位置大小留在原处）", near(sw.b.width, 0.5) && near(sw.b.top, 0) && near(sw[M0].top, 0.5) && near(sw[M0].width, 1), JSON.stringify(sw));
    const ed = geoOf(PG.moveTile(d3, "a", M0, "bottom"));
    ck.check("树：落下缘=目标上下对半（被拖格原位的空间先还给兄弟）",
      near(ed[M0].height, 0.25) && near(ed.a.top, 0.25) && near(ed.a.height, 0.25) && near(ed[M0].width, 1), JSON.stringify(ed));
    const dv0 = PG.layoutRects(d3).dividers.find((d) => d.dir === "row");
    const rz = geoOf(PG.resizeAt(d3, dv0.path, dv0.index, 0.99, 0.1, 0.2));
    ck.check("树：拖分隔条按最小占比夹取（右侧守 0.2）", near(rz[M0].width, 0.8) && near(rz.a.left, 0.8), JSON.stringify(rz));
    const rm = geoOf(PG.removeTile(PG.resizeAt(d3, dv0.path, dv0.index, 0.7), "a"));
    ck.check("树：摘格空间还给兄弟（主视图拿回整行）", near(rm[M0].width, 1) && Object.keys(rm).length === 2, JSON.stringify(rm));
    const sy = geoOf(PG.syncLayout(PG.resizeAt(d3, [], 0, 0.75), [M0, "a", "b", "c"], 16 / 9));
    ck.check("树：自定义布局开新格=从最大格分一半（面积并列取靠后者，按长边切）",
      near(sy.a.width, 0.25) && near(sy.c.left, 0.75) && near(sy.c.width, 0.25) && near(sy.c.height, 0.75), JSON.stringify(sy));
    ck.check("树：变换不改入参", JSON.stringify(d3) === JSON.stringify(PG.defaultLayout([M0, "a", "b"])), "");
    // 审查轮二：嵌套同轴容器的最小像素按「子格保持占比整体缩放」反推——B 只占内行 1/4，
    // 内行至少 4×180=720px（旧的求和口径给 360px，拖外层分隔条能把 B 压到 90px）
    const nest = { dir: "row", w: 1, kids: [{ key: "A", w: 1 }, { dir: "col", w: 1, kids: [{ dir: "row", w: 1, kids: [{ key: "B", w: 1 }, { key: "C", w: 3 }] }, { key: "D", w: 1 }] }] };
    ck.check("树：嵌套格最小像素按占比反推（B 占内行 1/4 → 内行≥720px）", PG.minExtent(nest.kids[1], "x", 180, 100) === 720, String(PG.minExtent(nest.kids[1], "x", 180, 100)));
    // 两侧最小值加起来放不下（窗口太小）：分隔条不锁死，只许让偏小的一侧变大
    const tight = { dir: "row", w: 1, kids: [{ key: "A", w: 1 }, { key: "B", w: 9 }] };
    ck.check("树：放不下两侧最小值时只许放大偏小的一侧（不锁死、也不更挤）",
      near(geoOf(PG.resizeAt(tight, [], 0, 0.3, 0.4, 0.7)).A.width, 0.3)
      && PG.resizeAt(tight, [], 0, 0.05, 0.4, 0.7) === tight
      && near(geoOf(PG.resizeAt(tight, [], 0, 0.6, 0.4, 0.7)).A.width, 0.3), "");
    // 审查轮三（改名跟随 P1）：renameTileKey 摘 stale 叶用的两个 helper——
    // 重复键 syncLayout 永不去重（两键都在 want），摘 stale 是布局树不繁殖的唯一闸
    const staleTree = PG.defaultLayout([M0, "a", "b"]);
    ck.check("树：treeHasKey/removeTile（改名摘 stale 叶的助手语义）",
      PG.treeHasKey(staleTree, "a") && !PG.treeHasKey(staleTree, "zz")
      && (() => { const pruned = PG.removeTile(staleTree, "a"); return pruned !== null && !PG.treeHasKey(pruned, "a") && PG.treeHasKey(pruned, "b"); })()
      && PG.removeTile(staleTree, "zz") === staleTree, "");
    ck.check("树：落点判定（距边 <1/4 取该边，否则中央）",
      PG.dropZone(0.5, 0.5) === "center" && PG.dropZone(0.1, 0.5) === "left" && PG.dropZone(0.95, 0.4) === "right"
      && PG.dropZone(0.5, 0.05) === "top" && PG.dropZone(0.6, 0.9) === "bottom", "");

    // ── 0b. 输入法标点 → 物理键位 ASCII 真值表（直连 ui/src/terminal/ime-punct.mjs）──
    const { imePunctToAscii } = await import("../../src/terminal/ime-punct.mjs");
    const imeCases = [
      ["￥", "$"], ["“", '"'], ["”", '"'], ["‘", "'"], ["：", ":"], ["，", ","], ["。", "."], ["【", "["],
      ["】", "]"], ["《", "<"], ["》", ">"], ["？", "?"], ["！", "!"], ["（", "("], ["）", ")"], ["……", "^"],
      ["——", "_"], ["、", "\\"], ["·", "`"], ["～", "~"], ["；", ";"], ["％", "%"], ["１", "1"], ["\u3000", " "],
    ];
    const imeBad = imeCases.filter(([a, b]) => imePunctToAscii(a) !== b).map(([a, b]) => `${a}→${imePunctToAscii(a)}≠${b}`);
    ck.check("输入法标点还原：常见中文标点/全角键 → 物理键位 ASCII", imeBad.length === 0, imeBad.join(" ") || `${imeCases.length} 例`);
    ck.check("输入法标点还原：ASCII/汉字/控制序列/多字串不动（返回 null 原样发送）",
      ["$", "%", "d", "中", "\x1b[A", "ab", "￥￥", ""].every((x) => imePunctToAscii(x) === null), "");

    // ── A. prod-1：远端清单扩成三会话（work/logs/build）──
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs", "build"] }), SID);
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
      if (tab) tab.click();
    });
    await page.waitForTimeout(800);
    // 输入法标点还原的门控负例：主视图尚未 attach tmux——C-b 在这里是 readline 光标左移，
    // 紧随其后打的中文标点是真文本，不得武装还原（demo 主视图回显原样字节，\x02 不占格）
    const mpA = await ptIn(page, `.term-session[data-sid="${SID}"]`, 0.5, 0.6);
    await page.mouse.click(mpA.x, mpA.y);
    await page.waitForTimeout(200);
    await page.keyboard.type("ZW");
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    ck.check("未 attach tmux 的主视图：Ctrl+B 后「￥」原样（不武装，宁缺不错）",
      await pollAsync(() => bufHas(page, "main", SID, "ZW￥"), 3000, page) && !(await bufHas(page, "main", SID, "ZW$")), "");
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

    // ── D2. 焦点格指示（用户反馈：主视图被选中时没有框、格子的框看不出来）：此前主视图在网格里
    //    根本没有焦点指示，格子是 1px --accent-glow（35% 半透明）。现主视图与格子同一套——
    //    ::after 2px accent 实线框 + 标题栏 accent 字（判据 :focus-within）。真鼠标点选切换 ──
    const ringOf = () => page.evaluate((sid) => {
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const pick = (el, head) => {
        if (!el) return null;
        const a = getComputedStyle(el, "::after");
        return { ring: a.borderTopStyle === "solid" && a.borderTopWidth === "2px" && a.borderTopColor === accent, head: !!head && getComputedStyle(head).color === accent };
      };
      const main = document.querySelector(`.term-session[data-sid="${sid}"]`);
      const cell = document.querySelector('.tmux-cell[data-tmux="logs"]');
      return { main: pick(main, main?.querySelector(".pane-tag")), cell: pick(cell, cell?.querySelector(".tmux-cell-head")) };
    }, SID);
    const r1 = await ringOf();
    ck.check("焦点在格子：格子 2px accent 实线框 + 标题栏 accent，主视图无框", r1.cell?.ring && r1.cell?.head && !r1.main?.ring && !r1.main?.head, JSON.stringify(r1));
    const mp0 = await ptIn(page, `.term-session[data-sid="${SID}"]`, 0.5, 0.6);
    await page.mouse.click(mp0.x, mp0.y);
    await page.waitForTimeout(200);
    const r2 = await ringOf();
    ck.check("点选主视图：主视图同样 2px accent 框 + 标题栏 accent（此前主视图无任何焦点指示），格子框撤",
      r2.main?.ring && r2.main?.head && !r2.cell?.ring && !r2.cell?.head, JSON.stringify(r2));
    const cp0 = await ptIn(page, '.tmux-cell[data-tmux="logs"] .tmux-cell-body', 0.5, 0.5);
    await page.mouse.click(cp0.x, cp0.y);
    await page.waitForTimeout(200);
    const r3 = await ringOf();
    ck.check("点回格子：框回到格子、主视图撤", r3.cell?.ring && !r3.main?.ring, JSON.stringify(r3));

    // ── D3. tmux 前缀后一键的输入法标点还原：中文输入法「中文标点」模式把 Shift+4 提交成「￥」，
    //    tmux 收到未绑定键静默丢弃——Ctrl+B $ 改会话名出不来（% 不变形，分屏照常）。insertText
    //    模拟输入法直接上屏（无 keydown，与真输入法提交走同一个 onData 出口）——
    //    无前缀的「￥」原样是文本；前缀后「￥」→ $ 直达 tmux（demo 进 (rename-session) 提示符）
    await page.keyboard.insertText("￥");
    ck.check("格子：无前缀时「￥」原样上屏（只还原前缀后的一键）", await pollAsync(() => bufHas(page, "pane", k1, "logs@demo:~$ ￥"), 3000, page), "");
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(150);
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    ck.check("格子：Ctrl+B 后输入法「￥」还原成 $（tmux 改会话名提示符弹出）", await pollAsync(() => bufHas(page, "pane", k1, "(rename-session) logs"), 3000, page), "");
    // 一次性：武装只消费前缀后第一键——改名提示符里再打的「￥」原样进名字行（不还原成 $）
    await page.keyboard.insertText("￥");
    const oneShot = await page.evaluate((k) => {
      const t = window.__t_pane_terms?.get(k);
      if (!t) return null;
      const b = t.buffer.active;
      for (let i = b.length - 1; i >= 0; i--) {
        const s = (b.getLine(i)?.translateToString(true) ?? "").trim();
        if (s) return s;
      }
      return null;
    }, k1);
    ck.check("一次性：前缀后的第二键不再还原（改名行原样「￥」，预填旧名仍在）", typeof oneShot === "string" && oneShot.endsWith("￥") && oneShot.includes("logs") && !oneShot.includes("$"), JSON.stringify(oneShot));
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(150);
    // 主视图（已 attach work）同样武装；未 attach tmux 的会话不武装——那里 C-b 是 readline
    // 光标左移，紧随其后打的中文标点是真文本（demo 主视图回显原样字节，\x02 不占格）
    await page.mouse.click(mp0.x, mp0.y);
    await page.waitForTimeout(200);
    await page.keyboard.type("ZQ");
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    ck.check("主视图（attach 了 tmux）：Ctrl+B 后「￥」同样还原成 $", await pollAsync(() => bufHas(page, "main", SID, "ZQ$"), 3000, page), "");

    // ── D4. 改名跟随：C-b $ 提交改名后，面板按不可变 tmux session_id（$N）对账——
    //    格子标题/fixture 清单/防呆全跟随（真实侧探针补发由前缀 $ 触发；demo 单对象
    //    原子改 + 3s 清单轮询带回，以等价模拟替代 id 对账——demo 格子无 id）。提示符
    //    预填旧名（真 tmux 同款）：先退格清行再输入，与真机走查同一用户路径。
    //    改完改回去，不影响后续按 logs 断言的段落 ──
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), k1);
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    await pollAsync(() => bufHas(page, "pane", k1, "(rename-session) logs"), 3000, page);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace"); // 清预填旧名
    await page.keyboard.type("app");
    await page.keyboard.press("Enter");
    ck.check("改名提交：格子回显新提示符（app@demo:~$）", await pollAsync(() => bufHas(page, "pane", k1, "app@demo:~$"), 3000, page), "");
    ck.check("改名跟随：格子标题原位换新名（旧名格摘除）",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="logs"]')
        && document.querySelector('.tmux-cell[data-tmux="app"] .tmux-cell-name')?.textContent === "app", null, 9000), "");
    const probeAfter = await page.evaluate((sid) => window.__demoInvoke("tmux_probe", { sid }), SID);
    ck.check("改名跟随：fixture 清单同步换名（探针即远端实况）",
      JSON.stringify((probeAfter?.sessions ?? []).map((x) => x.name)) === JSON.stringify(["work", "app", "build"])
      && (probeAfter?.sessions ?? []).every((x) => /^\$\d+$/.test(x.id)), JSON.stringify(probeAfter?.sessions));
    const dupApp = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "app" });
    ck.check("改名后防呆跟随（demo 以原子改名等价模拟 id 对账）：新名拒重开", (dupApp ?? "").includes("面板已包含会话 app"), dupApp ?? "未拒绝");
    const goneLogs = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "logs" });
    ck.check("改名后防呆跟随：旧名不再在册（不存在）", (goneLogs ?? "").includes("tmux 会话不存在：logs"), goneLogs ?? "未拒绝");
    // 改回去（后续段落按 logs 断言）
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    ck.check("改回：改名提示符预填新名（app）", await pollAsync(() => bufHas(page, "pane", k1, "(rename-session) app"), 3000, page), "");
    for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace"); // 清预填
    await page.keyboard.type("logs");
    await page.keyboard.press("Enter");
    ck.check("改回：格子标题回 logs",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="app"]')
        && document.querySelector('.tmux-cell[data-tmux="logs"] .tmux-cell-name')?.textContent === "logs", null, 9000), "");
    // 重名拒绝（真 tmux duplicate session 同款）：改名到已存在的 work 被拒、名字不变
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), k1);
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+b");
    await page.keyboard.insertText("￥");
    await pollAsync(() => bufHas(page, "pane", k1, "(rename-session) logs"), 3000, page);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("work");
    await page.keyboard.press("Enter");
    ck.check("改名重名拒绝：回显 duplicate session 且名字不变",
      await pollAsync(() => bufHas(page, "pane", k1, "duplicate session: work"), 3000, page)
        && await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"] .tmux-cell-name')?.textContent === "logs", null, 4000), "");

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
    ck.check("菜单：logs 行标「面板中」，主项可点（一键切主视图）、「＋面板」仍禁用",
      await page.evaluate(() => {
        const item = document.querySelector('[data-testid="tmux-quick-item-logs"]');
        return !!item && item.disabled === false && (item.textContent ?? "").includes("面板中")
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
    // 蒙灰走状态事件（走查修复 #11）——退化成 3s 快照驱动时 1.5s 窗口必红
    ck.check("掉线：格子保留且 1.5s 内蒙灰（dead）",
      await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"]')?.classList.contains("dead") === true, null, 1500), "");
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), `${SID}:${before}`);
    await page.keyboard.press("Control+c");
    ck.check("死格 Ctrl 控制键同样一次性告示（窗口捕获层改投路径，不再静默吞键）",
      await pollAsync(async () => (await bufCount(page, "pane", `${SID}:${before}`, "窗格已断开——键入未发送")) === 1, 3000, page), "");
    await page.keyboard.type("z");
    await page.waitForTimeout(300);
    ck.check("死格键入照样拦截，告示不重复刷屏",
      (await bufCount(page, "pane", `${SID}:${before}`, "窗格已断开——键入未发送")) === 1, "");

    // ── H. 面板在场时断线横幅缩半宽居右（格子不被整盖）──
    await page.evaluate((sid) => window.__demoInvoke("stop_auto_reconnect", { sid }), SID);
    ck.check("断线横幅缩半宽居右（右贴 24px、卡宽收到 380px）",
      await poll(page, () => {
        const ov = document.querySelector(".dead-overlay");
        const banner = ov?.querySelector(".dead-banner");
        if (!ov || !banner) return false;
        const cs = getComputedStyle(ov);
        return cs.justifyContent === "flex-end" && cs.paddingRight === "24px" && getComputedStyle(banner).maxWidth === "380px";
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
    // 审查轮二：掉线前焦点在 logs 格（上面死格键入就在它里面）——换装先收旧格再建新格，
    // 焦点不得落在兜底的主终端（用户以为还在 logs 里，接着打的字会进主视图）
    ck.check("重连换装后焦点交给同名新格（不落主终端）",
      await poll(page, (id) => !!document.activeElement?.closest(`.tmux-cell[data-pane-id="${id}"]`), after, 2000), "");

    // ── H2. 后台标签期间换装：切回时格子按可见尺寸重新 fit（隐藏期建出的 xterm 是默认尺寸）──
    await clickTab(page, "staging-1");
    await page.waitForTimeout(600);
    await page.evaluate((sid) => window.__demoInvoke("demo_drop_session", { sid, recoverOnAttempt: 1 }), SID);
    ck.check("后台换装：新 pane_id 的格子在隐藏中建出",
      await poll(page, (a) => {
        const c = document.querySelector('.tmux-cell[data-tmux="logs"]');
        return !!c && c.dataset.paneId !== a && c.style.display === "none";
      }, after, 6000), "");
    const bgId = (await cellOf(page, "logs"))?.id;
    await clickTab(page, "prod-1");
    let fit = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150);
      fit = await paneFit(page, `${SID}:${bgId}`);
      if (fit && fit.got[0] === fit.want[0] && fit.got[1] === fit.want[1]) break;
    }
    ck.check("切回后格子尺寸 = 可见盒子尺寸（不停留在隐藏期的默认 80×24）",
      !!fit && fit.got[0] === fit.want[0] && fit.got[1] === fit.want[1], JSON.stringify(fit));

    // ── I. 远端结束摘格（用户在格子里 exit / C-b d：核心 exited 臂）──
    // 真机走查实锤：旧对账给所有格子按出生算 6s 宽限，重建换装出的新格（此刻刚出生）
    // 一结束要挂到「出生 6s + 下一轮 3s 轮询」才收。现=流终结信号即刻对账 + 快照请求
    // 时刻判定缺席，1.2s 内必须收掉（宽限回归时此处确定性转红：该格出生不足 6s）。
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), `${SID}:${bgId}`);
    await page.waitForTimeout(150);
    await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: Number(id) }), { sid: SID, id: bgId });
    ck.check("远端结束：格子即刻摘除（流终结信号 + 快照请求时刻判定，不挂 6s 宽限）",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 1200), "");
    ck.check("远端结束给交代：toast 附 tmux 收尾提示行",
      await waitToast(page, "窗格已结束：logs — [detached (from session logs)]", 3000), "");
    ck.check("被摘格子握着焦点 → 交还主终端（不悬空在 body）",
      await page.evaluate((sid) => {
        const a = document.activeElement;
        return !!a && a.classList.contains("xterm-helper-textarea") && !!a.closest(`.term-session[data-sid="${sid}"]`);
      }, SID), "");

    // ── I2. 格子 OSC 52：tmux 复制模式 / claude code 的复制走主终端同一套策略（默认询问）──
    await page.evaluate((sid) => window.__demoInvoke("tmux_pane_open", { sid, session: "logs", cols: 80, rows: 24 }), SID);
    await poll(page, () => !!document.querySelector('.tmux-cell[data-tmux="logs"]'), null, 5000);
    const ko = `${SID}:${(await cellOf(page, "logs"))?.id}`;
    await page.evaluate((k) => {
      const b64 = btoa(unescape(encodeURIComponent("格子复制-42")));
      window.__t_pane_terms?.get(k)?.write("\x1b]52;c;" + b64 + "\x07");
    }, ko);
    ck.check("格子 OSC 52 弹询问卡（此前格子不挂钩子，静默丢弃）",
      await poll(page, () => (document.querySelector("[data-testid=osc52-preview]")?.textContent ?? "").includes("格子复制-42"), null, 3000), "");
    await page.click("[data-testid=osc52-deny]");

    // ── K. 上限 5：核心拒第 6 格，菜单「＋面板」禁用写明原因；⌘K 不列格子里的会话 ──
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs", "build", "db", "web", "api", "cache"] }), SID);
    for (const n of ["build", "db", "web", "api"]) {
      await page.evaluate(({ sid, n }) => window.__demoInvoke("tmux_pane_open", { sid, session: n, cols: 80, rows: 24 }), { sid: SID, n });
    }
    ck.check("5 格到位（logs/build/db/web/api）",
      await poll(page, () => document.querySelectorAll(".tmux-cell").length === 5, null, 5000), "");
    const capErr = await invokeErr(page, "tmux_pane_open", { sid: SID, session: "cache" });
    ck.check("第 6 格被拒（上限 5）", (capErr ?? "").includes("最多"), capErr ?? "未拒绝");
    await openQuickMenu(page);
    ck.check("菜单：到顶后「＋面板」禁用，原因写在 title",
      await poll(page, () => {
        const b = document.querySelector('[data-testid="tmux-pane-add-cache"]');
        return !!b && b.disabled && (b.title ?? "").includes("最多");
      }, null, 3000), "");
    await page.keyboard.press("Escape");
    await page.click('[data-testid="palette-open"]');
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="palette-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "tmux");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const palTitles = await page.evaluate(() => [...document.querySelectorAll(".palette-item .palette-title")].map((x) => x.textContent ?? ""));
    ck.check("⌘K：格子里的会话不列为「切换到」（点了只会撞防呆）",
      palTitles.some((s) => s.includes("切换到 tmux 会话：cache")) && !palTitles.some((s) => s.includes("切换到 tmux 会话：logs")),
      palTitles.filter((s) => s.includes("tmux")).join(" | "));
    await page.keyboard.press("Escape");

    // ── L. 分屏与面板互斥：进分屏格子全隐、「＋面板」禁用；退出分屏格子恢复 ──
    await rightClickTab(page, "staging-1");
    await clickMenuItem(page, "与当前会话分屏");
    ck.check("进分屏：格子全部隐藏",
      await poll(page, () => [...document.querySelectorAll(".tmux-cell")].every((c) => c.style.display === "none"), null, 3000), "");
    await page.evaluate((sid) => document.querySelector(`.term-session[data-sid="${sid}"]`)
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), SID);
    await page.waitForTimeout(300);
    if (await openQuickMenu(page)) {
      ck.check("分屏中「＋面板」禁用，原因写在 title",
        await page.evaluate(() => {
          const b = document.querySelector('[data-testid="tmux-pane-add-cache"]');
          return !!b && b.disabled && (b.title ?? "").includes("分屏");
        }), "");
      await page.keyboard.press("Escape");
    } else {
      ck.check("分屏中仍可打开 prod-1 的快接菜单", false, "快接钮不在场");
    }
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".session-toolbar button")].find((x) => (x.getAttribute("title") || "").includes("分屏"));
      b?.click();
    });
    ck.check("退出分屏：5 格恢复显示",
      await poll(page, () => [...document.querySelectorAll(".tmux-cell")].filter((c) => c.style.display === "flex").length === 5, null, 3000), "");


    // ── M. 拖拽布局（真鼠标）：分隔条调大小/越界夹取/双击均分、标题栏拖动（落中央互换、
    //    落边缘对半，主视图名牌同样可抓，提示框预演落点）、Esc 取消、纯点击不动布局、
    //    格子里 Ctrl+B d 脱离（tmux 前缀直达）、自定义布局下摘格/开格不留洞、右键重置 ──
    // 现场：主视图 + 5 格（logs/build/db/web/api）自动平铺 3×2
    await page.waitForTimeout(300);
    const L0 = await tileGeo(page);
    const keys0 = Object.keys(L0);
    ck.check("拖拽前：6 格自动平铺（主视图左上 1/3×1/2）",
      keys0.length === 6 && sameRect(L0[":main"], { l: 0, t: 0, w: 1 / 3, h: 0.5 }), JSON.stringify(L0[":main"]));
    ck.check("分隔条与平铺结构一致：两行各 2 条竖条 + 1 条横条",
      await page.evaluate(() => document.querySelectorAll(".tmux-div.div-v").length === 4 && document.querySelectorAll(".tmux-div.div-h").length === 1), "");
    // 主视图右邻（首行第二格）
    const nb = keys0.find((k) => k !== ":main" && approx(L0[k].l, 1 / 3) && approx(L0[k].t, 0));
    const nbKey = `${SID}:${await page.evaluate((n) => document.querySelector(`.tmux-cell[data-tmux="${n}"]`)?.dataset.paneId, nb)}`;
    const mainCols0 = await page.evaluate((sid) => window.__t_terms?.get(sid)?.cols ?? 0, SID);
    const nbCols0 = await page.evaluate((k) => window.__t_pane_terms?.get(k)?.cols ?? 0, nbKey);

    // M1 拖竖条：主视图与右邻的边界 1/3 → 0.45，只动这两格；PTY 几何随之校准
    // （先把焦点放进右邻格：拖条/双击均分后焦点不得被抢到主终端——审查轮二 P1）
    await page.evaluate((k) => window.__t_pane_terms?.get(k)?.focus(), nbKey);
    await mouseDrag(page, await divAt(page, "v", 1 / 3, 0.25), await termPt(page, 0.45, 0.25));
    const L1 = await tileGeo(page);
    ck.check("拖竖条：主视图宽 1/3→0.45、右邻让出同样宽度、其余格不动",
      approx(L1[":main"].w, 0.45) && approx(L1[nb].l, 0.45) && approx(L1[nb].w, 2 / 3 - 0.45)
      && keys0.filter((k) => k !== ":main" && k !== nb).every((k) => sameRect(L1[k], L0[k])), JSON.stringify({ main: L1[":main"], nb: L1[nb] }));
    await page.waitForTimeout(400);
    const pf1 = await paneFit(page, nbKey);
    ck.check("拖完右邻按新盒子重新 fit（列数变少且与盒子一致），主视图列数变多",
      !!pf1 && pf1.want[0] === pf1.got[0] && pf1.want[1] === pf1.got[1] && pf1.got[0] < nbCols0
      && (await page.evaluate((sid) => window.__t_terms?.get(sid)?.cols ?? 0, SID)) > mainCols0, JSON.stringify({ pf1, nbCols0, mainCols0 }));
    // M1b 越界夹取：一路拖到 0.95，右邻守住最小宽 180px
    const termW = await page.evaluate(() => document.getElementById("term").getBoundingClientRect().width);
    await mouseDrag(page, await divAt(page, "v", 0.45, 0.25), await termPt(page, 0.95, 0.25));
    const L1b = await tileGeo(page);
    ck.check("越界夹取：右邻守住最小宽 180px（不被挤没）",
      Math.abs(L1b[nb].w * termW - 180) < 3 && approx(L1b[":main"].w + L1b[nb].w, 2 / 3), `右邻=${(L1b[nb].w * termW).toFixed(1)}px`);
    // M2 拖横条：两行边界 0.5 → 0.62
    await mouseDrag(page, await divAt(page, "h", 0.5, 0.8), await termPt(page, 0.8, 0.62));
    const L2 = await tileGeo(page);
    ck.check("拖横条：上行高 0.5→0.62、下行让出同样高度",
      approx(L2[":main"].h, 0.62) && keys0.filter((k) => approx(L0[k].t, 0.5)).every((k) => approx(L2[k].t, 0.62) && approx(L2[k].h, 0.38)),
      JSON.stringify(L2[":main"]));
    // M3 双击均分：横条 → 两行回 0.5；首行竖条 → 首行三格回 1/3
    const dh3 = await divAt(page, "h", 0.62, 0.8);
    await page.mouse.dblclick(dh3.x, dh3.y);
    await page.waitForTimeout(250);
    const dv3 = await divAt(page, "v", L1b[":main"].w, 0.2);
    await page.mouse.dblclick(dv3.x, dv3.y);
    await page.waitForTimeout(250);
    const L3 = await tileGeo(page);
    ck.check("双击分隔条均分：回到 3×2 等分", keys0.every((k) => sameRect(L3[k], L0[k])), JSON.stringify(L3[":main"]));
    ck.check("拖条与双击均分后焦点仍在原格（click 冒泡不把焦点抢到主终端）",
      await page.evaluate((n) => !!document.activeElement?.closest(`.tmux-cell[data-tmux="${n}"]`), nb), nb);

    // M4 右下角格的标题栏拖到主视图中央 = 互换（拖动中：提示框=主视图整格 +「交换位置」，被拖格半透明）
    const far = keys0.find((k) => approx(L0[k].l, 2 / 3) && approx(L0[k].t, 0.5));
    const m4 = await mouseDrag(page,
      await ptIn(page, `.tmux-cell[data-tmux="${far}"] .tmux-cell-head`, 0.3, 0.5),
      await termPt(page, L3[":main"].l + L3[":main"].w / 2, L3[":main"].t + L3[":main"].h / 2),
      () => dropHint(page));
    ck.check("拖动中：提示框=主视图整格并标「交换位置」，被拖格半透明、全窗抓手态",
      !!m4 && m4.zone === "center" && m4.label.includes("交换位置") && sameRect(m4.rect, L3[":main"]) && m4.src && m4.body, JSON.stringify(m4));
    const L4 = await tileGeo(page);
    ck.check("落中央=互换：被拖格住进主视图原位、主视图住进它的原位",
      sameRect(L4[far], L3[":main"]) && sameRect(L4[":main"], L3[far]), JSON.stringify({ far: L4[far], main: L4[":main"] }));
    ck.check("松手后提示框与拖动态清理干净",
      await page.evaluate(() => !document.querySelector('[data-testid="tile-drop-hint"]') && !document.querySelector(".tile-drag-src")
        && !document.body.classList.contains("tile-dragging")), "");

    // M5 主视图名牌同样可抓：拖到右邻格右缘 → 该格对半、主视图占右半（落点=提示框预演，所见即所得）
    const tgt = nb;
    const tr = L4[tgt];
    const m5 = await mouseDrag(page,
      await ptIn(page, `.term-session[data-sid="${SID}"] .pane-tag`, 0.3, 0.5),
      await termPt(page, tr.l + tr.w * 0.92, tr.t + tr.h / 2),
      () => dropHint(page));
    const L5 = await tileGeo(page);
    ck.check("主视图名牌可抓：落右缘 → 主视图落在提示框预演的位置",
      !!m5 && m5.zone === "right" && sameRect(L5[":main"], m5.rect), JSON.stringify({ m5, main: L5[":main"] }));
    ck.check("右缘落点：主视图紧贴目标格右侧、同行同高，整体仍铺满无重叠",
      approx(L5[":main"].t, L5[tgt].t) && approx(L5[":main"].h, L5[tgt].h) && approx(L5[":main"].l, L5[tgt].l + L5[tgt].w) && tiled(L5),
      JSON.stringify({ main: L5[":main"], tgt: L5[tgt] }));

    // M6 Esc 取消：拖到别的格子上空按 Esc → 提示框即撤，松手也不改布局
    const pre6 = await tileGeo(page);
    const c6 = Object.keys(pre6).find((k) => k !== ":main");
    const o6 = Object.keys(pre6).find((k) => k !== ":main" && k !== c6);
    const s6 = await ptIn(page, `.tmux-cell[data-tmux="${c6}"] .tmux-cell-head`, 0.3, 0.5);
    await page.mouse.move(s6.x, s6.y);
    await page.mouse.down();
    await page.mouse.move(s6.x + 4, s6.y + 4, { steps: 2 });
    const e6 = await termPt(page, pre6[o6].l + pre6[o6].w / 2, pre6[o6].t + pre6[o6].h / 2);
    await page.mouse.move(e6.x, e6.y, { steps: 8 });
    const shown6 = !!(await dropHint(page));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const gone6 = await page.evaluate(() => !document.querySelector('[data-testid="tile-drop-hint"]') && !document.body.classList.contains("tile-dragging"));
    await page.mouse.up();
    await page.waitForTimeout(250);
    const L6 = await tileGeo(page);
    ck.check("Esc 取消拖动：提示框即撤、松手不改布局",
      shown6 && gone6 && Object.keys(pre6).every((k) => sameRect(L6[k], pre6[k])), JSON.stringify({ shown6, gone6 }));

    // M7 纯点击标题栏（不过 5px 阈值）：不动布局，只聚焦该格
    const pre7 = L6;
    const c7 = c6;
    const p7 = await ptIn(page, `.tmux-cell[data-tmux="${c7}"] .tmux-cell-head`, 0.3, 0.5);
    await page.mouse.click(p7.x, p7.y);
    await page.waitForTimeout(200);
    const L7 = await tileGeo(page);
    ck.check("纯点击标题栏：布局不动、焦点进该格",
      Object.keys(pre7).every((k) => sameRect(L7[k], pre7[k]))
      && await page.evaluate((n) => !!document.activeElement?.closest(`.tmux-cell[data-tmux="${n}"]`), c7), c7);

    // M8 格子里 Ctrl+B d（真实键盘）：tmux 前缀直达格子 → 脱离摘格；自定义布局里它的空间还给邻居。
    // 开 DEV 豁免钩子走 Tauri-only 分支：表内的 Ctrl+Shift+B（主机栏）被豁免、不进格子（随后的
    // d 只是普通字符，格子不脱离）；保留键 Ctrl+B 照样直达（demo 默认不豁免时 Ctrl+Shift+B
    // 会编成 \x02 被当作前缀——此处格子若脱离即说明豁免没生效）
    await page.evaluate(() => { window.__t_keymapExempt = true; });
    await page.keyboard.press("Control+Shift+B");
    await page.keyboard.press("d");
    await page.waitForTimeout(900);
    ck.check("豁免层：格子里 Ctrl+Shift+B 不进 tmux（随后的 d 不触发脱离）", !!(await cellOf(page, c7)), c7);
    await page.keyboard.press("Control+b");
    await page.keyboard.press("d");
    ck.check("格子里 Ctrl+B d = tmux 脱离：格子摘除 + toast 附 detached 收尾行",
      await poll(page, (n) => !document.querySelector(`.tmux-cell[data-tmux="${n}"]`), c7, 2500)
      && await waitToast(page, `窗格已结束：${c7} — [detached (from session ${c7})]`, 3000), c7);
    await page.evaluate(() => { window.__t_keymapExempt = false; });
    const L8 = await tileGeo(page);
    ck.check("自定义布局下摘格不留洞（5 格铺满无重叠）", Object.keys(L8).length === 5 && tiled(L8), JSON.stringify(L8));

    // M9 自定义布局下开新格：从当前最大的格子分出一半，其余格不动
    const maxA = Math.max(...Object.values(L8).map((r) => r.w * r.h));
    const bigs = Object.keys(L8).filter((k) => L8[k].w * L8[k].h > maxA - 0.005);
    await openQuickMenu(page);
    await page.click(`[data-testid="tmux-pane-add-${c7}"]`);
    await poll(page, (n) => document.querySelector(`.tmux-cell[data-tmux="${n}"]`)?.style.display === "flex", c7, 5000);
    await page.waitForTimeout(300);
    const L9 = await tileGeo(page);
    // 被分的那一格 = 新格所在的最大格（面积并列时实现取树序靠后者——任一并列者都合法）
    const split = bigs.find((k) => inside(L9[c7], L8[k]));
    ck.check("自定义布局下开新格：新格落在原最大格里、占其一半，被分格让出另一半，其余格不动，整体铺满",
      !!split && approx(L9[c7].w * L9[c7].h, (L8[split].w * L8[split].h) / 2, 0.01) && inside(L9[split], L8[split])
      && Object.keys(L8).filter((k) => k !== split).every((k) => sameRect(L9[k], L8[k])) && tiled(L9),
      JSON.stringify({ bigs, split, nw: L9[c7] }));

    // M9b 分屏期间：格子藏起、主视图右键不给「重置面板布局」（审查轮二）；退出分屏后自定义布局原样
    await rightClickTab(page, "staging-1");
    await clickMenuItem(page, "与当前会话分屏");
    await poll(page, () => [...document.querySelectorAll(".tmux-cell")].every((c) => c.style.display === "none"), null, 3000);
    const mp = await ptIn(page, `.term-session[data-sid="${SID}"]`, 0.5, 0.6);
    await page.mouse.click(mp.x, mp.y, { button: "right" });
    await poll(page, () => document.querySelectorAll(".ctx-menu [role=menuitem]").length > 0, null, 2000);
    ck.check("分屏中主视图右键不给「重置面板布局」", !(await page.evaluate(() => !!document.querySelector('[data-testid="pane-layout-reset"]'))), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.evaluate((sid) => document.querySelector(`.term-session[data-sid="${sid}"]`)
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), SID);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".session-toolbar button")].find((x) => (x.getAttribute("title") || "").includes("分屏"));
      b?.click();
    });
    await poll(page, () => [...document.querySelectorAll(".tmux-cell")].filter((c) => c.style.display === "flex").length === 5, null, 3000);
    await page.waitForTimeout(300);
    const L9b = await tileGeo(page);
    ck.check("退出分屏：自定义布局原样恢复", Object.keys(L9).every((k) => sameRect(L9b[k], L9[k])), JSON.stringify(L9b[":main"]));

    // M10 右键「重置面板布局」→ 回自动平铺；自动平铺下右键不再给该项
    const p10 = await ptIn(page, `.tmux-cell[data-tmux="${c7}"] .tmux-cell-head`, 0.3, 0.5);
    await page.mouse.click(p10.x, p10.y, { button: "right" });
    ck.check("布局被拖过：格内右键菜单给「重置面板布局」",
      await poll(page, () => !!document.querySelector('[data-testid="pane-layout-reset"]'), null, 2000), "");
    await page.click('[data-testid="pane-layout-reset"]');
    await page.waitForTimeout(300);
    const L10 = await tileGeo(page);
    ck.check("重置后回自动平铺（主视图左上 1/3×1/2、6 格铺满）",
      Object.keys(L10).length === 6 && sameRect(L10[":main"], { l: 0, t: 0, w: 1 / 3, h: 0.5 }) && tiled(L10), JSON.stringify(L10[":main"]));
    const p10b = await ptIn(page, `.tmux-cell[data-tmux="${c7}"] .tmux-cell-head`, 0.3, 0.5);
    await page.mouse.click(p10b.x, p10b.y, { button: "right" });
    await poll(page, () => !!document.querySelector('[data-testid="tmux-cell-menu"]'), null, 2000);
    ck.check("自动平铺下右键不给「重置面板布局」", !(await page.evaluate(() => !!document.querySelector('[data-testid="pane-layout-reset"]'))), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // M11 拖动中被拖的格子远端结束（审查轮二 P2）：元素被删后捕获已丢、把手收不到后续事件——
    // 不得留下半透明/提示框/全窗抓手光标，Esc 监听也要撤（否则主终端里 vim 的下一个 Esc 被吞）
    const g11 = await tileGeo(page);
    const c11 = Object.keys(g11).find((k) => k !== ":main" && k !== c7);
    const id11 = (await cellOf(page, c11))?.id;
    const s11 = await ptIn(page, `.tmux-cell[data-tmux="${c11}"] .tmux-cell-head`, 0.3, 0.5);
    const e11 = await termPt(page, g11[":main"].l + g11[":main"].w / 2, g11[":main"].t + g11[":main"].h / 2);
    await page.mouse.move(s11.x, s11.y);
    await page.mouse.down();
    await page.mouse.move(s11.x + 4, s11.y + 4, { steps: 2 });
    await page.mouse.move(e11.x, e11.y, { steps: 8 });
    const shown11 = !!(await dropHint(page));
    await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: Number(id) }), { sid: SID, id: id11 });
    await poll(page, (n) => !document.querySelector(`.tmux-cell[data-tmux="${n}"]`), c11, 2500);
    await page.waitForTimeout(200);
    const clean11 = await page.evaluate(() => !document.querySelector('[data-testid="tile-drop-hint"]') && !document.querySelector(".tile-drag-src")
      && !document.body.classList.contains("tile-dragging"));
    await page.mouse.up();
    await page.evaluate((sid) => document.querySelector(`.term-session[data-sid="${sid}"] .xterm-helper-textarea`)?.focus(), SID);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const esc11 = ((await page.evaluate((sid) => window.__demoInvoke("read_screen", { sid }), SID))?.text ?? "").endsWith("\x1b");
    // demo 回显循环把裸 ESC 原样回进主终端流——紧跟 "\" 收成 ST（ESC \），免得后续输出被
    // xterm 当残缺转义序列报解析错误（真实 shell 不回显裸 ESC，这是 demo 回显的伪影）
    await page.keyboard.type("\\");
    await page.waitForTimeout(200);
    ck.check("拖动中被拖格远端结束：拖动态即撤（无提示框/半透明/抓手光标），之后的 Esc 照常进终端",
      shown11 && clean11 && esc11, JSON.stringify({ shown11, clean11, esc11 }));
    // 分隔条拖动中邻格远端结束（树形变了，path/index 可能指向别的边界）：拖动即收尾、不留 resize 光标
    const g11b = await tileGeo(page);
    const vdiv = await page.evaluate(() => {
      const d = document.querySelector(".tmux-div.div-v");
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const victim = Object.keys(g11b).find((k) => k !== ":main");
    const vid = (await cellOf(page, victim))?.id;
    await page.mouse.move(vdiv.x, vdiv.y);
    await page.mouse.down();
    await page.mouse.move(vdiv.x + 30, vdiv.y, { steps: 4 });
    const resizing = await page.evaluate(() => document.body.classList.contains("tile-resizing"));
    await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: Number(id) }), { sid: SID, id: vid });
    await poll(page, (n) => !document.querySelector(`.tmux-cell[data-tmux="${n}"]`), victim, 2500);
    await page.mouse.move(vdiv.x + 60, vdiv.y, { steps: 3 });
    const cleanDiv = await page.evaluate(() => !document.body.classList.contains("tile-resizing") && !document.body.classList.contains("tile-resize-x")
      && !document.querySelector(".tmux-div.dragging"));
    await page.mouse.up();
    await page.waitForTimeout(250);
    ck.check("分隔条拖动中邻格远端结束：拖动即收尾（无 resize 光标/拖动态残留），剩余格铺满",
      resizing && cleanDiv && tiled(await tileGeo(page)), JSON.stringify({ resizing, cleanDiv }));

    // ── N. 窗格最大化/还原（监控墙轮同批）：× 左边加最大化钮；放大保留外框——
    //    标题栏常显、还原钮就在框上；主视图/兄弟格暂隐、分隔条撤收；还原回网格 ──
    const zoomName = await page.evaluate(() => [...document.querySelectorAll(".tmux-cell")].find((c) => c.style.display === "flex")?.dataset.tmux ?? "");
    ck.check("最大化前置：在场格子≥1", !!zoomName, zoomName);
    const zbtn = `.tmux-cell[data-tmux="${zoomName}"] [data-testid="tmux-cell-zoom"]`;
    ck.check("最大化钮在位且在 × 左边（head 内 zoom 钮先于 close 钮）",
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        const head = btn?.closest(".tmux-cell-head");
        const kids = head ? [...head.querySelectorAll("button")] : [];
        return kids.length === 2 && kids[0] === btn && kids[1].getAttribute("data-testid") === "tmux-cell-close";
      }, zbtn), "");
    await page.click(zbtn);
    await page.waitForTimeout(300);
    const z1 = await page.evaluate(({ n, sid }) => {
      const cell = document.querySelector(`.tmux-cell[data-tmux="${n}"]`);
      return {
        shown: cell?.style.display === "flex",
        full: Math.abs(parseFloat(cell?.style.left ?? "9")) < 0.001 && Math.abs(parseFloat(cell?.style.top ?? "9")) < 0.001,
        othersHidden: [...document.querySelectorAll(".tmux-cell")].filter((c) => c !== cell).every((c) => c.style.display === "none"),
        mainHidden: getComputedStyle(document.querySelector(`.term-session[data-sid="${sid}"]`) ?? document.body).display === "none",
        noDiv: document.querySelectorAll(".tmux-div").length === 0,
        headKept: !!cell?.querySelector(".tmux-cell-head"),
        zTitle: cell?.querySelector(".tmux-cell-zoom")?.getAttribute("title") ?? "",
        zSvgOn: cell?.querySelector(".tmux-cell-zoom")?.innerHTML.includes('points="4 14') ?? false,
      };
    }, { n: zoomName, sid: SID });
    ck.check("最大化：整幅只呈一格（全幅原点、兄弟格/主视图暂隐、分隔条撤收、外框标题栏保留）",
      z1.shown && z1.full && z1.othersHidden && z1.mainHidden && z1.noDiv && z1.headKept, JSON.stringify(z1));
    ck.check("放大态钮换装还原（title「还原窗格」+ minimize 图标）",
      z1.zTitle.includes("还原") && z1.zSvgOn, JSON.stringify({ t: z1.zTitle }));
    await page.click(zbtn);
    await page.waitForTimeout(300);
    const z2 = await page.evaluate(({ n, sid }) => ({
      flexCount: [...document.querySelectorAll(".tmux-cell")].filter((c) => c.style.display === "flex").length,
      mainBack: getComputedStyle(document.querySelector(`.term-session[data-sid="${sid}"]`) ?? document.body).display !== "none",
      title0: document.querySelector(`.tmux-cell[data-tmux="${n}"] .tmux-cell-zoom`)?.getAttribute("title") ?? "",
    }), { n: zoomName, sid: SID });
    ck.check("还原：格子回网格、主视图回归、钮换回最大化", z2.flexCount >= 1 && z2.mainBack && z2.title0.includes("最大化"), JSON.stringify(z2));

    // ── O. 工具栏净化 + 新建 tmux 会话（协作/文件/委托钮下线走右缘 rail；
    //    快接钮 accent 显眼；菜单内作曲行：白名单/同名预检/Esc 取消/创建即接入）──
    const declutter = await page.evaluate(() => ({
      noCollabBtn: !document.querySelector(".session-toolbar .st-collab"),
      noFileBtn: !document.querySelector(".session-toolbar .st-file"),
      noDelegate: !document.querySelector('[data-testid="delegate-open"]'),
      railFiles: !!document.querySelector('[data-testid="rb-files"]'),
      railCollab: !!document.querySelector('[data-testid="rb-collab"]'),
      quickAccent: document.querySelector('[data-testid="tmux-quick"] button')?.classList.contains("tmux-quick-btn") ?? false,
    }));
    ck.check("工具栏净化：协作/文件/委托钮下线，右缘 rail 入口在位，快接钮 accent 换装",
      declutter.noCollabBtn && declutter.noFileBtn && declutter.noDelegate
        && declutter.railFiles && declutter.railCollab && declutter.quickAccent, JSON.stringify(declutter));
    ck.check("右缘 rail 打开协作面板（rb-collab 是协作常驻入口；委托按钮在面板内，spec 08 已断言）",
      await (async () => {
        await page.click('[data-testid="rb-collab"]');
        await page.waitForTimeout(600);
        const ok = (await page.evaluate(() => document.querySelector('[data-testid="tp-title"]')?.textContent ?? "")) === "协作";
        await page.click('[data-testid="tp-close"]');
        await page.waitForTimeout(300);
        return ok;
      })(), "");
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-create-open"]');
    ck.check("作曲行出现且输入框聚焦", await poll(page, () =>
      !!document.querySelector('[data-testid="tmux-create-row"]')
      && document.activeElement?.classList.contains("tmux-create-input") === true, null, 3000), "");
    const tryCreate = async (name) => {
      // 提交前记旧错误文本（全套重载下固定 500ms 会把「错误还没落定」误判成无错）。
      // 约束：相邻两次 tryCreate 的错误文本必须不同——同文时第二轮会等满 6s 返回
      // 空串（假红，不是假绿）；当前两个调用点「非法」/「已存在」不同文
      const prev = await page.evaluate(() => document.querySelector('[data-testid="tmux-create-err"]')?.textContent ?? "");
      await page.evaluate(() => { const i = document.querySelector('[data-testid="tmux-create-input"]'); if (i) i.value = ""; });
      if (name) await page.type('[data-testid="tmux-create-input"]', name, { delay: 6 });
      await page.click('[data-testid="tmux-create-ok"]');
      for (let i = 0; i < 24; i++) {
        await page.waitForTimeout(250);
        const st = await page.evaluate(() => ({
          err: document.querySelector('[data-testid="tmux-create-err"]')?.textContent ?? "",
          open: !!document.querySelector('[data-testid="tmux-create-row"]'),
        }));
        if (!st.open) return ""; // 作曲行关闭 = 创建成功（本用例不应发生）
        if (st.err && st.err !== prev) return st.err; // 新错误落定
      }
      return "";
    };
    ck.check("非法名（a:b）就地报错", (await tryCreate("a:b")).includes("非法"), "");
    ck.check("同名预检（work 已存在）就地报错", (await tryCreate("work")).includes("已存在"), "");
    await page.focus('[data-testid="tmux-create-input"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const escState = await page.evaluate(() => ({
      rowGone: !document.querySelector('[data-testid="tmux-create-row"]'),
      menuKept: !!document.querySelector('[data-testid="tmux-quick-menu"]'),
    }));
    ck.check("Esc 取消作曲行但菜单不关（keymap 全拦生效）", escState.rowGone && escState.menuKept, JSON.stringify(escState));
    await page.click('[data-testid="tmux-create-open"]');
    await poll(page, () => !!document.querySelector('[data-testid="tmux-create-row"]'), null, 3000);
    await page.type('[data-testid="tmux-create-input"]', "fresh9", { delay: 6 });
    await page.keyboard.press("Enter");
    ck.check("Enter 提交：创建 toast", await waitToast(page, "已创建并接入"), "");
    ck.check("成功后作曲行随菜单收起", await poll(page, () => !document.querySelector('[data-testid="tmux-quick-menu"]'), null, 3000), "");
    ck.check("创建即接入：快接钮面换装 tmux:fresh9（随 3s 清单轮询下发）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:fresh9"), null, 6000), "");
    await openQuickMenu(page);
    ck.check("清单出现 fresh9 行", await poll(page, () =>
      [...document.querySelectorAll('[data-testid="tmux-quick-menu"] .tmux-quick-row button')]
        .some((b) => (b.textContent ?? "").includes("fresh9")), null, 4000), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── P. 新建会话的目标（建好落在哪）：默认主视图；「开进面板」把新会话直接开成
    //    本标签的格子。旧链路建好即 attach 主视图，而「＋面板」对主视图中的会话是
    //    禁用的（同一会话不做两路视图）——新会话再也进不了面板，这是真断路 ──
    // 现场清理：收到 ≤2 格（本段要再开 3 格并断言到顶：2+3=5）
    const trimPanes = async (keepMax) => {
      for (let i = 0; i < 8; i++) {
        const n = await page.evaluate(() => document.querySelectorAll(".tmux-cell").length);
        if (n <= keepMax) return n;
        const id = await page.evaluate(() => document.querySelector(".tmux-cell")?.dataset.paneId ?? null);
        if (!id) return n;
        await page.evaluate(({ sid, id }) => window.__demoInvoke("demo_pane_exit", { sid, paneId: Number(id) }), { sid: SID, id });
        await page.waitForTimeout(400);
      }
      return page.evaluate(() => document.querySelectorAll(".tmux-cell").length);
    };
    const cellsBeforeP = await trimPanes(2);
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-create-open"]');
    // 胶囊按 current.panes 判格数（DOM 格子随 eof 立收，React 侧清单等 3s 轮询）
    await poll(page, () => !document.querySelector('[data-testid="tmux-create-target-panel"]')?.disabled, null, 8000);
    const tgt0 = await page.evaluate(() => ({
      hasRow: !!document.querySelector('[data-testid="tmux-create-target"]'),
      main: document.querySelector('[data-testid="tmux-create-target-main"]')?.getAttribute("aria-checked"),
      panel: document.querySelector('[data-testid="tmux-create-target-panel"]')?.getAttribute("aria-checked"),
    }));
    ck.check("作曲行有目标单选，默认「接入主视图」（旧行为不变）",
      tgt0.hasRow && tgt0.main === "true" && tgt0.panel === "false", JSON.stringify({ cellsBeforeP, ...tgt0 }));
    await page.click('[data-testid="tmux-create-target-panel"]');
    ck.check("选「开进面板」后输入框仍聚焦（Enter 可直接提交）", await poll(page, () =>
      document.querySelector('[data-testid="tmux-create-target-panel"]')?.getAttribute("aria-checked") === "true"
      && document.activeElement?.classList.contains("tmux-create-input") === true, null, 2000), "");
    await page.type('[data-testid="tmux-create-input"]', "fresh10", { delay: 6 });
    // IME 组合期 Enter 是确认候选词：守卫在，作曲行不该被提前提交
    await page.evaluate(() => {
      const i = document.querySelector('[data-testid="tmux-create-input"]');
      i?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    ck.check("IME 组合期 Enter 不提交（作曲行仍在、未建会话）",
      await page.evaluate(() => !!document.querySelector('[data-testid="tmux-create-row"]')), "");
    await page.keyboard.press("Enter");
    ck.check("面板目标创建：toast「已并入面板」", await waitToast(page, "已并入面板"), "");
    ck.check("面板目标创建：fresh10 直接落成本标签格子",
      await poll(page, () => !!document.querySelector('.tmux-cell[data-tmux="fresh10"]'), null, 5000), "");
    ck.check("面板目标创建：主视图不接入（快接钮仍 tmux:fresh9，未被 fresh10 抢走）",
      await page.evaluate(() => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:fresh9")), "");
    await openQuickMenu(page);
    ck.check("清单里 fresh10 标「面板中」", await poll(page, () =>
      (document.querySelector('[data-testid="tmux-quick-item-fresh10"]')?.textContent ?? "").includes("面板中"), null, 4000), "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // 连建两格到顶：每次开菜单 → 开作曲行 → 选「开进面板」→ 输名 → Enter
    const createIntoPanel = async (name) => {
      await openQuickMenu(page);
      await page.click('[data-testid="tmux-create-open"]');
      await page.click('[data-testid="tmux-create-target-panel"]');
      await page.type('[data-testid="tmux-create-input"]', name, { delay: 6 });
      await page.keyboard.press("Enter");
      return poll(page, (n) => !!document.querySelector(`.tmux-cell[data-tmux="${n}"]`), name, 6000);
    };
    const p11 = await createIntoPanel("fresh11");
    const p12 = await createIntoPanel("fresh12");
    const cellsAtCap = await page.evaluate(() => document.querySelectorAll(".tmux-cell").length);
    ck.check("连建两格到顶（5 格）", p11 && p12 && cellsAtCap === 5, JSON.stringify({ p11, p12, cellsAtCap }));
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-create-open"]');
    const capOk = await poll(page, () => {
      const b = document.querySelector('[data-testid="tmux-create-target-panel"]');
      return !!b?.disabled && (b.getAttribute("title") ?? "").includes("面板最多");
    }, null, 8000);
    const cap = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tmux-create-target-panel"]');
      return { dis: !!b?.disabled, title: b?.getAttribute("title") ?? "" };
    });
    ck.check("面板满：「开进面板」禁用，原因写在 title（与「＋面板」同口径）",
      capOk && cap.dis && cap.title.includes("面板最多"), JSON.stringify(cap));
    await page.click('[data-testid="tmux-create-cancel"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // 复原现场（后续段要开 work 格）：收到 ≤3
    await trimPanes(3);

    // ── J1.5 面板中一键切主视图（找茬四轮 D6）：主项可点 = 收格 → 切主视图 ──
    // 此前 inPane 主项 disabled+「先关窗格」，切回主视图要两跳；格是纯视图（detach
    // 零损失），终态单视图落在双向防呆允许侧。
    await page.evaluate(({ sid }) => window.__demoInvoke("tmux_pane_open", { sid, session: "work", cols: 80, rows: 24 }), { sid: SID });
    ck.check("work 格子开好（一键切主视图前置）",
      await poll(page, () => !!document.querySelector('.tmux-cell[data-tmux="work"]'), null, 5000), "");
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-quick-item-work"]');
    ck.check("一键切主视图：work 格子收掉",
      await poll(page, () => !document.querySelector('.tmux-cell[data-tmux="work"]'), null, 4000), "");
    ck.check("一键切主视图：主视图换装 tmux:work（随 3s 清单轮询下发）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work"), null, 6000), "");

    // ── J. 会话关闭：格子随之全部收起（流终结信号逐格到达）──
    await page.evaluate((sid) => window.__demoInvoke("close_session", { sid }), SID);
    ck.check("关会话：格子 1.2s 内全部收起",
      await poll(page, () => document.querySelectorAll(".tmux-cell").length === 0, null, 1200), "");
  },
};
