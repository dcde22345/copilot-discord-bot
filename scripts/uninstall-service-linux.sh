#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="copilot-discord-bot"
ENV_FILE="/etc/copilot-discord-bot.env"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

usage() {
  cat <<EOF
Usage: sudo $0 [--remove-env] [--remove-service-file]

Stops + disables the systemd service.
EOF
}

REMOVE_ENV=0
REMOVE_SERVICE_FILE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove-env) REMOVE_ENV=1; shift;;
    --keep-service-file) REMOVE_SERVICE_FILE=0; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 1
fi

if systemctl list-unit-files | grep -q "^$SERVICE_NAME"; then
  systemctl stop "$SERVICE_NAME" || true
  systemctl disable "$SERVICE_NAME" || true
fi

if [[ $REMOVE_SERVICE_FILE -eq 1 && -f "$SERVICE_FILE" ]]; then
  rm -f "$SERVICE_FILE"
fi

systemctl daemon-reload

if [[ $REMOVE_ENV -eq 1 && -f "$ENV_FILE" ]]; then
  rm -f "$ENV_FILE"
fi

echo "Done."
