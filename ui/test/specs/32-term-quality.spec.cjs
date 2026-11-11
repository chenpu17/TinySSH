// 32 终端品质轮（P0）：扩展字符宽度（unicode11）、连字开关（含 WebGL↔DOM 渲染器取舍）、
// 外观五项（字体族/光标样式/闪烁/滚屏行数/字距）与危险粘贴确认。
// 断言面：设置 → 终端 新卡控件与回显、DEV 探针（__t_terms options / __t_liga）上
// 存量与新建终端实例的即时生效与继承、demo 镜像 scan_paste_danger 的确认框、
// reload 后 localStorage 回读与终端重建继承。
// 字体渲染本体（连字是否真的合成、Cascadia 是否真装了）属视觉/环境面，不在本 spec。

/** 当前可见的终端实例 sid 列表（隐藏 pane 不算；尚未建过终端则探针未建 → 空表）。 */
const liveSids = (page) =>
  page.evaluate(() => {
    const terms = window.__t_terms;
    if (!terms) return [];
    return [...terms.entries()]
      .filter(([, t]) => {
        const el = t.element;
        return !!el && el.isConnected && el.getBoundingClientRect().height > 0;
      })
      .map(([sid]) => sid);
  });

const termInfo = (page, sid) =>
  page.evaluate((s) => {
    const t = window.__t_terms.get(s);
    return {
      unicode: t.unicode.activeVersion,
      scrollback: t.options.scrollback,
      cursorStyle: t.options.cursorStyle,
      cursorBlink: t.options.cursorBlink,
      fontFamily: t.options.fontFamily,
      letterSpacing: t.options.letterSpacing,
    };
  }, sid);

const ligaSids = (page) => page.evaluate(() => [...(window.__t_liga ?? [])]);

const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

/** 打开设置 → 终端 分类 */
const openTermSettings = async (page) => {
  await page.click(".hb-settings");
  await page.waitForTimeout(700);
  await page.click('[data-testid="settings-cat-terminal"]');
  await page.waitForTimeout(400);
};

/** 关设置面板（点右上角关闭） */
const closeSettings = async (page) => {
  await page.evaluate(() => document.querySelector('[data-testid="settings-close"]')?.click());
  await page.waitForTimeout(400);
};

/** 用 ⌘V 触发粘贴流（demo 路径读 navigator.clipboard.readText，已在页面内打桩） */
const pasteViaCmdV = async (page) => {
  await page.evaluate(() => {
    // 取活动 pane 的输入域（隐藏会话的 textarea 也在 DOM 里，别喂错实例）
    const ta = document.querySelector(".term-session.active .xterm-helper-textarea")
      ?? document.querySelector(".xterm-helper-textarea");
    if (!ta) throw new Error("xterm textarea 不在场");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v", code: "KeyV", metaKey: true, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForTimeout(600);
};

/** 连接一台主机（demo 预置会话不自动武装，终端要靠主动建连产生） */
const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

module.exports = {
  title: "终端品质：宽字符/连字/外观五项/危险粘贴确认",
  async run({ page, ck }) {
    // ── 设置面板：新卡与默认回显 ──
    await openTermSettings(page);
    for (const id of ["term-font-select", "term-liga-toggle", "term-cursor-select",
      "term-cursor-blink-toggle", "term-scrollback-select", "term-spacing-select",
      "term-wheel-rate-select"]) {
      ck.check(`终端外观控件在场：${id}`, await page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), id));
    }
    const defaults = await page.evaluate(() => ({
      font: document.querySelector('[data-testid="term-font-select"]').value,
      liga: document.querySelector('[data-testid="term-liga-toggle"]').checked,
      cursor: document.querySelector('[data-testid="term-cursor-select"]').value,
      blink: document.querySelector('[data-testid="term-cursor-blink-toggle"]').checked,
      scrollback: document.querySelector('[data-testid="term-scrollback-select"]').value,
      spacing: document.querySelector('[data-testid="term-spacing-select"]').value,
      wheelRate: document.querySelector('[data-testid="term-wheel-rate-select"]').value,
    }));
    ck.check("默认回显（Maple Mono 中文等宽 / 连字关 / 方块光标 / 闪烁开 / 4000 行 / 字距 0 / 滚轮 60）",
      defaults.font === "maple" && !defaults.liga && defaults.cursor === "block"
        && defaults.blink && defaults.scrollback === "4000" && defaults.spacing === "0"
        && defaults.wheelRate === "60",
      JSON.stringify(defaults));
    const scrollbackOptions = await page.locator('[data-testid="term-scrollback-select"] option').evaluateAll(
      (options) => options.map((option) => option.value));
    ck.check("滚屏行数提供 2000/4000/6000/8000/10000 五档",
      JSON.stringify(scrollbackOptions) === JSON.stringify(["2000", "4000", "6000", "8000", "10000"]),
      JSON.stringify(scrollbackOptions));
    ck.check("默认档标注跟随 4000 行而非旧 10000 行", await page.locator(
      '[data-testid="term-scrollback-select"] option[value="4000"]').evaluate(
        (option) => option.textContent.includes("默认")));
    // 用户反馈 #16：字体预设偏少——补齐常见等宽字体（装没装由就地探测如实提示）
    const fontOptions = await page.locator('[data-testid="term-font-select"] option').evaluateAll(
      (options) => options.map((option) => option.value));
    ck.check("字体列表含新增预设（更纱黑体/Noto CJK/Fira/Source Code Pro/IBM Plex/Ubuntu）",
      ["sarasa", "noto-cjk", "fira", "source-code-pro", "ibm-plex", "ubuntu"]
        .every((id) => fontOptions.includes(id)), JSON.stringify(fontOptions));

    // ── 存量实例：先建一台（demo 预置会话不自动武装），验 unicode11 已激活 ──
    await closeSettings(page);
    await connectHost(page, "本机");
    const sids0 = await liveSids(page);
    ck.check("建连后有可见终端实例", sids0.length >= 1, `sids=${JSON.stringify(sids0)}`);
    const info0 = await termInfo(page, sids0[0]);
    ck.eq("Unicode 11 宽度表已激活", info0.unicode, "11");
    ck.eq("滚屏行数默认 4000", info0.scrollback, 4000);

    // ── 外观五项即时生效（存量实例） ──
    await openTermSettings(page);
    await page.selectOption('[data-testid="term-font-select"]', "sarasa");
    await page.waitForTimeout(300);
    ck.check("新增字体预设即时生效（更纱黑体栈）",
      (await termInfo(page, sids0[0])).fontFamily.includes("Sarasa Mono SC"),
      (await termInfo(page, sids0[0])).fontFamily);
    await page.selectOption('[data-testid="term-font-select"]', "cascadia");
    await page.waitForTimeout(300);
    ck.check("字体族即时生效（含 Cascadia Mono）", (await termInfo(page, sids0[0])).fontFamily.includes("Cascadia Mono"),
      (await termInfo(page, sids0[0])).fontFamily);
    await page.selectOption('[data-testid="term-scrollback-select"]', "10000");
    await page.selectOption('[data-testid="term-cursor-select"]', "bar");
    await page.click('[data-testid="term-cursor-blink-toggle"]');
    await page.selectOption('[data-testid="term-spacing-select"]', "1");
    await page.waitForTimeout(400);
    const info1 = await termInfo(page, sids0[0]);
    ck.check("滚屏/光标样式/闪烁/字距即时生效",
      info1.scrollback === 10000 && info1.cursorStyle === "bar" && info1.cursorBlink === false && info1.letterSpacing === 1,
      JSON.stringify({ scrollback: info1.scrollback, cursor: info1.cursorStyle, blink: info1.cursorBlink, spacing: info1.letterSpacing }));
    ck.check("demo 持久化（localStorage 六键落盘）",
      (await lsGet(page, "ui.v2.terminal.font_family")) === "cascadia"
        && (await lsGet(page, "ui.v2.terminal.scrollback")) === "10000"
        && (await lsGet(page, "ui.v2.terminal.cursor_style")) === "bar"
        && (await lsGet(page, "ui.v2.terminal.cursor_blink")) === "0"
        && (await lsGet(page, "ui.v2.terminal.letter_spacing")) === "1",
      JSON.stringify(await page.evaluate(() => Object.fromEntries(
        Object.keys(localStorage).filter((k) => k.startsWith("ui.v2.terminal.")).map((k) => [k, localStorage.getItem(k)])))));

    // ── 滚轮上报频率（KI-004）：五档 + 跟随刷新率，改档即时落盘 ──
    await page.selectOption('[data-testid="term-wheel-rate-select"]', "auto");
    await page.waitForTimeout(200);
    const wheelSel = await page.evaluate(() => ({
      value: document.querySelector('[data-testid="term-wheel-rate-select"]').value,
      stored: localStorage.getItem("ui.v2.terminal.wheel_rate"),
      options: [...document.querySelector('[data-testid="term-wheel-rate-select"]').options].map((o) => o.value),
    }));
    ck.check("滚轮频率五档在场（30/60/90/120/auto）",
      JSON.stringify(wheelSel.options) === JSON.stringify(["30", "60", "90", "120", "auto"]),
      JSON.stringify(wheelSel.options));
    ck.check("滚轮频率切到「跟随刷新率」即时落盘",
      wheelSel.value === "auto" && wheelSel.stored === "auto", JSON.stringify(wheelSel));

    // ── 连字开关：存量实例切换 + 新建实例继承 ──
    await page.click('[data-testid="term-liga-toggle"]');
    await page.waitForTimeout(400);
    ck.check("连字开关即时生效（存量实例载入 LigaturesAddon）",
      (await ligaSids(page)).includes(sids0[0]), `liga=${JSON.stringify(await ligaSids(page))}`);
    ck.eq("连字落盘", await lsGet(page, "ui.v2.terminal.ligatures"), "1");
    await closeSettings(page);

    // 新建会话（prod-1）→ 新终端继承全部外观与连字
    await connectHost(page, "prod-1");
    const sids1 = await liveSids(page);
    const newSid = sids1.find((s) => !sids0.includes(s));
    ck.check("新建会话产生新终端实例", !!newSid, `sids=${JSON.stringify(sids1)}`);
    if (newSid) {
      const info2 = await termInfo(page, newSid);
      ck.check("新实例继承外观与连字（Unicode11/字体/滚屏/连字）",
        info2.unicode === "11" && info2.fontFamily.includes("Cascadia Mono")
          && info2.scrollback === 10000 && (await ligaSids(page)).includes(newSid),
        JSON.stringify({ unicode: info2.unicode, font: info2.fontFamily, sb: info2.scrollback }));
    }

    // ── 危险粘贴确认（demo 镜像 scan_paste_danger） ──
    await page.evaluate(() => {
      const stub = { readText: () => Promise.resolve(window.__pasteText ?? ""), writeText: () => Promise.resolve() };
      try { Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true }); }
      catch { navigator.clipboard.readText = stub.readText; }
    });
    await page.evaluate(() => { window.__pasteText = "sudo rm -rf /"; });
    await pasteViaCmdV(page);
    ck.check("危险粘贴弹确认框（标题含「危险内容粘贴到」）", await page.evaluate(() => {
      const t = document.querySelector('[data-testid="paste-dialog-title"]');
      return !!t && t.textContent.includes("危险内容粘贴到");
    }), await page.evaluate(() => document.querySelector('[data-testid="paste-dialog-title"]')?.textContent ?? "(无弹窗)"));
    ck.check("命中清单在场并给出原因（删除根目录）", await page.evaluate(() => {
      const l = document.querySelector('[data-testid="paste-risk-list"]');
      return !!l && l.textContent.includes("删除根目录") && l.textContent.includes("rm -rf /");
    }), await page.evaluate(() => document.querySelector('[data-testid="paste-risk-list"]')?.textContent ?? "(无清单)"));
    ck.check("按钮文案为「仍然发送」", await page.evaluate(() =>
      (document.querySelector('[data-testid="paste-send"]')?.textContent ?? "").includes("仍然发送")));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog .ghost")].find((x) => x.textContent.includes("取消"));
      b?.click();
    });
    await page.waitForTimeout(300);
    ck.check("取消后弹窗关闭（未发送）", await page.evaluate(() => !document.querySelector('[data-testid="paste-risk-list"]')));

    // 安全多行 → 旧口径（多行预览确认，无危险清单）
    await page.evaluate(() => { window.__pasteText = "echo one\necho two"; });
    await pasteViaCmdV(page);
    ck.check("安全多行走多行确认（无危险清单）", await page.evaluate(() => {
      const t = document.querySelector('[data-testid="paste-dialog-title"]');
      return !!t && t.textContent.includes("粘贴多行内容到") && !document.querySelector('[data-testid="paste-risk-list"]');
    }), await page.evaluate(() => document.querySelector('[data-testid="paste-dialog-title"]')?.textContent ?? "(无弹窗)"));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog .ghost")].find((x) => x.textContent.includes("取消"));
      b?.click();
    });
    await page.waitForTimeout(300);

    // 危险但单行、且开启 bracketed paste 的远端也不放过——demo 里 bracketed paste 由
    // 终端态决定，这里只验「危险判定不依赖多行条件」：单行危险内容同样弹窗
    await page.evaluate(() => { window.__pasteText = "mkfs.ext4 /dev/sdb1"; });
    await pasteViaCmdV(page);
    ck.check("单行危险内容同样弹窗（mkfs 命中）", await page.evaluate(() => {
      const l = document.querySelector('[data-testid="paste-risk-list"]');
      return !!l && l.textContent.includes("格式化文件系统");
    }), await page.evaluate(() => document.querySelector('[data-testid="paste-risk-list"]')?.textContent ?? "(无清单)"));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog .ghost")].find((x) => x.textContent.includes("取消"));
      b?.click();
    });
    await page.waitForTimeout(300);

    // ── reload：设置回读 + 重建终端继承 ──
    await page.reload();
    await page.waitForTimeout(1500);
    await openTermSettings(page);
    const after = await page.evaluate(() => ({
      font: document.querySelector('[data-testid="term-font-select"]').value,
      liga: document.querySelector('[data-testid="term-liga-toggle"]').checked,
      cursor: document.querySelector('[data-testid="term-cursor-select"]').value,
      blink: document.querySelector('[data-testid="term-cursor-blink-toggle"]').checked,
      scrollback: document.querySelector('[data-testid="term-scrollback-select"]').value,
      spacing: document.querySelector('[data-testid="term-spacing-select"]').value,
      wheelRate: document.querySelector('[data-testid="term-wheel-rate-select"]').value,
    }));
    ck.check("reload 后设置回显完整",
      after.font === "cascadia" && after.liga && after.cursor === "bar" && !after.blink
        && after.scrollback === "10000" && after.spacing === "1" && after.wheelRate === "auto",
      JSON.stringify(after));
    await closeSettings(page);
    let sids2 = await liveSids(page);
    if (sids2.length === 0) {
      // demo 预置会话 reload 后不自动武装：连一台再验重建终端的继承
      await connectHost(page, "本机");
      sids2 = await liveSids(page);
    }
    ck.check("reload 后仍有可见终端", sids2.length >= 1, `sids=${JSON.stringify(sids2)}`);
    if (sids2.length) {
      const info3 = await termInfo(page, sids2[0]);
      ck.check("reload 重建的终端继承全部品质项",
        info3.unicode === "11" && info3.fontFamily.includes("Cascadia Mono")
          && info3.scrollback === 10000 && info3.letterSpacing === 1 && info3.cursorStyle === "bar"
          && (await ligaSids(page)).includes(sids2[0]),
        JSON.stringify(info3));
    }

    // ── A「回到底部」浮钮（主终端）：滚上去出现并报剩余行数、悬停才显形、
    //    点击回底、ALT 备用屏不出现 ──
    const sidA = sids2[0];
    // 鼠标先离开终端、并让终端失焦：浮钮默认应透明（悬停/聚焦才显形）
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
    await page.waitForTimeout(200);
    const scrollA = await page.evaluate(async (sid) => {
      const t = window.__t_terms.get(sid);
      t.write(Array.from({ length: 200 }, (_, i) => `scroll line ${i}`).join("\r\n") + "\r\n");
      await new Promise((r) => setTimeout(r, 450));
      t.scrollToTop();
      await new Promise((r) => setTimeout(r, 450));
      const btn = document.querySelector(`.term-session[data-sid="${sid}"] [data-testid="term-scroll-bottom"]`);
      return {
        found: !!btn,
        hidden: btn?.hidden ?? null,
        text: btn?.textContent ?? "",
        below: t.buffer.active.baseY - t.buffer.active.viewportY,
        opacity: btn ? getComputedStyle(btn).opacity : null,
      };
    }, sidA);
    ck.check("主终端「回到底部」浮钮在场且滚上去后取消隐藏",
      !!scrollA && scrollA.found && scrollA.hidden === false, JSON.stringify(scrollA));
    ck.check("浮钮文案含剩余行数",
      !!scrollA && scrollA.text.includes("回到底部") && scrollA.text.includes(`下方 ${scrollA.below} 行`),
      JSON.stringify(scrollA));
    ck.check("浮钮默认透明（悬停/聚焦才显形）", scrollA.opacity === "0", String(scrollA.opacity));
    await page.hover(`.term-session[data-sid="${sidA}"]`);
    await page.waitForTimeout(250);
    const hoverOpacity = await page.evaluate((sid) =>
      getComputedStyle(document.querySelector(
        `.term-session[data-sid="${sid}"] [data-testid="term-scroll-bottom"]`)).opacity, sidA);
    ck.check("悬停终端时浮钮显形", hoverOpacity === "1", hoverOpacity);

    // 真鼠标点击浮钮（终端保持焦点）：pointerdown 只拦默认聚焦、不拦 click
    await page.evaluate((sid) =>
      document.querySelector(`.term-session[data-sid="${sid}"] .xterm-helper-textarea`)?.focus(), sidA);
    const btnBox = await page.evaluate((sid) => {
      const r = document.querySelector(
        `.term-session[data-sid="${sid}"] [data-testid="term-scroll-bottom"]`)?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }, sidA);
    if (btnBox) await page.mouse.click(btnBox.x, btnBox.y);
    await page.waitForTimeout(450);
    const afterClick = await page.evaluate((sid) => {
      const t = window.__t_terms.get(sid);
      const btn = document.querySelector(`.term-session[data-sid="${sid}"] [data-testid="term-scroll-bottom"]`);
      const ae = document.activeElement;
      return {
        atBottom: t.buffer.active.viewportY === t.buffer.active.baseY,
        hidden: btn?.hidden ?? null,
        focusKept: !!ae && ae.classList.contains("xterm-helper-textarea")
          && !!ae.closest(`.term-session[data-sid="${sid}"]`),
      };
    }, sidA);
    ck.check("点击浮钮回到底部并隐藏，且不抢终端焦点",
      afterClick.atBottom && afterClick.hidden === true && afterClick.focusKept, JSON.stringify(afterClick));

    const altState = await page.evaluate(async (sid) => {
      const t = window.__t_terms.get(sid);
      t.scrollToTop();
      await new Promise((r) => setTimeout(r, 300));
      const btn = () => document.querySelector(`.term-session[data-sid="${sid}"] [data-testid="term-scroll-bottom"]`);
      const beforeHidden = btn()?.hidden ?? null;
      t.write("\x1b[?1049h");
      await new Promise((r) => setTimeout(r, 300));
      const out = { type: t.buffer.active.type, beforeHidden, hidden: btn()?.hidden ?? null };
      t.write("\x1b[?1049l");
      await new Promise((r) => setTimeout(r, 250));
      return out;
    }, sidA);
    ck.check("ALT 备用屏不显示回底浮钮（普通屏里本会显示）",
      altState.type === "alternate" && altState.beforeHidden === false && altState.hidden === true,
      JSON.stringify(altState));

    // ── D 回滚已满提示：触顶提示一次；继续输出不重复；改回滚行数后允许再提示 ──
    await page.evaluate(() => { window.__t_toasts = []; });
    const capToasts = () => page.evaluate(() =>
      (window.__t_toasts ?? []).filter((x) => x.text.includes("回滚已满")).length);
    const fillToCap = (lines) => page.evaluate(async ({ sid, n }) => {
      const t = window.__t_terms.get(sid);
      t.options.scrollback = 40;
      t.write(Array.from({ length: n }, (_, i) => `cap line ${i}`).join("\r\n") + "\r\n");
      await new Promise((r) => setTimeout(r, 800));
    }, { sid: sidA, n: lines });
    await fillToCap(120);
    ck.eq("回滚触顶提示一次", await capToasts(), 1);
    await fillToCap(60);
    ck.eq("继续输出不重复提示", await capToasts(), 1);
    await openTermSettings(page);
    await page.selectOption('[data-testid="term-scrollback-select"]', "2000");
    await page.waitForTimeout(300);
    await closeSettings(page);
    await page.evaluate(async (sid) => {
      const t = window.__t_terms.get(sid);
      t.options.scrollback = 40;
      t.write("one more line\r\n");
      await new Promise((r) => setTimeout(r, 800));
    }, sidA);
    ck.eq("改回滚行数后再次触顶可再提示（每会话一次已重置）", await capToasts(), 2);

    // 旧版高档不再出现在选项里，但已保存值不能让受控 select 空白：
    // 50000 映射到最接近且不超过新上限的 10000。
    await page.evaluate(() => localStorage.setItem("ui.v2.terminal.scrollback", "50000"));
    await page.reload();
    await page.waitForTimeout(1200);
    await openTermSettings(page);
    ck.eq("旧版 50000 行配置启动时归一到 10000，设置回显不空白",
      await page.locator('[data-testid="term-scrollback-select"]').inputValue(), "10000");
  },
};
