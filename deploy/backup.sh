#!/bin/bash
# ---------------------------------------------------------------------------
# COPIES WHAT CLAVARIUM REMEMBERS INTO ONE ARCHIVE, and the key of the vault
# into a SECOND file. One command, parameters only.
#
#   sudo deploy/backup.sh --to /path/to/a/folder
#
# TWO FILES, ON PURPOSE:
#   clavarium-<date>.tgz         the list of conversations, the folders and
#                                their files, devices, shortcuts, the secrets
#                                (sealed), and the settings of the edge
#   clavarium-<date>.vault-key   what opens the sealed secrets
# Keep them in two different places: whoever finds the archive alone cannot
# read a secret. The archive still holds the operators' password hashes and
# this machine's own keys: it is written readable by root only.
#
# WHAT IS NOT IN IT: the machines themselves. A conversation's VM -- what the
# tool installed there, what sits in /work -- is not copied. What must outlive
# a machine belongs in a folder attached to the conversation.
#
#   --root DIR   look for everything under DIR instead of /. For tests.
#
# Exit codes: 0 done; 64 bad parameters; 78 refused.
# ---------------------------------------------------------------------------
set -euo pipefail

bad() { echo "backup: $*" >&2; echo "usage: backup.sh --to FOLDER" >&2; exit 64; }
refuse() { echo "backup: REFUSED: $*" >&2; exit 78; }

TO=""; ROOT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --to) TO="${2:-}"; shift 2 || bad "--to needs a value" ;;
        --root) ROOT="${2:-}"; shift 2 || bad "--root needs a value" ;;
        *) bad "unknown parameter: $1" ;;
    esac
done
[ -n "$TO" ] || bad "--to says where the two files go"
[ -d "$TO" ] || bad "--to must be a folder that exists: $TO"
if [ -z "$ROOT" ]; then
    [ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
    ROOT="/"
fi
[ -d "$ROOT/home/clavarium" ] || refuse "there is no Clavarium data here ($ROOT/home/clavarium)"
KEY="$ROOT/var/lib/clavarium-vault/vault.key"

# Everything that would be needed on a new machine, if it exists here.
# (home/clavarium-mnt holds what the machines are given, on a chain root owns:
# see clavarium-host. The read-only views are not content: they are mirrors,
# made again at start. Work folders are copied as their files; the disks that
# hold them are made again. An older house kept all that under home/clavarium:
# the same rule there.)
parts=()
for part in home/clavarium home/clavarium-mnt etc/clavarium etc/dex etc/oauth2-proxy etc/caddy var/lib/caddy var/lib/dex var/lib/clavarium-tunnel; do
    [ -e "$ROOT/$part" ] && parts+=("$part")
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$TO/clavarium-$stamp.tgz"
note="$(mktemp -d)"
trap 'rm -rf -- "$note"' EXIT
{
    echo "Clavarium backup, made $stamp"
    echo "Conversations (their machines are NOT in this backup):"
    sed -n 's/^ *"name": "\([a-z0-9-]*\)",\{0,1\}$/  \1/p' "$ROOT/home/clavarium/conversations.json" 2>/dev/null || true
} > "$note/BACKUP.txt"

# The identity provider keeps a small database: it is still while it is copied.
dex_was_up="no"
if [ "$ROOT" = "/" ] && systemctl is-active --quiet dex.service 2>/dev/null; then dex_was_up="yes"; systemctl stop dex.service; fi
umask 077
status=0
tar -czf "$archive" --exclude='home/clavarium/views' --exclude='home/clavarium/work-disks' --exclude='home/clavarium-mnt/views' --exclude='home/clavarium-mnt/work-disks' --exclude='*.tmp' -C "$note" BACKUP.txt -C "$(cd "$ROOT" && pwd)" "${parts[@]}" || status=$?
[ "$dex_was_up" = "no" ] || systemctl start dex.service
# (1: a file changed while it was read -- the copy is still whole.)
[ "$status" -le 1 ] || { rm -f -- "$archive"; refuse "the archive could not be written"; }
tar -tzf "$archive" >/dev/null || { rm -f -- "$archive"; refuse "the archive cannot be read back"; }

echo "archive     $archive ($(du -h "$archive" | cut -f1))"
if [ -s "$KEY" ]; then
    install -m 0600 "$KEY" "$TO/clavarium-$stamp.vault-key"
    echo "vault key   $TO/clavarium-$stamp.vault-key"
    echo "Keep these two files in two different places."
else
    echo "vault key   none yet (no secret was ever stored)"
fi
echo "Not in the backup: the conversations' machines. What must last belongs in an attached folder."
