/* SHARED MACHINES (#221): conversations that live in one machine. The first makes it (its door put in); each then
   has its place there -- told to the host, its own user made by the door, its work mounted for that user, its tool
   installed once for all (as root) and its settings as its user. What it runs goes through its door. Leaving: its
   programs ended, its work taken out; the machine goes only with the last one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [['sudo', '-n', 'npm', 'install', '-g', 'tool'], ['tool', '--init']] },
]));

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-shared-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; const vms = new Map(); let installed = false; let uid = 1000;
    const users = new Map();
    const run = async (argv, options = {}) => {
        const line = argv.join(' ');
        calls.push(line);
        const [area, verb, vm] = argv;
        if (area === 'work') return { code: 0, stdout: '', stderr: '' };
        if (verb === 'launch') { vms.set(vm, 'Running'); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'start') { vms.set(vm, 'Running'); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'delete') { vms.delete(vm); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...vms].map(([name, state]) => ({ name, state })) }), stderr: '' };
        if (verb === 'info') return vms.has(vm) ? { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: vms.get(vm) } } }), stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        if (verb === 'exec') {
            const cmd = argv.slice(argv.indexOf('--') + 1);
            if (cmd.includes('npm') && cmd.includes('-g')) installed = true;
            if (/command -v tool/.test(cmd.join(' '))) return { code: installed ? 0 : 1, stdout: '', stderr: '' };
            const door = cmd[2] === 'clavarium-enter' ? cmd[3] : null;
            if (door && cmd.includes('id -u; id -g')) { if (!users.has(door)) users.set(door, ++uid); return { code: 0, stdout: `${users.get(door)}\n${users.get(door)}\n`, stderr: '' }; }
            if (cmd.includes('/usr/local/sbin/clavarium-enter')) assert.match(options.input ?? '', /THE DOOR OF A CONVERSATION/);
        }
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const machines = new Vms(run, ['vmm'], { freshMs: 0,
        machineOf: (n) => store.get(n)?.sharedMachine, userOf: (n) => store.get(n)?.machineUser });
    const all = new Conversations({ store, vms: machines, tools: TOOLS });
    return { calls, vms, store, all, users };
}

test('two conversations in one shared machine: made once, a place each, its tool once for all, each its own user', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist' });
    await b.all.built;
    const first = b.calls.join('\n');
    assert.match(first, /^vm launch clv-assist 1024$/m, 'the machine made, by its own name');
    assert.match(first, /exec clv-assist -- sudo -n install -m 0755 -o root -g root \/dev\/stdin \/usr\/local\/sbin\/clavarium-enter/, 'its door put in');
    assert.match(first, /^vm share clv-assist mail$/m);
    assert.match(first, /^vm smount clv-assist mail work mail 1000 1000 1001 1001$/m, 'its work, for its own user');
    assert.match(first, /exec clv-assist -- sudo -n npm install -g tool/, 'the tool installed for the machine, as root');
    assert.match(first, /exec clv-assist -- sudo -n clavarium-enter mail -- tool --init/, 'its settings as its own user');
    assert.equal(b.store.get('mail').phase, 'ready');
    assert.deepEqual(b.store.get('mail').machineUser, { uid: 1001, gid: 1001 });
    assert.equal(b.store.get('mail').work, 'kept', 'its work always kept here');

    b.calls.length = 0;
    await b.all.admit({ name: 'diary', tool: 'tool', machine: 'assist' });
    b.all.create({ name: 'diary', tool: 'tool', machine: 'assist' });
    await b.all.built;
    const second = b.calls.join('\n');
    assert.doesNotMatch(second, /vm launch/, 'the machine is there: not made again');
    assert.match(second, /^vm smount clv-assist diary work diary 1000 1000 1002 1002$/m, 'its own user, not the first one\'s');
    assert.doesNotMatch(second, /npm install -g tool/, 'the tool is there already');
    assert.equal(b.store.get('diary').phase, 'ready');
    assert.equal(b.vms.size, 1, 'one machine for both');
    assert.throws(() => b.all.create({ name: 'x', tool: 'tool', machine: 'Bad Name' }), Refusal);
});

test('leaving a shared machine: its programs ended, its work taken out, the host told; the machine goes with the last', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist' }); await b.all.built;
    b.all.create({ name: 'diary', tool: 'tool', machine: 'assist' }); await b.all.built;
    b.calls.length = 0;
    await b.all.archive('mail');
    const out = b.calls.join('\n');
    assert.match(out, /exec clv-assist -- sudo -n pkill -KILL -u c-mail/);
    assert.match(out, /^vm sumount clv-assist mail work$/m);
    assert.match(out, /^vm unshare clv-assist mail$/m);
    assert.doesNotMatch(out, /vm delete/, 'diary still lives in it');
    assert.doesNotMatch(out, /userdel/, 'archived: its home kept');
    assert.equal(b.vms.has('clv-assist'), true);
    b.calls.length = 0;
    await b.all.erase('diary');
    const last = b.calls.join('\n');
    assert.match(last, /userdel --remove c-diary/, 'erased: its user and home go');
    assert.match(last, /^vm delete clv-assist$/m, 'the last one gone: the machine goes');
    assert.equal(b.vms.size, 0);
});
