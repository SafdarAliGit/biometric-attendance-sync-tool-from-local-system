/* Live progress of running syncs */
'use strict';

Pages.progress = {
  title: 'Live Progress',
  async render(view) {
    view.innerHTML = `<div class="stack"><div id="runs-box" class="stack"></div>
      <div class="card"><div class="card-head"><h3>${icon('terminal', '')} Live activity log</h3><a class="btn btn-sm btn-ghost" href="#/logs">Open full logs</a></div>
      <div class="live-log" id="live-log"><div class="muted">Waiting for activity…</div></div></div></div>`;
    const logBox = $('#live-log');
    let logCount = 0;
    const addLog = (l) => {
      if (logCount === 0) logBox.innerHTML = '';
      logCount++;
      const d = document.createElement('div');
      d.className = 'l';
      d.innerHTML = `<span class="ts">${fmtTime(l.ts)}</span>${levelBadge(l.level)}<span>${l.device ? `<b>${esc(l.device)}</b> ` : ''}${l.employee ? `<span class="muted">ID ${esc(l.employee)}</span> ` : ''}${esc(l.message)}</span>`;
      if (l.detail && ['ERROR', 'WARNING'].includes(l.level)) { d.style.cursor = 'pointer'; d.title = 'Click for details'; d.onclick = () => errorDetailsDialog('Details', l.message, l.detail); }
      logBox.appendChild(d);
      while (logBox.children.length > 300) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    };
    try {
      const recent = await api('/logs?limit=60');
      recent.rows.slice().reverse().forEach((l) => addLog(l));
    } catch (e) { /* ignore */ }

    const drawAll = () => {
      const box = $('#runs-box'); if (!box) return;
      const runs = [...store.runs.values()].sort((a, b) => b.id - a.id);
      if (!runs.length) {
        box.innerHTML = `<div class="card">${emptyState('activity', 'No sync is running', 'The progress of every machine appears here in real time: reading punches from the machine, then sending them to ERPNext.', `<button class="btn btn-primary btn-lg" id="pg-start">${icon('refresh')} Sync Now</button>`)}</div>`;
        $('#pg-start').onclick = () => openSyncDialog();
        return;
      }
      box.innerHTML = runs.map(runCard).join('');
      runs.forEach(bindRun);
    };
    const updTask = (t) => {
      const el = document.getElementById('task-' + t.id);
      if (!el) return drawAll();
      el.outerHTML = taskRow(t);
      bindTask(t);
      const r = store.runs.get(t.run_id);
      if (r) updateOverall(r);
    };
    const updMeta = (r) => {
      const el = document.getElementById(`run-meta-${r.id}`);
      if (el) el.innerHTML = runMeta(r); else drawAll();
    };
    drawAll();
    const timer = setInterval(() => {
      $$('[data-elapsed]').forEach((e) => { e.textContent = fmtDuration((Date.now() - parseTs(e.dataset.elapsed)) / 1000); });
    }, 1000);
    const offs = [on('runs', drawAll), on('task', updTask), on('run_meta', updMeta), on('log', (l) => addLog(l)), on('run_finished', drawAll)];
    return () => { clearInterval(timer); offs.forEach((f) => f()); };
  },
};

const TASK_DONE = ['success', 'failed', 'partial', 'cancelled'];

function runTotals(r) {
  const tasks = [...r.tasks.values()];
  const done = tasks.filter((t) => TASK_DONE.includes(t.status)).length;
  const ok = tasks.filter((t) => t.status === 'success').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const sum = (k) => tasks.reduce((a, t) => a + (t[k] || 0), 0);
  // weight each machine: reading = 0-40%, sending = 40-100%
  const full = r.mode !== 'push';
  let progress = 0;
  tasks.forEach((t) => {
    if (TASK_DONE.includes(t.status)) { progress += 1; return; }
    let p = 0;
    if (full) {
      if (['done', 'failed'].includes(t.fetch_status)) p = 0.4;
      else if (t.fetch_status === 'running') p = 0.15;
    }
    const base = full ? 0.4 : 0;
    if (t.push_status === 'running' && t.to_push) p = base + (1 - base) * ((t.pushed + t.skipped + t.push_failed) / t.to_push);
    progress += Math.min(p, 0.99);
  });
  const pct = tasks.length ? Math.round((progress / tasks.length) * 100) : 0;
  return { tasks, done, ok, failed, pct, fetched: sum('fetched'), fresh: sum('new_punches'), pushed: sum('pushed'), skipped: sum('skipped'), pushFailed: sum('push_failed') };
}

function runMeta(r) {
  return `${r.erp_blocked ? `<div class="alert warning" style="margin:0 20px 14px">${icon('cloudOff')}<div><div class="t">Sending to ERPNext is paused for this run</div>${esc(r.erp_blocked)}. Nothing is lost: the punches are kept on this PC and sent on the next run.</div></div>` : ''}
    ${r.stage === 'shifts' && !r.finished ? `<div class="alert info" style="margin:0 20px 14px">${icon('loader', 'spin')}<div>Updating Shift Type “Last Sync of Checkin” in ERPNext…</div></div>` : ''}`;
}

function overallText(r, tt) {
  return `<b>${tt.done}</b> of <b>${tt.tasks.length || '…'}</b> machines done${r.mode !== 'push' ? ` · ${fmtNum(tt.fetched)} read · <b>${fmtNum(tt.fresh)}</b> new` : ''} · <span class="st-success">${fmtNum(tt.pushed)} sent</span>${tt.skipped ? ` · ${fmtNum(tt.skipped)} skipped` : ''}${tt.pushFailed ? ` · <span class="st-failed">${fmtNum(tt.pushFailed)} to retry</span>` : ''}${tt.failed ? ` · <span class="st-failed">${tt.failed} machine(s) offline</span>` : ''}`;
}

function runCard(r) {
  const tt = runTotals(r);
  const finished = r.finished;
  const tasks = tt.tasks.slice().sort((a, b) => a.device_name.localeCompare(b.device_name));
  return `
  <div class="card run-card" id="run-${r.id}">
    <div class="run-head">
      <div class="stat-icon ${finished ? (finished === 'success' ? 'success' : finished === 'failed' ? 'danger' : 'warning') : ''}">${icon(finished ? (finished === 'success' ? 'checkCircle' : 'alert') : 'activity')}</div>
      <div class="title"><h2>${r.mode === 'push' ? 'Send pending punches' : 'Sync run'} #${r.id}</h2>
        <div class="muted small">${esc(triggerLabel(r.trigger))} · started ${fmtTime(r.started_at)}
          ${finished ? '' : ` · elapsed <span data-elapsed="${esc(r.started_at)}">${fmtDuration((Date.now() - parseTs(r.started_at)) / 1000)}</span>`}</div></div>
      ${finished ? statusBadge(finished) : r.cancelling ? `<span class="badge warning">${icon('loader', 'spin')} Cancelling…</span>` :
        `<button class="btn btn-soft-danger" data-cancel-run="${r.id}">${icon('stop')} Cancel</button>`}
    </div>
    <div class="run-overall">
      <div class="row mb-1"><span id="ov-text-${r.id}">${overallText(r, tt)}</span><span id="ov-pct-${r.id}" class="strong">${tt.pct}%</span></div>
      <div class="bar bar-lg ${finished ? (finished === 'success' ? 'done' : '') : 'striped'}" id="ov-bar-${r.id}"><span style="width:${finished ? 100 : tt.pct}%"></span></div>
      ${finished && r.summary ? `<div class="small mt-1">${esc(r.summary)}</div>` : ''}
    </div>
    <div id="run-meta-${r.id}" style="padding-top:${r.erp_blocked || r.stage === 'shifts' ? '14px' : '0'}">${runMeta(r)}</div>
    ${tasks.map(taskRow).join('')}
    ${!tasks.length ? `<div class="task dev"><div class="muted small">No machines in this run</div></div>` : ''}
  </div>`;
}

function updateOverall(r) {
  const tt = runTotals(r);
  const txt = document.getElementById('ov-text-' + r.id);
  if (txt) txt.innerHTML = overallText(r, tt);
  const p = document.getElementById('ov-pct-' + r.id); if (p) p.textContent = tt.pct + '%';
  const b = document.querySelector(`#ov-bar-${r.id} > span`); if (b) b.style.width = tt.pct + '%';
}

function taskRow(t) {
  const st = t.status;
  const fin = TASK_DONE.includes(st);

  // stage 1: read machine
  let c1cls = '', c1w = 0, c1r = 'waiting';
  if (t.fetch_status === 'skipped') { c1r = 'not needed (send only)'; }
  else if (t.fetch_status === 'done') { c1cls = 'done'; c1w = 100; c1r = `${fmtNum(t.fetched)} read · ${fmtNum(t.new_punches)} new · ${fmtDuration(t.fetch_seconds)}`; }
  else if (t.fetch_status === 'running') {
    c1cls = 'indeterminate';
    c1r = st === 'connecting' ? 'connecting…' : (t.records != null ? `reading ${fmtNum(t.records)} records…` : 'reading…');
    if (t.fetch_started_at) c1r += ` ${fmtDuration((Date.now() - parseTs(t.fetch_started_at)) / 1000)}`;
  } else if (t.fetch_status === 'failed') { c1cls = 'failed'; c1w = 100; c1r = 'machine not reachable'; }
  else if (st === 'cancelled') c1r = 'cancelled';

  // stage 2: send to ERPNext
  let c2cls = '', c2w = 0, c2r = 'waiting';
  const handled = (t.pushed || 0) + (t.skipped || 0) + (t.push_failed || 0);
  if (t.push_status === 'running') {
    c2cls = 'striped'; c2w = t.to_push ? (handled / t.to_push) * 100 : 0;
    c2r = `${fmtNum(handled)} / ${fmtNum(t.to_push)}`;
  } else if (t.push_status === 'done') {
    c2cls = 'done'; c2w = 100;
    c2r = t.to_push ? `${fmtNum(t.pushed)} sent${t.skipped ? ` · ${fmtNum(t.skipped)} skipped` : ''}${t.push_seconds != null ? ' · ' + fmtDuration(t.push_seconds) : ''}` : 'nothing to send';
  } else if (t.push_status === 'partial') {
    c2cls = ''; c2w = t.to_push ? (handled / t.to_push) * 100 : 100;
    c2r = `${fmtNum(t.pushed)} sent · ${fmtNum(t.push_failed)} to retry`;
  } else if (t.push_status === 'paused') { c2cls = 'failed'; c2w = 100; c2r = `paused · ${fmtNum(t.to_push - handled)} kept`; }
  else if (st === 'cancelled') c2r = 'cancelled';

  const stIcon = { success: 'checkCircle', failed: 'xCircle', partial: 'alert', cancelled: 'stop', connecting: 'loader', fetching: 'download', pushing: 'send', clearing: 'loader', queued: 'clock' }[st] || 'clock';
  const isErr = st === 'failed' || t.fetch_status === 'failed';
  const msg = isErr && t.error ? `<div class="msg err">${icon('alert', '')} ${esc(t.error)} ${t.pushed ? `<span class="muted">(${fmtNum(t.pushed)} stored punch(es) were still sent)</span>` : ''} <a href="javascript:void(0)" data-err="${t.id}">details</a></div>`
    : t.message ? `<div class="msg ${t.push_status === 'paused' || st === 'partial' ? '' : 'muted'}" ${t.push_status === 'paused' || st === 'partial' ? 'style="color:var(--warning)"' : ''}>${icon(fin ? 'info' : 'chevron', '')} ${esc(t.message)}${t.attempts > 1 && !fin ? ` <span class="badge warning">attempt ${t.attempts}</span>` : ''}</div>` : '';

  return `<div class="task dev" id="task-${t.id}">
    <div class="site"><div class="n st-${['connecting', 'fetching', 'pushing', 'clearing'].includes(st) ? 'running' : st}">${icon(stIcon, ['connecting', 'clearing'].includes(st) ? 'spin' : '')}<span class="truncate" style="color:var(--text)">${esc(t.device_name)}</span></div>
      <div class="b">${esc(t.ip)} · ${esc(t.device_id)}${t.cleared ? ' · <span class="badge warning">log cleared</span>' : ''}</div></div>
    <div class="stage"><div class="label"><span>${icon('download', '')} Reading machine</span><span class="r">${esc(c1r)}</span></div><div class="bar ${c1cls}"><span style="width:${c1w}%"></span></div></div>
    <div class="stage"><div class="label"><span>${icon('cloud', '')} Sending to ERPNext</span><span class="r">${esc(c2r)}</span></div><div class="bar ${c2cls}"><span style="width:${c2w}%"></span></div></div>
    <div class="task-actions">${fin ? statusBadge(st) : statusBadge(st)}</div>
    ${msg}
  </div>`;
}

function bindTask(t) {
  const el = document.getElementById('task-' + t.id); if (!el) return;
  const d = el.querySelector('[data-err]');
  if (d) d.onclick = async () => {
    try { const r = await api(`/runs/${t.run_id}`); const tk = r.tasks.find((x) => x.id === t.id); errorDetailsDialog(`${t.device_name}: problem`, tk?.error || t.error, tk?.error_detail); }
    catch (e) { errorDetailsDialog(`${t.device_name}: problem`, t.error, ''); }
  };
}

function bindRun(r) {
  const card = document.getElementById('run-' + r.id); if (!card) return;
  const c = card.querySelector('[data-cancel-run]');
  if (c) c.onclick = async () => {
    if (!await confirmDialog({ title: 'Cancel this sync?', message: 'Machines being read finish their current step; the rest is skipped. Everything already read stays stored on this PC and is sent on the next run.', confirm: 'Cancel sync', danger: true })) return;
    try { await api(`/runs/${r.id}/cancel`, { method: 'POST' }); } catch (e) { toastError(e); }
  };
  r.tasks.forEach((t) => bindTask(t));
}
