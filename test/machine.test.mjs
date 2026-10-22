/* A conversation's machine, restarted and given more memory or disk by its
   owner. The VM manager is a stand-in that records what it is asked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal, FIXES } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms, megabytes } from '../server/vm.mjs';
import { readTools, NPM_WRITABLE } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 2048, install: [['sudo', 'npm', 'install', '-g', 'tool'], 'npm-writable'] },
    { id: 'plain', label: 'Plain', command: ['plain'], memoryMb: 768, install: [] },
    { id: 'again', label: 'Again', command: ['again'], resume: ['again', '--continue'], memoryMb: 2048, install: [] },
]));

/* `failStarts`: the starts (counted from 1) that fail, the machine left as it was. */
function bench(t, { stuck = false, refuseSet = false, unread = false, startFailsRunning = false, failStarts = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-machine-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const states = new Map();
    const sizes = new Map();
    let starts = 0;
    const run = async (argv) => {
        calls.push(argv.slice(1).join(' '));
        const [area, verb, vm] = argv;
        if (area !== 'vm') return { code: 0, stdout: '', stderr: '' };
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...states].map(([name, state]) => ({ name, state })) }), stderr: '' };
        if (verb === 'info') return states.has(vm) ? { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: states.get(vm) } } }), stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        if (verb === 'stop') { if (stuck) return { code: 1, stdout: '', stderr: 'timed out' }; states.set(vm, 'Stopped'); }
        if (verb === 'kill') { if (unread) { states.delete(vm); return { code: 1, stdout: '', stderr: 'timed out' }; } states.set(vm, 'Stopped'); }
        if (verb === 'start' && failStarts.includes(++starts)) return { code: 1, stdout: '', stderr: 'not enough memory' };
        if (verb === 'start') { states.set(vm, 'Running'); if (startFailsRunning) return { code: 2, stdout: '', stderr: "Please install the 'multipass-sshfs' snap manually inside the instance." }; }
        if (verb === 'suspend') states.set(vm, 'Suspended');
        if (verb === 'size') { const s = sizes.get(vm) ?? { memory: '1.0GiB', disk: '8.0GiB' }; return { code: 0, stdout: `memory ${s.memory}\ndisk ${s.disk}\n${s.cpus ? `cpus ${s.cpus}\n` : ''}`, stderr: '' }; }
        if (verb === 'set') {
            if (refuseSet || states.get(vm) !== 'Stopped') return { code: 1, stdout: '', stderr: 'instance must be stopped' };
            const s = sizes.get(vm) ?? { memory: '1.0GiB', disk: '8.0GiB' };
            sizes.set(vm, { ...s, [argv[3]]: `${argv[4]}${argv[3] === 'memory' ? 'M' : argv[3] === 'disk' ? 'G' : ''}` });
        }
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const all = new Conversations({ store, vms: new Vms(run, ['vmm'], { freshMs: 0 }), tools: TOOLS });
    const readied = [];
    all.ready = (name) => readied.push(name);
    /* A conversation as it is once built, its machine running. */
    const ready = (name, extra = {}) => { store.put({ name, tool: 'tool', memoryMb: 2048, diskGb: 8, work: 'kept', phase: 'ready', fixed: FIXES, ...extra }); states.set(`clv-${name}`, 'Running'); };
    return { all, store, calls, states, sizes, ready, readied };
}

test('sizes as the VM manager writes them are read in megabytes', () => {
    assert.equal(megabytes('2G'), 2048);
    assert.equal(megabytes('2.0GiB'), 2048);
    assert.equal(megabytes('1536M'), 1536);
    assert.equal(megabytes('1073741824'), 1024);
    assert.equal(megabytes('8.0GiB'), 8192);
    for (const bad of ['', 'lots', '2 G', '-1G', undefined]) assert.equal(megabytes(bad), undefined, String(bad));
});

test('a restart stops the machine cleanly, starts it again, and gives the tool back its terminal', async (t) => {
    const b = bench(t);
    b.ready('demo');
    const dropped = []; b.all.drop = (name) => dropped.push(name);
    const answer = await b.all.restart('demo');
    assert.equal(answer.phase, 'restarting');
    await assert.rejects(b.all.restart('demo'), /being restarted already/);
    await b.all.restarted;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['stop clv-demo', 'start clv-demo']);
    assert.deepEqual(dropped, ['demo'], 'its terminal was closed before the stop');
    assert.deepEqual(b.readied, ['demo'], 'started again as after any start');
    const c = b.store.get('demo');
    assert.equal(c.phase, 'ready'); assert.equal(c.restarted, 'Restarted.');
});

test('a clean stop that hangs is followed by a stop by force', async (t) => {
    const b = bench(t, { stuck: true });
    b.ready('demo');
    await b.all.restart('demo');
    await b.all.restarted;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['stop clv-demo', 'kill clv-demo', 'start clv-demo']);
    assert.equal(b.store.get('demo').restarted, 'Restarted.');
});

test('folders being mounted again are left to finish before the machine is stopped', async (t) => {
    const b = bench(t);
    b.ready('demo');
    let done; const mounting = new Promise((r) => { done = r; });
    b.all.quiet = (name) => (name === 'demo' ? mounting : null);
    await b.all.restart('demo');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(b.calls.some((c) => c.startsWith('stop')), false, 'not stopped while a folder is mounted');
    assert.equal(b.store.get('demo').step, 'Waiting for its folders to be mounted');
    done();
    await b.all.restarted;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['stop clv-demo', 'start clv-demo']);
    assert.equal(b.store.get('demo').restarted, 'Restarted.');
});

test('a start the VM manager calls failed for its own mounts, the machine running, is a start: its size is said changed', async (t) => {
    const b = bench(t, { startFailsRunning: true });
    b.ready('demo');
    await b.all.resize('demo', { memoryMb: 3072 });
    await b.all.resized;
    assert.equal(b.store.get('demo').phase, 'ready');
    assert.match(b.store.get('demo').restarted, /^It now has 3072 MB of memory/);
    assert.deepEqual(b.readied, ['demo'], 'started again as after any start');
});

test('a machine whose state cannot be read after a stop by force is not said to be gone', async (t) => {
    const b = bench(t, { stuck: true, unread: true });
    b.ready('demo');
    await b.all.restart('demo');
    await b.all.restarted;
    assert.match(b.store.get('demo').restarted, /did not stop \(its state could not be read\)/);
    assert.doesNotMatch(b.store.get('demo').restarted, /gone/);
});

test('a machine asleep is stopped by force (it cannot be stopped cleanly), then started; it is no longer asleep', async (t) => {
    const b = bench(t);
    b.ready('demo', { asleep: true });
    b.states.set('clv-demo', 'Suspended');
    await b.all.restart('demo');
    await b.all.restarted;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['kill clv-demo', 'start clv-demo']);
    assert.equal(b.store.get('demo').asleep, false);
});

test('a restart is refused for a conversation that is not ready, or whose machine is gone', async (t) => {
    const b = bench(t);
    b.ready('building', { phase: 'building' });
    await assert.rejects(b.all.restart('building'), Refusal);
    b.ready('gone'); b.states.delete('clv-gone');
    await assert.rejects(b.all.restart('gone'), /no longer exists/);
    await assert.rejects(b.all.restart('nobody'), /No such/);
});

test('memory and disk: the machine is stopped, set, started, and the record holds what the VM manager says', async (t) => {
    const b = bench(t);
    b.ready('demo');
    b.sizes.set('clv-demo', { memory: '2048M', disk: '8.0GiB' });
    await b.all.resize('demo', { memoryMb: 4096, diskGb: 20 });
    await b.all.resized;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['stop clv-demo', 'set clv-demo memory 4096', 'set clv-demo disk 20', 'start clv-demo', 'size clv-demo']);
    const c = b.store.get('demo');
    assert.equal(c.memoryMb, 4096); assert.equal(c.diskGb, 20); assert.equal(c.phase, 'ready');
    assert.equal(c.restarted, 'It now has 4096 MB of memory, 1 core, 20 GB of disk.');
    assert.deepEqual(b.readied, ['demo']);
});

test('a stopped machine is set and left stopped', async (t) => {
    const b = bench(t);
    b.ready('demo'); b.states.set('clv-demo', 'Stopped');
    await b.all.resize('demo', { memoryMb: 3072 });
    await b.all.resized;
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), ['set clv-demo memory 3072', 'size clv-demo']);
    assert.equal(b.states.get('clv-demo'), 'Stopped');
    assert.deepEqual(b.readied, [], 'nothing is started');
});

test('what cannot be is refused before anything is touched: less than the tool needs, a smaller disk, nothing new -- asleep too', async (t) => {
    const b = bench(t);
    b.ready('demo', { diskGb: 16 });
    await assert.rejects(b.all.resize('demo', { memoryMb: 1024 }), /between 2048 MB/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 999999 }), /16384 MB/);
    await assert.rejects(b.all.resize('demo', { diskGb: 8 }), /can only grow: it has 16 GB/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 2048, diskGb: 16 }), /Nothing to change/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 'a lot' }), Refusal);
    b.ready('sleepy', { asleep: true, diskGb: 16 }); b.states.set('clv-sleepy', 'Suspended');
    await assert.rejects(b.all.resize('sleepy', { memoryMb: 1024 }), /between 2048 MB/);
    await assert.rejects(b.all.resize('sleepy', { diskGb: 8 }), /can only grow: it has 16 GB/);
    await assert.rejects(b.all.resize('sleepy', { memoryMb: 2048 }), /Nothing to change/);
    await assert.rejects(b.all.resize('sleepy', { cpus: 999 }), /Cores: 1 to/);
    assert.equal(b.store.get('sleepy').sizeAtWake, undefined);
    assert.deepEqual(b.calls.filter((c) => !/^(info|states)\b/.test(c)), []);
});

test('a setting refused by the VM manager is said, the machine is started again, and the record keeps the real values', async (t) => {
    const b = bench(t, { refuseSet: true });
    b.ready('demo');
    b.sizes.set('clv-demo', { memory: '2.0GiB', disk: '8.0GiB' });
    await b.all.resize('demo', { memoryMb: 4096 });
    await b.all.resized;
    const c = b.store.get('demo');
    assert.match(c.restarted, /^Not changed: its memory could not be set \(instance must be stopped\)\. It has 2048 MB of memory, 1 core, 8 GB of disk\.$/);
    assert.equal(c.memoryMb, 2048);
    assert.equal(b.states.get('clv-demo'), 'Running');
});

test('a record that says another memory than the machine has is corrected from the VM manager', async (t) => {
    const b = bench(t);
    b.ready('website', { memoryMb: 1024, diskGb: undefined });
    b.sizes.set('clv-website', { memory: '2G', disk: '8.0GiB' });
    await b.all.reconcileAll();
    assert.equal(b.store.get('website').memoryMb, 2048);
    assert.equal(b.store.get('website').diskGb, 8);
});

test('a restart cut short by a restart of the server is said, not left hanging', (t) => {
    const b = bench(t);
    b.ready('demo', { phase: 'restarting', step: 'Stopping the machine' });
    const again = new Conversations({ store: b.store, vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), []), tools: TOOLS });
    assert.equal(again.get('demo').phase, 'ready');
    assert.match(again.get('demo').restarted, /server restarted while this machine was being restarted/);
});

test('npm can write where it installed the tool: a step of the recipe, and given once to a machine built before', async (t) => {
    const tool = TOOLS.find((x) => x.id === 'tool');
    assert.deepEqual(tool.steps.slice(-NPM_WRITABLE.length), NPM_WRITABLE, 'after the npm install');
    assert.deepEqual(NPM_WRITABLE.map((s) => s.argv.join(' ')), ['sudo -n mkdir -p /usr/local/lib/node_modules', 'sudo -n chown -R ubuntu:ubuntu /usr/local/lib/node_modules', 'sudo -n chown ubuntu:ubuntu /usr/local/bin']);
    assert.deepEqual(TOOLS.find((x) => x.id === 'plain').fixups, []);
    const b = bench(t);
    b.ready('old', { fixed: undefined });
    await b.all.open('old');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(b.calls.filter((c) => c.includes('chown')), ['exec clv-old -- sudo -n chown -R ubuntu:ubuntu /usr/local/lib/node_modules', 'exec clv-old -- sudo -n chown ubuntu:ubuntu /usr/local/bin']);
    assert.equal(b.store.get('old').fixed, FIXES);
    /* Once: the next opening does not do it again. */
    await b.all.open('old');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(b.calls.filter((c) => c.includes('chown')).length, 2);
});

test('the catalogue gives Claude Code and OpenCode at least 2 GB, and lets npm update them', async () => {
    const { loadTools } = await import('../server/tools.mjs');
    const tools = loadTools();
    for (const id of ['claude-code', 'opencode']) {
        const tool = tools.find((x) => x.id === id);
        assert.ok(tool.memoryMb >= 2048, id);
        assert.ok(tool.fixups.length > 0, `${id} is updated by npm as the machine's user`);
    }
});

/* The phase used to be set only after an awaited question to the VM
   manager: two restarts, or a restart and a resize, asked together both
   passed the check and ran alongside. */
test('a change of the machine takes it at once: a second restart, a resize or a move asked meanwhile is refused', async (t) => {
    const b = bench(t);
    b.ready('demo');
    const first = b.all.restart('demo');
    assert.equal(b.store.get('demo').phase, 'restarting', 'taken before anything is awaited');
    await assert.rejects(b.all.restart('demo'), /being restarted already/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 4096 }), /being restarted already/);
    await assert.rejects(b.all.moveWork('demo', 'disk'), /being restarted already/);
    await first; await b.all.restarted;
    assert.equal(b.store.get('demo').phase, 'ready');
    assert.equal(b.calls.filter((c) => c.startsWith('start')).length, 1, 'one restart, not two');
});

test('a change refused after it took the machine gives it back as it was', async (t) => {
    const b = bench(t);
    b.ready('gone'); b.states.delete('clv-gone');
    await assert.rejects(b.all.resize('gone', { memoryMb: 4096 }), /no longer exists/);
    assert.equal(b.store.get('gone').phase, 'ready');
    await assert.rejects(b.all.restart('gone'), /no longer exists/);
    assert.equal(b.store.get('gone').phase, 'ready');
});

test('the move of the work folder looks at what must hold under its own phase, and gives the machine back when it refuses', async (t) => {
    const b = bench(t);
    b.ready('demo');
    const moving = b.all.moveWork('demo', 'disk');
    assert.equal(b.store.get('demo').phase, 'moving');
    await assert.rejects(b.all.restart('demo'), /moving its work folder/);
    /* The stand-in prints no size: the move is refused, before anything is touched. */
    await assert.rejects(moving, /size of the work folder could not be read/);
    assert.equal(b.store.get('demo').phase, 'ready');
    assert.equal(b.calls.some((c) => c.startsWith('stop') || c.startsWith('start')), false);
});

/* A machine made when its tool needed less memory: its disk still grows. */
test('a resize that does not change the memory is not refused for a memory below what the tool now needs', async (t) => {
    const b = bench(t);
    b.ready('demo', { memoryMb: 1024 });
    b.sizes.set('clv-demo', { memory: '1024M', disk: '8.0GiB' });
    await b.all.resize('demo', { diskGb: 20 });
    await b.all.resized;
    assert.equal(b.store.get('demo').diskGb, 20);
    assert.equal(b.store.get('demo').memoryMb, 1024);
    await assert.rejects(b.all.resize('demo', { memoryMb: 1536 }), /between 2048 MB/, 'a change of memory is still checked');
});

/* A NEW SIZE CHOSEN WHILE IT SLEEPS: kept, and applied as it wakes. */
const changes = (calls) => calls.filter((c) => !/^(info|states|exec)\b/.test(c));
function asleep(t, options) {
    const b = bench(t, options);
    const asked = []; let refuse = false;
    b.all.room = async (x) => { asked.push(x); if (refuse) throw new Refusal(409, 'Not changed: this server cannot spare it.'); };
    const told = [];
    b.all.renewed = (name, text, running) => told.push({ name, text, running });
    b.ready('demo', { tool: 'again', asleep: true, toolStarted: true });
    b.states.set('clv-demo', 'Suspended');
    b.sizes.set('clv-demo', { memory: '2048M', disk: '8.0GiB' });
    return { ...b, asked, told, refuse: (on) => { refuse = on; } };
}

test('asleep, a new size is checked as a resize would be, kept in its record, and nothing is woken or stopped', async (t) => {
    const b = asleep(t);
    const answer = await b.all.resize('demo', { memoryMb: 3072, diskGb: 20 });
    assert.equal(answer.phase, 'ready');
    assert.equal(answer.asleep, true);
    assert.deepEqual({ ...answer.sizeAtWake, at: undefined }, { memoryMb: 3072, cpus: 1, diskGb: 20, at: undefined });
    assert.deepEqual(b.asked, [{ kind: 'grow', name: 'demo', memoryMb: 1024, diskMb: 12 * 1024 }], 'the reserve, for what it grows by');
    assert.deepEqual(changes(b.calls), [], 'not woken, not stopped, not set');
    assert.equal(b.states.get('clv-demo'), 'Suspended');
    assert.equal(b.store.get('demo').memoryMb, 2048, 'its size is still the one it has');
    /* A second choice replaces the first. */
    await b.all.resize('demo', { memoryMb: 4096 });
    assert.deepEqual({ ...b.store.get('demo').sizeAtWake, at: undefined }, { memoryMb: 4096, cpus: 1, diskGb: 8, at: undefined });
    /* It outlives a restart of this server. */
    const again = new Conversations({ store: b.store, vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), []), tools: TOOLS });
    assert.equal(again.get('demo').sizeAtWake.memoryMb, 4096);
    assert.equal(again.list().find((c) => c.name === 'demo').sizeAtWake.memoryMb, 4096, 'and the page is given it');
    /* Given up: it wakes as it is. */
    assert.equal(b.all.cancelResize('demo').sizeAtWake, undefined);
    assert.throws(() => b.all.cancelResize('demo'), /No new size is waiting/);
    assert.throws(() => b.all.cancelResize('nobody'), /No such/);
});

test('asleep, a new size this server cannot spare is refused and not kept', async (t) => {
    const b = asleep(t);
    b.refuse(true);
    await assert.rejects(b.all.resize('demo', { memoryMb: 8192 }), /cannot spare/);
    assert.equal(b.store.get('demo').sizeAtWake, undefined);
    assert.deepEqual(changes(b.calls), []);
});

test('at its wake, the size kept is applied: woken, stopped cleanly, set, started, and its tool takes up its session', async (t) => {
    const b = asleep(t);
    b.store.patch('demo', { sizeAtWake: { memoryMb: 3072, cpus: 2, diskGb: 20, at: new Date().toISOString() } });
    const steps = [];
    const argv = await b.all.open('demo', (text, progress) => { if (progress) steps.push(progress.steps[progress.at]); });
    b.all.attached('demo'); b.all.left('demo');
    assert.deepEqual(changes(b.calls), ['start clv-demo', 'stop clv-demo', 'set clv-demo memory 3072', 'set clv-demo cpus 2', 'set clv-demo disk 20', 'start clv-demo', 'size clv-demo']);
    assert.ok(argv.join(' ').includes("'again' '--continue'"), 'its tool takes up its last session');
    assert.deepEqual(b.asked, [{ kind: 'start', name: 'demo', memoryMb: 3072 }, { kind: 'grow', name: 'demo', memoryMb: 0, diskMb: 12 * 1024 }]);
    assert.deepEqual([...new Set(steps)], ['waking', 'stopping', 'answering', 'folders', 'tool', 'resume'], 'each step told to the screen that opens');
    const c = b.store.get('demo');
    assert.equal(c.sizeAtWake, undefined, 'applied: no longer waiting');
    assert.equal(c.asleep, false);
    assert.equal(c.phase, 'ready');
    assert.deepEqual([c.memoryMb, c.cpus, c.diskGb], [3072, 2, 20]);
    assert.equal(c.restarted, 'Changed as it woke: it now has 3072 MB of memory, 2 cores, 20 GB of disk.');
    assert.deepEqual(b.told, [{ name: 'demo', text: 'Its machine was restarted as it woke, with 3072 MB of memory, 2 cores, 20 GB of disk: the tool started again.', running: true }]);
    assert.equal(b.states.get('clv-demo'), 'Running');
    /* Its next opening is a plain one. */
    const before = b.calls.length;
    await b.all.open('demo'); b.all.left('demo');
    assert.deepEqual(changes(b.calls.slice(before)), []);
});

test('at its wake, a size this server can no longer spare is not applied: it wakes as it was, and it is said', async (t) => {
    const b = asleep(t);
    b.store.patch('demo', { sizeAtWake: { memoryMb: 8192, cpus: 1, diskGb: 8, at: new Date().toISOString() } });
    let calls = 0;
    b.all.room = async (x) => { b.asked.push(x); if (calls++ === 0) throw new Refusal(409, 'Not started: this server cannot spare 8 GB.'); };
    await b.all.open('demo'); b.all.left('demo');
    assert.deepEqual(changes(b.calls), ['start clv-demo'], 'woken only, nothing stopped or set');
    assert.equal(b.states.get('clv-demo'), 'Running');
    const c = b.store.get('demo');
    assert.equal(c.sizeAtWake, undefined);
    assert.equal(c.memoryMb, 2048);
    assert.equal(c.restarted, 'Not changed as it woke: Not started: this server cannot spare 8 GB. It kept 2048 MB of memory, 1 core, 8 GB of disk.');
    assert.equal(b.told.length, 1);
    assert.equal(b.told[0].running, false, 'its tool did not start again: it is there as it was');
    assert.match(b.told[0].text, /^Its machine was not changed as it woke: Not started/);
});

test('at its wake, a size the VM manager refuses is said, and the machine is started with what it has', async (t) => {
    const b = asleep(t, { refuseSet: true });
    b.store.patch('demo', { sizeAtWake: { memoryMb: 3072, cpus: 1, diskGb: 8, at: new Date().toISOString() } });
    await b.all.open('demo'); b.all.left('demo');
    assert.deepEqual(changes(b.calls), ['start clv-demo', 'stop clv-demo', 'set clv-demo memory 3072', 'start clv-demo', 'size clv-demo']);
    assert.equal(b.states.get('clv-demo'), 'Running');
    const c = b.store.get('demo');
    assert.equal(c.memoryMb, 2048);
    assert.match(c.restarted, /^Not changed as it woke: its memory could not be set \(instance must be stopped\)\. It has 2048 MB of memory, 1 core, 8 GB of disk\.$/);
    assert.equal(b.told[0].running, true);
});

test('at its wake, a machine that does not start with its new size is set back and started: never left stopped', async (t) => {
    /* The first start wakes it; the second, with the new size, fails. */
    const b = asleep(t, { failStarts: [2] });
    b.store.patch('demo', { sizeAtWake: { memoryMb: 3072, cpus: 1, diskGb: 8, at: new Date().toISOString() } });
    await b.all.open('demo'); b.all.left('demo');
    assert.deepEqual(changes(b.calls), ['start clv-demo', 'stop clv-demo', 'set clv-demo memory 3072', 'start clv-demo', 'set clv-demo memory 2048', 'start clv-demo', 'size clv-demo']);
    assert.equal(b.states.get('clv-demo'), 'Running');
    const c = b.store.get('demo');
    assert.equal(c.memoryMb, 2048);
    assert.match(c.restarted, /^Not changed as it woke: the machine did not start \(not enough memory\)\. It has 2048 MB/);
});

test('two screens opening it at once: the size kept is applied once, and a restart is refused meanwhile', async (t) => {
    const b = asleep(t);
    b.store.patch('demo', { sizeAtWake: { memoryMb: 3072, cpus: 1, diskGb: 8, at: new Date().toISOString() } });
    /* Held while this server's room is looked at: the size is being applied. */
    let go; const held = new Promise((r) => { go = r; });
    let looked; const looking = new Promise((r) => { looked = r; });
    b.all.room = async () => { looked(); await held; };
    const first = b.all.open('demo');
    await looking;
    const second = b.all.open('demo');
    await assert.rejects(b.all.restart('demo'), /new size as it wakes/);
    await assert.rejects(b.all.resize('demo', { memoryMb: 4096 }), /new size as it wakes/);
    go();
    await Promise.all([first, second]);
    b.all.left('demo'); b.all.left('demo');
    assert.equal(changes(b.calls).filter((c) => c.startsWith('stop')).length, 1);
    assert.equal(b.store.get('demo').memoryMb, 3072);
});

test('a restart asked while it sleeps applies the size kept for its wake', async (t) => {
    const b = asleep(t);
    await b.all.resize('demo', { memoryMb: 3072 });
    b.asked.length = 0;
    await b.all.restart('demo');
    assert.deepEqual(b.store.get('demo').progress.steps.slice(0, 3), ['stopping', 'setting', 'starting']);
    await b.all.restarted;
    assert.deepEqual(changes(b.calls), ['kill clv-demo', 'set clv-demo memory 3072', 'start clv-demo', 'size clv-demo']);
    assert.deepEqual(b.asked, [{ kind: 'start', name: 'demo', memoryMb: 3072 }]);
    const c = b.store.get('demo');
    assert.equal(c.sizeAtWake, undefined);
    assert.equal(c.memoryMb, 3072);
    assert.equal(c.asleep, false);
    assert.equal(c.restarted, 'Restarted: it now has 3072 MB of memory, 1 core, 8 GB of disk.');
});

test('a machine that runs is resized as before: nothing is kept for later', async (t) => {
    const b = bench(t);
    b.ready('demo');
    b.sizes.set('clv-demo', { memory: '2048M', disk: '8.0GiB' });
    const answer = await b.all.resize('demo', { memoryMb: 3072 });
    assert.equal(answer.phase, 'restarting');
    assert.equal(answer.sizeAtWake, undefined);
    await b.all.resized;
    assert.deepEqual(changes(b.calls), ['stop clv-demo', 'set clv-demo memory 3072', 'start clv-demo', 'size clv-demo']);
    assert.equal(b.store.get('demo').restarted, 'It now has 3072 MB of memory, 1 core, 8 GB of disk.');
});

test('the page asks: a size kept for its wake is answered 200, one applied now 202; cancelling it is a route of its own', async () => {
    const { Readable } = await import('node:stream');
    const { handleApi } = await import('../server/api.mjs');
    const done = [];
    const conversations = {
        list: () => [{ name: 'demo', phase: 'ready' }],
        resize: async (name, asked) => { done.push(['resize', name, asked]); return asked.memoryMb === 3072 ? { name, phase: 'ready', asleep: true, sizeAtWake: { memoryMb: 3072, cpus: 1, diskGb: 8 } } : { name, phase: 'restarting' }; },
        cancelResize: (name) => { done.push(['cancel', name]); return { name, phase: 'ready', asleep: true }; },
    };
    const post = async (path, body) => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        await handleApi(request, response, conversations, {}, undefined, () => true);
        return { status, body: JSON.parse(text) };
    };
    const kept = await post('/api/conversations/demo/machine', { memoryMb: 3072 });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.sizeAtWake.memoryMb, 3072);
    assert.equal((await post('/api/conversations/demo/machine', { memoryMb: 4096 })).status, 202);
    const cancelled = await post('/api/conversations/demo/machine/cancel', {});
    assert.equal(cancelled.status, 200);
    assert.deepEqual(done, [['resize', 'demo', { memoryMb: 3072, diskGb: undefined, cpus: undefined }], ['resize', 'demo', { memoryMb: 4096, diskGb: undefined, cpus: undefined }], ['cancel', 'demo']]);
});
