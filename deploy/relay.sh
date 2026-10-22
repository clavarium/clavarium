#!/bin/bash
# ---------------------------------------------------------------------------
# TURNS THIS MACHINE INTO THE RELAY OF ONE CLAVARIUM. One command, parameters
# only. Run it on a small machine that has a public address; the machine at
# home dials out to it, so home needs no open port and no fixed address.
#
#   sudo deploy/relay.sh --key "ssh-ed25519 AAAA... clavarium-tunnel"
#
#   --key LINE         the PUBLIC tunnel key of the home machine (`sudo clavarium key`)
#   --keeper-key LINE  the PUBLIC maintenance key of the home machine (optional)
#   --dry-run          check the parameters, say what would be done, do nothing
#
# `sudo clavarium online --relay HOST` at home runs this script here by itself,
# over SSH, with both keys.
#
# THE RELAY IS BLIND. It carries bytes: TLS starts in the browser and ends at
# home, so this machine never sees a page, a keystroke or a password. It holds
# no certificate and no secret of yours.
#
# WHAT IT SETS UP:
#   - an account, "clavarium-tunnel", that can do ONE thing: hold two
#     listening ports (8443, 8080) forwarded to home. No shell, no terminal,
#     no command, no other forwarding;
#   - a rule that sends what arrives on 443 and 80 to those two ports;
#   - the maintenance program, clavarium-relay, fetched by THIS machine from
#     npm at the version written below and checked against the registry's
#     sha512; with --keeper-key, an account "clavarium-keeper" that may run
#     that program, and nothing else (status, repair, updates);
#   - Ubuntu's security updates, by themselves (unattended-upgrades).
#
# WHAT A BLIND RELAY CAN STILL DO, and how to close it: whoever controls this
# machine receives port 80 for your name, so it could answer a certificate
# authority's challenge itself and obtain a valid certificate for your name.
# One DNS record closes that: a CAA record that names YOUR certificate
# account ("accounturi="). The end of this script says it again.
#
# Exit codes: 0 done; 64 bad parameters; 78 this machine is refused.
# ---------------------------------------------------------------------------
set -euo pipefail

# The version of the maintenance program this Clavarium works with.
RELAY_VERSION="0.1.1"
ACCOUNT="clavarium-tunnel"
TLS_PORT="8443"
HTTP_PORT="8080"
PROGRAM="/usr/local/sbin/clavarium-relay"
# Tests run it on a folder that stands for "/".
ROOT="${CLAVARIUM_RELAY_ROOT:-}"
REGISTRY="https://registry.npmjs.org"
[ -z "$ROOT" ] || REGISTRY="${CLAVARIUM_RELAY_REGISTRY:-$REGISTRY}"

bad() { echo "relay: $*" >&2; echo "usage: relay.sh --key \"ssh-ed25519 AAAA... name\" [--keeper-key \"ssh-ed25519 AAAA... name\"] [--dry-run]" >&2; exit 64; }
refuse() { echo "relay: REFUSED: $*" >&2; exit 78; }
step() { echo "== $*"; }

KEY=""; KEEPER_KEY=""; DRY="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --key) KEY="${2:-}"; shift 2 || bad "--key needs a value" ;;
        --keeper-key) KEEPER_KEY="${2:-}"; [ -n "$KEEPER_KEY" ] || bad "--keeper-key needs a value"; shift 2 ;;
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

if [ "$DRY" = "yes" ]; then
    cat <<PLAN
would make this machine a relay:
  account     $ACCOUNT: may hold ports $TLS_PORT and $HTTP_PORT forwarded to home, and nothing else
  ports       443 -> $TLS_PORT, 80 -> $HTTP_PORT
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
for port in 443 80 "$TLS_PORT" "$HTTP_PORT"; do
    # (On a second run, the tunnel itself holds two of them: that is the SSH server.)
    if ss -ltnpH "sport = :$port" 2>/dev/null | grep -v '"sshd' | grep -q .; then refuse "something already listens on port $port here: a relay needs 443 and 80 for itself"; fi
done

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
if [ -n "$KEEPER_KEY" ]; then "$ROOT$PROGRAM" setup --key "$KEY" --keeper-key "$KEEPER_KEY"
else "$ROOT$PROGRAM" setup --key "$KEY"; fi

echo
echo "This machine is a relay. It waits for the home machine to dial in."
echo "Compare with what the home machine printed (it must be the same):"
echo "    $(ssh-keygen -l -f "$ROOT/etc/ssh/ssh_host_ed25519_key.pub" | cut -d' ' -f2)"
echo "Point your name at this machine's public address (ports 443 and 80 must reach it)."
echo
echo "TO KEEP THIS RELAY BLIND, add a CAA record to your DNS that names your certificate"
echo "account (accounturi=...). Without it, whoever controls this machine could obtain a"
echo "certificate for your name. The account address is at home, after the first certificate:"
echo "    sudo grep -rho '\"location\": *\"[^\"]*\"' /var/lib/caddy/caddy/acme"
