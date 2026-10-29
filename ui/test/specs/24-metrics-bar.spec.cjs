// 24 监控条（命令框退役轮）：命令框腾出的底部常驻条改为 FinalShell 式远端资源
// 采样条——SSH 会话出条且五段数值完整；本地会话不出条；暂停可切换（采样停止
// 由真实后端验证，demo 域只断言开关状态）；命令框输入面确认退役。
const connect = async (page, name) => {
  const c = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  await c.hover();
  await page.waitForTimeout(250);
  await (await c.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1400);
};
const barText = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="metrics-bar"]');
  return el ? el.textContent.replace(/\s+/g, " ") : null;
});
const closeViaMenu = async (page, namePart) => {
  const has = await page.evaluate((t) => [...document.querySelectorAll(".tab")].some((x) => x.textContent.includes(t)), namePart);
  if (!has) return;
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
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
    if (b) b.click();
  });
  await page.waitForTimeout(900);
};

module.exports = {
  title: "监控条：SSH 会话出条+五段数值，本地会话隐藏，暂停可切换，命令框退役",
  async run({ page, ck }) {
    // demo 开机有 prod-1/staging-1 两签但无活动会话（welcome 在场）——先激活 prod-1
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("prod-1"));
      if (!tab) throw new Error("prod-1 tab not found");
      tab.click();
    });
    // 首样到达后监控条应在场
    await page.waitForSelector('[data-testid="metrics-bar"]', { timeout: 4000 }).catch(() => {});
    let bar = await barText(page);
    ck.check("SSH 会话（prod-1）：监控条在场", !!bar, bar || "null");
    ck.check("主机 chip=ops@prod-1", !!bar && bar.includes("ops@prod-1"), bar);
    // CPU%/网速是相邻两样差分——等第二个采样（3s 周期）到达再断言数值段
    await page.waitForFunction(
      () => /(B\/s|KB\/s|MB\/s)/.test(document.querySelector('[data-testid="metrics-bar"]')?.textContent ?? ""),
      { timeout: 6000 },
    ).catch(() => {});
    bar = await barText(page);
    const flat = bar ?? "";
    // 注意：textContent 各段之间没有空格（「CPU27%」「运行14 小时」）——正则用 \s*
    ck.check("CPU 段有数值（xx%）", /CPU\s*\d+%/.test(flat), flat);
    ck.check("内存段=用量/总量 GB", /\d+\.\d{2} \/ \d+\.\d{2} GB/.test(flat), flat);
    ck.check("网络段有收发速率", /↓/.test(flat) && /↑/.test(flat) && /(B\/s|KB\/s|MB\/s)/.test(flat), flat);
    ck.check("运行段有时长", /运行\s*(刚刚|\d+ 分钟|\d+ 小时|\d+ 天)/.test(flat), flat);
    ck.check("磁盘段=根分区 56%", /磁盘.*56%/.test(flat), flat);

    // 挤压回归（用户反馈窄窗各段文字互压）：旧实现 .mseg 允许 flex 收缩，
    // min-width:0 + nowrap 让文字溢出到邻段；现为 flex:none + 容器分档隐藏。
    // 两个宽度各验一次：段盒不重叠，且窄档确实按优先级隐藏。
    const vp0 = page.viewportSize();
    const barCheck = () => page.evaluate(() => {
      const bar = document.querySelector('[data-testid="metrics-bar"]');
      if (!bar) return { w: 0, overlap: true, hidden: [] };
      const kids = [...bar.children].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(el).display !== "none";
      });
      let overlap = false;
      for (let i = 1; i < kids.length; i++) {
        if (kids[i].getBoundingClientRect().left < kids[i - 1].getBoundingClientRect().right - 0.5) overlap = true;
      }
      const hidden = [...bar.querySelectorAll(".mseg")]
        .filter((el) => getComputedStyle(el).display === "none")
        .map((el) => el.getAttribute("data-pri"));
      return { w: Math.round(bar.clientWidth), overlap, hidden };
    });
    const wide = await (async () => { await page.setViewportSize({ width: 1440, height: vp0.height }); await page.waitForTimeout(250); return barCheck(); })();
    ck.check("宽窗：各段盒子不重叠", !wide.overlap, JSON.stringify(wide));
    const narrow = await (async () => { await page.setViewportSize({ width: 1000, height: vp0.height }); await page.waitForTimeout(250); return barCheck(); })();
    ck.check("窄窗：各段盒子不重叠（不互相压字）", !narrow.overlap, JSON.stringify(narrow));
    ck.check("窄窗：按优先级隐藏低优先段", narrow.hidden.length > 0 && narrow.w > 0, JSON.stringify(narrow));
    ck.check("窄窗：CPU/内存恒在", await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="metrics-bar"]');
      const t = bar?.textContent ?? "";
      return t.includes("CPU") && t.includes("内存");
    }), "");
    await page.setViewportSize(vp0);
    await page.waitForTimeout(250);

    // 暂停切换：按钮 aria-pressed 翻转（demo 后端供样恒成功，采样停止在真实域验证）
    const pressed0 = await page.evaluate(() => document.querySelector('[data-testid="metrics-pause"]')?.getAttribute("aria-pressed"));
    await page.evaluate(() => document.querySelector('[data-testid="metrics-pause"]').click());
    await page.waitForTimeout(200);
    const pressed1 = await page.evaluate(() => document.querySelector('[data-testid="metrics-pause"]')?.getAttribute("aria-pressed"));
    ck.check("暂停钮 aria-pressed 翻转", pressed0 === "false" && pressed1 === "true", `${pressed0}→${pressed1}`);
    await page.evaluate(() => document.querySelector('[data-testid="metrics-pause"]').click());
    await page.waitForTimeout(200);

    // 命令框退役：执行单条命令输入面不再存在
    ck.check("命令框已退役（无执行单条命令输入面）",
      await page.evaluate(() => !document.querySelector('.term-col input[placeholder*="执行单条命令"]')), "");

    // 关集成会话（noint-1，demo 投影 Disabled）：监控条照常在场——采样走 Fresh
    // 独立通道，与 shell 集成无关（旧命令框恰恰在此整条隐藏，正反之证）。
    // demo 地址未信任 → 先过 TOFU
    await connect(page, "noint-1（无集成）");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".hk-actions button")].find((x) => x.textContent.includes("信任并连接"));
      if (b) b.click();
    });
    // 等活动签切到 noint-1（监控条 chip 随活动会话）：bar 常驻所以选择器立即命中，
    // 必须等内容变化而不是等元素出现
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="metrics-bar"]')?.textContent ?? "").includes("noint-1"),
      { timeout: 6000 },
    ).catch(() => {});
    bar = await barText(page);
    ck.check("关集成会话：监控条照常在场（集成无关性）", !!bar && bar.includes("noint-1"), bar);

    // 切回 prod-1：出条跟随活动会话
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("prod-1"));
      if (!tab) throw new Error("tab not found");
      tab.click();
    });
    await page.waitForTimeout(400);
    bar = await barText(page);
    ck.check("切回 SSH 会话：监控条回归", !!bar && bar.includes("ops@prod-1"), bar);

    // 收尾（prod-1/staging-1 是开机预置会话，一并关闭复原空场）；无活动会话时
    // 终端域被 welcome 覆盖，监控条随 term-col 一起不出现——本地会话（kind=local）
    // 不出条的 kind 门控由真实应用冒烟验证（demo 把本机也投影成 ssh，域所限）
    await closeViaMenu(page, "noint-1");
    await closeViaMenu(page, "prod-1");
    await closeViaMenu(page, "staging-1");
    ck.check("收尾清空会话", (await page.evaluate(() => document.querySelectorAll(".tab").length)) === 0, "");
  },
};
