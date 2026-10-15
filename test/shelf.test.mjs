/* The ready-made machine: which builds use it, how old it may be, when the
   disk is too short to rebuild it, and how a rebuild keeps at most two. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shelf, shelfName, toolSignature, readyMadeFor, fresh, enoughRoom, preparation, MAX_AGE_MS, MIN_FREE_MB } from '../server/shelf.mjs';
import { Store } from '../server/store.mjs';
import { readTools, NODE_STEPS } from '../server/tools.mjs';
import { Refusal } from '../server/conversations.mjs';

const DAY = 24 * 60 * 60_000;
const TOOLS = readTools(JSON.stringify([
    { id: 'one', label: 'One', command: ['one'], memoryMb: 1024, install: ['node', ['sudo', '-n', 'npm', 'install', '-g', 'one']] },
    { id: 'two', label: 'Two', command: ['two'], memoryMb: 1024, install: ['node', ['sudo', '-n', 'npm', 'install', '-g', 'two']] },
    { id: 'shell', label: 'Shell', command: ['bash'], memoryMb: 768, install: [] },
]));
const [ONE, TWO, SHELL] = TOOLS;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const record = (ageDays, tools = TOOLS) => ({ name: 'clvshelf-20261001-080000', builtAt: new Date(NOW - ageDays * DAY).toISOString(), tools: Object.fromEntries(tools.map((t) => [t.id, toolSignature(t)])) });

test('a name says when, and can never be taken for a conversation\'s machine', () => {
    assert.equal(shelfName(new Date('2026-10-14T09:05:03.120Z')), 'clvshelf-20261014-090503');
    assert.ok(!shelfName(new Date()).startsWith('clv-'));
});

test('THE CHOICE: the shelf is used for a tool it holds, installed by today\'s recipe; otherwise the long way', () => {
    const r = record(3);
    assert.equal(readyMadeFor(r, ONE, NOW), r.name);
    assert.equal(readyMadeFor(r, SHELL, NOW), r.name, 'a tool with nothing to install still gains the prepared machine');
    assert.equal(readyMadeFor(undefined, ONE, NOW), undefined, 'no shelf');
    assert.equal(readyMadeFor(record(3, [ONE]), TWO, NOW), undefined, 'a tool it does not hold');
    /* The catalogue changed the recipe: the old install is not taken for the new one. */
    const changed = readTools(JSON.stringify([{ id: 'one', label: 'One', command: ['one'], memoryMb: 1024, install: ['node', ['sudo', '-n', 'npm', 'install', '-g', 'one@2']] }]))[0];
    assert.notEqual(toolSignature(changed), toolSignature(ONE));
    assert.equal(readyMadeFor(r, changed, NOW), undefined);
    assert.equal(readyMadeFor({ ...r, name: 'clv-demo' }, ONE, NOW), undefined, 'only a name of ours');
});

test('THE AGE RULE: used until its maximum age, not a moment after', () => {
    const limit = MAX_AGE_MS / DAY;
    assert.ok(limit >= 30, 'longer than the monthly rebuild, so that a late rebuild does not cost anything');
    assert.ok(fresh(record(limit), NOW));
    assert.ok(!fresh(record(limit + 0.01), NOW));
    assert.equal(readyMadeFor(record(limit + 1), ONE, NOW), undefined);
    assert.ok(!fresh({ builtAt: 'not a date' }, NOW));
});

test('THE DISK RULE: free room, plus what the previous one gives back, must reach the margin', () => {
    assert.equal(MIN_FREE_MB, 6144);
    assert.ok(enoughRoom(6144));
    assert.ok(!enoughRoom(6143));
    assert.ok(enoughRoom(3000, 3200), 'the previous shelf is removed first: its room counts');
    assert.ok(!enoughRoom(Number.NaN));
});

test('the preparation updates the system, prepares sharing, installs each tool once, shares Node.js, and tidies up', () => {
    const steps = preparation(TOOLS);
    const lines = steps.map((s) => s.argv.join(' '));
    assert.equal(lines.filter((l) => l === NODE_STEPS[0].argv.join(' ')).length, 1, 'apt-get update once');
    assert.equal(lines.filter((l) => l.includes('sha256sum')).length, 1, 'Node.js once, checked by its checksum');
    assert.ok(lines.includes('sudo -n snap install multipass-sshfs'));
    assert.ok(lines.includes('sudo -n npm install -g one') && lines.includes('sudo -n npm install -g two'));
    assert.ok(lines.indexOf('sudo -n snap install multipass-sshfs') < lines.indexOf('sudo -n npm install -g one'));
    assert.equal(steps.at(-1).label, 'Tidying up');
    assert.equal(steps.find((s) => s.argv.includes('sha256sum')).input, NODE_STEPS.find((s) => s.input).input);
});

test('npm is made the machine user\'s once, after every tool was installed: a later install as root would undo it', async () => {
    const { readTools, NPM_WRITABLE } = await import('../server/tools.mjs');
    const tools = readTools(JSON.stringify([
        { id: 'one', label: 'One', command: ['one'], memoryMb: 1024, install: ['node', ['sudo', '-n', 'npm', 'install', '-g', 'one'], 'npm-writable'] },
        { id: 'two', label: 'Two', command: ['two'], memoryMb: 1024, install: ['node', ['sudo', '-n', 'npm', 'install', '-g', 'two'], 'npm-writable'] },
    ]));
    const lines = preparation(tools).map((s) => s.argv.join(' '));
    for (const step of NPM_WRITABLE) {
        const line = step.argv.join(' ');
        assert.equal(lines.filter((l) => l === line).length, 1, line);
        assert.ok(lines.indexOf(line) > lines.indexOf('sudo -n npm install -g two'), `${line} comes after the last install`);
    }
    assert.equal(preparation(TOOLS).some((s) => s.label === 'Letting the tools update themselves'), TOOLS.some((t) => t.fixups.length > 0));
});

/* The host program, played: records the calls, answers what the test says. */
function bench(t, { free = 50_000 } = {}) {
    let fail;
    const dir = mkdtempSync(join(tmpdir(), 'clv-shelf-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const machines = new Set();
    let now = NOW;
    const run = async (argv) => {
        calls.push(argv.join(' '));
        const [, verb, name] = argv;
        if (fail && argv.join(' ').includes(fail)) return { code: 1, stdout: '', stderr: `E: ${fail} broke` };
        if (verb === 'room') return { code: 0, stdout: `free ${free}\n`, stderr: '' };
        if (verb === 'launch') machines.add(name);
        if (verb === 'delete') machines.delete(name);
        if (verb === 'size') return { code: 0, stdout: 'size 4300\n', stderr: '' };
        if (verb === 'list') return { code: 0, stdout: [...machines].join('\n'), stderr: '' };
        if (verb === 'info') return machines.has(name) ? { code: 0, stdout: '{}', stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'shelf.json'));
    const make = () => new Shelf({ store, run, tools: TOOLS, now: () => now });
    return { calls, machines, store, make, later: (days) => { now += days * DAY; }, failOn: (text) => { fail = text; } };
}

test('a rebuild prepares a machine, seals it, and it becomes the one new conversations are copied from', async (t) => {
    const b = bench(t);
    const shelf = b.make();
    assert.equal(shelf.pick(ONE), undefined);
    assert.ok(shelf.due(), 'none yet: one is due');
    await shelf.rebuild();
    assert.ok(shelf.about().building, 'it runs in the background');
    await assert.rejects(shelf.rebuild(), /already being rebuilt/);
    await shelf.job;
    const name = 'clvshelf-20261014-120000';
    assert.equal(b.calls[1], `shelf launch ${name}`);
    assert.ok(b.calls.includes(`shelf exec ${name} -- sudo -n snap install multipass-sshfs`));
    assert.equal(b.calls.at(-2), `shelf seal ${name}`);
    assert.equal(shelf.pick(ONE), name);
    const about = shelf.about();
    assert.equal(about.current.sizeMb, 4300);
    assert.deepEqual(about.current.tools, ['One', 'Two', 'Shell']);
    assert.equal(about.building, null);
    assert.ok(!shelf.due(), 'fresh: nothing due');
    b.later(31);
    assert.ok(shelf.due(), 'a month later, a rebuild is due');
    assert.equal(shelf.pick(ONE), name, 'still used while it is rebuilt');
});

test('at most two are kept: the one before the current is removed when a rebuild starts; a rebuild in progress leaves the current in use', async (t) => {
    const b = bench(t);
    const shelf = b.make();
    await shelf.rebuild(); await shelf.job;
    const first = shelf.pick(ONE);
    b.later(31); await shelf.rebuild(); await shelf.job;
    const second = shelf.pick(ONE);
    assert.notEqual(first, second);
    assert.deepEqual([...b.machines].sort(), [first, second]);
    b.later(31);
    await shelf.rebuild();
    assert.equal(shelf.pick(ONE), second, 'while the third is made, the second is used');
    await shelf.job;
    assert.equal(b.machines.size, 2);
    assert.ok(!b.machines.has(first), 'the oldest is gone');
    assert.ok(b.machines.has(second));
});

test('a rebuild is refused when the disk is short, and that is remembered for the page', async (t) => {
    const b = bench(t, { free: 4000 });
    const shelf = b.make();
    await assert.rejects(shelf.rebuild(), (e) => e instanceof Refusal && e.status === 409 && /3\.9 GB free on the server, 6\.0 GB needed/.test(e.message));
    assert.ok(!b.calls.some((c) => c.startsWith('shelf launch')), 'nothing was started');
    assert.match(shelf.about().refused.text, /Not rebuilt/);
    assert.ok(!shelf.due(), 'not tried again automatically before a day');
    b.later(1.01);
    assert.ok(shelf.due());
});

test('a failed rebuild removes its machine, keeps the current one in use, and says why', async (t) => {
    const b = bench(t);
    const shelf = b.make();
    await shelf.rebuild(); await shelf.job;
    const current = shelf.pick(ONE);
    b.later(31);
    b.failOn('install -g two');
    await shelf.rebuild(); await shelf.job;
    assert.match(shelf.about().error, /Installing Two failed: E: install -g two broke/);
    assert.ok(b.calls.includes('shelf delete clvshelf-20261114-120000'), 'its half-made machine is removed');
    assert.deepEqual([...b.machines], [current]);
    assert.equal(shelf.pick(ONE), current, 'the one there was is still used');
    assert.ok(!shelf.due(), 'not retried before a day');
});

test('at start: a rebuild cut short is forgotten and its machine removed; a recorded shelf that is gone is forgotten', async (t) => {
    const b = bench(t);
    b.store.put({ name: 'shelf', building: { name: 'clvshelf-20261014-110000', since: 'x', step: 'Installing One' }, current: record(2) });
    b.machines.add('clvshelf-20261014-110000');
    const shelf = b.make();
    await shelf.recover();
    assert.ok(b.calls.includes('shelf delete clvshelf-20261014-110000'));
    const about = shelf.about();
    assert.equal(about.building, null);
    assert.match(about.error, /restarted during a rebuild/);
    assert.equal(about.current, null, 'its recorded machine does not exist here');
    assert.equal(shelf.pick(ONE), undefined);
});
