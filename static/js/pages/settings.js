/* Settings */
'use strict';

Pages.settings = {
  title: 'Settings',
  async render(view, args) {
    const [s, auto, devices] = await Promise.all([loadSettings(), api('/autostart').catch(() => null), loadDevices().catch(() => [])]);
    const info = store.info || {};
    const sections = [['erpnext', 'cloud', 'ERPNext connection'], ['sync', 'calendar', 'Sync & schedule'], ['machines', 'fingerprint', 'Machine defaults'], ['punches', 'sliders', 'Punch rules'],
      ['errors', 'refresh', 'Error handling'], ['shifts', 'clock', 'Shift types'], ['notify', 'bell', 'Notifications & e-mail'], ['network', 'shield', 'Network & security'],
      ['startup', 'power', 'Startup'], ['maintenance', 'wrench', 'Maintenance']];
    const start = sections.some((x) => x[0] === args[0]) ? args[0] : 'erpnext';
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    const num = (name, val, extra = '') => `<input class="input" type="number" name="${name}" value="${esc(val)}" ${extra}>`;
    view.innerHTML = `
      <div class="grid" style="grid-template-columns: 230px minmax(0,1fr); align-items:start" id="set-grid">
        <div class="card" style="padding:8px;position:sticky;top:84px" id="set-nav">${sections.map(([id, ic, l]) => `<a href="javascript:void(0)" class="btn btn-ghost" style="width:100%;justify-content:flex-start" data-sec="${id}">${icon(ic)} ${l}</a>`).join('')}</div>
        <form class="card" id="set-form" autocomplete="off">
          <div class="card-body">

            <section data-s="erpnext" class="form-section">
              <h3>${icon('cloud')} ERPNext connection</h3><p class="desc">All machines send their punches to this ERPNext / Frappe HR site as <b>Employee Checkin</b> records.</p>
              <div class="form-grid">
                <div class="field" style="grid-column:1/-1"><label>ERPNext URL</label><input class="input mono" name="erpnext_url" value="${esc(s.erpnext_url)}" placeholder="https://erp.yourcompany.com"></div>
                <div class="field"><label>API key</label><input class="input mono" name="erpnext_api_key" value="${esc(s.erpnext_api_key)}" autocomplete="off"></div>
                <div class="field"><label>API secret</label><input class="input mono" type="password" name="erpnext_api_secret" autocomplete="new-password" placeholder="${s.has_erpnext_secret ? '•••••••• saved, leave empty to keep' : ''}"><div class="hint">Stored encrypted on this PC.</div></div>
                <div class="field"><label>ERPNext / HRMS version</label><select class="input" name="erpnext_version">${opt('auto', s.erpnext_version, 'Detect automatically (recommended)')}${['12', '13', '14', '15', '16'].map((v) => opt(v, s.erpnext_version, 'Version ' + v + (Number(v) > 13 ? ' (HRMS app)' : ''))).join('')}</select><div class="hint">v14+ uses the separate HRMS app for check-ins.</div></div>
                <div class="field"><label>Employee field holding the machine user ID</label><input class="input mono" name="employee_fieldname" value="${esc(s.employee_fieldname)}"><div class="hint">Default <code>attendance_device_id</code> (“Attendance Device ID” on the Employee).</div></div>
                <div class="field"><label>Request timeout (seconds)</label>${num('request_timeout', s.request_timeout, 'min="5" max="600"')}</div>
                <div class="field"><label>Parallel requests to ERPNext</label>${num('erp_concurrency', s.erp_concurrency, 'min="1" max="10"')}<div class="hint">1–2 is gentle on small servers.</div></div>
                <div class="field"><label>Pause between check-ins (ms)</label>${num('push_delay_ms', s.push_delay_ms, 'min="0" max="10000"')}<div class="hint">Use this if your server applies rate limits.</div></div>
              </div>
              <div class="toggle-row mt-2"><div><div class="t">Verify SSL certificate</div><div class="d">Turn off only for self-signed certificates on a private network.</div></div>${switchHtml('verify_ssl', s.verify_ssl)}</div>
              <div class="toggle-row"><div><div class="t">Skip auto attendance</div><div class="d">Sets <i>Skip Auto Attendance</i> on created check-ins, so the Shift Type does not mark attendance from them.</div></div>${switchHtml('skip_auto_attendance', s.skip_auto_attendance)}</div>
              <div class="row mt-2"><button type="button" class="btn" id="erp-test">${icon('plug')} Test connection</button><span class="muted small">Uses the values above, even before saving.</span></div>
              <div id="erp-result" class="mt-2"></div>
              <div class="alert info mt-2">${icon('key')}<div><div class="t">Creating an API key</div>In ERPNext open <b>User</b> → the integration user → <b>Settings → API Access → Generate Keys</b>. The user needs <b>Create</b> on <i>Employee Checkin</i>, <b>Write</b> on <i>Shift Type</i> (for shift sync), and <b>Read</b> on <i>Employee</i> (for Employee Mapping). Write on <i>Employee</i> is needed only for linking IDs from this app.</div></div>
            </section>

            <section data-s="sync" class="form-section">
              <h3>${icon('calendar')} Sync &amp; schedule</h3><p class="desc">How often the machines are read and punches are sent. Failed punches are retried on these runs too.</p>
              <div class="toggle-row"><div><div class="t">Automatic sync</div><div class="d">The service must be running (see Startup).</div></div>${switchHtml('sync_enabled', s.sync_enabled)}</div>
              <div class="form-grid mt-2">
                <div class="field"><label>Sync every (minutes)</label>${num('sync_interval_minutes', s.sync_interval_minutes, 'min="1" max="1440"')}<div class="hint">5–15 minutes is typical. Each run reads every enabled machine.</div></div>
                <div class="field"><label>Machines read in parallel</label>${num('parallel_devices', s.parallel_devices, 'min="1" max="32"')}</div>
              </div>
              <div class="toggle-row mt-2"><div><div class="t">Sync when the service starts</div><div class="d">Catches up right after the PC boots.</div></div>${switchHtml('sync_on_startup', s.sync_on_startup)}</div>
              <div class="toggle-row"><div><div class="t">Only sync during active hours</div><div class="d">For example office hours. Outside the window, nothing runs automatically (manual sync still works).</div></div>${switchHtml('active_hours_enabled', s.active_hours_enabled)}</div>
              <div id="active-box">
                <div class="form-grid mt-2"><div class="field"><label>From</label><input type="time" class="input" name="active_from" value="${esc(s.active_from)}"></div><div class="field"><label>To</label><input type="time" class="input" name="active_to" value="${esc(s.active_to)}"><div class="hint">A window over midnight (e.g. 20:00 → 06:00) works too.</div></div></div>
                <div class="field mt-2"><label>Days</label><div class="day-picker" id="days">${DAYS.map((d, i) => `<button type="button" data-d="${i}">${d}</button>`).join('')}</div>
                  <div class="row mt-1"><button type="button" class="btn btn-sm btn-ghost" data-preset="all">Every day</button><button type="button" class="btn btn-sm btn-ghost" data-preset="work">Mon–Fri</button><button type="button" class="btn btn-sm btn-ghost" data-preset="mon-sat">Mon–Sat</button><button type="button" class="btn btn-sm btn-ghost" data-preset="sun-thu">Sun–Thu</button></div></div>
              </div>
            </section>

            <section data-s="machines" class="form-section">
              <h3>${icon('fingerprint')} Machine defaults</h3><p class="desc">Used by every machine unless it has its own value (Machines → Edit).</p>
              <div class="form-grid">
                <div class="field"><label>Port</label>${num('device_port', s.device_port, 'min="1" max="65535"')}<div class="hint">ZKTeco default: 4370.</div></div>
                <div class="field"><label>Communication password (comm key)</label>${num('device_password', s.device_password, 'min="0"')}<div class="hint">0 = none.</div></div>
                <div class="field"><label>Connection timeout (seconds)</label>${num('device_timeout', s.device_timeout, 'min="3" max="600"')}<div class="hint">Raise it for machines with many records.</div></div>
                <div class="field"><label>Retries when a machine does not answer</label>${num('device_retries', s.device_retries, 'min="0" max="10"')}</div>
                <div class="field"><label>Delay between retries (seconds)</label>${num('device_retry_delay', s.device_retry_delay, 'min="0" max="600"')}</div>
                <div class="field"><label>Warn when the clock is off by more than (seconds)</label>${num('time_drift_alert_seconds', s.time_drift_alert_seconds, 'min="0"')}<div class="hint">0 = never warn.</div></div>
              </div>
              <div class="toggle-row mt-2"><div><div class="t">Use UDP instead of TCP</div><div class="d">Needed for some older machines.</div></div>${switchHtml('device_force_udp', s.device_force_udp)}</div>
              <div class="toggle-row"><div><div class="t">Skip the ping check before connecting</div><div class="d">Turn on if ping (ICMP) is blocked on your network but the machine port works.</div></div>${switchHtml('device_ommit_ping', s.device_ommit_ping)}</div>
              <div class="toggle-row"><div><div class="t">Lock the machine while reading</div><div class="d">Disables the keypad / sensor for a few seconds while the log is read, so no punch is missed. Recommended.</div></div>${switchHtml('disable_device_during_fetch', s.disable_device_during_fetch)}</div>
              <div class="toggle-row"><div><div class="t">Correct the machine clock automatically</div><div class="d">When the drift exceeds the limit above, the machine clock is set to this PC's time during sync.</div></div>${switchHtml('auto_sync_device_time', s.auto_sync_device_time)}</div>
              <div class="toggle-row"><div><div class="t">Allow clearing the machine log (clear_from_device_on_fetch)</div><div class="d">Off by default: punches are <b>never</b> deleted from the attendance machines. When on, a machine's log is cleared only if that machine also has <b>Clear machine log after sync (safe mode)</b> enabled and every punch is confirmed in ERPNext.</div></div>${switchHtml('clear_from_device_on_fetch', s.clear_from_device_on_fetch)}</div>
            </section>

            <section data-s="punches" class="form-section">
              <h3>${icon('sliders')} Punch rules</h3><p class="desc">How punches are turned into ERPNext check-ins.</p>
              <div class="form-grid">
                <div class="field"><label>Default punch direction (log type)</label><select class="input" name="default_punch_direction">${['AUTO', 'IN', 'OUT', 'NONE'].map((x) => opt(x, s.default_punch_direction, directionLabel(x))).join('')}</select><div class="hint"><b>Auto</b> uses the key pressed on the machine (below). <b>Not set</b> lets ERPNext alternate IN/OUT by shift.</div></div>
                <div class="field"><label>Import punches from</label><input class="input" type="date" name="import_start_date" value="${esc(s.import_start_date)}"><div class="hint">Older punches on the machines are ignored. Empty = all.</div></div>
                <div class="field"><label>Machine key values meaning IN</label><input class="input mono" name="punch_values_in" value="${esc((s.punch_values_in || []).join(', '))}"><div class="hint">Default 0, 4 (Check-in, Overtime-in).</div></div>
                <div class="field"><label>Machine key values meaning OUT</label><input class="input mono" name="punch_values_out" value="${esc((s.punch_values_out || []).join(', '))}"><div class="hint">Default 1, 5 (Check-out, Overtime-out).</div></div>
                <div class="field"><label>Ignore repeated punches within (seconds)</label>${num('repeat_punch_seconds', s.repeat_punch_seconds, 'min="0" max="3600"')}<div class="hint">Employees often punch twice. 0 = send every punch.</div></div>
                <div class="field"><label>Time offset (minutes)</label>${num('timestamp_offset_minutes', s.timestamp_offset_minutes, 'min="-1440" max="1440"')}<div class="hint">Added to the machine time before sending. Use only if the machines run in another time zone than ERPNext.</div></div>
                <div class="field"><label>Skip punches more than N minutes in the future</label>${num('ignore_future_minutes', s.ignore_future_minutes, 'min="0"')}<div class="hint">Protects ERPNext from a machine with a wrong clock. 0 = off.</div></div>
              </div>
            </section>

            <section data-s="errors" class="form-section">
              <h3>${icon('refresh')} Error handling &amp; retries</h3><p class="desc">The sync never stops on one bad punch or one offline machine. Each punch is retried on its own with increasing waits.</p>
              <div class="form-grid">
                <div class="field"><label>Attempts per punch before giving up</label>${num('max_push_attempts', s.max_push_attempts, 'min="1" max="100"')}<div class="hint">Then the punch is marked <b>Failed</b> and can be retried by hand.</div></div>
                <div class="field"><label>First retry after (minutes)</label>${num('retry_base_minutes', s.retry_base_minutes, 'min="1"')}</div>
                <div class="field"><label>Longest wait between retries (minutes)</label>${num('retry_max_minutes', s.retry_max_minutes, 'min="1"')}</div>
                <div class="field"><label>Pause sending after N ERPNext errors in a row</label>${num('erp_failure_breaker', s.erp_failure_breaker, 'min="1" max="100"')}<div class="hint">When ERPNext is down, pausing avoids hundreds of useless requests. Machines are still read.</div></div>
                <div class="field"><label>When no employee has the machine user ID</label><select class="input" name="unknown_employee_action">${opt('retry', s.unknown_employee_action, 'Keep retrying (HR may add the ID later)')}${opt('skip', s.unknown_employee_action, 'Skip the punch')}</select></div>
                <div class="field"><label>When the employee is inactive</label><select class="input" name="inactive_employee_action">${opt('skip', s.inactive_employee_action, 'Skip the punch')}${opt('retry', s.inactive_employee_action, 'Keep retrying')}</select></div>
              </div>
              <div class="alert info mt-2" id="backoff-preview">${icon('clock')}<div></div></div>
              <div class="hint mt-1">Duplicates (a check-in with the same employee and time already exists) are marked as synced, so re-sending is always safe.</div>
            </section>

            <section data-s="shifts" class="form-section">
              <h3>${icon('clock')} Shift types</h3><p class="desc">ERPNext's auto attendance only processes check-ins up to the Shift Type's <b>Last Sync of Checkin</b>. The app updates it once every machine of the shift has been read and all its punches are sent, so attendance is never marked from incomplete data.</p>
              <div class="toggle-row"><div><div class="t">Update “Last Sync of Checkin”</div><div class="d">Needs Write permission on Shift Type.</div></div>${switchHtml('shift_sync_enabled', s.shift_sync_enabled)}</div>
              <div id="shift-maps" class="mt-2"></div>
              <div class="row mt-2"><button type="button" class="btn btn-sm" id="shift-add">${icon('plus')} Add mapping</button><button type="button" class="btn btn-sm btn-ghost" id="shift-load">${icon('download')} Load shift types from ERPNext</button><span class="muted small" id="shift-note"></span></div>
            </section>

            <section data-s="notify" class="form-section">
              <h3>${icon('bell')} Notifications &amp; e-mail alerts</h3>
              <div class="toggle-row"><div><div class="t">Desktop notifications</div><div class="d">Show a system notification when a sync finishes.</div></div>${switchHtml('notify_desktop', s.notify_desktop)}</div>
              <div class="toggle-row"><div><div class="t">Only when something goes wrong</div><div class="d">Skip the notification for fully successful syncs.</div></div>${switchHtml('notify_only_failures', s.notify_only_failures)}</div>
              <div class="toggle-row"><div><div class="t">E-mail alerts</div><div class="d">For offline machines, failed punches and ERPNext outages. Each alert is repeated at most once per cool-down.</div></div>${switchHtml('email_enabled', s.email_enabled)}</div>
              <div id="mail-box">
                <div class="form-grid mt-2">
                  <div class="field"><label>SMTP server</label><input class="input mono" name="smtp_host" value="${esc(s.smtp_host)}" placeholder="smtp.gmail.com"></div>
                  <div class="field"><label>Port &amp; security</label><div class="input-group">${num('smtp_port', s.smtp_port, 'min="1" max="65535" style="max-width:110px"')}<select class="input" name="smtp_security">${opt('starttls', s.smtp_security, 'STARTTLS (587)')}${opt('ssl', s.smtp_security, 'SSL/TLS (465)')}${opt('none', s.smtp_security, 'None (25)')}</select></div></div>
                  <div class="field"><label>User name</label><input class="input" name="smtp_user" value="${esc(s.smtp_user)}" autocomplete="off"></div>
                  <div class="field"><label>Password</label><input class="input" type="password" name="smtp_password" autocomplete="new-password" placeholder="${s.has_smtp_password ? '•••••••• saved, leave empty to keep' : ''}"><div class="hint">For Gmail use an <i>App password</i>.</div></div>
                  <div class="field"><label>From address</label><input class="input" name="smtp_from" value="${esc(s.smtp_from)}" placeholder="attendance@yourcompany.com"></div>
                  <div class="field"><label>Send alerts to</label><input class="input" name="email_to" value="${esc((s.email_to || []).join(', '))}" placeholder="hr@yourcompany.com, it@yourcompany.com"></div>
                  <div class="field"><label>Alert when a machine is offline for (minutes)</label>${num('alert_device_offline_minutes', s.alert_device_offline_minutes, 'min="0"')}<div class="hint">0 = off.</div></div>
                  <div class="field"><label>Alert when failed punches reach</label>${num('alert_failed_punches', s.alert_failed_punches, 'min="0"')}<div class="hint">0 = off.</div></div>
                  <div class="field"><label>Alert when ERPNext is unreachable for (minutes)</label>${num('alert_erp_down_minutes', s.alert_erp_down_minutes, 'min="0"')}</div>
                  <div class="field"><label>Repeat the same alert at most every (minutes)</label>${num('alert_cooldown_minutes', s.alert_cooldown_minutes, 'min="5"')}</div>
                </div>
                <div class="toggle-row mt-2"><div><div class="t">Daily summary e-mail</div><div class="d">Punches read and sent today, machines status, items needing attention.</div></div><div class="row"><input type="time" class="input" name="daily_summary_time" value="${esc(s.daily_summary_time)}" style="width:120px">${switchHtml('daily_summary_enabled', s.daily_summary_enabled)}</div></div>
                <div class="row mt-2"><button type="button" class="btn btn-sm" id="mail-test">${icon('mail')} Send test e-mail</button><button type="button" class="btn btn-sm" id="mail-summary">${icon('send')} Send summary now</button><span class="muted small">Save first, the test uses the saved settings.</span></div>
              </div>
              <div class="row mt-2"><button type="button" class="btn btn-sm btn-ghost" id="test-notify">${icon('bell')} Test browser notification</button></div>
            </section>

            <section data-s="network" class="form-section">
              <h3>${icon('shield')} Network &amp; security</h3><p class="desc">API secrets, machine passwords and the SMTP password are stored encrypted with a key file in the data folder.</p>
              <div class="toggle-row"><div><div class="t">Admin password for the GUI</div><div class="d">${s.admin_password_enabled ? 'Enabled. The GUI asks for this password.' : 'Off. Anyone using this PC can open the GUI.'}</div></div>
                <div class="btn-group"><button type="button" class="btn btn-sm" id="pw-set">${icon('lock')} ${s.admin_password_enabled ? 'Change password' : 'Set password'}</button>${s.admin_password_enabled ? `<button type="button" class="btn btn-sm btn-soft-danger" id="pw-remove">Remove</button>` : ''}</div></div>
              <div class="toggle-row"><div><div class="t">Allow access from other PCs on the network</div><div class="d">${s.admin_password_enabled ? 'HR staff can open the GUI from their own PC. Takes effect after the service restarts.' : '<span class="st-failed">Set an admin password first.</span>'}${info.lan ? `<br>Now reachable at: ${(info.urls || []).map((u) => `<code>${esc(u)}</code>`).join(' ')}` : ''}</div></div>
                <label class="switch"><input type="checkbox" name="lan_access" ${s.lan_access ? 'checked' : ''} ${s.admin_password_enabled || s.lan_access ? '' : 'disabled'}><span class="track"></span></label></div>
              <div class="form-grid mt-2"><div class="field"><label>GUI port</label>${num('port', s.port, 'min="1024" max="65535"')}<div class="hint">Takes effect after the service restarts. Allow it in the firewall for network access.</div></div></div>
            </section>

            <section data-s="startup" class="form-section">
              <h3>${icon('power')} Startup</h3><p class="desc">Run the sync as a background service so punches keep flowing without anyone logged in.</p>
              <div class="toggle-row"><div><div class="t">Start with system</div><div class="d">${auto ? (auto.installed ? `Installed as: ${esc(auto.mechanism)}${auto.note ? ` · ${esc(auto.note)}` : ''}` : esc(auto.note || 'Not installed')) : 'Unknown'}</div></div>
                <label class="switch"><input type="checkbox" id="autostart" ${auto?.enabled ? 'checked' : ''} ${auto?.can_toggle ? '' : 'disabled'}><span class="track"></span></label></div>
              <div class="toggle-row"><div><div class="t">Sync when opened from the desktop shortcut</div><div class="d">Double-clicking the shortcut opens the GUI and starts a sync right away.</div></div>${switchHtml('autorun_on_shortcut', s.autorun_on_shortcut)}</div>
            </section>

            <section data-s="maintenance" class="form-section">
              <h3>${icon('wrench')} Maintenance</h3>
              <div class="form-grid">
                <div class="field"><label>Keep log entries for (days)</label>${num('log_retention_days', s.log_retention_days, 'min="1"')}</div>
                <div class="field"><label>Keep sync history for (days)</label>${num('run_retention_days', s.run_retention_days, 'min="1"')}</div>
                <div class="field"><label>Remove synced punches from this PC after (days)</label>${num('punch_retention_days', s.punch_retention_days, 'min="0"')}<div class="hint">0 = keep forever (recommended unless the database grows too big). Pending and failed punches are never removed.</div></div>
                <div class="field"><label>Data folder</label><div class="fp-path">${esc(info.data_dir || '')}</div><div class="hint">Database ${fmtBytes(info.db_size)}, encryption key and logs. Back this folder up.</div></div>
              </div>
              <div class="btn-group mt-2"><button type="button" class="btn" id="db-backup">${icon('download')} Download database backup</button><button type="button" class="btn" id="db-vacuum">${icon('database')} Compact database</button></div>
              <h3 class="mt-3">${icon('upload')} Import / export configuration</h3><p class="desc">Move your machines and settings to another PC.</p>
              <div class="btn-group"><button type="button" class="btn" id="cfg-export">${icon('download')} Export…</button><button type="button" class="btn" id="cfg-import">${icon('upload')} Import…</button><input type="file" id="cfg-file" accept=".json,application/json" class="hidden"></div>
            </section>
          </div>
          <div class="modal-foot" style="position:sticky;bottom:0;border-radius:0 0 12px 12px">
            <span class="muted small" id="dirty-note"></span><span class="spacer"></span>
            <button type="button" class="btn" id="set-reset">Discard changes</button>
            <button type="submit" class="btn btn-primary" id="set-save">${icon('check')} Save settings</button>
          </div>
        </form>
      </div>`;
    if (window.innerWidth < 980) { $('#set-grid').style.gridTemplateColumns = 'minmax(0,1fr)'; $('#set-nav').style.position = 'static'; }
    const form = $('#set-form');

    $$('[data-sec]').forEach((a) => (a.onclick = () => { $(`[data-s="${a.dataset.sec}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    if (start !== 'erpnext') setTimeout(() => $(`[data-s="${start}"]`).scrollIntoView({ block: 'start' }), 50);

    let dirty = false;
    const markDirty = () => { dirty = true; $('#dirty-note').textContent = 'You have unsaved changes'; };
    form.addEventListener('input', (e) => { if (!['autostart', 'cfg-file'].includes(e.target.id)) markDirty(); });
    $('#set-reset').onclick = () => { dirty = false; route(); };

    // active hours
    let days = new Set(s.active_days);
    const drawDays = () => $$('#days [data-d]').forEach((b) => b.classList.toggle('active', days.has(Number(b.dataset.d))));
    $$('#days [data-d]').forEach((b) => (b.onclick = () => { const d = Number(b.dataset.d); days.has(d) ? days.delete(d) : days.add(d); drawDays(); markDirty(); }));
    $$('[data-preset]').forEach((b) => (b.onclick = () => { days = new Set({ all: [0, 1, 2, 3, 4, 5, 6], work: [0, 1, 2, 3, 4], 'mon-sat': [0, 1, 2, 3, 4, 5], 'sun-thu': [6, 0, 1, 2, 3] }[b.dataset.preset]); drawDays(); markDirty(); }));
    drawDays();
    const syncActive = () => $('#active-box').classList.toggle('hidden', !form.active_hours_enabled.checked);
    form.active_hours_enabled.addEventListener('change', syncActive); syncActive();
    const syncMail = () => $('#mail-box').classList.toggle('hidden', !form.email_enabled.checked);
    form.email_enabled.addEventListener('change', syncMail); syncMail();
    form.clear_from_device_on_fetch.addEventListener('change', async () => {
      if (form.clear_from_device_on_fetch.checked && !await confirmDialog({ title: 'Allow clearing machine logs?', message: 'Machines with "Clear machine log after sync (safe mode)" enabled will have their attendance log deleted once every punch is confirmed in ERPNext. Continue?', confirm: 'Allow', danger: true })) form.clear_from_device_on_fetch.checked = false;
    });

    // backoff preview
    const backoff = () => {
      const n = Number(form.max_push_attempts.value) || 1, b = Number(form.retry_base_minutes.value) || 1, c = Number(form.retry_max_minutes.value) || b;
      const waits = []; let total = 0;
      for (let i = 1; i < n; i++) { const w = Math.min(b * 2 ** (i - 1), c); waits.push(w); total += w; }
      const f = (m) => (m >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`);
      $('#backoff-preview div').innerHTML = `A punch rejected by ERPNext is tried <b>${n}</b> time(s): waits of ${waits.slice(0, 7).map(f).join(', ')}${waits.length > 7 ? ', …' : ''}${waits.length ? ` (about <b>${f(total)}</b> in total)` : ''} before it is marked Failed. Retries happen on the next sync after each wait.`;
    };
    ['max_push_attempts', 'retry_base_minutes', 'retry_max_minutes'].forEach((n) => form[n].addEventListener('input', backoff)); backoff();

    // shift mappings
    let mappings = JSON.parse(JSON.stringify(s.shift_mappings || []));
    let shiftNames = [];
    const drawMaps = () => {
      const box = $('#shift-maps');
      box.innerHTML = mappings.length ? mappings.map((m, i) => `
        <div class="shift-map" data-i="${i}">
          <div class="row mb-1"><span class="strong small">Mapping ${i + 1}</span><span class="spacer"></span><button type="button" class="btn btn-sm btn-ghost btn-soft-danger" data-rm>${icon('trash')}</button></div>
          <div class="field"><label>Shift types</label><div class="chips" data-chips>${m.shift_types.map((t) => `<span class="chip">${esc(t)}<button type="button" data-rmshift="${esc(t)}" aria-label="Remove">${icon('x')}</button></span>`).join('') || '<span class="muted small">none</span>'}</div>
            <div class="input-group mt-1" style="max-width:420px"><input class="input" list="shift-list" data-shift-in placeholder="Shift type name"><button type="button" class="btn" data-addshift>${icon('plus')} Add</button></div></div>
          <div class="field mt-2"><label>Machines used by these shifts</label><div class="check-list">${devices.map((d) => `<label><input type="checkbox" data-dev="${d.id}" ${m.device_ids.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('') || '<span class="muted small">Add machines first</span>'}</div></div>
        </div>`).join('') + `<datalist id="shift-list">${shiftNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`
        : `<div class="muted small">No mappings. Add one per group of shifts that share the same machines.</div><datalist id="shift-list">${shiftNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
      $$('.shift-map').forEach((el) => {
        const m = mappings[Number(el.dataset.i)];
        el.querySelector('[data-rm]').onclick = () => { mappings.splice(Number(el.dataset.i), 1); drawMaps(); markDirty(); };
        const inp = el.querySelector('[data-shift-in]');
        const add = () => { const v = inp.value.trim(); if (v && !m.shift_types.includes(v)) { m.shift_types.push(v); drawMaps(); markDirty(); } };
        el.querySelector('[data-addshift]').onclick = add;
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
        el.querySelectorAll('[data-rmshift]').forEach((b) => (b.onclick = () => { m.shift_types = m.shift_types.filter((x) => x !== b.dataset.rmshift); drawMaps(); markDirty(); }));
        el.querySelectorAll('[data-dev]').forEach((c) => (c.onchange = () => { const id = Number(c.dataset.dev); m.device_ids = c.checked ? [...new Set([...m.device_ids, id])] : m.device_ids.filter((x) => x !== id); markDirty(); }));
      });
    };
    $('#shift-add').onclick = () => { mappings.push({ shift_types: [], device_ids: devices.map((d) => d.id) }); drawMaps(); markDirty(); };
    $('#shift-load').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Loading…');
      try {
        const rows = await api('/erpnext/shift-types');
        shiftNames = rows.map((r) => r.name);
        $('#shift-note').innerHTML = rows.length ? `${rows.length} shift type(s): ${rows.map((r) => `<b>${esc(r.name)}</b>${r.last_sync_of_checkin ? ` <span class="tiny">(last sync ${esc(fmtDate(r.last_sync_of_checkin))})</span>` : ''}`).join(', ')}` : 'No shift types found.';
        drawMaps();
      } catch (err) { showApiError(err, 'Could not load shift types'); } finally { setBusy(btn, false); }
    };
    drawMaps();

    // ERPNext test
    $('#erp-test').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Testing…');
      const out = $('#erp-result');
      try {
        const r = await api('/erpnext/test', { method: 'POST', body: { erpnext_url: form.erpnext_url.value, erpnext_api_key: form.erpnext_api_key.value, erpnext_api_secret: form.erpnext_api_secret.value || null, erpnext_version: form.erpnext_version.value, verify_ssl: form.verify_ssl.checked } });
        const perms = r.read_permissions || {};
        out.innerHTML = `<div class="alert success">${icon('checkCircle')}<div style="flex:1"><div class="t">Connected as ${esc(r.user)}</div>
          <div class="small">${Object.entries(r.versions || {}).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ') || 'Version information not available'}</div>
          <div class="small mt-1">Check-in method: <code>${esc(r.method)}</code></div>
          <div class="small mt-1">${Object.entries(perms).map(([k, v]) => `${v ? icon('check', '') : icon('x', '')} ${esc(k)}`).join(' &nbsp; ')}</div>
          ${perms['Employee'] === false ? '<div class="small mt-1" style="color:var(--warning)">Without read access to Employee, Employee Mapping does not work. Syncing still works.</div>' : ''}</div></div>`;
      } catch (err) {
        out.innerHTML = `<div class="alert danger">${icon('xCircle')}<div style="flex:1"><div class="t">Connection failed</div>${esc(err.message)} ${err.detail ? '<a href="javascript:void(0)" id="erp-det">details</a>' : ''}</div></div>`;
        $('#erp-det')?.addEventListener('click', () => errorDetailsDialog('ERPNext connection', err.message, err.detail));
      } finally { setBusy(btn, false); }
    };

    const ints = (v) => String(v).split(/[\s,;]+/).filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const n = (k) => Number(form[k].value);
      const values = {
        erpnext_url: form.erpnext_url.value.trim(), erpnext_api_key: form.erpnext_api_key.value.trim(), erpnext_version: form.erpnext_version.value,
        employee_fieldname: form.employee_fieldname.value.trim(), verify_ssl: form.verify_ssl.checked, skip_auto_attendance: form.skip_auto_attendance.checked,
        request_timeout: n('request_timeout'), erp_concurrency: n('erp_concurrency'), push_delay_ms: n('push_delay_ms'),
        sync_enabled: form.sync_enabled.checked, sync_interval_minutes: n('sync_interval_minutes'), parallel_devices: n('parallel_devices'),
        sync_on_startup: form.sync_on_startup.checked, active_hours_enabled: form.active_hours_enabled.checked,
        active_from: form.active_from.value, active_to: form.active_to.value, active_days: [...days],
        device_port: n('device_port'), device_password: n('device_password'), device_timeout: n('device_timeout'), device_retries: n('device_retries'),
        device_retry_delay: n('device_retry_delay'), time_drift_alert_seconds: n('time_drift_alert_seconds'), device_force_udp: form.device_force_udp.checked,
        device_ommit_ping: form.device_ommit_ping.checked, disable_device_during_fetch: form.disable_device_during_fetch.checked, auto_sync_device_time: form.auto_sync_device_time.checked,
        clear_from_device_on_fetch: form.clear_from_device_on_fetch.checked,
        default_punch_direction: form.default_punch_direction.value, import_start_date: form.import_start_date.value,
        punch_values_in: ints(form.punch_values_in.value), punch_values_out: ints(form.punch_values_out.value),
        repeat_punch_seconds: n('repeat_punch_seconds'), timestamp_offset_minutes: n('timestamp_offset_minutes'), ignore_future_minutes: n('ignore_future_minutes'),
        max_push_attempts: n('max_push_attempts'), retry_base_minutes: n('retry_base_minutes'), retry_max_minutes: n('retry_max_minutes'), erp_failure_breaker: n('erp_failure_breaker'),
        unknown_employee_action: form.unknown_employee_action.value, inactive_employee_action: form.inactive_employee_action.value,
        shift_sync_enabled: form.shift_sync_enabled.checked, shift_mappings: mappings,
        notify_desktop: form.notify_desktop.checked, notify_only_failures: form.notify_only_failures.checked, email_enabled: form.email_enabled.checked,
        smtp_host: form.smtp_host.value.trim(), smtp_port: n('smtp_port'), smtp_security: form.smtp_security.value, smtp_user: form.smtp_user.value.trim(),
        smtp_from: form.smtp_from.value.trim(), email_to: form.email_to.value,
        alert_device_offline_minutes: n('alert_device_offline_minutes'), alert_failed_punches: n('alert_failed_punches'), alert_erp_down_minutes: n('alert_erp_down_minutes'),
        alert_cooldown_minutes: n('alert_cooldown_minutes'), daily_summary_enabled: form.daily_summary_enabled.checked, daily_summary_time: form.daily_summary_time.value,
        lan_access: form.lan_access.checked, port: n('port'), autorun_on_shortcut: form.autorun_on_shortcut.checked,
        log_retention_days: n('log_retention_days'), run_retention_days: n('run_retention_days'), punch_retention_days: n('punch_retention_days'),
      };
      if (form.erpnext_api_secret.value) values.erpnext_api_secret = form.erpnext_api_secret.value;
      if (form.smtp_password.value) values.smtp_password = form.smtp_password.value;
      if (values.active_hours_enabled && !days.size) return toast('Select at least one day for the active hours.', 'warning');
      if (values.shift_sync_enabled && mappings.some((m) => !m.shift_types.length || !m.device_ids.length)) return toast('Each shift mapping needs at least one shift type and one machine.', 'warning');
      const btn = $('#set-save'); setBusy(btn, true, 'Saving…');
      try {
        const r = await api('/settings', { method: 'PUT', body: { values } });
        dirty = false; $('#dirty-note').textContent = '';
        form.erpnext_api_secret.value = ''; form.smtp_password.value = '';
        store.settings = r.settings;
        if (r.settings.has_erpnext_secret) form.erpnext_api_secret.placeholder = '•••••••• saved, leave empty to keep';
        if (r.settings.has_smtp_password) form.smtp_password.placeholder = '•••••••• saved, leave empty to keep';
        toast(r.restart_required ? 'Settings saved. Restart the service to apply the network / port change.' : 'Settings saved.', r.restart_required ? 'warning' : 'success', '', 8000);
      } catch (err) { toastError(err, 'Could not save settings'); }
      finally { setBusy(btn, false); }
    };

    $('#autostart').onchange = async (e) => {
      try { await api('/autostart', { method: 'PUT', body: { enabled: e.target.checked } }); toast(`Start with system ${e.target.checked ? 'enabled' : 'disabled'}.`, 'success'); }
      catch (err) { e.target.checked = !e.target.checked; toastError(err); }
    };
    $('#test-notify').onclick = async () => {
      if (!('Notification' in window)) return toast('This browser does not support notifications.', 'warning');
      const p = await Notification.requestPermission();
      if (p === 'granted') new Notification('Biometric Attendance Sync', { body: 'Notifications are working.' });
      else toast('Notification permission was denied.', 'warning');
    };
    $('#mail-test').onclick = async (e) => {
      const to = await promptDialog({ title: 'Send test e-mail', label: 'Send to', value: (s.email_to || []).join(', '), confirm: 'Send' });
      if (to === null) return;
      const btn = e.currentTarget; setBusy(btn, true, 'Sending…');
      try { await api('/email/test', { method: 'POST', body: { to } }); toast('Test e-mail sent.', 'success'); } catch (err) { showApiError(err, 'E-mail failed'); } finally { setBusy(btn, false); }
    };
    $('#mail-summary').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Sending…');
      try { await api('/email/summary', { method: 'POST' }); toast('Summary e-mail sent.', 'success'); } catch (err) { showApiError(err, 'E-mail failed'); } finally { setBusy(btn, false); }
    };

    // admin password
    $('#pw-set').onclick = () => {
      const m = openModal({
        title: s.admin_password_enabled ? 'Change admin password' : 'Set admin password', icon: 'lock',
        body: `<div class="stack">${s.admin_password_enabled ? '<div class="field"><label>Current password</label><input class="input" type="password" name="cur"></div>' : ''}
          <div class="field"><label>New password</label><input class="input" type="password" name="n1" autocomplete="new-password"><div class="hint">At least 6 characters.</div></div>
          <div class="field"><label>Repeat new password</label><input class="input" type="password" name="n2" autocomplete="new-password"></div></div>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>Save password</button>`,
      });
      m.el.querySelector('[data-ok]').onclick = async () => {
        const g = (k) => m.el.querySelector(`[name=${k}]`)?.value || '';
        if (g('n1') !== g('n2')) return toast('The passwords do not match.', 'warning');
        try { await api('/auth/password', { method: 'POST', body: { current: g('cur'), new: g('n1') } }); m.close(); toast('Admin password saved. Log in with the new password.', 'success'); setTimeout(() => location.reload(), 1200); }
        catch (e) { toastError(e); }
      };
    };
    $('#pw-remove')?.addEventListener('click', async () => {
      const cur = await promptDialog({ title: 'Remove admin password', label: 'Current password', type: 'password', confirm: 'Remove' });
      if (cur === null) return;
      try { await api('/auth/password', { method: 'POST', body: { current: cur, new: '' } }); toast('Admin password removed.', 'success'); route(); } catch (e) { toastError(e); }
    });

    // maintenance
    $('#db-backup').onclick = () => download('/maintenance/db-backup', null, 'attendance-sync.db').catch(toastError);
    $('#db-vacuum').onclick = async (e) => {
      const btn = e.currentTarget; setBusy(btn, true, 'Compacting…');
      try { const r = await api('/maintenance/vacuum', { method: 'POST' }); toast(`Database compacted: ${fmtBytes(r.before)} → ${fmtBytes(r.after)}.`, 'success'); } catch (err) { toastError(err); } finally { setBusy(btn, false); }
    };
    $('#cfg-export').onclick = () => {
      const m = openModal({
        title: 'Export configuration', icon: 'download',
        body: `<div class="stack"><div class="toggle-row"><div><div class="t">Include API secret and passwords</div><div class="d">Encrypted with a passphrase you choose. You need it when importing.</div></div>${switchHtml('inc', false)}</div>
          <div class="field hidden" id="pp-f"><label>Passphrase</label><input class="input" type="password" name="pp" autocomplete="new-password"><div class="hint">At least 6 characters. Keep it safe.</div></div></div>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('download')} Download</button>`,
      });
      const inc = m.el.querySelector('[name=inc]');
      inc.onchange = () => m.el.querySelector('#pp-f').classList.toggle('hidden', !inc.checked);
      m.el.querySelector('[data-ok]').onclick = async () => {
        try { await download('/config/export', { include_secrets: inc.checked, passphrase: m.el.querySelector('[name=pp]').value }, 'attendance-sync-config.json'); m.close(); }
        catch (e) { toastError(e); }
      };
    };
    $('#cfg-import').onclick = () => $('#cfg-file').click();
    $('#cfg-file').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      let data; try { data = JSON.parse(await f.text()); } catch { return toast('This file is not valid JSON.', 'error'); }
      const hasSecrets = !!data.secrets || (data.devices || []).some((x) => x.password);
      const m = openModal({
        title: 'Import configuration', icon: 'upload',
        body: `<p class="muted">${(data.devices || []).length} machine(s) found in <b>${esc(f.name)}</b>. Machines with the same Device ID are updated; the rest are added.</p>
          <div class="toggle-row"><div><div class="t">Also import settings</div><div class="d">ERPNext URL, schedule, rules, alerts… (network settings are not changed)</div></div>${switchHtml('imps', true)}</div>
          ${hasSecrets ? '<div class="field mt-2"><label>Passphrase for the secrets</label><input class="input" type="password" name="pp"></div>' : '<div class="hint mt-2">This file contains no secrets. Enter the API secret after importing.</div>'}`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('upload')} Import</button>`,
      });
      m.el.querySelector('[data-ok]').onclick = async () => {
        try {
          const r = await api('/config/import', { method: 'POST', body: { data, passphrase: m.el.querySelector('[name=pp]')?.value || '', import_settings: m.el.querySelector('[name=imps]').checked } });
          m.close(); toast(r.message, r.secret_errors ? 'warning' : 'success', 'Import complete', 9000); dirty = false; route();
        } catch (err) { toastError(err); }
      };
    };

    const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  },
};
