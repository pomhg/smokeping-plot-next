#!/usr/bin/env bash
# smokeping-plot-next installer / upgrader / uninstaller for systemd hosts.
#
#   sudo ./deploy/install.sh              # system service (recommended)
#   ./deploy/install.sh --user            # per-user service, no root needed
#   ./deploy/install.sh --binary ./bin/smokeping-plot-next
#   ./deploy/install.sh --version v0.2.0
#   ./deploy/install.sh --uninstall [--user]        # keeps data + config
#   ./deploy/install.sh --uninstall --purge [--user] # also deletes them
#
# Binary source, in order: --binary PATH, ./bin/smokeping-plot-next next to
# this repo, otherwise the GitHub release matching --version (default latest).
# Set GITHUB_TOKEN for private repositories.
set -euo pipefail

REPO="pomhg/smokeping-plot-next"
NAME="smokeping-plot-next"
MODE=""            # system | user
BINARY=""
VERSION="latest"
UNINSTALL=0
PURGE=0
PORT=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --system) MODE=system ;;
    --user) MODE=user ;;
    --binary) BINARY="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) not found; use docker compose or run the binary directly."

if [ -z "$MODE" ]; then
  if [ "$(id -u)" -eq 0 ]; then MODE=system; else MODE=user; fi
fi
if [ "$MODE" = system ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    log "system install needs root, re-running with sudo"
    exec sudo -E "$0" --system ${BINARY:+--binary "$BINARY"} --version "$VERSION" ${PORT:+--port "$PORT"} $([ "$UNINSTALL" = 1 ] && echo --uninstall) $([ "$PURGE" = 1 ] && echo --purge)
  fi
  die "system install needs root (or pass --user)"
fi

# ---------------------------------------------------------------- paths
if [ "$MODE" = system ]; then
  BIN_DIR=/usr/local/bin
  CONF_DIR=/etc/$NAME
  DATA_DIR=/var/lib/$NAME
  UNIT_DIR=/etc/systemd/system
  UNIT_REL=systemd/$NAME.service
  SYSTEMCTL="systemctl"
  JOURNALCTL="journalctl"
else
  BIN_DIR=$HOME/.local/bin
  CONF_DIR=$HOME/.config/$NAME
  DATA_DIR=$HOME/.local/share/$NAME
  UNIT_DIR=$HOME/.config/systemd/user
  UNIT_REL=systemd/$NAME.user.service
  SYSTEMCTL="systemctl --user"
  JOURNALCTL="journalctl --user"
fi
UNIT=$UNIT_DIR/$NAME.service

# When run via `curl | bash` the unit/env templates are not on disk; fetch
# them from the repository instead.
RAW_BASE="${SPN_RAW_BASE:-https://raw.githubusercontent.com/$REPO/main/deploy}"
TEMPLATE_TMP=""
need_template() {
  local rel="$1"
  local local_path="$SCRIPT_DIR/$rel"
  if [ -f "$local_path" ]; then echo "$local_path"; return; fi
  [ -n "$TEMPLATE_TMP" ] || TEMPLATE_TMP=$(mktemp -d)
  mkdir -p "$TEMPLATE_TMP/$(dirname "$rel")"
  curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} -o "$TEMPLATE_TMP/$rel" "$RAW_BASE/$rel" \
    || die "could not fetch $rel from $RAW_BASE (clone the repo and run deploy/install.sh from there)"
  echo "$TEMPLATE_TMP/$rel"
}

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  log "stopping and removing $NAME ($MODE)"
  $SYSTEMCTL disable --now $NAME 2>/dev/null || true
  rm -f "$UNIT" "$BIN_DIR/$NAME"
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL reset-failed $NAME 2>/dev/null || true
  if [ "$PURGE" = 1 ]; then
    rm -rf "$CONF_DIR" "$DATA_DIR"
    [ "$MODE" = system ] && rm -rf "/var/lib/private/$NAME"
    echo "Removed service, binary, config and data."
  else
    echo "Removed service and binary. Kept your data and config (add --purge to delete):"
    echo "  $DATA_DIR"
    echo "  $CONF_DIR"
  fi
  exit 0
fi

# ---------------------------------------------------------------- binary
fetch_release() {
  local os arch asset url tmp
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv6l) arch=armv7 ;;
    *) die "unsupported architecture $(uname -m); build from source with 'make build'" ;;
  esac
  asset="${NAME}_${os}_${arch}.tar.gz"
  if [ "$VERSION" = latest ]; then
    url="https://github.com/$REPO/releases/latest/download/$asset"
  else
    url="https://github.com/$REPO/releases/download/$VERSION/$asset"
  fi
  tmp=$(mktemp -d)
  log "downloading $url"
  if ! curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} -o "$tmp/$asset" "$url"; then
    die "download failed. For a private repo set GITHUB_TOKEN, or build locally: make build && sudo ./deploy/install.sh"
  fi
  tar -xzf "$tmp/$asset" -C "$tmp"
  BINARY=$(find "$tmp" -type f -name "$NAME" | head -1)
  [ -n "$BINARY" ] || die "archive did not contain $NAME"
  # the tarball ships deploy/ templates too; prefer them over network fetches
  local d; d=$(dirname "$BINARY")/deploy
  [ -d "$d" ] && SCRIPT_DIR="$d"
}

if [ -z "$BINARY" ]; then
  # extracted release tarball: <dir>/smokeping-plot-next next to <dir>/deploy/
  # source checkout after `make build`: <repo>/bin/smokeping-plot-next
  for cand in "$REPO_DIR/$NAME" "$REPO_DIR/bin/$NAME"; do
    if [ -x "$cand" ]; then
      BINARY="$cand"
      log "using local binary $BINARY"
      break
    fi
  done
  [ -n "$BINARY" ] || fetch_release
fi
[ -x "$BINARY" ] || die "binary not found or not executable: $BINARY"

# ---------------------------------------------------------------- install
log "installing binary to $BIN_DIR/$NAME"
mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR"
# system mode: systemd's StateDirectory= creates and owns the data dir
[ "$MODE" = system ] || mkdir -p "$DATA_DIR"
install -m 0755 "$BINARY" "$BIN_DIR/$NAME.new"
mv -f "$BIN_DIR/$NAME.new" "$BIN_DIR/$NAME"

if [ ! -f "$CONF_DIR/env" ]; then
  log "writing default config to $CONF_DIR/env"
  install -m 0644 "$(need_template env.example)" "$CONF_DIR/env"
fi
if [ -n "$PORT" ]; then
  sed -i.bak "s/^LISTEN=.*/LISTEN=:$PORT/" "$CONF_DIR/env" && rm -f "$CONF_DIR/env.bak"
fi

log "installing unit $UNIT"
install -m 0644 "$(need_template "$UNIT_REL")" "$UNIT"

# ---------------------------------------------------------------- ICMP for user mode
if [ "$MODE" = user ] && [ "$(uname -s)" = Linux ]; then
  range=$(cat /proc/sys/net/ipv4/ping_group_range 2>/dev/null || echo "1 0")
  read -r lo hi <<<"$range"
  gid=$(id -g)
  if [ "$gid" -lt "${lo:-1}" ] || [ "$gid" -gt "${hi:-0}" ]; then
    if command -v sudo >/dev/null 2>&1 && command -v setcap >/dev/null 2>&1; then
      log "granting CAP_NET_RAW to the binary so ICMP works without root (sudo may prompt)"
      if ! sudo setcap cap_net_raw+ep "$BIN_DIR/$NAME"; then
        warn "setcap failed; ICMP probes will not work until you run one of:"
        warn "  sudo setcap cap_net_raw+ep $BIN_DIR/$NAME"
        warn "  sudo sysctl -w net.ipv4.ping_group_range=\"0 2147483647\""
      fi
    else
      warn "unprivileged ICMP is disabled on this host (ping_group_range=$range)."
      warn "Ask an admin to run: sudo setcap cap_net_raw+ep $BIN_DIR/$NAME"
    fi
  fi
fi

# ---------------------------------------------------------------- start
$SYSTEMCTL daemon-reload
log "enabling and (re)starting service"
$SYSTEMCTL enable $NAME >/dev/null 2>&1 || true
$SYSTEMCTL restart $NAME

if [ "$MODE" = user ]; then
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      || warn "could not enable linger; the service will stop when you log out (sudo loginctl enable-linger $(id -un))"
  fi
fi

sleep 1
if ! $SYSTEMCTL is-active --quiet $NAME; then
  $SYSTEMCTL status $NAME --no-pager || true
  die "service failed to start; see: $JOURNALCTL -u $NAME -e"
fi

# ---------------------------------------------------------------- done
port=$(grep -E '^LISTEN=' "$CONF_DIR/env" 2>/dev/null | tail -1 | sed 's/.*://')
port=${port:-8080}
echo
log "$NAME is running ($MODE service)"
echo "  Open:    http://$(hostname):$port/"
if command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null || true); do echo "           http://$ip:$port/"; done
fi
echo "  Config:  $CONF_DIR/env"
echo "  Data:    $DATA_DIR"
echo "  Logs:    $JOURNALCTL -u $NAME -f"
echo "  Manage:  $SYSTEMCTL {status|restart|stop} $NAME"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  Firewall: sudo ufw allow $port/tcp"
elif command -v firewall-cmd >/dev/null 2>&1; then
  echo "  Firewall: sudo firewall-cmd --permanent --add-port=$port/tcp && sudo firewall-cmd --reload"
fi
