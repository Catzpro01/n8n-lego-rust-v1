#!/usr/bin/env bash
# n8n lego — tarball installer for a Linux VPS (Ubuntu 22.04+/Debian 12+).
#
#   tar -xzf n8n-lego-<version>.tar.gz && cd n8n-lego-<version>
#   sudo bash install.sh [options]
#
#   --dir <path>       install directory (default /opt/n8n-lego)
#   --user <name>      service account (default n8n-lego, created if missing)
#   --data-dir <path>  data directory (default /var/lib/n8n-lego)
#   --port <port>      listen port (default 5678)
#   --systemd          install and enable the systemd service
#   --no-systemd       install the files only
#   --no-catalog       skip fetching the node catalog (offline install)
#   --uninstall        stop the service and remove the install tree (keeps data)
#   -h, --help
#
# Idempotent: re-running upgrades the files in place and keeps your data.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="/opt/n8n-lego"
SERVICE_USER="n8n-lego"
DATA_DIR="/var/lib/n8n-lego"
PORT="5678"
WITH_SYSTEMD="ask"
FETCH_CATALOG=1
UNINSTALL=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?}"; shift ;;
    --user) SERVICE_USER="${2:?}"; shift ;;
    --data-dir) DATA_DIR="${2:?}"; shift ;;
    --port) PORT="${2:?}"; shift ;;
    --systemd) WITH_SYSTEMD="yes" ;;
    --no-systemd) WITH_SYSTEMD="no" ;;
    --no-catalog) FETCH_CATALOG=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
  shift
done

say()  { printf '\033[1mn8n-lego:\033[0m %s\n' "$*"; }
warn() { printf '\033[33mn8n-lego:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mn8n-lego:\033[0m %s\n' "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" = "0" ] || die "run as root: sudo bash install.sh $*"; }

if [ "$UNINSTALL" = "1" ]; then
  require_root --uninstall
  systemctl stop n8n-lego 2>/dev/null || true
  systemctl disable n8n-lego 2>/dev/null || true
  rm -f /etc/systemd/system/n8n-lego.service
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  say "removed $INSTALL_DIR (data kept in $DATA_DIR)"
  exit 0
fi

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null 2>&1 || die "node is not installed — install Node.js 22 LTS first (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  die "Node.js >= 22.18 required, found $(node -v)"
fi
say "node $(node -v) detected"

[ -f "$SRC_DIR/bin/n8n-lego.mjs" ] || die "install.sh must run from the extracted tarball directory"

# ---------------------------------------------------------------------- install
say "installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
for item in bin src scripts data vendor package.json package-lock.json README.md LICENSE.md; do
  [ -e "$SRC_DIR/$item" ] || continue
  rm -rf "${INSTALL_DIR:?}/$item"
  cp -R "$SRC_DIR/$item" "$INSTALL_DIR/"
done

# The editor UI is vendored in the tarball; npm re-resolves it when it is not.
if [ ! -d "$INSTALL_DIR/node_modules/n8n-editor-ui" ]; then
  if command -v npm >/dev/null 2>&1; then
    say "installing the editor UI bundle (npm install --omit=dev)"
    ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null )
  else
    warn "npm not found and node_modules is missing — the editor UI will not be served"
  fi
fi

# --------------------------------------------------------------------- data dir
SERVICE_HOME="/home/$SERVICE_USER"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if [ "$WITH_SYSTEMD" = "no" ]; then
    warn "user $SERVICE_USER does not exist — install with --systemd to create it"
  else
    say "creating service account $SERVICE_USER"
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd --system --create-home "$SERVICE_USER"
  fi
fi

mkdir -p "$DATA_DIR"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" 2>/dev/null || true
fi
chmod 750 "$DATA_DIR"

# ----------------------------------------------------------------------- catalog
if [ "$FETCH_CATALOG" = "1" ]; then
  say "fetching the node catalog (n8n-nodes-base + icons) into $DATA_DIR"
  if [ "$(id -u)" = "0" ] && id "$SERVICE_USER" >/dev/null 2>&1; then
    sudo -u "$SERVICE_USER" env N8N_LEGO_USER_FOLDER="$DATA_DIR" \
      node "$INSTALL_DIR/bin/n8n-lego.mjs" catalog || warn "catalog fetch failed — run it later: n8n-lego catalog"
  else
    N8N_LEGO_USER_FOLDER="$DATA_DIR" node "$INSTALL_DIR/bin/n8n-lego.mjs" catalog \
      || warn "catalog fetch failed — run it later: n8n-lego catalog"
  fi
else
  warn "skipping the catalog fetch (--no-catalog) — the palette stays empty until you run: n8n-lego catalog"
fi

# ----------------------------------------------------------------------- systemd
if [ "$WITH_SYSTEMD" = "ask" ]; then
  if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then WITH_SYSTEMD="yes"; else WITH_SYSTEMD="no"; fi
fi

if [ "$WITH_SYSTEMD" = "yes" ]; then
  require_root --systemd
  UNIT_SRC="$INSTALL_DIR/systemd/n8n-lego.service"
  [ -f "$UNIT_SRC" ] || die "systemd unit template missing: $UNIT_SRC"
  say "installing systemd unit (/etc/systemd/system/n8n-lego.service)"
  sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__USER__|$SERVICE_USER|g" \
      -e "s|__PORT__|$PORT|g" \
      "$UNIT_SRC" > /etc/systemd/system/n8n-lego.service
  systemctl daemon-reload
  systemctl enable n8n-lego >/dev/null
  systemctl restart n8n-lego
  # Poll at 1s cadence (docs/engineering-operations/RUNNER-PROTOCOL.md), bounded budget.
  for _ in 1 2 3 4 5; do
    systemctl is-active --quiet n8n-lego && break
    sleep 1
  done
  if systemctl is-active --quiet n8n-lego; then
    say "service running — http://localhost:$PORT"
  else
    warn "service did not come up; check: journalctl -u n8n-lego -n 50"
  fi
else
  say "files installed (no systemd). Start it with:"
  printf '  N8N_LEGO_USER_FOLDER=%s N8N_LEGO_PORT=%s node %s/bin/n8n-lego.mjs start\n' "$DATA_DIR" "$PORT" "$INSTALL_DIR"
fi

# ------------------------------------------------------------------------ report
say "done"
printf '  install dir : %s\n  data dir    : %s\n  port        : %s\n  logs        : %s\n' \
  "$INSTALL_DIR" "$DATA_DIR" "$PORT" \
  "$([ "$WITH_SYSTEMD" = "yes" ] && echo 'journalctl -u n8n-lego -f' || echo "$DATA_DIR/../n8n-lego.log")"
printf '\nOpen http://<server-ip>:%s and create the owner account on first visit.\n' "$PORT"
