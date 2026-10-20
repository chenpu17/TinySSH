// 41 块失败通知：OSC 133 D 标记带退出码（`133;D;<code>`）且非零时——标签闪烁恒开
// （复用 BEL 通路 flashAndNotify）；系统通知走「响铃时系统通知」既有开关 + 窗口失焦
// 门 + 节流（demo 无 Tauri 不验证该支路）；后台会话才 toast 点名失败命令（read_blocks
// 取最新块对账，对不上只报退出码），当前（聚焦）会话不 toast——正看着终端，失败直接
// 可见。每会话 10s 节流防失败循环刷屏。
// demo 数据面：read_blocks 合并 localStorage `ui.v2.blocksExtra:<sid>`（spec 40 同款
// 种入）。写入走 __t_terms（dev 探针）；后台会话 term 不要求可见——write() 是纯 JS
// API，parser 链路与渲染无关。

const failToasts = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".toast")]
    .map((t) => t.textContent ?? "")
    .filter((s) => s.includes("命令失败")));

module.exports = {
  title: "块失败通知：D 非零退出码 → 后台会话 toast + 标签闪烁；聚焦会话不打扰；10s 节流",
  async run({ page, ck }) {
    const note = () => page.evaluate(() =>
      [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? "").join(" | "));

    // ── 两个预置会话都激活一次（保证 term 已挂载），随后把 prod-1 留在后台 ──
    const tabsOk = await page.evaluate(() => {
      const pick = (name) => [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes(name));
      const p = pick("prod-1");
      const s = pick("staging-1");
      if (!p || !s) return false;
      p.click();
      return true;
    });
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("staging-1"))?.click();
    });
    await page.waitForTimeout(700);
    ck.check("prod-1 / staging-1 标签在场，且 staging-1 已聚焦（prod-1 后台）", tabsOk, "");

    // ── 阴性①：D 无退出码（`133;D` 裸标记）——无法判定失败，不反应 ──
    await page.evaluate(() => { window.__t_terms.get("s-demo-0001").write("\x1b]133;D\x07"); });
    await page.waitForTimeout(800);
    ck.check("裸 D（无退出码）不触发失败 toast", (await failToasts(page)).length === 0, await note());

    // ── 种入失败块（数据面）：命令上下文经 read_blocks 最新块对账取回 ──
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem("ui.v2.blocksExtra:s-demo-0001", JSON.stringify([{
        command: "systemctl restart tinyssh-agent",
        exit_code: 7,
        source: "human",
        start: new Date(now - 900).toISOString(),
        end: new Date(now - 300).toISOString(),
        exec_id: null,
        output: "Job for tinyssh-agent.service failed.",
        output_truncated: false,
      }]));
    });

    // ── 后台会话 D;7 → toast 点名（host + exit + 命令）+ 标签闪烁 ──
    await page.evaluate(() => { window.__t_terms.get("s-demo-0001").write("\x1b]133;D;7\x07"); });
    let named = "";
    try {
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".toast")].some((t) =>
          (t.textContent ?? "").includes("命令失败") && (t.textContent ?? "").includes("exit 7")),
        null, { timeout: 2500 });
      named = await note();
    } catch { named = "(无 toast)"; }
    ck.check("后台 D;7 → toast 点名 host/退出码/失败命令",
      named.includes("prod-1") && named.includes("exit 7") && named.includes("systemctl restart tinyssh-agent"), named);
    const flashed = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      return tab ? tab.classList.contains("tab-bell") : false;
    });
    ck.check("prod-1 标签闪烁（复用 BEL 通路，恒开）", flashed, "");

    // ── 节流：10s 内第二个失败不再 toast（防失败循环刷屏）──
    await page.evaluate(() => { window.__t_terms.get("s-demo-0001").write("\x1b]133;D;7\x07"); });
    await page.waitForTimeout(600);
    ck.check("10s 内重复失败只一条 toast（节流）", (await failToasts(page)).length === 1, await note());

    // ── D;0 成功不通知 ──
    await page.evaluate(() => { window.__t_terms.get("s-demo-0001").write("\x1b]133;D;0\x07"); });
    await page.waitForTimeout(600);
    ck.check("D;0 成功退出码静默", (await failToasts(page)).length === 1, await note());

    // ── 聚焦会话不打扰：等节流窗过期后聚焦 prod-1 再失败——无 toast（此前的
    // toast 早已过 2.6s 自清，计数为 0 才是干净基线）；但闪烁照旧——证明 D;7
    // 确实被处理，只是 toast 被前台门抑制 ──
    await page.waitForTimeout(10500);
    await page.evaluate(() => {
      [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"))?.click();
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__t_terms.get("s-demo-0001").write("\x1b]133;D;7\x07"); });
    await page.waitForTimeout(800);
    ck.check("聚焦会话失败不 toast（正看着终端，失败直接可见）",
      (await failToasts(page)).length === 0, await note());
    const stillFlash = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      return tab ? tab.classList.contains("tab-bell") : false;
    });
    ck.check("聚焦失败仍闪烁（D;7 已处理，仅 toast 被抑制）", stillFlash, "");

    // ── 清理种子 ──
    await page.evaluate(() => localStorage.removeItem("ui.v2.blocksExtra:s-demo-0001"));
  },
};
