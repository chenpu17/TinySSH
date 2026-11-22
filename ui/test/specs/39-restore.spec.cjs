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
const PROD_SCENE_TEXT = "prod scene @ 20:59";
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
  title: "会话现场恢复：双快照按创建序建签、检查点重放与公告行（#51/#43）",
  async run({ page, ck }) {
    // 清场：关掉 demo 预置会话 → 欢迎页可见
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    const welcome = await page.evaluate(() => !!document.querySelector(".welcome"));
    ck.check("关闭预置后回欢迎页", welcome);

    // 种入两条可恢复快照（顺序 prod → 本机）+ h-gone（主机已删，应被跳过）。
    // #51/#43：最终标签必须仍是快照创建序，不能被恢复后随机 sid 的列表序重排。
    // KI-103：本机条目带自定名 tab_name——恢复重建新 sid 后须回填，名字不丢。
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [
      { host_id: "h-prod1", saved_at: "2026-10-20T12:59:00Z", checkpoint: ckOf(PROD_SCENE_TEXT) },
      { host_id: "local", saved_at: "2026-10-20T13:00:00Z", tab_name: "我的本机", checkpoint: ckOf(SCENE_TEXT) },
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
    ck.check("行内计数只数主机在场的条目（2）", rowTxt.includes("恢复上次现场（2）"), rowTxt.slice(0, 80));
    const title = await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]')?.title ?? "");
    ck.check("悬停披露快照时刻与将跳过条目", title.includes("快照") && title.includes("跳过"), title.slice(0, 100));

    // 点恢复 → 建连（本机即时 Ready）→ term 挂载 → 公告行 + 检查点重放
    await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]').click());
    // 阻断层（KI-103 配套）：点击后立即出现、报进度、恢复完自动撤下。
    // 「期间点击被罩吃掉」直断机制：视口中心点必须命中遮罩（elementFromPoint）——
    // 比派发真实点击断「无副作用」稳（后者遮罩提前撤下会误报），与恢复时长无关。
    await page.waitForSelector('[data-testid="restore-mask"]', { timeout: 3000 });
    const mask = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="restore-mask"]');
      if (!el) return { present: false, text: "", hit: false };
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest?.('[data-testid="restore-mask"]') != null;
      return { present: true, text: el.textContent ?? "", hit };
    });
    ck.check("恢复中遮罩在场并报进度",
      mask.present && mask.text.includes("正在恢复上次现场") && mask.text.includes("正在处理") && mask.text.includes("恢复完成后才能继续操作"),
      mask.present ? mask.text.slice(0, 80) : "遮罩未出现");
    ck.check("遮罩期间视口中心点命中遮罩（指针被罩吃掉）", mask.hit, JSON.stringify(mask).slice(0, 80));
    await page.waitForSelector('[data-testid="restore-mask"]', { state: "hidden", timeout: 15000 });
    ck.check("恢复完成后遮罩撤下，可继续操作", await page.evaluate(() => !document.querySelector('[data-testid="restore-mask"]')));
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
    // 公告行时刻断言：期望串在页面侧按同款调用现算（审核轮：种子是 UTC 时刻，
    // 写死 "2026/10/20" 在 UTC+11 及以东机器会翻到次日必红——现算对时区/格式双免疫。
    // dateLocale() 在本 harness（固定 zh-CN context）下恒 "zh-CN"）。
    const when = await page.evaluate(() => new Date("2026-10-20T13:00:00Z").toLocaleString("zh-CN"));
    ck.check("公告行标注恢复与快照时刻",
      (buf ?? "").includes("已恢复上次会话现场") && (buf ?? "").includes(when),
      (buf ?? "").slice(-200) + " / 期望时刻=" + when);
    ck.check("主机已删的条目被跳过（无 ghost 文本、会话数 2）", (buf ?? "").includes("ghost") === false
      && await page.evaluate(() => document.querySelectorAll(".tab").length) === 2);
    const restored = await page.evaluate(async () => {
      const labels = [...document.querySelectorAll(".tab .tab-label")].map((el) => (el.textContent ?? "").trim());
      const sessions = await window.__demoInvoke("list_sessions");
      const prod = sessions.find((s) => s.host_id === "h-prod1");
      const term = prod ? window.__t_terms.get(prod.id) : null;
      const lines = [];
      if (term) {
        const b = term.buffer.active;
        for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
      }
      return { labels, prodText: lines.join("\n") };
    });
    ck.check("两条快照恢复后的最终标签仍是 prod → 本机（#51/#43；本机带自定名 KI-103 回填、prod 未改名退 host_name）",
      JSON.stringify(restored.labels) === JSON.stringify(["prod-1", "我的本机"]), restored.labels.join(" / "));
    ck.check("第一条 prod 快照也已重放，未因串行恢复漏项",
      restored.prodText.includes(PROD_SCENE_TEXT), restored.prodText.slice(-200));

    // 恢复后数据源清空（现场已被消费）→ 回欢迎页不再出现恢复行
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "本机");
    await page.waitForTimeout(600);
    const again = await page.evaluate(() => {
      localStorage.setItem("ui.v2.restore", "[]");
      return !!document.querySelector('[data-testid="restore-scene"]');
    });
    ck.check("恢复完成后欢迎页不再有恢复行", !again);
  },
};
