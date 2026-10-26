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
#   --version X.Y.Z    install exactly this version of the package "clavarium"
#                      from npm, checked (integrity, provenance from
#                      github.com/clavarium/clavarium, npm audit signatures).
#                      The default when this script comes from the package
#                      (npx clavarium install): its own version.
#   --from-dir DIR     FOR DEVELOPMENT: install the code of a working tree,
#                      as it is (not checked). The default when this script
#                      runs from a git working tree.
#   --updates MODE     auto (default): updates itself in the window below;
#                      asap: as soon as a version is out; ask: says so in
#                      Settings and waits; off. Changed later in Settings.
#   --update-window HH:MM-HH:MM   when "auto" may update (default 02:00-05:00)
#   --channel C        latest (default) or next (versions with a "-": tests)
#   --keep-release     keep the release that runs (change the settings only:
#                      what `clavarium online` does to go from local mode to
#                      server mode)
#   --relay-installed  the relay was set up already (by `clavarium online`):
#                      do not print the command to run on it
#   --name NAME        the name of this Clavarium, under its icon and in its
#                      tab (default: drawn from --domain); changed in Settings.
#                      Letters, digits, spaces, dots, hyphens: 30 at most
#   --client-id ID     the OAuth client id, seen in the open when a browser is
#                      sent to sign in. Default: a random string that tells
#                      nothing. Give one for a third party that connects here.
#                      Changed later: sudo clavarium client-id [ID]
#   --dry-run          check the parameters, say what would be done, do nothing
#
# AFTER --local, going online is one command: `sudo clavarium online --relay
# HOST --domain NAME` or `sudo clavarium online --port --domain NAME` (see
# deploy/online.mjs); `sudo clavarium key` shows the public keys again.
#
# RUN AGAIN on an installation, it installs the version asked for beside the
# one that runs and switches to it. An installation made before releases
# existed (code copied into /opt/clavarium) is moved to them; the old copy is
# removed only once the new one answers.
#
# WHAT IT SETS UP, and why it is safe to leave running:
#   - an account, "clavarium", that owns its data and NOTHING ELSE: no shell,
#     no password, not in any privileged group;
#   - the ONE program it may run as root (clavarium-host), named alone in the
#     rule that allows it. Everything that needs root goes through it;
#   - the code in /opt/clavarium, owned by root: the server cannot rewrite
#     itself. One folder per version (releases/<version>), the one that runs
#     named by a link (current); the last two are kept to go back to. A timer
#     looks for new versions and updates (deploy/updater.mjs), as --updates
#     and Settings say;
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
# What the machines are given -- the shared folders, their read-only views,
# the work folders and their disks, what was put aside: under /home too (the
# VM manager shares from there only), but on a chain of directories that ROOT
# owns from / down, so that the server cannot swap a path between a check and
# a mount (see clavarium-host, "held"). The server's own data stays in $DATA.
MNT="/home/clavarium-mnt"
VAULT="/var/lib/clavarium-vault"
# The git reader's sandbox: an empty root for it, and its one script.
RUNNER_ROOT="/var/lib/clavarium/runner-root"
GIT_READ="/usr/lib/clavarium/git-read"
ETC="/etc/clavarium"
HOST_PROGRAM="/usr/local/sbin/clavarium-host"
UNIT="/etc/systemd/system/clavarium.service"
UPDATE_CONF="$ETC/update.conf"
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

bad() { echo "install: $*" >&2; echo "usage: install.sh --domain NAME --operator EMAIL [--operator EMAIL...] [--port N] [--relay HOST [--relay-port N]] [--core-only] [--version X.Y.Z | --from-dir DIR] [--updates auto|asap|ask|off] [--update-window HH:MM-HH:MM] [--channel latest|next] [--name NAME] [--client-id ID] [--dry-run]" >&2; echo "   or: install.sh --local [--port N] [same options] [--dry-run]     to try it on this machine, with no domain" >&2; exit 64; }
refuse() { echo "install: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

DOMAIN=""; OPERATORS=""; PORT="7717"; CORE_ONLY="no"; DRY="no"; RELAY=""; RELAY_PORT="22"; LOCAL="no"; KEEP_RELEASE="no"; RELAY_INSTALLED="no"
VERSION=""; FROM_DIR=""; UPDATES=""; WINDOW=""; CHANNEL=""; APP_NAME=""; CLIENT_ID=""
while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="${2:-}"; shift 2 || bad "--domain needs a value" ;;
        --operator) [ -n "${2:-}" ] || bad "--operator needs a value"; OPERATORS="${OPERATORS:+$OPERATORS,}$2"; shift 2 ;;
        --port) PORT="${2:-}"; shift 2 || bad "--port needs a value" ;;
        --relay) RELAY="${2:-}"; [ -n "$RELAY" ] || bad "--relay needs a value"; shift 2 ;;
        --relay-port) RELAY_PORT="${2:-}"; shift 2 || bad "--relay-port needs a value" ;;
        --core-only) CORE_ONLY="yes"; shift ;;
        --local) LOCAL="yes"; shift ;;
        --version) VERSION="${2:-}"; [ -n "$VERSION" ] || bad "--version needs a value"; shift 2 ;;
        --from-dir) FROM_DIR="${2:-}"; [ -n "$FROM_DIR" ] || bad "--from-dir needs a value"; shift 2 ;;
        --updates) UPDATES="${2:-}"; shift 2 || bad "--updates needs a value" ;;
        --update-window) WINDOW="${2:-}"; shift 2 || bad "--update-window needs a value" ;;
        --channel) CHANNEL="${2:-}"; shift 2 || bad "--channel needs a value" ;;
        --keep-release) KEEP_RELEASE="yes"; shift ;;
        --relay-installed) RELAY_INSTALLED="yes"; shift ;;
        --name) APP_NAME="${2:-}"; [ -n "$APP_NAME" ] || bad "--name needs a value"; shift 2 ;;
        --client-id) CLIENT_ID="${2:-}"; [ -n "$CLIENT_ID" ] || bad "--client-id needs a value"; shift 2 ;;
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

# WHAT IS INSTALLED: an exact version from npm, or a working tree (development).
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || bad "--version is an exact version, like 1.2.3 or 1.3.0-next.1"
[ -z "$VERSION" ] || [ -z "$FROM_DIR" ] || bad "--version (from npm) or --from-dir (a working tree), not both"
if [ -n "$FROM_DIR" ]; then
    FROM_DIR="$(cd "$FROM_DIR" 2>/dev/null && pwd)" || bad "--from-dir is a folder that exists"
    [ -f "$FROM_DIR/server/main.mjs" ] && [ -f "$FROM_DIR/package-lock.json" ] || bad "--from-dir is a working tree of Clavarium (server/main.mjs, package-lock.json)"
fi
if [ -z "$VERSION" ] && [ -z "$FROM_DIR" ]; then
    if [ -e "$HERE/.git" ]; then FROM_DIR="$HERE"
    else VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$HERE/package.json" | head -1)"
        [[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || refuse "the version of this package was not found in $HERE/package.json: give --version"
    fi
fi
[ -z "$UPDATES" ] || [[ "$UPDATES" =~ ^(auto|asap|ask|off)$ ]] || bad "--updates is auto, asap, ask or off"
[ -z "$WINDOW" ] || { [[ "$WINDOW" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$ ]] && [ "${WINDOW%-*}" != "${WINDOW#*-}" ]; } || bad "--update-window is two times, like 02:00-05:00"
[ -z "$CHANNEL" ] || [[ "$CHANNEL" =~ ^(latest|next)$ ]] || bad "--channel is latest or next"
# It goes in the unit file, between quotes: plain characters only (any other is chosen in Settings).
[ -z "$APP_NAME" ] || [[ "$APP_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9\ ._-]{0,28}[A-Za-z0-9.])?$ ]] || bad "--name is letters, digits, spaces, dots and hyphens, 30 at most, like \"Home lab\""
# The OAuth client id, seen in the open when a browser is sent to sign in. Default:
# a random string, made below, that tells nothing. A value given here is for an
# installation that a particular third party connects to (deploy/oidc.mjs).
[ -z "$CLIENT_ID" ] || [[ "$CLIENT_ID" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$ ]] || bad "--client-id is letters, digits, dots, underscores and hyphens (no spaces), 64 at most"
# What the updates will be, as the settings file has them or as asked now.
had() { { sed -n "s/^$1=//p" "$UPDATE_CONF" 2>/dev/null || true; } | head -1; }
SHOW_MODE="${UPDATES:-$(had MODE)}"; SHOW_MODE="${SHOW_MODE:-auto}"
SHOW_WINDOW="${WINDOW:-$(had WINDOW)}"; SHOW_WINDOW="${SHOW_WINDOW:-02:00-05:00}"
case "$VERSION" in *-*) default_channel="next" ;; *) default_channel="latest" ;; esac
SHOW_CHANNEL="${CHANNEL:-$(had CHANNEL)}"; SHOW_CHANNEL="${SHOW_CHANNEL:-$default_channel}"

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
  name        $([ -n "$APP_NAME" ] && echo "$APP_NAME" || echo "drawn from the address; changed in Settings")
  sign-in id  $([ "$LOCAL" = "yes" ] && echo "none (--local): no sign-in" || [ -n "$CLIENT_ID" ] && echo "$CLIENT_ID (given)" || echo "a random string, made at install: tells nothing (sudo clavarium client-id to change)")
  server      127.0.0.1:$PORT, as the account "$ACCOUNT", Node.js $NODE_VERSION
  release     $([ "$KEEP_RELEASE" = "yes" ] && echo "the one that runs, kept (--keep-release)" || [ -n "$VERSION" ] && echo "clavarium@$VERSION from npm, checked (integrity, provenance from github.com/clavarium/clavarium, npm audit signatures)" || echo "the working tree $FROM_DIR, as it is (development: not checked)")
  updates     $(case "$SHOW_MODE" in auto) echo "automatic, between ${SHOW_WINDOW%-*} and ${SHOW_WINDOW#*-}" ;; asap) echo "as soon as a version is out" ;; ask) echo "said in Settings, done when you say" ;; off) echo "off" ;; esac), channel $SHOW_CHANNEL
  code        $CODE/releases/<version>, $CODE/current (root)      data  $DATA      folders  $MNT (root's chain)      vault key  $VAULT
  root rule   $ACCOUNT may run $HOST_PROGRAM, and nothing else
  edge        $([ "$LOCAL" = "yes" ] && echo "none (--local): no address in https, no sign-in" || [ "$CORE_ONLY" = "yes" ] && echo "none (--core-only)" || echo "caddy $CADDY_VERSION (TLS), oauth2-proxy $PROXY_VERSION (sign-in), dex $DEX_VERSION (who the operators are)")
  reached     $([ "$LOCAL" = "yes" ] && echo "from this machine only; from another one of yours, through ssh -L" || [ -n "$RELAY" ] && echo "through the relay $RELAY (this machine dials out; nothing here listens to the outside)" || echo "directly: ports 443 and 80 of this machine")
PLAN
    exit 0
fi

[ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
# /etc/os-release is read in a subshell: it defines VERSION, NAME and more, which
# would overwrite this script's own (VERSION is the Clavarium version asked for).
# shellcheck disable=SC1091
OS_ID="$(. /etc/os-release 2>/dev/null; printf '%s' "${ID:-}")"
# shellcheck disable=SC1091
OS_VERSION_ID="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_ID:-}")"
# shellcheck disable=SC1091
OS_PRETTY="$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}")"
[ "$OS_ID" = "ubuntu" ] || refuse "this is ${OS_PRETTY:-not Ubuntu}; Clavarium installs on Ubuntu Server $SUPPORTED"
case " $SUPPORTED " in *" ${OS_VERSION_ID} "*) : ;; *) refuse "this is Ubuntu ${OS_VERSION_ID:-?}; supported: $SUPPORTED" ;; esac
[ "$(uname -m)" = "x86_64" ] || refuse "this machine is $(uname -m); only x86_64 is supported"
grep -Eq '(vmx|svm)' /proc/cpuinfo || echo "install: WARNING: this processor does not show virtualisation: VMs may not start." >&2

step "packages"
export DEBIAN_FRONTEND=noninteractive
# Installing packages must not stop to ask which services to restart, nor fill the screen with it.
export NEEDRESTART_SUSPEND=1
apt-get update -qq
# bindfs: the read-only views. nftables: the network rules. build-essential
# and python3: one module of the server (the terminal) is compiled here.
# qrencode: the public keys, shown as QR codes on a screen. openssh-client: the tunnel.
apt-get install -y -qq bindfs nftables build-essential python3 curl ca-certificates xz-utils sudo snapd openssl git qrencode openssh-client >/dev/null
snap list multipass >/dev/null 2>&1 || snap install multipass >/dev/null

step "account"
id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
[ "$(getent passwd "$ACCOUNT" | cut -d: -f6)" = "$DATA" ] || usermod --home "$DATA" "$ACCOUNT"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0750 "$DATA"
install -d -o "$ACCOUNT" -g "$ACCOUNT" -m 0700 "$VAULT"
# What gets mounted into VMs is arranged by root only: see clavarium-host.
install -d -o root -g root -m 0755 "$MNT" "$MNT/resources" "$MNT/views" "$MNT/removed" "$MNT/work" "$MNT/work-disks"

step "code"
# No update while this runs: the timer and its service wait.
systemctl stop clavarium-update.timer clavarium-update.service 2>/dev/null || true
install -d -o root -g root -m 0755 "$CODE" "$CODE/releases" "$CODE/nodes"
# An installation from before releases: its code sits in $CODE itself. It
# keeps running while the new release is made beside it, and is removed only
# once the new one answers (below).
LEGACY="no"; [ -d "$CODE/server" ] && [ ! -L "$CODE/current" ] && LEGACY="yes"
# The Node.js the updater runs on to make the release (each release then has
# the one its own code pins, most often this one).
NODE_DIR="$CODE/nodes/$NODE_VERSION"
if [ ! -x "$NODE_DIR/bin/node" ]; then
    rm -rf -- "$NODE_DIR.partial"
    if [ -x "$CODE/node/bin/node" ] && [ "$("$CODE/node/bin/node" --version)" = "$NODE_VERSION" ]; then
        cp -a "$CODE/node" "$NODE_DIR.partial"
    else
        archive="$(mktemp)"
        curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 -o "$archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
        echo "$NODE_SHA256  $archive" | sha256sum -c - >/dev/null || refuse "the Node.js archive does not have the expected checksum"
        install -d "$NODE_DIR.partial"
        tar -xJf "$archive" -C "$NODE_DIR.partial" --strip-components=1 --no-same-owner
        rm -f -- "$archive"
    fi
    mv -- "$NODE_DIR.partial" "$NODE_DIR"
fi
updater() { PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/node" "$HERE/deploy/updater.mjs" "$@"; }
if [ "$KEEP_RELEASE" = "yes" ]; then
    [ -L "$CODE/current" ] || refuse "--keep-release: no release runs here yet"
    release="$(basename "$(readlink -f "$CODE/current")")"
    echo "   the release that runs is kept: $release"
else
if [ -n "$VERSION" ] && [ -L "$CODE/current" ] && [ "$(basename "$(readlink -f "$CODE/current")")" = "$VERSION" ]; then
    # Run again with the version that runs already (a step after it failed, a
    # DNS record made late): kept as it is, and the rest goes on.
    release="$VERSION"
    echo "   clavarium@$VERSION runs here already: kept"
elif [ -n "$VERSION" ]; then
    echo "   clavarium@$VERSION from npm: fetched, checked, built, tried (a few minutes)"
    release="$(updater prepare --version "$VERSION")" || refuse "clavarium@$VERSION was not installed (above: why)"
else
    echo "   the working tree $FROM_DIR (development): copied, built, tried"
    release="$(updater prepare --from-dir "$FROM_DIR")" || refuse "the working tree was not installed (above: why)"
fi
if [ "$(basename "$(readlink -f "$CODE/current" 2>/dev/null)")" != "$release" ]; then
    systemctl stop clavarium.service 2>/dev/null || true
    updater switch "$release"
fi
fi
APP="$CODE/current/app"
NODE="$CODE/current/node/bin/node"
# The updater of the release now in place, for what follows and from now on.
updater() { PATH="$CODE/current/node/bin:$PATH" "$NODE" "$APP/deploy/updater.mjs" "$@"; }

step "the git reader"
# The one way the server reads an agent's repository: a sandbox around one
# fixed script (clavarium-host "git read"). Its root is empty and root's.
install -d -o root -g root -m 0755 /var/lib/clavarium /usr/lib/clavarium "$RUNNER_ROOT"
install -o root -g root -m 0755 "$APP/deploy/git-read" "$GIT_READ"

step "the one privileged program"
install -o root -g root -m 0755 "$APP/deploy/clavarium-host" "$HOST_PROGRAM"
# The command for the keyboard (sudo clavarium online, key, relay): the
# program of the package, from the release that runs.
printf '#!/bin/sh\n# Clavarium: the command of the release that runs. Written by install.sh.\nexec %s %s "$@"\n' "$CODE/current/node/bin/node" "$CODE/current/app/deploy/clavarium.mjs" > /usr/local/bin/clavarium
chmod 0755 /usr/local/bin/clavarium
install -d -o root -g root -m 0755 "$ETC"
printf 'DATA=%s\nMNT=%s\n' "$DATA" "$MNT" > "$ETC/host.conf"; chmod 0644 "$ETC/host.conf"
rule="$(mktemp)"
printf '# Clavarium: the server account may run ONE program as root, and nothing else.\n%s ALL=(root) NOPASSWD: %s\n' "$ACCOUNT" "$HOST_PROGRAM" > "$rule"
visudo -cf "$rule" >/dev/null || refuse "the sudo rule did not pass its check"
install -o root -g root -m 0440 "$rule" /etc/sudoers.d/clavarium; rm -f -- "$rule"

step "what the machines are given, on root's chain"
# ONCE, from an earlier version: resources/, views/, work/, work-disks/ and
# removed/ move from $DATA to $MNT, with the server stopped (above); the
# machines are given back what they had, from the new places, through the
# program just installed. See deploy/move-to-mnt.sh.
bash "$APP/deploy/move-to-mnt.sh" --data "$DATA" --mnt "$MNT" --host "$HOST_PROGRAM" --node "$NODE"
# Each component from / to each of them belongs to root, nobody else may
# write it, and no access list says otherwise (ls marks one with a '+').
for at in /home "$MNT" "$MNT/resources" "$MNT/views" "$MNT/removed" "$MNT/work" "$MNT/work-disks"; do
    [ "$(stat -c %u "$at")" = "0" ] && [ -d "$at" ] && [ ! -L "$at" ] || refuse "$at must be a directory of root"
    case "$(stat -c %A "$at")" in ?????w????|????????w?) refuse "$at may be written by others than root" ;; esac
    mode="$(ls -ld -- "$at" | cut -d' ' -f1)"; [ "${#mode}" -eq 10 ] || refuse "$at has an access list (getfacl): only root may write it"
done
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
WorkingDirectory=$CODE/current/app
EnvironmentFile=$ETC/server.env
ExecStart=$CODE/current/node/bin/node server/main.mjs --host "sudo -n $HOST_PROGRAM" --data $DATA --vault-key $VAULT/vault.key --port $PORT$([ "$LOCAL" = "yes" ] || echo " --operators $OPERATORS --public-origin https://$DOMAIN")$([ -z "$APP_NAME" ] || echo " --name \"$APP_NAME\"")
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITFILE

# THE UPDATES: their settings (kept from an earlier run unless asked here),
# and the timer that looks for a new version every 15 minutes. What it does
# is the updater's (deploy/updater.mjs), as root, through this service only.
updater set port "$PORT" >/dev/null
updater set mode "$SHOW_MODE" >/dev/null
updater set window "$SHOW_WINDOW" >/dev/null
updater set channel "$SHOW_CHANNEL" >/dev/null
cat > /etc/systemd/system/clavarium-update.service <<UPDATEUNIT
[Unit]
Description=Clavarium - looks for a new version, and updates as its settings say
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$CODE/current/node/bin/node $CODE/current/app/deploy/updater.mjs run
TimeoutStartSec=3600
UPDATEUNIT
cat > /etc/systemd/system/clavarium-update.timer <<'UPDATETIMER'
[Unit]
Description=Clavarium - looks for a new version every 15 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=15min
RandomizedDelaySec=3min

[Install]
WantedBy=timers.target
UPDATETIMER
systemctl daemon-reload
systemctl enable --quiet clavarium.service
systemctl enable --quiet clavarium-update.timer
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
# It answers: the copy of an installation from before releases goes, and
# releases beyond the last two. Then the timer may look for updates.
if [ "$LEGACY" = "yes" ]; then
    rm -rf -- "$CODE/server" "$CODE/web" "$CODE/config" "$CODE/node_modules" "$CODE/node" "$CODE/package.json" "$CODE/package-lock.json"
    echo "   the earlier copy of the code in $CODE was removed: it runs from $CODE/current"
fi
updater prune
systemctl start clavarium-update.timer
echo "   running: $(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$APP/package.json" | head -1) ($release)"

# THE EDGE'S PROGRAMS: also in local mode, switched off, so that going online
# (sudo clavarium online) has them, and can test from the internet first.
# Downloads one file and refuses it unless it has the expected checksum.
fetch() { # <url> <sha256> <destination> [extra curl arguments...]
    local url="$1" sum="$2" to="$3"; shift 3
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 "$@" -o "$to" "$url"
    echo "$sum  $to" | sha256sum -c - >/dev/null || refuse "not the expected checksum: $url"
}
account() { id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"; }

if [ "$LOCAL" = "yes" ] || [ "$CORE_ONLY" = "no" ]; then
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
fi

if [ "$LOCAL" = "yes" ]; then
    echo
    # The keys for going online, as text and as QR codes (a screen and a keyboard may be all there is).
    /usr/local/bin/clavarium key || echo "install: the keys could not be shown: sudo clavarium key" >&2
    echo
    echo "Clavarium is installed, in local mode:   http://127.0.0.1:$PORT   (this machine only, no sign-in)"
    echo "From another computer of yours:          ssh -L $PORT:127.0.0.1:$PORT <you>@<this machine>"
    echo
    echo "NEXT, to go online (HTTPS, an administrator, a password shown once):"
    echo "    sudo clavarium online --relay RELAY_HOST --domain clav.example.com     through a relay of yours"
    echo "    sudo clavarium online --port --domain clav.example.com                 or with ports 80 and 443 open here"
    echo "The keys again: sudo clavarium key"
    exit 0
fi
if [ "$CORE_ONLY" = "yes" ]; then
    echo "Clavarium is installed: 127.0.0.1:$PORT, for $OPERATORS."
    echo "It answers nobody yet: put an authenticating proxy in front, for https://$DOMAIN."
    exit 0
fi

# ------------------------------- THE EDGE ---------------------------------

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
    # The OAuth client id is seen in the open (the sign-in redirect). By default
    # it is random, so it tells nothing about what this is; --client-id sets a
    # chosen one. dex and the proxy below MUST carry the same value. The display
    # name is the id too: nothing here names the product (deploy/oidc.mjs).
    client_id="${CLIENT_ID:-$(openssl rand -hex 16)}"
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
  - id: $client_id
    name: $client_id
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
client_id = "$client_id"
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
# Two sign-ins at once (two tabs, a reload during it) each have their own CSRF
# cookie; and there is time to type a password (deploy/updater.mjs, PROXY_LINES).
cookie_csrf_per_request = true
cookie_csrf_expire = "30m"
PROXY
    install -o root -g root -m 0600 "$proxy" /etc/oauth2-proxy/oauth2-proxy.cfg; rm -f -- "$proxy"
else
    echo "   the identity file exists: kept, with its operators and passwords."
    echo "   (to start again: remove /etc/dex/config.yaml and run this script again)"
    sed -i "s#^upstreams = .*#upstreams = [\"http://127.0.0.1:$PORT/\"]#" /etc/oauth2-proxy/oauth2-proxy.cfg
fi

# Behind a relay, the front listens on the loopback only: the tunnel is the
# one way in. Let's Encrypt first; if it cannot be reached (a tunnel not up yet),
# a certificate Caddy makes itself, so the site still answers (with a warning).
# Caddy would keep that one for hours: clavarium-certificate.timer replaces it
# with Let's Encrypt's as soon as it can (sudo clavarium doctor --certificate).
BIND=""; [ -z "$RELAY" ] || BIND="	bind 127.0.0.1"
# The page the front serves while the server is down (an update, a restart): kept outside the
# releases, so it is there during the switch; kept up to date by the updater (ensureMaintenance).
# A release from before it (--keep-release) has none: the updater writes it at its next turn.
install -d -o root -g root -m 0755 /var/lib/clavarium/maintenance
[ ! -f "$APP/deploy/maintenance.html" ] || install -o root -g root -m 0644 "$APP/deploy/maintenance.html" /var/lib/clavarium/maintenance/index.html
# The probe's token: kept on a rerun (see deploy/doctor.mjs, probeBlock).
# No Caddyfile yet (going online from local mode): no token, not a failure (pipefail).
PROBE="$( { sed -n 's/.*respond "\([0-9a-f]\{32\}\)" 200.*/\1/p' /etc/caddy/Caddyfile 2>/dev/null || true; } | head -1)"
[ -n "$PROBE" ] || PROBE="$(openssl rand -hex 16)"
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
		# The server down (an update, a restart): the maintenance page (deploy/updater.mjs, MAINTENANCE_BLOCK).
		reverse_proxy 127.0.0.1:4180 {
			@down {
				status 502 503 504
				header Content-Type text/html*
			}
			handle_response @down {
				header Cache-Control no-store
				header Retry-After 3
				header X-Clavarium-Down 1
				@api path /api/* /c/api/*
				handle @api {
					header Content-Type "application/json; charset=utf-8"
					respond "{\"error\":\"Clavarium is being updated or restarted: it comes back by itself in a moment.\",\"down\":true}" 503
				}
				handle {
					root * /var/lib/clavarium/maintenance
					rewrite * /index.html
					file_server {
						status 503
					}
				}
			}
		}
	}
}

# Clavarium's probe: is this machine reached by its name on port 80? Asked before Let's Encrypt is.
http://$DOMAIN {
$BIND
	handle /.well-known/clavarium-probe {
		respond "$PROBE" 200
	}
	handle {
		redir https://{host}{uri} 308
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
# A certificate Caddy made itself (its fallback) replaced by Let's Encrypt's as soon as it can.
/usr/local/bin/clavarium doctor --install-watch || echo "install: the certificate timer could not be set: sudo clavarium doctor --fix" >&2

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
    # An installation made before this script named the key "cle" and gave it
    # to another account: the relay knows THAT key. It is taken over, never
    # replaced, and what the tunnel reads is given to the account that runs it.
    if [ ! -e /var/lib/clavarium-tunnel/key ] && [ -s /var/lib/clavarium-tunnel/cle ]; then
        install -o clavarium-tunnel -g clavarium-tunnel -m 0600 /var/lib/clavarium-tunnel/cle /var/lib/clavarium-tunnel/key
        [ -s /var/lib/clavarium-tunnel/cle.pub ] && install -o clavarium-tunnel -g clavarium-tunnel -m 0644 /var/lib/clavarium-tunnel/cle.pub /var/lib/clavarium-tunnel/key.pub
        echo "   the tunnel key of the earlier installation is kept: the relay already knows it"
    fi
    [ -e /var/lib/clavarium-tunnel/known_hosts ] && chown clavarium-tunnel:clavarium-tunnel /var/lib/clavarium-tunnel/known_hosts
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
    # The unit is the updater's (deploy/tunnel.mjs, tunnelUnit): one text, kept up to date by each update.
    install -o root -g root -m 0755 "$APP/deploy/clavarium-tunnel" /usr/local/sbin/clavarium-tunnel
    "$NODE_DIR/bin/node" --input-type=module -e 'const { tunnelUnit } = await import(process.argv[1]); process.stdout.write(tunnelUnit(process.argv[2], process.argv[3]));' \
        "$APP/deploy/tunnel.mjs" "$RELAY" "$RELAY_PORT" > /etc/systemd/system/clavarium-tunnel.service
    systemctl daemon-reload
    systemctl enable --quiet clavarium-tunnel.service
    systemctl restart clavarium-tunnel.service
    # Caddy asked Let's Encrypt as it started, BEFORE the tunnel was up: it could not
    # be reached, and fell back to a certificate of its own. Asked again once the
    # tunnel holds (ExitOnForwardFailure: an ssh still running after 10 s has its forwards).
    if [ "$RELAY_INSTALLED" = "yes" ]; then
        sleep 10
        if systemctl is-active --quiet clavarium-tunnel.service; then
            rm -rf -- "/var/lib/caddy/caddy/certificates/local/$DOMAIN"
            systemctl restart caddy.service
        fi
    fi
    TUNNEL_KEY="$(cat /var/lib/clavarium-tunnel/key.pub)"
    RELAY_PRINT="$(ssh-keygen -l -f /var/lib/clavarium-tunnel/known_hosts | cut -d' ' -f2 | head -1)"
fi

echo
echo "Clavarium is installed:   https://$DOMAIN"
if [ -n "$PASSWORDS" ] && [ -n "${CLAVARIUM_PASSWORDS_TO:-}" ]; then
    # Run by `clavarium online`: it shows them LAST, where they do not scroll away, then deletes them.
    ( umask 077; printf '%s' "$PASSWORDS" > "$CLAVARIUM_PASSWORDS_TO" )
    echo "Sign in with: the password is shown at the very end."
elif [ -n "$PASSWORDS" ]; then
    echo "Sign in with (shown ONCE, kept nowhere in clear):"
    printf '%s' "$PASSWORDS"
else
    echo "Operators and passwords: unchanged."
fi
if [ -n "$RELAY" ] && [ "$RELAY_INSTALLED" = "yes" ]; then
    echo "The relay $RELAY is set up; the tunnel comes up by itself.   Its fingerprint: $RELAY_PRINT"
elif [ -n "$RELAY" ]; then
    echo
    # A server with a screen and a keyboard only: the key, carried by a phone.
    # It is a PUBLIC key: showing it is safe; it lets the relay know this machine.
    # The QR code far from the key's text, so a phone reads the code, not the text.
    if command -v qrencode >/dev/null 2>&1 || apt-get install -y -qq qrencode >/dev/null 2>&1; then
        echo "The relay's tunnel key, as a QR code:"
        echo "WARNING: read the QR code with the camera, not the text: some phones read the text on screen and get letters wrong, while the code is exact."
        qrencode -t ANSI -m 1 -l L -- "$TUNNEL_KEY" || true
        printf '\n\n\n\n\n\n'
    fi
    echo "ON THE RELAY ($RELAY), run this one command; the tunnel then comes up by itself:"
    echo "    sudo deploy/relay.sh --key \"$TUNNEL_KEY\""
    echo "It will print this, and it must be the same:    $RELAY_PRINT"
    echo "The name $DOMAIN must lead to the relay."
else
    echo "The name $DOMAIN must lead to this machine (ports 443 and 80)."
fi
