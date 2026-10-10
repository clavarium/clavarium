#!/bin/bash
# ---------------------------------------------------------------------------
# INSTALLS CLAVARIUM ON THIS MACHINE. One command, parameters only: it asks
# nothing, and can be run again to upgrade.
#
#   sudo deploy/install.sh --domain clav.example.com --operator you@example.com --core-only
#
#   --domain NAME      the address people will use (https://NAME)
#   --operator EMAIL   who may use it; repeat for several people
#   --port N           the loopback port of the server (default 7717)
#   --core-only        the server only: no authenticating edge in front. For a
#                      machine that has its own, and for tests. REQUIRED for
#                      now: the edge step is not written yet, and this script
#                      says so rather than leave a server open to no one.
#   --dry-run          check the parameters, say what would be done, do nothing
#
# WHAT IT SETS UP, and why it is safe to leave running:
#   - an account, "clavarium", that owns its data and NOTHING ELSE: no shell,
#     no password, not in any privileged group;
#   - the ONE program it may run as root (clavarium-host), named alone in the
#     rule that allows it. Everything that needs root goes through it;
#   - the code in /opt/clavarium, owned by root: the server cannot rewrite
#     itself;
#   - the data in /var/lib/clavarium; the directories whose content gets
#     mounted into VMs belong to root (see clavarium-host);
#   - the key of the vault APART from the data (/var/lib/clavarium-vault): a
#     copy of the data alone does not open the secrets.
#
# Exit codes: 0 done; 64 bad parameters; 78 this machine is refused.
# ---------------------------------------------------------------------------
set -euo pipefail

SUPPORTED="24.04 26.04"
ACCOUNT="clavarium"
CODE="/opt/clavarium"
DATA="/var/lib/clavarium"
VAULT="/var/lib/clavarium-vault"
ETC="/etc/clavarium"
HOST_PROGRAM="/usr/local/sbin/clavarium-host"
UNIT="/etc/systemd/system/clavarium.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bad() { echo "install: $*" >&2; echo "usage: install.sh --domain NAME --operator EMAIL [--operator EMAIL...] [--port N] --core-only [--dry-run]" >&2; exit 64; }
refuse() { echo "install: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

DOMAIN=""; OPERATORS=""; PORT="7717"; CORE_ONLY="no"; DRY="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:-}"; shift 2 || bad "--domain needs a value" ;;
        --operator) [ -n "${2:-}" ] || bad "--operator needs a value"; OPERATORS="${OPERATORS:+$OPERATORS,}$2"; shift 2 ;;
        --port) PORT="${2:-}"; shift 2 || bad "--port needs a value" ;;
        --core-only) CORE_ONLY="yes"; shift ;;
        --dry-run) DRY="yes"; shift ;;
        *) bad "unknown parameter: $1" ;;
    esac
done

# Every value ends up in a unit file and on a command line: checked here.
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$ ]] || bad "--domain is a host name, lower case, like clav.example.com"
[ -n "$OPERATORS" ] || bad "at least one --operator is needed: without one, nobody could come in"
IFS=',' read -r -a each <<< "$OPERATORS"
for operator in "${each[@]}"; do
    [[ "$operator" =~ ^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$ ]] || bad "--operator is an e-mail address, lower case: $operator"
done
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || bad "--port is a number from 1024 to 65535"
[ "$CORE_ONLY" = "yes" ] || bad "the edge step (sign-in in front of the server) is not written yet: add --core-only, and put your own authenticating proxy in front"

# The Node.js the server runs on: the same pinned version, with the same
# checksum, as the one put in the VMs. One place says which (server/tools.mjs).
NODE_VERSION="$(sed -n "s/^export const NODE_VERSION = '\(v[0-9.]*\)';$/\1/p" "$HERE/server/tools.mjs")"
NODE_SHA256="$(sed -n "s/^export const NODE_SHA256 = '\([0-9a-f]\{64\}\)';$/\1/p" "$HERE/server/tools.mjs")"
[ -n "$NODE_VERSION" ] && [ -n "$NODE_SHA256" ] || refuse "the pinned Node.js version was not found in $HERE/server/tools.mjs"

if [ "$DRY" = "yes" ]; then
    cat <<PLAN
would install Clavarium:
  address     https://$DOMAIN
  operators   $OPERATORS
  server      127.0.0.1:$PORT, as the account "$ACCOUNT", Node.js $NODE_VERSION
  code        $CODE (root)      data  $DATA      vault key  $VAULT
  root rule   $ACCOUNT may run $HOST_PROGRAM, and nothing else
  edge        none (--core-only)
PLAN
    exit 0
fi

[ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || refuse "this is ${PRETTY_NAME:-not Ubuntu}; Clavarium installs on Ubuntu Server $SUPPORTED"
case " $SUPPORTED " in *" ${VERSION_ID:-} "*) : ;; *) refuse "this is Ubuntu ${VERSION_ID:-?}; supported: $SUPPORTED" ;; esac
[ "$(uname -m)" = "x86_64" ] || refuse "this machine is $(uname -m); only x86_64 is supported"
grep -Eq '(vmx|svm)' /proc/cpuinfo || echo "install: WARNING: this processor does not show virtualisation: VMs may not start." >&2

step "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# bindfs: the read-only views. nftables: the network rules. build-essential
# and python3: one module of the server (the terminal) is compiled here.
apt-get install -y -qq bindfs nftables build-essential python3 curl ca-certificates xz-utils sudo snapd >/dev/null
snap list multipass >/dev/null 2>&1 || snap install multipass >/dev/null

step "account"
id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0750 "$DATA"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$VAULT"
# What gets mounted into VMs is arranged by root only: see clavarium-host.
install -d -o root -g root -m 0755 "$DATA/resources" "$DATA/views" "$DATA/removed"

step "code"
systemctl stop clavarium.service 2>/dev/null || true
install -d -o root -g root -m 0755 "$CODE"
rm -rf -- "$CODE/server" "$CODE/web" "$CODE/config"
cp -r "$HERE/server" "$HERE/web" "$HERE/config" "$HERE/package.json" "$HERE/package-lock.json" "$CODE/"
if [ ! -x "$CODE/node/bin/node" ] || [ "$("$CODE/node/bin/node" --version)" != "$NODE_VERSION" ]; then
    archive="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 -o "$archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
    echo "$NODE_SHA256  $archive" | sha256sum -c - >/dev/null || refuse "the Node.js archive does not have the expected checksum"
    rm -rf -- "$CODE/node"; install -d "$CODE/node"
    tar -xJf "$archive" -C "$CODE/node" --strip-components=1 --no-same-owner
    rm -f -- "$archive"
fi
(cd "$CODE" && PATH="$CODE/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
[ -f "$CODE/node_modules/node-pty/build/Release/pty.node" ] || refuse "the terminal module was not built (see: cd $CODE && npm ci)"
chown -R root:root "$CODE"

step "the one privileged program"
install -o root -g root -m 0755 "$HERE/deploy/clavarium-host" "$HOST_PROGRAM"
install -d -o root -g root -m 0755 "$ETC"
printf 'DATA=%s\n' "$DATA" > "$ETC/host.conf"; chmod 0644 "$ETC/host.conf"
rule="$(mktemp)"
printf '# Clavarium: the server account may run ONE program as root, and nothing else.\n%s ALL=(root) NOPASSWD: %s\n' "$ACCOUNT" "$HOST_PROGRAM" > "$rule"
visudo -cf "$rule" >/dev/null || refuse "the sudo rule did not pass its check"
install -o root -g root -m 0440 "$rule" /etc/sudoers.d/clavarium; rm -f -- "$rule"
# Settings that are not parameters (the speech-to-text endpoint): kept across upgrades.
[ -e "$ETC/server.env" ] || install -o root -g root -m 0600 /dev/null "$ETC/server.env"

step "service"
# NO private mount namespace here (PrivateTmp, ProtectHome, ProtectSystem...):
# the read-only views are mounts made on behalf of this service, and the VM
# manager must see them. In a private namespace it would see empty folders.
cat > "$UNIT" <<UNITFILE
[Unit]
Description=Clavarium - conversations as VMs
After=network-online.target snap.multipass.multipassd.service
Wants=network-online.target

[Service]
User=$ACCOUNT
Group=$ACCOUNT
WorkingDirectory=$CODE
EnvironmentFile=$ETC/server.env
ExecStart=$CODE/node/bin/node server/main.mjs --host "sudo -n $HOST_PROGRAM" --data $DATA --vault-key $VAULT/vault.key --port $PORT --operators $OPERATORS --public-origin https://$DOMAIN
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITFILE
systemctl daemon-reload
systemctl enable --quiet clavarium.service
systemctl restart clavarium.service

step "checks"
for _ in $(seq 1 20); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" && break
    sleep 1
done
systemctl is-active --quiet clavarium.service || refuse "the service did not stay up: journalctl -u clavarium"
curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/" || refuse "the server does not answer on 127.0.0.1:$PORT"
sudo -u "$ACCOUNT" sudo -n -l "$HOST_PROGRAM" >/dev/null || refuse "the account cannot reach its one program"
if sudo -u "$ACCOUNT" sudo -n -l /bin/sh >/dev/null 2>&1; then refuse "the account can run more than its one program as root"; fi

echo "Clavarium is installed: 127.0.0.1:$PORT, for $OPERATORS."
echo "It answers nobody yet: put an authenticating proxy in front, for https://$DOMAIN."
