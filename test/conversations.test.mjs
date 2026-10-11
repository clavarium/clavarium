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
        /* Every call starts with the area, "vm": it is checked, then left out. */
        /* The area is checked: "vm" is then left out, "work" is kept. */
        assert.ok(argv[0] === 'vm' || argv[0] === 'work', argv.join(' '));
        calls.push(argv[0] === 'vm' ? argv.slice(1).join(' ') : argv.join(' '));
        if (argv[0] === 'work') return answers.work?.(argv, options) ?? { code: 0, stdout: '', stderr: '' };
        const verb = argv[1];
        const override = answers[verb]?.(argv, options);
        if (override) return override;
        const vm = argv[2];
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
        'launch clv-demo 1024',
        'exec clv-demo -- sudo -n snap install multipass-sshfs',
        'work make demo',
        `mount clv-demo work demo ${process.getuid()} ${process.getgid()}`,
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
    assert.deepEqual(b.calls, ['info clv-demo', 'start clv-demo']);
    assert.deepEqual(said, ['Waking the machine...']);
    assert.deepEqual(argv.slice(0, 14), ['vmm', 'vm', 'exec', 'clv-demo', '--', 'tmux', '-L', 'clavarium', 'new-session', '-A', '-s', SESSION, '-c', '/work']);
    assert.deepEqual(argv.slice(14, 16), ['tool', '--go']);
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
    assert.ok(b.calls.includes('delete clv-demo'));
});

test('a build cut short by a restart is marked failed, with what to do', async (t) => {
    const b = bench(t, { launch: () => new Promise(() => {}) });
    b.make().create({ name: 'demo', tool: 'tool' });
    const after = b.make().list()[0];
    assert.equal(after.phase, 'failed');
    assert.match(after.error, /restarted/);
});

test('building again: for a machine that is gone or a build that failed; a working machine is refused', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    await assert.rejects(all.rebuild('demo'), /has its machine/);
    await assert.rejects(all.rebuild('nope'), /No such conversation/);
    /* The machine disappears behind the server's back. */
    b.states.delete('clv-demo');
    await assert.rejects(all.open('demo'), (e) => e.status === 410);
    b.calls.length = 0;
    const again = await all.rebuild('demo');
    assert.equal(again.phase, 'building');
    await assert.rejects(all.rebuild('demo'), /still being built/, 'asked twice, built once');
    await all.built;
    assert.equal(b.calls.filter((c) => c.startsWith('launch')).length, 1);
    assert.ok(!b.calls.some((c) => c.startsWith('delete')), 'nothing to clear away');
    assert.equal(all.list()[0].phase, 'ready');
});

test('building again after a failed build clears away what the failure left', async (t) => {
    let fail = true;
    const b = bench(t, { exec: (argv) => (fail && argv.includes('install-tool') ? { code: 1, stdout: '', stderr: 'no network' } : undefined) });
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    assert.equal(all.list()[0].phase, 'failed');
    fail = false; b.calls.length = 0;
    await all.rebuild('demo');
    await all.built;
    assert.deepEqual(b.calls.slice(0, 2), ['info clv-demo', 'delete clv-demo']);
    assert.equal(all.list()[0].phase, 'ready');
    assert.equal(all.list()[0].error, undefined);
});

test('where the tool works: kept by the server unless asked otherwise; put aside, not erased, when archived', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.create({ name: 'kept', tool: 'tool' });
    await all.built;
    assert.equal(all.list()[0].work, 'kept');
    b.calls.length = 0;
    all.create({ name: 'fast', tool: 'tool', workOnDisk: true });
    await all.built;
    assert.equal(all.list()[1].work, 'disk');
    assert.ok(b.calls.includes('exec clv-fast -- sudo -n mkdir -p /work'));
    assert.ok(!b.calls.some((c) => c.startsWith('work ') || c.includes(' work ')), 'nothing of it is kept here');
    b.calls.length = 0;
    await all.archive('fast');
    assert.ok(!b.calls.some((c) => c.startsWith('work ')));
    await all.archive('kept');
    assert.equal(b.calls.at(-1), 'work aside kept');
});

test('a work folder that cannot be shown in the machine fails the build, and says so', async (t) => {
    const b = bench(t, { mount: () => ({ code: 2, stdout: '', stderr: 'mount failed: no sshfs' }) });
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    assert.match(all.list()[0].error, /work folder could not be shown.*no sshfs/);
});
