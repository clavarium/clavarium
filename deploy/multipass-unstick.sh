#!/bin/bash
# MULTIPASS STOPPED AND STARTED FOR SURE (25-11, on a real server: after its update its daemon restarted, but its
# old dnsmasq -- the small server giving its machines their addresses -- stayed alive, still holding port 53; each new
# daemon died starting its own ("Address already in use"), systemd gave up ("Start request repeated too quickly"),
# and only a restart of the whole server freed it). Its daemon stopped; what stays of its dnsmasq in its control
# group ended; systemd's count of failed starts reset; started.
# Its machines left running by a daemon that died (qemu in its group, 25-11 on test-c: the new daemon cannot take
# them back -- "Failed to get shared write lock" on their disks -- and stays mute) are stopped too, step by step as
# a forced stop is (the host program's vm halt): asked to shut down from inside (with the VM manager's own key, a
# minute), then asked to end (10 s), then ended. Each step said; the server's watch then starts again those that ran.
# Run as root, by the host program (vm revive hard) and the updater (deploy/multipass-refresh.mjs).
set -u
UNIT=snap.multipass.multipassd.service
# Where the VM manager keeps its data (moved to another disk: its MULTIPASS_STORAGE), for its leases and its key.
DATA="/var/snap/multipass/common/data/multipassd"
MOVED_TO="$(sed -n 's/^Environment=MULTIPASS_STORAGE=\(\/[A-Za-z0-9/._-]*\)$/\1/p' /etc/systemd/system/$UNIT.d/override.conf 2>/dev/null | head -1)"
[ -n "$MOVED_TO" ] && [ -d "$MOVED_TO/data" ] && DATA="$MOVED_TO/data"
gone() { ! kill -0 "$1" 2>/dev/null; }
# A machine whose daemon died: shut down from inside, then asked to end, then ended.
halt_orphan() {
    local pid="$1" name="$2" ip i
    ip="$(awk -v n="$name" '$4 == n {print $3}' "$DATA/network/dnsmasq.leases" 2>/dev/null | tail -1)"
    if [ -n "$ip" ] && [ -r "$DATA/ssh-keys/id_rsa" ] && timeout 20 ssh -i "$DATA/ssh-keys/id_rsa" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 "ubuntu@$ip" sudo shutdown -h now >/dev/null 2>&1; then
        # Its system shuts down (about 20 s on a test machine); its qemu then waits, paused (Multipass starts it
        # with -no-shutdown): ended once its system is down.
        for i in $(seq 1 45); do gone "$pid" && break; ping -c 1 -W 1 "$ip" >/dev/null 2>&1 || { [ "$i" -ge 5 ] && break; }; sleep 1; done
        gone "$pid" || sleep 8   # its network goes before its disks are done
        kill -TERM "$pid" 2>/dev/null || true
        for i in $(seq 1 10); do gone "$pid" && break; sleep 1; done
        gone "$pid" || kill -KILL "$pid" 2>/dev/null || true
        echo "  $name: shut down from inside"; return
    fi
    kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 10); do gone "$pid" && { echo "  $name: asked to end"; return; }; sleep 1; done
    kill -KILL "$pid" 2>/dev/null || true
    echo "  $name: ended"
}
timeout 120 snap stop multipass.multipassd >/dev/null 2>&1 || true
for procs in "/sys/fs/cgroup/system.slice/$UNIT/cgroup.procs" "/sys/fs/cgroup/systemd/system.slice/$UNIT/cgroup.procs"; do
    [ -r "$procs" ] || continue
    for pid in $(cat "$procs" 2>/dev/null); do
        comm="$(cat "/proc/$pid/comm" 2>/dev/null)"
        case "$comm" in
            dnsmasq) echo "its old dnsmasq ended ($pid)"; kill -KILL "$pid" 2>/dev/null || true ;;
            qemu-system-*) name="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -o 'instances/[a-z0-9-]*' | head -1 | cut -d/ -f2)"
                           echo "a machine left by the dead daemon, stopped: ${name:-?} ($pid)"; halt_orphan "$pid" "${name:-?}" ;;
        esac
    done
done
pkill -KILL -x multipassd 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true
sleep 2
timeout 120 snap start multipass.multipassd
