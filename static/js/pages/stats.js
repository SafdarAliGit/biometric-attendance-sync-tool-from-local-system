/* Statistics, run history, run details */
'use strict';

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function chartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = cssVar('--font');
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--border');
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.boxHeight = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--sidebar');
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
}

Pages.stats = {
  title: 'Statistics',
  async render(view, args) {
    let tab = args[0] === 'history' ? 'history' : 'overview';
    let days = 30;
    const charts = [];
    const destroyCharts = () => { while (charts.length) charts.pop().destroy(); };
    view.innerHTML = `
      <div class="row mb-3">
        <div class="segmented" id="st-tabs"><button data-t="overview">${icon('chart', '')} Overview</button><button data-t="history">${icon('history', '')} Sync history</button></div>
        <span class="spacer"></span>
        <select class="input" id="st-days" style="width:auto"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 365 days</option></select>
        <button class="btn" id="st-export">${icon('download')} Export CSV</button>
      </div>
      <div id="st-body"></div>`;
    const tabsEl = $('#st-tabs');
    const setTab = (t) => { tab = t; tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.t === t)); draw(); };
    tabsEl.querySelectorAll('button').forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
    $('#st-days').onchange = (e) => { days = Number(e.target.value); draw(); };
    $('#st-export').onclick = () => {
      const m = openModal({
        title: 'Export to CSV', icon: 'download',
        body: `<div class="stack"><button class="btn" data-x="punches">${icon('list')} Punches (selected period)</button><button class="btn" data-x="runs">${icon('history')} Sync history (selected period)</button><button class="btn" data-x="logs">${icon('logs')} All logs</button></div>`,
      });
      m.el.querySelector('[data-x=punches]').onclick = () => { download(`/punches/export.csv?date_from=${todayStr(-days + 1)}`, null, 'punches.csv').catch(toastError); m.close(); };
      m.el.querySelector('[data-x=runs]').onclick = () => { download(`/export/runs.csv?days=${days}`, null, 'sync-runs.csv').catch(toastError); m.close(); };
      m.el.querySelector('[data-x=logs]').onclick = () => { download('/logs/export.csv', null, 'logs.csv').catch(toastError); m.close(); };
    };

    async function draw() {
      destroyCharts();
      const body = $('#st-body');
      body.innerHTML = `<div class="muted">${icon('loader', 'spin')} Loading…</div>`;
      if (tab === 'history') return drawHistory(body);
      const [sum, daily, devs] = await Promise.all([api(`/stats/summary?days=${days}`), api(`/stats/daily?days=${Math.min(days, 90)}`), api(`/stats/devices?days=${days}`)]);
      const c = sum.counts || {};
      body.innerHTML = `
        <div class="grid grid-4 mb-3">
          <div class="card stat"><div class="stat-icon">${icon('activity')}</div><div><div class="label">Sync runs</div><div class="value">${fmtNum(sum.runs)}</div><div class="meta"><span class="st-success">${sum.runs_ok} ok</span> · ${sum.runs_partial} partial · <span class="st-failed">${sum.runs_failed} failed</span></div></div></div>
          <div class="card stat"><div class="stat-icon ${sum.read_success_rate == null ? '' : sum.read_success_rate >= 95 ? 'success' : sum.read_success_rate >= 70 ? 'warning' : 'danger'}">${icon('fingerprint')}</div><div><div class="label">Machine reads OK</div><div class="value">${sum.read_success_rate == null ? '—' : sum.read_success_rate + '%'}</div><div class="meta">${fmtNum(sum.device_reads_ok)} of ${fmtNum(sum.device_reads)} reads</div></div></div>
          <div class="card stat"><div class="stat-icon success">${icon('cloud')}</div><div><div class="label">Sent to ERPNext</div><div class="value">${fmtNum(sum.period_synced)}</div><div class="meta">${fmtNum(sum.period_fetched)} new punches read in the period</div></div></div>
          <div class="card stat"><div class="stat-icon ${c.failed ? 'danger' : 'success'}">${icon(c.failed ? 'alert' : 'shield')}</div><div><div class="label">Ledger now</div><div class="value">${fmtNum(sum.punches_total)}</div><div class="meta">${fmtNum(c.pending || 0)} pending · <span class="${c.failed ? 'st-failed' : ''}">${fmtNum(c.failed || 0)} failed</span> · ${fmtNum(c.skipped || 0)} skipped</div></div></div>
        </div>
        <div class="grid grid-2 mb-3">
          <div class="card"><div class="card-head"><h3>Punches per day (by sync status)</h3></div><div class="card-body"><div class="chart-box"><canvas id="ch-daily"></canvas></div></div></div>
          <div class="card"><div class="card-head"><h3>Employees punching per day</h3></div><div class="card-body"><div class="chart-box"><canvas id="ch-emps"></canvas></div></div></div>
        </div>
        <div class="card mb-3">
          <div class="card-head"><h3>Per-machine status</h3></div>
          <div class="card-body tight table-wrap"><table class="table"><thead><tr><th>Machine</th><th>Status</th><th>Last read</th><th>Reads OK</th><th>Avg read time</th><th>Today</th><th>Pending</th><th>Failed</th><th>Stored</th></tr></thead><tbody>
            ${devs.length ? devs.map((d) => `<tr class="clickable" data-dev="${d.id}">
              <td><div class="strong">${esc(d.name)} ${d.enabled ? '' : '<span class="badge outline">disabled</span>'}</div><div class="tiny muted mono">${esc(d.ip)} · ${esc(d.device_id)}</div></td>
              <td>${statusBadge(d.status)}</td>
              <td class="small nowrap">${d.last_success_at ? `${fmtRelative(d.last_success_at)}<div class="tiny muted">${fmtDate(d.last_success_at)}</div>` : '<span class="muted">never</span>'}</td>
              <td class="small">${d.reads ? `${d.reads_ok}/${d.reads} <span class="muted">(${Math.round(100 * d.reads_ok / d.reads)}%)</span>` : '—'}</td>
              <td class="small">${d.avg_fetch != null ? fmtDuration(d.avg_fetch) : '—'}</td>
              <td class="small">${fmtNum(d.stats.today)}</td><td class="small">${fmtNum(d.stats.pending)}</td>
              <td class="small ${d.stats.failed ? 'st-failed strong' : ''}">${fmtNum(d.stats.failed)}</td><td class="small">${fmtNum(d.stats.total)}</td></tr>`).join('')
              : `<tr><td colspan="9">${emptyState('fingerprint', 'No machines')}</td></tr>`}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Punches by hour</h3><input type="date" class="input" id="hr-day" style="max-width:180px" value="${todayStr()}"></div>
          <div class="card-body"><div class="chart-box sm"><canvas id="ch-hourly"></canvas></div></div>
        </div>`;
      $$('#st-body [data-dev]').forEach((tr) => (tr.onclick = () => { location.hash = `#/punches/device/${tr.dataset.dev}`; }));
      chartDefaults();
      const ok = cssVar('--success'), bad = cssVar('--danger'), prim = cssVar('--primary'), warn = cssVar('--warning'), info = cssVar('--info'), muted = cssVar('--muted');
      const labels = daily.map((d) => new Date(d.day + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
      const bar = (label, key, color) => ({ label, data: daily.map((d) => d[key]), backgroundColor: color, borderRadius: 3, maxBarThickness: 26 });
      charts.push(new Chart($('#ch-daily'), {
        type: 'bar',
        data: { labels, datasets: [bar('Synced', 'synced', ok), bar('Pending', 'pending', info), bar('Skipped', 'skipped', muted), bar('Failed', 'failed', bad)] },
        options: { maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'bottom' } } },
      }));
      charts.push(new Chart($('#ch-emps'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Employees', data: daily.map((d) => d.employees), borderColor: prim, backgroundColor: prim + '22', fill: true, tension: .35, pointRadius: 2 }] },
        options: { maintainAspectRatio: false, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { display: false } } },
      }));
      let hourChart = null;
      const drawHourly = async () => {
        const rows = await api(`/stats/hourly?day=${$('#hr-day').value || todayStr()}`);
        if (hourChart) { hourChart.destroy(); charts.splice(charts.indexOf(hourChart), 1); }
        hourChart = new Chart($('#ch-hourly'), {
          type: 'bar', data: { labels: rows.map((r) => String(r.hour).padStart(2, '0') + ':00'), datasets: [{ label: 'Punches', data: rows.map((r) => r.count), backgroundColor: warn, borderRadius: 4, maxBarThickness: 24 }] },
          options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
        });
        charts.push(hourChart);
      };
      $('#hr-day').onchange = drawHourly;
      drawHourly();
    }

    async function drawHistory(body) {
      let offset = 0; const limit = 25; let status = '', trigger = '';
      body.innerHTML = `<div class="card">
        <div class="filters">
          <select class="input" id="h-trigger" style="max-width:200px"><option value="">Any trigger</option><option value="schedule">Scheduled</option><option value="manual">Manual</option><option value="startup">At startup</option><option value="shortcut">Shortcut</option><option value="retry">Retry</option></select>
          <select class="input" id="h-status" style="max-width:180px"><option value="">Any result</option><option value="success">Success</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-soft-danger" id="h-clear">${icon('trash')} Clear history…</button>
        </div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Started</th><th>Trigger</th><th>Result</th><th>Machines</th><th>Read</th><th>New</th><th>Sent</th><th>Skipped</th><th>Waiting after</th><th>Duration</th></tr></thead><tbody id="h-rows"></tbody></table></div>
        <div class="row" style="padding:12px 20px;border-top:1px solid var(--border)"><span class="muted small" id="h-count"></span><span class="spacer"></span><button class="btn btn-sm" id="h-prev">‹ Newer</button><button class="btn btn-sm" id="h-next">Older ›</button></div></div>`;
      const load = async () => {
        const p = new URLSearchParams({ limit, offset }); if (status) p.set('status', status); if (trigger) p.set('trigger', trigger);
        const r = await api('/runs?' + p);
        $('#h-rows').innerHTML = r.rows.length ? r.rows.map((x) => `<tr class="clickable" data-run="${x.id}">
          <td class="strong">#${x.id}</td><td class="nowrap small">${fmtDate(x.started_at)}</td>
          <td>${esc(triggerLabel(x.trigger))}${x.mode === 'push' ? ' <span class="badge">send only</span>' : ''}</td>
          <td>${statusBadge(x.status)}</td><td>${x.devices_ok}/${x.devices_total}${x.devices_failed ? ` <span class="st-failed small">(${x.devices_failed} offline)</span>` : ''}</td>
          <td>${fmtNum(x.fetched)}</td><td>${fmtNum(x.new_punches)}</td><td class="strong">${fmtNum(x.pushed)}</td><td>${fmtNum(x.skipped)}</td><td>${x.pending_after ? fmtNum(x.pending_after) : '—'}</td>
          <td>${x.finished_at ? fmtDuration((parseTs(x.finished_at) - parseTs(x.started_at)) / 1000) : '…'}</td></tr>`).join('')
          : `<tr><td colspan="11">${emptyState('history', 'No runs found')}</td></tr>`;
        $('#h-count').textContent = r.total ? `${offset + 1}–${Math.min(offset + limit, r.total)} of ${r.total}` : '';
        $('#h-prev').disabled = offset === 0; $('#h-next').disabled = offset + limit >= r.total;
        $$('#h-rows [data-run]').forEach((tr) => (tr.onclick = () => Pages.stats.openRun(Number(tr.dataset.run))));
      };
      $('#h-trigger').onchange = (e) => { trigger = e.target.value; offset = 0; load(); };
      $('#h-status').onchange = (e) => { status = e.target.value; offset = 0; load(); };
      $('#h-prev').onclick = () => { offset = Math.max(0, offset - limit); load(); };
      $('#h-next').onclick = () => { offset += limit; load(); };
      $('#h-clear').onclick = async () => {
        const v = await promptDialog({ title: 'Clear sync history', label: 'Delete runs older than (days)', value: '90', type: 'number', hint: 'Enter 0 to delete all history. Punches are not touched.', confirm: 'Delete' });
        if (v === null) return;
        await api(`/runs?before_days=${Number(v) || 0}`, { method: 'DELETE' }).catch(toastError);
        toast('History cleared.', 'success'); offset = 0; load();
      };
      await load();
    }

    setTab(tab);
    const offs = [on('theme', () => draw()), on('run_finished', () => setTimeout(draw, 800))];
    return () => { destroyCharts(); offs.forEach((f) => f()); };
  },

  async openRun(id) {
    let d;
    try { d = await api(`/runs/${id}`); } catch (e) { return toastError(e); }
    const r = d.run;
    const m = openModal({
      title: `${r.mode === 'push' ? 'Send pending' : 'Sync run'} #${r.id}`, icon: 'history', size: 'xwide',
      body: `
        <div class="row mb-3" style="gap:18px">
          ${statusBadge(r.status)}
          <span class="small">${icon('clock', '')} ${fmtDate(r.started_at, true)} → ${r.finished_at ? fmtDate(r.finished_at, true) : 'running'}</span>
          <span class="small">${esc(triggerLabel(r.trigger))}</span>
          <span class="small"><b>${fmtNum(r.new_punches)}</b> new · <b>${fmtNum(r.pushed)}</b> sent · ${fmtNum(r.skipped)} skipped · ${fmtNum(r.pending_after)} waiting after</span>
        </div>
        ${r.summary ? `<div class="alert info mb-3">${icon('info')}<div>${esc(r.summary)}</div></div>` : ''}
        <div class="card mb-3"><div class="table-wrap"><table class="table"><thead><tr><th>Machine</th><th>Result</th><th>Read</th><th>New</th><th>To send</th><th>Sent</th><th>Skipped</th><th>To retry</th><th>Read time</th><th>Send time</th><th>Problem</th></tr></thead><tbody>
          ${d.tasks.map((t) => `<tr>
            <td class="strong">${esc(t.device_name)}<div class="tiny muted">${esc(t.ip)}</div></td><td>${statusBadge(t.status)}${t.cleared ? ' <span class="badge warning">cleared</span>' : ''}</td>
            <td class="small">${t.fetch_status === 'done' ? fmtNum(t.fetched) : t.fetch_status === 'skipped' ? '—' : `<span class="st-failed">${esc(t.fetch_status)}</span>`}</td>
            <td class="small">${fmtNum(t.new_punches)}</td><td class="small">${fmtNum(t.to_push)}</td><td class="small strong">${fmtNum(t.pushed)}</td><td class="small">${fmtNum(t.skipped)}</td><td class="small ${t.push_failed ? 'st-failed' : ''}">${fmtNum(t.push_failed)}</td>
            <td class="small">${fmtDuration(t.fetch_seconds)}</td><td class="small">${fmtDuration(t.push_seconds)}</td>
            <td class="small" style="max-width:320px">${t.error ? `<span class="st-failed">${esc(t.error)}</span> ${t.error_detail ? `<a href="javascript:void(0)" data-det="${t.id}">details</a>` : ''}` : ''}</td>
          </tr>`).join('') || `<tr><td colspan="11" class="muted">No machines in this run</td></tr>`}
        </tbody></table></div></div>
        <h3 class="mb-1">Log</h3>
        <div class="live-log" style="max-height:320px;border-radius:10px">${d.logs.map((l) => `<div class="l"><span class="ts">${fmtTime(l.ts)}</span>${levelBadge(l.level)}<span>${l.device ? `<b>${esc(l.device)}</b> ` : ''}${l.employee ? `<span class="muted">ID ${esc(l.employee)}</span> ` : ''}${esc(l.message)}</span></div>`).join('') || '<div class="muted">No log entries</div>'}</div>`,
      foot: `<a class="btn" href="#/logs/run/${r.id}" data-close>${icon('logs')} Open in Logs</a><button class="btn btn-primary" data-close>Close</button>`,
    });
    m.el.querySelectorAll('[data-det]').forEach((a) => (a.onclick = () => {
      const t = d.tasks.find((x) => x.id === Number(a.dataset.det));
      errorDetailsDialog(`${t.device_name}: details`, t.error, t.error_detail);
    }));
    m.el.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => { location.hash = a.getAttribute('href'); }));
  },
};
