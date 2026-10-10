#!/bin/bash
# ---------------------------------------------------------------------------
# PUTS A BACKUP BACK (see backup.sh) -- on this machine, or on a new one where
# install.sh has just been run. One command, parameters only.
#
#   sudo deploy/restore.sh ARCHIVE.tgz [--vault-key FILE]
#   sudo deploy/restore.sh ARCHIVE.tgz --check        reads, changes nothing
#
# In order:
#   1. the archive is read and checked BEFORE anything is touched;
#   2. what is here now is set aside (/var/backups), key included;
#   3. services stop, files go back with their owners, services start;
#   4. if a service does not come back, what was set aside is put back.
#
# It puts back; it does not erase what was added here since the backup.
# A conversation whose machine does not exist here is listed at the end: its
# name, tool and folders are back, its machine is not.
#
#   --root DIR   work under DIR instead of /, without touching services. For tests.
#
# Exit codes: 0 done; 64 bad parameters; 78 refused; 1 failed and rolled back.
# ---------------------------------------------------------------------------
set -euo pipefail

bad() { echo "restore: $*" >&2; echo "usage: restore.sh ARCHIVE.tgz [--vault-key FILE] [--check]" >&2; exit 64; }
refuse() { echo "restore: REFUSED: $*" >&2; exit 78; }

ARCHIVE=""; VAULT_KEY=""; CHECK="no"; ROOT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --vault-key) VAULT_KEY="${2:-}"; shift 2 || bad "--vault-key needs a value" ;;
        --check) CHECK="yes"; shift ;;
        --root) ROOT="${2:-}"; shift 2 || bad "--root needs a value" ;;
        -*) bad "unknown parameter: $1" ;;
        *) [ -z "$ARCHIVE" ] || bad "one archive at a time"; ARCHIVE="$1"; shift ;;
    esac
done
[ -n "$ARCHIVE" ] || bad "which archive?"
[ -r "$ARCHIVE" ] || bad "this archive cannot be read: $ARCHIVE"
[ -z "$VAULT_KEY" ] || [ -r "$VAULT_KEY" ] || bad "this key file cannot be read: $VAULT_KEY"

# 1. Check before touching anything.
listing="$(tar -tzf "$ARCHIVE" 2>/dev/null)" || refuse "this is not an archive that can be read"
grep -qx 'BACKUP.txt' <<< "$listing" || refuse "this archive was not made by backup.sh"
grep -q '^var/lib/clavarium/' <<< "$listing" || refuse "this archive holds no Clavarium data"
# Nothing in it may land outside the places a backup is made of.
if grep -Ev '^(BACKUP\.txt|var/lib/(clavarium|caddy|dex|clavarium-tunnel)(/|$)|etc/(clavarium|dex|oauth2-proxy|caddy)(/|$))' <<< "$listing" | grep -q .; then
    refuse "this archive holds files that are not part of a backup"
fi
if grep -q '\.\.' <<< "$listing"; then refuse "this archive holds a path that climbs out"; fi
if [ -n "$VAULT_KEY" ]; then [ "$(wc -c < "$VAULT_KEY")" -eq 32 ] || refuse "this is not a vault key (32 bytes expected)"; fi
tar -xzOf "$ARCHIVE" BACKUP.txt
has_secrets="no"
if tar -xzOf "$ARCHIVE" var/lib/clavarium/secrets.json 2>/dev/null | grep -q '"name"'; then has_secrets="yes"; fi
if [ "$has_secrets" = "yes" ] && [ -z "$VAULT_KEY" ]; then
    refuse "this backup holds sealed secrets: give the key that opens them (--vault-key FILE)"
fi
if [ "$CHECK" = "yes" ]; then echo "checked: nothing was changed."; exit 0; fi

REAL="no"
if [ -z "$ROOT" ]; then
    [ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
    id clavarium >/dev/null 2>&1 || refuse "Clavarium is not installed here: run install.sh first, then restore"
    ROOT="/"; REAL="yes"
fi
ROOT="$(cd "$ROOT" && pwd)"; [ "$ROOT" != "/" ] || ROOT=""

services=()
if [ "$REAL" = "yes" ]; then
    for s in clavarium clavarium-tunnel oauth2-proxy dex caddy; do
        if systemctl cat "$s.service" >/dev/null 2>&1; then services+=("$s.service"); fi
    done
fi

# 2. Set aside what is here now.
aside="$ROOT/var/backups/clavarium-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$aside"; chmod 700 "$aside"
present=()
for part in var/lib/clavarium var/lib/clavarium-vault etc/clavarium etc/dex etc/oauth2-proxy etc/caddy var/lib/caddy var/lib/dex var/lib/clavarium-tunnel; do
    [ -e "$ROOT/$part" ] && present+=("$part")
done
[ "${#services[@]}" -eq 0 ] || systemctl stop "${services[@]}"
[ "${#present[@]}" -eq 0 ] || tar -czpf "$aside/state.tgz" --exclude='var/lib/clavarium/views' -C "$ROOT/" "${present[@]}"
echo "what was here is set aside: $aside/state.tgz"

back() {
    echo "restore: FAILED: putting back what was here" >&2
    [ "${#services[@]}" -eq 0 ] || systemctl stop "${services[@]}" || true
    [ ! -e "$aside/state.tgz" ] || tar -xzpf "$aside/state.tgz" -C "$ROOT/"
    if [ "${#services[@]}" -gt 0 ]; then systemctl reset-failed "${services[@]}" || true; systemctl start "${services[@]}" || true; fi
    exit 1
}
trap back ERR

# 3. Put the files back, with their owners (by name: numbers differ between machines).
tar -xzpf "$ARCHIVE" -C "$ROOT/" --exclude='BACKUP.txt'
if [ -n "$VAULT_KEY" ]; then
    mkdir -p "$ROOT/var/lib/clavarium-vault"
    install -m 0600 "$VAULT_KEY" "$ROOT/var/lib/clavarium-vault/vault.key"
fi
if [ "$REAL" = "yes" ]; then
    chown clavarium:clavarium /var/lib/clavarium-vault /var/lib/clavarium-vault/vault.key 2>/dev/null || true
    # What gets mounted into VMs is arranged by root only: see clavarium-host.
    install -d -o root -g root -m 0755 /var/lib/clavarium/resources /var/lib/clavarium/views /var/lib/clavarium/removed
    systemctl daemon-reload
    systemctl start "${services[@]}"
    # 4. Every service must come up (up to 30 s) AND HOLD: one that starts,
    # dies on its settings and is started again looks alive at any one glance
    # (seen on a real machine). So they are watched for a while; otherwise, back.
    all_up() { local s; for s in "${services[@]}"; do systemctl is-active --quiet "$s" || return 1; done; }
    for _ in $(seq 1 15); do
        if all_up; then break; fi
        sleep 2
    done
    for _ in $(seq 1 6); do
        sleep 2
        for s in "${services[@]}"; do
            if ! systemctl is-active --quiet "$s"; then echo "restore: $s does not hold" >&2; false; fi
        done
    done
fi
trap - ERR
echo "restored."

if [ "$REAL" = "yes" ]; then
    missing=""
    while read -r name; do
        [ -n "$name" ] || continue
        multipass info "clv-$name" >/dev/null 2>&1 || missing="$missing $name"
    done < <(sed -n 's/^ *"name": "\([a-z0-9-]*\)",\{0,1\}$/\1/p' /var/lib/clavarium/conversations.json 2>/dev/null)
    [ -z "$missing" ] || echo "These conversations have no machine here (archive them, then create them again):$missing"
fi
