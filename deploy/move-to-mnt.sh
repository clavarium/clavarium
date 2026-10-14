#!/bin/bash
# ---------------------------------------------------------------------------
# ONCE, FROM AN EARLIER VERSION: what the machines are given moves from the
# data directory to $MNT. Run by install.sh, as root, with the server stopped.
#
#   move-to-mnt.sh --data DIR --mnt DIR --host PROGRAM [--node NODE]
#
# WHY. The data directory belongs to the server's account: a compromised
# server could swap any of its directories for a link between a check of the
# host program and the moment root mounts, unmounts or moves something there.
# So the folders (resources/), their read-only views (views/), the work
# folders and their disks (work/, work-disks/) and what was put aside
# (removed/) now live under $MNT, a chain root owns from / down (see
# clavarium-host, "held"). The server's own files stay where they are.
#
# HOW, in order -- nothing is moved before every check passed:
#   1. a name found on both sides refuses the whole move: it is sorted out
#      by hand, never overwritten;
#   2. the machines let go of what they had from the old places (their
#      mounts are noted first), the views are closed, the work disks
#      unmounted: a running tool sees its /work disappear for a moment;
#   3. the entries are MOVED, never copied: the same files, the same owners
#      (a work folder that held files outside its disk keeps them: they go
#      into the disk when it is made again);
#   4. through the host program, from the new places, each machine is given
#      back what it had: the view made, the work disk mounted, then shown. A
#      mount that cannot be made again is said, not fatal: the machine gets
#      it when it is built again, or when the folder is attached again.
#
# $MNT and its directories must exist (install.sh makes them, root's).
# Exit codes: 0 done (or nothing to do); 64 bad parameters; 78 refused,
# nothing moved.
# ---------------------------------------------------------------------------
set -euo pipefail

bad() { echo "move-to-mnt: $*" >&2; echo "usage: move-to-mnt.sh --data DIR --mnt DIR --host PROGRAM [--node NODE]" >&2; exit 64; }
refuse() { echo "move-to-mnt: REFUSED: $*" >&2; exit 78; }
say() { echo "move-to-mnt: $*"; }

DATA=""; MNT=""; HOST=""; NODE="node"
while [ $# -gt 0 ]; do
    case "$1" in
        --data) DATA="${2:-}"; shift 2 || bad "--data needs a value" ;;
        --mnt) MNT="${2:-}"; shift 2 || bad "--mnt needs a value" ;;
        --host) HOST="${2:-}"; shift 2 || bad "--host needs a value" ;;
        --node) NODE="${2:-}"; shift 2 || bad "--node needs a value" ;;
        *) bad "unknown parameter: $1" ;;
    esac
done
[ -n "$DATA" ] && [ -n "$MNT" ] && [ -n "$HOST" ] || bad "--data, --mnt and --host are needed"
case "$DATA$MNT" in *[!A-Za-z0-9/._-]*|*..*) bad "a path with an unexpected character" ;; esac
[ "$DATA" != "$MNT" ] || bad "the data directory and MNT are the same place"

DIRS="resources views work work-disks removed"
todo="no"
for d in $DIRS; do
    old="$DATA/$d"
    if [ -L "$old" ]; then refuse "$old is a link: it is never followed; look at it by hand"; fi
    [ -d "$old" ] && todo="yes"
    [ -d "$MNT/$d" ] && [ ! -L "$MNT/$d" ] || refuse "$MNT/$d must exist (install.sh makes it)"
done
[ "$todo" = "yes" ] || exit 0

# 1. Nothing moved over something already there.
for d in resources work work-disks removed; do
    [ -d "$DATA/$d" ] || continue
    for entry in "$DATA/$d"/* "$DATA/$d"/.[!.]* "$DATA/$d"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        name="${entry##*/}"
        if [ -e "$MNT/$d/$name" ] || [ -L "$MNT/$d/$name" ]; then
            refuse "$DATA/$d/$name and $MNT/$d/$name both exist: move one by hand, then install again"
        fi
    done
done

# 2. What the machines have from the old places: noted, then let go.
list="$(mktemp)"
trap 'rm -f -- "$list"' EXIT
# One line per mount: machine, target, kind, name, uid, gid. JSON is read
# by Node.js (installed with the server), never by hand.
PARSE='
const data = process.argv[1];
let j; try { j = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(0); }
const plain = data.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`^${plain}/(resources|views|work)/([a-z]([a-z0-9-]{0,30}[a-z0-9])?)$`);
const first = (l) => String((Array.isArray(l) ? l[0] : "") ?? "").split(":")[0];
for (const [vm, info] of Object.entries(j?.info ?? {})) {
    for (const [target, m] of Object.entries(info?.mounts ?? {})) {
        const x = re.exec(String(m?.source_path ?? ""));
        if (!x) continue;
        const kind = x[1] === "resources" ? "folder" : x[1] === "views" ? "view" : "work";
        console.log([vm, target, kind, x[2], first(m.uid_mappings), first(m.gid_mappings)].join("\t"));
    }
}'
vms="$(multipass list --format csv 2>/dev/null | cut -d, -f1 | grep -E '^clv-[a-z]([a-z0-9-]{0,30}[a-z0-9])?$' || true)"
for vm in $vms; do
    multipass info "$vm" --format json 2>/dev/null | "$NODE" -e "$PARSE" "$DATA" >> "$list" || true
done
while IFS=$'\t' read -r vm target kind name uid gid; do
    [ -n "$vm" ] || continue
    say "$vm lets go of $target for a moment"
    multipass umount "$vm:$target" >/dev/null 2>&1 || say "$vm: $target could not be let go of (it is shown again below)"
done < "$list"
if [ -d "$DATA/views" ]; then
    for at in "$DATA/views"/*; do
        [ -e "$at" ] || continue
        if mountpoint -q "$at"; then umount "$at"; fi
    done
fi
if [ -d "$DATA/work" ]; then
    for at in "$DATA/work"/*; do
        [ -e "$at" ] || continue
        if mountpoint -q "$at"; then umount "$at"; fi
    done
fi

# 3. Moved. Views are mirrors, made again from the folders: their empty
# mount points are only removed.
if [ -d "$DATA/views" ]; then
    find "$DATA/views" -mindepth 1 -maxdepth 1 -type d -empty -delete
    rmdir "$DATA/views" 2>/dev/null || refuse "$DATA/views still holds something that is not an empty view: look at it by hand"
fi
for d in resources work work-disks removed; do
    [ -d "$DATA/$d" ] || continue
    find "$DATA/$d" -mindepth 1 -maxdepth 1 -exec mv -n -t "$MNT/$d" {} +
    rmdir "$DATA/$d" || refuse "$DATA/$d is not empty after the move: look at it by hand"
    say "$DATA/$d moved to $MNT/$d"
done

# 4. Each machine given back what it had, from the new places.
while IFS=$'\t' read -r vm target kind name uid gid; do
    [ -n "$vm" ] || continue
    [[ "$uid" =~ ^[0-9]{1,6}$ ]] && [[ "$gid" =~ ^[0-9]{1,6}$ ]] || { say "$vm: $target is not shown again (unexpected owner mapping): build the machine again"; continue; }
    ok="yes"
    case "$kind" in
        view) "$HOST" view make "$name" >/dev/null || ok="no" ;;
        work) "$HOST" work make "$name" >/dev/null || ok="no" ;;
    esac
    if [ "$ok" = "yes" ]; then "$HOST" vm mount "$vm" "$kind" "$name" "$uid" "$gid" >/dev/null || ok="no"; fi
    if [ "$ok" = "yes" ]; then say "$vm: $target shown again"; else say "$vm: $target could NOT be shown again: build the machine again, or attach the folder again"; fi
done < "$list"
exit 0
