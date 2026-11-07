#!/bin/bash
# ---------------------------------------------------------------------------
# TURNS THIS MACHINE INTO THE RELAY OF A CLAVARIUM -- and, later, of other
# Clavarium homes too. One command, parameters only. Run it on a small machine
# that has a public address; the machine at home dials out to it, so home
# needs no open port and no fixed address.
#
#   sudo deploy/relay.sh --key "ssh-ed25519 AAAA... clavarium-tunnel" --name clav.example.com
#
#   --key LINE         the PUBLIC tunnel key of the home machine (`sudo clavarium key`)
#   --keeper-key LINE  the PUBLIC maintenance key of the home machine (optional)
#   --name NAME        the home's name (its domain); with it, the relay routes by
#                      name from the start, and other homes can be added later
#   --dry-run          check the parameters, say what would be done, do nothing
#
# `sudo clavarium online --relay HOST` at home runs this script here by itself,
# over SSH, with both keys and the name. That home is the PRINCIPAL: the only
# one that holds the maintenance key. Run again on a relay that serves homes
# already, this script sets up the principal again (its key, its name) and
# leaves the other homes as they are.
#
# THE RELAY IS BLIND. It carries bytes: TLS starts in the browser and ends at
# home, so this machine never sees a page, a keystroke or a password. It holds
# no certificate and no secret of yours.
#
# WHAT IT SETS UP:
#   - an account, "clavarium-tunnel", that can do ONE thing: hold listening
#     ports forwarded to home. Each home has its own key there, and each key
#     may hold its own two ports only (the principal: 8443 and 8080). No
#     shell, no terminal, no command, no other forwarding;
#   - what takes 443 and 80: the router, which reads the name the visitor
#     asks for and passes the bytes, untouched, to that home's ports (a name
#     it does not know goes nowhere); or, for a relay of one home whose name
#     it does not know (set up before names were given), a rule that sends
#     443 and 80 to 8443 and 8080;
#   - the maintenance program, clavarium-relay, fetched by THIS machine from
#     npm at the version written below and checked against the registry's
#     sha512; with --keeper-key, an account "clavarium-keeper" that may run
#     that program, and nothing else (status, repair, updates, the homes);
#   - Ubuntu's security updates, by themselves (unattended-upgrades).
#
# ANOTHER HOME is added from the principal, never from here and never with
# an account of this machine: `sudo clavarium relay invite NAME` there gives
# a one-time code, typed on the new home (`sudo clavarium online --relay
# PRINCIPAL --domain NAME --join CODE`). The principal adds the new home's
# PUBLIC tunnel key here (clavarium-relay add-home) and tells it its ports.
# A second owner is thus let in by the principal's owner, and by nobody else.
#
# WHAT A BLIND RELAY CAN STILL DO, and how to close it: whoever controls this
# machine receives port 80 for every name it serves, so it could answer a
# certificate authority's challenge itself and obtain a valid certificate for
# such a name. One DNS record per name closes that: a CAA record that names
# THAT home's certificate account ("accounturi="). The end of this script says
# it again, and so does each home as it goes online.
#
# Exit codes: 0 done; 64 bad parameters; 78 this machine is refused.
# ---------------------------------------------------------------------------
set -euo pipefail

# The version of the maintenance program this Clavarium works with.
RELAY_VERSION="0.2.0-next.1"
ACCOUNT="clavarium-tunnel"
TLS_PORT="8443"
HTTP_PORT="8080"
PROGRAM="/usr/local/sbin/clavarium-relay"
# Tests run it on a folder that stands for "/".
ROOT="${CLAVARIUM_RELAY_ROOT:-}"
REGISTRY="https://registry.npmjs.org"
[ -z "$ROOT" ] || REGISTRY="${CLAVARIUM_RELAY_REGISTRY:-$REGISTRY}"

bad() { echo "relay: $*" >&2; echo "usage: relay.sh --key \"ssh-ed25519 AAAA... name\" [--keeper-key \"ssh-ed25519 AAAA... name\"] [--name NAME] [--dry-run]" >&2; exit 64; }
refuse() { echo "relay: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

KEY=""; KEEPER_KEY=""; NAME=""; DRY="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --key) KEY="${2:-}"; shift 2 || bad "--key needs a value" ;;
        --keeper-key) KEEPER_KEY="${2:-}"; [ -n "$KEEPER_KEY" ] || bad "--keeper-key needs a value"; shift 2 ;;
        --name) NAME="${2:-}"; [ -n "$NAME" ] || bad "--name needs a value"; shift 2 ;;
        --dry-run) DRY="yes"; shift ;;
        *) bad "unknown parameter: $1" ;;
    esac
done
# A key goes into a file that gives rights: it must be exactly a public key,
# on one line, with nothing that could add an option next to it.
for k in "$KEY" "$KEEPER_KEY"; do
    case "$k" in *"PRIVATE KEY"*) bad "this is a PRIVATE key: it must never leave home. Give the public one (one line, starts with ssh-ed25519)" ;; esac
done
[[ "$KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}(\ [A-Za-z0-9@._-]{1,64})?$ ]] || bad "--key is one line: ssh-ed25519, the key, and optionally a name"
[ -z "$KEEPER_KEY" ] || [[ "$KEEPER_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}(\ [A-Za-z0-9@._-]{1,64})?$ ]] || bad "--keeper-key is one line: ssh-ed25519, the key, and optionally a name"
[ "$KEY" != "$KEEPER_KEY" ] || bad "the tunnel and the maintenance keys are two different keys"
[ -z "$NAME" ] || [[ "$NAME" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$ ]] || bad "--name is a host name, lower case, like clav.example.com"

if [ "$DRY" = "yes" ]; then
    cat <<PLAN
would make this machine a relay:
  account     $ACCOUNT: may hold ports $TLS_PORT and $HTTP_PORT forwarded to home, and nothing else
  ports       443 -> $TLS_PORT, 80 -> $HTTP_PORT, for $([ -n "$NAME" ] && echo "the name $NAME, through the router (other names: refused)" || echo "any name (no --name: one home only)")
  sees        nothing: TLS ends at home
  program     clavarium-relay@$RELAY_VERSION from npm, checked (sha512 of the registry)
  maintenance $([ -n "$KEEPER_KEY" ] && echo "clavarium-keeper: may run clavarium-relay, and nothing else" || echo "none (no --keeper-key)")
  updates     Ubuntu's security updates, automatic
PLAN
    exit 0
fi

[ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
# shellcheck disable=SC1091
OS="$(. "$ROOT/etc/os-release" 2>/dev/null; printf '%s %s|%s' "${ID:-}" "${ID_LIKE:-}" "${PRETTY_NAME:-}")"
case "${OS%%|*}" in *ubuntu*|*debian*) : ;; *) refuse "this is ${OS#*|}; the relay installs on Ubuntu or Debian" ;; esac
command -v sshd >/dev/null 2>&1 || refuse "there is no SSH server on this machine (package openssh-server)"
grep -Eqs '^\s*Include\s+/etc/ssh/sshd_config\.d/' "$ROOT/etc/ssh/sshd_config" || refuse "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d: the account could not be bounded"
check="$(mktemp)"
for k in "$KEY" "$KEEPER_KEY"; do
    [ -n "$k" ] || continue
    printf '%s\n' "$k" > "$check"
    ssh-keygen -l -f "$check" >/dev/null 2>&1 || { rm -f -- "$check"; refuse "this is not a key the SSH tools recognise"; }
done
rm -f -- "$check"
# On a relay already (a second run), its own router holds 443 and 80, and the tunnels hold theirs.
if [ ! -s "$ROOT/etc/clavarium-relay/homes" ] && [ ! -s "$ROOT/etc/ssh/clavarium-relay/$ACCOUNT" ]; then
    for port in 443 80 "$TLS_PORT" "$HTTP_PORT"; do
        if ss -ltnpH "sport = :$port" 2>/dev/null | grep -v '"sshd' | grep -q .; then refuse "something already listens on port $port here: a relay needs 443 and 80 for itself"; fi
    done
fi

step "the maintenance program, from npm"
for tool in curl openssl tar; do command -v "$tool" >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq curl openssl tar ca-certificates >/dev/null; break; }; done
# --- fetch_relay: shared, word for word, with deploy/relay.sh (a test says so) ---
# fetch_relay VERSION DIR: the package clavarium-relay@VERSION from the registry,
# checked against the registry's sha512, unpacked in DIR (DIR/package/...).
fetch_relay() {
    local version="$1" dir="$2" meta integrity got proto="=https"
    case "$REGISTRY" in file://*) proto="=file" ;; esac
    meta="$(curl --proto "$proto" -fsSL --max-time 60 "$REGISTRY/clavarium-relay/$version")" || { echo "the registry did not answer for clavarium-relay@$version" >&2; return 1; }
    printf '%s' "$meta" | grep -Eq "\"version\" *: *\"${version//./\\.}\"" || { echo "the registry has no clavarium-relay@$version" >&2; return 1; }
    integrity="$(printf '%s' "$meta" | grep -Eo '"integrity" *: *"sha512-[A-Za-z0-9+/=]+"' | head -1 | sed 's/.*"\(sha512-[^"]*\)"$/\1/')"
    [ -n "$integrity" ] || { echo "the registry gave no sha512 for clavarium-relay@$version" >&2; return 1; }
    curl --proto "$proto" -fsSL --max-time 120 -o "$dir/relay.tgz" "$REGISTRY/clavarium-relay/-/clavarium-relay-$version.tgz" || { echo "the package could not be downloaded" >&2; return 1; }
    got="sha512-$(openssl dgst -sha512 -binary "$dir/relay.tgz" | base64 -w0)"
    [ "$got" = "$integrity" ] || { echo "the package is not the one the registry describes (sha512)" >&2; return 1; }
    tar -xzf "$dir/relay.tgz" -C "$dir" --no-same-owner package/clavarium-relay package/package.json || { echo "the package does not hold the program" >&2; return 1; }
    grep -Eq "\"name\" *: *\"clavarium-relay\"" "$dir/package/package.json" && grep -Eq "\"version\" *: *\"${version//./\\.}\"" "$dir/package/package.json" || { echo "the package is not clavarium-relay@$version" >&2; return 1; }
    bash -n "$dir/package/clavarium-relay" || { echo "the program in the package does not parse" >&2; return 1; }
}
# --- end of fetch_relay ---
work="$(mktemp -d)"
if ! fetch_relay "$RELAY_VERSION" "$work"; then rm -rf -- "$work"; refuse "clavarium-relay@$RELAY_VERSION could not be installed (above: why)"; fi
install -d "$ROOT$(dirname "$PROGRAM")"
install -m 0755 "$work/package/clavarium-relay" "$ROOT$PROGRAM"
rm -rf -- "$work"

step "accounts, rules, ports, updates"
setup=(setup --key "$KEY")
[ -z "$KEEPER_KEY" ] || setup+=(--keeper-key "$KEEPER_KEY")
[ -z "$NAME" ] || setup+=(--name "$NAME")
"$ROOT$PROGRAM" "${setup[@]}"

echo
echo "This machine is a relay. It waits for the home machine to dial in."
echo "Compare with what the home machine printed (it must be the same):"
echo "    $(ssh-keygen -l -f "$ROOT/etc/ssh/ssh_host_ed25519_key.pub" | cut -d' ' -f2)"
echo "Point your name at this machine's public address (ports 443 and 80 must reach it)."
echo
echo "TO KEEP THIS RELAY BLIND, add a CAA record to your DNS FOR EACH NAME it serves, that"
echo "names that home's certificate account (accounturi=...). Without it, whoever controls"
echo "this machine could obtain a certificate for that name. The account address is at"
echo "each home, after its first certificate:"
echo "    sudo grep -rho '\"location\": *\"[^\"]*\"' /var/lib/caddy/caddy/acme"
