"""Query / toggle 'start with system' for the installed service or task."""
import shutil
import subprocess

from .config import IS_WINDOWS, SERVICE_NAME, WINDOWS_TASK_NAME


def _run(cmd: list[str]) -> tuple[int, str]:
    try:
        kw = {"creationflags": 0x08000000} if IS_WINDOWS else {}
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30, **kw)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:
        return 1, str(e)


def status() -> dict:
    if IS_WINDOWS:
        code, out = _run(["schtasks", "/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST"])
        if code == 0:
            return {"installed": True, "mechanism": "Scheduled task (at logon)",
                    "enabled": "Disabled" not in out, "can_toggle": True}
        code, out = _run(["sc", "qc", WINDOWS_TASK_NAME])
        if code == 0:
            return {"installed": True, "mechanism": "Windows service",
                    "enabled": "AUTO_START" in out, "can_toggle": True,
                    "note": "Changing a Windows service needs the app to run as administrator."}
        return {"installed": False, "mechanism": None, "enabled": False, "can_toggle": False,
                "note": "Run install.ps1 to install the startup task or service."}
    if not shutil.which("systemctl"):
        return {"installed": False, "mechanism": None, "enabled": False, "can_toggle": False,
                "note": "systemd was not found on this system."}
    code, out = _run(["systemctl", "--user", "is-enabled", SERVICE_NAME])
    if out in ("enabled", "disabled"):
        return {"installed": True, "mechanism": "systemd user service", "enabled": out == "enabled",
                "can_toggle": True}
    code, out = _run(["systemctl", "is-enabled", SERVICE_NAME])
    if out in ("enabled", "disabled"):
        return {"installed": True, "mechanism": "systemd system service",
                "enabled": out == "enabled", "can_toggle": False,
                "note": f"Use: sudo systemctl enable|disable {SERVICE_NAME}"}
    return {"installed": False, "mechanism": None, "enabled": False, "can_toggle": False,
            "note": "Run install.sh to install the service."}


def set_enabled(enabled: bool) -> tuple[bool, str]:
    st = status()
    if not st["installed"]:
        return False, st.get("note", "Not installed")
    if IS_WINDOWS:
        if st["mechanism"].startswith("Scheduled"):
            code, out = _run(["schtasks", "/Change", "/TN", WINDOWS_TASK_NAME,
                              "/ENABLE" if enabled else "/DISABLE"])
        else:
            code, out = _run(["sc", "config", WINDOWS_TASK_NAME, "start=",
                              "auto" if enabled else "demand"])
        return code == 0, out
    if st["mechanism"] == "systemd user service":
        code, out = _run(["systemctl", "--user", "enable" if enabled else "disable", SERVICE_NAME])
        return code == 0, out
    return False, st.get("note", "")
