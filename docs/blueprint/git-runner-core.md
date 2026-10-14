# The git runner: the minimal secure core

## Threat model (owner's decision)

**Out of scope**: unknown bugs in git, the kernel and systemd. We keep git
updated and do not design around unknown parser bugs; findings of that kind
are not counted. Time and size limits stay: they also stop plain resource
exhaustion.

**In scope**: everything the AI agent controls that our commands use:
- the folder and its `.git`: config (`core.sshCommand`, `core.fsmonitor`,
  credential helpers, `url.*.insteadOf`, `include.path`, filters), hooks, a
  `gitdir:` gitfile, a `.git` symlink, `commondir`,
  `objects/info/alternates`, `shallow`, symlinks inside `.git` and `refs`,
  file modes;
- the names it chooses: branch and ref names (option-like, with `../`),
  file names, commit messages;
- sizes and timing (including changing the folder during a read);
- hence the arguments, paths, options and environment of every command we
  run with that data.

## Rules for every git command

From git(1) SECURITY and how forges (Gitaly) run git. The server's builder
(section 4) applies all of them; the sandbox (section 3) those that fit a read.

1. `execFile` with an argument array; never a shell.
2. Environment built from nothing (no inherited `GIT_*`): `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` and `XDG_CONFIG_HOME` on an empty
   place, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_REPLACE_OBJECTS=1`, `LC_ALL=C`, `PATH`.
3. `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never`,
   then `protocol.<p>.allow=always` only for what that command needs (https/ssh
   to the remote); `transfer.fsckObjects=true` where we receive.
4. `--end-of-options` before any value that comes from the agent (or owner).
5. Full refspecs only: `refs/heads/<x>:refs/heads/<y>` (or the fixed `*` forms
   below). A push source is never a bare id (git tries a ref of that name
   first): it is `refs/clavarium/send`, the only ref left in the workspace,
   set to the verified id (section 6); its destination `refs/heads/<y>`.
6. Every ref name validated before use (`branchProblem`: the
   `check-ref-format` rules, allow-list `[A-Za-z0-9._/-]`, no leading `-`, no
   `..`, no component of 40 or 64 hex characters); bytes checked before
   decoding, so non-UTF-8 is refused.
7. Output parsed with `-z` / `%x00` as bytes, and treated as data: messages,
   names and paths are shown escaped, never interpreted.
8. Credentials only through the environment (`http.extraHeader` via
   `GIT_CONFIG_COUNT`, today's `asEnv`; or `GIT_SSH_COMMAND` with a key file),
   never in argv, never in a file the agent can see.
9. Never read a configuration value from the agent's repository: remote,
   target, names come from the server's records.
10. Nothing from the agent is ever written into the reference; push only from
    a throw-away workspace (section 5), never from the agent's folder.

"The remote" is whatever git server the repository points at (GitLab, GitHub,
Gitea, self-hosted git over ssh or https); nothing here depends on which.

No maintained Node.js library covers this model: simple-git blocks argument
injection only (a `core.fsmonitor` in the repository's own config ran during
`status()` in a test); isomorphic-git executes nothing but follows gitfiles
and `.git` symlinks, reads a file outside the repository through a crafted
ref name, and has no size limit; nodegit is unmaintained. So: the git binary
through `execFile`, plus the runner sandbox for the one read of the agent's folder.

Build note, step A1, 14-10: the part to build **first**; `git-runner.md`
stays the full design and review record (its section 20: older trials). git
2.43.0, systemd 255. "Trial" = run on the development box on 14-10.

## 1. The hole, the rule, the scope

Today `GitReview.#copy` clones `resources/<name>`, which the agent writes,
as the server with `safe.directory=*`: a `.git` gitfile, symlink, `commondir`
or `alternates` makes it copy, show and push any repository the server reads.

**Rule: the server never runs git on a path the agent can write.** A root
host verb reads the folder in a throw-away sandbox and writes a full bundle
to stdout; the server treats it as hostile and imports it into a throw-away
workspace, made fresh for each review and each send and then deleted. The
reference (`resources/<name>-origin`, today's mirror) holds only the remote's
history and only the refresh writes it; **no agent data is ever written
there**. Kept: the shared folder, the mirror, `gitaccess.mjs`, `branchProblem`,
`allowed`, `quietMinutes`, `perHour`, the checks in the machine, the log.
Brought in from `git-runner.md` section 4: the root-owned **`$MNT`** chain
and **`held`** (section 2), and its host exit-code mapping.

**Deferred** (designed in `git-runner.md`): per-agent folders, fixed-size
disks, quotas; worktree `make`/`aside`; the upgrade guard and `git selftest`;
cgroup budgets on server git; keeping rewritten remote tips (core: an alert);
incremental bundles; per-object/inflated-size limits; owner-confirmed
non-fast-forward pushes; `fs.watch` (core: today's `lstat` marks); fsck
exceptions scoped to objects (`fsck.skipList`; core: whole id, allowlist
only); a sandboxed push (section 5: only if git bugs come into scope);
header-only check reads and a cached R (optimizations).

## 2. Host verbs

In `deploy/clavarium-host`, in its style (fixed argument count, `is_name`,
paths built from the name, argv and properties fixed). Never a server path.

**`$MNT` and `held`.** Everything root mounts, unmounts or moves --
`resources/` (the folders), `views/` (their read-only views), `work/` and
`work-disks/` (the work disks), `removed/` (what was put aside) -- moves
from the server-owned `$DATA` (server account, 0750) to `$MNT/<dir>`
(`$MNT` = `/home/clavarium-mnt`, in `host.conf`). `held <path>`: each
component from `/` down to the entry's parent is a real directory (not a
link), root's, not group- or world-writable, with no access list (`ls`
'+'); the entry is a real directory. The server then cannot swap any
component (rename or `RENAME_EXCHANGE` needs write on a parent), so the
path systemd, `mount`, `bindfs`, `umount`, `mv` or multipassd walks later
is the one checked. `kept <dir>` (any of the five) and `folder_of` call
`held`; so do `git read`, `vm mount folder|view|work` (on the source
itself), `view make|close` and `work make` (on the entry, after `mkdir`).
`$DATA` keeps only the server's own files, which root never touches. Never
a `/proc/self/fd` staging path (`mount` walks the path again:
`git-runner.md` R1). `install.sh` creates `$MNT` and its five directories
root:root 0755, writes `MNT` to `host.conf` (the server reads it from
there), then runs `deploy/move-to-mnt.sh` once (server stopped): a name on
both sides refuses the whole move; the machines' mounts from `$DATA` are
noted and let go of, views closed, work disks unmounted; the entries are
moved (never copied); each machine is given back what it had, through the
host program, from the new places. `backup.sh`/`restore.sh` take `$MNT`;
`restore.sh` makes `$MNT` and its directories root:root 0755, puts an
older archive's `home/clavarium/{resources,work,removed}` under `$MNT`
(tar `--transform`, link targets untouched), and adds `MNT=` to a restored
`host.conf` that lacks it.

| Verb | Checks, then action |
|---|---|
| `git read <name>` | `is_name`; refused if it ends in `-origin` (never the reference). Source `$MNT/resources/<name>` via `folder_of` (`held`). `exec 0</dev/null`; refused unless stdout **and** stderr are pipes (`LimitFSIZE=0` kills git writing to a regular file, trial). `flock -n /run/clavarium/read-<name>.lock`, else refused "busy". Unit `clvread-<name>_<16 hex from /dev/urandom>` (`_` never in a name). Runs section 3 as a background child it `wait`s for (a signal cuts `wait` short; a foreground command would hold the trap back until the read ended); a TERM/INT/HUP/PIPE trap stops the unit and exits 82, an EXIT trap stops it on any other way out; then `reset-failed`. Exits with a mapped code only. |
| `git stop <name>` | `is_name`; `systemctl stop 'clvread-<name>_*'`, `reset-failed` on them. After the server kills a read, and at server start for every git repository. |

**Exit codes** (fixed by the host, `git-runner.md` section 4): **78**
refused (`REFUSED: ...`, before any unit exists); **64** usage. Otherwise,
if `systemd-run --wait` returns 0: **0**. Else the unit stays loaded (no
`--collect`; a failed unit is kept until `reset-failed`) and `systemctl show
-p Result,ExecMainCode,ExecMainStatus` maps it: exit 128 -> **65**; exit 3
-> **67** (unreadable refs, section 3); other exit -> **66**; `timeout` ->
**80**; `oom-kill` -> **81**; signal or core dump -> **82**; did not start
(`resources`, 200-243) or unreadable state -> **79**. Nothing else is
emitted. Code inside can choose only among 0, 65, 66, 67, and stderr text;
the server trusts only 0, and 65 + exactly 17 bytes (`# v2 git bundle\n\n`)
as "no branches"; all else fails. Unique names + `reset-failed`: a failed
unit never blocks the next read.

## 3. The sandbox

```
systemd-run --quiet --wait --pipe --service-type=exec --unit="clvread-${N}_${RAND}" \
  -p DynamicUser=yes -p RootDirectory=/var/lib/clavarium/runner-root -p MountAPIVFS=no \
  -p "TemporaryFileSystem=/dev:ro /tmp:ro /var/tmp:ro /resources:ro" -p "BindPaths=/dev/null /dev/zero /dev/urandom" \
  -p DevicePolicy=closed -p "DeviceAllow=/dev/null rw" -p "DeviceAllow=/dev/zero r" -p "DeviceAllow=/dev/urandom r" \
  -p "BindReadOnlyPaths=/usr /usr/bin:/bin /usr/lib:/lib /usr/lib64:/lib64 $MNT/resources/$N:/resources/$N" \
  -p PrivateNetwork=yes -p RestrictAddressFamilies=AF_UNIX -p NoNewPrivileges=yes \
  -p CapabilityBoundingSet= -p AmbientCapabilities= -p RestrictNamespaces=yes -p RestrictSUIDSGID=yes \
  -p RestrictRealtime=yes -p LockPersonality=yes -p MemoryDenyWriteExecute=yes \
  -p SystemCallArchitectures=native -p SystemCallFilter=@system-service \
  -p "SystemCallFilter=~@aio @keyring @setuid @chown @memlock @privileged @resources userfaultfd kcmp process_vm_readv process_vm_writev msgget msgsnd msgrcv msgctl semget semop semctl shmget shmat shmdt shmctl mq_open mq_unlink" \
  -p SystemCallErrorNumber=EPERM \
  -p RuntimeMaxSec=300 -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=8 -p CPUQuota=100% \
  -p LimitFSIZE=0 -p LimitCORE=0 -p LimitNOFILE=256 -p WorkingDirectory=/resources/$N \
  -E PATH=/usr/bin -E HOME=/nonexistent -E XDG_CONFIG_HOME=/nonexistent -E LC_ALL=C -E GIT_CONFIG_NOSYSTEM=1 \
  -E GIT_CONFIG_GLOBAL=/dev/null -E GIT_CEILING_DIRECTORIES=/resources -E GIT_NO_LAZY_FETCH=1 \
  -E GIT_TERMINAL_PROMPT=0 -E GIT_OPTIONAL_LOCKS=0 -E GIT_NO_REPLACE_OBJECTS=1 \
  /usr/lib/clavarium/git-read $N
```

`/usr/lib/clavarium/git-read` (root:root 0755, `install.sh`; inside via the
`/usr` bind) is fixed sh; it reads only paths from the repository and never
echoes them (the full text is `deploy/git-read`; red team A3 changed it, see
the review log at the end):

```
[ -d .git ] && [ ! -L .git ] && [ ! -e .git/commondir ] && [ ! -L .git/commondir ] \
  || { echo "NOT A PLAIN .git DIRECTORY" >&2; exit 66; }
for p in .git/refs .git/packed-refs; do ...find -L... || { echo "REFS UNREADABLE" >&2; exit 3; }; done
.git/shallow or .git/info/grafts present -> "SHALLOW REPOSITORY", 66
export GIT_DIR=.git     # never discovery: git would try the folder as a bare repository
g() { /usr/bin/git -c safe.directory=/resources/$NAME -c safe.bareRepository=explicit -c core.hooksPath=/dev/null -c core.fsmonitor=false \
  -c core.pager=cat -c core.alternateRefsCommand= -c protocol.allow=never -c pack.threads=1 \
  -c pack.windowMemory=256m -c pack.useBitmaps=false "$@"; }
g rev-parse --show-object-format = sha1, else "NOT SHA-1", 66
refs = g for-each-ref --format='%(objectname) %(refname)' refs/heads/
names of refs == loose files under .git/refs/heads (not *.lock) + refs/heads lines of packed-refs,
  else "BROKEN OR CHANGING REFS", 66;  more than 1000 -> "MORE THAN 1000 BRANCHES", 66
no refs: print "# v2 git bundle\n\n", exit 128
print "# v2 git bundle\n<refs>\n\n"; ids of refs | g pack-objects --stdout --revs --delta-base-offset -q
git failing: 66 (a signal re-raised)
```

The bundle is **built by the script**, not by `git bundle create`: that
command resolves every branch a second time by name and silently leaves out
one that moved meanwhile or whose name is ambiguous (`a` beside `a/b`, a
branch named `refs/heads/main`), and `for-each-ref` silently skips a symbolic
ref pointing nowhere or in a loop (trials, A3). Here the list is taken once,
the pack is made from its ids, and the list must name every ref file on
disk: a ref git skips, or a branch made or deleted during the read, refuses
the read instead of losing a branch.

Without the readability check, a 000 `refs/heads/feat` gives exit 0 with
`feat/*` silently missing, and a 000 `refs/heads` gives 128 + 17 bytes, as an
empty repository (trial). The first line refuses a gitfile, a `.git` link or
`commondir` (any of them could send git to refs elsewhere in the folder that
the check never saw); `find -L` checks a linked ref directory where git
reads it. A folder changed during the read gives at worst a refused read
("BROKEN OR CHANGING REFS", or a pack whose objects were pruned meanwhile),
reported. The server takes the last stderr line of a 66 to name the failure
(`shallow`, `v3`, `many`, `refs`; section 8); the agent can forge that line,
which only renames its own read's failure. `systemd-run` passes no caller
environment: only the `-E` list above.

`GIT_DIR=.git`: git opens the `.git` the checks looked at and nothing else.
Left to discovery, git that finds `.git` unusable (a junk `HEAD`) tests the
folder itself as a bare repository, and a read of objects and refs no check
saw succeeds (audit, git 2.43: a shallow bare clone at the top passed every
check). Now that is "GIT COULD NOT OPEN THE REPOSITORY" (66).
`/resources:ro` in `TemporaryFileSystem`: the root keeps a mount point per
folder ever read; an empty `/resources` over it shows only the one bound.

`runner-root`: empty, root:root 0755 (`install.sh`). `$MNT` matches
`[A-Za-z0-9/._-]`, `N` `is_name`: the bind list cannot be split. Inside
(trial): dynamic uid; `/` = read-only binds, empty mountpoints, empty `/proc`;
`/dev` = `null`, `zero`, `urandom`; nothing writable; stdin at EOF.
The sandbox is for what the agent controls: should any command from its
config get past the overrides, it runs with nothing to reach or keep.
The second filter takes io_uring, userfaultfd, keyring, setuid, `kcmp`,
`process_vm_*` and host SysV/POSIX IPC away (`@system-service` keeps them;
the IPC calls are listed one by one because `@ipc` holds `pipe`/`pipe2`).
**Must NOT be added** (trial): `ProtectKernelTunables`, `ProtectControlGroups`,
`ProtectProc` bring back the host's whole `/dev` and `/proc`; `PrivateDevices`
binds host `/dev/shm`, `/dev/pts`; `PrivateIPC` adds a writable `/dev/mqueue`
(the filter closes host IPC instead); `ProtectHostname` fails (226);
`TemporaryFileSystem=/` shows the host root. `PrivateNetwork` leaves a
read-only host `/sys` (section 9).

## 4. Receive, into a fresh workspace

1. **Limits**: 1 read per repository (server queue + flock), 2 on the host.
   Cap = min(8 GiB, max(512 MiB, 2 x R + 256 MiB)), R = `rev-list
   --disk-usage --objects --branches` on the reference: the remote's history
   only, so nothing the agent commits raises it (R = 0 with no reference
   yet). Refused below 2 x cap + 5 GiB free. The **workspace** (section 5):
   fresh `$DATA/git-work/<random>` (0700), `git init --bare
   --object-format=sha1`.
2. `sudo -n clavarium-host git read <name>`, stdout/stderr pipes. **Every
   stdout byte counted**; past the cap: kill, `git stop`, clean up. Deadline
   360 s over steps 2-5. Stderr: last 4 KB, printable ASCII, labelled "text
   from the agent's repository".
3. **Header**, in Node, on Buffers, before any git: refused once a line passes
   4 KiB or the header 128 KiB (the agent is told: shorter names or fewer
   branches; 1000 names of 200 characters do not fit, the header limit is
   the binding one), or on a control byte (below 0x20, 0x7f). Bytes above
   0x7f pass, so a name git allows (`café`) is dropped by `branchProblem`
   and said, alone, instead of failing every read. Exactly `# v2 git bundle`; no `-<sha>`
   prerequisite; lines `^[0-9a-f]{40} refs/heads/(.+)$`; exact duplicates
   dropped, one name with two shas refused; at most 1000 lines, dropped
   names included (the reader lists at most 1000: more means some were left
   out); names failing `branchProblem` dropped and reported; an empty line,
   then `PACK`. A pack lacking objects ("did not receive expected object")
   is `incomplete`, with the `--unshallow` advice.
4. Pack bytes, still counted, into `git index-pack --stdin --strict[=<id>=<sev>,...]
   --threads=1 --max-input-size=<cap>`: in the empty workspace it checks
   every object and link. **fsck exceptions** (owner option, `ignore`/`warn`)
   only for a fixed allowlist of legacy-history ids: `zeroPaddedFilemode`,
   `badFilemode`, `badTimezone`, `badDate`, `missingEmail`,
   `missingNameBeforeEmail`, `missingSpaceBeforeEmail`,
   `missingSpaceBeforeDate`. Any other id (`hasDot*`, `gitmodules*`,
   `symlink*`, `nulIn*`, `badTree`, `fullPathname`, `emptyName`,
   `largePathname`, `duplicateEntries`...) is rejected by the option
   validator and never offered. They go as `--strict=<id>=<sev>` (index-pack
   reads no fsck config, trial) and `-c fetch.fsck.<id>=<sev>` on the
   refresh; a refusal on an allowlisted id offers it to the owner.
5. `cat-file --batch-check` on the header shas: each a commit. One
   `update-ref --stdin` writes them as `refs/heads/<b>` in the workspace (one
   repository cannot hold `a` and `a/b`: refused, named). Steps 1-5 run
   with no alternates: the bundle must be complete on its own.

Every server-side git: one builder (today's `runGit`) applying the rules at
the top, plus `GIT_ATTR_SOURCE=<empty tree>`, `core.attributesFile=/dev/null`,
`gc.auto=0`, `http.followRedirects=false`, a deadline. It runs only in the
reference and in workspaces, all the server's. Never `safe.directory`. On
the deadline it kills git's process group (`detached` spawn,
`process.kill(-pid)`) and waits for `close` before the mutex is released.

## 5. The reference and the workspace

**Reference** (`resources/<name>-origin`): only `refs/heads/*` fetched from
the remote. Written by the refresh (section 6) alone, made by it on first
use (`makeOrigin`, `shareOrigin`); no remote, or not refreshed yet: no
reference, R = 0, base = the empty tree. Under the **reference mutex** (one
per reference, in the server: refresh, review, send, upkeep; replaces
`#locked` and `#mirrorQueue`), waited at most 60 s, else "reference busy".
Upkeep: a daily `repack -a -d --threads=1` under the mutex (remote objects
only); a refresh killed by its deadline has its `*.lock` files removed under
the mutex, logged.

**Workspace**: `$DATA/git-work/<random>`, one per review, per send, per
automatic check read; never reused. `$DATA` is the server account's (0750),
outside `$MNT`, never bound into a sandbox or mounted into a VM: the agent
cannot reach it. `git-work/` (0700) is emptied at server start; each
workspace is removed in `finally`, also after a deadline kill. Its git has
no config but what the server writes: no agent config, hooks or attributes.

**Borrowing the remote's objects.** After step 5 of section 4, and only
when needed (review, send), under the reference mutex, the server writes one
line into the workspace's `objects/info/alternates`: the absolute path of
`<reference>/objects`, a server constant. The remote tip is read in the
reference with `rev-parse --verify --end-of-options refs/heads/<target>`
(read-only) and used in the workspace as a 40-hex id. Safe because:
- git reads an alternate as an object source only; every write in the
  workspace (objects, packs, refs, locks) goes to the workspace's own
  directories, and the reference has no alternates of its own;
- no `gc`, `repack` or `prune` ever runs in a workspace (`gc.auto=0`), the
  only commands that could act on borrowed objects;
- the line is added after index-pack and the commit check, so the receive
  checks still see an empty repository and an incomplete bundle is refused;
- the mutex is held while the workspace uses it, so no refresh or upkeep
  removes a borrowed pack mid-use; at worst a missing object fails the
  review or send, never the reference.

Borrowing supplies remote objects the agent has not fetched (the remote
tip, base); it does not shrink the full bundle's import, which waits for the
deferred incremental bundles.

**The push runs in the workspace, not in a second sandbox.** The workspace
holds the credential (environment only) and agent-made objects that passed
index-pack `--strict` and the commit check; it holds no agent config, hook,
attribute or path, and the remote, target and refspec come from the server.
Reaching the credential from those objects would take a bug in git's pack or
transport code: out of scope by the threat model. If that ever changes, the
push moves into a unit like section 3 with network to the remote only
(deferred).

## 6. Review, refresh, push

**Review.** Refresh, then read into a fresh workspace (failure: shown, no
review); under the mutex (10 s, else "busy"), borrow the remote's objects,
then in the workspace: base = the remote tip id of `<target>`, head =
`refs/heads/<b>` (owner's pick; default the last moved, from the server's
records). Today's `#outgoing` fields, the true `rev-list --count`, and `git
diff --text --no-ext-diff --no-textconv --no-color` with `GIT_ATTR_SOURCE` =
empty tree: no `.gitattributes` can hide or rewrite a file. Streamed, killed
at `DIFF_MAX`, "cut" shown. Against hidden history: new-object size
(`rev-list --objects --disk-usage base..head`), the 10 largest new blobs
(`cat-file --batch-check`), paths changed with no net change (`log
--name-only` minus `diff --name-only`), full messages and authors; control
characters shown escaped (Cc, Cf, line and paragraph separators, every
Default_Ignorable_Code_Point: zero-width, BOM, soft hyphen, fillers, tag
characters); an extra confirmation above 100 commits or when
the diff is cut. **What the review could not show is said, never read as
nothing** (A3): the state rests on `merge-base --is-ancestor` both ways
(a failure of it fails the review), never on a count; a count that failed
is "could not be counted", not 0; the diff stopped by its deadline counts
as cut; a log cut by its 8 MiB limit lists only whole commits; messages
over 4000 characters say how much is not shown; more than 50
changed-and-changed-back paths say how many more; any such gap is listed in
`guards.incomplete` and asks for the extra confirmation. The server keeps `branch`, `head`, `remoteTip` (ids) and
"branches as of <time>"; the workspace is deleted. Another pick is a new
review. **No remote**: no refresh, no borrowing; state `no-remote`, commits
against the empty tree; Send refused "no address".

**Refresh** (today's `#refresh`, under the mutex): `fetch --prune --no-tags
--end-of-options <remote> '+refs/heads/*:refs/heads/*'`, never `--atomic`, never a wider
refspec. A tip before that is not an ancestor of its successor, or is gone,
alerts the owner. The only writer of the reference.

**Send** (page or automatic), in its own fresh workspace: (1) read and
receive (section 4), else refused "could not confirm the agent's branch";
(2) under the mutex, refresh from the remote, else "remote unreachable"; if
the reference's `refs/heads/<target>` is `head` or has it as an ancestor:
"already on the remote", sent, logged and counted in `perHour` once,
nothing pushed; (3) the workspace's `refs/heads/<b>` must be **exactly the reviewed `head`
id** (else 409 "the agent changed this branch"; same id, same content: git's
SHA-1 has collision detection), the reference's `refs/heads/<target>` the
reviewed `remoteTip` or absent if it was (else 409 "the remote moved"); then
one `update-ref --stdin` deletes every agent ref and writes
`refs/clavarium/send` = `head`, the workspace's only ref; borrow, and
`merge-base --is-ancestor <remoteTip> refs/clavarium/send` must hold (else
"diverged"); (4) in the workspace:

```
git push --porcelain --no-verify --force-with-lease=refs/heads/<target>:<remoteTip, or empty> \
  --end-of-options <remote> refs/clavarium/send:refs/heads/<target>
```

The lease implies force when it matches: the fast-forward rests on (3)
together with a source that can only be the reviewed id (no ref named after
an id can exist, rule 6, and none but `refs/clavarium/send` is left). The
porcelain line must name that source and destination with flag ` ` or `*`;
a `+` or "(forced update)" is a failure, alerted. (5) Refresh: the pushed
commits enter the reference only as the remote's history, as a fast-forward
(no rewrite alert); if it fails: "sent, reference not refreshed", counted.
A push ended by deadline or signal (not a porcelain refusal) has an
unknown outcome: refresh; `refs/heads/<target>` = `head` -> sent, counted
in `perHour`; else "outcome unknown, refreshed: not on the remote"; if the
refresh fails: "outcome unknown, remote unreachable", kept in the server's
records, auto-send blocked for that branch until a later refresh settles
it. The workspace is deleted in every case.

## 7. Automatic sending, on the new reading

Today's rules and options: off until the owner names branches (`allowed`),
`quietMinutes`, `perHour` (default 4), checks required, log, alert.

- **Trigger**: today's 30 s tick on the `lstat` marks, each repository on
  its own (A3: one whose read takes its whole time limit no longer holds up
  the others; a repository still busy from an earlier tick is skipped; the
  two host read slots stay shared); a change schedules a
  read 5 s after the last one; a change during a read sets a dirty flag (one
  more read). A safety read every 10 minutes while in use; one at start.
  Each read is a check read: a fresh workspace (section 4, no borrowing),
  its branch tips recorded, then deleted.
- **Real debounce**: the server's records keep, per branch, its last tip
  and `movedAt` = the read that first saw it; each new tip restarts the
  clock. Candidate: name allowed, tip has commits the remote lacks (under
  the mutex, read-only in the reference: `cat-file -e <tip>^{commit}` and
  `merge-base --is-ancestor <tip> <exact id of refs/heads/<b>>` both
  succeeding means not a candidate, nothing logged; no such branch: a
  candidate unless the tip is on another remote branch (merged there,
  then deleted); missing or not an ancestor: a candidate), checked before the cap and the checks, now - `movedAt` >= `quietMinutes`, no read queued,
  running or dirty. `perHour` cap with alert; checks in the machine against
  `refs/heads/<b>` = tip; Send as above with that tip as `head` and the
  reference's tip as `remoteTip`, in a fresh workspace, never forced;
  diverged, refused, checks failed logged once per commit.

## 8. Every failure is a failure

Owner: every row (log; phone after 2 in a row). AI: one wake-up line, where it can act.

| Failure | Owner sees | AI told |
|---|---|---|
| Host refused (78): busy, not a folder, a link, chain not root's | "could not read: <reason>" | no |
| Unit did not start (79), sudo, other host code | "host program failed (<code>)" + one alert while it lasts (not one per read) | no |
| Time limit (80) | "reading stopped: time limit" | "your repository could not be read in 300 s; pack it (git gc)" |
| Memory limit (81) | "reading stopped: memory limit (1 GB)" | "your repository needs too much memory to read; pack it (git gc)" |
| Other kill (82) | "reading stopped: killed (<signal>)" + alert after 2 | no |
| Unreadable refs (67) | "some branches are not readable" | "check permissions (chmod -R o+rX .git)" |
| Shallow or grafts (66, "SHALLOW REPOSITORY"); pack lacking objects | "not read: shallow or grafts" | "git fetch --unshallow (and remove .git/info/grafts)" |
| Ref git skips, or branches made/deleted during the read (66, "BROKEN OR CHANGING REFS") | "not read: a ref git skips, or branches changing" | after 2 in a row: "fix or delete it (compare ls -R .git/refs/heads with git branch)" |
| Not SHA-1 (66, "NOT SHA-1"); over 1000 refs (66, "MORE THAN 1000 BRANCHES") | the reason | "use SHA-1"; "delete branches" |
| Git failed (65 not empty, 66) | code + text from the agent's repository | after 2 in a row: "could not read your repository: a plain .git directory, check permissions (chmod -R o+rX .git), not shallow, SHA-1" |
| Over the byte cap | "N MB, over the cap" | "your branches add up to more than N MB" |
| Not enough free space | "not read: N MB free" + one alert while it lasts (same kind = same failure, whatever N says) | no |
| Bad header (v3, prerequisite, two shas, over 1000, too long, no `PACK`) | "could not be read safely: <reason>" | v3: "use SHA-1"; prerequisite: "git fetch --unshallow"; over 1000: "delete branches"; over 4 KiB / 128 KiB: "rename / shorter names or fewer branches" |
| A review command failed or was stopped | listed under the guards ("could not be counted", "not whole"...), extra confirmation; ancestry failing: the review fails | no |
| Invalid branch name | listed, not offered | "branch <b> was not taken: <rule>" |
| index-pack refused (fsck), tip not a commit | id, object, path; exception offered only for an allowlisted id, else "refused" -- said as soon as index-pack ends, even while the reader still writes (`--strict` stops at the first bad object: waiting for the reader on a full pipe made it a time limit) | "fsck refused your commits: <id>" |
| No branches | "no branches"; nothing to review or send | "nothing committed on a branch (git switch -c <name>)" |
| Two branches clash (`a` and `a/b`) | both named, read refused | "branch <b> clashes with <b2>; rename one" |
| Reference busy / stale refresh lock removed | review: "busy, try again"; logged | no |
| Refresh failed, remote unreachable, or git could not even start (key gone, vault not opening) | `explain()` text, or the reason; alert after 3 | no |
| Remote rewrite or delete | "<b> was rewritten on the remote" + alert | "origin/<b> was rewritten; fetch again" |
| Read before Send failed / agent moved / remote moved / lease refused / no address | the reason (409) | automatic, remote moved: "pull origin/<b> first" |
| Push outcome unknown (killed, or failed with no porcelain line for our ref) | "outcome unknown, refreshed: <sent / not on the remote>"; refresh failed: "outcome unknown, remote unreachable" + one alert, auto-send blocked for <b> until a refresh settles it -- "not arrived": sent again | no |
| Push ok, refresh after it failed | "sent, reference not refreshed" (counted) | no |
| Already on the remote | "already sent" (counted once) | no |
| Push reported a forced update or another source | "push not as reviewed" + alert | no |
| Not in list / diverged / cap / checks failed | as today, once per commit | diverged: "pull origin/<b> first"; checks: their output |
| Automatic sending: remote unreachable, outcome not on the remote, workspace, other error | said once per commit; the same commit tried again after 5 minutes (only diverged, remote moved, refused, forced end it for that commit) | no |

## 9. Attacks stopped; what is not protected

| Attack | Stopped by |
|---|---|
| `.git` gitfile, symlink, `commondir`, `alternates`, `../` | Only the folder exists in the sandbox (trial: "not a git repository"); `GIT_CEILING_DIRECTORIES`; `git-read` refuses all but a plain `.git` directory. |
| Hooks, fsmonitor, pager, filters, aliases, `sshCommand`, credential helpers, `insteadOf`, `include.path` in `.git/config` | Overridden on the command line; `bundle create` runs none, `protocol.allow=never`; the server never reads that config. |
| A config command the overrides miss; FIFO, endless or huge files | Dynamic uid, no capability, no network, nothing writable, no `/proc`, 3 devices, seccomp (`@system-service` minus io_uring, userfaultfd, keyring, setuid, `kcmp`, `process_vm_*`, host SysV/POSIX IPC); `RuntimeMaxSec`, `MemoryMax`, `TasksMax`, byte cap; host-fixed exit codes. |
| Endless header, forged bundle, prerequisites | Bounded Node parse; empty fresh repository; `index-pack --strict`; commit check. |
| Hostile `.gitmodules`, `.git` path, symlink tree; agent asking for the waiver | fsck; exceptions only for the legacy-history allowlist, never offered for these. |
| Unreadable ref directory read as "deleted" | `git-read` refuses (67); a missing branch deletes nothing. |
| Ref names with `..`, a leading `-`, control or non-ASCII bytes | Header bytes checked, `branchProblem`; `--end-of-options`, full refspecs; only `refs/heads/` read; agent refs written only in a workspace. |
| Credentials or a remote taken from the agent | Credentials only in the server's environment; remote and target from the server's records; push only from a server workspace the agent cannot reach. |
| Agent data kept or planted in the reference; a workspace reused | Nothing from the agent is written there (only the refresh writes it); one fresh workspace per review, send and check read, deleted after, `git-work/` emptied at start; alternates read-only, added after the receive checks; group kill. |
| `.gitattributes` hiding a change | `--text`, no textconv, attributes from the empty tree. |
| History hidden from the review (add then delete, huge blobs, past 100 commits, a huge message, decoy paths, a command stopped by its limit) | New-object size, largest blobs, no-net-change paths, full messages, escaped control and invisible characters, every gap listed in `guards.incomplete`, extra confirmation. |
| A branch silently left out of a read (moved during it, ambiguous name, `a` beside `a/b`, a symbolic ref pointing nowhere) | The bundle built from one `for-each-ref` list, checked against the ref files on disk; `a`/`a/b` refused by name. |
| One repository's slow reads holding up the others | Each repository ticks on its own. |
| Branch changed between review and Send | Send re-reads into a fresh workspace and pushes only the exact reviewed `head` id; lease on the shown `remoteTip`. |
| Branch named after the reviewed id (push source or lease forcing another commit) | `branchProblem` refuses 40/64-hex components; agent refs deleted, push from `refs/clavarium/send` only; porcelain line checked (no `+`, no forced update). |
| Commit loop | Debounce, read pacing, `perHour`, alert; cap from the remote's size only; workspaces deleted. |
| A bent path (compromised server): name, or `resources/` swapped for a link (`RENAME_EXCHANGE`) | The host takes a name only; the source sits on the root-owned `$MNT` chain checked by `held`, so the server cannot change any component; the sandbox uid reads only world-readable bits. |

**Out of scope** (threat model): unknown bugs in git, the kernel, systemd,
including in the server-side parsers (index-pack, diff, merge-base, push on
agent objects, the last with the credential in its environment). **Not protected**: server memory against a pack under the
cap that inflates hugely (deadlines only, until cgroup budgets); the multipass mount's links and special
files; a read-only `/sys` in the sandbox; the shared folder (no attribution,
unbounded, as today); what is reviewed carelessly or auto-sent (merge
parents beyond the first shown only as a count); agents seeing each other's
branches; the agent's network; remote rewrites beyond the alert; an
allowlisted fsck waiver covering a whole read.

## 10. Test plan

**Unit** (`--say-only`; a stand-in runner): verb checks (bad names, `..`,
`-`, `_`, `-origin`, a link, `resources/` or a parent not root's or
group-writable, non-pipe output, busy); `held` on `vm mount folder`; the
exact vector including the second filter line, no "must not" setting;
mapping 0, 65 + 17 bytes, 65, 66, 67, 79, 80, 81, 82, 78, and git exiting 78
or 200 mapping to 66; each header refusal at and one byte over its limit,
1000/1001 names; cap-1/cap/cap+1, agent history never raising the cap;
deadline cleanup, group kill; `a` and `a/b` refused and named; the reference
unchanged (refs and `objects/` identical) after a check read, a review, a
refused send; alternates written only after index-pack and the commit check
(a bundle lacking an object the reference has is refused); each workspace
removed after success, failure and deadline kill, `git-work/` emptied at
start; Send in a new workspace refused when the tip differs from the
reviewed id by any byte; auto-send read before any reference; no-remote
repository shows its commits, Send "no address"; stale refresh locks; lease
present and absent; both 409s; diverged never pushed; the post-push refresh
is a fast-forward, no rewrite alert; push
timing out after the remote accepted it reports sent; a failed refresh after
a push, a double Send from the page, and a server SIGKILLed mid-push then
restarted each end in "already on the remote" (no 409, no AI message); an
unknown outcome with the refresh failing blocks auto-send for the branch;
remote ahead and agent branch behind: no checks, no `perHour` slot, no
"diverged"; `branchProblem` refuses a 40- and a 64-hex component; fsck option rejects
`hasDotgit`, `gitmodulesUrl`, `symlinkPointsToGitDir`; review guards
(add-then-delete path listed, largest blob, >100 commits and cut diff ask
twice, escaped control characters); debounce, dirty flag, `perHour`; every
row of section 8; no failure reads "nothing to send". Builder: every call
has `--end-of-options` before agent values, no inherited `GIT_*`, no
credential in argv; cap with no reference uses R = 0.

**Real** (root, systemd 255): inside the unit, `find / -xdev -writable`
empty, `/dev` and `/proc` as listed, `connect` to host ports 22 and 8770
fails, `io_uring_setup`, `userfaultfd`, `shmget`, `mq_open` return EPERM,
stdin at EOF; `git bundle create - --branches` succeeds under both filters;
`sudo` stdout binary-clean; no unit left after a failed, timed-out or killed
read (after `reset-failed`), and the next read works; mapping read for a
real timeout and OOM; `refs/heads/feat` at 000 -> 67, `refs/heads` at 000 ->
67, the same through a linked `refs` directory -> 67; a gitfile, `.git`
link or `commondir` pointing inside the folder -> 66; a server killed mid-read or mid-review reads again after restart, its workspace gone; worktrees and many
branches read, reference unchanged; a review against a 1 GB reference: its `objects/` unchanged and the
workspace gets no objects from it (the alternates line only), a remote tip
the bundle lacks resolves through the alternate; `zeroPaddedFilemode` history imports
only with the exception; lease push to a local bare remote (ok, moved, new
branch); install moves `resources/` to `$MNT`, backup and restore keep the
chain root's; a 1-2 GB read timed.

**Attack** (A3; each fails safely and says so): every row of section 9, and:
gitfile or `.git` symlink to the vault's directory; `commondir`/`alternates`
absolute and relative; FIFO `.git`, `packed-refs`, object; 10 GB sparse file;
a million refs; forged headers (v3, prerequisite, `refs/tags/x`, two shas,
non-commit tip, truncated pack, endless line); a pack bomb; hostile config
(`include.path=/etc/shadow`, `core.sshCommand`, fsmonitor, pager,
`credential.helper`, `url.*.insteadOf`); branches named `--upload-pack=x`,
`-f`, `a/../b`, non-UTF-8; `-diff`/
`textconv` attributes; SIGKILL of the server mid-send; amend or remote move between
review and Send; 1000 commits a minute; `/proc/1/environ` and the vault path;
a loop of `RENAME_EXCHANGE` of `resources/` (or a parent) with a link to
`/root` during `git read` (refused, or the real folder bound; the server
account cannot do it at all on `$MNT`); a tree tripping `gitmodulesUrl` or
`hasDotgit` refused with no exception offered; an add-then-delete commit
shown in the review; a 0700 ref directory gives 67, nothing deleted; a
bundle whose tip is a remote commit it does not carry, refused; a branch
named after the reviewed id pointing at another commit (refused, and with
`branchProblem` bypassed the push still sends the reviewed id); a
non-fast-forward through a matching lease (refused by (3), never pushed).

## Review log (round 3)

| Finding | Verdict | Change |
|---|---|---|
| `git read` binds through server-owned `$DATA` (raceable; 34/R2 back) | confirmed (medium) | `resources/` on root-owned `$MNT`; `held` in `kept`, `folder_of`, `git read`, `vm mount`; install, backup, restore; section 9 row; A3 `RENAME_EXCHANGE` test. No fd staging. |
| Seccomp narrowing and IPC isolation dropped | confirmed (medium) | Second `SystemCallFilter=~` line with IPC calls listed; no `PrivateIPC`; section 9 row; vector unit test; EPERM real test; bundle under the filter re-checked. |
| Review can push history the owner never saw | confirmed (low) | Section 6 guards brought in (size, largest blobs, no-net-change paths, messages, escaping, extra confirmation); section 9 row; tests. |
| fsck exceptions: any id, whole reference, agent provokes the offer (two findings) | confirmed (low) | Fixed legacy-history allowlist; security ids rejected and never offered; section 8, 9 rows; attack test; object scoping deferred. |
| Unreadable ref directory reads as deleted / no branches | confirmed (medium) | `git-read` wrapper exits 3 -> 67; section 8 row; deletes only when two reads agree; tests. |
| Landing before the reference exists; no-remote never has one | confirmed (medium) | Section 5 step 0 makes it; no-remote Review and Send; tests. |
| Shared exit codes; "cannot forge" claim false | confirmed (low) | Host mapping from `systemctl show` restored (65-67, 79-82); `reset-failed` instead of `--collect`; memory and kill rows; `pack.windowMemory=256m`; claim corrected. |
| Reference never maintained; cap ratchets | confirmed (low) | Cap on reachable `--disk-usage`; section 5 step 4 repack/prune; tests. |
| Deadline kill hits only the git parent; push outcome | confirmed (low) | Group kill and wait in the builder; unknown push outcome resolved by refresh; test. |

After round 3 (owner): threat model and rules added at the top; `git-read`
also refuses a non-plain `.git` and follows linked ref directories (finding
5 completed); cap R = 0 before the reference exists (finding 6).

Owner change: no agent data in the reference. It holds only the remote's
history, written only by the refresh; each review, send and check read uses
a fresh server-only workspace that borrows the remote's objects read-only
(alternates, after the receive checks) and pushes with a lease, then is
deleted; a send pushes only the exact reviewed id. Gone: landing, `refs/agents/*`,
per-ref deletes and the two-read rule, landing lock cleanup, agent-object
maintenance, the cap ratchet (R is now the remote's size). Push not
sandboxed (threat model). "GitLab" now reads "the remote".

## Review log (round 4)

| Finding | Verdict | Change |
|---|---|---|
| Push source as a bare id resolves to an agent branch of that name; the lease forces it | confirmed (critical) | Push from `refs/clavarium/send` after deleting agent refs; `branchProblem` refuses 40/64-hex components; porcelain line checked; "no force" note corrected (rule 5, section 6); section 8, 9 rows; attack tests. |
| Sent push reported as "remote moved"; unknown outcome with a failed refresh undefined | confirmed (low) | "Already on the remote" after the Send refresh; "sent, reference not refreshed"; "outcome unknown, remote unreachable" blocks auto-send; section 8 rows; tests. |
| A branch only behind the remote is an auto-send candidate (false "diverged") | confirmed (medium) | Candidate = tip has commits the remote lacks, checked first; test. |
| Borrowing saves nothing; "copies nothing" test meaningless | confirmed (low, doc only) | Test reworded; section 5 sentence; header-only check reads and cached R deferred. |

## Trial (A2, 14-10, this development box: git 2.43.0, systemd 255, sudo)

Built as above, with three changes found while building, written back here:
the host accepts a **socket** as well as a pipe for stdout/stderr (Node.js
gives a child socketpairs: the pipe-only check refused every real read);
`git-read` **does not `exec` git**: it folds git's codes other than 0, 3,
128 into 66 and re-raises a signal, so 200-243 can only be systemd's (79)
and "git exiting 78 or 200 -> 66" holds; `git code` (say-only) tests the
mapping without root.

Run with `sudo` on copies of `clavarium-host` whose fixed paths (host.conf,
runner root, script, locks) point into a scratch folder; the script was
bound at `/git-read` (the real one lives under the `/usr` bind). Vector
otherwise unchanged. Results:

| Case | Outcome |
|---|---|
| `$MNT` under `/tmp` | 78 "/tmp may be written by others than root" (`held`); `resources/` not root's: 78 |
| Folder replaced by a link to `/etc`; `site-origin` | 78 "no such folder"; 78 "never read this way" |
| stdout to a regular file | 78; to a pipe or a Node socket: 0 |
| Plain repository, 2 branches | 0, 556 bytes; through `GitRunner`: both branches, 124 ms |
| `gitdir:` gitfile (outside and inside the folder), `.git` link, `commondir` | 66 "NOT A PLAIN .git DIRECTORY" |
| `alternates` absolute (a "vault" repository) | git cannot see the path in the sandbox: 65, "bad object", read refused |
| `alternates` relative (`../../../../vault`) | path unresolvable inside: alternates ignored, 0 with the folder's own branch only |
| Refs `--upload-pack=touch /tmp/x` and `-f` in `packed-refs` | git fails ("bad object --upload-pack=..."): 65, refused, nothing ran |
| Branch named by a 40-hex id | git bundles it; the server drops it (`branchProblem`) and says so |
| `refs/heads/feat` at 0700 (agent's own uid) | 67 "REFS UNREADABLE" |
| Hostile config (`include.path=/etc/shadow`, fsmonitor, sshCommand, pager, `pager.bundle`, `alias.bundle`, credential helper, `insteadOf`, `alternateRefsCommand`, `packObjectsHook`, `hooksPath` + hook) | 0, normal bundle; no marker file written by anything |
| FIFO `packed-refs`, `RuntimeMaxSec=5` (copy) | 80 after 5 s; unit gone; next read 0 |
| Same FIFO, server deadline 3 s | `GitRunner` fails "time limit", `git stop` ends the unit, workspace gone, next read works |
| Second read while one runs | 78 "busy" (flock) |
| 1.5 GB blob of zeros (1.5 MB packed) | 0, 1.5 MB bundle; imported in 6.6 s; with `MemoryMax=6M` still 0 (git streams it): the OOM code (81) was not reproduced for real |
| Inside the unit (probe in place of the script) | dynamic uid 64850; `/dev` = null, urandom, zero; `/proc` empty; `/tmp` read-only and empty; folder read-only; stdin EOF; `/proc/1/environ` and the vault path absent; TCP to 127.0.0.1:22 and :8770: EAFNOSUPPORT; `io_uring_setup`, `userfaultfd`, `shmget`, `mq_open`, `kcmp`, `process_vm_readv`, `keyctl`, `setuid`: EPERM; AF_UNIX socket allowed |
| `find / -xdev -writable` inside | only `/usr/lib/systemd/system/*.service` that are links to `/dev/null` (masked units); securityfs/apparmor files are mode 666 but writes fail (I/O error) |
| Units left after all of the above | none (`reset-failed`) |

Found: a unit **stopped** (`git stop`), or ended by SIGTERM/SIGPIPE, counts
as a clean exit for systemd: `git read` then exits **0 with no bytes**. Not a
hole (the server only takes a complete bundle: "ended inside its header"),
but 0 does not mean "read" on its own.

Not tried for real: the `RENAME_EXCHANGE` loop on `$MNT`; install moving
`resources/` (no run on the test server); backup/restore as root; a review
against a 1 GB reference; a 1-2 GB real repository timed; the OOM code.

## Review log (red team A3, 14-10)

Attacks in `test/runner-attack.test.mjs` (21) and
`e2e/runner-attack.e2e.mjs` (8, real unit). No execution and no read of
another repository got through; these did, and were fixed at their cause:

| Finding | Change |
|---|---|
| A failed `rev-list --count` read as 0, state "up-to-date" | State from `merge-base --is-ancestor` both ways (failure fails the review); a failed count is `null`, said, confirmation asked; Send counts again |
| A diff stopped by its deadline shown as whole (medium) | Any stopped or failed diff is `cut`, said, confirmation |
| A 9 MiB message hid the other commits; messages cut at 4000 silently | Only whole commits listed from a cut log; fewer listed than counted is said; cut messages say how much is missing; confirmation |
| Add-then-delete path pushed out of the 50-path list by decoys | The total is kept and said; over 50: confirmation |
| Invisible characters not escaped | `escaped()` covers Cc, Cf, Zl, Zp, Default_Ignorable_Code_Point |
| A looping or dangling symbolic ref as the only branch read as "no branches" | Reader checks the listed refs against the files on disk ("BROKEN OR CHANGING REFS", kind `refs`) |
| A branch missing from a read during commits/pack-refs/gc | `git bundle create` re-resolves names and skips moved ones: the reader now builds the bundle from one `for-each-ref` list and `pack-objects` on its ids (25/25 reads whole, 3 runs) |
| `a` packed beside loose `a/b`: `a` silently dropped | Same: both are listed, the server refuses the clash by name |
| One slow repository delays every other one's reads and sends | `GitKeeper.tick` runs each repository on its own; one run per repository at a time |
| A non-ASCII branch (`café`) failed every read, agent not told | Bytes above 0x7f pass the header check; that branch dropped and said |
| 1000 valid 150-character names over 128 KiB, agent not told | The limit stays; the agent is told (shorter names or fewer branches); same for a 4 KiB line |
| Shallow or grafted repository refused as "pack refused", agent not told | Reader refuses "SHALLOW REPOSITORY" (kind `shallow`), and a pack lacking objects is `incomplete`; both tell `git fetch --unshallow` |

Real sandbox after the change (this box, sudo, scratch under
`/tmp/claude-1000`): the 8 attack tests pass, and a probe read `café`
(dropped, said), 301 branches, `a` + `a/b` (refused `clash`), shallow
(`shallow`), no branches (`empty`) within `TasksMax=8`; no unit left.
Not changed: two repositories hanging at once still hold both host read
slots for up to 360 s.

## Review log (audit, 15-10)

| Finding | Verdict | Change |
|---|---|---|
| `views/`, `work/`, `work-disks/`, `removed/` still on the server-owned `$DATA`, unchecked by `held` (root escalation by a swapped path) | confirmed (high) | All five on `$MNT`; `kept` holds every one; `held` on each source and entry before `mount`, `bindfs`, `umount`, `mv`; server reads views and work folders from `$MNT`; `deploy/move-to-mnt.sh` moves them once (install); backup/restore; tests: `host-program`, `move-to-mnt`, `resources`. |
| Restoring an archive made before the change leaves the host refusing every verb (no `MNT`) | confirmed (medium) | `restore.sh` maps the old paths onto `$MNT` (tar `--transform`, link targets untouched) and adds `MNT=` to a restored `host.conf`; test. |
| A pack index-pack refuses partway stalls the read until the time limit; no waiver offered | confirmed (medium/high, two findings) | The indexer's end gives the verdict at once (`fail`), one classification for both ends (`packFailure`), bytes for an ended indexer dropped; test with 8 MiB after a bad-time-zone commit. |
| `git-read`: a junk `.git` makes git read the folder as a bare repository, past every check | confirmed (low) | `GIT_DIR=.git`, `safe.bareRepository=explicit`; test with a shallow bare clone at the top. |
| A refresh whose credential cannot be used throws: never recorded or alerted, Send errors | confirmed (low) | Caught in `#refreshLocked`, said like any failed refresh; test. |
| Automatic sending gives up on a commit for good after a passing failure | confirmed (medium) | Only final kinds end a commit; others tried again after `RETRY_MS`; a settled "not arrived" clears it; test. |
| Host and space failures alert at every read, twice the first time | confirmed (medium) | Same failure = same kind (and words, unless they carry a varying number); one alert while it lasts; test. |
| Lower findings | fixed | `git read` waits for the unit as a child (trap not held back; EXIT trap); `/resources:ro` in the sandbox; `held` refuses an access list; remote tips by exact ref; a merged-then-deleted remote branch not made again; a push failing with no porcelain line is an unknown outcome; last good R kept; stale reference locks removed at start; grave send failures alert once whatever the routine option; an agent line marked told only when heard; a first automatic sending leases the fresh remote tip. |
| Lower findings not changed | -- | Unlisted branches still logged once per commit (section 7 and 8 ask for it; `remoteLacks` is cached per tip and refresh). Merge commits in the "changed and changed back" guard: first-parent diffs would list everything a merge of the remote's branch brings in as changed back; left for a remerge-based check. |

