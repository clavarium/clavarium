#!/bin/bash
# ---------------------------------------------------------------------------
# INSTALLS CLAVARIUM, from https://clavarium.org/install.sh:
#
#   curl -fsSL https://clavarium.org/install.sh | sudo bash
#   curl -fsSL https://clavarium.org/install.sh | sudo bash -s -- --channel next
#   ... -s -- --relay IP --relay-user ubuntu --domain clav.example.com --admin you@example.com
#       installs, shows the setup key (text + QR), waits for the relay, then goes online
#   ... -s -- --direct --domain clav.example.com     (ports 80 and 443 open to this machine)
#   ... -s -- --key-only     step 1 alone: the relay's key, text + QR, in seconds
#
# It asks nothing and always ends in LOCAL MODE (this computer only, no
# sign-in). It prints the next command (`sudo clavarium online ...`) and the
# public keys, as text and as QR codes.
#
# What it does: Node.js at a pinned version, checked against its checksum
# (written here); then the package "clavarium" from npm (latest, or the
# channel asked for), whose installer, deploy/install.sh, does the rest: it
# installs that exact version again from npm, checked (integrity, provenance
# from github.com/clavarium/clavarium).
#
#   --channel latest|next   which versions (default latest)
#   --version X.Y.Z         exactly this version
#   any other option goes to deploy/install.sh (--port, --updates, ...)
#
# Ubuntu Server 24.04 or 26.04, x86_64.
# ---------------------------------------------------------------------------
set -euo pipefail

NODE_VERSION="v24.20.0"
NODE_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"
NODES="/opt/clavarium/nodes"

bad() { echo "install: $*" >&2; exit 64; }
refuse() { echo "install: REFUSED: $*" >&2; exit 78; }

CHANNEL="latest"; VERSION=""; PASS=(); ONLINE=(); KEY_ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --channel) CHANNEL="${2:-}"; shift 2 || bad "--channel needs a value"; PASS+=(--channel "$CHANNEL") ;;
        --version) VERSION="${2:-}"; shift 2 || bad "--version needs a value" ;;
        --local) shift ;;
        --key-only) KEY_ONLY=yes; shift ;;
        # Going online in the same command: installed in local mode first, then
        # `clavarium online` runs and WAITS for the relay (or the domain) by itself.
        --relay|--relay-user|--domain|--admin|--relay-fingerprint) [ -n "${2:-}" ] || bad "$1 needs a value"; ONLINE+=("$1" "$2"); shift 2 ;;
        --keep-setup-key|--yes) ONLINE+=("$1"); shift ;;
        --direct) ONLINE+=(--port); shift ;;
        --operator|--core-only|--from-dir|--keep-release|--relay-installed) bad "$1 is not for this script (see deploy/install.sh)" ;;
        *) PASS+=("$1"); shift ;;
    esac
done
[[ "$CHANNEL" =~ ^(latest|next)$ ]] || bad "--channel is latest or next"
[ -z "$VERSION" ] || [[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || bad "--version is an exact version, like 1.2.3"

[ "$(id -u)" -eq 0 ] || refuse "run it as root: curl -fsSL https://clavarium.org/install.sh | sudo bash"

# Version of this script: 2026-10-18.4 (printed, to tell a stale copy from the current one).
# STEP 1 OF 2, ALONE: the key the relay will be made with. Made here, its private
# half never leaves this machine; its public half shown as text and as a QR code.
# The installation (step 2) takes it from the same place.
if [ -n "$KEY_ONLY" ]; then
    ACCESS=/var/lib/clavarium-relay-access
    command -v ssh-keygen >/dev/null 2>&1 && command -v qrencode >/dev/null 2>&1 \
        || { export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1; { apt-get update -qq && apt-get install -y -qq openssh-client qrencode; } >/dev/null 2>&1; } \
        || refuse "openssh-client and qrencode could not be installed"
    install -d -m 0700 "$ACCESS"
    [ -s "$ACCESS/setup-key" ] || ssh-keygen -q -t ed25519 -N '' -C clavarium-setup -f "$ACCESS/setup-key"
    echo "clavarium install.sh 2026-10-18.4"
    echo
    echo "The key to create your relay with (its SSH key, at your host). It is a PUBLIC key: showing it is safe."
    echo
    echo "    $(cat "$ACCESS/setup-key.pub")"
    echo
    # The QR code is 78 columns by 39 lines: shown under the key when the screen
    # has room, alone on a cleared screen when it is just big enough, not at all
    # (the text above is the same key) when it is smaller.
    size="$(stty size </dev/tty 2>/dev/null || echo "67 240")"; lines="${size% *}"; cols="${size#* }"
    if [ "$cols" -ge 78 ] && [ "$lines" -ge 45 ]; then
        qrencode -t ANSI -m 1 -l L < "$ACCESS/setup-key.pub" || true
    elif [ "$cols" -ge 78 ] && [ "$lines" -ge 40 ] && [ -r /dev/tty ]; then
        printf 'The same key as a QR code takes the whole screen: press Enter to see it.'; read -r _ </dev/tty || true
        clear; qrencode -t ANSI -m 1 -l L < "$ACCESS/setup-key.pub" || true
        printf 'Press Enter to go on.'; read -r _ </dev/tty || true; clear
        echo "    $(cat "$ACCESS/setup-key.pub")"
    else
        echo "(This screen is too small for the QR code: ${cols}x${lines}, it needs 78x40. The text above is the key.)"
    fi
    echo "Kept here, where the installation (step 2) takes it: $ACCESS/setup-key (the private half"
    echo "never leaves this machine) and $ACCESS/setup-key.pub (the public one, above)."
    echo
    echo "Where it goes, if your host does not ask for it when you create the machine: on the relay,"
    echo "in /home/<user>/.ssh/authorized_keys (or /root/.ssh/authorized_keys for root), one line."
    echo "That user must be able to use sudo without a password (most hosts' default user can)."
    echo
    echo "Next: create the relay (Ubuntu) with this key, point your domain to its address, then:"
    echo "    curl -fsSL https://clavarium.org/install.sh | sudo bash -s -- --relay <relay-ip> --relay-user ubuntu --domain <your-domain> --admin <your-email>"
    exit 0
fi
# shellcheck disable=SC1091
OS="$(. /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-}" "${VERSION_ID:-}")"
case "$OS" in "ubuntu 24.04"|"ubuntu 26.04") : ;; *) refuse "this is ${OS:-an unknown system}; Clavarium installs on Ubuntu Server 24.04 or 26.04" ;; esac
[ "$(uname -m)" = "x86_64" ] || refuse "this machine is $(uname -m); only x86_64 is supported"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
for tool in curl xz sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates xz-utils >/dev/null; break; }
done

echo "== Node.js $NODE_VERSION"
NODE_DIR="$NODES/$NODE_VERSION"
if [ ! -x "$NODE_DIR/bin/node" ]; then
    install -d -o root -g root -m 0755 /opt/clavarium "$NODES"
    archive="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 -o "$archive" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
    echo "$NODE_SHA256  $archive" | sha256sum -c - >/dev/null || { rm -f -- "$archive"; refuse "the Node.js archive does not have the expected checksum"; }
    rm -rf -- "$NODE_DIR.partial"; install -d "$NODE_DIR.partial"
    tar -xJf "$archive" -C "$NODE_DIR.partial" --strip-components=1 --no-same-owner
    rm -f -- "$archive"
    mv -- "$NODE_DIR.partial" "$NODE_DIR"
fi

echo "== the package clavarium@${VERSION:-$CHANNEL}, from npm"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
# npm checks what it downloads against the registry's integrity.
packed="$(cd "$work" && HOME="$work" PATH="$NODE_DIR/bin:$PATH" npm pack --silent --cache "$work/cache" "clavarium@${VERSION:-$CHANNEL}" 2>"$work/npm.err" | tail -1)" \
    || refuse "npm could not fetch clavarium@${VERSION:-$CHANNEL}: $(tail -1 "$work/npm.err")"
[ -f "$work/$packed" ] || refuse "npm gave no package"
tar -xzf "$work/$packed" -C "$work" --no-same-owner
got="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$work/package/package.json" | head -1)"
[[ "$got" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,40})?$ ]] || refuse "the package has no version"
echo "   clavarium $got"

PATH="$NODE_DIR/bin:$PATH" bash "$work/package/deploy/install.sh" --local --version "$got" "${PASS[@]}"
# Asked to go online too: on with it now. The questions (the relay's fingerprint)
# are read from the keyboard (/dev/tty), not from this script's own input.
if [ "${#ONLINE[@]}" -gt 0 ]; then
    echo
    echo "== going online"
    exec /usr/local/bin/clavarium online "${ONLINE[@]}" </dev/tty
fi
