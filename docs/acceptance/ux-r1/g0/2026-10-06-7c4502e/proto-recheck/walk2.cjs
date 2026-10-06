'use strict';
/* 独立对抗复验：九项修复 + 绕过探针。仅 Playwright 页面上下文输入，无系统级键鼠注入。 */
const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('node:fs');
const base = 'file:///Users/chenpu/workspace/claude-code/TinySSH/docs/ux/ux-r1-g0/r01-prototype/index.html';
const comp = 'file:///Users/chenpu/workspace/claude-code/TinySSH/docs/ux/ux-r1-g0/r01-prototype/components.html';
const out = '/tmp/rev-ux-shots';
fs.mkdirSync(out, { recursive: true });
const results = []; const errors = [];
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(9000);
  page.on('pageerror', e => errors.push(e.message));
  let nav = 0;
  const load = async (s, w = 1280, h = 800) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(base + '?rev=' + (++nav) + '#s=' + s);
  };
  const run = async (name, fn) => {
    try { results.push({ name, ...(await fn()) }); }
    catch (e) { results.push({ name, FAIL: e.message.split('\n')[0] }); }
  };

  /* F1 960x600 返回终端 */
  await run('F1-narrow-return', async () => {
    await load('files', 960, 600);
    const before = await page.evaluate(() => ({
      cls: document.getElementById('content').className,
      termVisible: document.getElementById('term-area').offsetParent !== null,
    }));
    await page.screenshot({ path: out + '/f1-before.png' });
    await page.click('#btn-back-terminal');
    const after = await page.evaluate(() => ({
      cls: document.getElementById('content').className,
      termVisible: document.getElementById('term-area').offsetParent !== null,
      fileOpen: S.file.open,
      w: Math.round(document.getElementById('term-area').getBoundingClientRect().width),
    }));
    await page.screenshot({ path: out + '/f1-after.png' });
    // 再开再返（可重复）
    await page.click('#btn-files');
    const reopen = await page.evaluate(() => document.getElementById('content').className);
    await page.click('#btn-back-terminal');
    const reback = await page.evaluate(() => document.getElementById('term-area').offsetParent !== null);
    return { before, after, reopen, reback };
  });

  /* F2 分屏聚焦右窗格：工具栏/文件chip/上传目标 三者一致 */
  await run('F2-pane-target', async () => {
    await load('terminal');
    await page.click('[data-tab="s3"]');
    await page.click('#btn-split');
    await page.click('#pane-b');
    const focused = await page.evaluate(() => ({
      active: S.active, paneFocus: S.paneFocus, splitRight: S.splitRight,
      toolbar: document.getElementById('tb-ident-text').textContent,
    }));
    await page.click('#btn-files');
    const chip = await page.textContent('#file-host-chip');
    await page.click('#btn-upload');
    const task = await page.evaluate(() => S.drawer.tasks[S.drawer.tasks.length - 1]);
    await page.screenshot({ path: out + '/f2-consistency.png' });
    // 对抗：聚焦 b 时直接关掉右会话 s1
    await page.click('[data-tab-x="s1"]');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    await page.click('#cs-confirm');
    const afterClose = await page.evaluate(() => ({
      split: S.split, paneBHidden: document.getElementById('pane-b').hidden,
      toolbar: document.getElementById('tb-ident-text').textContent,
      chip: document.getElementById('file-host-chip').textContent,
    }));
    return { focused, chip, uploadTo: task.to, afterClose };
  });

  /* F3 搜索真实计数 */
  await run('F3-search', async () => {
    await load('terminal');
    await page.click('#btn-tsearch');
    await page.fill('#term-search-input', 'deploy');
    const hit = await page.textContent('#term-search-count');
    const marksA = await page.locator('#term-a mark.hl').count();
    await page.fill('#term-search-input', 'NO_SUCH_TOKEN_ZZ9');
    const miss = await page.textContent('#term-search-count');
    const missMarks = await page.locator('#term-a mark.hl').count();
    const emptyShown = await page.evaluate(() => !document.getElementById('term-search-empty').hidden);
    await page.screenshot({ path: out + '/f3-nomatch.png' });
    const specials = {};
    for (const q of ['[', '&', '<', '(?P<lvl>', 'GET /health']) {
      await page.fill('#term-search-input', q);
      specials[q] = (await page.textContent('#term-search-count'));
    }
    // Esc 残留探针
    await page.fill('#term-search-input', 'deploy');
    await page.keyboard.press('Escape');
    const escResidue = {
      barHidden: await page.evaluate(() => document.getElementById('term-search').hidden),
      marksLeft: await page.locator('#term-a mark.hl').count(),
    };
    // 分屏聚焦右窗格：搜索应作用于 term-b
    await page.click('#btn-split');
    await page.click('#pane-b');
    await page.click('#btn-tsearch');
    await page.fill('#term-search-input', 'docker');
    const splitSearch = {
      count: await page.textContent('#term-search-count'),
      marksB: await page.locator('#term-b mark.hl').count(),
      marksA: await page.locator('#term-a mark.hl').count(),
    };
    return { hit, marksA, miss, missMarks, emptyShown, specials, escResidue, splitSearch };
  });

  /* F4 密码认证 + whoami */
  await run('F4-password-whoami', async () => {
    await load('welcome-new');
    await page.click('#btn-welcome-add');
    await page.fill('#hf-name', 'rev-host');
    await page.fill('#hf-addr', '192.0.2.77');
    await page.fill('#hf-user', 'revuser');
    await page.selectOption('#hf-auth', { label: '密码' });
    const pwVisible = await page.evaluate(() =>
      !document.getElementById('hf-secret-field').hidden &&
      document.getElementById('hf-secret').type === 'password');
    await page.screenshot({ path: out + '/f4-password-field.png' });
    await page.click('#hf-go'); // 密码为空 → 必填
    const pwErr = await page.evaluate(() => ({
      errShown: !document.getElementById('hf-secret-field').querySelector('.field-err').hidden,
      modalStays: !document.getElementById('overlay-root').hidden,
      connected: S.sessions.length,
    }));
    await page.fill('#hf-secret', 'pw-123');
    await page.click('#hf-go');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden && !!document.getElementById('ch-input'));
    const r1 = await page.evaluate(() => ({
      sub: document.querySelector('.modal-sub').textContent,
      type: document.getElementById('ch-input').type,
    }));
    await page.click('#ch-go'); // 空提交
    const r1err = await page.evaluate(() =>
      !document.getElementById('ch-input').closest('.field').querySelector('.field-err').hidden);
    await page.fill('#ch-input', 'pw-123');
    await page.click('#ch-go');
    await page.waitForFunction(() => !!document.getElementById('ch-input') && document.getElementById('ch-input').type === 'text');
    const r2 = await page.evaluate(() => document.querySelector('.modal-sub').textContent);
    await page.screenshot({ path: out + '/f4-challenge-r2.png' });
    await page.fill('#ch-input', '654321');
    await page.click('#ch-go');
    await page.waitForFunction(() => S.sessions.some(s => s.status === 'connected'));
    const conn = await page.evaluate(() => ({ n: S.sessions.length, st: S.sessions[0].status }));
    await page.click('#pane-a');
    await page.keyboard.type('whoami');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const term = await page.textContent('#term-a');
    await page.screenshot({ path: out + '/f4-whoami.png' });
    return { pwVisible, pwErr, r1, r1err, r2, conn, echo: term.includes('whoami'), userOut: /\nrevuser\n/.test(term) };
  });

  /* F5 模态 Tab 陷阱 + Esc 焦点还原 + 绕过探针 */
  await run('F5-modal-trap', async () => {
    await load('welcome-new');
    await page.click('#btn-welcome-add');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    const seq = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      seq.push(await page.evaluate(() => !!document.activeElement.closest('.modal')));
    }
    const escapedTabs = seq.filter(x => !x).length;
    await page.screenshot({ path: out + '/f5-trap.png' });
    await page.keyboard.press('Escape');
    const restoredTo = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
    await page.click('#btn-welcome-add'); // 重开
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    await page.keyboard.press('Tab');
    const reopenTrap = await page.evaluate(() => !!document.activeElement.closest('.modal'));
    // 绕过探针：点击模态正文（非聚焦元素）后再 Tab
    await page.click('.modal .modal-sub');
    const afterBodyClick = await page.evaluate(() => ({
      el: document.activeElement.id || document.activeElement.tagName,
      inDialog: !!document.activeElement.closest('.modal'),
    }));
    const bodyTabs = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      bodyTabs.push(await page.evaluate(() => ({
        el: document.activeElement.id || document.activeElement.tagName,
        inDialog: !!document.activeElement.closest('.modal'),
      })));
    }
    await page.screenshot({ path: out + '/f5-bodyclick-tab.png' });
    return { escapedTabs, restoredTo, reopenTrap, afterBodyClick, bodyTabs };
  });

  /* F6a S10 Agent 审批/首次委托 */
  await run('F6a-agent', async () => {
    await load('agent');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    const title = await page.textContent('.modal-title');
    await page.click('#ag-deny');
    const denyClosed = await page.evaluate(() => document.getElementById('overlay-root').hidden);
    await load('agent');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    await page.click('#ag-approve');
    await page.waitForFunction(() => document.querySelector('.modal-title') && document.querySelector('.modal-title').textContent.includes('首次委托'));
    await page.screenshot({ path: out + '/f6a-delegation.png' });
    await page.click('#fd-ok');
    await page.waitForFunction(() => document.getElementById('overlay-root').hidden);
    await page.waitForTimeout(200);
    const term = await page.textContent('#term-a');
    return { title, denyClosed, firstDelegationShown: true, agentEcho: term.includes('# agent'), agentOut: /\n3/.test(term) };
  });

  /* F6b S11 设置真实交互 */
  await run('F6b-settings', async () => {
    await load('terminal');
    await page.click('#btn-settings');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    await page.click('input[name="theme"][value="light"]');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.screenshot({ path: out + '/f6b-settings.png' });
    await page.click('[data-set="term"]');
    const termH3 = await page.textContent('#set-pane h3');
    await page.selectOption('#set-font', '14');
    const fontToast = (await page.textContent('#toast-root')).slice(0, 50);
    await page.click('[data-set="cred"]');
    const credRows = await page.locator('[data-cred-del]').count();
    await page.locator('[data-cred-del="0"]').click(); // 被引用 → 拒删
    const warnToast = (await page.textContent('#toast-root')).slice(0, 50);
    const rowsAfterBound = await page.locator('[data-cred-del]').count();
    await page.locator('[data-cred-del="2"]').click(); // 未绑定 → 可删
    const rowsAfterFree = await page.locator('[data-cred-del]').count();
    await page.click('[data-set="agent"]');
    const agentPane = await page.textContent('#set-pane');
    return { theme, termH3, fontToast, credRows, warnToast, rowsAfterBound, rowsAfterFree, agentPlaceholder: agentPane.includes('后续任务') };
  });

  /* F6c S09 转发完整流 */
  await run('F6c-forwards', async () => {
    await load('terminal');
    const count0 = await page.textContent('#sb-fwd-count');
    await page.click('#sb-forwards');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    const list1 = await page.evaluate(() => S.forwards.map(f => f.status).join(','));
    await page.click('[data-fstop="f1"]');
    const stopping = await page.evaluate(() => S.forwards[0].status);
    await page.waitForTimeout(950);
    const stopped = await page.evaluate(() => S.forwards[0].status);
    await page.screenshot({ path: out + '/f6c-list.png' });
    await page.click('#fwd-new');
    await page.waitForFunction(() => !!document.getElementById('fw-listen'));
    await page.click('#fw-go'); // 空 → 校验
    const errShown = await page.evaluate(() =>
      !document.getElementById('fw-listen').closest('.field').querySelector('.field-err').hidden);
    await page.fill('#fw-listen', '127.0.0.1:6379');
    await page.fill('#fw-dest', '10.0.0.31:6379');
    await page.click('#fw-go');
    await page.waitForFunction(() => document.getElementById('overlay-root').hidden);
    const creating = await page.evaluate(() => S.forwards.map(f => f.status).join(','));
    const countCreating = await page.textContent('#sb-fwd-count');
    await page.waitForTimeout(1100);
    const after = await page.evaluate(() => S.forwards.map(f => f.status).join(','));
    const countAfter = await page.textContent('#sb-fwd-count');
    return { count0, list1, stopping, stopped, errShown, creating, countCreating, after, countAfter };
  });

  /* F6d 传输 Committing（running→提交中→完成） */
  await run('F6d-committing', async () => {
    await load('files');
    await page.click('#btn-upload');
    const id = await page.evaluate(() => S.drawer.tasks[S.drawer.tasks.length - 1].id);
    const seq = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 6500) {
      const s = await page.evaluate((tid) => {
        const t = S.drawer.tasks.find(x => x.id === tid); return t ? t.status : 'gone';
      }, id);
      if (seq[seq.length - 1] !== s) { seq.push(s); if (s === 'done') break; }
      await page.waitForTimeout(150);
    }
    const committingText = await page.evaluate(() => document.getElementById('drawer-list').textContent.includes('提交中'));
    return { seq, committingTextSeenNow: committingText };
  });

  /* F6e 传输 OutcomeUnknown（重试/丢弃） */
  await run('F6e-unknown', async () => {
    await load('unknown');
    const txt = await page.textContent('#drawer-list');
    const hasWarn = txt.includes('结果未知');
    const nRetry = await page.locator('[data-task="retry"]').count();
    const nDiscard = await page.locator('[data-task="discard"]').count();
    await page.screenshot({ path: out + '/f6e-unknown.png' });
    await page.click('[data-task="discard"]');
    const discarded = await page.evaluate(() => S.drawer.tasks.find(t => t.id === 'tu').status);
    await load('unknown');
    await page.click('[data-task="retry"]');
    const retryStart = await page.evaluate(() => S.drawer.tasks.find(t => t.id === 'tu').status);
    await page.waitForTimeout(5500);
    const retryFinal = await page.evaluate(() => S.drawer.tasks.find(t => t.id === 'tu').status);
    return { hasWarn, nRetry, nDiscard, discarded, retryStart, retryFinal };
  });

  /* F7 components.html 两处文案 */
  await run('F7-components-copy', async () => {
    await page.goto(comp + '?rev=' + (++nav));
    const body = await page.textContent('body');
    return {
      deleteHostOk: body.includes('不受影响——删除仅移除配置；已打开的标签保留连接'),
      noDisconnectClaim: !body.includes('断开活动会话') && !body.includes('断开其活动会话'),
      noResumeHint: !body.includes('已保留断点'),
      resumeDisclaimer: body.includes('本版本不支持续传'),
    };
  });

  /* 对抗：窄窗+分屏组合 */
  await run('P-narrow-split', async () => {
    await load('files', 960, 600);
    await page.click('#btn-split');
    const mode1 = await page.evaluate(() => document.getElementById('content').className);
    await page.click('#btn-back-terminal');
    const after = await page.evaluate(() => ({
      cls: document.getElementById('content').className,
      split: S.split,
      termVisible: document.getElementById('term-area').offsetParent !== null,
      paneBHidden: document.getElementById('pane-b').hidden,
    }));
    await page.screenshot({ path: out + '/p-narrow-split.png' });
    return { mode1, after };
  });

  /* U5 重连/关闭 sanity */
  await run('U5-reconnect-close', async () => {
    await load('disconnected');
    await page.getByRole('button', { name: '立即重连', exact: true }).click();
    await page.waitForFunction(() => S.sessions.find(s => s.id === S.active).status === 'connected');
    const banner = await page.textContent('#term-banner');
    const active = await page.evaluate(() => S.active);
    await page.click('[data-tab-x="' + active + '"]');
    await page.waitForFunction(() => !document.getElementById('overlay-root').hidden);
    const dlg = await page.textContent('.modal');
    await page.click('#cs-confirm');
    const gone = await page.evaluate((a) => !S.sessions.map(s => s.id).includes(a), active);
    return { boundaryBanner: banner.includes('新连接边界'), dlgListsImpact: dlg.includes('传输') || dlg.includes('转发'), gone };
  });

  await browser.close();
  const report = {
    scope: 'Headless isolated Chrome, local HTML only. All input via Playwright page context; no system-level injection. Each scenario freshly reloaded.',
    results, pageErrors: errors,
  };
  fs.writeFileSync(out + '/results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
