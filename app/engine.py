"""Sync runs: read punches from every machine, keep them in the local ledger, push them to ERPNext.

Design rules
- Every punch read from a machine is stored locally first (de-duplicated). Nothing is lost if
  ERPNext, the network or this program fails half-way.
- Each machine is processed independently. An offline machine never stops the others, and the
  punches already stored for it are still pushed.
- Each punch has its own status, attempt counter and back-off. One bad punch never blocks the rest.
- If ERPNext itself is down (network, auth, server errors) pushing pauses for the rest of the run
  (circuit breaker) and resumes automatically on the next run.
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from . import db
from .device import effective, open_machine
from .erpnext import ERP_LEVEL, ERPNext
from .errors import Cancelled, TaskError, explain
from .events import bus, log, logger
from .notify import desktop_notify

FINAL = {"synced", "skipped"}
TS_FMT = "%Y-%m-%d %H:%M:%S"


def _parse_ts(value: str) -> datetime:
    return datetime.strptime(value, TS_FMT)


def _parse_date(value: str | None):
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            pass
    return None


class Run:
    def __init__(self, run_id: int, trigger: str, mode: str, options: dict):
        self.id = run_id
        self.trigger = trigger
        self.mode = mode
        self.options = options
        self.started_at = db.now()
        self.cancel = threading.Event()
        self.tasks: dict[int, dict] = {}
        self.lock = threading.Lock()
        self.erp_blocked: str | None = None     # reason pushing is paused for this run
        self.erp_streak = 0                      # consecutive transient ERPNext errors
        self.erp_sem = threading.Semaphore(1)
        self.finished: str | None = None
        self.summary = ""
        self.stage = "machines"                  # machines | shifts | done

    def snapshot(self) -> dict:
        with self.lock:
            return {"id": self.id, "trigger": self.trigger, "mode": self.mode,
                    "started_at": self.started_at, "cancelling": self.cancel.is_set(),
                    "erp_blocked": self.erp_blocked, "stage": self.stage,
                    "finished": self.finished, "summary": self.summary,
                    "tasks": [dict(t) for t in self.tasks.values()]}


class Engine:
    def __init__(self):
        self._lock = threading.Lock()
        self.runs: dict[int, Run] = {}

    # ---------------------------------------------------------------- public API

    def is_running(self) -> bool:
        return any(not r.finished for r in self.runs.values())

    def active_snapshot(self) -> list[dict]:
        return [r.snapshot() for r in self.runs.values()]

    def recover_interrupted(self):
        """Runs that were running when the service stopped are marked as interrupted."""
        for r in db.query("SELECT id FROM runs WHERE status = 'running'"):
            db.update("runs", r["id"], status="failed", finished_at=db.now(),
                      summary="Interrupted: the service stopped during this run.")
            db.execute("UPDATE tasks SET status='failed', error=COALESCE(error, "
                       "'Interrupted: the service stopped') WHERE run_id = ? AND status NOT IN "
                       "('success','failed','partial','cancelled')", (r["id"],))

    def cancel_run(self, run_id: int):
        run = self.runs.get(run_id)
        if not run or run.finished:
            raise TaskError("This run is not active.", retryable=False)
        run.cancel.set()
        bus.publish("run_cancelling", run_id=run_id)
        log("WARNING", f"Cancel requested for sync run #{run_id}", run_id=run_id)

    def start_run(self, trigger: str, options: dict | None = None) -> int:
        options = options or {}
        mode = "push" if options.get("push_only") else "full"
        with self._lock:
            if self.is_running():
                raise TaskError("A sync is already running. Wait for it to finish.",
                                retryable=False)
            ids = options.get("device_ids")
            if ids:
                marks = ",".join("?" * len(ids))
                devices = db.query(f"SELECT * FROM devices WHERE id IN ({marks}) ORDER BY name",
                                   tuple(ids))
            else:
                devices = db.query("SELECT * FROM devices WHERE enabled = 1 ORDER BY name")
            requeued = self._apply_resync(options, devices)
            if mode == "push":
                due = {r["device_pk"] for r in db.query(
                    "SELECT DISTINCT device_pk FROM punches WHERE sync_status = 'pending'")}
                devices = [d for d in devices if d["id"] in due] if ids else \
                    db.query("SELECT * FROM devices WHERE id IN (SELECT DISTINCT device_pk FROM "
                             "punches WHERE sync_status='pending') ORDER BY name")
            if not devices and mode == "full":
                raise TaskError("No enabled machines. Add a machine first, or enable one.",
                                retryable=False)
            run_id = db.execute(
                "INSERT INTO runs (trigger, mode, status, started_at, devices_total, options) "
                "VALUES (?,?,?,?,?,?)",
                (trigger, mode, "running", db.now(), len(devices), json.dumps(options)))
            run = Run(run_id, trigger, mode, options)
            for d in devices:
                tid = db.execute(
                    "INSERT INTO tasks (run_id, device_pk, device_name, device_id, ip, status) "
                    "VALUES (?,?,?,?,?,?)", (run_id, d["id"], d["name"], d["device_id"], d["ip"],
                                             "queued"))
                run.tasks[tid] = {
                    "id": tid, "run_id": run_id, "device_pk": d["id"], "device_name": d["name"],
                    "device_id": d["device_id"], "ip": d["ip"], "status": "queued",
                    "fetch_status": "skipped" if mode == "push" else "waiting",
                    "push_status": "waiting", "attempts": 0, "fetched": 0, "new_punches": 0,
                    "records": None, "to_push": 0, "pushed": 0, "push_failed": 0, "skipped": 0,
                    "cleared": 0, "message": "Waiting…", "error": None, "started_at": None,
                    "finished_at": None, "fetch_started_at": None, "push_started_at": None,
                    "fetch_seconds": None, "push_seconds": None}
            # drop finished runs from memory
            for rid in [k for k, r in self.runs.items() if r.finished]:
                self.runs.pop(rid, None)
            self.runs[run_id] = run
        bus.publish("run_started", run=run.snapshot())
        names = ", ".join(d["name"] for d in devices) or "none"
        label = "Push-only sync" if mode == "push" else "Sync"
        log("INFO", f"{label} run #{run_id} started ({trigger}) for: {names}", run_id=run_id)
        if requeued is not None:
            log("INFO", f"Re-send: {requeued} stored punch(es) between "
                        f"{options.get('resync_from') or 'the start'} and "
                        f"{options.get('resync_to') or 'today'} were queued again. Punches already "
                        "in ERPNext are recognised as duplicates.", run_id=run_id)
        threading.Thread(target=self._run, args=(run, devices), daemon=True,
                         name=f"run-{run_id}").start()
        return run_id

    # ---------------------------------------------------------------- run

    def _run(self, run: Run, devices: list[dict]):
        settings = db.get_settings()
        erp = ERPNext(settings)
        run.erp_sem = threading.Semaphore(max(1, int(settings.get("erp_concurrency") or 1)))
        if not erp.configured:
            run.erp_blocked = "ERPNext is not configured (Settings → ERPNext connection)"
        try:
            by_task = {tid: next(d for d in devices if d["id"] == t["device_pk"])
                       for tid, t in run.tasks.items()}
            workers = max(1, min(int(settings.get("parallel_devices") or 4), len(by_task) or 1))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix=f"run{run.id}") as ex:
                futures = [ex.submit(self._device_task, run, tid, dev, settings, erp)
                           for tid, dev in by_task.items()]
                for f in futures:
                    try:
                        f.result()
                    except Exception as e:  # never expected, but never fatal for the run
                        logger.exception("device task crashed: %s", e)
            if settings.get("shift_sync_enabled") and not run.cancel.is_set():
                run.stage = "shifts"
                bus.publish("run_stage", run_id=run.id, stage="shifts")
                self._sync_shifts(run, settings, erp)
        except Exception as e:
            msg, detail, _ = explain(e)
            log("ERROR", f"Sync run #{run.id} stopped unexpectedly: {msg}", detail, run_id=run.id)
        finally:
            self._finish(run, settings)

    def _apply_resync(self, o: dict, devices: list[dict]) -> int | None:
        """Queue stored punches of a date range again (before machines are selected)."""
        if not (o.get("resync_from") or o.get("resync_to")) or not devices:
            return None
        start = o.get("resync_from") or "0000-01-01"
        end = (o.get("resync_to") or "9999-12-31") + " 23:59:59"
        ids = [d["id"] for d in devices]
        marks = ",".join("?" * len(ids))
        return db.execute_count(
            f"UPDATE punches SET sync_status='pending', attempts=0, next_attempt_at=NULL, "
            f"reason=NULL, last_error=NULL WHERE device_pk IN ({marks}) AND ts >= ? AND ts <= ? "
            f"AND sync_status != 'pending'", (*ids, start, end))

    def _publish(self, run: Run, task: dict, force: bool = False):
        now = time.monotonic()
        if not force and now - task.get("_pub", 0) < 0.4:
            return
        task["_pub"] = now
        bus.publish("task", task={k: v for k, v in task.items() if not k.startswith("_")})

    def _set(self, run: Run, task: dict, publish=True, force=False, **fields):
        with run.lock:
            task.update(fields)
        if publish:
            self._publish(run, task, force)

    def _save_task(self, task: dict):
        db.update("tasks", task["id"], **{k: task[k] for k in (
            "status", "fetch_status", "push_status", "attempts", "started_at", "finished_at",
            "fetch_seconds", "push_seconds", "fetched", "new_punches", "to_push", "pushed",
            "push_failed", "skipped", "cleared", "error")}, error_detail=task.get("_detail"))

    # ---------------------------------------------------------------- one machine

    def _device_task(self, run: Run, tid: int, device: dict, settings: dict, erp: ERPNext):
        task = run.tasks[tid]
        name = device["name"]
        self._set(run, task, status="connecting", started_at=db.now(), force=True)
        fetched_keys: list[tuple] | None = None
        fetch_ok = None
        try:
            if run.mode == "full":
                fetched_keys = self._fetch(run, task, device, settings)
                fetch_ok = fetched_keys is not None
            if run.cancel.is_set():
                raise Cancelled()
            self._push(run, task, device, settings, erp)
            if run.cancel.is_set():
                raise Cancelled()
            if (fetch_ok and settings.get("clear_from_device_on_fetch")
                    and device.get("clear_after_sync")):
                self._safe_clear(run, task, device, settings, fetched_keys)
        except Cancelled:
            self._set(run, task, status="cancelled", message="Cancelled", force=True)
        except Exception as e:
            msg, detail, _ = explain(e)
            task["_detail"] = detail
            self._set(run, task, status="failed", error=msg, message=msg, force=True)
            log("ERROR", msg, detail, run_id=run.id, task_id=tid, device=name)
        finally:
            if task["status"] not in ("failed", "cancelled"):
                if fetch_ok is False:
                    status = "failed"
                elif task["push_status"] in ("partial", "paused", "failed") or task["push_failed"]:
                    status = "partial"
                else:
                    status = "success"
                parts = []
                if run.mode == "full":
                    parts.append(f"{task['new_punches']} new" if fetch_ok else "machine not reachable")
                parts.append(f"{task['pushed']} sent")
                if task["skipped"]:
                    parts.append(f"{task['skipped']} skipped")
                if task["push_failed"]:
                    parts.append(f"{task['push_failed']} to retry")
                if task["cleared"]:
                    parts.append("machine log cleared")
                self._set(run, task, status=status, message=" · ".join(parts))
            self._set(run, task, finished_at=db.now(), force=True)
            self._save_task(task)

    def _fetch(self, run: Run, task: dict, device: dict, settings: dict) -> list[tuple] | None:
        """Read all punches from the machine and store the new ones. Returns the keys read,
        or None if the machine could not be read."""
        name = device["name"]
        cfg = effective(device, settings)
        retries = max(0, int(settings.get("device_retries") or 0))
        delay = max(0, int(settings.get("device_retry_delay") or 0))
        start = time.monotonic()
        self._set(run, task, fetch_status="running", fetch_started_at=db.now(), force=True)
        db.update("devices", device["id"], last_attempt_at=db.now())
        last_exc = None
        rows: list[dict] | None = None
        info: dict = {}
        for attempt in range(1, retries + 2):
            if run.cancel.is_set():
                raise Cancelled()
            self._set(run, task, attempts=attempt, status="connecting",
                      message=f"Connecting to {cfg['ip']}:{cfg['port']}…"
                              + (f" (attempt {attempt})" if attempt > 1 else ""), force=True)
            try:
                with open_machine(device, settings) as m:
                    records = m.record_count()
                    self._set(run, task, status="fetching", records=records,
                              message=f"Reading {records:,} record(s) from the machine…"
                              if records is not None else "Reading records from the machine…",
                              force=True)
                    info = self._clock_check(run, task, device, settings, m)
                    with m.disabled(bool(settings.get("disable_device_during_fetch"))):
                        rows = m.attendance()
                last_exc = None
                break
            except Exception as e:
                last_exc = e
                msg, detail, retryable = explain(e)
                if attempt <= retries and retryable:
                    log("WARNING", f"Reading the machine failed (attempt {attempt}): {msg} "
                                   f"Retrying in {delay}s…", detail, run_id=run.id,
                        task_id=task["id"], device=name)
                    self._set(run, task, message=f"{msg} Retrying in {delay}s…", force=True)
                    if run.cancel.wait(delay):
                        raise Cancelled()
                    continue
                break
        if rows is None:
            msg, detail, _ = explain(last_exc)
            task["_detail"] = detail
            db.update("devices", device["id"], status="offline", last_error=msg)
            bus.publish("device", device={"id": device["id"], "status": "offline",
                                          "last_error": msg})
            self._set(run, task, fetch_status="failed", error=msg,
                      fetch_seconds=round(time.monotonic() - start, 1),
                      message=msg + " Punches already stored are still sent.", force=True)
            log("ERROR", f"Machine not reachable: {msg} Punches stay on the machine and are read "
                         "on the next run.", detail, run_id=run.id, task_id=task["id"], device=name)
            return None

        new, ignored = self._store(run, device, cfg, rows)
        info.update({"records": len(rows)})
        prev = json.loads(device.get("last_info") or "{}")
        prev.update({k: v for k, v in info.items() if v is not None})
        db.update("devices", device["id"], status="online", last_error=None,
                  last_success_at=db.now(), last_info=json.dumps(prev))
        bus.publish("device", device={"id": device["id"], "status": "online",
                                      "last_success_at": db.now()})
        secs = round(time.monotonic() - start, 1)
        self._set(run, task, fetch_status="done", fetched=len(rows), new_punches=new,
                  fetch_seconds=secs, message=f"{len(rows):,} read · {new} new", force=True)
        extra = f", {ignored} before the import start date ignored" if ignored else ""
        log("SUCCESS" if new else "INFO",
            f"Read {len(rows):,} punch(es) from the machine in {secs}s: {new} new{extra}.",
            run_id=run.id, task_id=task["id"], device=name)
        return [(r["user_id"], r["ts"].strftime(TS_FMT)) for r in rows]

    def _clock_check(self, run, task, device, settings, m) -> dict:
        info = {}
        try:
            clock = m.conn.get_time()
            drift = round((clock - datetime.now()).total_seconds())
            info = {"clock": clock.strftime(TS_FMT), "drift_seconds": drift}
            limit = int(settings.get("time_drift_alert_seconds") or 0)
            if limit and abs(drift) > limit:
                if settings.get("auto_sync_device_time"):
                    m.set_time()
                    info["drift_seconds"] = 0
                    log("INFO", f"Machine clock was {drift:+d}s off. It was set to this PC's time.",
                        run_id=run.id, task_id=task["id"], device=device["name"])
                else:
                    log("WARNING", f"Machine clock is {drift:+d}s off this PC's time. Punch times "
                                   "may be wrong. Use Machines → Sync time, or enable automatic "
                                   "time sync in Settings.",
                        run_id=run.id, task_id=task["id"], device=device["name"])
        except Exception:
            pass
        return info

    def _store(self, run: Run, device: dict, cfg: dict, rows: list[dict]) -> tuple[int, int]:
        start = _parse_date(cfg.get("import_start_date"))
        now = db.now()
        batch, ignored = [], 0
        for r in rows:
            if not r["user_id"]:
                continue
            if start and r["ts"] < start:
                ignored += 1
                continue
            batch.append((device["id"], r["user_id"], r["ts"].strftime(TS_FMT), r["uid"],
                          r["punch"], r["status"], now, run.id))
        new = db.executemany(
            "INSERT OR IGNORE INTO punches (device_pk, user_id, ts, uid, punch, verify_status, "
            "fetched_at, run_id) VALUES (?,?,?,?,?,?,?,?)", batch) if batch else 0
        return new, ignored

    # ---------------------------------------------------------------- push

    def _log_type(self, direction: str, punch, settings: dict) -> str | None:
        if direction == "IN":
            return "IN"
        if direction == "OUT":
            return "OUT"
        if direction == "AUTO":
            if punch in (settings.get("punch_values_out") or []):
                return "OUT"
            if punch in (settings.get("punch_values_in") or []):
                return "IN"
        return None

    def _push(self, run: Run, task: dict, device: dict, settings: dict, erp: ERPNext):
        name = device["name"]
        due = db.query(
            "SELECT * FROM punches WHERE device_pk = ? AND sync_status = 'pending' AND "
            "(next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY ts, id",
            (device["id"], db.now()))
        waiting = db.scalar("SELECT COUNT(*) FROM punches WHERE device_pk = ? AND "
                            "sync_status = 'pending'", (device["id"],)) or 0
        if not due:
            later = waiting
            self._set(run, task, push_status="done", to_push=0,
                      message=f"Nothing to send{f' ({later} waiting for retry later)' if later else ''}",
                      force=True)
            return
        if run.erp_blocked:
            self._set(run, task, push_status="paused", to_push=len(due),
                      message=f"{len(due)} punch(es) kept for later: {run.erp_blocked}", force=True)
            return
        cfg = effective(device, settings)
        offset = timedelta(minutes=int(settings.get("timestamp_offset_minutes") or 0))
        future_limit = datetime.now() + timedelta(minutes=int(settings.get("ignore_future_minutes") or 0))
        repeat = int(settings.get("repeat_punch_seconds") or 0)
        delay = max(0, int(settings.get("push_delay_ms") or 0)) / 1000
        breaker = max(1, int(settings.get("erp_failure_breaker") or 5))
        start = time.monotonic()
        self._set(run, task, status="pushing", push_status="running", to_push=len(due),
                  push_started_at=db.now(), message=f"Sending {len(due)} punch(es) to ERPNext…",
                  force=True)
        for i, p in enumerate(due, 1):
            if run.cancel.is_set():
                raise Cancelled()
            if run.erp_blocked:
                break
            ts = _parse_ts(p["ts"])
            if settings.get("ignore_future_minutes") and ts > future_limit:
                self._mark(p, "skipped", "future_time",
                           "The punch time is in the future. The machine clock is probably wrong.")
                self._bump(run, task, "skipped")
                continue
            if repeat and db.scalar(
                    "SELECT 1 FROM punches WHERE user_id = ? AND id != ? AND sync_status = 'synced' "
                    "AND ts < ? AND ts >= ? LIMIT 1",
                    (p["user_id"], p["id"], p["ts"],
                     (ts - timedelta(seconds=repeat)).strftime(TS_FMT))):
                self._mark(p, "skipped", "repeat", f"Repeated punch within {repeat}s")
                self._bump(run, task, "skipped")
                continue
            log_type = self._log_type(cfg["punch_direction"], p["punch"], settings)
            with run.erp_sem:
                res = erp.add_checkin(p["user_id"], ts + offset, device["device_id"], log_type,
                                      device.get("latitude"), device.get("longitude"))
            kind, short, text, checkin = res
            self._handle_result(run, task, device, settings, p, kind, short, text, checkin,
                                log_type, breaker)
            if kind == "rate_limit":
                run.cancel.wait(5)
            elif delay:
                run.cancel.wait(delay)
            self._set(run, task, message=f"Sending to ERPNext… {i}/{len(due)}")
        pending_left = db.scalar("SELECT COUNT(*) FROM punches WHERE device_pk = ? AND "
                                 "sync_status = 'pending'", (device["id"],)) or 0
        secs = round(time.monotonic() - start, 1)
        if run.erp_blocked and task["pushed"] + task["skipped"] + task["push_failed"] < len(due):
            push_status = "paused"
        elif task["push_failed"]:
            push_status = "partial"
        else:
            push_status = "done"
        self._set(run, task, push_status=push_status, push_seconds=secs, force=True)
        if task["pushed"] or task["push_failed"] or task["skipped"]:
            lvl = "SUCCESS" if not task["push_failed"] else "WARNING"
            log(lvl, f"ERPNext: {task['pushed']} check-in(s) created, {task['skipped']} skipped / "
                     f"already present, {task['push_failed']} failed in {secs}s. "
                     f"{pending_left} waiting for retry.", run_id=run.id, task_id=task["id"],
                device=name)

    def _bump(self, run: Run, task: dict, key: str):
        with run.lock:
            task[key] += 1
        self._publish(run, task)

    def _mark(self, p: dict, status: str, reason: str | None, error: str | None = None,
              erp_name: str | None = None, log_type: str | None = None, attempts: int | None = None,
              next_at: str | None = None):
        db.update("punches", p["id"], sync_status=status, reason=reason, last_error=error,
                  erp_name=erp_name or p.get("erp_name"), log_type=log_type or p.get("log_type"),
                  attempts=p["attempts"] if attempts is None else attempts,
                  next_attempt_at=next_at,
                  synced_at=db.now() if status in FINAL else p.get("synced_at"))

    def _retry_later(self, p: dict, settings: dict, reason: str, error: str, count: bool = True):
        attempts = p["attempts"] + (1 if count else 0)
        if count and attempts >= int(settings.get("max_push_attempts") or 8):
            self._mark(p, "failed", reason, error, attempts=attempts)
            return "failed"
        base = max(1, int(settings.get("retry_base_minutes") or 5))
        cap = max(base, int(settings.get("retry_max_minutes") or 360))
        wait = min(base * (2 ** max(0, attempts - 1)), cap) if count else base
        nxt = (datetime.now() + timedelta(minutes=wait)).isoformat(timespec="seconds")
        self._mark(p, "pending", reason, error, attempts=attempts, next_at=nxt)
        return "retry"

    def _handle_result(self, run, task, device, settings, p, kind, short, text, checkin,
                       log_type, breaker):
        name = device["name"]
        if kind == "ok":
            run.erp_streak = 0
            self._erp_up()
            self._mark(p, "synced", None, None, erp_name=checkin, log_type=log_type,
                       attempts=p["attempts"] + 1)
            self._bump(run, task, "pushed")
            return
        if kind == "duplicate":
            run.erp_streak = 0
            # a punch this app created earlier (re-sent) keeps its plain "synced" status
            created_here = bool(p.get("erp_name"))
            self._mark(p, "synced", None if created_here else "duplicate",
                       None if created_here else short, log_type=log_type,
                       attempts=p["attempts"] + 1)
            self._bump(run, task, "skipped")
            return
        if kind in ("unknown_employee", "inactive_employee"):
            run.erp_streak = 0
            action = settings.get("unknown_employee_action" if kind == "unknown_employee"
                                  else "inactive_employee_action")
            if action == "skip":
                self._mark(p, "skipped", kind, short, log_type=log_type,
                           attempts=p["attempts"] + 1)
                self._bump(run, task, "skipped")
            else:
                outcome = self._retry_later(p, settings, kind, short)
                self._bump(run, task, "push_failed")
                if p["attempts"] == 0 or outcome == "failed":
                    log("WARNING", f"User ID {p['user_id']} at {p['ts']}: {short}. "
                                   + ("Gave up after the maximum attempts." if outcome == "failed"
                                      else "Will retry automatically."), text,
                        run_id=run.id, task_id=task["id"], device=name, employee=p["user_id"])
            return
        if kind == "validation":
            run.erp_streak = 0
            outcome = self._retry_later(p, settings, "validation", short)
            self._bump(run, task, "push_failed")
            log("WARNING" if outcome == "retry" else "ERROR",
                f"User ID {p['user_id']} at {p['ts']} was rejected by ERPNext: {short}"
                + (" Will retry automatically." if outcome == "retry" else " Gave up."), text,
                run_id=run.id, task_id=task["id"], device=name, employee=p["user_id"])
            return
        # ERPNext-level problems: the punch is not at fault
        self._erp_down(short)
        if kind in ("auth", "permission", "not_found_endpoint"):
            self._retry_later(p, settings, kind, short, count=False)
            self._block(run, short, text)
            return
        # network / server / rate limit: transient
        self._retry_later(p, settings, kind, short, count=(kind == "server"))
        self._bump(run, task, "push_failed")
        run.erp_streak += 1
        if run.erp_streak >= breaker:
            self._block(run, f"{short} ({run.erp_streak} errors in a row)", text)

    def _block(self, run: Run, reason: str, detail: str):
        with run.lock:
            if run.erp_blocked:
                return
            run.erp_blocked = reason
        bus.publish("run_erp_blocked", run_id=run.id, reason=reason)
        log("ERROR", f"Pushing to ERPNext paused for this run: {reason}. All punches are kept on "
                     "this PC and will be sent on the next run.", detail, run_id=run.id)

    def _erp_down(self, error: str):
        if not db.get_state("erp_down_since"):
            db.set_state("erp_down_since", db.now())
        db.set_state("erp_last_error", error)

    def _erp_up(self):
        if db.get_state("erp_down_since"):
            db.execute("DELETE FROM state WHERE key IN ('erp_down_since','erp_last_error')")

    # ---------------------------------------------------------------- safe clear

    def _safe_clear(self, run: Run, task: dict, device: dict, settings: dict, keys: list[tuple]):
        """Clear the machine's log only if every punch read is stored AND final in ERPNext, and
        no new punch arrived since it was read."""
        name = device["name"]
        if not keys:
            return
        not_final = 0
        chunk = 400
        for i in range(0, len(keys), chunk):
            part = keys[i:i + chunk]
            cond = " OR ".join("(user_id = ? AND ts = ?)" for _ in part)
            params = [x for k in part for x in k]
            final = db.scalar(f"SELECT COUNT(*) FROM punches WHERE device_pk = ? AND "
                              f"sync_status IN ('synced','skipped') AND ({cond})",
                              (device["id"], *params)) or 0
            not_final += len(part) - final
        # punches before the import start date are never stored: they are safe to clear only if
        # the user explicitly chose a start date, which means they are not wanted
        cfg = effective(device, settings)
        start = _parse_date(cfg.get("import_start_date"))
        if start:
            not_final -= sum(1 for _, ts in keys if _parse_ts(ts) < start)
        if not_final > 0:
            log("INFO", f"Machine log NOT cleared: {not_final} punch(es) are not yet confirmed in "
                        "ERPNext. It will be cleared after they are synced.",
                run_id=run.id, task_id=task["id"], device=name)
            return
        self._set(run, task, status="clearing", message="Clearing the machine log (all punches "
                                                        "are confirmed in ERPNext)…", force=True)
        try:
            with open_machine(device, settings) as m:
                with m.disabled(True):
                    count = m.record_count()
                    if count is None or count != len(keys):
                        log("INFO", "Machine log NOT cleared: new punches arrived while syncing. "
                                    "It will be cleared on a later run.",
                            run_id=run.id, task_id=task["id"], device=name)
                        return
                    m.clear_attendance()
            info = json.loads(db.scalar("SELECT last_info FROM devices WHERE id = ?",
                                        (device["id"],)) or "{}")
            info.update({"records": 0, "cleared_at": db.now()})
            db.update("devices", device["id"], last_info=json.dumps(info))
            self._set(run, task, cleared=1, force=True)
            log("SUCCESS", f"Machine log cleared ({len(keys):,} punch(es)). All of them are "
                           "stored on this PC and confirmed in ERPNext.",
                run_id=run.id, task_id=task["id"], device=name)
        except Exception as e:
            msg, detail, _ = explain(e)
            log("WARNING", f"Could not clear the machine log: {msg}", detail, run_id=run.id,
                task_id=task["id"], device=name)

    # ---------------------------------------------------------------- shift types

    def _sync_shifts(self, run: Run, settings: dict, erp: ERPNext):
        if run.erp_blocked:
            log("WARNING", "Shift Type 'Last Sync of Checkin' was not updated because pushing to "
                           "ERPNext is paused.", run_id=run.id)
            return
        offset = timedelta(minutes=int(settings.get("timestamp_offset_minutes") or 0))
        for m in settings.get("shift_mappings") or []:
            shifts = [s for s in m.get("shift_types") or [] if s]
            ids = [int(x) for x in m.get("device_ids") or []]
            if not shifts or not ids:
                continue
            marks = ",".join("?" * len(ids))
            devices = db.query(f"SELECT id, name, last_success_at FROM devices WHERE id IN "
                               f"({marks})", tuple(ids))
            blockers = []
            stamps = []
            for d in devices:
                if not d["last_success_at"]:
                    blockers.append(f"{d['name']} (never read)")
                    continue
                pend = db.scalar("SELECT COUNT(*) FROM punches WHERE device_pk = ? AND "
                                 "sync_status = 'pending' AND ts <= ?",
                                 (d["id"], d["last_success_at"].replace("T", " "))) or 0
                if pend:
                    blockers.append(f"{d['name']} ({pend} pending)")
                    continue
                stamps.append(datetime.fromisoformat(d["last_success_at"]))
            if blockers or len(devices) != len(ids):
                log("INFO", f"Shift Type(s) {', '.join(shifts)} not updated yet. Waiting for: "
                            f"{', '.join(blockers) or 'deleted machines'}.", run_id=run.id)
                continue
            mark = min(stamps) + offset
            for shift in shifts:
                key = f"shift_sync:{shift}"
                prev = db.get_state(key)
                if prev and datetime.fromisoformat(prev) >= mark:
                    continue
                try:
                    erp.update_shift_sync(shift, mark)
                    db.set_state(key, mark.isoformat(timespec="seconds"))
                    log("SUCCESS", f"Shift Type '{shift}': Last Sync of Checkin set to "
                                   f"{mark:%Y-%m-%d %H:%M:%S}.", run_id=run.id)
                except TaskError as e:
                    log("WARNING", e.message, e.detail, run_id=run.id)
                except Exception as e:
                    msg, detail, _ = explain(e, f"Shift Type '{shift}'")
                    log("WARNING", msg, detail, run_id=run.id)

    # ---------------------------------------------------------------- finish

    def _finish(self, run: Run, settings: dict):
        tasks = list(run.tasks.values())
        ok = sum(1 for t in tasks if t["status"] == "success")
        failed = sum(1 for t in tasks if t["status"] == "failed")
        if run.cancel.is_set():
            status = "cancelled"
        elif not tasks:
            status = "success"
        elif ok == len(tasks):
            status = "success"
        elif failed == len(tasks):
            status = "failed"
        else:
            status = "partial"
        tot = lambda k: sum(t[k] or 0 for t in tasks)  # noqa: E731
        pending = db.scalar("SELECT COUNT(*) FROM punches WHERE sync_status = 'pending'") or 0
        parts = []
        if run.mode == "full":
            parts.append(f"{sum(1 for t in tasks if t['fetch_status'] == 'done')}/{len(tasks)} "
                         "machine(s) read")
            parts.append(f"{tot('new_punches')} new punch(es)")
        parts.append(f"{tot('pushed')} sent to ERPNext")
        if tot("skipped"):
            parts.append(f"{tot('skipped')} skipped / already present")
        if pending:
            parts.append(f"{pending} waiting for retry")
        if run.erp_blocked:
            parts.append(f"ERPNext paused: {run.erp_blocked}")
        summary = " · ".join(parts)
        db.update("runs", run.id, status=status, finished_at=db.now(),
                  devices_ok=sum(1 for t in tasks if t["status"] in ("success", "partial")),
                  devices_failed=failed, fetched=tot("fetched"), new_punches=tot("new_punches"),
                  pushed=tot("pushed"), push_failed=tot("push_failed"), skipped=tot("skipped"),
                  pending_after=pending, summary=summary)
        with run.lock:
            run.finished = status
            run.summary = summary
            run.stage = "done"
        level = {"success": "SUCCESS", "partial": "WARNING", "cancelled": "WARNING"}.get(status,
                                                                                         "ERROR")
        log(level, f"Sync run #{run.id} finished ({status}): {summary}", run_id=run.id)
        bus.publish("run_finished", run_id=run.id, status=status, summary=summary)
        if settings.get("notify_desktop") and not (settings.get("notify_only_failures")
                                                    and status == "success"):
            title = {"success": "Attendance synced", "partial": "Attendance sync: some problems",
                     "failed": "Attendance sync failed", "cancelled": "Attendance sync cancelled"}
            desktop_notify(title.get(status, "Attendance sync"), summary)


engine = Engine()
