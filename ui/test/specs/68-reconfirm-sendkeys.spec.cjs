// 68 KI-002：重连成功进入「已重连 · 待核实」后，人类在终端里回车提交命令
//（send_keys 路径，不是命令框 exec）必须立即转回「已连接」，状态点由琥珀变绿。
// 断言面：demo 域 session_state_feed 300ms 轮询 + 标签状态点/工具栏状态文案。

const SID = "s-demo-0001";

const stateOf = (page) =>
  page.evaluate((sid) => {
    const tab = document.querySelector(`.tab[data-sid="${sid}"] .tab-dot`);
    const st = document.querySelector(".session-toolbar .st-state");
    return {
      dot: tab ? [...tab.classList].find((c) => c === "ok" || c === "warn" || c === "err" || c === "dim") : null,
      text: st?.textContent ?? null,
    };
  }, SID);

const pollState = async (page, wantDot, wantText, timeout = 5000) => {
  const dl = Date.now() + timeout;
  while (Date.now() < dl) {
    const s = await stateOf(page);
    if (s.dot === wantDot && (s.text ?? "").includes(wantText)) return s;
    await page.waitForTimeout(100);
  }
  return stateOf(page);
};

module.exports = {
  title: "重连重确认：终端回车提交后标签即时变绿（KI-002）",
  async run({ page, ck }) {
    await page.waitForTimeout(1200);
    // 固定到 prod-1（demo 默认活动会话），确保键入进的是目标终端
    await page.evaluate((sid) => {
      document.querySelector(`.tab[data-sid="${sid}"]`)?.click();
    }, SID);
    await page.waitForTimeout(500);

    // 自动重连第 1 次成功 → Reconfirming（琥珀「已重连 · 待核实」）
    await page.evaluate((sid) => window.__demoInvoke("demo_drop_session", {
      sid, recoverOnAttempt: 1,
    }), SID);
    const warn = await pollState(page, "warn", "已重连 · 待核实", 6000);
    ck.eq("重连成功后标签为琥珀 warn 点", warn.dot, "warn");
    ck.eq("工具栏显示「已重连 · 待核实」", warn.text, "已重连 · 待核实");

    // 人类在终端里敲 ls 回车（onData → send_keys，不经命令框 exec）
    await page.evaluate(() => {
      const ta = document.querySelector(".term-session.active .xterm-helper-textarea")
        ?? document.querySelector(".xterm-helper-textarea");
      if (!ta) throw new Error("xterm textarea 不在场");
      ta.focus();
    });
    await page.keyboard.type("ls", { delay: 30 });
    await page.keyboard.press("Enter");

    const ok = await pollState(page, "ok", "已连接", 5000);
    ck.eq("终端回车后标签变绿 ok", ok.dot, "ok");
    ck.eq("终端回车后工具栏显示「已连接」", ok.text, "已连接");
  },
};
