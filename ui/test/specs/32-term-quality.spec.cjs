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
      "term-cursor-blink-toggle", "term-scrollback-select", "term-spacing-select"]) {
      ck.check(`终端外观控件在场：${id}`, await page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), id));
    }
    const defaults = await page.evaluate(() => ({
      font: document.querySelector('[data-testid="term-font-select"]').value,
      liga: document.querySelector('[data-testid="term-liga-toggle"]').checked,
      cursor: document.querySelector('[data-testid="term-cursor-select"]').value,
      blink: document.querySelector('[data-testid="term-cursor-blink-toggle"]').checked,
      scrollback: document.querySelector('[data-testid="term-scrollback-select"]').value,
      spacing: document.querySelector('[data-testid="term-spacing-select"]').value,
    }));
    ck.check("默认回显（Maple Mono 中文等宽 / 连字关 / 方块光标 / 闪烁开 / 10000 行 / 字距 0）",
      defaults.font === "maple" && !defaults.liga && defaults.cursor === "block"
        && defaults.blink && defaults.scrollback === "10000" && defaults.spacing === "0",
      JSON.stringify(defaults));

    // ── 存量实例：先建一台（demo 预置会话不自动武装），验 unicode11 已激活 ──
    await closeSettings(page);
    await connectHost(page, "本机");
    const sids0 = await liveSids(page);
    ck.check("建连后有可见终端实例", sids0.length >= 1, `sids=${JSON.stringify(sids0)}`);
    const info0 = await termInfo(page, sids0[0]);
    ck.eq("Unicode 11 宽度表已激活", info0.unicode, "11");
    ck.eq("滚屏行数默认 10000", info0.scrollback, 10000);

    // ── 外观五项即时生效（存量实例） ──
    await openTermSettings(page);
    await page.selectOption('[data-testid="term-font-select"]', "cascadia");
    await page.waitForTimeout(300);
    ck.check("字体族即时生效（含 Cascadia Mono）", (await termInfo(page, sids0[0])).fontFamily.includes("Cascadia Mono"),
      (await termInfo(page, sids0[0])).fontFamily);
    await page.selectOption('[data-testid="term-scrollback-select"]', "50000");
    await page.selectOption('[data-testid="term-cursor-select"]', "bar");
    await page.click('[data-testid="term-cursor-blink-toggle"]');
    await page.selectOption('[data-testid="term-spacing-select"]', "1");
    await page.waitForTimeout(400);
    const info1 = await termInfo(page, sids0[0]);
    ck.check("滚屏/光标样式/闪烁/字距即时生效",
      info1.scrollback === 50000 && info1.cursorStyle === "bar" && info1.cursorBlink === false && info1.letterSpacing === 1,
      JSON.stringify({ scrollback: info1.scrollback, cursor: info1.cursorStyle, blink: info1.cursorBlink, spacing: info1.letterSpacing }));
    ck.check("demo 持久化（localStorage 六键落盘）",
      (await lsGet(page, "ui.v2.terminal.font_family")) === "cascadia"
        && (await lsGet(page, "ui.v2.terminal.scrollback")) === "50000"
        && (await lsGet(page, "ui.v2.terminal.cursor_style")) === "bar"
        && (await lsGet(page, "ui.v2.terminal.cursor_blink")) === "0"
        && (await lsGet(page, "ui.v2.terminal.letter_spacing")) === "1",
      JSON.stringify(await page.evaluate(() => Object.fromEntries(
        Object.keys(localStorage).filter((k) => k.startsWith("ui.v2.terminal.")).map((k) => [k, localStorage.getItem(k)])))));

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
          && info2.scrollback === 50000 && (await ligaSids(page)).includes(newSid),
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
    }));
    ck.check("reload 后设置回显完整",
      after.font === "cascadia" && after.liga && after.cursor === "bar" && !after.blink
        && after.scrollback === "50000" && after.spacing === "1",
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
          && info3.scrollback === 50000 && info3.letterSpacing === 1 && info3.cursorStyle === "bar"
          && (await ligaSids(page)).includes(sids2[0]),
        JSON.stringify(info3));
    }
  },
};
