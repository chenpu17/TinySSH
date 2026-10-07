'use strict';
// Isolated headless browser; page input only, no desktop input or existing profiles.
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../../..');
const out = process.argv[2];
if (!out) throw new Error('usage: node prototype_probe.cjs OUTPUT_DIRECTORY');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = pathToFileURL(path.join(root, 'docs/ux/ux-r1-g0/r01-prototype/index.html')).href;
    const checks = [];
    await page.goto(base + '?probe=1#s=files');
    await page.click('#btn-back-terminal');
    assert.equal(await page.locator('#term-area').isVisible(), true);
    assert.equal(await page.evaluate(() => S.file.open), false);
    checks.push('960px: return from files restores visible terminal');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(base + '?probe=2#s=terminal');
    await page.click('[data-tab="s3"]');
    await page.click('#btn-split');
    await page.click('#pane-b');
    const target = await page.textContent('#tb-ident-text');
    await page.click('#btn-files');
    const chip = await page.textContent('#file-host-chip');
    await page.click('#btn-upload');
    const destination = await page.evaluate(() => S.drawer.tasks.at(-1).to);
    assert.ok(target.includes('deploy@10.0.0.11') && chip.includes('prod-api') && destination.includes('prod-api'), JSON.stringify({target, chip, destination}));
    checks.push('focused right pane: toolbar, files and transfer target agree');
    await page.goto(base + '?probe=3#s=terminal');
    await page.click('#btn-tsearch');
    await page.fill('#term-search-input', 'deploy');
    assert.ok(await page.locator('#term-a mark.hl').count() > 0);
    await page.fill('#term-search-input', 'NO_SUCH_TOKEN_ZZ9');
    assert.equal((await page.textContent('#term-search-count')).trim(), '0/0');
    assert.equal(await page.locator('#term-a mark.hl').count(), 0);
    checks.push('search: real matches and zero-match state');
    await page.screenshot({ path: path.join(out, 'terminal-search.png') });
    await page.goto(base + '?probe=4#s=unknown');
    const unresolved = {
      retryButtons: await page.locator('[data-task="retry"]').count(),
      discardButtons: await page.locator('[data-task="discard"]').count(),
      disposition: 'G3 prerequisite: replace with recheck/records; current behavior is not approved',
    };
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'prototype-probe.json'), JSON.stringify({ scope: 'G1-focused spot checks only; no runtime SSH acceptance', checks, unresolved, pageErrors: errors }, null, 2) + '\n');
    console.log(JSON.stringify({ checks, unresolved, pageErrors: errors }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
