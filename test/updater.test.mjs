/* THE UPDATER (deploy/updater.mjs) against a stand-in registry (fake-registry.mjs):
   real npm installs, real checks of integrity and provenance, real releases
   and links in a folder of the test. What only a real machine has -- npm's
   signature check, systemd, the backup, the privileged programs, Node.js
   downloads -- is stood in for, and recorded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fakeRegistry } from './fake-registry.mjs';
import { Updater, Refused, compareVersions, inWindow, readConf, writeConf, DROP_IN_TEXT } from '../deploy/updater.mjs';

const PARLEY_REPO = 'https://github.com/clavarium/clavarium-parley';

async function setup(t) {
    const reg = await fakeRegistry();
    const root = mkdtempSync(join(tmpdir(), 'clv-update-'));
    t.after(() => { reg.close(); rmSync(root, { recursive: true, force: true }); });
    const parley = reg.publish('clavarium-parley', '0.9.0', { 'bin/parley.mjs': 'console.log("0.9.0")\n' }, { repo: PARLEY_REPO });
    const shrink = (version) => JSON.stringify({ name: 'clavarium', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'clavarium', version, dependencies: { 'clavarium-parley': '0.9.0' } }, 'node_modules/clavarium-parley': { version: '0.9.0', resolved: parley.tarball, integrity: parley.integrity } } });
    /* A Clavarium as small as can be: its smoke test passes, or fails on purpose. */
    const publish = (version, { smoke = true, dataFormat = 1, repo, attest, tag } = {}) => reg.publish('clavarium', version, {
        'npm-shrinkwrap.json': shrink(version),
        'server/smoke.mjs': smoke ? 'console.log("smoke: ok")\n' : 'console.error("broken on purpose"); process.exit(1);\n',
        'server/tools.mjs': "export const NODE_VERSION = 'v24.20.0';\n",
        'deploy/clavarium-host': '#!/bin/bash\n',
    }, { packageJson: { clavarium: { dataFormat }, dependencies: { 'clavarium-parley': '0.9.0' } }, repo, attest, ...(tag === undefined ? {} : { tag }) });
    const dirs = { code: join(root, 'opt'), conf: join(root, 'etc', 'update.conf'), stateDir: join(root, 'state'), data: join(root, 'data') };
    mkdirSync(dirs.data, { recursive: true });
    const calls = []; const broken = new Set();
    let clock = new Date(2026, 9, 18, 12, 0);
    /* What systemd says of the server, and whether it answers: up, unless a test says otherwise. */
    const service = { state: 'active', answers: true };
    const u = new Updater({
        ...dirs, registry: reg.origin, log: () => {}, now: () => clock, minFreeMb: 1,
        verifySignatures: async (dir) => { calls.push(`signatures ${basename(dir)}`); return { code: 0 }; },
        restart: async () => { calls.push('restart'); return { code: 0 }; },
        health: async (release) => { calls.push(`health ${release.version}`); return broken.has(release.version) ? 'it did not answer' : ''; },
        backup: async () => { calls.push('backup'); return join(root, 'backup.tgz'); },
        restoreData: async () => { calls.push('restore'); return { code: 0 }; },
        installPrivileged: async (app) => { calls.push(`privileged ${realpathSync(app).split('/releases/')[1].split('/')[0]}`); },
        /* The Node.js of this test, for every release. */
        ensureNode: async () => dirname(dirname(process.execPath)),
        diagnose: async () => 'journal: it said why',
        dropIn: join(root, 'systemd', 'clavarium.service.d', 'restart.conf'),
        serviceState: async () => service.state,
        answers: async () => service.answers,
    });
    return { reg, u, dirs, calls, broken, publish, parley, service, at: (d) => { clock = d; }, current: () => basename(realpathSync(join(dirs.code, 'current'))) };
}

/* The first installation, as install.sh makes it: a release, then the link. */
async function installed(s, version = '1.0.0') {
    s.publish(version);
    const r = await s.u.prepare({ version });
    s.u.switchTo(r.id);
    s.calls.length = 0;
    return r;
}

test('versions compare as npm does; a window may pass midnight; settings keep their shapes', () => {
    assert.equal(compareVersions('0.1.0-next.2', '0.1.0-next.10'), -1);
    assert.equal(compareVersions('0.1.0', '0.1.0-next.3'), 1);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(inWindow('02:00-05:00', new Date(2026, 0, 1, 3, 0)), true);
    assert.equal(inWindow('02:00-05:00', new Date(2026, 0, 1, 5, 0)), false);
    assert.equal(inWindow('23:00-01:00', new Date(2026, 0, 1, 0, 30)), true);
    const dir = mkdtempSync(join(tmpdir(), 'clv-conf-'));
    try {
        const file = join(dir, 'update.conf');
        assert.deepEqual(readConf(file), { MODE: 'auto', CHANNEL: 'latest', WINDOW: '02:00-05:00', PORT: '7717' });
        writeConf(file, 'mode', 'asap'); writeConf(file, 'window', '01:30-04:00');
        assert.deepEqual(readConf(file), { MODE: 'asap', CHANNEL: 'latest', WINDOW: '01:30-04:00', PORT: '7717' });
        for (const [k, v] of [['mode', 'sometimes'], ['channel', 'beta'], ['window', '02:00-02:00'], ['window', '2:00-5:00'], ['registry', 'http://x']]) assert.throws(() => writeConf(file, k, v), Refused, `${k} ${v}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a release: an exact version from the registry, checked before any of its code runs, built, tried; Parley for the machines from the lock', async (t) => {
    const s = await setup(t);
    s.publish('1.0.0');
    const r = await s.u.prepare({ version: '1.0.0' });
    assert.equal(r.id, '1.0.0');
    assert.equal(JSON.parse(readFileSync(join(r.app, 'package.json'), 'utf8')).version, '1.0.0');
    assert.deepEqual(s.calls, ['signatures .1.0.0.partial'], 'npm audit signatures, on the release as npm installed it');
    const archive = join(r.app, 'toolbox', 'clavarium-parley-0.9.0.tgz');
    assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, s.parley.integrity, 'the archive the registry serves, as the lock records it');
    assert.equal(JSON.parse(readFileSync(join(r.dir, 'release.json'), 'utf8')).source, 'npm');
    assert.equal(existsSync(join(s.dirs.stateDir, 'npm-cache')), false, "npm's cache does not stay");
    s.u.switchTo(r.id);
    assert.equal(s.current(), '1.0.0');
    assert.equal(s.u.about().version, '1.0.0');
});

test('refused before anything changes: built elsewhere, no provenance, a smoke test that fails', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.1.0', { repo: 'https://github.com/someone/fork' });
    await assert.rejects(s.u.apply('1.1.0'), /was built from https:\/\/github\.com\/someone\/fork, not https:\/\/github\.com\/clavarium\/clavarium/);
    s.publish('1.1.1', { attest: false });
    await assert.rejects(s.u.apply('1.1.1'), /has no provenance/);
    s.publish('1.1.2', { smoke: false });
    await assert.rejects(s.u.apply('1.1.2'), /smoke test failed: broken on purpose/);
    assert.equal(s.current(), '1.0.0');
    assert.deepEqual(s.calls.filter((c) => !c.startsWith('signatures')), [], 'no backup, no restart');
    assert.deepEqual(readdirSync(join(s.dirs.code, 'releases')), ['1.0.0'], 'nothing half made is left');
    assert.deepEqual(s.u.about().history.map((h) => `${h.to} ${h.result}`), ['1.1.2 failed', '1.1.1 failed', '1.1.0 failed']);
    /* Not newer, not a version: refused by name. */
    await assert.rejects(s.u.apply('0.9.0'), /not newer than 1\.0\.0/);
    await assert.rejects(s.u.apply('1.0.0; id'), Refused);
});

test('check: what is out on the channel; "next" also sees a newer stable version', async (t) => {
    const s = await setup(t);
    await installed(s);
    assert.equal(await s.u.check(), null, 'up to date');
    s.publish('1.0.1-next.1');
    assert.equal(await s.u.check(), null, 'latest does not see a pre-release');
    s.u.set('channel', 'next');
    assert.equal(await s.u.check(), '1.0.1-next.1');
    s.publish('1.0.1');
    assert.equal(await s.u.check(), '1.0.1', 'the stable one is newer than the pre-release');
    assert.equal(s.u.about().available, '1.0.1');
    assert.ok(s.u.about().checkedAt);
});

test('an update: made beside, backed up, switched, restarted, healthy; the last two releases are kept', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    await s.u.apply('1.0.1');
    assert.equal(s.current(), '1.0.1');
    assert.deepEqual(s.calls, ['signatures .1.0.1.partial', 'backup', 'privileged 1.0.1', 'restart', 'health 1.0.1']);
    s.publish('1.0.2');
    await s.u.apply('1.0.2');
    assert.deepEqual(readdirSync(join(s.dirs.code, 'releases')).sort(), ['1.0.1', '1.0.2'], 'the oldest one went');
    const about = s.u.about();
    assert.deepEqual(about.history.map((h) => `${h.from}->${h.to} ${h.result}`), ['1.0.1->1.0.2 done', '1.0.0->1.0.1 done']);
    assert.equal(about.running, null);
    assert.deepEqual(about.releases.map((r) => `${r.id}${r.current ? '*' : ''}`), ['1.0.2*', '1.0.1']);
});

test('an update that does not come up: back to what ran, by itself, and said; not tried again by itself', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    s.broken.add('1.0.1');
    await s.u.apply('1.0.1');
    assert.equal(s.current(), '1.0.0');
    assert.deepEqual(s.calls, ['signatures .1.0.1.partial', 'backup', 'privileged 1.0.1', 'restart', 'health 1.0.1', 'privileged 1.0.0', 'restart', 'health 1.0.0']);
    const [last] = s.u.about().history;
    assert.equal(last.result, 'rolled-back'); assert.equal(last.why, 'it did not answer');
    assert.match(last.log, /1\.0\.1 did not come up: it did not answer\njournal: it said why/, 'what was seen is kept, for "See the log"');
    assert.deepEqual(readdirSync(join(s.dirs.code, 'releases')), ['1.0.0'], 'the release that failed is removed');
    /* The timer sees it again: not tried by itself. */
    s.u.set('mode', 'asap');
    assert.equal(await s.u.tick(), '1.0.1 failed here before: not tried again by itself');
    /* The data moved in the meantime (its format): the backup is put back. */
    s.calls.length = 0;
    s.publish('1.0.2', { dataFormat: 2 });
    s.broken.add('1.0.2');
    writeFileSync(join(s.dirs.data, 'data-format.json'), '{"format":1}');
    const was = s.u.health;
    s.u.health = async (r) => { if (r.version === '1.0.2') writeFileSync(join(s.dirs.data, 'data-format.json'), '{"format":2}'); return was(r); };
    await s.u.apply('1.0.2');
    assert.ok(s.calls.includes('restore'), JSON.stringify(s.calls));
});

test('never while a machine is being built, moved or restarted', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    writeFileSync(join(s.dirs.data, 'conversations.json'), JSON.stringify([{ name: 'alpha', phase: 'ready' }, { name: 'beta', phase: 'building' }]));
    await assert.rejects(s.u.apply('1.0.1'), /a machine is being built or restarted \(beta\): the update waits/);
    s.u.set('mode', 'asap');
    assert.match(await s.u.tick(), /being built/);
    assert.equal(s.current(), '1.0.0');
    writeFileSync(join(s.dirs.data, 'conversations.json'), JSON.stringify([{ name: 'beta', phase: 'ready' }]));
    assert.equal(await s.u.tick(), 'updated to 1.0.1');
});

test('the timer does what the mode says: off, a window, as soon as out, ask; a request from the host program comes first', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    s.u.set('mode', 'off');
    assert.equal(await s.u.tick(), 'off');
    s.u.set('mode', 'auto');
    s.at(new Date(2026, 9, 18, 12, 0));
    assert.equal(await s.u.tick(), 'outside the window');
    s.u.set('mode', 'ask');
    assert.equal(await s.u.tick(), '1.0.1 is out: waiting for the owner');
    assert.equal(await s.u.tick(), 'checked lately');
    assert.equal(s.current(), '1.0.0');
    s.u.set('mode', 'auto');
    s.at(new Date(2026, 9, 19, 3, 0));
    assert.equal(await s.u.tick(), 'updated to 1.0.1');
    /* "Go back to 1.0.0", asked through the host program. */
    writeFileSync(join(s.dirs.stateDir, 'request'), 'rollback 1.0.0\n');
    await s.u.runOnce();
    assert.equal(s.current(), '1.0.0');
    assert.equal(existsSync(join(s.dirs.stateDir, 'request')), false);
    assert.equal(s.u.about().history[0].action, 'back');
    /* After what the administrator asked, the registry is asked once more: back on 1.0.0, 1.0.1 is offered again. */
    assert.equal(s.u.about().available, '1.0.1');
    /* An update asked through the interface: once it runs, it is not offered again. */
    writeFileSync(join(s.dirs.stateDir, 'request'), 'apply 1.0.1\n');
    await s.u.runOnce();
    assert.equal(s.current(), '1.0.1');
    assert.equal(s.u.about().available, null, 'the version that runs is not offered');
    /* And a newer one out meanwhile is offered at once, without waiting for the timer. */
    s.publish('1.0.2');
    writeFileSync(join(s.dirs.stateDir, 'request'), 'apply 1.0.1\n');
    await s.u.runOnce();
    assert.equal(s.u.about().available, '1.0.2');
});

test('going back: only to a release that is kept, and that can read the data', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1', { dataFormat: 2 });
    await s.u.apply('1.0.1');
    await assert.rejects(s.u.rollback('0.9.0'), /not kept here/);
    await assert.rejects(s.u.rollback('1.0.1'), /the release that runs/);
    writeFileSync(join(s.dirs.data, 'data-format.json'), '{"format":2}');
    await assert.rejects(s.u.rollback('1.0.0'), /1\.0\.0 cannot read the data of this version \(format 2; it reads 1\)/);
    writeFileSync(join(s.dirs.data, 'data-format.json'), '{"format":1}');
    /* It does not come up: back again on what ran. */
    s.broken.add('1.0.0');
    await s.u.rollback('1.0.0');
    assert.equal(s.current(), '1.0.1');
    assert.equal(s.u.about().history[0].result, 'failed');
    s.broken.delete('1.0.0');
    await s.u.rollback('1.0.0');
    assert.equal(s.current(), '1.0.0');
});

test('for development, a release from a working tree: copied, installed from its lock file, tried; not checked against the registry', async (t) => {
    const s = await setup(t);
    const tree = join(s.dirs.data, '..', 'tree');
    mkdirSync(join(tree, 'server'), { recursive: true });
    writeFileSync(join(tree, 'server', 'smoke.mjs'), 'console.log("smoke: ok")\n');
    writeFileSync(join(tree, 'server', 'tools.mjs'), "export const NODE_VERSION = 'v24.20.0';\n");
    writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'clavarium', version: '1.1.0-dev', clavarium: { dataFormat: 1 }, dependencies: { 'clavarium-parley': '0.9.0' } }));
    writeFileSync(join(tree, 'package-lock.json'), JSON.stringify({ name: 'clavarium', version: '1.1.0-dev', lockfileVersion: 3, requires: true, packages: { '': { name: 'clavarium', version: '1.1.0-dev', dependencies: { 'clavarium-parley': '0.9.0' } }, 'node_modules/clavarium-parley': { version: '0.9.0', resolved: s.parley.tarball, integrity: s.parley.integrity } } }));
    const r = await s.u.prepare({ fromDir: tree });
    assert.match(r.id, /^local-\d{8}-\d{6}$/);
    assert.equal(r.version, '1.1.0-dev'); assert.equal(r.source, 'local');
    assert.ok(existsSync(join(r.app, 'node_modules', 'clavarium-parley', 'package.json')));
    assert.ok(existsSync(join(r.app, 'toolbox', 'clavarium-parley-0.9.0.tgz')));
    assert.deepEqual(s.calls, [], 'no signature check: it is not from the registry');
});

test('a busy phase holds an update back only while the server runs, and only for 30 minutes', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    s.u.set('mode', 'asap');
    const at = (min) => new Date(new Date(2026, 9, 18, 12, 0).getTime() - min * 60_000).toISOString();
    writeFileSync(join(s.dirs.data, 'conversations.json'), JSON.stringify([{ name: 'beta', phase: 'restarting', restartingSince: at(5) }, { name: 'gamma', phase: 'building', buildingSince: at(45) }]));
    assert.match(await s.u.busy(), /\(beta\): the update waits/, 'a phase of 45 minutes is not waited for');
    /* The server is down: what its file says is not going on. */
    s.service.state = 'failed';
    assert.equal(await s.u.busy(), '');
    s.service.state = 'activating';
    assert.equal(await s.u.busy(), '');
    s.service.state = 'active';
    writeFileSync(join(s.dirs.data, 'conversations.json'), JSON.stringify([{ name: 'gamma', phase: 'building', buildingSince: at(45) }]));
    assert.equal(await s.u.tick(), 'updated to 1.0.1');
});

test('the watchdog: a server that did not stay up after an update goes back by itself, once; otherwise one restart an hour', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    s.u.set('mode', 'asap');
    assert.equal(await s.u.runOnce(), 'updated to 1.0.1');
    s.calls.length = 0;
    /* Up: nothing. */
    assert.equal(await s.u.runOnce(), 'up to date');
    assert.deepEqual(s.calls, []);
    /* It died after the update looked well (its service failed): back to 1.0.0, by itself. */
    s.at(new Date(2026, 9, 18, 13, 0));
    s.service.state = 'failed';
    assert.match(await s.u.runOnce(), /^1\.0\.1 did not stay up \(its service was failed\): back to 1\.0\.0$/);
    assert.equal(s.current(), '1.0.0');
    assert.deepEqual(s.calls, ['privileged 1.0.0', 'restart', 'health 1.0.0']);
    const [last] = s.u.about().history;
    assert.equal(last.result, 'rolled-back'); assert.equal(last.by, 'watchdog'); assert.equal(last.from, '1.0.0'); assert.equal(last.to, '1.0.1');
    /* Up again on 1.0.0: 1.0.1 is not tried again by itself. */
    s.service.state = 'active';
    s.at(new Date(2026, 9, 18, 13, 15));
    assert.equal(await s.u.runOnce(), '1.0.1 failed here before: not tried again by itself');
    /* Down again within the hour: nothing more by itself (it never loops). */
    s.calls.length = 0;
    s.service.state = 'inactive';
    s.at(new Date(2026, 9, 18, 13, 30));
    await s.u.runOnce();
    assert.deepEqual(s.calls.filter((c) => c === 'restart'), []);
    /* An hour later, no recent update to suspect: one restart, said. */
    s.at(new Date(2026, 9, 18, 14, 5));
    assert.match(await s.u.runOnce(), /^the server was down \(inactive\): restarted by itself$/);
    assert.deepEqual(s.calls, ['restart', 'health 1.0.0']);
    assert.equal(s.u.about().history[0].action, 'restart');
    /* Active but not answering: only on the third turn in a row. */
    s.calls.length = 0;
    s.service.state = 'active'; s.service.answers = false;
    s.at(new Date(2026, 9, 18, 15, 10));
    assert.match((await s.u.watchdog()).said, /turn 1 of 3/);
    assert.match((await s.u.watchdog()).said, /turn 2 of 3/);
    s.service.answers = true;
    assert.equal((await s.u.watchdog()).said, 'up', 'the count starts again');
    s.service.answers = false;
    await s.u.watchdog(); await s.u.watchdog();
    const third = await s.u.watchdog();
    assert.equal(third.acted, true); assert.match(third.said, /no answer/);
    assert.deepEqual(s.calls, ['restart', 'health 1.0.0']);
});

test('the watchdog does not go back to a release that cannot read the data, nor after a day', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1', { dataFormat: 2 });
    await s.u.apply('1.0.1');
    writeFileSync(join(s.dirs.data, 'data-format.json'), '{"format":2}');
    s.calls.length = 0;
    s.service.state = 'failed';
    s.at(new Date(2026, 9, 18, 13, 0));
    assert.match((await s.u.watchdog()).said, /restarted by itself/);
    assert.equal(s.current(), '1.0.1');
    rmSync(join(s.dirs.data, 'data-format.json'));
    s.at(new Date(2026, 9, 20, 13, 0));
    assert.match((await s.u.watchdog()).said, /restarted by itself/, 'an update of two days ago is not suspected');
    assert.equal(s.current(), '1.0.1');
});

test('a lock left by a process that is gone is taken over', async (t) => {
    const s = await setup(t);
    await installed(s);
    s.publish('1.0.1');
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    mkdirSync(s.dirs.stateDir, { recursive: true });
    writeFileSync(join(s.dirs.stateDir, 'lock'), String(gone));
    await s.u.apply('1.0.1');
    assert.equal(s.current(), '1.0.1');
    writeFileSync(join(s.dirs.stateDir, 'lock'), String(process.pid));
    s.publish('1.0.2');
    await assert.rejects(s.u.apply('1.0.2'), /running already/, 'a lock of a living process is not');
    rmSync(join(s.dirs.stateDir, 'lock'));
});

test('health after a switch: it must stay up two minutes; one restart by systemd is forgiven if it answers at the end', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'clv-health-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const release = { dir: join(root, 'r') }; mkdirSync(release.dir);
    /* A story in seconds: what systemd says (pid; 0 = down) at each moment. */
    const run = async (story, answersAtEnd = true) => {
        let ms = 0;
        const at = () => story.filter(([sec]) => sec * 1000 <= ms).at(-1)[1];
        const u = new Updater({
            code: join(root, 'opt'), conf: join(root, 'conf'), stateDir: join(root, 'st'), data: root, log: () => {},
            restart: async () => ({ code: 0 }),
            clock: () => ms, sleep: async (d) => { ms += d; },
            serviceState: async () => (at() ? 'active' : 'activating'),
            answers: async () => !!at() && (answersAtEnd || ms < 120_000),
            mainPid: async () => String(at()),
            pidCwd: () => release.dir,
        });
        return u.health(release);
    };
    assert.equal(await run([[0, 0], [3, 100]]), '');
    assert.equal(await run([[0, 0], [3, 100], [40, 0], [44, 101]]), '', 'one restart, answering at the end');
    assert.match(await run([[0, 0], [3, 100], [40, 0], [44, 101], [80, 0], [84, 102]]), /more than once/);
    assert.match(await run([[0, 0], [3, 100], [100, 0]]), /stopped soon after it started/);
    assert.match(await run([[0, 0]]), /did not answer|stopped/);
    assert.match(await run([[0, 0], [3, 100]], false), /stopped soon after/);
});

test('the drop-in beside the server unit: a crash loop never locks it out; written once', async (t) => {
    const s = await setup(t);
    assert.equal(await s.u.ensureDropIn(), true);
    assert.equal(await s.u.ensureDropIn(), false);
    const text = readFileSync(join(dirname(s.dirs.code), 'systemd', 'clavarium.service.d', 'restart.conf'), 'utf8');
    assert.equal(text, DROP_IN_TEXT);
    assert.match(text, /StartLimitIntervalSec=0/); assert.match(text, /RestartSec=3/);
});
