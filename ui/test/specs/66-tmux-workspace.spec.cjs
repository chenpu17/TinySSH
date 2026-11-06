// 66 tmux 工作空间（保存/恢复轮）：运行期持续落盘「上次画面」——blob sessions.last
// 主机清单 + sessions.panes 每主机 tmux 面板组合（格子会话名有序 / 拖拽布局树 /
// 主视图 attach）。覆盖：armed 后 attach+开格+拖分隔条 → 组合落盘（防抖补写）、
// 关标签组合摘除（last 只剩仍在场主机）、reload 后欢迎页「重连上次会话」一键全量
// 恢复（并行建连·门挂起暂停计时 → 连上即开格不等其他主机 → 该主机格子就绪后播种
// 布局树 → attach 静默恢复；seed 用 Rust serde 读回形状——容器补 key:""、叶子补
// dir/kids:null——几何断言即钉住 sanitizer 对生产读回形状的兼容）、Gone（tmux
// 会话已不在服务器）跳过并汇总 toast。demo 镜像：tmux_pane_open 懒建 fixture
// （work/logs，恢复建连的新会话按名解析）、workspace 走 localStorage 同键透传。
const rightClickTab = async (page, namePart) => {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(t));
    if (!tab) throw new Error("tab not found: " + t);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 380, clientY: 130 }));
  }, namePart);
  await page.waitForTimeout(350);
};
const clickItem = async (page, part) => {
  await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".ctx-menu [role=menuitem]")].find((x) => x.textContent.includes(p));
    if (!b) throw new Error("menuitem not found: " + p);
    b.click();
  }, part);
  await page.waitForTimeout(500);
};
/** 关标签（右键菜单 → 确认弹窗；spec 19 同款）。 */
const closeViaMenu = async (page, namePart) => {
  await rightClickTab(page, namePart);
  await clickItem(page, "关闭会话");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};
const blob = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}"));
/** 轮询（坑 55：不用 waitForFunction）。 */
const poll = async (page, fn, arg, tmo = 5000) => {
  const dl = Date.now() + tmo;
  while (Date.now() < dl) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await page.waitForTimeout(150);
  }
  return false;
};
const waitToast = (page, substr, timeout = 8000) =>
  poll(page, (s) => [...document.querySelectorAll(".toast")].some((e) => (e.textContent ?? "").includes(s)), substr, timeout);
const activateTab = async (page, label) => {
  const ok = await page.evaluate((t) => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes(t));
    if (!tab) return false;
    tab.click();
    return true;
  }, label);
  if (!ok) throw new Error(`标签不在场：${label}`);
  await page.waitForTimeout(700);
};
const openQuickMenu = async (page) => {
  await page.evaluate(() => {
    const open = !!document.querySelector('[data-testid="tmux-quick-menu"]');
    const btn = document.querySelector('[data-testid="tmux-quick"] button');
    if (btn && !open) btn.click();
  });
  return poll(page, () => !!document.querySelector('[data-testid="tmux-quick-menu"]'), null, 2000);
};
const bufText = (page, sid) =>
  page.evaluate((s) => {
    const t = window.__t_terms && window.__t_terms.get(s);
    if (!t) return null;
    const b = t.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - 400); i < b.length; i++) {
      out.push(b.getLine(i) ? b.getLine(i).translateToString(true) : "");
    }
    return out.join("\n");
  }, sid);
/** 当前活动标签的网格几何（主视图键 ":main"，可见格子按 tmux 会话名；spec 63 tileGeo 去 sid 化）。 */
const geo = (page) =>
  page.evaluate(() => {
    const box = document.getElementById("term").getBoundingClientRect();
    const out = {};
    const put = (k, el) => {
      const r = el.getBoundingClientRect();
      out[k] = { l: (r.left - box.left) / box.width, t: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height };
    };
    const main = [...document.querySelectorAll(".term-session")].find((el) => el.style.display !== "none" && el.getBoundingClientRect().width > 0);
    if (main) put(":main", main);
    for (const c of document.querySelectorAll(".tmux-cell")) if (c.style.display === "flex") put(c.dataset.tmux, c);
    return out;
  });
const near = (a, b, eps = 0.025) => Math.abs(a - b) < eps;
/** 找分隔条身上一点（spec 63 divAt 同款）。 */
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
const termPt = (page, fx, fy) =>
  page.evaluate(({ fx, fy }) => {
    const r = document.getElementById("term").getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  }, { fx, fy });
const mouseDrag = async (page, from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};

module.exports = {
  title: "tmux 工作空间：组合落盘（attach+开格+拖布局）/防抖补写/关格清空/一键全量恢复（布局播种+Gone 跳过+attach 恢复）",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);

    // ── A. 造主机 ws-host 并连接（用户主动建连 = armed；demo 只有 prod-1 预置信任，
    //      ws-host 首连必过 TOFU 门）──
    await page.click('.hostbar button[title="添加主机"]');
    await page.waitForTimeout(500);
    const inputs = await page.$$(".add-host-dlg input");
    await inputs[0].fill("ws-host");
    await inputs[1].fill("ws.demo");
    await inputs[2].fill("22");
    await inputs[3].fill("ops");
    await inputs[4].fill("pw");
    await page.evaluate(() => [...document.querySelectorAll(".add-host-dlg button")].find((b) => b.textContent.trim() === "仅保存").click());
    await page.waitForTimeout(900);
    const hostId = await page.evaluate(async () => {
      const hosts = await window.__demoInvoke("list_hosts", {});
      return (hosts ?? []).find((h) => h.name === "ws-host")?.id ?? null;
    });
    ck.check("ws-host 落库（拿到 host_id）", !!hostId, String(hostId));
    const sidsBefore = await page.evaluate(() => [...(window.__t_terms?.keys?.() ?? [])]);
    const card = await page.$('.host-card:has(.host-name:text-is("ws-host"))');
    await card.hover();
    await page.waitForTimeout(300);
    await (await card.$('button[title^="连接"]')).click();
    // 新主机首连必过 TOFU 门（demo 只预置信任 prod-1）——轮询门出现再点，不赌固定延时
    ck.check("TOFU 门弹出（ws-host 首连）", await poll(page, () => !!document.querySelector(".hk-mask"), null, 8000), "");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((y) => y.textContent.trim() === "信任并连接");
      if (b) b.click();
    });
    await page.waitForTimeout(1800);
    const sid = await page.evaluate((before) => {
      const out = [];
      window.__t_terms && window.__t_terms.forEach((_, k) => { if (!before.includes(k)) out.push(k); });
      return out[out.length - 1] ?? null;
    }, sidsBefore);
    ck.check("ws-host 已连接（新 sid 就位）", !!sid, String(sid));

    // ── B. attach work 进主视图 + 并入 logs/build 两格 ──
    await page.evaluate((s) => window.__demoInvoke("demo_tmux_fixture", { sid: s, sessions: ["work", "logs", "build"] }), sid);
    await activateTab(page, "ws-host");
    ck.check("快接菜单展开", await openQuickMenu(page), "");
    await page.click('[data-testid="tmux-quick-item-work"]');
    ck.check("attach work（恢复现场 toast）", await waitToast(page, "已恢复现场（tmux work"), "");
    ck.check("快接钮面换装 tmux:work（清单轮询下发）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work"), null, 6000), "");
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-pane-add-logs"]');
    ck.check("并入 logs", await waitToast(page, "已并入面板：logs"), "");
    ck.check("logs 格可见", await poll(page, () => document.querySelector('.tmux-cell[data-tmux="logs"]')?.style.display === "flex", null, 5000), "");
    await openQuickMenu(page);
    await page.click('[data-testid="tmux-pane-add-build"]');
    ck.check("并入 build", await waitToast(page, "已并入面板：build"), "");
    ck.check("build 格可见", await poll(page, () => document.querySelector('.tmux-cell[data-tmux="build"]')?.style.display === "flex", null, 5000), "");

    // ── C. 拖分隔条（顶部行下压）→ 组合落盘（防抖 1.5s + 写链）──
    await mouseDrag(page, await divAt(page, "h", 0.5, 0.8), await termPt(page, 0.8, 0.62));
    const wsOk = await poll(page, (hid) => {
      const ws = JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}");
      const c = (ws?.sessions?.panes ?? []).find((x) => x.host_id === hid);
      return !!c && c.attached === "work" && !!c.layout && Array.isArray(c.sessions);
    }, hostId, 8000);
    ck.check("组合落盘：panes 含 ws-host（attached=work + layout 非空）", wsOk, "");
    const combo = await page.evaluate((hid) => {
      const ws = JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}");
      return (ws?.sessions?.panes ?? []).find((x) => x.host_id === hid) ?? null;
    }, hostId);
    ck.check("格子会话名按开格序：[logs, build]",
      JSON.stringify(combo?.sessions) === JSON.stringify(["logs", "build"]), JSON.stringify(combo));
    const rootK = combo?.layout;
    const leafKeys = (n, acc = []) => (n ? (n.kids ? (n.kids.forEach ? n.kids.forEach((k) => leafKeys(k, acc)) : null, acc) : (acc.push(n.key), acc)) : acc);
    const keys = rootK ? leafKeys(rootK) : [];
    ck.check("布局树键齐：:main/logs/build", keys.includes(":main") && keys.includes("logs") && keys.includes("build"), JSON.stringify(rootK));
    // 拖拽路径不归一权重（几何按占比）：顶行占比 = w0/(w0+w1)，拖到 0.62
    const w0 = rootK?.kids?.[0]?.w ?? 0, w1 = rootK?.kids?.[1]?.w ?? 0;
    const topFrac = w0 + w1 > 0 ? w0 / (w0 + w1) : 0;
    ck.check("拖拽权重已记忆（顶行占比 0.55~0.72）", topFrac > 0.55 && topFrac < 0.72, `w=[${w0},${w1}] frac=${topFrac.toFixed(3)}`);
    const last1 = (await blob(page))?.sessions?.last ?? [];
    ck.check("sessions.last 含 ws-host", last1.includes(hostId), JSON.stringify(last1));

    // ── D. 关标签组合摘除：关 ws-host 标签 → 该主机组合摘除；last 只剩仍在场主机
    //    （预置 prod-1/staging-1 会话还开着，它们没在用面板所以只进 last 不进 panes；
    //    「关光所有会话=空集」是 writeWorkspaceSessions 的实现直接保证，不另造场景）──
    await closeViaMenu(page, "ws-host");
    const cleared = await poll(page, () => {
      const sp = (JSON.parse(localStorage.getItem("ui.v2.workspace") ?? "{}"))?.sessions;
      return (sp?.panes ?? []).length === 0 && JSON.stringify(sp?.last) === JSON.stringify(["h-prod1", "h-staging1"]);
    }, null, 8000);
    ck.check("关标签后组合摘除 + last 只剩仍在场的预置两台", cleared, JSON.stringify((await blob(page))?.sessions));

    // ── E. 种「上次工作空间」→ reload（不武装）→ 清预置 → 欢迎页一键全量恢复 ──
    // 种子只用预置主机（demo 主机不跨 reload）：prod-1=双格+自定义布局；staging-1
    // =ghost（服务器上不存在）+ 主视图 attach work
    await page.evaluate((seed) => localStorage.setItem("ui.v2.workspace", JSON.stringify(seed)), {
      schema_version: 1, chrome: "dark", hostbar: null, terminal: null, transfers: null,
      sessions: {
        last: ["h-prod1", "h-staging1"],
        panes: [
          { host_id: "h-prod1", sessions: ["work", "logs"], attached: null,
            // 生产读回形状（Rust serde 整存整取后）：容器补 key:""、叶子补 dir/kids:null
            // ——seed 用这个形状，恢复几何断言即钉住 sanitizer 对真实读回形状的兼容
            layout: { key: "", dir: "row", w: 1, kids: [
              { key: ":main", dir: null, kids: null, w: 3 },
              { key: "", dir: "col", w: 1, kids: [
                { key: "work", dir: null, kids: null, w: 1 },
                { key: "logs", dir: null, kids: null, w: 1 },
              ] },
            ] } },
          { host_id: "h-staging1", sessions: ["ghost"], attached: "work", layout: null },
        ],
      },
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    ck.check("欢迎页一键恢复钮就位（读回种子组合）",
      await poll(page, () => !!document.querySelector('[data-testid="reconnect-last"]'), null, 6000), "");
    ck.check("按钮 title 提示 tmux 窗格与布局恢复",
      (await page.evaluate(() => document.querySelector('[data-testid="reconnect-last"]')?.getAttribute("title") ?? "")).includes("tmux 窗格"), "");
    await page.evaluate(() => document.querySelector('[data-testid="reconnect-last"]')?.click());
    // staging-1 首连必过 TOFU 指纹门（demo 只预置信任 prod-1）——恢复动线里
    // 用户点「信任并连接」继续，等待循环随后捕到 Connected
    ck.check("TOFU 门弹出（staging-1 首连）", await poll(page, () => !!document.querySelector(".hk-mask"), null, 8000), "");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((y) => y.textContent.trim() === "信任并连接");
      if (b) b.click();
    });
    ck.check("全量恢复 toast：2 个主机 · 2 个 tmux 窗格", await waitToast(page, "已恢复上次工作空间：2 个主机 · 2 个 tmux 窗格", 25000), "");
    ck.check("Gone 汇总 toast：ghost 已不在服务器", await waitToast(page, "已不在服务器，已跳过：ghost", 6000), "");

    // ── F. 恢复结果断言：格子按序 + 保存的布局权重 + 主视图 attach ──
    await activateTab(page, "prod-1");
    ck.check("work 格可见", await poll(page, () => document.querySelector('.tmux-cell[data-tmux="work"]')?.style.display === "flex", null, 5000), "");
    const g = await geo(page);
    ck.check("布局播种：主视图压到 0.75（保存权重 3:1）", !!g[":main"] && near(g[":main"].w, 0.75), JSON.stringify(g));
    ck.check("布局播种：work 右上（l≈0.75, h≈0.5）", !!g.work && near(g.work.l, 0.75) && near(g.work.h, 0.5), JSON.stringify(g.work));
    ck.check("布局播种：logs 右下（l≈0.75, t≈0.5, h≈0.5）", !!g.logs && near(g.logs.l, 0.75) && near(g.logs.t, 0.5) && near(g.logs.h, 0.5), JSON.stringify(g.logs));
    await activateTab(page, "staging-1");
    ck.check("主视图 attach 静默恢复（attach/switch-client 回显）",
      await poll(page, () => {
        // 并行建连下「最后建的会话」不一定是 staging——扫全部主终端缓冲；新会话
        // 首挂回显 `tmux attach -t`，已挂再挂才是 switch-client（spec 61 D 分支）
        let hit = false;
        window.__t_terms?.forEach((t) => {
          const b = t.buffer.active;
          for (let i = Math.max(0, b.length - 400); i < b.length; i++) {
            const line = b.getLine(i)?.translateToString(true) ?? "";
            if (line.includes("attach -t '=work'") || line.includes("switch-client -t '=work'")) hit = true;
          }
        });
        return hit;
      }, null, 8000), "");
    ck.check("恢复后 staging-1 快接钮面 tmux:work（attach 落清单）",
      await poll(page, () => (document.querySelector('[data-testid="tmux-quick"] button')?.textContent ?? "").includes("tmux:work"), null, 8000), "");
  },
};
