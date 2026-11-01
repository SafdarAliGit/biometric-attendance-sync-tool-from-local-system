"""SQLite storage. A short-lived connection per call keeps it safe across threads."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

from .config import DB_PATH, DEFAULT_SETTINGS, ensure_dirs

_write_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS devices (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    device_id          TEXT NOT NULL UNIQUE,   -- sent to ERPNext as Employee Checkin.device_id
    ip                 TEXT NOT NULL,
    port               INTEGER,                -- NULL = default from settings
    password_enc       TEXT,                   -- comm key, NULL = default from settings
    timeout            INTEGER,
    force_udp          INTEGER,                -- NULL = default
    punch_direction    TEXT,                   -- NULL = default | AUTO | IN | OUT | NONE
    latitude           REAL,
    longitude          REAL,
    import_start_date  TEXT,                   -- NULL = default
    clear_after_sync   INTEGER NOT NULL DEFAULT 0,
    enabled            INTEGER NOT NULL DEFAULT 1,
    location           TEXT DEFAULT '',
    notes              TEXT DEFAULT '',
    status             TEXT DEFAULT 'unknown', -- unknown | online | offline | error
    last_error         TEXT,
    last_attempt_at    TEXT,
    last_success_at    TEXT,                   -- last successful fetch from the machine
    last_info          TEXT,                   -- JSON: serial, firmware, counts, clock
    created_at         TEXT,
    updated_at         TEXT
);

CREATE TABLE IF NOT EXISTS punches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_pk       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    ts              TEXT NOT NULL,            -- device local time, YYYY-MM-DD HH:MM:SS
    uid             INTEGER,
    punch           INTEGER,
    verify_status   INTEGER,
    log_type        TEXT,                     -- IN | OUT | NULL, resolved at push time
    sync_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | skipped | failed
    reason          TEXT,                     -- short code: duplicate, unknown_employee, ...
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error      TEXT,
    erp_name        TEXT,                     -- Employee Checkin name in ERPNext
    employee        TEXT,
    fetched_at      TEXT,
    synced_at       TEXT,
    run_id          INTEGER,
    UNIQUE (device_pk, user_id, ts)
);

CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger         TEXT NOT NULL,            -- manual | schedule | shortcut | startup | retry
    mode            TEXT NOT NULL DEFAULT 'full',  -- full | push
    status          TEXT NOT NULL,            -- running | success | partial | failed | cancelled
    started_at      TEXT,
    finished_at     TEXT,
    devices_total   INTEGER DEFAULT 0,
    devices_ok      INTEGER DEFAULT 0,
    devices_failed  INTEGER DEFAULT 0,
    fetched         INTEGER DEFAULT 0,
    new_punches     INTEGER DEFAULT 0,
    pushed          INTEGER DEFAULT 0,
    push_failed     INTEGER DEFAULT 0,
    skipped         INTEGER DEFAULT 0,
    pending_after   INTEGER DEFAULT 0,
    options         TEXT,
    summary         TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    device_pk      INTEGER,
    device_name    TEXT,
    device_id      TEXT,
    ip             TEXT,
    status         TEXT NOT NULL DEFAULT 'queued',
    fetch_status   TEXT DEFAULT 'waiting',   -- waiting | running | done | failed | skipped
    push_status    TEXT DEFAULT 'waiting',   -- waiting | running | done | partial | failed | paused | skipped
    attempts       INTEGER DEFAULT 0,
    started_at     TEXT,
    finished_at    TEXT,
    fetch_seconds  REAL,
    push_seconds   REAL,
    fetched        INTEGER DEFAULT 0,
    new_punches    INTEGER DEFAULT 0,
    to_push        INTEGER DEFAULT 0,
    pushed         INTEGER DEFAULT 0,
    push_failed    INTEGER DEFAULT 0,
    skipped        INTEGER DEFAULT 0,
    cleared        INTEGER DEFAULT 0,
    error          TEXT,
    error_detail   TEXT
);

CREATE TABLE IF NOT EXISTS logs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    level    TEXT NOT NULL,
    run_id   INTEGER,
    task_id  INTEGER,
    device   TEXT,
    employee TEXT,
    message  TEXT,
    detail   TEXT
);

CREATE TABLE IF NOT EXISTS device_users (
    device_pk  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    uid        INTEGER,
    name       TEXT,
    privilege  INTEGER,
    card       TEXT,
    fetched_at TEXT,
    PRIMARY KEY (device_pk, user_id)
);

CREATE TABLE IF NOT EXISTS employees (
    name           TEXT PRIMARY KEY,
    employee_name  TEXT,
    device_value   TEXT,
    status         TEXT,
    department     TEXT,
    designation    TEXT,
    company        TEXT,
    branch         TEXT,
    fetched_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_punch_status ON punches(sync_status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_punch_device ON punches(device_pk, sync_status, ts);
CREATE INDEX IF NOT EXISTS idx_punch_user ON punches(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_punch_ts ON punches(ts);
CREATE INDEX IF NOT EXISTS idx_punch_synced ON punches(synced_at);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON tasks(device_pk);
CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_emp_value ON employees(device_value);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    ensure_dirs()
    with _write_lock, connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                         (key, json.dumps(value)))


def query(sql: str, params=()) -> list[dict]:
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def query_one(sql: str, params=()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def scalar(sql: str, params=()):
    with connect() as conn:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


def execute(sql: str, params=()) -> int:
    with _write_lock, connect() as conn:
        cur = conn.execute(sql, params)
        return cur.lastrowid


def execute_count(sql: str, params=()) -> int:
    """Execute and return the number of changed rows."""
    with _write_lock, connect() as conn:
        return conn.execute(sql, params).rowcount


def executemany(sql: str, rows) -> int:
    with _write_lock, connect() as conn:
        before = conn.total_changes
        conn.executemany(sql, rows)
        return conn.total_changes - before


def update(table: str, row_id: int, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    execute(f"UPDATE {table} SET {cols} WHERE id = ?", (*fields.values(), row_id))


# ---- settings ----

def get_settings() -> dict:
    data = dict(DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        try:
            data[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            pass
    return data


def get_setting(key: str):
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    if row is None:
        return DEFAULT_SETTINGS.get(key)
    return json.loads(row["value"])


def set_settings(values: dict):
    with _write_lock, connect() as conn:
        for key, value in values.items():
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                         (key, json.dumps(value)))


# ---- small persistent state (alert cool-downs, shift sync marks, …) ----

def get_state(key: str, default=None):
    row = query_one("SELECT value FROM state WHERE key = ?", (key,))
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def set_state(key: str, value):
    execute("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", (key, json.dumps(value)))
