// 64 按钮卫生（按钮美化轮）：全局 button 基础规则就是「主按钮」（渐变实底 + 600 粗体 + 内高光
// 投影），各族只覆盖了一部分就会漏——这一轮扫出的病全是同一形状，故把扫描器固化成回归：
//   ① 字体继承：按钮/输入框不继承字体（UA 默认 Arial）→ 中文落系统雅黑（CDP 实测），与正文
//      MiSans VF 两套字；断言可见按钮/输入框 font-family 与 body 一致
//   ② 阴影泄漏：静默钮（静息透明底）带着主按钮的内高光/投影 → 一圈淡框/项间亮线
//   ③ 悬停陷阱：族规则 .x:hover（0,2,0）输给通用 button:not(:disabled):hover（0,2,1），
//      悬停整块变 accent 实底（活动栏/采集开关/命令面板/分屏方向，历史第 1–7 例同形）
//   ④ 菜单项统一：右键/下拉菜单项无描边无阴影 28px、危险项红字；工具栏直系钮统一 28px
//   ⑤ 焦点门控：鼠标开右键菜单首项持焦点不高亮；键盘态（菜单里按键 / 键盘打开）才高亮
//   ⑥ 菜单宽度随内容后越界回夹：右下角右键，菜单整体仍在视口内
const SID = "s-demo-0001";

/** 扫当前屏可见、未被遮挡的按钮：返回 { leaks, traps, fonts, n }（traps 需逐个真鼠标悬停）。 */
async function scanScreen(page, label) {
  const info = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--accent-fill-hover)";
    document.body.appendChild(probe);
    const accentHover = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const bodyFont = getComputedStyle(document.body).fontFamily;
    const out = [];
    [...document.querySelectorAll("button")].forEach((b, i) => {
      const r = b.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !(b === top || b.contains(top))) return;
      const cs = getComputedStyle(b);
      const quiet = /rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) && cs.backgroundImage === "none";
      const name = `${(typeof b.className === "string" && b.className) || "(无类)"}「${(b.getAttribute("data-testid") || b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 12)}」`;
      out.push({ i, name, quiet, shadow: cs.boxShadow !== "none", font: cs.fontFamily, disabled: b.disabled, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    });
    const inputs = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select")]
      .filter((e) => e.getClientRects().length > 0 && !e.classList.contains("mono") && !e.closest(".xterm"))
      .filter((e) => { const ff = getComputedStyle(e).fontFamily; return !ff.includes("Mono") && ff !== bodyFont; })
      .map((e) => `${e.tagName.toLowerCase()}.${e.className || "(无类)"}`);
    return { accentHover, bodyFont, list: out, badInputs: inputs };
  });
  const leaks = info.list.filter((b) => b.quiet && b.shadow).map((b) => `${label}:${b.name}`);
  // 等宽族（终端/路径类）显式用 --mono，不算未继承；其余必须与 body 同栈
  const fonts = info.list.filter((b) => b.font !== info.bodyFont && !b.font.includes("Mono")).map((b) => `${label}:${b.name}=${b.font.split(",")[0]}`)
    .concat(info.badInputs.map((x) => `${label}:${x}`));
  const traps = [];
  for (const b of info.list) {
    if (!b.quiet || b.disabled) continue;
    await page.mouse.move(b.x, b.y);
    await page.waitForTimeout(140);
    const hv = await page.evaluate((i) => getComputedStyle(document.querySelectorAll("button")[i]).backgroundColor, b.i);
    if (hv === info.accentHover) traps.push(`${label}:${b.name}`);
  }
  await page.mouse.move(2, 880);
  return { leaks, traps, fonts, n: info.list.length };
}

const tabPt = (page, part) => page.evaluate((p) => {
  const t = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes(p));
  const r = (t.querySelector(".tab-label") ?? t).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, part);
const ptOf = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);
const itemStyle = (page, sel, idx) => page.evaluate(({ sel, idx }) => {
  const e = document.querySelectorAll(sel)[idx];
  if (!e) return null;
  const cs = getComputedStyle(e);
  return { bg: cs.backgroundColor, outline: cs.outlineStyle, focus: document.activeElement === e };
}, { sel, idx });
const clear = (bg) => /rgba\(0, 0, 0, 0\)|transparent/.test(bg);

module.exports = {
  title: "按钮卫生：字体继承、阴影泄漏、悬停陷阱、菜单项/工具栏统一、焦点门控、菜单回夹",
  async run({ page, ck }) {
    // 冻结过渡：悬停底色在 0.12s 过渡中途序列化成 rgba(r,g,b,1)，与目标 rgb() 字符串比不上，
    // 悬停陷阱会漏判（变异 B3 实测）——扫描期间一律无过渡，样式即时落定
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
    const tab = await tabPt(page, "prod-1");
    await page.mouse.click(tab.x, tab.y);
    await page.waitForTimeout(600);
    await page.evaluate((sid) => window.__demoInvoke("demo_tmux_fixture", { sid, sessions: ["work", "logs"] }), SID);
    // tmux 可用随 3s 会话清单轮询下发（坑 82）——等快接钮出现
    for (let i = 0; i < 30 && !(await ptOf(page, '[data-testid="tmux-quick"] > button')); i++) await page.waitForTimeout(200);

    const agg = { leaks: [], traps: [], fonts: [], n: 0 };
    const add = (r) => { agg.leaks.push(...r.leaks); agg.traps.push(...r.traps); agg.fonts.push(...r.fonts); agg.n += r.n; };

    // ── 主界面（工具栏 / 标签条 / 活动栏 / 状态条 / 主机栏）──
    add(await scanScreen(page, "主界面"));

    // ── ④ 工具栏直系钮统一 28px ──
    const tbH = await page.evaluate(() => [...document.querySelectorAll(".session-toolbar > button, .session-toolbar > .st-tools > button")]
      .map((b) => `${(b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 8)}:${Math.round(b.getBoundingClientRect().height)}`));
    ck.check("工具栏直系钮统一 28px 高（此前 27/28/30 混排）", tbH.length >= 5 && tbH.every((x) => x.endsWith(":28")), tbH.join(" "));

    // ── 工具菜单：项无描边无阴影 28px、危险项红字、悬停有反馈（此前悬停底=菜单底）──
    const tools = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".session-toolbar .st-tools > button")].find((x) => /工具/.test(x.textContent || ""));
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(tools.x, tools.y);
    await page.waitForTimeout(300);
    const tm = await page.evaluate(() => {
      const menu = document.querySelector(".session-toolbar .tools-menu");
      const items = [...menu.querySelectorAll("button[role=menuitem]")];
      const danger = items.find((b) => b.classList.contains("tm-danger"));
      const probe = document.createElement("div"); probe.style.color = "var(--danger)"; document.body.appendChild(probe);
      const dangerColor = getComputedStyle(probe).color; probe.remove();
      return {
        menuBg: getComputedStyle(menu).backgroundColor,
        bad: items.filter((b) => { const cs = getComputedStyle(b); return cs.borderTopStyle !== "none" && cs.borderTopWidth !== "0px" || cs.boxShadow !== "none" || Math.round(b.getBoundingClientRect().height) !== 28; }).map((b) => b.textContent),
        dangerOk: !!danger && getComputedStyle(danger).color === dangerColor,
        sep: !!menu.querySelector(".ctx-menu-sep"),
      };
    });
    ck.check("工具菜单项：无描边、无阴影、28px 行", tm.bad.length === 0, tm.bad.join(" / ") || "全部合规");
    ck.check("工具菜单：「关闭会话…」红字且与上方动作有分隔线", tm.dangerOk && tm.sep, JSON.stringify({ dangerOk: tm.dangerOk, sep: tm.sep }));
    const second = await page.evaluate(() => { const r = document.querySelectorAll(".session-toolbar .tools-menu button")[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(second.x, second.y);
    await page.waitForTimeout(200);
    const hovBg = await page.evaluate(() => getComputedStyle(document.querySelectorAll(".session-toolbar .tools-menu button")[1]).backgroundColor);
    ck.check("工具菜单项悬停有可见底色（≠ 菜单底，≠ 透明）", !clear(hovBg) && hovBg !== tm.menuBg, `菜单底 ${tm.menuBg} / 悬停 ${hovBg}`);
    add(await scanScreen(page, "工具菜单"));
    await page.mouse.click(tools.x, tools.y);
    await page.waitForTimeout(250);

    // ── 标签右键菜单：项无 ghost 描边、危险项红字；⑤ 焦点门控 ──
    await page.mouse.click(tab.x, tab.y, { button: "right" });
    await page.waitForTimeout(300);
    const cm = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".ctx-menu [role=menuitem]")];
      const close = items.find((b) => b.textContent.includes("关闭会话"));
      const probe = document.createElement("div"); probe.style.color = "var(--danger)"; document.body.appendChild(probe);
      const dangerColor = getComputedStyle(probe).color; probe.remove();
      return {
        bad: items.filter((b) => { const cs = getComputedStyle(b); return cs.borderTopStyle !== "none" && cs.borderTopWidth !== "0px" || cs.boxShadow !== "none"; }).map((b) => b.textContent),
        ghost: items.filter((b) => b.classList.contains("ghost")).length,
        closeRed: !!close && getComputedStyle(close).color === dangerColor,
      };
    });
    ck.check("右键菜单项不再是描边 ghost 钮（无描边、无阴影）", cm.bad.length === 0 && cm.ghost === 0, cm.bad.join(" / ") || `ghost 类 ${cm.ghost}`);
    ck.check("右键菜单「关闭会话…」红字（与工具菜单同语义）", cm.closeRed);
    const m1 = await itemStyle(page, ".ctx-menu .sm-item", 0);
    ck.check("鼠标打开：首项持焦点（键盘可达）但不高亮、无焦点环", !!m1 && m1.focus && clear(m1.bg) && m1.outline === "none", JSON.stringify(m1));
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    const m2 = await itemStyle(page, ".ctx-menu .sm-item", 1);
    const m2a = await itemStyle(page, ".ctx-menu .sm-item", 0);
    ck.check("菜单内按 ↓：第 2 项获焦并高亮、首项熄灭", !!m2 && m2.focus && !clear(m2.bg) && clear(m2a.bg), `${JSON.stringify(m2)} / 首项 ${m2a?.bg}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // 键盘态打开：先按键（无指针按下），再在标签上合成 contextmenu（Shift+F10 / 菜单键同形）。
    // 指针先移开——菜单开在标签左上，残留在标签中心的指针会正好压在首项上，悬停高亮冒充
    // 焦点高亮（变异 B6 实测：去掉打开即进键盘态，此断言靠悬停照样绿）
    await page.mouse.move(2, 880);
    await page.keyboard.press("F10");
    await page.evaluate(() => {
      const t = [...document.querySelectorAll(".tab")].find((x) => x.textContent.includes("prod-1"));
      const r = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    });
    await page.waitForTimeout(300);
    const k1 = await itemStyle(page, ".ctx-menu .sm-item", 0);
    ck.check("键盘态打开：首项焦点高亮立即可见", !!k1 && k1.focus && !clear(k1.bg), JSON.stringify(k1));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── ⑥ 终端右下角右键：宽度随内容的菜单回夹进视口 ──
    // demo 中文短项让菜单停在 min-width 200，旧估算夹取（innerWidth-200）恰好兜得住，测不到
    // 回夹（变异 B7 实测）——临时撑到 330px（英文长项量级，max-width 340 内）逼出越界
    const wide = await page.addStyleTag({ content: ".ctx-menu { min-width: 330px !important; }" });
    const corner = await page.evaluate(() => { const r = document.getElementById("term").getBoundingClientRect(); return { x: r.right - 4, y: r.bottom - 4 }; });
    await page.mouse.click(corner.x, corner.y, { button: "right" });
    await page.waitForTimeout(300);
    const inView = await page.evaluate(() => {
      const m = document.querySelector(".ctx-menu");
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), W: innerWidth, H: innerHeight };
    });
    ck.check("右下角右键：菜单整体在视口内（越界回夹）", !!inView && inView.l >= 0 && inView.t >= 0 && inView.r <= inView.W && inView.b <= inView.H, JSON.stringify(inView));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await wide.evaluate((el) => el.remove());

    // ── 文件面板 / 命令面板 / 监控大屏 / 设置外观 ──
    await page.click('[data-testid="rb-files"]');
    await page.waitForTimeout(1200);
    add(await scanScreen(page, "文件面板"));
    await page.click('[data-testid="tp-close"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="palette-open"]');
    await page.waitForTimeout(400);
    add(await scanScreen(page, "命令面板"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(900);
    add(await scanScreen(page, "监控大屏"));
    await page.click('[data-testid="rail-monitor"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="rail-settings"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="settings-cat-appearance"]');
    await page.waitForTimeout(300);
    add(await scanScreen(page, "设置外观"));
    await page.click('[data-testid="settings-close"]');
    await page.waitForTimeout(300);

    ck.check(`① 字体继承：可见按钮/输入框与正文同字体栈（共扫 ${agg.n} 个按钮）`, agg.n > 80 && agg.fonts.length === 0, agg.fonts.slice(0, 6).join(" / ") || "全部继承");
    ck.check("② 阴影泄漏：静默钮无主按钮内高光/投影", agg.leaks.length === 0, agg.leaks.slice(0, 6).join(" / ") || "无");
    ck.check("③ 悬停陷阱：静默钮悬停不变 accent 实底", agg.traps.length === 0, agg.traps.slice(0, 6).join(" / ") || "无");
  },
};
