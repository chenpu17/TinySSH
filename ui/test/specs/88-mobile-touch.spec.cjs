// 88 移动端终端触屏交互（KI-052）：长按选词 → 浮条（复制/粘贴/全选/取消）、保留
// 手指拖动扩选、返回键收起并清选区、粘贴仍走统一粘贴链（多行必确认）、点按链接
// 弹浮条（打开/复制链接）而非「按住 ⌘ 再单击」的桌面提示。
// KI-134：安卓长按补发的 contextmenu 在长按期间被拦下（不聚焦终端、不叠右键菜单、
// 不关刚弹出的浮条）。
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

    // ── KI-133：取消链接浮条后不点别处、直接再点同一个链接 ──
    //    xterm 的 Linkifier 只在指针移进「新格子」时重新识别；触屏每次点按补发的
    //    mousemove 都落在所点格子上，它认为「没动」→ 点了没反应。手指落下时清掉它的
    //    上一格记忆。一次触屏点按 = 合成触摸 pointerdown/up（真浏览器里还有 touchstart/
    //    touchend，与这里无关）+ 浏览器随后补发的真实鼠标事件
    const tapLink = async (id) => {
      await touch(page, "pointerdown", link.x, link.y, id);
      await touch(page, "pointerup", link.x, link.y, id);
      await page.mouse.move(link.x, link.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(250);
    };
    // 浮条落地时吞 600ms 窗内的 click（同上），等窗口过去再真点
    await page.waitForTimeout(700);
    await page.click('[data-testid="touch-link-cancel"]');
    await page.waitForTimeout(200);
    ck.check("「取消」收起链接浮条", (await barIds(page)) === null, JSON.stringify(await barIds(page)));
    await tapLink(90);
    const again = await barIds(page);
    ck.check("取消后不点别处、直接再点同一个链接：浮条重新弹出",
      !!again && again.includes("touch-link-open"), JSON.stringify(again));
    await page.waitForTimeout(700);
    await tapLink(91);
    const third = await barIds(page);
    ck.check("浮条开着时再点终端（落在遮罩上）：浮条收起", third === null, JSON.stringify(third));
    await tapLink(92);
    ck.check("收起后第三次点同一个链接：浮条仍能弹出（留给下一步「复制链接」）", !!(await barIds(page)), "");
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

    // ── KI-134：安卓长按到点后浏览器补发 contextmenu，落点看谁先到，三处都得拦 ──
    //    ① 抢在 480ms 定时器前落在 xterm 上：xterm 借机聚焦隐藏输入框（真机：软键盘
    //       弹出→视口变矮→resize 清掉选区），右键菜单还会叠在随后的选区浮条上；
    //    ② 定时器先到、落在 xterm 上：聚焦同上；
    //    ③ 定时器先到、落在刚弹出的浮条遮罩上：遮罩自己的 contextmenu 把浮条当场关掉。
    //    手指抬起/取消后放行（遮罩上的右键照旧关浮条）；鼠标右键没有触摸 pointerdown，照常弹菜单。
    //    合成 PointerEvent(pointerType:"touch") 不带浏览器补发，这里按时序手动派发。
    await page.evaluate(() => {
      window.__t.write("\x1b[2J\x1b[3J\x1b[H");
      window.__t.write("hello world\r\n");
      window.__ctxSeen = 0;
      // 探针挂在 .xterm 上（与 xterm 自己的 contextmenu 监听同节点同阶段）：
      // 事件在 window 捕获阶段被拦下时这里收不到
      window.__t.element.addEventListener("contextmenu", () => { window.__ctxSeen++; });
      document.activeElement?.blur?.();
    });
    await page.waitForTimeout(250);
    const ctx = (target) => page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : window.__t.element.querySelector(".xterm-screen");
      if (!el) return "missing";
      const pass = el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      return pass ? "passed" : "prevented";
    }, target);
    const seen = () => page.evaluate(() => { const n = window.__ctxSeen; window.__ctxSeen = 0; return n; });
    const focused = () => page.evaluate(() => document.activeElement?.classList?.contains("xterm-helper-textarea") === true);
    const menuOpen = () => page.evaluate(() => !!document.querySelector("[data-testid=term-redraw]"));

    const q = pt(1, 0); // "hello" 的 e
    await touch(page, "pointerdown", q.x, q.y, 82);
    await page.waitForTimeout(300);
    const early = await ctx("");
    await page.waitForTimeout(400);
    const seen1 = await seen();
    ck.check("① 补发抢在定时器前：被拦，xterm 的监听收不到、终端不被聚焦",
      early === "prevented" && seen1 === 0 && !(await focused()), JSON.stringify([early, seen1]));
    ck.check("① 右键菜单没有叠上来，480ms 后照常出选区与浮条",
      !(await menuOpen()) && (await selection(page)) === "hello" && !!(await barIds(page)), "");
    await touch(page, "pointerup", q.x, q.y, 82);

    await touch(page, "pointerdown", q.x, q.y, 83);
    await page.waitForTimeout(640);
    const lateXterm = await ctx("");
    const seen2 = await seen();
    ck.check("② 补发晚于定时器、落在 xterm 上：被拦，选区与浮条保留",
      lateXterm === "prevented" && seen2 === 0 && (await selection(page)) === "hello" && !!(await barIds(page)),
      JSON.stringify([lateXterm, seen2]));
    const lateMask = await ctx("[data-testid=touch-bar-mask]");
    ck.check("③ 补发落在刚弹出的浮条遮罩上：被拦，浮条不被当场关掉",
      lateMask === "prevented" && (await selection(page)) === "hello" && !!(await barIds(page)), lateMask);
    // 放行与否看效果：遮罩与 #term 自己的 contextmenu 处理器都会 preventDefault，
    // dispatchEvent 的返回值在这里分不出「守卫拦下」和「处理器消化」
    await touch(page, "pointerup", q.x, q.y, 83);
    await ctx("[data-testid=touch-bar-mask]");
    ck.check("手指抬起后放行：遮罩上的 contextmenu 照旧关浮条并清选区",
      (await barIds(page)) === null && (await selection(page)) === "", JSON.stringify([await barIds(page), await selection(page)]));

    // 聚焦态（真机上软键盘在场）：浏览器原生长按处理在派发 contextmenu 之前就把焦点从
    // 终端输入框上拿走（合成事件带不出这一步，这里手动失焦模拟），守卫吞掉事件后要把
    // 焦点还回去——不还的话软键盘收起→视口变矮→resize，刚选的词又被清掉
    await page.evaluate(() => window.__t.focus());
    await page.waitForTimeout(120);
    ck.check("起点：终端输入框聚焦", await focused(), "");
    await touch(page, "pointerdown", q.x, q.y, 85);
    await page.waitForTimeout(300);
    await page.evaluate(() => document.activeElement?.blur?.());
    ck.check("模拟原生长按处理：焦点已被拿走", !(await focused()), "");
    await ctx("");
    await page.waitForTimeout(80);
    const seenF = await seen();
    ck.check("聚焦态长按：补发被拦，焦点还给终端输入框", seenF === 0 && (await focused()), JSON.stringify([seenF]));
    await page.waitForTimeout(320);
    ck.check("聚焦态长按：选区与浮条在、右键菜单没有叠上来",
      (await selection(page)) === "hello" && !!(await barIds(page)) && !(await menuOpen()), "");
    await touch(page, "pointerup", q.x, q.y, 85);
    await page.evaluate(() => window.__tinysshBack());
    await page.waitForTimeout(200);

    await touch(page, "pointerdown", q.x, q.y, 84);
    await touch(page, "pointercancel", q.x, q.y, 84);
    await ctx("");
    const seen3 = await seen();
    ck.check("触摸被取消后放行（此后到达的不是这次长按的补发）：xterm 与 #term 都照常收到",
      seen3 === 1 && (await menuOpen()), JSON.stringify([seen3]));
    await page.evaluate(() => window.__tinysshBack());

    await page.mouse.click(q.x, q.y, { button: "right" });
    await page.waitForTimeout(200);
    ck.check("鼠标右键（无触摸长按）照常弹终端右键菜单", await menuOpen(), "");
    await page.evaluate(() => window.__tinysshBack());
  },
};
