/* The health of a machine: what is looked at, what is said, and the folders
   that came loose, put back -- never on a machine that does not run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Health, PROBE, PROBE_NAME, readProbe, judge } from '../server/health.mjs';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Grants } from '../server/grants.mjs';

test('the probe, run for real here, says memory, kills, disk, and which paths are mounted and readable', () => {
    const r = spawnSync('sh', ['-c', PROBE, PROBE_NAME, '/proc', '/no/such/mount'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const facts = readProbe(r.stdout);
    assert.ok(facts.memory.totalMb > 0 && facts.memory.availableMb > 0, r.stdout);
    assert.ok(Number.isInteger(facts.oomKills));
    assert.ok(facts.disks['/'].sizeMb > 0);
    assert.deepEqual(facts.mounts, { '/proc': 'ok', '/no/such/mount': 'missing' });
});

test('a path is an argument of the probe, never shell text', () => {
    const r = spawnSync('sh', ['-c', PROBE, PROBE_NAME, '/x; echo pwned', '$(echo pwned)'], { encoding: 'utf8' });
    assert.doesNotMatch(r.stdout.replace(/mount missing .*/g, ''), /pwned/);
    assert.deepEqual(readProbe(r.stdout).mounts, {}, 'a path with a space is not one of ours: its line is not read');
});

test('what is said: the state, a machine that does not answer, memory, disk, folders', () => {
    assert.equal(judge({ state: 'Running', answering: true, oomKills: 0, memory: { totalMb: 2048, availableMb: 1200 }, disks: { '/': { availableMb: 4000, sizeMb: 8000 } } }).level, 'ok');
    assert.deepEqual(judge({ state: 'Suspended' }), { level: 'info', problems: [{ level: 'info', text: 'Its machine is asleep. It wakes when you open the conversation.' }] });
    assert.equal(judge({ state: 'Unknown' }).level, 'bad');
    assert.equal(judge({ state: undefined }).problems[0].text, 'Its machine no longer exists.');
    assert.equal(judge({ state: 'Running', answering: false }).problems[0].text, 'Its machine does not answer. Restarting it usually helps.');
    const full = judge({ state: 'Running', answering: true, oomKills: 3, memory: { totalMb: 1024, availableMb: 30 }, disks: { '/': { availableMb: 100, sizeMb: 8000 }, '/work': { availableMb: 50, sizeMb: 10000 } } });
    assert.equal(full.level, 'warn');
    assert.deepEqual(full.problems.map((p) => p.text), [
        'It ran out of memory 3 times since it started: a program was stopped by the system. Give it more memory (Machine).',
        'Its memory is almost full: 30 MB free of 1024 MB.',
        'Its disk is almost full: 100 MB left of 8000 MB.',
        'Its work folder (/work) is almost full: 50 MB left of 10000 MB.',
    ]);
    const folders = judge({ state: 'Running', answering: true, remounted: ['/work'], failed: [{ path: '/resources/a', why: 'refused' }], missing: ['/resources/a'] });
    assert.equal(folders.level, 'bad');
    assert.deepEqual(folders.problems.map((p) => p.text), ['/work had come loose in the machine: it was mounted again.', '/resources/a is not reachable in the machine and could not be mounted again: refused.']);
});

/* A machine played by the test: its state, what its probe prints, what the VM manager is asked. */
function machine(t, { state = 'Running', mounted = ['/work', '/resources/reports'], dead = [], silent = false, phase = 'ready' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-health-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const box = { state, dead: new Set(dead), mounted: new Set(mounted) };
    const vms = {
        state: async () => box.state,
        exec: async (_name, argv) => {
            calls.push(`exec ${argv[0]}`);
            if (silent) return { code: 1, stdout: '', stderr: 'timed out' };
            const lines = ['memory 2097152 1048576', 'oom 0', 'disk / 5000 8000'];
            for (const p of argv.slice(4)) lines.push(`mount ${box.mounted.has(p) && !box.dead.has(p) ? 'ok' : 'missing'} ${p}`);
            return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
        },
        umount: async (_c, name) => { calls.push(`umount ${name}`); box.dead.delete(`/resources/${name}`); box.mounted.delete(`/resources/${name}`); return { code: 0, stdout: '', stderr: '' }; },
        mount: async (_c, kind, name) => {
            calls.push(`mount ${kind} ${name}`);
            if (box.mounted.has(`/resources/${name}`)) return { code: 1, stdout: '', stderr: 'already mounted' };
            box.mounted.add(`/resources/${name}`); return { code: 0, stdout: '', stderr: '' };
        },
        workUnmount: async () => { calls.push('unwork'); box.dead.delete('/work'); box.mounted.delete('/work'); return { code: 0 }; },
        workMake: async () => { calls.push('work make'); return { code: 0 }; },
        workMount: async () => { calls.push('mount work'); box.mounted.add('/work'); return { code: 0, stdout: '', stderr: '' }; },
    };
    const grants = new Grants();
    const host = async () => ({ code: 0, stdout: '', stderr: '' });
    const store = new Store(join(dir, 'resources.json'));
    const resources = new Resources({ store, vms, host, dataDir: dir, grants, uid: 1, gid: 2 });
    const records = new Map([['demo', { name: 'demo', phase, work: 'kept' }]]);
    const conversations = { get: (n) => records.get(n), awake: () => [...records.keys()] };
    const health = new Health({ vms, conversations, resources, settleMs: 5 });
    return { health, calls, box, resources, grants, dir, store };
}
const attach = (m, name, access) => {
    m.store.put({ name, type: 'folder' });
    m.grants.give('conversation:demo', `folder:${name}`, access === 'write' ? 'rw' : 'r');
};

test('everything in place: one probe, nothing touched', async (t) => {
    const m = machine(t);
    attach(m, 'reports', 'write');
    const seen = await m.health.check('demo');
    assert.equal(seen.level, 'ok');
    assert.deepEqual(m.calls, ['exec sh']);
    assert.deepEqual(m.health.of('demo').missing, []);
});

test('a folder the VM manager believes mounted but whose link died is unmounted, then mounted again as it was', async (t) => {
    const m = machine(t, { dead: ['/resources/reports', '/work'] });
    attach(m, 'reports', 'write');
    const seen = await m.health.check('demo');
    assert.deepEqual(m.calls, ['exec sh', 'exec sh', 'unwork', 'work make', 'mount work', 'umount reports', 'mount folder reports', 'exec sh']);
    assert.deepEqual(seen.remounted, ['/work', '/resources/reports']);
    assert.equal(seen.level, 'info');
    assert.deepEqual(seen.missing, []);
});

test('a folder attached to read comes back as its read-only view', async (t) => {
    const m = machine(t, { mounted: ['/work'] });
    attach(m, 'papers', 'read');
    await m.health.check('demo');
    assert.ok(m.calls.includes('mount view papers'), m.calls.join(', '));
});

test('a folder that cannot be put back is said, with why', async (t) => {
    const m = machine(t, { mounted: ['/work'] });
    attach(m, 'reports', 'write');
    m.resources.repair = async () => 'refused by the VM manager';
    const seen = await m.health.check('demo');
    assert.equal(seen.level, 'bad');
    assert.deepEqual(seen.failed, [{ path: '/resources/reports', why: 'refused by the VM manager' }]);
});

test('without repairing, a missing folder is only said', async (t) => {
    const m = machine(t, { dead: ['/work'] });
    const seen = await m.health.check('demo', { repair: false });
    assert.deepEqual(m.calls, ['exec sh']);
    assert.deepEqual(seen.missing, ['/work']);
    assert.equal(seen.level, 'warn');
});

test('a machine asleep, stopped or being restarted is never touched: only its state is said', async (t) => {
    for (const state of ['Suspended', 'Stopped', 'Starting']) {
        const m = machine(t, { state, dead: ['/work'] });
        const seen = await m.health.check('demo');
        assert.deepEqual(m.calls, [], state);
        assert.equal(seen.state, state);
    }
    const busy = machine(t, { phase: 'restarting', dead: ['/work'] });
    assert.equal((await busy.health.check('demo')).state, 'Restarting');
    assert.deepEqual(busy.calls, []);
});

test('a machine that went to sleep between two looks is not repaired', async (t) => {
    const m = machine(t, { dead: ['/work'] });
    let asked = 0;
    Object.defineProperty(m.box, 'state', { get: () => (asked++ === 0 ? 'Running' : 'Suspended') });
    await m.health.check('demo');
    assert.deepEqual(m.calls, ['exec sh', 'exec sh'], 'looked at, never touched');
});

test('a machine that does not answer is said to', async (t) => {
    const m = machine(t, { silent: true });
    const seen = await m.health.check('demo');
    assert.equal(seen.answering, false);
    assert.equal(seen.level, 'bad');
});

test('two looks asked at once are one look', async (t) => {
    const m = machine(t);
    const [a, b] = await Promise.all([m.health.check('demo'), m.health.check('demo')]);
    assert.equal(a, b);
    assert.deepEqual(m.calls, ['exec sh']);
});
