/* A machine's state, as the VM manager says it: every machine in one question, shared;
   gone only when it lists every machine and not this one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vms, VmUnknown, STATES_FRESH_MS, WAIT_FRESH_MS } from '../server/vm.mjs';
import { judge } from '../server/health.mjs';

const list = (states) => ({ code: 0, stdout: JSON.stringify({ list: Object.entries(states).map(([name, state]) => ({ name, state })) }), stderr: '' });

test('its state; undefined only when the VM manager lists the others and not it', async () => {
    const vms = new Vms(async () => list({ 'clv-demo': 'Running', 'clv-other': 'Suspended' }), ['vmm']);
    assert.equal(await vms.state('demo'), 'Running');
    assert.equal(await vms.state('other'), 'Suspended');
    assert.equal(await vms.state('gone'), undefined);
});

test('one question for every caller: asked together, asked once; asked again after a change', async () => {
    const asked = []; let clock = 0;
    const vms = new Vms(async (argv) => { asked.push(argv.slice(0, 2).join(' ')); await new Promise((r) => setTimeout(r, 20)); return list({ 'clv-a': 'Running', 'clv-b': 'Running' }); }, ['vmm'], { now: () => clock });
    assert.deepEqual(await Promise.all(['a', 'b', 'a', 'b'].map((n) => vms.state(n))), ['Running', 'Running', 'Running', 'Running']);
    assert.deepEqual(asked, ['vm states'], 'four callers, one question');
    await vms.state('a');
    assert.equal(asked.length, 1, 'still fresh');
    clock += 5000; await vms.state('a');
    assert.equal(asked.length, 1, 'a few seconds old: still the shared answer');
    await vms.state('a', { within: WAIT_FRESH_MS });
    assert.equal(asked.length, 2, 'a wait that looks again every few seconds asks again');
    clock += STATES_FRESH_MS; await vms.state('a');
    assert.equal(asked.length, 3, 'asked again once old');
    await vms.run(['vm', 'start', 'clv-a']); await vms.state('a');
    assert.deepEqual(asked.slice(-2), ['vm start', 'vm states'], 'a change makes it asked again');
});

test('a VM manager that does not answer says nothing of the machine: never "no longer exists"', async () => {
    for (const r of [{ code: 1, stdout: '', stderr: 'cannot connect to the multipass socket' }, { code: 124, stdout: '', stderr: '' }, { code: 0, stdout: 'not json', stderr: '' }]) {
        await assert.rejects(new Vms(async () => r, ['vmm']).state('demo'), (e) => e instanceof VmUnknown && e.status === 503 && e.retry === true);
    }
    const said = judge({ state: 'Unknown' });
    assert.equal(said.problems[0].level, 'info');
    assert.doesNotMatch(said.problems[0].text, /no longer exists/);
});

test('asked fresh when an owner acts: never a machine deleted a moment ago taken for one that runs', async () => {
    let states = { 'clv-a': 'Running' }; let asked = 0;
    const vms = new Vms(async () => { asked += 1; return list(states); }, ['vmm'], { now: () => 0 });
    assert.equal(await vms.state('a'), 'Running');
    states = {};
    assert.equal(await vms.state('a'), 'Running', 'the shared answer, a few seconds old');
    assert.equal(await vms.state('a', { fresh: true }), undefined);
    assert.equal(asked, 2);
});

/* 17-11: the shared answer serves 15 s now; one asked while a machine changed must not outlive the change. */
test('an answer asked while a machine started is neither kept nor joined after the start', async () => {
    let states = { 'clv-a': 'Starting' }; const asked = [];
    let release; const held = new Promise((r) => { release = r; });
    const vms = new Vms(async (argv) => {
        asked.push(argv[1]);
        if (argv[1] === 'states') { const now = list(states); if (asked.filter((x) => x === 'states').length === 1) await held; return now; }
        states = { 'clv-a': 'Running' };
        return { code: 0, stdout: '', stderr: '' };
    }, ['vmm'], { now: () => 0 });
    assert.equal(STATES_FRESH_MS, 15_000);
    const early = vms.state('a');
    await new Promise((r) => setImmediate(r));
    await vms.run(['vm', 'start', 'clv-a']);
    assert.equal(await vms.state('a'), 'Running', 'not joined to the question asked before the start');
    release();
    assert.equal(await early, 'Starting', 'the early caller gets its own answer');
    assert.equal(await vms.state('a'), 'Running', 'and that old answer was not kept');
});
