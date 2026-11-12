// 86 P3 现场恢复 × tmux（#26）：快照里记下主视图 attach 的 tmux 会话名，恢复时
// 按名重新接入（tmux_restore → capture-pane 补史 → tmux_attach）——不再只是
// 「静态画面 + 新 shell」。demo 的 tmux_restore/tmux_attach 镜像真实链路语义。
const closeViaMenu = async (page, namePart) => {
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
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};

const SCENE_TEXT = "scene-tmux-42";
const ckOf = (lineText) => ({
  cols: 80, rows: 24,
  buffers: [
    { lines: [[{ text: lineText, fg: null, bg: null, flags: 0 }]] },
    { lines: [] },
  ],
  active_buffer: 0,
  cursor: { x: 0, y: 1, visible: true, style: "block" },
  modes: { autowrap: true, application_cursor: false, bracketed_paste: false, origin_mode: false },
  title: null,
});

const termBuffer = (page) => page.evaluate(() => {
  const live = (t) => { const el = t.element; return !!el && el.isConnected && el.getBoundingClientRect().height > 0; };
  const term = [...window.__t_terms.values()].find(live);
  if (!term) return null;
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y);
    if (!l) continue;
    const cs = [];
    for (let x = 0; x < l.length; x++) {
      const c = l.getCell(x);
      if (!c) break;
      cs.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
    }
    out.push(cs.join("").trimEnd());
  }
  return out.join("\n");
});

/** 面板格子缓冲（demo 的格子终端挂在 __t_pane_terms，键 sid:paneId）。 */
const paneBuffer = (page) => page.evaluate(() => {
  const terms = [...(window.__t_pane_terms?.values() ?? [])];
  const term = terms.find((t) => t.element?.isConnected);
  if (!term) return null;
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y);
    if (!l) continue;
    const cs = [];
    for (let x = 0; x < l.length; x++) {
      const c = l.getCell(x);
      if (!c) break;
      cs.push(c.getWidth() === 0 ? "" : (c.getChars() || " "));
    }
    out.push(cs.join("").trimEnd());
  }
  return out.join("\n");
});

module.exports = {
  title: "会话现场恢复：tmux 主视图按名重新接入（#26）",
  async run({ page, ck }) {
    // 清场 → 欢迎页
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    ck.check("关闭预置后回欢迎页", await page.evaluate(() => !!document.querySelector(".welcome")));

    // 种入一条 SSH 快照：屏幕画面 + 主视图 attach 的 tmux 会话名
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [{
      host_id: "h-prod1",
      saved_at: "2026-10-20T13:00:00Z",
      tmux_session: "work",
      tmux_panes: [],
      checkpoint: ckOf(SCENE_TEXT),
    }]);

    await page.reload();
    await page.waitForTimeout(1500);
    // demo 预置会话随 reload 回来——关掉让欢迎页可见（read_restore 已在挂载时载入）
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await page.waitForTimeout(400);
    const title = await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]')?.title ?? "");
    ck.check("快照带 tmux 时 tooltip 承诺一并恢复", title.includes("tmux 会话与面板格子会一并恢复"), title.slice(0, 180));

    // 点恢复 → 建连 → 重放快照 → tmux_restore 按名找 work → 补史 → attach。
    // toast 驻留短于终端落定时间，轮询捕捉而不是固定等待（避免错过提示）。
    await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]').click());
    let sawToast = false;
    let buf = null;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(200);
      if (!sawToast) {
        sawToast = await page.evaluate(() => [...document.querySelectorAll(".toast")]
          .some((t) => t.textContent.includes("tmux work")));
      }
      buf = await termBuffer(page);
      if (sawToast && (buf ?? "").includes("tmux attach -t '=work'")) break;
    }
    ck.check("新会话已建立且终端在场", buf !== null && buf.length > 0);
    ck.check("快照文本已重放进终端", (buf ?? "").includes(SCENE_TEXT), (buf ?? "").slice(-260));
    ck.check("恢复公告行仍在", (buf ?? "").includes("已恢复上次会话现场"), (buf ?? "").slice(-260));
    ck.check("tmux 主视图已按名重新接入", (buf ?? "").includes("tmux attach -t '=work'"), (buf ?? "").slice(-400));
    ck.check("capture-pane 近史已补进滚回", (buf ?? "").includes("capture-pane 近史"), (buf ?? "").slice(-500));
    ck.check("恢复成功 toast 报出 tmux 会话", sawToast);

    // ---- 第二段：面板格子恢复（tmux_panes）——快照里的每个 tmux 会话按序重开 ----
    await closeViaMenu(page, "prod-1");
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [{
      host_id: "h-prod1",
      saved_at: "2026-10-20T13:05:00Z",
      tmux_session: null,
      tmux_panes: ["work"],
      checkpoint: ckOf("scene-pane-7"),
    }]);
    await page.reload();
    await page.waitForTimeout(1500);
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]').click());
    let cellVisible = false;
    let pbuf = null;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(200);
      cellVisible = await page.evaluate(() => {
        const el = document.querySelector('.tmux-cell[data-tmux="work"]');
        return !!el && el.getBoundingClientRect().height > 0;
      });
      pbuf = await paneBuffer(page);
      if (cellVisible && (pbuf ?? "").includes("面板窗格")) break;
    }
    ck.check("快照里的 tmux 面板格子已重开", cellVisible);
    ck.check("面板格子已接入 tmux（独立通道）", (pbuf ?? "").includes("面板窗格"), (pbuf ?? "").slice(-200));
  },
};
