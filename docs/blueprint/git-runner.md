# The git runner and the single reference repository

Design note, step A1 of the git chantier validated on 14-10, revised after
two reviews (section 21). No code is changed by this note. Target: git 2.43.0
and systemd 255 (Ubuntu 24.04). "Trial" means a command actually run on the
development box on 14-10 (section 20); "to check in a trial" marks a design
point not yet run; everything else is design.

## 1. The problem, in one paragraph

Today the server runs git as its own account on `resources/<name>`, the
folder the agent writes (`GitReview.#copy`: `git clone --bare --no-local
file://<folder>` with `safe.directory=*`). Git follows whatever that folder's
`.git` points to: a gitfile (`gitdir: /elsewhere`), a `.git` symlink,
`commondir`, `objects/info/alternates`. So the agent can make the server copy
any other repository the server can read, and show or push it. And any git
parser bug triggered by agent-written bytes runs as the account that holds
the vault and the keys. Reproduced in the trial: a folder holding only
`.git` = `gitdir: <other repo>` made the server's git print the other
repository's commit.

## 2. The rule, and what it does not remove

**The server never runs git on a path the agent can write.** The agent's
repository layout is read only by git running in a throw-away sandbox,
started by the root host program, that sees nothing but that one folder,
read-only, with no network and no rights. What comes out is a byte stream
that the server treats as hostile input: header parsed strictly in Node
under a byte bound, pack imported with `index-pack --strict` into a fresh
empty repository. Only then are its branches moved into the reference
repository, under a namespace of their own.

**Remaining risk, stated plainly.** The server account still parses the
agent's pack and objects: index-pack and landing at import, then review
diff, merge-base and gc. A memory-safety bug in those git parsers runs with
the vault. The surface shrinks from "repository layout plus everything git
reads" to git's hardened receive-side parsers (the ones every forge exposes
on push); it is reduced, not removed (section 18). Every server-side git
command runs under a deadline and a memory, CPU and task bound, per command
and in total (section 9), because pack byte caps do not bound inflated size.

## 3. Layout

**Two trees.** `$DATA` (server-owned) keeps the server's own state, vault
aside, and `git-import/`. Everything root mounts from, mounts onto or
loop-attaches is under **`$MNT`** (`/home/clavarium-mnt`, in `host.conf`),
root:root 0755: `resources/`, `views/`, `work/`, `work-disks/`, `worktrees/`,
`worktree-disks/`, `removed/`. The server cannot rename or replace any
component of a path there, only change the contents of the leaves it owns
(section 4, `held`). `$MNT` is under `/home` so the multipass snap reaches it
as it reaches `$DATA` today (to check in a trial). Both are on the same file
system by default; the floor `F` (section 8) is checked on each.

One **reference repository** per repository asset. It is the existing mirror
`$MNT/resources/<name>-origin` (bare, written only by the server, shown in
machines read-only through its bindfs view at
`/resources/<originFolder(name)>`). Created with `--object-format=sha1`.

| Refs in the reference | Written by | From |
|---|---|---|
| `refs/heads/*` | refresh (arrow 1), and after a push (section 12) | GitLab |
| `refs/agents/<conversation>/*` | import (arrow 3) | that conversation's folder |
| `refs/shared/*` | import | the shared folder (option below) |
| `refs/clavarium/rewritten/<branch>/<UTC>`, `refs/clavarium/before/*`, `refs/clavarium/incoming/*` | refresh, push, landing | old tips kept; transient work refs (sections 8, 10) |

The prefixes never overlap; no conversation name can produce `refs/shared/`.
Each writer touches only its own prefix. Tags are neither fetched nor
imported (`--no-tags`), as today. Below, `<dest>` is `refs/agents/<conv>` or
`refs/shared`.

**One writer per reference.** One server mutex per reference covers every
write to it and everything gc can disturb: refresh with its before/rewritten
refs (one critical section), each landing, ref cleanup, gc, and the
re-check + push + `update-ref` of section 12. Reviews take it too (they are
short). It replaces `GitKeeper`'s per-name refresh de-duplication and
`GitReview.#locked`. Since the server is the only writer, leftover lock files
(`refs/**/*.lock`, `packed-refs.lock`, `shallow.lock`, `config.lock`,
`HEAD.lock`, and `objects/pack/tmp_*`, `.tmp-*`) are removed and logged at
server start, on every acquire of the mutex, and after any git on the
reference ends by signal, OOM or deadline.

**Default branch.** Each refresh reads GitLab's with `git ls-remote --symref
-- <remote> HEAD` and sets the reference's `HEAD` to it (`symbolic-ref`). A
repository without GitLab keeps `main`.

**One folder per writing agent (default).** A conversation attached in
*write* gets its own working repository `$MNT/worktrees/<name>/<conv>`, a
**fixed-size, fully allocated disk** (`WORKTREE_MB` in `host.conf`; section
4), mounted in its machine at `/resources/<name>` (same path as today).
Attribution is real: only that machine writes that folder. A new folder is
refused unless free − `R` ≥ `WORKTREE_MB` + `F` (section 8) and the reference
fits the disk. The server fills it **once, before its first mount**: `worktree
make <name> <conv> new`, then (forced options of section 9):

```
git clone --quiet --no-local --no-hardlinks --no-tags -- <reference> <folder>
git -C <folder> remote set-url origin /resources/<originFolder(name)>
git -C <folder> switch --quiet -c agent/<conv> origin/<default>   # or --orphan agent/<conv> if absent
```

The server records "filled" in its store only after the last step; a folder
not recorded as filled is never mounted. A failed fill runs `worktree aside`
and a fresh `new`, at most 3 times in a row per (repository, conversation);
then it stops, alerts the owner and shows "could not prepare the folder"
until a manual retry. The agent pulls from the reference itself (arrow 2)
with `git fetch origin`. Cost: one full clone per writer; the page shows
writers x (repository size + headroom) against free space before the owner
switches a repository to this mode.

**Server start.** Before any read or mount: `git sweep` (section 4), then
`worktree make <name> <conv> again` for every folder recorded as filled
(attached or not). A folder whose disk cannot be mounted again is reported
(section 15), never read, mounted, put aside or refilled automatically.

**Option "one shared folder"** (operator, per repository): writers share
`$MNT/resources/<name>` as today (unbounded on the host disk, as today:
section 18); its branches land under `refs/shared/*`, and the page says they
cannot be told apart by agent. Existing repositories start in this mode.
**Switching** to per-agent folders is refused while a write-attached machine
of that repository runs (the page says why). On switch, pending reviews of
`refs/shared/*` are closed; `refs/shared/*` is removed with the shared
folder.

A *read* attachment shows only the reference, read-only. Consequence, stated
in the page: every conversation attached to a repository can fetch the
`refs/agents/*` of the others (that is how they work together); nothing of
another repository is ever in the reference.

**Worktrees inside a folder.** `git worktree add` writes gitfiles with
machine paths (`/resources/<name>/.git/worktrees/x`). The sandbox mounts the
folder at that same path, so they resolve, only inside the folder. One read
covers all worktrees (branches are shared); section 13 says what triggers it.

## 4. Host program verbs

Added to `deploy/clavarium-host`, in its style: fixed argument count, every
name checked with `is_name`, every path built here from names. The git
argument vector and the sandbox property list are **fixed in the host
program** (one function, shared by `git read` and `git selftest`).

**`held <path>`**, used by every verb that mounts, binds or loop-attaches,
including the existing `vm mount folder|view|work` and `work make`: each
component from `/` is a real directory (not a link), owned by root, not
writable by group or other; only the leaf may be the server's (a shared
folder, the root of a disk). An image must be a regular file, root's, 0600.
Since no component can then be changed by the server, the path that `mount`,
systemd or multipassd walk again later is the one checked: no fd binding or
staging path is needed (`mount --bind /proc/self/fd/N` re-walks a resolved
path anyway, trial).

| Verb | Arguments | Checks, then action |
|---|---|---|
| `git read` | `<name> <id>` | `is_name <name>`; `<id>` is `-` (shared folder) or `is_name`. Source = `$MNT/worktrees/<name>/<id>`, which must be a mountpoint, or for `-` `$MNT/resources/<name>`; `held`. Refused (78) if stdout or stderr is a terminal; if `git --version`, `systemctl --version` or `uname -r` differs from `/var/lib/clavarium/runner-ok` ("reads off until re-tested"); or if `clvread-<name>_<id>` is active, activating or deactivating. Otherwise `systemctl reset-failed` on it (errors ignored). `exec 0</dev/null`; a trap on EXIT and TERM stops the unit, reads its result, then `reset-failed`. Runs `systemd-run` (section 5) **as a child** and maps the unit's `Result`/`ExecMainCode`/`ExecMainStatus` (`systemctl show`, never systemd-run's exit status or stderr; a unit collected after a clean exit: to check in a trial) to: 0 git ok; 65 git exited 128; 66 git exited otherwise; 78 refused before start; 79 unit did not start; 80 time limit; 81 memory limit; 82 other kill. It exits with no other code. Stdout = the bundle; stderr = git's messages. |
| `git stop` | `<name> <id>` | Same name checks; `systemctl stop`, then `reset-failed` (errors ignored). |
| `git sweep` | none | Stop and `reset-failed` every `clvread-*` unit. |
| `git selftest` | none | Runs the root-owned `/usr/lib/clavarium/runner-selftest` (the in-unit probes of real tests 1-2, section 19) in a unit built from the same property list, on the root-owned canary `/var/lib/clavarium/runner-canary`. On pass writes `runner-ok` (root, 0644) with the three versions; exit 0 pass, 1 fail. Also run by `install.sh` and an apt `DPkg::Post-Invoke` hook. |
| `worktree make` | `<name> <id> new\|again` | `is_name` both; `held` on `$MNT/worktrees/<name>` and `$MNT/worktree-disks/<name>` (made root:root if missing); image `<id>.img`. **`new`**: refused if the image exists; built as `.new` (`fallocate -l ${WORKTREE_MB}M`, `mkfs.ext4 -q -m 0 -E root_owner=<server uid:gid>`), renamed, mounted, `rmdir lost+found`; refused if the disk root is then not empty. **`again`**: no image and the entry a non-empty plain directory (a restored backup): its files go into a new disk, as `work make` does; no image otherwise: refused ("disk missing"). Image present: `held`, `e2fsck -p` (exit over 1: refused), mounted if the entry is not a mountpoint (then it must be an empty plain directory), `rmdir lost+found` (errors ignored); already mounted: nothing. Mount options `loop,nosuid,nodev` (no `discard`: the image stays allocated). |
| `worktree aside` | `<name> <id>` | Unmount, move image and entry to `$MNT/removed/<name>.<id>-<UTC>-<pid>` (as `folder aside`). |
| `vm mount ... worktree` | `<vm> worktree <name> <uid> <gid>` | `<vm>` must be `clv-<id>` for `$MNT/worktrees/<name>/<id>`: a folder goes to its own machine only. Must be a mountpoint; `held`. Target `<vm>:/resources/<name>`. |

`_` separates the names in the unit name because names cannot contain it.
`work make` also switches to `fallocate` and drops `discard`. `install.sh`
creates `$MNT` and its directories root:root 0755 (`worktree-disks/<name>`
0700), moves `resources/`, `views/`, `work/`, `work-disks/`, `removed/` there
from `$DATA` (server stopped, mounts closed first; the server's
`--mounted $MNT` and every path follow), writes `MNT` to `host.conf`, and
creates the empty sandbox root `/var/lib/clavarium/runner-root` (root:root
0755, outside every bound tree), the canary, the self-test script and the apt
hook. systemd creates the bind mountpoints in the sandbox root
(`/resources/<name>`); they stay, empty and root-owned, so a sandbox sees the
**names** of repositories read before, never their content. `backup.sh` and
`restore.sh` take `$MNT` without `views`, `work-disks`, `worktree-disks` (tar
crosses mountpoints, so folder contents are kept), and `restore.sh` makes
`$MNT`'s directories root-owned. The server spawns the host program with
stdin `ignore`. Sudo's syslog line for `git read` is turned off in sudoers;
the server's log keeps reads.

## 5. The sandbox

Command run by `git read` (`$SRC` = the `held` source, `$N` = name):

```
systemd-run --quiet --wait --pipe --service-type=exec \
  --unit="clvread-${N}_${ID}" \
  -p DynamicUser=yes \
  -p RootDirectory=/var/lib/clavarium/runner-root \
  -p MountAPIVFS=no -p PrivateDevices=yes -p PrivateTmp=yes \
  -p TemporaryFileSystem="/tmp:ro /var/tmp:ro /dev/shm:ro" \
  -p InaccessiblePaths="-/dev/mqueue -/dev/hugepages -/dev/pts -/dev/ptmx" \
  -p BindReadOnlyPaths="/usr /usr/bin:/bin /usr/lib:/lib /usr/lib64:/lib64 $SRC:/resources/$N" \
  -p PrivateNetwork=yes -p RestrictAddressFamilies=AF_UNIX -p PrivateIPC=yes \
  -p ProtectHostname=yes -p ProtectClock=yes -p ProtectKernelTunables=yes \
  -p ProtectKernelModules=yes -p ProtectKernelLogs=yes -p ProtectControlGroups=yes \
  -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p AmbientCapabilities= \
  -p RestrictNamespaces=yes -p RestrictSUIDSGID=yes -p RestrictRealtime=yes \
  -p LockPersonality=yes -p MemoryDenyWriteExecute=yes \
  -p SystemCallArchitectures=native -p SystemCallFilter=@system-service \
  -p "SystemCallFilter=~@aio @keyring @setuid @chown @memlock @mount @privileged @resources userfaultfd kcmp process_vm_readv process_vm_writev" \
  -p SystemCallErrorNumber=EPERM \
  -p RuntimeMaxSec=300 -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=8 \
  -p CPUQuota=100% -p Nice=10 -p IOWeight=20 \
  -p LimitFSIZE=0 -p LimitCORE=0 -p LimitNOFILE=256 -p UMask=0077 \
  -p WorkingDirectory=/resources/$N \
  -E PATH=/usr/bin -E HOME=/nonexistent -E XDG_CONFIG_HOME=/nonexistent \
  -E GIT_CONFIG_NOSYSTEM=1 -E GIT_CONFIG_GLOBAL=/dev/null -E LC_ALL=C \
  -E GIT_CEILING_DIRECTORIES=/resources -E GIT_NO_LAZY_FETCH=1 \
  -E GIT_TERMINAL_PROMPT=0 -E GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c safe.directory=/resources/$N -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false -c core.pager=cat -c core.alternateRefsCommand= \
    -c protocol.allow=never -c pack.threads=1 -c pack.windowMemory=256m \
    bundle create - --branches
```

To check in a trial on 255: the `TemporaryFileSystem`/`InaccessiblePaths`
lines with `DynamicUser` inside `RootDirectory` (stacking over the implied
`PrivateTmp`), that `bundle create -` needs no writable `/tmp`, and that git
starts with the extra syscall exclusions (else an allowlist from `strace`).
No `--collect`: the host program reads the result, then `reset-failed`; a
failed unit left loaded blocks its name ("already loaded", trial), hence
`reset-failed` before each start and `git sweep` at server start.
`StandardInput=null` is not used: `--pipe` overrides it (trial); stdin is
`/dev/null` because the host program redirects it.

| Setting | Why |
|---|---|
| root host program, `systemd-run` | Building namespaces needs root. Unprivileged bwrap is out: Ubuntu 24.04 restricts user namespaces through AppArmor (`apparmor_restrict_unprivileged_userns=1`). systemd is already there. |
| `DynamicUser=yes` | A fresh uid (61184–65519) per run, owning nothing, released at the end. Not the server's uid: a same-uid process could signal or `ptrace` the server. |
| `RootDirectory=` empty dir + binds | **Not `TemporaryFileSystem=/`**: with `DynamicUser=yes` (implies `ProtectSystem=strict`) it left the whole host root visible on 255 (trial). With an empty `RootDirectory`, the trial saw only the binds plus empty mountpoints. |
| binds `/usr`, `/bin`, `/lib`, `/lib64` | Git, its helpers and libc; on 24.04 the last three are links into `/usr`. Nothing of `/etc`, `/var`, `/home`, `/run`, `$DATA`. |
| folder at `/resources/$N`, read-only | The one thing to read, at the machine's path. Read-only: git cannot write, lock or repair in it. |
| `MountAPIVFS=no` | No `/proc`, `/sys`. Git does not need them (trial). |
| `PrivateDevices=yes` + masks | On 255 `PrivateDevices` gives device nodes (`null`, `zero`, `full`, `random`, `urandom`, `tty`, `ptmx`) **and** binds the host's `/dev/shm`, `/dev/mqueue`, `/dev/hugepages`, `/dev/pts` (trial by review: a file in its `/dev/shm` appeared on the host). They are masked: `/dev/shm` an empty read-only tmpfs, the others inaccessible. |
| `/tmp`, `/var/tmp` read-only empty tmpfs; `LimitFSIZE=0` | `PrivateTmp` alone is a directory on the host's root file system, where empty files, directories and links cost inodes and blocks that `LimitFSIZE` does not count (trial by review). `LimitFSIZE` does not apply to pipes; stdout **must be a pipe** (`SIGXFSZ` on a regular file, trial). |
| `PrivateNetwork=yes`, `AF_UNIX`, `PrivateIPC=yes` | No network (own loopback only), no abstract socket of the host, no host SysV IPC. `RestrictAddressFamilies=none` is refused as a transient property on 255 (trial). |
| no capabilities, `NoNewPrivileges`, `RestrictSUIDSGID`, `RestrictNamespaces` | Nothing to escalate with. **Never `CAP_DAC_READ_SEARCH`**: `open_by_handle_at` would read any file of the file system holding `$MNT`. |
| seccomp `@system-service` minus io_uring, userfaultfd, keyring, setuid, chown, mount, memlock, privileged, resources, cross-process memory | Shrinks the kernel surface left to a git compromised inside. |
| `RuntimeMaxSec=300`, `MemoryMax=1G`, `TasksMax=8`, `CPUQuota`, `Nice`, `IOWeight` | A hostile repository (FIFO, huge objects, millions of refs) cannot hang or starve the host. Trial: a FIFO `packed-refs` killed at the limit. `RuntimeMaxSec` follows the "read time limit" option. |
| `--unit` fixed name | At most one read per folder; stoppable by name. |
| env and `-c` | No system or user config; the repository's `.git/config` is still read, so everything that could start a program is overridden on the command line: hooks, fsmonitor, pager, alternate refs command; `protocol.allow=never`; no lazy fetch. `safe.directory` is the exact path, never `*`. |

Not relied upon: `NoExecPaths=/` + `ExecPaths=/usr` did not stop executing a
binary from the folder (trial), and `/usr/bin/sh`, `perl`, `python3` are
inside anyway: **code execution inside the sandbox is assumed**.

**Upgrade guard**, in the host program, so a restart is not needed and the
server cannot skip it: `git read` refuses (78, "reads off until re-tested")
when the live versions differ from `runner-ok`. On that refusal, and at
start, the server calls `git selftest`: pass, reads resume; fail, reads stay
off and the operator is alerted.

## 6. Owners and permissions

Agent files reach the host through the multipass mount (`multipass mount -u
<server uid>:1000 -g <server gid>:1000`): what `ubuntu` writes in the machine
belongs on the host to the server account. What root or `chown` in the
machine produce is **to be measured in A2** (`stat` on the host).

The sandbox uid is never the owner, so it reads through the *other* bits.
Git's defaults (umask 002 in the machine) are readable. A folder the agent
made unreadable makes the read fail: a denial the agent can cause anyway.
The AI is given a hint (section 15).

The per-agent folder is filled by the server (umask 022 for that clone
only), so it starts readable. The server otherwise runs with umask 077, so
nothing it writes is readable through *other* bits. Confinement of links and
hardlinks made through the mount is entirely the multipass mount's (section
18); A2 tests `ln` from the folder to a file outside it.

## 7. What runs inside, and why a bundle

`git bundle create - --branches` (exactly, fixed in the host program).

- **One-way.** It reads the repository and writes one stream; stdin is
  `/dev/null` (the host program's redirect). No protocol, nothing from the
  server reaches the sandboxed git.
- **Upload-pack rejected.** It would make the server's `fetch-pack` talk to
  an agent-controlled process. A bundle is a static format the server parses
  itself.
- **Full, never incremental.** The fresh repository is empty, so a bundle
  with prerequisites is refused. Cost: the whole history at each read,
  bounded by the size cap and read pacing (section 13). Plan if real test 10
  shows the deadline too short: incremental bundles, prerequisites checked
  with `cat-file -e` in the reference, alternates to it, `--fix-thin`.
- `--branches`: only `refs/heads/*`; `HEAD`, tags, notes, stashes are not
  taken.
- Shallow, partial, reftable or sha256 repositories fail or are refused
  (section 15).

## 8. How the server receives

1. **Space.** Floor `F` = max(5 GiB, 10 % of the disk) (operator). The
   server keeps the sum `R` of bytes reserved by running reads, under a
   lock. A read starts only if free − `R` ≥ 2 x cap + `F`; it adds 2 x cap to
   `R` (fresh pack, landed copy) and removes it in step 8. Folder disks are
   allocated when made, so free space already counts them. Free space is
   checked again during streaming and before landing; below `F` the read
   stops with the same clean-up. Below `F`, reads, landings, refreshes and
   new folders all stop and the owner is alerted. Limits: 2 reads at once on
   the host, 1 per folder.
2. `mkdir $DATA/git-import/<random>` (0700; `git-import/` wiped at start).
   `git init --bare --object-format=sha1` in it (section 9 options).
3. **Cap** = min(operator maximum 8 GiB, max(512 MiB, 2 x the reference's
   pack size + 256 MiB)); the owner is alerted when the maximum clips it.
   Spawn `sudo -n clavarium-host git read <name> <id>`, stdout a pipe. The
   stream is **never stored**: the header is parsed in Node (step 4), then
   the pack bytes are piped, still counted, into `index-pack` (step 5). Past
   the cap: child killed, `git stop`, directory removed. **Import deadline**
   over steps 3-6: the "read time limit" (default 300 s) + a fixed margin +
   10 s per 100 MiB of cap, then kill and the same clean-up. Stderr: last
   4 KB, printable ASCII only, shown as "text from the agent's repository",
   never parsed, never placed next to action buttons.
4. **Header** (Node, before any git sees it). It runs in the server process,
   outside the cgroup of section 9, so it has its own bound: refused as soon
   as one line passes 4 KiB or the header passes 128 KiB before the empty
   line and `PACK`. Parsed on Buffers by scanning for `\n`; only checked
   lines become strings. Rules:
   - first line exactly `# v2 git bundle`; v3 refused;
   - no prerequisite line (`-<sha>`);
   - each ref line `^[0-9a-f]{40} refs/heads/(.+)$`; exact duplicate lines
     dropped (a symbolic branch, trial); the same name with two shas
     refused; at most 1000 names; a branch failing `branchProblem` is
     dropped from the import and its existing ref left untouched (step 7);
   - an empty line, then `PACK`.
   A refusal kills the child, `git stop`, removes the directory, releases
   the reservation, and reports "bad header: <reason>" (section 15).
   **No branches**: host exit 65 and stdout exactly the 17 bytes `# v2 git
   bundle\n\n` (empty repository, or commits on a detached HEAD only,
   trial): landed as an empty set, so every `<dest>/` ref is deleted. Any
   other non-zero exit or missing `PACK` is a failure (section 15).
5. `git index-pack --strict[=<id>=<sev>,...] --threads=1
   --max-input-size=<cap> --stdin`, fed the pack; exceptions of section 9.
   No `--fix-thin`. In an empty repository this checks every object
   (`.gitmodules`, `.git`-like names) and every link, so no separate `fsck`
   runs. `--max-input-size` bounds **compressed** bytes only; inflated size
   is bounded by the cgroup (section 9) and step 6.
6. `git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectsize)'`:
   refused if one object is over the object limit (default 100 MiB) or the
   inflated total over 4 x cap (operator options). Each ref sha must be a
   commit; refs written with `update-ref --stdin`.
7. **Land.** Wait for the reference's mutex at most 60 s; past that "reference
   busy": retried quietly, no alert, the AI told nothing, not counted as a
   failure. Once held, the landing has its own deadline.
   - `for-each-ref` in the fresh repository and on `<dest>/` in the
     reference (old tips recorded here);
   - copy objects with `fetch --no-tags --no-write-fetch-head -- <fresh>
     '+refs/heads/*:refs/clavarium/incoming/<id>/*'` (`<id>` = conversation
     or `shared`; the incoming prefix is emptied before and after);
   - **two** `update-ref --stdin` transactions (`start` ... `prepare`,
     `commit`): first `delete`, with old value, each `<dest>/` ref whose name
     is not in the bundle header (names dropped in step 4 count as present);
     then `create`/`update` with old values for the rest. One transaction
     cannot delete `a` and create `a/b` or the reverse; two can (trials,
     loose and packed). A crash between them leaves some branches missing
     until the next read lands them again (dirty flag, read at start);
   - rewritten = recorded old tip not an ancestor of the new (`merge-base
     --is-ancestor`), logged "agent/<id> rewrote <b>" only after the second
     `commit`.
8. Remove the fresh directory and release the reservation (`finally`).

The server never fetches from the agent folder, never points alternates at
it, never opens it with git.

## 9. Options and bounds on every server-side git command

One function builds every git call (clone into a new folder, init, index-pack,
cat-file, update-ref, landing, refresh, ls-remote, review, merge-base, push,
gc). Environment:

```
PATH=/usr/bin:/bin  HOME=/nonexistent  XDG_CONFIG_HOME=/nonexistent
GIT_CONFIG_NOSYSTEM=1  GIT_CONFIG_GLOBAL=/dev/null  LC_ALL=C
GIT_TERMINAL_PROMPT=0  GIT_ASKPASS=/bin/true  SSH_ASKPASS=/bin/true
GIT_NO_LAZY_FETCH=1  GIT_PROTOCOL_FROM_USER=0
GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904   (empty tree)
GIT_CEILING_DIRECTORIES=$DATA
```

`-c` options:

```
core.hooksPath=/dev/null        core.fsmonitor=false     core.pager=cat
core.attributesFile=/dev/null   core.alternateRefsCommand=
protocol.allow=never  protocol.https.allow=always  protocol.ssh.allow=always
  (protocol.file.allow=always ONLY on the landing fetch and the folder clone)
transfer.fsckObjects=true  fetch.fsckObjects=true
transfer.bundleURI=false   fetch.recurseSubmodules=false  submodule.recurse=false
http.followRedirects=false gc.auto=0  maintenance.auto=false
http.lowSpeedLimit=1000    http.lowSpeedTime=30
pack.threads=1  pack.windowMemory=256m  pack.deltaCacheSize=64m
core.bigFileThreshold=32m  core.deltaBaseCacheLimit=64m
core.packedGitLimit=256m   core.packedGitWindowSize=32m
```

ssh (`gitaccess.mjs`) adds `-o ServerAliveInterval=15 -o
ServerAliveCountMax=3` to its `ConnectTimeout`.

**Bounds.** Every call the builder makes has a server deadline (kill,
`finally`) and runs in its own child of one parent cgroup `git/`:
`memory.max` 2 GiB (operator), `memory.swap.max` 0, `pids.max` 64 in total;
per child 1 GiB, `pids.max` 16, one CPU. The server's unit has
`Delegate=memory pids cpu` and `DelegateSubgroup=main`, so Node starts in a
leaf (cgroup v2 refuses controllers on a cgroup that holds processes); a
fixed wrapper writes the child's limits before `exec git` and removes it in
`finally`. To check in a trial; fallback: `systemd-run --scope` through a
host verb into one slice with the same totals. Optionally `MemoryMax` on
`clavarium.service`. So an OOM kills one git, and all server git together
stay under the `git/` limit, never pushing the global OOM killer onto the
server, multipassd or a machine.

**fsck exceptions.** An owner option per repository sets message ids with a
severity. They reach index-pack (step 5) as `--strict=<id>=<sev>`, and the
refresh, the folder clone and the landing fetch as `-c
fetch.fsck.<id>=<sev>`. Index-pack reads no fsck config, and `fsck.<id>`
affects neither (trials).

Plus: `--` before addresses and paths; `--no-tags`; no TTY. **No
`safe.directory`** on the server side (the current `safe.directory=*` goes
with `#copy`). Before using a reference or fresh repository, the server
checks: no `objects/info/alternates` or `http-alternates`, no
`extensions.partialClone`, `objectFormat` sha1 or unset, no
`extensions.refStorage` (`--ref-format` does not exist in 2.43).
`http.followRedirects=false` because the token travels as
`http.extraHeader`.

## 10. The reference from GitLab, and rewrite detection

Refresh (arrow 1), under the reference's mutex:

1. Note every `refs/heads/*` tip as `refs/clavarium/before/*` (one
   `update-ref --stdin`), so an old tip is never unreachable even after a
   crash.
2. `git -C <reference> fetch --prune --no-tags --no-write-fetch-head --
   <remote> '+refs/heads/*:refs/heads/*'`, then the default branch (section
   3). A non-zero exit counts toward "refresh failed", and step 3 still runs.
3. For each `refs/clavarium/before/<b>`: branch gone, a **delete on GitLab**,
   logged and told; equal, or `merge-base --is-ancestor <before> <current>`,
   nothing; otherwise a **rewrite on GitLab**: the old tip goes to
   `refs/clavarium/rewritten/<b>/<UTC>` (30 days), owner and attached agents
   told, automatic sending to that branch **paused** (stored, survives a
   restart) until the owner looks.
4. Delete `refs/clavarium/before/*`. Leftovers at start mean an interrupted
   refresh: run step 3 on them, then step 4.

A refresh refused by fsck is a GitLab problem: the owner sees the message id
and object and is offered the exception of section 9; agents are told
nothing.

## 11. Review

Opening a review first runs a read of that folder and lands it (no read
quiet delay; counted in the caps). Then, computed in the reference only,
under its mutex (waited at most 10 s, else "busy, try again"), between
`refs/heads/<target>` (refreshed just before) and `<dest>/<branch>`; the
default branch shown is the agent's most recently moved ref, else
`agent/<conv>`. The page shows "branches as of <time>" and a "Read now"
button. Commands of `#outgoing` today, plus:

- `rev-list --count base..head`: the true number; above 100, "N commits, only
  100 listed" and one extra confirmation.
- `rev-list --objects --disk-usage base..head` and the 10 largest new blobs
  (`cat-file --batch-check`).
- Paths touched by some commit with no net change (`log --name-only` minus
  `diff --name-only`), listed.
- Blob sizes looked up first; blobs over a limit shown "too large, not
  shown". `diff --text --no-ext-diff --no-textconv --no-color` read as a
  stream: git killed at `DIFF_MAX` (not sliced afterwards as
  `gitpush.mjs:209` does now); a cut diff needs a separate tick.
- Control characters escaped. The review records `head` and `remoteTip`.

## 12. Push with a lease

Pressing Send first runs a read of that folder and lands it, as in section
11. Then, under the reference's mutex:

1. `<dest>/<branch>` must still equal `head`; else 409 "the agent changed
   this branch since you looked: look again" (kept from `gitpush.mjs:223`).
   If the read could not run (cap, failure, folder unavailable): "could not
   confirm the agent's branch is unchanged", sent only on an explicit
   confirmation.
2. Push:

```
git -C <reference> push --porcelain --no-verify \
  --force-with-lease=refs/heads/<target>:<remoteTip shown, or empty if absent> \
  -- <remote> <head>:refs/heads/<target>
```

3. On success: for a forced push, the old tip first goes to
   `refs/clavarium/rewritten/<target>/<UTC>` marked "overwritten by
   Clavarium"; then `update-ref refs/heads/<target> <head> <old>`. The next
   refresh then sees a fast-forward: our own push is never reported as a
   GitLab rewrite.

- The lease makes GitLab refuse if its branch is no longer what the owner
  saw; an empty value means "must not exist".
- **Automatic sending is never a force push**: `merge-base --is-ancestor
  <remoteTip> <head>` first; otherwise "diverged".
- **The operator may confirm a non-fast-forward** by hand.
- The key never leaves the server (`gitaccess.mjs`, unchanged).

## 13. Automatic sending

- **Detection.** Non-recursive `fs.watch` only, on a fixed list: the
  folder's `.git` (catches `packed-refs`, `HEAD`), the tops of
  `.git/refs/heads`, `.git/logs` and `.git/worktrees`; each opened after
  `lstat` says it is a real directory; at most 4 per folder and a fixed
  total on the host. The server never walks an agent tree. An event only
  triggers a read; the read (in the sandbox) lists the branches. Fast path:
  today's `lstat` marks every 30 s, plus `.git/worktrees/*/HEAD` and
  `.git/worktrees/*/logs/HEAD` for at most 16 worktrees. **Backstop**: a
  safety read of every folder in use every 10 minutes (counted in the caps,
  skipped while one is queued or running); a ref-only update with no HEAD
  reflog change (nested `branch -f`, `update-ref`) is caught only by it. A
  watch that fails (ENOSPC, cap) means polling for that folder; the owner is
  told once. `gitkeeper.mjs` gets the same marks and periodic read.
- **Read quiet**: a read starts 5 s after the last event (operator option).
  A dirty flag per folder: an event during a read, or while queued,
  schedules exactly one more read after it.
- **Start**: after a server start, every folder of a repository in use is
  read once (as today's first tick); also on attach and on wake.
- **Reads**: 1 per folder, 2 on the host, at most 120 per folder per hour and
  a byte budget per folder per hour (operator; default 10 x cap); past that,
  reads wait and the owner is told once.
- **Sends**: a candidate is each `<dest>/<b>` whose tip is not on its target,
  not yet sent, and whose target matches the owner's list. It is sent only
  when its tip has not moved for the **send quiet delay** (today's
  `quietMinutes`, per repository, default 10, 0 allowed; measured from the
  last landing that moved it, kept in memory, from the first read after a
  restart) and no read of its folder is queued, running or dirty.
  Re-evaluated on every tick and after every refresh. A send runs only after
  a refresh that succeeded in the same cycle, whatever the refresh interval
  (including 0); a failed refresh skips it ("GitLab unreachable"). Held by
  the cap or checks 'unavailable': retried, as today. Diverged, refused and
  similar: logged once per commit. The push re-checks the candidate sha
  (section 12). Cap 20 sends per hour per repository (0 = unlimited), alert
  when reached.
- **Checks** run in the machine, as today, but `machineFor` loses its "first
  awake machine" choice: for `refs/agents/<conv>/<b>` only in `clv-<conv>`;
  in shared mode only in the machine of the conversation the owner names for
  checks. Not running means 'unavailable'. The script compares `git rev-parse
  --verify refs/heads/<b>` with `head`, not `HEAD`.
- **Operator options** (with confirmation): branch list with `*` patterns,
  `main` and `*` allowed; "may create branches on GitLab" (off); read quiet
  seconds; send quiet minutes; caps; size cap; read time limit; checks
  required. Fixed: the key never leaves the server; never an automatic force
  push.
- **Only while in use**: a repository whose machines are all asleep starts
  nothing new; a read already pending still completes (it needs only the
  host and the mounted disk).

## 14. Telling the owner and the AI

The owner: the repository log in the page, and the phone (alerts.mjs) when
"alert" is on. The AI: one line typed into its terminal through the wake-up
route (wakeups.mjs: server-written text, branch names reduced by
`plainName`), only for what it can act on. Never agent-supplied text beyond a
sanitised branch name.

## 15. Every failure

| Failure | Nothing changes in | Owner sees | AI told |
|---|---|---|---|
| Host refused (78), unit did not start (79), folder missing, a link, not a mountpoint | reference | "could not read <id>: <reason>" | no |
| Host program failed: any exit other than 0, 65, 66, 78-82 (sudo, usage) | reference | "host program failed" + alert to owner and operator | no |
| Reads off until re-tested (78), self-test pending or failed | reads off | "reads off (re-test pending/failed)"; operator alert on failure | no |
| Not enough disk (below `F`) | reference | "not read: N MB free" + alert | no |
| Time limit (80) / memory limit (81) / killed (82) | reference | "reading stopped: <which>" | only when the reference is under a quarter of the cap: "your repository could not be read in time or memory; pack it (git gc)" |
| Import deadline exceeded (server side) | reference | "import took over N s at <step>" | no |
| git failed (65 not empty, 66) or no `PACK` | reference | text from the agent's repository; alert after 2 in a row | after 2 in a row: "could not read your repository; check permissions (chmod -R o+rX .git), that it is not shallow, and that it is SHA-1 with files refs (git init --ref-format=files)" |
| No branches (65 + 17 bytes) | `<dest>/` emptied | "no branches" | if `<dest>/` had refs: "no branch found; commit on a branch (git switch -c <name>)"; else "nothing committed yet" |
| Stream over the cap | reference | "N MB, over the cap"; if the reference alone is near the cap: "the GitLab history alone is N MB; raise the size cap", once per state change | only when the reference is well under the cap: "your branches add up to more than the cap" |
| Object or inflated total over the limit | reference | "object of N MB in <id>" | "a file over N MB is in your history" |
| Bad header | reference | "could not be read safely: <reason>" | over 1000 branches: "delete branches (over 1000)"; v3: "use a SHA-1 repository"; prerequisite: "unshallow (git fetch --unshallow)"; over-long, two shas for one name: no |
| Invalid branch name | that branch only, its ref untouched | listed | "branch <b> was not taken: <rule>" |
| index-pack refused (fsck) | reference | message id and object | only if the object is not reachable from `refs/heads/*`: "fsck refused your commits: <id>"; else owner only |
| Reference busy (mutex not had in time) | reference | logged; reviews: "busy, try again" | no |
| Landing failed | reference | git's line; alert after 2 in a row | after 2 in a row, on a name clash: "branch <b> clashes with <b2>; rename one" |
| Lock left by a crash or a killed git | — | "removed stale lock <path>" at start or at the next mutex acquire | no |
| gc failed or killed | reference | alert after 2 in a row | no |
| Refresh failed 3 times in a row | reference | alert | no |
| GitLab unreachable | reference; sends skipped | `explain()` text + alert | no |
| GitLab rewrite / delete | refs/heads updated, old tip kept | "<b> was rewritten on GitLab" + alert | "origin/<b> was rewritten; fetch again" |
| Agent changed its branch after review | GitLab | 409 "look again" | no |
| Agent's branch could not be confirmed before Send | GitLab unless confirmed | "could not confirm the agent's branch is unchanged" | no |
| Not in list / diverged / cap / checks failed | GitLab | as today, once per commit | diverged: "pull origin/<b> first"; checks: their output |
| Lease refused | GitLab | "GitLab's <b> moved since you looked"; refresh at once | automatic: "pull origin/<b> first", only once the reference holds GitLab's new tip |
| Folder fill failed | no folder mounted | "could not prepare the folder"; after 3 in a row, alert and stop until a manual retry | no |
| Folder disk missing or `e2fsck` failed (start, re-attach) | folder not mounted nor read; nothing remade | "folder of <conv> unavailable: <reason>" + alert | no |
| Folder detached | disk, "filled" and `refs/agents/<conv>/*` kept | before detach or discard: the AI's branches not on any `refs/heads/*` | no |
| Server restart mid-read | — | `git sweep`; `git-import/` wiped; disks mounted again; every folder in use read again | no |

## 16. Cleanup and size

Fresh import directories removed after each read and at start.
**Detach or a level change** only unmounts: the disk, its "filled" record
and `refs/agents/<conv>/*` stay, and a write attach mounts them again
(`worktree make ... again`); write → read → write is not a detach. **Archive**,
an explicit "discard" by the owner, or an operator-set idle period removes
`refs/agents/<conv>/*` and puts the folder aside. Before a detach or a
discard, the page lists the AI's branches not on any `refs/heads/*`.
`refs/shared/*` removed with the shared folder. `refs/clavarium/rewritten/*`
older than 30 days removed. `$MNT/removed/` kept for an operator-set period
(default 90 days). Its size, and that of detached disks, shown in Settings.

**Size limits** (operator): the reference's on-disk size, and bytes landed
per agent per day. Over either, landing is refused, the owner alerted, the
AI told. Unreachable objects: `git gc --prune=2.days.ago` daily, and when the
reference grows past a threshold, on the reference only, under its mutex and
the bounds of section 9. Disk use of references and folders shown in
Settings.

## 17. Attacks considered

| Attack | Stopped by |
|---|---|
| `.git` gitfile to another repository | Only the folder exists in the sandbox. Trial: `fatal: not a git repository: <path>`. |
| `.git` symlink outside | Same. Trial: "Need a repository". |
| `commondir` outside | Same. Trial: "Invalid path". |
| `objects/info/alternates` outside | Same. Trial: "unable to normalize alternate object path". |
| Relative `../` paths | `/resources` holds this folder and only empty mountpoints of others; `GIT_CEILING_DIRECTORIES`. |
| Hooks, fsmonitor, pager, filters, aliases in `.git/config` | Overridden on the command line; `bundle create` runs none of them; code inside reaches nothing. |
| A git parser bug, sandbox side | Throw-away uid, no capability, no network, no `/proc`, seccomp, no writable path except empty read-only tmpfs, nothing secret visible. |
| A git parser bug, server side (index-pack, landing, diff, merge-base, gc) | **Not removed**: runs as the server uid (section 18). Reduced to hardened receive parsers on fsck-checked objects, under the cgroup bounds. |
| FIFO, device, huge or endless files | `RuntimeMaxSec`, `MemoryMax`, `TasksMax`. Trial: FIFO killed at the limit. |
| Huge bundle, zip bomb, delta amplification | Byte cap on the stream (compressed bytes only); per-command and total cgroup bounds on server git; `--threads=1`, `bigFileThreshold`; per-object and inflated-total limits; size checks before diff; space reservation. |
| Endless or over-long bundle header | Byte bound per line and on the header, in Node, before any git. |
| Filling `$DATA`/`$MNT` | Fully allocated disk per folder, new folder refused below `WORKTREE_MB` + `F`; reservation of 2 x cap per read and floor `F`; reference size and daily landed-bytes limits; frequent prune. |
| `/tmp`, `/dev/shm` of the host from the sandbox | Read-only empty tmpfs; `/dev/mqueue`, `/dev/hugepages`, `/dev/pts` inaccessible. |
| Forged bundle content (a compromised git inside) | Bounded strict header parse, no prerequisites, index-pack `--strict` in an empty repository, commit type check, host exit codes the content cannot choose. |
| Quickfetch / prerequisite trick | Import into an empty repository with no alternates; prerequisites refused. |
| Ref names `../`, `HEAD`, options, control characters | `branchProblem`; only `refs/heads/` in the bundle, only `<dest>/` in the reference. |
| Branch rename `a` → `a/b` freezing landing | Deletes and creates/updates in two transactions (trial). |
| Overwriting GitLab refs in the reference | Disjoint prefixes; one writer per reference. |
| A folder, image or mount target swapped for a link or another tree | Everything root mounts from, onto or loop-attaches is under root-owned `$MNT`; `held` checks the whole chain on every such verb; images root's, 0600, `e2fsck -p` first. |
| Using reads to exhaust the host | One per folder, two at a time, read caps and byte budget per hour, cgroup bounds. |
| Many refs or directories to exhaust the watcher | No recursive watch, at most 4 per folder, fixed total; polling fallback. |
| Terminal of the operator as stdin | `exec 0</dev/null`; refused when stdout or stderr is a terminal. |
| Server killing or tracing via shared uid | Dynamic uid, no `/proc`. |
| Token sent elsewhere by a redirect | `http.followRedirects=false`. |
| Lazy fetch to a promisor | No partial clones; `GIT_NO_LAZY_FETCH=1`; no network in the sandbox. |
| `.gitattributes` hiding changes in the review | `--text`, no textconv, attributes from the empty tree. |
| History hidden from the review (add then delete, past 100 commits) | True commit count, new-object size and largest blobs, paths with no net change. |
| Racing the owner's review | Read and land before the review and before Send; agent ref re-checked against `head`; lease on the exact `remoteTip`. |
| Agent loop of commits | Read quiet delay, send quiet delay, read and send caps, alerts. |
| GitLab history rewritten under us | Before-refs, ancestry check after every fetch, old tip kept, sends paused. |

## 18. What is NOT protected

- **The kernel.** A kernel bug reachable from the allowed syscalls escapes
  the sandbox. So does a systemd bug.
- **Server-side git parsers.** The server uid parses the agent's pack and
  objects (index-pack, landing, then review diff, merge-base, gc). A
  memory-safety bug there runs with the vault. Later hardening: run
  index-pack and the type check in a second `DynamicUser` unit writing only
  the fresh directory; landing, diff, merge-base and gc would still parse
  agent objects as the server uid.
- **The multipass mount.** Confinement of links, hardlinks and special files
  created through it is the VM manager's. Measured partly in A2.
- **The shared folder** stays unbounded on the host disk, as today.
- **What the agent commits.** Reviewed carelessly or sent automatically to a
  listed branch, it goes to GitLab; automatic sends are not reviewed. Checks
  run in the machine and can be faked by it.
- **Other agents of the same repository** see each other's branches.
- **Exfiltration by the agent** over its own network (roadmap). The key
  never leaves, but the code it reads can.
- **Denial by the agent** of its own reads (permissions, size, slowness).
- **"Shared folder" mode**: no attribution between writers.
- **GitLab** itself, and a host key accepted on first contact.

## 19. Test plan

Unit (host program in `--say-only`, a stand-in for the runner): argument
checks of every verb (bad names, `..`, `-`, links, non-root or writable
components in `held`, image not root's or not 0600, not a mountpoint, active
unit, terminal on stdout); the exact `systemd-run` vector, shared with
`selftest`; exit-code mapping 65-82 and nothing else; `reset-failed` before a
start, in the trap and in `git stop`; version mismatch gives 78; `worktree
make new` (refused if the image exists, fails if the root is not empty after
`rmdir lost+found`) and `again` (missing image refused, restored directory
moved in, mounted, already mounted left); header parser (every refusal of
section 8 step 4, byte by byte; 4 KiB line and 128 KiB header at the limit
and one byte over; exact duplicate kept once, two shas refused; no branches
only on 65 + 17 bytes); cap counting at cap-1, cap, cap+1; cap clipped by
the maximum; space reservation with two reads; deadlines; mutex wait gives
"reference busy"; every row of section 15; forced options, deadline and
cgroup wrapper on every server git call (one test enumerates the call
sites); prefixes never overlap; landing in two transactions for `a` → `a/b`
and `a/b` → `a`, loose and packed; a dropped invalid branch is not deleted;
a failed landing logs no rewrite; no branches deletes `<dest>/`; refresh
where one ref fails after another was force-updated still records the
rewrite; lease for existing and absent branches; 409 when the agent ref
moved; our forced push not reported as rewrite; non-fast-forward never sent
automatically; send quiet delay; caps 20/h and 0; dirty flag; candidates
retried after cap and 'unavailable'; fill retried at most 3 times; review
count above 100, add-then-delete path named; checks only in `clv-<conv>`.

Real, on Linux with systemd 255, as root (CI box and the house):

1. Inside the unit: `ls -la / /dev /dev/shm /tmp /var/tmp` and `find / -xdev
   -writable` match an expected list; no `/proc`; `connect` fails; uid
   dynamic; no capability; fd 0 is `/dev/null` (via `/dev/fd/0`, or a
   test-only unit) even when the host program runs from a terminal or with a
   pipe on stdin; `io_uring_setup` gives EPERM; a file made in `/dev/shm` is
   not on the host; 100k empty files in `/tmp` fail.
2. A guard that **`TemporaryFileSystem=/` is not used**, and a test that
   fails if the host root becomes visible. `git selftest` passes, and fails
   on a broken property list.
3. A disk built by `worktree make new`, filled as in section 3; a normal
   repository with worktrees and branches imports and lands under
   `refs/agents/<conv>/`; GitLab refs untouched.
4. Stdout through `sudo` is binary-clean (random blobs, checksums equal).
5. Owners: files written in a real machine as `ubuntu` and `root`, read by
   the runner; `chmod 600` gives the expected message; `ln` through the
   mount to a file outside the folder.
6. `RuntimeMaxSec` and the server deadline both kill and clean. A failed
   unit (git 128, cap kill, host program killed) does not block the next
   read; killing the server mid-read of an empty repository, then restarting
   it, leaves the folder readable.
7. Push with lease to a local bare remote: accepted unchanged, refused when
   moved; a new branch with an empty lease. Amend during the send quiet
   delay: the first sha is never sent; amend then Send: 409 or confirmation.
8. `worktree make`: `dd` until full fails inside that disk only; the vault
   and the reference stay writable; with disks adding up past free space, a
   new folder is refused.
9. Fill, commit, unmount every disk (as a reboot), restart: content,
   branches and stashes there, `git read` and `vm mount` work. Same after
   backup and restore. Write → detach → write keeps `agent/<conv>` and its
   unsent commits.
10. Time a full read of a 1-2 GB repository (bundle, index-pack, landing)
    under one CPU; record the size above which incremental bundles (section
    7) are taken up.
11. SIGKILL an `update-ref` holding its lock: the next landing succeeds
    without a restart.
12. A commit in a linked worktree on a nested branch, and a nested `git
    branch -f` in the main worktree, are read within the safety period.
13. A pack with a zero-padded tree goes through the full import with the
    exception set, and is refused without it.
14. Twice green `npm run check` before any deploy (chantier rule).

**Attack tests** (A3, by another team; each must fail safely and say so):
gitfile to another repository of `$DATA`; `.git` symlink to the vault
directory; `commondir` and `alternates` absolute and relative; `.git`,
`packed-refs`, an object as a FIFO; a device node if the mount allows it; a
10 GB sparse file in objects; millions of refs; 50k nested refs (event-loop
lag and watch count stay bounded); a ref name with `..`, newline, leading
`-`; a forged bundle header (v3, prerequisite, `refs/tags/x`, duplicate,
non-commit tip, truncated pack, extra bytes); `# v2 git bundle\n` then many
MB without `\n`, and 1000 valid refs then a line that never ends (refused,
server memory flat); a pack bomb over the cap; **a pack under the cap
inflating beyond memory**, as one zero blob and as a delta chain (small base,
many copy ops declaring several GiB, a second chained delta): refused,
server up; **three concurrent bombs or large diffs/gc on different
repositories**: gits killed, server and machines up; **two concurrent reads
near the cap**: the second waits, `$DATA` stays above `F`; the server user
renaming or replacing any component of the source, target or image path
during `vm mount ... worktree`, `worktree make` and `git read` (refused or
impossible); a shallow, a partial, a reftable and a sha256 repository;
hostile `.git/config` (hooks, fsmonitor, pager, alias, include of
`/etc/shadow`, `core.sshCommand`); `.gitattributes` with `-diff` and
`textconv` (must show in the review); a commit adding a file and the next
deleting it (path named in the review); a file swapped for a symlink during
the read; two reads of the same folder at once; a commit loop (1000 commits
in a minute); the agent amending its branch between review and send
(refused); a GitLab rewrite between review and send; a GitLab history with a
`zeroPaddedFilemode` tree (refresh refused, owner offered the exception, AI
told nothing); a redirecting https remote; network from inside (host ports
22 and 8770); `/proc/1/environ`, `/etc/passwd`, the vault path from inside
(must not exist).

## 20. Trial record (development box, 14-10, not the house)

`git 2.43.0`, `systemd 255.4-1ubuntu8.17`, kernel 6.8. With the first
command of section 5 (scratch folder): a normal repository gave a valid v2
bundle in ~0.3 s; gitfile, `.git` link, `commondir`, `alternates` attacks
failed with "not a repository"-type errors; a FIFO `packed-refs` was killed
at `RuntimeMaxSec`; a hostile `core.fsmonitor`/`core.pager` ran nothing.
`DynamicUser` + `TemporaryFileSystem=/` exposes the host root on 255;
`RestrictAddressFamilies=none` is refused as a transient property;
`NoExecPaths` did not hold on the bound folder; `LimitFSIZE=0` kills git when
stdout is a regular file; `PrivateUsers=yes` failed to start (217).
Reviewers' trials, same box: `--pipe` overrides `StandardInput=null`;
`PrivateDevices` binds host `/dev/shm`, `/dev/mqueue`, `/dev/hugepages`,
`/dev/pts`; `PrivateTmp` is on the root file system and takes inodes;
`git bundle create` on an empty repository writes the 17-byte header and
exits 128; a fetch with `--atomic --prune` fails forever on `a` → `a/b`;
`fsck.<id>=ignore` does not affect a fetch, `fetch.fsck.<id>` does.
Round 2: one `update-ref --stdin` transaction deleting `a` and creating
`a/b` (and the reverse) fails at `prepare` ("cannot lock ref"), loose and
packed; the same as two transactions succeeds, loose and packed, both
directions; `index-pack --strict` ignores `fsck.`, `fetch.fsck.` and
`receive.fsck.<id>` and accepts `--strict=<id>=ignore`; `mount --bind
/proc/self/fd/N` (util-linux 2.39.3) readlinks the fd and passes the
resolved path to `mount(2)`; a failed transient unit without `--collect`
blocks `systemd-run --unit=<same>` ("already loaded") until `reset-failed`;
commits on a detached HEAD only give the 17-byte header and exit 128; a
symbolic branch gives the same ref line twice.

## 21. Review log

### Round 1

| # | Finding | Verdict | Change |
|---|---|---|---|
| 1 | Server uid still parses hostile pack and objects; note claimed the risk gone | confirmed | Sections 2, 17 (server-side row), 18 state it; later hardening named. |
| 2 | Server-side index-pack/fsck/diff unbounded; `--max-input-size` is not inflated size | confirmed | Section 9 cgroup bound on every server git reading agent objects, memory options, `--threads=1`; section 8 step 6 object limits; section 11 size check before diff; section 17 row rewritten; A3 delta test. |
| 3 | `--pipe` overrides `StandardInput=null` | confirmed (low) | `exec 0</dev/null` and terminal refusal in `git read`; property dropped; sections 5, 7; test of fd 0. |
| 4 | `/tmp` on host disk; host `/dev/shm`, `/dev/mqueue`, `/dev/hugepages`, `/dev/pts` visible | confirmed | Read-only tmpfs and `InaccessiblePaths`; section 5 rows corrected; real test 1 extended. |
| 5 | Disk check ignores concurrency and the copies of each import | confirmed | Section 8 step 1 reservation, floor, re-checks; `in.bundle` dropped; concurrent test. |
| 6 | `shared` id collides with a conversation name | confirmed (low) | `refs/shared/*` prefix; switch cleanup. |
| 7 | Server-side git unbounded (second report), diff sliced after reading | confirmed | Same as 2; diff read as a stream and killed at `DIFF_MAX`; gc bounded. |
| 8 | No quota on the reference and folders | confirmed | Fixed-size folder disks; reference and daily landed-bytes limits; frequent prune; `removed/` retention. |
| 9 | Review can push content the owner never saw | confirmed (low) | Section 11: true count, new-object size, largest blobs, no-net-change paths, tick for cut; test. |
| 10 | Host `/dev/shm` and `/tmp` inodes (second report) | confirmed | Same as 4; inode test. |
| 11 | Recursive `fs.watch` DoS | confirmed | Section 13 non-recursive fixed watches, caps, fallback; row and test. |
| 12 | Per-agent folders unbounded on `$DATA` | confirmed | `worktree make` builds a loop disk; mountpoint checks; cost shown; test 8. Round 2 (R11): sparse images did not bound the sum; now allocated. |
| 13 | Disk accounting wrong and racy (third report) | confirmed | Same as 5 and 8; floor stops refreshes and landings too. |
| 14 | Empty or failed sandbox read as "nothing committed yet" | confirmed | Host runs systemd-run as a child, own exit codes 65-82; empty = 65 + 17 bytes; section 15 rows. |
| 15 | No guard against upgrades | confirmed (low) | Upgrade guard (section 5); sha1 init and extension checks (section 9); reftable/sha256 row. No `--ref-format` (absent in 2.43). Round 2 (R18): guard moved into the host program. |
| 16 | fsck strictness breaks legacy history | confirmed | Exception on refresh, clone, import; refresh refusal goes to the owner; reachability check before telling the AI. Round 2 (R22): index-pack needs `--strict=<id>=<sev>`. |
| 17 | `--atomic --prune` landing frozen by `a` → `a/b` | confirmed | Server-computed `update-ref`; rewrites from ancestry, after commit; rows and tests. Round 2 (R7): one transaction also fails; now two. |
| 18 | No single writer for the reference; stale locks | confirmed | One mutex per reference (section 3); stale locks removed at start; rows. |
| 19 | Push sends the reviewed sha after the agent changed it | confirmed | Section 12 step 1 re-check (409); automatic sends re-check; row and test. |
| 20 | Default cap fixed; AI told to fix GitLab history | confirmed (low) | Cap relative to the reference; owner-only message when the reference is near the cap. |
| 21 | Rewrite preservation not crash-safe; own push reported as rewrite | confirmed | Before-refs (section 10); `update-ref` after push (section 12); pause stored. |
| 22 | Lost wake-ups | confirmed | Dirty flag, read all at start, candidates re-evaluated and retried. |
| 23 | Checks and HEAD in per-agent folders | confirmed | Checks only in `clv-<conv>`; "first awake machine" removed from `machineFor` (owner request); shared mode uses an owner-named machine; branch compared by ref; review default branch defined; HEAD not added. |
| 24 | Stale reference after a failed refresh | confirmed (low) | Sends only after a successful refresh in the same cycle; lease advice only once the reference has the new tip. |
| 25 | Mode switch loses running agents' work; `shared` collision | confirmed | Switch refused while a writer runs; reviews closed; `refs/shared/*`. |
| 26 | Default branch, interrupted fill, origin path | confirmed | `ls-remote --symref`; orphan branch; "filled" recorded last, else aside and remake; `originFolder(name)`. |
| 27 | Server checks out agent-influenced trees at fill | not confirmed | No change: the folder was never agent-writable, objects passed fsck, dangerous features off. |
| 28 | Second wall does not cover other repositories | not confirmed | Paragraph removed anyway (see 33). |
| 29 | Folder reuse and stale mounts break "filled once" | not confirmed | No change beyond 26 (unfilled folder never mounted). |
| 30 | io_uring and userfaultfd allowed | low | Excluded from seccomp; test. |
| 31 | `fs.watch` follows symlinks in path components | low | Covered by 11 (no tree walk, fixed list, events are hints). |
| 32 | `RootDirectory` under `/usr` shows repository names | low | Root moved to `/var/lib/clavarium/runner-root`; names visible, stated. |
| 33 | Hardlink "second wall" does not exist | low | Removed; server umask 077; A2 tests `ln`. |
| 34 | `$DATA` server-owned: host checks can be raced | low | Round 1's fd bind did not hold (R1); replaced by the root-owned `$MNT` chain checked by `held` (R1, R2). |
| 35 | Exit codes and invalid branch handling ambiguous | low | Exit codes from the host program (14); one rule: a bad branch is dropped, its ref untouched. |
| 36 | Seccomp broader than needed | low | Groups excluded; allowlist from `strace` if git fails to start. |
| 37 | `shared` id (third report) | low | Same as 6. |
| 38 | Agent-controlled stderr shown as "what git said" | low | Labelled as text from the agent's repository, printable ASCII, away from buttons. |
| 39 | Per-read logging on the host | low | Sudo syslog off for `git read`; the server logs reads. |

### Round 2

| # | Finding | Verdict | Change |
|---|---|---|---|
| R1 | Fix 34 fails: `mount` resolves `/proc/self/fd/N` and walks the path again | confirmed (medium) | Fd bind and staging path dropped; paths are made un-raceable instead (R2): section 4 `held`; trial in section 20. |
| R2 | Mounting verbs pass paths through server-owned `$DATA` to root (`vm mount`, `worktree make`) | confirmed (high) | Everything root mounts from, onto or loop-attaches moved to root-owned `$MNT`; `held` on every such verb, existing ones included; images root's 0600; install, backup, restore; section 17 row; A3 rename test. |
| R3 | A failed unit blocks later reads; staging binds leak | confirmed (medium; availability) | `reset-failed` before start, in an EXIT/TERM trap and in `git stop`; `git sweep` at start; result from `systemctl show` only; staging gone (R1); restart row; real test 6. |
| R4 | No remount of per-agent disks after a reboot | confirmed (medium) | `worktree make ... again` at every start for filled folders, `e2fsck -p` first; row "disk missing or e2fsck failed"; real test 9. |
| R5 | Server git cgroup bound per command only | confirmed (medium) | Parent `git/` cgroup with totals; Node in `main` leaf; slice fallback; section 9 wording; A3 concurrent test. |
| R6 | Header parse has no byte bound | confirmed (medium) | 4 KiB per line, 128 KiB per header, Buffer scan, stated outside the cgroup; unit and A3 tests. |
| R7 | One `update-ref` transaction cannot delete `a` and create `a/b` | confirmed (high) | Two transactions (deletes, then creates/updates), old tips recorded first, rewrite logged after the second; trials both ways, loose and packed (section 20). |
| R8 | Failed transient units never collected | confirmed (high) | Same as R3. |
| R9 | `lost+found` makes the clone target non-empty; fill loops | confirmed (high) | `rmdir lost+found`, verb fails if the root is not empty; at most 3 fills in a row, then alert; real test 3 uses a made disk. |
| R10 | No remount after a reboot (second report) | confirmed (high) | Same as R4; `new`/`again` split: a filled folder with no disk is refused, never refilled. |
| R11 | Sparse images overcommit the disk | confirmed (medium) | `fallocate`, no `discard` (also `work make`); new folder refused below `WORKTREE_MB` + `F`; section 17 row; test 8. |
| R12 | Review and 409 re-check use a possibly stale reference; reads skipped while asleep | confirmed (medium) | Read and land before a review and before Send; unconfirmed Send needs confirmation; "as of" time and "Read now"; pending reads complete; read on attach/wake; row; test 7. |
| R13 | Locks of a git killed at run time wedge the reference | confirmed (medium) | Locks removed on every mutex acquire and after a killed git; rows; real test 11. |
| R14 | A hanging GitLab fetch holds the mutex; the import deadline counts the wait | confirmed (medium) | Deadline on every git call; low-speed and ssh keep-alive limits; import deadline steps 3-6; bounded mutex wait, "reference busy" row; review "busy". |
| R15 | Send quiet delay lost | confirmed (medium) | `quietMinutes` kept as the send quiet delay, per tip; options renamed; section 17 row; test 7. |
| R16 | Commits in linked worktrees or nested refs never trigger a read | confirmed (medium) | `.git/worktrees` watched (4 per folder), worktree marks, 10-minute safety read as backstop; `gitkeeper.mjs` mirrors; real test 12. |
| R17 | Exit-code mapping and messages incomplete | confirmed (low) | Only 0, 65, 66, 78-82, else "host program failed"; exact duplicates dropped; hints per header reason; no-branches case lands; AI hint after 2 failures; unit tests. |
| R18 | Upgrade guard only at start and cannot run from the server | confirmed (medium) | Version check in `git read` against `runner-ok`; `git selftest` verb, apt hook; section 5 paragraph; row; tests. |
| R19 | Full history per read can exceed deadlines on large repositories | confirmed (low) | Import deadline grows with the cap; byte budget default 10 x cap; deadline row; git gc hint only for a small reference; real test 10. |
| R20 | Detach throws away the folder and its refs | confirmed (medium) | Detach only unmounts; archive, discard or idle period put aside; unsent branches listed; size shown; row; real test 9. |
| R21 | Fix 17 single transaction (second report) | confirmed (high) | Same as R7. |
| R22 | fsck exceptions never reach index-pack | confirmed (high) | `--strict=<id>=<sev>` on index-pack, `fetch.fsck.<id>` on fetches and clone; `receive.fsck` dropped; real test 13. |
| R23 | `worktree make` one-shot; backup and restore | confirmed (high) | Same as R4/R10; restored directories moved into a new disk; backup/restore exclude `worktree-disks` and make `$MNT` root's. |
| R24 | `lost+found` (second report) | confirmed (medium) | Same as R9. |
| R25 | A leftover unit blocks reads (third report) | confirmed (medium) | Same as R3. |
| R26 | Step 7 `fsck` duplicates `index-pack --strict`; cap wording | confirmed (low) | Step 7 dropped; cap written as a `min`, owner alerted when clipped; incremental plan in section 7. |
| R27 | Invalid branch "untouched" yet deleted by the landing | confirmed (medium) | Deletes only names absent from the header; dropped names count as present. |
| R28 | Refresh loses a rewrite on a partial fetch failure | confirmed (medium) | Porcelain dropped; ancestry check of before-refs after every fetch and at start; unit test. |
| R29 | Cgroup controllers cannot be enabled with a bare `Delegate=yes`; command list | confirmed (low) | `Delegate=memory pids cpu`, `DelegateSubgroup=main`; "every call the builder makes". |
| R30 | Upgrade guard (second report) | confirmed (medium) | Same as R18. |
| R31 | Fix 16 weakens the import check | not confirmed | No change: every import carries the legacy history, so the exception is needed there. |
