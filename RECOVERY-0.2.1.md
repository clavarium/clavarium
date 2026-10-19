# 0.2.1 recovery work (branch `recovery-0.2.1`)

**HOLD: nothing from this branch is published without the operator's explicit word.**
Path when cleared: `0.2.1-next.1` to npm `next` (push to main with a "-" version), test-c
(channel next) takes it BY ITS OWN 0.2.0 updater timer after its service is put in the failed
state, then the full acceptance suite on test-c (22/22), and only then, with the operator's
word, 0.2.1 stable.

## Evidence from production (update 0.1.5 -> 0.2.0)
- Settings > Updates history: "0.2.0: its service stopped" within the 60 s health window, AND the
  rollback failed: "0.1.5 did not come back either (its service stopped)".
- A physical reboot fixed everything; production runs 0.1.5 again.
- So both versions died right after their restart; a reboot cured it: an environmental,
  transient cause common to both. Not reproduced from 0.1.5 data (locally, test-c).
- test-c rehearsal (0.2.0): a conversation put to sleep through Clavarium, then a restart of
  clavarium.service: the server came back at once, multipass answered, no hang (the machine was
  woken by an open page's terminal reconnecting, which is the normal behaviour).
- Observed on test-c: the bindfs processes of the read-only views (FUSE) live in
  clavarium.service's cgroup, so a stop of the service kills them under the machines' mounts.

## Hypotheses (unproven)
1. The old server did not die on stop (uninterruptible I/O, e.g. on a FUSE/bindfs view or a
   multipass call), kept the port: the new one fails to listen (EADDRINUSE) and exits; the same
   for 0.1.5 on rollback. A reboot clears the stuck process.
2. multipassd wedged (calls hang), cleared by the reboot.
3. Memory/disk pressure during the switch (backup, npm install).

## Done (on this branch, `npm run check` green before the last additions; see below)
- Updater (deploy/updater.mjs), with unit tests (test/updater.test.mjs):
  - busy(): conversation phases ignored when clavarium.service is not active, and any busy phase
    older than 30 min (logged).
  - WATCHDOG at each timer turn: service failed/inactive, or no answer on 3 turns in a row:
    after an update < 24 h old with the previous release kept (and able to read the data), back
    to it by itself ("did not stay up: back to X", not tried again by itself); otherwise one
    restart; at most one automatic action per hour.
  - Health after a switch: comes up within 60 s, then watched until 2 min after the restart; one
    systemd restart forgiven if it answers at the end, not two.
  - A stale lock whose pid is gone is taken over (EPERM counts as alive).
  - Restart = reset-failed, stop, then what is left of the old server (unit cgroup, or holding the
    port, via ss) is killed; a process in state D holding the port is said precisely ("a stuck
    process holds the port: pid N, state D ... the server needs a reboot") instead of starting.
  - On a failed update, rollback or watchdog action: `systemctl status`, `ss -ltnp` on the port,
    the leftover processes and their state, and `journalctl -u clavarium -n 80` are kept in the
    history entry (`log`); Settings > Updates shows "See the log" on that line.
  - Drop-in /etc/systemd/system/clavarium.service.d/restart.conf (StartLimitIntervalSec=0,
    RestartSec=3), written by the updater at each turn and at each switch.
  - tick() read the OLDEST history entry for its result message: fixed (newest).
- Server:
  - Start: the host steps (views, /tools, work disks, network rules) are waited for 20 s at most;
    the server listens and serves its pages even if the host program or multipass hangs; a
    machine that starts waits for them.
  - EADDRINUSE: a clear line ("port N is in use by another process ...") then exit 1.
  - unhandledRejection logged, not fatal.
  - server/vmwatch.mjs (+ test): `vm ping` every minute; not answering: the pages say "The machines
    cannot be reached just now"; stuck 5 min: `vm revive` (snap restart multipass.multipassd)
    ONCE, recorded, owner alerted; not again within 6 h.
  - Host program: new verbs `vm ping` (timeout 25 multipass list) and `vm revive`.
  - Startup reconcile of busy phases already existed (conversations.mjs constructor): unchanged.

## Remains
- Full `npm run check` on the last additions (log capture, reset-failed, drop-in, EADDRINUSE).
- Rehearsal on test-c through `next`, acceptance 22/22, then the operator's word for stable.
- Note: the changes help only once 0.2.1 runs; the update that brings it is applied by 0.2.0's
  updater (old busy(), 60 s health, plain restart).
