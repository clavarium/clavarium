/* THE GIT RUNNER: every git command this server runs, and the one way an
 * agent's commits reach it. Design: docs/blueprint/git-runner-core.md.
 *
 * THE RULE: THE SERVER NEVER RUNS GIT ON A PATH THE AGENT CAN WRITE. A
 * repository the agent writes holds a config (hooks, fsmonitor, sshCommand,
 * filters, include.path...), maybe a gitfile, a `.git` link, `commondir` or
 * `alternates` pointing anywhere this account can read. Git run there by this
 * server would obey all of it. So:
 *
 *   1. the host program reads the folder in a throw-away sandbox (`git read`,
 *      see deploy/clavarium-host and deploy/git-read) and writes ONE FULL
 *      BUNDLE of its branches to stdout;
 *   2. this file treats those bytes as hostile: every byte counted against a
 *      cap, the header parsed here on Buffers before any git sees it, the
 *      pack checked object by object (`index-pack --strict`) into an EMPTY,
 *      FRESH WORKSPACE that only this server can reach, each tip a commit;
 *   3. the workspace is used for one review, one send or one check read, and
 *      then deleted. Nothing the agent made is ever written into the
 *      reference (the remote's history, `resources/<name>-origin`): only the
 *      refresh from the remote writes there.
 *
 * EVERY GIT COMMAND goes through `git()` below: an argument array (never a
 * shell), an environment built from nothing, settings that turn off whatever
 * could run a program, the protocols a command needs and no other, a
 * deadline that kills git's whole process group. Values that come from the
 * agent (or the owner) go after `--end-of-options`, or on stdin.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statfsSync, writeFileSync, existsSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Refusal } from './conversations.mjs';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
export const CAP_MIN = 512 * MiB;
export const CAP_MAX = 8 * GiB;
export const CAP_EXTRA = 256 * MiB;
/* Free room kept on the disk of the workspaces, beyond twice the cap. */
export const RESERVE = 5 * GiB;
export const LINE_MAX = 4096;
export const HEADER_MAX = 128 * 1024;
export const READ_BRANCHES_MAX = 1000;
export const READ_DEADLINE_MS = 360_000;
export const HOST_READS = 2;
export const BRANCH_MAX = 200;
/* What `git bundle create` writes for a repository with no branch. */
export const EMPTY_BUNDLE = '# v2 git bundle\n\n';
/* The fsck messages an owner may waive, for old histories made by old
   tools. Nothing that guards a checkout (.git paths, .gitmodules, symlinks,
   odd tree entries) is ever on this list, nor offered. */
export const FSCK_WAIVABLE = Object.freeze(['zeroPaddedFilemode', 'badFilemode', 'badTimezone', 'badDate', 'missingEmail',
    'missingNameBeforeEmail', 'missingSpaceBeforeEmail', 'missingSpaceBeforeDate']);
export const FSCK_LEVELS = Object.freeze(['ignore', 'warn']);

/* A failure the owner is shown as it is, and maybe the agent too.
   `kind` names the row of the blueprint's failure table; `ai` is the one
   line the agent may be told (or null); `alert` asks for the owner's phone
   at once; `offer` an fsck id the owner may waive. */
export class GitFailure extends Refusal {
    constructor(status, kind, message, { ai = null, alert = false, offer = null, detail = '' } = {}) {
        super(status, message); this.kind = kind; this.ai = ai; this.alert = alert; this.offer = offer; this.detail = detail;
    }
}

/* Why a name cannot be a branch here, or '' when it can. The rules of `git
   check-ref-format` for refs/heads/<name>, written out so that no git has to
   run to know it, plus ours: a plain set of characters (it goes on command
   lines and into a page), no leading "-" (an option), a bounded length, not
   "HEAD", and NO PART THAT LOOKS LIKE AN OBJECT ID (40 or 64 hex): git tries
   a ref of that name before the object, so such a branch could stand in for
   the commit that was reviewed. */
export function branchProblem(name) {
    const text = String(name ?? '');
    if (text === '') return 'A branch has a name.';
    if (text.length > BRANCH_MAX) return `A branch name is at most ${BRANCH_MAX} characters.`;
    if (!/^[A-Za-z0-9._/-]+$/.test(text)) return 'A branch name is made of letters, digits, ".", "_", "-" and "/".';
    if (text.startsWith('-')) return 'A branch name does not start with "-".';
    if (text === 'HEAD' || text === '@') return 'This name is not a branch.';
    if (text.includes('..') || text.includes('//') || text.startsWith('/') || text.endsWith('/') || text.endsWith('.')) return 'A branch name has no "..", no "//", and does not start or end with "/" or end with ".".';
    if (text.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'No part of a branch name starts with "." or ends with ".lock".';
    if (text.split('/').some((part) => /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(part))) return 'No part of a branch name looks like a commit id (40 or 64 hexadecimal characters).';
    return '';
}

const isId = (text) => /^[0-9a-f]{40}$/.test(String(text ?? ''));
export { isId };

/* ---------- the builder ---------- */

/* The settings every server-side git gets, before its own arguments. */
export function gitArgs(argv, { allow = [], receive = false, extra = [] } = {}) {
    return [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
        '-c', 'core.attributesFile=/dev/null', '-c', 'gc.auto=0', '-c', 'http.followRedirects=false',
        '-c', 'credential.helper=', '-c', 'protocol.allow=never',
        ...allow.flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
        ...(receive ? ['-c', 'transfer.fsckObjects=true'] : []),
        ...extra.flatMap((c) => ['-c', c]),
        ...argv,
    ];
}
/* An environment built from nothing: no GIT_* of this process leaks in. */
export function gitEnv(home, extra = {}) {
    return {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', GIT_ATTR_SOURCE: EMPTY_TREE,
        ...extra,
    };
}
/* The protocol a remote address needs, and nothing more. */
export const protocolOf = (address) => (address?.transport === 'https' ? ['https'] : address?.transport === 'ssh' ? ['ssh'] : address?.transport === 'local' ? ['file'] : []);

/* Kills a process group, quietly: it may be gone already. */
const killGroup = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };

/* Runs git: resolves { code, signal, stdout (Buffer), stderr, killed }.
   `killed`: 'deadline' or 'size' when this server stopped it. Never throws. */
export function runGit(argv, { cwd, env = {}, home = '/nonexistent', allow = [], receive = false, extra = [], input, deadlineMs = 300_000, maxBytes = 64 * MiB, onSpawn } = {}) {
    return new Promise((resolve) => {
        const child = spawn('git', gitArgs(argv, { allow, receive, extra }), { cwd, env: gitEnv(home, env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const out = []; let size = 0; let err = ''; let killed = null;
        const timer = setTimeout(() => { killed = 'deadline'; killGroup(child); }, deadlineMs);
        child.stdout.on('data', (d) => {
            if (killed) return;
            size += d.length;
            if (size > maxBytes) { out.push(d.subarray(0, d.length - (size - maxBytes))); killed = 'size'; killGroup(child); return; }
            out.push(d);
        });
        child.stderr.on('data', (d) => { err = (err + d.toString('latin1')).slice(-65536); });
        child.on('error', () => { clearTimeout(timer); resolve({ code: 127, signal: null, stdout: Buffer.alloc(0), stderr: 'git could not be started', killed }); });
        child.stdin.on('error', () => {});
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 128, signal, stdout: Buffer.concat(out), stderr: err, killed }); });
        onSpawn?.(child);
        child.stdin.end(input ?? '');
    });
}

/* ---------- waiting in line ---------- */

/* One holder at a time, waited for at most `waitMs`; the reference's lock. */
export class Mutex {
    #held = false; #waiters = [];
    acquire(waitMs, why = 'The reference of this repository is busy: try again in a moment.') {
        if (!this.#held) { this.#held = true; return Promise.resolve(this.#releaser()); }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, timer: setTimeout(() => { this.#waiters = this.#waiters.filter((w) => w !== waiter); reject(new GitFailure(503, 'busy', why)); }, waitMs) };
            this.#waiters.push(waiter);
        });
    }
    #releaser() {
        let done = false;
        return () => {
            if (done) return; done = true;
            const next = this.#waiters.shift();
            if (next) { clearTimeout(next.timer); next.resolve(this.#releaser()); } else this.#held = false;
        };
    }
    get held() { return this.#held; }
}
/* `n` holders at a time, the others wait their turn. */
export class Slots {
    #free; #waiters = [];
    constructor(n) { this.#free = n; }
    async take() {
        if (this.#free > 0) { this.#free -= 1; } else await new Promise((resolve) => this.#waiters.push(resolve));
        let done = false;
        return () => { if (done) return; done = true; const next = this.#waiters.shift(); if (next) next(); else this.#free += 1; };
    }
}

/* ---------- the bundle header, read here ---------- */

/* Reads the header of a v2 bundle as it arrives, on Buffers, before any git
   sees it. `push(chunk)` returns undefined while more is needed, or
   { refs: [{name, id}], dropped: [{name, why}], rest } once the empty line is
   reached; it throws a GitFailure on anything else. `rest` is what followed
   the header in that chunk (the start of the pack). */
export class HeaderReader {
    #buf = Buffer.alloc(0); #lineStart = 0;
    push(chunk) {
        const from = this.#buf.length;
        this.#buf = Buffer.concat([this.#buf, chunk]);
        for (let i = from; i < this.#buf.length; i++) {
            const byte = this.#buf[i];
            if (byte === 0x0a) {
                if (i === this.#lineStart && i > 0) return this.#done(i);
                this.#lineStart = i + 1;
                continue;
            }
            if (i - this.#lineStart >= LINE_MAX) throw refused('a header line is longer than 4 KiB', { ai: LINE_AI });
            if (i >= HEADER_MAX) throw refused('the header is larger than 128 KiB', { ai: HEADER_AI });
            /* Bytes above ASCII are let through: git allows such branch
               names ("café"), and the name is then dropped by branchProblem
               and said, alone, instead of failing every read of the
               repository. Control bytes never pass. */
            if (byte < 0x20 || byte === 0x7f) throw refused('the header holds a control byte');
        }
        if (this.#buf.length > HEADER_MAX) throw refused('the header is larger than 128 KiB', { ai: HEADER_AI });
        return undefined;
    }
    #done(end) {
        const lines = this.#buf.subarray(0, end - 1).toString('latin1').split('\n');
        const rest = this.#buf.subarray(end + 1);
        if (lines[0] === '# v3 git bundle') throw refused('it is a version 3 bundle (SHA-256 or capabilities)', { kind: 'v3', ai: 'your repository could not be read: use SHA-1 (sha256 repositories are not supported)' });
        if (lines[0] !== '# v2 git bundle') throw refused('it does not start as a version 2 bundle');
        const byName = new Map(); const dropped = []; let lineCount = 0;
        for (const line of lines.slice(1)) {
            if (line.startsWith('-')) throw refused('it needs commits it does not carry (a shallow repository)', { kind: 'prerequisite', ai: 'your repository is shallow and could not be read: run git fetch --unshallow' });
            const m = /^([0-9a-f]{40}) refs\/heads\/(.+)$/.exec(line);
            if (!m) throw refused('a line of it is not a branch');
            /* Every line counts, a name dropped below too: the reader lists at
               most this many, so more can only mean branches left out. */
            if (++lineCount > READ_BRANCHES_MAX) throw refused(`it has more than ${READ_BRANCHES_MAX} branches`, { kind: 'many', ai: MANY_AI });
            const [, id, name] = m;
            const why = branchProblem(name);
            /* Shown as the agent typed it (UTF-8), escaped where it is shown. */
            const shown = Buffer.from(name, 'latin1').toString('utf8');
            if (why) { if (!dropped.some((d) => d.name === shown)) dropped.push({ name: shown, why }); continue; }
            if (byName.has(name)) {
                if (byName.get(name) !== id) throw refused(`the branch ${name} is given two commits`);
                continue;
            }
            byName.set(name, id);
        }
        return { refs: [...byName].map(([name, id]) => ({ name, id })), dropped, rest };
    }
}
const MANY_AI = `your repository has more than ${READ_BRANCHES_MAX} branches and could not be read: delete branches`;
const HEADER_AI = `the names of your branches add up to more than ${HEADER_MAX / 1024} KiB and could not be read: delete branches or use shorter names`;
const LINE_AI = 'a branch name of your repository is longer than 4 KiB and it could not be read: rename that branch';
const SHALLOW_AI = 'your repository is shallow or has grafts and could not be read: run git fetch --unshallow (and remove .git/info/grafts)';
const refused = (why, { kind = 'header', ai = null } = {}) => new GitFailure(422, kind, `The repository could not be read safely: ${why}.`, { ai });

/* min(8 GiB, max(512 MiB, 2 x R + 256 MiB)): R is the size of the
   remote's history (the reference), so nothing the agent commits raises it. */
export const capFor = (r) => Math.min(CAP_MAX, Math.max(CAP_MIN, 2 * r + CAP_EXTRA));

/* What the stderr of a read may be shown as: its end, printable ASCII,
   labelled -- it is text from the agent's repository, not ours. */
export const agentText = (text) => {
    const plain = String(text ?? '').slice(-4096).replace(/[^\x20-\x7e\n]/g, '?').trim();
    return plain ? ` (text from the agent's repository: ${plain.split('\n').slice(-3).join(' / ')})` : '';
};

/* What each fixed exit code of `git read` means for the owner and the agent. */
export function hostFailure(code, stderr, bytes) {
    const text = agentText(stderr);
    if (code === 65 && bytes === EMPTY_BUNDLE.length) return new GitFailure(409, 'empty', 'No branches: nothing has been committed on a branch.', { ai: 'nothing is committed on a branch in your repository (git switch -c <name>, then commit)' });
    if (code === 78) return new GitFailure(409, 'refused', `Could not read: ${(/REFUSED: (.*)/.exec(String(stderr)) ?? [])[1]?.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) ?? 'refused by the host'}.`);
    if (code === 80) return new GitFailure(504, 'timeout', 'Reading stopped: time limit.', { ai: 'your repository could not be read in 300 s; pack it (git gc)' });
    if (code === 81) return new GitFailure(507, 'memory', 'Reading stopped: memory limit (1 GB).', { ai: 'your repository needs too much memory to read; pack it (git gc)' });
    if (code === 82) return new GitFailure(502, 'killed', 'Reading stopped: killed (a signal).');
    if (code === 67) return new GitFailure(409, 'unreadable', 'Some branches are not readable.', { ai: 'some branches of your repository cannot be read: check permissions (chmod -R o+rX .git)' });
    if (code === 66) {
        /* The reader's own last line says why. The agent can write such a
           line too (git's messages carry its names); then it only changes
           which failure its own read is said to be, never a failure into
           a read. */
        const said = String(stderr ?? '').trim().split('\n').pop();
        if (said === 'SHALLOW REPOSITORY') return new GitFailure(422, 'shallow', 'Not read: the repository is shallow or has grafts, so its commits lack their parents.', { ai: SHALLOW_AI });
        if (said === 'NOT SHA-1') return new GitFailure(422, 'v3', 'Not read: the repository does not use SHA-1.', { ai: 'your repository could not be read: use SHA-1 (sha256 repositories are not supported)' });
        if (said === 'MORE THAN 1000 BRANCHES') return new GitFailure(422, 'many', `Not read: the repository has more than ${READ_BRANCHES_MAX} branches.`, { ai: MANY_AI });
        if (said === 'BROKEN OR CHANGING REFS') return new GitFailure(409, 'refs', `Not read: a ref under refs/heads is one git skips (a symbolic ref pointing nowhere or in a loop, a broken file, an invalid name), or branches were made or deleted during the read${text}.`, { ai: 'a ref under .git/refs/heads or in .git/packed-refs is not a branch git can read (a symbolic ref pointing nowhere, a broken file, an invalid name): fix or delete it (compare ls -R .git/refs/heads with git branch)' });
    }
    if (code === 65 || code === 66) return new GitFailure(502, 'git', `Git failed to read the repository (${code})${text}.`, { ai: 'could not read your repository: it needs a plain .git directory, readable (chmod -R o+rX .git), not shallow, SHA-1' });
    return new GitFailure(502, 'host', `The host program failed (${code}).`, { alert: true });
}

/* An fsck refusal said for the owner: the id, and an offer only when the id is waivable. */
function fsckFailure(stderr) {
    const text = String(stderr ?? '');
    const m = /(?:error|warning): object ([0-9a-f]{40}): ([A-Za-z]+): ([^\n]*)/.exec(text);
    const id = m?.[2] ?? null;
    const offer = id && FSCK_WAIVABLE.includes(id) ? id : null;
    const said = m ? `${id} in object ${m[1]}: ${m[3].replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}` : (text.trim().split('\n').pop() ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
    return new GitFailure(422, 'fsck', `The commits were refused by the object check (fsck): ${said}.${offer ? ' This check may be waived for this repository, for old histories.' : ''}`, { offer, ai: `fsck refused your commits: ${id ?? 'invalid objects'}` });
}

/* What index-pack's refusal of a pack means: one verdict, whether it comes
   when the reader is done or while the reader is still writing. */
function packFailure(ix) {
    if (/did not receive expected object/.test(ix.err)) return refused('its pack lacks objects its commits need', { kind: 'incomplete', ai: SHALLOW_AI });
    if (/fsck|object [0-9a-f]{40}: [A-Za-z]+:/.test(ix.err)) return fsckFailure(ix.err);
    return refused(`its pack was refused: ${(ix.err.trim().split('\n').pop() ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}`);
}

/* fsck waivers as index-pack takes them: "id=level,...", only allowed ones. */
export function strictOption(waivers = {}) {
    const parts = Object.entries(waivers ?? {}).filter(([id, level]) => FSCK_WAIVABLE.includes(id) && FSCK_LEVELS.includes(level)).map(([id, level]) => `${id}=${level}`);
    return parts.length ? `--strict=${parts.join(',')}` : '--strict';
}
/* An owner's waivers, checked: { id: 'ignore' | 'warn' }. */
export function waiversProblem(waivers) {
    if (waivers === null || typeof waivers !== 'object' || Array.isArray(waivers)) return 'Waivers are a list of fsck ids with "ignore" or "warn".';
    for (const [id, level] of Object.entries(waivers)) {
        if (!FSCK_WAIVABLE.includes(id)) return `"${String(id).slice(0, 40)}" cannot be waived: only checks about old dates, modes and author lines can.`;
        if (!FSCK_LEVELS.includes(level)) return 'A waiver is "ignore" or "warn".';
    }
    return '';
}

export class GitRunner {
    #dataDir; #host; #reserve; #deadline; #spawnRead; #git; #cap; #mutexes = new Map(); #queues = new Map(); #slots = new Slots(HOST_READS); #sizes = new Map();

    /* `host`: how the host program is reached, as an argument vector.
       `spawnRead(name)`: a stand-in for `host git read <name>`, for tests.
       `reserveBytes`: free room kept beyond twice the cap.
       `git(argv, options)`: a stand-in for the builder's git, and `cap` a
       fixed byte cap, for tests. */
    constructor({ dataDir, host = [], reserveBytes = RESERVE, readDeadlineMs = READ_DEADLINE_MS, spawnRead, git = runGit, cap } = {}) {
        this.#dataDir = dataDir; this.#host = host; this.#reserve = reserveBytes; this.#deadline = readDeadlineMs; this.#git = git; this.#cap = cap;
        this.#spawnRead = spawnRead ?? ((name) => spawn(this.#host[0], [...this.#host.slice(1), 'git', 'read', name], { stdio: ['ignore', 'pipe', 'pipe'] }));
        /* What is left from before is nobody's now: a workspace outlives its
           use only if this server stopped in the middle of one. The copies an
           earlier version kept (git-review/) go too. */
        rmSync(this.workRoot, { recursive: true, force: true });
        rmSync(`${dataDir}/git-review`, { recursive: true, force: true });
        mkdirSync(this.workRoot, { recursive: true, mode: 0o700 });
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
    }

    get workRoot() { return `${this.#dataDir}/git-work`; }
    /* An empty place for HOME: git and ssh find nothing there. */
    get home() { return `${this.#dataDir}/git-home`; }

    /* The builder: every git of this server. */
    git(argv, options = {}) { return this.#git(argv, { home: this.home, ...options }); }
    /* In one repository of ours (the reference or a workspace), by GIT_DIR: no discovery. */
    in(dir, argv, options = {}) { return this.git(argv, { ...options, env: { ...(options.env ?? {}), GIT_DIR: dir } }); }

    /* The lock of a reference: refresh, review, send and upkeep take it. */
    lock(reference, waitMs) {
        if (!this.#mutexes.has(reference)) this.#mutexes.set(reference, new Mutex());
        return this.#mutexes.get(reference).acquire(waitMs);
    }

    /* A fresh, empty workspace: { path, remove() }. Made for one use. */
    async workspace() {
        const path = join(this.workRoot, randomBytes(12).toString('hex'));
        mkdirSync(path, { mode: 0o700 });
        const made = await this.git(['init', '--quiet', '--bare', '--object-format=sha1', path]);
        if (made.code !== 0) { rmSync(path, { recursive: true, force: true }); throw new GitFailure(500, 'workspace', 'A workspace could not be made.'); }
        return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
    }

    /* Lends the reference's objects to a workspace, read-only: one line in
       its alternates, written only after the receive checks. */
    borrow(workspace, reference) {
        if (!existsSync(join(reference, 'objects'))) return;
        writeFileSync(join(workspace, 'objects', 'info', 'alternates'), `${join(reference, 'objects')}\n`);
    }

    /* R: the size of what the reference holds (0 with no reference). Measured
       without the reference's lock (a read must not wait for a send that
       waits for a read): a measure that fails while a refresh rewrites the
       reference gives the last good one, never 0 for a reference that exists. */
    async sizeOf(reference) {
        if (!reference || !existsSync(join(reference, 'objects'))) return 0;
        const r = await this.in(reference, ['rev-list', '--disk-usage', '--objects', '--branches'], { deadlineMs: 120_000 });
        const text = r.stdout.toString('latin1').trim();
        const n = Number(text);
        if (r.code === 0 && text !== '' && Number.isFinite(n)) { this.#sizes.set(reference, n); return n; }
        return this.#sizes.get(reference) ?? 0;
    }
    freeBytes() { try { const s = statfsSync(this.workRoot); return s.bavail * s.bsize; } catch { return 0; } }

    /* Stops every read of a repository on the host (a read given up on). */
    stopReads(name) {
        if (this.#host.length === 0) return Promise.resolve();
        return new Promise((resolve) => {
            const child = spawn(this.#host[0], [...this.#host.slice(1), 'git', 'stop', name], { stdio: 'ignore' });
            child.on('error', () => resolve()); child.on('close', () => resolve());
        });
    }

    /* Removes the lock files a killed git left in a reference. Under its lock. */
    staleLocks(reference) {
        const removed = [];
        const walk = (dir, depth) => {
            let names; try { names = readdirSync(dir); } catch { return; }
            for (const n of names) {
                const p = join(dir, n);
                let s; try { s = lstatSync(p); } catch { continue; }
                if (s.isDirectory() && depth < 12 && n !== 'objects') walk(p, depth + 1);
                else if (s.isFile() && n.endsWith('.lock')) { try { unlinkSync(p); removed.push(p.slice(reference.length + 1)); } catch { /* gone */ } }
            }
        };
        walk(reference, 0);
        return removed;
    }

    /* ONE READ of a repository into a fresh workspace: see the top of this
       file. Resolves { path, branches: [{name, id}], dropped, remove() };
       rejects with a GitFailure (the workspace is then already gone).
       `reference`: the remote's history, for the cap only (never borrowed
       here). `waivers`: the owner's fsck waivers. One read per repository
       at a time, two on the host. */
    read(name, { reference, waivers } = {}) {
        const before = this.#queues.get(name) ?? Promise.resolve();
        const run = before.then(() => this.#read(name, reference, waivers), () => this.#read(name, reference, waivers));
        const tail = run.catch(() => {});
        this.#queues.set(name, tail);
        void tail.then(() => { if (this.#queues.get(name) === tail) this.#queues.delete(name); });
        return run;
    }

    async #read(name, reference, waivers) {
        const release = await this.#slots.take();
        let ws;
        try {
            const cap = this.#cap ?? capFor(await this.sizeOf(reference));
            const free = this.freeBytes();
            if (free < 2 * cap + this.#reserve) throw new GitFailure(507, 'space', `Not read: ${Math.floor(free / MiB)} MB free on the server, ${Math.ceil((2 * cap + this.#reserve) / MiB)} MB needed.`, { alert: true });
            ws = await this.workspace();
            const got = await this.#receive(name, ws.path, cap, waivers);
            return { ...got, path: ws.path, remove: ws.remove };
        } catch (error) {
            ws?.remove();
            throw error;
        } finally { release(); }
    }

    #receive(name, ws, cap, waivers) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + this.#deadline;
            const header = new HeaderReader();
            let parsed; let bytes = 0; let failure = null; let packStarted = false; let first = Buffer.alloc(0);
            let indexer; let indexed; let readerClosed = false;
            let errText = '';
            const reader = this.#spawnRead(name);
            let settled = false;
            const settle = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
            /* Given up: the bytes stop being taken (the git in the sandbox
               then dies on a closed pipe), the host is told to stop the read,
               and the failure is said once the reader is gone -- or after a
               short grace, should it hang. */
            const fail = (f) => {
                if (failure) return;
                failure = f;
                reader.stdout.destroy();
                try { reader.kill('SIGTERM'); } catch { /* not ours to kill (sudo): the host stops it */ }
                if (indexer && indexer.exitCode === null && indexer.signalCode === null) killGroup(indexer);
                const stopped = this.stopReads(name);
                setTimeout(() => { void stopped.then(() => settle(failure)); }, 10_000).unref?.();
            };
            const timer = setTimeout(() => fail(new GitFailure(504, 'deadline', `Reading stopped: the server's time limit (${Math.round(this.#deadline / 1000)} s).`, { ai: 'your repository could not be read in time; pack it (git gc)' })), Math.max(0, deadline - Date.now()));
            const startIndexer = () => {
                indexed = new Promise((done) => {
                    const child = spawn('git', gitArgs(['index-pack', '--stdin', strictOption(waivers), '--threads=1', `--max-input-size=${cap}`]), { cwd: ws, env: gitEnv(this.home, { GIT_DIR: ws }), detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
                    let err = '';
                    child.stderr.on('data', (d) => { err = (err + d.toString('latin1')).slice(-16384); });
                    child.stdin.on('error', () => {});
                    child.stdin.on('drain', () => reader.stdout.resume());
                    /* index-pack can stop before the reader does: --strict
                       ends at the first bad object. Its stdin is dead then,
                       no 'drain' comes, and a reader paused on a full pipe
                       would wait for the time limit, its fsck refusal said
                       as a timeout (and no waiver offered). So its verdict
                       is taken at once, and the read given up. */
                    const ended = (ix) => {
                        done(ix);
                        if (readerClosed || failure) return;
                        if (ix.code !== 0) fail(packFailure(ix));
                        else reader.stdout.resume();
                    };
                    child.on('error', () => ended({ code: 127, err: 'git could not be started' }));
                    child.on('close', (code) => ended({ code: code ?? 128, err }));
                    indexer = child;
                });
            };
            /* Bytes for an index-pack that has ended go nowhere: its verdict is already in. */
            const feed = (chunk) => {
                if (chunk.length === 0) return;
                if (indexer.exitCode !== null || indexer.signalCode !== null || indexer.stdin.destroyed || indexer.stdin.writableEnded) return;
                if (!indexer.stdin.write(chunk)) reader.stdout.pause();
            };
            reader.stdout.on('data', (chunk) => {
                if (failure) return;
                bytes += chunk.length;
                if (bytes > cap) { fail(new GitFailure(413, 'cap', `The branches are ${Math.ceil(bytes / MiB)} MB or more, over the cap of ${Math.floor(cap / MiB)} MB.`, { ai: `your branches add up to more than ${Math.floor(cap / MiB)} MB` })); return; }
                try {
                    if (!parsed) {
                        const done = header.push(chunk);
                        if (!done) return;
                        parsed = done;
                        chunk = done.rest;
                    }
                    if (!packStarted) {
                        first = Buffer.concat([first, chunk]);
                        if (first.length < 4) return;
                        if (first.subarray(0, 4).toString('latin1') !== 'PACK') throw refused('no pack follows the header');
                        packStarted = true;
                        startIndexer();
                        chunk = first;
                    }
                    feed(chunk);
                } catch (error) { fail(error instanceof GitFailure ? error : refused('it could not be parsed')); }
            });
            reader.stderr.on('data', (d) => { errText = (errText + d.toString('latin1')).slice(-4096); });
            reader.on('error', () => fail(new GitFailure(502, 'host', 'The host program could not be started.', { alert: true })));
            reader.on('close', async (code) => {
                readerClosed = true;
                indexer?.stdin.end();
                const ix = indexed ? await indexed : null;
                if (failure) { await this.stopReads(name); return settle(failure); }
                if (code !== 0) return settle(hostFailure(code, errText, bytes));
                if (!parsed) return settle(refused('the bundle ended inside its header'));
                if (!packStarted) return settle(refused('no pack follows the header'));
                /* A pack lacking objects its commits need: a shallow history
                   the reader could not see (or a pack cut short). */
                if (ix.code !== 0) return settle(packFailure(ix));
                try { settle(null, await this.#land(ws, parsed, deadline)); } catch (error) { settle(error); }
            });
        });
    }

    /* After index-pack: each tip a commit, then written as refs/heads/<b> in the workspace. */
    async #land(ws, parsed, deadline) {
        const { refs, dropped } = parsed;
        const left = () => Math.max(1000, deadline - Date.now());
        if (refs.length > 0) {
            const seen = await this.in(ws, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: refs.map((r) => `${r.id}\n`).join(''), deadlineMs: left() });
            const kinds = new Map(seen.stdout.toString('latin1').split('\n').filter(Boolean).map((l) => l.split(' ')));
            const bad = refs.find((r) => kinds.get(r.id) !== 'commit');
            if (seen.code !== 0 || bad) throw new GitFailure(422, 'fsck', `The tip of ${bad?.name ?? 'a branch'} is not a commit the bundle carries.`, { ai: `fsck refused your commits: the tip of ${bad?.name ?? 'a branch'} is not a commit` });
            /* One repository cannot hold "a" and "a/b": said by name, before git says it less clearly. */
            const names = refs.map((r) => r.name).sort();
            for (const a of names) {
                const b = names.find((n) => n.startsWith(`${a}/`));
                if (b) throw new GitFailure(409, 'clash', `The branches ${a} and ${b} cannot both be read: rename one.`, { ai: `branch ${b} clashes with ${a}; rename one` });
            }
            const wrote = await this.in(ws, ['update-ref', '--stdin'], { input: refs.map((r) => `create refs/heads/${r.name} ${r.id}\n`).join(''), deadlineMs: left() });
            if (wrote.code !== 0) throw new GitFailure(500, 'workspace', 'The branches could not be written in the workspace.');
        }
        return { branches: refs, dropped };
    }
}
