/* Core helpers: API, formatting, toasts, modals, live updates */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const Pages = {};
const store = {
  runs: new Map(),      // active runs: id -> snapshot
  settings: null,
  devices: null,
  info: null,
  connected: false,
  listeners: {},
};

/* ---------- events ---------- */
function on(evt, fn) { (store.listeners[evt] ||= new Set()).add(fn); return () => store.listeners[evt].delete(fn); }
function emit(evt, data) { (store.listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(message, status, detail) { super(message); this.status = status; this.detail = detail; }
}
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch (e) { throw new ApiError('Cannot reach the attendance sync service. Is it running?', 0); }
  if (res.status === 401 && !path.startsWith('/auth')) { showLogin(); throw new ApiError('Login required', 401); }
  if (raw) { if (!res.ok) throw new ApiError(await errText(res), res.status); return res; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    let msg = (data && data.detail) || res.statusText || 'Request failed';
    if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('; ');
    throw new ApiError(msg, res.status, data && data.error_detail);
  }
  return data;
}
async function errText(res) { try { const d = await res.json(); return d.detail || res.statusText; } catch { return res.statusText; } }

async function download(path, body, fallbackName) {
  const res = await api(path, { method: body ? 'POST' : 'GET', body, raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^"]+)"?/);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- formatting ---------- */
function fmtBytes(n, digits = 1) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : digits)} ${u[i]}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString(); }
function fmtDuration(s) {
  if (s == null || isNaN(s)) return '—';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
function parseTs(ts) { return ts ? new Date(String(ts).replace(' ', 'T')) : null; }
function fmtDate(ts, withSeconds = false) {
  const d = parseTs(ts); if (!d || isNaN(d)) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}
function fmtTime(ts) { const d = parseTs(ts); return d && !isNaN(d) ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
function fmtDay(ts) { const d = parseTs(ts); return d && !isNaN(d) ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—'; }
function fmtRelative(ts) {
  const d = parseTs(ts); if (!d || isNaN(d)) return 'never';
  const diff = (Date.now() - d.getTime()) / 1000, fut = diff < 0, a = Math.abs(diff);
  let out;
  if (a < 45) out = 'just now';
  else if (a < 3600) out = `${Math.round(a / 60)} min`;
  else if (a < 86400) out = `${Math.round(a / 3600)} h`;
  else out = `${Math.round(a / 86400)} d`;
  if (out === 'just now') return out;
  return fut ? `in ${out}` : `${out} ago`;
}
function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const triggerLabel = (t) => ({ manual: 'Manual', schedule: 'Scheduled', shortcut: 'Shortcut', startup: 'At startup', retry: 'Retry' }[t] || t);
const directionLabel = (d) => ({ AUTO: 'Auto (from machine key)', IN: 'Always IN', OUT: 'Always OUT', NONE: 'Not set (ERPNext decides)' }[d] || d);
const REASONS = {
  duplicate: 'Already in ERPNext',
  unknown_employee: 'No employee with this ID',
  inactive_employee: 'Employee inactive',
  validation: 'Rejected by ERPNext',
  future_time: 'Time in the future',
  repeat: 'Repeated punch',
  manual: 'Skipped by user',
  network: 'ERPNext unreachable',
  server: 'ERPNext server error',
  rate_limit: 'Rate limited',
  auth: 'API key rejected',
  permission: 'No permission',
  not_found_endpoint: 'API method not found',
};
const reasonLabel = (r) => REASONS[r] || r || '';

const STATUS = {
  success: ['success', 'checkCircle', 'Success'],
  partial: ['warning', 'alert', 'Partial'],
  failed: ['danger', 'xCircle', 'Failed'],
  cancelled: ['', 'stop', 'Cancelled'],
  running: ['primary', 'loader', 'Running'],
  queued: ['', 'clock', 'Queued'],
  connecting: ['primary', 'loader', 'Connecting'],
  fetching: ['info', 'download', 'Reading'],
  pushing: ['primary', 'send', 'Sending'],
  clearing: ['warning', 'loader', 'Clearing'],
  done: ['success', 'checkCircle', 'Done'],
  // machines
  online: ['success', 'wifi', 'Online'],
  offline: ['danger', 'wifiOff', 'Offline'],
  unknown: ['', 'help', 'Not checked'],
  error: ['danger', 'alert', 'Error'],
  // punches
  pending: ['info', 'clock', 'Pending'],
  retrying: ['warning', 'refresh', 'Retrying'],
  synced: ['success', 'checkCircle', 'Synced'],
  skipped: ['', 'skip', 'Skipped'],
};
function statusBadge(status, text) {
  const [cls, ic, label] = STATUS[status] || ['', 'info', status];
  const spin = ['loader'].includes(ic) ? 'spin' : '';
  return `<span class="badge ${cls}">${icon(ic, spin)}${esc(text || label)}</span>`;
}
function punchBadge(p) {
  if (p.sync_status === 'pending' && p.attempts > 0) return statusBadge('retrying', `Retry ${p.attempts}`);
  if (p.sync_status === 'synced' && p.reason === 'duplicate') return statusBadge('synced', 'Already there');
  return statusBadge(p.sync_status);
}
function levelBadge(level) { return `<span class="lv lv-${esc(level)}">${esc(level)}</span>`; }

/* ---------- toasts ---------- */
function toast(message, type = 'info', title = '', ms = 5000) {
  const ic = { success: 'checkCircle', error: 'xCircle', warning: 'alert', info: 'info' }[type] || 'info';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(ic)}<div>${title ? `<div class="t">${esc(title)}</div>` : ''}<div>${esc(message)}</div></div><button class="x" aria-label="Close">&times;</button>`;
  $('#toasts').appendChild(el);
  const close = () => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 200); };
  el.querySelector('.x').onclick = close;
  if (ms) setTimeout(close, type === 'error' ? ms * 2 : ms);
}
function toastError(e, title = 'Error') {
  if (e && e.detail) { toast(e.message, 'error', title); return; }
  toast(e && e.message ? e.message : String(e), 'error', title);
}

/* ---------- modals ---------- */
function openModal({ title, body = '', foot = '', size = '', onClose, icon: ic } = {}) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">${ic ? `<span class="stat-icon" style="width:34px;height:34px">${icon(ic)}</span>` : ''}<h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', keyh); onClose && onClose(); };
  const keyh = (e) => { if (e.key === 'Escape' && root.lastElementChild === wrap) close(); };
  document.addEventListener('keydown', keyh);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap._down = true; });
  wrap.addEventListener('mouseup', (e) => { if (e.target === wrap && wrap._down) close(); wrap._down = false; });
  wrap.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  root.appendChild(wrap);
  const first = wrap.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { el: wrap, body: wrap.querySelector('.modal-body'), close };
}

function confirmDialog({ title = 'Are you sure?', message = '', confirm = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, icon: danger ? 'alert' : 'help',
      body: `<p style="margin:0;color:var(--text-2)">${message}</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirm)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.el.querySelector('[data-ok]').onclick = () => { done = true; m.close(); resolve(true); };
  });
}

function promptDialog({ title, label, value = '', type = 'text', placeholder = '', hint = '', confirm = 'OK' }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title,
      body: `<div class="field"><label>${esc(label)}</label><input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>${esc(confirm)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const inp = m.el.querySelector('input');
    const ok = () => { done = true; const v = inp.value; m.close(); resolve(v); };
    m.el.querySelector('[data-ok]').onclick = ok;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  });
}

function errorDetailsDialog(title, message, detail) {
  openModal({
    title, icon: 'xCircle', size: 'wide',
    body: `<div class="alert danger">${icon('xCircle')}<div>${esc(message)}</div></div>
      ${detail ? `<h3 class="mt-3 mb-1">Technical details</h3><pre>${esc(detail)}</pre>` : ''}`,
    foot: `${detail ? `<button class="btn" data-copy>${icon('copy')} Copy details</button>` : ''}<button class="btn btn-primary" data-close>Close</button>`,
  }).el.querySelector('[data-copy]')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(`${message}\n\n${detail || ''}`).then(() => toast('Copied to clipboard', 'success'));
  });
}
function showApiError(e, title = 'Error') {
  if (e && e.detail) errorDetailsDialog(title, e.message, e.detail); else toastError(e, title);
}

/* ---------- live updates (WebSocket) ---------- */
let ws = null, wsRetry = 1000;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsRetry = 1000; store.connected = true; emit('connection', true); };
  ws.onclose = (e) => {
    store.connected = false; emit('connection', false);
    if (e.code === 4401) { showLogin(); return; }
    setTimeout(connectWS, wsRetry); wsRetry = Math.min(wsRetry * 1.7, 15000);
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      store.runs.clear();
      (msg.runs || []).forEach((r) => store.runs.set(r.id, normalizeRun(r)));
      emit('runs');
      break;
    case 'run_started':
      store.runs.set(msg.run.id, normalizeRun(msg.run));
      emit('runs'); emit('run_started', msg.run);
      break;
    case 'task': {
      const t = msg.task, r = store.runs.get(t.run_id);
      if (r) { const isNew = !r.tasks.has(t.id); r.tasks.set(t.id, t); emit(isNew ? 'runs' : 'task', t); }
      break;
    }
    case 'run_cancelling': {
      const r = store.runs.get(msg.run_id); if (r) { r.cancelling = true; emit('runs'); }
      break;
    }
    case 'run_stage': {
      const r = store.runs.get(msg.run_id); if (r) { r.stage = msg.stage; emit('run_meta', r); }
      break;
    }
    case 'run_erp_blocked': {
      const r = store.runs.get(msg.run_id); if (r) { r.erp_blocked = msg.reason; emit('run_meta', r); }
      break;
    }
    case 'run_finished': {
      const r = store.runs.get(msg.run_id);
      if (r) { r.finished = msg.status; r.summary = msg.summary; }
      emit('run_finished', msg);
      const quiet = r && ['schedule', 'startup'].includes(r.trigger) && msg.status === 'success';
      if (!quiet) {
        const type = { success: 'success', partial: 'warning', cancelled: 'warning' }[msg.status] || 'error';
        toast(msg.summary, type, 'Sync finished', 9000);
      }
      setTimeout(() => { store.runs.delete(msg.run_id); emit('runs'); }, 60000);
      emit('runs');
      break;
    }
    case 'device':
      emit('device', msg.device);
      break;
    case 'log':
      emit('log', msg.log);
      break;
  }
}
function normalizeRun(r) {
  return { ...r, tasks: new Map((r.tasks || []).map((t) => [t.id, t])) };
}
function activeRuns() { return [...store.runs.values()].filter((r) => !r.finished); }

/* ---------- common UI bits ---------- */
function emptyState(ic, title, text = '', action = '') {
  return `<div class="empty">${icon(ic)}<div class="t">${esc(title)}</div><div>${text}</div>${action ? `<div class="mt-2">${action}</div>` : ''}</div>`;
}
function switchHtml(name, checked, label = '', sub = '') {
  return `<label class="switch"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}><span class="track"></span>${label ? `<span class="txt"><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</span>` : ''}</label>`;
}
function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) { btn._html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `${icon('loader', 'spin')} ${esc(text || 'Working…')}`; }
  else { btn.disabled = false; if (btn._html) btn.innerHTML = btn._html; }
}
function throttle(fn, ms) {
  let t = 0, timer = null;
  return (...a) => {
    const now = Date.now();
    if (now - t >= ms) { t = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; t = Date.now(); fn(...a); }, ms - (now - t));
  };
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function loadDevices() { store.devices = await api('/devices'); return store.devices; }
async function loadSettings() { store.settings = await api('/settings'); return store.settings; }
