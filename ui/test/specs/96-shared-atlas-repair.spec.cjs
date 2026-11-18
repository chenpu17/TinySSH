// 96 终端共享字形图集错字自愈（GitHub #47 / KI-014 再复发）：
// 两个同 font/theme/DPR 的 WebGL 终端共享 TextureAtlas。清 A 的图集再用另一套
// 字形填回，B 的缓冲区文字没变，但旧 RenderModel 的纹理坐标会画成别的字——
// 与用户截图里中文位置叠出拉丁/符号同型。公开 refresh() 只请求重画，旧模型不动。
// 本 spec 先证明探针能制造错字，再要求 repaintAll 清全部终端模型并逐像素复原。
const SID = "s-demo-0001";
const TEXT = "昇腾负载仍较高 ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";

const openPanel = async (page) => {
  await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", {
    sid, sessions: ["work", "logs", "build"],
  }), SID);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".tab")].find((x) => x.textContent?.includes("prod-1"));
    tab?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-testid="tmux-quick"] button')?.click());
  await page.waitForTimeout(400);
  await page.click('[data-testid="tmux-pane-add-work"]');
  await page.waitForTimeout(1300);
};

module.exports = {
  title: "终端共享图集错字：整组清绘制模型后逐像素复原",
  async run({ page, ck }) {
    await page.waitForTimeout(900);
    await openPanel(page);

    const setup = await page.evaluate(async (text) => {
      const a = window.__t_terms?.get("s-demo-0001");
      const pair = [...(window.__t_pane_terms?.entries() ?? [])][0];
      const b = pair?.[1];
      if (!a || !b) return { missing: true };
      const ra = a._core?._renderService?._renderer?.value;
      const rb = b._core?._renderService?._renderer?.value;
      window.__atlas96 = { a, b, ra, rb };
      b.write(`\x1b[2J\x1b[H\x1b[?25l${text}\r\n${text}\r\n${text}`);
      a.write("\x1b[2J\x1b[H\x1b[?25lMAIN-REFERENCE-abcdefghijklmnopqrstuvwxyz");
      await new Promise((r) => setTimeout(r, 500));
      return {
        missing: false,
        shared: !!ra && !!rb && ra._charAtlas === rb._charAtlas,
        canProbe: typeof ra?.clearTextureAtlas === "function" && !!ra._model && !!rb._model,
        rows: b.rows,
      };
    }, TEXT);
    ck.check("主终端与 tmux 格子均已建立", !setup.missing, JSON.stringify(setup));
    if (setup.missing) return;
    if (!setup.shared || !setup.canProbe) {
      ck.check("当前环境没有可探测的共享 WebGL 图集——跳过像素探针", true, JSON.stringify(setup));
      return;
    }
    ck.check("探针前提：两个终端确实共享同一字形图集", setup.shared, JSON.stringify(setup));

    const clip = await page.evaluate(() => {
      const r = document.querySelector('.tmux-cell[data-tmux="work"] .tmux-cell-body').getBoundingClientRect();
      return { x: r.x + 8, y: r.y + 4, width: Math.min(560, r.width - 16), height: 72 };
    });
    const before = await page.screenshot({ clip });

    await page.evaluate(async () => {
      const { a, b, ra } = window.__atlas96;
      ra.clearTextureAtlas();
      let flood = "";
      for (let i = 0; i < 1800; i++) flood += String.fromCharCode(33 + (i * 17 % 90));
      a.write(`\x1b[2J\x1b[H${flood}`);
      // 只碰 B 的最后一行：顶部三行若仍正常，才说明不是碰巧整屏重画。
      b.write(`\x1b[${b.rows};1Hx`);
      await new Promise((r) => setTimeout(r, 650));
    });
    const corrupt = await page.screenshot({ clip });
    ck.check("共享图集探针确实制造出错字（基准画面已改变）", !before.equals(corrupt),
      `正常 ${before.length} bytes / 错字 ${corrupt.length} bytes`);
    ck.check("错字只是渲染层：终端缓冲区原文未变", await page.evaluate((text) => {
      const { b } = window.__atlas96;
      return [0, 1, 2].every((i) => b.buffer.active.getLine(i)?.translateToString(true).includes(text));
    }, TEXT), TEXT);

    const repair = await page.evaluate(async () => {
      const { repaintAll } = await import("/src/terminal/repaint.ts");
      const { a, b, ra, rb } = window.__atlas96;
      let atlasClears = 0;
      const clearA = ra.clearTextureAtlas.bind(ra);
      const clearB = rb.clearTextureAtlas.bind(rb);
      ra.clearTextureAtlas = () => { atlasClears++; clearA(); };
      rb.clearTextureAtlas = () => { atlasClears++; clearB(); };
      repaintAll([{ term: a }, { term: b }]);
      const modelsCleared = [ra, rb].every((r) => r._model.cells.every((v) => v === 0));
      await new Promise((r) => setTimeout(r, 650));
      return { atlasClears, modelsCleared };
    });
    ck.check("repaintAll 同步清空两个终端的旧 RenderModel", repair.modelsCleared, JSON.stringify(repair));
    ck.check("自愈不再调用有共享缺陷的 clearTextureAtlas", repair.atlasClears === 0, JSON.stringify(repair));

    const repaired = await page.screenshot({ clip });
    ck.check("修复后与正常基准逐像素一致", before.equals(repaired),
      `正常 ${before.length} bytes / 修复 ${repaired.length} bytes / 错字 ${corrupt.length} bytes`);
  },
};
