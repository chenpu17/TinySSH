'use strict';
/* TinySSH · UX-R1 R01 可交互原型：纯前端模拟，不连接任何服务器。 */

/* ---------- 图标 ---------- */

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.6 16.6 21 21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'chevron-left': '<path d="m15 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v4h4"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3.5v5h-5"/>',
  split: '<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
  ellipsis: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.2v.3"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 9.5 3 3-3 3M12.5 15.5H17"/>',
  play: '<path d="M8.5 5.5 18 12l-9.5 6.5z" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
};

function icon(name) {
  const body = ICONS[name] || ICONS.x;
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}
function hydrate(root) {
  root.querySelectorAll('.i[data-icon]').forEach(function (s) {
    s.innerHTML = icon(s.dataset.icon);
    s.removeAttribute('data-icon');
  });
}

/* ---------- 工具 ---------- */

const $ = (id) => document.getElementById(id);
let _uid = 0;
const uid = () => 'x' + (++_uid);
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let TIMERS = [];
function after(ms, fn) { const t = setTimeout(fn, ms); TIMERS.push(t); return t; }
function clearTimers() { TIMERS.forEach(clearTimeout); TIMERS = []; }

/* ---------- 模拟数据 ---------- */

const HOSTS_DEF = [
  { id: 'h1', name: 'prod-api', user: 'deploy', addr: '10.0.0.11', tags: ['生产'], fav: true },
  { id: 'h2', name: 'staging', user: 'deploy', addr: '10.0.0.21', tags: ['开发'], fav: true },
  { id: 'h3', name: 'db-readonly', user: 'reader', addr: '10.0.0.31', tags: ['生产'], fav: true },
  { id: 'h4', name: 'build-runner', user: 'ci', addr: '10.0.0.41', tags: ['开发'] },
  { id: 'h5', name: 'personal-vps', user: 'chen', addr: '203.0.113.8', tags: ['个人'] },
  { id: 'h6', name: '生产环境日志排查中心', user: 'ops', addr: '10.0.0.51', tags: ['生产', '运维'] },
  { id: 'h7', name: '数据库备份与归档', user: 'ops', addr: '10.0.0.52', tags: ['运维'] },
];

const RECENT = [
  { host: 'h1', t: '2 小时前连接' },
  { host: 'h2', t: '昨天 18:40 连接' },
  { host: 'h4', t: '昨天 09:12 连接' },
  { host: 'h7', t: '3 天前连接' },
  { host: 'h5', t: '上周四连接' },
];

const SESSIONS_DEF = [
  { id: 's1', hostId: 'h1', status: 'connected', screen: 'prod' },
  { id: 's2', hostId: 'h1', status: 'connected', screen: 'prod2' },
  { id: 's3', hostId: 'h2', status: 'connected', screen: 'staging' },
  { id: 's4', hostId: 'h6', status: 'connected', screen: 'vim' },
  { id: 's5', hostId: 'h3', status: 'connected', screen: 'mysql' },
  { id: 's6', hostId: 'h4', status: 'connecting', screen: 'connecting' },
  { id: 's7', hostId: 'h5', status: 'disconnected', screen: 'vps' },
  { id: 's8', hostId: 'h7', status: 'connected', screen: 'rsync' },
];

const FS = {
  '/srv/app': {
    dirs: [['backups', '09/30'], ['logs', '10/06'], ['shared', '09/12']],
    files: [['app.toml', '4 KB', '10/04'], ['deploy.sh', '2 KB', '10/02'], ['readme.md', '3 KB', '09/28'], ['release.tar.gz', '86 MB', '10/06']],
  },
  '/srv/app/logs': {
    dirs: [['archive', '10/05']],
    files: [['access.log', '70 MB', '10/06'], ['access.log.1', '8 MB', '10/05'], ['error.log', '2 MB', '10/06'], ['startup.log', '128 KB', '10/05']],
  },
};

const TASKS_DEF = [
  { id: 't1', dir: 'down', name: 'access.log', from: 'prod-api:/srv/app/logs/access.log', to: '本机 Downloads/access.log', status: 'running', done: '42 / 70 MB', pct: 60 },
  { id: 't2', dir: 'up', name: 'config.tar.gz', from: '本机 ~/Downloads/config.tar.gz', to: 'prod-api:/srv/app/config.tar.gz', status: 'conflict', done: '', pct: 0 },
  { id: 't3', dir: 'up', name: 'release.tar.gz', from: '本机 Downloads/release.tar.gz', to: 'prod-api:/srv/app/release.tar.gz', status: 'done', done: '86 MB', pct: 100 },
];

const FORWARDS_DEF = [
  { id: 'f1', type: '本地（-L）', listen: '127.0.0.1:5432', dest: '10.0.0.31:5432', status: 'Listening' },
];

/* ---------- 终端画面（模拟） ---------- */

function pr(u, h, p) {
  return '<span class="t-user">' + u + '@' + h + '</span><span class="t-dim">:</span><span class="t-path">' + p + '</span><span class="t-dim">$</span> ';
}
const CURSOR = '<span class="cursor"></span>';

const SCREENS = {
  prod:
    '<span class="t-dim">Last login: Tue Oct 6 10:24:00 2026 from 192.168.1.23</span>\n' +
    pr('deploy', 'prod-api', '~/app') + 'git status --short\n' +
    '<span class="t-warn"> M config/app.toml</span>\n' +
    pr('deploy', 'prod-api', '~/app') + 'systemctl status api --no-pager\n' +
    '<span class="t-ok">● api.service — Application API</span>\n' +
    '<span class="t-dim">   Loaded: loaded (/etc/systemd/system/api.service; enabled)</span>\n' +
    '<span class="t-ok">   Active: active (running) since Mon 2026-10-05 22:10:44 CST</span>\n' +
    '<span class="t-dim"> Main PID: 1842 (api-server)</span>\n' +
    '<span class="t-dim">    Tasks: 18 (limit: 4915)</span>\n' +
    pr('deploy', 'prod-api', '~/app') + 'tail -n 3 logs/access.log\n' +
    '<span class="t-dim">10:24:01  GET /health     200   2ms</span>\n' +
    '<span class="t-dim">10:24:04  GET /api/items  200  12ms</span>\n' +
    '<span class="t-dim">10:24:08  GET /health     200   1ms</span>\n' +
    pr('deploy', 'prod-api', '~/app') + CURSOR,
  prod2:
    '<span class="t-dim">Last login: Tue Oct 6 11:02:33 2026 from 192.168.1.23</span>\n' +
    pr('deploy', 'prod-api', '~') + 'docker compose ps\n' +
    '<span class="t-dim">NAME                STATUS                 PORTS</span>\n' +
    '<span class="t-dim">api                 Up 26 hours            0.0.0.0:8080-&gt;8080/tcp</span>\n' +
    '<span class="t-dim">worker              Up 26 hours</span>\n' +
    '<span class="t-dim">postgres            Up 26 hours (healthy)  5432/tcp</span>\n' +
    pr('deploy', 'prod-api', '~') + CURSOR,
  staging:
    pr('deploy', 'staging', '~/app') + 'git pull origin main\n' +
    '<span class="t-dim">remote: Enumerating objects: 12, done.</span>\n' +
    '<span class="t-dim">Unpacking objects: 100% (12/12), 4.2 KiB | 4.2 MiB/s, done.</span>\n' +
    '<span class="t-ok">Fast-forward</span>\n' +
    '<span class="t-dim"> release.toml | 2 +-</span>\n' +
    '<span class="t-dim"> 1 file changed, 1 insertion(+), 1 deletion(-)</span>\n' +
    pr('deploy', 'staging', '~/app') + 'docker compose up -d --build\n' +
    '<span class="t-dim">[+] Building 12.4s (14/14) FINISHED</span>\n' +
    '<span class="t-ok"> Container staging-api-1  Started  2.1s</span>\n' +
    pr('deploy', 'staging', '~/app') + CURSOR,
  vim:
    '<span class="t-dim">  1  #!/usr/bin/env python3</span>\n' +
    '<span class="t-dim">  2  """按小时聚合错误日志。"""</span>\n' +
    '<span class="t-dim">  3  import re</span>\n' +
    '<span class="t-dim">  4  from collections import Counter</span>\n' +
    '<span class="t-dim">  5</span>\n' +
    '<span class="t-dim">  6  </span><span class="t-cyan">PATTERN</span><span class="t-dim"> = re.compile(</span><span class="t-warn">r"\\[(?P&lt;lvl&gt;ERROR|WARN)\\] (?P&lt;msg&gt;.+)"</span><span class="t-dim">)</span>\n' +
    '<span class="t-dim">  7</span>\n' +
    '<span class="t-dim">  8  </span><span class="t-cyan">def</span><span class="t-dim"> hourly(path):</span>\n' +
    '<span class="t-dim">  9      counts = Counter()</span>\n' +
    '<span class="t-dim"> 10      </span><span class="t-cyan">with</span><span class="t-dim"> open(path) </span><span class="t-cyan">as</span><span class="t-dim"> fh:</span>\n' +
    '<span class="t-dim"> 11          </span><span class="t-cyan">for</span><span class="t-dim"> line </span><span class="t-cyan">in</span><span class="t-dim"> fh:</span>\n' +
    '<span class="t-dim"> 12              m = PATTERN.search(line)</span>\n' +
    '<span class="t-dim"> 13              </span><span class="t-cyan">if</span><span class="t-dim"> m:</span>\n' +
    '<span class="t-dim"> 14                  counts[line[:13]] += 1</span>\n' +
    '<span class="t-dim"> 15      </span><span class="t-cyan">return</span><span class="t-dim"> counts</span>\n' +
    '<span class="t-dim">~</span>\n' +
    '<span class="t-dim">~</span>\n' +
    '<span class="t-vimstatus">-- INSERT --            analyze_log.py            py   15:9</span>',
  mysql:
    pr('reader', 'db-readonly', '~') + 'mysql -h 127.0.0.1 -u reader orders -e "SELECT id, status, total FROM orders ORDER BY id DESC LIMIT 5;"\n' +
    '<span class="t-dim">+----+----------+---------+</span>\n' +
    '<span class="t-dim">| id | status   | total   |</span>\n' +
    '<span class="t-dim">+----+----------+---------+</span>\n' +
    '<span class="t-dim">| 98 | paid     | 1280.00 |</span>\n' +
    '<span class="t-dim">| 97 | pending  |  460.00 |</span>\n' +
    '<span class="t-dim">| 96 | paid     |   89.50 |</span>\n' +
    '<span class="t-dim">| 95 | refunded |  220.00 |</span>\n' +
    '<span class="t-dim">| 94 | paid     | 3120.00 |</span>\n' +
    '<span class="t-dim">+----+----------+---------+</span>\n' +
    pr('reader', 'db-readonly', '~') + CURSOR,
  vps:
    pr('chen', 'personal-vps', '~') + 'sudo journalctl -u nginx --since "10:00" -n 4\n' +
    '<span class="t-dim">Oct 06 10:41:02 vps nginx[881]: configuration file /etc/nginx/nginx.conf test failed</span>\n' +
    '<span class="t-warn">Oct 06 10:52:31 vps nginx[881]: [emerg] unexpected end of file in /etc/nginx/conf.d/app.conf:42</span>\n' +
    '<span class="t-dim">Oct 06 11:03:17 vps systemd[1]: nginx.service: Deactivated successfully</span>\n' +
    '<span class="t-dim">Oct 06 11:03:17 vps systemd[1]: Stopped A high performance web server.</span>\n' +
    pr('chen', 'personal-vps', '~') + CURSOR,
  rsync:
    pr('ops', '数据库备份与归档', '~') + 'rsync -av --progress /srv/data/ backup:/pool/daily/\n' +
    '<span class="t-dim">sending incremental file list</span>\n' +
    '<span class="t-dim">data/orders-20261005.tar.zst</span>\n' +
    '<span class="t-ok">    1,204,352  12%  41.20MB/s    0:02:51</span>\n' +
    '<span class="t-dim">data/orders-20261006.tar.zst</span>\n' +
    '<span class="t-ok">      986,432   9%  40.95MB/s    0:03:12</span>\n' +
    '<span class="t-dim">sent 2.19M bytes  received 123 bytes  180.4K bytes/sec</span>\n' +
    pr('ops', '数据库备份与归档', '~') + CURSOR,
  local:
    '<span class="t-dim">Last login: Mon Oct 6 14:20:05 on ttys005</span>\n' +
    '<span class="t-user">chen@Mac</span><span class="t-dim"> ~ %</span> ' + CURSOR,
  connecting:
    '<span class="t-dim">（模拟）正在建立连接…… 等待期间可以取消，不会阻塞其他主机。</span>\n',
};

function screenFresh(h) {
  return '<span class="t-dim">Last login: Tue Oct 6 ' + new Date().toTimeString().slice(0, 5) + ' from 192.168.1.23（模拟）</span>\n' +
    '<span class="t-dim">Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-84-generic x86_64)</span>\n\n' +
    pr(esc(h.user), esc(h.name), '~') + CURSOR;
}

/* ---------- 状态 ---------- */

const SCENARIOS = [
  { group: '主视图', items: [
    { key: 'welcome-new', label: 'S01 欢迎 · 新装（无主机）' },
    { key: 'welcome-recent', label: 'S01 欢迎 · 已有主机（最近连接）' },
    { key: 'terminal', label: 'S05 终端工作区 · 正常' },
    { key: 'files', label: 'S07 终端 + 文件并排 · 传输队列展开' },
  ] },
  { group: '异常与关键状态', items: [
    { key: 'conn-fail', label: '连接失败 · 错误条（对象 / 原因 / 下一步）' },
    { key: 'disconnected', label: '断线 · 重连横幅（可演示重连成功）' },
    { key: 'fingerprint', label: '指纹变化 · 确认模态（旧值 / 新值对照）' },
    { key: 'conflict', label: '传输同名冲突 · 对话框（跳过 / 替换 / 保留两份）' },
    { key: 'unknown', label: '传输 · 提交结果未知 · 恢复决策（重试 / 丢弃）' },
    { key: 'agent', label: 'S10 协作 · Agent 首次委托与审批' },
    { key: 'narrow', label: '窄窗 960 · 文件面板转完整视图' },
  ] },
];

const S = {
  scenario: 'files', theme: 'dark', view: 'welcome-new',
  sidebarOpen: true, sidebarW: 224,
  hosts: [], sessions: [], active: null, selectedHost: null,
  searchQ: '', tagFilter: new Set(),
  split: false, splitRight: null, paneFocus: 'a',
  file: null, drawer: null, forwards: [],
  narrowForced: false,
};

function hostOf(s) { return S.hosts.find((h) => h.id === s.hostId) || { name: '未知主机', user: '', addr: '' }; }
function activeSession() { return S.sessions.find((s) => s.id === S.active) || null; }
function focusedSession() {
  if (S.split && S.paneFocus === 'b') {
    const s2 = S.sessions.find((x) => x.id === S.splitRight);
    if (s2) return s2;
  }
  return activeSession();
}
function targetHostLabel() {
  const s = focusedSession();
  if (!s) return '';
  if (s.kind === 'local') return '本机';
  return hostOf(s).name;
}
function titleOf(s) {
  if (s.kind === 'local') return '本地终端';
  const same = S.sessions.filter((x) => x.hostId === s.hostId);
  const idx = same.indexOf(s);
  const h = hostOf(s);
  return idx > 0 ? h.name + ' ' + (idx + 1) : h.name;
}
function syncHostStatus() {
  S.hosts.forEach((h) => {
    const ss = S.sessions.filter((x) => x.hostId === h.id);
    h.status = ss.some((x) => x.status === 'connecting') ? 'connecting'
      : ss.some((x) => x.status === 'connected') ? 'connected' : 'idle';
  });
}

/* ---------- 场景 ---------- */

function labelOf(key) {
  for (const g of SCENARIOS) { const it = g.items.find((i) => i.key === key); if (it) return it.label; }
  return key;
}

function applyScenario(key, silent) {
  clearTimers(); closeMenus(); closeModal();
  S.scenario = key;
  S.narrowForced = key === 'narrow';
  S.hosts = JSON.parse(JSON.stringify(HOSTS_DEF));
  S.sessions = []; S.active = null; S.selectedHost = null; S.searchQ = ''; S.tagFilter = new Set();
  S.split = false; S.splitRight = null; S.paneFocus = 'a';
  S.file = { open: false, mode: 'side', forceFull: false, path: '/srv/app/logs', sel: new Set(['access.log']), hist: [], hi: -1 };
  S.drawer = { open: false, tasks: JSON.parse(JSON.stringify(TASKS_DEF)) };
  S.forwards = JSON.parse(JSON.stringify(FORWARDS_DEF));

  const initSessions = () => { S.sessions = JSON.parse(JSON.stringify(SESSIONS_DEF)); };

  switch (key) {
    case 'welcome-new': S.view = 'welcome-new'; break;
    case 'welcome-recent': S.view = 'welcome-recent'; break;
    case 'terminal': initSessions(); S.active = 's1'; S.view = 'session'; break;
    case 'files':
      initSessions(); S.active = 's1'; S.view = 'session';
      S.file.open = true; S.drawer.open = true; break;
    case 'conn-fail':
      S.hosts.push({ id: 'h9', name: 'old-db', user: 'ops', addr: '10.0.9.9', tags: ['运维'], failNext: true });
      initSessions(); S.sessions.push({ id: 'sf', hostId: 'h9', status: 'failed', screen: 'failed' });
      S.active = 'sf'; S.view = 'session'; break;
    case 'disconnected': initSessions(); S.active = 's7'; S.view = 'session'; break;
    case 'fingerprint':
      S.hosts.push({ id: 'h10', name: 'new-app-01', user: 'ops', addr: '10.0.9.7', tags: ['生产'], fpChange: true });
      initSessions(); S.active = 's1'; S.view = 'session';
      after(120, () => openFingerprint(null)); break;
    case 'conflict':
      initSessions(); S.active = 's1'; S.view = 'session';
      S.file.open = true; S.drawer.open = true;
      after(120, () => openConflict(S.drawer.tasks.find((t) => t.id === 't2'))); break;
    case 'unknown': {
      initSessions(); S.active = 's1'; S.view = 'session';
      S.drawer.open = true;
      const unknownTask = {
        id: 'tu', dir: 'down', name: 'events-20261006.jsonl',
        from: 'prod-api:/srv/app/logs/events-20261006.jsonl',
        to: '本机 Downloads/events-20261006.jsonl', status: 'unknown', done: '', pct: 0,
      };
      S.drawer.tasks = [unknownTask, S.drawer.tasks.find((t) => t.id === 't3')].filter(Boolean);
      break;
    }
    case 'agent':
      initSessions(); S.active = 's1'; S.view = 'session';
      after(300, () => openAgentApproval()); break;
    case 'narrow':
      initSessions(); S.active = 's1'; S.view = 'session';
      S.file.open = true; S.drawer.open = true; break;
  }

  if (S.sessions.some((s) => s.id === 's6' && s.status === 'connecting')) {
    after(2600, () => {
      const s6 = S.sessions.find((s) => s.id === 's6');
      if (s6 && s6.status === 'connecting') {
        s6.status = 'connected'; s6.screen = 'fresh';
        syncHostStatus(); renderAll();
      }
    });
  }
  syncHostStatus(); renderAll();
  if (!silent) toast('场景：' + labelOf(key));
}

/* ---------- 菜单 / 模态 / Toast ---------- */

let menuCloser = null;
function closeMenus() {
  $('menu-root').innerHTML = '';
  if (menuCloser) { document.removeEventListener('mousedown', menuCloser); menuCloser = null; }
}
function openMenu(anchor, items) {
  closeMenus();
  const root = $('menu-root');
  const m = el('<div class="menu" role="menu"></div>');
  items.forEach((it) => {
    if (it === 'sep') { m.append(el('<div class="menu-sep"></div>')); return; }
    if (it.group) { m.append(el('<div class="menu-group">' + esc(it.group) + '</div>')); return; }
    const b = el('<button class="menu-item' + (it.danger ? ' danger' : '') + '" role="menuitem"' + (it.disabled ? ' disabled' : '') + ' title="' + esc(it.tip || '') + '"></button>');
    b.innerHTML =
      (it.icon ? '<span class="i" data-icon="' + it.icon + '"></span>' : '') +
      '<span>' + esc(it.label) + '</span>' +
      (it.kbd ? '<kbd>' + esc(it.kbd) + '</kbd>' : '') +
      (it.checked ? '<span class="mi-check i" data-icon="check"></span>' : '');
    if (!it.disabled) b.addEventListener('click', () => { closeMenus(); if (it.act) it.act(); });
    m.append(b);
  });
  root.append(m); hydrate(m);
  const r = anchor.getBoundingClientRect();
  let x = r.right - m.offsetWidth, y = r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  menuCloser = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) closeMenus(); };
  setTimeout(() => document.addEventListener('mousedown', menuCloser), 0);
}

let modalReturnFocus = null;
function modalFocusables(m) {
  return [...m.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((x) => !x.disabled && x.offsetParent !== null);
}
function modalTabTrap(e) {
  if (e.key !== 'Tab') return;
  const m = $('overlay-root').querySelector('.modal');
  if (!m) return;
  const f = modalFocusables(m);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { first.focus(); e.preventDefault(); }
}
function openModal(html, opts) {
  opts = opts || {};
  const root = $('overlay-root');
  modalReturnFocus = document.activeElement;
  root.hidden = false;
  root.innerHTML = '<div class="modal" role="dialog" aria-modal="true"' + (opts.width ? ' style="width:' + opts.width + 'px"' : '') + '>' + html + '</div>';
  hydrate(root);
  const m = root.querySelector('.modal');
  m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal()));
  if (!opts.lock) root.addEventListener('mousedown', overlayBackdrop);
  root.addEventListener('keydown', modalTabTrap);
  const f = m.querySelector('input, select, .btn-primary');
  if (f) f.focus();
  return m;
}
function overlayBackdrop(e) { if (e.target === $('overlay-root')) closeModal(); }
function closeModal() {
  const r = $('overlay-root');
  r.removeEventListener('keydown', modalTabTrap);
  r.hidden = true; r.innerHTML = '';
  r.removeEventListener('mousedown', overlayBackdrop);
  if (modalReturnFocus && document.contains(modalReturnFocus)) {
    try { modalReturnFocus.focus(); } catch (_) { /* 元素已不可聚焦 */ }
  }
  modalReturnFocus = null;
}

function toast(msg, type) {
  const root = $('toast-root');
  while (root.children.length >= 2) root.firstChild.remove();
  const t = el('<div class="toast' + (type === 'warn' ? ' warn' : '') + '"></div>');
  t.innerHTML = '<span class="i" data-icon="' + (type === 'warn' ? 'alert' : 'check') + '"></span><span>' + msg + '</span>';
  root.append(t); hydrate(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 3000);
}

/* ---------- 终端内搜索（真实匹配） ---------- */

let SEARCH = { marks: [], idx: 0 };

function searchPane() {
  return (S.split && S.paneFocus === 'b') ? $('term-b') : $('term-a');
}
function clearSearchMarks() {
  SEARCH.marks.forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  });
  SEARCH = { marks: [], idx: 0 };
}
function setSearchCount(i, n, empty) {
  $('term-search-count').textContent = n ? (i + 1) + '/' + n : '0/0';
  $('term-search-empty').hidden = !empty;
}
function runSearch() {
  clearSearchMarks();
  const q = $('term-search-input').value;
  const pane = searchPane();
  if (!q || !pane) { setSearchCount(0, 0, false); return; }
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  const ql = q.toLowerCase();
  const ranges = [];
  nodes.forEach((node) => {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let i = 0;
    while (ql && lower.indexOf(ql, i) >= 0) {
      const pos = lower.indexOf(ql, i);
      const r = document.createRange();
      r.setStart(node, pos);
      r.setEnd(node, pos + q.length);
      ranges.push(r);
      i = pos + q.length;
    }
  });
  // 倒序应用，避免节点切割后使前面的 range 失效
  for (let k = ranges.length - 1; k >= 0; k--) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'hl';
      ranges[k].surroundContents(mark);
      SEARCH.marks.unshift(mark);
    } catch (_) { /* 跨节点匹配跳过 */ }
  }
  const n = SEARCH.marks.length;
  if (n) {
    SEARCH.idx = 0;
    SEARCH.marks[0].classList.add('cur');
    SEARCH.marks[0].scrollIntoView({ block: 'nearest' });
    setSearchCount(0, n, false);
  } else {
    setSearchCount(0, 0, true);
  }
}
function searchStep(dir) {
  const n = SEARCH.marks.length;
  if (!n) return;
  SEARCH.marks[SEARCH.idx].classList.remove('cur');
  SEARCH.idx = (SEARCH.idx + dir + n) % n;
  const m = SEARCH.marks[SEARCH.idx];
  m.classList.add('cur');
  m.scrollIntoView({ block: 'nearest' });
  setSearchCount(SEARCH.idx, n, false);
}

/* ---------- 渲染 ---------- */

function renderAll() {
  renderChrome(); renderView(); renderSidebar(); renderTabs(); renderToolbar();
  renderTerminal(); renderFilePanel(); renderDrawer(); renderStatusbar(); updateFileMode(); fitDrawer();
}

function renderChrome() {
  document.documentElement.dataset.theme = S.theme;
  const tb = $('btn-theme');
  tb.querySelector('.i').innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon');
  tb.title = S.theme === 'dark' ? '切换到浅色主题（终端配色独立）' : '切换到深色主题（终端配色独立）';
  $('app').classList.toggle('no-sidebar', !S.sidebarOpen);
  $('sidebar').style.width = S.sidebarW + 'px';
  $('btn-sidebar-expand').hidden = S.sidebarOpen;
  $('btn-sidebar-collapse').setAttribute('aria-label', S.sidebarOpen ? '收起主机栏' : '展开主机栏');
}

function renderView() {
  const w = $('view-welcome'), sv = $('view-session');
  const isWelcome = S.view.startsWith('welcome');
  w.hidden = !isWelcome; sv.hidden = isWelcome;
  if (!isWelcome) return;
  const recent = S.view === 'welcome-recent';
  $('welcome-title').textContent = recent ? '继续上次的工作。' : '连接服务器，开始工作。';
  $('welcome-sub').textContent = recent ? '从最近的连接开始，或添加新的主机。' : '保存常用主机，在清晰的终端里完成开发、部署和排障。';
  $('welcome-card').hidden = recent;
  $('welcome-note2').hidden = recent;
  $('recent-block').hidden = !recent;
  if (recent) {
    $('recent-grid').innerHTML = RECENT.map((r) => {
      const h = S.hosts.find((x) => x.id === r.host);
      if (!h) return '';
      const st = h.status === 'connected' ? 'dot-ok' : 'dot-off';
      return '<button class="recent-card" data-recent="' + h.id + '">' +
        '<span class="rc-top"><span class="rc-name">' + esc(h.name) + '</span><i class="dot ' + st + '"></i></span>' +
        '<span class="rc-addr mono">' + esc(h.user) + '@' + esc(h.addr) + '</span>' +
        '<span class="rc-time">' + r.t + '</span>' +
        '<span class="rc-go">连接</span></button>';
    }).join('');
  }
}

function hostRowHtml(h) {
  const dot = h.status === 'connected' ? 'dot-ok' : h.status === 'connecting' ? 'dot-warn' : 'dot-off';
  const sel = S.selectedHost === h.id ? ' selected' : '';
  const acts = h.status === 'connecting'
    ? '<button class="text-btn" data-act="cancel-connect" data-id="' + h.id + '">取消</button>' +
      '<button class="host-more" data-act="host-menu" data-id="' + h.id + '" aria-label="更多操作"><span class="i" data-icon="ellipsis"></span></button>'
    : '<button class="host-connect" data-act="connect" data-id="' + h.id + '" title="连接 ' + esc(h.name) + '" aria-label="连接 ' + esc(h.name) + '"><span class="i" data-icon="play"></span></button>' +
      '<button class="host-more" data-act="host-menu" data-id="' + h.id + '" aria-label="更多操作"><span class="i" data-icon="ellipsis"></span></button>';
  return '<div class="host-row' + sel + (h.status === 'connecting' ? ' connecting' : '') + '" data-host="' + h.id + '" tabindex="0" role="button" aria-label="' + esc(h.name) + ' ' + esc(h.user) + '@' + esc(h.addr) + '">' +
    '<i class="dot ' + dot + '"></i>' +
    '<div class="host-meta"><span class="host-name">' + esc(h.name) + '</span><span class="host-addr mono">' + esc(h.user) + '@' + esc(h.addr) + '</span></div>' +
    '<div class="host-acts">' + acts + '</div></div>';
}

function renderSidebar() {
  const q = S.searchQ.trim().toLowerCase();
  const match = (h) => !q || [h.name, h.addr, h.user].concat(h.tags).join(' ').toLowerCase().includes(q);
  const inTags = (h) => !S.tagFilter.size || h.tags.some((t) => S.tagFilter.has(t));
  const hosts = S.hosts.filter((h) => match(h) && inTags(h));
  const favs = hosts.filter((h) => h.fav), others = hosts.filter((h) => !h.fav);

  let html = '';
  if (!S.hosts.length) {
    html = '<div class="side-empty"><b>尚未添加连接</b>添加或导入后显示在这里。</div>';
    $('host-groups').innerHTML = html;
    $('tag-chips').innerHTML = '';
    $('tag-label').hidden = true;
    return;
  }
  $('tag-label').hidden = false;
  if (favs.length) {
    html += '<div class="side-label">收藏</div>' + favs.map(hostRowHtml).join('');
    html += '<div class="side-label">其他主机</div>' + others.map(hostRowHtml).join('');
  } else {
    html += '<div class="side-label">全部主机</div>' + hosts.map(hostRowHtml).join('');
  }
  if (q && !hosts.length) {
    html += '<div class="side-empty"><b>没有匹配「' + esc(S.searchQ) + '」的主机</b>保留查询；可添加为新主机。<div style="margin-top:8px"><button class="btn btn-secondary btn-sm" data-act="add-host">添加连接</button></div></div>';
  }
  $('host-groups').innerHTML = html;

  const counts = {};
  S.hosts.forEach((h) => h.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  $('tag-chips').innerHTML = Object.keys(counts).map((t) =>
    '<button class="tag-chip' + (S.tagFilter.has(t) ? ' on' : '') + '" data-tag="' + esc(t) + '" aria-pressed="' + S.tagFilter.has(t) + '">' + esc(t) + ' ' + counts[t] + '</button>'
  ).join('');
  hydrate($('host-groups'));
}

function renderTabs() {
  const strip = $('tabstrip');
  strip.innerHTML = S.sessions.map((s) => {
    const dot = s.status === 'connected' ? 'dot-ok' : s.status === 'connecting' ? 'dot-warn' : s.status === 'failed' ? 'dot-err' : 'dot-off';
    const label = s.status === 'connected' ? '已连接' : s.status === 'connecting' ? '正在连接' : s.status === 'failed' ? '连接失败' : '已断开';
    return '<div class="tab' + (s.id === S.active ? ' active' : '') + '" data-tab="' + s.id + '" role="tab" tabindex="0" aria-selected="' + (s.id === S.active) + '" title="' + esc(titleOf(s)) + ' · ' + label + '">' +
      '<i class="dot ' + dot + '"></i><span class="tab-title">' + esc(titleOf(s)) + '</span>' +
      '<button class="tab-x" data-tab-x="' + s.id + '" aria-label="关闭会话 ' + esc(titleOf(s)) + '" title="关闭会话"><span class="i i-xs" data-icon="x"></span></button></div>';
  }).join('');
  hydrate(strip);
  const act = strip.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderToolbar() {
  const s = focusedSession();
  const stText = { connected: '已连接', connecting: '正在连接', disconnected: '已断开', failed: '连接失败' };
  if (!s) return;
  if (s.kind === 'local') {
    $('tb-ident-text').textContent = '本地 · zsh';
  } else {
    const h = hostOf(s);
    $('tb-ident-text').textContent = h.user + '@' + h.addr;
  }
  $('tb-status-text').textContent = stText[s.status] || '';
  $('tb-dot').className = 'dot ' + (s.status === 'connected' ? 'dot-ok' : s.status === 'connecting' ? 'dot-warn' : s.status === 'failed' ? 'dot-err' : 'dot-off');
  $('btn-files').setAttribute('aria-pressed', S.file.open);
  $('btn-split').setAttribute('aria-pressed', S.split);
  $('btn-split').title = S.split ? '退出分屏（不断开连接）' : '在右侧显示已有会话（双窗格）';
}

function bannerOf(s) {
  if (s.banner) return s.banner;
  if (s.status === 'failed') {
    const h = hostOf(s);
    return {
      type: 'err',
      title: '无法连接 ' + esc(h.name) + '（' + esc(h.user) + '@' + esc(h.addr) + ':22）',
      body: '原因：连接超时——10 秒内没有收到响应。下一步：确认地址可达、防火墙放行后重试，或编辑主机检查端口与认证方式。',
      actions: [
        { label: '重试', primary: true, act: () => { removeSession(s.id); connectHost(s.hostId, { forceNew: true }); } },
        { label: '编辑主机', act: () => openHostForm(hostOf(s)) },
        { label: '技术详情', act: 'details' },
      ],
      details: 'os error 110 (ETIMEDOUT) · attempt a-3f9c2 · 2026-10-06 14:32:11 (+08:00) · 已脱敏',
    };
  }
  if (s.status === 'disconnected') {
    return {
      type: 'warn',
      title: '与 ' + esc(titleOf(s)) + ' 的连接已断开：网络中断（connection reset by peer）',
      body: '旧画面保留可复制；输入不会排队发给未来的连接。自动重试：第 1/5 次，3 秒后。',
      actions: [
        { label: '立即重连', primary: true, act: () => doReconnect(s) },
        { label: '停止重试', act: () => {
          s.banner = { type: 'warn', title: '已停止自动重试', body: '可随时手动重连。', actions: [{ label: '重新连接', primary: true, act: () => doReconnect(s) }] };
          renderTerminal();
        } },
      ],
    };
  }
  return null;
}

function canType(s) {
  if (!s || s.status !== 'connected' || s.screen === 'vim') return false;
  return s.screen === 'fresh' || (SCREENS[s.screen] || '').includes(CURSOR);
}

function inputLineHtml(s) {
  const h = s.kind === 'local' ? { user: 'chen', name: 'Mac' } : hostOf(s);
  const prompt = s.kind === 'local'
    ? '<span class="t-user">chen@Mac</span><span class="t-dim"> ~ %</span> '
    : pr(esc(h.user), esc(h.name), '~');
  return '<span class="term-line">' + prompt + esc(s.buf || '') + CURSOR + '</span>';
}

function runCommand(s) {
  const cmd = (s.buf || '').trim();
  s.buf = '';
  const h = s.kind === 'local' ? { user: 'chen', name: 'Mac' } : hostOf(s);
  const echoLine = s.kind === 'local'
    ? '<span class="t-user">chen@Mac</span><span class="t-dim"> ~ %</span> ' + esc(cmd)
    : pr(esc(h.user), esc(h.name), '~') + esc(cmd);
  let out = '';
  if (cmd === 'clear') { s.termHtml = ''; renderTerminal(); return; }
  if (cmd === 'whoami') out = esc(h.user);
  else if (cmd === 'hostname') out = esc(h.name);
  else if (cmd === 'pwd') out = s.kind === 'local' ? '/Users/chen' : '/home/' + h.user;
  else if (cmd.startsWith('echo ')) out = esc(cmd.slice(5));
  else if (cmd === 'ls') out = '<span class="t-cyan">app</span>  logs  readme.md';
  else if (cmd === 'date') out = esc(new Date().toString().slice(0, 24));
  else if (cmd === 'help') out = '（原型）可用：whoami / hostname / pwd / ls / echo / date / clear';
  else if (cmd) out = '<span class="t-warn">bash: ' + esc(cmd.split(' ')[0]) + ': command not found（原型仅模拟部分命令）</span>';
  s.termHtml += echoLine + '\n' + (out ? out + '\n' : '');
  renderTerminal();
}

function renderTerminal() {
  const s = activeSession();
  const area = $('term-area');
  if (!s) return;
  area.classList.toggle('disconnected', s.status === 'disconnected');
  area.classList.toggle('split', S.split);

  const banner = bannerOf(s);
  const bn = $('term-banner');
  if (banner) {
    const bActions = (banner.actions || []).map((a, i) =>
      '<button class="btn ' + (a.primary ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-bact="' + i + '">' + esc(a.label) + '</button>').join('');
    bn.hidden = false;
    bn.className = 'term-banner ' + banner.type;
    bn.innerHTML = '<span class="i" data-icon="' + (banner.type === 'err' ? 'alert' : banner.type === 'ok' ? 'check' : 'alert') + '"></span>' +
      '<div class="tb-main"><div class="tb-title">' + banner.title + '</div>' +
      (banner.body ? '<div class="tb-body">' + banner.body + '</div>' : '') +
      (banner.details ? '<div class="tb-details mono">' + esc(banner.details) + '</div>' : '') + '</div>' +
      '<div class="tb-actions">' + bActions + '</div>';
    hydrate(bn);
    bn.querySelectorAll('[data-bact]').forEach((b) => {
      const a = banner.actions[+b.dataset.bact];
      b.addEventListener('click', () => {
        if (a.act === 'details') { bn.querySelector('.tb-details').classList.toggle('open'); return; }
        a.act();
      });
    });
  } else {
    bn.hidden = true;
  }

  const stamp = s.reconnectStamp ? '<span class="t-dim">─── 于 14:36 重新连接（新连接边界；不重放历史命令）───</span>\n' : '';
  if (s.termHtml === undefined || s.termHtml === null) {
    let html = SCREENS[s.screen] || screenFresh(hostOf(s));
    if (canType(s)) {
      const idx = html.lastIndexOf('\n');
      s.termHtml = idx >= 0 ? html.slice(0, idx + 1) : '';
    } else {
      s.termHtml = html;
    }
  }
  $('term-a').innerHTML = stamp + s.termHtml + (canType(s) ? inputLineHtml(s) : '');
  $('pane-a').classList.toggle('focused', S.split && S.paneFocus === 'a');
  $('pane-tag-a').textContent = titleOf(s) + (S.split ? ' · 点击切换焦点' : '');

  const pb = $('pane-b');
  if (S.split) {
    if (!S.splitRight || !S.sessions.find((x) => x.id === S.splitRight)) {
      const cand = S.sessions.find((x) => x.id !== S.active && x.status === 'connected');
      S.splitRight = cand ? cand.id : null;
    }
    if (S.splitRight) {
      const s2 = S.sessions.find((x) => x.id === S.splitRight);
      if (s2.termHtml === undefined || s2.termHtml === null) {
        let html2 = SCREENS[s2.screen] || screenFresh(hostOf(s2));
        if (canType(s2)) {
          const idx2 = html2.lastIndexOf('\n');
          s2.termHtml = idx2 >= 0 ? html2.slice(0, idx2 + 1) : '';
        } else {
          s2.termHtml = html2;
        }
      }
      pb.hidden = false;
      $('term-b').innerHTML = s2.termHtml + (canType(s2) ? inputLineHtml(s2) : '');
      $('pane-b').classList.toggle('focused', S.paneFocus === 'b');
      $('pane-tag-b').textContent = titleOf(s2);
    } else { pb.hidden = true; S.split = false; }
  } else {
    pb.hidden = true;
  }
  if (!$('term-search').hidden) runSearch();
}

function renderFilePanel() {
  const p = S.file, panel = $('file-panel');
  panel.hidden = !p.open;
  if (!p.open) return;
  const s = focusedSession();
  const h = s && s.kind !== 'local' ? hostOf(s) : { name: '本机' };
  $('file-host-chip').textContent = h.name + ' · 模拟';
  const parts = p.path.split('/').filter(Boolean);
  let bc = '<button class="crumb" data-nav="/">/</button>';
  parts.forEach((seg, i) => {
    const target = '/' + parts.slice(0, i + 1).join('/');
    bc += '<span class="crumb-sep">/</span><button class="crumb' + (i === parts.length - 1 ? ' here' : '') + '" data-nav="' + target + '">' + esc(seg) + '</button>';
  });
  $('file-breadcrumb').innerHTML = bc;

  const dir = FS[p.path];
  const rows = (dir ? dir.dirs.map((d) =>
    '<div class="filerow is-dir" data-dir="' + esc(d[0]) + '" tabindex="0" role="button" aria-label="目录 ' + esc(d[0]) + '">' +
    '<span class="i" data-icon="folder"></span><span class="fname mono">' + esc(d[0]) + '</span>' +
    '<span class="col-size fsize">—</span><span class="col-time ftime">' + esc(d[1]) + '</span></div>'
  ).join('') : '') + (dir ? dir.files.map((f) =>
    '<div class="filerow' + (p.sel.has(f[0]) ? ' selected' : '') + '" data-file="' + esc(f[0]) + '" tabindex="0" role="button" aria-label="文件 ' + esc(f[0]) + '" aria-selected="' + p.sel.has(f[0]) + '">' +
    '<span class="i" data-icon="file"></span><span class="fname mono">' + esc(f[0]) + '</span>' +
    '<span class="col-size fsize">' + esc(f[1]) + '</span><span class="col-time ftime">' + esc(f[2]) + '</span></div>'
  ).join('') : '<div class="side-empty">（模拟）该目录为空。</div>');
  $('file-list').innerHTML = rows;
  hydrate($('file-list'));
  $('file-sel-count').textContent = p.sel.size ? '已选 ' + p.sel.size + ' 个文件' : '未选择文件（点击多选）';
  $('btn-download').disabled = !p.sel.size;
}

const ACTIVE_TASK = ['running', 'conflict', 'cancelling', 'committing', 'unknown'];

function scheduleCompletion(t) {
  after(3500, () => {
    if (t.status !== 'running') return;
    t.pct = 100; t.done = '完成'; t.status = 'committing';
    renderAll();
    after(1100, () => {
      if (t.status !== 'committing') return;
      t.status = 'done'; t.done = (t.dir === 'up' ? '已上传 ' : '已下载 ') + t.done.replace('完成 ', '');
      renderAll();
    });
  });
}

function taskRowHtml(t) {
  const icon = t.dir === 'down' ? 'download' : 'upload';
  let right = '', line = '', cls = t.status;
  if (t.status === 'running') {
    right = '<span>' + esc(t.done) + '</span><span>' + t.pct + '%</span><button class="btn btn-ghost btn-sm" data-task="cancel" data-id="' + t.id + '">取消</button>';
  } else if (t.status === 'cancelling') {
    right = '<span class="st-dim">取消中…</span>';
  } else if (t.status === 'committing') {
    right = '<span class="st-dim">提交中…（不可取消）</span>';
  } else if (t.status === 'unknown') {
    right = '<button class="btn btn-secondary btn-sm" data-task="retry" data-id="' + t.id + '">重试</button>' +
      '<button class="btn btn-ghost btn-sm" data-task="discard" data-id="' + t.id + '">丢弃</button>';
    line = '<div class="task-path st-warn">结果未知：连接中断于提交阶段，远端可能已写入完整文件。请核对后选择重试或丢弃。</div>';
  } else if (t.status === 'conflict') {
    right = '<button class="btn btn-secondary btn-sm" data-task="resolve" data-id="' + t.id + '">选择处理方式</button>';
    line = '<div class="task-path st-warn">等待处理：目标存在同名文件（跳过 / 替换 / 保留两份）</div>';
  } else if (t.status === 'done') {
    right = '<span class="st-ok">已完成</span>';
  } else if (t.status === 'skipped') {
    right = '<span class="st-dim">已跳过</span>';
  } else if (t.status === 'discarded') {
    right = '<span class="st-dim">已丢弃（未确认远端状态，可重新发起）</span>';
  } else if (t.status === 'cancelled') {
    right = '<span class="st-dim">已取消</span>';
  }
  const bar = (t.status === 'running' || t.status === 'conflict' || t.status === 'committing')
    ? '<div class="prog"><i style="width:' + t.pct + '%"></i></div>' : '';
  return '<div class="task ' + cls + ' ' + t.dir + '">' +
    '<div class="task-icon"><span class="i" data-icon="' + icon + '"></span></div>' +
    '<div class="task-main"><div class="task-top"><span class="task-name">' + esc(t.name) + '</span><span class="task-meta">' + right + '</span></div>' +
    '<div class="task-path mono">' + esc(t.from) + '  →  ' + esc(t.to) + '</div>' + line + bar + '</div></div>';
}

function renderDrawer() {
  const d = $('drawer');
  d.hidden = !S.drawer.open;
  const n = S.drawer.tasks.filter((t) => ACTIVE_TASK.includes(t.status)).length;
  $('drawer-count').textContent = S.drawer.tasks.length + ' 个任务 · ' + n + ' 个进行中';
  $('drawer-list').innerHTML = S.drawer.tasks.map(taskRowHtml).join('');
  hydrate($('drawer-list'));
}

function renderStatusbar() {
  const s = focusedSession();
  if (s) $('sb-left').textContent = s.kind === 'local' ? '本地 · zsh · 模拟数据' : 'SSH · UTF-8 · 模拟数据';
  const trN = S.drawer.tasks.filter((t) => ACTIVE_TASK.includes(t.status)).length;
  const fwN = S.forwards.filter((f) => f.status === 'Listening').length;
  $('sb-tr-count').textContent = trN;
  $('sb-fwd-count').textContent = fwN;
  $('sb-transfers').classList.toggle('attention', trN > 0);
  $('sb-drawer-toggle').classList.toggle('open', S.drawer.open);
}

/* ---------- 布局：文件并排 / 完整视图（含 16px 回差） ---------- */

function updateFileMode() {
  const c = $('content');
  if (!S.file.open) { c.classList.remove('mode-side', 'mode-full'); return; }
  const avail = innerWidth - (S.sidebarOpen ? S.sidebarW : 0);
  const need = 560 + 320;
  let full;
  if (S.split || S.narrowForced || S.file.forceFull) full = true;
  else if (S.file.mode === 'side') full = avail < need;
  else full = avail < need + 16;
  S.file.mode = full ? 'full' : 'side';
  c.classList.toggle('mode-side', !full);
  c.classList.toggle('mode-full', full);
}

function fitDrawer() {
  const d = $('drawer');
  if (!d || d.hidden) return;
  const h = Math.min(240, Math.max(120, Math.round($('content').clientHeight * 0.45)));
  d.style.height = h + 'px';
}

/* ---------- 连接流（模拟延时） ---------- */

function connectHost(id, opts) {
  opts = opts || {};
  const h = S.hosts.find((x) => x.id === id);
  if (!h) return;
  const live = S.sessions.find((s) => s.hostId === id && (s.status === 'connected' || s.status === 'connecting'));
  if (live && !opts.forceNew) {
    S.active = live.id; S.view = 'session'; renderAll();
    toast('已聚焦该主机的现有会话（模拟）');
    return;
  }
  if (h.status === 'connecting') return;
  h.status = 'connecting';
  const s = { id: uid(), hostId: id, kind: 'ssh', status: 'connecting', screen: 'connecting', banner: null };
  S.sessions.push(s);
  S.active = s.id; S.view = 'session'; S.selectedHost = id;
  renderAll();

  const proceed = () => {
    after(opts.fast ? 700 : 1300, () => {
      if (!S.sessions.includes(s)) return;
      s.status = 'connected'; h.status = 'connected'; s.screen = 'fresh';
      toast('已连接 ' + esc(h.name) + '（模拟延时）');
      renderAll();
    });
  };
  if (h.authKind === 'secret') {
    after(700, () => { if (S.sessions.includes(s)) openChallenge(s, 1, proceed); });
    return;
  }
  if (h.fpChange) {
    after(900, () => { if (S.sessions.includes(s)) openFingerprint(s, proceed); });
    return;
  }
  if (h.failNext) {
    after(1400, () => {
      if (!S.sessions.includes(s)) return;
      s.status = 'failed'; h.status = 'idle';
      renderAll();
    });
    return;
  }
  proceed();
}

function removeSession(id) {
  const i = S.sessions.findIndex((s) => s.id === id);
  if (i >= 0) S.sessions.splice(i, 1);
  if (S.splitRight === id) { S.split = false; S.splitRight = null; }
  if (S.active === id) S.active = (S.sessions[i - 1] || S.sessions[0] || {}).id || null;
  if (!S.sessions.length) S.view = S.hosts.length ? 'welcome-recent' : 'welcome-new';
  syncHostStatus();
}

function closeSession(id) {
  const s = S.sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.status === 'connected') {
    const running = S.drawer.tasks.filter((t) => ['running', 'committing', 'cancelling'].includes(t.status)).length;
    const unknownN = S.drawer.tasks.filter((t) => t.status === 'unknown' || t.status === 'conflict').length;
    const fwN = S.forwards.filter((f) => f.status === 'Listening').length;
    const impacts = [];
    if (running) impacts.push('将中断 ' + running + ' 个进行中的传输任务');
    if (unknownN) impacts.push(unknownN + ' 个待决策任务将保留在队列中');
    if (fwN) impacts.push('该会话的 ' + fwN + ' 个端口转发将停止');
    impacts.push('已保存的主机与凭据不受影响');
    const m = openModal(
      '<div class="modal-head"><div><div class="modal-title">关闭会话 · ' + esc(titleOf(s)) + '</div>' +
      '<div class="modal-sub">关闭是主动结束连接；与网络断线不同。</div></div>' +
      '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
      '<div class="modal-body"><div class="tb-body" style="color:var(--text-primary);font-size:13px;line-height:22px">' + impacts.map((x) => '· ' + x).join('<br>') + '</div></div>' +
      '<div class="modal-foot"><span class="foot-note">模拟确认：首版统一关闭确认。</span>' +
      '<button class="btn btn-secondary" data-close>取消</button>' +
      '<button class="btn btn-danger" id="cs-confirm">关闭会话</button></div>', { width: 480 });
    m.querySelector('#cs-confirm').addEventListener('click', () => {
      closeModal(); removeSession(id); renderAll();
    });
    return;
  }
  removeSession(id); renderAll();
}

function doReconnect(s) {
  s.banner = { type: 'info', title: '正在重新建立连接…', body: '重试次数将在成功后清零。', actions: [] };
  renderTerminal();
  after(1200, () => {
    if (!S.sessions.includes(s)) return;
    s.status = 'connected'; s.reconnectStamp = true;
    syncHostStatus();
    s.banner = {
      type: 'ok',
      title: '已重连。这是新的连接边界。',
      body: '原工作目录、环境变量与远端进程不会自动恢复；不会自动重放历史命令。',
      actions: [{ label: '知道了', primary: true, act: () => { s.banner = null; renderTerminal(); } }],
    };
    renderAll();
    after(2600, () => { if (S.sessions.includes(s) && s.banner && s.banner.type === 'ok') { s.banner = null; renderTerminal(); } });
  });
}

/* ---------- 指纹确认（旧值 / 新值对照） ---------- */

function openFingerprint(session, proceed) {
  const h = session ? hostOf(session) : (S.hosts.find((x) => x.id === 'h10') || { name: 'new-app-01', user: 'ops', addr: '10.0.9.7' });
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">核实主机指纹</div>' +
    '<div class="modal-sub">来自 ' + esc(h.name) + ' · ' + esc(h.user) + '@' + esc(h.addr) + ':22 的连接请求（模拟）</div></div></div>' +
    '<div class="modal-body">' +
    '<div class="fp-warn"><span class="i" data-icon="alert"></span><div>该主机的指纹与上次记录<b>不同</b>。请通过其他可信渠道（如服务器控制台）核实后再继续；信任前不会发送任何密码或密钥。</div></div>' +
    '<div class="fp-compare">' +
    '<div class="fp-item old"><div class="fp-label"><span>上次记录 · ED25519</span><span>2026-08-12</span></div><div class="fp-val mono">SHA256:Ab3kP9rWvQ2mZxN8cL0dJ4hG7fT1sY6uIoP5eR2bC9k</div></div>' +
    '<div class="fp-item new"><div class="fp-label"><span>本次连接 · ED25519</span><span class="st-warn">与记录不同</span></div><div class="fp-val mono">SHA256:Qm7vT2xR8kL1pO9nB3cH6gF4dS0aZ7jUwY5eN2rK8t</div></div>' +
    '</div></div>' +
    '<div class="modal-foot"><span class="foot-note">拒绝将取消本次连接尝试，不影响其他会话。</span>' +
    '<button class="btn btn-secondary" id="fp-reject">拒绝</button>' +
    '<button class="btn btn-primary" id="fp-accept">信任新指纹并继续</button></div>', { width: 560, lock: true });
  m.querySelector('#fp-reject').addEventListener('click', () => {
    closeModal();
    if (session) {
      removeSession(session.id); renderAll();
      toast('已拒绝指纹并取消该连接尝试（模拟）', 'warn');
    } else {
      toast('已拒绝指纹并取消该连接请求（模拟）', 'warn');
    }
  });
  m.querySelector('#fp-accept').addEventListener('click', () => {
    closeModal();
    toast('已信任新指纹（模拟）', 'warn');
    if (session) proceed();
    else connectHost('h10', { forceNew: true, fast: true });
  });
}

/* ---------- 同名冲突 ---------- */

function openConflict(t) {
  if (!t) return;
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">目标存在同名文件</div>' +
    '<div class="modal-sub">上传任务 · ' + esc(t.name) + '（模拟）</div></div></div>' +
    '<div class="modal-body">' +
    '<div class="kv" style="grid-template-columns:110px 1fr">' +
    '<dt>目标位置</dt><dd class="mono">' + esc(t.to) + '</dd>' +
    '<dt>目标已有</dt><dd>17 MB · 2026-10-05 22:41（远端）</dd>' +
    '<dt>本文件</dt><dd>18 MB · 今天 14:30（本机）</dd>' +
    '</div>' +
    '<div class="fp-warn" style="margin-top:14px"><span class="i" data-icon="alert"></span><div>默认跳过。替换仅保证本任务内的检查；若目标正被其他程序写入，可能覆盖其变更。选择只应用于本批明确列出的任务。</div></div>' +
    '</div>' +
    '<div class="modal-foot"><span class="foot-note">决策后、提交前会再次检查目标变化。</span>' +
    '<button class="btn btn-secondary" id="cf-skip">跳过</button>' +
    '<button class="btn btn-secondary" id="cf-keep2">保留两份</button>' +
    '<button class="btn btn-danger" id="cf-replace">替换</button></div>', { width: 520 });
  m.querySelector('#cf-skip').addEventListener('click', () => {
    t.status = 'skipped'; closeModal(); renderAll();
    toast('已跳过 ' + esc(t.name) + '；本批其余任务不受影响');
  });
  m.querySelector('#cf-keep2').addEventListener('click', () => {
    t.status = 'running'; t.pct = 8; t.done = '1.4 / 18 MB';
    t.to = t.to.replace(/config\.tar\.gz$/, 'config (1).tar.gz');
    closeModal(); renderAll();
    toast('保留两份：新文件命名为 config (1).tar.gz（模拟）');
  });
  m.querySelector('#cf-replace').addEventListener('click', () => {
    t.status = 'running'; t.pct = 18; t.done = '3.2 / 18 MB';
    closeModal(); renderAll();
    toast('已选择替换：若目标被其他程序写入，可能覆盖其变更（模拟）', 'warn');
  });
}

/* ---------- keyboard-interactive 两轮挑战（模拟） ---------- */

function openChallenge(session, round, done) {
  const h = hostOf(session);
  const questions = [
    { q: '请输入 ' + esc(h.user) + '@' + esc(h.addr) + ' 的登录密码', ph: '密码', type: 'password' },
    { q: '验证码（6 位，已发送到你绑定的设备 · 模拟）', ph: '000000', type: 'text' },
  ];
  const cur = questions[round - 1];
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">SSH 认证 · keyboard-interactive</div>' +
    '<div class="modal-sub">' + esc(h.name) + ' · 第 ' + round + ' 次提问，共 ' + questions.length + ' 次（模拟）</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body"><div class="field"><label for="ch-input">' + cur.q + '</label>' +
    '<input id="ch-input" type="' + cur.type + '" placeholder="' + cur.ph + '" autocomplete="off"><div class="field-err" hidden>请输入内容后继续</div></div>' +
    '<p class="wc-sub">服务器发起的多轮问答认证；回答仅用于本次连接（模拟）。</p></div>' +
    '<div class="modal-foot"><span class="foot-note">取消将结束本次连接尝试。</span>' +
    '<button class="btn btn-secondary" id="ch-cancel">取消连接</button>' +
    '<button class="btn btn-primary" id="ch-go">继续</button></div>', { width: 520, lock: true });
  const submit = () => {
    const input = m.querySelector('#ch-input');
    if (!input.value.trim()) {
      input.closest('.field').classList.add('err');
      input.closest('.field').querySelector('.field-err').hidden = false;
      return;
    }
    closeModal();
    if (round < questions.length) openChallenge(session, round + 1, done);
    else { toast('认证通过（模拟 · ' + questions.length + ' 轮问答）'); done(); }
  };
  m.querySelector('#ch-go').addEventListener('click', submit);
  m.querySelector('#ch-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  m.querySelector('#ch-cancel').addEventListener('click', () => {
    closeModal();
    removeSession(session.id); renderAll();
    toast('已取消连接尝试（模拟）', 'warn');
  });
}

/* ---------- S10 协作：Agent 首次委托与审批（模拟） ---------- */

function openAgentApproval() {
  const cmd = 'tail -n 200 /srv/app/logs/error.log | grep -c ERROR';
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">Agent 请求执行命令</div>' +
    '<div class="modal-sub">claude-code · 会话 prod-api #1（模拟）</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body">' +
    '<div class="fp-warn"><span class="i" data-icon="terminal"></span><div>Agent 请求在你的会话中执行以下命令：</div></div>' +
    '<div class="mono" style="background:var(--term-bg);color:var(--term-fg);border-radius:8px;padding:10px 12px;margin-top:10px">' + esc(cmd) + '</div>' +
    '<p class="wc-sub" style="margin-top:10px">批准后命令经你的会话执行，输出回传给 Agent；你可随时撤销本次授权（模拟）。</p></div>' +
    '<div class="modal-foot"><span class="foot-note">拒绝不会中断会话；Agent 将收到拒绝结果。</span>' +
    '<button class="btn btn-secondary" id="ag-deny">拒绝</button>' +
    '<button class="btn btn-primary" id="ag-approve">批准</button></div>', { width: 600, lock: true });
  m.querySelector('#ag-deny').addEventListener('click', () => {
    closeModal();
    toast('已拒绝 Agent 请求（模拟）', 'warn');
  });
  m.querySelector('#ag-approve').addEventListener('click', () => {
    closeModal();
    openFirstDelegation(() => {
      const s = S.sessions.find((x) => x.id === 's1') || activeSession();
      if (s && canType(s)) {
        s.termHtml += pr(esc(hostOf(s).user), esc(hostOf(s).name), '~') + '<span class="t-cyan"># agent</span> ' + esc(cmd) + '\n' +
          '<span class="t-dim">3  （模拟输出：匹配行数）</span>\n';
        renderTerminal();
      }
      toast('已批准并执行；结果已回传 Agent（模拟）');
    });
  });
}

function openFirstDelegation(done) {
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">首次委托确认</div>' +
    '<div class="modal-sub">Agent 将获得本会话的受控执行通道（模拟）</div></div></div>' +
    '<div class="modal-body"><div class="tb-body" style="color:var(--text-primary);font-size:13px;line-height:22px">' +
    '· 每条命令执行前都会请求你的批准<br>· 授权只针对当前会话，不影响其他主机<br>' +
    '· 你在输入栏打字时 Agent 不会注入命令</div></div>' +
    '<div class="modal-foot"><span class="foot-note">此为首次委托的一次性确认。</span>' +
    '<button class="btn btn-secondary" data-close>取消</button>' +
    '<button class="btn btn-primary" id="fd-ok">了解并允许</button></div>', { width: 520, lock: true });
  m.querySelector('#fd-ok').addEventListener('click', () => { closeModal(); done(); });
}

/* ---------- 连接表单 / 导入 / 设置 / 连接工具 ---------- */

function openHostForm(h) {
  const isEdit = !!h;
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">' + (isEdit ? '编辑连接' : '添加连接') + '</div>' +
    '<div class="modal-sub">保存后凭据独立存放在本机凭据库（模拟）。</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body">' +
    '<div class="field-row">' +
    '<div class="field"><label for="hf-name">名称</label><input id="hf-name" placeholder="例如 prod-api" value="' + (isEdit ? esc(h.name) : '') + '"><div class="field-err" hidden>请填写名称</div></div>' +
    '<div class="field narrow"><label for="hf-port">端口</label><input id="hf-port" value="22"></div>' +
    '</div>' +
    '<div class="field"><label for="hf-addr">地址</label><input id="hf-addr" placeholder="主机名或 IP" value="' + (isEdit ? esc(h.addr) : '') + '"><div class="field-err" hidden>请填写地址</div></div>' +
    '<div class="field"><label for="hf-user">用户名</label><input id="hf-user" placeholder="deploy" value="' + (isEdit ? esc(h.user) : '') + '"><div class="field-err" hidden>请填写用户名</div></div>' +
    '<div class="field"><label for="hf-auth">认证方式</label><select id="hf-auth"><option>已有密钥 · id_ed25519（已保存）</option><option>密码</option><option>系统 SSH Agent</option><option>生成新密钥（ed25519）</option><option>粘贴 / 导入私钥</option></select></div>' +
    '<div class="field" id="hf-secret-field" hidden><label for="hf-secret">密码</label><input id="hf-secret" type="password" placeholder="登录密码（保存在本机凭据库）" autocomplete="off"><div class="field-err" hidden>请填写密码</div></div>' +
    '<div class="field" id="hf-keytext-field" hidden><label for="hf-keytext">私钥内容</label><textarea id="hf-keytext" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----（模拟粘贴，原型不校验格式）"></textarea><div class="field-err" hidden>请粘贴私钥内容</div></div>' +
    '<div class="field" id="hf-pass-field" hidden><label for="hf-pass">密钥口令（可选）</label><input id="hf-pass" type="password" placeholder="私钥解密口令" autocomplete="off"></div>' +
    '<details class="more-settings"><summary>更多设置</summary>' +
    '<div class="field"><label for="hf-tags">标签（逗号分隔）</label><input id="hf-tags" placeholder="生产, 运维"></div>' +
    '<div class="field"><label for="hf-enc">编码</label><select id="hf-enc"><option>UTF-8</option><option>GBK</option></select></div>' +
    '</details></div>' +
    '<div class="modal-foot"><span class="foot-note">取消不保存任何内容；已保存的凭据不会被默默删除。</span>' +
    '<button class="btn btn-secondary" data-close>取消</button>' +
    '<button class="btn btn-secondary" id="hf-save">仅保存</button>' +
    '<button class="btn btn-primary" id="hf-go">保存并连接</button></div>', { width: 560 });
  const AUTH_KINDS = ['key', 'secret', 'agent', 'gen', 'paste'];
  const sel = m.querySelector('#hf-auth');
  const authKind = () => AUTH_KINDS[sel.selectedIndex] || 'key';
  const syncAuthFields = () => {
    const k = authKind();
    m.querySelector('#hf-secret-field').hidden = k !== 'secret';
    m.querySelector('#hf-keytext-field').hidden = k !== 'paste';
    m.querySelector('#hf-pass-field').hidden = k !== 'paste';
  };
  sel.addEventListener('change', syncAuthFields);
  syncAuthFields();
  const validate = () => {
    let ok = true;
    [['hf-name'], ['hf-addr'], ['hf-user']].forEach(([idv]) => {
      const input = m.querySelector('#' + idv);
      const bad = !input.value.trim();
      input.closest('.field').classList.toggle('err', bad);
      input.closest('.field').querySelector('.field-err').hidden = !bad;
      if (bad) ok = false;
    });
    const k = authKind();
    if (k === 'secret') {
      const input = m.querySelector('#hf-secret');
      const bad = !input.value;
      input.closest('.field').classList.toggle('err', bad);
      input.closest('.field').querySelector('.field-err').hidden = !bad;
      if (bad) ok = false;
    }
    if (k === 'paste') {
      const input = m.querySelector('#hf-keytext');
      const bad = !input.value.trim();
      input.closest('.field').classList.toggle('err', bad);
      input.closest('.field').querySelector('.field-err').hidden = !bad;
      if (bad) ok = false;
    }
    return ok;
  };
  const save = (connect) => {
    if (!validate()) return;
    const vals = {
      name: m.querySelector('#hf-name').value.trim(),
      addr: m.querySelector('#hf-addr').value.trim(),
      user: m.querySelector('#hf-user').value.trim(),
      tags: m.querySelector('#hf-tags').value.split(/[，,]/).map((x) => x.trim()).filter(Boolean),
      authKind: authKind(),
    };
    let host;
    if (isEdit) { Object.assign(h, vals); host = h; }
    else {
      host = { id: uid(), fav: false, ...vals };
      S.hosts.push(host);
    }
    closeModal();
    toast(isEdit ? '已保存修改（模拟）' : '已保存到主机库（模拟）');
    if (connect) connectHost(host.id, { forceNew: true });
    else { renderSidebar(); if (!S.sessions.length) S.view = 'welcome-recent'; renderAll(); }
  };
  m.querySelector('#hf-go').addEventListener('click', () => save(true));
  m.querySelector('#hf-save').addEventListener('click', () => save(false));
}

function openImport() {
  const rows = [
    { alias: 'log-collector', addr: 'ops@10.0.0.77', chip: '可导入', cls: 'ok', checked: true, disabled: false },
    { alias: 'api-prod', addr: 'deploy@10.0.0.11', chip: '重复 · 默认跳过', cls: '', checked: false, disabled: false },
    { alias: 'jumpbox', addr: 'ops@203.0.113.99', chip: '依赖 ProxyJump · 不支持', cls: 'warn', checked: false, disabled: true },
  ];
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">导入 SSH 配置</div>' +
    '<div class="modal-sub">来源：~/.ssh/config（模拟解析结果）。导入前不建立任何连接。</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body">' +
    rows.map((r, i) =>
      '<label class="imp-row' + (r.disabled ? ' dis' : '') + '">' +
      '<input type="checkbox" data-imp="' + i + '"' + (r.checked ? ' checked' : '') + (r.disabled ? ' disabled' : '') + '>' +
      '<div class="imp-main"><div class="imp-alias mono">' + r.alias + '</div><div class="imp-addr mono">' + r.addr + '</div></div>' +
      '<span class="imp-chip ' + r.cls + '">' + r.chip + '</span></label>').join('') +
    '<p class="wc-sub" style="margin-top:4px">含 ProxyJump 等未支持依赖的条目不可直接导入，可转为手工表单修正；同名或同 address+port+user 默认跳过。</p>' +
    '</div>' +
    '<div class="modal-foot"><span class="foot-note">逐条返回结果；局部失败不撤销成功项。</span>' +
    '<button class="btn btn-secondary" data-close>取消</button>' +
    '<button class="btn btn-primary" id="imp-go">导入选中项</button></div>', { width: 720 });
  m.querySelector('#imp-go').addEventListener('click', () => {
    const picked = [];
    m.querySelectorAll('[data-imp]').forEach((cb) => { if (cb.checked) picked.push(rows[+cb.dataset.imp]); });
    let added = 0;
    picked.forEach((r) => {
      if (r.alias === 'log-collector' && !S.hosts.some((h) => h.name === 'log-collector')) {
        S.hosts.push({ id: uid(), name: 'log-collector', user: 'ops', addr: '10.0.0.77', tags: ['运维'] });
        added++;
      }
    });
    closeModal();
    toast(added ? '已导入 ' + added + ' 台主机（模拟）' : '没有可导入的条目（重复默认跳过）');
    if (!S.sessions.length) S.view = S.hosts.length ? 'welcome-recent' : 'welcome-new';
    renderAll();
  });
}

function openSettings() {
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">设置</div><div class="modal-sub">外观与终端偏好即时预览（模拟持久化）。</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body"><div class="set-wrap">' +
    '<div class="set-nav">' +
    '<button class="on" data-set="look">外观</button><button data-set="term">终端</button><button data-set="cred">凭据</button>' +
    '<button data-set="agent">Agent 接入</button><button data-set="keys">快捷键</button><button data-set="about">关于</button></div>' +
    '<div class="set-pane" id="set-pane">' +
    '<h3>外观</h3>' +
    '<label class="set-opt"><input type="radio" name="theme" value="sys">跟随系统</label>' +
    '<label class="set-opt"><input type="radio" name="theme" value="light">浅色</label>' +
    '<label class="set-opt"><input type="radio" name="theme" value="dark">深色</label>' +
    '<div class="set-note">应用主题与终端配色解耦：终端保持独立的深色配色（可在「终端」中单独选择）。本原型仅提供「外观」分类。</div>' +
    '</div></div></div>' +
    '<div class="modal-foot"><span class="foot-note">其余分类在 R27 / R41 任务实现。</span><button class="btn btn-secondary" data-close>关闭</button></div>', { width: 800 });
  const radios = m.querySelectorAll('input[name="theme"]');
  const sysLight = matchMedia('(prefers-color-scheme: light)').matches;
  radios.forEach((r) => { r.checked = r.value === S.theme; });
  radios.forEach((r) => r.addEventListener('change', () => {
    S.theme = r.value;
    renderChrome();
    toast('外观已切换并持久化（模拟）');
  }));
  m.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
    m.querySelectorAll('[data-set]').forEach((x) => x.classList.toggle('on', x === b));
    const pane = m.querySelector('#set-pane');
    if (b.dataset.set === 'look') { openSettings(); return; }
    if (b.dataset.set === 'term') {
      pane.innerHTML = '<h3>终端</h3>' +
        '<div class="field"><label for="set-font">字号</label><select id="set-font"><option>12</option><option selected>13</option><option>14</option><option>16</option></select></div>' +
        '<div class="field"><label for="set-scroll">回滚行数</label><select id="set-scroll"><option>1000</option><option selected>5000</option><option>10000</option><option>50000</option></select></div>' +
        '<div class="set-note">即时预览（模拟持久化）；终端配色保持独立深色，不随应用主题。</div>';
      pane.querySelector('#set-font').addEventListener('change', (e) => toast('终端字号 → ' + e.target.value + ' px（模拟持久化）'));
      pane.querySelector('#set-scroll').addEventListener('change', (e) => toast('回滚行数 → ' + e.target.value + '（模拟持久化）'));
      return;
    }
    if (b.dataset.set === 'cred') {
      const creds = [
        { name: 'id_ed25519（默认密钥）', bound: 'prod-api · staging 等 4 台主机' },
        { name: 'deploy-password', bound: 'staging' },
        { name: 'old-laptop-key', bound: null },
      ];
      pane.innerHTML = '<h3>凭据</h3>' + creds.map((c, i) =>
        '<div class="set-opt cred-row"><span><span class="mono">' + esc(c.name) + '</span>' +
        '<span class="set-note" style="display:block">' + (c.bound ? '被引用：' + esc(c.bound) : '<span class="st-warn">未绑定任何主机</span>') + '</span></span>' +
        '<button class="btn btn-danger btn-sm" data-cred-del="' + i + '"' + (c.bound ? ' title="被引用的凭据不可删除"' : '') + '>删除</button></div>').join('') +
        '<div class="set-note">删除前做引用检查；被引用的凭据须先解除主机绑定（DF8.4，模拟）。</div>';
      pane.querySelectorAll('[data-cred-del]').forEach((btn) => btn.addEventListener('click', () => {
        const c = creds[+btn.dataset.credDel];
        if (c.bound) { toast('无法删除：' + c.name + ' 仍被主机引用（DF8.4）', 'warn'); return; }
        toast('已删除凭据 ' + c.name + '（模拟）');
        btn.closest('.set-opt').remove();
      }));
      return;
    }
    pane.innerHTML = '<h3>' + esc(b.textContent) + '</h3><div class="set-note">该分类内容由后续任务（R27 / R41 / R43）提供；当前原型未包含。</div>';
  }));
}

function openConnDetails() {
  const s = focusedSession();
  if (!s || s.kind === 'local') { toast('本地终端无连接详情（模拟）'); return; }
  const h = hostOf(s);
  openModal(
    '<div class="modal-head"><div><div class="modal-title">连接详情</div><div class="modal-sub">' + esc(h.name) + ' · 会话 ' + esc(titleOf(s)) + '</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body"><dl class="kv">' +
    '<dt>用户</dt><dd>' + esc(h.user) + '</dd>' +
    '<dt>地址</dt><dd class="mono">' + esc(h.addr) + ':22</dd>' +
    '<dt>认证</dt><dd>密钥 · id_ed25519</dd>' +
    '<dt>指纹</dt><dd class="mono">SHA256:Ab3kP9rWvQ2mZxN8cL0dJ4hG7fT1sY6uIoP5eR2bC9k</dd>' +
    '<dt>编码</dt><dd>UTF-8</dd>' +
    '<dt>创建时间</dt><dd>2026-10-06 10:24:00 (+08:00)</dd>' +
    '</dl>' +
    '<details class="tech-details"><summary>技术详情</summary><div class="mono">session id: 8f3a-4c21-9d77-e0b5<br>cipher: chacha20-poly1305@openssh.com</div>' +
    '<div style="margin-top:8px"><button class="btn btn-secondary btn-sm" id="cd-copy"><span class="i" data-icon="copy"></span>复制会话 ID</button></div></details>' +
    '</div>' +
    '<div class="modal-foot"><span class="foot-note">模拟数据。</span><button class="btn btn-secondary" data-close>关闭</button></div>', { width: 560 })
    .querySelector('#cd-copy').addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText('8f3a-4c21-9d77-e0b5').then(() => toast('已复制（模拟）'), () => toast('复制失败（浏览器限制）', 'warn'));
    });
}

function openForwards() {
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">端口转发</div><div class="modal-sub">本会话 · prod-api（模拟）</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body"><div id="fwd-list"></div>' +
    '<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" id="fwd-new">新建转发</button></div>' +
    '<p class="wc-sub" style="margin-top:12px">本地（-L）/ 远程（-R）/ SOCKS5（-D）。默认监听 127.0.0.1；监听成功与目标可达分开显示。</p></div>' +
    '<div class="modal-foot"><span class="foot-note">完整表单在 R40 任务实现。</span><button class="btn btn-secondary" data-close>关闭</button></div>', { width: 560 });
  const render = () => {
    m.querySelector('#fwd-list').innerHTML = S.forwards.map((f) =>
      '<div class="fwd-row"><div class="fwd-route"><div class="fwd-type">' + esc(f.type) + ' · ' + esc(f.listen) + '</div>' +
      '<div class="fwd-listen mono">→ ' + esc(f.dest) + '</div></div>' +
      '<span class="pill ' + (f.status === 'Listening' ? 'ok' : '') + '">' + (f.status === 'Stopping' ? '停止中…' : f.status === 'Connecting' ? '连接中…' : f.status === 'Listening' ? 'Listening' : '已停止') + '</span>' +
      (f.status === 'Listening' ? '<button class="btn btn-secondary btn-sm" data-fstop="' + f.id + '">停止</button>' : '') +
      '</div>').join('');
    m.querySelectorAll('[data-fstop]').forEach((b) => b.addEventListener('click', () => {
      const f = S.forwards.find((x) => x.id === b.dataset.fstop);
      f.status = 'Stopping'; render(); renderStatusbar();
      after(700, () => { f.status = 'Stopped'; render(); renderStatusbar(); toast('转发已停止（模拟）'); });
    }));
  };
  render();
  m.querySelector('#fwd-new').addEventListener('click', () => openForwardForm(() => { render(); renderStatusbar(); }));
}

function openForwardForm(onCreate) {
  const m = openModal(
    '<div class="modal-head"><div><div class="modal-title">新建端口转发</div>' +
    '<div class="modal-sub">本会话 · prod-api（模拟）。默认只监听 127.0.0.1。</div></div>' +
    '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
    '<div class="modal-body">' +
    '<div class="field"><label for="fw-type">类型</label><select id="fw-type"><option>本地（-L）</option><option>远程（-R）</option><option>SOCKS5（-D）</option></select></div>' +
    '<div class="field-row">' +
    '<div class="field"><label for="fw-listen">监听地址</label><input id="fw-listen" placeholder="127.0.0.1:6379"><div class="field-err" hidden>格式：地址:端口</div></div>' +
    '<div class="field"><label for="fw-dest">目标</label><input id="fw-dest" placeholder="10.0.0.31:6379"><div class="field-err" hidden>格式：地址:端口</div></div>' +
    '</div>' +
    '<p class="wc-sub">监听成功与目标可达分开显示；远程（-R）由服务器侧监听（模拟）。</p></div>' +
    '<div class="modal-foot"><span class="foot-note">创建后立即尝试监听。</span>' +
    '<button class="btn btn-secondary" data-close>取消</button>' +
    '<button class="btn btn-primary" id="fw-go">创建转发</button></div>', { width: 560 });
  const submit = () => {
    const listen = m.querySelector('#fw-listen').value.trim();
    const dest = m.querySelector('#fw-dest').value.trim();
    const okListen = /^[^\s:]+:\d+$/.test(listen);
    const okDest = /^[^\s:]+:\d+$/.test(dest);
    [['#fw-listen', okListen], ['#fw-dest', okDest]].forEach(([selId, ok]) => {
      const input = m.querySelector(selId);
      input.closest('.field').classList.toggle('err', !ok);
      input.closest('.field').querySelector('.field-err').hidden = ok;
    });
    if (!okListen || !okDest) return;
    const f = {
      id: uid(), type: m.querySelector('#fw-type').value,
      listen, dest, status: 'Connecting',
    };
    S.forwards.push(f);
    closeModal();
    onCreate();
    toast('转发创建中：正在监听 ' + listen + '（模拟）');
    after(800, () => {
      f.status = 'Listening';
      renderStatusbar();
      if (!$('overlay-root').hidden && $('overlay-root').querySelector('.modal')) onCreate();
      toast('转发已监听：' + listen + ' → ' + dest + '（模拟）');
    });
  };
  m.querySelector('#fw-go').addEventListener('click', submit);
  m.querySelector('#fw-listen').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  m.querySelector('#fw-dest').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

/* ---------- 事件绑定 ---------- */

function wire() {
  hydrate(document);

  $('btn-theme').addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; renderChrome(); });
  $('btn-scenario').addEventListener('click', () => {
    const items = [];
    SCENARIOS.forEach((g) => {
      items.push({ group: g.group });
      g.items.forEach((it) => items.push({ label: it.label, checked: it.key === S.scenario, act: () => applyScenario(it.key) }));
    });
    openMenu($('btn-scenario'), items);
  });

  $('btn-sidebar-collapse').addEventListener('click', () => { S.sidebarOpen = false; renderChrome(); updateFileMode(); });
  $('btn-sidebar-expand').addEventListener('click', () => { S.sidebarOpen = true; renderChrome(); updateFileMode(); });

  $('host-search').addEventListener('input', (e) => { S.searchQ = e.target.value; renderSidebar(); });

  $('side-scroll').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      const id = act.dataset.id;
      if (act.dataset.act === 'connect') { connectHost(id); return; }
      if (act.dataset.act === 'cancel-connect') {
        const s = S.sessions.find((x) => x.hostId === id && x.status === 'connecting');
        if (s) removeSession(s.id);
        renderAll(); toast('已取消连接尝试（模拟）');
        return;
      }
      if (act.dataset.act === 'host-menu') { hostMenu(act, id); return; }
      if (act.dataset.act === 'add-host') { openHostForm(null); return; }
    }
    const row = e.target.closest('.host-row');
    if (row) { S.selectedHost = row.dataset.host; renderSidebar(); }
  });
  $('side-scroll').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.host-row');
    if (row && !e.target.closest('[data-act]')) connectHost(row.dataset.host);
  });
  $('host-groups').addEventListener('keydown', (e) => {
    const row = e.target.closest('.host-row');
    if (row && e.key === 'Enter') connectHost(row.dataset.host);
  });
  $('tag-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (!chip) return;
    const t = chip.dataset.tag;
    if (S.tagFilter.has(t)) S.tagFilter.delete(t); else S.tagFilter.add(t);
    renderSidebar();
  });

  const grip = $('side-grip');
  let drag = null;
  grip.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, w: S.sidebarW };
    grip.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    S.sidebarW = Math.max(200, Math.min(300, drag.w + e.clientX - drag.x));
    $('sidebar').style.width = S.sidebarW + 'px';
    const tip = $('drag-tip');
    tip.hidden = false;
    tip.textContent = S.sidebarW + ' px（200–300）';
    tip.style.left = (S.sidebarW + 20) + 'px';
    tip.style.top = '60px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    grip.classList.remove('dragging');
    $('drag-tip').hidden = true;
    updateFileMode();
  });

  $('btn-add-host').addEventListener('click', () => openHostForm(null));
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-welcome-add').addEventListener('click', () => openHostForm(null));
  $('btn-welcome-add2').addEventListener('click', () => openHostForm(null));
  $('btn-welcome-import').addEventListener('click', openImport);
  $('btn-welcome-import2').addEventListener('click', openImport);
  $('btn-welcome-local').addEventListener('click', openLocalTerminal);
  $('recent-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-recent]');
    if (card) connectHost(card.dataset.recent);
  });

  $('tabstrip').addEventListener('click', (e) => {
    const x = e.target.closest('[data-tab-x]');
    if (x) { closeSession(x.dataset.tabX); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.active = tab.dataset.tab; renderAll(); }
  });
  $('tabstrip').addEventListener('keydown', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab && e.key === 'Enter') { S.active = tab.dataset.tab; renderAll(); }
  });
  $('btn-new-tab').addEventListener('click', () => {
    const items = S.hosts.map((h) => ({ label: h.name + ' · ' + h.user + '@' + h.addr, icon: 'terminal', act: () => connectHost(h.id, { forceNew: true }) }));
    items.push('sep');
    items.push({ label: '本地终端', icon: 'terminal', kbd: '⌘T', act: openLocalTerminal });
    openMenu($('btn-new-tab'), items);
  });
  $('btn-all-tabs').addEventListener('click', () => {
    const stText = { connected: '已连接', connecting: '正在连接', disconnected: '已断开', failed: '连接失败' };
    const items = S.sessions.map((s) => ({
      label: titleOf(s) + ' · ' + (stText[s.status] || ''),
      checked: s.id === S.active,
      act: () => { S.active = s.id; renderAll(); },
    }));
    openMenu($('btn-all-tabs'), items);
  });

  $('btn-tsearch').addEventListener('click', () => {
    const bar = $('term-search');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) { $('term-search-input').focus(); runSearch(); }
    else clearSearchMarks();
  });
  $('btn-tsearch-close').addEventListener('click', () => { $('term-search').hidden = true; clearSearchMarks(); });
  $('term-search-input').addEventListener('input', runSearch);
  $('btn-tsearch-prev').addEventListener('click', () => searchStep(-1));
  $('btn-tsearch-next').addEventListener('click', () => searchStep(1));

  $('panes').addEventListener('keydown', (e) => {
    const s = focusedSession();
    if (!s || !canType(s)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter') { runCommand(s); e.preventDefault(); return; }
    if (e.key === 'Backspace') { s.buf = (s.buf || '').slice(0, -1); renderTerminal(); e.preventDefault(); return; }
    if (e.key.length === 1) { s.buf = (s.buf || '') + e.key; renderTerminal(); e.preventDefault(); }
  });

  $('btn-split').addEventListener('click', () => {
    S.split = !S.split;
    if (S.split) {
      S.paneFocus = 'a';
      toast('双分屏：点击窗格切换焦点；「退出分屏」不断开连接');
      if (S.file.open) toast('分屏下打开文件使用完整视图，返回后恢复分屏', 'warn');
    }
    renderAll();
  });
  $('pane-a').addEventListener('mousedown', () => { S.paneFocus = 'a'; renderAll(); });
  $('pane-b').addEventListener('mousedown', () => { S.paneFocus = 'b'; renderAll(); });

  $('btn-files').addEventListener('click', toggleFiles);
  $('btn-file-close').addEventListener('click', toggleFiles);
  $('btn-back-terminal').addEventListener('click', () => { S.file.open = false; renderAll(); });
  $('btn-file-full').addEventListener('click', () => { S.file.forceFull = true; updateFileMode(); });

  $('file-breadcrumb').addEventListener('click', (e) => {
    const c = e.target.closest('[data-nav]');
    if (c) navigateTo(c.dataset.nav);
  });
  $('file-list').addEventListener('click', (e) => {
    const dir = e.target.closest('[data-dir]');
    if (dir) { navigateTo(joinPath(S.file.path, dir.dataset.dir)); return; }
    const f = e.target.closest('[data-file]');
    if (f) {
      const n = f.dataset.file;
      if (S.file.sel.has(n)) S.file.sel.delete(n); else S.file.sel.add(n);
      renderFilePanel();
    }
  });
  $('file-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const dir = e.target.closest('[data-dir]');
    if (dir) { navigateTo(joinPath(S.file.path, dir.dataset.dir)); return; }
    const f = e.target.closest('[data-file]');
    if (f) { const n = f.dataset.file; if (S.file.sel.has(n)) S.file.sel.delete(n); else S.file.sel.add(n); renderFilePanel(); }
  });
  $('btn-fback').addEventListener('click', () => {
    if (S.file.hi > 0) { S.file.hi--; S.file.path = S.file.hist[S.file.hi]; S.file.sel.clear(); renderFilePanel(); }
  });
  $('btn-ffwd').addEventListener('click', () => {
    if (S.file.hi < S.file.hist.length - 1) { S.file.hi++; S.file.path = S.file.hist[S.file.hi]; S.file.sel.clear(); renderFilePanel(); }
  });
  $('btn-fup').addEventListener('click', () => {
    const parent = S.file.path.split('/').slice(0, -1).join('/') || '/';
    if (FS[parent]) navigateTo(parent); else toast('（模拟）未提供更上层目录数据', 'warn');
  });
  $('btn-frefresh').addEventListener('click', () => toast('已刷新目录（模拟）'));
  $('btn-download').addEventListener('click', () => {
    const p = S.file;
    if (!p.sel.size) return;
    const dir = FS[p.path];
    p.sel.forEach((name) => {
      const f = dir && dir.files.find((x) => x[0] === name);
      S.drawer.tasks.push({
        id: uid(), dir: 'down', name,
        from: targetHostLabel() + ':' + p.path + '/' + name,
        to: '本机 Downloads/' + name,
        status: 'running', done: '0 / ' + (f ? f[1] : '—'), pct: 4,
      });
    });
    S.drawer.tasks.filter((t) => t.status === 'running').forEach(scheduleCompletion);
    S.drawer.open = true;
    toast('已创建 ' + p.sel.size + ' 个下载任务（模拟）');
    renderAll();
  });
  $('btn-upload').addEventListener('click', () => {
    const t = {
      id: uid(), dir: 'up', name: 'assets-20261006.tar.gz',
      from: '本机 ~/Downloads/assets-20261006.tar.gz',
      to: targetHostLabel() + ':' + S.file.path + '/assets-20261006.tar.gz',
      status: 'running', done: '2.1 / 12 MB', pct: 17,
    };
    S.drawer.tasks.push(t);
    scheduleCompletion(t);
    S.drawer.open = true;
    toast('原型：此处打开系统文件选择器（已模拟加入一个上传任务）');
    renderAll();
  });
  $('btn-file-more').addEventListener('click', () => {
    openMenu($('btn-file-more'), [
      { label: '按路径下载…', act: () => toast('输入远端绝对路径下载（R33 实现）') },
      { label: '定位到终端目录', act: () => toast('已定位到本次连接的可信 cwd（模拟）') },
      { label: '显示隐藏文件', act: () => toast('（模拟）切换显示隐藏项') },
      { label: '排序：名称 / 大小 / 修改时间', act: () => toast('（模拟）切换排序列') },
    ]);
  });

  $('btn-tools').addEventListener('click', () => {
    openMenu($('btn-tools'), [
      { label: '连接详情', icon: 'file', act: openConnDetails },
      { label: '端口转发', icon: 'arrow-right', act: openForwards },
      { label: '活动记录', icon: 'list', disabled: true, tip: 'R41 实现' },
      'sep',
      { label: '关闭会话', icon: 'x', kbd: '⌘W', act: () => { const fs = focusedSession(); if (fs) closeSession(fs.id); } },
    ]);
  });

  $('drawer-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-task]');
    if (!b) return;
    const t = S.drawer.tasks.find((x) => x.id === b.dataset.id);
    if (!t) return;
    if (b.dataset.task === 'cancel') {
      t.status = 'cancelling';
      after(600, () => { t.status = 'cancelled'; renderAll(); toast('任务已取消（模拟）'); });
      renderAll();
    }
    if (b.dataset.task === 'resolve') openConflict(t);
    if (b.dataset.task === 'retry') {
      t.status = 'running'; t.pct = 4; t.done = '0 / 24 MB';
      scheduleCompletion(t);
      renderAll();
      toast('已重新发起下载：将先核对远端文件状态（模拟）');
    }
    if (b.dataset.task === 'discard') {
      t.status = 'discarded';
      renderAll();
      toast('已丢弃任务；未确认远端状态，可重新发起下载', 'warn');
    }
  });
  $('sb-drawer-toggle').addEventListener('click', toggleDrawer);
  $('sb-transfers').addEventListener('click', toggleDrawer);
  $('btn-drawer-collapse').addEventListener('click', toggleDrawer);
  $('btn-drawer-x').addEventListener('click', toggleDrawer);
  $('sb-forwards').addEventListener('click', openForwards);

  window.addEventListener('resize', () => { updateFileMode(); fitDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('menu-root').children.length) { closeMenus(); return; }
    if (!$('overlay-root').hidden) { closeModal(); return; }
    if (!$('term-search').hidden) $('term-search').hidden = true;
  });
}

function hostMenu(anchor, id) {
  const h = S.hosts.find((x) => x.id === id);
  if (!h) return;
  openMenu(anchor, [
    { label: '新建会话（另建 shell）', act: () => connectHost(id, { forceNew: true }) },
    { label: '编辑', act: () => openHostForm(h) },
    { label: h.fav ? '取消收藏' : '收藏', act: () => { h.fav = !h.fav; renderSidebar(); } },
    'sep',
    {
      label: '删除主机', danger: true,
      act: () => {
        const m = openModal(
          '<div class="modal-head"><div><div class="modal-title">删除主机 · ' + esc(h.name) + '</div></div>' +
          '<button class="icon-btn modal-x" data-close aria-label="关闭"><span class="i" data-icon="x"></span></button></div>' +
          '<div class="modal-body"><div class="tb-body" style="color:var(--text-primary);font-size:13px;line-height:22px">删除配置不会停止已存在的会话，也不会删除被其他主机引用的凭据；活动标签将保留连接时的主机信息。</div></div>' +
          '<div class="modal-foot"><span class="foot-note">模拟确认。</span><button class="btn btn-secondary" data-close>取消</button><button class="btn btn-danger" id="del-go">删除</button></div>', { width: 480 });
        m.querySelector('#del-go').addEventListener('click', () => {
          S.hosts = S.hosts.filter((x) => x.id !== id);
          closeModal(); renderSidebar();
          toast('已删除主机配置（模拟）');
        });
      },
    },
  ]);
}

function toggleFiles() {
  S.file.open = !S.file.open;
  if (S.file.open) {
    updateFileMode();
    if (S.file.mode === 'full') toast('空间不足：文件以完整视图打开；未改变主机栏开关', 'warn');
  }
  renderAll();
}
function toggleDrawer() { S.drawer.open = !S.drawer.open; renderAll(); fitDrawer(); }

function navigateTo(path) {
  if (!FS[path]) { toast('（模拟）未提供该目录数据', 'warn'); return; }
  const p = S.file;
  p.hist = p.hist.slice(0, p.hi + 1); p.hist.push(p.path); p.hi = p.hist.length - 1;
  p.path = path; p.sel.clear();
  renderFilePanel();
}
function joinPath(base, seg) { return (base === '/' ? '' : base) + '/' + seg; }

function openLocalTerminal() {
  const s = { id: uid(), kind: 'local', status: 'connected', screen: 'local' };
  S.sessions.push(s);
  S.active = s.id; S.view = 'session';
  renderAll();
  toast('已打开本地终端：不伪装为远端主机（模拟）');
}

/* ---------- 启动 ---------- */

wire();
const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
const getParam = (k) => hashParams.get(k) || params.get(k) || (window['__R01_' + k.toUpperCase()] || null);
const wantScenario = getParam('s') || getParam('scenario');
const okKey = SCENARIOS.some((g) => g.items.some((i) => i.key === wantScenario));
applyScenario(okKey ? wantScenario : 'files', true);
if (getParam('theme') === 'light' || getParam('theme') === 'dark') {
  S.theme = getParam('theme');
  renderChrome();
}
