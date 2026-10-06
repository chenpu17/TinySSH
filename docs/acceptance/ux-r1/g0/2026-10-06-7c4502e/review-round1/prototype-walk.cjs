const { chromium } = require('/Users/chenpu/node_modules/playwright');
const fs = require('node:fs');
const base = 'file:///Users/chenpu/workspace/claude-code/TinySSH/docs/ux/ux-r1-g0/r01-prototype/index.html';
const out = '/tmp/tinyssh-g0-decision-review';
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(5000);
  const errors=[]; const results=[]; let navigation=0;
  page.on('pageerror', e => errors.push(e.message));
  const scenario=async(s,w=1280,h=800)=>{await page.setViewportSize({width:w,height:h});await page.goto(base+'?review='+ (++navigation) +'#s='+s);};
  const state=()=>page.evaluate(()=>({active:S.active,focus:S.paneFocus,right:S.splitRight,view:S.view,fileMode:S.file.mode,fileOpen:S.file.open,sessions:S.sessions.map(s=>({id:s.id,host:s.hostId,status:s.status})),toolbar:document.getElementById('tb-ident-text').textContent}));
  const snap=async name=>page.screenshot({path:out+'/'+name+'.png'});
  async function run(name,fn){try{results.push({name,...await fn()});}catch(e){results.push({name,error:e.message});}}
  try {
    await run('U1 create connection',async()=>{
      await scenario('welcome-new'); await snap('welcome-current');
      await page.click('#btn-welcome-add'); await page.fill('#hf-name','review-host');await page.fill('#hf-addr','192.0.2.10');await page.fill('#hf-user','review');
      await page.selectOption('#hf-auth',{label:'密码'});
      const passwordFields=await page.locator('input[type=password]').count();
      await snap('auth-password-current');await page.click('#hf-go');await page.waitForFunction(()=>S.sessions.some(s=>s.status==='connected'));
      const before=await page.locator('#term-a').textContent();await page.locator('#pane-a').click();await page.keyboard.type('whoami');await page.keyboard.press('Enter');
      return {passwordFields,mockConnected:true,simulatedCommandChangesScreen:before!==(await page.locator('#term-a').textContent()),state:await state()};
    });
    await run('U2 terminal search',async()=>{
      await scenario('terminal');await page.click('#btn-tsearch');await page.fill('#term-search-input','error');
      const hit=await page.locator('.term-search-count').textContent();await page.fill('#term-search-input','NO_SUCH_REVIEW_TOKEN_297');
      const miss=await page.locator('.term-search-count').textContent();await snap('search-no-match-current');
      return {hitCounter:hit,nonexistentCounter:miss,renderedMatches:await page.locator('#term-a mark').count()};
    });
    await run('U3 multi-session and focused pane target',async()=>{
      await scenario('terminal');await page.click('[data-tab="s3"]');const staging=await state();await page.click('[data-tab="s1"]');const returned=await state();
      await page.click('[data-tab="s3"]');await page.click('#btn-split');await page.click('#pane-b');const focusedRight=await state();await page.click('#btn-files');
      const fileHost=await page.locator('#file-host-chip').textContent();await page.click('#btn-upload');
      const upload=await page.evaluate(()=>S.drawer.tasks[S.drawer.tasks.length-1]);await snap('focused-pane-file-target-current');
      return {staging,returned,focusedRight,fileHost,upload};
    });
    await run('U4 files and conflict',async()=>{
      await scenario('files');await page.locator('[data-file]').nth(1).click();await page.click('#btn-download');
      const download=await page.evaluate(()=>S.drawer.tasks[S.drawer.tasks.length-1]);await page.click('#btn-upload');const upload=await page.evaluate(()=>S.drawer.tasks[S.drawer.tasks.length-1]);
      await scenario('conflict');await page.click('#cf-keep2');const conflictResult=await page.evaluate(()=>S.drawer.tasks);
      return {download,upload,conflictResult};
    });
    await run('U4 narrow return terminal',async()=>{
      await scenario('files',960,600);const before=await state();await page.click('#btn-back-terminal');const after=await state();await snap('narrow-return-current');
      return {before,after,terminalVisible:await page.locator('#term-area').isVisible(),returnButtonStillVisible:await page.locator('#btn-back-terminal').isVisible()};
    });
    await run('U5 reconnect and close',async()=>{
      await scenario('disconnected');const disconnected=await state();await page.getByRole('button',{name:'立即重连',exact:true}).click();await page.waitForFunction(()=>S.sessions.find(s=>s.id===S.active).status==='connected');
      const banner=await page.locator('#term-banner').textContent();const active=await page.evaluate(()=>S.active);await page.locator('[data-tab-x="'+active+'"]').click();const confirm=await page.locator('[role=dialog]').textContent();await page.click('#cs-confirm');
      return {disconnected,reconnectedBanner:banner,closeDialog:confirm,removed:!(await page.evaluate(()=>S.sessions.map(s=>s.id))).includes(active)};
    });
    await run('keyboard modal containment',async()=>{
      await scenario('welcome-new');await page.click('#btn-welcome-add');const focus=[];
      for(let i=0;i<18;i++){await page.keyboard.press('Tab');focus.push(await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,inDialog:!!document.activeElement.closest('[role=dialog]')})));}
      await page.keyboard.press('Escape');const after=await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName}));return {focus,focusRestoredAfterClose:after};
    });
  } finally {await browser.close();}
  const report={scope:'Headless isolated browser and local HTML only. All keyboard input used Playwright page context; no system input injection.',results,pageErrors:errors};
  fs.writeFileSync(out+'/prototype-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})();
