# The update incident of 19-10, and how it was closed

**Closed.** 0.2.1 stable on 20-10 (the operator's server updated from 0.1.5 by the Update
button, `done`); 0.2.2 stable the same day.

## What happened
The operator's server, on 0.1.5, updated to 0.2.0: "its service stopped", and the return to
0.1.5 failed the same way. Every request through the sign-in got a 502; a reboot of the
machine cured it. No log of the machine was kept, so the exact cause on that machine is not
proven.

## The cause found on a test machine
A read-only view (bindfs, FUSE) whose program is gone stays mounted and answers "Transport
endpoint is not connected". At its start, the server of 0.1.5 and 0.2.0 tried to make the view
again, failed, and exited; systemd started it again and again. Only a reboot took the broken
mount off. This gives exactly the history of the incident. A process left holding the
server's port (EADDRINUSE) gives it too, and was reproduced as well.

## What changed
- 0.2.1: the updater's watchdog, the log of the service kept in the history ("See the log"),
  reset-failed, a drop-in so that a crash loop never locks the service out, the server listens
  even when the host program or the VM manager hangs.
- 0.2.1 (next.2): `clavarium-host mounts repair` takes broken views off; asked by the server at
  its start and by the updater after each stop. The watchdog acts at the first timer turn on a
  service that systemd keeps starting, restarts the release that runs first, and goes back to
  the release before only if that restart does not bring it back.
- Proven on test machines: 0.1.5 -> 0.2.1 by the Update button, clean and with a view broken at
  the moment of the click, `done`; the test deployment updated by its own timer; acceptance 22/22.

## Found on the way, fixed
- `install.sh`: going online from local mode stopped at the edge (no Caddyfile yet, pipefail).
- A device kept a terminal it had been taken back while it was open; a conversation named and
  not given to a pairing was answered with its first one.
- The pre-push hook, run in a fresh copy (as Clavarium runs it before sending): dependencies
  installed, the tools folder made, git's own variables not passed to the tests.
- Tools start through a launcher of their own (config/launch); the key Claude Code trusts only
  in its settings file is written there.
- Chat: a long short version kept whole (Parley 0.10.1); a picture the person attached shown
  in their own message.

## Rule kept
Next first (a "-" version), the test deployment updated by its own timer, acceptance 22/22,
then stable only with the operator's word.
