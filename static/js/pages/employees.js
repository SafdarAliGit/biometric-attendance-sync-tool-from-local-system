/* Employee mapping: machine user IDs ↔ ERPNext employees */
'use strict';

Pages.employees = {
  title: 'Employee Mapping',
  async render(view) {
    let data = null, filter = 'issues', q = '';
    view.innerHTML = `
      <div class="stack">
        <div class="row">
          <div class="muted" style="flex:1;min-width:260px">Each punch carries the machine's <b>User ID</b>. ERPNext finds the employee whose <b id="fieldname">Attendance Device ID</b> equals that ID. This page shows which IDs match and which don't.</div>
          <button class="btn" id="m-users">${icon('fingerprint')} Read users from machines</button>
          <button class="btn btn-primary" id="m-emps">${icon('cloud')} Read employees from ERPNext</button>
        </div>
        <div id="m-kpis"></div>
        <div class="card">
          <div class="filters">
            <div class="segmented" id="m-filter"><button data-f="issues">${icon('alert', '')} Problems</button><button data-f="all">All IDs</button><button data-f="ok">Matched</button></div>
            <div class="input-group" style="flex:1;min-width:200px;max-width:360px"><input class="input" id="m-q" placeholder="Search ID, name, department…"></div>
            <span class="spacer"></span><span class="muted small" id="m-meta"></span>
          </div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Machine user ID</th><th>Name on machine</th><th>Machines</th><th>ERPNext employee</th><th>Status</th><th>Punches</th><th>Problem</th><th></th></tr></thead><tbody id="m-body"></tbody></table></div>
        </div>
        <div class="card" id="m-unlinked"></div>
      </div>`;
    const ISSUE = {
      not_in_erpnext: ['danger', 'No employee in ERPNext has this ID'],
      inactive: ['warning', 'Employee is not Active'],
      duplicate_id: ['warning', 'Several employees share this ID'],
    };
    const draw = () => {
      if (!data) return;
      $('#fieldname').textContent = data.fieldname === 'attendance_device_id' ? 'Attendance Device ID' : data.fieldname;
      const rows = data.rows;
      const n = (k) => rows.filter((r) => r.issue === k).length;
      $('#m-kpis').innerHTML = `<div class="grid grid-4">
        <div class="card stat"><div class="stat-icon">${icon('fingerprint')}</div><div><div class="label">IDs on machines / in punches</div><div class="value">${fmtNum(rows.length)}</div><div class="meta">${data.users_fetched_at ? `machine users read ${fmtRelative(data.users_fetched_at)}` : 'machine users not read yet'}</div></div></div>
        <div class="card stat"><div class="stat-icon success">${icon('link')}</div><div><div class="label">Matched</div><div class="value">${fmtNum(rows.filter((r) => !r.issue).length)}</div><div class="meta">${fmtNum(data.employee_count)} employees in ERPNext${data.employees_fetched_at ? ` · read ${fmtRelative(data.employees_fetched_at)}` : ''}</div></div></div>
        <div class="card stat"><div class="stat-icon ${n('not_in_erpnext') ? 'danger' : 'success'}">${icon('users')}</div><div><div class="label">Not found in ERPNext</div><div class="value">${fmtNum(n('not_in_erpnext'))}</div><div class="meta">their punches cannot be imported</div></div></div>
        <div class="card stat"><div class="stat-icon ${n('inactive') + n('duplicate_id') ? 'warning' : 'success'}">${icon('alert')}</div><div><div class="label">Inactive / duplicate ID</div><div class="value">${fmtNum(n('inactive'))} <span class="muted" style="font-size:16px">/ ${fmtNum(n('duplicate_id'))}</span></div><div class="meta">${fmtNum(data.unlinked_employees.length)} active employee(s) without an ID</div></div></div>
      </div>
      ${!data.employees_fetched_at ? `<div class="alert info mt-3">${icon('info')}<div>Click <b>Read employees from ERPNext</b> to compare. The API user needs read permission on Employee.</div></div>` : ''}`;
      $$('#m-filter button').forEach((b) => b.classList.toggle('active', b.dataset.f === filter));
      const ql = q.toLowerCase();
      const shown = rows.filter((r) => (filter === 'all' || (filter === 'issues' ? r.issue : !r.issue)) &&
        (!ql || [r.user_id, r.device_user_name, r.employee, r.employee_name, r.department].join(' ').toLowerCase().includes(ql)));
      $('#m-meta').textContent = `${shown.length} shown`;
      $('#m-body').innerHTML = shown.length ? shown.map((r) => `
        <tr class="${r.issue ? 'issue-row' + (r.issue === 'not_in_erpnext' ? ' bad' : '') : ''}">
          <td class="mono strong">${esc(r.user_id)}</td>
          <td class="small">${esc(r.device_user_name || '')}</td>
          <td class="small muted">${esc(r.devices || '—')}</td>
          <td class="small">${r.employee ? `<div class="strong">${esc(r.employee_name || '')}</div><div class="tiny muted">${esc(r.employee)}${r.department ? ' · ' + esc(r.department) : ''}</div>` : '<span class="muted">—</span>'}</td>
          <td>${r.employee_status ? `<span class="badge ${r.employee_status === 'Active' ? 'success' : 'warning'}">${esc(r.employee_status)}</span>` : ''}</td>
          <td class="small">${fmtNum(r.punches)}${r.last_punch ? `<div class="tiny muted">last ${fmtRelative(r.last_punch)}</div>` : ''}${r.pending || r.failed ? `<div class="tiny">${r.pending ? `<span class="st-running">${r.pending} pending</span> ` : ''}${r.failed ? `<span class="st-failed">${r.failed} failed</span>` : ''}</div>` : ''}</td>
          <td class="small">${r.issue ? `<span class="badge ${ISSUE[r.issue][0]}">${esc(ISSUE[r.issue][1])}</span>` : `<span class="badge success">${icon('check')} OK</span>`}</td>
          <td class="actions"><div class="btn-group">
            ${r.issue === 'not_in_erpnext' && data.employees_fetched_at ? `<button class="btn btn-sm" data-link="${esc(r.user_id)}">${icon('link')} Link…</button>` : ''}
            ${r.punches ? `<a class="btn btn-sm btn-ghost" href="#/punches/user/${encodeURIComponent(r.user_id)}" title="View punches">${icon('list')}</a>` : ''}
            ${r.failed ? `<button class="btn btn-sm btn-ghost" data-retry="${esc(r.user_id)}" title="Retry failed punches">${icon('refresh')}</button>` : ''}
          </div></td>
        </tr>`).join('') : `<tr><td colspan="8">${emptyState(filter === 'issues' ? 'checkCircle' : 'users', filter === 'issues' ? 'No problems found' : 'Nothing to show', filter === 'issues' ? 'Every machine user ID matches an active ERPNext employee.' : 'Read the users from the machines and the employees from ERPNext.')}</td></tr>`;
      $$('#m-body [data-link]').forEach((b) => (b.onclick = () => linkDialog(b.dataset.link, rows.find((r) => r.user_id === b.dataset.link))));
      $$('#m-body [data-retry]').forEach((b) => (b.onclick = async () => {
        try { const r = await api('/punches/retry', { method: 'POST', body: { user_id: b.dataset.retry, status: 'failed' } }); toast(`${r.count} punch(es) queued.`, 'success'); load(); } catch (e) { toastError(e); }
      }));
      const ul = data.unlinked_employees;
      $('#m-unlinked').innerHTML = `<div class="card-head"><h3>${icon('users', '')} Active employees without an attendance device ID (${ul.length})</h3></div>
        <div class="card-body tight table-wrap">${ul.length ? `<table class="table"><thead><tr><th>Employee</th><th>Name</th><th>Department</th><th>Company</th><th></th></tr></thead><tbody>
          ${ul.slice(0, 300).map((e) => `<tr><td class="mono small">${esc(e.name)}</td><td class="strong">${esc(e.employee_name || '')}</td><td class="small">${esc(e.department || '')}</td><td class="small muted">${esc(e.company || '')}</td><td class="actions"><button class="btn btn-sm" data-assign="${esc(e.name)}">${icon('link')} Set ID…</button></td></tr>`).join('')}
        </tbody></table>${ul.length > 300 ? `<div class="hint" style="padding:10px 20px">Showing the first 300.</div>` : ''}` : `<div class="empty small">${icon('checkCircle')}<div>${data.employees_fetched_at ? 'Every active employee has an ID.' : 'Read the employees from ERPNext first.'}</div></div>`}</div>`;
      $$('#m-unlinked [data-assign]').forEach((b) => (b.onclick = async () => {
        const emp = ul.find((e) => e.name === b.dataset.assign);
        const v = await promptDialog({ title: `Set attendance device ID`, label: `Machine user ID for ${emp.employee_name || emp.name}`, hint: 'The user ID this employee uses on the biometric machines. It is saved on the Employee in ERPNext.', confirm: 'Save to ERPNext' });
        if (v && v.trim()) doLink(emp.name, v.trim());
      }));
    };
    const doLink = async (employee, uid) => {
      try {
        const r = await api('/employees/link', { method: 'POST', body: { employee, user_id: uid } });
        toast(`Saved in ERPNext. ${r.requeued} punch(es) of ID ${uid} will be sent on the next sync.`, 'success', 'Employee linked', 8000);
        load();
      } catch (e) { showApiError(e, 'Could not update the employee'); }
    };
    const linkDialog = (uid, row) => {
      const list = data.unlinked_employees;
      const m = openModal({
        title: `Link user ID ${uid}`, icon: 'link', size: 'wide',
        body: `<p class="muted mt-0">Choose the ERPNext employee who uses ID <b class="mono">${esc(uid)}</b>${row?.device_user_name ? ` (“${esc(row.device_user_name)}” on the machine)` : ''}. The ID is saved in their <b>${esc(data.fieldname)}</b> field and the waiting punches are queued again.</p>
          <input class="input mb-2" id="lk-q" placeholder="Search employees without an ID…" value="${esc(row?.device_user_name || '')}">
          <div class="scan-list" id="lk-list"></div>
          <div class="hint mt-2">Only active employees without an ID are listed. The API user needs write permission on Employee.</div>`,
        foot: `<button class="btn" data-close>Cancel</button>`,
      });
      const drawList = () => {
        const ql = m.el.querySelector('#lk-q').value.trim().toLowerCase();
        const words = ql.split(/\s+/).filter(Boolean);
        const hits = list.filter((e) => !words.length || words.some((w) => [e.name, e.employee_name, e.department].join(' ').toLowerCase().includes(w))).slice(0, 100);
        m.el.querySelector('#lk-list').innerHTML = hits.length ? hits.map((e) => `<div class="row"><span class="strong">${esc(e.employee_name || '')}</span><span class="mono tiny muted">${esc(e.name)}</span><span class="small muted">${esc(e.department || '')}</span><span class="spacer"></span><button class="btn btn-sm btn-primary" data-pick="${esc(e.name)}">${icon('link')} Link</button></div>`).join('') : '<div class="empty small">No matching employees</div>';
        m.el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => { m.close(); doLink(b.dataset.pick, uid); }));
      };
      m.el.querySelector('#lk-q').oninput = drawList; drawList();
    };
    const load = async () => { try { data = await api('/employees/mapping'); draw(); } catch (e) { toastError(e); } };
    $$('#m-filter button').forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    let qt; $('#m-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim(); draw(); }, 200); };
    $('#m-emps').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Reading…');
      try { const r = await api('/employees/refresh', { method: 'POST' }); toast(`${fmtNum(r.count)} employee(s) read from ERPNext.`, 'success'); await load(); }
      catch (err) { showApiError(err, 'Could not read employees'); } finally { setBusy(btn, false); }
    };
    $('#m-users').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Reading machines…');
      try {
        const r = await api('/employees/read-device-users', { method: 'POST' });
        const bad = r.filter((x) => !x.ok);
        toast(r.filter((x) => x.ok).map((x) => `${x.device}: ${x.count}`).join(', ') || 'No machine could be read.', bad.length ? 'warning' : 'success', bad.length ? `${bad.length} machine(s) not reachable` : 'Users read');
        await load();
      } catch (err) { toastError(err); } finally { setBusy(btn, false); }
    };
    await load();
  },
};
