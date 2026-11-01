/* Help & full user guide */
'use strict';

Pages.help = {
  title: 'Help & Guide',
  render(view) {
    const S = [
      ['overview', 'info', 'Overview'],
      ['install', 'download', 'Installation'],
      ['quickstart', 'rocket', 'Quick start'],
      ['erpnext', 'cloud', 'ERPNext setup'],
      ['machines', 'fingerprint', 'Adding machines'],
      ['how', 'activity', 'How a sync works'],
      ['reliability', 'shield', 'Reliability & retries'],
      ['punches', 'list', 'Punches page'],
      ['mapping', 'users', 'Employee mapping'],
      ['direction', 'sliders', 'IN / OUT direction'],
      ['shifts', 'clock', 'Shift types'],
      ['clear', 'trash', 'Clearing machine logs'],
      ['alerts', 'bell', 'Alerts & e-mail'],
      ['network', 'globe', 'Network access'],
      ['service', 'power', 'Service & startup'],
      ['troubleshooting', 'wrench', 'Troubleshooting'],
      ['faq', 'help', 'FAQ'],
    ];
    const h = (id) => { const s = S.find((x) => x[0] === id); return `<h2>${icon(s[1])} ${s[2]}</h2>`; };
    const port = store.info?.port || 8766;
    view.innerHTML = `
    <div class="help">
      <nav class="card help-toc">${S.map(([id, , l]) => `<a href="javascript:void(0)" data-go="${id}">${l}</a>`).join('')}</nav>
      <article class="card help-content">

      <section id="h-overview">${h('overview')}
        <p><b>Biometric Attendance Sync</b> reads the punches from your biometric attendance machines (ZKTeco and compatible, over the local network) and creates <b>Employee Checkin</b> records in your online ERPNext / Frappe HR site. It runs as a small background service on a PC in the office network. You use it from this page in your web browser.</p>
        <ol class="steps">
          <li>Every few minutes it connects to each machine and reads its attendance log.</li>
          <li>New punches are saved in a local database on this PC (the <i>ledger</i>), so nothing is lost even if the internet is down.</li>
          <li>Each pending punch is sent to ERPNext. Accepted punches are marked <b>Synced</b>; problems are retried automatically.</li>
          <li>Optionally, the Shift Type's <i>Last Sync of Checkin</i> is updated so ERPNext's auto attendance can run.</li>
        </ol>
        <p>Many machines can be connected; all of them send to the same ERPNext site.</p>
      </section>

      <section id="h-install">${h('install')}
        <p>Requires <b>Python 3.10+</b> on the PC that can reach the machines.</p>
        <h3>Windows</h3>
        <ol><li>Install Python from python.org and tick <b>Add python.exe to PATH</b>.</li>
          <li>Double-click <code>install.bat</code>. It creates a virtual environment, a startup task (runs at logon, hidden) and desktop / Start-menu shortcuts.</li>
          <li>For a real Windows service that runs before anyone logs in, open PowerShell <b>as Administrator</b> and run <code>.\\install.ps1 -Service</code>.</li></ol>
        <h3>Linux</h3>
        <ol><li><code>./install.sh</code>: systemd user service + menu entry + desktop shortcut (recommended).</li>
          <li><code>./install.sh --system</code>: system-wide service.</li></ol>
        <p>Then open <code>http://127.0.0.1:${esc(port)}</code> or double-click <b>Biometric Attendance Sync</b> on the desktop. Uninstall with <code>uninstall.bat</code> / <code>uninstall.sh</code>; the <code>data</code> folder is kept.</p>
      </section>

      <section id="h-quickstart">${h('quickstart')}
        <ol class="steps">
          <li>Open <a href="#/settings/erpnext">Settings → ERPNext connection</a>, enter the URL, API key and secret, click <b>Test connection</b>, then <b>Save</b>.</li>
          <li>Open <a href="#/devices">Machines</a> → <b>Add machine</b> (or <b>Find machines on network</b>). Enter a name, a Device ID and the IP address. The connection is tested after saving.</li>
          <li>Open <a href="#/employees">Employee Mapping</a>, click both <b>Read</b> buttons and fix the IDs that are not found in ERPNext.</li>
          <li>Click <b>Sync Now</b>. Watch the progress on <a href="#/progress">Live Progress</a>.</li>
          <li>Under <a href="#/settings/startup">Settings → Startup</a> make sure the service starts with the system. Syncing then runs automatically.</li>
        </ol>
      </section>

      <section id="h-erpnext">${h('erpnext')}
        <ul>
          <li><b>API user</b>: create (or use) a user, open <i>Settings → API Access → Generate Keys</i>. Copy the API key and the secret (the secret is shown only once).</li>
          <li><b>Permissions</b>: <i>Create</i> on Employee Checkin (required); <i>Write</i> on Shift Type (shift sync); <i>Read</i> on Employee (mapping page); <i>Write</i> on Employee (only to link IDs from this app). The <i>HR User</i> role covers most of these.</li>
          <li><b>Employee IDs</b>: on every Employee set <b>Attendance Device ID</b> (Attendance &amp; Leaves section) to the user ID the person uses on the machines. A different field can be chosen in Settings.</li>
          <li><b>Version</b>: “Detect automatically” finds out whether check-ins live in the HRMS app (v14+) or in ERPNext (v12/v13).</li>
        </ul>
      </section>

      <section id="h-machines">${h('machines')}
        <table class="table"><tbody>
          <tr><td class="strong">Name</td><td>Anything readable, e.g. “Main gate”.</td></tr>
          <tr><td class="strong">Device ID</td><td>Saved on every check-in as <i>Device ID</i>. Unique, no spaces. Lets HR see where someone punched.</td></tr>
          <tr><td class="strong">IP / port</td><td>Machine menu → Comm. → Ethernet. Give the machine a fixed IP (or a DHCP reservation). Port is usually 4370.</td></tr>
          <tr><td class="strong">Comm key</td><td>Machine menu → Comm. → Connection → Comm Key. 0 = none.</td></tr>
          <tr><td class="strong">Protocol</td><td>TCP for most machines; UDP for some older models.</td></tr>
          <tr><td class="strong">Direction</td><td>See <a href="javascript:void(0)" data-go="direction">IN / OUT direction</a>.</td></tr>
          <tr><td class="strong">Latitude / longitude</td><td>Only when Frappe HR's <i>Allow Geolocation Tracking</i> is on.</td></tr>
        </tbody></table>
        <p>Machine tools: <b>Test</b> (serial, firmware, user and record counts, clock), <b>Users</b> (read user list), <b>Sync time</b> (set the machine clock), <b>Re-send a date range</b>, <b>Disable</b>, <b>Delete</b>.</p>
      </section>

      <section id="h-how">${h('how')}
        <p>Each machine is processed independently, several at once:</p>
        <ol>
          <li><b>Reading machine</b>: connect, lock the keypad briefly, read all records, unlock. New punches are stored; already known ones are ignored (de-duplicated by machine, user and time).</li>
          <li><b>Sending to ERPNext</b>: every pending punch of that machine whose retry time has come is sent, oldest first. The live progress shows sent / skipped / to-retry counts.</li>
          <li><b>Clearing</b> (only if enabled for the machine, see below).</li>
        </ol>
        <p>A <b>Send pending</b> run skips step 1, which is useful when ERPNext was down and the machines were already read.</p>
      </section>

      <section id="h-reliability">${h('reliability')}
        <ul>
          <li><b>Offline machine</b>: retried a few times, then reported. The other machines continue, and the punches already stored for the offline machine are still sent. Its punches remain on the machine and are read next time.</li>
          <li><b>ERPNext or internet down</b>: after a few errors in a row sending pauses for that run (no flood of requests). Machines are still read and stored. The next run resumes automatically.</li>
          <li><b>One punch rejected</b> (e.g. no employee with this ID): only that punch is retried later with growing waits (5 min, 10, 20, 40… up to the maximum). After the maximum attempts it becomes <b>Failed</b> and appears on the dashboard. Fix the cause and click <b>Retry</b>.</li>
          <li><b>Duplicates</b>: if ERPNext already has a check-in with the same employee and time, the punch is marked synced (“Already there”). Re-sending is always safe.</li>
          <li><b>Crash or power loss</b>: the ledger is a database written immediately. On restart the interrupted run is closed and the next run continues where it left off.</li>
        </ul>
        <p>Retry behaviour is configurable under <a href="#/settings/errors">Settings → Error handling</a>.</p>
      </section>

      <section id="h-punches">${h('punches')}
        <p>Every punch ever read is listed with its status:</p>
        <table class="table"><tbody>
          <tr><td>${statusBadge('pending')}</td><td>Waiting to be sent (new, or ERPNext was unreachable).</td></tr>
          <tr><td>${statusBadge('retrying', 'Retry 2')}</td><td>ERPNext rejected it; it is retried automatically. The details column shows why and when.</td></tr>
          <tr><td>${statusBadge('synced')}</td><td>Check-in created (the ERPNext name is shown) or already present.</td></tr>
          <tr><td>${statusBadge('skipped')}</td><td>Not sent by rule: repeated punch, time in the future, inactive employee, or skipped by you.</td></tr>
          <tr><td>${statusBadge('failed')}</td><td>Gave up after the maximum attempts. Needs your attention.</td></tr>
        </tbody></table>
        <p>Select rows to <b>Retry</b> or <b>Skip</b> them, or use <b>Retry all matching</b> with a filter (e.g. reason “No employee with this ID”). Export any view to CSV.</p>
      </section>

      <section id="h-mapping">${h('mapping')}
        <p>The most common problem is a machine user ID that no employee has in ERPNext. The mapping page compares the users on all machines (and the IDs found in punches) with the employees in ERPNext and highlights:</p>
        <ul><li><b>No employee in ERPNext has this ID</b>: click <b>Link…</b> and choose the employee; the ID is saved on the Employee and the waiting punches are queued again.</li>
          <li><b>Employee is not Active</b>: punches are skipped (or retried, depending on Settings).</li>
          <li><b>Several employees share this ID</b>: fix it in ERPNext, otherwise check-ins go to the wrong person.</li>
          <li><b>Active employees without an ID</b>: listed at the bottom with a <b>Set ID…</b> button.</li></ul>
      </section>

      <section id="h-direction">${h('direction')}
        <ul>
          <li><b>Auto</b>: uses the function key pressed on the machine. Key values 0 and 4 mean IN, 1 and 5 mean OUT (adjustable in Settings → Punch rules). Other values send no direction.</li>
          <li><b>Always IN / Always OUT</b>: for separate entry and exit machines.</li>
          <li><b>Not set</b>: ERPNext decides (with shift-based auto attendance, the first punch is IN and the last is OUT).</li>
        </ul>
      </section>

      <section id="h-shifts">${h('shifts')}
        <p>ERPNext's auto attendance only uses check-ins up to the Shift Type field <b>Last Sync of Checkin</b>. Under <a href="#/settings/shifts">Settings → Shift types</a> map shift types to the machines their employees use. After a run, the field is updated to the time when <i>all</i> those machines were last read successfully, provided none of them still has pending punches. This prevents attendance being marked “Absent” because a machine was offline.</p>
      </section>

      <section id="h-clear">${h('clear')}
        <p>By default the app <b>never</b> deletes anything from the machines: <b>Settings → Machine defaults → Allow clearing the machine log (clear_from_device_on_fetch)</b> is off. Machines have limited memory; if you turn it on <b>and</b> enable <b>Clear machine log after sync (safe mode)</b> on a machine, its log is deleted only when:</p>
        <ol><li>every punch read is stored on this PC <b>and</b> confirmed in ERPNext (synced or skipped), and</li><li>no new punch arrived since it was read (the record count is checked again while the machine is locked).</li></ol>
        <p>Otherwise clearing is postponed to a later run. It is off by default. The local ledger keeps the punches.</p>
      </section>

      <section id="h-alerts">${h('alerts')}
        <ul>
          <li><b>Desktop notifications</b> after each run (optionally only on problems).</li>
          <li><b>E-mail alerts</b> (SMTP): machine offline longer than N minutes, failed punches reaching a threshold, ERPNext unreachable longer than N minutes. Each alert repeats at most once per cool-down.</li>
          <li><b>Daily summary</b> e-mail at a chosen time.</li>
        </ul>
      </section>

      <section id="h-network">${h('network')}
        <p>By default the GUI only listens on this PC. To let HR open it from other PCs: set an <b>admin password</b>, enable <b>Allow access from other PCs</b> (Settings → Network &amp; security), restart the service and allow the port (${esc(port)}) in the firewall. Then open <code>http://&lt;this-pc-ip&gt;:${esc(port)}</code>. Without a password, network access is refused.</p>
      </section>

      <section id="h-service">${h('service')}
        <ul>
          <li><b>Linux</b>: <code>systemctl --user status biometric-attendance-sync</code>, logs in <code>data/logs/app.log</code>.</li>
          <li><b>Windows</b>: startup task “BiometricAttendanceSync” (Task Scheduler) or the service of the same name (services.msc).</li>
          <li>The desktop shortcut starts the service if needed, optionally starts a sync, and opens this page.</li>
          <li>Environment overrides: <code>BAS_DATA_DIR</code>, <code>BAS_PORT</code>, <code>BAS_HOST</code>.</li>
        </ul>
      </section>

      <section id="h-troubleshooting">${h('troubleshooting')}
        <ul>
          <li><b>Machine not reachable</b>: ping the IP from this PC; check cable / Wi-Fi and that the machine IP did not change. If ping is blocked but the port works, enable <i>Skip the ping check</i>. Try UDP for old models, and a longer timeout for machines with many records.</li>
          <li><b>“Communication password is wrong”</b>: set the comm key on the machine (Machines → Edit).</li>
          <li><b>“No ERPNext employee has this attendance device ID”</b>: see Employee Mapping.</li>
          <li><b>“API key rejected” / “No permission”</b>: regenerate keys or add the roles listed under ERPNext setup; test under Settings.</li>
          <li><b>“Check-in API method was not found”</b>: set the ERPNext version explicitly (v14+ needs the HRMS app installed).</li>
          <li><b>Wrong punch times</b>: sync the machine clock (Machines → More → Sync time) and check the PC's time zone. Use the time offset only when machines and ERPNext are in different time zones.</li>
          <li><b>The page doesn't open</b>: the service isn't running. Start it from the shortcut, or run <code>python run.py</code> to see the error.</li>
        </ul>
      </section>

      <section id="h-faq">${h('faq')}
        <h3>Can a punch be created twice in ERPNext?</h3><p>No. Punches are de-duplicated locally, and ERPNext rejects a second check-in with the same employee and time, which the app treats as already synced.</p>
        <h3>What if the internet is down for a day?</h3><p>Machines are still read every few minutes and punches are stored locally. When ERPNext is reachable again, everything pending is sent automatically, in order.</p>
        <h3>Does the app change anything on the machines?</h3><p>Only when you ask: setting the clock, or clearing the log in safe mode. Reading briefly locks the keypad (a few seconds) to avoid missing a punch; this can be turned off.</p>
        <h3>Which machines are supported?</h3><p>Machines that speak the ZKTeco protocol (most ZKTeco / ZKSoftware, eSSL, Identix and other OEM models with TCP/IP), via the pyzk library.</p>
        <h3>Where is my data?</h3><p>In the <code>data</code> folder next to the application: <code>app.db</code> (settings, machines, punches, logs), <code>secret.key</code> (encryption key) and <code>logs/</code>. Back it up with Settings → Maintenance.</p>
      </section>
      </article>
    </div>`;
    $$('[data-go]').forEach((a) => (a.onclick = () => document.getElementById('h-' + a.dataset.go).scrollIntoView({ behavior: 'smooth' })));
  },
};
