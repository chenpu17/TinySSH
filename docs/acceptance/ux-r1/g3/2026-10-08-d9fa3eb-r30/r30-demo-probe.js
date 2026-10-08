// R30 路径/条目元数据/会话隔离 探针（真实 Chromium + vite demo 后端 :5183）：
// A resolve/stat/list 契约（demo invoke 直测）：初始目录、canonical 归一、
//   不存在/权限可区别 kind、symlink 三态（可达/悬空）、未知字段 null；
// B UI 渲染：首载链 cwd、未知字段「—」、symlink 行「→/链接」+ 点击进入、
//   canonical 导航（../ 归一）、不存在/权限路径可读错误（旧码必红判别多处）；
// C C02 过期响应保护：慢目录晚到响应不得覆盖新路径（旧码必红）；
// Z 零 JS 错误。
// 工艺：demo 态内存态 reload 即清；invoke 走页面内 import('/src/adapter/bridge.ts')。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.PROBE_URL || 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 240000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  await sleep(400);

  const demoInvoke = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  // 旧码（无 C4 命令面）rejection 会让 evaluate 整体炸——契约断言面用安全壳
  const safeInvoke = async (cmd, args) => {
    try { return await demoInvoke(cmd, args); } catch (e) { return null; }
  };
  // 错误断言面：rejection 在页面内捕获归一（evaluate 外层 catch 拿不到 kind）
  const demoInvokeErr = (cmd, args) => page.evaluate(async ({ c, a }) => {
    try {
      const { invoke } = await import('/src/adapter/bridge.ts');
      await invoke(c, a);
      return null;
    } catch (e) {
      return { kind: e && typeof e.kind === 'string' ? e.kind : null, message: e && e.message ? String(e.message) : String(e) };
    }
  }, { c: cmd, a: args });
  const waitFor_ = async (fn, tries, gap = 120) => {
    for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
    return null;
  };
  const connectHost = async (needle) => {
    await page.evaluate((h) => {
      const card = [...document.querySelectorAll('.host-card')].find((c) => c.querySelector('.host-name')?.textContent.includes(h));
      card?.querySelector('.host-connect-btn')?.click();
    }, needle);
    await page.waitForSelector('.hk-mask', { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'));
      b?.click();
    });
    return waitFor_(async () => {
      const list = await demoInvoke('list_sessions');
      return list.find((x) => x.host_name.includes(needle) && x.state === 'Connected')?.id ?? null;
    }, 100);
  };
  const sftpPathVal = () => page.evaluate(() => document.querySelector('.sftp-path input')?.value ?? null);
  const rowsText = () => page.evaluate(() => [...document.querySelectorAll('.sftp-list .sftp-row')].map((r) => r.textContent).join(' || '));
  const errText = () => page.evaluate(() => document.querySelector('.section .err')?.textContent ?? null);
  const setPath = (v) => page.evaluate((x) => {
    const el = document.querySelector('.sftp-path input');
    // React 受控输入：原生 value setter + input 事件（直赋会被 tracker 去重丢 onChange）
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus();
    set.call(el, x);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, v);

  // ================= A: resolve/stat/list 契约（invoke 面） =================
  const sidSeed = (await demoInvoke('list_sessions')).find((x) => x.host_name === 'prod-1')?.id ?? 's-demo-0001';
  const r0 = await safeInvoke('sftp_resolve_path', { sid: sidSeed, path: null });
  ok('A1 resolve null → initial dir canonical', r0 && r0.canonical === '/var/log/nginx', JSON.stringify(r0));
  const r1 = await safeInvoke('sftp_resolve_path', { sid: sidSeed, path: '/root/../root' });
  ok('A2 resolve normalizes dotdot', r1 && r1.canonical === '/root', JSON.stringify(r1));
  let missErr = null;
  try { missErr = await demoInvokeErr('sftp_resolve_path', { sid: sidSeed, path: '/nope-r30' }); } catch (e) { missErr = null; }
  ok('A3 resolve missing → sftp_path_not_found kind', missErr && missErr.kind === 'sftp_path_not_found',
    missErr ? (missErr.kind ?? JSON.stringify(missErr)) : 'no-reject');
  let privErr = null;
  try { privErr = await demoInvokeErr('sftp_resolve_path', { sid: sidSeed, path: '/var/private' }); } catch (e) { privErr = null; }
  ok('A4 resolve denied → sftp_permission_denied kind', privErr && privErr.kind === 'sftp_permission_denied',
    privErr ? (privErr.kind ?? JSON.stringify(privErr)) : 'no-reject');
  const stC = await safeInvoke('sftp_stat', { sid: sidSeed, path: '/root/current' });
  ok('A5 stat symlink-to-dir: kind/target/is_dir/canonical', stC && stC.kind === 'symlink' && stC.symlink_target === '/root/releases/v3' && stC.is_dir === true && stC.canonical === '/root/releases/v3', JSON.stringify(stC));
  const stG = await safeInvoke('sftp_stat', { sid: sidSeed, path: '/root/gone-link' });
  ok('A6 stat dangling: canonical null, target kept', stG && stG.kind === 'symlink' && stG.canonical === null && stG.symlink_target === '/var/gone', JSON.stringify(stG));
  const stS = await safeInvoke('sftp_stat', { sid: sidSeed, path: '/var/log/nginx/php-fpm.sock' });
  ok('A7 stat socket: kind other, size/mtime null', stS && stS.kind === 'other' && stS.size === null && stS.mtime === null, JSON.stringify(stS));
  const es = await safeInvoke('sftp_list', { sid: sidSeed, path: '/var/log/nginx' });
  const sock = (es ?? []).find((x) => x.name === 'php-fpm.sock');
  const link = (es ?? []).find((x) => x.name === 'latest');
  ok('A8 list carries kind + null fields', !!sock && sock.size === null && sock.mtime === null && !!link && link.kind === 'symlink', JSON.stringify({ sock, link }));

  // ================= B: UI 渲染（建连 → files 面板） =================
  const sidP = await connectHost('prod-1');
  ok('B0 connect prod-1', !!sidP);
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  const inpUp = await page.waitForSelector('.sftp-path input', { timeout: 5000 }).catch(() => null);
  ok('B1 files panel opens with path input', !!inpUp);
  // 首载链：brief cwd=/var/log/nginx 自动载入
  const firstRows = await waitFor_(async () => ((await rowsText()).includes('access.log') ? await rowsText() : null), 50);
  ok('B2 first-load chain uses brief cwd', !!firstRows, (await sftpPathVal()) ?? 'no-path');
  ok('B3 path shows canonical cwd', (await sftpPathVal()) === '/var/log/nginx', (await sftpPathVal()) ?? 'null');
  // 未知字段「—」（旧码 fmtBytes(0)="0 B" + epoch 日期 必红）
  const sockRow = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.sftp-list .sftp-row')].find((x) => x.textContent.includes('php-fpm.sock'));
    return r ? { size: r.querySelector('.sftp-size')?.textContent, time: r.querySelector('.sftp-time')?.textContent } : null;
  });
  ok('B4 unknown size/mtime render em-dash', sockRow && sockRow.size === '—' && sockRow.time === '—', JSON.stringify(sockRow));
  // symlink 行：→ 图标 + 「链接」 + 名字为按钮
  const linkRow = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.sftp-list .sftp-row')].find((x) => x.textContent.includes('latest'));
    if (!r) return null;
    return { ico: r.querySelector('.sftp-ico')?.textContent, size: r.querySelector('.sftp-size')?.textContent, btn: r.querySelector('.sftp-name')?.tagName };
  });
  ok('B5 symlink row: arrow glyph + 链接 + button', linkRow && linkRow.ico?.includes('→') && linkRow.size === '链接' && linkRow.btn === 'BUTTON', JSON.stringify(linkRow));
  // 点击 symlink（stat 探明目录 → 进入跟随列表）
  await page.evaluate(() => {
    [...document.querySelectorAll('.sftp-list .sftp-row .sftp-name')].find((b) => b.textContent === 'latest')?.click();
  });
  const atLatest = await waitFor_(async () => ((await sftpPathVal()) === '/var/log/nginx/latest' ? true : null), 40);
  ok('B6 click symlink navigates (follow list)', !!atLatest, (await sftpPathVal()) ?? 'null');
  const latestRows = await rowsText();
  ok('B6b followed list has targets, not the link itself', latestRows.includes('access.log') && !latestRows.includes('latest'), latestRows.slice(0, 100));
  // canonical 导航（../ 归一）
  await setPath('/root/../root/deploy');
  const atDeploy = await waitFor_(async () => ((await sftpPathVal()) === '/root/deploy' ? true : null), 40);
  ok('B7 input canonicalizes dotdot before listing', !!atDeploy, (await sftpPathVal()) ?? 'null');
  ok('B7b deploy rows present', (await rowsText()).includes('release.sh'));
  // /root：两个 symlink（current 可进、gone-link 悬空）
  await setPath('/root');
  await waitFor_(async () => ((await rowsText()).includes('gone-link') ? true : null), 40);
  await page.evaluate(() => {
    [...document.querySelectorAll('.sftp-list .sftp-row .sftp-name')].find((b) => b.textContent === 'current')?.click();
  });
  const atV3 = await waitFor_(async () => ((await sftpPathVal()) === '/root/current' ? true : null), 40);
  ok('B8 /root/current symlink navigates to v3 content', !!atV3 && (await rowsText()).includes('app.tar.gz'), (await sftpPathVal()) ?? 'null');
  // 不存在/权限路径：可读错误（不猜路径）
  await setPath('/nope-r30');
  const missUi = await waitFor_(async () => ((await errText())?.includes('不存在') ? await errText() : null), 40);
  ok('B9 missing path input → readable not-found error', !!missUi, (await errText()) ?? 'null');
  await setPath('/var/private');
  const privUi = await waitFor_(async () => ((await errText())?.includes('权限不足') ? await errText() : null), 40);
  ok('B10 denied path input → readable denied error', !!privUi, (await errText()) ?? 'null');

  // ================= C: C02 代际守卫（旧码必红） =================
  await safeInvoke('demo_sftp_slow', { path: '/root/logs', ms: 1200 }); // 旧码无钩子：safe 壳降级为无延迟
  await setPath('/root/logs');          // 慢（1200ms 后到）
  await setPath('/root/deploy');        // 快（先到）
  const deployNow = await waitFor_(async () => ((await sftpPathVal()) === '/root/deploy' && (await rowsText()).includes('release.sh') ? true : null), 40);
  ok('C1 fast navigation lands first', !!deployNow);
  await sleep(1600);                    // 慢响应此刻已晚到
  const pathAfter = await sftpPathVal();
  const rowsAfter = await rowsText();
  ok('C2 late stale response does NOT overwrite (C02)', pathAfter === '/root/deploy' && rowsAfter.includes('release.sh') && !rowsAfter.includes('app.log'),
    `path=${pathAfter} rows=${rowsAfter.slice(0, 80)}`);
  ok('C3 loading state cleared (no stuck skeleton)', await page.evaluate(() => !document.querySelector('.sftp-list[aria-busy=\"true\"]') && !document.querySelector('.sftp-sk')));
  await safeInvoke('demo_sftp_slow', { path: '', ms: 0 }); // 清钩子

  // ================= Z: 零 JS 错误 =================
  ok('Z0 zero js errors', jsErrors.length === 0, jsErrors.join('||').slice(0, 200));

  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
})();
