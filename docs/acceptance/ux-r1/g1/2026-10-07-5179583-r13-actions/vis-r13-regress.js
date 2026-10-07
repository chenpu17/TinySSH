// vis-r13 独立复验 脚本 1/2：R13 零回归核对（R12 AppShell 基线几何/主题/token）。
// R13 唯一样式改动 .tab min-width:0→120 / max-width:170→220，其余结构应与 R12 一致。
// 每轮先归一 localStorage（ui.hostbar=1 / ui.hostbar_w=224 / ui.theme=dark）再 reload。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('fs');
const DIR = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g1/2026-10-07-5179583-r13-actions';
const SHOTS = DIR + '/vis-shots';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  const R = {};
  const box = async (sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const b = await el.boundingBox();
    return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
  };
  const cs = (sel, props) => page.$eval(sel, (el, props) => {
    const s = getComputedStyle(el); const o = {};
    for (const p of props) o[p] = s.getPropertyValue(p);
    return o;
  }, props).catch(() => null);
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const step = async (name, fn) => { try { await fn(); } catch (e) { R['ERR_' + name] = String(e).slice(0, 250); } };
  const toastVsStatusbar = () => page.evaluate(() => {
    const t = document.querySelector('.toast'), s = document.querySelector('.statusbar');
    if (!t || !s) return { toast: !!t, statusbar: !!s };
    const a = t.getBoundingClientRect(), b = s.getBoundingClientRect();
    return {
      toast: { top: Math.round(a.top), bottom: Math.round(a.bottom), right: Math.round(a.right) },
      statusbar: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
      verticalOverlapPx: Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
    };
  });
  // 归一 localStorage 后 reload（防跨轮残留）
  const normalize = async () => {
    await page.goto('http://localhost:5183', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('ui.hostbar', '1');
      localStorage.setItem('ui.hostbar_w', '224');
      localStorage.setItem('ui.theme', 'dark');
      localStorage.removeItem('ui.font_size');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
  };

  await normalize();

  // ---------- A. 欢迎态几何 1280×800 ----------
  await step('A_welcome', async () => {
    R.A_welcome = {
      titlebar: await box('.titlebar'), hostbar: await box('.hostbar'),
      statusbar: await box('.statusbar'), welcome: !!(await page.$('.welcome')),
      tabbarRow: !!(await page.$('.tabbar-row')), sessionToolbar: !!(await page.$('.session-toolbar')),
      taskPanel: !!(await page.$('.task-panel')),
      hostCards: await page.$$eval('.host-card', (els) => els.length),
      hostbarInlineWidth: await page.$eval('.hostbar', (el) => el.style.width).catch(() => null),
      sbLeft: await page.$eval('.sb-left', (el) => el.textContent.trim()).catch(() => null),
      hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      chrome: await page.evaluate(() => document.documentElement.dataset.chrome),
    };
    R.styles_dark = {
      titlebar: await cs('.titlebar', ['background-color', 'border-bottom-color', 'border-bottom-width', 'height']),
      hostbar: await cs('.hostbar', ['background-color', 'border-right-color']),
      statusbar: await cs('.statusbar', ['background-color', 'border-top-color', 'font-size', 'color', 'height']),
      appTitle: await cs('.app-title', ['font-size', 'font-weight']),
      tabbarRow: await cs('.tabbar-row', ['background-color', 'border-bottom-color', 'height']),
      taskPanel: null,
    };
    R.tokens_dark = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        panel: s.getPropertyValue('--panel').trim(), border: s.getPropertyValue('--border').trim(),
        chrome: document.documentElement.dataset.chrome,
      };
    });
    R.fontTiers_dark = await page.evaluate(() => {
      const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontSize : null; };
      return { appTitle: g('.app-title'), tab: g('.tab'), statusbar: g('.statusbar'), sbBtn: g('.sb-btn'), hbSearchInput: g('.hb-search input'), hbSettings: g('.hb-settings') };
    });
    await shot('01-welcome-1280x800');
  });

  // ---------- B/C. 1024×768 与 960×600 不破版 ----------
  for (const [w, h, name] of [[1024, 768, 'B_vp1024'], [960, 600, 'C_vp960']]) {
    await step(name, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(350);
      R[name] = {
        titlebar: await box('.titlebar'), hostbar: await box('.hostbar'),
        statusbar: await box('.statusbar'), main: await box('.main'),
        welcome: !!(await page.$('.welcome')),
        hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
        vOver: await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2),
      };
      if (w === 1024) {
        await page.click('.sb-btn[title="文件与传输"]');
        await page.waitForTimeout(400);
        R[name].filesTpFull = await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')).catch(() => null);
        R[name].panelBox = await box('.task-panel');
        await shot('04-vp1024-files-tpfull');
        await page.click('.tp-head button[aria-label="关闭任务面板"]').catch(() => {});
        await page.waitForTimeout(200);
      }
      await shot(`0${w === 1024 ? 2 : 3}-${name.toLowerCase()}`);
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(350);

  // ---------- D. 建会话 1：几何 + toast 对位 + xterm ----------
  await step('D_session1', async () => {
    const card = await page.$('.host-card');
    await card.hover(); await page.waitForTimeout(250);
    await page.click('.host-card .host-connect-btn');
    // 兜底：若弹指纹/双因素则处理
    await page.waitForTimeout(1200);
    if (await page.$('.hk-mask')) {
      const inp = await page.$('.hk-mask input');
      if (inp) { await inp.fill('123456'); await page.waitForTimeout(150); }
      await page.click('.hk-actions button');
      await page.waitForTimeout(1500);
    } else {
      await page.waitForTimeout(600);
    }
    R.D_session1 = {
      welcomeGone: (await page.$('.welcome')) === null,
      tabbarRow: await box('.tabbar-row'), sessionToolbar: await box('.session-toolbar'),
      statusbar: await box('.statusbar'),
      tabs: await page.$$eval('.tab .tab-label', (els) => els.map((e) => e.textContent)),
      sbLeft: await page.$eval('.sb-left', (el) => el.textContent.trim()).catch(() => null),
      xterm: !!(await page.$('.xterm')),
    };
    R.D_toastVsStatusbar = await toastVsStatusbar();
    await shot('05-session1-connect-toast');
  });

  // ---------- I. 任务面板 files：384 宽 ----------
  await step('I_files', async () => {
    await page.click('.st-file');
    await page.waitForTimeout(450);
    R.I_files = {
      panel: await box('.task-panel'),
      head: await page.$eval('.tp-head b', (el) => el.textContent).catch(() => null),
      tpFull: await page.$eval('.task-panel', (el) => el.classList.contains('tp-full')),
    };
    await shot('11-panel-files');
    await page.click('.tp-head button[aria-label="关闭任务面板"]');
    await page.waitForTimeout(200);
    R.I_panels_closed = (await page.$('.task-panel')) === null;
  });

  // ---------- T. 双主题：深→浅→深（.hb-settings 显示设置） ----------
  await step('T_themes', async () => {
    await page.click('.hb-settings');
    await page.waitForTimeout(300);
    R.T_settingsOpen = !!(await page.$('.term-settings'));
    await shot('20-theme-settings');
    const opts = await page.$$('.ts-themes .ts-opt');
    R.T_themeOptions = await page.$$eval('.ts-themes .ts-opt', (els) => els.map((e) => e.textContent.trim()));
    await opts[1].click(); // 浅色
    await page.waitForTimeout(400);
    R.T_light = {
      chrome: await page.evaluate(() => document.documentElement.dataset.chrome),
      tokens: await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return { panel: s.getPropertyValue('--panel').trim(), border: s.getPropertyValue('--border').trim() };
      }),
      titlebarBg: (await cs('.titlebar', ['background-color']))['background-color'],
      statusbarColor: (await cs('.statusbar', ['color'])).color,
      appTitleColor: (await cs('.app-title', ['color'])).color,
      hScroll: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    };
    await shot('21-theme-light');
    await opts[0].click(); // 回深色
    await page.waitForTimeout(400);
    R.T_darkRestore = {
      chrome: await page.evaluate(() => document.documentElement.dataset.chrome),
      tokens: await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return { panel: s.getPropertyValue('--panel').trim(), border: s.getPropertyValue('--border').trim() };
      }),
    };
    await shot('22-theme-dark-restore');
    // Esc 关设置面板（顺带验 R13 Esc 链第一段）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    R.T_settingsClosedByEsc = (await page.$('.term-settings')) === null;
  });

  // ---------- F. 会话 2（含指纹确认流）+ 标签行 ----------
  await step('F_session2', async () => {
    const cards = await page.$$('.host-card');
    if (cards.length > 1) {
      await cards[1].hover(); await page.waitForTimeout(250);
      await (await cards[1].$('.host-connect-btn')).click();
      await page.waitForTimeout(1000);
      // 指纹确认 / 双因素（第二台起）
      for (let i = 0; i < 3 && (await page.$('.hk-mask')); i++) {
        const inp = await page.$('.hk-mask input');
        if (inp) { await inp.fill('123456'); await page.waitForTimeout(150); }
        await page.click('.hk-actions button');
        await page.waitForTimeout(1300);
      }
      R.F_session2 = {
        tabCount: await page.$$eval('.tab', (els) => els.length),
        tabs: await page.$$eval('.tab .tab-label', (els) => els.map((e) => e.textContent)),
        tabbarRow: await box('.tabbar-row'),
        sessionToolbar: await box('.session-toolbar'),
        hkMaskResidue: !!(await page.$('.hk-mask')),
      };
      // R13 样式改动实测：每根 .tab 宽 ∈ [120, 220]
      R.F_tabWidths = await page.$$eval('.tab', (els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        return { label: e.querySelector('.tab-label')?.textContent, w: Math.round(r.width * 10) / 10, minW: getComputedStyle(e).minWidth, maxW: getComputedStyle(e).maxWidth };
      }));
    }
    await shot('07-two-sessions');
  });

  // ---------- G. ⌘B 主机栏开合（浏览器路径，统一分发） ----------
  await step('G_hostbar', async () => {
    await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
    R.G_hostbar = { cmdBCollapsed: (await page.$('.hostbar')) === null };
    await shot('08-hostbar-collapsed');
    await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
    R.G_hostbar.cmdBReopened = !!(await page.$('.hostbar'));
    if (R.G_hostbar.cmdBReopened) R.G_hostbar.widthReopened = (await box('.hostbar')).w;
  });

  R.errors = errors;
  fs.writeFileSync(DIR + '/vis-r13-regress-result.json', JSON.stringify(R, null, 1));
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
