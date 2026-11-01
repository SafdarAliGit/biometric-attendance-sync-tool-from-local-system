"""Paths, defaults and runtime configuration."""
import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("BAS_DATA_DIR", BASE_DIR / "data")).resolve()
DB_PATH = DATA_DIR / "app.db"
KEY_PATH = DATA_DIR / "secret.key"
LOG_DIR = DATA_DIR / "logs"
RUNTIME_PATH = DATA_DIR / "runtime.json"   # host/port + launch token, read by launcher.py

IS_WINDOWS = sys.platform.startswith("win")

DEFAULT_HOST = "127.0.0.1"
LAN_HOST = "0.0.0.0"
DEFAULT_PORT = 8766

SERVICE_NAME = "biometric-attendance-sync"      # systemd unit name (Linux)
WINDOWS_TASK_NAME = "BiometricAttendanceSync"   # scheduled task / service name (Windows)

DEFAULT_SETTINGS = {
    # ERPNext connection (the API secret is stored encrypted under erpnext_api_secret_enc)
    "erpnext_url": "",
    "erpnext_api_key": "",
    "erpnext_api_secret_enc": "",
    "erpnext_version": "auto",          # "auto" | "12" | "13" | "14" | "15" | "16"
    "employee_fieldname": "attendance_device_id",
    "verify_ssl": True,
    "request_timeout": 30,
    "skip_auto_attendance": False,
    "erp_concurrency": 2,               # parallel check-in requests to ERPNext
    "push_delay_ms": 0,                 # pause between check-in requests (rate limiting)
    # Sync schedule
    "sync_enabled": True,
    "sync_interval_minutes": 15,
    "active_hours_enabled": False,
    "active_from": "00:00",
    "active_to": "23:59",
    "active_days": [0, 1, 2, 3, 4, 5, 6],  # Monday=0
    "sync_on_startup": True,
    "parallel_devices": 4,
    # Machine defaults (each machine may override port / password / timeout / direction)
    "device_port": 4370,
    "device_timeout": 30,
    "device_password": 0,
    "device_force_udp": False,
    "device_ommit_ping": False,
    "device_retries": 2,
    "device_retry_delay": 10,
    "disable_device_during_fetch": True,
    "auto_sync_device_time": False,
    "time_drift_alert_seconds": 120,
    # Punch rules
    "default_punch_direction": "AUTO",   # "AUTO" | "IN" | "OUT" | "NONE"
    "punch_values_in": [0, 4],
    "punch_values_out": [1, 5],
    "import_start_date": "",             # YYYY-MM-DD, punches before it are ignored
    "repeat_punch_seconds": 0,           # ignore repeated punches of a user within N seconds
    "timestamp_offset_minutes": 0,       # shift device time before sending (time-zone fix)
    "ignore_future_minutes": 1440,       # punches more than N minutes in the future are held
    # Error handling
    "max_push_attempts": 8,
    "retry_base_minutes": 5,
    "retry_max_minutes": 360,
    "unknown_employee_action": "retry",  # "retry" | "skip"
    "inactive_employee_action": "skip",  # "retry" | "skip"
    "erp_failure_breaker": 5,            # consecutive network/server errors that pause pushing
    # Shift types (updates Shift Type.last_sync_of_checkin)
    "shift_sync_enabled": False,
    "shift_mappings": [],                # [{"shift_types": [...], "device_ids": [db ids]}]
    # Notifications
    "notify_desktop": True,
    "notify_only_failures": True,
    "email_enabled": False,
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_security": "starttls",         # "starttls" | "ssl" | "none"
    "smtp_user": "",
    "smtp_password_enc": "",
    "smtp_from": "",
    "email_to": [],
    "alert_device_offline_minutes": 60,
    "alert_failed_punches": 10,
    "alert_erp_down_minutes": 30,
    "alert_cooldown_minutes": 360,
    "daily_summary_enabled": False,
    "daily_summary_time": "20:00",
    # Startup
    "autorun_on_shortcut": True,
    # Network & security
    "lan_access": False,
    "port": DEFAULT_PORT,
    "admin_password_hash": "",
    # Maintenance
    "log_retention_days": 90,
    "run_retention_days": 180,
    "punch_retention_days": 0,           # 0 = keep synced punches forever
}

SECRET_SETTINGS = {"erpnext_api_secret": "erpnext_api_secret_enc",
                   "smtp_password": "smtp_password_enc"}
HIDDEN_SETTINGS = {"admin_password_hash", "erpnext_api_secret_enc", "smtp_password_enc"}


def ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def read_runtime():
    try:
        return json.loads(RUNTIME_PATH.read_text())
    except Exception:
        return {}


def write_runtime(data: dict):
    ensure_dirs()
    RUNTIME_PATH.write_text(json.dumps(data))
    try:
        os.chmod(RUNTIME_PATH, 0o600)
    except OSError:
        pass
