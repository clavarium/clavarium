#!/bin/bash
# ---------------------------------------------------------------------------
# ALL THE MACHINES TO ANOTHER DISK: the whole storage of the VM manager
# (Multipass), its disks and its images, moved in Multipass's own documented
# way -- never one machine alone.
#
#   sudo bash deploy/move-machines.sh --to /mnt/disk2/machines [--dry-run]
#
# In order, and nothing is lost on the way: the originals are COPIED, never
# moved, and stay where they are until you remove them yourself.
#   1. checks: root; the place under /mnt, /media or /home (the VM manager is
#      confined to those); empty or absent; room for everything, and 10 % more;
#   2. Clavarium stopped (nothing starts a machine meanwhile), every machine
#      stopped, then the VM manager;
#   3. copied: <path>/data and <path>/cache; the paths the VM manager wrote in
#      its two files of instances changed to the new place;
#   4. the VM manager told where (MULTIPASS_STORAGE, in a drop-in of its
#      service), started, and asked for its machines: the same names must come
#      back. If not, everything is put back as it was and said;
#   5. Clavarium started again: its conversations start their machines as
#      they are opened.
# Then: once all works, the old copy can go:
#   sudo rm -rf /var/snap/multipass/common/data/multipassd/vault /var/snap/multipass/common/cache/multipassd
#
# Exit codes: 0 done (or would be, --dry-run); 64 bad parameters; 78 refused,
# nothing changed; 1 failed and put back.
# ---------------------------------------------------------------------------
set -euo pipefail

OLD="/var/snap/multipass/common"
DROP_DIR="/etc/systemd/system/snap.multipass.multipassd.service.d"
DROP="$DROP_DIR/override.conf"
MULTIPASS="/snap/bin/multipass"

bad() { echo "move-machines: $*" >&2; echo "usage: sudo bash deploy/move-machines.sh --to /mnt/DISK/PLACE [--dry-run]" >&2; exit 64; }
refuse() { echo "move-machines: REFUSED: $*" >&2; exit 78; }
say() { echo "== $*"; }

TO=""; DRY="no"
while [ $# -gt 0 ]; do
    case "$1" in
        --to) TO="${2:-}"; shift 2 || bad "--to needs a place" ;;
        --dry-run) DRY="yes"; shift ;;
        *) bad "unknown: $1" ;;
    esac
done
[ -n "$TO" ] || bad "--to is needed"
case "$TO" in /mnt/?*|/media/?*|/home/?*) : ;; *) refuse "the VM manager can only keep its machines under /mnt, /media or /home: $TO" ;; esac
[[ "$TO" =~ ^/[A-Za-z0-9/._-]+$ ]] && [[ "$TO" != *..* ]] || refuse "a plain path, please: $TO"
TO="${TO%/}"
[ "$(id -u)" -eq 0 ] || refuse "run it as root (sudo)"
[ -f "$DROP" ] && grep -q '^Environment=MULTIPASS_STORAGE=' "$DROP" && refuse "the machines were moved already (see $DROP): move them back first"
[ -d "$OLD/data/multipassd" ] || refuse "no storage of the VM manager in $OLD"
if [ -e "$TO" ] && [ -n "$(ls -A "$TO" 2>/dev/null)" ]; then refuse "$TO is not empty"; fi

parent="$TO"; while [ ! -d "$parent" ]; do parent="$(dirname "$parent")"; done
need_mb=$(( $(du -smx "$OLD/data/multipassd" "$OLD/cache/multipassd" 2>/dev/null | awk '{s+=$1} END{print s+0}') * 11 / 10 + 512 ))
free_mb="$(df -Pm -- "$parent" | awk 'NR==2 {print $4}')"
[ "$(stat -c %d "$parent")" != "$(stat -c %d "$OLD")" ] || refuse "$TO is on the disk the machines are on already"
say "the machines take about $(( need_mb / 1024 )) GB with the margin; $parent has $(( free_mb / 1024 )) GB free"
[ "$free_mb" -ge "$need_mb" ] || refuse "not enough room on $parent: $free_mb MB free, $need_mb MB needed"
if [ "$DRY" = "yes" ]; then
    say "would stop Clavarium and every machine, copy $OLD/data/multipassd to $TO/data and $OLD/cache/multipassd to $TO/cache, write $DROP, start again"
    exit 0
fi

was_running="$(systemctl is-active clavarium.service 2>/dev/null || true)"
names_before="$("$MULTIPASS" list --format csv 2>/dev/null | tail -n +2 | cut -d, -f1 | sort | tr '\n' ' ')"
put_back() {
    echo "move-machines: putting everything back as it was" >&2
    snap stop multipass >/dev/null 2>&1 || true
    rm -f -- "$DROP"; systemctl daemon-reload
    snap start multipass >/dev/null 2>&1 || true
    [ "$was_running" = "active" ] && systemctl start clavarium.service || true
    echo "move-machines: back on $OLD; the copy in $TO is left for you to look at, or to remove" >&2
    exit 1
}

say "stopping Clavarium, then every machine, then the VM manager"
systemctl stop clavarium-update.timer clavarium.service 2>/dev/null || true
timeout 600 "$MULTIPASS" stop --all || echo "   (a machine did not stop cleanly: the VM manager stops it)"
snap stop multipass
case "$TO" in /mnt/*|/media/*) snap connect multipass:removable-media 2>/dev/null || true ;; esac

say "copying (the originals stay where they are)"
mkdir -p -- "$TO"; chown root:root -- "$TO"; chmod 0755 -- "$TO"
cp -a -- "$OLD/data/multipassd" "$TO/data" || put_back
cp -a -- "$OLD/cache/multipassd" "$TO/cache" 2>/dev/null || mkdir -p -- "$TO/cache"
# The two files where the VM manager wrote where its machines are.
for f in "$TO/data/multipassd-vm-instances.json" "$TO/data/vault/multipassd-instance-image-records.json"; do
    [ -f "$f" ] || continue
    sed -i -e "s#$OLD/data/multipassd#$TO/data#g" -e "s#$OLD/cache/multipassd#$TO/cache#g" -- "$f" || put_back
done

say "the VM manager on $TO"
mkdir -p -- "$DROP_DIR"
printf '[Service]\n# Written by Clavarium (deploy/move-machines.sh): where the machines are.\nEnvironment=MULTIPASS_STORAGE=%s\n' "$TO" > "$DROP"
systemctl daemon-reload
snap start multipass || put_back
for _ in $(seq 1 60); do "$MULTIPASS" list >/dev/null 2>&1 && break; sleep 2; done
names_after="$("$MULTIPASS" list --format csv 2>/dev/null | tail -n +2 | cut -d, -f1 | sort | tr '\n' ' ')" || names_after=""
if [ "$names_after" != "$names_before" ]; then echo "move-machines: the VM manager does not list the same machines: before [$names_before], now [$names_after]" >&2; put_back; fi

say "Clavarium started again: its conversations start their machines as they are opened"
systemctl start clavarium.service clavarium-update.timer 2>/dev/null || true
echo
echo "Done: the machines are on $TO ($(df -h --output=avail "$TO" | tail -1 | tr -d ' ') free there)."
echo "Once everything works, the old copy can go:"
echo "    sudo rm -rf $OLD/data/multipassd/vault $OLD/cache/multipassd"
