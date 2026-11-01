"""Start the Biometric Attendance Sync server (used by the service / startup task)."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402

from app import db  # noqa: E402
from app.config import DEFAULT_HOST, LAN_HOST, read_runtime, write_runtime  # noqa: E402


def main():
    db.init_db()
    default_host = LAN_HOST if db.get_setting("lan_access") else DEFAULT_HOST
    host = os.environ.get("BAS_HOST", default_host)
    port = int(os.environ.get("BAS_PORT") or db.get_setting("port"))
    rt = read_runtime()
    rt.update({"host": host, "port": port})
    write_runtime(rt)
    # pythonw (Windows, no console) has no stdout/stderr
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")
    uvicorn.run("app.main:app", host=host, port=port, log_level="warning", ws="auto")


if __name__ == "__main__":
    main()
