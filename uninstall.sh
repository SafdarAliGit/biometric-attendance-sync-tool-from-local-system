#!/usr/bin/env bash
# Removes the service and shortcuts. The data/ folder is kept.
set -u
SERVICE=biometric-attendance-sync
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$HOME/.config/systemd/user/$SERVICE.service" ]; then
  systemctl --user disable --now "$SERVICE" 2>/dev/null
  rm -f "$HOME/.config/systemd/user/$SERVICE.service"
  systemctl --user daemon-reload
  echo "Removed user service."
fi
if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  sudo systemctl disable --now "$SERVICE"
  sudo rm -f "/etc/systemd/system/$SERVICE.service"
  sudo systemctl daemon-reload
  echo "Removed system service."
fi
rm -f "$HOME/.local/share/applications/$SERVICE.desktop"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$DESK/$SERVICE.desktop"
echo "Shortcuts removed. Your data in $APP_DIR/data was NOT deleted."
