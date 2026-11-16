// 88 移动端终端触屏交互（KI-052）：长按选词 → 浮条（复制/粘贴/全选/取消）、保留
// 手指拖动扩选、返回键收起并清选区、粘贴仍走统一粘贴链（多行必确认）、点按链接
// 弹浮条（打开/复制链接）而非「按住 ⌘ 再单击」的桌面提示。
//
// 桌面 Chrome 上复现：data-platform=android 让 isMobilePlatform() 判定为移动端，
// pointer 事件用合成 PointerEvent(pointerType:"touch")；链接点按走 xterm 自己的
// Linkifier（真鼠标事件 + 平台判定），不需要触屏模拟。
const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

// 终端几何：取可见会话的 .xterm-screen 矩形 + xterm 私有 cell 尺寸（与 addon-fit 同源）

const touch = (page, type, x, y, id = 77) => page.evaluate(([t, px, py, pid]) => {
  const screen = window.__t.element.querySelector(".xterm-screen");
  screen.dispatchEvent(new PointerEvent(t, {
    pointerId: pid, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true,
    clientX: px, clientY: py, button: 0, buttons: t === "pointerup" ? 0 : 1,
  }));
}, [type, x, y, id]);

const barIds = (page) => page.evaluate(() => {
  const b = document.querySelector("[data-testid=touch-bar]");
  return b ? [...b.querySelectorAll("[data-testid]")].map((x) => x.dataset.testid) : null;
});

const selection = (page) => page.evaluate(() => window.__t.getSelection());

module.exports = {
  title: "移动端触屏终端：长按选词/拖动扩选/浮条动作、返回键、链接浮条",
  async run({ page, ck }) {
    await connectLocal(page);
    await page.evaluate(() => {
      const live = [...window.__t_terms.values()].find((t) =>
        t.element && t.element.isConnected && t.element.getBoundingClientRect().height > 0);
      live.write("\x1b[2J\x1b[3J\x1b[H");
      live.write("hello world alpha\r\nsee https://example.com/tiny for details\r\n");
    });
    await page.waitForTimeout(350);
    // 进入移动端世界（行为裁剪读 dataset；宽度仍 1440，不触发窄屏布局断点）
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await page.waitForTimeout(200);
    const g = await page.evaluate(() => {
      const t = window.__t_terms && [...window.__t_terms.values()].find((x) =>
        x.element && x.element.isConnected && x.element.getBoundingClientRect().height > 0);
      if (!t) return null;
      window.__t = t;
      const el = t.element.querySelector(".xterm-screen");
      const r = el.getBoundingClientRect();
      const cell = t._core?._renderService?.dimensions?.css?.cell;
      return { left: r.left, top: r.top, w: cell?.width ?? 0, h: cell?.height ?? 0, rows: t.rows };
    });
    ck.check("终端可见且能取到 cell 尺寸", !!g && g.w > 0 && g.h > 0, JSON.stringify(g));
    if (!g) return;
    // 视口行 0/1 对应的缓冲区行（清屏后 viewportY 应为 0）
    const pt = (col, vrow) => ({ x: g.left + (col + 0.5) * g.w, y: g.top + (vrow + 0.5) * g.h });

    // ── 长按选词：480ms 触发，手指还按着时浮条已在屏幕上 ──
    const p1 = pt(1, 0); // "hello" 的 e
    await touch(page, "pointerdown", p1.x, p1.y);
    await page.waitForTimeout(640);
    const ids = await barIds(page);
    ck.check("长按 480ms 弹出选区浮条（复制/粘贴/全选/取消）",
      !!ids && ids.includes("touch-copy") && ids.includes("touch-paste")
        && ids.includes("touch-select-all") && ids.includes("touch-cancel"),
      JSON.stringify(ids));
    ck.eq("长按选中的是触点所在的词", await selection(page), "hello");
    ck.check("浮条期间手指未抬起也不被遮罩吞掉（bar 仍在）", !!(await barIds(page)), "");

    // ── 拖动扩选：从词首拖到同行的 "d" 列（col 10）──
    const p2 = pt(10, 0);
    await touch(page, "pointermove", p2.x, p2.y);
    ck.eq("按住拖动扩选到目标列", await selection(page), "hello world");
    await touch(page, "pointerup", p2.x, p2.y);

    // ── 复制：写剪贴板 + toast；选区保留（与桌面高亮同口径）──
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
    });
    // 浮条落地时吞了一次 click（600ms 窗），等窗口过去再真点
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-copy"]');
    await page.waitForTimeout(300);
    ck.eq("「复制」把选区写入剪贴板", await page.evaluate(() => window.__copied), "hello world");
    ck.eq("复制后浮条收起", await barIds(page), null);
    ck.eq("复制后选区保留", await selection(page), "hello world");
    ck.check("复制后有 toast 告知字符数", await page.evaluate(() =>
      [...document.querySelectorAll(".toast")].some((e) => e.textContent.includes("已复制"))), "");

    // ── 粘贴：走同一条 pasteTextInto 链，多行必弹确认（不静默执行）──
    await page.evaluate(() => {
      navigator.clipboard.readText = () => Promise.resolve("line-one\nline-two");
    });
    const p3 = pt(1, 1);
    await touch(page, "pointerdown", p3.x, p3.y, 78);
    await page.waitForTimeout(640);
    ck.check("第二次长按仍弹浮条", !!(await barIds(page)), "");
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-paste"]');
    await page.waitForTimeout(400);
    ck.check("「粘贴」多行内容走统一粘贴链（弹确认卡）",
      await page.evaluate(() => !!document.querySelector('[data-testid="paste-dialog-title"]')), "");
    await page.evaluate(() => window.__tinysshBack());
    await page.waitForTimeout(200);
    ck.check("返回键先关粘贴确认卡（不误退应用）", await page.evaluate(() =>
      !document.querySelector('[data-testid="paste-dialog-title"]') && window.__tinysshBack !== undefined), "");

    // ── 返回键收起浮条并清选区 ──
    await touch(page, "pointerup", p3.x, p3.y, 78);
    const p4 = pt(1, 0);
    await touch(page, "pointerdown", p4.x, p4.y, 79);
    await page.waitForTimeout(640);
    const handled = await page.evaluate(() => window.__tinysshBack());
    await page.waitForTimeout(200);
    ck.eq("返回键被前端接管（不退 App）", handled, true);
    ck.eq("返回键收起浮条", await barIds(page), null);
    ck.eq("返回键清掉选区", await selection(page), "");

    // ── 全选：整屏入选区，浮条留在原位（否则整屏选区没有「复制」入口）──
    await touch(page, "pointerdown", p4.x, p4.y, 80);
    await page.waitForTimeout(640);
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-select-all"]');
    await page.waitForTimeout(200);
    const all = await selection(page);
    ck.check("「全选」选中整屏内容且浮条保留",
      all.includes("hello world alpha") && all.includes("https://example.com/tiny") && !!(await barIds(page)),
      JSON.stringify(all.slice(0, 40)));
    await page.click('[data-testid="touch-copy"]');
    await page.waitForTimeout(250);
    const copiedAll = await page.evaluate(() => window.__copied);
    ck.check("全选后可直接复制整屏且收起浮条",
      (copiedAll ?? "").includes("hello world alpha") && !(await barIds(page)), JSON.stringify((copiedAll ?? "").slice(0, 40)));

    // ── 链接点按：xterm Linkifier 正常识别后，移动端弹浮条（打开/复制链接），
    //    不再给「按住 ⌘ 再单击」的桌面提示 ──
    const link = pt(10, 1); // "https://example.com/tiny" 中段
    await page.mouse.move(link.x, link.y);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const linkIds = await barIds(page);
    ck.check("点按终端里的 URL 弹出链接浮条（打开/复制链接）",
      !!linkIds && linkIds.includes("touch-link-open") && linkIds.includes("touch-link-copy"),
      JSON.stringify(linkIds));
    ck.check("移动端点链接不再弹「按住 ⌘」提示", await page.evaluate(() =>
      ![...document.querySelectorAll(".toast")].some((e) => e.textContent.includes("再单击"))), "");
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-link-copy"]');
    await page.waitForTimeout(250);
    const copiedUrl = await page.evaluate(() => window.__copied);
    ck.check("「复制链接」写入完整 URL 并收起浮条",
      /^https:\/\/example\.com\/tiny/.test(copiedUrl ?? "") && !(await barIds(page)), JSON.stringify(copiedUrl));

    // ── 「更多」页：终端维护（清屏/重置鼠标上报/重绘）——桌面上这四项只在终端
    //    右键菜单里，触屏没有右键，此前完全无入口 ──
    await touch(page, "pointerdown", p4.x, p4.y, 81);
    await page.waitForTimeout(640);
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-more"]');
    await page.waitForTimeout(250);
    const moreIds = await barIds(page);
    ck.check("「更多」页给出清屏/重置鼠标上报/重绘/返回",
      !!moreIds && ["touch-clear", "touch-mouse-reset", "touch-redraw", "touch-back"]
        .every((id) => moreIds.includes(id)), JSON.stringify(moreIds));
    ck.check("未拖过面板时不给「重置面板布局」（与桌面右键同条件）",
      !(moreIds ?? []).includes("touch-pane-reset"), JSON.stringify(moreIds));
    // 返回键在更多页只回选区页，不一步收掉整个浮条
    const backOnMore = await page.evaluate(() => window.__tinysshBack());
    await page.waitForTimeout(200);
    const backIds = await barIds(page);
    ck.check("返回键在更多页回到第一页（浮条仍在）",
      backOnMore === true && !!backIds && backIds.includes("touch-copy"), JSON.stringify(backIds));
    await page.waitForTimeout(500);
    await page.click('[data-testid="touch-more"]');
    await page.waitForTimeout(250);
    await page.click('[data-testid="touch-clear"]');
    await page.waitForTimeout(300);
    ck.check("「清屏」清掉终端内容并收起浮条", await page.evaluate(() => {
      const line = window.__t.buffer.active.getLine(0)?.translateToString(true) ?? "";
      return !line.includes("hello") && !document.querySelector("[data-testid=touch-bar]");
    }));
  },
};
