/* WHAT AN OWNER DOES TO A MACHINE (conversations.mjs, machineAction, 09-11): start, stop, restart,
   sleep, force stop -- one at a time per machine, Force stop taking the place of any other, each step
   read from the host program's output, a report at the end. The host program is a stand-in that
   answers as `vm halt` does, step by step; a step may hang until it is ended ("Force now"). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Conversations, Refusal, FIXES, MACHINE_KINDS } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms, stepLine } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';
import { handleApi } from '../server/api.mjs';

const TOOLS = readTools(JSON.stringify([{ id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [] }]));
const tick = (ms = 5) => new Promise((r) => { setTimeout(r, ms); });

/* `ways[verb](argv, options, b)`: what the host program does for that verb (else: done at once). */
function bench(t, ways = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-acts-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const states = new Map();
    const b = { calls, states };
    const run = async (argv, options = {}) => {
        const [, verb, vm] = argv;
        if (!['states', 'info'].includes(verb)) calls.push(argv.slice(1).join(' '));
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...states].map(([name, state]) => ({ name, state })) }), stderr: '' };
        if (ways[verb]) return ways[verb](argv, options, b);
        if (verb === 'halt' || verb === 'hardstop') {
            for (const l of verb === 'halt' ? ['step polite start', 'step polite ok 2s', 'step force skip 0s gone'] : ['step term start', 'step term ok 1s', 'step kill skip 0s gone']) options.onLine?.(l);
            states.set(vm, 'Stopped');
            for (const l of ['step check start', 'step check ok 0s freed 8.0G']) options.onLine?.(l);
        }
        if (verb === 'start') states.set(vm, 'Running');
        if (verb === 'suspend') { options.onLine?.('step suspend start'); states.set(vm, 'Suspended'); options.onLine?.('step suspend ok 3s'); }
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const all = new Conversations({ store, vms: new Vms(run, ['vmm'], { freshMs: 0 }), tools: TOOLS });
    const said = []; const readied = []; const dropped = [];
    all.machineSaid = (name, text, ok, chat) => said.push({ name, text, ok, chat });
    all.ready = (name) => readied.push(name);
    all.drop = (name) => dropped.push(name);
    store.put({ name: 'demo', tool: 'tool', memoryMb: 1024, diskGb: 8, work: 'kept', phase: 'ready', fixed: FIXES });
    states.set('clv-demo', 'Running');
    return Object.assign(b, { all, store, said, readied, dropped });
}
/* A step of the way down that hangs until it is ended (the server's signal), as the host program's does. */
const hangs = (lines) => (argv, options) => new Promise((resolve) => {
    for (const l of lines(argv)) options.onLine?.(l);
    options.signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderr: '', aborted: true }));
});

test('a step line of the host program is read; anything else is not', () => {
    assert.deepEqual(stepLine('step check ok 1s freed 8.0G'), { id: 'check', result: 'ok', s: 1, more: 'freed 8.0G', freedGb: 8 });
    assert.deepEqual(stepLine('step polite start'), { id: 'polite', result: 'start' });
    assert.deepEqual(stepLine('step force timeout 30s'), { id: 'force', result: 'timeout', s: 30 });
    for (const bad of ['', 'REFUSED: no', 'step Polite ok 1s', 'step polite maybe 1s']) assert.equal(stepLine(bad), null, bad);
    assert.deepEqual(MACHINE_KINDS, ['start', 'stop', 'restart', 'sleep', 'force']);
});

test('stop: the way down, step by step on the record, then a report with the RAM freed, said in the journal and its chat', async (t) => {
    const b = bench(t);
    const state = await b.all.machineAction('demo', 'stop');
    assert.equal(state.action.kind, 'stop');
    assert.deepEqual(state.action.steps.map((x) => x.id), ['polite', 'force', 'term', 'kill', 'check']);
    const report = await b.all.acted;
    assert.equal(report.ok, true);
    assert.deepEqual(b.calls, ['halt clv-demo polite kill']);
    assert.deepEqual(report.steps.map((x) => `${x.id}:${x.result}`), ['polite:ok', 'force:skip', 'term:skip', 'kill:skip', 'check:ok']);
    assert.equal(report.freedGb, 8);
    const kept = b.store.get('demo');
    assert.equal(kept.machine, undefined, 'nothing left running on the page');
    assert.equal(kept.machineReport.ok, true);
    assert.match(kept.machineReport.said, /^Stopped in \d+ s \(polite stop 2 s, check 0 s\), 8\.0 GB freed\.$/);
    assert.deepEqual(b.said.map((x) => [x.ok, x.chat]), [[true, true]]);
    assert.deepEqual(b.dropped, ['demo'], 'its terminal closed first');
});

test('two actions at once: the second is refused while the first runs (sleep included), never run alongside', async (t) => {
    const b = bench(t, { halt: hangs(() => ['step polite start']) });
    await b.all.machineAction('demo', 'stop');
    for (const kind of ['stop', 'start', 'sleep', 'restart']) await assert.rejects(b.all.machineAction('demo', kind), (e) => e instanceof Refusal && e.status === 409, kind);
    await assert.rejects(b.all.sleep('demo'), /busy/);
    await assert.rejects(b.all.restart('demo'), /busy/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 2048 }), /busy/);
    await assert.rejects(b.all.open('demo'), /being changed/, 'not woken under a stop');
    assert.deepEqual(b.calls, ['halt clv-demo polite kill'], 'only the first ran');
    assert.equal(b.store.get('demo').machine.steps[0].state, 'run');
});

test('Force stop takes the place of a running action: it is ended, and the qemu is ended without the VM manager', async (t) => {
    const b = bench(t, { halt: hangs(() => ['step polite start']) });
    await b.all.machineAction('demo', 'stop');
    const stopping = b.all.acted;
    const state = await b.all.machineAction('demo', 'force');
    assert.equal(state.action.kind, 'force');
    assert.deepEqual(state.action.steps.map((x) => x.id), ['term', 'kill', 'check']);
    const first = await stopping;
    assert.equal(first.ok, false); assert.equal(first.preempted, true);
    const report = await b.all.acted;
    assert.equal(report.ok, true);
    assert.deepEqual(b.calls, ['halt clv-demo polite kill', 'hardstop clv-demo']);
    assert.equal(b.store.get('demo').machineReport.kind, 'force');
    assert.match(b.store.get('demo').machineReport.said, /^Stopped by force in \d+ s \(SIGTERM 1 s, check 0 s\), 8\.0 GB freed\.$/);
});

test('Force stop also ends a restart under way: the restart says so, then the machine is forced off', async (t) => {
    const b = bench(t, { halt: hangs(() => ['step polite start']) });
    const told = []; b.all.renewed = (name, text) => told.push(text);
    await b.all.machineAction('demo', 'restart');
    const restarting = b.all.restarted;
    await b.all.machineAction('demo', 'force');
    await restarting; const report = await b.all.acted;
    assert.match(told[0], /not restarted: it was stopped by force instead/);
    assert.equal(report.ok, true);
    assert.equal(b.store.get('demo').phase, 'ready');
    assert.equal(b.calls.includes('start clv-demo'), false, 'not started after the force');
});

test('"Force now" ends the step running and starts the next one; nothing to move on from is refused', async (t) => {
    let n = 0;
    const b = bench(t, {
        halt: (argv, options, bb) => {
            n += 1;
            if (n === 1) return hangs(() => ['step polite start'])(argv, options);
            for (const l of ['step force start', 'step force ok 1s']) options.onLine?.(l);
            bb.states.set('clv-demo', 'Stopped');
            for (const l of ['step check start', 'step check ok 1s freed 2.0G']) options.onLine?.(l);
            return { code: 0, stdout: '', stderr: '' };
        },
    });
    await assert.rejects(b.all.machineAction('demo', 'force-now'), /Nothing to move on/);
    await b.all.machineAction('demo', 'stop');
    await tick();
    await b.all.machineAction('demo', 'force-now');
    const report = await b.all.acted;
    assert.equal(report.ok, true);
    assert.deepEqual(b.calls, ['halt clv-demo polite kill', 'halt clv-demo force kill']);
    assert.deepEqual(report.steps.map((x) => `${x.id}:${x.result}`), ['polite:skip', 'force:ok', 'check:ok']);
});

test('a VM manager that does not answer: the report says it failed, and what to do (its restart is the owner\'s call)', async (t) => {
    const b = bench(t, {
        halt: (argv, options) => {
            for (const l of ['step polite start', 'step polite timeout 60s', 'step force start', 'step force timeout 30s', 'step term start', 'step term ok 1s', 'step kill skip 0s gone', 'step check start', 'step check fail 2s mute freed 8.0G']) options.onLine?.(l);
            return { code: 1, stdout: '', stderr: '' };
        },
    });
    await b.all.machineAction('demo', 'stop');
    const report = await b.all.acted;
    assert.equal(report.ok, false);
    assert.equal(report.advice, 'manager');
    assert.match(report.said, /^Not stopped in \d+ s \(polite stop timeout 60 s, forced stop timeout 30 s, SIGTERM 1 s, check fail 2 s\)\..*VM manager may need a restart: that is your call\.$/);
    assert.deepEqual(b.said.map((x) => x.ok), [false]);
    assert.equal(b.calls.some((c) => /revive/.test(c)), false, 'the VM manager is never restarted by itself');
});

test('a qemu that stays, its owner having chosen the VM manager\'s ways only: Force stop advised', async (t) => {
    const b = bench(t, {
        halt: (argv, options, bb) => {
            if (argv[3] === 'polite') {
                assert.equal(argv[4], 'force', 'the VM manager\'s own ways only');
                for (const l of ['step polite start', 'step polite timeout 60s', 'step check start', 'step check fail 10s qemu-left freed 0.0G']) options.onLine?.(l);
                return { code: 1, stdout: '', stderr: '' };
            }
            return hangs(() => ['step force start'])(argv, options);
        },
    });
    assert.equal(b.all.setStopEscalate('demo', false).escalate, false);
    await b.all.machineAction('demo', 'stop');
    assert.deepEqual(b.store.get('demo').machine.steps.map((x) => x.id), ['polite', 'force', 'check']);
    const report = await b.all.acted;
    assert.equal(report.ok, false); assert.equal(report.advice, 'force');
    assert.match(report.said, /Use Force stop\.$/);
    assert.equal(b.all.setStopEscalate('demo', true).escalate, true, 'the default, back');
    assert.equal(b.store.get('demo').stopEscalate, undefined);
});

test('"Force now" past the forced stop, for an owner who chose the VM manager\'s ways only, goes on to SIGTERM', async (t) => {
    let n = 0;
    const b = bench(t, {
        halt: (argv, options, bb) => {
            n += 1;
            if (n === 1) return hangs(() => ['step polite start', 'step polite timeout 60s', 'step force start'])(argv, options);
            assert.deepEqual(argv.slice(3), ['term', 'kill']);
            for (const l of ['step term start', 'step term ok 1s']) options.onLine?.(l);
            bb.states.set('clv-demo', 'Stopped');
            for (const l of ['step check start', 'step check ok 0s freed 4.0G']) options.onLine?.(l);
            return { code: 0, stdout: '', stderr: '' };
        },
    });
    b.all.setStopEscalate('demo', false);
    await b.all.machineAction('demo', 'stop');
    await tick();
    const state = await b.all.machineAction('demo', 'force-now');
    assert.deepEqual(state.action.steps.map((x) => x.id), ['polite', 'force', 'term', 'kill', 'check']);
    const report = await b.all.acted;
    assert.equal(report.ok, true); assert.equal(report.freedGb, 4);
});

test('sleep goes through the same lock and the same report; start wakes it and starts its tool', async (t) => {
    const b = bench(t);
    await b.all.machineAction('demo', 'sleep');
    const slept = await b.all.acted;
    assert.equal(slept.ok, true);
    assert.equal(b.store.get('demo').asleep, true);
    assert.deepEqual(slept.steps.map((x) => `${x.id}:${x.result}`), ['suspend:ok']);
    await b.all.machineAction('demo', 'start');
    const started = await b.all.acted;
    assert.equal(started.ok, true);
    assert.equal(b.store.get('demo').asleep, false);
    assert.deepEqual(b.readied, ['demo'], 'its tool starts, after the machine is given back');
    await assert.rejects(b.all.machineAction('demo', 'start'), /runs already/);
    await assert.rejects(b.all.machineAction('demo', 'nonsense'), /Not an action/);
    await assert.rejects(b.all.machineAction('nobody', 'stop'), /No such/);
});

test('a sleep whose qemu stays: not asleep, said, and Force stop advised', async (t) => {
    const b = bench(t, { suspend: (argv, options) => { for (const l of ['step suspend start', 'step suspend ok 3s qemu-left', 'step resleep start', 'step resleep fail 9s', 'step stop start', 'step stop fail 120s']) options.onLine?.(l); return { code: 78, stdout: '', stderr: 'REFUSED: suspended clv-demo but its memory was not freed' }; } });
    await assert.rejects(b.all.sleep('demo'), /did not go to sleep/);
    const report = b.store.get('demo').machineReport;
    assert.equal(report.ok, false); assert.equal(report.advice, 'force');
    assert.deepEqual(report.steps.map((x) => x.id), ['suspend', 'resleep', 'stop']);
    assert.notEqual(b.store.get('demo').asleep, true);
});

test('an action cut short by a restart of the server is said as such, never left running', async (t) => {
    const b = bench(t, { halt: hangs(() => ['step polite start']) });
    await b.all.machineAction('demo', 'stop');
    const again = new Conversations({ store: b.store, vms: new Vms(async () => ({ code: 0, stdout: '{"list":[]}', stderr: '' }), ['vmm']), tools: TOOLS });
    const state = again.machineState('demo');
    assert.equal(state.action, null);
    assert.equal(state.report.cut, true);
    assert.deepEqual(state.report.steps, [{ id: 'polite', result: 'cut' }]);
});

/* THE ROUTES: one POST with an action, one GET for the page; the owner's side only. */
async function api(method, path, body, conversations) {
    const request = Object.assign(Readable.from([Buffer.from(body ? JSON.stringify(body) : '')]), { method, url: path, headers: { 'content-type': 'application/json' } });
    let status; let text = '';
    const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
    await handleApi(request, response, conversations, {}, undefined, () => true);
    return { status, body: JSON.parse(text) };
}

test('routes: POST .../machine {action} acts, {escalate} chooses, GET .../machine reads the steps', async (t) => {
    const b = bench(t, { halt: hangs(() => ['step polite start']) });
    const posted = await api('POST', '/api/conversations/demo/machine', { action: 'stop' }, b.all);
    assert.equal(posted.status, 202);
    assert.equal(posted.body.action.kind, 'stop');
    const read = await api('GET', '/api/conversations/demo/machine', null, b.all);
    assert.equal(read.status, 200);
    assert.equal(read.body.action.steps[0].state, 'run');
    assert.equal(read.body.limits.polite, 60);
    assert.equal((await api('POST', '/api/conversations/demo/machine', { action: 'sleep' }, b.all)).status, 409);
    assert.equal((await api('POST', '/api/conversations/demo/machine', { action: 'force-now' }, b.all)).status, 202);
    assert.equal((await api('POST', '/api/conversations/demo/machine', { action: 'force' }, b.all)).status, 202);
    await b.all.acted;
    assert.equal((await api('POST', '/api/conversations/demo/machine', { action: 'nuke' }, b.all)).status, 400);
    const chose = await api('POST', '/api/conversations/demo/machine', { escalate: false }, b.all);
    assert.deepEqual([chose.status, chose.body.escalate], [200, false]);
    assert.equal((await api('GET', '/api/conversations/nobody/machine', null, b.all)).status, 404);
});

test('the lock is given back whatever happens to the host call: killed by its bound, failing, or throwing', async (t) => {
    for (const way of [
        () => ({ code: null, stdout: '', stderr: '' }),
        () => ({ code: 124, stdout: 'step polite start\n', stderr: '' }),
        () => { throw new Error('spawn failed'); },
    ]) {
        const b = bench(t, { halt: (argv, options) => { options.onLine?.('step polite start'); return way(); }, suspend: () => way() });
        await b.all.machineAction('demo', 'stop');
        const report = await b.all.acted;
        assert.equal(report.ok, false);
        assert.equal(b.store.get('demo').machine, undefined, 'nothing left running on the page');
        await assert.rejects(b.all.sleep('demo'), /did not go to sleep/, 'the next one runs: the lock was given back');
        await b.all.machineAction('demo', 'force');
        assert.equal((await b.all.acted).ok, true);
    }
});

test('a frozen machine is never left "going to sleep": refused at once, Force stop advised; a busy refusal says which action runs', async (t) => {
    const b = bench(t, { suspend: (argv, options) => { for (const l of ['step suspend start', 'step suspend fail 0s frozen']) options.onLine?.(l); return { code: 78, stdout: '', stderr: 'REFUSED: its qemu is frozen: a suspend would hang the VM manager; use Force stop' }; } });
    await assert.rejects(b.all.sleep('demo'), /frozen/);
    const report = b.store.get('demo').machineReport;
    assert.equal(report.advice, 'force');
    assert.match(report.said, /frozen/);
    const h = bench(t, { halt: hangs(() => ['step polite start']) });
    await h.all.machineAction('demo', 'stop');
    await assert.rejects(h.all.machineAction('demo', 'start'), /^Error: Its machine is busy: stopping for \d+ s\. Wait, or force it off\.$|busy: stopping/);
});
