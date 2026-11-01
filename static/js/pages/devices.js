/* Machines: list, add/edit, test, clock, users, network scan */
'use strict';

Pages.devices = {
  title: 'Machines',
  async render(view) {
    view.innerHTML = `
      <div class="row mb-3">
        <div class="muted" style="flex:1;min-width:240px">Your biometric attendance machines (ZKTeco and compatible). All machines send their punches to the ERPNext site set in Settings.</div>
        <button class="btn" id="scan-net">${icon('scan')} Find machines on network</button>
        <button class="btn btn-primary" id="add-device">${icon('plus')} Add machine</button>
      </div>
      <div class="stack" id="device-list"><div class="muted">${icon('loader', 'spin')} Loading…</div></div>`;
    $('#add-device').onclick = () => Pages.devices.openEditor();
    $('#scan-net').onclick = () => openScanDialog();
    await Pages.devices.refresh();
    const offs = [on('run_finished', () => Pages.devices.refresh()), on('device', throttle(() => Pages.devices.refresh(), 2000))];
    return () => offs.forEach((f) => f());
  },

  async refresh() {
    const list = $('#device-list'); if (!list) return;
    let devices, settings;
    try { [devices, settings] = await Promise.all([loadDevices(), loadSettings()]); } catch (e) { list.innerHTML = `<div class="alert danger">${icon('xCircle')}<div>${esc(e.message)}</div></div>`; return; }
    if (!devices.length) {
      list.innerHTML = `<div class="card">${emptyState('fingerprint', 'No machines yet', 'Add a biometric machine by its IP address, or search the local network for machines.', `<div class="btn-group" style="justify-content:center"><button class="btn" id="empty-scan">${icon('scan')} Find machines</button><button class="btn btn-primary" id="empty-add">${icon('plus')} Add machine</button></div>`)}</div>`;
      $('#empty-add').onclick = () => Pages.devices.openEditor();
      $('#empty-scan').onclick = () => openScanDialog();
      return;
    }
    list.innerHTML = devices.map((d) => deviceCard(d, settings)).join('');
    devices.forEach((d) => bindDeviceCard(d));
  },

  openEditor(device = null, prefill = {}) { openDeviceEditor(device, prefill); },
};

function deviceCard(d, s) {
  const i = d.last_info || {};
  const avatar = !d.enabled ? '' : d.status === 'online' ? 'ok' : d.status === 'offline' ? 'bad' : '';
  const dir = d.punch_direction || s.default_punch_direction;
  const drift = i.drift_seconds;
  const driftBad = drift != null && s.time_drift_alert_seconds && Math.abs(drift) > s.time_drift_alert_seconds;
  return `
  <div class="card server-card device-card" data-device="${d.id}">
    <div class="server-head">
      <div class="server-avatar ${avatar}">${icon(d.status === 'offline' ? 'wifiOff' : 'fingerprint')}</div>
      <div class="server-title">
        <div class="name">${esc(d.name)} ${d.enabled ? '' : '<span class="badge outline">Disabled</span>'}
          ${statusBadge(d.status)}
          ${d.clear_after_sync ? `<span class="badge warning" title="The machine log is cleared after every punch is confirmed in ERPNext">${icon('trash')} Clears after sync</span>` : ''}
        </div>
        <div class="meta">
          <span title="IP address and port">${icon('globe')} ${esc(d.ip)}:${esc(d.port || s.device_port)}</span>
          <span title="Device ID sent to ERPNext">${icon('hash')} ${esc(d.device_id)}</span>
          ${d.location ? `<span>${icon('mapPin')} ${esc(d.location)}</span>` : ''}
          <span title="Punch direction">${icon('sliders')} ${esc(directionLabel(dir))}</span>
          ${i.serial ? `<span title="Serial number / firmware">${icon('cpu')} ${esc(i.serial)}${i.firmware ? ' · ' + esc(i.firmware) : ''}</span>` : ''}
          <span>${icon('clock')} Last read ${d.last_success_at ? `<span title="${esc(fmtDate(d.last_success_at, true))}">${fmtRelative(d.last_success_at)}</span>` : 'never'}</span>
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-sm" data-act="test">${icon('plug')} Test</button>
        <button class="btn btn-sm btn-primary" data-act="sync">${icon('refresh')} Sync now</button>
        <button class="btn btn-sm" data-act="users">${icon('users')} Users</button>
        <button class="btn btn-sm" data-act="edit">${icon('edit')} Edit</button>
        <button class="btn btn-sm btn-ghost" data-act="more" title="More tools">${icon('more')}</button>
      </div>
    </div>
    ${d.status === 'offline' && d.last_error ? `<div style="padding:0 20px 14px"><div class="alert danger">${icon('wifiOff')}<div style="flex:1"><div class="t">Not reachable${d.last_attempt_at ? ' · ' + esc(fmtDate(d.last_attempt_at)) : ''}</div>${esc(d.last_error)}<div class="small mt-1">Punches stay stored on the machine and are read automatically once it is reachable again.</div></div></div></div>` : ''}
    ${driftBad ? `<div style="padding:0 20px 14px"><div class="alert warning">${icon('clock')}<div style="flex:1"><div class="t">The machine clock is ${drift > 0 ? '+' : ''}${drift}s off this PC</div>Punch times may be wrong. Click <b>Sync time</b> under More tools, or enable automatic time sync in Settings.</div></div></div>` : ''}
    <div class="device-kpis">
      <div><div class="l">Today</div><div class="v">${fmtNum(d.stats.today)}</div></div>
      <div><div class="l">Waiting</div><div class="v ${d.stats.pending ? '' : 'muted'}">${fmtNum(d.stats.pending)}</div></div>
      <div><div class="l">Failed</div><div class="v ${d.stats.failed ? 'st-failed' : 'muted'}">${fmtNum(d.stats.failed)}</div></div>
      <div><div class="l">Stored on PC</div><div class="v">${fmtNum(d.stats.total)}</div></div>
      <div><div class="l">On machine</div><div class="v">${i.records != null ? fmtNum(i.records) : '—'} <small>${i.users != null ? `· ${fmtNum(i.users)} users` : ''}</small></div></div>
    </div>
  </div>`;
}

function bindDeviceCard(d) {
  const card = $(`[data-device="${d.id}"]`);
  card.querySelector('[data-act=test]').onclick = (e) => testDevice(d, e.currentTarget);
  card.querySelector('[data-act=sync]').onclick = () => quickSync([d.id]);
  card.querySelector('[data-act=users]').onclick = () => openUsersDialog(d);
  card.querySelector('[data-act=edit]').onclick = () => openDeviceEditor(d);
  card.querySelector('[data-act=more]').onclick = () => deviceMoreMenu(d);
}

async function testDevice(d, btn) {
  setBusy(btn, true, 'Testing…');
  try {
    const i = await api(`/devices/${d.id}/test`, { method: 'POST' });
    openModal({
      title: `${d.name}: connected`, icon: 'checkCircle',
      body: `<div class="alert success mb-3">${icon('checkCircle')}<div>The machine answered in ${i.response_ms} ms.</div></div>
        <div class="kv">
          <div>Device name</div><div>${esc(i.device_name || '—')}</div>
          <div>Serial number</div><div class="mono">${esc(i.serial || '—')}</div>
          <div>Platform / firmware</div><div>${esc(i.platform || '—')} · ${esc(i.firmware || '—')}</div>
          <div>MAC address</div><div class="mono">${esc(i.mac || '—')}</div>
          <div>Users</div><div>${fmtNum(i.users)}${i.users_cap ? ` of ${fmtNum(i.users_cap)}` : ''}</div>
          <div>Fingerprints / faces</div><div>${i.fingers ?? '—'} / ${i.faces ?? '—'}</div>
          <div>Attendance records</div><div>${fmtNum(i.records)}${i.records_cap ? ` of ${fmtNum(i.records_cap)} capacity` : ''}</div>
          <div>Machine clock</div><div>${esc(i.clock || '—')} ${i.drift_seconds != null ? `<span class="${Math.abs(i.drift_seconds) > 60 ? 'st-failed' : 'muted'}">(${i.drift_seconds > 0 ? '+' : ''}${i.drift_seconds}s vs this PC)</span>` : ''}</div>
        </div>
        ${i.records_cap && i.records / i.records_cap > 0.8 ? `<div class="alert warning mt-3">${icon('alert')}<div>The attendance log is ${Math.round(100 * i.records / i.records_cap)}% full. Consider enabling <b>Clear machine log after sync</b> (safe mode) for this machine.</div></div>` : ''}`,
      foot: `<button class="btn" data-time>${icon('clock')} Sync time</button><button class="btn btn-primary" data-close>Close</button>`,
    }).el.querySelector('[data-time]').onclick = (e) => syncTime(d, e.currentTarget);
    Pages.devices.refresh();
  } catch (e) { showApiError(e, `${d.name}: connection failed`); Pages.devices.refresh(); }
  finally { setBusy(btn, false); }
}

async function syncTime(d, btn) {
  if (!await confirmDialog({ title: 'Set machine clock?', message: `Set the clock of <b>${esc(d.name)}</b> to this PC's time (${new Date().toLocaleString()})? Make sure this PC's clock is correct.`, confirm: 'Set time' })) return;
  setBusy(btn, true, 'Setting…');
  try { const i = await api(`/devices/${d.id}/sync-time`, { method: 'POST' }); toast(`Clock set. Machine time is now ${i.clock}.`, 'success'); Pages.devices.refresh(); }
  catch (e) { showApiError(e, 'Could not set the time'); } finally { setBusy(btn, false); }
}

async function openUsersDialog(d) {
  const m = openModal({
    title: `${d.name}: users`, icon: 'users', size: 'wide',
    body: `<div class="row mb-2"><input class="input" id="u-q" placeholder="Filter by ID or name…" style="max-width:280px"><span class="spacer"></span><span class="muted small" id="u-meta"></span><button class="btn btn-sm" id="u-refresh">${icon('download')} Read from machine</button></div>
      <div class="table-wrap" style="max-height:420px"><table class="table"><thead><tr><th>User ID</th><th>Name on machine</th><th>Privilege</th><th>Card</th></tr></thead><tbody id="u-rows"><tr><td colspan="4" class="muted">${icon('loader', 'spin')} Loading…</td></tr></tbody></table></div>
      <div class="hint mt-2">The <b>User ID</b> must match the employee's <b>Attendance Device ID</b> in ERPNext. Check all machines at once under <a href="#/employees" data-close>Employee Mapping</a>.</div>`,
    foot: `<button class="btn btn-primary" data-close>Close</button>`,
  });
  let users = [];
  const draw = () => {
    const q = m.el.querySelector('#u-q').value.trim().toLowerCase();
    const rows = users.filter((u) => !q || (u.user_id + ' ' + (u.name || '')).toLowerCase().includes(q));
    m.el.querySelector('#u-rows').innerHTML = rows.length ? rows.map((u) => `<tr><td class="strong mono">${esc(u.user_id)}</td><td>${esc(u.name || '')}</td><td>${u.privilege === 14 ? '<span class="badge primary">Admin</span>' : '<span class="muted small">User</span>'}</td><td class="mono small">${esc(u.card && u.card !== '0' ? u.card : '')}</td></tr>`).join('')
      : `<tr><td colspan="4">${emptyState('users', users.length ? 'No match' : 'No users read yet', users.length ? '' : 'Click “Read from machine”.')}</td></tr>`;
    m.el.querySelector('#u-meta').textContent = users.length ? `${users.length} user(s) · read ${fmtRelative(users[0].fetched_at)}` : '';
  };
  const load = async (refresh) => {
    try { users = await api(`/devices/${d.id}/users${refresh ? '?refresh=true' : ''}`); draw(); }
    catch (e) { showApiError(e, 'Could not read users'); draw(); }
  };
  m.el.querySelector('#u-q').oninput = draw;
  m.el.querySelector('#u-refresh').onclick = async (e) => { setBusy(e.currentTarget, true, 'Reading…'); await load(true); setBusy(e.currentTarget, false); };
  m.el.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => { location.hash = '#/employees'; }));
  await load(false);
  if (!users.length) load(true);
}

function deviceMoreMenu(d) {
  const m = openModal({
    title: d.name, icon: 'fingerprint',
    body: `<div class="stack">
      <button class="btn" data-a="time">${icon('clock')} Sync time (set machine clock to this PC)</button>
      <button class="btn" data-a="resync">${icon('history')} Re-send a date range to ERPNext…</button>
      <button class="btn" data-a="punches">${icon('list')} View punches from this machine</button>
      <button class="btn" data-a="logs">${icon('logs')} View logs for this machine</button>
      <button class="btn" data-a="toggle">${icon('power')} ${d.enabled ? 'Disable' : 'Enable'} automatic sync for this machine</button>
      <button class="btn" data-a="dup">${icon('copy')} Duplicate settings (new machine)</button>
      <button class="btn btn-soft-danger" data-a="delete">${icon('trash')} Delete machine</button>
      <div class="hint">Deleting a machine removes its local punch history from this PC. Check-ins already in ERPNext are not touched.</div>
    </div>`,
  });
  m.el.querySelector('[data-a=time]').onclick = (e) => syncTime(d, e.currentTarget);
  m.el.querySelector('[data-a=resync]').onclick = () => { m.close(); openSyncDialog({ deviceIds: [d.id], resync: true, from: todayStr(-7), to: todayStr() }); };
  m.el.querySelector('[data-a=punches]').onclick = () => { m.close(); location.hash = `#/punches/device/${d.id}`; };
  m.el.querySelector('[data-a=logs]').onclick = () => { m.close(); location.hash = '#/logs/device/' + encodeURIComponent(d.name); };
  m.el.querySelector('[data-a=toggle]').onclick = async () => {
    m.close();
    try { await api(`/devices/${d.id}`, { method: 'PUT', body: deviceBody(d, { enabled: !d.enabled }) }); toast(`Machine ${d.enabled ? 'disabled' : 'enabled'}.`, 'success'); Pages.devices.refresh(); } catch (e) { toastError(e); }
  };
  m.el.querySelector('[data-a=dup]').onclick = () => { m.close(); openDeviceEditor(null, { ...d, name: d.name + ' (copy)', device_id: d.device_id + '_2', ip: '' }); };
  m.el.querySelector('[data-a=delete]').onclick = async () => {
    m.close();
    const warn = d.stats.pending ? `<br><br><b class="st-failed">${fmtNum(d.stats.pending)} punch(es) of this machine have not been sent to ERPNext yet and will be lost locally.</b> (They are still on the machine unless it was cleared.)` : '';
    if (!await confirmDialog({ title: 'Delete machine?', message: `Remove <b>${esc(d.name)}</b> and its ${fmtNum(d.stats.total)} locally stored punch(es)? ERPNext is not affected.${warn}`, confirm: 'Delete', danger: true })) return;
    try { await api(`/devices/${d.id}`, { method: 'DELETE' }); toast('Machine deleted.', 'success'); Pages.devices.refresh(); } catch (e) { toastError(e); }
  };
}

function deviceBody(d, over = {}) {
  return {
    name: d.name, device_id: d.device_id, ip: d.ip, port: d.port, timeout: d.timeout, force_udp: d.force_udp,
    punch_direction: d.punch_direction, latitude: d.latitude, longitude: d.longitude, import_start_date: d.import_start_date,
    clear_after_sync: d.clear_after_sync, enabled: d.enabled, location: d.location || '', notes: d.notes || '', password: null, ...over,
  };
}

async function openDeviceEditor(device = null, prefill = {}) {
  const s = store.settings || await loadSettings();
  const d = device || { enabled: true, clear_after_sync: false, ...prefill };
  const isNew = !device;
  const inherit = (v, label) => `<option value="" ${v == null || v === '' ? 'selected' : ''}>Default (${esc(label)})</option>`;
  const m = openModal({
    title: isNew ? 'Add machine' : `Edit ${d.name}`, icon: 'fingerprint', size: 'wide',
    body: `<form id="dev-form" class="stack" autocomplete="off">
      <div class="form-section" style="padding:0;border:0"><h3>${icon('info')} General</h3>
        <div class="form-grid">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(d.name || '')}" placeholder="Main gate" required></div>
          <div class="field"><label>Device ID (sent to ERPNext)</label><input class="input mono" name="device_id" value="${esc(d.device_id || '')}" placeholder="MAIN_GATE" required><div class="hint">Unique. Letters, digits, '-' and '_' only. Appears as <i>Device ID</i> on each Employee Checkin.</div></div>
          <div class="field"><label>Location (optional)</label><input class="input" name="location" value="${esc(d.location || '')}" placeholder="Head office, ground floor"></div>
          <div class="field"><label>&nbsp;</label>${switchHtml('enabled', d.enabled, 'Include in automatic sync')}</div>
        </div></div>
      <div class="form-section" style="padding:0;border:0"><h3>${icon('network')} Connection</h3>
        <div class="form-grid">
          <div class="field"><label>IP address or host name</label><input class="input mono" name="ip" value="${esc(d.ip || '')}" placeholder="192.168.1.201" required></div>
          <div class="field"><label>Port</label><input class="input" type="number" name="port" min="1" max="65535" value="${esc(d.port ?? '')}" placeholder="${esc(s.device_port)} (default)"></div>
          <div class="field"><label>Communication password (comm key)</label><input class="input" type="password" name="password" inputmode="numeric" placeholder="${d.has_password ? '•••••• (saved, leave empty to keep)' : `Default (${s.device_password ? 'set in Settings' : '0 = none'})`}"><div class="hint">Menu → Comm. on the machine. Usually 0.${d.has_password ? ' <a href="javascript:void(0)" id="pw-clear">Use the default instead</a>' : ''}</div></div>
          <div class="field"><label>Timeout (seconds)</label><input class="input" type="number" name="timeout" min="3" max="600" value="${esc(d.timeout ?? '')}" placeholder="${esc(s.device_timeout)} (default)"></div>
          <div class="field"><label>Protocol</label><select class="input" name="force_udp">${inherit(d.force_udp, s.device_force_udp ? 'UDP' : 'TCP')}<option value="0" ${d.force_udp === false ? 'selected' : ''}>TCP</option><option value="1" ${d.force_udp === true ? 'selected' : ''}>UDP (older machines)</option></select></div>
        </div></div>
      <div class="form-section" style="padding:0;border:0"><h3>${icon('sliders')} Punches</h3>
        <div class="form-grid">
          <div class="field"><label>Punch direction (log type)</label><select class="input" name="punch_direction">${inherit(d.punch_direction, directionLabel(s.default_punch_direction))}${['AUTO', 'IN', 'OUT', 'NONE'].map((x) => `<option value="${x}" ${d.punch_direction === x ? 'selected' : ''}>${directionLabel(x)}</option>`).join('')}</select><div class="hint">Use <b>Always IN</b> / <b>Always OUT</b> for separate entry and exit machines.</div></div>
          <div class="field"><label>Import punches from (optional)</label><input class="input" type="date" name="import_start_date" value="${esc(d.import_start_date || '')}"><div class="hint">Older punches on this machine are ignored. Empty = ${s.import_start_date ? esc(s.import_start_date) + ' (global)' : 'all punches'}.</div></div>
          <div class="field"><label>Latitude (optional)</label><input class="input" type="number" step="any" name="latitude" value="${esc(d.latitude ?? '')}" placeholder="e.g. 24.8607"></div>
          <div class="field"><label>Longitude (optional)</label><input class="input" type="number" step="any" name="longitude" value="${esc(d.longitude ?? '')}" placeholder="e.g. 67.0011"><div class="hint">Needed only when <i>Allow Geolocation Tracking</i> is on in Frappe HR (v15+).</div></div>
        </div></div>
      <div class="form-section" style="padding:0;border:0"><h3>${icon('shield')} Machine log</h3>
        <div class="toggle-row"><div><div class="t">Clear machine log after sync (safe mode)</div><div class="d">Frees memory on the machine. The log is cleared <b>only</b> when every punch read is stored on this PC <b>and</b> confirmed in ERPNext, and no new punch arrived meanwhile. Otherwise clearing waits for a later run.</div></div>${switchHtml('clear_after_sync', d.clear_after_sync)}</div>
      </div>
      <div class="field"><label>Notes</label><textarea class="input" name="notes" rows="2">${esc(d.notes || '')}</textarea></div>
    </form>`,
    foot: `${isNew ? '' : `<button class="btn" data-test>${icon('plug')} Save &amp; test</button>`}<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-save>${icon('check')} ${isNew ? 'Add machine' : 'Save'}</button>`,
  });
  const f = m.el.querySelector('#dev-form');
  let clearPw = false;
  m.el.querySelector('#pw-clear')?.addEventListener('click', (e) => { clearPw = true; e.target.textContent = 'Default will be used after saving'; f.password.placeholder = 'Default'; });
  f.name.addEventListener('input', () => {
    if (isNew && !f.device_id.dataset.touched) f.device_id.value = f.name.value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
  });
  f.device_id.addEventListener('input', () => { f.device_id.dataset.touched = '1'; });
  f.clear_after_sync.addEventListener('change', async () => {
    if (f.clear_after_sync.checked && !await confirmDialog({ title: 'Clear the machine log?', message: 'After each successful sync, the attendance log on the machine is deleted (only when every punch is confirmed in ERPNext). The punches remain stored on this PC and in ERPNext. Continue?', confirm: 'Enable', danger: true })) f.clear_after_sync.checked = false;
  });
  const save = async (btn, thenTest) => {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const body = {
      name: f.name.value, device_id: f.device_id.value, ip: f.ip.value, port: num(f.port.value), timeout: num(f.timeout.value),
      force_udp: f.force_udp.value === '' ? null : f.force_udp.value === '1', punch_direction: f.punch_direction.value || null,
      latitude: num(f.latitude.value), longitude: num(f.longitude.value), import_start_date: f.import_start_date.value || null,
      clear_after_sync: f.clear_after_sync.checked, enabled: f.enabled.checked, location: f.location.value, notes: f.notes.value,
      password: f.password.value ? f.password.value : (clearPw ? '' : (isNew ? '' : null)),
    };
    setBusy(btn, true, 'Saving…');
    try {
      const saved = await api(isNew ? '/devices' : `/devices/${d.id}`, { method: isNew ? 'POST' : 'PUT', body });
      m.close();
      toast(isNew ? 'Machine added. Testing the connection…' : 'Machine saved.', 'success');
      await Pages.devices.refresh();
      if (isNew || thenTest) {
        const b = $(`[data-device="${saved.id}"] [data-act=test]`);
        if (b) testDevice(saved, b);
      }
    } catch (e) { setBusy(btn, false); toastError(e, 'Could not save'); }
  };
  m.el.querySelector('[data-save]').onclick = (e) => save(e.currentTarget, false);
  m.el.querySelector('[data-test]')?.addEventListener('click', (e) => save(e.currentTarget, true));
}

async function openScanDialog() {
  let net = '';
  try { net = (await api('/devices/scan/network')).network; } catch (e) { /* ignore */ }
  const m = openModal({
    title: 'Find machines on the network', icon: 'scan', size: 'wide',
    body: `<p class="muted mt-0">Searches the network for devices that answer on the ZKTeco port. It only checks whether the port is open; it does not change anything.</p>
      <div class="row"><div class="field" style="flex:1;min-width:200px"><label>Network</label><input class="input mono" name="net" value="${esc(net)}" placeholder="192.168.1.0/24"></div>
      <div class="field" style="width:120px"><label>Port</label><input class="input" type="number" name="port" value="4370"></div>
      <div class="field"><label>&nbsp;</label><button class="btn btn-primary" data-scan>${icon('search')} Scan</button></div></div>
      <div class="mt-3" id="scan-out"></div>`,
    foot: `<button class="btn" data-close>Close</button>`,
  });
  m.el.querySelector('[data-scan]').onclick = async (e) => {
    const btn = e.currentTarget; setBusy(btn, true, 'Scanning…');
    const out = m.el.querySelector('#scan-out');
    out.innerHTML = `<div class="muted">${icon('loader', 'spin')} Scanning, this takes a few seconds…</div>`;
    try {
      const r = await api('/devices/scan', { method: 'POST', body: { network: m.el.querySelector('[name=net]').value, port: Number(m.el.querySelector('[name=port]').value) || 4370 } });
      out.innerHTML = r.found.length ? `<div class="label mb-1">${r.found.length} device(s) found in ${esc(r.network)}</div><div class="scan-list">${r.found.map((x) => `
          <div class="row"><span>${icon('fingerprint', '')}</span><span class="mono strong">${esc(x.ip)}</span><span class="spacer"></span>${x.known ? '<span class="badge success">already added</span>' : `<button class="btn btn-sm btn-primary" data-add="${esc(x.ip)}">${icon('plus')} Add</button>`}</div>`).join('')}</div>`
        : emptyState('search', 'No machines found', 'Check that the machines are switched on and on the same network, or enter another network range.');
      out.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
        const port = Number(m.el.querySelector('[name=port]').value) || 4370;
        m.close(); openDeviceEditor(null, { ip: b.dataset.add, port: port === 4370 ? null : port, name: `Machine ${b.dataset.add.split('.').pop()}` });
      }));
    } catch (err) { out.innerHTML = ''; toastError(err); }
    finally { setBusy(btn, false); }
  };
}
