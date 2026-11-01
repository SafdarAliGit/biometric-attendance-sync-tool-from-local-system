/* Dashboard */
'use strict';

Pages.dashboard = {
  title: 'Dashboard',
  async render(view) {
    view.innerHTML = `<div class="stack" id="dash"><div class="muted">${icon('loader', 'spin')} Loading…</div></div>`;
    let chart = null;
    const load = async () => {
      const [sum, runs, devices, hourly] = await Promise.all([api('/stats/summary?days=30'), api('/runs?limit=8'), api('/devices'), api('/stats/hourly')]);
      draw(sum, runs.rows, devices, hourly);
    };
    const draw = (s, runs, devices, hourly) => {
      const c = s.counts || {};
      const pending = c.pending || 0, failed = c.failed || 0;
      const setup = !s.erp_configured || !s.devices;
      const next = s.next_runs[0];
      $('#dash').innerHTML = `
        ${setup ? `
          <div class="card"><div class="card-body">
            <div class="row" style="gap:18px;align-items:flex-start">
              <div class="stat-icon" style="width:52px;height:52px">${icon('rocket')}</div>
              <div style="flex:1;min-width:240px">
                <h2>Welcome to Biometric Attendance Sync</h2>
                <p class="muted mt-1">Get started in three steps:</p>
                <ol class="steps">
                  <li>${s.erp_configured ? `${icon('check', '')} ` : ''}<b>Connect ERPNext</b>: enter the URL, API key and secret under <a href="#/settings/erpnext">Settings → ERPNext</a>.</li>
                  <li>${s.devices ? `${icon('check', '')} ` : ''}<b>Add your machines</b> with their IP address, or let the app scan the network for them.</li>
                  <li>Click <b>Sync Now</b>. After that, syncing runs automatically every ${esc(store.settings?.sync_interval_minutes || 15)} minutes.</li>
                </ol>
              </div>
              <div class="btn-group">${!s.erp_configured ? `<a class="btn btn-primary" href="#/settings/erpnext">${icon('cloud')} Connect ERPNext</a>` : ''}${!s.devices ? `<a class="btn ${s.erp_configured ? 'btn-primary' : ''}" href="#/devices" id="welcome-add">${icon('plus')} Add a machine</a>` : ''}<a class="btn" href="#/help">${icon('help')} Read the guide</a></div>
            </div>
          </div></div>` : ''}

        ${s.erp_down_since ? `<div class="alert danger">${icon('cloudOff')}<div style="flex:1"><div class="t">ERPNext has not been reachable since ${fmtDate(s.erp_down_since)} (${fmtRelative(s.erp_down_since)})</div>${esc(s.erp_last_error || '')}. Punches are safely kept on this PC (${fmtNum(pending)} waiting) and are sent automatically when ERPNext is back.</div><a class="btn btn-sm" href="#/settings/erpnext">Check connection</a></div>` : ''}
        ${failed ? `<div class="alert warning">${icon('alert')}<div style="flex:1"><div class="t">${fmtNum(failed)} punch(es) failed every retry and need attention</div>Usually the employee in ERPNext has no matching attendance device ID. Fix it in Employee Mapping, then retry.</div><div class="btn-group"><a class="btn btn-sm" href="#/punches/failed">View</a><a class="btn btn-sm" href="#/employees">Employee mapping</a></div></div>` : ''}

        <div class="grid grid-4">
          <div class="card stat"><div class="stat-icon ${!s.devices_enabled ? '' : s.devices_offline ? 'danger' : 'success'}">${icon(s.devices_offline ? 'wifiOff' : 'fingerprint')}</div><div><div class="label">Machines online</div><div class="value">${s.devices_online} <span class="muted" style="font-size:16px">/ ${s.devices_enabled}</span></div><div class="meta">${s.devices_offline ? `<span class="st-failed">${s.devices_offline} offline</span>` : 'All reachable at last read'}</div></div></div>
          <div class="card stat"><div class="stat-icon info">${icon('users')}</div><div><div class="label">Today</div><div class="value">${fmtNum(s.today_punches)} <span class="muted" style="font-size:13px;font-weight:500">punches</span></div><div class="meta">${fmtNum(s.today_employees)} employee(s) · ${fmtNum(s.today_synced)} sent today</div></div></div>
          <div class="card stat"><div class="stat-icon ${failed ? 'danger' : pending ? 'warning' : 'success'}">${icon(failed ? 'alert' : pending ? 'clock' : 'checkCircle')}</div><div><div class="label">Waiting / failed</div><div class="value">${fmtNum(pending)} <span class="muted" style="font-size:16px">/ ${fmtNum(failed)}</span></div><div class="meta">${s.retrying ? `${fmtNum(s.retrying)} being retried` : 'Nothing waiting for retry'}</div></div></div>
          <div class="card stat"><div class="stat-icon ${s.read_success_rate == null ? '' : s.read_success_rate >= 95 ? 'success' : s.read_success_rate >= 70 ? 'warning' : 'danger'}">${icon('cloud')}</div><div><div class="label">Sent to ERPNext (30 days)</div><div class="value">${fmtNum(s.period_synced)}</div><div class="meta">Machine reads OK: ${s.read_success_rate == null ? '—' : s.read_success_rate + '%'} · ${fmtNum(s.punches_total)} punches stored</div></div></div>
        </div>

        <div class="grid grid-3">
          <div class="card" style="grid-column: span 2" id="dash-active"></div>
          <div class="card">
            <div class="card-head"><h3>${icon('calendar', '')} Schedule</h3><a class="btn btn-sm btn-ghost" href="#/settings/sync">Edit</a></div>
            <div class="card-body">
              ${next ? `<div class="label muted">Next automatic sync</div><div style="font-size:20px;font-weight:700">${fmtTime(next)}</div><div class="muted small">${fmtRelative(next)} · every ${esc(store.settings?.sync_interval_minutes)} min</div>`
              : `<div class="muted">Automatic sync is off.</div><a class="btn btn-sm mt-2" href="#/settings/sync">${icon('calendar')} Turn it on</a>`}
              <hr>
              <div class="label muted">Last sync</div>
              ${s.last_run ? `<div class="row mt-1">${statusBadge(s.last_run.status)}<span class="small">${fmtDate(s.last_run.finished_at)}</span></div><div class="muted small mt-1">${esc(s.last_run.summary || '')}</div>` : '<div class="muted small">No sync yet</div>'}
            </div>
          </div>
        </div>

        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h3>${icon('fingerprint', '')} Machines</h3><a class="btn btn-sm btn-ghost" href="#/devices">Manage</a></div>
            <div class="card-body">${devices.length ? devices.map((d) => `
              <div class="health-row">
                <div class="stat-icon ${!d.enabled ? '' : d.status === 'online' ? 'success' : d.status === 'offline' ? 'danger' : ''}">${icon(d.status === 'offline' ? 'wifiOff' : 'fingerprint')}</div>
                <div style="flex:1;min-width:0"><div class="t truncate">${esc(d.name)} ${d.enabled ? '' : '<span class="badge outline">disabled</span>'}</div>
                  <div class="d truncate">${esc(d.ip)} · last read ${fmtRelative(d.last_success_at)}${d.status === 'offline' && d.last_error ? ` · <span class="st-failed">${esc(d.last_error)}</span>` : ''}</div></div>
                <div style="text-align:right" class="small"><div class="strong">${fmtNum(d.stats.today)} today</div><div class="muted">${d.stats.pending ? `${fmtNum(d.stats.pending)} pending` : ''}${d.stats.failed ? ` <span class="st-failed">${fmtNum(d.stats.failed)} failed</span>` : ''}</div></div>
              </div>`).join('') : emptyState('fingerprint', 'No machines yet', 'Add your first biometric machine.')}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>${icon('chart', '')} Punches today by hour</h3><a class="btn btn-sm btn-ghost" href="#/stats">Statistics</a></div>
            <div class="card-body"><div class="chart-box sm"><canvas id="ch-hourly"></canvas></div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>${icon('history', '')} Recent syncs</h3><a class="btn btn-sm btn-ghost" href="#/stats/history">View all</a></div>
          <div class="card-body tight table-wrap">
            ${runs.length ? `<table class="table"><thead><tr><th>Run</th><th>Started</th><th>Trigger</th><th>Result</th><th>Machines</th><th>New</th><th>Sent</th><th>Waiting</th><th>Duration</th></tr></thead><tbody>
              ${runs.map((r) => `<tr class="clickable" data-run="${r.id}">
                <td class="strong">#${r.id}</td><td class="nowrap">${fmtDate(r.started_at)}</td><td>${esc(triggerLabel(r.trigger))}${r.mode === 'push' ? ' <span class="badge">send only</span>' : ''}</td>
                <td>${statusBadge(r.status)}</td><td>${r.devices_ok}/${r.devices_total}${r.devices_failed ? ` <span class="st-failed small">(${r.devices_failed} offline)</span>` : ''}</td>
                <td>${fmtNum(r.new_punches)}</td><td>${fmtNum(r.pushed)}</td><td>${r.pending_after ? fmtNum(r.pending_after) : '—'}</td>
                <td>${r.finished_at ? fmtDuration((parseTs(r.finished_at) - parseTs(r.started_at)) / 1000) : '…'}</td></tr>`).join('')}
            </tbody></table>` : emptyState('history', 'No syncs yet', 'Click Sync Now at the top right to run the first one.')}
          </div>
        </div>`;
      $$('#dash [data-run]').forEach((tr) => (tr.onclick = () => Pages.stats.openRun(Number(tr.dataset.run))));
      const wa = $('#welcome-add'); if (wa) wa.onclick = () => setTimeout(() => Pages.devices.openEditor(), 150);
      if (chart) chart.destroy();
      if (window.Chart) {
        chartDefaults();
        chart = new Chart($('#ch-hourly'), {
          type: 'bar',
          data: { labels: hourly.map((h) => String(h.hour).padStart(2, '0')), datasets: [{ label: 'Punches', data: hourly.map((h) => h.count), backgroundColor: cssVar('--primary'), borderRadius: 4, maxBarThickness: 22 }] },
          options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
        });
      }
      drawActive();
    };
    const drawActive = () => {
      const box = $('#dash-active'); if (!box) return;
      const runs = activeRuns();
      if (!runs.length) {
        box.innerHTML = `<div class="card-head"><h3>${icon('activity', '')} Activity</h3></div>
          <div class="card-body"><div class="row" style="gap:18px">
            <div class="stat-icon success" style="width:52px;height:52px">${icon('shield')}</div>
            <div style="flex:1;min-width:200px"><div class="strong">No sync is running</div><div class="muted small">Punches are collected automatically on schedule. You can also sync right now.</div></div>
            <div class="btn-group"><button class="btn btn-lg" id="dash-push" title="Send pending punches without contacting the machines">${icon('send')} Send pending</button><button class="btn btn-primary btn-lg" id="dash-start">${icon('refresh')} Sync Now</button></div>
          </div></div>`;
        $('#dash-start').onclick = () => quickSync();
        $('#dash-push').onclick = async () => {
          try { await api('/runs', { method: 'POST', body: { push_only: true } }); location.hash = '#/progress'; } catch (e) { toastError(e); }
        };
        return;
      }
      box.innerHTML = `<div class="card-head"><h3>${icon('activity', '')} Syncing now</h3><a class="btn btn-sm" href="#/progress">${icon('eye')} Live progress</a></div>
        <div class="card-body stack">${runs.map((r) => {
          const tt = runTotals(r);
          const cur = tt.tasks.find((t) => ['connecting', 'fetching', 'pushing', 'clearing'].includes(t.status));
          return `<div><div class="row small"><span class="strong">Run #${r.id}</span><span class="muted">${tt.done}/${tt.tasks.length || '…'} machines · ${fmtNum(tt.pushed)} sent</span><span class="spacer"></span>${cur ? `<span class="muted truncate">${esc(cur.device_name)}: ${esc(cur.message || '')}</span>` : ''}</div>
            <div class="bar bar-lg mt-1 striped"><span style="width:${Math.max(tt.pct, 3)}%"></span></div></div>`;
        }).join('')}</div>`;
    };
    await loadSettings().catch(() => {});
    await load();
    const offs = [on('runs', drawActive), on('task', throttle(drawActive, 800)), on('run_finished', () => setTimeout(load, 800)), on('theme', () => load())];
    return () => { offs.forEach((f) => f()); if (chart) chart.destroy(); };
  },
};
