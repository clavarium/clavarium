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
 */
import { execFile } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { readOrigin } from './resources.mjs';

export const DIFF_MAX = 200_000;
export const COMMITS_MAX = 100;
const SEP = '\x1f';
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';

/* `git(argv, { cwd, env })` -> { code, stdout, stderr }. No shell, a bounded time, a bounded answer. */
const runGit = (argv, { cwd, env = {} } = {}) => new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/true', LC_ALL: 'C', ...env } },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

/* Settings handed to git through its environment: [[key, value], ...]. */
const asEnv = (pairs) => Object.fromEntries([['GIT_CONFIG_COUNT', String(pairs.length)], ...pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])]);

export class GitReview {
    #store; #vault; #resources; #root; #git; #local;

    /* `localRemotes`: lets a remote be a directory of this machine. For tests only. */
    constructor({ store, vault, resources, dataDir, git = runGit, localRemotes = false }) {
        this.#store = store; this.#vault = vault; this.#resources = resources; this.#root = `${dataDir}/git-review`; this.#git = git; this.#local = localRemotes;
    }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #remoteOf(r) { return this.#store.get(r.name)?.remote ?? r.from; }
    #auth(name) {
        const s = this.#store.get(name);
        if (!s?.sealed) return {};
        const basic = Buffer.from(`${s.user || 'x-access-token'}:${this.#vault.open(s.sealed)}`).toString('base64');
        return asEnv([['http.extraHeader', `Authorization: Basic ${basic}`]]);
    }

    /* What the page may know: where it goes, and whether a key is kept. Never the key. */
    settings(name) {
        const r = this.#repository(name);
        const s = this.#store.get(r.name);
        return { remote: this.#remoteOf(r) ?? null, user: s?.user ?? null, hasKey: Boolean(s?.sealed) };
    }

    /* Where commits are sent, and the key that lets them in. An empty key keeps the one there is. */
    setRemote(name, body) {
        const r = this.#repository(name);
        const asked = String(body?.url ?? '').trim();
        const remote = this.#local && asked.startsWith('/') ? asked : readOrigin(asked);
        if (!remote) throw new Refusal(400, 'Where are the commits sent? An https address.');
        const user = String(body?.user ?? '').trim();
        if (user.length > 100 || /[\s:]/.test(user)) throw new Refusal(400, 'The user name of the key has no space and no colon.');
        const key = String(body?.key ?? '');
        if (key.length > 1000 || /[\r\n\0]/.test(key)) throw new Refusal(400, 'A key is one line.');
        const before = this.#store.get(r.name);
        this.#store.put({ name: r.name, remote, user: user || undefined, sealed: key ? this.#vault.seal(key) : before?.sealed });
        return this.settings(r.name);
    }

    /* The repository is gone: its key goes with it. */
    forget(name) { this.#store.remove(name); rmSync(`${this.#root}/${name}.git`, { recursive: true, force: true }); }

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

    /* What would go out: { state, branch, head, remote, commits, stat, diff, cut, message }.
       state: 'empty' (nothing committed), 'no-remote', 'unreachable', 'up-to-date',
       'ahead' (can be sent), 'diverged' (the remote has commits this has not). */
    async outgoing(name) {
        const r = this.#repository(name);
        const copy = await this.#copy(r);
        const here = (argv, env) => this.#git(['-C', copy, '-c', 'core.hooksPath=/dev/null', ...argv], { env });
        const remote = this.#remoteOf(r) ?? null;
        const named = await here(['symbolic-ref', '--short', 'HEAD']);
        const branch = named.stdout.trim();
        const tip = branch ? await here(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) : { code: 1, stdout: '' };
        if (!branch || tip.code !== 0) return { state: 'empty', branch: branch || null, head: null, remote, commits: [], stat: '', diff: '', cut: false, message: 'Nothing has been committed in this repository yet.' };
        if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.startsWith('-')) throw new Refusal(400, 'The name of the branch is not one that can be sent.');
        const head = tip.stdout.trim();
        const list = async (range) => (await here(['log', `--max-count=${COMMITS_MAX}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%s`, range])).stdout.split('\n').filter(Boolean)
            .map((line) => { const [id, author, date, ...subject] = line.split(SEP); return { id, author, date, subject: subject.join(SEP).slice(0, 300) }; });
        if (!remote) return { state: 'no-remote', branch, head, remote, commits: await list(branch), stat: '', diff: '', cut: false, message: 'No address is set to send these commits to.' };

        /* What the remote has of this branch, brought into the copy to compare with. */
        const far = `refs/remotes/origin/${branch}`;
        const fetched = await here(['fetch', '--quiet', '--no-tags', '--', remote, `+refs/heads/${branch}:${far}`], { ...this.#auth(r.name), ...(this.#local ? asEnv([['protocol.file.allow', 'always']]) : {}) });
        let base = far;
        if (fetched.code !== 0) {
            if (!/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) {
                return { state: 'unreachable', branch, head, remote, commits: [], stat: '', diff: '', cut: false, message: `The remote did not answer as expected: ${firstLine(fetched.stderr)}` };
            }
            /* The remote has no such branch yet: everything is new. Compared with nothing. */
            base = (await here(['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim();
        }
        const range = base === far ? `${far}..${branch}` : branch;
        const commits = await list(range);
        const behind = base === far ? Number((await here(['rev-list', '--count', `${branch}..${far}`])).stdout.trim()) : 0;
        const compare = ['--no-ext-diff', '--no-textconv', '--no-color', base, branch];
        const stat = (await here(['diff', '--stat=100', ...compare])).stdout;
        const whole = (await here(['diff', ...compare])).stdout;
        const state = commits.length === 0 ? 'up-to-date' : behind > 0 ? 'diverged' : 'ahead';
        const message = state === 'up-to-date' ? 'Everything committed here is already there.'
            : state === 'diverged' ? `The remote has ${behind} commit(s) that this repository does not have: the tool must bring them in first (pull), then this can be sent.`
                : `${commits.length} commit(s) would be sent to ${branch}.`;
        return { state, branch, head, remote, commits, stat, diff: whole.slice(0, DIFF_MAX), cut: whole.length > DIFF_MAX, message };
    }

    /* Sends exactly the commit that was shown: `head` is what the owner looked at. */
    async push(name, body) {
        const r = this.#repository(name);
        const now = await this.outgoing(r.name);
        if (now.state !== 'ahead') throw new Refusal(409, now.message);
        if (typeof body?.head !== 'string' || body.head !== now.head) throw new Refusal(409, 'The repository changed since you looked: look again at what would be sent.');
        const sent = await this.#git(['-C', `${this.#root}/${r.name}.git`, '-c', 'core.hooksPath=/dev/null', 'push', '--quiet', '--', now.remote, `${now.head}:refs/heads/${now.branch}`],
            { env: { ...this.#auth(r.name), ...(this.#local ? asEnv([['protocol.file.allow', 'always']]) : {}) } });
        if (sent.code !== 0) throw new Refusal(502, `The remote refused: ${firstLine(sent.stderr)}`);
        return { ok: true, branch: now.branch, head: now.head, commits: now.commits.length };
    }
}
