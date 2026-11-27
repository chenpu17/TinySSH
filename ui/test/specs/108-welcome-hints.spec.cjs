// 108 KI-138 / KI-139：欢迎页启动提示精简 + 首次启动首帧即出厂色板。
// KI-138（用户反馈「启动提示太占空间，没必要整得这么复杂」）：欢迎页原为五行教程
//   （accent 标签芯片 + 长句，句句折两行），整块 228px，比四个主行动钮高三倍。
//   现压成卡片底部一行键帽提示，只留专注模式键 / 复制粘贴键 / 拖文件上传。
//   断言面：教程节点不再渲染；提示行存在、三项、在主行动钮之下且是卡片末行；
//   键帽按平台——专注键走 FOCUS_KEY_LABEL，复制/粘贴键与右键菜单同源（17 号 spec 用的是
//   同一张表：mac ⌘C ⌘V，Windows/Linux Ctrl+Shift+C Ctrl+V；Ctrl+C 有选区才复制、无选区是
//   SIGINT，键帽不提示，细节在悬停 title）；中文一行且右侧有余量，英文最多两行、按整项折行、
//   每行不溢出（三项之间只用间距，不用会悬空的「·」；实测 mac 英文一行、Windows/Linux 两行）；
//   卡片高度回到 360px 以内、宽度仍是设计值 470px（教程删掉后宽度改显式钉满）；
//   四枚主行动钮与状态句原样保留；触屏平台整行收起。
//   harness 与 CI 都不在 Windows 上跑，F 组在应用脚本之前改写平台判定来覆盖非 mac 口径。
// KI-139：theme-boot.js 在没有存储色板时不挂 data-theme，CSS 落回 :root 石墨基底，
//   首次启动首帧是石墨青、App 挂载后才切东京夜。断言面：全新上下文在
//   DOMContentLoaded（App 尚未挂载）就是 data-theme=tokyo，外观跟随系统深浅；
//   首帧与稳定态一致（无闪色）；设置页回显「跟随系统」+「东京夜」；
//   用户存过的色板与外观不被出厂默认覆盖。

const TOKYO_BG = { dark: "#14151f", light: "#dfe2e9" };
const GRAPHITE_BG = "#0a0e14";
// 键帽的平台口径：与 17 号 spec 右键菜单的断言同一张表
const KEYCAPS = (mac) => (mac ? ["Fn+F11", "⌘C", "⌘V"] : ["F11", "Ctrl+Shift+C", "Ctrl+V"]);
const NO_PSEUDO = (c) => c === "none" || c === "normal" || c === "";

const welcomeGeo = (page) => page.evaluate(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), width: Math.round(b.width) };
  };
  const box = document.querySelector(".welcome-box");
  const hints = document.querySelector(".welcome-hints");
  const note = document.querySelector(".welcome-note");
  const nav = navigator;
  const spans = hints ? [...hints.children] : [];
  // 逐行宽度：同一 top 的子项取最右缘（项目符号若是 CSS 生成的，textContent 里看不到，
  // 但它占的宽度算在子项盒外——这里量的是子项自身，所以另读 ::before 的计算样式）
  const left = hints ? hints.getBoundingClientRect().left : 0;
  const byRow = new Map();
  for (const s of spans) {
    const b = s.getBoundingClientRect();
    const top = Math.round(b.top);
    byRow.set(top, Math.max(byRow.get(top) ?? 0, b.right - left));
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([top, width]) => ({ top, width: Math.round(width * 10) / 10 }));
  return {
    mac: /mac|iphone|ipad|ios/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? ""),
    vw: innerWidth, vh: innerHeight,
    steps: document.querySelectorAll(".welcome-steps, .ws-k").length,
    box: r(box), mark: r(document.querySelector(".welcome-mark")),
    actions: [...document.querySelectorAll(".welcome-actions button")].map((b) => ({ text: b.textContent.trim(), ...r(b) })),
    hints: r(hints),
    hintsDisplay: hints ? getComputedStyle(hints).display : null,
    hintsInner: hints ? hints.clientWidth : 0,
    hintRows: rows.length,
    hintRowsGeo: rows,
    hintRowTops: spans.map((s) => Math.round(s.getBoundingClientRect().top)),
    // 第 2、3 项前若有 CSS 生成的项目符号，折行后会悬空在行首
    hintSeparators: spans.slice(1).map((s) => getComputedStyle(s, "::before").content),
    hintItems: spans.map((s) => s.textContent),
    kbds: hints ? [...hints.querySelectorAll("kbd")].map((k) => k.textContent) : [],
    copyTitle: spans[1]?.getAttribute("title") ?? null,
    hintIsLast: !!box && box.lastElementChild === hints,
    note: r(note), noteDisplay: note ? getComputedStyle(note).display : null,
    theme: document.documentElement.getAttribute("data-theme"),
    chrome: document.documentElement.getAttribute("data-chrome"),
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  };
});

const J = (v) => JSON.stringify(v);
// 首行右侧余量；提示行缺失时给 -1（断言失败而不是抛异常截断后面的断言）
const slack = (x) => (x.hintRowsGeo[0] ? x.hintsInner - x.hintRowsGeo[0].width : -1);

module.exports = {
  title: "欢迎页启动提示精简为一行键帽提示；首次启动首帧即东京夜·跟随系统",
  async run({ page, browser, ck, BASE }) {
    // ── A. 欢迎页（harness 默认 1440×900、zh、100% 字号）──
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    const g = await welcomeGeo(page);
    ck.check("五行教程已移除：.welcome-steps / .ws-k 不再渲染", g.steps === 0, `残留 ${g.steps} 个`);
    ck.check("启动提示在卡片底部，且是卡片的最后一个子块", g.hintIsLast && !!g.hints, J({ hints: g.hints, last: g.hintIsLast }));
    ck.check("启动提示压成一行（三项同一条基线）", g.hintsDisplay === "flex" && g.hintItems.length === 3 && g.hintRows === 1,
      J({ display: g.hintsDisplay, items: g.hintItems, rows: g.hintRowsGeo }));
    ck.check("中文一行放得下：右侧至少留 16px 余量（非 mac 的复制粘贴键帽更宽）",
      slack(g) >= 16, J({ rows: g.hintRowsGeo, inner: g.hintsInner }));
    ck.check("三项之间没有 CSS 生成的项目符号（折行后会悬空在行首）",
      g.hintSeparators.every(NO_PSEUDO), J(g.hintSeparators));
    ck.check("提示只留三件事：专注模式 / 复制粘贴 / 拖文件上传",
      g.hintItems.length === 3 && g.hintItems[0]?.includes("专注模式")
        && g.hintItems[1]?.endsWith("复制粘贴") && g.hintItems[2] === "拖入文件即上传",
      J(g.hintItems));
    // 键帽与右键菜单同源（actions.ts 的 FOCUS/COPY/PASTE_KEY_LABEL）。专注键走 FOCUS_KEY_LABEL：
    // macOS 的 F11 被系统「显示桌面」占用，需 Fn+F11（旧教程写死 F11）
    ck.check(`键帽按平台给出（${g.mac ? "mac" : "非 mac"}），与右键菜单同一口径`,
      J(g.kbds) === J(KEYCAPS(g.mac)), J(g.kbds));
    ck.check("复制粘贴项带悬停说明：有选中内容才复制（非 mac 另说明无选中时是中断）",
      !!g.copyTitle && g.copyTitle.includes("复制")
        && (g.mac ? g.copyTitle.includes("⌘C") : g.copyTitle.includes("Ctrl+C") && g.copyTitle.includes("中断")),
      J(g.copyTitle));
    ck.check("提示行在四枚主行动钮之下，自身不超过 34px 高",
      g.actions.length === 4 && g.hints?.top >= Math.max(...g.actions.map((a) => a.bottom)) && g.hints?.height <= 34,
      J({ hints: g.hints, actionsBottom: Math.max(...g.actions.map((a) => a.bottom)) }));
    ck.check("四枚主行动钮原样保留且标签单行不折",
      g.actions.length === 4 && g.actions.every((a) => a.height <= 36)
        && ["添加主机", "快速连接", "从 ~/.ssh/config 导入", "打开本地终端"].every((t) => g.actions.some((a) => a.text === t)),
      J(g.actions.map((a) => `${a.text}:${a.height}`)));
    ck.check("状态句原样保留（常规窗口高度下可见）", g.noteDisplay !== "none" && g.note.height > 0, J({ display: g.noteDisplay, note: g.note }));
    ck.check("卡片高度回到 360px 以内（精简前 525px）", g.box.height <= 360, `卡高 ${g.box.height}px`);
    ck.check("卡片宽度仍是设计值 470px（教程删掉后宽度显式钉满，不随内容缩到 408）",
      Math.abs(g.box.width - 470) <= 1, `卡宽 ${g.box.width}px`);
    ck.check("卡片完整落在可视区内（品牌标与提示行都可见）",
      g.mark.top >= 0 && g.hints?.bottom <= g.vh, J({ mark: g.mark, hints: g.hints, vh: g.vh }));

    // ── B. 触屏平台：键盘提示没有意义，整行收起；主行动钮不受影响 ──
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; });
    await page.waitForTimeout(300);
    const m = await welcomeGeo(page);
    ck.check("触屏平台：启动提示整行收起", m.hintsDisplay === "none" && (m.hints?.height ?? 0) === 0, J({ display: m.hintsDisplay, h: m.hints?.height }));
    ck.check("触屏平台：卡片比桌面再矮至少 25px，四枚主行动钮仍在",
      m.box.height <= g.box.height - 25 && m.actions.length === 4, J({ desktop: g.box.height, touch: m.box.height }));
    await page.evaluate(() => { delete document.documentElement.dataset.platform; });
    await page.waitForTimeout(300);

    // ── C. 英文界面：三项提示都有译文；行数按平台口径，折行处不留悬空的项目符号 ──
    await page.evaluate(() => localStorage.setItem("ui.v2.locale", "en"));
    await page.reload({ waitUntil: "networkidle" });
    // 提示行缺席时等不到选择器：吞掉超时，让下面的断言自己变红（不抛异常截断后续断言）
    await page.waitForSelector(".welcome-hints", { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(1200);
    const e = await welcomeGeo(page);
    const enText = e.hintItems.join("|");
    ck.check("英文界面：三项提示都有译文",
      enText.includes("Focus mode") && enText.includes("Copy/paste") && enText.includes("Drop file to upload")
        && !enText.includes("专注") && !enText.includes("复制") && !enText.includes("拖入"),
      J(e.hintItems));
    ck.check("英文界面：悬停说明有译文",
      !!e.copyTitle && e.copyTitle.includes("copies") && (e.mac || e.copyTitle.includes("interrupts")), J(e.copyTitle));
    // 英文比中文长。只钉不变式——最多两行、按整项折行、每行都不溢出、行首没有「·」——不钉「恰好几行」：
    // 能放进一行是更好的结果，不该判红。当前实测 mac 一行；非 mac 的 Ctrl+Shift+C + Ctrl+V 更宽，
    // 前两项留在首行、拖文件上传单独在第二行
    ck.check("英文界面：最多两行，按整项折行，每行都不溢出，行首没有项目符号",
      e.hintRows >= 1 && e.hintRows <= 2 && e.hintRowsGeo.every((r) => r.width <= e.hintsInner)
        && (e.hintRows === 1 || (e.hintRowTops[0] === e.hintRowTops[1] && e.hintRowTops[2] > e.hintRowTops[1]))
        && e.hintSeparators.every(NO_PSEUDO),
      J({ rows: e.hintRowsGeo, tops: e.hintRowTops, inner: e.hintsInner, sep: e.hintSeparators }));
    ck.check("英文界面：卡片高度仍不超过 360px", e.box.height <= 360, `卡高 ${e.box.height}px`);

    // ── D. 首次启动首帧：全新上下文（无任何 localStorage），init 脚本先于应用脚本 ──
    const firstLaunch = async ({ colorScheme, seed = null, platform = null }) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN", colorScheme });
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (err) => errs.push(String(err)));
      p.on("console", (msg) => { if (msg.type() === "error") errs.push(`console.error: ${msg.text()}`); });
      await p.addInitScript(({ seed, platform }) => {
        window.__boot = [];
        const snap = () => {
          const r = document.documentElement;
          window.__boot.push([r.getAttribute("data-theme"), r.getAttribute("data-chrome"), getComputedStyle(r).getPropertyValue("--bg").trim()]);
        };
        // theme-boot.js 是 head 里的同步脚本，DOMContentLoaded 时它必然已经跑过，而 App 的
        // 启动 effect（异步读设置）此时尚未落定——这一拍取到的就是「首帧」
        document.addEventListener("DOMContentLoaded", snap);
        // 平台判定（actions.ts isMacPlatform）读 navigator.userAgentData.platform：
        // 在应用脚本之前改写它（F 组用）
        if (platform) {
          Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => ({ platform, mobile: false }) });
        }
        if (seed) for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
      }, { seed, platform });
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await p.waitForSelector(".welcome-title", { timeout: 20000 });
      await p.waitForTimeout(1200);
      const boot = await p.evaluate(() => window.__boot);
      const stable = await welcomeGeo(p);
      return { ctx, p, boot, stable, errs };
    };

    for (const scheme of ["dark", "light"]) {
      const f = await firstLaunch({ colorScheme: scheme });
      const [theme, chrome, bg] = f.boot[0] ?? [];
      ck.check(`首次启动·系统${scheme === "dark" ? "深色" : "浅色"}：首帧（App 挂载前）已是 data-theme=tokyo`, theme === "tokyo", J(f.boot));
      ck.check(`首次启动·系统${scheme === "dark" ? "深色" : "浅色"}：首帧外观跟随系统（data-chrome=${scheme}）`, chrome === scheme, J(f.boot));
      ck.check(`首次启动·系统${scheme === "dark" ? "深色" : "浅色"}：首帧底色即东京夜 ${TOKYO_BG[scheme]}，不是石墨基底`,
        bg === TOKYO_BG[scheme] && bg !== GRAPHITE_BG, `首帧 --bg=${bg}`);
      ck.check(`首次启动·系统${scheme === "dark" ? "深色" : "浅色"}：稳定态与首帧一致（无闪色）`,
        f.stable.theme === theme && f.stable.chrome === chrome && f.stable.bg === bg,
        J({ stable: [f.stable.theme, f.stable.chrome, f.stable.bg], boot: f.boot }));
      ck.check(`首次启动·系统${scheme === "dark" ? "深色" : "浅色"}：无页面 JS 错误`, f.errs.length === 0, f.errs.slice(0, 3).join(" | "));

      if (scheme === "dark") {
        // 设置页回显：出厂默认 = 跟随系统 + 东京夜（新装 vault 无值时的落点）
        await f.p.evaluate(() => document.querySelector('[data-testid="rail-settings"]')?.click());
        await f.p.waitForSelector(".ts-appearance", { timeout: 8000 });
        await f.p.waitForTimeout(500);
        const picked = await f.p.evaluate(() => {
          const pressed = (root) => (root ? [...root.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent.trim()) : null);
          return {
            appearance: pressed(document.querySelector(".ts-appearance")),
            palettes: pressed(document.querySelector('[data-testid^="chrome-palette-"]')?.parentElement),
          };
        });
        ck.check("设置页回显：应用外观 = 跟随系统", J(picked.appearance) === J(["跟随系统"]), J(picked));
        ck.check("设置页回显：色板 = 东京夜", J(picked.palettes) === J(["东京夜"]), J(picked));
      }
      await f.ctx.close();
    }

    // ── E. 出厂默认不得覆盖用户选择：存过石墨 + 浅色，首帧照旧 ──
    //     只断首帧：ui.chrome / ui.palette 是首帧镜像，外观的事实源是工作空间 blob
    //     （只种镜像不种 blob 是真实使用里不存在的状态，稳定态外观不在本条范围）
    const u = await firstLaunch({ colorScheme: "dark", seed: { "ui.palette": "graphite", "ui.chrome": "light" } });
    ck.check("已存色板/外观优先：系统深色 + 存过石墨·浅色 → 首帧仍是 graphite·light（石墨浅色底）",
      J(u.boot[0]) === J(["graphite", "light", "#eef1f5"]), J(u.boot));
    ck.check("已存色板优先：稳定态色板仍是石墨（App 认存储值，未被出厂默认改写）",
      u.stable.theme === "graphite" && u.stable.bg === "#0a0e14", J([u.stable.theme, u.stable.bg]));
    ck.check("已存色板优先：无页面 JS 错误", u.errs.length === 0, u.errs.slice(0, 3).join(" | "));
    await u.ctx.close();

    // ── F. 模拟 Windows / Linux：非 mac 的键帽更宽（Ctrl+Shift+C + Ctrl+V 比 ⌘C ⌘V 宽约
    //     95px），470px 卡的内容宽只有 400px。FOCUS/COPY/PASTE_KEY_LABEL 是模块级常量，
    //     求值于 import 时，所以平台要在应用脚本之前改写 ──
    for (const platform of ["Windows", "Linux"]) {
      for (const [lang, seed] of [["zh", null], ["en", { "ui.v2.locale": "en" }]]) {
        const f = await firstLaunch({ colorScheme: "dark", seed, platform });
        const w = await welcomeGeo(f.p);
        const tag = `${platform}·${lang === "zh" ? "中文" : "英文"}`;
        ck.check(`${tag}：按非 mac 口径给键帽`, !w.mac && J(w.kbds) === J(KEYCAPS(false)), J(w.kbds));
        ck.check(`${tag}：悬停说明写的是 Ctrl+C 与中断`, w.copyTitle?.includes("Ctrl+C") && w.copyTitle.includes(lang === "zh" ? "中断" : "interrupts"), J(w.copyTitle));
        if (lang === "zh") {
          ck.check(`${tag}：一行放得下，右侧至少留 16px 余量，卡高仍 ≤360px`,
            w.hintRows === 1 && slack(w) >= 16 && w.box.height <= 360,
            J({ rows: w.hintRowsGeo, inner: w.hintsInner, boxH: w.box.height }));
        } else {
          ck.check(`${tag}：最多两行，按整项折行，每行都不溢出，卡高仍 ≤360px`,
            w.hintRows >= 1 && w.hintRows <= 2
              && (w.hintRows === 1 || (w.hintRowTops[0] === w.hintRowTops[1] && w.hintRowTops[2] > w.hintRowTops[1]))
              && w.hintRowsGeo.every((r) => r.width <= w.hintsInner) && w.hintSeparators.every(NO_PSEUDO)
              && w.box.height <= 360,
            J({ rows: w.hintRowsGeo, tops: w.hintRowTops, inner: w.hintsInner, boxH: w.box.height }));
        }
        ck.check(`${tag}：无页面 JS 错误`, f.errs.length === 0, f.errs.slice(0, 3).join(" | "));
        await f.ctx.close();
      }
    }
  },
};
