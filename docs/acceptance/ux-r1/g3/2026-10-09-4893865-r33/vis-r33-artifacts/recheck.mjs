// vis-r33 处置轮聚焦复核：welcome 有界差/新文案、尾部提示、drop-err+no-cwd-hint 深浅可读性
import { chromium } from '/Users/chenpu/node_modules/playwright/index.mjs';
import zlib from 'node:zlib';
import fs from 'node:fs';

const OUT = '/tmp/vis-r33';
const report = [];
const R = (name, pass, detail) => { report.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${detail}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodePNG(buf) {
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported png bd=${bitDepth} ct=${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const out = Buffer.alloc(h * stride); let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++]; const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null; const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = (x >= bpp && prev) ? prev[x - bpp] : 0;
      let v = raw[p + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    p += stride;
  }
  return { w, h, bpp, data: out };
}
// diff：strict 像素计数 + 差异像素 bounding box（有界性判定）
function diffBox(a, b) {
  const n = a.data.length; let cnt = 0; let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1; let maxCh = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(a.data[i] - b.data[i]); if (d > maxCh) maxCh = d; }
  for (let px = 0; px < a.w * a.h; px++) {
    const i = px * a.bpp; let diff = false;
    for (let c = 0; c < a.bpp; c++) if (a.data[i + c] !== b.data[i + c]) { diff = true; break; }
    if (diff) { cnt++; const x = px % a.w, y = (px / a.w) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { count: cnt, box: cnt ? { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 } : null, maxCh };
}

const fContrast = eval(`(${(([fgSel, bgSel]) => {
  const lum = (el) => { const c = getComputedStyle(el).color.match(/[\d.]+/g).map(Number); const bg2 = getComputedStyle(el).backgroundColor.match(/[\d.]+/g).map(Number); const L = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); }; return { fg: L(c), bg: L(bg2) }; };
  const f = document.querySelector(fgSel), b = document.querySelector(bgSel); if (!f || !b) return null;
  const lf = lum(f), lb = lum(b); const hi = Math.max(lf.fg, lf.bg, lb.fg, lb.bg), lo = Math.min(lf.fg, lf.bg, lb.fg, lb.bg);
  return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}).toString()})`);

const invoke = (page, cmd, args) => page.evaluate(async ([c, a]) => { const b = await import('/src/adapter/bridge.ts'); return await b.invoke(c, a); }, [cmd, args]);

const browser = await chromium.launch({ executablePath: '/Users/chenpu/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
const errors = [];
async function newPage(ctx, url) {
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 150)}`); });
  page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 150)}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.host-card', { timeout: 15000 });
  await sleep(500);
  return page;
}

// ==== 1. welcome 双树（处置后：diff 应有界于传输行文字区）====
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
const cur = await newPage(ctxA, 'http://localhost:5183/');
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
const base = await newPage(ctxB, 'http://localhost:5184/');

await cur.screenshot({ path: `${OUT}/rc-w-cur.png` }); await sleep(200);
await cur.screenshot({ path: `${OUT}/rc-w-cur2.png` });
await base.screenshot({ path: `${OUT}/rc-w-base.png` });
const self = diffBox(decodePNG(fs.readFileSync(`${OUT}/rc-w-cur.png`)), decodePNG(fs.readFileSync(`${OUT}/rc-w-cur2.png`)));
const cross = diffBox(decodePNG(fs.readFileSync(`${OUT}/rc-w-cur.png`)), decodePNG(fs.readFileSync(`${OUT}/rc-w-base.png`)));
R('rc-selfnoise', self.count === 0, `当前树自噪声 strict=${self.count}`);
const inSteps = cross.box && cross.box.minX >= 400 && cross.box.maxX <= 1050 && cross.box.minY >= 380 && cross.box.maxY <= 560;
R('rc-welcome-bounded', cross.count > 0 && inSteps, `双树 strict=${cross.count}px maxCh=${cross.maxCh} bbox=x[${cross.box.minX},${cross.box.maxX}] y[${cross.box.minY},${cross.box.maxY}] (${cross.box.w}x${cross.box.h}) 有界于 welcome 步骤区=${inSteps}`);
const welcomeTxt = await cur.evaluate(() => [...document.querySelectorAll('.welcome-steps .ws-k')].map(e => e.parentElement.textContent).find(t => t.includes('传输')) ?? '');
R('rc-welcome-copy', welcomeTxt.includes('拖文件进窗口上传') && welcomeTxt.includes('拖到文件面板直接传到正在浏览的目录') && welcomeTxt.includes('拖到终端先确认目标'), `新文案="${welcomeTxt.trim().slice(0, 70)}..."`);
await base.close(); await ctxB.close();

// ==== 2. 会话 + 面板：尾部新提示 + 确认卡错误行/提示行 ====
await cur.locator('.tab', { hasText: 'prod-1' }).first().click();
await cur.waitForSelector('.st-file', { timeout: 10000 }); await sleep(700);
await cur.click('.st-file');
await cur.waitForSelector('.sftp-row', { timeout: 10000 }); await sleep(300);
const footerTxt = await cur.evaluate(() => [...document.querySelectorAll('.side-quiet')].find(e => e.textContent.includes('单击选中'))?.textContent ?? '');
R('rc-footer-copy', footerTxt.includes('下载存上次下载目录') && footerTxt.includes('另存为'), `尾部提示="${footerTxt.trim().slice(0, 60)}..."`);

// 深色先测：错误行触发（提交不存在目录 → sftp_resolve_path 拒）

const closeCard = async (page) => {
  await page.keyboard.press('Escape'); await sleep(150);
  if (await page.locator('.confirm-mask').count()) {
    await page.mouse.click(30, 30); await sleep(200);
    await page.keyboard.press('Escape'); await sleep(150);
  }
  return await page.locator('.confirm-mask').count();
};

const openCard = async () => { await invoke(cur, 'demo_drag_drop', { paths: ['/Users/demo/Desktop/a.tar.gz'], x: 200, y: 400 }); await cur.waitForSelector('.confirm-dialog', { timeout: 5000 }); await sleep(120); };
await openCard();
const hintAbsent = await cur.evaluate(() => !document.querySelector('[data-testid="drop-no-cwd-hint"]'));
R('rc-hint-absent-default', hintAbsent, '默认（有 cwd）提示行不在');
await cur.fill('[data-testid="drop-dir-input"]', '/no/such/dir');
await cur.click('[data-testid="drop-confirm"]'); await sleep(400);
const errInfo = await cur.evaluate(() => {
  const el = document.querySelector('[data-testid="drop-err"]'); if (!el) return null;
  const range = document.createRange(); range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter(r => r.width > 0);
  const er = el.getBoundingClientRect(); const dlg = document.querySelector('.confirm-dialog').getBoundingClientRect();
  const bad = rects.filter(r => r.left < er.left - 0.6 || r.right > er.right + 0.6 || r.top < er.top - 0.6 || r.bottom > er.bottom + 0.6 || r.bottom > dlg.bottom + 0.6);
  return { txt: el.textContent.trim(), rects: rects.length, bad: bad.length, dlgBottom: +dlg.bottom.toFixed(0), dlgH: +dlg.height.toFixed(0) };
});
R('rc-errline-dark', !!errInfo && errInfo.bad === 0 && errInfo.dlgBottom <= 800, `深色错误行="${errInfo?.txt}" rect=${errInfo?.rects} 截断=${errInfo?.bad} 卡高=${errInfo?.dlgH} 底=${errInfo?.dlgBottom}≤800`);
const cErrDark = await cur.evaluate(fContrast, ['[data-testid="drop-err"]', '.confirm-dialog']);
R('rc-err-contrast-dark', cErrDark >= 4.5, `深色 err/卡底对比度=${cErrDark}`);
await cur.screenshot({ path: `${OUT}/rc-card-err-dark.png` });
const mLeft = await closeCard(cur);
if (mLeft) R('rc-esc-close-dark', false, `Esc 后 mask 残留=${mLeft}`); else R('rc-esc-close-dark', true, 'Esc 关卡干净');

// 无可信 cwd：demo_brief_cwd {cwd:null} → 重 attach 刷新 brief → 提示行出现
await invoke(cur, 'demo_brief_cwd', { cwd: null }); await sleep(150);
await cur.locator('.tab', { hasText: 'staging-1' }).first().click(); await sleep(350);
await cur.locator('.tab', { hasText: 'prod-1' }).first().click();
await cur.waitForSelector('.st-file', { timeout: 8000 }); await sleep(500);
await openCard();
const hintInfo = await cur.evaluate(() => {
  const el = document.querySelector('[data-testid="drop-no-cwd-hint"]'); if (!el) return null;
  const range = document.createRange(); range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter(r => r.width > 0);
  const er = el.getBoundingClientRect();
  const bad = rects.filter(r => r.left < er.left - 0.6 || r.right > er.right + 0.6 || r.top < er.top - 0.6 || r.bottom > er.bottom + 0.6);
  return { txt: el.textContent.trim(), rects: rects.length, bad: bad.length, inputVal: document.querySelector('[data-testid="drop-dir-input"]').value, disabled: document.querySelector('[data-testid="drop-confirm"]').disabled, focused: document.activeElement?.getAttribute('data-testid') };
});
R('rc-hint-line', !!hintInfo && hintInfo.bad === 0 && hintInfo.focused === 'drop-dir-input',
  `提示行="${hintInfo?.txt?.slice(0, 30)}..." rect=${hintInfo?.rects} 截断=${hintInfo?.bad} 焦点=${hintInfo?.focused} 预填="${hintInfo?.inputVal}"（设计：无可信 cwd 时以可见面板浏览目录预填，非借不可见状态；「都无留空」分支 demo 不可达=登记面）`);
await cur.screenshot({ path: `${OUT}/rc-card-hint-dark.png` });
const cHintDark = await cur.evaluate(fContrast, ['[data-testid="drop-no-cwd-hint"]', '.confirm-dialog']);
// Esc 关 + 恢复 cwd 默认
const mLeft2 = await closeCard(cur);
R('rc-esc-close-hint', mLeft2 === 0, `提示行卡 Esc 后残留=${mLeft2}`);
await invoke(cur, 'demo_brief_cwd', {}); await sleep(100);

// 浅色同一组
await cur.emulateMedia({ colorScheme: 'light' }); await sleep(400);
await openCard();
await cur.fill('[data-testid="drop-dir-input"]', '/no/such/dir');
await cur.click('[data-testid="drop-confirm"]'); await sleep(400);
const cErrLight = await cur.evaluate(fContrast, ['[data-testid="drop-err"]', '.confirm-dialog']);
const errVisible = await cur.evaluate(() => !!document.querySelector('[data-testid="drop-err"]'));
R('rc-err-contrast-light', errVisible && cErrLight >= 4.5, `浅色 err 行在=${errVisible} err/卡底对比度=${cErrLight}`);
await cur.screenshot({ path: `${OUT}/rc-card-err-light.png` });
await invoke(cur, 'demo_brief_cwd', { cwd: null }); await sleep(100);
const mLeft3 = await closeCard(cur);
R('rc-esc-close-light', mLeft3 === 0, `浅色错误卡关闭残留=${mLeft3}`);
await cur.locator('.tab', { hasText: 'staging-1' }).first().click(); await sleep(350);
await cur.locator('.tab', { hasText: 'prod-1' }).first().click();
await cur.waitForSelector('.st-file', { timeout: 8000 }); await sleep(500);
await openCard();
const hintPresent = await cur.evaluate(() => !!document.querySelector('[data-testid="drop-no-cwd-hint"]'));
const cHintLight = await cur.evaluate(fContrast, ['[data-testid="drop-no-cwd-hint"]', '.confirm-dialog']);
R('rc-hint-contrast-light', hintPresent && cHintLight !== null, `浅色提示行在=${hintPresent} 对比度=${cHintLight}（dim 次要文本，数字如实报）`);
await cur.screenshot({ path: `${OUT}/rc-card-hint-light.png` });
const mLeft4 = await closeCard(cur);
R('rc-esc-close-light2', mLeft4 === 0, `浅色提示卡关闭残留=${mLeft4}`);
await invoke(cur, 'demo_brief_cwd', {});
await ctxA.close();

console.log('\n=== 处置复核汇总 ===');
const fails = report.filter(r => !r.pass);
console.log(`查项=${report.length} PASS=${report.length - fails.length} FAIL=${fails.length}`);
console.log(`pageerror/console.error=${errors.length}${errors.length ? '\n' + errors.join('\n') : ''}`);
fs.writeFileSync(`${OUT}/recheck-report.json`, JSON.stringify({ report, errors }, null, 2));
await browser.close();
