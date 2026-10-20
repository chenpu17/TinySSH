// 39 P3 会话现场恢复：退出快照（Tauri 受控退出路径，Rust 侧钉住）→ 欢迎页
// 「恢复上次现场」一键入口 → 既有建连全流程 → applyCheckpoint 重放（历史进滚回、
// 公告行标注快照时刻）。demo 镜像读 localStorage（采集侧 demo 无对应入口，不造假）。
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

const SCENE_TEXT = "deploy done @ 21:00";
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

module.exports = {
  title: "会话现场恢复：欢迎页一键入口 → 建连 → 检查点重放 + 公告行",
  async run({ page, ck }) {
    // 清场：关掉 demo 预置会话 → 欢迎页可见
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    const welcome = await page.evaluate(() => !!document.querySelector(".welcome"));
    ck.check("关闭预置后回欢迎页", welcome);

    // 种入快照：local（可恢复）+ h-gone（主机已删，应被跳过）
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [
      { host_id: "local", saved_at: "2026-10-20T13:00:00Z", checkpoint: ckOf(SCENE_TEXT) },
      { host_id: "h-gone", saved_at: "2026-10-20T13:00:00Z", checkpoint: ckOf("ghost") },
    ]);

    await page.reload();
    await page.waitForTimeout(1500);
    // demo 预置会话随 reload 回来——先关掉让欢迎页可见（read_restore 已在挂载时载入）
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await page.waitForTimeout(400);
    ck.check("欢迎页有「恢复上次现场」行", await page.evaluate(() => !!document.querySelector('[data-testid="restore-scene"]')));
    const rowTxt = await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]')?.textContent ?? "");
    ck.check("行内计数只数主机在场的条目（1）", rowTxt.includes("恢复上次现场（1）"), rowTxt.slice(0, 80));
    const title = await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]')?.title ?? "");
    ck.check("悬停披露快照时刻与将跳过条目", title.includes("快照") && title.includes("跳过"), title.slice(0, 100));

    // 点恢复 → 建连（本机即时 Ready）→ term 挂载 → 公告行 + 检查点重放
    await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]').click());
    await page.waitForTimeout(2500);
    const buf = await page.evaluate(() => {
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
    ck.check("新会话已建立且终端在场", buf !== null && buf.length > 0);
    ck.check("快照文本已重放进终端", (buf ?? "").includes(SCENE_TEXT), (buf ?? "").slice(-200));
    ck.check("公告行标注恢复与快照时刻", (buf ?? "").includes("已恢复上次会话现场") && (buf ?? "").includes("2026/10/20"), (buf ?? "").slice(-200));
    ck.check("主机已删的条目被跳过（无 ghost 文本、会话数 1）", (buf ?? "").includes("ghost") === false
      && await page.evaluate(() => document.querySelectorAll(".tab").length) === 1);

    // 恢复后数据源清空（现场已被消费）→ 回欢迎页不再出现恢复行
    await closeViaMenu(page, "本机");
    await page.waitForTimeout(600);
    const again = await page.evaluate(() => {
      localStorage.setItem("ui.v2.restore", "[]");
      return !!document.querySelector('[data-testid="restore-scene"]');
    });
    ck.check("恢复完成后欢迎页不再有恢复行", !again);
  },
};
