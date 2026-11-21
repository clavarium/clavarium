/* SETTINGS, MACHINES (server/machinelist.mjs, 09-11): every machine with its state, the memory its qemu
   holds and since when; Force stop from the list through the one lock of its machine; the VM manager
   restarted only when confirmed; what is done when it hangs, and when memory is short, set there. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MachineList } from '../server/machinelist.mjs';
import { Conversations, FIXES } from '../server/conversations.mjs';
import { Capacity } from '../server/capacity.mjs';
import { VmWatch } from '../server/vmwatch.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';
import { handleApi } from '../server/api.mjs';

const TOOLS = readTools(JSON.stringify([{ id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [] }]));
const PARAMS = /handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.split('=')[0].trim());
const NOW = Date.parse('2026-11-09T12:00:00Z');

function bench(t, { answers = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mlist-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const states = new Map([['clv-alpha', 'Running'], ['clv-beta', 'Suspended'], ['clv-gamma', 'Stopped']]);
    const host = { answers };
    const run = async (argv, options = {}) => {
        const [area, verb, vm] = argv.slice(argv[0] === 'vmm' ? 1 : 0);
        if (area === 'server' && verb === 'room') return { code: 0, stdout: ['memory 16384 8000', 'machine clv-alpha 3100', 'machineage clv-alpha 7200', 'machine clv-beta 600', 'machineage clv-beta 60'].join('\n') };
        if (verb === 'states') return host.answers ? { code: 0, stdout: JSON.stringify({ list: [...states].map(([name, state]) => ({ name, state })) }), stderr: '' } : { code: 124, stdout: '', stderr: 'timed out' };
        calls.push(`${verb}${vm ? ` ${vm}` : ''}`);
        if (verb === 'hardstop') { options.onLine?.('step term start'); states.set(vm, 'Stopped'); options.onLine?.('step term ok 1s'); options.onLine?.('step check ok 0s freed 3.0G'); }
        if (verb === 'ping') return host.answers ? { code: 0 } : { code: 124, stderr: 'timed out' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const vms = new Vms(run, ['vmm'], { freshMs: 0 });
    const all = new Conversations({ store, vms, tools: TOOLS });
    all.machineSaid = () => {}; all.drop = () => {}; all.ready = () => {};
    for (const name of ['alpha', 'beta', 'gamma']) store.put({ name, tool: 'tool', memoryMb: 4096, diskGb: 8, work: 'kept', phase: 'ready', fixed: FIXES });
    store.patch('gamma', { stopped: true, machineReport: { kind: 'force', ok: true, at: '2026-11-09T11:00:00.000Z', s: 2, steps: [], said: 'Stopped by force in 2 s.' } });
    store.put({ name: 'building', tool: 'tool', memoryMb: 1024, phase: 'building' });
    const capacity = new Capacity({ run: (argv, o) => run(argv, o), store: new Store(join(dir, 'server.json')), conversations: all });
    const vmWatch = new VmWatch({ run: (argv, o) => run(argv, o), store: new Store(join(dir, 'vm-manager.json')), log: () => {} });
    const list = new MachineList({ conversations: all, vms, capacity, vmWatch, now: () => NOW });
    const api = async (method, path, body) => {
        const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        const named = { conversations: all, headers: {}, originOk: () => true, capacity, machineList: list };
        await handleApi(request, response, ...PARAMS.slice(2).map((p) => named[p]));
        return { status, body: JSON.parse(text) };
    };
    return { all, store, list, calls, host, api, vmWatch, capacity };
}

test('the list: name, state, memory its qemu holds, since when; the most first; one being built left out', async (t) => {
    const b = bench(t);
    const got = await b.api('GET', '/api/server/machines');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.machines.map((m) => [m.name, m.state, m.rssMb]), [['alpha', 'Running', 3100], ['beta', 'Suspended', 600], ['gamma', 'Stopped', 0]]);
    assert.equal(got.body.machines[0].since, '2026-11-09T10:00:00.000Z', 'its qemu started two hours ago');
    assert.equal(got.body.machines[2].since, '2026-11-09T11:00:00.000Z', 'stopped: since its last stop here');
    assert.equal(got.body.manager.ok, true);
    assert.equal(got.body.manager.mode, 'night');
    assert.equal(got.body.pressure, 'force');
    /* The VM manager does not answer: every state unknown, never "gone". */
    b.host.answers = false;
    const mute = await b.list.list();
    assert.deepEqual(mute.machines.map((m) => m.state), ['Unknown', 'Unknown', 'Unknown']);
});

test('Force stop from the list: through the one lock of its machine, as from its conversation', async (t) => {
    const b = bench(t);
    const forced = await b.api('POST', '/api/server/machines/alpha/force', {});
    assert.equal(forced.status, 202);
    const report = await b.all.acted;
    assert.equal(report.ok, true);
    assert.equal(report.kind, 'force');
    assert.deepEqual(b.calls, ['hardstop clv-alpha']);
    assert.equal(b.store.get('alpha').stopped, true);
    assert.equal((await b.api('POST', '/api/server/machines/nobody/force', {})).status, 404);
});

test('the machine manager: restarted only when confirmed; when it hangs, and memory short, set here', async (t) => {
    const b = bench(t);
    const refused = await b.api('POST', '/api/server/vm-manager/restart', {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? JSON.stringify(refused.body), /resumes every machine/);
    assert.deepEqual(b.calls, []);
    const done = await b.api('POST', '/api/server/vm-manager/restart', { confirm: true });
    assert.equal(done.status, 200);
    assert.deepEqual(b.calls, ['revive']);
    assert.deepEqual([done.body.manager.last.by, done.body.manager.last.result], ['owner', 'done']);
    const mode = await b.api('POST', '/api/server/vm-manager', { mode: 'ask' });
    assert.deepEqual([mode.status, mode.body.manager.mode], [200, 'ask']);
    assert.equal((await b.api('POST', '/api/server/vm-manager', { mode: 'never' })).status, 400);
    const way = await b.api('POST', '/api/server/pressure', { way: 'sleep' });
    assert.deepEqual([way.status, way.body.pressure], [200, 'sleep']);
    assert.equal((await b.api('GET', '/api/server/machines')).body.pressure, 'sleep');
    assert.equal((await b.api('POST', '/api/server/pressure', { way: 'nuke' })).status, 400);
});
