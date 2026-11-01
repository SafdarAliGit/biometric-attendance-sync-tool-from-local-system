"""Desktop-shortcut launcher: make sure the service is running, optionally trigger a
sync run (Settings → "Sync when opened from the shortcut"), and open the GUI."""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from app.config import (DEFAULT_PORT, IS_WINDOWS, SERVICE_NAME, WINDOWS_TASK_NAME,  # noqa: E402
                        read_runtime)


def port() -> int:
    rt = read_runtime()
    if rt.get("port"):
        return int(rt["port"])
    try:
        from app import db
        db.init_db()
        return int(db.get_setting("port"))
    except Exception:
        return DEFAULT_PORT


def healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _quiet(cmd) -> int:
    kw = {"creationflags": 0x08000000} if IS_WINDOWS else {}
    try:
        return subprocess.run(cmd, capture_output=True, timeout=30, **kw).returncode
    except Exception:
        return 1


def start_server():
    if IS_WINDOWS:
        if _quiet(["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME]) == 0:
            return
        if _quiet(["sc", "start", WINDOWS_TASK_NAME]) == 0:
            return
        exe = Path(sys.executable)
        pythonw = exe.with_name("pythonw.exe")
        subprocess.Popen([str(pythonw if pythonw.exists() else exe), str(BASE / "run.py")],
                         cwd=str(BASE), creationflags=0x00000008 | 0x00000200 | 0x08000000)
        return
    if shutil.which("systemctl"):
        if _quiet(["systemctl", "--user", "cat", SERVICE_NAME]) == 0:
            if _quiet(["systemctl", "--user", "start", SERVICE_NAME]) == 0:
                return
        elif _quiet(["systemctl", "cat", SERVICE_NAME]) == 0:
            # system service: may need privileges; fall through to a direct start if it fails
            if _quiet(["systemctl", "start", SERVICE_NAME]) == 0:
                return
    subprocess.Popen([sys.executable, str(BASE / "run.py")], cwd=str(BASE),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


def show_error(msg: str):
    print(msg, file=sys.stderr)
    try:
        if IS_WINDOWS:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, msg, "Biometric Attendance Sync", 0x10)
        elif shutil.which("zenity"):
            subprocess.run(["zenity", "--error", "--title=Biometric Attendance Sync", f"--text={msg}"])
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", "Biometric Attendance Sync", msg])
    except Exception:
        pass


def main():
    url = f"http://127.0.0.1:{port()}"
    if not healthy(url):
        start_server()
        for _ in range(60):
            time.sleep(0.5)
            if healthy(url):
                break
        else:
            show_error("The attendance sync service did not start. Check data/logs/app.log, or run "
                       "'python run.py' in a terminal to see the error.")
            return 1
    target = url + "/"
    no_run = "--no-run" in sys.argv
    if not no_run:
        token = read_runtime().get("launch_token", "")
        try:
            req = urllib.request.Request(url + "/api/launch", method="POST", data=b"{}",
                                         headers={"X-Launch-Token": token,
                                                  "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                if json.loads(r.read() or b"{}").get("started"):
                    target = url + "/#/progress"
        except Exception:
            pass
    if "--no-browser" not in sys.argv:
        webbrowser.open(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
