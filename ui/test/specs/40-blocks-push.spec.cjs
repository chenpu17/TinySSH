// 40 块推送（P1-b 增量）：OSC 133 shell 集成标记直达——核心输出通道广播的是喂屏
// 原始字节，133 原样到达 FE xterm；makeTerm 的 parser handler 在块开/合瞬间经
// blocksActivityRef 刷新块面板（150ms 尾沿去抖），不再等 5s 轮询。
// demo 数据面：read_blocks 合并 localStorage `ui.v2.blocksExtra:<sid>`（spec 种入）。
// 真实侧 133 到达路径由 feed_output_fn 广播原始字节保证（无新增 Rust 面，xterm 对
// 未消费的 133 维持默认忽略，handler return false 不改任何渲染行为）。

module.exports = {
  title: "块推送：OSC 133 标记即时刷新块面板（5s 轮询降为兜底）",
  async run({ page, ck }) {
    const note = () => page.evaluate(() =>
      document.querySelector('[data-testid="blocks-note"]')?.textContent ?? "(无)");

    // ── 激活预置会话（s-demo-0001=prod-1）+ 开块面板，基线 = demo 合成 5 块 ──
    const tabOk = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      if (!tab) return false;
      tab.click();
      return true;
    });
    await page.waitForTimeout(600);
    ck.check("预置会话标签在场并可激活（prod-1）", tabOk, "");
    await page.click('[data-testid="sb-blocks"]');
    await page.waitForTimeout(700);
    ck.check("面板基线：最近 5 块", (await note()).includes("最近 5 块"), await note());

    // ── 种入新块（数据面就绪）：阴性对照——无 133 标记时面板不得自己变（轮询 5s
    // 未到、1.2s 内唯一合法来源是推送，等不到即证明种子本身不触发刷新）──
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem("ui.v2.blocksExtra:s-demo-0001", JSON.stringify([{
        command: "systemctl status tinyssh-agent",
        exit_code: 0,
        source: "human",
        start: new Date(now - 1200).toISOString(),
        end: new Date(now - 400).toISOString(),
        exec_id: null,
        output: "● tinyssh-agent.service: active (running)",
        output_truncated: false,
      }]));
    });
    await page.waitForTimeout(1200);
    ck.check("阴性对照：只种数据不动终端，面板仍 5 块（种子不触发刷新）",
      (await note()).includes("最近 5 块"), await note());

    // ── 往 prod-1 term 写 OSC 133 C+D（真实链路里 pump 广播的原始字节就带这些
    // 标记）——推送路径应在去抖+取数内上屏（≤3s，5s 轮询不可能这么快）──
    await page.evaluate(() => {
      const t = window.__t_terms.get("s-demo-0001");
      const el = document.querySelector('[data-sid="s-demo-0001"]');
      if (!t || !el || el.getBoundingClientRect().height <= 0) throw new Error("prod-1 term 不可见");
      t.write("\x1b]133;C\x07");
      t.write("\x1b]133;D;0\x07");
    });
    let pushed = true;
    try {
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="blocks-note"]')?.textContent ?? "").includes("最近 6 块"),
        null, { timeout: 3000 });
    } catch { pushed = false; }
    ck.check("OSC 133 C+D 后 3s 内新块上屏（推送生效，早于 5s 轮询）", pushed, await note());

    // ── 新块行在场且最新在上（面板旧→新取回、倒序渲染）──
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="block-row"]')].map((r) => ({
        cmd: r.querySelector(".blk-cmd")?.textContent,
        src: r.dataset.source,
        exit: r.dataset.exit,
      })));
    ck.check("新块最新在上：种入命令、human、exit=0",
      rows[0]?.cmd === "systemctl status tinyssh-agent" && rows[0]?.src === "human"
      && rows[0]?.exit === "0", JSON.stringify(rows[0]));

    // ── 去抖合并：ConPTY 提示符重绘式突发（A/B/C/D ×2 连发）只触发一轮取数，
    // 面板数据一致、无重复行 ──
    await page.evaluate(() => {
      const t = window.__t_terms.get("s-demo-0001");
      for (const k of ["A", "B", "C", "D;0", "A", "B", "C", "D;0"]) {
        t.write(`\x1b]133;${k}\x07`);
      }
    });
    await page.waitForTimeout(600);
    const burstNote = await note();
    const rowCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="block-row"]').length);
    ck.check("突发 8 标记去抖合并：仍 6 块无重复", burstNote.includes("最近 6 块") && rowCount === 6,
      `${burstNote} / rows=${rowCount}`);

    // ── 清理种子（同浏览器上下文 localStorage 跨 spec 存续）──
    await page.evaluate(() => localStorage.removeItem("ui.v2.blocksExtra:s-demo-0001"));
  },
};
