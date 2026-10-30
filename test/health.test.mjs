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
    const facts = readProbe(r.stdout, ['/proc', '/no/such/mount']);
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
    assert.deepEqual(judge({ state: 'Suspended' }), { level: 'info', problems: [{ level: 'info', kind: 'state', key: 'asleep', text: 'Its machine is asleep. It wakes when you open the conversation.' }] });
    assert.equal(judge({ state: 'Unknown' }).level, 'info', 'a VM manager that does not answer says nothing of the machine (vmwatch.mjs says it of all)');
    assert.equal(judge({ state: undefined }).problems[0].text, 'Its machine no longer exists.');
    assert.equal(judge({ state: 'Running', answering: false }).problems[0].text, 'Its machine does not answer. Restarting it usually helps.');
    const full = judge({ state: 'Running', answering: true, oomKills: 3, oomKinds: { machine: 3, limit: 0 }, memory: { totalMb: 1024, availableMb: 30 }, disks: { '/': { availableMb: 100, sizeMb: 8000 }, '/work': { availableMb: 50, sizeMb: 10000 } } });
    assert.equal(full.level, 'warn');
    assert.deepEqual(full.problems.map((p) => p.text), [
        'The whole machine ran out of memory 3 times since it started: a program in it was stopped. Its files are safe.',
        'Its memory is almost full: 30 MB free of 1024 MB.',
        'Its disk is almost full: 100 MB left of 8000 MB.',
        'Its work folder (/work) is kept on this server, whose disk is almost full: 50 MB left of 10000 MB.',
    ]);
    /* What each is about, and a name that stays the same whatever its numbers (the whole machine short again: a new one). */
    assert.deepEqual(full.problems.map((p) => [p.kind, p.key]), [['memory', 'oom-machine:3'], ['memory', 'memory-low'], ['disk', 'disk:/'], ['server-disk', 'disk:/work']]);
    /* The server's disk, seen through a kept work folder: not this machine's trouble -- every conversation would say it. */
    const shared = judge({ state: 'Running', answering: true, oomKills: 0, memory: { totalMb: 2048, availableMb: 1200 }, disks: { '/': { availableMb: 4000, sizeMb: 8000 }, '/work': { availableMb: 50, sizeMb: 10000 } } });
    assert.equal(shared.level, 'info');
    assert.deepEqual(shared.problems.map((p) => p.level), ['info']);
    /* A program at the limit it was given: noted, quietly; the machine is fine. Not told apart: noted too. */
    const limited = judge({ state: 'Running', answering: true, oomKills: 42, oomKinds: { machine: 0, limit: 42 }, memory: { totalMb: 4096, availableMb: 2200 } });
    assert.equal(limited.level, 'info');
    assert.deepEqual(limited.problems.map((p) => [p.level, p.key, p.text]), [['info', 'oom-limit', '42 programs were stopped at the memory limit given to them, since it started. The machine itself had room.']]);
    assert.equal(judge({ state: 'Running', answering: true, oomKills: 2, memory: { totalMb: 4096, availableMb: 2200 } }).level, 'info');
    assert.equal(judge({ state: 'Running', answering: true, memory: { totalMb: 1024, availableMb: 12 } }).problems[0].key, 'memory-low');
    const folders = judge({ state: 'Running', answering: true, remounted: ['/work'], failed: [{ path: '/resources/a', why: 'refused' }], missing: ['/resources/a'] });
    assert.equal(folders.level, 'bad');
    assert.deepEqual(folders.problems.map((p) => p.text), ['/work had come loose in the machine: it was mounted again.', '/resources/a is not reachable in the machine and could not be mounted again: refused.']);
});

/* A machine played by the test: its state, what its probe prints, what the VM manager is asked. */
function machine(t, { state = 'Running', mounted = ['/work', '/resources/reports'], dead = [], silent = false, phase = 'ready', extra = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-health-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const box = { state, dead: new Set(dead), mounted: new Set(mounted) };
    const vms = {
        state: async () => box.state,
        exec: async (_name, argv, options) => {
            calls.push(`exec ${argv[0]}`); box.options = options;
            if (silent) return { code: 1, stdout: '', stderr: 'timed out' };
            const lines = ['memory 2097152 1048576', 'oom 0', 'disk / 5000 8000'];
            for (const p of argv.slice(4)) lines.push(`mount ${box.mounted.has(p) && !box.dead.has(p) ? 'ok' : 'missing'} ${p}`);
            lines.push(...extra);
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
    return { health, calls, box, resources, grants, dir, store, vms };
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

/* The probe's output is the agent's to write (root in its machine): any
   "disk <x>" line used to become a warning with its text, and 8 MB of lines
   were kept and sent with every list of conversations. */
test('what the probe prints is read only where it was asked: its disks, its paths, whole numbers, a bounded size', async (t) => {
    const facts = readProbe(['memory 2097152 1048576', 'disk <b>evil</b> 1 999999', 'disk /work 1 99999', 'disk / x 5', 'mount ok /etc', 'mount pwned /resources/a', 'mount missing /resources/a', 'oom 1e9'].join('\n'), ['/resources/a']);
    assert.deepEqual(facts.disks, {}, 'only / and, when expected, /work; whole numbers only');
    assert.deepEqual(facts.mounts, { '/resources/a': 'missing' });
    assert.equal(facts.oomKills, undefined);
    assert.deepEqual(readProbe('disk /work 1 99999', ['/work']).disks, { '/work': { availableMb: 1, sizeMb: 99999 } });
    assert.deepEqual(readProbe(`${'x\n'.repeat(300)}oom 3`).oomKills, undefined, 'past the lines that are read: not read');
    assert.deepEqual(readProbe(`${' '.repeat(20_000)}\noom 3`).oomKills, undefined, 'past the bytes that are read: not read');
    const hostile = Array.from({ length: 5000 }, (_, i) => `disk /evil${i} 1 999999`);
    const m = machine(t, { extra: ['disk <img src=x> 1 999999', ...hostile] });
    attach(m, 'reports', 'write');
    const seen = await m.health.check('demo');
    assert.equal(seen.level, 'ok', JSON.stringify(seen.problems.slice(0, 3)));
    assert.deepEqual(Object.keys(seen.disks), ['/']);
    assert.ok(m.box.options.maxBytes > 0 && m.box.options.maxBytes <= 256 * 1024, 'the probe\'s output is bounded where it is taken in');
    assert.ok(JSON.stringify(m.health.of('demo')).length < 10_000);
});

test('what is said is bounded, whatever happens', () => {
    const many = { state: 'Running', answering: true, failed: Array.from({ length: 100 }, (_, i) => ({ path: `/resources/r${i}`, why: 'x'.repeat(2000) })) };
    const said = judge(many);
    assert.ok(said.problems.length <= 20);
    assert.ok(said.problems.every((p) => p.text.length <= 300));
    assert.equal(said.level, 'bad');
});

/* The clock used to look at each conversation in turn: one machine slow to
   answer held up every other one. */
test('the clock looks at every conversation at once, each within its own time', async (t) => {
    const probed = [];
    const vms = {
        state: async () => 'Running',
        exec: async (name) => { probed.push(name); if (name === 'slow') return new Promise(() => {}); return { code: 0, stdout: 'memory 2097152 1048576\noom 0\ndisk / 5000 8000\n', stderr: '' }; },
    };
    const records = new Map([['slow', { name: 'slow', phase: 'ready', work: 'disk' }], ['quick', { name: 'quick', phase: 'ready', work: 'disk' }]]);
    const conversations = { get: (n) => records.get(n), awake: () => [...records.keys()] };
    const health = new Health({ vms, conversations, lookMs: 30 });
    const stop = health.start(10);
    t.after(stop);
    const until = Date.now() + 2000;
    while (!health.of('quick') && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(health.of('quick')?.level, 'ok', 'looked at, while the slow one still has not answered');
    assert.deepEqual(probed.filter((n) => n === 'slow').length, 1, 'a look still going is joined, not started again');
});

test('each judgment is told as it is made (its chat says what is wrong), and a hook that fails stops nothing', async (t) => {
    const m = machine(t, { silent: true });
    const told = [];
    m.health.judged = (name, record) => told.push([name, record.level, record.problems.map((p) => p.key)]);
    await m.health.check('demo');
    assert.deepEqual(told, [['demo', 'bad', ['silent']]]);
    m.health.judged = () => { throw new Error('the chat is gone'); };
    assert.equal((await m.health.check('demo')).level, 'bad');
});

test('a machine that does not answer is left alone a while, longer each time, unless its owner asks', async () => {
    let probes = 0;
    const vms = { state: async () => 'Running', exec: async () => { probes += 1; return { code: 255, stdout: '', stderr: 'timed out' }; } };
    const conversations = { get: () => ({ phase: 'ready', work: 'disk' }) };
    const { Health } = await import('../server/health.mjs');
    const h = new Health({ vms, conversations, probeMs: 10 });
    assert.equal((await h.check('demo')).answering, false);
    assert.equal(probes, 1);
    assert.equal((await h.check('demo')).answering, false);
    assert.equal(probes, 1, 'not asked again at once: each question holds the VM manager');
    await h.check('demo', { asked: true });
    assert.equal(probes, 2, 'its owner asked: asked');
});

test('"Seen": what it says now no longer calls its owner; another problem does, and one gone and back does again', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-seen-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let disk = 'disk / 300 8000'; let memory = 'memory 2097152 1048576';
    const vms = { state: async () => 'Running', exec: async () => ({ code: 0, stdout: `${memory}\noom 3\n${disk}\n`, stderr: '' }) };
    const conversations = { get: () => ({ phase: 'ready', work: 'disk' }) };
    const h = new Health({ vms, conversations, seen: new Store(join(dir, 'seen.json')) });
    await h.check('demo');
    const keys = () => h.of('demo').problems.filter((p) => p.level !== 'info').map((p) => p.key);
    assert.deepEqual(keys(), ['disk:/'], 'programs stopped (the kind not told): only noted');
    assert.deepEqual(h.of('demo').seen, []);
    assert.deepEqual(h.markSeen('demo').seen, keys());
    memory = 'memory 2097152 10000';
    await h.check('demo', { asked: true });
    assert.ok(keys().includes('memory-low'));
    assert.ok(!h.of('demo').seen.includes('memory-low'), 'another problem: not seen');
    disk = 'disk / 6000 8000';
    await h.check('demo', { asked: true });
    assert.ok(!h.of('demo').seen.includes('disk:/'), 'gone: forgotten');
    disk = 'disk / 300 8000';
    await h.check('demo', { asked: true });
    assert.ok(keys().includes('disk:/') && !h.of('demo').seen.includes('disk:/'), 'back: it calls again');
});

test('the probe tells the kernel\'s two kinds apart: the whole machine short, or a program at its own limit', () => {
    const out = spawnSync('sh', ['-c', PROBE.split('\n').find((l) => l.includes('oomkinds')).replace('( sudo -n dmesg 2>/dev/null || dmesg 2>/dev/null )', 'cat')], { input: ['[ 1.0] Memory cgroup out of memory: Killed process 3662 (python3) total-vm:59324kB', '[ 2.0] Memory cgroup out of memory: Killed process 3700 (node)', '[ 3.0] Out of memory: Killed process 812 (java) total-vm:9999kB', '[ 4.0] something else'].join('\n'), encoding: 'utf8' });
    assert.equal(out.stdout.trim(), 'oomkinds 1 2');
    assert.deepEqual(readProbe('oom 3\noomkinds 1 2\n', []).oomKinds, { machine: 1, limit: 2 });
    assert.equal(readProbe('oom 3\n', []).oomKinds, undefined, 'not read: not said');
});

test('a folder the VM manager cannot mount for want of its helper in the machine: the helper is installed once, then it is tried again', async (t) => {
    const m = machine(t, { mounted: ['/work'] });
    attach(m, 'reports', 'write');
    attach(m, 'papers', 'write');
    let helper = false; const execs = [];
    const exec = m.vms.exec.bind(m.vms);
    m.vms.exec = async (name, argv, o) => { if (argv.includes('multipass-sshfs')) { execs.push(argv.join(' ')); helper = true; return { code: 0, stdout: '', stderr: '' }; } return exec(name, argv, o); };
    m.resources.repair = async () => (helper ? '' : "Please install the 'multipass-sshfs' snap manually inside the instance.");
    const seen = await m.health.check('demo');
    assert.deepEqual(execs, ['sudo -n snap install multipass-sshfs'], 'once, for both folders');
    assert.equal((seen.failed ?? []).some((f) => /multipass-sshfs/.test(f.why)), false);
});
