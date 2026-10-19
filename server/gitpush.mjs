/* WHAT WOULD GO OUT OF A REPOSITORY, SHOWN TO THE OWNER -- AND SENT ONLY THEN.
 *
 * A tool commits in its repository, in its machine. It never holds the key
 * that lets commits out: that key is kept here, sealed, and used here. Before
 * anything is sent, the owner is shown what would go: the commits, the files,
 * the changes. What is pushed is exactly the commit that was shown.
 *
 * GIT IS NEVER RUN IN THE TOOL'S REPOSITORY, nor on any path it can write
 * (gitrunner.mjs says why and how). Each review and each send:
 *
 *   1. reads the tool's branches through the host program's sandbox into a
 *      FRESH WORKSPACE only this server reaches, checked object by object;
 *   2. compares them, in that workspace, with THE REFERENCE: the remote's
 *      history, fetched by this server alone and holding nothing of the
 *      tool's (its objects are lent to the workspace, read-only);
 *   3. for Send, pushes from that workspace exactly the reviewed commit, from
 *      the one ref left there, with a lease on the remote tip that was shown;
 *   4. deletes the workspace.
 *
 * "The remote" is whatever git server the address names; nothing here
 * depends on which. The key travels to git in its environment, never on a
 * command line.
 *
 * WHICH KEY. A key set here for sending, over https, comes first: that is
 * what this screen always did. Otherwise a repository is sent with what it
 * was cloned with (gitaccess.mjs) -- an SSH key made here, or a token or
 * password, which only ever goes back to the https origin it was given for.
 */
import { Refusal } from './conversations.mjs';
import { GitAccess, readAddress, explain } from './gitaccess.mjs';
import { GitRunner, GitFailure, EMPTY_TREE, branchProblem, protocolOf, isId } from './gitrunner.mjs';

export { branchProblem };
export const DIFF_MAX = 200_000;
export const COMMITS_MAX = 100;
export const BRANCHES_MAX = 500;
export { BRANCH_MAX } from './gitrunner.mjs';
export const LARGEST = 10;
export const UNCHANGED_MAX = 50;
/* A commit message is shown up to this many characters, and the cut is said. */
export const MESSAGE_MAX = 4000;
export const REVIEWS_KEPT = 20;
/* The branch diagram: so many commits, so many of the remote's branches. */
export const GRAPH_COMMITS = 40;
export const GRAPH_BRANCHES = 20;
/* How long a review waits for the reference, and a send or a refresh. */
export const REVIEW_WAIT_MS = 10_000;
export const SEND_WAIT_MS = 60_000;
export const FETCH_MS = 300_000;
export const PUSH_MS = 300_000;
/* Asking the remote for its default branch: a short question. */
export const LS_REMOTE_MS = 60_000;
export const DEFAULT_EVERY_MS = 24 * 3_600_000;

const asBranch = (name) => { const why = branchProblem(name); if (why) throw new Refusal(400, why); return String(name); };
const lines = (buf) => buf.toString('utf8').split('\n').filter(Boolean);
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/[^\x20-\x7e]/g, '?').slice(0, 300) ?? '';

/* Text from the agent (messages, names, paths, the diff) as the page may
   show it: control characters and the marks that reorder text on screen
   are written out, never interpreted. Line ends and tabs stay. */
export function escaped(text) {
    /* Controls (Cc), format characters (Cf: bidirectional marks, zero-width
       joiners, the byte-order mark, soft hyphen, tag characters), line and
       paragraph separators, and every code point Unicode says is shown as
       nothing (Default_Ignorable_Code_Point: fillers, variation selectors):
       each could hide or reorder text on the page. */
    return String(text ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
        (c) => (c === '\n' || c === '\t' ? c : `\\u{${c.codePointAt(0).toString(16)}}`));
}

export class GitReview {
    #store; #vault; #resources; #local; #access; #runner; #now; #listeners = []; #waivers = () => ({});

    /* `localRemotes`: lets a remote be a directory of this machine. For tests only.
       `runner`: the git runner (gitrunner.mjs); its reads go through the host program. */
    constructor({ store, vault, resources, dataDir, localRemotes = false, access = new GitAccess({ vault, dataDir }), runner = new GitRunner({ dataDir }), now = () => new Date() }) {
        this.#store = store; this.#vault = vault; this.#resources = resources; this.#local = localRemotes; this.#access = access; this.#runner = runner; this.#now = now;
    }

    get runner() { return this.#runner; }
    /* `listen({ read(name, failure|null), refresh(name, result) })`: told of every read and refresh. */
    listen(listener) { this.#listeners.push(listener); }
    /* `fn(name)`: the owner's fsck waivers of a repository (gitkeeper.mjs keeps them). */
    useWaivers(fn) { this.#waivers = fn; }
    #tell(kind, ...args) { for (const l of this.#listeners) { try { l[kind]?.(...args); } catch { /* a listener never stops a read */ } } }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #record(name) { return this.#store.get(name) ?? { name }; }
    #remoteOf(r) { return this.#store.get(r.name)?.remote ?? r.from; }
    /* Where the commits of a repository go (and where its reference is fetched from), or undefined. */
    remoteOf(name) { const r = this.#resources.get(String(name ?? '')); return r?.type === 'git' ? this.#remoteOf(r) : undefined; }
    #address(remote) { try { return readAddress(remote, { localRemotes: this.#local }); } catch { return undefined; } }
    /* Runs `work(env)` with what lets git into `remote`: see the top of this file. */
    async #reach(name, remote, work) {
        const address = this.#address(remote);
        const s = this.#store.get(name);
        const credential = address?.transport === 'https' && s?.sealed
            ? { method: 'token', user: s.user, sealed: s.sealed, origin: `https://${address.host}${address.port ? `:${address.port}` : ''}` }
            : this.#access.credentialOf(name);
        return (await this.#access.run(credential, address, (env) => work(env, protocolOf(address)))).result;
    }

    /* What the page may know: where it goes, whether a key is kept, which SSH key. Never a key. */
    settings(name) {
        const r = this.#repository(name);
        const s = this.#store.get(r.name);
        const c = this.#access.credentialOf(r.name);
        return { remote: this.#remoteOf(r) ?? null, user: s?.user ?? null, hasKey: Boolean(s?.sealed), sshKey: c?.method === 'ssh-key' ? c.key : null };
    }

    /* Where commits are sent, and the key that lets them in. An empty key keeps the one there is.
       `sshKey`: for an ssh address, which key made here is used (it then also serves to fetch). */
    setRemote(name, body) {
        const r = this.#repository(name);
        const address = readAddress(String(body?.url ?? ''), { localRemotes: this.#local });
        if (!address) throw new Refusal(400, 'Where are the commits sent? An https or ssh address.');
        const remote = address.url;
        if (body?.sshKey && address.transport !== 'ssh') throw new Refusal(400, 'An SSH key is used with an ssh address.');
        const user = String(body?.user ?? '').trim();
        if (user.length > 100 || /[\s:]/.test(user)) throw new Refusal(400, 'The user name of the key has no space and no colon.');
        const key = String(body?.key ?? '');
        if (key.length > 1000 || /[\r\n\0]/.test(key)) throw new Refusal(400, 'A key is one line.');
        if (body?.sshKey) this.#access.useKey(r.name, body.sshKey);
        const before = this.#record(r.name);
        /* Another address: what was reviewed was reviewed against another remote. */
        this.#store.put({ ...before, name: r.name, remote, user: user || undefined, sealed: key ? this.#vault.seal(key) : before?.sealed, reviews: before.remote === remote ? before.reviews : [] });
        return this.settings(r.name);
    }

    /* The repository is gone: its key goes with it. */
    forget(name) { this.#store.remove(name); this.#access.forget(name); }

    /* ---------- the tips of the agent's branches, as the server last saw them ---------- */

    /* { [branch]: { id, movedAt } }: each new tip restarts its clock. */
    tips(name) { return this.#record(name).tips ?? {}; }
    #saw(name, branches) {
        const at = this.#now().toISOString();
        const before = this.tips(name);
        const tips = {};
        for (const b of branches) tips[b.name] = before[b.name]?.id === b.id ? before[b.name] : { id: b.id, movedAt: at };
        this.#store.put({ ...this.#record(name), tips, readAt: at });
        return tips;
    }

    /* One read of the agent's branches into a fresh workspace (gitrunner.mjs). */
    async #read(r, waivers) {
        try {
            const got = await this.#runner.read(r.name, { reference: this.#resources.originPath(r.name), waivers: waivers ?? this.#waivers(r.name) });
            this.#saw(r.name, got.branches);
            this.#tell('read', r.name, null, got);
            return got;
        } catch (error) {
            this.#tell('read', r.name, error);
            if (error instanceof GitFailure && error.kind === 'empty') this.#saw(r.name, []);
            throw error;
        }
    }

    /* A check read: the tips are recorded, the workspace deleted. */
    async readTips(name, { waivers } = {}) {
        const r = this.#repository(name);
        const got = await this.#read(r, waivers);
        got.remove();
        return this.tips(r.name);
    }

    /* ---------- the reference ---------- */

    #reference(name) { return this.#resources.originPath(name); }
    #tipsIn = async (dir) => {
        const r = await this.#runner.in(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/']);
        const tips = new Map();
        for (const line of lines(r.stdout)) {
            const [id, ref] = line.split(' ');
            const b = ref?.slice('refs/heads/'.length);
            if (isId(id) && b && !branchProblem(b)) tips.set(b, id);
        }
        return tips;
    };
    async #isAncestor(dir, older, newer) {
        const r = await this.#runner.in(dir, ['merge-base', '--is-ancestor', '--end-of-options', older, newer], { deadlineMs: 120_000 });
        return r.code === 0;
    }
    /* Is `older` an ancestor of (or the same as) `newer`? A git that fails
       or is stopped is a failure of the review, never a "no". */
    async #ancestry(dir, older, newer) {
        const r = await this.#runner.in(dir, ['merge-base', '--is-ancestor', '--end-of-options', older, newer], { deadlineMs: 120_000 });
        if (!r.killed && !r.signal && (r.code === 0 || r.code === 1)) return r.code === 0;
        throw new GitFailure(504, 'review', 'The review could not be made: git could not compare the branch with the remote (stopped or failed). Try again.');
    }
    async #has(dir, id) { return (await this.#runner.in(dir, ['cat-file', '-e', '--end-of-options', `${id}^{commit}`])).code === 0; }

    /* Fetches the remote's branches into the reference, making it the first
       time. Under the reference's lock. Resolves { ok, message, rewritten,
       made, brought }; `rewritten`: branches whose tip before is not an
       ancestor of their tip now, or that are gone; `brought`: branches that
       came with commits the reference did not have, { branch, commits }.
       The only writer of the reference. */
    async refresh(name, { waitMs = SEND_WAIT_MS } = {}) {
        const r = this.#repository(name);
        const release = await this.#runner.lock(this.#reference(r.name), waitMs);
        try { return await this.#refreshLocked(r); } finally { release(); }
    }
    /* `ours`: { branch, head } just pushed from here: what it brings back is not news from the remote. */
    async #refreshLocked(r, ours = null) {
        const remote = this.#remoteOf(r);
        const said = (result) => { this.#tell('refresh', r.name, result); return result; };
        if (!remote) return said({ ok: false, message: 'This repository has no remote: it was not cloned and no address is set.', rewritten: [] });
        const reference = this.#reference(r.name);
        let made = false;
        try {
            if (!this.#resources.hasOrigin(r.name)) {
                await this.#resources.makeOrigin(r.name);
                const init = await this.#runner.git(['init', '--quiet', '--bare', '--object-format=sha1', '--initial-branch=main', reference]);
                if (init.code !== 0) return said({ ok: false, message: `The reference could not be made: ${firstLine(init.stderr)}`, rewritten: [] });
                made = true;
            }
        } catch (error) {
            return said({ ok: false, message: error instanceof Refusal ? error.message : 'The reference could not be made.', rewritten: [] });
        }
        const before = await this.#tipsIn(reference);
        const waivers = Object.entries(this.#waivers(r.name) ?? {}).map(([id, level]) => `fetch.fsck.${id}=${level}`);
        /* Reaching the remote can throw before git runs (its key gone, a vault
           that does not open, a run directory that cannot be made): that is
           a failed refresh like any other -- recorded, counted, alerted after
           three -- never an exception that skips all of that. */
        let fetched;
        try {
            fetched = await this.#reach(r.name, remote, (env, allow) => this.#runner.in(reference, ['fetch', '--quiet', '--prune', '--no-tags', '--end-of-options', remote, '+refs/heads/*:refs/heads/*'],
                { env, allow, receive: true, extra: waivers, deadlineMs: FETCH_MS }));
        } catch (error) {
            return said({ ok: false, message: error instanceof Refusal ? error.message : 'The remote could not be reached.', rewritten: [] });
        }
        if (fetched.killed || fetched.signal) {
            const removed = this.#runner.staleLocks(reference);
            return said({ ok: false, message: `The remote did not answer in time${removed.length ? `; stale lock files removed: ${removed.join(', ')}` : ''}.`, rewritten: [], stale: removed });
        }
        if (fetched.code !== 0) return said({ ok: false, message: explain(fetched.stderr), rewritten: [] });
        const after = await this.#tipsIn(reference);
        const rewritten = [];
        for (const [b, was] of before) {
            const now = after.get(b);
            if (!now) rewritten.push({ branch: b, was, now: null });
            else if (now !== was && !await this.#isAncestor(reference, was, now)) rewritten.push({ branch: b, was, now });
        }
        /* Counted against everything the reference had before, so a branch
           made from another one brings only its own commits. The first fetch
           brings the whole history: that is not news. */
        const brought = [];
        if (!made && before.size > 0) {
            const had = [...before.values()].map((id) => `^${id}`).join('\n');
            for (const [b, now] of after) {
                if (before.get(b) === now || rewritten.some((w) => w.branch === b) || (ours && ours.branch === b && ours.head === now)) continue;
                const counted = await this.#runner.in(reference, ['rev-list', '--count', '--stdin', '--end-of-options'], { input: `${now}\n${had}\n`, deadlineMs: 120_000 }).catch(() => null);
                const commits = Number(counted?.code === 0 ? counted.stdout.toString('latin1').trim() : 0) || 0;
                if (commits > 0) brought.push({ branch: b, commits, head: now, base: before.get(b) ?? null });
            }
        }
        if (made) await this.#resources.shareOrigin(r.name).catch(() => {});
        await this.#learnDefault(r, remote).catch(() => {});
        return said({ ok: true, message: 'Up to date with the remote.', rewritten, made, brought });
    }

    /* Is `tip` of the agent's branch `b` something the remote lacks? Not
       when the remote has that commit on its branch of the same name. Read
       only, in the reference. */
    async remoteLacks(name, b, tip) {
        const reference = this.#reference(name);
        if (!this.#resources.hasOrigin(name)) return true;
        const release = await this.#runner.lock(reference, SEND_WAIT_MS);
        try {
            if (!isId(tip) || !await this.#has(reference, tip)) return true;
            /* The exact ref, never a name git would guess at (rev-parse
               tries refs/heads/<b> under several prefixes). */
            const theirs = (await this.#tipsIn(reference)).get(asBranch(b));
            /* No branch of that name on the remote: nothing to send if the
               commit is on another one already (a branch merged, then
               deleted there, is not made again). */
            if (!theirs) return !(await this.#runner.in(reference, ['for-each-ref', '--format=%(refname)', `--contains=${tip}`, 'refs/heads/'])).stdout.toString('latin1').trim();
            return !await this.#isAncestor(reference, tip, theirs);
        } finally { release(); }
    }
    /* THE REMOTE'S DEFAULT BRANCH, which automatic sending lets a
       conversation send to only after the owner confirmed it (gitkeeper.mjs).
       The fetch above copies branches, not the remote's HEAD, so it is asked
       for on its own -- when not known yet (an empty remote has none: asked
       again at the next refresh), then once a day: it rarely changes, and
       every question is one more trip to the remote. A failure keeps what
       was known (unknown: automatic sending sends nothing by itself that
       the owner did not confirm, see gitkeeper.mjs). */
    async #learnDefault(r, remote) {
        const record = this.#record(r.name);
        const at = record.defaultBranchAt ? new Date(record.defaultBranchAt).getTime() : 0;
        if (record.defaultBranch && this.#now().getTime() - at < DEFAULT_EVERY_MS) return;
        const asked = await this.#reach(r.name, remote, (env, allow) => this.#runner.in(this.#reference(r.name), ['ls-remote', '--symref', '--end-of-options', remote, 'HEAD'], { env, allow, deadlineMs: LS_REMOTE_MS }));
        if (asked.code !== 0) return;
        const found = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(asked.stdout.toString('latin1'));
        const branch = found && !branchProblem(found[1]) ? found[1] : null;
        if (!branch) return;
        this.#store.put({ ...this.#record(r.name), name: r.name, defaultBranch: branch, defaultBranchAt: this.#now().toISOString() });
    }
    /* The remote's default branch as last learnt, or null when unknown. */
    defaultBranch(name) { return this.#record(name).defaultBranch ?? null; }

    /* The remote's tip of a branch, as the reference has it, or null. */
    async remoteTip(name, b) {
        if (!this.#resources.hasOrigin(name)) return null;
        return (await this.#tipsIn(this.#reference(name))).get(asBranch(b)) ?? null;
    }

    /* Daily upkeep of the reference: its objects packed again (remote objects only). */
    async upkeep(name) {
        if (!this.#resources.hasOrigin(name)) return;
        const release = await this.#runner.lock(this.#reference(name), SEND_WAIT_MS);
        try { await this.#runner.in(this.#reference(name), ['repack', '-a', '-d', '--quiet', '--threads=1'], { deadlineMs: 1_800_000 }); } finally { release(); }
    }

    /* ---------- the review ---------- */

    /* The review kept for a send: the last one of that commit (and branch, when given). */
    reviewOf(name, head, target) {
        return (this.#record(name).reviews ?? []).find((v) => v.head === head && (target === undefined || v.target === target));
    }
    #keep(name, review) {
        const record = this.#record(name);
        const reviews = [review, ...(record.reviews ?? []).filter((v) => !(v.head === review.head && v.target === review.target))].slice(0, REVIEWS_KEPT);
        this.#store.put({ ...record, reviews });
    }

    /* What would go out: { state, branch, agentBranches, dropped, target,
       branches, targetExists, remoteTip, head, remote, commits, count, stat,
       diff, cut, guards, asOf, message }.
       `branch`: the agent's branch (the owner's pick, else the one that moved
       last); `target`: the remote's branch it would go to (the one asked
       for, else the same name). state: 'empty', 'no-remote', 'unreachable',
       'up-to-date', 'ahead' (can be sent), 'diverged'. */
    async outgoing(name, { target, branch } = {}) {
        const r = this.#repository(name);
        const asked = target === undefined || target === null || target === '' ? undefined : asBranch(target);
        const pick = branch === undefined || branch === null || branch === '' ? undefined : asBranch(branch);
        const remote = this.#remoteOf(r) ?? null;
        const nothing = { branches: [], agentBranches: [], dropped: [], targetExists: false, remoteTip: null, head: null, commits: [], count: 0, stat: '', diff: '', cut: false, guards: null, remote };
        if (remote) {
            const fresh = await this.refresh(r.name, { waitMs: REVIEW_WAIT_MS });
            if (!fresh.ok) return { ...nothing, state: 'unreachable', branch: pick ?? null, target: asked ?? null, message: `The remote did not answer as expected: ${fresh.message}` };
        }
        let got;
        try { got = await this.#read(r); } catch (error) {
            if (error instanceof GitFailure && error.kind === 'empty') return { ...nothing, state: 'empty', branch: null, target: asked ?? null, message: 'Nothing has been committed on a branch in this repository yet.' };
            throw error;
        }
        try {
            const tips = this.tips(r.name);
            const agentBranches = got.branches.map((b) => ({ name: b.name, id: b.id, movedAt: tips[b.name]?.movedAt ?? null }))
                .sort((a, b) => String(b.movedAt).localeCompare(String(a.movedAt)) || a.name.localeCompare(b.name));
            const dropped = got.dropped.map((d) => ({ name: escaped(d.name), why: d.why }));
            if (agentBranches.length === 0) return { ...nothing, dropped, state: 'empty', branch: null, target: asked ?? null, message: 'No branch of this repository can be sent: see the names that were not taken.' };
            const chosen = pick ? agentBranches.find((b) => b.name === pick) : agentBranches[0];
            if (!chosen) throw new Refusal(404, `The agent's repository has no branch ${pick}.`);
            const ws = got.path;
            const head = chosen.id;
            const to = asked ?? chosen.name;
            const asOf = this.#now().toISOString();
            const base0 = { agentBranches, dropped, branch: chosen.name, target: to, head, remote, asOf };
            if (!remote) {
                const shown = await this.#compare(ws, { head, base: EMPTY_TREE, range: [head], negatives: [] });
                return { ...nothing, ...base0, ...shown, state: 'no-remote', message: 'No address is set to send these commits to.' };
            }
            const reference = this.#reference(r.name);
            const release = await this.#runner.lock(reference, REVIEW_WAIT_MS);
            try {
                this.#runner.borrow(ws, reference);
                const remoteTips = await this.#tipsIn(reference);
                const branches = [...remoteTips.keys()].sort().slice(0, BRANCHES_MAX);
                const remoteTip = remoteTips.get(to) ?? null;
                let shown; let behind = null; let inRemote = false; let containsRemote = true;
                if (remoteTip) {
                    shown = await this.#compare(ws, { head, base: remoteTip, range: [head], negatives: [remoteTip] });
                    /* The state rests on ancestry, asked directly, never on a
                       count: a count that failed must not read as 0, "already
                       there", nor as "nothing behind". */
                    inRemote = await this.#ancestry(ws, head, remoteTip);
                    containsRemote = await this.#ancestry(ws, remoteTip, head);
                    const b = await this.#runner.in(ws, ['rev-list', '--count', '--end-of-options', remoteTip, `^${head}`], { deadlineMs: 120_000 });
                    const text = b.stdout.toString('latin1').trim();
                    behind = b.code === 0 && !b.killed && /^\d+$/.test(text) ? Number(text) : null;
                } else {
                    /* A new branch: what would travel is what the remote has on
                       no branch at all; the changes are shown from where the
                       agent's branch left the remote's branch of its own name. */
                    const same = remoteTips.get(chosen.name);
                    const fork = same ? (await this.#runner.in(ws, ['merge-base', '--end-of-options', head, same])).stdout.toString('latin1').trim() : '';
                    shown = await this.#compare(ws, { head, base: isId(fork) ? fork : EMPTY_TREE, range: [head], negatives: [...remoteTips.values()] });
                }
                const state = !remoteTip ? 'ahead' : inRemote ? 'up-to-date' : !containsRemote ? 'diverged' : 'ahead';
                const n = shown.count;
                const commitsText = n === null ? 'Commits (their number could not be counted)' : `${n} commit(s)`;
                const message = state === 'up-to-date' ? `Everything committed here is already there, in ${to}.`
                    : state === 'diverged' ? `The remote's ${to} has ${behind ?? 'some'} commit(s) that this repository does not have: the tool must bring them in first (pull), then this can be sent.`
                        : !remoteTip ? (n !== 0 ? `${commitsText} would be sent to ${to}, a new branch on the remote.` : `${to} would be made on the remote, at a commit it already has: no new commit.`)
                            : `${commitsText} would be sent to ${to}.`;
                if (state === 'ahead') this.#keep(r.name, { branch: chosen.name, head, target: to, remoteTip, count: n ?? undefined, confirm: shown.guards.confirm, at: asOf });
                return { ...nothing, ...base0, ...shown, branches, targetExists: Boolean(remoteTip), remoteTip, state, message };
            } finally { release(); }
        } finally { got.remove(); }
    }

    /* The workspace of one read, with the remote's history lent to it when
       there is one, for `work(ws, remoteTips)`; deleted after. */
    async #withRead(r, work) {
        const got = await this.#read(r);
        try {
            let release = null; let remoteTips = new Map();
            if (this.#remoteOf(r) && this.#resources.hasOrigin(r.name)) {
                release = await this.#runner.lock(this.#reference(r.name), REVIEW_WAIT_MS);
                this.#runner.borrow(got.path, this.#reference(r.name));
                remoteTips = await this.#tipsIn(this.#reference(r.name));
            }
            try { return await work(got, remoteTips); } finally { release?.(); }
        } finally { got.remove(); }
    }

    /* THE BRANCH DIAGRAM: the agent's branches, the remote's, and their
       last commits, newest first in topological order: { branches: [{name,
       id, side: 'agent'|'remote'}], commits: [{id, parents, subject, date,
       refs: [{name, side}]}] }. What the agent wrote is escaped as everywhere. */
    async graph(name) {
        const r = this.#repository(name);
        try {
            return await this.#withRead(r, async (got, remoteTips) => {
                const branches = got.branches.map((b) => ({ name: escaped(b.name), id: b.id, side: 'agent' }));
                for (const [b, id] of [...remoteTips].sort(([a], [c]) => a.localeCompare(c)).slice(0, GRAPH_BRANCHES)) branches.push({ name: escaped(b), id, side: 'remote' });
                const tips = [...new Set(branches.map((b) => b.id))];
                if (tips.length === 0) return { branches, commits: [] };
                const log = await this.#runner.in(got.path, ['log', '--topo-order', `--max-count=${GRAPH_COMMITS}`, '-z', '--format=%H%x00%P%x00%aI%x00%s', '--stdin', '--end-of-options'], { input: `${tips.join('\n')}\n`, deadlineMs: 60_000, maxBytes: 4 * 1024 * 1024 });
                const fields = log.stdout.toString('utf8').split('\0');
                const commits = [];
                for (let i = 0; i + 3 < fields.length; i += 4) {
                    const id = fields[i].replace(/^\n/, '');
                    if (!isId(id)) break;
                    commits.push({ id, parents: fields[i + 1].split(' ').filter(isId), date: fields[i + 2], subject: escaped(fields[i + 3]).slice(0, 300),
                        refs: branches.filter((b) => b.id === id).map((b) => ({ name: b.name, side: b.side })) });
                }
                return { branches, commits };
            });
        } catch (error) {
            if (error instanceof GitFailure && error.kind === 'empty') return { branches: [], commits: [] };
            throw error;
        }
    }

    /* ONE COMMIT, as a review shows it: against its first parent (or
       nothing, for the first commit). Or, given `base`, the commits from
       base to it (what a line of the chat said was sent or brought). Named
       by their identifier, whole or its first 7 characters at least, as a
       line of the chat shows them. Never sent from here. */
    async commit(name, id, base) {
        const r = this.#repository(name);
        const asked = String(id ?? '');
        const from = base === null || base === undefined || base === '' ? '' : String(base);
        const SHORT = /^[0-9a-f]{7,40}$/;
        if (!SHORT.test(asked) || (from && !SHORT.test(from))) throw new Refusal(400, 'A commit is named by its identifier (7 to 40 hexadecimal characters).');
        return this.#withRead(r, async (got) => {
            const p = await this.#runner.in(got.path, ['rev-list', '--parents', '--max-count=1', '--end-of-options', asked], { deadlineMs: 60_000 });
            const ids = p.stdout.toString('latin1').trim().split(' ');
            if (p.code !== 0 || !isId(ids[0]) || !ids[0].startsWith(asked)) throw new Refusal(404, 'This commit is not in the repository.');
            const whole = ids[0];
            if (from) {
                const q = await this.#runner.in(got.path, ['rev-list', '--max-count=1', '--end-of-options', from], { deadlineMs: 60_000 });
                const was = q.stdout.toString('latin1').trim();
                if (q.code !== 0 || !isId(was) || !was.startsWith(from)) throw new Refusal(404, 'This commit is not in the repository.');
                const shown = await this.#compare(got.path, { head: whole, base: was, range: [whole], negatives: [was] });
                return { ...shown, id: whole, base: was, parents: [was], head: whole, state: 'commit', message: '' };
            }
            const parents = ids.slice(1).filter(isId);
            const shown = await this.#compare(got.path, { head: whole, base: parents[0] ?? EMPTY_TREE, range: [whole], negatives: parents });
            return { ...shown, id: whole, parents, head: whole, state: 'commit', message: parents.length > 1 ? 'A merge: its changes against its first parent.' : '' };
        });
    }

    /* What a review shows of head against base, in a workspace: the commits
       (with their whole messages), the true count, the files, the changes,
       and what the changes alone could hide. `range` and `negatives` say
       which commits are new: reachable from head, from none of negatives. */
    async #compare(ws, { head, base, range, negatives }) {
        const revs = `${[...range, ...negatives.map((id) => `^${id}`)].join('\n')}\n`;
        const inWs = (argv, options) => this.#runner.in(ws, argv, { deadlineMs: 120_000, ...options });
        /* WHAT THE REVIEW COULD NOT SHOW. Each git below may fail or be
           stopped by its deadline or its size limit (a long history, a huge
           message, a pathological diff): what it would have shown is then
           missing, and that is said here, and asks the owner to confirm. A
           missing answer is never read as "nothing": not a count of 0, not
           an empty diff, not an empty list. */
        const incomplete = [];
        const failed = (r) => r.code !== 0 || Boolean(r.killed) || Boolean(r.signal);
        const stopped = (r) => (r.killed === 'size' ? 'too long to read whole' : r.killed === 'deadline' ? 'stopped by its time limit' : 'git failed');
        const counted = await inWs(['rev-list', '--count', '--stdin', '--end-of-options'], { input: revs });
        const countText = counted.stdout.toString('latin1').trim();
        const count = !failed(counted) && /^\d+$/.test(countText) ? Number(countText) : null;
        if (count === null) incomplete.push(`The commits could not be counted (${stopped(counted)}).`);
        const log = await inWs(['log', `--max-count=${COMMITS_MAX}`, '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', '--stdin', '--end-of-options'], { input: revs, maxBytes: 8 * 1024 * 1024 });
        const fields = log.stdout.toString('utf8').split('\0');
        /* Cut short: the last record may be a part of a commit. Not listed as if whole. */
        const records = failed(log) ? Math.floor((fields.length - 1) / 6) * 6 : fields.length;
        const commits = [];
        for (let i = 0; i + 5 < records; i += 6) {
            const [id, parents, author, mail, date, body] = fields.slice(i, i + 6);
            const whole = escaped(body.trim());
            const message = whole.length > MESSAGE_MAX ? `${whole.slice(0, MESSAGE_MAX)}\n[... ${whole.length - MESSAGE_MAX} more characters of this message are not shown]` : whole;
            commits.push({ id: id.replace(/^\n/, ''), parents: parents.split(' ').filter(Boolean).length, author: escaped(author).slice(0, 200), email: escaped(mail).slice(0, 200), date, subject: whole.split('\n')[0].slice(0, 300), message, messageCut: whole.length > MESSAGE_MAX });
        }
        const cutMessages = commits.filter((c) => c.messageCut).length;
        if (cutMessages > 0) incomplete.push(`${cutMessages} commit message(s) are longer than ${MESSAGE_MAX} characters: only their start is shown.`);
        if (failed(log)) incomplete.push(`The list of commits is not whole (${stopped(log)}): ${commits.length} listed.`);
        else if (count !== null && commits.length < Math.min(count, COMMITS_MAX)) incomplete.push(`Only ${commits.length} of ${count} commits could be listed.`);
        const compare = ['--text', '--no-ext-diff', '--no-textconv', '--no-color', '--end-of-options', base, head];
        const statRun = await inWs(['diff', '--stat=100', ...compare], { maxBytes: 1024 * 1024 });
        if (failed(statRun)) incomplete.push(`The list of changed files is not whole (${stopped(statRun)}).`);
        const stat = escaped(statRun.stdout.toString('utf8'));
        const whole = await inWs(['diff', ...compare], { maxBytes: DIFF_MAX + 1 });
        /* Cut by its size, or stopped for any other reason: either way not all of it is shown. */
        const cut = failed(whole) || whole.stdout.length > DIFF_MAX;
        if (failed(whole) && whole.killed !== 'size') incomplete.push(`The changes could not be shown whole (${stopped(whole)}).`);
        const diff = escaped(whole.stdout.subarray(0, DIFF_MAX).toString('utf8'));
        /* AGAINST HISTORY THE DIFF CANNOT SHOW: a file added then removed,
           a huge blob, more commits than a page lists. */
        const sizeRun = await inWs(['rev-list', '--objects', '--disk-usage', '--stdin', '--end-of-options'], { input: revs });
        const sizeText = sizeRun.stdout.toString('latin1').trim();
        const newBytes = !failed(sizeRun) && /^\d+$/.test(sizeText) ? Number(sizeText) : null;
        if (newBytes === null) incomplete.push(`The size of the new data could not be measured (${stopped(sizeRun)}).`);
        const objects = await inWs(['rev-list', '--objects', '--stdin', '--end-of-options'], { input: revs, maxBytes: 32 * 1024 * 1024 });
        if (failed(objects)) incomplete.push(`Not every new file could be weighed (${stopped(objects)}).`);
        const pathOf = new Map();
        for (const line of objects.stdout.toString('utf8').split('\n')) { const sp = line.indexOf(' '); if (sp === 40) pathOf.set(line.slice(0, 40), line.slice(41)); }
        let largest = [];
        if (pathOf.size > 0) {
            const sized = await inWs(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${[...pathOf.keys()].join('\n')}\n`, maxBytes: 32 * 1024 * 1024 });
            if (failed(sized)) incomplete.push(`Not every new file could be weighed (${stopped(sized)}).`);
            largest = lines(sized.stdout).map((l) => l.split(' ')).filter(([, type]) => type === 'blob')
                .map(([id, , size]) => ({ id, size: Number(size), path: escaped(pathOf.get(id) ?? '').slice(0, 300) }))
                .sort((a, b) => b.size - a.size).slice(0, LARGEST);
        }
        const touchedRun = await inWs(['log', '--name-only', '-z', '--format=', '--stdin', '--end-of-options'], { input: revs, maxBytes: 16 * 1024 * 1024 });
        const netRun = await inWs(['diff', '--name-only', '-z', '--no-renames', ...compare], { maxBytes: 16 * 1024 * 1024 });
        if (failed(touchedRun) || failed(netRun)) incomplete.push(`The files changed and changed back could not all be found (${stopped(failed(touchedRun) ? touchedRun : netRun)}).`);
        const touched = new Set(touchedRun.stdout.toString('utf8').split('\0').map((p) => p.replace(/^\n+/, '')).filter(Boolean));
        const net = new Set(netRun.stdout.toString('utf8').split('\0').filter(Boolean));
        const allUnchanged = [...touched].filter((p) => !net.has(p));
        const unchanged = allUnchanged.slice(0, UNCHANGED_MAX).map((p) => escaped(p).slice(0, 300));
        /* More than the page lists: an old add-then-delete must not hide behind newer decoys. */
        if (allUnchanged.length > UNCHANGED_MAX) incomplete.push(`${allUnchanged.length} files were changed and changed back; only ${UNCHANGED_MAX} are listed.`);
        const confirm = count === null || count > COMMITS_MAX || cut || incomplete.length > 0;
        return { commits, count, stat, diff, cut, guards: { newBytes, largest, unchanged, unchangedAll: allUnchanged.length, merges: commits.filter((c) => c.parents > 1).length, confirm, incomplete, listedAll: !failed(objects) } };
    }

    /* ---------- send ---------- */

    /* Sends exactly the commit that was shown, to exactly the branch that
       was shown: `head` is what the owner looked at, `target` where it was
       said to go. Resolves { ok, branch, from, head, commits, made, already }. */
    async push(name, body) {
        const r = this.#repository(name);
        const target = body?.target === undefined || body?.target === null || body?.target === '' ? undefined : asBranch(body.target);
        const head = String(body?.head ?? '');
        if (!this.#remoteOf(r)) throw new GitFailure(409, 'no-address', 'No address is set to send these commits to.');
        const review = isId(head) ? this.reviewOf(r.name, head, target) : undefined;
        if (!review) throw new GitFailure(409, 'look', 'The repository changed since you looked: look again at what would be sent.');
        if (review.confirm && body?.sure !== true) throw new GitFailure(409, 'confirm', 'This is more than the page could show (over 100 commits, or a diff cut short): confirm that it should be sent anyway.');
        return this.send(r.name, review);
    }

    /* The send itself, for the page and for automatic sending: `review` is
       { branch, head, target, remoteTip, count, auto }. Every step of the
       blueprint's section 6, in order. `auto`: sent automatically -- no
       owner was shown a remote tip, so the remote's tip after the refresh
       of step (2) is the one leased (a first sending with no reference yet
       is not "the remote moved"); that the branch has it all is still
       required. Never set from the page: a page's review is a stored one. */
    async send(name, review) {
        const r = this.#repository(name);
        const remote = this.#remoteOf(r);
        if (!remote) throw new GitFailure(409, 'no-address', 'No address is set to send these commits to.');
        const { branch, head, target } = review;
        asBranch(branch); asBranch(target);
        if (!isId(head) || (review.remoteTip !== null && review.remoteTip !== undefined && !isId(review.remoteTip))) throw new GitFailure(409, 'look', 'Look again at what would be sent.');
        let remoteTip = review.remoteTip ?? null;
        let count = review.count;
        const sent = (extra) => ({ ok: true, branch: target, from: branch, head, base: remoteTip, commits: count ?? 0, made: !remoteTip, already: false, ...extra });
        /* (1) What the agent has now, read again into a fresh workspace. */
        let got;
        try { got = await this.#read(r); } catch (error) {
            throw new GitFailure(409, 'reread', `Not sent: could not confirm the agent's branch. ${error.message}`, { ai: error.ai ?? null });
        }
        const reference = this.#reference(r.name);
        try {
            const release = await this.#runner.lock(reference, SEND_WAIT_MS);
            try {
                /* (2) What the remote has now. Already there: nothing to push. */
                const fresh = await this.#refreshLocked(r);
                if (!fresh.ok) throw new GitFailure(502, 'unreachable', `Not sent: the remote is unreachable. ${fresh.message}`);
                /* Automatic sending: whether this branch may go by itself is
                   decided again here, under the lock, with the remote's
                   default branch as this very refresh learnt it (it may have
                   changed, or become known, since the decision was made).
                   `allow(defaultBranch)` comes from the keeper; none: not sent. */
                if (review.auto === true && (typeof review.allow !== 'function' || review.allow(this.defaultBranch(r.name)) !== true)) {
                    throw new GitFailure(409, 'not-allowed', `Not sent: ${target} may not be sent automatically (the remote's default branch, or a pattern not confirmed). Confirm it in the conversation's panel, or send it from the review.`);
                }
                const now = (await this.#tipsIn(reference)).get(target) ?? null;
                if (review.auto === true) remoteTip = now;
                if (now && (now === head || (await this.#has(reference, head) && await this.#isAncestor(reference, head, now)))) return sent({ already: true, commits: 0, made: false });
                /* Automatic sending makes a branch on the remote only where the
                   owner allowed it for that conversation: asked here, on the
                   tip just fetched under the lock, not on an older reading. */
                if (review.auto === true && !now && review.create !== true) throw new GitFailure(409, 'no-branch', `Not sent: ${target} does not exist on the remote, and automatic sending may not create branches here.`);
                /* (3) Exactly what was reviewed, on both sides. */
                const mine = got.branches.find((b) => b.name === branch);
                if (!mine || mine.id !== head) throw new GitFailure(409, 'agent-moved', `Not sent: the agent changed ${branch} since you looked. Look again.`);
                if (now !== remoteTip) throw new GitFailure(409, 'remote-moved', `Not sent: the remote's ${target} moved since you looked. Look again.`, { ai: `origin/${target} moved: pull origin/${target} first` });
                const ws = got.path;
                const only = `${got.branches.map((b) => `delete refs/heads/${b.name}\n`).join('')}create refs/clavarium/send ${head}\n`;
                if ((await this.#runner.in(ws, ['update-ref', '--stdin'], { input: only })).code !== 0) throw new GitFailure(500, 'workspace', 'Not sent: the workspace could not be prepared.');
                this.#runner.borrow(ws, reference);
                if (remoteTip && !await this.#isAncestor(ws, remoteTip, 'refs/clavarium/send')) throw new GitFailure(409, 'diverged', `Not sent: the remote's ${target} has commits this branch does not have. The agent must pull them first.`, { ai: `pull origin/${target} first` });
                /* Sent automatically: how many commits travel, said in the log. */
                if (count === undefined) {
                    const others = [...(await this.#tipsIn(reference)).values()].map((id) => `^${id}`);
                    count = Number((await this.#runner.in(ws, ['rev-list', '--count', '--stdin', '--end-of-options'], { input: `refs/clavarium/send\n${others.join('\n')}\n` })).stdout.toString('latin1').trim()) || 0;
                }
                /* (4) The push: the lease on the tip that was shown. */
                const pushed = await this.#reach(r.name, remote, (env, allow) => this.#runner.in(ws, ['push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/${target}:${remoteTip ?? ''}`, '--end-of-options', remote, `refs/clavarium/send:refs/heads/${target}`],
                    { env, allow, deadlineMs: PUSH_MS }).then((x) => ({ ...x, stdout: x.stdout.toString('utf8') })));
                const line = pushed.stdout.split('\n').find((l) => /^[ *+!=-]\t/.test(l)) ?? '';
                const [flag, refs, summary = ''] = [line[0], ...line.slice(2).split('\t')];
                const ours = refs === `refs/clavarium/send:refs/heads/${target}`;
                if (pushed.killed || pushed.signal || (!line && pushed.code !== 0)) {
                    /* Ended by a deadline or a signal, or failed with no word
                       about our ref (a connection dropped after the remote
                       took the pack): the outcome is unknown. The remote says. */
                    const settle = await this.#refreshLocked(r, { branch: target, head });
                    if (!settle.ok) throw new GitFailure(502, 'unknown-unreachable', `The outcome is unknown, and the remote is unreachable: automatic sending to ${target} waits until a refresh settles it.`, { alert: true });
                    if ((await this.#tipsIn(reference)).get(target) === head) return sent({});
                    throw new GitFailure(502, 'unknown-not-sent', 'The outcome was unknown; refreshed: it is not on the remote.');
                }
                if (line && ours && (flag === '+' || /forced update/.test(summary))) throw new GitFailure(502, 'forced', 'The push was not as reviewed (a forced update): look at the remote.', { alert: true });
                if (line && !ours && (flag === ' ' || flag === '*' || flag === '+')) throw new GitFailure(502, 'forced', 'The push was not as reviewed (another source): look at the remote.', { alert: true });
                if (flag === '!' && /stale info|fetch first|non-fast-forward/.test(summary)) throw new GitFailure(409, 'remote-moved', `Not sent: the remote's ${target} moved (the lease was refused). Look again.`, { ai: `origin/${target} moved: pull origin/${target} first` });
                if (pushed.code !== 0 || !(flag === ' ' || flag === '*')) throw new GitFailure(502, 'refused', `The remote refused: ${explain(pushed.stderr) || firstLine(summary)}`);
                /* (5) The pushed commits enter the reference only as the remote's history. */
                const after = await this.#refreshLocked(r, { branch: target, head });
                return sent(after.ok ? {} : { refreshed: false, note: 'Sent; the reference was not refreshed.' });
            } finally { release(); }
        } finally { got.remove(); }
    }
}
