"""FastAPI application: REST API, WebSocket and static GUI."""
import asyncio
import csv
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import APP_NAME, __version__, autostart, db
from .config import (DEFAULT_SETTINGS, HIDDEN_SETTINGS, IS_WINDOWS, LAN_HOST, SECRET_SETTINGS,
                     STATIC_DIR, read_runtime, write_runtime)
from .crypto import (decrypt, decrypt_with_passphrase, encrypt, encrypt_with_passphrase,
                     hash_password, verify_password)
from .device import open_machine, save_info, validate_device_id
from .engine import engine
from .erpnext import ERPNext
from .errors import TaskError, explain
from .events import bus, log, logger
from .notify import daily_summary, send_email
from .scheduler import next_runs, scheduler

SESSION_COOKIE = "bas_session"
SESSION_TTL = 12 * 3600
_sessions: dict[str, float] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    engine.recover_interrupted()
    bus.attach(asyncio.get_running_loop())
    if not scheduler.is_alive():
        scheduler.start()
    rt = read_runtime()
    rt.update({"pid": os.getpid(), "started_at": db.now()})
    rt.setdefault("launch_token", secrets.token_urlsafe(24))
    write_runtime(rt)
    logger.info("%s %s started", APP_NAME, __version__)
    yield
    scheduler.stop()


app = FastAPI(title=APP_NAME, version=__version__, lifespan=lifespan, docs_url=None,
              redoc_url=None)


# ---------------------------------------------------------------- auth & network guard

def _auth_required() -> bool:
    return bool(db.get_setting("admin_password_hash"))


def _valid_session(token: str | None) -> bool:
    if not token:
        return False
    exp = _sessions.get(token)
    if not exp or exp < time.time():
        _sessions.pop(token, None)
        return False
    _sessions[token] = time.time() + SESSION_TTL
    return True


OPEN_PATHS = {"/api/health", "/api/auth/status", "/api/auth/login", "/api/launch"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


def _bound_to_lan() -> bool:
    return read_runtime().get("host", "127.0.0.1") not in ("127.0.0.1", "localhost")


def _host_ok(host_header: str | None) -> bool:
    """Block DNS-rebinding: only accept local host names unless bound to the network."""
    if _bound_to_lan():
        return True
    h = host_header or ""
    host = h.split("]")[0] + "]" if h.startswith("[") else h.rsplit(":", 1)[0]
    return host in LOCAL_HOSTS


def _is_local_client(request) -> bool:
    host = request.client.host if request.client else ""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "testclient")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if not _host_ok(request.headers.get("host")):
        return JSONResponse({"detail": "Invalid host"}, status_code=403)
    if not _is_local_client(request) and not _auth_required():
        return JSONResponse({"detail": "Network access needs an admin password. Set one in "
                                       "Settings → Network & security on the PC running the "
                                       "service."}, status_code=403)
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin:
        from urllib.parse import urlparse
        if urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)
    if path.startswith("/api/") and path not in OPEN_PATHS and _auth_required():
        if not _valid_session(request.cookies.get(SESSION_COOKIE)):
            return JSONResponse({"detail": "Login required"}, status_code=401)
    return await call_next(request)


@app.exception_handler(TaskError)
async def task_error_handler(request: Request, exc: TaskError):
    return JSONResponse({"detail": exc.message, "error_detail": exc.detail}, status_code=400)


class LoginIn(BaseModel):
    password: str


class SetPasswordIn(BaseModel):
    current: str = ""
    new: str = ""


@app.get("/api/health")
def health():
    return {"ok": True, "app": APP_NAME, "version": __version__}


@app.get("/api/auth/status")
def auth_status(request: Request):
    required = _auth_required()
    return {"required": required,
            "authenticated": (not required) or _valid_session(request.cookies.get(SESSION_COOKIE))}


@app.post("/api/auth/login")
def login(body: LoginIn):
    stored = db.get_setting("admin_password_hash")
    if stored and not verify_password(body.password, stored):
        time.sleep(1)
        raise HTTPException(401, "Wrong password")
    token = secrets.token_urlsafe(32)
    _sessions[token] = time.time() + SESSION_TTL
    resp = JSONResponse({"ok": True})
    resp.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="strict", max_age=SESSION_TTL)
    return resp


@app.post("/api/auth/logout")
def logout(request: Request):
    _sessions.pop(request.cookies.get(SESSION_COOKIE, ""), None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.post("/api/auth/password")
def set_password(body: SetPasswordIn, request: Request):
    stored = db.get_setting("admin_password_hash")
    if stored and not verify_password(body.current, stored):
        raise HTTPException(400, "The current password is wrong")
    if body.new and len(body.new) < 6:
        raise HTTPException(400, "The password must be at least 6 characters")
    if not body.new and db.get_setting("lan_access"):
        raise HTTPException(400, "Turn off network access first. It requires an admin password.")
    db.set_settings({"admin_password_hash": hash_password(body.new) if body.new else ""})
    _sessions.clear()
    log("INFO", "Admin password " + ("changed" if body.new else "removed"))
    return {"ok": True, "enabled": bool(body.new)}


# ---------------------------------------------------------------- settings

class SettingsIn(BaseModel):
    values: dict


TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
INT_LIMITS = {
    "request_timeout": (5, 600), "erp_concurrency": (1, 10), "push_delay_ms": (0, 10000),
    "sync_interval_minutes": (1, 1440), "parallel_devices": (1, 32),
    "device_port": (1, 65535), "device_timeout": (3, 600), "device_password": (0, 999999999),
    "device_retries": (0, 10), "device_retry_delay": (0, 600),
    "time_drift_alert_seconds": (0, 86400), "repeat_punch_seconds": (0, 3600),
    "timestamp_offset_minutes": (-1440, 1440), "ignore_future_minutes": (0, 525600),
    "max_push_attempts": (1, 100), "retry_base_minutes": (1, 1440),
    "retry_max_minutes": (1, 10080), "erp_failure_breaker": (1, 100),
    "smtp_port": (1, 65535), "alert_device_offline_minutes": (0, 100000),
    "alert_failed_punches": (0, 1000000), "alert_erp_down_minutes": (0, 100000),
    "alert_cooldown_minutes": (5, 100000), "port": (1024, 65535),
    "log_retention_days": (1, 3650), "run_retention_days": (1, 3650),
    "punch_retention_days": (0, 36500),
}
CHOICES = {
    "erpnext_version": {"auto", "12", "13", "14", "15", "16"},
    "default_punch_direction": {"AUTO", "IN", "OUT", "NONE"},
    "unknown_employee_action": {"retry", "skip"},
    "inactive_employee_action": {"retry", "skip"},
    "smtp_security": {"starttls", "ssl", "none"},
}


def _validate_settings(v: dict) -> dict:
    out = {}
    for key, value in v.items():
        if key in SECRET_SETTINGS:
            if value:  # empty = keep the stored secret
                out[SECRET_SETTINGS[key]] = encrypt(str(value))
            continue
        if key not in DEFAULT_SETTINGS or key in HIDDEN_SETTINGS:
            continue
        default = DEFAULT_SETTINGS[key]
        if key in INT_LIMITS:
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise TaskError(f"'{key}' must be a number.", retryable=False)
            lo, hi = INT_LIMITS[key]
            if not lo <= value <= hi:
                raise TaskError(f"'{key}' must be between {lo} and {hi}.", retryable=False)
        elif key in CHOICES:
            value = str(value)
            if value not in CHOICES[key]:
                raise TaskError(f"Invalid value for '{key}'.", retryable=False)
        elif isinstance(default, bool):
            value = bool(value)
        elif key in ("active_from", "active_to", "daily_summary_time"):
            if not TIME_RE.match(str(value)):
                raise TaskError(f"'{key}' must be a time like 08:30.", retryable=False)
        elif key == "active_days":
            value = sorted({int(d) for d in value if 0 <= int(d) <= 6})
        elif key in ("punch_values_in", "punch_values_out"):
            try:
                value = sorted({int(x) for x in value})
            except (TypeError, ValueError):
                raise TaskError("Punch values must be whole numbers.", retryable=False)
        elif key == "import_start_date":
            value = str(value or "").strip()
            if value:
                try:
                    datetime.strptime(value, "%Y-%m-%d")
                except ValueError:
                    raise TaskError("The import start date must look like 2024-01-31.",
                                    retryable=False)
        elif key == "erpnext_url":
            value = str(value or "").strip().rstrip("/")
            if value and not re.match(r"^https?://", value):
                raise TaskError("The ERPNext URL must start with http:// or https://",
                                retryable=False)
        elif key == "email_to":
            items = value if isinstance(value, list) else re.split(r"[,;\s]+", str(value))
            value = [x.strip() for x in items if x and x.strip()]
            bad = [x for x in value if not EMAIL_RE.match(x)]
            if bad:
                raise TaskError(f"Invalid e-mail address: {bad[0]}", retryable=False)
        elif key == "shift_mappings":
            clean = []
            for m in value or []:
                shifts = [str(s).strip() for s in m.get("shift_types") or [] if str(s).strip()]
                ids = [int(x) for x in m.get("device_ids") or []]
                if shifts and ids:
                    clean.append({"shift_types": shifts, "device_ids": ids})
            value = clean
        elif key == "employee_fieldname":
            value = str(value or "").strip() or "attendance_device_id"
            if not re.match(r"^[a-z_][a-z0-9_]*$", value):
                raise TaskError("The employee field name may contain only lowercase letters, "
                                "digits and '_'.", retryable=False)
        elif isinstance(default, str):
            value = str(value or "").strip()
        out[key] = value
    if out.get("lan_access") and not db.get_setting("admin_password_hash"):
        raise TaskError("Set an admin password before allowing network access.", retryable=False)
    return out


def public_settings() -> dict:
    s = db.get_settings()
    out = {k: v for k, v in s.items() if k not in HIDDEN_SETTINGS}
    out["has_erpnext_secret"] = bool(s.get("erpnext_api_secret_enc"))
    out["has_smtp_password"] = bool(s.get("smtp_password_enc"))
    out["admin_password_enabled"] = bool(s.get("admin_password_hash"))
    return out


@app.get("/api/settings")
def get_settings():
    return public_settings()


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    before = db.get_settings()
    values = _validate_settings(body.values)
    db.set_settings(values)
    restart = any(k in values and values[k] != before.get(k) for k in ("port", "lan_access"))
    if any(k in values for k in ("erpnext_url", "erpnext_version")):
        from .erpnext import _method_cache
        _method_cache.clear()
    log("INFO", "Settings saved")
    return {"ok": True, "restart_required": restart, "settings": public_settings()}


@app.get("/api/autostart")
def get_autostart():
    return autostart.status()


class ToggleIn(BaseModel):
    enabled: bool


@app.put("/api/autostart")
def put_autostart(body: ToggleIn):
    ok, out = autostart.set_enabled(body.enabled)
    if not ok:
        raise TaskError(f"Could not change the startup setting: {out}", retryable=False)
    return autostart.status()


# ---------------------------------------------------------------- ERPNext

class ErpTestIn(BaseModel):
    erpnext_url: str | None = None
    erpnext_api_key: str | None = None
    erpnext_api_secret: str | None = None
    erpnext_version: str | None = None
    verify_ssl: bool | None = None


@app.post("/api/erpnext/test")
def erpnext_test(body: ErpTestIn):
    s = db.get_settings()
    for k in ("erpnext_url", "erpnext_api_key", "erpnext_version", "verify_ssl"):
        v = getattr(body, k)
        if v is not None and v != "":
            s[k] = v.strip().rstrip("/") if isinstance(v, str) else v
    if body.erpnext_api_secret:
        s["erpnext_api_secret_enc"] = encrypt(body.erpnext_api_secret)
    try:
        result = ERPNext(s).test()
    except TaskError:
        raise
    except Exception as e:
        msg, detail, _ = explain(e, "ERPNext test")
        raise TaskError(msg, detail)
    db.set_state("erp_last_test", result)
    log("SUCCESS", f"ERPNext connection OK as {result['user']}")
    return result


@app.get("/api/erpnext/shift-types")
def erpnext_shift_types():
    rows = ERPNext().shift_types()
    for r in rows:
        r["local_mark"] = db.get_state(f"shift_sync:{r['name']}")
    return rows


# ---------------------------------------------------------------- devices

class DeviceIn(BaseModel):
    name: str
    device_id: str
    ip: str
    port: int | None = None
    password: str | None = None        # None = keep, "" = use default
    timeout: int | None = None
    force_udp: bool | None = None
    punch_direction: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    import_start_date: str | None = None
    clear_after_sync: bool = False
    enabled: bool = True
    location: str = ""
    notes: str = ""


def _device_stats() -> dict[int, dict]:
    today = datetime.now().strftime("%Y-%m-%d")
    rows = db.query(
        "SELECT device_pk, COUNT(*) total, "
        "SUM(sync_status='pending') pending, SUM(sync_status='failed') failed, "
        "SUM(sync_status='synced') synced, SUM(sync_status='skipped') skipped, "
        "SUM(ts >= ?) today, MAX(ts) last_punch FROM punches GROUP BY device_pk", (today,))
    return {r["device_pk"]: r for r in rows}


def _public_device(d: dict, stats: dict | None = None) -> dict:
    out = {k: v for k, v in d.items() if k != "password_enc"}
    out["has_password"] = bool(d.get("password_enc"))
    out["last_info"] = json.loads(d.get("last_info") or "null")
    st = (stats or {}).get(d["id"]) or {}
    out["stats"] = {k: st.get(k) or 0 for k in ("total", "pending", "failed", "synced", "skipped",
                                                "today")}
    out["stats"]["last_punch"] = st.get("last_punch")
    for k in ("enabled", "clear_after_sync"):
        out[k] = bool(out[k])
    if out.get("force_udp") is not None:
        out["force_udp"] = bool(out["force_udp"])
    return out


def _get_device(device_pk: int) -> dict:
    d = db.query_one("SELECT * FROM devices WHERE id = ?", (device_pk,))
    if not d:
        raise HTTPException(404, "Machine not found")
    return d


def _device_fields(body: DeviceIn, existing: dict | None = None) -> dict:
    name = body.name.strip()
    if not name:
        raise TaskError("Enter a name for the machine.", retryable=False)
    ip = body.ip.strip()
    if not ip:
        raise TaskError("Enter the IP address or host name of the machine.", retryable=False)
    direction = (body.punch_direction or "").upper() or None
    if direction and direction not in ("AUTO", "IN", "OUT", "NONE"):
        raise TaskError("Invalid punch direction.", retryable=False)
    start = (body.import_start_date or "").strip() or None
    if start:
        try:
            datetime.strptime(start, "%Y-%m-%d")
        except ValueError:
            raise TaskError("The import start date must look like 2024-01-31.", retryable=False)
    for val, lo, hi, label in ((body.latitude, -90, 90, "Latitude"),
                               (body.longitude, -180, 180, "Longitude")):
        if val is not None and not lo <= val <= hi:
            raise TaskError(f"{label} is out of range.", retryable=False)
    f = {"name": name, "device_id": validate_device_id(body.device_id), "ip": ip,
         "port": body.port or None, "timeout": body.timeout or None,
         "force_udp": None if body.force_udp is None else int(body.force_udp),
         "punch_direction": direction, "latitude": body.latitude, "longitude": body.longitude,
         "import_start_date": start, "clear_after_sync": int(body.clear_after_sync),
         "enabled": int(body.enabled), "location": body.location.strip(),
         "notes": body.notes.strip(), "updated_at": db.now()}
    if body.password is not None:
        pw = body.password.strip()
        if pw and not pw.isdigit():
            raise TaskError("The communication password (comm key) must be a number.",
                            retryable=False)
        f["password_enc"] = encrypt(pw) if pw else None
    clash = db.query_one("SELECT id FROM devices WHERE device_id = ? AND id != ?",
                         (f["device_id"], existing["id"] if existing else 0))
    if clash:
        raise TaskError("Another machine already uses this Device ID. Each machine needs its "
                        "own.", retryable=False)
    return f


@app.get("/api/devices")
def list_devices():
    stats = _device_stats()
    return [_public_device(d, stats) for d in db.query("SELECT * FROM devices ORDER BY name")]


@app.post("/api/devices")
def create_device(body: DeviceIn):
    f = _device_fields(body)
    f["created_at"] = db.now()
    cols = ", ".join(f)
    new_id = db.execute(f"INSERT INTO devices ({cols}) VALUES ({','.join('?' * len(f))})",
                        tuple(f.values()))
    log("INFO", f"Machine added: {f['name']} ({f['ip']})", device=f["name"])
    return _public_device(_get_device(new_id), _device_stats())


@app.put("/api/devices/{device_pk}")
def update_device(device_pk: int, body: DeviceIn):
    existing = _get_device(device_pk)
    f = _device_fields(body, existing)
    db.update("devices", device_pk, **f)
    log("INFO", f"Machine updated: {f['name']}", device=f["name"])
    return _public_device(_get_device(device_pk), _device_stats())


@app.delete("/api/devices/{device_pk}")
def delete_device(device_pk: int):
    d = _get_device(device_pk)
    if engine.is_running():
        raise TaskError("Wait until the running sync has finished.", retryable=False)
    db.execute("DELETE FROM devices WHERE id = ?", (device_pk,))
    log("WARNING", f"Machine deleted: {d['name']} (its local punch history was removed; ERPNext "
                   "is not affected)", device=d["name"])
    return {"ok": True}


def _with_machine(device_pk: int, fn, what: str):
    d = _get_device(device_pk)
    s = db.get_settings()
    try:
        with open_machine(d, s) as m:
            return d, fn(m)
    except TaskError:
        raise
    except Exception as e:
        msg, detail, _ = explain(e, what)
        raise TaskError(msg, detail)


@app.post("/api/devices/{device_pk}/test")
def test_device(device_pk: int):
    t0 = time.monotonic()
    try:
        d, info = _with_machine(device_pk, lambda m: m.info(), "Connection test")
    except TaskError as e:
        d = _get_device(device_pk)
        db.update("devices", device_pk, status="offline", last_error=e.message,
                  last_attempt_at=db.now())
        log("ERROR", f"Connection test failed: {e.message}", e.detail, device=d["name"])
        raise
    info["response_ms"] = round((time.monotonic() - t0) * 1000)
    prev = json.loads(d.get("last_info") or "{}")
    prev.update(info)
    save_info(device_pk, prev)
    db.update("devices", device_pk, status="online", last_error=None)
    log("SUCCESS", f"Connection test OK: serial {info.get('serial') or '?'}, "
                   f"{info.get('users')} users, {info.get('records')} records", device=d["name"])
    return info


@app.post("/api/devices/{device_pk}/sync-time")
def sync_device_time(device_pk: int):
    def go(m):
        m.set_time()
        return m.info()
    d, info = _with_machine(device_pk, go, "Setting the clock")
    prev = json.loads(d.get("last_info") or "{}")
    prev.update(info)
    save_info(device_pk, prev)
    log("SUCCESS", "Machine clock set to this PC's time", device=d["name"])
    return info


def _read_users(device_pk: int) -> int:
    d, users = _with_machine(device_pk, lambda m: m.users(), "Reading users")
    now = db.now()
    db.execute("DELETE FROM device_users WHERE device_pk = ?", (device_pk,))
    db.executemany("INSERT OR REPLACE INTO device_users (device_pk, user_id, uid, name, privilege,"
                   " card, fetched_at) VALUES (?,?,?,?,?,?,?)",
                   [(device_pk, u["user_id"], u["uid"], u["name"], u["privilege"], u["card"], now)
                    for u in users if u["user_id"]])
    log("INFO", f"Read {len(users)} user(s) from the machine", device=d["name"])
    return len(users)


@app.get("/api/devices/{device_pk}/users")
def device_users(device_pk: int, refresh: bool = False):
    if refresh:
        _read_users(device_pk)
    return db.query("SELECT * FROM device_users WHERE device_pk = ? ORDER BY CAST(user_id AS "
                    "INTEGER), user_id", (device_pk,))


class ScanIn(BaseModel):
    network: str = ""
    port: int = 4370


def _local_network() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return str(ipaddress.ip_network(f"{ip}/24", strict=False))
    except OSError:
        return "192.168.1.0/24"


@app.get("/api/devices/scan/network")
def scan_default():
    return {"network": _local_network()}


@app.post("/api/devices/scan")
def scan_devices(body: ScanIn):
    try:
        net = ipaddress.ip_network(body.network or _local_network(), strict=False)
    except ValueError:
        raise TaskError("Enter a network like 192.168.1.0/24.", retryable=False)
    if net.num_addresses > 1024:
        raise TaskError("The network is too large. Use a /22 or smaller.", retryable=False)
    known = {d["ip"] for d in db.query("SELECT ip FROM devices")}

    def probe(ip):
        try:
            with socket.create_connection((str(ip), body.port), timeout=0.6):
                return str(ip)
        except OSError:
            return None
    with ThreadPoolExecutor(max_workers=64) as ex:
        found = [ip for ip in ex.map(probe, net.hosts()) if ip]
    return {"network": str(net), "found": [{"ip": ip, "known": ip in known} for ip in found]}


# ---------------------------------------------------------------- runs

class RunIn(BaseModel):
    device_ids: list[int] | None = None
    push_only: bool = False
    resync_from: str | None = None
    resync_to: str | None = None


@app.post("/api/runs")
def start_run(body: RunIn):
    for v in (body.resync_from, body.resync_to):
        if v:
            try:
                datetime.strptime(v, "%Y-%m-%d")
            except ValueError:
                raise TaskError("Dates must look like 2024-01-31.", retryable=False)
    run_id = engine.start_run("manual", body.model_dump(exclude_none=True))
    return {"run_id": run_id}


@app.get("/api/active")
def active():
    return engine.active_snapshot()


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: int):
    engine.cancel_run(run_id)
    return {"ok": True}


@app.get("/api/runs")
def list_runs(limit: int = 50, offset: int = 0, status: str | None = None,
              trigger: str | None = None):
    where, params = [], []
    if status:
        where.append("status = ?")
        params.append(status)
    if trigger:
        where.append("trigger = ?")
        params.append(trigger)
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = db.scalar(f"SELECT COUNT(*) FROM runs{w}", tuple(params))
    rows = db.query(f"SELECT * FROM runs{w} ORDER BY id DESC LIMIT ? OFFSET ?",
                    (*params, limit, offset))
    return {"total": total, "rows": rows}


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    run = db.query_one("SELECT * FROM runs WHERE id = ?", (run_id,))
    if not run:
        raise HTTPException(404, "Run not found")
    tasks = db.query("SELECT * FROM tasks WHERE run_id = ? ORDER BY device_name", (run_id,))
    logs = db.query("SELECT * FROM logs WHERE run_id = ? ORDER BY id LIMIT 2000", (run_id,))
    return {"run": run, "tasks": tasks, "logs": logs}


@app.delete("/api/runs")
def clear_history(before_days: int = 0):
    cutoff = (datetime.now() - timedelta(days=before_days)).isoformat(timespec="seconds")
    n = db.execute_count("DELETE FROM runs WHERE started_at < ? AND status != 'running'",
                         (cutoff,))
    log("INFO", f"Run history cleared ({n} run(s))")
    return {"ok": True, "deleted": n}


# ---------------------------------------------------------------- punches

def _punch_where(status=None, device=None, q=None, date_from=None, date_to=None, reason=None,
                 user_id=None):
    where, params = [], []
    if status:
        sts = [x for x in status.split(",") if x]
        if "retrying" in sts:
            sts.remove("retrying")
            cond = "(p.sync_status = 'pending' AND p.attempts > 0)"
            if sts:
                cond = f"({cond} OR p.sync_status IN ({','.join('?' * len(sts))}))"
            where.append(cond)
            params += sts
        elif sts:
            where.append(f"p.sync_status IN ({','.join('?' * len(sts))})")
            params += sts
    if device:
        where.append("p.device_pk = ?")
        params.append(int(device))
    if user_id:
        where.append("p.user_id = ?")
        params.append(user_id)
    if reason:
        where.append("p.reason = ?")
        params.append(reason)
    if date_from:
        where.append("p.ts >= ?")
        params.append(date_from)
    if date_to:
        where.append("p.ts <= ?")
        params.append(date_to + " 23:59:59")
    if q:
        where.append("(p.user_id LIKE ? OR e.employee_name LIKE ? OR e.name LIKE ? OR "
                     "p.erp_name LIKE ? OR p.last_error LIKE ?)")
        params += [f"%{q}%"] * 5
    return (" WHERE " + " AND ".join(where)) if where else "", params


EMP_JOIN = (" LEFT JOIN (SELECT device_value, MIN(name) name, MIN(employee_name) employee_name "
            "FROM employees WHERE device_value IS NOT NULL GROUP BY device_value) e "
            "ON e.device_value = p.user_id")
PUNCH_SELECT = ("SELECT p.*, d.name AS device_name, d.device_id AS device_code, "
                "e.name AS employee_id, e.employee_name FROM punches p "
                "LEFT JOIN devices d ON d.id = p.device_pk" + EMP_JOIN)


@app.get("/api/punches")
def list_punches(limit: int = 100, offset: int = 0, status: str | None = None,
                 device: int | None = None, q: str | None = None, date_from: str | None = None,
                 date_to: str | None = None, reason: str | None = None,
                 user_id: str | None = None):
    w, params = _punch_where(status, device, q, date_from, date_to, reason, user_id)
    base_from = " FROM punches p" + EMP_JOIN
    total = db.scalar(f"SELECT COUNT(*){base_from}{w}", tuple(params))
    rows = db.query(f"{PUNCH_SELECT}{w} ORDER BY p.ts DESC, p.id DESC LIMIT ? OFFSET ?",
                    (*params, min(limit, 1000), offset))
    counts = {r["sync_status"]: r["n"] for r in db.query(
        "SELECT sync_status, COUNT(*) n FROM punches GROUP BY sync_status")}
    counts["retrying"] = db.scalar("SELECT COUNT(*) FROM punches WHERE sync_status='pending' "
                                   "AND attempts > 0") or 0
    reasons = db.query("SELECT reason, COUNT(*) n FROM punches WHERE reason IS NOT NULL "
                       "GROUP BY reason ORDER BY n DESC")
    return {"total": total, "rows": rows, "counts": counts, "reasons": reasons}


class PunchActionIn(BaseModel):
    ids: list[int] | None = None
    status: str | None = None          # apply to a filter instead of ids
    device: int | None = None
    reason: str | None = None
    user_id: str | None = None
    date_from: str | None = None
    date_to: str | None = None


def _action_scope(body: PunchActionIn) -> tuple[str, list]:
    if body.ids:
        return f" WHERE id IN ({','.join('?' * len(body.ids))})", list(body.ids)
    w, params = _punch_where(body.status, body.device, None, body.date_from, body.date_to,
                             body.reason, body.user_id)
    if not w:
        raise TaskError("Select punches or a filter first.", retryable=False)
    return w.replace("p.", ""), params


@app.post("/api/punches/retry")
def retry_punches(body: PunchActionIn):
    w, params = _action_scope(body)
    n = db.execute_count(f"UPDATE punches SET sync_status='pending', attempts=0, "
                         f"next_attempt_at=NULL{w}{' AND' if w else ' WHERE'} "
                         f"sync_status != 'synced'", tuple(params))
    log("INFO", f"{n} punch(es) queued for sending again")
    started = False
    if n and not engine.is_running():
        try:
            engine.start_run("retry", {"push_only": True})
            started = True
        except TaskError:
            pass
    return {"ok": True, "count": n, "started": started}


@app.post("/api/punches/skip")
def skip_punches(body: PunchActionIn):
    w, params = _action_scope(body)
    n = db.execute_count(f"UPDATE punches SET sync_status='skipped', reason='manual', "
                         f"next_attempt_at=NULL, synced_at=?{w} AND sync_status IN "
                         f"('pending','failed')", (db.now(), *params))
    log("INFO", f"{n} punch(es) marked as skipped by the user")
    return {"ok": True, "count": n}


@app.get("/api/punches/export.csv")
def export_punches(status: str | None = None, device: int | None = None, q: str | None = None,
                   date_from: str | None = None, date_to: str | None = None,
                   reason: str | None = None):
    w, params = _punch_where(status, device, q, date_from, date_to, reason)
    rows = db.query(f"{PUNCH_SELECT}{w} ORDER BY p.ts", tuple(params))
    cols = ["ts", "user_id", "employee_id", "employee_name", "device_name", "device_code",
            "log_type", "punch", "sync_status", "reason", "attempts", "erp_name", "last_error",
            "fetched_at", "synced_at"]
    return _csv([{c: r.get(c) for c in cols} for r in rows], "punches.csv")


# ---------------------------------------------------------------- employees & mapping

@app.post("/api/employees/refresh")
def refresh_employees():
    erp = ERPNext()
    try:
        rows = erp.employees()
    except TaskError:
        raise
    except Exception as e:
        msg, detail, _ = explain(e, "Reading employees")
        raise TaskError(msg, detail)
    now = db.now()
    db.execute("DELETE FROM employees")
    db.executemany("INSERT OR REPLACE INTO employees (name, employee_name, device_value, status, "
                   "department, designation, company, branch, fetched_at) VALUES "
                   "(?,?,?,?,?,?,?,?,?)",
                   [(r.get("name"), r.get("employee_name"),
                     (str(r.get(erp.fieldname)).strip() if r.get(erp.fieldname) else None),
                     r.get("status"), r.get("department"), r.get("designation"),
                     r.get("company"), r.get("branch"), now) for r in rows])
    db.set_state("employees_fetched_at", now)
    log("INFO", f"Read {len(rows)} employee(s) from ERPNext")
    return {"ok": True, "count": len(rows)}


@app.post("/api/employees/read-device-users")
def read_all_device_users():
    results = []
    for d in db.query("SELECT id, name FROM devices WHERE enabled = 1"):
        try:
            results.append({"device": d["name"], "ok": True, "count": _read_users(d["id"])})
        except TaskError as e:
            log("WARNING", f"Could not read users: {e.message}", e.detail, device=d["name"])
            results.append({"device": d["name"], "ok": False, "error": e.message})
    return results


@app.get("/api/employees/mapping")
def employee_mapping():
    users = db.query("SELECT u.user_id, GROUP_CONCAT(DISTINCT d.name) devices, MAX(u.name) "
                     "device_name FROM device_users u JOIN devices d ON d.id = u.device_pk "
                     "GROUP BY u.user_id")
    punch = {r["user_id"]: r for r in db.query(
        "SELECT user_id, COUNT(*) total, MAX(ts) last_ts, SUM(sync_status='pending') pending, "
        "SUM(sync_status='failed') failed, SUM(reason='unknown_employee') unknown, "
        "SUM(reason='inactive_employee') inactive FROM punches GROUP BY user_id")}
    emps = db.query("SELECT * FROM employees")
    by_value: dict[str, list] = {}
    for e in emps:
        if e["device_value"]:
            by_value.setdefault(e["device_value"], []).append(e)
    ids = {u["user_id"] for u in users} | set(punch)
    rows = []
    for uid in ids:
        u = next((x for x in users if x["user_id"] == uid), {})
        p = punch.get(uid, {})
        matches = by_value.get(uid, [])
        emp = matches[0] if matches else None
        if not emp:
            issue = "not_in_erpnext"
        elif len(matches) > 1:
            issue = "duplicate_id"
        elif emp["status"] != "Active":
            issue = "inactive"
        else:
            issue = None
        rows.append({"user_id": uid, "device_user_name": u.get("device_name"),
                     "devices": u.get("devices"), "employee": emp and emp["name"],
                     "employee_name": emp and emp["employee_name"],
                     "employee_status": emp and emp["status"],
                     "department": emp and emp["department"], "duplicates": len(matches),
                     "punches": p.get("total") or 0, "last_punch": p.get("last_ts"),
                     "pending": p.get("pending") or 0, "failed": p.get("failed") or 0,
                     "issue": issue})
    rows.sort(key=lambda r: (r["issue"] is None, int(r["user_id"]) if r["user_id"].isdigit()
                             else 10 ** 9, r["user_id"]))
    unlinked = [e for e in emps if not e["device_value"] and e["status"] == "Active"]
    return {"rows": rows, "unlinked_employees": unlinked,
            "employees_fetched_at": db.get_state("employees_fetched_at"),
            "users_fetched_at": db.scalar("SELECT MAX(fetched_at) FROM device_users"),
            "fieldname": db.get_setting("employee_fieldname"),
            "employee_count": len(emps)}


class LinkIn(BaseModel):
    employee: str
    user_id: str


@app.post("/api/employees/link")
def link_employee(body: LinkIn):
    erp = ERPNext()
    erp.set_employee_device_value(body.employee, body.user_id.strip())
    db.execute("UPDATE employees SET device_value = ? WHERE name = ?",
               (body.user_id.strip(), body.employee))
    n = db.execute_count("UPDATE punches SET sync_status='pending', attempts=0, "
                         "next_attempt_at=NULL WHERE user_id = ? AND sync_status IN "
                         "('pending','failed','skipped') AND reason IN "
                         "('unknown_employee','inactive_employee')", (body.user_id.strip(),))
    log("SUCCESS", f"Employee {body.employee} linked to device user ID {body.user_id}. "
                   f"{n} punch(es) queued again.", employee=body.user_id)
    return {"ok": True, "requeued": n}


# ---------------------------------------------------------------- logs

@app.get("/api/logs")
def get_logs(limit: int = 200, offset: int = 0, level: str | None = None,
             device: str | None = None, q: str | None = None, run_id: int | None = None):
    where, params = [], []
    if level:
        lv = [x for x in level.split(",") if x]
        where.append(f"level IN ({','.join('?' * len(lv))})")
        params += lv
    if device:
        where.append("device = ?")
        params.append(device)
    if run_id:
        where.append("run_id = ?")
        params.append(run_id)
    if q:
        where.append("(message LIKE ? OR detail LIKE ? OR employee LIKE ?)")
        params += [f"%{q}%"] * 3
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = db.scalar(f"SELECT COUNT(*) FROM logs{w}", tuple(params))
    rows = db.query(f"SELECT * FROM logs{w} ORDER BY id DESC LIMIT ? OFFSET ?",
                    (*params, min(limit, 1000), offset))
    return {"total": total, "rows": rows}


@app.delete("/api/logs")
def clear_logs():
    db.execute("DELETE FROM logs")
    log("INFO", "Logs cleared")
    return {"ok": True}


@app.get("/api/logs/export.csv")
def export_logs():
    rows = db.query("SELECT ts, level, device, employee, run_id, message, detail FROM logs "
                    "ORDER BY id")
    return _csv(rows, "logs.csv")


# ---------------------------------------------------------------- statistics

@app.get("/api/stats/summary")
def stats_summary(days: int = 30):
    since = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    today = datetime.now().strftime("%Y-%m-%d")
    q = lambda sql, p=(): db.scalar(sql, p) or 0  # noqa: E731
    counts = {r["sync_status"]: r["n"] for r in db.query(
        "SELECT sync_status, COUNT(*) n FROM punches GROUP BY sync_status")}
    runs = db.query_one("SELECT COUNT(*) n, SUM(status='success') ok, SUM(status='partial') part,"
                        " SUM(status='failed') bad FROM runs WHERE started_at >= ? AND "
                        "summary NOT LIKE 'Skipped:%'", (since,))
    dev_tasks = db.query_one("SELECT COUNT(*) n, SUM(fetch_status='done') ok FROM tasks t JOIN "
                             "runs r ON r.id = t.run_id WHERE r.started_at >= ? AND "
                             "r.mode = 'full'", (since,))
    last = db.query_one("SELECT * FROM runs WHERE status != 'running' AND summary NOT LIKE "
                        "'Skipped:%' ORDER BY id DESC LIMIT 1")
    devices = db.query("SELECT status, enabled FROM devices")
    return {
        "devices": len(devices), "devices_enabled": sum(1 for d in devices if d["enabled"]),
        "devices_online": sum(1 for d in devices if d["enabled"] and d["status"] == "online"),
        "devices_offline": sum(1 for d in devices if d["enabled"] and d["status"] == "offline"),
        "punches_total": sum(counts.values()), "counts": counts,
        "retrying": q("SELECT COUNT(*) FROM punches WHERE sync_status='pending' AND attempts>0"),
        "today_punches": q("SELECT COUNT(*) FROM punches WHERE ts >= ?", (today,)),
        "today_synced": q("SELECT COUNT(*) FROM punches WHERE synced_at >= ? AND "
                          "sync_status='synced'", (today,)),
        "today_employees": q("SELECT COUNT(DISTINCT user_id) FROM punches WHERE ts >= ?",
                             (today,)),
        "period_synced": q("SELECT COUNT(*) FROM punches WHERE synced_at >= ? AND "
                           "sync_status='synced' AND (reason IS NULL OR erp_name IS NOT NULL)", (since,)),
        "period_fetched": q("SELECT COUNT(*) FROM punches WHERE fetched_at >= ?", (since,)),
        "runs": runs["n"] or 0, "runs_ok": runs["ok"] or 0, "runs_partial": runs["part"] or 0,
        "runs_failed": runs["bad"] or 0,
        "device_reads": dev_tasks["n"] or 0, "device_reads_ok": dev_tasks["ok"] or 0,
        "read_success_rate": round(100 * (dev_tasks["ok"] or 0) / dev_tasks["n"], 1)
        if dev_tasks["n"] else None,
        "last_run": last, "next_runs": next_runs(3), "running": engine.is_running(),
        "erp_down_since": db.get_state("erp_down_since"),
        "erp_last_error": db.get_state("erp_last_error"),
        "erp_configured": ERPNext().configured,
        "erp_last_test": db.get_state("erp_last_test"),
    }


@app.get("/api/stats/daily")
def stats_daily(days: int = 30):
    start = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    punches = {r["day"]: r for r in db.query(
        "SELECT substr(ts,1,10) day, COUNT(*) total, COUNT(DISTINCT user_id) employees, "
        "SUM(sync_status='synced') synced, SUM(sync_status='pending') pending, "
        "SUM(sync_status='failed') failed, SUM(sync_status='skipped') skipped "
        "FROM punches WHERE ts >= ? GROUP BY day", (start,))}
    out = []
    for i in range(days):
        day = (datetime.now() - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        p = punches.get(day, {})
        out.append({"day": day, **{k: p.get(k) or 0 for k in ("total", "employees", "synced",
                                                              "pending", "failed", "skipped")}})
    return out


@app.get("/api/stats/hourly")
def stats_hourly(day: str | None = None):
    day = day or datetime.now().strftime("%Y-%m-%d")
    rows = {int(r["h"]): r["n"] for r in db.query(
        "SELECT substr(ts,12,2) h, COUNT(*) n FROM punches WHERE substr(ts,1,10) = ? "
        "GROUP BY h", (day,))}
    return [{"hour": h, "count": rows.get(h, 0)} for h in range(24)]


@app.get("/api/stats/devices")
def stats_devices(days: int = 30):
    since = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    stats = _device_stats()
    reads = {r["device_pk"]: r for r in db.query(
        "SELECT t.device_pk, COUNT(*) n, SUM(t.fetch_status='done') ok, AVG(t.fetch_seconds) "
        "avg_fetch FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.started_at >= ? AND "
        "r.mode='full' GROUP BY t.device_pk", (since,))}
    out = []
    for d in db.query("SELECT * FROM devices ORDER BY name"):
        pd = _public_device(d, stats)
        r = reads.get(d["id"], {})
        pd["reads"] = r.get("n") or 0
        pd["reads_ok"] = r.get("ok") or 0
        pd["avg_fetch"] = r.get("avg_fetch")
        out.append(pd)
    return out


def _csv(rows: list[dict], filename: str) -> Response:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/export/runs.csv")
def export_runs(days: int = 365):
    since = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    rows = db.query("SELECT id, trigger, mode, status, started_at, finished_at, devices_total, "
                    "devices_ok, devices_failed, fetched, new_punches, pushed, push_failed, "
                    "skipped, pending_after, summary FROM runs WHERE started_at >= ? ORDER BY id",
                    (since,))
    return _csv(rows, "sync-runs.csv")


# ---------------------------------------------------------------- e-mail

class EmailTestIn(BaseModel):
    to: str | None = None


@app.post("/api/email/test")
def email_test(body: EmailTestIn):
    s = db.get_settings()
    to = [x.strip() for x in re.split(r"[,;\s]+", body.to or "") if x.strip()] or None
    send_email("Test e-mail", "This is a test e-mail. Alerts are configured correctly.",
               "<p>This is a test e-mail. Alerts are configured correctly.</p>", s, to)
    log("SUCCESS", "Test e-mail sent")
    return {"ok": True}


@app.post("/api/email/summary")
def email_summary_now():
    daily_summary(force=True)
    log("INFO", "Daily summary e-mail sent (manual)")
    return {"ok": True}


# ---------------------------------------------------------------- maintenance & config

@app.post("/api/maintenance/vacuum")
def vacuum():
    before = Path(db.DB_PATH).stat().st_size
    with db._write_lock:
        conn = sqlite3.connect(db.DB_PATH)
        conn.execute("VACUUM")
        conn.close()
    after = Path(db.DB_PATH).stat().st_size
    log("INFO", f"Database compacted: {before} → {after} bytes")
    return {"ok": True, "before": before, "after": after}


@app.get("/api/maintenance/db-backup")
def db_backup():
    buf_path = Path(db.DB_PATH).with_suffix(".backup.db")
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(buf_path)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    data = buf_path.read_bytes()
    buf_path.unlink(missing_ok=True)
    name = f"attendance-sync-{datetime.now():%Y%m%d-%H%M}.db"
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


class ExportIn(BaseModel):
    include_secrets: bool = False
    passphrase: str = ""


@app.post("/api/config/export")
def config_export(body: ExportIn):
    if body.include_secrets and len(body.passphrase) < 6:
        raise TaskError("The passphrase must be at least 6 characters.", retryable=False)
    s = db.get_settings()
    settings = {k: v for k, v in s.items() if k not in HIDDEN_SETTINGS}
    devices = []
    for d in db.query("SELECT * FROM devices ORDER BY id"):
        item = {k: d[k] for k in ("id", "name", "device_id", "ip", "port", "timeout", "force_udp",
                                  "punch_direction", "latitude", "longitude", "import_start_date",
                                  "clear_after_sync", "enabled", "location", "notes")}
        if body.include_secrets and d.get("password_enc"):
            item["password"] = encrypt_with_passphrase(decrypt(d["password_enc"]) or "",
                                                       body.passphrase)
        devices.append(item)
    out = {"app": APP_NAME, "version": __version__, "exported_at": db.now(),
           "settings": settings, "devices": devices}
    if body.include_secrets:
        out["secrets"] = {k: encrypt_with_passphrase(decrypt(s.get(col)) or "", body.passphrase)
                          for k, col in SECRET_SETTINGS.items() if s.get(col)}
    data = json.dumps(out, indent=2)
    return Response(data, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="attendance-sync-config.json"'})


class ImportIn(BaseModel):
    data: dict
    passphrase: str = ""
    import_settings: bool = True


@app.post("/api/config/import")
def config_import(body: ImportIn):
    data = body.data
    if "devices" not in data:
        raise TaskError("This file is not an attendance sync configuration.", retryable=False)
    secret_errors = 0

    def dec(blob):
        nonlocal secret_errors
        try:
            return decrypt_with_passphrase(blob, body.passphrase)
        except Exception:
            secret_errors += 1
            return None
    id_map = {}
    added = updated = 0
    for item in data.get("devices", []):
        try:
            device_id = validate_device_id(item.get("device_id", ""))
        except TaskError:
            continue
        f = {k: item.get(k) for k in ("name", "ip", "port", "timeout", "force_udp",
                                      "punch_direction", "latitude", "longitude",
                                      "import_start_date", "location", "notes")}
        f["clear_after_sync"] = int(bool(item.get("clear_after_sync")))
        f["enabled"] = int(bool(item.get("enabled", True)))
        f["updated_at"] = db.now()
        if item.get("password"):
            pw = dec(item["password"])
            if pw is not None:
                f["password_enc"] = encrypt(pw) if pw else None
        existing = db.query_one("SELECT id FROM devices WHERE device_id = ?", (device_id,))
        if existing:
            db.update("devices", existing["id"], **f)
            id_map[item.get("id")] = existing["id"]
            updated += 1
        else:
            f.update({"device_id": device_id, "created_at": db.now()})
            new = db.execute(f"INSERT INTO devices ({', '.join(f)}) VALUES "
                             f"({','.join('?' * len(f))})", tuple(f.values()))
            id_map[item.get("id")] = new
            added += 1
    if body.import_settings and isinstance(data.get("settings"), dict):
        incoming = {k: v for k, v in data["settings"].items()
                    if k not in ("lan_access", "port") and k in DEFAULT_SETTINGS}
        if "shift_mappings" in incoming:
            incoming["shift_mappings"] = [
                {"shift_types": m.get("shift_types", []),
                 "device_ids": [id_map[i] for i in m.get("device_ids", []) if i in id_map]}
                for m in incoming["shift_mappings"]]
        try:
            db.set_settings(_validate_settings(incoming))
        except TaskError as e:
            raise TaskError(f"Settings could not be imported: {e.message}", retryable=False)
        for key, blob in (data.get("secrets") or {}).items():
            val = dec(blob)
            if val and key in SECRET_SETTINGS:
                db.set_settings({SECRET_SETTINGS[key]: encrypt(val)})
    msg = f"Configuration imported: {added} machine(s) added, {updated} updated."
    if secret_errors:
        msg += f" {secret_errors} password(s) could not be decrypted (wrong passphrase?)."
    log("INFO", msg)
    return {"ok": True, "added": added, "updated": updated, "secret_errors": secret_errors,
            "message": msg}


# ---------------------------------------------------------------- shortcut launch

@app.post("/api/launch")
def launch(request: Request):
    token = request.headers.get("X-Launch-Token")
    if not token or token != read_runtime().get("launch_token"):
        raise HTTPException(403, "Invalid launch token")
    if not db.get_setting("autorun_on_shortcut"):
        return {"started": False, "reason": "disabled"}
    if engine.is_running():
        return {"started": False, "reason": "already running"}
    try:
        return {"started": True, "run_id": engine.start_run("shortcut")}
    except TaskError as e:
        return {"started": False, "reason": e.message}


@app.get("/api/info")
def info():
    rt = read_runtime()
    lan = rt.get("host") == LAN_HOST
    urls = [f"http://127.0.0.1:{rt.get('port')}"]
    if lan:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            urls.append(f"http://{s.getsockname()[0]}:{rt.get('port')}")
            s.close()
        except OSError:
            pass
    return {"app": APP_NAME, "version": __version__,
            "platform": "windows" if IS_WINDOWS else "linux",
            "data_dir": str(Path(db.DB_PATH).parent), "db_size": Path(db.DB_PATH).stat().st_size,
            "pid": rt.get("pid"), "started_at": rt.get("started_at"), "busy": engine.is_running(),
            "host": rt.get("host"), "port": rt.get("port"), "lan": lan, "urls": urls,
            "free_disk": shutil.disk_usage(Path(db.DB_PATH).parent).free}


# ---------------------------------------------------------------- websocket

@app.websocket("/ws")
async def ws(websocket: WebSocket):
    if _auth_required() and not _valid_session(websocket.cookies.get(SESSION_COOKIE)):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    qu = bus.subscribe()
    try:
        await websocket.send_json({"type": "hello", "runs": engine.active_snapshot()})
        while True:
            try:
                msg = await asyncio.wait_for(qu.get(), timeout=25)
            except asyncio.TimeoutError:
                msg = {"type": "ping"}
            await websocket.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception as e:  # connection dropped
        logger.debug("websocket closed: %s", e)
    finally:
        bus.unsubscribe(qu)


# ---------------------------------------------------------------- static GUI

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
