// rev-r32 R3 retest: open files panel first
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let pass = 0, fail = 0;
const P = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} [${JSON.stringify(detail).slice(0, 300)}]`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:5183/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-card', { timeout: 10000 });
  const inv = (cmd, args) => page.evaluate(async ({ c, a }) => {
    const { invoke } = await import('/src/adapter/bridge.ts');
    return invoke(c, a);
  }, { c: cmd, a: args });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.host-card')].find((c) => c.textContent.includes('demo'));
    card?.querySelector('.host-connect-btn')?.click();
  });
  await sleep(800);
  await page.evaluate(() => {
    [...document.querySelectorAll('.hk-mask button')].find((x) => x.textContent.includes('信任并连接'))?.click();
  });
  for (let i = 0; i < 20; i++) {
    const s = await inv('list_sessions', {}).then((l) => l.find((x) => x.state === 'Connected')).catch(() => null);
    if (s) break;
    await sleep(300);
  }
  await sleep(1500);
  const sid = (await inv('list_sessions', {})).find((x) => x.state === 'Connected')?.id;
  if (!sid) { console.log('FATAL no session'); process.exit(1); }
  // create 3 tasks, let them finish
  for (const n of ['r3x', 'r3y', 'r3z']) await inv('upload_file', { sid, local: `/tmp/${n}.bin`, remote: `/var/log/${n}.bin` });
  await sleep(6000);
  const reg = await inv('list_transfers', {});
  // open files panel
  await page.evaluate(() => document.querySelector('.st-file')?.click());
  await sleep(1000);
  let cards = await page.evaluate(() => document.querySelectorAll('.xfer-row').length);
  P('R3a panel cards == registry size (reconciled)', cards === reg.length, { cards, registry: reg.length });
  await inv('upload_file', { sid, local: '/tmp/r3new.bin', remote: '/var/log/r3new.bin' });
  await sleep(2500);
  const reg2 = await inv('list_transfers', {});
  cards = await page.evaluate(() => [...document.querySelectorAll('.xfer-row')].map((r) => r.querySelector('.xfer-name')?.textContent));
  P('R3b new task added, old cards retained', reg2.length === reg.length + 1 && cards.length >= reg2.length - 1, { registryBefore: reg.length, registryAfter: reg2.length, cards });
  P('R3c old card names still visible', cards.some((n) => n && (n.includes('r3x') || n.includes('r3y'))), cards);
  console.log(`SUMMARY ${pass}/${pass + fail}`);
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
