@echo off
rem Double-click to remove the Biometric Attendance Sync service and shortcuts (data is kept).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
pause
