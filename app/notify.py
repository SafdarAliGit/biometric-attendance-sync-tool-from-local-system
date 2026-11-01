"""Desktop notifications, e-mail and alert rules (best effort, never raises)."""
import os
import shutil
import smtplib
import ssl
import subprocess
from datetime import datetime, timedelta
from email.message import EmailMessage
from html import escape

from . import APP_NAME, db
from .config import IS_WINDOWS
from .crypto import decrypt
from .errors import TaskError
from .events import log, logger


def _ps_escape(s: str) -> str:
    return s.replace("'", "''")


def desktop_notify(title: str, message: str):
    try:
        if IS_WINDOWS:
            script = (
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
                "ContentType = WindowsRuntime] > $null;"
                "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
                "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
                "$x = $t.GetElementsByTagName('text');"
                f"$x.Item(0).AppendChild($t.CreateTextNode('{_ps_escape(title)}')) > $null;"
                f"$x.Item(1).AppendChild($t.CreateTextNode('{_ps_escape(message)}')) > $null;"
                "$n = [Windows.UI.Notifications.ToastNotification]::new($t);"
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
                f"'{APP_NAME}').Show($n);"
            )
            subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
                              script], creationflags=0x08000000)  # CREATE_NO_WINDOW
        elif shutil.which("notify-send"):
            env = dict(os.environ)
            if "DBUS_SESSION_BUS_ADDRESS" not in env and hasattr(os, "getuid"):
                bus = f"/run/user/{os.getuid()}/bus"
                if os.path.exists(bus):
                    env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"
            subprocess.Popen(["notify-send", "-a", APP_NAME, title, message],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        logger.warning("Desktop notification failed: %s", e)


# ---------------------------------------------------------------- e-mail

def send_email(subject: str, text: str, html: str | None = None, settings: dict | None = None,
               to: list[str] | None = None):
    """Send one e-mail. Raises TaskError with a readable message on failure."""
    s = settings or db.get_settings()
    recipients = to or [x for x in (s.get("email_to") or []) if x]
    if not s.get("smtp_host"):
        raise TaskError("No SMTP server is configured.", retryable=False)
    if not recipients:
        raise TaskError("No alert recipients are configured.", retryable=False)
    msg = EmailMessage()
    msg["Subject"] = f"[{APP_NAME}] {subject}"
    msg["From"] = s.get("smtp_from") or s.get("smtp_user") or "attendance-sync@localhost"
    msg["To"] = ", ".join(recipients)
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    host, port = s["smtp_host"], int(s.get("smtp_port") or 587)
    security = s.get("smtp_security") or "starttls"
    password = decrypt(s.get("smtp_password_enc"))
    try:
        ctx = ssl.create_default_context()
        if security == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=30, context=ctx)
        else:
            server = smtplib.SMTP(host, port, timeout=30)
        with server:
            server.ehlo()
            if security == "starttls":
                server.starttls(context=ctx)
                server.ehlo()
            if s.get("smtp_user"):
                server.login(s["smtp_user"], password or "")
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise TaskError("The SMTP server rejected the user name or password.", str(e), False)
    except (smtplib.SMTPException, OSError) as e:
        raise TaskError(f"Could not send the e-mail: {e}", str(e))


def _html_table(title: str, intro: str, rows: list[tuple[str, str]]) -> str:
    body = "".join(f"<tr><td style='padding:4px 12px 4px 0;color:#666'>{escape(k)}</td>"
                   f"<td style='padding:4px 0'><b>{escape(str(v))}</b></td></tr>" for k, v in rows)
    return (f"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px'>"
            f"<h2 style='margin:0 0 8px'>{escape(title)}</h2><p>{escape(intro)}</p>"
            f"<table>{body}</table><p style='color:#888;font-size:12px'>Sent by {APP_NAME}</p></div>")


# ---------------------------------------------------------------- alerts

def _cooldown_ok(key: str, minutes: int) -> bool:
    last = db.get_state("alert:" + key)
    if last:
        try:
            if datetime.fromisoformat(last) > datetime.now() - timedelta(minutes=minutes):
                return False
        except ValueError:
            pass
    return True


def _alert(key: str, subject: str, intro: str, rows: list[tuple[str, str]], settings: dict):
    if not settings.get("email_enabled"):
        return
    if not _cooldown_ok(key, int(settings.get("alert_cooldown_minutes") or 360)):
        return
    text = intro + "\n\n" + "\n".join(f"{k}: {v}" for k, v in rows)
    try:
        send_email(subject, text, _html_table(subject, intro, rows), settings)
        db.set_state("alert:" + key, db.now())
        log("INFO", f"Alert e-mail sent: {subject}")
    except TaskError as e:
        log("WARNING", f"Alert e-mail could not be sent: {e.message}", e.detail)


def clear_alert(key: str):
    db.execute("DELETE FROM state WHERE key = ?", ("alert:" + key,))


def check_alerts():
    """Called by the scheduler every few minutes."""
    s = db.get_settings()
    if not s.get("email_enabled"):
        return
    offline_min = int(s.get("alert_device_offline_minutes") or 0)
    if offline_min:
        limit = (datetime.now() - timedelta(minutes=offline_min)).isoformat(timespec="seconds")
        for d in db.query("SELECT * FROM devices WHERE enabled = 1"):
            ref = d["last_success_at"] or d["created_at"]
            if ref and ref < limit and d["last_attempt_at"]:
                _alert(f"offline:{d['id']}", f"Machine '{d['name']}' is offline",
                       f"No attendance could be read from this machine for more than "
                       f"{offline_min} minutes. Punches stay stored on the machine and will be "
                       "synced once it is reachable again.",
                       [("Machine", d["name"]), ("IP address", d["ip"]),
                        ("Last successful read", d["last_success_at"] or "never"),
                        ("Last error", d["last_error"] or "")], s)
            elif d["status"] == "online":
                clear_alert(f"offline:{d['id']}")
    threshold = int(s.get("alert_failed_punches") or 0)
    if threshold:
        failed = db.scalar("SELECT COUNT(*) FROM punches WHERE sync_status = 'failed'") or 0
        if failed >= threshold:
            top = db.query("SELECT reason, COUNT(*) n FROM punches WHERE sync_status='failed' "
                           "GROUP BY reason ORDER BY n DESC LIMIT 5")
            _alert("failed_punches", f"{failed} punches could not be synced",
                   "These punches failed every retry. Open the Punches page, filter on "
                   "'Failed', fix the cause (often a missing attendance device ID on the "
                   "employee) and click 'Retry'.",
                   [("Failed punches", str(failed))] +
                   [(r["reason"] or "other", str(r["n"])) for r in top], s)
        else:
            clear_alert("failed_punches")
    down_min = int(s.get("alert_erp_down_minutes") or 0)
    down_since = db.get_state("erp_down_since")
    if down_min and down_since:
        try:
            since = datetime.fromisoformat(down_since)
        except ValueError:
            since = None
        if since and since < datetime.now() - timedelta(minutes=down_min):
            pending = db.scalar("SELECT COUNT(*) FROM punches WHERE sync_status='pending'") or 0
            _alert("erp_down", "ERPNext is not reachable",
                   "Punches are being collected from the machines and kept on this PC. They "
                   "will be sent automatically when ERPNext is reachable again.",
                   [("Unreachable since", down_since), ("Punches waiting", str(pending)),
                    ("Last error", db.get_state("erp_last_error", ""))], s)
    elif not down_since:
        clear_alert("erp_down")


def daily_summary(settings: dict | None = None, force: bool = False):
    s = settings or db.get_settings()
    if not force and not (s.get("email_enabled") and s.get("daily_summary_enabled")):
        return
    today = datetime.now().strftime("%Y-%m-%d")
    q = lambda sql, p=(): db.scalar(sql, p) or 0  # noqa: E731
    synced = q("SELECT COUNT(*) FROM punches WHERE synced_at >= ? AND sync_status='synced'",
               (today,))
    fetched = q("SELECT COUNT(*) FROM punches WHERE fetched_at >= ?", (today,))
    pending = q("SELECT COUNT(*) FROM punches WHERE sync_status='pending'")
    failed = q("SELECT COUNT(*) FROM punches WHERE sync_status='failed'")
    employees = q("SELECT COUNT(DISTINCT user_id) FROM punches WHERE ts >= ?", (today,))
    devices = db.query("SELECT name, status, last_success_at FROM devices WHERE enabled = 1")
    rows = [("New punches read today", fetched), ("Punches sent to ERPNext today", synced),
            ("Employees who punched today", employees), ("Waiting to be sent", pending),
            ("Failed (need attention)", failed)]
    rows += [(f"Machine: {d['name']}", f"{d['status']} · last read {d['last_success_at'] or 'never'}")
             for d in devices]
    send_email(f"Daily attendance summary {today}",
               "\n".join(f"{k}: {v}" for k, v in rows),
               _html_table(f"Attendance summary for {today}", "Today's sync activity:", rows), s)
