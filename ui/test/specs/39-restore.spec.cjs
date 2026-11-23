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
const PROD_SECOND_SCENE_TEXT = "prod second scene @ 20:58";
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
  title: "会话现场恢复：同主机双快照按创建序建签、检查点重放与安全门取消（#51/#43/KI-104）",
  async run({ page, ck }) {
    // 清场：关掉 demo 预置会话 → 欢迎页可见
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    const welcome = await page.evaluate(() => !!document.querySelector(".welcome"));
    ck.check("关闭预置后回欢迎页", welcome);

    // 种入同主机两条快照 + 本机 + h-gone（主机已删，应被跳过）。
    // #51/#43：最终标签必须仍是快照创建序，不能被恢复后随机 sid 的列表序重排。
    // KI-103：本机条目带自定名 tab_name——恢复重建新 sid 后须回填，名字不丢。
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [
      { host_id: "h-prod1", saved_at: "2026-10-20T12:58:00Z", checkpoint: ckOf(PROD_SECOND_SCENE_TEXT) },
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
    ck.check("行内计数只数主机在场的条目（3）", rowTxt.includes("恢复上次现场（3）"), rowTxt.slice(0, 80));
    const title = await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]')?.title ?? "");
    ck.check("悬停披露快照时刻与将跳过条目", title.includes("快照") && title.includes("跳过"), title.slice(0, 100));

    // 点恢复 → 建连（本机即时 Ready）→ term 挂载 → 公告行 + 检查点重放
    await page.evaluate(() => document.querySelector('[data-testid="restore-scene"]').click());
    // 阻断层（KI-103 配套）：点击后立即出现、报进度、恢复完自动撤下。
    // 「期间点击被罩吃掉」直断机制：视口中心点必须命中遮罩（elementFromPoint）——
    // 比派发真实点击断「无副作用」稳（后者遮罩提前撤下会误报），与恢复时长无关。
    // demo 可能同步完成所有条目，遮罩在一次渲染内出现又撤下；终态重放才是主断言，
    // 仍在处理时检查遮罩，已完成则不得强制要求观察到一个瞬时帧。
    await page.waitForTimeout(50);
    const mask = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="restore-mask"]');
      if (!el) return { present: false, text: "", hit: false };
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.closest?.('[data-testid="restore-mask"]') != null;
      return { present: true, text: el.textContent ?? "", hit };
    });
    ck.check("恢复中遮罩若被观察到则在场并报进度（demo 同步完成允许不经过可见帧）",
      !mask.present || (mask.text.includes("正在恢复上次现场") && mask.text.includes("正在处理") && mask.text.includes("恢复完成后才能继续操作")),
      mask.present ? mask.text.slice(0, 80) : "遮罩未出现");
    ck.check("遮罩被观察到时视口中心点命中（指针被罩吃掉）", !mask.present || mask.hit, JSON.stringify(mask).slice(0, 80));
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
    ck.check("主机已删的条目被跳过（无 ghost 文本、会话数 3）", (buf ?? "").includes("ghost") === false
      && await page.evaluate(() => document.querySelectorAll(".tab").length) === 3);
    const restored = await page.evaluate(async () => {
      const labels = [...document.querySelectorAll(".tab .tab-label")].map((el) => (el.textContent ?? "").trim());
      const sessions = await window.__demoInvoke("list_sessions");
      const prod = sessions.find((s) => s.host_id === "h-prod1");
      const textOf = (session) => {
        const term = session ? window.__t_terms.get(session.id) : null;
        const lines = [];
        if (term) {
          const b = term.buffer.active;
          for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
        }
        return lines.join("\n");
      };
      const prodSessions = sessions.filter((s) => s.host_id === "h-prod1");
      return { labels, prodText: textOf(prod), sameHostTexts: prodSessions.map(textOf) };
    });
    ck.check("快照恢复后的最终标签按创建序排列（本机带自定名 KI-103 回填、prod 未改名退 host_name）",
      JSON.stringify(restored.labels) === JSON.stringify(["prod-1", "prod-1", "我的本机"]), restored.labels.join(" / "));
    ck.check("同主机两条快照串行恢复，未被建连锁吞掉且各自重放",
      restored.sameHostTexts.length === 2 &&
      restored.sameHostTexts.some((x) => x.includes(PROD_SCENE_TEXT)) &&
      restored.sameHostTexts.some((x) => x.includes(PROD_SECOND_SCENE_TEXT)),
      restored.sameHostTexts.map((x) => x.slice(-100)).join(" || "));
    // 回到欢迎页才能直接观察前端内存态：read_restore 在 demo 中只读种子，
    // 且 remoteOpen 时命令面板隐藏恢复入口，不能拿入口不可见冒充「无残项」。
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "本机");
    await page.waitForTimeout(600);
    const again = await page.evaluate(() => !!document.querySelector('[data-testid="restore-scene"]'));
    ck.check("成功及主机已删条目均消费，回欢迎页无恢复残项", !again);

    // demo 没有快照删除命令；只清测试种子，避免影响后续取消用例。
    await page.evaluate(() => localStorage.setItem("ui.v2.restore", "[]"));

    // KI-104：TOFU 门挂在恢复 attempt 上；遮罩虽低于安全门，仍可取消整个恢复。
    // 取消必须移除门、终结算法且不留下迟到会话；本地条目不再处理且保留可重试。
    await page.evaluate((seed) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify(seed));
    }, [
      { host_id: "h-noint", saved_at: "2026-10-20T13:01:00Z", checkpoint: ckOf("cancel me") },
      { host_id: "local", saved_at: "2026-10-20T13:02:00Z", checkpoint: ckOf("must remain") },
    ]);
    await page.reload();
    await page.waitForTimeout(1200);
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await page.click('[data-testid="restore-scene"]');
    await page.waitForSelector('[data-testid="restore-mask"]', { timeout: 3000 });
    await page.waitForSelector(".hk-dialog", { timeout: 6000 });
    ck.check("恢复中的 TOFU 安全门仍显示且可取消", await page.evaluate(() =>
      document.querySelector(".hk-dialog")?.textContent.includes("首次连接确认") &&
      !!document.querySelector('[data-testid="restore-gate-cancel"]')));
    await page.click('[data-testid="restore-gate-cancel"]');
    await page.waitForSelector('[data-testid="restore-mask"]', { state: "hidden", timeout: 5000 });
    await page.waitForTimeout(500);
    const cancelled = await page.evaluate(async () => ({
      gates: (await window.__demoInvoke("pending_host_keys", {})).length,
      sessions: await window.__demoInvoke("list_sessions", {}),
      row: document.querySelector('[data-testid="restore-scene"]')?.textContent ?? "",
    }));
    ck.check("取消恢复立即作废 TOFU 门", cancelled.gates === 0, JSON.stringify(cancelled.gates));
    ck.check("取消恢复没有创建任何迟到会话", cancelled.sessions.length === 0,
      cancelled.sessions.map((s) => s.host_id).join(","));
    ck.check("取消后未处理快照全部保留且入口可观察", cancelled.row.includes("恢复上次现场（2）"), cancelled.row);

    // 双因素等待也走同一 attempt 取消链（且等待门时不计 20 秒超时）。
    await page.evaluate(async (checkpoint) => {
      localStorage.setItem("ui.v2.restore", JSON.stringify([
        { host_id: "h-otp1", saved_at: "2026-10-20T13:03:00Z", checkpoint },
      ]));
    }, ckOf("otp"));
    await page.reload();
    await page.waitForTimeout(1200);
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    await page.click('[data-testid="restore-scene"]');
    await page.waitForFunction(() => document.querySelector(".hk-dialog")?.textContent.includes("首次连接确认"), null, { timeout: 6000 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".hk-dialog button")].find((x) => x.textContent.includes("信任并连接"));
      b.click();
    });
    await page.waitForFunction(() => document.querySelector(".hk-dialog")?.textContent.includes("双因素"), null, { timeout: 6000 });
    await page.click('[data-testid="restore-gate-cancel"]');
    await page.waitForSelector('[data-testid="restore-mask"]', { state: "hidden", timeout: 5000 });
    const otpCancelled = await page.evaluate(async () => ({
      gates: (await window.__demoInvoke("pending_auth_prompts", {})).length,
      sessions: await window.__demoInvoke("list_sessions", {}),
    }));
    ck.check("双因素等待中取消恢复同样无死卡、无迟到会话",
      otpCancelled.gates === 0 && otpCancelled.sessions.length === 0, JSON.stringify(otpCancelled));
  },
};
