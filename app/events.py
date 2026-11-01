"""Thread-safe event bus to push live updates to WebSocket clients, plus the activity log."""
import asyncio
import logging
from logging.handlers import RotatingFileHandler

from . import db
from .config import LOG_DIR, ensure_dirs

ensure_dirs()
logger = logging.getLogger("bas")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    _h = RotatingFileHandler(LOG_DIR / "app.log", maxBytes=5 * 1024 * 1024, backupCount=5,
                             encoding="utf-8")
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(_h)
    _c = logging.StreamHandler()
    _c.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(_c)


class Bus:
    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queues: set[asyncio.Queue] = set()

    def attach(self, loop):
        self.loop = loop

    def subscribe(self) -> asyncio.Queue:
        qu = asyncio.Queue(maxsize=2000)
        self.queues.add(qu)
        return qu

    def unsubscribe(self, qu):
        self.queues.discard(qu)

    def _put(self, msg):
        for qu in list(self.queues):
            try:
                qu.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    def publish(self, msg_type: str, **data):
        if not self.loop or self.loop.is_closed():
            return
        msg = {"type": msg_type, **data}
        try:
            self.loop.call_soon_threadsafe(self._put, msg)
        except RuntimeError:
            pass


bus = Bus()


def log(level: str, message: str, detail: str = "", run_id=None, task_id=None,
        device: str | None = None, employee: str | None = None):
    level = level.upper()
    getattr(logger, level.lower() if level != "SUCCESS" else "info")(
        " ".join(x for x in [f"[{device}]" if device else "", f"[{employee}]" if employee else "",
                             message] if x))
    try:
        row_id = db.execute(
            "INSERT INTO logs (ts, level, run_id, task_id, device, employee, message, detail) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (db.now(), level, run_id, task_id, device, employee, message, detail or ""))
    except Exception as e:  # never let logging break a sync
        logger.error("could not write log row: %s", e)
        return
    bus.publish("log", log={"id": row_id, "ts": db.now(), "level": level, "run_id": run_id,
                            "task_id": task_id, "device": device, "employee": employee,
                            "message": message, "detail": detail or ""})
