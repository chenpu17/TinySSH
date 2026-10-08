// vis-r21 复核测量（修复后两行布局 .cred-top/.cred-sub）：四态（暗/亮 × 未绑定/使用中）
// 断言：label 渲染宽度 > 0、kind 与 fp 盒不相交、删除钮在位、行高两行、截图留档。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-b36015b-r21/vis/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const measure = async (theme, bound, tag) => {
    await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    if (theme === 'light') await page.evaluate(() => localStorage.setItem('ui.theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.host-card', { timeout: 10000 });
    const ident = await page.evaluate(async () => {
      const bridge = await import('/src/adapter/bridge.ts');
      return await bridge.invoke('create_identity', { req: { Generate: { label: 'vis-test', kind: 'Ed25519' } } });
    });
    if (bound) {
      await page.evaluate(async (iid) => {
        const bridge = await import('/src/adapter/bridge.ts');
        await bridge.invoke('upsert_host', { host: { id: null, name: 'vis-bind', address: '10.0.0.99', port: 22, username: 'ops', auth: { Key: { identity_id: iid } }, tags: [], charset: 'utf-8' } });
      }, ident.id);
      await page.waitForSelector('.host-card:has(.host-name:text-is("vis-bind"))', { timeout: 8000 });
    }
    await page.click('.hb-settings');
    await page.waitForSelector('.cred-row', { timeout: 6000 });
    await sleep(150);
    const m = await page.evaluate((isBound) => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
      const label = box('.cred-label'), kind = box('.cred-kind'), fp = box('.cred-fp');
      const row = box('.cred-row');
      const noOverlap = !(kind && fp) || kind.y !== fp.y || (kind.x + kind.w <= fp.x + 0.5);
      return {
        label, kind, fp, row,
        labelVisible: label && label.w > 10,
        noOverlapKindFp: noOverlap,
        badge: box(isBound ? '.cred-bound' : '.cred-unbound'),
        delBtn: !!document.querySelector('.cred-row button[aria-label^="删除凭据"]'),
        twoLineRows: kind && fp && Math.abs(kind.y - fp.y) < 2 && label && fp.y > label.y + label.h - 2,
      };
    }, bound);
    ok(`${tag} label 可见（w>10, 实际 ${m.label && m.label.w}）`, m.labelVisible, JSON.stringify(m.label));
    ok(`${tag} kind 与指纹不叠印`, m.noOverlapKindFp, `kind=${JSON.stringify(m.kind)} fp=${JSON.stringify(m.fp)}`);
    ok(`${tag} 两行布局（label 行在上，kind/fp 同行在下）`, m.twoLineRows);
    ok(`${tag} 徽章在位（${bound ? '使用中' : '未绑定'}）`, !!m.badge, JSON.stringify(m.badge));
    ok(`${tag} 删除钮在位`, m.delBtn);
    await page.screenshot({ path: OUT + `fix-cred-${tag}.png` });
    return m;
  };

  await measure('dark', false, 'dark-unbound');
  await measure('dark', true, 'dark-bound');
  await measure('light', false, 'light-unbound');
  const m4 = await measure('light', true, 'light-bound');

  // 清理播种（最后一轮还挂着 vis-bind 主机）
  await page.click('.pop-mask'); await sleep(150);
  const cleanup = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    const hosts = await bridge.invoke('list_hosts');
    const bind = hosts.find((h) => h.name === 'vis-bind');
    if (bind) await bridge.invoke('delete_host', { id: bind.id });
    const idents = await bridge.invoke('list_identities');
    for (const it of idents) await bridge.invoke('delete_identity', { id: it.id });
    return { hosts: (await bridge.invoke('list_hosts')).filter((h) => h.name === 'vis-bind').length, idents: (await bridge.invoke('list_identities')).length };
  });
  ok('清理播种零残留', cleanup.hosts === 0 && cleanup.idents === 0, JSON.stringify(cleanup));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`SUMMARY ${results.length - fails.length}/${results.length}` + (fails.length ? ' FAILS: ' + fails.map((f) => f.name).join('; ') : ''));
})().catch((e) => { console.error('PROBE-ERROR ' + String(e)); process.exit(2); });
