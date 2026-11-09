/* THE WATCHDOG OF A MACHINE (server/watchdog.mjs, 09-11): mute or full for its delay, forced off then
   started, once; its AI told in its chat, its owner alerted; never before the delay, never a loop,
   never while it starts, never when its owner turned it off. Then the same through the real lock of
   its machine (conversations.mjs, machineAction) and the route that sets it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Watchdog, lookOf, delayWords, AGAIN_MS } from '../server/watchdog.mjs';
import { Conversations, FIXES, WATCHDOG_DELAY_MIN } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';
import { handleApi } from '../server/api.mjs';

const MUTE = { state: 'Running', answering: false };
const FULL = { state: 'Running', answering: true, memory: { totalMb: 8192, availableMb: 100 } };
const WELL = { state: 'Running', answering: true, memory: { totalMb: 8192, availableMb: 4000 } };
const BOOTING = { state: 'Starting', busy: true };

function bench(t, { setting = { on: true, delayMin: 60 }, act } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-dog-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let clock = Date.parse('2026-11-09T02:00:00Z');
    const acted = []; const told = []; const alerts = [];
    const conversations = { get: (name) => (name === 'demo' ? { name } : undefined), watchdog: () => setting };
    const dog = new Watchdog({ conversations, store: new Store(join(dir, 'watchdog.json')), now: () => clock,
        act: act ?? (async (name) => { acted.push(name); return { ok: true, said: 'Started in 20 s.' }; }),
        tell: (name, text, started) => told.push({ name, text, started }), alert: (p) => alerts.push(p) });
    return { dog, acted, told, alerts, setting, later: (min) => { clock += min * 60_000; } };
}

test('a look is mute, full, well, or nothing to judge (not running, starting)', () => {
    assert.equal(lookOf(MUTE), 'mute');
    assert.equal(lookOf(FULL), 'full');
    assert.equal(lookOf(WELL), 'well');
    assert.equal(lookOf(BOOTING), null);
    assert.equal(lookOf({ state: 'Stopped' }), null);
    assert.equal(lookOf({ ...FULL, memory: { totalMb: 8192, availableMb: 420 } }), 'well', '5 % free is not full');
    assert.deepEqual([delayWords(30), delayWords(60), delayWords(120), delayWords(90)], ['30 min', '1 h', '2 h', '1 h 30']);
    assert.equal(WATCHDOG_DELAY_MIN, 60, 'one hour by default');
});

test('mute for its delay: forced off then started, once; its AI told in its chat, its owner alerted; not before', async (t) => {
    const b = bench(t);
    assert.equal(await b.dog.judged('demo', MUTE), 'watching');
    b.later(59);
    assert.equal(await b.dog.judged('demo', { ...MUTE, memory: FULL.memory }), 'watching', '59 minutes: not yet');
    assert.deepEqual(b.acted, []);
    b.later(1);
    assert.equal(await b.dog.judged('demo', MUTE), 'restarted');
    assert.deepEqual(b.acted, ['demo']);
    assert.equal(b.told.length, 1);
    assert.match(b.told[0].text, /^Your machine did not answer for 1 h: it was restarted automatically at \d\d:\d\d\.$/);
    assert.equal(b.told[0].started, true, 'the tool is told to read its chat again');
    assert.equal(b.alerts.length, 1);
    assert.match(b.alerts[0].title, /demo: restarted by its watchdog/);
    assert.match(b.alerts[0].body, /Started in 20 s\./);
    assert.equal(b.dog.of('demo').last.ok, true);
    /* Mute again at once (it boots): nothing; still mute an hour later, too soon: said once, never done again. */
    assert.equal(await b.dog.judged('demo', BOOTING), null);
    assert.equal(await b.dog.judged('demo', MUTE), 'watching');
    b.later(61);
    assert.equal(await b.dog.judged('demo', MUTE), 'held');
    assert.equal(await b.dog.judged('demo', MUTE), null);
    b.later(61);
    assert.equal(await b.dog.judged('demo', MUTE), null);
    assert.deepEqual(b.acted, ['demo'], 'once: never a loop');
    assert.equal(b.alerts.length, 2);
    assert.match(b.alerts[1].body, /not restarted twice/);
});

test('full for its delay: said as memory full; a well look in between starts the count again', async (t) => {
    const b = bench(t, { setting: { on: true, delayMin: 30 } });
    await b.dog.judged('demo', FULL);
    b.later(20);
    assert.equal(await b.dog.judged('demo', WELL), null, 'well: the count starts again');
    b.later(1);
    await b.dog.judged('demo', FULL);
    b.later(29);
    assert.equal(await b.dog.judged('demo', FULL), 'watching');
    b.later(1);
    assert.equal(await b.dog.judged('demo', FULL), 'restarted');
    assert.match(b.told[0].text, /^Your machine's memory stayed full for 30 min: it was restarted automatically at \d\d:\d\d\.$/);
    /* Mute after being full: "(memory full)". Seen well since, and hours later: it may act once more. */
    b.later(5); await b.dog.judged('demo', WELL);
    b.later(AGAIN_MS / 60_000);
    await b.dog.judged('demo', FULL); b.later(10); await b.dog.judged('demo', MUTE); b.later(25);
    assert.equal(await b.dog.judged('demo', MUTE), 'restarted');
    assert.match(b.told[1].text, /^Your machine did not answer for 30 min \(memory full\): it was restarted/);
    assert.deepEqual(b.acted, ['demo', 'demo']);
});

test('off: nothing, however long; turned on again, the count starts from then', async (t) => {
    const b = bench(t, { setting: { on: false, delayMin: 60 } });
    for (let i = 0; i < 5; i += 1) { assert.equal(await b.dog.judged('demo', MUTE), null); b.later(60); }
    assert.deepEqual([b.acted, b.told, b.alerts], [[], [], []]);
    b.setting.on = true;
    assert.equal(await b.dog.judged('demo', MUTE), 'watching');
});

test('it could not be started again: its AI and its owner told so', async (t) => {
    const b = bench(t, { act: async () => ({ ok: false, said: 'Not started: no room.' }) });
    await b.dog.judged('demo', MUTE); b.later(60);
    assert.equal(await b.dog.judged('demo', MUTE), 'failed');
    assert.match(b.told[0].text, /forced off at \d\d:\d\d but did not start again\. Not started: no room\.$/);
    assert.equal(b.told[0].started, false);
    assert.match(b.alerts[0].title, /could not restart it/);
});

/* THROUGH THE REAL LOCK: the host program a stand-in, its machine forced off (vm hardstop) then started. */
const TOOLS = readTools(JSON.stringify([{ id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [] }]));
function real(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-dog-real-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; const states = new Map([['clv-demo', 'Running']]);
    const run = async (argv, options = {}) => {
        const [, verb, vm] = argv;
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...states].map(([name, state]) => ({ name, state })) }), stderr: '' };
        calls.push(argv.slice(1).join(' '));
        if (verb === 'hardstop') { for (const l of ['step term start', 'step term ok 1s']) options.onLine?.(l); states.set(vm, 'Stopped'); for (const l of ['step check start', 'step check ok 0s freed 8.0G']) options.onLine?.(l); }
        if (verb === 'start') states.set(vm, 'Running');
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const all = new Conversations({ store, vms: new Vms(run, ['vmm'], { freshMs: 0 }), tools: TOOLS });
    all.machineSaid = () => {}; all.ready = () => {}; all.drop = () => {};
    store.put({ name: 'demo', tool: 'tool', memoryMb: 1024, diskGb: 8, work: 'kept', phase: 'ready', fixed: FIXES });
    let clock = Date.parse('2026-11-09T02:00:00Z');
    const told = [];
    const dog = new Watchdog({ conversations: all, store: new Store(join(dir, 'watchdog.json')), now: () => clock,
        act: async (name) => { const f = await all.machineAction(name, 'force', { wait: true }); return f.ok ? all.machineAction(name, 'start', { wait: true }) : f; },
        tell: (name, text) => told.push(text) });
    return { all, store, dog, calls, told, later: (min) => { clock += min * 60_000; } };
}

test('through its machine\'s one lock: forced off then started; its owner\'s setting read from the conversation, set by the route', async (t) => {
    const b = real(t);
    assert.deepEqual(b.all.watchdog('demo'), { on: true, delayMin: 60 }, 'the default');
    await b.dog.judged('demo', MUTE); b.later(60);
    assert.equal(await b.dog.judged('demo', MUTE), 'restarted');
    assert.deepEqual(b.calls, ['hardstop clv-demo', 'start clv-demo']);
    assert.equal(b.store.get('demo').machineReport.kind, 'start');
    assert.equal(b.told.length, 1);
    /* The route: off, then a delay of its own; nothing else changes. */
    const api = async (body) => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/conversations/demo/machine', headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        await handleApi(request, { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } }, b.all, {}, undefined, () => true);
        return { status, body: JSON.parse(text) };
    };
    const off = await api({ watchdog: { on: false } });
    assert.deepEqual([off.status, off.body.watchdog], [200, { on: false, delayMin: 60 }]);
    assert.deepEqual(b.store.get('demo').watchdog, { on: false });
    const custom = await api({ watchdog: { on: true, delayMin: 45 } });
    assert.deepEqual(custom.body.watchdog, { on: true, delayMin: 45 });
    assert.equal((await api({ watchdog: { delayMin: 2 } })).status, 400, 'too short');
    assert.equal((await api({ watchdog: { delayMin: 60 } })).body.watchdog.delayMin, 60);
    assert.equal(b.store.get('demo').watchdog, undefined, 'back to the defaults: nothing kept');
});
