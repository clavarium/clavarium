/* A COPY OF A CONVERSATION (#221): a new one with its original's work, its tool's state and its accesses; the
   original untouched, woken only the time to read its state, then put to sleep again. Its own files only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, readlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';
import { copyWorkFolder, copied } from '../server/copywork.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [] },
    { id: 'kept', label: 'Kept', command: ['kept'], memoryMb: 1024, install: [], state: { keep: ['.kept'] } },
]));

function bench(t, { prefix = ['vmm'], refuse = () => false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-t-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; const vms = new Map();
    const run = async (argv) => {
        const line = argv.join(' ');
        calls.push(line);
        const [, verb, vm] = argv;
        if (refuse(line)) return { code: 1, stdout: '', stderr: 'refused here' };
        if (verb === 'launch' || verb === 'start') { vms.set(vm, 'Running'); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'stop' || verb === 'suspend') { vms.set(vm, verb === 'stop' ? 'Stopped' : 'Suspended'); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...vms].map(([name, state]) => ({ name, state })) }), stderr: '' };
        if (verb === 'exec' && line.includes('id -u; id -g')) return { code: 0, stdout: '1001\n1001\n', stderr: '' };
        if (verb === 'info') return vms.has(vm) ? { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: vms.get(vm) } } }), stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const machines = new Vms(run, prefix, { freshMs: 0, machineOf: (n) => store.get(n)?.sharedMachine, userOf: (n) => store.get(n)?.machineUser });
    const all = new Conversations({ store, vms: machines, tools: TOOLS, uid: 1000, gid: 1000 });
    const work = []; const rights = [];
    all.copyWork = async (from, to) => { work.push(`${from}>${to}`); };
    all.copyRights = async (from, to) => { rights.push(`${from}>${to}`); };
    return { dir, calls, vms, store, all, work, rights };
}

test('a copy: a new conversation, held while its work and accesses are copied, then ready; the original untouched', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', title: 'Mail', tool: 'tool', memoryMb: 1536, group: 'Home' }); await b.all.built;
    let seen;
    b.all.copyWork = async (from, to) => { seen = b.store.get(to); b.work.push(`${from}>${to}`); };
    const r = await b.all.copy('mail');
    assert.equal(r.title, 'Mail (copy)'); assert.equal(r.tool, 'tool'); assert.equal(r.memoryMb, 1536); assert.equal(r.group, 'Home'); assert.equal(r.copyOf, 'mail');
    await b.all.copied;
    assert.equal(seen.phase, 'building', 'never usable half made');
    assert.deepEqual(b.work, [`mail>${r.name}`]); assert.deepEqual(b.rights, [`mail>${r.name}`]);
    const c = b.store.get(r.name);
    assert.equal(c.phase, 'ready'); assert.equal(c.step, undefined);
    assert.equal(b.store.get('mail').phase, 'ready');
    assert.equal(b.vms.get('clv-mail'), 'Running', 'the original untouched');
});

test('a copy into a shared machine: its place made there; its memory within the machine', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'tool', memoryMb: 6144 }); await b.all.built;
    const r = await b.all.copy('mail', { title: 'Mail two', machine: 'assist', machineMb: 4096 });
    await b.all.copied;
    const c = b.store.get(r.name);
    assert.equal(c.sharedMachine, 'assist'); assert.equal(c.machineMb, 4096); assert.equal(c.memoryMb, 4096);
    assert.equal(c.phase, 'ready');
    assert.match(b.calls.join('\n'), /^vm launch clv-assist 4096$/m);
});

test('a copy: its tool\'s state read from its original, woken for it then put to sleep again, and put in the copy', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) printf 'ARCHIVE-OF %s' "$3"; exit 0;; *"tar -xzf"*) { printf '%s:' "$3"; cat; } > "${dir}/imported"; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.vms.set('clv-mail', 'Suspended'); b.store.patch('mail', { asleep: true });
    const r = await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    assert.equal(b.store.get(r.name).phase, 'ready');
    assert.equal(readFileSync(join(dir, 'imported'), 'utf8'), `clv-${r.name}:ARCHIVE-OF clv-mail`);
    const out = b.calls.join('\n');
    assert.match(out, /^vm start clv-mail$/m, 'woken to read its state');
    assert.ok(out.lastIndexOf('vm start clv-mail') < out.lastIndexOf('clv-mail'), 'then something more done to it: put to sleep');
    assert.notEqual(b.vms.get('clv-mail'), 'Running', 'asleep again');
});

test('a copy reads its tool\'s memory through its original\'s work folder, and puts it in through its own, never through the VM manager\'s channel (14-11)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work'); mkdirSync(work);
    const fake = join(dir, 'vmm');
    /* Its archive written where it is told (the last word: its id), in the work folder; nothing on its output. */
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) for id; do :; done; mkdir -p "${work}/.clavarium-carry"; printf 'ARCHIVE-IN-WORK' > "${work}/.clavarium-carry/$id.tgz"; exit 0;; *"tar -xzf"*) for id; do :; done; { printf '%s:' "$3"; if [ -f "${work}/.clavarium-carry/$id.tgz" ]; then printf 'from-work:'; cat "${work}/.clavarium-carry/$id.tgz"; else cat; fi; } > "${dir}/imported"; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    b.all.workFolder = () => work;
    const r = await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    assert.equal(b.store.get(r.name).phase, 'ready');
    assert.equal(readFileSync(join(dir, 'imported'), 'utf8'), `clv-${r.name}:from-work:ARCHIVE-IN-WORK`, 'put in its own work folder, read from there');
    assert.deepEqual(readdirSync(join(work, '.clavarium-carry')), [], 'taken from there: nothing left in its work');
});

test('a move into a shared machine carries its tool\'s state through its work folder too, never the VM manager\'s channel (14-11)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-move-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work'); mkdirSync(work);
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) for id; do :; done; mkdir -p "${work}/.clavarium-carry"; printf 'STATE-IN-WORK' > "${work}/.clavarium-carry/$id.tgz"; exit 0;; *"tar -xzf"*) for id; do :; done; { if [ -f "${work}/.clavarium-carry/$id.tgz" ]; then printf 'from-work:'; cat "${work}/.clavarium-carry/$id.tgz"; else cat; fi; } > "${dir}/imported"; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    b.all.workFolder = () => work;
    await b.all.moveToShared('mail', { machine: 'assist' });
    await b.all.built;
    assert.equal(b.store.get('mail').phase, 'ready');
    assert.equal(b.store.get('mail').sharedMachine, 'assist');
    assert.equal(readFileSync(join(dir, 'imported'), 'utf8'), 'from-work:STATE-IN-WORK');
    assert.deepEqual(readdirSync(join(work, '.clavarium-carry')), [], 'nothing left in its work');
});

test('a move cut short by a restart of this server: back in its own machine, as it was -- never « build it again » (14-11)', async (t) => {
    const b = bench(t);
    b.store.put({ name: 'mail', tool: 'kept', phase: 'building', step: 'Taking its state along', movingTo: 'assist', movingFromMb: 2048, memoryMb: 1024, sharedMachine: 'assist', machineMb: 4096 });
    const again = new Conversations({ store: b.store, vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm'], { freshMs: 0 }), tools: TOOLS, uid: 1000, gid: 1000 });
    const c = again.get('mail');
    assert.equal(c.phase, 'ready');
    assert.equal(c.sharedMachine, undefined); assert.equal(c.machineMb, undefined); assert.equal(c.memoryMb, 2048);
    assert.equal(c.movingTo, undefined);
    assert.match(c.moved, /stays in its own machine, as it was/);
});

test('a copy of an original that was STOPPED: started to read it, then stopped again -- never left asleep (14-11)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) printf 'ARCHIVE'; exit 0;; *"tar -xzf"*) cat > /dev/null; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.vms.set('clv-mail', 'Stopped');
    b.store.patch('mail', { stopped: true });
    const r = await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    assert.equal(b.store.get(r.name).phase, 'ready');
    const out = b.calls.join('\n');
    assert.match(out, /^vm start clv-mail$/m, 'started to read its state');
    assert.doesNotMatch(out, /^vm suspend clv-mail$/m, 'not put to sleep');
    assert.match(out, /^vm halt clv-mail\b/m, 'stopped again');
    assert.ok(out.indexOf('vm halt clv-mail') < out.indexOf('vm launch clv-copy'), 'before the copy\'s machine is made');
    assert.notEqual(b.store.get('mail').asleep, true);
    assert.equal(b.store.get('mail').lentTo, undefined, 'no longer said read for a copy');
});

test('a copy: refused before anything is made; a copy that fails is said, its original untouched', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'code', tool: 'tool', workOnDisk: true }); await b.all.built;
    await assert.rejects(b.all.copy('code'), /own machine's disk/);
    await assert.rejects(b.all.copy('nobody'), /No such conversation/);
    assert.equal(b.store.all().length, 1, 'nothing made');
    b.all.create({ name: 'mail', tool: 'tool' }); await b.all.built;
    b.all.copyWork = async () => { throw new Error('the disk is full'); };
    const r = await b.all.copy('mail');
    await b.all.copied;
    const c = b.store.get(r.name);
    assert.equal(c.phase, 'failed'); assert.match(c.error, /^Not copied: the disk is full\. Its original is untouched; erase this copy\.$/);
    assert.equal(b.store.get('mail').phase, 'ready');
});

test('its work folder copied as it is, but never what belongs to its original alone', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copywork-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const from = join(dir, 'a'); const to = join(dir, 'b');
    for (const d of ['.parley/files', '.docket', '.tether', '.binder', 'src']) mkdirSync(join(from, d), { recursive: true });
    mkdirSync(to);
    for (const [f, v] of [['.parley/to-agent.jsonl', 'thread'], ['.parley/files/a.png', 'png'], ['.parley/pulse.json', '{}'], ['.parley/speakers.json', '{}'], ['.parley/restart-asked', ''],
        ['.docket/plans.jsonl', 'r'], ['.tether/asks.jsonl', 'q'], ['.binder/asks.jsonl', 'q'], ['src/main.c', 'int'], ['.bash_history', 'ls']]) writeFileSync(join(from, f), v);
    symlinkSync('src/main.c', join(from, 'link'));
    await copyWorkFolder(from, to);
    for (const f of ['.parley/to-agent.jsonl', '.parley/files/a.png', 'src/main.c', '.bash_history']) assert.equal(readFileSync(join(to, f), 'utf8'), readFileSync(join(from, f), 'utf8'), f);
    assert.equal(readlinkSync(join(to, 'link')), 'src/main.c', 'a link stays a link');
    for (const f of ['.parley/pulse.json', '.parley/speakers.json', '.parley/restart-asked', '.docket', '.tether', '.binder']) assert.equal(existsSync(join(to, f)), false, f);
    assert.equal(copied('.docketing'), true, 'only those names');
});

test('a copy: its original, woken the time it is read, is not "asleep" meanwhile -- the server\'s sweep of sleepers never puts it back to sleep under the reading (13-11: exit 255)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) sleep 1; printf 'ARCHIVE'; exit 0;; *"tar -xzf"*) cat > /dev/null; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.vms.set('clv-mail', 'Suspended'); b.store.patch('mail', { asleep: true });
    b.store.patch('mail', { asleep: true });
    assert.deepEqual(b.all.asleep(), ['mail']);
    const seen = [];
    const watch = setInterval(() => seen.push(b.all.asleep().includes('mail')), 20);
    await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    clearInterval(watch);
    assert.ok(seen.includes(false), 'not asleep while it is read');
    assert.deepEqual(b.all.asleep(), ['mail'], 'asleep again after');
});

test('a long copy says how far it is: its work as files and size, as it goes', async (t) => {
    const from = mkdtempSync(join(tmpdir(), 'clv-copy-from-'));
    const to = mkdtempSync(join(tmpdir(), 'clv-copy-to-'));
    t.after(() => { rmSync(from, { recursive: true, force: true }); rmSync(to, { recursive: true, force: true }); });
    mkdirSync(join(from, 'a'));
    writeFileSync(join(from, 'a', 'one'), 'x'.repeat(2048));
    writeFileSync(join(from, 'two'), 'y'.repeat(1024));
    const seen = [];
    const done = await copyWorkFolder(from, join(to, 'w'), (p) => seen.push(p));
    assert.deepEqual(done, { files: 2, bytes: 3072 });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.at(-1), { files: 2, bytes: 3072 });
});

test('a copy shows its steps by name while it carries: its work, its tool\'s memory, put back', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) sleep 1; printf 'ARCHIVE'; exit 0;; *"tar -xzf"*) cat > /dev/null; sleep 1; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.copyWork = async (f, tt, on) => { on?.({ files: 3, bytes: 5 * 1024 * 1024 }); await new Promise((ok) => setTimeout(ok, 200)); return { files: 3, bytes: 5 * 1024 * 1024 }; };
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    const steps = new Set();
    const patch = b.store.patch.bind(b.store);
    b.store.patch = (name, change) => { if (change?.step) steps.add(change.step); return patch(name, change); };
    await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    const all = [...steps].join(' | ');
    assert.match(all, /Copying its work: 3 files, 5 MB/);
    assert.match(all, /Copying Kept's memory/);
    assert.match(all, /Putting Kept's memory in the copy/);
});

test('a copy reads its original first and puts it back to sleep BEFORE its own machine is made: the two never run at once', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-copy-vmm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
for a in "$@"; do case "$a" in *"tar -czf"*) printf 'ARCHIVE'; exit 0;; *"tar -xzf"*) cat > /dev/null; printf '{"name":"mail","at":"x"}'; exit 0;; esac; done
exit 0
`, { mode: 0o755 });
    const b = bench(t, { prefix: [fake] });
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.vms.set('clv-mail', 'Suspended'); b.store.patch('mail', { asleep: true });
    b.calls.length = 0;
    const r = await b.all.copy('mail', { title: 'Copy' });
    await b.all.copied;
    assert.equal(b.store.get(r.name).phase, 'ready');
    const out = b.calls;
    const asleepAgain = out.findIndex((l) => /^vm (suspend|stop) clv-mail$/.test(l));
    const made = out.findIndex((l) => l.startsWith(`vm launch clv-${r.name}`));
    assert.ok(asleepAgain >= 0 && made >= 0, out.join('\n'));
    assert.ok(asleepAgain < made, 'asleep again before the copy\'s machine is launched');
});
