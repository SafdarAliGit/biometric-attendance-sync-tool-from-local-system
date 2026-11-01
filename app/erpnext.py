"""ERPNext / Frappe HR REST client with error classification."""
import json
import threading
from datetime import datetime
from urllib.parse import quote

import requests

from . import db
from .crypto import decrypt
from .errors import TaskError

EMPLOYEE_NOT_FOUND = "No Employee found for the given employee field value"
EMPLOYEE_INACTIVE = "Transactions cannot be created for an Inactive Employee"
DUPLICATE_CHECKIN = "This employee already has a log with the same timestamp"

# Result kinds returned by classify():
#   ok, duplicate, unknown_employee, inactive_employee  -> punch-level outcomes
#   validation                                          -> punch-level, retried with back-off
#   auth, permission, not_found_endpoint                -> ERPNext-level, stop pushing (config issue)
#   network, server, rate_limit                         -> ERPNext-level, transient
ERP_LEVEL = {"auth", "permission", "not_found_endpoint", "network", "server", "rate_limit"}

_method_cache: dict[str, str] = {}
_cache_lock = threading.Lock()


def _error_text(resp: requests.Response) -> str:
    """Pull the readable message(s) out of a Frappe error response."""
    try:
        data = resp.json()
    except ValueError:
        return (resp.text or resp.reason or "")[:2000]
    parts = []
    if data.get("exception"):
        parts.append(str(data["exception"]))
    if data.get("_server_messages"):
        try:
            for m in json.loads(data["_server_messages"]):
                try:
                    m = json.loads(m)
                    parts.append(str(m.get("message", m)))
                except (ValueError, AttributeError):
                    parts.append(str(m))
        except ValueError:
            parts.append(str(data["_server_messages"]))
    if data.get("message") and not isinstance(data.get("message"), dict):
        parts.append(str(data["message"]))
    if data.get("exc"):
        try:
            exc = json.loads(data["exc"])
            parts.append(exc[0] if isinstance(exc, list) and exc else str(exc))
        except ValueError:
            parts.append(str(data["exc"]))
    text = "\n".join(p for p in parts if p).strip()
    return text or json.dumps(data)[:2000]


def _short(text: str) -> str:
    """First meaningful line, without HTML tags."""
    import re
    clean = re.sub(r"<[^>]+>", "", text or "")
    for line in clean.splitlines():
        line = line.strip()
        if line and not line.startswith("Traceback"):
            return line[:300]
    return clean[:300]


def classify(resp: requests.Response | None, exc: Exception | None = None) -> tuple[str, str, str]:
    """Return (kind, short message, full text)."""
    if exc is not None:
        if isinstance(exc, requests.exceptions.SSLError):
            return "network", "SSL certificate could not be verified", str(exc)
        if isinstance(exc, requests.exceptions.Timeout):
            return "network", "ERPNext did not respond in time", str(exc)
        if isinstance(exc, requests.exceptions.RequestException):
            return "network", "Could not reach ERPNext", str(exc)
        return "network", f"Request failed: {exc}", str(exc)
    if resp.status_code == 200:
        return "ok", "", ""
    text = _error_text(resp)
    if DUPLICATE_CHECKIN in text:
        return "duplicate", "Already in ERPNext (same employee and time)", text
    if EMPLOYEE_NOT_FOUND in text:
        return "unknown_employee", "No ERPNext employee has this attendance device ID", text
    if EMPLOYEE_INACTIVE in text:
        return "inactive_employee", "The employee is inactive in ERPNext", text
    if resp.status_code == 401 or "AuthenticationError" in text:
        return "auth", "ERPNext rejected the API key / secret", text
    if resp.status_code == 403 or "PermissionError" in text:
        return "permission", ("The API user lacks permission (needs Create on Employee Checkin "
                              "and Write on Shift Type)"), text
    if resp.status_code == 404 or "ModuleNotFoundError" in text or "has no attribute" in text \
            or "is not whitelisted" in text:
        return "not_found_endpoint", "The check-in API method was not found on this ERPNext", text
    if resp.status_code == 429:
        return "rate_limit", "ERPNext is rate limiting requests", text
    if resp.status_code >= 500 and "ValidationError" not in text:
        return "server", f"ERPNext server error (HTTP {resp.status_code})", text
    return "validation", _short(text) or f"HTTP {resp.status_code}", text


class ERPNext:
    def __init__(self, settings: dict | None = None):
        s = settings or db.get_settings()
        self.url = (s.get("erpnext_url") or "").strip().rstrip("/")
        self.key = (s.get("erpnext_api_key") or "").strip()
        self.secret = decrypt(s.get("erpnext_api_secret_enc")) or ""
        self.version = str(s.get("erpnext_version") or "auto")
        self.fieldname = (s.get("employee_fieldname") or "attendance_device_id").strip()
        self.verify = bool(s.get("verify_ssl", True))
        self.timeout = int(s.get("request_timeout") or 30)
        self.skip_auto_attendance = bool(s.get("skip_auto_attendance"))
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"token {self.key}:{self.secret}",
                                     "Accept": "application/json"})

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key and self.secret)

    def require(self):
        if not self.configured:
            raise TaskError("ERPNext is not configured. Enter the URL, API key and API secret in "
                            "Settings → ERPNext connection.", retryable=False)

    def _req(self, method: str, path: str, **kw) -> requests.Response:
        kw.setdefault("timeout", self.timeout)
        kw.setdefault("verify", self.verify)
        return self.session.request(method, self.url + path, **kw)

    def _check(self, resp: requests.Response, what: str):
        kind, short, text = classify(resp)
        if kind != "ok":
            raise TaskError(f"{what}: {short}", text, retryable=kind in ("network", "server"))
        try:
            return resp.json().get("message", resp.json().get("data"))
        except ValueError:
            raise TaskError(f"{what}: ERPNext returned an unexpected response "
                            "(is the URL correct?)", resp.text[:2000])

    # ---- discovery ----

    def versions(self) -> dict:
        try:
            r = self._req("GET", "/api/method/frappe.utils.change_log.get_versions")
            if r.status_code == 200:
                return r.json().get("message") or {}
        except (requests.RequestException, ValueError):
            pass
        return {}

    def checkin_method(self) -> str:
        if self.version not in ("auto", ""):
            app = "hrms" if int(self.version) > 13 else "erpnext"
            return f"{app}.hr.doctype.employee_checkin.employee_checkin.add_log_based_on_employee_field"
        with _cache_lock:
            if self.url in _method_cache:
                return _method_cache[self.url]
        app = "hrms" if "hrms" in self.versions() else "erpnext"
        method = f"{app}.hr.doctype.employee_checkin.employee_checkin.add_log_based_on_employee_field"
        with _cache_lock:
            _method_cache[self.url] = method
        return method

    def test(self) -> dict:
        self.require()
        try:
            r = self._req("GET", "/api/method/frappe.auth.get_logged_user")
        except requests.RequestException as e:
            kind, short, text = classify(None, e)
            raise TaskError(short, text)
        user = self._check(r, "Login check")
        versions = self.versions()
        with _cache_lock:
            _method_cache.pop(self.url, None)
        perms = {}
        for doctype in ("Employee Checkin", "Employee", "Shift Type"):
            try:
                rr = self._req("GET", f"/api/resource/{quote(doctype)}",
                               params={"limit_page_length": 1, "fields": '["name"]'})
                perms[doctype] = rr.status_code == 200
            except requests.RequestException:
                perms[doctype] = False
        return {"ok": True, "user": user,
                "versions": {k: (v.get("version") if isinstance(v, dict) else v)
                             for k, v in versions.items()},
                "hrms": "hrms" in versions, "method": self.checkin_method(),
                "read_permissions": perms, "at": db.now()}

    # ---- check-ins ----

    def add_checkin(self, employee_value: str, ts: datetime, device_id: str, log_type: str | None,
                    latitude=None, longitude=None) -> tuple[str, str, str, str | None]:
        """Return (kind, short message, full text, checkin name)."""
        data = {"employee_field_value": employee_value, "timestamp": str(ts),
                "device_id": device_id, "log_type": log_type,
                "employee_fieldname": self.fieldname}
        if self.skip_auto_attendance:
            data["skip_auto_attendance"] = 1
        if latitude not in (None, "") and longitude not in (None, ""):
            data["latitude"] = latitude
            data["longitude"] = longitude
        try:
            r = self._req("POST", "/api/method/" + self.checkin_method(), json=data)
        except requests.RequestException as e:
            return (*classify(None, e), None)
        kind, short, text = classify(r)
        name = None
        if kind == "ok":
            try:
                msg = r.json().get("message")
                name = msg.get("name") if isinstance(msg, dict) else str(msg)
            except ValueError:
                return "server", "ERPNext returned an unreadable response", r.text[:2000], None
        return kind, short, text, name

    def update_shift_sync(self, shift_type: str, ts: datetime):
        r = self._req("PUT", f"/api/resource/Shift%20Type/{quote(shift_type, safe='')}",
                      json={"last_sync_of_checkin": ts.strftime("%Y-%m-%d %H:%M:%S")})
        return self._check(r, f"Updating Shift Type '{shift_type}'")

    # ---- lists ----

    def _list(self, doctype: str, fields: list[str], filters=None) -> list[dict]:
        params = {"fields": json.dumps(fields), "limit_page_length": 0}
        if filters:
            params["filters"] = json.dumps(filters)
        r = self._req("GET", f"/api/resource/{quote(doctype)}", params=params)
        return self._check(r, f"Reading {doctype} list") or []

    def employees(self) -> list[dict]:
        self.require()
        base = ["name", "employee_name", "status", "department", "designation", "company",
                "branch"]
        fields = base + [self.fieldname]
        try:
            return self._list("Employee", fields)
        except TaskError:
            # some optional fields (branch, designation) may not be readable on every setup
            return self._list("Employee", ["name", "employee_name", "status", self.fieldname])

    def shift_types(self) -> list[dict]:
        self.require()
        try:
            return self._list("Shift Type", ["name", "last_sync_of_checkin",
                                             "enable_auto_attendance"])
        except TaskError:
            return self._list("Shift Type", ["name"])

    def set_employee_device_value(self, employee: str, value: str):
        self.require()
        r = self._req("PUT", f"/api/resource/Employee/{quote(employee, safe='')}",
                      json={self.fieldname: value})
        return self._check(r, f"Updating employee {employee}")
