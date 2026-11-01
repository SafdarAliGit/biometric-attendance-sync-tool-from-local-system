#!/usr/bin/env bash
# Biometric Attendance Sync - Linux installer
#   ./install.sh               install as a systemd *user* service (default, recommended)
#   ./install.sh --system      install as a system-wide systemd service (uses sudo)
#   ./install.sh --no-service  only create the venv and shortcuts
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=biometric-attendance-sync
MODE=user
for arg in "$@"; do
  case "$arg" in
    --system) MODE=system ;;
    --no-service) MODE=none ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

# ---- Python ----
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then PY="$c"; break; fi
done
[ -z "$PY" ] && { echo "Python 3.10+ is required (e.g. sudo apt install python3 python3-venv)."; exit 1; }
say "Using $($PY --version)"

if [ ! -x "$APP_DIR/.venv/bin/python" ]; then
  say "Creating virtual environment"
  "$PY" -m venv "$APP_DIR/.venv" || { echo "Creating the venv failed. Try: sudo apt install python3-venv"; exit 1; }
fi
say "Installing dependencies"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" -q
mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

# ---- service ----
UNIT="[Unit]
Description=Biometric Attendance Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python $APP_DIR/run.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1"

if [ "$MODE" = user ]; then
  say "Installing systemd user service"
  mkdir -p "$HOME/.config/systemd/user"
  printf '%s\n\n[Install]\nWantedBy=default.target\n' "$UNIT" > "$HOME/.config/systemd/user/$SERVICE.service"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  # start at boot even before login
  if ! loginctl enable-linger "$USER" 2>/dev/null; then
    sudo loginctl enable-linger "$USER" 2>/dev/null || warn "Could not enable lingering. The service will start when you log in. To start at boot run: sudo loginctl enable-linger $USER"
  fi
elif [ "$MODE" = system ]; then
  say "Installing systemd system service (sudo)"
  printf '%s\nUser=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$UNIT" "$USER" | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"
fi

# ---- shortcuts ----
say "Creating menu entry and desktop shortcut"
DESKTOP_FILE="[Desktop Entry]
Type=Application
Name=Biometric Attendance Sync
Comment=Sync biometric attendance machines to ERPNext
Exec=$APP_DIR/.venv/bin/python $APP_DIR/launcher.py
Icon=$APP_DIR/static/img/favicon.svg
Terminal=false
Categories=Office;Utility;"
mkdir -p "$HOME/.local/share/applications"
echo "$DESKTOP_FILE" > "$HOME/.local/share/applications/$SERVICE.desktop"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESK" ]; then
  echo "$DESKTOP_FILE" > "$DESK/$SERVICE.desktop"
  chmod +x "$DESK/$SERVICE.desktop"
  gio set "$DESK/$SERVICE.desktop" metadata::trusted true 2>/dev/null || true
fi
chmod +x "$APP_DIR/launcher.py" "$APP_DIR/run.py" 2>/dev/null || true

PORT=$("$APP_DIR/.venv/bin/python" -c "import sys; sys.path.insert(0,'$APP_DIR'); from app import db; db.init_db(); print(db.get_setting('port'))" 2>/dev/null || echo 8766)
echo
say "Done! Open http://127.0.0.1:$PORT or double-click 'Biometric Attendance Sync' on your desktop."
[ "$MODE" = none ] && echo "    Start manually with: $APP_DIR/.venv/bin/python $APP_DIR/run.py"
exit 0
