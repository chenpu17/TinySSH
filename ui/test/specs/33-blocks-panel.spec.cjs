// 33 命令块轮（P1-b，FR-10 V2）：命令块面板——最近块时间线（来源徽标/退出码/耗时）、
// 复制命令、重跑（与粘贴同一条安全链：危险形态 Rust/demo 扫描 → 确认框）、
// 跳到最近失败（行高亮）、工具菜单第二入口。
// demo 侧 read_blocks 为按 sid 的确定性合成块（s-demo-0001 五块：含 exit 1 与
// shutdown 危险形态）；真实侧 read_blocks 投影由 core p1_tests 钉住。

/** 按 command 子串找块行（面板内最新在上） */
const rowByCmd = (page, substr) =>
  page.evaluate((s) => {
    const rows = [...document.querySelectorAll('[data-testid="block-row"]')];
    const hit = rows.find((r) => r.querySelector(".blk-cmd")?.textContent?.includes(s));
    return hit ? rows.indexOf(hit) : -1;
  }, substr);

const clickRowAction = async (page, substr, action) => {
  const idx = await rowByCmd(page, substr);
  if (idx < 0) throw new Error(`块行不在场：${substr}`);
  await page.evaluate(({ i, a }) => {
    const row = document.querySelectorAll('[data-testid="block-row"]')[i];
    row.querySelector(`[data-testid="${a}"]`).click();
  }, { i: idx, a: action });
  await page.waitForTimeout(500);
};

const dialogTitle = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="paste-dialog-title"]')?.textContent ?? null);

module.exports = {
  title: "命令块面板：时间线/徽标/复制/重跑安全链/跳转最近失败",
  async run({ page, ck }) {
    // ── 先激活预置会话标签（demo 预置 s-demo-0001=prod-1，但启动时无活动会话）──
    const tabOk = await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((t) => t.textContent?.includes("prod-1"));
      if (!tab) return false;
      tab.click();
      return true;
    });
    await page.waitForTimeout(600);
    ck.check("预置会话标签在场并可激活（prod-1）", tabOk, "");

    // ── 开面板（状态条入口）──
    await page.click('[data-testid="sb-blocks"]');
    await page.waitForTimeout(700);
    ck.check("面板标题为「命令块」", await page.evaluate(() =>
      document.querySelector('[data-testid="tp-title"]')?.textContent === "命令块"), "");
    ck.check("块数量回显（最近 5 块）", await page.evaluate(() =>
      (document.querySelector('[data-testid="blocks-note"]')?.textContent ?? "").includes("最近 5 块")),
      await page.evaluate(() => document.querySelector('[data-testid="blocks-note"]')?.textContent ?? "(无)"));

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="block-row"]')].map((r) => ({
        cmd: r.querySelector(".blk-cmd")?.textContent,
        src: r.dataset.source,
        exit: r.dataset.exit,
      })));
    ck.check("五块旧→新取回、最新在上", rows.length === 5
      && rows[0].cmd === "tail -n 50 /var/log/nginx/error.log"
      && rows[4].cmd === "shutdown -h now", JSON.stringify(rows));
    ck.check("来源徽标：Agent 块与人类块归因正确", rows[0].src === "agent:claude-code"
      && rows[1].src === "human" && rows[2].src === "agent:claude-code", JSON.stringify(rows.map((r) => r.src)));
    ck.check("退出码：失败块红色 exit 1、成功块 ✓ 0", rows[1].exit === "1"
      && rows[0].exit === "0", JSON.stringify(rows.map((r) => r.exit)));

    // ── 复制命令（写桩剪贴板）──
    await page.evaluate(() => {
      window.__copied = null;
      const stub = { readText: async () => window.__pasteText ?? "", writeText: async (t) => { window.__copied = t; } };
      try { Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true }); }
      catch { navigator.clipboard.writeText = stub.writeText; }
    });
    await clickRowAction(page, "tail -n 50", "block-copy");
    ck.check("复制命令入剪贴板（含 toast）", await page.evaluate(() =>
      window.__copied === "tail -n 50 /var/log/nginx/error.log"
      && !!document.querySelector(".toast.ok")), await page.evaluate(() => String(window.__copied)));

    // ── 危险重跑：shutdown -h now 命中内置形态 → 确认框（仍可取消）──
    await clickRowAction(page, "shutdown -h now", "block-rerun");
    ck.check("危险重跑弹确认框（标题「危险命令重跑到」）", (await dialogTitle(page) ?? "").includes("危险命令重跑到"),
      await dialogTitle(page) ?? "(无弹窗)");
    ck.check("危险重跑确认框给原因与按钮（关机/重启/停机 · 仍然重跑）", await page.evaluate(() => {
      const l = document.querySelector('[data-testid="paste-risk-list"]');
      const b = document.querySelector('[data-testid="paste-send"]');
      return !!l && l.textContent.includes("关机/重启/停机") && l.textContent.includes("shutdown -h now")
        && !!b && b.textContent.includes("仍然重跑");
    }), "");
    await page.evaluate(() => document.querySelector(".paste-dialog [data-autofocus]")?.click());
    await page.waitForTimeout(300);
    ck.check("取消后不发送（弹窗关闭）", (await dialogTitle(page)) === null, "");

    // ── 安全重跑：df -h 无命中且单行 → 直接发送（不经确认框）──
    await clickRowAction(page, "df -h", "block-rerun");
    ck.check("安全重跑直发（无确认框）", (await dialogTitle(page)) === null, "");

    // ── 跳到最近失败：按钮在场可用，点击后失败行高亮唯一 ──
    ck.check("跳转按钮可用（存在 exit≠0 块）", await page.evaluate(() =>
      !(document.querySelector('[data-testid="blocks-jump-fail"]')?.disabled ?? true)), "");
    await page.click('[data-testid="blocks-jump-fail"]');
    await page.waitForTimeout(400);
    ck.check("最近失败行高亮唯一且正确（systemctl restart nginx）", await page.evaluate(() => {
      const rowsAll = [...document.querySelectorAll('[data-testid="block-row"]')];
      const lit = rowsAll.filter((r) => r.classList.contains("blk-fail"));
      return lit.length === 1 && lit[0].querySelector(".blk-cmd")?.textContent === "systemctl restart nginx";
    }), "");

    // ── 工具菜单第二入口 ──
    await page.evaluate(() => document.querySelector('[data-testid="tp-close"]')?.click());
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll(".st-tools button")];
      btns.find((b) => b.textContent.includes("工具"))?.click();
    });
    await page.waitForTimeout(300);
    await page.click('[data-testid="tools-blocks"]');
    await page.waitForTimeout(500);
    ck.check("工具菜单可再开命令块面板", await page.evaluate(() =>
      document.querySelector('[data-testid="tp-title"]')?.textContent === "命令块"
      && document.querySelectorAll('[data-testid="block-row"]').length === 5), "");

    // 收尾：关面板（不残留会话/弹窗）
    await page.evaluate(() => document.querySelector('[data-testid="sb-blocks"]')?.click());
    await page.waitForTimeout(300);
    ck.check("收尾：面板已关", await page.evaluate(() => !document.querySelector('[data-testid="tp-title"]')), "");
  },
};
