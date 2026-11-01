/* Logs */
'use strict';

Pages.logs = {
  title: 'Logs',
  async render(view, args) {
    const f = { levels: new Set(['ERROR', 'WARNING', 'SUCCESS', 'INFO']), device: '', q: '', run_id: '' };
    if (args[0] === 'device' && args[1]) f.device = args[1];
    if (args[0] === 'run' && args[1]) f.run_id = args[1];
    if (args[0] === 'errors') f.levels = new Set(['ERROR', 'WARNING']);
    let devices = [];
    try { devices = await loadDevices(); } catch (e) { /* ignore */ }
    view.innerHTML = `
      <div class="card">
        <div class="filters">
          <div class="level-chips">${['ERROR', 'WARNING', 'SUCCESS', 'INFO'].map((l) => `<button data-lv="${l}" class="${l}">${l}</button>`).join('')}</div>
          <select class="input" id="lf-device" style="max-width:200px"><option value="">All machines</option>${devices.map((d) => `<option ${f.device === d.name ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
          <input class="input" id="lf-run" type="number" placeholder="Run #" style="max-width:110px" value="${esc(f.run_id)}">
          <div class="input-group" style="flex:1;min-width:200px"><input class="input" id="lf-q" placeholder="Search messages, user IDs…"></div>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="lf-export">${icon('download')} Export CSV</button>
          <button class="btn btn-sm btn-soft-danger" id="lf-clear">${icon('trash')} Clear</button>
        </div>
        <div class="table-wrap"><table class="table"><thead><tr><th style="width:170px">Time</th><th style="width:90px">Level</th><th style="width:150px">Machine</th><th style="width:100px">User ID</th><th>Message</th><th style="width:60px">Run</th></tr></thead>
          <tbody id="log-body"></tbody></table></div>
        <div class="row" style="padding:12px 20px;border-top:1px solid var(--border)"><span class="muted small" id="log-count"></span><span class="spacer"></span><button class="btn btn-sm" id="log-more">Load more</button></div>
      </div>`;
    const body = $('#log-body');
    let offset = 0, total = 0;
    const qs = () => {
      const p = new URLSearchParams();
      p.set('level', [...f.levels].join(','));
      if (f.device) p.set('device', f.device);
      if (f.q) p.set('q', f.q);
      if (f.run_id) p.set('run_id', f.run_id);
      return p;
    };
    const row = (l, isNew = false) => `
      <tr class="${l.detail ? 'clickable' : ''} ${isNew ? 'new-log' : ''}" data-id="${l.id}">
        <td class="nowrap small">${fmtDate(l.ts, true)}</td><td>${levelBadge(l.level)}</td>
        <td class="small">${esc(l.device || '')}</td><td class="small mono">${esc(l.employee || '')}</td>
        <td class="log-msg">${esc(l.message)} ${l.detail ? `<span class="muted tiny">${icon('chevronDown', '')}details</span>` : ''}</td>
        <td class="small">${l.run_id ? `<a href="javascript:void(0)" data-run="${l.run_id}">#${l.run_id}</a>` : ''}</td></tr>`;
    const bindRows = () => {
      body.querySelectorAll('tr[data-id]').forEach((tr) => {
        if (tr._b) return; tr._b = true;
        tr.onclick = (e) => {
          const a = e.target.closest('[data-run]');
          if (a) { e.stopPropagation(); Pages.stats.openRun(Number(a.dataset.run)); return; }
          const l = tr._log; if (!l || !l.detail) return;
          const next = tr.nextElementSibling;
          if (next && next.classList.contains('detail-row')) { next.remove(); return; }
          const d = document.createElement('tr'); d.className = 'detail-row';
          d.innerHTML = `<td colspan="6"><pre>${esc(l.detail)}</pre><button class="btn btn-sm" data-copy>${icon('copy')} Copy</button></td>`;
          d.querySelector('[data-copy]').onclick = () => navigator.clipboard?.writeText(l.message + '\n\n' + l.detail).then(() => toast('Copied', 'success', '', 1500));
          tr.after(d);
        };
      });
    };
    const load = async (reset = true) => {
      if (reset) { offset = 0; body.innerHTML = `<tr><td colspan="6" class="muted">${icon('loader', 'spin')} Loading…</td></tr>`; }
      const p = qs(); p.set('limit', 200); p.set('offset', offset);
      try {
        const r = await api('/logs?' + p);
        total = r.total;
        if (reset) body.innerHTML = '';
        if (!r.rows.length && reset) body.innerHTML = `<tr><td colspan="6">${emptyState('logs', 'No log entries', 'Nothing matches these filters.')}</td></tr>`;
        r.rows.forEach((l) => { body.insertAdjacentHTML('beforeend', row(l)); body.lastElementChild._log = l; });
        offset += r.rows.length;
        $('#log-count').textContent = `Showing ${fmtNum(offset)} of ${fmtNum(total)}`;
        $('#log-more').classList.toggle('hidden', offset >= total);
        bindRows();
      } catch (e) { toastError(e); }
    };
    const syncChips = () => $$('[data-lv]').forEach((b) => b.classList.toggle('active', f.levels.has(b.dataset.lv)));
    $$('[data-lv]').forEach((b) => (b.onclick = () => { f.levels.has(b.dataset.lv) ? f.levels.delete(b.dataset.lv) : f.levels.add(b.dataset.lv); if (!f.levels.size) f.levels.add(b.dataset.lv); syncChips(); load(); }));
    syncChips();
    $('#lf-device').onchange = (e) => { f.device = e.target.value; load(); };
    let qt; $('#lf-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); };
    $('#lf-run').onchange = (e) => { f.run_id = e.target.value; load(); };
    $('#log-more').onclick = () => load(false);
    $('#lf-export').onclick = () => download('/logs/export.csv', null, 'logs.csv').catch(toastError);
    $('#lf-clear').onclick = async () => {
      if (!await confirmDialog({ title: 'Clear all logs?', message: 'This permanently deletes every log entry. Punches, run history and statistics are kept.', confirm: 'Clear logs', danger: true })) return;
      await api('/logs', { method: 'DELETE' }).catch(toastError); load();
    };
    await load();
    const off = on('log', (l) => {
      if (!f.levels.has(l.level)) return;
      if (f.device && l.device !== f.device) return;
      if (f.run_id && String(l.run_id) !== String(f.run_id)) return;
      if (f.q && !(l.message + l.detail + (l.employee || '')).toLowerCase().includes(f.q.toLowerCase())) return;
      const emptyRow = body.querySelector('.empty'); if (emptyRow) body.innerHTML = '';
      body.insertAdjacentHTML('afterbegin', row(l, true)); body.firstElementChild._log = l;
      total++; offset++; $('#log-count').textContent = `Showing ${fmtNum(offset)} of ${fmtNum(total)}`;
      bindRows();
    });
    return off;
  },
};
