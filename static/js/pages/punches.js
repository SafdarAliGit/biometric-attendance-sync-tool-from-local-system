/* Punches: the local attendance ledger */
'use strict';

Pages.punches = {
  title: 'Punches',
  async render(view, args) {
    const f = { status: '', device: '', q: '', date_from: '', date_to: '', reason: '', user_id: '' };
    if (['pending', 'retrying', 'synced', 'skipped', 'failed'].includes(args[0])) f.status = args[0];
    if (args[0] === 'device' && args[1]) f.device = args[1];
    if (args[0] === 'user' && args[1]) f.user_id = args[1];
    let devices = [];
    try { devices = await loadDevices(); } catch (e) { /* ignore */ }
    const limit = 100;
    let offset = 0, total = 0, rows = [];
    const selected = new Set();
    view.innerHTML = `
      <div class="stack">
        <div class="status-chips" id="p-chips"></div>
        <div class="card">
          <div class="filters">
            <select class="input" id="pf-device" style="max-width:200px"><option value="">All machines</option>${devices.map((d) => `<option value="${d.id}" ${String(f.device) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
            <input class="input" type="date" id="pf-from" style="max-width:160px" title="From date">
            <input class="input" type="date" id="pf-to" style="max-width:160px" title="To date">
            <select class="input" id="pf-reason" style="max-width:210px"><option value="">Any reason</option></select>
            <div class="input-group" style="flex:1;min-width:200px"><input class="input" id="pf-q" placeholder="Search user ID, employee, check-in, error…" value="${esc(f.user_id)}"></div>
            <span class="spacer"></span>
            <button class="btn btn-sm" id="p-export">${icon('download')} Export CSV</button>
          </div>
          <div class="row hidden" id="p-bulk" style="padding:10px 20px;background:var(--primary-soft);border-bottom:1px solid var(--border)">
            <span class="strong small" id="p-sel"></span><span class="spacer"></span>
            <button class="btn btn-sm" id="p-retry-sel">${icon('refresh')} Retry selected</button>
            <button class="btn btn-sm" id="p-skip-sel">${icon('skip')} Skip selected</button>
            <button class="btn btn-sm btn-ghost" id="p-clear-sel">Clear selection</button>
          </div>
          <div class="table-wrap"><table class="table"><thead><tr><th class="cb"><input type="checkbox" id="p-all" aria-label="Select all"></th><th>Punch time</th><th>User ID</th><th>Employee</th><th>Machine</th><th>Type</th><th>Status</th><th>Details</th><th>ERPNext check-in</th></tr></thead>
            <tbody id="p-body"></tbody></table></div>
          <div class="pager"><span class="muted small" id="p-count"></span><span class="spacer"></span>
            <button class="btn btn-sm" id="p-retry-all" title="Queue every matching punch that is not synced">${icon('refresh')} Retry all matching</button>
            <button class="btn btn-sm" id="p-prev">‹ Newer</button><button class="btn btn-sm" id="p-next">Older ›</button></div>
        </div>
      </div>`;
    const body = $('#p-body');
    const qs = () => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v && k !== 'user_id') p.set(k, v);
      if (f.user_id && !f.q) p.set('user_id', f.user_id);
      return p;
    };
    const drawChips = (counts) => {
      const total = Object.entries(counts).filter(([k]) => k !== 'retrying').reduce((a, [, v]) => a + v, 0);
      const chips = [['', 'list', 'All', total], ['pending', 'clock', 'Pending', counts.pending || 0], ['retrying', 'refresh', 'Retrying', counts.retrying || 0],
        ['synced', 'checkCircle', 'Synced', counts.synced || 0], ['skipped', 'skip', 'Skipped', counts.skipped || 0], ['failed', 'xCircle', 'Failed', counts.failed || 0]];
      $('#p-chips').innerHTML = chips.map(([v, ic, l, n]) => `<button data-st="${v}" class="${f.status === v ? 'active' : ''}">${icon(ic)} ${l} <span class="n ${v === 'failed' && n ? 'st-failed' : ''}">${fmtNum(n)}</span></button>`).join('');
      $$('#p-chips [data-st]').forEach((b) => (b.onclick = () => { f.status = b.dataset.st; offset = 0; load(); }));
    };
    const drawReasons = (reasons) => {
      const sel = $('#pf-reason'); const cur = f.reason;
      sel.innerHTML = '<option value="">Any reason</option>' + reasons.map((r) => `<option value="${esc(r.reason)}" ${cur === r.reason ? 'selected' : ''}>${esc(reasonLabel(r.reason))} (${fmtNum(r.n)})</option>`).join('');
    };
    const syncBulk = () => {
      $('#p-bulk').classList.toggle('hidden', !selected.size);
      $('#p-sel').textContent = `${selected.size} punch(es) selected`;
      $('#p-all').checked = rows.length > 0 && rows.every((r) => selected.has(r.id));
    };
    const row = (p) => `
      <tr data-id="${p.id}">
        <td class="cb"><input type="checkbox" data-cb="${p.id}" ${selected.has(p.id) ? 'checked' : ''}></td>
        <td class="nowrap"><div class="strong">${esc(p.ts.slice(11, 19))}</div><div class="tiny muted">${fmtDay(p.ts)}</div></td>
        <td class="mono strong"><a href="javascript:void(0)" data-user="${esc(p.user_id)}" title="Show only this user">${esc(p.user_id)}</a></td>
        <td class="small">${p.employee_id ? `${esc(p.employee_name || '')}<div class="tiny muted">${esc(p.employee_id)}</div>` : '<span class="muted">—</span>'}</td>
        <td class="small">${esc(p.device_name || '')}</td>
        <td>${p.log_type ? `<span class="badge ${p.log_type === 'IN' ? 'success' : 'info'}">${esc(p.log_type)}</span>` : `<span class="muted tiny">key ${esc(p.punch ?? '')}</span>`}</td>
        <td>${punchBadge(p)}</td>
        <td class="small" style="max-width:300px">${p.reason ? `<div class="${p.sync_status === 'failed' ? 'st-failed' : ''}">${esc(reasonLabel(p.reason))}</div>` : ''}${p.last_error && p.reason !== 'duplicate' ? `<div class="tiny muted truncate" title="${esc(p.last_error)}">${esc(p.last_error)}</div>` : ''}${p.sync_status === 'pending' && p.next_attempt_at ? `<div class="tiny muted">next try ${fmtRelative(p.next_attempt_at)}</div>` : ''}</td>
        <td class="small mono">${p.erp_name ? esc(p.erp_name) : ''}${p.synced_at && p.sync_status === 'synced' ? `<div class="tiny muted">${fmtRelative(p.synced_at)}</div>` : ''}</td>
      </tr>`;
    const load = async () => {
      body.innerHTML = `<tr><td colspan="9" class="muted">${icon('loader', 'spin')} Loading…</td></tr>`;
      const p = qs(); p.set('limit', limit); p.set('offset', offset);
      try {
        const r = await api('/punches?' + p);
        total = r.total; rows = r.rows;
        drawChips(r.counts); drawReasons(r.reasons);
        body.innerHTML = rows.length ? rows.map(row).join('') : `<tr><td colspan="9">${emptyState('list', 'No punches', 'Nothing matches these filters. Punches appear here after the machines have been read.')}</td></tr>`;
        $('#p-count').textContent = total ? `${fmtNum(offset + 1)}–${fmtNum(Math.min(offset + limit, total))} of ${fmtNum(total)}` : '';
        $('#p-prev').disabled = offset === 0; $('#p-next').disabled = offset + limit >= total;
        $('#p-retry-all').classList.toggle('hidden', !['failed', 'skipped', 'retrying', 'pending'].includes(f.status) && !f.reason);
        body.querySelectorAll('[data-cb]').forEach((c) => (c.onchange = () => { const id = Number(c.dataset.cb); c.checked ? selected.add(id) : selected.delete(id); syncBulk(); }));
        body.querySelectorAll('[data-user]').forEach((a) => (a.onclick = () => { f.q = ''; f.user_id = a.dataset.user; $('#pf-q').value = a.dataset.user; offset = 0; load(); }));
        syncBulk();
      } catch (e) { toastError(e); }
    };
    $('#p-all').onchange = (e) => { rows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); load(); };
    $('#pf-device').onchange = (e) => { f.device = e.target.value; offset = 0; load(); };
    $('#pf-from').onchange = (e) => { f.date_from = e.target.value; offset = 0; load(); };
    $('#pf-to').onchange = (e) => { f.date_to = e.target.value; offset = 0; load(); };
    $('#pf-reason').onchange = (e) => { f.reason = e.target.value; offset = 0; load(); };
    let qt; $('#pf-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value.trim(); f.user_id = ''; offset = 0; load(); }, 300); };
    $('#p-prev').onclick = () => { offset = Math.max(0, offset - limit); load(); };
    $('#p-next').onclick = () => { offset += limit; load(); };
    $('#p-clear-sel').onclick = () => { selected.clear(); load(); };
    $('#p-export').onclick = () => download('/punches/export.csv?' + qs(), null, 'punches.csv').catch(toastError);
    const act = async (path, payload, label) => {
      try {
        const r = await api(path, { method: 'POST', body: payload });
        toast(`${fmtNum(r.count)} punch(es) ${label}.${r.started ? ' Sending started.' : ''}`, 'success');
        selected.clear(); load(); updateFailedBadge();
      } catch (e) { toastError(e); }
    };
    $('#p-retry-sel').onclick = () => act('/punches/retry', { ids: [...selected] }, 'queued for sending');
    $('#p-skip-sel').onclick = async () => {
      if (!await confirmDialog({ title: 'Skip these punches?', message: `${selected.size} punch(es) will not be sent to ERPNext. You can retry them later.`, confirm: 'Skip' })) return;
      act('/punches/skip', { ids: [...selected] }, 'skipped');
    };
    $('#p-retry-all').onclick = async () => {
      if (!await confirmDialog({ title: 'Retry all matching punches?', message: `All ${fmtNum(total)} matching punch(es) that are not synced will be queued and sent now.`, confirm: 'Retry all' })) return;
      act('/punches/retry', { status: f.status, device: f.device ? Number(f.device) : null, reason: f.reason || null, user_id: f.user_id || null, date_from: f.date_from || null, date_to: f.date_to || null }, 'queued for sending');
    };
    await load();
    const off = on('run_finished', () => setTimeout(load, 600));
    return off;
  },
};
