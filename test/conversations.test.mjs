import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal, SESSION } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms, vmName } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool', '--go'], memoryMb: 1024, install: [['sudo', 'install-tool']] },
]));

/* A VM manager that records every command and answers what the test decides. */
function bench(t, answers = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const states = new Map();
    const run = async (argv, options) => {
        calls.push(argv.join(' '));
        const verb = argv[0];
        const override = answers[verb]?.(argv, options);
        if (override) return override;
        const vm = verb === 'launch' ? argv[argv.indexOf('--name') + 1] : verb === 'delete' ? argv[2] : argv[1];
        if (verb === 'launch') states.set(vm, 'Running');
        if (verb === 'start') states.set(vm, 'Running');
        if (verb === 'stop') states.set(vm, 'Stopped');
        if (verb === 'suspend') states.set(vm, 'Suspended');
        if (verb === 'delete') states.delete(vm);
        if (verb === 'info') return states.has(vm) ? { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: states.get(vm) } } }), stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const make = (extra = {}) => new Conversations({ store, vms: new Vms(run, ['vmm']), tools: TOOLS, ...extra });
    return { calls, states, store, make, dir };
}

test('creating a conversation launches its own VM, makes the work folder, installs the tool, in that order', async (t) => {
    const b = bench(t);
    const all = b.make();
    const made = all.create({ name: 'demo', tool: 'tool' });
    assert.equal(made.phase, 'building');
    await all.built;
    assert.deepEqual(b.calls, [
        'launch 24.04 --name clv-demo --memory 1024M --disk 8G --cpus 1 --timeout 900',
        'exec clv-demo -- sudo -n snap install multipass-sshfs',
        'exec clv-demo -- sudo -n mkdir -p /work',
        'exec clv-demo -- sudo -n chown ubuntu:ubuntu /work',
        'exec clv-demo -- sudo install-tool',
    ]);
    assert.equal(all.list()[0].phase, 'ready');
    assert.equal(all.list()[0].toolLabel, 'Tool');
});

test('a bad name, an unknown tool, too little memory and a name already taken are refused before any VM exists', (t) => {
    const b = bench(t);
    const all = b.make();
    for (const bad of [{ name: 'Bad Name', tool: 'tool' }, { name: 'ok', tool: 'nope' }, { name: 'ok', tool: 'tool', memoryMb: 256 }]) {
        assert.throws(() => all.create(bad), Refusal);
    }
    all.create({ name: 'demo', tool: 'tool' });
    assert.throws(() => all.create({ name: 'demo', tool: 'tool' }), /already/);
    assert.equal(b.calls.filter((c) => c.startsWith('launch')).length, 1);
});

test('a failed install is said in words, with the last line the machine gave', async (t) => {
    const b = bench(t, { exec: (argv) => (argv.includes('install-tool') ? { code: 1, stdout: '', stderr: 'E: first\nE: unable to locate package\n' } : undefined) });
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    const c = all.list()[0];
    assert.equal(c.phase, 'failed');
    assert.match(c.error, /Installing Tool failed at step 1: E: unable to locate package/);
});

test('opening wakes a stopped machine, and the terminal runs the tool alone in tmux, in the VM', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    b.states.set(vmName('demo'), 'Stopped');
    b.calls.length = 0;
    const said = [];
    const argv = await all.open('demo', (x) => said.push(x));
    assert.deepEqual(b.calls, ['info clv-demo --format json', 'start clv-demo']);
    assert.deepEqual(said, ['Waking the machine...']);
    assert.deepEqual(argv.slice(0, 13), ['vmm', 'exec', 'clv-demo', '--', 'tmux', '-L', 'clavarium', 'new-session', '-A', '-s', SESSION, '-c', '/work']);
    assert.deepEqual(argv.slice(13, 15), ['tool', '--go']);
    await assert.rejects(all.open('nope'), /No such conversation/);
});

test('the tool has exited: the machine stops after the delay, unless someone came back', async (t) => {
    const gone = { exec: (argv) => (argv.includes('has-session') ? { code: 1, stdout: '', stderr: 'no session' } : undefined) };
    const b = bench(t, gone);
    const all = b.make({ stopDelayMs: 30 });
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;

    await all.open('demo'); all.left('demo');
    await all.ended('demo');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(b.states.get('clv-demo'), 'Stopped');

    /* Same exit, but the person reopens the conversation within the delay. */
    await all.open('demo');
    all.left('demo');
    await all.ended('demo');
    await all.open('demo');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(b.states.get('clv-demo'), 'Running', 'reopening cancels the stop');
});

test('a link that merely broke stops nothing: the session is still there, the tool keeps working', async (t) => {
    const b = bench(t);
    const all = b.make({ stopDelayMs: 20 });
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    await all.open('demo'); all.left('demo');
    await all.ended('demo');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(b.states.get('clv-demo'), 'Running');
    assert.equal(b.calls.some((c) => c.startsWith('stop')), false);
});

test('a sleep that was asked for is remembered until the conversation is opened on purpose', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    await all.sleep('demo');
    assert.equal(all.list()[0].asleep, true);
    assert.equal(b.make().list()[0].asleep, true, 'and it survives a restart of the server');
    await all.open('demo');
    assert.equal(all.list()[0].asleep, false);
});

test('Sleep suspends; archive deletes the machine and forgets the conversation', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    await all.sleep('demo');
    assert.equal(b.states.get('clv-demo'), 'Suspended');
    await all.archive('demo');
    assert.equal(b.states.has('clv-demo'), false);
    assert.deepEqual(all.list(), []);
    assert.ok(b.calls.includes('delete --purge clv-demo'));
});

test('a build cut short by a restart is marked failed, with what to do', async (t) => {
    const b = bench(t, { launch: () => new Promise(() => {}) });
    b.make().create({ name: 'demo', tool: 'tool' });
    const after = b.make().list()[0];
    assert.equal(after.phase, 'failed');
    assert.match(after.error, /restarted/);
});
