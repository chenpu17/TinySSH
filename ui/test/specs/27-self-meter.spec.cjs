// 27 自身开销监控（本轮）：tinyssh-app 进程级 CPU/内存上屏——设置→关于详版
// （CPU%+工作集+提交+采样时刻，2s 刷新）与监控条「本机」缩略段（会话中随手
// 可见）。demo 域供模拟值（形状与真实后端一致，cpu 恒有值）；核心不可达自
// 隐藏由组件内 null 分支保证（demo 恒可达，不可达路径由真实域冒烟覆盖）。
module.exports = {
  title: "自身开销：关于卡详版实时刷新，监控条「本机」段在场",
  async run({ page, ck }) {
    // ---- 监控条「本机」段：SSH 会话在场时随手可见 ----
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("prod-1"));
      if (!tab) throw new Error("prod-1 tab not found");
      tab.click();
    });
    await page.waitForSelector('[data-testid="self-chip"]', { timeout: 6000 }).catch(() => {});
    const chip = await page.evaluate(() => document.querySelector('[data-testid="self-chip"]')?.textContent?.replace(/\s+/g, " ") ?? null);
    ck.check("监控条「本机」段在场", !!chip, chip ?? "null");
    ck.check("本机段含 CPU 百分比", !!chip && /本机\s*CPU\s*[\d.]+%/.test(chip), chip);
    ck.check("本机段含工作集 MB", !!chip && /\d+ MB/.test(chip), chip);
    // 关闭监控条所在会话不影响本段断言已有结论；随后关于卡在空场也可验证
    // ---- 设置→关于 详版：数值齐全且随轮询刷新 ----
    await page.click(".hb-settings");
    await page.click("[data-testid=settings-cat-about]");
    await page.waitForSelector('[data-testid="self-meter"]', { timeout: 6000 }).catch(() => {});
    const readCard = () => page.evaluate(() => ({
      body: document.querySelector('[data-testid="self-meter"]')?.textContent?.replace(/\s+/g, " ") ?? null,
      at: document.querySelector('[data-testid="self-meter-at"]')?.textContent ?? null,
    }));
    const c1 = await readCard();
    ck.check("关于卡自身开销块在场", !!c1.body, c1.body ?? "null");
    ck.check("CPU 段有数值", !!c1.body && /CPU\s*[\d.]+%/.test(c1.body), c1.body);
    ck.check("工作集段 MB", !!c1.body && /内存\s*\d+ MB/.test(c1.body), c1.body);
    ck.check("提交段 MB", !!c1.body && /提交\s*\d+ MB/.test(c1.body), c1.body);
    ck.check("采样时刻 HH:MM:SS", !!c1.at && /^\u91c7\u6837\u4e8e \d{2}:\d{2}:\d{2}$/.test(c1.at), c1.at);
    // 2s 周期轮询——等下一拍，采样时刻必须前进（活性判定，确定性无 flake）
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="self-meter-at"]');
        return !!el && el.textContent !== prev;
      },
      c1.at,
      { timeout: 6000 },
    ).catch(() => {});
    const c2 = await readCard();
    ck.check("2s 轮询后采样时刻前进（实时刷新）", !!c2.at && c2.at !== c1.at, `${c1.at} → ${c2.at}`);
    // 收尾：关设置面板，恢复空场（会话关闭交由 24 号 spec 自理，互不依赖）
    await page.click("[data-testid=settings-close]").catch(() => {});
  },
};
