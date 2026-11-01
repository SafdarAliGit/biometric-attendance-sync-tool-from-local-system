"""Interval scheduler: periodic sync inside the active hours, alerts, daily summary, housekeeping."""
import threading
import time
from datetime import datetime, timedelta

from . import db
from .engine import engine
from .errors import TaskError
from .events import log, logger
from .notify import check_alerts, daily_summary


def in_active_window(settings: dict, moment: datetime) -> bool:
    if not settings.get("active_hours_enabled"):
        return True
    if moment.weekday() not in (settings.get("active_days") or []):
        return False
    hm = moment.strftime("%H:%M")
    start, end = settings.get("active_from") or "00:00", settings.get("active_to") or "23:59"
    if start <= end:
        return start <= hm <= end
    return hm >= start or hm <= end  # window over midnight, e.g. 22:00 → 06:00


def _last_auto_run() -> datetime | None:
    row = db.query_one("SELECT started_at FROM runs WHERE trigger IN ('schedule','startup') "
                       "ORDER BY id DESC LIMIT 1")
    if row and row["started_at"]:
        try:
            return datetime.fromisoformat(row["started_at"])
        except ValueError:
            return None
    return None


def next_runs(limit: int = 3) -> list[str]:
    """Upcoming automatic sync times for the dashboard."""
    s = db.get_settings()
    if not s.get("sync_enabled"):
        return []
    interval = max(1, int(s.get("sync_interval_minutes") or 15))
    last = _last_auto_run()
    t = (last + timedelta(minutes=interval)) if last else datetime.now()
    t = max(t, datetime.now()).replace(second=0, microsecond=0)
    out, guard = [], 0
    while len(out) < limit and guard < 60 * 24 * 8:
        if in_active_window(s, t):
            out.append(t.isoformat(timespec="minutes"))
            t += timedelta(minutes=interval)
        else:
            t += timedelta(minutes=1)
        guard += 1
    return out


class Scheduler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True, name="scheduler")
        self._halt = threading.Event()
        self._boot_time = time.time()
        self._startup_done = False
        self._last_alerts = 0.0
        self._last_housekeeping = 0.0

    def stop(self):
        self._halt.set()

    def run(self):
        while not self._halt.is_set():
            try:
                self.tick(datetime.now())
            except Exception as e:
                logger.exception("scheduler error: %s", e)
            for job in (self.alerts, self.summary, self.housekeeping):
                try:
                    job()
                except Exception as e:
                    logger.exception("scheduler job error: %s", e)
            self._halt.wait(15)

    def tick(self, moment: datetime):
        s = db.get_settings()
        if not s.get("sync_enabled") or engine.is_running():
            return
        if not db.scalar("SELECT COUNT(*) FROM devices WHERE enabled = 1"):
            return
        if not self._startup_done:
            if time.time() - self._boot_time < 10:
                return
            self._startup_done = True
            if s.get("sync_on_startup") and in_active_window(s, moment):
                self._start("startup")
                return
        if not in_active_window(s, moment):
            return
        interval = max(1, int(s.get("sync_interval_minutes") or 15))
        last = _last_auto_run()
        if last is None or moment >= last + timedelta(minutes=interval):
            self._start("schedule")

    def _start(self, trigger: str):
        try:
            run_id = engine.start_run(trigger)
            logger.info("Automatic sync run #%s started (%s)", run_id, trigger)
        except TaskError as e:
            log("WARNING", f"Automatic sync skipped: {e.message}")
            # avoid retrying every 15 s: record a skipped run marker
            db.execute("INSERT INTO runs (trigger, mode, status, started_at, finished_at, summary)"
                       " VALUES (?,?,?,?,?,?)", (trigger, "full", "failed", db.now(), db.now(),
                                                 f"Skipped: {e.message}"))

    def alerts(self):
        if time.time() - self._last_alerts < 300:
            return
        self._last_alerts = time.time()
        check_alerts()

    def summary(self):
        s = db.get_settings()
        if not (s.get("email_enabled") and s.get("daily_summary_enabled")):
            return
        now = datetime.now()
        if now.strftime("%H:%M") < (s.get("daily_summary_time") or "20:00"):
            return
        today = now.strftime("%Y-%m-%d")
        if db.get_state("daily_summary_sent") == today:
            return
        db.set_state("daily_summary_sent", today)
        try:
            daily_summary(s)
            log("INFO", "Daily summary e-mail sent.")
        except TaskError as e:
            log("WARNING", f"Daily summary e-mail failed: {e.message}", e.detail)

    def housekeeping(self):
        if time.time() - self._last_housekeeping < 3600:
            return
        self._last_housekeeping = time.time()
        s = db.get_settings()
        cut = lambda days: (datetime.now() - timedelta(days=int(days))).isoformat(timespec="seconds")  # noqa: E731
        db.execute("DELETE FROM logs WHERE ts < ?", (cut(s.get("log_retention_days") or 90),))
        db.execute("DELETE FROM runs WHERE started_at < ? AND status != 'running'",
                   (cut(s.get("run_retention_days") or 180),))
        if int(s.get("punch_retention_days") or 0) > 0:
            n = db.execute_count("DELETE FROM punches WHERE sync_status IN ('synced','skipped') "
                                 "AND synced_at < ?", (cut(s["punch_retention_days"]),))
            if n:
                log("INFO", f"Housekeeping: removed {n} old synced punch(es) from the local "
                            "ledger.")


scheduler = Scheduler()
