/* App shell, router, login, start-sync dialog */
'use strict';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'devices', label: 'Machines', icon: 'fingerprint' },
  { id: 'progress', label: 'Live Progress', icon: 'activity' },
  { id: 'punches', label: 'Punches', icon: 'list' },
  { id: 'employees', label: 'Employee Mapping', icon: 'users' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'stats', label: 'Statistics', icon: 'chart' },
  { section: 'System' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'help', label: 'Help & Guide', icon: 'help' },
];

let currentCleanup = null;

function renderShell() {
  $('#root').innerHTML = `
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <div class="brand-logo">${icon('fingerprint')}</div>
        <div><div class="brand-name">Attendance Sync</div><div class="brand-sub">Biometric → ERPNext</div></div>
      </div>
      <nav class="nav">
        ${NAV.map((n) => n.section ? `<div class="nav-label">${n.section}</div>` :
          `<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${n.label}</span>${n.id === 'progress' ? '<span class="badge-dot hidden" id="nav-running"></span>' : ''}${n.id === 'punches' ? '<span class="nav-count hidden" id="nav-failed"></span>' : ''}</a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <span class="ver" id="app-version"></span>
        <button class="icon-btn" id="theme-btn" title="Toggle dark mode"></button>
        <button class="icon-btn hidden" id="logout-btn" title="Log out">${icon('logout')}</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
        <h1 id="page-title"></h1>
        <span class="status-pill" id="status-pill"><span class="dot"></span><span class="t">Idle</span></span>
        <button class="btn btn-primary" id="start-btn">${icon('refresh')} <span>Sync Now</span></button>
      </header>
      <div class="view" id="view"></div>
    </div>
  </div>`;
  $('#theme-btn').onclick = toggleTheme;
  updateThemeIcon();
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#start-btn').onclick = () => openSyncDialog();
  $('#status-pill').onclick = () => { if (activeRuns().length) location.hash = '#/progress'; };
  $('#logout-btn').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };
  on('runs', updateStatusPill);
  on('task', throttle(updateStatusPill, 1000));
  on('connection', updateStatusPill);
  on('run_finished', () => setTimeout(updateFailedBadge, 1000));
  updateStatusPill();
  updateFailedBadge();
}

async function updateFailedBadge() {
  try {
    const r = await api('/punches?limit=1&status=failed');
    const el = $('#nav-failed'); if (!el) return;
    const n = r.counts.failed || 0;
    el.textContent = n > 999 ? '999+' : n;
    el.classList.toggle('hidden', !n);
    el.title = `${n} punch(es) failed and need attention`;
  } catch (e) { /* ignore */ }
}

function updateStatusPill() {
  const pill = $('#status-pill'); if (!pill) return;
  const runs = activeRuns();
  pill.classList.remove('running', 'offline');
  const dot = $('#nav-running');
  if (!store.connected) {
    pill.classList.add('offline'); pill.querySelector('.t').textContent = 'Reconnecting…';
  } else if (runs.length) {
    pill.classList.add('running');
    const tasks = runs.flatMap((r) => [...r.tasks.values()]);
    const done = tasks.filter((t) => ['success', 'failed', 'partial', 'cancelled'].includes(t.status)).length;
    pill.querySelector('.t').textContent = `Syncing · ${done}/${tasks.length || '…'} machines`;
  } else {
    pill.querySelector('.t').textContent = 'Idle';
  }
  dot && dot.classList.toggle('hidden', !runs.length);
  const sb = $('#start-btn');
  if (sb) sb.disabled = runs.length > 0;
}

function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('bas-theme', t); } catch (e) {}
  updateThemeIcon();
  emit('theme', t);
}
function updateThemeIcon() {
  const b = $('#theme-btn'); if (!b) return;
  b.innerHTML = icon(document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon');
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, ...rest] = hash.split('/');
  const p = Pages[page] || Pages.dashboard;
  const id = Pages[page] ? page : 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
  $('#sidebar')?.classList.remove('open');
  if (currentCleanup) { try { currentCleanup(); } catch (e) {} currentCleanup = null; }
  $('#page-title').textContent = p.title;
  document.title = `${p.title} · Attendance Sync`;
  const view = $('#view');
  view.innerHTML = '';
  window.scrollTo(0, 0);
  Promise.resolve(p.render(view, rest.map(decodeURIComponent))).then((cleanup) => { currentCleanup = cleanup || null; })
    .catch((e) => { view.innerHTML = `<div class="alert danger">${icon('xCircle')}<div><div class="t">Could not load this page</div>${esc(e.message)}</div></div>`; });
}

/* ---------- login ---------- */
let loginShown = false;
function showLogin() {
  if (loginShown) return; loginShown = true;
  $('#root').innerHTML = `
    <div class="login-wrap"><div class="card login-card">
      <div class="brand"><div class="brand-logo">${icon('fingerprint')}</div><div><div class="brand-name">Biometric Attendance Sync</div><div class="brand-sub">Enter the admin password to continue</div></div></div>
      <form id="login-form" class="stack">
        <div class="field"><label>Password</label><input class="input" type="password" name="password" autocomplete="current-password" autofocus required></div>
        <div class="alert danger hidden" id="login-err">${icon('xCircle')}<div></div></div>
        <button class="btn btn-primary btn-lg" type="submit">${icon('lock')} Log in</button>
      </form>
    </div></div>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); setBusy(btn, true, 'Checking…');
    try {
      await api('/auth/login', { method: 'POST', body: { password: e.target.password.value } });
      location.reload();
    } catch (err) {
      setBusy(btn, false);
      const box = $('#login-err'); box.classList.remove('hidden'); box.querySelector('div').textContent = err.message;
    }
  };
}

/* ---------- start-sync dialog ---------- */
async function openSyncDialog(pre = {}) {
  let devices;
  try { devices = await loadDevices(); } catch (e) { return toastError(e); }
  if (!devices.length) {
    const ok = await confirmDialog({ title: 'No machines yet', message: 'Add a biometric machine before syncing.', confirm: 'Add machine' });
    if (ok) { location.hash = '#/devices'; setTimeout(() => Pages.devices.openEditor && Pages.devices.openEditor(), 200); }
    return;
  }
  const preIds = pre.deviceIds ? new Set(pre.deviceIds) : null;
  const pendingTotal = devices.reduce((a, d) => a + d.stats.pending, 0);
  const m = openModal({
    title: 'Sync attendance', icon: 'refresh', size: 'wide',
    body: `
      <div class="field mb-3"><label>What to do</label>
        <div class="radio-cards" id="sync-mode">
          <label class="radio-card active"><input type="radio" name="mode" value="full" checked><div><div class="t">${icon('download', '')} Read machines &amp; send</div><div class="d">Reads new punches from the selected machines, stores them on this PC, then sends everything pending to ERPNext.</div></div></label>
          <label class="radio-card"><input type="radio" name="mode" value="push"><div><div class="t">${icon('send', '')} Only send pending</div><div class="d">Does not contact the machines. Sends the ${fmtNum(pendingTotal)} punch(es) waiting on this PC.</div></div></label>
        </div>
      </div>
      <div class="row mb-1"><span class="label">Machines</span><span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-all>Select all</button><button class="btn btn-sm btn-ghost" data-none>Select none</button></div>
      <div class="tree">${devices.map((d) => `
        <label class="tree-row srv" style="cursor:pointer">
          <input type="checkbox" data-dev="${d.id}" ${(preIds ? preIds.has(d.id) : d.enabled) ? 'checked' : ''}>
          <span class="n truncate">${icon('fingerprint', '')} ${esc(d.name)} <span class="muted small">${esc(d.ip)}</span> ${d.enabled ? '' : '<span class="badge outline">disabled</span>'}</span>
          <span class="small">${statusBadge(d.status)}${d.stats.pending ? ` <span class="badge info">${fmtNum(d.stats.pending)} pending</span>` : ''}</span>
        </label>`).join('')}</div>
      <details class="mt-3" id="resync-box" ${pre.resync ? 'open' : ''}><summary class="strong small" style="cursor:pointer">${icon('history', '')} Re-send a date range (advanced)</summary>
        <div class="hint mt-1">Queues the punches already stored on this PC for this period again, e.g. after check-ins were deleted in ERPNext. Punches already in ERPNext are recognised as duplicates, so nothing is created twice.</div>
        <div class="form-grid mt-2"><div class="field"><label>From</label><input class="input" type="date" name="rs_from" value="${esc(pre.from || '')}"></div><div class="field"><label>To</label><input class="input" type="date" name="rs_to" value="${esc(pre.to || '')}"></div></div>
      </details>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-go>${icon('refresh')} Start sync</button>`,
  });
  const cards = m.el.querySelectorAll('#sync-mode .radio-card');
  cards.forEach((c) => c.querySelector('input').addEventListener('change', () => cards.forEach((x) => x.classList.toggle('active', x.querySelector('input').checked))));
  m.el.querySelector('[data-all]').onclick = () => m.el.querySelectorAll('[data-dev]').forEach((c) => (c.checked = true));
  m.el.querySelector('[data-none]').onclick = () => m.el.querySelectorAll('[data-dev]').forEach((c) => (c.checked = false));
  m.el.querySelector('[data-go]').onclick = async (ev) => {
    const ids = [...m.el.querySelectorAll('[data-dev]')].filter((c) => c.checked).map((c) => Number(c.dataset.dev));
    if (!ids.length) return toast('Select at least one machine.', 'warning');
    const body = { device_ids: ids, push_only: m.el.querySelector('[name=mode]:checked').value === 'push' };
    const f = m.el.querySelector('[name=rs_from]').value, t = m.el.querySelector('[name=rs_to]').value;
    if (f || t) { body.resync_from = f || null; body.resync_to = t || null; }
    const btn = ev.currentTarget; setBusy(btn, true, 'Starting…');
    try {
      await api('/runs', { method: 'POST', body });
      m.close();
      toast('The sync has started.', 'success');
      location.hash = '#/progress';
    } catch (e) { setBusy(btn, false); toastError(e, 'Could not start the sync'); }
  };
}

async function quickSync(deviceIds = null) {
  try {
    await api('/runs', { method: 'POST', body: deviceIds ? { device_ids: deviceIds } : {} });
    toast('The sync has started.', 'success');
    location.hash = '#/progress';
  } catch (e) { toastError(e, 'Could not start the sync'); }
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const st = await api('/auth/status');
    if (st.required && !st.authenticated) return showLogin();
    renderShell();
    if (st.required) $('#logout-btn').classList.remove('hidden');
    store.info = await api('/info');
    $('#app-version').textContent = 'v' + store.info.version;
    connectWS();
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    $('#root').innerHTML = `<div class="login-wrap"><div class="card login-card"><div class="alert danger">${icon('xCircle')}<div><div class="t">The attendance sync service is not reachable</div>${esc(e.message)}<div class="mt-2"><button class="btn btn-sm" onclick="location.reload()">${icon('refresh')} Retry</button></div></div></div></div></div>`;
  }
}
document.addEventListener('DOMContentLoaded', boot);
