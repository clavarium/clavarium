#!/bin/bash
# ---------------------------------------------------------------------------
# INSTALLS CLAVARIUM ON THIS MACHINE. One command, parameters only: it asks
# nothing, and can be run again to upgrade.
#
#   sudo deploy/install.sh --domain clav.example.com --operator you@example.com
#
#   --domain NAME      the address people will use (https://NAME)
#   --operator EMAIL   who may use it; repeat for several people
#   --port N           the loopback port of the server (default 7717)
#   --relay HOST       this machine is at home, with no public address: it
#                      dials out to a relay (see relay.sh) and is reached
#                      through it. Nothing here then listens to the outside.
#   --relay-port N     the SSH port of the relay (default 22)
#   --core-only        the server only: no edge in front. For a machine that
#                      has its own authenticating proxy.
#   --local            TO TRY IT, on a machine of your own, with no domain: no
#                      edge, no sign-in, no name. The page answers on this
#                      machine only (http://127.0.0.1:PORT), and whoever can
#                      open a page on this machine is its operator. Not for a
#                      machine other people use. Takes no --domain, --operator
#                      or --relay.
#   --dry-run          check the parameters, say what would be done, do nothing
#
# WHAT IT SETS UP, and why it is safe to leave running:
#   - an account, "clavarium", that owns its data and NOTHING ELSE: no shell,
#     no password, not in any privileged group;
#   - the ONE program it may run as root (clavarium-host), named alone in the
#     rule that allows it. Everything that needs root goes through it;
#   - the code in /opt/clavarium, owned by root: the server cannot rewrite
#     itself;
#   - the data in /home/clavarium, the account's home; the directories whose
#     content gets mounted into VMs belong to root (see clavarium-host).
#     UNDER /home ON PURPOSE: the VM manager is confined and can only share
#     folders from there. Anywhere else, a folder "does not exist" for it
#     (found on a real machine: nothing could be attached from /var/lib);
#   - the key of the vault APART from the data (/var/lib/clavarium-vault): a
#     copy of the data alone does not open the secrets;
#   - THE EDGE, unless --core-only: the only thing that listens to the outside
#     (TLS), the sign-in in front of everything, and a small identity provider
#     that knows the operators. Each is a pinned release, checked against a
#     checksum written here, and runs as its own account. Every operator gets
#     a password made on this machine, SHOWN ONCE at the end.
#
# Exit codes: 0 done; 64 bad parameters; 78 this machine is refused.
# ---------------------------------------------------------------------------
set -euo pipefail

SUPPORTED="24.04 26.04"
ACCOUNT="clavarium"
CODE="/opt/clavarium"
DATA="/home/clavarium"
VAULT="/var/lib/clavarium-vault"
ETC="/etc/clavarium"
HOST_PROGRAM="/usr/local/sbin/clavarium-host"
UNIT="/etc/systemd/system/clavarium.service"
# The edge: exact releases, exact checksums (sha256 of what is downloaded).
CADDY_VERSION="2.11.4"
CADDY_SHA256="527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9"
PROXY_VERSION="v7.15.4"
PROXY_SHA256="4fbe902189aab713d9c0519b90a645032d4636ecb523dc36f5cc312d8ebef1e2"
# The identity provider publishes no archive, only a container image. What is
# fetched is the one layer of that image that holds the program, named by its
# checksum: no container tool is needed, and nothing else of the image is used.
DEX_VERSION="v2.45.1"
DEX_LAYER="680f1119fdbcdd7f0ad8985b2534ded871b08b5b77c40f337c38aebd062b59c2"
DEX_SHA256="217aa675738d1cbaf25fe8d7bc04cb00dbc60f91d8465b76b8d8af963d571337"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bad() { echo "install: $*" >&2; echo "usage: install.sh --domain NAME --operator EMAIL [--operator EMAIL...] [--port N] [--relay HOST [--relay-port N]] [--core-only] [--dry-run]" >&2; echo "   or: install.sh --local [--port N] [--dry-run]     to try it on this machine, with no domain" >&2; exit 64; }
refuse() { echo "install: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

DOMAIN=""; OPERATORS=""; PORT="7717"; CORE_ONLY="no"; DRY="no"; RELAY=""; RELAY_PORT="22"; LOCAL="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:-}"; shift 2 || bad "--domain needs a value" ;;
        --operator) [ -n "${2:-}" ] || bad "--operator needs a value"; OPERATORS="${OPERATORS:+$OPERATORS,}$2"; shift 2 ;;
        --port) PORT="${2:-}"; shift 2 || bad "--port needs a value" ;;
        --relay) RELAY="${2:-}"; [ -n "$RELAY" ] || bad "--relay needs a value"; shift 2 ;;
        --relay-port) RELAY_PORT="${2:-}"; shift 2 || bad "--relay-port needs a value" ;;
        --core-only) CORE_ONLY="yes"; shift ;;
        --local) LOCAL="yes"; shift ;;
        --dry-run) DRY="yes"; shift ;;
        *) bad "unknown parameter: $1" ;;
    esac
done

# Every value ends up in a unit file and on a command line: checked here.
if [ "$LOCAL" = "yes" ]; then
    # To try it: nothing of the outside is set up, so nothing of it is asked.
    [ -z "$DOMAIN" ] && [ -z "$OPERATORS" ] && [ -z "$RELAY" ] || bad "--local is this machine only: it takes no --domain, --operator or --relay"
    CORE_ONLY="yes"
else
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$ ]] || bad "--domain is a host name, lower case, like clav.example.com"
[ -n "$OPERATORS" ] || bad "at least one --operator is needed: without one, nobody could come in"
IFS=',' read -r -a each <<< "$OPERATORS"
for operator in "${each[@]}"; do
    [[ "$operator" =~ ^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$ ]] || bad "--operator is an e-mail address, lower case: $operator"
done
fi
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || bad "--port is a number from 1024 to 65535"
if [ -n "$RELAY" ]; then
    [[ "$RELAY" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$|^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || bad "--relay is the name or the address of the relay machine"
    [[ "$RELAY_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$RELAY_PORT" -ge 1 ] && [ "$RELAY_PORT" -le 65535 ] || bad "--relay-port is a port number"
    [ "$CORE_ONLY" = "no" ] || bad "--relay comes with the edge: it cannot go with --core-only"
fi

# The Node.js the server runs on: the same pinned version, with the same
# checksum, as the one put in the VMs. One place says which (server/tools.mjs).
NODE_VERSION="$(sed -n "s/^export const NODE_VERSION = '\(v[0-9.]*\)';$/\1/p" "$HERE/server/tools.mjs")"
NODE_SHA256="$(sed -n "s/^export const NODE_SHA256 = '\([0-9a-f]\{64\}\)';$/\1/p" "$HERE/server/tools.mjs")"
[ -n "$NODE_VERSION" ] && [ -n "$NODE_SHA256" ] || refuse "the pinned Node.js version was not found in $HERE/server/tools.mjs"

if [ "$DRY" = "yes" ]; then
    cat <<PLAN
would install Clavarium:
  address     $([ "$LOCAL" = "yes" ] && echo "http://127.0.0.1:$PORT, from this machine only (--local)" || echo "https://$DOMAIN")
  operators   $([ "$LOCAL" = "yes" ] && echo "whoever can open a page on this machine: no sign-in" || echo "$OPERATORS")
  server      127.0.0.1:$PORT, as the account "$ACCOUNT", Node.js $NODE_VERSION
  code        $CODE (root)      data  $DATA      vault key  $VAULT
  root rule   $ACCOUNT may run $HOST_PROGRAM, and nothing else
  edge        $([ "$LOCAL" = "yes" ] && echo "none (--local): no address in https, no sign-in" || [ "$CORE_ONLY" = "yes" ] && echo "none (--core-only)" || echo "caddy $CADDY_VERSION (TLS), oauth2-proxy $PROXY_VERSION (sign-in), dex $DEX_VERSION (who the operators are)")
  reached     $([ "$LOCAL" = "yes" ] && echo "from this machine only; from another one of yours, through ssh -L" || [ -n "$RELAY" ] && echo "through the relay $RELAY (this machine dials out; nothing here listens to the outside)" || echo "directly: ports 443 and 80 of this machine")
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
# Installing packages must not stop to ask which services to restart, nor fill the screen with it.
export NEEDRESTART_SUSPEND=1
apt-get update -qq
# bindfs: the read-only views. nftables: the network rules. build-essential
# and python3: one module of the server (the terminal) is compiled here.
apt-get install -y -qq bindfs nftables build-essential python3 curl ca-certificates xz-utils sudo snapd openssl git >/dev/null
snap list multipass >/dev/null 2>&1 || snap install multipass >/dev/null

step "account"
id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
[ "$(getent passwd "$ACCOUNT" | cut -d: -f6)" = "$DATA" ] || usermod --home "$DATA" "$ACCOUNT"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0750 "$DATA"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$VAULT"
# What gets mounted into VMs is arranged by root only: see clavarium-host.
install -d -o root -g root -m 0755 "$DATA/resources" "$DATA/views" "$DATA/removed" "$DATA/work" "$DATA/work-disks"

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
ExecStart=$CODE/node/bin/node server/main.mjs --host "sudo -n $HOST_PROGRAM" --data $DATA --vault-key $VAULT/vault.key --port $PORT$([ "$LOCAL" = "yes" ] || echo " --operators $OPERATORS --public-origin https://$DOMAIN")
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

if [ "$LOCAL" = "yes" ]; then
    echo "Clavarium is installed, to try it:   http://127.0.0.1:$PORT   (from this machine only)"
    echo "From another computer of yours:      ssh -L $PORT:127.0.0.1:$PORT <you>@<this machine>, then the same address there."
    echo "There is no sign-in: whoever can open a page on this machine is its operator."
    echo "For real use, run it again with --domain and --operator."
    exit 0
fi
if [ "$CORE_ONLY" = "yes" ]; then
    echo "Clavarium is installed: 127.0.0.1:$PORT, for $OPERATORS."
    echo "It answers nobody yet: put an authenticating proxy in front, for https://$DOMAIN."
    exit 0
fi

# ------------------------------- THE EDGE ---------------------------------
# Downloads one file and refuses it unless it has the expected checksum.
fetch() { # <url> <sha256> <destination> [extra curl arguments...]
    local url="$1" sum="$2" to="$3"; shift 3
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 "$@" -o "$to" "$url"
    echo "$sum  $to" | sha256sum -c - >/dev/null || refuse "not the expected checksum: $url"
}
account() { id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"; }

step "edge: programs"
work="$(mktemp -d)"
if [ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
    fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "$CADDY_SHA256" "$work/caddy.tgz"
    tar -xzf "$work/caddy.tgz" -C "$work" --no-same-owner caddy
    install -o root -g root -m 0755 "$work/caddy" /usr/local/bin/caddy
fi
if ! /usr/local/bin/oauth2-proxy --version 2>/dev/null | grep -q " $PROXY_VERSION "; then
    fetch "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/$PROXY_VERSION/oauth2-proxy-$PROXY_VERSION.linux-amd64.tar.gz" "$PROXY_SHA256" "$work/proxy.tgz"
    tar -xzf "$work/proxy.tgz" -C "$work" --no-same-owner --strip-components=1
    install -o root -g root -m 0755 "$work/oauth2-proxy" /usr/local/bin/oauth2-proxy
fi
if [ "$(sha256sum /usr/local/bin/dex 2>/dev/null | cut -d' ' -f1)" != "$DEX_SHA256" ]; then
    token="$(curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 'https://ghcr.io/token?scope=repository:dexidp/dex:pull' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [ -n "$token" ] || refuse "the registry gave no anonymous token for the identity provider"
    fetch "https://ghcr.io/v2/dexidp/dex/blobs/sha256:$DEX_LAYER" "$DEX_LAYER" "$work/dex.tgz" -H "Authorization: Bearer $token"
    tar -xzf "$work/dex.tgz" -C "$work" --no-same-owner usr/local/bin/dex
    echo "$DEX_SHA256  $work/usr/local/bin/dex" | sha256sum -c - >/dev/null || refuse "the identity provider is not the expected program"
    install -o root -g root -m 0755 "$work/usr/local/bin/dex" /usr/local/bin/dex
fi
rm -rf -- "$work"

step "edge: accounts and settings"
account caddy /var/lib/caddy; account dex /var/lib/dex; account oauth2-proxy /nonexistent
install -d -o caddy -g caddy -m 0700 /var/lib/caddy
install -d -o dex -g dex -m 0700 /var/lib/dex
install -d -o root -g root -m 0755 /etc/caddy /etc/oauth2-proxy
install -d -o root -g dex -m 0750 /etc/dex

# The identity file holds the operators and their passwords. It is written
# ONCE: running this script again keeps it, and the passwords with it.
PASSWORDS=""
if [ ! -e /etc/dex/config.yaml ]; then
    client_secret="$(openssl rand -hex 32)"
    cookie_secret="$(openssl rand -base64 32 | tr '+/' '-_')"
    identity="$(mktemp)"
    cat > "$identity" <<DEX
# Who may sign in to Clavarium on THIS machine. Written by install.sh.
issuer: https://$DOMAIN/dex
storage:
  type: sqlite3
  config:
    file: /var/lib/dex/dex.db
web:
  # Loopback only: the TLS front publishes it under /dex.
  http: 127.0.0.1:5556
oauth2:
  skipApprovalScreen: true
staticClients:
  - id: clavarium
    name: Clavarium
    secret: $client_secret
    redirectURIs:
      - https://$DOMAIN/oauth2/callback
enablePasswordDB: true
staticPasswords:
DEX
    for operator in "${each[@]}"; do
        password="$(openssl rand -base64 18 | tr '+/' '-_')"
        # On standard input: a password never sits on a command line.
        hash="$(printf '%s\n' "$password" | /usr/local/bin/caddy hash-password)"
        [[ "$hash" == \$2* ]] || refuse "the password could not be hashed"
        printf '  - email: "%s"\n    hash: "%s"\n    username: "%s"\n    userID: "%s"\n' \
            "$operator" "$hash" "${operator%%@*}" "$(cat /proc/sys/kernel/random/uuid)" >> "$identity"
        PASSWORDS="$PASSWORDS    $operator    $password"$'\n'
    done
    install -o root -g dex -m 0640 "$identity" /etc/dex/config.yaml; rm -f -- "$identity"

    # The sign-in proxy talks to the identity provider on the loopback, by
    # explicit addresses: it does not depend on this machine resolving its own
    # public name, nor on the certificate being issued yet.
    proxy="$(mktemp)"
    cat > "$proxy" <<PROXY
provider = "oidc"
client_id = "clavarium"
client_secret = "$client_secret"
cookie_secret = "$cookie_secret"
oidc_issuer_url = "https://$DOMAIN/dex"
skip_oidc_discovery = true
login_url = "https://$DOMAIN/dex/auth"
redeem_url = "http://127.0.0.1:5556/dex/token"
oidc_jwks_url = "http://127.0.0.1:5556/dex/keys"
redirect_url = "https://$DOMAIN/oauth2/callback"
# Who is an operator is decided by the identity file, and again by the server.
email_domains = ["*"]
cookie_secure = true
cookie_samesite = "lax"
set_xauthrequest = true
reverse_proxy = true
skip_provider_button = true
# The operators were chosen by whoever installed this: no "grant access" page.
approval_prompt = "auto"
http_address = "127.0.0.1:4180"
upstreams = ["http://127.0.0.1:$PORT/"]
# A paired device does not sign in: its own door (/c/) checks its key. The
# identity headers are stripped there, so nobody can claim to be an operator.
skip_auth_routes = ["^/c/"]
skip_auth_strip_headers = true
PROXY
    install -o root -g root -m 0600 "$proxy" /etc/oauth2-proxy/oauth2-proxy.cfg; rm -f -- "$proxy"
else
    echo "   the identity file exists: kept, with its operators and passwords."
    echo "   (to start again: remove /etc/dex/config.yaml and run this script again)"
    sed -i "s#^upstreams = .*#upstreams = [\"http://127.0.0.1:$PORT/\"]#" /etc/oauth2-proxy/oauth2-proxy.cfg
fi

# Behind a relay, the front listens on the loopback only: the tunnel is the
# one way in.
BIND=""; [ -z "$RELAY" ] || BIND="	bind 127.0.0.1"
cat > /etc/caddy/Caddyfile <<CADDY
# The only thing on this machine that takes what comes from the outside.
$DOMAIN {
$BIND
	tls {
		issuer acme {
			disable_tlsalpn_challenge
		}
		issuer internal
	}
	handle /dex/* {
		reverse_proxy 127.0.0.1:5556
	}
	handle {
		reverse_proxy 127.0.0.1:4180
	}
}
CADDY

step "edge: services"
cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
Description=Caddy - the TLS front of this machine
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
CADDYUNIT
cat > /etc/systemd/system/dex.service <<'DEXUNIT'
[Unit]
Description=Dex - who the operators of this machine are
After=network.target

[Service]
User=dex
ExecStart=/usr/local/bin/dex serve /etc/dex/config.yaml
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/dex
Restart=on-failure

[Install]
WantedBy=multi-user.target
DEXUNIT
cat > /etc/systemd/system/oauth2-proxy.service <<'PROXYUNIT'
[Unit]
Description=oauth2-proxy - the sign-in in front of Clavarium
After=network-online.target dex.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=oauth2-proxy
Group=oauth2-proxy
LoadCredential=oauth2-proxy.cfg:/etc/oauth2-proxy/oauth2-proxy.cfg
ExecStart=/usr/local/bin/oauth2-proxy --config %d/oauth2-proxy.cfg
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
PROXYUNIT
systemctl daemon-reload
systemctl enable --quiet caddy.service dex.service oauth2-proxy.service
systemctl restart dex.service caddy.service oauth2-proxy.service

step "edge: checks"
local_get() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" || true; }
for _ in $(seq 1 30); do
    [ "$(local_get /dex/.well-known/openid-configuration)" = "200" ] && [ "$(local_get /oauth2/sign_in)" = "200" ] && break
    sleep 2
done
for service in caddy dex oauth2-proxy; do
    systemctl is-active --quiet "$service.service" || refuse "$service did not stay up: journalctl -u $service"
done
[ "$(local_get /dex/.well-known/openid-configuration)" = "200" ] || refuse "the identity provider does not answer through the front"
# Not signed in: the server must be out of reach.
case "$(local_get /api/conversations)" in 302|401|403) : ;; *) refuse "the server answers somebody who has not signed in" ;; esac

# ------------------------------ THE TUNNEL --------------------------------
TUNNEL_KEY=""; RELAY_PRINT=""
if [ -n "$RELAY" ]; then
    step "tunnel to the relay"
    apt-get install -y -qq openssh-client >/dev/null
    account clavarium-tunnel /nonexistent
    install -d -o clavarium-tunnel -g clavarium-tunnel -m 0700 /var/lib/clavarium-tunnel
    # The private key is made here and never leaves this machine.
    [ -e /var/lib/clavarium-tunnel/key ] || sudo -u clavarium-tunnel ssh-keygen -q -t ed25519 -N '' -C clavarium-tunnel -f /var/lib/clavarium-tunnel/key
    # The relay's identity is taken once and then held: a different machine
    # answering later at the same address is refused.
    if [ ! -s /var/lib/clavarium-tunnel/known_hosts ]; then
        scanned="$(ssh-keyscan -T 15 -t ed25519 -p "$RELAY_PORT" "$RELAY" 2>/dev/null || true)"
        [ -n "$scanned" ] || refuse "the relay $RELAY does not answer on port $RELAY_PORT"
        printf '%s\n' "$scanned" > /var/lib/clavarium-tunnel/known_hosts
        chown clavarium-tunnel:clavarium-tunnel /var/lib/clavarium-tunnel/known_hosts
    fi
    cat > /etc/systemd/system/clavarium-tunnel.service <<TUNNEL
[Unit]
Description=Clavarium - the outgoing tunnel to the relay
After=network-online.target caddy.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=clavarium-tunnel
Group=clavarium-tunnel
# Only TLS (443) and the certificate challenge (80) are carried.
ExecStart=/usr/bin/ssh -N -T -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/var/lib/clavarium-tunnel/key -o UserKnownHostsFile=/var/lib/clavarium-tunnel/known_hosts -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R *:8443:127.0.0.1:443 -R *:8080:127.0.0.1:80 -p $RELAY_PORT clavarium-tunnel@$RELAY
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
TUNNEL
    systemctl daemon-reload
    systemctl enable --quiet clavarium-tunnel.service
    systemctl restart clavarium-tunnel.service
    TUNNEL_KEY="$(cat /var/lib/clavarium-tunnel/key.pub)"
    RELAY_PRINT="$(ssh-keygen -l -f /var/lib/clavarium-tunnel/known_hosts | cut -d' ' -f2 | head -1)"
fi

echo
echo "Clavarium is installed:   https://$DOMAIN"
if [ -n "$PASSWORDS" ]; then
    echo "Sign in with (shown ONCE, kept nowhere in clear):"
    printf '%s' "$PASSWORDS"
else
    echo "Operators and passwords: unchanged."
fi
if [ -n "$RELAY" ]; then
    echo
    echo "ON THE RELAY ($RELAY), run this one command; the tunnel then comes up by itself:"
    echo "    sudo deploy/relay.sh --key \"$TUNNEL_KEY\""
    echo "It will print this, and it must be the same:    $RELAY_PRINT"
    echo "The name $DOMAIN must lead to the relay."
else
    echo "The name $DOMAIN must lead to this machine (ports 443 and 80)."
fi
