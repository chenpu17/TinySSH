// vis-r21 新面完整性探针（:5183 新端专用，真实 Chromium headless 1280x800）。
// 只读 UI + bridge.invoke 播种（create_identity / upsert_host），收尾删除播种数据。
// 断言面：
//  S 设置弹窗凭据库 section（.cred-row 结构/未绑定徽章/删除钮/空态消失）
//  T 暗色→亮色主题 token 翻转（getComputedStyle 对账 + 截图）
//  B upsert_host Key 绑定 → 「使用中」徽章切换 + 弹窗无布局破版
//  F 表单「已有密钥（凭据库）」select（选项含凭据 label / 选中后生成导入区隐藏）
//  N 1024 窄视口 select 不溢出不破版
//  C 清理：delete_host → delete_identity（无引用必成功）→ 两域回空
//  Z 零 console error / pageerror
// 登记（r20 探针同款坑）：后端播种一律走 import('/src/adapter/bridge.ts')（与应用同图同戳）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const OUT = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-b36015b-r21/vis/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 150000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });

  // 播种一条凭据（与应用同模块图 invoke）
  const ident = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    return await bridge.invoke('create_identity', { req: { Generate: { label: 'vis-test', kind: 'Ed25519' } } });
  });
  ok('P0 播种 create_identity 返回元数据', ident && ident.id && String(ident.fingerprint).startsWith('SHA256:'), JSON.stringify(ident));

  // ---- S 设置弹窗凭据库（暗色）----
  await page.click('.hb-settings');
  await page.waitForSelector('.cred-row', { timeout: 6000 });
  const row = await page.$('.cred-row');
  ok('S1 .cred-row 恰 1 行', (await page.$$('.cred-row')).length === 1);
  ok('S2 .cred-label=vis-test', (await row.$eval('.cred-label', (e) => e.textContent.trim())) === 'vis-test');
  ok('S3 .cred-kind 含 Ed25519', (await row.$eval('.cred-kind', (e) => e.textContent)).includes('Ed25519'));
  ok('S4 .cred-fp SHA256: 前缀', (await row.$eval('.cred-fp', (e) => e.textContent.trim())).startsWith('SHA256:'));
  const unbound = await row.$('.cred-unbound');
  ok('S5 未绑定徽章在位（文本=未绑定）且无使用中', !!unbound && (await unbound.textContent()).trim() === '未绑定' && !(await row.$('.cred-bound')));
  ok('S6 删除钮在位（aria-label）', !!(await row.$('button[aria-label="删除凭据 vis-test"]')));
  ok('S7 空态文案已消失', (await page.$$eval('.term-settings .dim', (els) => els.some((e) => e.textContent.includes('还没有凭据')))) === false);
  await page.screenshot({ path: OUT + 'new-cred-dark.png' });
  const darkStyles = await page.evaluate(() => {
    const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim();
    const computed = (decl) => { const d = document.createElement('div'); d.style.color = decl; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const row = document.querySelector('.cred-row');
    const unb = document.querySelector('.cred-unbound');
    return {
      unboundColor: cs(unb, 'color'),
      rowBorder: cs(row, 'border-bottom-color'),
      delColor: cs(row.querySelector('button'), 'color'),
      dimComputed: computed('var(--dim)'),
      borderComputed: computed('var(--border)'),
    };
  });
  ok('S8 暗色徽章/分隔线=token（归一化）', darkStyles.unboundColor === darkStyles.dimComputed && darkStyles.rowBorder === darkStyles.borderComputed, JSON.stringify(darkStyles));
  const darkBox = await (await page.$('.term-settings')).boundingBox();
  ok('S9 弹窗 boundingBox 采样', !!darkBox && darkBox.height > 100, JSON.stringify(darkBox));

  // ---- T 亮色主题翻转 ----
  await page.evaluate(() => localStorage.setItem('ui.theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  // demo 态在内存，reload 后重播种同一凭据（label 相同，新 id）
  const identLight = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    return await bridge.invoke('create_identity', { req: { Generate: { label: 'vis-test', kind: 'Ed25519' } } });
  });
  ok('T0 亮色轮重播种成功', !!identLight.id, JSON.stringify(identLight));
  await page.click('.hb-settings');
  await page.waitForSelector('.cred-row', { timeout: 6000 });
  const lightStyles = await page.evaluate(() => {
    const cs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim();
    const computed = (decl) => { const d = document.createElement('div'); d.style.color = decl; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const row = document.querySelector('.cred-row');
    const unb = document.querySelector('.cred-unbound');
    return {
      chrome: document.documentElement.getAttribute('data-chrome'),
      unboundColor: cs(unb, 'color'),
      rowBorder: cs(row, 'border-bottom-color'),
      delColor: cs(row.querySelector('button'), 'color'),
      dimComputed: computed('var(--dim)'),
      borderComputed: computed('var(--border)'),
    };
  });
  ok('T1 亮色 chrome 生效', lightStyles.chrome === 'light', lightStyles.chrome);
  ok('T2 徽章颜色随主题翻转', lightStyles.unboundColor !== darkStyles.unboundColor, `${darkStyles.unboundColor} -> ${lightStyles.unboundColor}`);
  ok('T3 cred-row 分隔线随主题翻转', lightStyles.rowBorder !== darkStyles.rowBorder, `${darkStyles.rowBorder} -> ${lightStyles.rowBorder}`);
  ok('T4 删除钮颜色随主题翻转', lightStyles.delColor !== darkStyles.delColor, `${darkStyles.delColor} -> ${lightStyles.delColor}`);
  ok('T5 --dim/--border token 值翻转', lightStyles.dimComputed !== darkStyles.dimComputed && lightStyles.borderComputed !== darkStyles.borderComputed, `dim ${darkStyles.dimComputed}->${lightStyles.dimComputed} border ${darkStyles.borderComputed}->${lightStyles.borderComputed}`);
  ok('T6 徽章色=token（--dim 同源，归一化比较）', await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--dim)';
    document.body.appendChild(probe);
    const a = getComputedStyle(probe).color;
    probe.remove();
    return a === getComputedStyle(document.querySelector('.cred-unbound')).color;
  }), 'probe-vs-badge');
  await page.screenshot({ path: OUT + 'new-cred-light.png' });
  const lightBox = await (await page.$('.term-settings')).boundingBox();
  ok('T7 亮色弹窗尺寸与暗色一致（主题不破版）', lightBox && darkBox && Math.abs(lightBox.height - darkBox.height) <= 1 && Math.abs(lightBox.width - darkBox.width) <= 1, `dark h=${darkBox.height} light h=${lightBox.height}`);

  // ---- B 绑定主机 → 使用中徽章 ----
  await page.evaluate(async (identId) => {
    const bridge = await import('/src/adapter/bridge.ts');
    await bridge.invoke('upsert_host', { host: { id: null, name: 'vis-bind', address: '10.0.0.99', port: 22, username: 'ops', auth: { Key: { identity_id: identId } }, tags: [], charset: 'utf-8' } });
  }, ident.id);
  await page.waitForSelector('.host-card:has(.host-name:text-is("vis-bind"))', { timeout: 8000 });
  // 设置面板开着时 identities 列表不会自动刷——关（点 pop-mask）开一次
  await page.click('.pop-mask'); await sleep(200); await page.click('.hb-settings');
  await page.waitForSelector('.cred-row .cred-bound', { timeout: 6000 });
  ok('B1 绑定后徽章切「使用中」', ((await page.$eval('.cred-bound', (e) => e.textContent.trim())) === '使用中'));
  ok('B2 未绑定徽章消失', !(await page.$('.cred-unbound')));
  const boundBox = await (await page.$('.term-settings')).boundingBox();
  ok('B3 绑定态弹窗尺寸不变（无布局破版）', boundBox && lightBox && Math.abs(boundBox.height - lightBox.height) <= 1, `h=${boundBox.height}`);
  await page.screenshot({ path: OUT + 'new-cred-bound-light.png' });

  // ---- F 表单「已有密钥」select ----
  await page.click('.pop-mask'); await sleep(200); // 关设置
  await page.click('button.icon-btn[aria-label="添加主机"]');
  await page.waitForSelector('.add-host', { timeout: 6000 });
  // 默认密码模式：无「已有密钥」字段（knownIdentities>0 但 authMode=password）
  ok('F0 密码模式无已有密钥 select', (await page.$$('.add-host .ah-field')) .length > 0 && !(await page.$('.add-host .ah-field:has(label:text-is("已有密钥（凭据库）"))')));
  // 切私钥模式
  await page.$eval('.add-host .ah-field:has(label:text-is("认证方式")) select', (el) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(el, 'key');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('.add-host .ah-field:has(label:text-is("已有密钥（凭据库）")) select', { timeout: 6000 });
  const opts = await page.$$eval('.add-host .ah-field:has(label:text-is("已有密钥（凭据库）")) select option', (els) => els.map((e) => e.textContent.trim()));
  ok('F1 select 渲染且选项含凭据 label', opts.some((t) => t.startsWith('vis-test · ')) && opts[0] === '新密钥（下方生成 / 导入）', JSON.stringify(opts));
  const genBtn = await page.$('.add-host button:has-text("生成新密钥")');
  const fileBtn = await page.$('.add-host .file-btn');
  const pemArea = await page.$('.add-host textarea');
  ok('F2 未选中时生成/导入区在位', !!genBtn && !!fileBtn && !!pemArea);
  await page.$eval('.add-host .ah-field:has(label:text-is("已有密钥（凭据库）")) select', (el) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const target = [...el.options].find((o) => o.textContent.includes('vis-test'));
    set.call(el, target.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  const genGone = await page.$('.add-host button:has-text("生成新密钥")');
  const areaGone = await page.$('.add-host textarea');
  ok('F3 选中已有密钥后生成/导入区隐藏', !genGone && !areaGone, `gen=${!!genGone} textarea=${!!areaGone}`);
  ok('F4 无水平溢出（1280）', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: OUT + 'new-form-key-picked-1280.png' });

  // ---- N 1024 窄视口 ----
  await page.setViewportSize({ width: 1024, height: 800 });
  await sleep(300);
  const selBox = await (await page.$('.add-host .ah-field:has(label:text-is("已有密钥（凭据库）")) select')).boundingBox();
  const formBox = await (await page.$('.add-host')).boundingBox();
  ok('N1 1024 下 select 在表单内不溢出', selBox && formBox && selBox.x >= formBox.x - 1 && selBox.x + selBox.width <= formBox.x + formBox.width + 1 && selBox.x + selBox.width <= 1024, JSON.stringify({ selBox, formRight: formBox ? formBox.x + formBox.width : null }));
  ok('N2 1024 无水平溢出', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: OUT + 'new-form-key-picked-1024.png' });

  // ---- C 清理播种数据 ----
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.$eval('.add-host', (el) => { el.querySelector('button[aria-label="收起表单"]')?.click(); });
  await sleep(150);
  const hosts = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    return await bridge.invoke('list_hosts');
  });
  const bind = hosts.find((h) => h.name === 'vis-bind');
  await page.evaluate(async (hid) => {
    const bridge = await import('/src/adapter/bridge.ts');
    await bridge.invoke('delete_host', { id: hid });
  }, bind.id);
  const del = await page.evaluate(async (iid) => {
    const bridge = await import('/src/adapter/bridge.ts');
    try { await bridge.invoke('delete_identity', { id: iid }); return 'ok'; } catch (e) { return 'REJECTED: ' + String(e); }
  }, ident.id);
  ok('C1 delete_host 后 delete_identity 无引用必成功', del === 'ok', del);
  const after = await page.evaluate(async () => {
    const bridge = await import('/src/adapter/bridge.ts');
    return { idents: await bridge.invoke('list_identities'), hosts: await bridge.invoke('list_hosts') };
  });
  ok('C2 播种清干净（identities=0 且 vis-bind 不在）', after.idents.length === 0 && !after.hosts.some((h) => h.name === 'vis-bind'), `idents=${after.idents.length} hosts=${after.hosts.length}`);

  // ---- Z 零 JS 错误 ----
  ok('Z1 零 console error / pageerror', consoleErrors.length === 0, JSON.stringify(consoleErrors));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`SUMMARY ${results.length - fails.length}/${results.length}` + (fails.length ? ' FAILS: ' + fails.map((f) => f.name).join('; ') : ''));
  process.exit(0);
})().catch((e) => { console.error('PROBE-ERROR ' + String(e)); process.exit(2); });
