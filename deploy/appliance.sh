#!/bin/bash
# ---------------------------------------------------------------------------
# CLAVARIUM AS ONE VIRTUAL MACHINE, on the computer you run this on. One
# command, parameters only: it starts an Ubuntu VM with Multipass and installs
# Clavarium inside it (install.sh). The computer itself is left alone.
#
#   deploy/appliance.sh --domain clav.example.com --operator you@example.com --relay relay.example.net
#
#   --domain, --operator, --relay, --relay-port, --port     as for install.sh
#   --name NAME        the VM's name (default clavarium)
#   --cpus N  --memory NG  --disk NG     its size (default 4, 8G, 60G): every
#                      conversation is a VM INSIDE this one, and they share it
#   --release X        the Ubuntu release (default 24.04)
#   --sudo             reach Multipass through sudo
#   --dry-run          check the parameters, say what would be done, do nothing
#
# A VM on a computer has no public address: without --relay, the site is only
# reachable from this computer.
#
# Exit codes: 0 done; 64 bad parameters; 78 refused.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bad() { echo "appliance: $*" >&2; echo "usage: appliance.sh --domain NAME --operator EMAIL [--relay HOST] [--name NAME] [--cpus N] [--memory NG] [--disk NG] [--release X] [--sudo] [--dry-run]" >&2; exit 64; }
refuse() { echo "appliance: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

NAME="clavarium"; CPUS="4"; MEMORY="8G"; DISK="60G"; RELEASE="24.04"; SUDO="no"; DRY="no"
pass=()   # what goes to install.sh, untouched: it checks its own parameters
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME="${2:-}"; shift 2 || bad "--name needs a value" ;;
        --cpus) CPUS="${2:-}"; shift 2 || bad "--cpus needs a value" ;;
        --memory) MEMORY="${2:-}"; shift 2 || bad "--memory needs a value" ;;
        --disk) DISK="${2:-}"; shift 2 || bad "--disk needs a value" ;;
        --release) RELEASE="${2:-}"; shift 2 || bad "--release needs a value" ;;
        --sudo) SUDO="yes"; shift ;;
        --dry-run) DRY="yes"; shift ;;
        --domain|--operator|--relay|--relay-port|--port) [ $# -ge 2 ] || bad "$1 needs a value"; pass+=("$1" "$2"); shift 2 ;;
        *) bad "unknown parameter: $1" ;;
    esac
done
[[ "$NAME" =~ ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$ ]] || bad "--name is lower-case letters, digits and hyphens"
case "$NAME" in clv-*) bad "--name cannot start with clv-: those names are for conversations" ;; esac
[[ "$CPUS" =~ ^[0-9]{1,2}$ ]] && [ "$CPUS" -ge 2 ] || bad "--cpus is a number, 2 at least"
[[ "$MEMORY" =~ ^[0-9]{1,3}G$ ]] && [ "${MEMORY%G}" -ge 4 ] || bad "--memory is like 8G, 4G at least"
[[ "$DISK" =~ ^[0-9]{2,4}G$ ]] && [ "${DISK%G}" -ge 20 ] || bad "--disk is like 60G, 20G at least"
[[ "$RELEASE" =~ ^[0-9]{2}\.[0-9]{2}$ ]] || bad "--release is like 24.04"
# The rest is checked by the installer itself, here, before any VM exists.
plan="$(bash "$HERE/deploy/install.sh" "${pass[@]}" --dry-run)" || exit 64

if [ "$DRY" = "yes" ]; then
    echo "would start a VM named $NAME (Ubuntu $RELEASE, $CPUS processors, $MEMORY of memory, $DISK of disk), and inside it:"
    echo "$plan"
    exit 0
fi

mp=(multipass); [ "$SUDO" = "no" ] || mp=(sudo multipass)
command -v multipass >/dev/null 2>&1 || refuse "Multipass is not installed on this computer (https://multipass.run)"
if "${mp[@]}" info "$NAME" >/dev/null 2>&1; then refuse "a VM named $NAME exists already; choose another --name, or delete it first"; fi

step "starting the VM (a few minutes)"
"${mp[@]}" launch "$RELEASE" --name "$NAME" --cpus "$CPUS" --memory "$MEMORY" --disk "$DISK" --timeout 1200

step "sending Clavarium"
# Multipass only reads files in the home directory, and not hidden ones.
package="$HOME/clavarium-appliance-$$.tgz"
trap 'rm -f -- "$package"' EXIT
tar -czf "$package" -C "$HERE" server web config deploy package.json package-lock.json
[ "$SUDO" = "no" ] || chmod 644 "$package"
"${mp[@]}" transfer "$package" "$NAME:/tmp/clavarium.tgz"
"${mp[@]}" exec "$NAME" -- bash -c 'mkdir -p ~/clavarium && tar -xzf /tmp/clavarium.tgz -C ~/clavarium && rm -f /tmp/clavarium.tgz'

step "installing inside the VM"
# shellcheck disable=SC2016 # expanded inside the VM, where ~ is its own home
"${mp[@]}" exec "$NAME" -- bash -c 'sudo bash ~/clavarium/deploy/install.sh "$@"' install "${pass[@]}"

address="$("${mp[@]}" info "$NAME" --format csv | tail -1 | cut -d, -f3)"
echo
echo "The VM is named $NAME; its address on this computer is $address."
echo "To look inside:   ${mp[*]} shell $NAME"
echo "To stop it:       ${mp[*]} stop $NAME        (and start: ${mp[*]} start $NAME)"
