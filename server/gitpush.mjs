/* WHAT WOULD GO OUT OF A REPOSITORY, SHOWN TO THE OWNER -- AND SENT ONLY THEN.
 *
 * A tool commits in its repository, in its machine. It never holds the key
 * that lets commits out: that key is kept here, sealed, and used here. Before
 * anything is sent, the owner is shown what would go: the commits, the files,
 * the changes. What is pushed is exactly the commit that was shown.
 *
 * GIT IS NEVER RUN IN THE TOOL'S REPOSITORY. A repository that a tool can
 * write in could make git run what it likes (hooks, filters, a pager, a
 * file-system monitor). The one thing git is built to do safely with a
 * repository it does not trust is to FETCH from it. So each time:
 *
 *   1. a fresh, bare copy is fetched from the tool's repository into a place
 *      that only this server writes -- no hooks, no settings, no files of
 *      the tool come along, only commits;
 *   2. everything else (reading commits, comparing, sending) is done in that
 *      copy, whose settings are ours.
 *
 * The key travels to git in its environment, never on a command line.
 *
 * WHICH KEY. A key set here for sending, over https, comes first: that is
 * what this screen always did. Otherwise a repository is sent with what it
 * was cloned with (gitaccess.mjs) -- an SSH key made here, or a token or
 * password, which only ever goes back to the https origin it was given for:
 * pointing the address elsewhere never hands it to another server.
 */
import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { GitAccess, readAddress, explain, asEnv } from './gitaccess.mjs';

export const DIFF_MAX = 200_000;
export const COMMITS_MAX = 100;
export const BRANCHES_MAX = 500;
export const BRANCH_MAX = 200;
const SEP = '\x1f';
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';

/* `git(argv, { cwd, env })` -> { code, stdout, stderr }. No shell, a bounded time, a bounded answer. */
export const runGit = (argv, { cwd, env = {} } = {}) => new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/true', LC_ALL: 'C', ...env } },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

/* Why a name cannot be a branch to send to, or '' when it can. These are the
   rules of `git check-ref-format` for refs/heads/<name>, written out here so
   that no git has to be run to know it, plus ours: a plain set of characters
   (it goes on a command line and into a page), no leading "-" (an option),
   a bounded length, and not "HEAD". */
export function branchProblem(name) {
    const text = String(name ?? '');
    if (text === '') return 'A branch has a name.';
    if (text.length > BRANCH_MAX) return `A branch name is at most ${BRANCH_MAX} characters.`;
    if (!/^[A-Za-z0-9._\/-]+$/.test(text)) return 'A branch name is made of letters, digits, ".", "_", "-" and "/".';
    if (text.startsWith('-')) return 'A branch name does not start with "-".';
    if (text === 'HEAD' || text === '@') return 'This name is not a branch.';
    if (text.includes('..') || text.includes('//') || text.startsWith('/') || text.endsWith('/') || text.endsWith('.')) return 'A branch name has no "..", no "//", and does not start or end with "/" or end with ".".';
    if (text.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'No part of a branch name starts with "." or ends with ".lock".';
    return '';
}
const asBranch = (name) => { const why = branchProblem(name); if (why) throw new Refusal(400, why); return String(name); };

export class GitReview {
    #store; #vault; #resources; #root; #git; #local; #access; #queue = new Map();

    /* `localRemotes`: lets a remote be a directory of this machine. For tests only. */
    constructor({ store, vault, resources, dataDir, git = runGit, localRemotes = false, access = new GitAccess({ vault, dataDir }) }) {
        this.#store = store; this.#vault = vault; this.#resources = resources; this.#root = `${dataDir}/git-review`; this.#git = git; this.#local = localRemotes; this.#access = access;
    }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #remoteOf(r) { return this.#store.get(r.name)?.remote ?? r.from; }
    /* Where the commits of a repository go (and where its origin is kept from), or undefined. */
    remoteOf(name) { const r = this.#resources.get(String(name ?? '')); return r?.type === 'git' ? this.#remoteOf(r) : undefined; }
    /* Lets the keeper of the origin (gitkeeper.mjs) fetch with the same way in as Send. */
    reach(name, remote, work) { return this.#reach(name, remote, work); }
    /* Runs `work(env)` with what lets git into `remote`: see the top of this file. */
    async #reach(name, remote, work) {
        let address;
        try { address = readAddress(remote, { localRemotes: this.#local }); } catch { address = undefined; }
        const s = this.#store.get(name);
        const local = address?.transport === 'local' ? asEnv([['protocol.file.allow', 'always']]) : {};
        const credential = address?.transport === 'https' && s?.sealed
            ? { method: 'token', user: s.user, sealed: s.sealed, origin: `https://${address.host}${address.port ? `:${address.port}` : ''}` }
            : this.#access.credentialOf(name);
        return (await this.#access.run(credential, address, (env) => work({ ...env, ...local }))).result;
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
        const before = this.#store.get(r.name);
        this.#store.put({ name: r.name, remote, user: user || undefined, sealed: key ? this.#vault.seal(key) : before?.sealed });
        return this.settings(r.name);
    }

    /* The repository is gone: its key goes with it. */
    forget(name) { this.#store.remove(name); this.#access.forget(name); rmSync(`${this.#root}/${name}.git`, { recursive: true, force: true }); }

    /* One look or one send at a time per repository: both use the same
       copy, and a page and the automatic sending may ask at once. */
    #locked(name, work) {
        const before = this.#queue.get(name) ?? Promise.resolve();
        const run = before.then(work, work);
        const tail = run.catch(() => {});
        this.#queue.set(name, tail);
        void tail.then(() => { if (this.#queue.get(name) === tail) this.#queue.delete(name); });
        return run;
    }

    /* A fresh bare copy of what the tool committed. See the top of this file. */
    async #copy(r) {
        const from = this.#resources.folder(r.name);
        const copy = `${this.#root}/${r.name}.git`;
        rmSync(copy, { recursive: true, force: true });
        mkdirSync(this.#root, { recursive: true });
        const fetched = await this.#git(['clone', '--bare', '--quiet', '--no-local', '--no-tags', '--', `file://${from}`, copy],
            { env: asEnv([['protocol.file.allow', 'always'], ['safe.directory', '*'], ['core.hooksPath', '/dev/null']]) });
        if (fetched.code !== 0) throw new Refusal(502, `The repository could not be read: ${firstLine(fetched.stderr)}`);
        return copy;
    }

    /* What would go out: { state, branch, target, branches, targetExists,
       remoteTip, head, remote, commits, stat, diff, cut, message }.
       `branch` is the tool's branch; `target` the branch of the remote it
       would go to: the one asked for, else the branch of the same name.
       state: 'empty' (nothing committed), 'no-remote', 'unreachable', 'up-to-date',
       'ahead' (can be sent), 'diverged' (the remote has commits this has not). */
    async outgoing(name, { target } = {}) {
        const r = this.#repository(name);
        if (target !== undefined && target !== null && target !== '') asBranch(target);
        return this.#locked(r.name, () => this.#outgoing(r, target || undefined));
    }

    async #outgoing(r, asked) {
        const copy = await this.#copy(r);
        const here = (argv, env) => this.#git(['-C', copy, '-c', 'core.hooksPath=/dev/null', ...argv], { env });
        const remote = this.#remoteOf(r) ?? null;
        const named = await here(['symbolic-ref', '--short', 'HEAD']);
        const branch = named.stdout.trim();
        const tip = branch ? await here(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) : { code: 1, stdout: '' };
        const nothing = { branches: [], targetExists: false, remoteTip: null, stat: '', diff: '', cut: false };
        if (!branch || tip.code !== 0) return { ...nothing, state: 'empty', branch: branch || null, target: asked ?? null, head: null, remote, commits: [], message: 'Nothing has been committed in this repository yet.' };
        if (branchProblem(branch)) throw new Refusal(400, 'The name of the branch is not one that can be sent.');
        const target = asked ?? branch;
        const head = tip.stdout.trim();
        const list = async (...range) => (await here(['log', `--max-count=${COMMITS_MAX}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%s`, ...range])).stdout.split('\n').filter(Boolean)
            .map((line) => { const [id, author, date, ...subject] = line.split(SEP); return { id, author, date, subject: subject.join(SEP).slice(0, 300) }; });
        if (!remote) return { ...nothing, state: 'no-remote', branch, target, head, remote, commits: await list(branch), message: 'No address is set to send these commits to.' };

        /* What the remote has -- every branch, so that the owner can choose
           where to send, and so that a new branch is compared with what is
           already there -- brought into the copy to compare with. */
        const fetched = await this.#reach(r.name, remote, (env) => here(['fetch', '--quiet', '--no-tags', '--prune', '--', remote, '+refs/heads/*:refs/remotes/origin/*'], env));
        if (fetched.code !== 0) {
            return { ...nothing, state: 'unreachable', branch, target, head, remote, commits: [], message: `The remote did not answer as expected: ${explain(fetched.stderr)}` };
        }
        const branches = (await here(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin/'])).stdout.split('\n')
            .filter((b) => b && !branchProblem(b)).sort().slice(0, BRANCHES_MAX);
        const far = `refs/remotes/origin/${target}`;
        const farTip = await here(['rev-parse', '--verify', '--quiet', far]);
        const targetExists = farTip.code === 0;
        const remoteTip = targetExists ? farTip.stdout.trim() : null;
        let commits; let base; let behind = 0;
        if (targetExists) {
            commits = await list(`${far}..${branch}`);
            behind = Number((await here(['rev-list', '--count', `${branch}..${far}`])).stdout.trim());
            base = far;
        } else {
            /* A new branch: what would travel is what the remote has on no
               branch at all; the changes are shown from where the tool's
               branch left the remote's branch of the same name, if any. */
            commits = await list(branch, '--not', '--remotes=origin');
            const fork = (await here(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0
                ? (await here(['merge-base', branch, `refs/remotes/origin/${branch}`])).stdout.trim() : '';
            base = fork || (await here(['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim();
        }
        const compare = ['--no-ext-diff', '--no-textconv', '--no-color', base, branch];
        const stat = (await here(['diff', '--stat=100', ...compare])).stdout;
        const whole = (await here(['diff', ...compare])).stdout;
        const state = !targetExists ? 'ahead' : commits.length === 0 ? 'up-to-date' : behind > 0 ? 'diverged' : 'ahead';
        const message = state === 'up-to-date' ? `Everything committed here is already there, in ${target}.`
            : state === 'diverged' ? `The remote's ${target} has ${behind} commit(s) that this repository does not have: the tool must bring them in first (pull), then this can be sent.`
                : !targetExists ? (commits.length > 0 ? `${commits.length} commit(s) would be sent to ${target}, a new branch on the remote.` : `${target} would be made on the remote, at a commit it already has: no new commit.`)
                    : `${commits.length} commit(s) would be sent to ${target}.`;
        return { state, branch, target, branches, targetExists, remoteTip, head, remote, commits, stat, diff: whole.slice(0, DIFF_MAX), cut: whole.length > DIFF_MAX, message };
    }

    /* Sends exactly the commit that was shown, to exactly the branch that
       was shown: `head` is what the owner looked at, `target` where it was
       said to go (the tool's own branch when not given). The remote is
       looked at again just before: a branch that moved meanwhile is said,
       never overwritten (no force, ever). */
    async push(name, body) {
        const r = this.#repository(name);
        const target = body?.target === undefined || body?.target === null || body?.target === '' ? undefined : asBranch(body.target);
        return this.#locked(r.name, async () => {
            const now = await this.#outgoing(r, target);
            if (now.state !== 'ahead') throw new Refusal(409, now.message);
            if (typeof body?.head !== 'string' || body.head !== now.head) throw new Refusal(409, 'The repository changed since you looked: look again at what would be sent.');
            const sent = await this.#reach(r.name, now.remote, (env) => this.#git(['-C', `${this.#root}/${r.name}.git`, '-c', 'core.hooksPath=/dev/null', 'push', '--quiet', '--', now.remote, `${now.head}:refs/heads/${now.target}`], { env }));
            if (sent.code !== 0) throw new Refusal(502, `The remote refused: ${explain(sent.stderr)}`);
            return { ok: true, branch: now.target, from: now.branch, head: now.head, commits: now.commits.length, made: !now.targetExists };
        });
    }
}
