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
        if (verb === 'clone') states.set(argv[3], 'Stopped');
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

/* A machine with a work folder, for the moves: answers what a move asks. */
function moving(t, { size = 40, links = '', vmFree = 5000, room = 'disk 9000 host 20000', failCopy = false } = {}) {
    const b = bench(t, {
        exec: (argv) => {
            const cmd = argv.slice(argv.indexOf('--') + 1).join(' ');
            if (cmd.startsWith('sudo -n du ')) return { code: 0, stdout: `${size}\t/work\n`, stderr: '' };
            if (cmd.startsWith('sudo -n find ')) return { code: 0, stdout: links, stderr: '' };
            if (cmd.startsWith('sudo -n df ')) return { code: 0, stdout: ` Avail\n ${vmFree}\n`, stderr: '' };
            if (failCopy && cmd.startsWith('sudo -n cp ')) return { code: 1, stdout: '', stderr: 'cp: error writing: Input/output error' };
            return undefined;
        },
        work: (argv) => (argv[1] === 'room' ? { code: 0, stdout: `${room}\n`, stderr: '' } : undefined),
    });
    return b;
}
const inVm = (calls) => calls.filter((c) => c.startsWith('exec ')).map((c) => c.replace('exec clv-demo -- sudo -n ', '').replace('exec clv-demo -- ', ''));

test('moving the work to a kept folder: checked, the tool stopped, copied, the tool started again', async (t) => {
    const b = moving(t);
    const started = [];
    const all = b.make(); all.ready = (name) => started.push(name);
    all.create({ name: 'demo', tool: 'tool', workOnDisk: true });
    await all.built;
    b.calls.length = 0; started.length = 0;
    const answer = await all.moveWork('demo', 'kept');
    assert.equal(answer.phase, 'moving');
    await assert.rejects(all.open('demo'), /moving its work folder/);
    await all.moved;
    assert.deepEqual(inVm(b.calls), [
        'du -sm /work', 'find /work -type l ( -lname /* -o -lname *..* ) -print -quit', 'tmux -L clavarium kill-server',
        'mv -T /work /work.before-move', 'cp -r --no-dereference --preserve=mode,timestamps /work.before-move/. /work/', 'rm -rf /work.before-move',
    ]);
    assert.ok(b.calls.indexOf('work room demo') < b.calls.findIndex((c) => c.includes('kill-server')), 'room is known before the tool is stopped');
    const c = all.list()[0];
    assert.deepEqual([c.phase, c.work], ['ready', 'kept']);
    assert.match(c.moved, /now kept here/);
    assert.deepEqual(started, ['demo']);
    await assert.rejects(all.moveWork('demo', 'kept'), /already kept/);
});

test('moving the work to the disk of the machine, and what was kept is put aside', async (t) => {
    const b = moving(t);
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    b.calls.length = 0;
    await all.moveWork('demo', 'disk');
    await all.moved;
    assert.deepEqual(inVm(b.calls), [
        'du -sm /work', 'df -m --output=avail /', 'tmux -L clavarium kill-server',
        'rm -rf /work.moving', 'mkdir /work.moving', 'cp -r --no-dereference --preserve=mode,timestamps /work/. /work.moving/', 'chown -R ubuntu:ubuntu /work.moving',
        'rmdir /work', 'mv -T /work.moving /work',
    ]);
    assert.ok(b.calls.includes('unwork clv-demo'));
    assert.equal(b.calls.at(-1), 'work aside demo');
    assert.equal(all.list()[0].work, 'disk');
});

test('a move is refused, with nothing touched, unless a gigabyte stays free', async (t) => {
    const cases = [
        [{ size: 8500 }, 'kept', /it holds 8500 MB and its kept folder has 9000 MB/],
        [{ size: 100, room: 'disk 9000 host 900' }, 'kept', /the server has 900 MB left/],
        [{ links: '/work/node_modules/.bin/tool\n' }, 'kept', /links that point upwards or outside \(the first: \/work\/node_modules\/.bin\/tool\)/],
    ];
    for (const [options, to, message] of cases) {
        const b = moving(t, options);
        const all = b.make();
        all.create({ name: 'demo', tool: 'tool', workOnDisk: true });
        await all.built;
        b.calls.length = 0;
        await assert.rejects(all.moveWork('demo', to), message);
        assert.ok(!b.calls.some((c) => c.includes('kill-server') || c.includes(' mv ') || c.includes(' cp ')), 'the tool goes on, its files are where they were');
        assert.deepEqual([all.list()[0].phase, all.list()[0].work], ['ready', 'disk']);
    }
    const b = moving(t, { size: 4500, vmFree: 5000 });
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    await assert.rejects(all.moveWork('demo', 'disk'), /4500 MB and the disk of its machine has 5000 MB left/);
    await assert.rejects(all.moveWork('demo', 'elsewhere'), /"kept" or to "disk"/);
    await assert.rejects(all.moveWork('nope', 'disk'), /No such conversation/);
});

test('a copy that fails is undone: the work is where it was, and the tool is started again', async (t) => {
    const b = moving(t, { failCopy: true });
    const started = [];
    const all = b.make(); all.ready = (name) => started.push(name);
    all.create({ name: 'demo', tool: 'tool', workOnDisk: true });
    await all.built;
    b.calls.length = 0; started.length = 0;
    await all.moveWork('demo', 'kept');
    await all.moved;
    const c = all.list()[0];
    assert.deepEqual([c.phase, c.work], ['ready', 'disk']);
    assert.match(c.moved, /Not moved: the copy failed \(cp: error writing: Input\/output error\)\. Its work is where it was\./);
    assert.deepEqual(inVm(b.calls).slice(-2), ['rmdir /work', 'mv -T /work.before-move /work']);
    assert.equal(b.calls.at(-1), 'work aside demo');
    assert.deepEqual(started, ['demo']);
});

test('a file of the machine\'s own disk is read for whoever asked to see it: under /work only, a plain path, a modest size', async (t) => {
    const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    let kind = 'regular file'; let size = content.length;
    const b = bench(t, { exec: (argv) => {
        const cmd = argv.slice(argv.indexOf('--') + 1);
        if (cmd[0] === 'stat') return { code: 0, stdout: `${kind} ${size}\n`, stderr: '' };
        if (cmd[0] === 'base64') return { code: 0, stdout: content.toString('base64'), stderr: '' };
        return undefined;
    } });
    const all = b.make();
    all.create({ name: 'demo', tool: 'tool', workOnDisk: true });
    await all.built;
    b.calls.length = 0;
    const file = await all.machineFile('demo', '/work/out/summary.pdf');
    assert.equal(file.name, 'summary.pdf');
    assert.deepEqual(file.bytes, content, 'raw bytes arrive whole');
    assert.deepEqual(b.calls, ['info clv-demo', 'exec clv-demo -- stat -L -c %F %s -- /work/out/summary.pdf', 'exec clv-demo -- base64 -w 0 -- /work/out/summary.pdf']);
    assert.ok(!b.calls.some((c) => c.includes('sudo')), 'never as root');
    for (const path of ['/etc/shadow', '/work/../etc/shadow', '/work', '/work/', 'work/x', '/work/a b', '/work/x;id', '/work/$(id)', '/workx/y', '/work/./x', '/root/.ssh/id_ed25519', '']) {
        await assert.rejects(all.machineFile('demo', path), /Only a file under \/work/, path);
    }
    kind = 'directory'; await assert.rejects(all.machineFile('demo', '/work/out'), /not a file/);
    kind = 'regular file'; size = 50 * 1024 * 1024; await assert.rejects(all.machineFile('demo', '/work/big.iso'), /too large .*50 MB/);
    await assert.rejects(all.machineFile('nope', '/work/x'), /No such conversation/);
});

/* THE READY-MADE MACHINE: copied when there is one for the tool, the long
   way otherwise or when the copy goes wrong. */
const SHELF = 'clvshelf-20261014-120000';
test('with a ready-made machine, the build copies it, starts it, and passes the steps already done', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.shelf = { pick: (tool) => (tool.id === 'tool' ? SHELF : undefined) };
    const steps = [];
    const original = b.store.patch.bind(b.store);
    b.store.patch = (name, changes) => { if (changes.step) steps.push(changes.step); return original(name, changes); };
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    assert.deepEqual(b.calls, [
        `clone ${SHELF} clv-demo 1024`,
        'start clv-demo',
        'exec clv-demo -- cloud-init status --wait',
        'work make demo',
        `mount clv-demo work demo ${process.getuid()} ${process.getgid()}`,
        'exec clv-demo -- which tool',
    ]);
    assert.deepEqual(steps, ['Preparing the machine', 'Installing Tool (already on the machine)']);
    const c = all.list()[0];
    assert.equal(c.phase, 'ready');
    assert.equal(c.readyMade, true);
});

test('a copy that cannot be made or started is removed, and the machine is built the long way', async (t) => {
    for (const broken of ['clone', 'start']) {
        const b = bench(t, { [broken]: () => ({ code: 1, stdout: '', stderr: 'unknown command' }) });
        const all = b.make();
        all.shelf = { pick: () => SHELF };
        all.create({ name: 'demo', tool: 'tool' });
        await all.built;
        const launched = b.calls.indexOf('launch clv-demo 1024');
        assert.ok(launched > 0, `${broken}: launched after the failed copy`);
        if (broken === 'start') assert.ok(b.calls.slice(0, launched).includes('delete clv-demo'), 'the half-made copy is removed first');
        assert.ok(b.calls.includes('exec clv-demo -- sudo -n snap install multipass-sshfs'));
        assert.ok(b.calls.includes('exec clv-demo -- sudo install-tool'));
        assert.equal(all.list()[0].phase, 'ready');
        assert.equal(all.list()[0].readyMade, undefined);
    }
});

test('a copy whose tool is missing after all installs it the usual way', async (t) => {
    const b = bench(t, { exec: (argv) => (argv.includes('which') ? { code: 1, stdout: '', stderr: '' } : undefined) });
    const all = b.make();
    all.shelf = { pick: () => SHELF };
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    assert.ok(b.calls.includes('exec clv-demo -- sudo install-tool'));
    assert.ok(!b.calls.some((c) => c.startsWith('launch')));
    assert.equal(all.list()[0].phase, 'ready');
});

test('without a ready-made machine, the build is exactly what it was', async (t) => {
    const b = bench(t);
    const all = b.make();
    all.shelf = { pick: () => undefined };
    all.create({ name: 'demo', tool: 'tool' });
    await all.built;
    assert.equal(b.calls[0], 'launch clv-demo 1024');
    assert.ok(!b.calls.some((c) => c.startsWith('clone') || c.includes('cloud-init') || c.includes('which')));
});
