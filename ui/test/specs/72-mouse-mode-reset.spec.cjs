// 72 KI-001 补强：远端 TUI 退出后残留鼠标上报模式。
//
// 复现：应用发 1003h+1006h（any-motion+SGR）后只发 1049l 离开备用屏、不发
// 1003l。旧行为下协议留在 ANY，提示符里的移动/点击/拖动/滚轮继续被编码成
// ESC[<35;..M / 0;..M / 32;..m / 65;..M 送进 PTY，回显成满屏 35;22;4M 乱码，
// 滚轮也不再滚 scrollback。
// 修复：离开备用屏（47/1047/1049l）或收到 shell 集成 OSC 133;A/D 时本地关协议；
// 另提供右键「重置鼠标上报」手动出口。
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

const connectHost = async (page, name) => {
  const card = await page.$(`.host-card:has(.host-name:text-is("${name}"))`);
  if (!card) throw new Error(`主机卡不在场：${name}`);
  await card.hover();
  await page.waitForTimeout(250);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1600);
};

const wait = (page, ms = 120) => page.waitForTimeout(ms);

module.exports = {
  title: "鼠标上报残留：离开备用屏/提示符自动复位 + 右键手动复位",
  async run({ page, ck }) {
    // ── 1. 纯函数：只关协议，已关时不重复动作 ──
    const unit = await page.evaluate(async () => {
      const mod = await import("/src/terminal/mouse-mode-guard.ts");
      const core = { coreMouseService: { activeProtocol: "ANY" } };
      const term = { _core: core };
      const first = mod.resetMouseReporting(term);
      const proto1 = core.coreMouseService.activeProtocol;
      const second = mod.resetMouseReporting(term);
      return { first, proto1, second, proto2: core.coreMouseService.activeProtocol };
    });
    ck.check("ANY 协议可被本地重置", unit.first && unit.proto1 === "NONE");
    ck.check("已关闭时不重复动作", !unit.second && unit.proto2 === "NONE");

    // ── 2. 真实终端：1049l 自动复位 ──
    await connectHost(page, "本机");
    const sids = await liveSids(page);
    ck.check("建连后有可见终端实例", sids.length >= 1, `sids=${JSON.stringify(sids)}`);
    const alt = await page.evaluate(async (sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1049h");
      await new Promise((r) => setTimeout(r, 100));
      term.write("\x1b[?1003h\x1b[?1006h");
      await new Promise((r) => setTimeout(r, 100));
      const inAlt = { type: term.buffer.active.type, mode: term.modes.mouseTrackingMode };
      term.write("\x1b[?1049l");
      await new Promise((r) => setTimeout(r, 100));
      return { inAlt, after: { type: term.buffer.active.type, mode: term.modes.mouseTrackingMode } };
    }, sids[0]);
    ck.check("进入备用屏并开 ANY 后协议生效", alt.inAlt.type === "alternate" && alt.inAlt.mode === "any",
      JSON.stringify(alt.inAlt));
    ck.check("1049l 离开备用屏后协议自动关闭", alt.after.type === "normal" && alt.after.mode === "none",
      JSON.stringify(alt.after));

    // ── 3. OSC 133;A（shell 提示符）自动复位 ──
    const osc = await page.evaluate(async (sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1003h\x1b[?1006h");
      await new Promise((r) => setTimeout(r, 100));
      const before = term.modes.mouseTrackingMode;
      term.write("\x1b]133;A\x07");
      await new Promise((r) => setTimeout(r, 100));
      return { before, after: term.modes.mouseTrackingMode };
    }, sids[0]);
    ck.check("OSC 133;A 到达时清掉普通屏残留协议", osc.before === "any" && osc.after === "none",
      JSON.stringify(osc));

    // 备用屏里的 OSC 133 可能来自转发它的多路复用器/应用：不得误关 TUI 鼠标
    const oscAlt = await page.evaluate(async (sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1049h");
      await new Promise((r) => setTimeout(r, 100));
      term.write("\x1b[?1003h\x1b[?1006h");
      await new Promise((r) => setTimeout(r, 100));
      const before = term.modes.mouseTrackingMode;
      term.write("\x1b]133;A\x07");
      await new Promise((r) => setTimeout(r, 100));
      const after = term.modes.mouseTrackingMode;
      term.write("\x1b[?1049l");
      await new Promise((r) => setTimeout(r, 100));
      return { before, after, afterLeave: term.modes.mouseTrackingMode };
    }, sids[0]);
    ck.check("备用屏内 OSC 133;A 不误关 TUI 鼠标",
      oscAlt.before === "any" && oscAlt.after === "any", JSON.stringify(oscAlt));
    ck.check("离开备用屏后仍会复位", oscAlt.afterLeave === "none", JSON.stringify(oscAlt));

    // 47/1047 同样是离开备用屏的通用信号
    const altCodes = await page.evaluate(async (sid) => {
      const term = window.__t_terms.get(sid);
      const out = [];
      for (const code of [47, 1047]) {
        term.write(`\x1b[?${code}h`);
        await new Promise((r) => setTimeout(r, 80));
        term.write("\x1b[?1003h\x1b[?1006h");
        await new Promise((r) => setTimeout(r, 80));
        term.write(`\x1b[?${code}l`);
        await new Promise((r) => setTimeout(r, 80));
        out.push({ code, mode: term.modes.mouseTrackingMode, type: term.buffer.active.type });
      }
      return out;
    }, sids[0]);
    ck.check("47/1047 离开备用屏同样复位",
      altCodes.every((x) => x.mode === "none" && x.type === "normal"), JSON.stringify(altCodes));

    // ── 4. 备用屏里的 TUI 鼠标不受影响；退出后不再产生报文 ──
    await page.evaluate((sid) => {
      const term = window.__t_terms.get(sid);
      window.__mouseRaw = [];
      term.onData((d) => window.__mouseRaw.push(d));
      term.write("\x1b[?1049h");
    }, sids[0]);
    await wait(page, 120);
    await page.evaluate((sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1003h\x1b[?1006h");
      term.focus();
    }, sids[0]);
    await wait(page, 120);
    const rect = await page.evaluate((sid) => {
      const term = window.__t_terms.get(sid);
      const r = term.element.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, sids[0]);
    await page.mouse.move(rect.x + 100, rect.y + 80);
    await page.mouse.move(rect.x + 220, rect.y + 110, { steps: 8 });
    await page.mouse.wheel(0, 120);
    await wait(page, 250);
    const altReports = await page.evaluate(() => window.__mouseRaw.slice());
    ck.check("备用屏 TUI 仍能收到移动/滚轮报文",
      altReports.some((d) => d.includes("\x1b[<35;")) && altReports.some((d) => d.includes("\x1b[<6")),
      JSON.stringify(altReports.slice(-4)));

    await page.evaluate((sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1049l");
      window.__mouseRaw = [];
    }, sids[0]);
    await wait(page, 150);
    await page.mouse.move(rect.x + 140, rect.y + 90);
    await page.mouse.move(rect.x + 260, rect.y + 130, { steps: 8 });
    await page.mouse.wheel(0, 120);
    await wait(page, 250);
    const afterReports = await page.evaluate(() => ({
      raw: window.__mouseRaw.slice(),
      mode: window.__t_terms.get([...window.__t_terms.keys()].find((k) => {
        const t = window.__t_terms.get(k);
        return t.element && t.element.isConnected && t.element.getBoundingClientRect().height > 0;
      })).modes.mouseTrackingMode,
    }));
    ck.eq("退出备用屏后不再产生鼠标报文", JSON.stringify(afterReports.raw.filter((d) => d.includes("\x1b[<"))), "[]");
    ck.eq("退出后协议为 none", afterReports.mode, "none");

    // ── 5. 右键「重置鼠标上报」手动出口 ──
    await page.evaluate((sid) => {
      const term = window.__t_terms.get(sid);
      term.write("\x1b[?1003h\x1b[?1006h");
    }, sids[0]);
    await wait(page, 120);
    await page.evaluate(() => {
      const el = document.querySelector(".term-session.active") ?? document.querySelector(".term-session");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: r.left + 240, clientY: r.top + 120,
      }));
    });
    await wait(page, 250);
    const menuPresent = await page.evaluate(() => !!document.querySelector('[data-testid="term-mouse-reset"]'));
    ck.check("终端右键菜单有「重置鼠标上报」", menuPresent);
    if (menuPresent) await page.click('[data-testid="term-mouse-reset"]');
    await wait(page, 200);
    const menuMode = await page.evaluate((sid) => window.__t_terms.get(sid).modes.mouseTrackingMode, sids[0]);
    ck.eq("点菜单后协议关闭", menuMode, "none");
  },
};
