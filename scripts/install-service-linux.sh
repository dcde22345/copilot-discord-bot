#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="copilot-discord-bot"
INSTALL_DIR="/opt/copilot-discord-bot"
APP_DIR="$INSTALL_DIR/app"
DATA_DIR="/var/lib/copilot-discord-bot"
ENV_FILE="/etc/copilot-discord-bot.env"
URLS="http://127.0.0.1:5000"
RUN_USER=""
REPOS_ROOT=""
COPILOT_CLI_PATH=""

usage() {
  cat <<EOF
Usage: sudo $0 --user <username> --repos-root <path> [options]

Options:
  --user <username>        User account to run the service as (recommended: your normal user).
  --repos-root <path>      Root folder containing repos (absolute path).
  --install-dir <path>     Install dir (default: $INSTALL_DIR)
  --data-dir <path>        Data dir (default: $DATA_DIR)
  --env-file <path>        Env file path (default: $ENV_FILE)
  --urls <urls>            ASP.NET urls (default: $URLS)
  --copilot-cli <path>     Optional explicit copilot CLI path

This script will:
- dotnet publish into the install dir
- create an env file (mode 600) with Bot__* vars
- install and enable a systemd service ($SERVICE_NAME)
EOF
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: run as root (sudo)." >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) RUN_USER="$2"; shift 2;;
    --repos-root) REPOS_ROOT="$2"; shift 2;;
    --install-dir) INSTALL_DIR="$2"; APP_DIR="$INSTALL_DIR/app"; shift 2;;
    --data-dir) DATA_DIR="$2"; shift 2;;
    --env-file) ENV_FILE="$2"; shift 2;;
    --urls) URLS="$2"; shift 2;;
    --copilot-cli) COPILOT_CLI_PATH="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

require_root

if [[ -z "$RUN_USER" ]]; then
  echo "ERROR: --user is required" >&2
  exit 1
fi
if [[ -z "$REPOS_ROOT" ]]; then
  echo "ERROR: --repos-root is required" >&2
  exit 1
fi

if ! command -v dotnet >/dev/null 2>&1; then
  echo "ERROR: dotnet not found. Install .NET 10 runtime/SDK first." >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PROJECT="$PROJECT_ROOT/src/CopilotDiscordBot/CopilotDiscordBot.csproj"

mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR"

echo "Publishing to $APP_DIR ..."
DOTNET_CLI_HOME="/tmp" dotnet publish "$APP_PROJECT" -c Release -o "$APP_DIR" >/dev/null

DLL="$APP_DIR/CopilotDiscordBot.dll"
if [[ ! -f "$DLL" ]]; then
  echo "ERROR: publish output missing: $DLL" >&2
  exit 1
fi

echo
echo "Creating env file: $ENV_FILE"
echo "(tokens are not echoed)"
read -r -s -p "Discord bot token: " DISCORD_TOKEN
echo
read -r -p "Owner Discord user id (0 to disable owner-only): " OWNER_ID
OWNER_ID="${OWNER_ID:-0}"
read -r -s -p "GH_TOKEN (optional, recommended for services): " GH_TOKEN
echo

umask 077
cat > "$ENV_FILE" <<EOF
# Copilot Discord Bot service environment
Bot__DiscordBotToken=$DISCORD_TOKEN
Bot__OwnerDiscordUserId=$OWNER_ID
Bot__ReposRoot=$REPOS_ROOT
Bot__DataDir=$DATA_DIR/data
EOF

if [[ -n "$COPILOT_CLI_PATH" ]]; then
  echo "Bot__CopilotCliPath=$COPILOT_CLI_PATH" >> "$ENV_FILE"
fi
if [[ -n "$GH_TOKEN" ]]; then
  echo "GH_TOKEN=$GH_TOKEN" >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
DOTNET_PATH="$(command -v dotnet)"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Copilot Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$DOTNET_PATH $DLL --urls $URLS
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME" >/dev/null

echo "Done. Check: systemctl status $SERVICE_NAME" 
echo "Health: $URLS/health"
