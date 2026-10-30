/* The review and Send, with a real git: an agent's repository read as the
   host program reads it (git-stand-in.mjs), the reference (the remote's
   history), a remote, and what goes between them. Design:
   blueprint/git-runner-core.md, sections 4 to 6. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitReview, branchProblem, COMMITS_MAX, DIFF_MAX } from '../server/gitpush.mjs';
import { GitRunner, GitFailure, runGit } from '../server/gitrunner.mjs';
import { Refusal } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { git, standInRead, committed, ENV } from './git-stand-in.mjs';

/* `wrap(git)`: a stand-in around the builder's git, to play a remote that
   accepts a push and then goes silent, or a refresh that fails. */
function bench(t, { wrap, reads } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-push-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'resources', 'site'); const remote = join(dir, 'remote.git');
    mkdirSync(work, { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    git(work, 'init', '--quiet', '--initial-branch=main');
    const folder = (name) => join(dir, 'resources', name);
    const resources = {
        get: (name) => (name === 'site' ? { name: 'site', type: 'git' } : name === 'notes' ? { name: 'notes', type: 'folder' } : undefined),
        folder, originPath: (name) => folder(`${name}-origin`), hasOrigin: (name) => existsSync(join(folder(`${name}-origin`), 'HEAD')),
        makeOrigin: async (name) => { mkdirSync(folder(`${name}-origin`), { recursive: true }); }, shareOrigin: async () => {},
    };
    const calls = [];
    const recorded = async (argv, options) => { calls.push({ argv, env: options.env ?? {} }); return wrap ? wrap(argv, options, runGit) : runGit(argv, options); };
    const make = () => new GitReview({ store: new Store(join(dir, 'git.json')), vault: new Vault(join(dir, 'vault.key')), resources, dataDir: join(dir, 'data'), localRemotes: true,
        runner: new GitRunner({ dataDir: join(dir, 'data'), reserveBytes: 0, spawnRead: standInRead(folder, { reads }), git: recorded }) });
    const review = make();
    const refreshes = [];
    review.listen({ refresh: (name, result) => refreshes.push(result) });
    const commit = (file, text, subject) => committed(work, file, text, subject);
    const reference = folder('site-origin');
    /* What the reference holds, to show that nothing of the agent's ever lands there. */
    const snapshot = () => (existsSync(reference) ? execFileSync('sh', ['-c', 'find . -type f | sort | xargs sha256sum'], { cwd: reference, encoding: 'utf8' }) : '');
    return { dir, work, remote, commit, review, make, calls, refreshes, reference, snapshot, workRoot: join(dir, 'data', 'git-work') };
}
const theirs = (b, branch, file) => {
    const other = join(b.dir, `other-${Math.random().toString(16).slice(2)}`);
    git(b.dir, 'clone', '--quiet', '--branch', branch, b.remote, other);
    return committed(other, file, `${file}\n`, `theirs ${file}`) && (git(other, 'push', '--quiet', 'origin', branch), git(other, 'rev-parse', 'HEAD'));
};

test('what would go out is shown -- commits, files, changes -- and exactly that is sent', async (t) => {
    const b = bench(t);
    assert.equal((await b.review.outgoing('site')).state, 'empty');
    const first = b.commit('README.md', '# site\n', 'Start the site');
    const local = await b.review.outgoing('site');
    assert.deepEqual([local.state, local.commits.map((c) => c.subject)], ['no-remote', ['Start the site']], 'no remote: the commits are still shown');
    await assert.rejects(b.review.push('site', { head: first }), /No address is set/);
    b.review.setRemote('site', { url: b.remote });
    const seen = await b.review.outgoing('site');
    assert.deepEqual([seen.state, seen.branch, seen.head, seen.count, seen.commits.map((c) => c.subject)], ['ahead', 'main', first, 1, ['Start the site']]);
    assert.match(seen.stat, /README\.md/);
    assert.match(seen.diff, /^\+# site$/m);
    assert.deepEqual([seen.commits[0].author, seen.commits[0].email, seen.commits[0].message], ['Tool', 'tool@example.com', 'Start the site']);
    /* The agent commits again after the owner looked: what was looked at is not what would go. */
    const second = b.commit('page.html', '<h1>hi</h1>\n', 'Add a page');
    await assert.rejects(b.review.push('site', { head: first }), (e) => e.kind === 'agent-moved' && /changed main since you looked/.test(e.message));
    assert.equal(git(b.remote, 'for-each-ref'), '', 'nothing was sent');
    const again = await b.review.outgoing('site');
    assert.equal(again.count, 2);
    assert.deepEqual(await b.review.push('site', { head: second }), { ok: true, branch: 'main', from: 'main', head: second, base: null, commits: 2, made: true, already: false });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), second, 'the remote has exactly that commit');
    assert.deepEqual(b.refreshes.at(-1).rewritten, [], 'the refresh after the push is a fast-forward: no rewrite alert');
    assert.equal((await b.review.outgoing('site')).state, 'up-to-date');
    /* A second Send of the same commit (a double click, a page reloaded): already there, not an error. */
    assert.equal((await b.review.push('site', { head: second })).already, true);
    /* A push the server never saw end (it was killed mid-push): after a restart, Send says "already on the remote". */
    const third = b.commit('c.txt', 'c\n', 'three');
    await b.review.outgoing('site');
    git(b.work, 'push', '--quiet', b.remote, 'main');
    const restarted = b.make();
    assert.equal((await restarted.push('site', { head: third })).already, true);
    /* Each workspace is gone after each use. */
    assert.deepEqual(readdirSync(b.workRoot), []);
});

test('a remote that moved on is said, nothing is forced over it, and the lease guards the moment in between', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    await b.review.push('site', { head: first });
    /* Somebody else pushes to the remote. */
    const other = theirs(b, 'main', 'b.txt');
    const mine = b.commit('c.txt', 'c\n', 'mine');
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'diverged');
    assert.match(seen.message, /has 1 commit\(s\) that this repository does not have/);
    await assert.rejects(b.review.push('site', { head: mine }), /look again/i, 'a diverged review is no review to send');
    /* Even handed straight to Send, a diverged commit is never pushed. */
    await assert.rejects(b.review.send('site', { branch: 'main', head: mine, target: 'main', remoteTip: other }), (e) => e.kind === 'diverged');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), other, 'the remote is untouched');
    /* The remote moves between the review and Send: 409, nothing forced. */
    git(b.work, 'pull', '--quiet', '--no-rebase', '--no-edit', b.remote, 'main');
    const merged = git(b.work, 'rev-parse', 'HEAD');
    assert.equal((await b.review.outgoing('site')).state, 'ahead');
    const later = theirs(b, 'main', 'd.txt');
    await assert.rejects(b.review.push('site', { head: merged }), (e) => e.kind === 'remote-moved' && e.ai === 'origin/main moved: pull origin/main first');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), later);
    /* The lease itself: on the tip that was shown, or "absent" for a new branch. */
    const pushes = b.calls.filter((c) => c.argv.includes('push'));
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].argv.includes('--force-with-lease=refs/heads/main:'), 'the first push made the branch: the lease said "absent"');
});

test('a lease refused by the remote is said as "moved", and nothing is forced', async (t) => {
    /* The remote moves in the instant between the refresh and the push. */
    let sneak;
    const b = bench(t, { wrap: async (argv, options, real) => { if (argv.includes('push') && sneak) { sneak(); sneak = undefined; } return real(argv, options); } });
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site'); await b.review.push('site', { head: first });
    const mine = b.commit('b.txt', 'b\n', 'two');
    await b.review.outgoing('site');
    let moved;
    sneak = () => { moved = theirs(b, 'main', 'x.txt'); };
    await assert.rejects(b.review.push('site', { head: mine }), (e) => e.kind === 'remote-moved' && /lease was refused/.test(e.message));
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), moved);
    const lease = b.calls.filter((c) => c.argv.includes('push')).at(-1).argv;
    assert.ok(lease.includes(`--force-with-lease=refs/heads/main:${first}`));
    assert.ok(lease.indexOf('--end-of-options') < lease.indexOf('refs/clavarium/send:refs/heads/main'));
});

test('a push whose end was not seen: the remote says what happened', async (t) => {
    let mode = ''; let pushed = false;
    const b = bench(t, {
        wrap: async (argv, options, real) => {
            if (argv.includes('push')) {
                const r = mode === 'lost-not-sent' ? { code: 0, stdout: Buffer.alloc(0), stderr: '' } : await real(argv, options);
                pushed = true;
                return mode.startsWith('lost') ? { ...r, code: null, signal: 'SIGKILL', killed: 'deadline', stdout: Buffer.alloc(0) } : r;
            }
            if (argv.includes('fetch') && pushed && mode.endsWith('down')) return { code: 128, signal: null, stdout: Buffer.alloc(0), stderr: 'fatal: unreachable', killed: null };
            return real(argv, options);
        },
    });
    b.review.setRemote('site', { url: b.remote });
    const step = async (file, how) => { const head = b.commit(file, `${file}\n`, file); await b.review.outgoing('site'); mode = how; pushed = false; try { return await b.review.push('site', { head }); } finally { mode = ''; } };
    /* The remote accepted it, then the push was killed: the refresh finds it there: sent. */
    const one = await step('a.txt', 'lost');
    assert.equal(one.ok, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one.head);
    /* The push worked, the refresh after it did not: sent, said so. */
    const two = await step('b.txt', 'after-down');
    assert.deepEqual([two.ok, two.note], [true, 'Sent; the reference was not refreshed.']);
    /* Killed, and the remote gone silent: unknown, never "sent". */
    await assert.rejects(step('c.txt', 'lost-down'), (e) => e.kind === 'unknown-unreachable' && e.alert === true);
    /* Killed before it reached the remote: the refresh says it is not there. */
    await assert.rejects(step('d.txt', 'lost-not-sent'), (e) => e.kind === 'unknown-not-sent' && /not on the remote/.test(e.message));
    assert.deepEqual(readdirSync(b.workRoot), []);
});

test('a refresh stopped by its time limit leaves no lock behind', async (t) => {
    let stall = false;
    const b = bench(t, { wrap: async (argv, options, real) => (argv.includes('fetch') && stall ? { code: null, signal: 'SIGKILL', killed: 'deadline', stdout: Buffer.alloc(0), stderr: '' } : real(argv, options)) });
    b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    assert.equal((await b.review.refresh('site')).ok, true);
    writeFileSync(join(b.reference, 'packed-refs.lock'), '');
    mkdirSync(join(b.reference, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(b.reference, 'refs', 'heads', 'main.lock'), '');
    stall = true;
    const r = await b.review.refresh('site');
    assert.equal(r.ok, false);
    assert.deepEqual(r.stale.sort(), ['packed-refs.lock', 'refs/heads/main.lock']);
    assert.equal(existsSync(join(b.reference, 'packed-refs.lock')), false);
});

test('the reference holds the remote\'s history only: a review, a check read and a refused send leave it as it was', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    await b.review.push('site', { head: first });
    const before = b.snapshot();
    assert.ok(before.length > 0);
    const mine = b.commit('secret.txt', 'agent data\n', 'two');
    await b.review.outgoing('site');
    await b.review.readTips('site');
    b.commit('more.txt', 'more\n', 'three');
    await assert.rejects(b.review.push('site', { head: mine }), (e) => e.kind === 'agent-moved');
    assert.equal(b.snapshot(), before, 'refs and objects identical');
    assert.notEqual(spawnSync('git', ['cat-file', '-e', `${mine}^{commit}`], { cwd: b.reference, env: ENV }).status, 0, 'the agent\'s commit never reached it');
    assert.deepEqual(readdirSync(b.workRoot), []);
});

test('the review shows what the diff alone could hide, escaped, and asks twice when it cannot show it all', async (t) => {
    const b = bench(t);
    b.review.setRemote('site', { url: b.remote });
    const base = b.commit('a.txt', 'a\n', 'one');
    await b.review.outgoing('site'); await b.review.push('site', { head: base });
    /* A file added then deleted: no trace in the diff. A big blob. A message with control characters. */
    b.commit('hidden.bin', 'x'.repeat(50_000), 'add');
    git(b.work, 'rm', '--quiet', 'hidden.bin'); git(b.work, 'commit', '--quiet', '-m', 'Quiet \u001b[2Jfix‮ txt.exe\n\nlong body line');
    const seen = await b.review.outgoing('site');
    assert.deepEqual(seen.guards.unchanged, ['hidden.bin']);
    assert.equal(seen.guards.largest[0].path, 'hidden.bin');
    assert.equal(seen.guards.largest[0].size, 50_000);
    assert.ok(seen.guards.newBytes > 0);
    assert.equal(seen.diff, '', 'the diff shows nothing');
    assert.equal(seen.commits[0].subject, 'Quiet \\u{1b}[2Jfix\\u{202e} txt.exe');
    assert.match(seen.commits[0].message, /long body line/);
    assert.equal(seen.guards.confirm, false);
    /* More commits than a page lists: the true count, and a second confirmation. */
    for (let i = 0; i <= COMMITS_MAX; i++) git(b.work, 'commit', '--quiet', '--allow-empty', '-m', `c${i}`);
    const many = await b.review.outgoing('site');
    assert.equal(many.count, COMMITS_MAX + 3);
    assert.equal(many.commits.length, COMMITS_MAX);
    assert.equal(many.guards.confirm, true);
    await assert.rejects(b.review.push('site', { head: many.head }), (e) => e.kind === 'confirm');
    assert.equal((await b.review.push('site', { head: many.head, sure: true })).commits, COMMITS_MAX + 3);
    /* Attributes cannot hide a change: no textconv, no "-diff", read as text. */
    writeFileSync(join(b.work, '.gitattributes'), '* -diff\n*.txt diff=hide\n');
    git(b.work, 'config', 'diff.hide.textconv', 'true');
    b.commit('.gitattributes', '* -diff\n*.txt diff=hide\n', 'attributes');
    b.commit('note.txt', 'visible change\n', 'note');
    assert.match((await b.review.outgoing('site')).diff, /^\+visible change$/m);
    /* A diff cut short asks twice too. */
    b.commit('huge.txt', 'y\n'.repeat(DIFF_MAX), 'huge');
    const cut = await b.review.outgoing('site');
    assert.equal(cut.cut, true); assert.equal(cut.diff.length <= DIFF_MAX, true); assert.equal(cut.guards.confirm, true);
});

test('the agent\'s branches: the last one moved by default, another on request, names it cannot use are listed', async (t) => {
    let clock = new Date('2026-03-02T10:00:00Z');
    const b = bench(t);
    const review = new GitReview({ store: new Store(join(b.dir, 'git2.json')), vault: new Vault(join(b.dir, 'vault.key')), resources: { get: () => ({ name: 'site', type: 'git' }), folder: (n) => join(b.dir, 'resources', n), originPath: (n) => join(b.dir, 'resources', `${n}-origin`), hasOrigin: () => false, makeOrigin: async () => {}, shareOrigin: async () => {} },
        dataDir: join(b.dir, 'data2'), runner: new GitRunner({ dataDir: join(b.dir, 'data2'), reserveBytes: 0, spawnRead: standInRead((n) => join(b.dir, 'resources', n)) }), now: () => clock });
    b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'checkout', '--quiet', '-b', 'feature');
    const f1 = b.commit('f.txt', 'f\n', 'feature work');
    let seen = await review.outgoing('site');
    assert.deepEqual(seen.agentBranches.map((x) => x.name).sort(), ['feature', 'main']);
    clock = new Date('2026-03-02T10:05:00Z');
    git(b.work, 'checkout', '--quiet', 'main');
    const m2 = b.commit('m.txt', 'm\n', 'main work');
    seen = await review.outgoing('site');
    assert.deepEqual([seen.branch, seen.head], ['main', m2], 'the branch that moved last');
    const picked = await review.outgoing('site', { branch: 'feature' });
    assert.deepEqual([picked.branch, picked.head, picked.target], ['feature', f1, 'feature']);
    await assert.rejects(review.outgoing('site', { branch: 'nope' }), /no branch nope/);
    /* A name that looks like an id, or an option: not taken, said. */
    writeFileSync(join(b.work, '.git', 'refs', 'heads', 'a'.repeat(40)), `${m2}\n`);
    const odd = await review.outgoing('site');
    assert.deepEqual(odd.dropped.map((d) => d.name), ['a'.repeat(40)]);
    assert.equal(odd.agentBranches.some((x) => x.name === 'a'.repeat(40)), false);
});

test('a repository rigged by its agent runs nothing here: no hook, no filter, no program named in its settings', async (t) => {
    const b = bench(t);
    const proof = join(b.dir, 'ran');
    const trap = join(b.dir, 'trap.sh');
    writeFileSync(trap, `#!/bin/sh\ntouch ${proof}\nexit 0\n`); chmodSync(trap, 0o755);
    b.commit('a.txt', 'a\n', 'one');
    for (const hook of ['pre-push', 'post-checkout', 'pre-commit', 'reference-transaction', 'post-update', 'pre-receive', 'update']) { writeFileSync(join(b.work, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${proof}\n`); chmodSync(join(b.work, '.git', 'hooks', hook), 0o755); }
    const included = join(b.dir, 'included');
    writeFileSync(included, `[core]\n\tfsmonitor = ${trap}\n`);
    for (const [key, value] of [['core.fsmonitor', trap], ['core.pager', trap], ['core.sshCommand', trap], ['core.editor', trap], ['uploadpack.packObjectsHook', trap], ['diff.external', trap], ['core.hooksPath', join(b.work, '.git', 'hooks')], ['filter.x.clean', trap], ['filter.x.smudge', trap], ['diff.x.textconv', trap], ['core.alternateRefsCommand', trap], ['credential.helper', `!${trap}`], ['url./nowhere/.insteadOf', b.remote], ['include.path', included], ['pager.bundle', trap], ['alias.bundle', `!${trap}`]]) git(b.work, 'config', key, value);
    writeFileSync(join(b.work, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(b.work, 'b.txt'), 'b\n');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.x.clean=cat', '-c', 'include.path=/dev/null', 'add', '.gitattributes', 'b.txt'], { cwd: b.work, env: ENV });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'commit', '--quiet', '-m', 'rigged'], { cwd: b.work, env: ENV });
    const head = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { cwd: b.work, env: ENV, encoding: 'utf8' }).trim();
    rmSync(proof, { force: true });
    b.review.setRemote('site', { url: b.remote });
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'ahead');
    assert.match(seen.diff, /^\+b$/m);
    await b.review.push('site', { head });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), head);
    assert.equal(existsSync(proof), false, 'nothing of the agent\'s was run');
});

test('a .git that is not a plain directory is not read: gitfile, link, commondir', async (t) => {
    const b = bench(t);
    const elsewhere = join(b.dir, 'elsewhere');
    git(b.dir, 'init', '--quiet', '--initial-branch=main', elsewhere);
    committed(elsewhere, 'secret.txt', 'not the agent\'s\n', 'secret');
    b.review.setRemote('site', { url: b.remote });
    const tryIt = async (setup) => {
        rmSync(join(b.work, '.git'), { recursive: true, force: true });
        setup();
        await assert.rejects(b.review.outgoing('site'), (e) => e instanceof GitFailure && e.kind === 'git' && /NOT A PLAIN \.git DIRECTORY/.test(e.message));
    };
    await tryIt(() => writeFileSync(join(b.work, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`));
    await tryIt(() => symlinkSync(join(elsewhere, '.git'), join(b.work, '.git')));
    await tryIt(() => { git(b.work, 'init', '--quiet'); writeFileSync(join(b.work, '.git', 'commondir'), join(elsewhere, '.git')); });
    /* Alternates: the bundle must be complete on its own; objects borrowed from elsewhere are refused in the empty workspace. */
    rmSync(join(b.work, '.git'), { recursive: true, force: true });
    git(b.work, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(b.work, '.git', 'objects', 'info', 'alternates'), `${join(elsewhere, '.git', 'objects')}\n`);
    git(b.work, 'update-ref', 'refs/heads/main', git(elsewhere, 'rev-parse', 'HEAD'));
    const got = await b.review.outgoing('site');
    /* git bundles what it can reach, alternates included: the content is then the agent's own to send, nothing more is reachable. */
    assert.ok(['ahead', 'up-to-date'].includes(got.state));
    assert.equal(git(b.remote, 'for-each-ref'), '');
});

test('unreadable refs are said, never taken for deleted branches', async (t) => {
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'checkout', '--quiet', '-b', 'feat/x');
    b.commit('b.txt', 'b\n', 'two');
    const known = await b.review.readTips('site');
    assert.deepEqual(Object.keys(known).sort(), ['feat/x', 'main']);
    chmodSync(join(b.work, '.git', 'refs', 'heads', 'feat'), 0o000);
    try {
        await assert.rejects(b.review.outgoing('site'), (e) => e.kind === 'unreadable' && /chmod -R o\+rX \.git/.test(e.ai));
        assert.deepEqual(b.review.tips('site'), known, 'nothing taken for deleted: the tips seen before are kept');
    } finally { chmodSync(join(b.work, '.git', 'refs', 'heads', 'feat'), 0o755); }
});

test('the key is sealed and never said back; only a git repository has a push, and only to an https or ssh address', async (t) => {
    const b = bench(t);
    b.review.setRemote('site', { url: b.remote, user: 'me', key: 'very-secret-token' });
    assert.deepEqual(b.review.settings('site'), { remote: b.remote, user: 'me', hasKey: true, sshKey: null });
    assert.equal(readFileSync(join(b.dir, 'git.json'), 'utf8').includes('very-secret-token'), false);
    b.review.setRemote('site', { url: b.remote });
    assert.equal(b.review.settings('site').hasKey, true, 'an empty key keeps the one there is');
    await assert.rejects(b.review.outgoing('notes'), /No such repository/);
    assert.throws(() => b.review.setRemote('nope', { url: b.remote }), /No such repository/);
    assert.equal(b.review.setRemote('site', { url: 'ssh://git@example.com/x.git' }).remote, 'ssh://git@example.com/x.git');
    assert.throws(() => b.review.setRemote('site', { url: 'file:///etc' }), /repository address is https/);
    assert.throws(() => b.review.setRemote('site', { url: 'http://example.com/x.git' }), /repository address is https/);
    b.review.setRemote('site', { url: b.remote });
    assert.throws(() => b.review.setRemote('site', { url: b.remote, key: 'two\nlines' }), /one line/);
    assert.throws(() => b.review.setRemote('site', { url: b.remote, user: 'a:b' }), /no space and no colon/);
    const strict = new GitReview({ store: new Store(join(b.dir, 'g2.json')), vault: new Vault(join(b.dir, 'vault.key')), resources: { get: () => ({ name: 'site', type: 'git' }), folder: () => b.work }, dataDir: join(b.dir, 'd3'), runner: new GitRunner({ dataDir: join(b.dir, 'd3') }) });
    assert.throws(() => strict.setRemote('site', { url: b.remote }), /repository address is https/);
});

test('the branch to send to: the remote\'s branches are listed, the same name is the default, another or a new one can be chosen -- and what goes is exactly what was shown', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    await b.review.push('site', { head: first });
    git(b.remote, 'branch', 'staging', first);
    const mine = b.commit('b.txt', 'b\n', 'two');
    const seen = await b.review.outgoing('site');
    assert.deepEqual([seen.target, seen.branches, seen.targetExists, seen.remoteTip], ['main', ['main', 'staging'], true, first]);
    const staging = await b.review.outgoing('site', { target: 'staging' });
    assert.deepEqual([staging.state, staging.target, staging.commits.map((c) => c.subject)], ['ahead', 'staging', ['two']]);
    assert.match(staging.message, /1 commit\(s\) would be sent to staging/);
    const { base: was, ...pushed } = await b.review.push('site', { head: mine, target: 'staging' });
    assert.deepEqual(pushed, { ok: true, branch: 'staging', from: 'main', head: mine, commits: 1, made: false, already: false });
    assert.match(was, /^[0-9a-f]{40}$/, 'the tip the branch had before, for "See the commits"');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/staging'), mine);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first, 'only the branch that was shown');
    const third = b.commit('c.txt', 'c\n', 'three');
    const fresh = await b.review.outgoing('site', { target: 'try/new-idea' });
    assert.deepEqual([fresh.state, fresh.targetExists, fresh.commits.map((c) => c.subject)], ['ahead', false, ['three']]);
    assert.match(fresh.message, /would be sent to try\/new-idea, a new branch/);
    assert.match(fresh.stat, /b\.txt/); assert.match(fresh.stat, /c\.txt/);
    assert.doesNotMatch(fresh.stat, /a\.txt/);
    await assert.rejects(b.review.push('site', { head: third, target: 'staging..x' }), /no "\.\."/);
    await assert.rejects(b.review.push('site', { head: third, target: '-f' }), /does not start with "-"/);
    await assert.rejects(b.review.push('site', { head: third, target: 'main' }), /look again/i, 'reviewed for one branch is not reviewed for another');
    assert.equal((await b.review.push('site', { head: third, target: 'try/new-idea' })).made, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/new-idea'), third);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first);
    assert.equal((await b.review.outgoing('site', { target: 'try/new-idea' })).state, 'up-to-date');
    await assert.rejects(b.review.outgoing('site', { target: 'a b' }), /letters, digits/);
});

test('every git of a review and a send: --end-of-options before what the agent or the owner chose, no credential on a command line', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'checkout', '--quiet', '-b', 'try/x');
    b.commit('b.txt', 'b\n', 'two');
    b.review.setRemote('site', { url: b.remote, user: 'me', key: 'very-secret-token' });
    const seen = await b.review.outgoing('site', { target: 'release/next' });
    await b.review.push('site', { head: seen.head, target: 'release/next' });
    assert.ok(first);
    const chosen = ['try/x', 'release/next', seen.head, b.remote];
    for (const { argv, env } of b.calls) {
        const end = argv.indexOf('--end-of-options');
        argv.forEach((arg, i) => {
            if (chosen.some((v) => arg.includes(v)) && !arg.startsWith('--force-with-lease=') && !arg.startsWith('--max-input-size=')) {
                assert.ok(end >= 0 && end < i, `${argv.join(' ')}: ${arg} before --end-of-options`);
            }
        });
        assert.equal(JSON.stringify(argv).includes('very-secret-token'), false);
        assert.equal(Object.keys(env).some((k) => k.startsWith('GIT_') && !['GIT_DIR', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_CONFIG_COUNT'].includes(k) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)), false, Object.keys(env).join(','));
    }
});

test('branch names follow the rules of git check-ref-format, and ours: no leading "-", bounded, no part like an object id', () => {
    const names = ['main', 'try/one', 'release-1.2', 'a.b/c_d', 'feature/x.y', '-x', 'a..b', 'a/', '/a', 'a//b', 'a.lock', 'a/.b', '.a', 'a.', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', '@', 'HEAD', 'x'.repeat(201), '', 'f'.repeat(40), `x/${'0'.repeat(64)}`];
    for (const name of names) {
        const ours = branchProblem(name) === '';
        let gits = false;
        try { execFileSync('git', ['check-ref-format', `refs/heads/${name}`], { stdio: 'ignore' }); gits = true; } catch { gits = false; }
        if (ours) assert.equal(gits, true, `${name} is accepted here but not by git`);
        if (gits && !ours) assert.ok(name.startsWith('-') || name.length > 200 || name === 'HEAD' || /[^A-Za-z0-9._/-]/.test(name) || name.split('/').some((p) => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(p)), `${name} is refused here for no reason`);
    }
    assert.equal(branchProblem('try/one'), '');
});

test('a refresh that cannot even start git (its key gone, a vault that does not open) is a failed refresh, said; a send then fails as "unreachable"', async (t) => {
    let broken = false;
    const b = bench(t, { wrap: async (argv, options, real) => { if (broken && argv.includes('fetch')) throw new Refusal(409, 'The key of this repository could not be opened.'); return real(argv, options); } });
    const head = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    broken = true;
    const r = await b.review.refresh('site');
    assert.deepEqual([r.ok, r.message], [false, 'The key of this repository could not be opened.']);
    assert.equal(b.refreshes.at(-1), r, 'the listener heard it: recorded, counted, alerted after three');
    await assert.rejects(b.review.push('site', { head }), (e) => e instanceof GitFailure && e.kind === 'unreachable' && /could not be opened/.test(e.message));
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)'), '', 'nothing sent');
});

test('a push that fails with no word about our ref (a connection dropped) is an unknown outcome: the remote says', async (t) => {
    let mode = '';
    const b = bench(t, {
        wrap: async (argv, options, real) => {
            if (!argv.includes('push') || !mode) return real(argv, options);
            const r = mode === 'landed' ? await real(argv, options) : null;
            return { ...(r ?? { signal: null, killed: null }), code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: the remote end hung up unexpectedly\n' };
        },
    });
    b.review.setRemote('site', { url: b.remote });
    const step = async (file, how) => { const head = b.commit(file, `${file}\n`, file); await b.review.outgoing('site'); mode = how; try { return await b.review.push('site', { head }); } finally { mode = ''; } };
    /* It had landed: sent, never "the remote refused". */
    const one = await step('a.txt', 'landed');
    assert.equal(one.ok, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one.head);
    /* It had not: said as not on the remote. */
    await assert.rejects(step('b.txt', 'lost'), (e) => e.kind === 'unknown-not-sent');
});

test('the remote\'s tip of a branch is that exact ref, never one git guesses from the name; a branch merged and deleted there is not made again', async (t) => {
    const b = bench(t);
    const one = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site'); await b.review.push('site', { head: one });
    /* A remote branch literally named "refs/heads/feat": rev-parse refs/heads/feat would find it. */
    git(b.remote, 'update-ref', 'refs/heads/refs/heads/feat', one);
    await b.review.refresh('site');
    assert.equal(await b.review.remoteTip('site', 'feat'), null);
    assert.equal(await b.review.remoteTip('site', 'main'), one);
    /* feat merged into main on the remote, then deleted: its commits are on main. */
    git(b.work, 'checkout', '--quiet', '-b', 'feat');
    const feat = b.commit('f.txt', 'f\n', 'feature');
    git(b.work, 'push', '--quiet', b.remote, 'feat:main');
    git(b.remote, 'update-ref', '-d', 'refs/heads/refs/heads/feat');
    await b.review.refresh('site');
    assert.equal(await b.review.remoteLacks('site', 'feat', feat), false, 'already on the remote, on main');
    assert.equal(await b.review.remoteLacks('site', 'feat', b.commit('g.txt', 'g\n', 'more')), true, 'a new commit is still something to send');
});

test('an automatic sending makes a branch on the remote only when allowed, asked on the tip just fetched; the remote\'s default branch is learnt', async (t) => {
    const b = bench(t);
    const one = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site'); await b.review.push('site', { head: one });
    assert.equal(b.review.defaultBranch('site'), 'main', 'learnt at the refresh of the send');
    git(b.work, 'checkout', '--quiet', '-b', 'try/new');
    const two = b.commit('b.txt', 'b\n', 'two');
    await assert.rejects(b.review.send('site', { branch: 'try/new', head: two, target: 'try/new', remoteTip: null, auto: true, allow: () => true }), (e) => e.kind === 'no-branch' && /does not exist on the remote/.test(e.message));
    assert.throws(() => git(b.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/try/new'));
    const sent = await b.review.send('site', { branch: 'try/new', head: two, target: 'try/new', remoteTip: null, auto: true, create: true, allow: () => true });
    assert.equal(sent.made, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/new'), two);
    /* Asked once a day, not at every refresh: it rarely changes, and each question goes to the remote. */
    const asked = () => b.calls.filter((c) => c.argv.includes('ls-remote')).length;
    const before = asked();
    await b.review.refresh('site');
    assert.equal(asked(), before);
});

test('an automatic sending is decided again under the lock, after its refresh: no `allow`, or one that says no with the fresh default branch, sends nothing', async (t) => {
    const b = bench(t);
    const one = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site'); await b.review.push('site', { head: one });
    git(b.work, 'checkout', '--quiet', '-b', 'try/new');
    const two = b.commit('b.txt', 'b\n', 'two');
    const ask = { branch: 'try/new', head: two, target: 'try/new', remoteTip: null, auto: true, create: true };
    await assert.rejects(b.review.send('site', ask), (e) => e.kind === 'not-allowed', 'no decision given: nothing goes by itself');
    const seen = [];
    await assert.rejects(b.review.send('site', { ...ask, allow: (d) => { seen.push(d); return false; } }), (e) => e.kind === 'not-allowed');
    assert.deepEqual(seen, ['main'], 'asked with the default branch the send\'s own refresh knows');
    assert.throws(() => git(b.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/try/new'));
});

test('the branch diagram: the agent\'s branches and the remote\'s, their last commits; each commit opens as a review', async (t) => {
    const b = bench(t);
    assert.deepEqual(await b.review.graph('site'), { branches: [], commits: [] }, 'nothing committed: nothing drawn');
    const first = b.commit('README.md', '# site\n', 'Start the site');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    await b.review.push('site', { head: first });
    git(b.work, 'checkout', '--quiet', '-b', 'dev');
    const second = b.commit('page.html', '<h1>hi</h1>\n', 'Add a <b>page</b>');
    const drawn = await b.review.graph('site');
    assert.deepEqual(drawn.branches.map((x) => `${x.side}:${x.name}`).sort(), ['agent:dev', 'agent:main', 'remote:main']);
    assert.deepEqual(drawn.commits.map((c) => c.subject), ['Add a <b>page</b>', 'Start the site'], 'newest first; the subject is text, the page escapes it');
    assert.deepEqual(drawn.commits[0].parents, [first]);
    assert.deepEqual(drawn.commits.map((c) => c.author), ['Tool', 'Tool'], 'each commit says who committed it');
    assert.deepEqual(drawn.commits[0].refs, [{ name: 'dev', side: 'agent' }]);
    assert.deepEqual(drawn.commits[1].refs.map((r) => r.side).sort(), ['agent', 'remote']);
    const one = await b.review.commit('site', second);
    assert.deepEqual([one.state, one.count, one.commits.map((c) => c.id), one.parents], ['commit', 1, [second], [first]]);
    assert.match(one.diff, /^\+<h1>hi<\/h1>$/m);
    assert.doesNotMatch(one.diff, /README/, 'against its parent only');
    assert.match((await b.review.commit('site', first)).diff, /^\+# site$/m, 'the first commit, against nothing');
    await assert.rejects(b.review.commit('site', 'HEAD'), /7 to 40 hexadecimal/);
    /* Named as a line of the chat names it (its first seven characters), and from one commit to another. */
    assert.deepEqual((await b.review.commit('site', second.slice(0, 7))).commits.map((c) => c.id), [second]);
    const range = await b.review.commit('site', second, first.slice(0, 7));
    assert.deepEqual([range.count, range.commits.map((c) => c.id), range.base], [1, [second], first]);
    await assert.rejects(b.review.commit('site', second, 'zz'), /7 to 40 hexadecimal/);
    await assert.rejects(b.review.commit('site', 'f'.repeat(40)), /not in the repository/);
    assert.deepEqual(readdirSync(b.workRoot), [], 'each workspace is gone');
});

test('refused by a hook of the remote: its verdict and what the hook said reach the owner and the agent, cleaned', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site'); await b.review.push('site', { head: first });
    writeFileSync(join(b.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "\\033[31mGH006: Protected branch update failed\\033[0m" >&2\necho "- Commit messages must name a ticket (ABC-123)." >&2\nexit 1\n');
    chmodSync(join(b.remote, 'hooks', 'pre-receive'), 0o755);
    const mine = b.commit('b.txt', 'b\n', 'two');
    await b.review.outgoing('site');
    await assert.rejects(b.review.push('site', { head: mine }), (e) => {
        assert.equal(e.kind, 'refused');
        assert.match(e.message, /^The remote refused: \[remote rejected\].*pre-receive hook declined/);
        assert.match(e.message, /; it said: "GH006: Protected branch update failed \/ - Commit messages must name a ticket \(ABC-123\)\."$/, 'one line: the chat and the page show it as it is');
        assert.equal(e.detail, 'GH006: Protected branch update failed\n- Commit messages must name a ticket (ABC-123).');
        assert.doesNotMatch(e.message, /\x1b|failed to push some refs/);
        assert.match(e.ai, /^the remote refused the sending to main: .*pre-receive hook declined.*; it said: "GH006: Protected branch update failed \/ - Commit messages must name a ticket \(ABC-123\)\."$/);
        assert.doesNotMatch(e.ai, /\n/);
        return true;
    });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first);
});

test('what the remote said: remote lines only, no colours, no progress, bounded', async () => {
    const { remoteSaid, REMOTE_LINES } = await import('../server/gitaccess.mjs');
    assert.equal(remoteSaid('To x\nremote: Resolving deltas: 100%\nremote: \x1b[1mNo\x1b[0m\x07 way\r\nerror: failed to push some refs'), 'No way');
    assert.equal(remoteSaid('error: nothing from the remote'), '');
    const many = Array.from({ length: 50 }, (_, i) => `remote: line ${i}`).join('\n');
    assert.equal(remoteSaid(many).split('\n').filter((l) => !/left out/.test(l)).length, REMOTE_LINES);
    assert.match(remoteSaid(many), /^\[30 lines left out\]\nline 30\n/);
    /* A talkative hook: what says it is wrong is kept, wherever it stood. */
    const chatty = [...Array.from({ length: 40 }, (_, i) => `remote: checking file ${i}`), 'remote: ERROR: secrets found in config.yml', ...Array.from({ length: 200 }, (_, i) => `remote: scanned ${i}`)].join('\n');
    const kept = remoteSaid(chatty);
    assert.match(kept, /^\[40 lines left out\]\nERROR: secrets found in config\.yml\n\[\d+ lines left out\]\nscanned \d+/);
    assert.match(kept, /scanned 199$/);
    assert.match(remoteSaid(many), /line 49$/);
    assert.ok(remoteSaid(`remote: ${'x'.repeat(5000)}`).length <= 1501);
});
