/* What happens to a repository when nobody looks: the reference (the
   remote's history) kept up to date where the tool can fetch it, automatic
   sending -- only to the branches the owner listed, after a quiet delay,
   after passing checks -- and every failure said. With a real git; the
   host program's read, the machine and the clock are stand-ins. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitReview } from '../server/gitpush.mjs';
import { GitKeeper, DEFAULTS, AUTO_DEFAULTS, allowed, patternProblem, readAuto, needsConfirmation, mayAutoSend, withoutOldSetting, READ_DELAY_MS, SAFETY_READ_MS, RETRY_MS } from '../server/gitkeeper.mjs';
import { GitRunner, runGit } from '../server/gitrunner.mjs';
import { Resources, originFolder } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Vms } from '../server/vm.mjs';
import { GitChecks } from '../server/gitchecks.mjs';
import { git, standInRead, ENV } from './git-stand-in.mjs';

/* `machineFor`: which running, awake machine has the repository attached (none:
   undefined). By default one does, so that the clock has a reason to act.
   `readCode`: an exit code every read of the host program gives. `wrap`: around the builder's git.
   `reserve`: free room the runner keeps (huge: every read refused for room). `heard`: what telling the agent resolves to. */
/* `attach`: alpha writes in the repository from the start (its automatic sending can be set). `runs(conversation, name)`: does its machine run. */
async function bench(t, { checks = 'passed', machineFor = async () => 'alpha', runs, readCode, wrap, reserve = 0, heard, attach = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-keep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
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
    await resources.create({ name: 'site', type: 'git' });
    if (attach) await resources.attach('alpha', 'site', 'write');
    const work = join(dir, 'resources', 'site');
    let clock = new Date('2026-03-02T10:00:00Z');
    const now = () => clock;
    const reads = [];
    const runner = new GitRunner({ dataDir: join(dir, 'data'), reserveBytes: reserve, spawnRead: standInRead((n) => resources.folder(n), { reads, code: readCode }), ...(wrap ? { git: (argv, options) => wrap(argv, options, runGit) } : {}) });
    const review = new GitReview({ store: new Store(join(dir, 'git.json')), vault: new Vault(join(dir, 'vault.key')), resources, dataDir: join(dir, 'data'), localRemotes: true, runner, now });
    review.setRemote('site', { url: remote });
    git(work, 'fetch', '--quiet', remote, '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'reset', '--quiet', '--hard', 'origin/main');
    const ran = []; const told = []; const agent = []; const agentTo = []; const lines = [];
    const fakeChecks = {
        machineFor: (name) => machineFor(name, resources),
        runs: runs ? (c, name) => runs(c, name, resources) : async (c, name) => (await machineFor(name, resources)) === c && resources.of(c).some((x) => x.name === name && x.access === 'write'),
        run: async (name, asked) => { ran.push(asked); return { status: typeof checks === 'function' ? checks() : checks, output: 'stand-in', head: asked.head, target: asked.target, machine: asked.machine ?? 'alpha', at: clock.toISOString() }; },
    };
    const keeper = new GitKeeper({ store: new Store(join(dir, 'git-keep.json')), review, resources, checks: fakeChecks, alerts: { tell: async (m) => { told.push(m); return 1; } }, now, tellAgent: async (name, line, to) => { agent.push(line); agentTo.push([line, to]); return heard ? heard() : undefined; }, thread: (conversation, event) => lines.push([conversation, event]) });
    const commit = (file, text, subject) => { writeFileSync(join(work, file), text); git(work, 'add', file); git(work, 'commit', '--quiet', '-m', subject); return git(work, 'rev-parse', 'HEAD'); };
    /* Time passes; marks written by git have a resolution that a fast test can beat: the clock moves on. */
    const later = (minutes) => { clock = new Date(clock.getTime() + minutes * 60_000); };
    const theirs = (branch, file) => { git(seed, 'fetch', '--quiet', 'origin'); git(seed, 'checkout', '--quiet', '-B', branch, `origin/${branch}`); writeFileSync(join(seed, file), `${file}\n`); git(seed, 'add', file); git(seed, 'commit', '--quiet', '-m', `theirs ${file}`); git(seed, 'push', '--quiet', 'origin', branch); return git(seed, 'rev-parse', 'HEAD'); };
    const log = () => keeper.about('site').log;
    /* Alpha's automatic sending; the tests send to main (the default
       branch: confirmed) and make branches unless they say otherwise. */
    const auto = (body, conversation = 'alpha') => keeper.setAuto('site', conversation, { sure: true, create: true, ...body });
    return { dir, remote, seed, work, vm, host, resources, review, keeper, commit, later, ran, told, agent, agentTo, reads, theirs, log, runner, auto, lines };
}
/* Ticks until a read has happened and its tips were weighed: the read waits READ_DELAY_MS after the last change. */
async function settle(b) { await b.keeper.tick(); b.later(READ_DELAY_MS / 60_000); await b.keeper.tick(); }

test('the reference is kept by the server only, shown read-only next to the repository, and the tool fetches from it with no key', async (t) => {
    const b = await bench(t);
    await b.resources.attach('alpha', 'site', 'write');
    b.vm.length = 0;
    git(b.seed, 'checkout', '--quiet', '-b', 'feature'); writeFileSync(join(b.seed, 'f.txt'), 'f\n'); git(b.seed, 'add', 'f.txt'); git(b.seed, 'commit', '--quiet', '-m', 'Feature'); git(b.seed, 'push', '--quiet', 'origin', 'feature');
    const theirs = git(b.seed, 'rev-parse', 'HEAD');
    const about = await b.keeper.refresh('site');
    assert.equal(about.origin.ok, true, about.origin.message);
    assert.equal(about.origin.path, '/resources/site-origin');
    const mirror = join(b.dir, 'resources', 'site-origin');
    assert.equal(git(mirror, 'rev-parse', 'refs/heads/feature'), theirs, 'the reference has the remote\'s branches');
    assert.ok(b.host.includes('folder make site-origin'), 'its folder is made by the host program, like any folder');
    assert.ok(b.host.includes('view make site-origin'));
    assert.deepEqual(b.vm, ['mount clv-alpha view site-origin 1001 1002']);
    git(b.work, 'fetch', '--quiet', mirror, '+refs/heads/*:refs/remotes/origin/*');
    assert.equal(git(b.work, 'rev-parse', 'refs/remotes/origin/feature'), theirs);
    b.vm.length = 0;
    await b.resources.attach('beta', 'site', 'read');
    assert.deepEqual(b.vm, ['mount clv-beta view site 1001 1002', 'mount clv-beta view site-origin 1001 1002']);
    b.vm.length = 0;
    await b.resources.attach('beta', 'site', 'none');
    assert.deepEqual(b.vm, ['umount clv-beta site', 'umount clv-beta site-origin']);
    b.vm.length = 0;
    assert.deepEqual(await b.resources.remount('alpha'), []);
    assert.deepEqual(b.vm, ['mount clv-alpha folder site 1001 1002', 'mount clv-alpha view site-origin 1001 1002']);
    await assert.rejects(b.resources.attach('alpha', 'site-origin', 'write'), /No such resource/);
    await assert.rejects(b.resources.create({ name: 'site-origin' }), /kept for the origin/);
    await b.resources.attach('alpha', 'site', 'none');
    b.host.length = 0;
    await b.resources.remove('site');
    assert.deepEqual(b.host, ['view close site', 'folder aside site', 'view close site-origin', 'folder aside site-origin']);
    assert.ok(existsSync(join(b.dir, 'removed', 'site-origin', 'HEAD')));
});

test('nothing of the tool runs here: git is never run in its repository, only its bundle is read', async (t) => {
    const b = await bench(t);
    const proof = join(b.dir, 'ran');
    const trap = join(b.dir, 'trap.sh');
    writeFileSync(trap, `#!/bin/sh\ntouch ${proof}\nexit 0\n`); chmodSync(trap, 0o755);
    for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'post-update', 'pre-receive', 'update', 'post-merge']) { writeFileSync(join(b.work, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${proof}\n`); chmodSync(join(b.work, '.git', 'hooks', hook), 0o755); }
    for (const [key, value] of [['core.fsmonitor', trap], ['core.pager', trap], ['core.sshCommand', trap], ['uploadpack.packObjectsHook', trap], ['core.hooksPath', join(b.work, '.git', 'hooks')]]) git(b.work, 'config', key, value);
    b.auto({ branches: 'main', quietSeconds: 0 });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'commit', '--quiet', '--allow-empty', '-m', 'rigged'], { cwd: b.work, env: ENV });
    rmSync(proof, { force: true });
    await b.keeper.refresh('site');
    await b.keeper.tick();
    assert.match(b.log()[0].what, /Sent automatically for alpha: 1 commit\(s\) to main/);
    assert.equal(existsSync(proof), false, 'nothing of the tool\'s was run here');
});

test('settings: nothing is sent automatically by default; what is set is checked; a repository with no record loads with the defaults', async (t) => {
    const b = await bench(t);
    assert.deepEqual(b.keeper.settings('site'), { ...DEFAULTS });
    assert.equal(DEFAULTS.refreshMinutes, 5);
    assert.equal(DEFAULTS.requireForSend, false);
    const set = b.keeper.set('site', { refreshMinutes: 0, checkCommand: 'npm test', requireForSend: true });
    assert.equal(set.settings.refreshMinutes, 0);
    assert.throws(() => b.keeper.set('site', { checkCommand: 'a\nb' }), /one line/);
    assert.throws(() => b.keeper.set('site', { fsck: { hasDotgit: 'ignore' } }), /cannot be waived/);
    assert.deepEqual(b.keeper.set('site', { fsck: { zeroPaddedFilemode: 'warn' } }).settings.fsck, { zeroPaddedFilemode: 'warn' });
    assert.throws(() => b.keeper.set('nope', {}), /No such repository/);
    /* A page from before: automatic sending is no longer a setting of the repository. */
    assert.throws(() => b.keeper.set('site', { autoBranches: 'main' }), /set for each conversation/);
    assert.throws(() => b.keeper.set('site', { quietMinutes: 1 }), /set for each conversation/);
    assert.equal(allowed(['try/*'], 'try/a'), true);
    assert.equal(allowed(['try/*'], 'try/a/b'), false);
    assert.equal(allowed(['try/*'], 'main'), false);
    assert.equal(allowed(['test'], 'test'), true);
    assert.equal(allowed(['test'], 'tests'), false);
    assert.equal(allowed(['v1.0'], 'v1x0'), false, 'a dot is a dot');
    assert.equal(allowed([], 'main'), false);
    assert.equal(patternProblem('release/*'), '');
});

test('automatic sending, per conversation: empty by default, checked, "*" and the default branch only once confirmed', async (t) => {
    const b = await bench(t);
    await b.resources.attach('beta', 'site', 'read');
    assert.deepEqual(AUTO_DEFAULTS, { branches: [], confirmed: [], quietSeconds: 5, perHour: 20, create: false, checks: true });
    assert.deepEqual(b.keeper.auto('site', 'alpha').settings, { ...AUTO_DEFAULTS }, 'nothing is sent unless the owner chose');
    assert.throws(() => b.keeper.auto('site', 'beta'), /attached for writing/, 'read-only: nothing to set');
    assert.throws(() => b.keeper.setAuto('site', 'beta', { branches: 'try/*' }), /attached for writing/);
    assert.throws(() => b.keeper.auto('nope', 'alpha'), /No such repository/);
    /* The model, on its own. */
    const plain = readAuto({ branches: 'test, staging\ntry/*', quietSeconds: '30', perHour: 0, create: true, checks: false }, undefined, 'main');
    assert.deepEqual(plain, { branches: ['test', 'staging', 'try/*'], confirmed: [], quietSeconds: 30, perHour: 0, create: true, checks: false });
    assert.throws(() => readAuto({ branches: '-x' }), /not a branch name/);
    assert.throws(() => readAuto({ branches: ['a..b'] }), /not a branch name/);
    assert.throws(() => readAuto({ branches: Array.from({ length: 21 }, (_, i) => `b${i}`) }), /At most 20/);
    assert.throws(() => readAuto({ quietSeconds: -1 }), /quiet seconds/);
    assert.throws(() => readAuto({ quietSeconds: 1.5 }), /quiet seconds/);
    assert.throws(() => readAuto({ quietSeconds: '' }), /quiet seconds/);
    assert.throws(() => readAuto({ perHour: 1001 }), /0 \(no cap\)/);
    for (const wide of ['*', '*/*', 'main', 'ma*']) {
        assert.throws(() => readAuto({ branches: wide }, undefined, 'main'), (e) => e.kind === 'confirm-wide' && e.status === 409, wide);
        assert.deepEqual(readAuto({ branches: wide, sure: true }, undefined, 'main').confirmed, [wide]);
    }
    assert.equal(needsConfirmation('develop', 'develop'), true, 'the remote\'s default, whatever its name');
    assert.equal(needsConfirmation('main', 'develop'), false);
    assert.equal(needsConfirmation('master', null), true, 'unknown: main and master are asked about');
    /* Unknown, any branch could be the default one: every pattern is asked about. */
    assert.equal(needsConfirmation('try/*', null), true, 'unknown: every pattern is asked about');
    assert.equal(needsConfirmation('try/*', 'main'), false, 'known: only what reaches it');
    assert.equal(mayAutoSend({ branches: ['try/*'], confirmed: [] }, 'try/a', null), false, 'unknown and unconfirmed: nothing goes by itself');
    assert.equal(mayAutoSend({ branches: ['try/*'], confirmed: ['try/*'] }, 'try/a', null), true, 'confirmed: it goes');
    assert.equal(mayAutoSend({ branches: ['try/*'], confirmed: [] }, 'try/a', 'main'), true, 'known, and not the default: it goes');
    assert.throws(() => readAuto({ branches: 'try/*' }, undefined, null), (e) => e.kind === 'confirm-wide' && /default branch is not known yet/.test(e.message));
    /* The decision. */
    assert.equal(mayAutoSend({ branches: ['*'], confirmed: [] }, 'x', 'main'), false, 'not confirmed: counts for nothing');
    assert.equal(mayAutoSend({ branches: ['*'], confirmed: ['*'] }, 'x', 'main'), true);
    assert.equal(mayAutoSend({ branches: ['*'], confirmed: ['*'] }, 'a/b', 'main'), false, '"*" is one level');
    assert.equal(mayAutoSend({ branches: ['develop'], confirmed: [] }, 'develop', 'main'), true);
    assert.equal(mayAutoSend({ branches: ['develop'], confirmed: [] }, 'develop', 'develop'), false, 'became the default since: asked again');
    assert.equal(mayAutoSend({ branches: [], confirmed: [] }, 'main', 'main'), false);
    /* Through the keeper: the remote's default branch is learnt at a refresh. */
    await b.keeper.refresh('site');
    assert.equal(b.review.defaultBranch('site'), 'main');
    assert.deepEqual(b.keeper.auto('site', 'alpha').asked, ['main']);
    assert.throws(() => b.keeper.setAuto('site', 'alpha', { branches: 'main, try/*' }), /Confirm: main would let this conversation send/);
    assert.deepEqual(b.keeper.auto('site', 'alpha').settings.branches, [], 'refused: nothing saved');
    const saved = b.keeper.setAuto('site', 'alpha', { branches: 'main, try/*', sure: true, quietSeconds: 0 });
    assert.deepEqual([saved.settings.branches, saved.settings.confirmed, saved.settings.quietSeconds], [['main', 'try/*'], ['main'], 0]);
    assert.deepEqual(b.keeper.setAuto('site', 'alpha', { perHour: 3 }).settings.confirmed, ['main'], 'the same list: not asked again');
    b.keeper.setAuto('site', 'alpha', { branches: 'try/*' });
    assert.throws(() => b.keeper.setAuto('site', 'alpha', { branches: 'try/*, main' }), /Confirm/, 'removed, then typed again: asked again');
    assert.deepEqual(b.keeper.about('site').auto, { alpha: ['try/*'] }, 'the review panel says which conversation sends by itself');
});

test('a file of the previous version loads: its setting for the repository is dropped, never carried into a conversation; every conversation starts from the prudent defaults', async (t) => {
    const b = await bench(t);
    await b.resources.attach('beta', 'site', 'write');
    await b.resources.attach('gamma', 'site', 'read');
    const file = join(b.dir, 'old-keep.json');
    writeFileSync(file, JSON.stringify([
        { name: 'site', refreshMinutes: 7, autoBranches: ['main', 'try/*'], quietMinutes: 3, perHour: 2, alert: false, mirror: { at: '2026-03-01T00:00:00.000Z', ok: true, message: 'Up to date with the origin.' }, log: [{ at: '2026-03-01T00:00:00.000Z', branch: 'main', head: 'a'.repeat(40), ok: true, what: 'Sent automatically.' }], sent: [] },
        /* A repository removed since, and a record written by hand, oddly. */
        { name: 'gone', autoBranches: 'x, -bad', quietMinutes: 'soon', perHour: 99999 },
        { name: 'quiet' },
    ]));
    const old = new GitKeeper({ store: new Store(file), review: b.review, resources: b.resources, checks: { machineFor: async () => undefined }, alerts: null });
    const about = old.about('site');
    assert.deepEqual([about.settings.refreshMinutes, about.settings.alert, about.settings.fsck, about.log.length, about.origin.ok], [7, false, {}, 1, true], 'the rest of the record is kept');
    assert.deepEqual(about.auto, {}, 'nobody sends by itself');
    assert.deepEqual(old.auto('site', 'alpha').settings, { ...AUTO_DEFAULTS }, 'not carried: an empty list, no branch made, nothing confirmed');
    assert.deepEqual(old.auto('site', 'beta').settings, { ...AUTO_DEFAULTS });
    assert.throws(() => old.auto('site', 'gamma'), /attached for writing/);
    const text = readFileSync(file, 'utf8');
    for (const key of ['autoBranches', 'quietMinutes', '"perHour"']) assert.equal(text.includes(key), false, `${key} is no longer kept`);
    const records = JSON.parse(text);
    assert.equal(records.find((r) => r.name === 'site').auto, undefined, 'no setting made for any conversation');
    assert.deepEqual(records.find((r) => r.name === 'gone'), { name: 'gone' });
    assert.deepEqual(records.find((r) => r.name === 'quiet'), { name: 'quiet' }, 'nothing to drop: untouched');
    /* The model alone. */
    assert.equal(withoutOldSetting({ name: 'x', refreshMinutes: 5 }), null);
    assert.deepEqual(withoutOldSetting({ name: 'x', autoBranches: ['*'], quietMinutes: 10, perHour: 4, refreshMinutes: 5, auto: { alpha: { branches: ['try/*'] } } }), { name: 'x', refreshMinutes: 5, auto: { alpha: { branches: ['try/*'] } } }, 'only the old keys go');
});

test('automatic sending of a conversation: its settings, its running machine, its checks, its cap; detached or archived, forgotten', async (t) => {
    const up = new Set(['alpha']);
    const b = await bench(t, { runs: async (c, name, resources) => up.has(c) && resources.of(c).some((x) => x.name === name && x.access === 'write') });
    await b.resources.attach('beta', 'site', 'write');
    /* Two writers in one folder: each list is confirmed as such (see the test of both orders). */
    b.auto({ branches: 'try/*', quietSeconds: 0, perHour: 1, shared: true });
    b.auto({ branches: 'feat/*', quietSeconds: 0, checks: false, shared: true }, 'beta');
    git(b.work, 'checkout', '--quiet', '-b', 'feat/x'); const feat = b.commit('f.txt', 'f\n', 'feat');
    git(b.work, 'checkout', '--quiet', '-b', 'try/y'); const tryY = b.commit('y.txt', 'y\n', 'try');
    await settle(b);
    const remoteOf = (branch) => { try { return git(b.remote, 'rev-parse', `refs/heads/${branch}`); } catch { return ''; } };
    assert.equal(remoteOf('try/y'), tryY, 'alpha\'s list, alpha\'s machine runs: sent');
    assert.equal(remoteOf('feat/x'), '', 'only beta names it, and beta\'s machine does not run: it waits');
    assert.equal(b.log().some((l) => /feat\/x is not in the list/.test(l.what)), false, 'waiting for beta is not "outside every list"');
    assert.deepEqual(b.ran.map((r) => [r.target, r.machine]), [['try/y', 'alpha']], 'the checks ran in alpha\'s machine');
    assert.equal(b.log()[0].conversation, 'alpha');
    assert.match(b.log()[0].what, /Sent automatically for alpha: 2 commit\(s\) to try\/y \(a new branch\), checks passed/);
    /* Beta's machine runs: its branch goes, with its settings (no checks asked for). */
    up.add('beta');
    await b.keeper.tick();
    assert.equal(remoteOf('feat/x'), feat);
    assert.equal(b.ran.length, 1, 'beta asked for no checks');
    assert.match(b.log()[0].what, /Sent automatically for beta: .* to feat\/x .*no checks asked for/);
    /* Alpha's cap is alpha's: one an hour. */
    git(b.work, 'checkout', '--quiet', 'try/y'); b.commit('y2.txt', 'y2\n', 'try again');
    await settle(b);
    assert.match(b.log()[0].what, /1 automatic sending\(s\) this hour already for alpha/);
    assert.equal(b.keeper.auto('site', 'alpha').sentThisHour, 1);
    assert.equal(b.keeper.auto('site', 'beta').sentThisHour, 1);
    /* Only branches the remote has, unless the owner allowed making them. */
    b.auto({ branches: 'try/*, new/*', quietSeconds: 0, perHour: 0, create: false, shared: true });
    git(b.work, 'checkout', '--quiet', '-b', 'new/z'); b.commit('z.txt', 'z\n', 'new');
    await settle(b);
    assert.equal(remoteOf('new/z'), '');
    assert.ok(b.log().some((l) => l.conversation === 'alpha' && /new\/z does not exist on the remote, and alpha may not create branches/.test(l.what)));
    assert.ok(b.agentTo.some(([line, to]) => /new\/z was not sent/.test(line) && to === 'alpha'), 'told to alpha\'s agent only');
    assert.equal(remoteOf('try/y') === tryY, false, 'perHour 0: no cap, the waiting commit went');
    /* Detached: forgotten; attached again: an empty list. */
    await b.resources.attach('beta', 'site', 'none'); b.keeper.forgetAttachment('site', 'beta');
    await b.resources.attach('beta', 'site', 'write');
    assert.deepEqual(b.keeper.auto('site', 'beta').settings.branches, []);
    /* Archived: every setting of the conversation goes. */
    b.keeper.forgetConversation('alpha');
    assert.deepEqual(b.keeper.auto('site', 'alpha').settings, { ...AUTO_DEFAULTS });
    assert.deepEqual(b.keeper.about('site').auto, {});
});


test('automatic sending: only to a listed branch, only after the quiet delay, only after passing checks, never forced, capped, logged and told', async (t) => {
    let verdict = 'passed';
    const b = await bench(t, { checks: () => verdict });
    git(b.work, 'checkout', '--quiet', '-b', 'try/one');
    b.commit('a.txt', 'a\n', 'one');
    /* No list: nothing, whatever happens, and nothing is even read. */
    b.later(60); await b.keeper.tick(); b.later(60); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
    assert.deepEqual(b.log(), []);
    assert.deepEqual(b.reads, []);
    b.auto({ branches: 'try/*', quietSeconds: 600, perHour: 2 });
    /* The quiet delay starts again at each new tip. */
    await settle(b);
    b.later(5); const second = b.commit('b.txt', 'b\n', 'two'); await settle(b);
    b.later(6); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/try/'), '', 'not yet: something new came 6 minutes ago');
    b.later(5); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), second, 'sent: exactly the commit, to the branch of the same name');
    assert.equal(b.ran.at(-1).head, second); assert.equal(b.ran.at(-1).target, 'try/one'); assert.equal(b.ran.at(-1).branch, 'try/one');
    assert.equal(b.log()[0].ok, true); assert.match(b.log()[0].what, /Sent automatically for alpha: 2 commit\(s\) to try\/one \(a new branch\), checks passed/);
    assert.deepEqual(b.told.map((m) => m.title), ['site: sent to try/one']);
    /* Checks that fail: not sent, said once, told; the checks are not run again for that commit. */
    verdict = 'failed';
    const third = b.commit('c.txt', 'c\n', 'three');
    await settle(b); b.later(11); await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), second);
    assert.match(b.log()[0].what, /Not sent: the checks failed in the machine/);
    assert.equal(b.log().filter((l) => /checks failed/.test(l.what)).length, 1, 'said once');
    assert.equal(b.ran.filter((r) => r.head === third).length, 1, 'run once for that commit');
    /* Checks that cannot be run (no hook, no command) are not a pass. */
    verdict = 'none';
    b.commit('d.txt', 'd\n', 'four');
    await settle(b); b.later(11); await b.keeper.tick();
    assert.match(b.log()[0].what, /needs passing checks, and none is set/);
    /* A branch outside the list: never, said once. */
    verdict = 'passed';
    git(b.work, 'checkout', '--quiet', '-b', 'main-copy');
    b.commit('e.txt', 'e\n', 'five');
    await settle(b); b.later(11); await b.keeper.tick(); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/main-copy'), '');
    assert.equal(b.log().filter((l) => /main-copy is not in the list/.test(l.what)).length, 1);
    /* The remote moved on: said, nothing forced, the agent told to pull. */
    git(b.work, 'checkout', '--quiet', 'try/one');
    const theirs = b.theirs('try/one', 'x.txt');
    await b.keeper.refresh('site');
    b.commit('f.txt', 'f\n', 'six');
    await settle(b); b.later(11); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), theirs, 'nothing forced');
    assert.match(b.log()[0].what, /Not sent: the remote's try\/one has commits this branch does not have/);
    assert.ok(b.agent.includes('Clavarium, repository site: pull origin/try/one first.'));
});

test('reads are paced: a change waits a few seconds, a change during a read asks for one more, a read every ten minutes at least', async (t) => {
    const b = await bench(t);
    /* (A quiet delay longer than the test: a send would read once more.) */
    b.auto({ branches: 'main', quietSeconds: 7200 });
    await b.keeper.tick();
    assert.equal(b.reads.length, 1, 'one read at start');
    await b.keeper.tick(); await b.keeper.tick();
    assert.equal(b.reads.length, 1, 'nothing changed: no read');
    /* A thousand commits a minute: still one read per pause of the marks. */
    for (let i = 0; i < 5; i++) { b.commit(`f${i}.txt`, `${i}\n`, `c${i}`); await b.keeper.tick(); }
    assert.equal(b.reads.length, 1, 'changing all the time: the read waits');
    b.later(READ_DELAY_MS / 60_000); await b.keeper.tick();
    assert.equal(b.reads.length, 2);
    b.later(SAFETY_READ_MS / 60_000); await b.keeper.tick();
    assert.equal(b.reads.length, 3, 'the safety read');
});

test('the cap per hour holds, and the sending is tried again once the hour has room', async (t) => {
    const b = await bench(t);
    b.auto({ branches: 'main', quietSeconds: 60, perHour: 1 });
    const one = b.commit('a.txt', 'a\n', 'one');
    await settle(b); b.later(2); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one);
    const two = b.commit('b.txt', 'b\n', 'two');
    await settle(b); b.later(2); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one, 'capped');
    assert.match(b.log()[0].what, /1 automatic sending\(s\) this hour already/);
    assert.equal(b.ran.length, 1, 'no checks for a capped commit');
    b.later(60); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), two, 'sent once the hour had room');
    assert.equal(b.keeper.about('site').sentThisHour, 1);
});

test('a branch only behind the remote is no candidate: no checks, no slot of the hour, no "diverged"', async (t) => {
    const b = await bench(t);
    b.auto({ branches: 'main', quietSeconds: 0, perHour: 1 });
    b.theirs('main', 'ahead.txt');
    await b.keeper.refresh('site');
    await settle(b); b.later(5); await b.keeper.tick();
    assert.deepEqual(b.ran, []);
    assert.deepEqual(b.log(), []);
    assert.equal(b.keeper.about('site').sentThisHour, 0);
});

test('Send from the page: checks are advice by default, required when the owner says so, and only for that commit and branch', async (t) => {
    let verdict = 'failed';
    const b = await bench(t, { checks: () => verdict });
    const head = b.commit('a.txt', 'a\n', 'one');
    await b.review.outgoing('site');
    assert.equal((await b.keeper.check('site', { head })).status, 'failed');
    assert.deepEqual([b.ran.at(-1).branch, b.ran.at(-1).target, b.ran.at(-1).remoteTip], ['main', 'main', git(b.remote, 'rev-parse', 'main')]);
    b.keeper.set('site', { requireForSend: true });
    await assert.rejects(b.keeper.send('site', { head }), /Passing checks are required/);
    verdict = 'passed';
    await b.review.outgoing('site', { target: 'other' });
    await b.keeper.check('site', { head, target: 'other' });
    await assert.rejects(b.keeper.send('site', { head, target: 'main' }), /Passing checks are required/, 'checked for another branch is not checked for this one');
    await b.keeper.check('site', { head, target: 'main' });
    assert.equal((await b.keeper.send('site', { head, target: 'main' })).branch, 'main');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), head);
    await assert.rejects(b.keeper.check('site', { head: 'f'.repeat(40) }), /changed since you looked/);
});

test('a push whose outcome is unknown, with the remote silent, holds automatic sending for that branch until a refresh settles it', async (t) => {
    let silent = false; let pushed = false;
    const b = await bench(t, {
        wrap: async (argv, options, real) => {
            if (argv.includes('push') && silent) { const r = await real(argv, options); pushed = true; return { ...r, code: null, signal: 'SIGKILL', killed: 'deadline', stdout: Buffer.alloc(0) }; }
            if (argv.includes('fetch') && silent && pushed) return { code: 128, signal: null, stdout: Buffer.alloc(0), stderr: 'fatal: unreachable', killed: null };
            return real(argv, options);
        },
    });
    b.auto({ branches: 'main', quietSeconds: 0, perHour: 10 });
    const head = b.commit('a.txt', 'a\n', 'one');
    silent = true;
    await b.keeper.tick();
    assert.match(b.log()[0].what, /outcome is unknown, and the remote is unreachable/);
    assert.deepEqual(b.keeper.about('site').blocked, ['main']);
    const told = b.told.length;
    b.commit('b.txt', 'b\n', 'two');
    await settle(b);
    assert.match(b.log()[0].what, /outcome of an earlier sending to main is unknown/);
    assert.equal(b.told.length, told, 'said, not sent');
    /* The remote answers again: the refresh settles it -- it had arrived. */
    silent = false;
    await b.keeper.refresh('site');
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(b.keeper.about('site').blocked, []);
    assert.ok(b.log().some((l) => /did arrive \(settled by a refresh\)/.test(l.what) && l.head === head));
});

test('a repository no running machine uses does nothing by itself: no refresh, no automatic sending; "Refresh now" still works', async (t) => {
    const phases = { alpha: { phase: 'ready', asleep: false }, beta: { phase: 'ready', asleep: false } };
    const runs = new Set(['alpha', 'beta']);
    const conversations = {
        awake: () => Object.entries(phases).filter(([, c]) => c.phase === 'ready' && c.asleep !== true).map(([name]) => name),
        running: async (name) => runs.has(name),
    };
    const b = await bench(t, { attach: false, machineFor: (name, resources) => new GitChecks({ vms: null, conversations, resources }).machineFor(name), runs: (c, name, resources) => new GitChecks({ vms: null, conversations, resources }).runs(c, name) });
    const theirs = git(b.remote, 'rev-parse', 'refs/heads/main');
    const mirror = join(b.dir, 'resources', 'site-origin');
    const mirrored = () => (existsSync(join(mirror, 'HEAD')) ? git(mirror, 'rev-parse', 'refs/heads/main') : '');
    b.keeper.set('site', { refreshMinutes: 5 });
    const mine = b.commit('a.txt', 'a\n', 'mine');
    const remoteMain = () => git(b.remote, 'rev-parse', 'refs/heads/main');
    await b.keeper.tick(); b.later(30); await b.keeper.tick(); b.later(30); await b.keeper.tick();
    assert.equal(mirrored(), '', 'the remote was not fetched');
    assert.equal(b.keeper.about('site').origin.at, undefined);
    assert.equal(remoteMain(), theirs, 'nothing was sent');
    assert.deepEqual(b.ran, [], 'no checks were asked for');
    assert.deepEqual(b.reads, [], 'nothing was read');
    await b.resources.attach('alpha', 'site', 'write');
    await b.resources.attach('beta', 'site', 'read');
    b.auto({ branches: 'main', quietSeconds: 60 });
    for (const [alpha, beta, alphaRuns] of [[{ asleep: true }, { phase: 'building' }, true], [{ phase: 'failed' }, { asleep: true }, true], [{}, { phase: 'failed' }, false]]) {
        phases.alpha = { phase: 'ready', ...alpha }; phases.beta = { phase: 'ready', ...beta };
        if (alphaRuns) runs.add('alpha'); else runs.delete('alpha');
        b.later(30); await b.keeper.tick();
        assert.equal(mirrored(), '', JSON.stringify({ alpha, beta, alphaRuns }));
        assert.equal(remoteMain(), theirs);
    }
    assert.equal((await b.keeper.refresh('site')).origin.ok, true);
    assert.equal(mirrored(), theirs);
    git(b.seed, 'commit', '--quiet', '--allow-empty', '-m', 'theirs again'); git(b.seed, 'push', '--quiet', 'origin', 'HEAD:feature');
    phases.beta = { phase: 'ready', asleep: false };
    b.later(30); await b.keeper.tick();
    assert.equal(git(mirror, 'rev-parse', 'refs/heads/feature'), git(b.seed, 'rev-parse', 'HEAD'), 'refreshed by the clock while a machine uses it');
    assert.equal(remoteMain(), theirs, 'alpha\'s machine does not run: nothing is sent for it');
    assert.deepEqual(b.reads, [], 'nor read');
    runs.add('alpha');
    b.later(30); await b.keeper.tick();
    assert.equal(remoteMain(), theirs, 'not yet: the quiet delay starts when it is first read');
    b.later(2); await b.keeper.tick();
    assert.equal(remoteMain(), mine, 'sent once a machine used it and it stayed quiet');
    assert.equal(b.ran.length, 1);
});

test('every failure is said: in the log once while it lasts, the phone after two in a row, the agent where it can act', async (t) => {
    const cases = [
        [66, /Git failed to read/, { phoneAfter: 2, agent: /could not read your repository/, agentAfter: 2 }],
        [67, /not readable/, { phoneAfter: 2, agent: /chmod -R o\+rX \.git/ }],
        [80, /time limit/, { phoneAfter: 2, agent: /could not be read in 300 s/ }],
        [81, /memory limit/, { phoneAfter: 2, agent: /too much memory/ }],
        [82, /killed/, { phoneAfter: 2 }],
        [78, /Could not read/, { phoneAfter: 2 }],
        [79, /host program failed/, { phoneAfter: 1 }],
    ];
    for (const [code, said, { phoneAfter, agent, agentAfter = 1 }] of cases) {
        const b = await bench(t, { readCode: code });
        b.auto({ branches: 'main' });
        await b.keeper.tick();
        const first = b.log();
        assert.equal(first.length, 1, `${code}: logged`); assert.match(first[0].what, said);
        assert.equal(b.told.length >= 1, phoneAfter === 1, `${code}: phone at once?`);
        assert.equal(b.agent.length > 0, Boolean(agent) && agentAfter === 1, `${code}: agent told at once?`);
        b.later(11); await b.keeper.tick();
        assert.equal(b.log().length, 1, `${code}: said once while it lasts`);
        assert.ok(b.told.length >= 1, `${code}: phone after two in a row`);
        if (agent) { assert.equal(b.agent.length, 1, `${code}: the agent is told once`); assert.match(b.agent[0], agent); } else assert.deepEqual(b.agent, []);
        assert.equal(b.log().some((l) => /nothing to send/i.test(l.what)), false);
    }
    /* No branches: the agent is told how to make one. */
    const empty = await bench(t);
    rmSync(join(empty.work, '.git'), { recursive: true, force: true });
    git(empty.work, 'init', '--quiet');
    empty.auto({ branches: 'main' });
    await empty.keeper.tick();
    assert.match(empty.log()[0].what, /No branches/);
    assert.match(empty.agent[0], /git switch -c <name>/);
    /* A name that cannot be taken: the agent is told, plainly. */
    const odd = await bench(t);
    writeFileSync(join(odd.work, '.git', 'refs', 'heads', 'f'.repeat(40)), `${git(odd.work, 'rev-parse', 'HEAD')}\n`);
    odd.auto({ branches: 'main' });
    await odd.keeper.tick();
    assert.match(odd.agent[0], /branch f{40} was not taken: .*commit id/);
    /* A rewrite of the remote: the owner alerted, the agent told to fetch again. */
    const rw = await bench(t);
    await rw.keeper.refresh('site');
    git(rw.seed, 'commit', '--quiet', '--amend', '-m', 'rewritten'); git(rw.seed, 'push', '--quiet', '--force', 'origin', 'HEAD:main');
    await rw.keeper.refresh('site');
    assert.match(rw.log()[0].what, /main was rewritten on the remote/);
    assert.ok(rw.told.some((m) => /main rewritten on the remote/.test(m.title)));
    assert.match(rw.agent[0], /origin\/main was rewritten; fetch again/);
    /* The remote unreachable: the phone after three in a row. */
    rmSync(rw.remote, { recursive: true, force: true });
    const before = rw.told.length;
    for (let i = 0; i < 3; i++) await rw.keeper.refresh('site');
    assert.equal(rw.told.length, before + 1);
    assert.equal(rw.keeper.about('site').origin.ok, false);
});

test('the reference is never what is read, and the workspaces are gone after every read', async (t) => {
    const b = await bench(t);
    b.auto({ branches: 'main', quietSeconds: 0 });
    b.commit('a.txt', 'a\n', 'one');
    /* The check read comes before any reference exists. */
    assert.equal(existsSync(join(b.dir, 'resources', 'site-origin', 'HEAD')), false);
    await b.review.readTips('site');
    assert.deepEqual(Object.keys(b.review.tips('site')), ['main']);
    await settle(b);
    assert.deepEqual(b.reads.every((n) => n === 'site'), true, 'only the agent\'s folder is read, never site-origin');
    assert.deepEqual(readdirSync(b.runner.workRoot), []);
});

test('a long repository name still gets a valid, distinct origin folder', () => {
    const a = originFolder('a-very-long-repository-name-one');
    const c = originFolder('a-very-long-repository-name-two');
    for (const name of [a, c]) assert.match(name, /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/);
    assert.notEqual(a, c);
    assert.equal(originFolder('site'), 'site-origin');
});

test('a sending that failed for a passing reason is tried again later; one whose outcome a refresh settled as "not arrived" is sent again', async (t) => {
    let down = false; let lost = false;
    const b = await bench(t, {
        wrap: async (argv, options, real) => {
            if (argv.includes('fetch') && down) return { code: 128, signal: null, stdout: Buffer.alloc(0), stderr: 'fatal: unreachable', killed: null };
            /* Killed before it reached the remote, the remote silent after. */
            if (argv.includes('push') && lost) { down = true; return { code: null, signal: 'SIGKILL', killed: 'deadline', stdout: Buffer.alloc(0), stderr: '' }; }
            return real(argv, options);
        },
    });
    b.auto({ branches: 'main', quietSeconds: 0, perHour: 10 });
    /* The remote down for a moment: not sent, said once ... */
    down = true;
    const one = b.commit('a.txt', 'a\n', 'one');
    await settle(b);
    assert.match(b.log()[0].what, /remote is unreachable/);
    await b.keeper.tick();
    assert.equal(b.log().filter((l) => /unreachable/.test(l.what)).length, 1, 'said once while it lasts');
    /* ... and sent once it answers again, after the pause between tries. */
    down = false;
    await b.keeper.tick();
    assert.notEqual(git(b.remote, 'rev-parse', 'refs/heads/main'), one, 'not at every tick');
    b.later(RETRY_MS / 60_000); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), one, 'tried again: sent');
    /* Outcome unknown, the remote silent: blocked; a refresh then says it did not arrive: sent again. */
    lost = true;
    const two = b.commit('b.txt', 'b\n', 'two');
    await settle(b);
    assert.deepEqual(b.keeper.about('site').blocked, ['main']);
    lost = false; down = false;
    await b.keeper.refresh('site');
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(b.log().some((l) => /did not arrive \(settled by a refresh\): it can be sent again/.test(l.what)));
    await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), two, 'as the log said: sent again');
});

test('a grave failure tells the phone once, whatever the option for routine notices; a host or space failure once while it lasts', async (t) => {
    /* Sending: the outcome unknown and the remote silent is grave. */
    let silent = false; let pushed = false;
    const b = await bench(t, {
        wrap: async (argv, options, real) => {
            if (argv.includes('push') && silent) { pushed = true; return { code: null, signal: 'SIGKILL', killed: 'deadline', stdout: Buffer.alloc(0), stderr: '' }; }
            if (argv.includes('fetch') && silent && pushed) return { code: 128, signal: null, stdout: Buffer.alloc(0), stderr: 'fatal: unreachable', killed: null };
            return real(argv, options);
        },
    });
    b.auto({ branches: 'main', quietSeconds: 0, perHour: 10 }); b.keeper.set('site', { alert: false });
    await b.keeper.refresh('site');
    b.commit('a.txt', 'a\n', 'one');
    silent = true;
    await settle(b);
    assert.deepEqual(b.told.map((m) => m.title), ['site: sending needs a look'], 'told although routine notices are off, and once');
    /* Reading: the host program failing tells the phone once, not at every read. */
    const host = await bench(t, { readCode: 79 });
    host.auto({ branches: 'main' });
    for (let i = 0; i < 4; i++) { host.later(11); await host.keeper.tick(); }
    assert.deepEqual(host.told.map((m) => m.title), ['site: the host needs a look']);
    assert.equal(host.log().length, 1);
    /* No room for a read: the same. */
    const room = await bench(t, { reserve: Number.MAX_SAFE_INTEGER });
    room.auto({ branches: 'main' });
    for (let i = 0; i < 4; i++) { room.later(11); await room.keeper.tick(); }
    assert.deepEqual(room.told.map((m) => m.title), ['site: the host needs a look']);
    assert.equal(room.log().length, 1);
});

test('a line for the agent that reached nobody is said again; one that was heard, once', async (t) => {
    let heard = false;
    const b = await bench(t, { readCode: 67, heard: () => heard });
    b.auto({ branches: 'main' });
    await b.keeper.tick();
    await new Promise((done) => setTimeout(done, 20));
    b.later(11); await b.keeper.tick();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(b.agent.length, 2, 'nobody heard it: said again');
    heard = true;
    b.later(11); await b.keeper.tick();
    await new Promise((done) => setTimeout(done, 20));
    b.later(11); await b.keeper.tick();
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(b.agent.length, 3, 'heard: not said again');
});

test('a first automatic sending with no reference yet (no refresh asked for) is sent, never "the remote moved"', async (t) => {
    const b = await bench(t);
    b.auto({ branches: 'main', quietSeconds: 0 }); b.keeper.set('site', { refreshMinutes: 0 });
    const head = b.commit('a.txt', 'a\n', 'one');
    await settle(b);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), head);
    assert.match(b.log()[0].what, /Sent automatically for alpha: 1 commit\(s\) to main, checks passed/);
});

test('lock files a stopped server left in a reference are removed at start, under its lock, and said', async (t) => {
    const b = await bench(t, { machineFor: async () => undefined });
    await b.keeper.refresh('site');
    const reference = b.resources.originPath('site');
    writeFileSync(join(reference, 'packed-refs.lock'), '');
    const timer = b.keeper.start(3_600_000);
    t.after(() => clearInterval(timer));
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(existsSync(join(reference, 'packed-refs.lock')), false);
    assert.match(b.log()[0].what, /Stale lock files .* removed: packed-refs\.lock/);
    assert.equal((await b.keeper.refresh('site')).origin.ok, true, 'the next refresh works');
});

/* The decision used to be made before the send, with the default branch of
   then, and never looked at again: a branch that became the remote's
   default meanwhile went out unconfirmed. */
test('automatic sending is decided again after the send\'s own refresh: a branch that just became the remote\'s default is not sent unconfirmed', async (t) => {
    const b = await bench(t);
    await b.keeper.refresh('site');
    assert.equal(b.review.defaultBranch('site'), 'main');
    b.keeper.set('site', { refreshMinutes: 0 });
    git(b.seed, 'push', '--quiet', 'origin', 'main:develop');
    git(b.work, 'checkout', '--quiet', '-b', 'develop');
    const mine = b.commit('d.txt', 'd\n', 'develop');
    b.auto({ branches: 'develop', quietSeconds: 0 });
    assert.deepEqual(b.keeper.auto('site', 'alpha').settings.confirmed, [], 'not the default branch when saved: nothing to confirm');
    /* The remote now says develop is its default branch; known here only a day later, at a refresh. */
    git(b.remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    b.later(25 * 60);
    await settle(b);
    assert.equal(b.review.defaultBranch('site'), 'develop', 'learnt by the send\'s refresh');
    assert.notEqual(git(b.remote, 'rev-parse', 'refs/heads/develop'), mine, 'not sent');
    assert.ok(b.log().some((l) => l.ok === false && /may not be sent automatically/.test(l.what)), JSON.stringify(b.log()));
});

/* One folder, two writers: allowed, never silently. Both orders. */
test('a list of automatic sending next to another writer of the same folder is confirmed, in both orders, and the panel says so', async (t) => {
    const b = await bench(t);
    await b.keeper.refresh('site');
    /* A list first, then a second writer. */
    b.auto({ branches: 'try/*' });
    assert.throws(() => b.keeper.beforeWriter('site', 'beta', false), (e) => e.kind === 'confirm-shared' && e.status === 409 && /Other conversations write in this same folder/.test(e.message));
    assert.doesNotThrow(() => b.keeper.beforeWriter('site', 'beta', true), 'confirmed: allowed');
    assert.doesNotThrow(() => b.keeper.beforeWriter('site', 'alpha', false), 'already a writer: nothing new');
    assert.doesNotThrow(() => b.keeper.beforeWriter('nope', 'beta', false), 'not a repository: nothing to say');
    await b.resources.attach('beta', 'site', 'write');
    assert.deepEqual(b.keeper.auto('site', 'alpha').sharedWith, ['beta'], 'the panel names the other writers');
    /* A second writer first, then a list. */
    assert.throws(() => b.keeper.setAuto('site', 'beta', { branches: 'feat/*', sure: true }), (e) => e.kind === 'confirm-shared' && /alpha/.test(e.message) && /their commits can be sent by this setting/.test(e.message));
    assert.deepEqual(b.keeper.auto('site', 'beta').settings.branches, [], 'refused: nothing saved');
    assert.deepEqual(b.keeper.setAuto('site', 'beta', { branches: 'feat/*', sure: true, shared: true }).settings.branches, ['feat/*']);
    assert.doesNotThrow(() => b.keeper.setAuto('site', 'beta', { branches: '' }), 'an empty list needs nobody\'s word');
    /* No list anywhere: a second writer needs no confirmation. */
    b.keeper.setAuto('site', 'alpha', { branches: '' });
    assert.doesNotThrow(() => b.keeper.beforeWriter('site', 'gamma', false));
});

test('what happens to a repository is said in the chat of the conversations it is attached to: a sending for the one it was for, a refusal with what to do, a send by hand, commits from the origin', async (t) => {
    let verdict = 'passed';
    const b = await bench(t, { checks: () => verdict });
    await b.resources.attach('beta', 'site', 'read');
    await b.keeper.refresh('site');
    assert.deepEqual(b.lines, [], 'the first fetch of the origin is not news');
    git(b.work, 'checkout', '--quiet', '-b', 'try/one');
    b.commit('a.txt', 'a\n', 'one'); b.commit('b.txt', 'b\n', 'two');
    b.auto({ branches: 'try/*', quietSeconds: 0 });
    await settle(b); b.later(1); await b.keeper.tick();
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/one'), git(b.work, 'rev-parse', 'HEAD'));
    /* The sending: alpha's alone, whose settings sent it; its own refresh brings nothing "new". */
    const tip = git(b.work, 'rev-parse', 'HEAD');
    /* The commit it names is its first seven characters (the page makes them a link); a new branch has no "See the commits". */
    assert.deepEqual(b.lines, [['alpha', { kind: 'sent', text: `Sent to try/one of site: 2 commits (up to ${tip.slice(0, 7)}) (a new branch), checks passed.`, topic: 'Sent', brief: 'try/one', actions: ['review:site'] }]]);
    /* Refused: checks that failed, with what to do; once for that commit. */
    b.lines.length = 0; verdict = 'failed';
    b.commit('c.txt', 'c\n', 'three');
    await settle(b); b.later(1); await b.keeper.tick(); b.later(1); await b.keeper.tick();
    assert.deepEqual(b.lines, [['alpha', { kind: 'refused', text: 'Not sent to try/one of site: the checks failed in the machine of alpha. The agent was told; see the checks in the review.', tone: 'warn', topic: 'Not sent', brief: 'try/one', actions: ['review:site'] }]]);
    /* A branch outside every list: nothing asked, nothing said. */
    b.lines.length = 0; verdict = 'passed';
    git(b.work, 'checkout', '--quiet', '-b', 'scratch');
    b.commit('d.txt', 'd\n', 'four');
    await settle(b); b.later(1); await b.keeper.tick();
    assert.deepEqual(b.lines, []);
    /* A branch to create, not allowed: said with what to do. */
    b.auto({ branches: 'try/*, scratch', quietSeconds: 0, create: false });
    b.later(1); await b.keeper.tick(); b.later(1); await b.keeper.tick();
    /* (The new settings also let try/one go again, its checks passing now.) */
    const scratch = b.lines.filter(([, e]) => e.brief === 'scratch');
    assert.deepEqual(scratch.map(([c, e]) => [c, e.kind]), [['alpha', 'refused']]);
    assert.match(scratch[0][1].text, /^Not sent to scratch of site: scratch does not exist on the remote, and alpha may not create branches by itself\. Make the branch on the remote/);
    /* Sent by hand from the review: said wherever it is attached, reading included. */
    b.lines.length = 0;
    git(b.work, 'checkout', '--quiet', 'main');
    const before = git(b.remote, 'rev-parse', 'refs/heads/main');
    const head = b.commit('e.txt', 'e\n', 'five');
    await b.review.outgoing('site');
    await b.keeper.send('site', { head, target: 'main' });
    const byHand = `Sent by hand to main of site: 1 commit (up to ${head.slice(0, 7)}).`;
    assert.deepEqual(b.lines.map(([c, e]) => [c, e.kind, e.text, e.brief]), [['alpha', 'sent-by-hand', byHand, 'main'], ['beta', 'sent-by-hand', byHand, 'main']]);
    /* "See the commit(s)": from the tip the remote had to the one sent. */
    assert.deepEqual(b.lines[0][1].actions, [`commits:site.${head.slice(0, 12)}.${before.slice(0, 12)}.1`, 'review:site']);
    /* The origin brings commits made elsewhere: said, for the record, wherever it is attached; detached, nothing. */
    b.lines.length = 0;
    b.theirs('main', 'x.txt'); b.theirs('main', 'y.txt'); b.theirs('try/one', 'z.txt');
    await b.resources.attach('beta', 'site', 'none');
    await b.keeper.refresh('site');
    const tipOf = (branch) => git(b.remote, 'rev-parse', `refs/heads/${branch}`).slice(0, 7);
    assert.deepEqual(b.lines, [['alpha', { kind: 'origin', text: `Origin of site updated: 3 new commits (2 on main (up to ${tipOf('main')}), 1 on try/one (up to ${tipOf('try/one')})).`, topic: 'Origin updated', brief: 'site', actions: ['review:site'] }]]);
    b.lines.length = 0;
    await b.keeper.refresh('site');
    assert.deepEqual(b.lines, [], 'nothing new: nothing said');
});
