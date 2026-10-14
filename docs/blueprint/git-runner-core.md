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
   to GitLab; file on the landing fetch); `transfer.fsckObjects=true` where we receive.
4. `--end-of-options` before any value that comes from the agent (or owner).
5. Full refspecs only: `refs/heads/<x>:refs/heads/<y>` (or the fixed `*` forms
   below); a push source is a verified 40-hex id, its destination `refs/heads/<y>`.
6. Every ref name validated before use (`branchProblem`: the
   `check-ref-format` rules, allow-list `[A-Za-z0-9._/-]`, no leading `-`, no
   `..`); bytes checked before decoding, so non-UTF-8 is refused.
7. Output parsed with `-z` / `%x00` as bytes, and treated as data: messages,
   names and paths are shown escaped, never interpreted.
8. Credentials only through the environment (`http.extraHeader` via
   `GIT_CONFIG_COUNT`, today's `asEnv`; or `GIT_SSH_COMMAND` with a key file),
   never in argv, never in a file the agent can see.
9. Never read a configuration value from the agent's repository: remote,
   target, names come from the server's records.
10. Push only from the server's reference, never from the agent's folder.

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
to stdout; the server treats it as hostile, imports it into a fresh empty
repository, and lands its branches in the reference (`resources/<name>-origin`,
today's mirror) under `refs/agents/<name>/*`. Review and push read only the
reference. Kept: the shared folder, the mirror, `gitaccess.mjs`, `branchProblem`,
`allowed`, `quietMinutes`, `perHour`, the checks in the machine, the log.
Brought in from `git-runner.md` section 4: the root-owned **`$MNT`** chain
and **`held`** (section 2), and its host exit-code mapping.

**Deferred** (designed in `git-runner.md`): per-agent folders, fixed-size
disks, quotas; worktree `make`/`aside`; the upgrade guard and `git selftest`;
cgroup budgets on server git; keeping rewritten GitLab tips (core: an alert);
incremental bundles; per-object/inflated-size limits; owner-confirmed
non-fast-forward pushes; `fs.watch` (core: today's `lstat` marks); fsck
exceptions scoped to objects (`fsck.skipList`; core: whole id, allowlist only).

## 2. Host verbs

In `deploy/clavarium-host`, in its style (fixed argument count, `is_name`,
paths built from the name, argv and properties fixed). Never a server path.

**`$MNT` and `held`.** `resources/` moves from the server-owned `$DATA`
(server account, 0750) to `$MNT/resources` (`$MNT` = `/home/clavarium-mnt`,
in `host.conf`). `held <path>`: each component from `/` down to the entry's
parent is a real directory (not a link), root's, not group- or
world-writable; the entry is a real directory. The server then cannot swap
any component (rename or `RENAME_EXCHANGE` needs write on a parent), so the
path systemd or `mount` walks later is the one checked. `kept` and
`folder_of` call `held`; so do `git read` and every existing `vm mount
folder|view|work`. Never a `/proc/self/fd` staging path (`mount` walks the
path again: `git-runner.md` R1). `install.sh` creates `$MNT` and
`$MNT/resources` root:root 0755, moves `$DATA/resources` there once (server
stopped, mounts closed), writes `MNT` to `host.conf`; the server reads `MNT`
from there. `backup.sh`/`restore.sh` take `$MNT/resources`; `restore.sh`
makes `$MNT` and `$MNT/resources` root:root 0755.

| Verb | Checks, then action |
|---|---|
| `git read <name>` | `is_name`; refused if it ends in `-origin` (never the reference). Source `$MNT/resources/<name>` via `folder_of` (`held`). `exec 0</dev/null`; refused unless stdout **and** stderr are pipes (`LimitFSIZE=0` kills git writing to a regular file, trial). `flock -n /run/clavarium/read-<name>.lock`, else refused "busy". Unit `clvread-<name>_<16 hex from /dev/urandom>` (`_` never in a name). Runs section 3 as a child; a TERM/EXIT trap stops the unit, then `reset-failed`. Exits with a mapped code only. |
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
  -p "TemporaryFileSystem=/dev:ro /tmp:ro /var/tmp:ro" -p "BindPaths=/dev/null /dev/zero /dev/urandom" \
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
echoes them:

```
#!/usr/bin/sh
[ -d .git ] && [ ! -L .git ] && [ ! -e .git/commondir ] && [ ! -L .git/commondir ] \
  || { echo "NOT A PLAIN .git DIRECTORY" >&2; exit 66; }
for p in .git/refs .git/packed-refs; do
  [ -e "$p" ] || continue
  find -L "$p" >/dev/null 2>&1 && [ -z "$(find -L "$p" \( ! -readable -o -type d ! -executable \) -print -quit 2>/dev/null)" ] \
    || { echo "REFS UNREADABLE" >&2; exit 3; }
done
exec /usr/bin/git -c safe.directory=/resources/$1 -c core.hooksPath=/dev/null -c core.fsmonitor=false \
  -c core.pager=cat -c core.alternateRefsCommand= -c protocol.allow=never -c pack.threads=1 \
  -c pack.windowMemory=256m bundle create - --branches
```

Without it, a 000 `refs/heads/feat` gives exit 0 with `feat/*` silently
missing, and a 000 `refs/heads` gives 128 + 17 bytes, as an empty repository
(trial). git exiting 3 also maps to 67: only a wrong message, never content.
The first line refuses a gitfile, a `.git` link or `commondir` (any of them
could send git to refs elsewhere in the folder that the check never saw);
`find -L` checks a linked ref directory where git reads it. A folder changed
during the read gives at worst a bundle that fails sections 4-5, reported.
`systemd-run` passes no caller environment: only the `-E` list above.

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

## 4. Receive

1. **Limits**: 1 read per repository (server queue + flock), 2 on the host.
   Cap = min(8 GiB, max(512 MiB, 2 x R + 256 MiB)), R = `rev-list
   --disk-usage --objects --branches --glob=refs/agents/*` on the reference
   (reachable objects only: garbage never raises it; 0 when there is no
   reference yet, section 5 step 0); refused below 2 x cap
   + 5 GiB free. Fresh `$DATA/git-import/<random>` (0700, wiped at start),
   `git init --bare --object-format=sha1`.
2. `sudo -n clavarium-host git read <name>`, stdout/stderr pipes. **Every
   stdout byte counted**; past the cap: kill, `git stop`, clean up. Deadline
   360 s over steps 2-5. Stderr: last 4 KB, printable ASCII, labelled "text
   from the agent's repository".
3. **Header**, in Node, on Buffers, before any git: refused once a line passes
   4 KiB or the header 128 KiB, or on any byte outside printable ASCII. Exactly `# v2 git bundle`; no `-<sha>`
   prerequisite; lines `^[0-9a-f]{40} refs/heads/(.+)$`; exact duplicates
   dropped, one name with two shas refused; at most 1000; names failing
   `branchProblem` dropped and reported; an empty line, then `PACK`.
4. Pack bytes, still counted, into `git index-pack --stdin --strict[=<id>=<sev>,...]
   --threads=1 --max-input-size=<cap>`: in an empty repository it checks
   every object and link. **fsck exceptions** (owner option, `ignore`/`warn`)
   only for a fixed allowlist of legacy-history ids: `zeroPaddedFilemode`,
   `badFilemode`, `badTimezone`, `badDate`, `missingEmail`,
   `missingNameBeforeEmail`, `missingSpaceBeforeEmail`,
   `missingSpaceBeforeDate`. Any other id (`hasDot*`, `gitmodules*`,
   `symlink*`, `nulIn*`, `badTree`, `fullPathname`, `emptyName`,
   `largePathname`, `duplicateEntries`...) is rejected by the option
   validator and never offered. They go as `--strict=<id>=<sev>` (index-pack
   reads no fsck config, trial) and `-c fetch.fsck.<id>=<sev>` on the refresh
   and landing fetches; a refusal on an allowlisted id offers it to the owner.
5. `cat-file --batch-check` on the header shas: each a commit. One
   `update-ref --stdin` writes them as `refs/heads/<b>` in the fresh
   repository (one repository cannot hold `a` and `a/b`).
6. Land (section 5); remove the fresh directory in `finally`.

Every server-side git: one builder (today's `runGit`) applying the rules at
the top, plus `GIT_ATTR_SOURCE=<empty tree>`, `core.attributesFile=/dev/null`,
`gc.auto=0`, `http.followRedirects=false`, a deadline. It runs only in the
reference and the fresh repository, both the server's. Never `safe.directory`. On
the deadline it kills git's process group (`detached` spawn,
`process.kill(-pid)`) and waits for `close` before the mutex is released.

## 5. Landing, one ref at a time

Under the **reference mutex** (one per reference, in the server: refresh,
landing, review, push, maintenance; replaces `#locked` and `#mirrorQueue`),
waited at most 60 s, else "reference busy", retried quietly.

0. **Reference made if missing.** No `<reference>/HEAD`: `makeOrigin`, `init
   --bare` (the builder), `shareOrigin`, with or without a remote. Landing
   never waits for a refresh.
1. **Stale locks.** The server is the only writer and holds the mutex, so any
   `*.lock` under `refs/`, `packed-refs.lock`, `HEAD.lock`, `config.lock`,
   `objects/pack/tmp_*` is stale: removed, logged (also after a git on the
   reference is killed by its deadline).
2. Empty `refs/clavarium/incoming/`; `git fetch --no-tags --no-write-fetch-head
   --end-of-options <fresh> '+refs/heads/*:refs/clavarium/incoming/*'` (objects only).
3. **One `update-ref` per ref**: first `-d refs/agents/<name>/<b> <old>` for
   each name gone from the bundle **and from the previous good read too**
   (two reads in a row agree; "no branches" likewise), then
   `refs/agents/<name>/<b> <new> <old or zero>` for each new or moved one.
   Empty `incoming/` again.
4. **Maintenance**, when `count-objects -v` shows over 1000 loose objects or
   20 packs, and at least daily: `repack -a -d --threads=1`, then `prune
   --expire=1.day.ago`, under the deadline. Release.

So `a` -> `a/b` deletes `a`, then creates `a/b`; a ref that fails (clash,
lock) fails alone, is named in the report and retried at the next read. One
function writes all refs and refuses anything outside `refs/agents/<name>/`
and `refs/clavarium/incoming/`: **a landing never writes `refs/heads/*`**. A
non-ancestor new tip is logged "the agent rewrote <b>".

## 6. Review, refresh, push

**Review.** Read and land first (failure: shown, no review), refresh, then in
the reference under the mutex (10 s, else "busy"): base `refs/heads/<target>`,
head `refs/agents/<name>/<b>` (owner's pick; default the last moved). Today's
`#outgoing` fields, the true `rev-list --count`, and `git diff --text
--no-ext-diff --no-textconv --no-color` with `GIT_ATTR_SOURCE` = empty tree:
no `.gitattributes` can hide or rewrite a file. Streamed, killed at
`DIFF_MAX`, "cut" shown. Against hidden history: new-object size
(`rev-list --objects --disk-usage base..head`), the 10 largest new blobs
(`cat-file --batch-check`), paths changed with no net change (`log
--name-only` minus `diff --name-only`), full messages and authors; control
characters shown escaped; an extra confirmation above 100 commits or when
the diff is cut. Keeps `head`, `remoteTip`, "branches as of <time>". **No
remote**: no refresh; state `no-remote`, commits against the empty tree;
Send refused "no address".

**Refresh** (today's `#refresh`, under the mutex): `fetch --prune --no-tags
--end-of-options <remote> '+refs/heads/*:refs/heads/*'`, never `--atomic`, never a wider
refspec (pruning stays in `refs/heads/`). A tip before that is not an
ancestor of its successor, or is gone, alerts the owner. Nothing more.

**Send** (page or automatic): (1) read and land, else refused "could not
confirm the agent's branch"; (2) under the mutex, refresh from GitLab, else
"GitLab unreachable"; (3) `refs/agents/<name>/<b>` must equal the reviewed
`head` (else 409 "the agent changed this branch"), `refs/heads/<target>` the
reviewed `remoteTip` or be absent if it was (else 409 "GitLab moved"), and
`merge-base --is-ancestor <remoteTip> <head>` hold (else "diverged"); (4):

```
git push --porcelain --no-verify --force-with-lease=refs/heads/<target>:<remoteTip, or empty> \
  --end-of-options <remote> <head>:refs/heads/<target>
```

No `+`, no `--force`: (3) makes it a fast-forward; the lease makes GitLab
refuse if it moved since. (5) `update-ref refs/heads/<target> <head>
<remoteTip>`, so our own push is never seen as a GitLab rewrite. A push
ended by deadline or signal (not a porcelain refusal) has an unknown
outcome: refresh under the mutex; `refs/heads/<target>` = `head` -> sent,
(5), counted in `perHour`; else "outcome unknown, refreshed: not on GitLab".

## 7. Automatic sending, on the new reading

Today's rules and options: off until the owner names branches (`allowed`),
`quietMinutes`, `perHour` (default 4), checks required, log, alert.

- **Trigger**: today's 30 s tick on the `lstat` marks; a change schedules a
  read 5 s after the last one; a change during a read sets a dirty flag (one
  more read). A safety read every 10 minutes while in use; one at start.
- **Real debounce**: per landed branch, `movedAt` = the last landing that
  changed its tip; each new tip restarts the clock. Candidate: name allowed,
  tip not on GitLab's same-name branch, now - `movedAt` >= `quietMinutes`, no
  read queued, running or dirty. `perHour` cap with alert; checks in the
  machine against `refs/heads/<b>` = `head`; Send as above, never forced;
  diverged, refused, checks failed logged once per commit.

## 8. Every failure is a failure

Owner: every row (log; phone after 2 in a row). AI: one wake-up line, where it can act.

| Failure | Owner sees | AI told |
|---|---|---|
| Host refused (78): busy, not a folder, a link, chain not root's | "could not read: <reason>" | no |
| Unit did not start (79), sudo, other host code | "host program failed (<code>)" + alert to owner and operator | no |
| Time limit (80) | "reading stopped: time limit" | "your repository could not be read in 300 s; pack it (git gc)" |
| Memory limit (81) | "reading stopped: memory limit (1 GB)" | "your repository needs too much memory to read; pack it (git gc)" |
| Other kill (82) | "reading stopped: killed (<signal>)" + alert after 2 | no |
| Unreadable refs (67) | "some branches are not readable" | "check permissions (chmod -R o+rX .git)" |
| Git failed (65 not empty, 66) | code + text from the agent's repository | after 2 in a row: "could not read your repository: a plain .git directory, check permissions (chmod -R o+rX .git), not shallow, SHA-1" |
| Over the byte cap | "N MB, over the cap" | "your branches add up to more than N MB" |
| Not enough free space | "not read: N MB free" + alert | no |
| Bad header (v3, prerequisite, two shas, over 1000, too long, no `PACK`) | "could not be read safely: <reason>" | v3: "use SHA-1"; prerequisite: "git fetch --unshallow"; over 1000: "delete branches" |
| Invalid branch name | listed, not landed | "branch <b> was not taken: <rule>" |
| index-pack refused (fsck), tip not a commit | id, object, path; exception offered only for an allowlisted id, else "refused" | "fsck refused your commits: <id>" |
| No branches (two reads in a row) | "no branches"; `refs/agents/<name>/` emptied | "nothing committed on a branch (git switch -c <name>)" |
| One ref failed to land | the ref and git's line | after 2 in a row on a clash: "branch <b> clashes with <b2>; rename one" |
| Stale lock removed / reference busy | logged; review: "busy, try again" | no |
| Refresh failed, GitLab unreachable | `explain()` text; alert after 3 | no |
| GitLab rewrite or delete | "<b> was rewritten on GitLab" + alert | "origin/<b> was rewritten; fetch again" |
| Read before Send failed / agent moved / GitLab moved / lease refused / no address | the reason (409) | automatic, GitLab moved: "pull origin/<b> first" |
| Push outcome unknown | "outcome unknown, refreshed: <sent / not on GitLab>" | no |
| Not in list / diverged / cap / checks failed | as today, once per commit | diverged: "pull origin/<b> first"; checks: their output |

## 9. Attacks stopped; what is not protected

| Attack | Stopped by |
|---|---|
| `.git` gitfile, symlink, `commondir`, `alternates`, `../` | Only the folder exists in the sandbox (trial: "not a git repository"); `GIT_CEILING_DIRECTORIES`; `git-read` refuses all but a plain `.git` directory. |
| Hooks, fsmonitor, pager, filters, aliases, `sshCommand`, credential helpers, `insteadOf`, `include.path` in `.git/config` | Overridden on the command line; `bundle create` runs none, `protocol.allow=never`; the server never reads that config. |
| A config command the overrides miss; FIFO, endless or huge files | Dynamic uid, no capability, no network, nothing writable, no `/proc`, 3 devices, seccomp (`@system-service` minus io_uring, userfaultfd, keyring, setuid, `kcmp`, `process_vm_*`, host SysV/POSIX IPC); `RuntimeMaxSec`, `MemoryMax`, `TasksMax`, byte cap; host-fixed exit codes. |
| Endless header, forged bundle, prerequisites | Bounded Node parse; empty fresh repository; `index-pack --strict`; commit check. |
| Hostile `.gitmodules`, `.git` path, symlink tree; agent asking for the waiver | fsck; exceptions only for the legacy-history allowlist, never offered for these. |
| Unreadable ref directory read as "deleted" | `git-read` refuses (67); deletes only when two reads agree. |
| Ref names with `..`, a leading `-`, control or non-ASCII bytes | Header bytes checked, `branchProblem`; `--end-of-options`, full refspecs; only `refs/heads/` read, only `refs/agents/<name>/` written. |
| Credentials or a remote taken from the agent | Credentials only in the server's environment; remote and target from the server's records; push only from the reference. |
| `a` -> `a/b` wedge; killed git leaving locks; GitLab refs overwritten | One ref per command, deletes first; stale locks removed under the mutex; group kill; one function writes only the agent prefixes. |
| `.gitattributes` hiding a change | `--text`, no textconv, attributes from the empty tree. |
| History hidden from the review (add then delete, huge blobs, past 100 commits) | New-object size, largest blobs, no-net-change paths, full messages, escaped control characters, extra confirmation. |
| Branch changed between review and Send | Read before Send, 409 on `head`; lease on the shown `remoteTip`. |
| Commit loop | Debounce, read pacing, `perHour`, alert, reachable-only cap, maintenance. |
| A bent path (compromised server): name, or `resources/` swapped for a link (`RENAME_EXCHANGE`) | The host takes a name only; the source sits on the root-owned `$MNT` chain checked by `held`, so the server cannot change any component; the sandbox uid reads only world-readable bits. |

**Out of scope** (threat model): unknown bugs in git, the kernel, systemd,
including in the server-side parsers (index-pack, fetch, diff, merge-base on
agent objects). **Not protected**: server memory against a pack under the
cap that inflates hugely (deadlines only, until cgroup budgets); the multipass mount's links and special
files; a read-only `/sys` in the sandbox; the shared folder (no attribution,
unbounded, as today); what is reviewed carelessly or auto-sent (merge
parents beyond the first shown only as a count); agents seeing each other's
branches; the agent's network; GitLab rewrites beyond the alert; an
allowlisted fsck waiver covering the whole reference.

## 10. Test plan

**Unit** (`--say-only`; a stand-in runner): verb checks (bad names, `..`,
`-`, `_`, `-origin`, a link, `resources/` or a parent not root's or
group-writable, non-pipe output, busy); `held` on `vm mount folder`; the
exact vector including the second filter line, no "must not" setting;
mapping 0, 65 + 17 bytes, 65, 66, 67, 79, 80, 81, 82, 78, and git exiting 78
or 200 mapping to 66; each header refusal at and one byte over its limit,
1000/1001 names; cap-1/cap/cap+1, a rewrite loop not raising the cap;
deadline cleanup, group kill; landing `a` <-> `a/b` (loose, packed), one ref
failing alone, the prefix guard, no branches deleting only on the second
read; reference made on the first Review with `refreshMinutes=0` and on an
auto-send read before any reference; no-remote repository shows its commits,
Send "no address"; many small landings then maintenance bound loose objects
and packs; stale locks; refresh never touches `refs/agents/*`; lease present
and absent; both 409s; diverged never pushed; own push not a rewrite; push
timing out after the remote accepted it reports sent; fsck option rejects
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
link or `commondir` pointing inside the folder -> 66; a server killed mid-read reads again after restart; worktrees and many
branches land, GitLab refs unchanged; `zeroPaddedFilemode` history imports
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
`textconv` attributes; SIGKILL in `update-ref`; amend or GitLab move between
review and Send; 1000 commits a minute; `/proc/1/environ` and the vault path;
a loop of `RENAME_EXCHANGE` of `resources/` (or a parent) with a link to
`/root` during `git read` (refused, or the real folder bound; the server
account cannot do it at all on `$MNT`); a tree tripping `gitmodulesUrl` or
`hasDotgit` refused with no exception offered; an add-then-delete commit
shown in the review; a 0700 ref directory never deletes landed refs.

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
