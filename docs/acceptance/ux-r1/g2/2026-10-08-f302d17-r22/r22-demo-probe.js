// R22 C7 SSH config 导入诊断 demo 探针（真实 Chromium + vite demo 后端，:5183）：
// A 面板分级列：阻断/警告/未指定用户徽章 + 溯源行；B 默认勾选 = 可直接导入且未导入；
// C 导入选中；D 已在列表条目「勾选即覆盖」（overwrite=true 反证：未传则核心回
//   Duplicate、行内出现「跳过：重复」兜底文案）；E 转手工表单预填（DF7.4：
//   blocked 带「含不兼容指令」提示；nouser 带「未指定用户」提示 + 用户名留空；
//   标签 ssh-config）。
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log(JSON.stringify(results)); console.error('PROBE-WATCHDOG'); process.exit(3); }, 180000).unref?.();

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });

  const panel = () => page.evaluateHandle(() => [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('从 ~/.ssh/config 导入')) || null);
  const row = async (name) => {
    const p = await panel();
    return p.asElement()?.evaluateHandle((c, n) => [...c.querySelectorAll('.sshcfg-row')].find((r) => r.textContent.includes(n)) || null, name);
  };
  const rowState = async (name) => {
    const r = (await row(name)).asElement();
    if (!r) return null;
    return r.evaluate((el) => {
      const cb = el.querySelector('input[type="checkbox"]');
      return {
        checked: cb?.checked ?? null, disabled: cb?.disabled ?? null,
        text: el.textContent,
        manual: !!([...el.querySelectorAll('button')].find((b) => b.textContent.includes('转手工表单'))),
      };
    });
  };
  const openPanel = async () => {
    await page.click('button[aria-label="导入 ~/.ssh/config"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('从 ~/.ssh/config 导入')), { timeout: 4000 });
    await sleep(200);
  };
  const closePanel = async () => {
    const p = (await panel()).asElement();
    const btn = await p?.$$('button');
    for (const b of btn ?? []) { if ((await b.textContent())?.trim() === '收起') { await b.click(); break; } }
    await sleep(200);
  };

  // ---- A/B 面板分级 + 默认勾选 ----
  await openPanel();
  const names = await (await panel()).asElement()?.evaluate((c) => [...c.querySelectorAll('.sshcfg-row')].map((r) => r.textContent.slice(0, 12)));
  ok('A1 五条目渲染', (names ?? []).length === 5, JSON.stringify(names));
  const web = await rowState('web-1');
  ok('A2 web-1 警告级未同步标注', !!web && web.text.includes('未同步') && web.text.includes('serveraliveinterval'), web?.text.slice(0, 120));
  ok('A3 web-1 溯源 ~/.ssh/config:3', !!web && web.text.includes('~/.ssh/config:3'), web?.text.slice(0, 80));
  const blocked = await rowState('bastion-jump');
  ok('B1 bastion-jump 阻断级标注+勾选禁用+转手工表单钮', !!blocked && blocked.disabled && !blocked.checked && blocked.manual && blocked.text.includes('阻断') && blocked.text.includes('proxyjump'), JSON.stringify(blocked));
  const nouser = await rowState('nouser');
  ok('B2 nouser 未指定用户标注+勾选禁用', !!nouser && nouser.disabled && nouser.text.includes('未指定登录用户'), JSON.stringify(nouser));
  const db1 = await rowState('db-1');
  ok('B3 db-1 默认勾选（可直接导入且未导入）', !!db1 && db1.checked && !db1.disabled, JSON.stringify(db1));
  const prod = await rowState('prod-1');
  ok('B4 prod-1 已在列表不默认勾选（勾选即覆盖文案）', !!prod && !prod.checked && !prod.disabled && prod.text.includes('已在主机列表'), JSON.stringify(prod));

  // ---- C 导入选中：web-1/db-1 成功 ----
  await (await panel()).asElement()?.evaluate((c) => {
    [...c.querySelectorAll('button')].find((b) => b.textContent.includes('导入选中')).click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('✓ 已导入')), { timeout: 5000 });
  const importedCnt = await (await panel()).asElement()?.evaluate((c) => (c.textContent.match(/✓ 已导入/g) || []).length);
  ok('C1 两条导入成功', importedCnt === 2, String(importedCnt));
  await closePanel();
  const webCard = await page.evaluate(() => [...document.querySelectorAll('.host-card .host-name')].some((n) => n.textContent.trim() === 'web-1'));
  ok('C2 web-1 主机卡刷出', webCard);

  // ---- D 重复与显式覆盖 ----
  await openPanel();
  const web2 = await rowState('web-1');
  ok('D1 重开后 web-1 已在列表且不默认勾选', !!web2 && !web2.checked && web2.text.includes('已在主机列表'), JSON.stringify(web2));
  // 勾 prod-1（已导入）→「勾选即覆盖」→ 必须直接成功（若 overwrite 未传则核心回
  // Duplicate、行内出现「跳过：重复」——以此反证 overwrite=true 已随请求发送）
  await (await row('prod-1')).asElement()?.evaluate((el) => el.querySelector('input[type="checkbox"]').click());
  await (await panel()).asElement()?.evaluate((c) => {
    [...c.querySelectorAll('button')].find((b) => b.textContent.includes('导入选中')).click();
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('✓ 已导入')), { timeout: 5000 });
  const dupSkipShown = await (await panel()).asElement()?.evaluate((c) => c.textContent.includes('跳过：重复'));
  const prodDone = await rowState('prod-1');
  ok('D2 勾选已导入条目=显式覆盖成功（无 Duplicate 兜底文案）', !dupSkipShown && !!prodDone && prodDone.checked && prodDone.text.includes('✓ 已导入'), JSON.stringify(prodDone));

  // ---- E 转手工表单预填（DF7.4） ----
  const bRow = (await row('bastion-jump')).asElement();
  await bRow?.evaluate((el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('转手工表单')).click());
  await page.waitForSelector('.add-host', { timeout: 4000 });
  const prefill = await page.evaluate(() => {
    const f = document.querySelector('.add-host');
    const inputs = [...f.querySelectorAll('input')];
    const sel = f.querySelector('select');
    return {
      hint: f.textContent.includes('预填自 ~/.ssh/config:12') && f.textContent.includes('不兼容指令'),
      name: inputs[0]?.value, address: inputs[1]?.value, port: inputs[2]?.value, user: inputs[3]?.value,
      auth: sel?.value, tags: inputs[inputs.length - 1]?.value,
      panelGone: ![...document.querySelectorAll('.card')].some((c) => c.textContent.includes('从 ~/.ssh/config 导入')),
    };
  });
  ok('E1 blocked 预填全字段+面板关闭', prefill.panelGone && prefill.name === 'bastion-jump' && prefill.address === '10.9.8.7' && prefill.port === '22' && prefill.user === 'ops', JSON.stringify(prefill));
  ok('E2 blocked 预填提示含不兼容指令+authMode=agent+标签 ssh-config', prefill.hint && prefill.auth === 'agent' && prefill.tags === 'ssh-config', JSON.stringify(prefill));
  await page.keyboard.press('Escape');
  await sleep(200);

  await openPanel();
  const nRow = (await row('nouser')).asElement();
  await nRow?.evaluate((el) => [...el.querySelectorAll('button')].find((b) => b.textContent.includes('转手工表单')).click());
  await page.waitForSelector('.add-host', { timeout: 4000 });
  const prefill2 = await page.evaluate(() => {
    const f = document.querySelector('.add-host');
    const inputs = [...f.querySelectorAll('input')];
    return { hint: f.textContent.includes('未指定用户'), name: inputs[0]?.value, user: inputs[3]?.value };
  });
  ok('E3 nouser 预填提示未指定用户+用户名留空', prefill2.hint && prefill2.name === 'nouser' && prefill2.user === '', JSON.stringify(prefill2));
  await page.keyboard.press('Escape');
  await sleep(200);

  ok('Z1 零 JS 错误', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  console.log('SUMMARY ' + results.filter((r) => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})();
