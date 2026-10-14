/* What happens to a repository when nobody looks: its origin kept up to date
   in a mirror the tool can fetch from, and automatic sending -- only to the
   branches the owner listed, after a quiet delay, after passing checks. With
   a real git; the machine and the clock are stand-ins. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, renameSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitReview } from '../server/gitpush.mjs';
import { GitKeeper, DEFAULTS, allowed, patternProblem } from '../server/gitkeeper.mjs';
import { Resources, originFolder } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Vms } from '../server/vm.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function bench(t, { checks = 'passed' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-keep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    /* The origin, as a hosting service would hold it, with a main branch. */
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const seed = join(dir, 'seed');
    git(dir, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), '# site\n'); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    const vm = []; const host = [];
    const resources = new Resources({
        store: new Store(join(dir, 'resources.json')),
        vms: new Vms(async (argv) => { vm.push(argv.slice(1).join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['vmm']),
        host: async (argv) => {
            host.push(argv.join(' '));
            if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(dir, 'resources', argv[2]), { recursive: true });
            if (argv[0] === 'folder' && argv[1] === 'aside') { mkdirSync(join(dir, 'removed'), { recursive: true }); renameSync(join(dir, 'resources', argv[2]), join(dir, 'removed', argv[2])); }
            return { code: 0, stdout: '', stderr: '' };
        },
        dataDir: dir, uid: 1001, gid: 1002,
    });
    /* The tool's repository: an empty one, then its origin set (a directory, as the tests allow). */
    await resources.create({ name: 'site', type: 'git' });
    const work = join(dir, 'resources', 'site');
    const review = new GitReview({ store: new Store(join(dir, 'git.json')), vault: new Vault(join(dir, 'vault.key')), resources, dataDir: dir, localRemotes: true });
    review.setRemote('site', { url: remote });
    git(work, 'fetch', '--quiet', remote, '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'reset', '--quiet', '--hard', 'origin/main');
    let clock = new Date('2026-03-02T10:00:00Z');
    const ran = []; const told = [];
    const fakeChecks = { run: async (name, asked) => { ran.push(asked); return { status: typeof checks === 'function' ? checks() : checks, output: 'stand-in', head: asked.head, target: asked.target, machine: 'alpha', at: clock.toISOString() }; } };
    const keeper = new GitKeeper({ store: new Store(join(dir, 'git-keep.json')), review, resources, checks: fakeChecks, alerts: { tell: async (m) => { told.push(m); return 1; } }, now: () => clock });
    const commit = (file, text, subject) => { writeFileSync(join(work, file), text); git(work, 'add', file); git(work, 'commit', '--quiet', '-m', subject); return git(work, 'rev-parse', 'HEAD'); };
    const later = (minutes) => { clock = new Date(clock.getTime() + minutes * 60_000); };
    return { dir, remote, seed, work, vm, host, resources, review, keeper, commit, later, ran, told };
}

test('the origin is kept in a mirror only the server writes, shown read-only next to the repository, and the tool fetches from it with no key', async (t) => {
    const b = await bench(t);
    await b.resources.attach('alpha', 'site', 'write');
    b.vm.length = 0;
    /* Somebody pushes a branch to the origin. */
    git(b.seed, 'checkout', '--quiet', '-b', 'feature'); writeFileSync(join(b.seed, 'f.txt'), 'f\n'); git(b.seed, 'add', 'f.txt'); git(b.seed, 'commit', '--quiet', '-m', 'Feature'); git(b.seed, 'push', '--quiet', 'origin', 'feature');
    const theirs = git(b.seed, 'rev-parse', 'HEAD');
    const about = await b.keeper.refresh('site');
    assert.equal(about.origin.ok, true, about.origin.message);
    assert.equal(about.origin.path, '/resources/site-origin');
    const mirror = join(b.dir, 'resources', 'site-origin');
    assert.equal(git(mirror, 'rev-parse', 'refs/heads/feature'), theirs, 'the mirror has the origin\'s branches');
    assert.ok(b.host.includes('folder make site-origin'), 'its folder is made by the host program, like any folder');
    /* Shown in the machine through its read-only view, never as a writable folder. */
    assert.ok(b.host.includes('view make site-origin'));
    assert.deepEqual(b.vm, ['mount clv-alpha view site-origin 1001 1002']);
    /* What the tool runs in its own machine: a plain fetch from a path, no key, no network. */
    git(b.work, 'fetch', '--quiet', mirror, '+refs/heads/*:refs/remotes/origin/*');
    assert.equal(git(b.work, 'rev-parse', 'refs/remotes/origin/feature'), theirs);
    /* A conversation attached later gets it at once; detached, it goes. */
    b.vm.length = 0;
    await b.resources.attach('beta', 'site', 'read');
    assert.deepEqual(b.vm, ['mount clv-beta view site 1001 1002', 'mount clv-beta view site-origin 1001 1002']);
    b.vm.length = 0;
    await b.resources.attach('beta', 'site', 'none');
    assert.deepEqual(b.vm, ['umount clv-beta site', 'umount clv-beta site-origin']);
    /* A rebuilt machine gets it back. */
    b.vm.length = 0;
    assert.deepEqual(await b.resources.remount('alpha'), []);
    assert.deepEqual(b.vm, ['mount clv-alpha folder site 1001 1002', 'mount clv-alpha view site-origin 1001 1002']);
    /* The mirror is not a resource: it cannot be attached on its own, and its name is kept. */
    await assert.rejects(b.resources.attach('alpha', 'site-origin', 'write'), /No such resource/);
    await assert.rejects(b.resources.create({ name: 'site-origin' }), /kept for the origin/);
    /* Removed with its repository: put aside, not erased. */
    await b.resources.attach('alpha', 'site', 'none');
    b.host.length = 0;
    await b.resources.remove('site');
    assert.deepEqual(b.host, ['view close site', 'folder aside site', 'view close site-origin', 'folder aside site-origin']);
    assert.ok(existsSync(join(b.dir, 'removed', 'site-origin', 'HEAD')));
});

test('refreshing runs nothing of the tool: git is run in the mirror and the copy, never in the tool\'s repository', async (t) => {
    const b = await bench(t);
    const proof = join(b.dir, 'ran');
    const trap = join(b.dir, 'trap.sh');
    writeFileSync(trap, `#!/bin/sh\ntouch ${proof}\nexit 0\n`); chmodSync(trap, 0o755);
    for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'post-update', 'pre-receive', 'update', 'post-merge']) { writeFileSync(join(b.work, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${proof}\n`); chmodSync(join(b.work, '.git', 'hooks', hook), 0o755); }
    for (const [key, value] of [['core.fsmonitor', trap], ['core.pager', trap], ['core.sshCommand', trap], ['uploadpack.packObjectsHook', trap], ['core.hooksPath', join(b.work, '.git', 'hooks')]]) git(b.work, 'config', key, value);
    b.keeper.set('site', { autoBranches: 'main', quietMinutes: 0 });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'commit', '--quiet', '--allow-empty', '-m', 'rigged'], { cwd: b.work, env: ENV });
    rmSync(proof, { force: true });
    await b.keeper.refresh('site');
    await b.keeper.tick();
    assert.match(b.keeper.about('site').log[0].what, /Sent automatically: 1 commit\(s\) to main/);
    assert.equal(existsSync(proof), false, 'nothing of the tool\'s was run here');
});

test('settings: nothing is sent automatically by default; what is set is checked; a repository with no record loads with the defaults', async (t) => {
    const b = await bench(t);
    assert.deepEqual(b.keeper.settings('site'), { ...DEFAULTS });
    assert.deepEqual(DEFAULTS.autoBranches, [], 'the list is empty to begin with');
    assert.equal(DEFAULTS.refreshMinutes, 5);
    assert.equal(DEFAULTS.quietMinutes, 10);
    assert.equal(DEFAULTS.requireForSend, false);
    const set = b.keeper.set('site', { autoBranches: 'test, staging\ntry/*', refreshMinutes: 0, checkCommand: 'npm test', requireForSend: true });
    assert.deepEqual(set.settings.autoBranches, ['test', 'staging', 'try/*']);
    assert.equal(set.settings.refreshMinutes, 0);
    assert.throws(() => b.keeper.set('site', { autoBranches: '-x' }), /not a branch name/);
    assert.throws(() => b.keeper.set('site', { autoBranches: ['a..b'] }), /not a branch name/);
    assert.throws(() => b.keeper.set('site', { quietMinutes: -1 }), /quiet minutes/);
    assert.throws(() => b.keeper.set('site', { checkCommand: 'a\nb' }), /one line/);
    assert.throws(() => b.keeper.set('site', { perHour: 0 }), /1 to 60/);
    assert.throws(() => b.keeper.set('nope', {}), /No such repository/);
    assert.equal(readFileSync(join(b.dir, 'git-keep.json'), 'utf8').includes('"autoBranches"'), true);
    /* Patterns: "*" is one level. */
    assert.equal(allowed(['try/*'], 'try/a'), true);
    assert.equal(allowed(['try/*'], 'try/a/b'), false);
    assert.equal(allowed(['try/*'], 'main'), false);
    assert.equal(allowed(['test'], 'test'), true);
    assert.equal(allowed(['test'], 'tests'), false);
    assert.equal(allowed(['v1.0'], 'v1x0'), false, 'a dot is a dot');
    assert.equal(allowed([], 'main'), false);
    assert.equal(patternProblem('release/*'), '');
});

test('automatic sending: only to a listed branch, only after the quiet delay, only after passing checks, never forced, capped, logged and told', async (t) => {
    let verdict = 'passed';
    const b = await bench(t, { checks: () => verdict });
    git(b.work, 'checkout', '--quiet', '-b', 'try/one');
    b.commit('a.txt', 'a\n', 'one');
    /* No list: nothing, whatever happens. */
    b.later(60); await b.keeper.tick(); b.later(60); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
    assert.deepEqual(b.keeper.about('site').log, []);
    b.keeper.set('site', { autoBranches: 'try/*', quietMinutes: 10, perHour: 2 });
    /* Committing: the quiet delay starts again at each commit. */
    await b.keeper.tick();
    b.later(5); const second = b.commit('b.txt', 'b\n', 'two'); await b.keeper.tick();
    b.later(6); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/try/'), '', 'not yet: something new came 6 minutes ago');
    b.later(5); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), second, 'sent: exactly the commit, to the branch of the same name');
    assert.equal(b.ran.at(-1).head, second); assert.equal(b.ran.at(-1).target, 'try/one');
    const log = b.keeper.about('site').log;
    assert.equal(log[0].ok, true); assert.match(log[0].what, /Sent automatically: 2 commit\(s\) to try\/one \(a new branch\), checks passed/);
    assert.deepEqual(b.told.map((m) => m.title), ['site: sent to try/one']);
    /* Checks that fail: not sent, said once, told. */
    verdict = 'failed';
    const third = b.commit('c.txt', 'c\n', 'three');
    b.later(11); await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), second);
    assert.match(b.keeper.about('site').log[0].what, /Not sent: the checks failed in the machine/);
    assert.equal(b.keeper.about('site').log.filter((l) => /checks failed/.test(l.what)).length, 1, 'said once');
    /* Checks that cannot be run (no hook, no command) are not a pass. */
    verdict = 'none';
    b.commit('d.txt', 'd\n', 'four');
    await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.match(b.keeper.about('site').log[0].what, /needs passing checks, and none is set/);
    /* A branch outside the list: never. */
    verdict = 'passed';
    git(b.work, 'checkout', '--quiet', '-b', 'main-copy');
    b.commit('e.txt', 'e\n', 'five');
    await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/main-copy'), '');
    assert.match(b.keeper.about('site').log[0].what, /main-copy is not in the list/);
    /* The remote moved on: said, nothing forced. */
    git(b.work, 'checkout', '--quiet', 'try/one');
    git(b.seed, 'fetch', '--quiet', 'origin'); git(b.seed, 'checkout', '--quiet', '-b', 'try/one', 'origin/try/one');
    writeFileSync(join(b.seed, 'x.txt'), 'x\n'); git(b.seed, 'add', 'x.txt'); git(b.seed, 'commit', '--quiet', '-m', 'theirs'); git(b.seed, 'push', '--quiet', 'origin', 'try/one');
    const theirs = git(b.seed, 'rev-parse', 'HEAD');
    b.commit('f.txt', 'f\n', 'six');
    await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), theirs, 'nothing forced');
    assert.match(b.keeper.about('site').log[0].what, /Not sent: The remote's try\/one has 1 commit\(s\)/);
    assert.ok(third);
});

test('the cap per hour holds, and the sending is tried again once the hour has room', async (t) => {
    const b = await bench(t);
    b.keeper.set('site', { autoBranches: 'main', quietMinutes: 1, perHour: 1 });
    const one = b.commit('a.txt', 'a\n', 'one');
    await b.keeper.tick(); b.later(2); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one);
    const two = b.commit('b.txt', 'b\n', 'two');
    b.later(2); await b.keeper.tick(); b.later(2); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one, 'capped');
    assert.match(b.keeper.about('site').log[0].what, /1 automatic sending\(s\) this hour already/);
    b.later(60); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), two, 'sent once the hour had room');
    assert.equal(b.keeper.about('site').sentThisHour, 1);
});

test('Send from the page: checks are advice by default, required when the owner says so, and only for that commit and branch', async (t) => {
    let verdict = 'failed';
    const b = await bench(t, { checks: () => verdict });
    const head = b.commit('a.txt', 'a\n', 'one');
    /* By default, a failed check is shown, and the owner decides. */
    assert.equal((await b.keeper.check('site', { head })).status, 'failed');
    b.keeper.set('site', { requireForSend: true });
    await assert.rejects(b.keeper.send('site', { head }), /Passing checks are required/);
    verdict = 'passed';
    await b.keeper.check('site', { head, target: 'other' });
    await assert.rejects(b.keeper.send('site', { head, target: 'main' }), /Passing checks are required/, 'checked for another branch is not checked for this one');
    await b.keeper.check('site', { head, target: 'main' });
    assert.equal((await b.keeper.send('site', { head, target: 'main' })).branch, 'main');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), head);
    await assert.rejects(b.keeper.check('site', { head: 'f'.repeat(40) }), /already there|changed since you looked/);
});

test('a long repository name still gets a valid, distinct origin folder', () => {
    const a = originFolder('a-very-long-repository-name-one');
    const c = originFolder('a-very-long-repository-name-two');
    for (const name of [a, c]) assert.match(name, /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/);
    assert.notEqual(a, c);
    assert.equal(originFolder('site'), 'site-origin');
});
