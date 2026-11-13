/* SHARED MACHINES (#221): conversations that live in one machine. The first makes it (its door put in); each then
   has its place there -- told to the host, its own user made by the door, its work mounted for that user, its tool
   installed once for all (as root) and its settings as its user. What it runs goes through its door. Leaving: its
   programs ended, its work taken out; the machine goes only with the last one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [['sudo', '-n', 'npm', 'install', '-g', 'tool'], ['tool', '--init']] },
    { id: 'kept', label: 'Kept', command: ['kept'], memoryMb: 1024, install: [], state: { keep: ['.kept'] } },
]));

function bench(t, { stopDelayMs, prefix = ['vmm'], refuse = () => false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-shared-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; const vms = new Map(); let installed = false; let uid = 1000;
    const users = new Map(); const alive = new Set();
    const run = async (argv, options = {}) => {
        const line = argv.join(' ');
        calls.push(line);
        const [area, verb, vm] = argv;
        if (refuse(line)) return { code: 1, stdout: '', stderr: 'refused here' };
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
            if (cmd.includes('has-session')) return { code: alive.has(door) ? 0 : 1, stdout: '', stderr: '' };
            if (door && cmd.includes('id -u; id -g')) { if (!users.has(door)) users.set(door, ++uid); return { code: 0, stdout: `${users.get(door)}\n${users.get(door)}\n`, stderr: '' }; }
            if (cmd.includes('/usr/local/sbin/clavarium-enter')) assert.match(options.input ?? '', /THE DOOR OF A CONVERSATION/);
            if (cmd.some((x) => String(x).startsWith('/etc/clavarium/limits/'))) assert.match(options.input, /^mem=\d+\nprocs=1024\n$/);
        }
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const machines = new Vms(run, prefix, { freshMs: 0,
        machineOf: (n) => store.get(n)?.sharedMachine, userOf: (n) => store.get(n)?.machineUser });
    const all = new Conversations({ store, vms: machines, tools: TOOLS, uid: 1000, gid: 1000, ...(stopDelayMs !== undefined ? { stopDelayMs } : {}) });
    return { calls, vms, store, all, users, alive };
}

test('two conversations in one shared machine: made once, a place each, its tool once for all, each its own user', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist' });
    await b.all.built;
    const first = b.calls.join('\n');
    assert.match(first, /^vm launch clv-assist 4096$/m, 'the machine made, by its own name, 4 GB unless said');
    assert.match(first, /exec clv-assist -- sudo -n install -m 0755 -o root -g root \/dev\/stdin \/usr\/local\/sbin\/clavarium-enter/, 'its door put in');
    assert.match(first, /^vm share clv-assist mail$/m);
    assert.match(first, /exec clv-assist -- sudo -n install -D -m 0644 -o root -g root \/dev\/stdin \/etc\/clavarium\/limits\/mail/, 'its limits set');
    assert.match(first, /^vm smount clv-assist mail work mail 1000 1000 1001 1001$/m, 'its work, for its own user');
    assert.match(first, /exec clv-assist -- sudo -n npm install -g tool/, 'the tool installed for the machine, as root');
    assert.match(first, /exec clv-assist -- sudo -n clavarium-enter mail -- tool --init/, 'its settings as its own user');
    assert.equal(b.store.get('mail').phase, 'ready');
    assert.deepEqual(b.store.get('mail').machineUser, { uid: 1001, gid: 1001 });
    assert.equal(b.store.get('mail').work, 'kept', 'its work always kept here');
    assert.equal(b.store.get('mail').machineMb, 4096);

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
    assert.equal(b.store.get('diary').machineMb, 4096, 'the size of its machine, the same for all');
});

test('a new shared machine: its size chosen when it is made; a conversation never asks more than it has', async (t) => {
    const b = bench(t);
    assert.throws(() => b.all.create({ name: 'mail', tool: 'tool', machine: 'small', machineMb: 512 }), /1024 to 16384/);
    assert.throws(() => b.all.create({ name: 'mail', tool: 'tool', machine: 'small', machineMb: 1024, memoryMb: 2048 }), /has 1024 MB/);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'small', machineMb: 2048 }); await b.all.built;
    assert.match(b.calls.join('\n'), /^vm launch clv-small 2048$/m, 'made with the size chosen');
    /* Its size is its own: a second one does not change it, and cannot ask more. */
    assert.throws(() => b.all.create({ name: 'diary', tool: 'tool', machine: 'small', memoryMb: 3072 }), /has 2048 MB/);
    b.all.create({ name: 'diary', tool: 'tool', machine: 'small', machineMb: 8192 }); await b.all.built;
    assert.equal(b.store.get('diary').machineMb, 2048);
    /* The room asked: a new shared machine's size; none for one that is there. */
    const asked = []; b.all.room = async (x) => { asked.push(x.memoryMb); };
    await b.all.admit({ name: 'other', tool: 'tool', machine: 'big', machineMb: 6144 });
    await b.all.admit({ name: 'third', tool: 'tool', machine: 'small' });
    assert.deepEqual(asked, [6144]);
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

test('one tool ends in a shared machine: its programs only, while another one there still has its tool; the machine stops with the last', async (t) => {
    const b = bench(t, { stopDelayMs: 0 });
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist' }); await b.all.built;
    b.all.create({ name: 'diary', tool: 'tool', machine: 'assist' }); await b.all.built;
    const settle = () => new Promise((r) => setTimeout(r, 30));
    b.alive.add('diary'); b.calls.length = 0;
    assert.equal(await b.all.ended('mail'), false, 'its tool exited');
    await settle();
    assert.match(b.calls.join('\n'), /exec clv-assist -- sudo -n pkill -KILL -u c-mail/, 'its own programs ended');
    assert.doesNotMatch(b.calls.join('\n'), /^vm stop/m, 'diary goes on');
    b.alive.clear(); b.calls.length = 0;
    await b.all.ended('diary'); await settle();
    assert.match(b.calls.join('\n'), /^vm stop clv-assist/m, 'none left: the machine stops');
});

test('in a shared machine, its memory is its limit (set without a restart); the machine\'s own memory restarts it, for all', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist', machineMb: 4096 }); await b.all.built;
    b.all.create({ name: 'diary', tool: 'tool', machine: 'assist' }); await b.all.built;
    b.calls.length = 0;
    await b.all.resize('mail', { memoryMb: 2048 });
    assert.equal(b.store.get('mail').memoryMb, 2048);
    assert.match(b.calls.join('\n'), /install -D -m 0644 -o root -g root \/dev\/stdin \/etc\/clavarium\/limits\/mail/);
    assert.doesNotMatch(b.calls.join('\n'), /^vm (stop|set)/m, 'nothing stopped');
    await assert.rejects(b.all.resize('mail', { memoryMb: 8192 }), /and 4096 MB/);
    await assert.rejects(b.all.resize('mail', { memoryMb: 2048, diskGb: 20 }), /those of the shared machine/);
    await assert.rejects(b.all.resizeShared('diary', { machineMb: 1024 }), /no less than the largest/);
    b.calls.length = 0;
    await b.all.resizeShared('diary', { machineMb: 6144 });
    assert.match(b.calls.join('\n'), /^vm stop clv-assist[^\n]*\n(?:[^\n]*\n)*vm set clv-assist memory 6144\n(?:[^\n]*\n)*vm start clv-assist/m, 'stopped, set, started');
    assert.equal(b.store.get('mail').machineMb, 6144); assert.equal(b.store.get('diary').machineMb, 6144);
});

/* MOVED INTO A SHARED MACHINE (#221, 12-11): from a machine of its own, its work following, its tool's state carried. */
test('moved into a shared machine: its own stopped, its place made there, its own machine deleted at the end', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool' }); await b.all.built;
    assert.equal(b.vms.get('clv-mail'), 'Running');
    b.calls.length = 0;
    const r = await b.all.moveToShared('mail', { machine: 'assist' });
    assert.equal(r.phase, 'building');
    await assert.rejects(b.all.moveToShared('mail', { machine: 'assist' }), /not ready|busy/, 'one move at a time');
    await b.all.built;
    const out = b.calls.join('\n');
    assert.match(out, /^vm stop clv-mail$/m, 'its own machine stopped first');
    assert.match(out, /^vm launch clv-assist 4096$/m);
    assert.match(out, /^vm share clv-assist mail$/m);
    assert.match(out, /^vm smount clv-assist mail work mail 1000 1000 1001 1001$/m, 'its work follows, for its own user');
    assert.match(out, /^vm delete clv-mail$/m, 'its own machine deleted, at the end');
    assert.ok(out.indexOf('vm delete clv-mail') > out.indexOf('vm smount clv-assist mail'), 'deleted only once its place is made');
    const c = b.store.get('mail');
    assert.equal(c.phase, 'ready'); assert.equal(c.sharedMachine, 'assist'); assert.equal(c.machineMb, 4096);
    assert.deepEqual([...b.vms.keys()], ['clv-assist']);
    /* The room asked for a new shared machine: its size, less what its own machine (running) gives back. */
    const asked = []; b.all.room = async (x) => { asked.push(x.memoryMb); };
    b.all.create({ name: 'notes', tool: 'tool', memoryMb: 1536 }); await b.all.built;
    asked.length = 0;
    await b.all.moveToShared('notes', { machine: 'other', machineMb: 4096 }); await b.all.built;
    assert.deepEqual(asked, [4096 - 1536]);
    /* A second one joins the same machine; its size is the machine's. */
    b.all.create({ name: 'diary', tool: 'tool' }); await b.all.built;
    await b.all.moveToShared('diary', { machine: 'assist', machineMb: 8192 }); await b.all.built;
    assert.equal(b.store.get('diary').machineMb, 4096);
    assert.deepEqual([...b.vms.keys()].sort(), ['clv-assist', 'clv-other']);
});

test('moved into a shared machine: what is refused, said before anything is done', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool' }); await b.all.built;
    b.all.create({ name: 'code', tool: 'tool', workOnDisk: true }); await b.all.built;
    b.all.create({ name: 'diary', tool: 'tool', machine: 'assist' }); await b.all.built;
    await assert.rejects(b.all.moveToShared('mail', { machine: 'Bad Name' }), /lower-case/);
    await assert.rejects(b.all.moveToShared('mail', { machine: 'diary' }), /name of its own/);
    await assert.rejects(b.all.moveToShared('mail', { machine: 'small', machineMb: 512 }), /1024 to 16384/);
    await assert.rejects(b.all.moveToShared('code', { machine: 'assist' }), /own machine's disk/);
    await assert.rejects(b.all.moveToShared('diary', { machine: 'other' }), /shared machine assist already/);
    assert.equal(b.store.get('mail').phase, 'ready'); assert.equal(b.store.get('mail').sharedMachine, undefined);
});

test('moved into a shared machine: its place not made there -> back in its own machine, as it was, kept', async (t) => {
    const b = bench(t, { refuse: (line) => /^vm share /.test(line) });
    b.all.create({ name: 'mail', tool: 'tool', memoryMb: 1536 }); await b.all.built;
    const told = []; b.all.renewed = (n, text) => told.push(text);
    await b.all.moveToShared('mail', { machine: 'assist' }); await b.all.built;
    const c = b.store.get('mail');
    assert.equal(c.phase, 'ready'); assert.equal(c.sharedMachine, undefined); assert.equal(c.machineMb, undefined); assert.equal(c.memoryMb, 1536);
    assert.equal(b.vms.has('clv-mail'), true, 'its own machine kept');
    assert.doesNotMatch(b.calls.join('\n'), /^vm delete clv-mail$/m);
    assert.match(told.at(-1), /Not moved to the shared machine assist: .*It stays in its own machine/);
    await b.all.moveToShared('mail', { machine: 'assist' }).then(() => b.all.built);   /* may be asked again */
});

test('moved into a shared machine: its tool\'s state taken from its own machine and put back in its new home', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-move-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    /* The VM manager as the server runs it for a stream: an export prints the archive, an import keeps what it reads. */
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) printf 'ARCHIVE-OF %s' "$3"; exit 0;; *"tar -xzf"*) { printf '%s:' "$3"; cat; } > "${dir}/imported"; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    await b.all.moveToShared('mail', { machine: 'assist' }); await b.all.built;
    assert.equal(b.store.get('mail').sharedMachine, 'assist');
    assert.equal(b.store.get('mail').phase, 'ready'); assert.equal(b.store.get('mail').step, undefined, 'nothing left said as running');
    assert.equal(readFileSync(join(dir, 'imported'), 'utf8'), 'clv-assist:ARCHIVE-OF clv-mail', 'taken from its own machine, put back in the shared one');
    assert.equal(b.vms.has('clv-mail'), false);
});

test('in a shared machine, the machine\'s own size is never written as its limit (the server starting again)', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', machine: 'assist', machineMb: 4096 }); await b.all.built;
    assert.equal(b.store.get('mail').memoryMb, 1024);
    await b.all.reconcileAll();
    assert.equal(b.store.get('mail').memoryMb, 1024, 'its limit kept');
    assert.doesNotMatch(b.calls.join('\n'), /^vm size/m, 'not even asked');
});
