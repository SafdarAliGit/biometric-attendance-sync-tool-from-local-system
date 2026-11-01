# Biometric Attendance Sync (for ERPNext / Frappe HR)

Reads punches from biometric attendance machines (ZKTeco protocol, via `pyzk`) on the local network and
creates **Employee Checkin** records in an online ERPNext / Frappe HR site. It runs as a background
service on Linux or Windows. You use it from your browser at `http://127.0.0.1:8766`.

## Features

- **Many machines, one ERPNext site.** Each machine has its own Device ID, IP/port, comm key, timeout,
  protocol (TCP/UDP), punch direction, import start date and optional geolocation.
- **Local punch ledger (SQLite).** Every punch is stored on this PC first and de-duplicated by
  machine, user and time. Nothing is lost if ERPNext, the internet or the PC goes down.
- **Never halts.**
  - Each machine is processed on its own, in parallel.
  - An offline machine is retried, reported and skipped. Its already-stored punches are still sent.
  - Each punch has its own retry counter with exponential back-off.
  - Duplicates are recognised as already synced.
  - A circuit breaker pauses sending while ERPNext is down and resumes automatically.
- **Live progress.** Each machine shows two stages ("Reading machine", "Sending to ERPNext") and an
  overall progress bar. Updates come over a WebSocket, alongside a streaming activity log.
- **Punches page.** Filter by status, machine, date, reason or employee. Retry or skip punches in bulk,
  and export to CSV.
- **Employee mapping.**
  - Compares the users on the machines with ERPNext employees (`attendance_device_id`).
  - Flags IDs with no employee, inactive employees and IDs shared by several employees.
  - Links an ID to an employee in ERPNext with one click and re-queues the waiting punches.
- **Machine tools.**
  - Connection test (serial, firmware, users and records, clock drift).
  - Set the clock, with optional automatic correction.
  - Read the users, re-send a date range, and find machines on the network.
- **Clear the machine log (safe mode, per machine).** The log is cleared only when every punch read is
  confirmed in ERPNext and no new punch arrived in the meantime.
- **Shift Type sync.** `Last Sync of Checkin` is updated only when all machines of the shift are read
  and fully sent.
- **Schedule.** Interval sync, optional active hours and days (windows over midnight work), and a sync
  at startup.
- **Alerts.** Desktop notifications. SMTP e-mail when a machine is offline, punches fail or ERPNext is
  down, with a cool-down so alerts don't repeat too often. Optional daily summary e-mail.
- **Security and maintenance.**
  - Optional admin password.
  - LAN access, allowed only when an admin password is set.
  - Encrypted secrets.
  - Config import / export, a database backup download and log retention.

## Install

**Linux**

```bash
./install.sh            # systemd user service + desktop shortcut (recommended)
./install.sh --system   # or a system-wide service
```

**Windows**: double-click `install.bat`. For a real Windows service (starts before login), run
`install.ps1 -Service` in PowerShell as Administrator.

Requires Python 3.10+ on a PC that can reach the machines.

**Run without installing**

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py      # then open http://127.0.0.1:8766
```

## ERPNext requirements

Create an API key and secret for an integration user with these permissions:

- **Create** on *Employee Checkin* (required).
- **Write** on *Shift Type* (shift sync).
- **Read** on *Employee* (mapping page).
- **Write** on *Employee* (only to link IDs from the app).

Set each employee's **Attendance Device ID** to the user ID they use on the machines.

## Files

| Path | Purpose |
|---|---|
| `run.py` | Starts the server (used by the service) |
| `launcher.py` | Desktop-shortcut target: starts the service if needed, optionally starts a sync, opens the browser |
| `app/` | FastAPI backend: `engine.py` (sync runs, retries, safe clear, shift sync), `device.py` (pyzk), `erpnext.py` (REST client + error classification), `scheduler.py`, `notify.py` (desktop / e-mail alerts), `main.py` (API) |
| `static/` | HTML / CSS / JavaScript GUI (no build step; Chart.js bundled for offline use) |
| `data/` | SQLite database, encryption key, logs. **Keep this folder private and back it up.** |

Environment overrides: `BAS_DATA_DIR`, `BAS_PORT`, `BAS_HOST`.

The sync logic is based on [frappe/biometric-attendance-sync-tool](https://github.com/frappe/biometric-attendance-sync-tool)
(GPL-3.0). The original tracks its progress through the last line of a log file and stops on unexpected
errors. This version replaces that with a per-punch ledger.
# biometric-attendance-sync-tool-from-local-system
