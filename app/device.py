"""Biometric machine access (ZKTeco protocol via pyzk)."""
import json
from contextlib import contextmanager
from datetime import datetime

from zk import ZK

from . import db
from .crypto import decrypt
from .errors import TaskError


def effective(device: dict, settings: dict) -> dict:
    """Merge a machine row with the global defaults."""
    password = decrypt(device.get("password_enc"))
    direction = device.get("punch_direction") or settings["default_punch_direction"]
    return {
        "ip": device["ip"].strip(),
        "port": int(device.get("port") or settings["device_port"]),
        "timeout": int(device.get("timeout") or settings["device_timeout"]),
        "password": int(password) if password not in (None, "") else int(settings["device_password"] or 0),
        "force_udp": bool(device["force_udp"]) if device.get("force_udp") is not None
        else bool(settings["device_force_udp"]),
        "ommit_ping": bool(settings["device_ommit_ping"]),
        "punch_direction": direction,
        "import_start_date": device.get("import_start_date") or settings["import_start_date"] or "",
    }


class Machine:
    """A short-lived session with one machine."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.conn = None

    def __enter__(self):
        zk = ZK(self.cfg["ip"], port=self.cfg["port"], timeout=self.cfg["timeout"],
                password=self.cfg["password"], force_udp=self.cfg["force_udp"],
                ommit_ping=self.cfg["ommit_ping"])
        self.conn = zk.connect()
        return self

    def __exit__(self, *exc):
        if self.conn:
            try:
                self.conn.disconnect()
            except Exception:
                pass
        return False

    @contextmanager
    def disabled(self, enabled: bool = True):
        """Lock the keypad / sensor while reading or clearing so no punch is lost in between."""
        if enabled:
            try:
                self.conn.disable_device()
            except Exception:
                enabled = False
        try:
            yield
        finally:
            if enabled:
                try:
                    self.conn.enable_device()
                except Exception:
                    pass

    def _safe(self, fn, default=None):
        try:
            return fn()
        except Exception:
            return default

    def info(self) -> dict:
        c = self.conn
        self._safe(c.read_sizes)
        clock = self._safe(c.get_time)
        drift = round((clock - datetime.now()).total_seconds()) if clock else None
        return {
            "serial": self._safe(c.get_serialnumber, ""),
            "firmware": self._safe(c.get_firmware_version, ""),
            "platform": self._safe(c.get_platform, ""),
            "device_name": self._safe(c.get_device_name, ""),
            "mac": self._safe(c.get_mac, ""),
            "users": getattr(c, "users", None),
            "users_cap": getattr(c, "users_cap", None),
            "records": getattr(c, "records", None),
            "records_cap": getattr(c, "rec_cap", None),
            "fingers": getattr(c, "fingers", None),
            "faces": getattr(c, "faces", None),
            "clock": clock.isoformat(sep=" ", timespec="seconds") if clock else None,
            "drift_seconds": drift,
            "read_at": db.now(),
        }

    def record_count(self) -> int | None:
        try:
            self.conn.read_sizes()
            return int(self.conn.records)
        except Exception:
            return None

    def attendance(self) -> list[dict]:
        rows = self.conn.get_attendance() or []
        out = []
        for a in rows:
            ts = a.timestamp
            if not isinstance(ts, datetime):
                continue
            out.append({"user_id": str(a.user_id).strip(), "ts": ts.replace(microsecond=0),
                        "uid": a.uid, "punch": a.punch, "status": a.status})
        return out

    def users(self) -> list[dict]:
        return [{"uid": u.uid, "user_id": str(u.user_id).strip(), "name": (u.name or "").strip(),
                 "privilege": u.privilege, "card": str(u.card or "")}
                for u in (self.conn.get_users() or [])]

    def set_time(self, when: datetime | None = None):
        self.conn.set_time(when or datetime.now())

    def clear_attendance(self):
        self.conn.clear_attendance()


def open_machine(device: dict, settings: dict) -> Machine:
    return Machine(effective(device, settings))


def save_info(device_pk: int, info: dict):
    db.update("devices", device_pk, last_info=json.dumps(info))


def validate_device_id(value: str) -> str:
    value = (value or "").strip()
    if not value or not all(ch.isalnum() or ch in "-_" for ch in value):
        raise TaskError("The Device ID may only contain letters, digits, '-' and '_' "
                        "(no spaces).", retryable=False)
    return value
