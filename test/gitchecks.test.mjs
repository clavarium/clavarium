/* The checks before sending, run "in the machine": here the machine is a
   stand-in that runs the command it is handed in a directory of this test
   (as the host program would run it in the VM), so the script itself, the
   hook and the command really run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitChecks, SCRIPT, FETCH_SCRIPT } from '../server/gitchecks.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8' }).trim();

function bench(t, { running = true, attached = { alpha: 'write' } } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-checks-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const machine = join(dir, 'machine');
    const work = join(machine, 'resources', 'site');
    mkdirSync(work, { recursive: true });
    git(work, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(work, 'a.txt'), 'a\n'); git(work, 'add', 'a.txt'); git(work, 'commit', '--quiet', '-m', 'one');
    const head = git(work, 'rev-parse', 'HEAD');
    const execs = [];
    const vms = {
        exec: (conversation, argv, { timeoutMs } = {}) => new Promise((resolve) => {
            execs.push({ conversation, argv, timeoutMs });
            /* A path of the machine, as a path here. */
            const mapped = argv.map((a) => (a.startsWith('/resources/') ? join(machine, a) : a));
            execFile(mapped[0], mapped.slice(1), { env: ENV, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
        }),
    };
    const conversations = { awake: () => Object.keys(attached), running: async () => running };
    const resources = { of: (name) => (attached[name] ? [{ name: 'site', access: attached[name] }] : []) };
    const checks = new GitChecks({ vms, conversations, resources });
    const ask = (more = {}) => checks.run('site', { head, branch: 'main', target: 'staging', remoteTip: null, remote: 'https://example.com/site.git', command: '', hook: true, seconds: 20, ...more });
    return { dir, work, head, execs, checks, ask };
}

test('the pre-push hook runs in the machine, fed what git feeds it, for the exact commit and branch to send', async (t) => {
    const b = bench(t);
    const seen = join(b.dir, 'seen');
    writeFileSync(join(b.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho "args: $1 $2" > ${seen}\ncat >> ${seen}\necho hook says fine\n`);
    chmodSync(join(b.work, '.git', 'hooks', 'pre-push'), 0o755);
    const r = await b.ask();
    assert.equal(r.status, 'passed', r.output);
    assert.equal(r.machine, 'alpha');
    assert.match(r.output, /hook says fine/);
    assert.equal(readFileSync(seen, 'utf8'), `args: origin https://example.com/site.git\nrefs/heads/main ${b.head} refs/heads/staging ${'0'.repeat(40)}\n`);
    /* It went through the machine, with a time limit, as arguments: nothing pasted into the script. */
    assert.deepEqual(b.execs[0].argv.slice(0, 6), ['timeout', '-k', '10', '20', 'sh', '-c']);
    assert.equal(b.execs[0].argv[6], SCRIPT);
    assert.equal(b.execs[0].argv[8], '/resources/site');
});

test('a failing hook or command fails the checks; the output comes back, bounded; nothing set is not a pass', async (t) => {
    const b = bench(t);
    let r = await b.ask({ command: 'echo checking; exit 3' });
    assert.equal(r.status, 'failed');
    assert.match(r.output, /checking/); assert.match(r.output, /exit 3/);
    r = await b.ask({ command: 'echo all good' });
    assert.equal(r.status, 'passed');
    r = await b.ask({ command: 'yes 0123456789 | head -c 100000; true' });
    assert.ok(r.output.length <= 8200, 'bounded');
    r = await b.ask();
    assert.equal(r.status, 'none', 'no hook, no command: nothing was checked');
    r = await b.ask({ hook: false, command: '' });
    assert.equal(r.status, 'none');
    assert.equal(b.execs.length, 4, 'nothing to run: the machine is not even asked');
    /* The hook fails: the command is not run after it. */
    writeFileSync(join(b.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho refused by hook\nexit 1\n');
    chmodSync(join(b.work, '.git', 'hooks', 'pre-push'), 0o755);
    r = await b.ask({ command: `touch ${join(b.dir, 'command-ran')}` });
    assert.equal(r.status, 'failed');
    assert.match(r.output, /refused by hook/);
    assert.equal(existsSync(join(b.dir, 'command-ran')), false);
});

test('the checks always run in a copy made at the commit to send, taken away after: never in the folder the tool works in', async (t) => {
    const b = bench(t);
    const seen = join(b.dir, 'seen');
    writeFileSync(join(b.work, 'b.txt'), 'b\n'); git(b.work, 'add', 'b.txt'); git(b.work, 'commit', '--quiet', '-m', 'two');
    /* The repository moved on: the commit to send is checked out nowhere. A working tree is made at it, the checks see exactly it, and it is taken away. */
    let r = await b.ask({ command: `git rev-parse HEAD > ${seen}; test ! -e b.txt` });
    assert.equal(r.status, 'passed', r.output);
    assert.equal(readFileSync(seen, 'utf8').trim(), b.head);
    assert.match(r.output, /a copy made at this commit/);
    assert.equal(git(b.work, 'worktree', 'list').split('\n').length, 1, 'the working tree made for the checks is gone');
    assert.equal(git(b.work, 'rev-parse', 'HEAD') === b.head, false, 'the repository itself was not moved');
    /* Even when the repository is at that commit, and has changes not committed: the copy is checked, not the folder. */
    git(b.work, 'reset', '--quiet', '--hard', b.head);
    writeFileSync(join(b.work, 'a.txt'), 'changed, not committed\n');
    r = await b.ask({ command: `pwd > ${seen}; grep -qx a a.txt` });
    assert.equal(r.status, 'passed', r.output);
    assert.notEqual(readFileSync(seen, 'utf8').trim(), b.work);
    assert.equal(readFileSync(join(b.work, 'a.txt'), 'utf8'), 'changed, not committed\n', 'the folder the tool works in is untouched');
    /* A commit that is not in the repository: failed, and said. */
    r = await b.ask({ head: 'f'.repeat(40), command: 'true' });
    assert.equal(r.status, 'failed');
    assert.match(r.output, /not in this repository/);
});

test('a time limit stops the checks', async (t) => {
    const b = bench(t);
    const r = await b.ask({ command: 'sleep 30', seconds: 1 });
    assert.equal(r.status, 'failed');
    assert.match(r.output, /Stopped after 1 seconds/);
});

test('no machine running with the repository attached: the checks cannot run, and say so', async (t) => {
    let r = await bench(t, { running: false }).ask({ command: 'true' });
    assert.equal(r.status, 'unavailable');
    assert.match(r.output, /No machine that has this repository attached is running/);
    r = await bench(t, { attached: {} }).ask({ command: 'true' });
    assert.equal(r.status, 'unavailable');
});

test('a machine that may write in the repository is chosen first', async (t) => {
    const b = bench(t, { attached: { reader: 'read', writer: 'write' } });
    assert.equal(await b.checks.machineFor('site'), 'writer');
});

test('automatic sending runs the checks in the machine of the conversation whose settings decided, or not at all', async (t) => {
    const b = bench(t, { attached: { reader: 'read', writer: 'write', other: 'write' } });
    assert.equal(await b.checks.runs('other', 'site'), true);
    assert.equal(await b.checks.runs('reader', 'site'), false, 'read-only: not a conversation that sends');
    assert.equal(await b.checks.runs('nobody', 'site'), false);
    const r = await b.ask({ command: 'true', machine: 'other' });
    assert.equal(r.status, 'passed');
    assert.equal(r.machine, 'other');
    assert.deepEqual(b.execs.map((e) => e.conversation), ['other'], 'not the first writer found: the one asked for');
    assert.equal((await b.ask({ command: 'true', machine: 'reader' })).status, 'unavailable');
    const asleep = bench(t, { running: false });
    assert.equal(await asleep.checks.runs('alpha', 'site'), false);
});

test('the local fetch in the machine: origin/* brought up to date from the reference, nothing of the agent changed, the branches it follows that moved said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-fetch-'));
    try {
        const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim();
        const origin = join(dir, 'site-origin'); mkdirSync(origin);
        g(origin, 'init', '-q', '-b', 'main'); writeFileSync(join(origin, 'a'), '1'); g(origin, 'add', 'a'); g(origin, 'commit', '-qm', 'one');
        const repo = join(dir, 'site');
        g(dir, 'clone', '-q', origin, repo);
        writeFileSync(join(repo, 'mine.txt'), 'not committed');
        const mainBefore = g(repo, 'rev-parse', 'main'); const old = g(repo, 'rev-parse', 'origin/main');
        writeFileSync(join(origin, 'a'), '2'); g(origin, 'commit', '-qam', 'two'); const tip = g(origin, 'rev-parse', 'HEAD');
        const run = () => { try { return { code: 0, out: execFileSync('sh', ['-c', FETCH_SCRIPT, 'clavarium-fetch', repo, origin], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout ?? '') }; } };
        const r = run();
        assert.equal(r.code, 0);
        assert.equal(r.out.trim(), `main origin/main ${old} ${tip}`);
        assert.equal(g(repo, 'rev-parse', 'origin/main'), tip, 'origin/main moved');
        assert.equal(g(repo, 'rev-parse', 'main'), mainBefore, 'its branch did not');
        assert.equal(readFileSync(join(repo, 'mine.txt'), 'utf8'), 'not committed', 'nor its files');
        assert.equal(run().out, '', 'nothing moved since: nothing said');
        /* Not a repository there yet (attached, not cloned): nothing done, said by its exit. */
        const none = spawnSync('sh', ['-c', FETCH_SCRIPT, 'clavarium-fetch', join(dir, 'nothing'), origin]);
        assert.equal(none.status, 90);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the checks are told they run in a copy at the commit sent, whatever branch the main folder is on', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-checkenv-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, 'repo');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' } }).trim();
    mkdirSync(repo);
    git('init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'f'), '1'); git('add', 'f'); git('commit', '-qm', 'one');
    const sent = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'elsewhere'); writeFileSync(join(repo, 'f'), '2'); git('commit', '-qam', 'two');
    const cmd = 'echo "head=$CLAVARIUM_CHECK_HEAD repo=$CLAVARIUM_CHECK_REPOSITORY"; [ "$(git rev-parse HEAD)" = "$CLAVARIUM_CHECK_HEAD" ] && [ "$PWD" = "$CLAVARIUM_CHECK_COPY" ] && echo same';
    const r = spawnSync('sh', ['-c', SCRIPT, 'clavarium-check', repo, sent, '', '', cmd, 'no'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, new RegExp(`head=${sent} repo=${repo}`));
    assert.match(r.stdout, /\nsame\n/);
});
