/* The heartbeat of a machine (beat.mjs): its health read from its work folder, here, with no command --
   and believed only as far as it should be (the agent writes there). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, utimesSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Beat, beatWanted, installScript, INSTALL_NAME, FRESH_MS, BEAT_BYTES, VERSION } from '../server/beat.mjs';
import { Health, PROBE, SPOT_MS, readProbe } from '../server/health.mjs';
import { copied } from '../server/copywork.mjs';
import { Vms } from '../server/vm.mjs';

const ONE = new URL('../config/machine/clavarium-beat-one', import.meta.url).pathname;
const RUNNER = new URL('../config/machine/clavarium-beat', import.meta.url).pathname;
const PROBED = ['memory 2097152 1048576', 'oom 0', 'disk / 5000 8000', 'mount ok /work', 'secrets 1', 'secret API_KEY'].join('\n');

function place(t, { now = Date.now(), kept = 'kept', shared = false, install = 0 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-beat-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const clock = { now };
    const work = (name) => join(dir, 'work', name);
    mkdirSync(work('demo'), { recursive: true });
    const records = new Map([['demo', { name: 'demo', phase: 'ready', work: kept }]]);
    const calls = [];
    const vms = {
        state: async () => 'Running',
        shared: () => shared,
        exec: async (_name, argv) => { calls.push(`exec ${argv[0]}`); return { code: 0, stdout: `${PROBED}\n`, stderr: '' }; },
        execMachine: async (_name, argv) => { calls.push(`machine ${argv.slice(0, 3).join(' ')} ${argv.slice(6).join(' ')}`); return { code: install, stdout: '', stderr: '' }; },
        noteBeat: (read) => calls.push(read ? 'beat read' : 'beat fallback'),
    };
    const conversations = { get: (n) => records.get(n), awake: () => [...records.keys()] };
    const beat = new Beat({ on: true, vms, workFolder: work, conversations, now: () => clock.now, version: '9.9.9' });
    /* A beat as its machine writes it, at `at` by this server's clock. */
    const write = (fields = {}, at = clock.now) => {
        const folder = join(work('demo'), '.clavarium');
        mkdirSync(folder, { recursive: true });
        const file = join(folder, 'beat.json');
        writeFileSync(file, JSON.stringify({ v: 1, conversation: 'demo', seq: 1, version: '9.9.9', probe: PROBED, ...fields }));
        utimesSync(file, at / 1000, at / 1000);
        return file;
    };
    return { dir, clock, work, records, calls, vms, conversations, beat, write };
}

test('CLAVARIUM_BEAT: on only when it holds `health`', () => {
    assert.equal(beatWanted(undefined), false);
    assert.equal(beatWanted(''), false);
    assert.equal(beatWanted('health'), true);
    assert.equal(beatWanted('secrets,health'), true);
    assert.equal(beatWanted('healthy'), false);
});

test('a fresh beat of its own conversation is read; its probe as the probe always was', (t) => {
    const p = place(t);
    p.write();
    const r = p.beat.read('demo');
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(readProbe(r.text, ['/work']).mounts, { '/work': 'ok' });
    assert.deepEqual(readProbe(r.text, ['/work']).secrets, { count: 1, names: ['API_KEY'] });
});

test('a beat is not believed: stale, ahead, another conversation, not JSON, its number going back', (t) => {
    const p = place(t);
    p.write({}, p.clock.now - FRESH_MS - 1000);
    assert.equal(p.beat.read('demo').why, 'stale', 'its age is this server\'s clock, the file\'s time here');
    p.write({}, p.clock.now + 60_000);
    assert.equal(p.beat.read('demo').why, 'ahead');
    p.write({ conversation: 'other' });
    assert.equal(p.beat.read('demo').why, 'another conversation');
    p.write({ v: 2 });
    assert.equal(p.beat.read('demo').why, 'not a beat');
    p.write({ seq: 'x' });
    assert.equal(p.beat.read('demo').why, 'no number');
    p.write({ probe: 42 });
    assert.equal(p.beat.read('demo').why, 'no probe');
    writeFileSync(join(p.work('demo'), '.clavarium', 'beat.json'), '{"v":1,');
    assert.equal(p.beat.read('demo').why, 'not json');
    p.write({ seq: 5 });
    assert.equal(p.beat.read('demo').ok, true);
    assert.equal(p.beat.read('demo').ok, true, 'the same beat read again is still it');
    p.write({ seq: 3 }, p.clock.now - 1000);
    assert.equal(p.beat.read('demo').why, 'number');
    p.write({ seq: 4 });
    assert.equal(p.beat.read('demo').ok, true, 'after one refused, the next is a new start');
});

test('a link, a big file, a pipe: never followed, never read, never waited for', (t) => {
    const p = place(t);
    /* The folder itself a link to somewhere else (with a perfect beat there). */
    const elsewhere = join(p.dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'beat.json'), JSON.stringify({ v: 1, conversation: 'demo', seq: 1, version: '9.9.9', probe: PROBED }));
    symlinkSync(elsewhere, join(p.work('demo'), '.clavarium'));
    assert.equal(p.beat.read('demo').why, 'none');
    assert.equal(p.beat.expect('demo', ['/work']), false, 'nothing written through a link');
    assert.equal(existsSync(join(elsewhere, 'expected')), false);
    rmSync(join(p.work('demo'), '.clavarium'));
    /* The file a link. */
    mkdirSync(join(p.work('demo'), '.clavarium'));
    symlinkSync(join(elsewhere, 'beat.json'), join(p.work('demo'), '.clavarium', 'beat.json'));
    assert.equal(p.beat.read('demo').why, 'unreadable');
    rmSync(join(p.work('demo'), '.clavarium', 'beat.json'));
    /* Too big. */
    p.write({ probe: 'x'.repeat(BEAT_BYTES) });
    assert.equal(p.beat.read('demo').why, 'too big');
    rmSync(join(p.work('demo'), '.clavarium', 'beat.json'));
    /* A pipe nobody writes to: refused at once, not waited on. */
    const made = spawnSync('mkfifo', [join(p.work('demo'), '.clavarium', 'beat.json')]);
    if (made.status === 0) assert.equal(p.beat.read('demo').why, 'not a file');
    rmSync(join(p.work('demo'), '.clavarium', 'beat.json'));
    /* A folder in its place. */
    mkdirSync(join(p.work('demo'), '.clavarium', 'beat.json'));
    assert.notEqual(p.beat.read('demo').ok, true);
});

test('what should be mounted is written for the beat, aside then moved, again only when it changed', (t) => {
    const p = place(t);
    assert.equal(p.beat.expect('demo', ['/work', '/resources/a', '/bad path', '/x;y']), true);
    const at = join(p.work('demo'), '.clavarium', 'expected');
    assert.equal(readFileSync(at, 'utf8'), '/work\n/resources/a\n', 'only plain paths');
    /* A link put at its place is replaced, never written through. */
    rmSync(at);
    const target = join(p.dir, 'target');
    writeFileSync(target, 'mine');
    symlinkSync(target, at);
    assert.equal(p.beat.expect('demo', ['/work']), true);
    assert.equal(readFileSync(target, 'utf8'), 'mine');
    assert.equal(readFileSync(at, 'utf8'), '/work\n');
    const off = new Beat({ on: false, vms: p.vms, workFolder: p.work, conversations: p.conversations });
    assert.equal(off.expect('demo', ['/work']), false);
});

/* A Health that reads the beat: what is asked of the machine, look after look. */
function healthOf(p, resources = null) {
    return new Health({ vms: p.vms, conversations: p.conversations, resources, settleMs: 1, beat: p.beat, now: () => p.clock.now });
}

test('a fresh beat answers the look: no command into the machine', async (t) => {
    const p = place(t);
    const health = healthOf(p);
    await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), ['exec sh'], 'the first look is a command: nothing known yet');
    p.clock.now += 120_000;
    p.write({ seq: 2 });
    p.calls.length = 0;
    const seen = await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), [], p.calls.join(', '));
    assert.ok(p.calls.includes('beat read'));
    assert.equal(seen.answering, true);
    assert.equal(seen.level, 'ok');
    assert.deepEqual(seen.missing, []);
    p.clock.now += 120_000;
    p.write({ seq: 3 });
    await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), []);
});

test('the secrets\' names come from the beat as from the probe', async (t) => {
    const p = place(t);
    const health = healthOf(p);
    const told = [];
    health.probed = (_name, facts) => told.push(facts.secrets);
    await health.check('demo');
    p.clock.now += 120_000; p.write({ seq: 2 });
    await health.check('demo');
    assert.deepEqual(told, [{ count: 1, names: ['API_KEY'] }, { count: 1, names: ['API_KEY'] }]);
});

test('a beat gone stale, one older than our own look, or missing a path: a command, at once', async (t) => {
    const p = place(t);
    const health = healthOf(p);
    await health.check('demo');
    p.clock.now += 120_000;
    p.write({ seq: 2 }, p.clock.now - FRESH_MS - 5000);
    p.calls.length = 0;
    await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec') || c.startsWith('beat')), ['beat fallback', 'exec sh']);
    /* Written before our own last look: it may say what was put back since. */
    p.clock.now += 60_000;
    p.write({ seq: 3 }, p.clock.now - 90_000);
    p.calls.length = 0;
    await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), ['exec sh']);
    /* A path that should be mounted and that the beat does not speak of (written before it was expected). */
    p.clock.now += 120_000;
    p.write({ seq: 4, probe: PROBED.replace('mount ok /work', '') });
    p.calls.length = 0;
    await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), ['exec sh']);
});

test('a loose folder in the beat: looked at again by command before anything is done', async (t) => {
    const p = place(t);
    const repaired = [];
    const health = healthOf(p, { expected: () => ['/work'], repair: async (_c, path) => { repaired.push(path); return ''; } });
    await health.check('demo');
    p.clock.now += 120_000;
    p.write({ seq: 2, probe: PROBED.replace('mount ok /work', 'mount missing /work') });
    p.calls.length = 0;
    const seen = await health.check('demo');
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), ['exec sh'], 'the second look is a command, and it finds the folder there');
    assert.deepEqual(seen.missing, []);
    assert.deepEqual(repaired, [], 'there after all: nothing put back');
});

test('a spot check by command every 30 minutes, a fresh beat or not; a look asked is always a command', async (t) => {
    const p = place(t);
    const health = healthOf(p);
    await health.check('demo');
    let seq = 1;
    let commands = 0;
    for (let i = 0; i < 16; i++) {
        p.clock.now += 120_000;
        p.write({ seq: ++seq });
        p.calls.length = 0;
        await health.check('demo');
        commands += p.calls.filter((c) => c.startsWith('exec')).length;
    }
    assert.equal(commands, 1, 'one in 32 minutes');
    p.clock.now += 60_000; p.write({ seq: ++seq });
    p.calls.length = 0;
    await health.check('demo', { asked: true });
    assert.deepEqual(p.calls.filter((c) => c.startsWith('exec')), ['exec sh']);
});

test('off, or a work folder on its machine\'s disk: every look a command, nothing read, nothing counted', async (t) => {
    const p = place(t);
    const off = new Beat({ on: false, vms: p.vms, workFolder: p.work, conversations: p.conversations });
    const health = new Health({ vms: p.vms, conversations: p.conversations, resources: null, beat: off, now: () => p.clock.now });
    await health.check('demo'); p.clock.now += 120_000; p.write({ seq: 2 });
    await health.check('demo');
    assert.deepEqual(p.calls, ['exec sh', 'exec sh']);
    const q = place(t, { kept: 'disk' });
    const disk = healthOf(q);
    await disk.check('demo'); q.clock.now += 120_000; q.write({ seq: 2 });
    await disk.check('demo');
    assert.deepEqual(q.calls, ['exec sh', 'exec sh']);
    assert.equal(await q.beat.ensure('demo'), 'off');
});

test('put in its machine once per version: one command, skipped when a fresh beat says this version', async (t) => {
    const p = place(t);
    assert.equal(await p.beat.ensure('demo'), 'put');
    assert.deepEqual(p.calls, [`machine sudo -n sh own demo 9.9.9`]);
    assert.equal(await p.beat.ensure('demo'), 'tried', 'not again for this version');
    p.write({ version: '9.9.9' });
    assert.equal(await p.beat.ensure('demo', { woke: true }), 'fresh');
    p.write({ version: '9.9.8', seq: 2 });
    assert.equal(await p.beat.ensure('demo', { woke: true }), 'put', 'a start: tried again; an older version: put again');
    assert.equal(p.calls.length, 2);
    /* Two asked at once: one command. */
    const q = place(t, { shared: true, install: 1 });
    const [a, b] = await Promise.all([q.beat.ensure('demo'), q.beat.ensure('demo')]);
    assert.deepEqual([a, b], ['failed', 'failed']);
    assert.deepEqual(q.calls, ['machine sudo -n sh shared - 9.9.9'], 'in a shared machine, for all who live there');
    assert.equal(await q.beat.ensure('demo'), 'tried', 'a failure is not tried again before its machine starts again');
});

test('the install is one script that parses, holds the probe whole, and takes only its words', () => {
    const script = installScript();
    assert.ok(script.includes(PROBE), 'exactly the probe of health.mjs');
    assert.equal(spawnSync('sh', ['-n', '-c', script]).status, 0);
    for (const args of [['other', 'demo', '1.0'], ['own', 'Bad;name', '1.0'], ['own', 'demo', '1.0;rm']]) {
        const r = spawnSync('sh', ['-c', `${script.split('\n').slice(0, 4).join('\n')}\necho passed`, INSTALL_NAME, ...args], { encoding: 'utf8' });
        assert.equal(r.status, 64, args.join(' '));
        assert.doesNotMatch(r.stdout, /passed/);
    }
    assert.equal(typeof VERSION, 'string');
    for (const f of [ONE, RUNNER]) assert.equal(spawnSync('sh', ['-n', f]).status, 0, f);
});

test('one beat, run here for real: what the probe printed comes back whole, quotes and backslashes too', (t) => {
    const p = place(t);
    const lib = join(p.dir, 'lib');
    mkdirSync(lib);
    /* A stand-in for the probe: what an agent's awk could print, and the paths it was given. */
    writeFileSync(join(lib, 'probe.sh'), [
        'echo "memory 2097152 1048576"',
        'printf \'%s\\n\' \'disk / 5000 8000\' \'odd "quoted" \\\\back\\\\ slash\' "tab	here"',
        'for p in "$@"; do echo "mount ok $p"; done',
        'printf \'bell\\007end\\n\'',
    ].join('\n'));
    chmodSync(join(lib, 'probe.sh'), 0o644);
    mkdirSync(join(p.work('demo'), '.clavarium'), { recursive: true });
    writeFileSync(join(p.work('demo'), '.clavarium', 'expected'), '/work\n/resources/a b\n/resources/x\n$(echo pwned)\n');
    const r = spawnSync('sh', [ONE, 'demo', '7', '9.9.9'], { encoding: 'utf8', env: { PATH: process.env.PATH, CLAVARIUM_BEAT_WORK: p.work('demo'), CLAVARIUM_BEAT_LIB: lib } });
    assert.equal(r.status, 0, r.stderr);
    const read = p.beat.read('demo');
    assert.equal(read.ok, true, read.why);
    assert.equal(read.seq, 7);
    const lines = read.text.split('\n');
    assert.deepEqual(lines, ['memory 2097152 1048576', 'disk / 5000 8000', 'odd "quoted" \\\\back\\\\ slash', 'tab\there', 'mount ok /work', 'mount ok /resources/x', 'bellend']);
    assert.deepEqual(readProbe(read.text, ['/work', '/resources/x']).mounts, { '/work': 'ok', '/resources/x': 'ok' });
    assert.deepEqual(spawnSync('ls', ['-A', join(p.work('demo'), '.clavarium')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort(), ['beat.json', 'expected'], 'nothing left aside');
});

test('a link at /work/.clavarium: the beat writes nothing through it', (t) => {
    const p = place(t);
    const lib = join(p.dir, 'lib'); mkdirSync(lib);
    writeFileSync(join(lib, 'probe.sh'), 'echo "memory 1 1"\n');
    const elsewhere = join(p.dir, 'elsewhere'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(p.work('demo'), '.clavarium'));
    spawnSync('sh', [ONE, 'demo', '1', '9.9.9'], { env: { PATH: process.env.PATH, CLAVARIUM_BEAT_WORK: p.work('demo'), CLAVARIUM_BEAT_LIB: lib } });
    assert.equal(existsSync(join(elsewhere, 'beat.json')), false);
});

test('a copy of a work folder leaves its heartbeat behind', () => {
    assert.equal(copied('.clavarium'), false);
    assert.equal(copied('.clavarium/beat.json'), false);
    assert.equal(copied('.clavarium-notes'), true);
});

test('the host tally says how many looks the beat answered and how many fell back', async () => {
    let now = 1000;
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try {
        const vms = new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), [], { now: () => now });
        await vms.run(['vm', 'exec', 'clv-demo', '--', 'true']);
        vms.noteBeat(true); vms.noteBeat(true); vms.noteBeat(false);
        now += 6 * 60_000;
        await vms.run(['vm', 'exec', 'clv-demo', '--', 'true']);
    } finally { console.log = log; }
    assert.match(lines.join('\n'), /; beat read 2x, fallback 1x$/);
});

test('spot checks are 30 minutes apart', () => assert.equal(SPOT_MS, 30 * 60_000));
