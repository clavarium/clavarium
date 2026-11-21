/* A WHOLE CONVERSATION CARRIED ELSEWHERE (14-11): its manifest with what it was given (by id, a secret by its name
   only), its home without caches, its work; put back into a conversation of the same tool, its work only into an
   empty folder unless asked, what it was given linked again where it exists, the rest listed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';
import { accessesOf, relinkAccesses } from '../server/carry.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'kept', label: 'Kept', command: ['kept'], memoryMb: 1024, install: [], state: { keep: ['.kept'], skip: ['.kept/cache'] } },
]));

/* Its machine faked by a VM manager that runs what it is given here: its home a folder of the test, its /work
   the work folder of the test -- the very scripts of the server, with real tar. */
function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-carry-t-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const home = join(dir, 'home'); const work = join(dir, 'work');
    mkdirSync(home); mkdirSync(work);
    const fake = join(dir, 'vmm');
    writeFileSync(fake, `#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
if [ "$1" = sh ] && [ "$2" = -c ]; then s=$(printf '%s' "$3" | sed "s#/work/#${work}/#g"); shift 3; cd "${home}"; HOME="${home}" exec sh -c "$s" "$@"; fi
exit 0
`, { mode: 0o755 });
    const vms = new Map();
    const run = async (argv) => {
        const [, verb, vm] = argv;
        if (verb === 'launch' || verb === 'start') { vms.set(vm, 'Running'); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: [...vms].map(([name, state]) => ({ name, state })) }), stderr: '' };
        if (verb === 'info') return vms.has(vm) ? { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: vms.get(vm) } } }), stderr: '' } : { code: 2, stdout: '', stderr: 'does not exist' };
        if (verb === 'exec' && argv.includes('sh') && argv.includes('import')) {
            const r = spawnSync(fake, argv, { encoding: 'utf8' });
            return { code: r.status, stdout: r.stdout, stderr: r.stderr };
        }
        return { code: 0, stdout: '', stderr: '' };
    };
    const store = new Store(join(dir, 'conversations.json'));
    const machines = new Vms(run, [fake], { freshMs: 0 });
    const all = new Conversations({ store, vms: machines, tools: TOOLS, uid: 1000, gid: 1000 });
    all.workFolder = () => work;
    return { dir, home, work, store, all };
}

const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const save = (stream, file) => new Promise((ok, fail) => { const w = createWriteStream(file); stream.on('error', fail); w.on('finish', ok); stream.pipe(w); });
const listOf = (file) => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

async function exported(b, name) {
    const out = await b.all.exportWhole(name);
    const file = join(b.dir, 'export.tgz');
    await save(out.stream, file);
    return file;
}

test('a whole export: its manifest with its accesses by id, its home without caches, its work; nothing left in its work', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', title: 'Mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    put(join(b.home, '.kept/session'), 'memory'); put(join(b.home, '.kept/cache/big'), 'x');
    put(join(b.home, 'notes/a.txt'), 'a'); put(join(b.home, 'notes/node_modules/dep/i.js'), 'x');
    put(join(b.home, '.cache/pip/x'), 'x'); put(join(b.home, '.npm/x'), 'x'); put(join(b.home, '.local/share/Trash/files/old'), 'x');
    put(join(b.home, '.local/share/kept'), 'k'); put(join(b.home, '.clavarium-import.abc/x'), 'x');
    put(join(b.work, 'project/readme'), 'work');
    b.all.accessesOf = async () => ({ resources: [{ id: 'git:clavarium', access: 'write' }], secrets: ['OVH_KEY'], tethers: [{ id: 't1', level: 'use' }], binders: [], talk: true, guide: [] });
    const file = await exported(b, 'mail');
    const names = listOf(file);
    assert.equal(names[0], 'clavarium-conversation.json', 'its manifest first');
    for (const kept of ['home/.kept/session', 'home/notes/a.txt', 'home/.local/share/kept', 'work/project/readme']) assert.ok(names.includes(kept), `${kept} carried`);
    for (const left of ['.cache', '.npm', 'node_modules', 'Trash', '.clavarium-import', '.kept/cache', '.clavarium-carry']) assert.ok(!names.some((n) => n.includes(left)), `${left} left out`);
    const manifest = JSON.parse(spawnSync('tar', ['-xzOf', file, 'clavarium-conversation.json'], { encoding: 'utf8' }).stdout);
    assert.equal(manifest.version, 2); assert.equal(manifest.whole, true); assert.equal(manifest.tool, 'kept'); assert.equal(manifest.title, 'Mail');
    assert.deepEqual(manifest.accesses.resources, [{ id: 'git:clavarium', access: 'write' }]);
    assert.deepEqual(manifest.accesses.secrets, ['OVH_KEY']);
    assert.deepEqual(readdirSync(join(b.work, '.clavarium-carry')), [], 'its home\'s part taken away');
});

test('its accesses listed by id, a secret by its name only -- never its value', () => {
    const value = 'sk-very-secret-value';
    const deps = {
        folders: { of: () => [{ name: 'clavarium', access: 'write' }, { name: 'docs', access: 'read' }], get: (n) => ({ name: n, type: n === 'docs' ? 'folder' : 'git' }), assetOf: (r) => `${r.type}:${r.name}` },
        secrets: { of: () => ['OVH_KEY'], valueOf: () => value },
        tethers: { grantsOf: () => [{ id: 'mail-1', level: 'use', rules: ['send'] }] },
        binders: { grantsOf: () => [{ id: 'lots-2', level: 'read' }] },
        talk: { isOn: () => true }, guide: { lines: () => ['Be short.'] },
    };
    const a = accessesOf(deps, 'mail');
    assert.deepEqual(a.resources, [{ id: 'git:clavarium', access: 'write' }, { id: 'folder:docs', access: 'read' }]);
    assert.deepEqual(a.secrets, ['OVH_KEY']);
    assert.deepEqual(a.tethers, [{ id: 'mail-1', level: 'use', rules: ['send'] }]); assert.deepEqual(a.binders, [{ id: 'lots-2', level: 'read' }]);
    assert.equal(a.talk, true);
    assert.ok(!JSON.stringify(a).includes(value), 'no secret value');
});

test('an import links again what exists here by the same id, with the same level, and lists the rest', async () => {
    const calls = [];
    const deps = {
        folders: { get: (n) => (n === 'clavarium' ? { name: n, type: 'git' } : undefined), assetOf: (r) => `${r.type}:${r.name}`, attach: async (c, n, a) => { calls.push(`attach ${c} ${n} ${a}`); } },
        secrets: { attach: (c, n) => { if (n !== 'OVH_KEY') throw new Error('No such secret.'); calls.push(`secret ${c} ${n}`); } },
        tethers: { regrant: (c, l) => { calls.push(`tether ${c} ${l.length}`); return l.filter((g) => g.id !== 'mail-1').map((g) => g.id); } },
        binders: { regrant: () => ['lots-9'] },
        talk: { set: async (c, on) => { calls.push(`talk ${c} ${on}`); } }, guide: { setLines: async () => {} },
        gitKeeper: { beforeWriter: (r, c) => { calls.push(`writer ${r} ${c}`); } },
    };
    const r = await relinkAccesses(deps, 'new', {
        resources: [{ id: 'git:clavarium', access: 'write' }, { id: 'folder:gone', access: 'read' }, { id: 'folder:clavarium', access: 'read' }],
        secrets: ['OVH_KEY', 'OLD_KEY'], tethers: [{ id: 'mail-1', level: 'use' }, { id: 'cal-2', level: 'use' }], binders: [{ id: 'lots-9', level: 'read' }], talk: true,
    });
    assert.deepEqual(r.linked, ['git:clavarium', 'secret:OVH_KEY', 'tether:mail-1']);
    assert.deepEqual(r.missing, ['folder:gone', 'folder:clavarium', 'secret:OLD_KEY', 'tether:cal-2', 'binder:lots-9']);
    assert.deepEqual(calls, ['writer clavarium new', 'attach new clavarium write', 'secret new OVH_KEY', 'tether new 2', 'talk new true']);
});

test('a whole import: its home put back, its work restored only into an empty folder unless replaceWork, its accesses re-linked', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    put(join(b.home, '.kept/session'), 'old memory'); put(join(b.home, 'notes/a.txt'), 'notes');
    put(join(b.work, 'project/readme'), 'its work');
    b.all.accessesOf = async () => ({ resources: [{ id: 'git:clavarium', access: 'write' }], secrets: ['OVH_KEY'] });
    const file = await exported(b, 'mail');
    /* Then it changed: its memory, its work. */
    put(join(b.home, '.kept/session'), 'new memory'); put(join(b.work, 'project/readme'), 'changed'); put(join(b.work, 'other'), 'x');
    let given = null;
    b.all.relink = async (name, accesses) => { given = { name, accesses }; return { linked: ['git:clavarium'], missing: ['secret:OVH_KEY'] }; };
    await assert.rejects(() => b.all.importState('mail', file), (e) => e.status === 409 && e.kind === 'work-not-empty');
    assert.equal(readFileSync(join(b.work, 'project/readme'), 'utf8'), 'changed', 'nothing touched when refused');
    assert.equal(readFileSync(join(b.home, '.kept/session'), 'utf8'), 'new memory');
    assert.equal(given, null);
    const r = await b.all.importState('mail', file, { replaceWork: true });
    assert.equal(r.whole, true); assert.deepEqual(r.toLink, ['secret:OVH_KEY']); assert.equal(r.from.name, 'mail');
    assert.equal(given.name, 'mail'); assert.deepEqual(given.accesses.resources, [{ id: 'git:clavarium', access: 'write' }]);
    assert.equal(readFileSync(join(b.home, '.kept/session'), 'utf8'), 'old memory', 'its home put back');
    assert.equal(readFileSync(join(b.home, 'notes/a.txt'), 'utf8'), 'notes');
    assert.equal(readFileSync(join(b.work, 'project/readme'), 'utf8'), 'its work', 'its work put back');
    assert.ok(!existsSync(join(b.work, 'other')), 'replaced, as asked');
    assert.deepEqual(readdirSync(join(b.work, '.clavarium-carry')), [], 'nothing left aside');
});

test('a whole import into an empty work folder needs no asking; another tool\'s export refused', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    put(join(b.work, 'f'), 'w');
    const file = await exported(b, 'mail');
    rmSync(join(b.work, 'f'));
    const r = await b.all.importState('mail', file);
    assert.equal(r.whole, true); assert.deepEqual(r.toLink, []);
    assert.equal(readFileSync(join(b.work, 'f'), 'utf8'), 'w');
    /* Another tool's export: refused before anything is touched. */
    const other = join(b.dir, 'other.tgz'); const m = join(b.dir, 'm'); mkdirSync(m);
    writeFileSync(join(m, 'clavarium-conversation.json'), JSON.stringify({ kind: 'clavarium-conversation', version: 1, tool: 'else' }));
    spawnSync('tar', ['-czf', other, '-C', m, 'clavarium-conversation.json']);
    await assert.rejects(() => b.all.importState('mail', other), (e) => e.status === 400);
});

test('a whole export carries its reminders and wake-ups; its import takes them only when asked, never the docket raw', async (t) => {
    const b = bench(t);
    b.all.create({ name: 'mail', tool: 'kept' }); await b.all.built;
    b.store.patch('mail', { work: 'kept' });
    put(join(b.work, 'f'), 'w');
    put(join(b.work, '.docket/plans.jsonl'), '{"kind":"plan","id":"p1","cron":"0 9 * * *","text":"standup"}\n');
    b.all.wakeupsOf = () => ({ perHour: 3, items: [{ kind: 'every', on: true, minutes: 30, message: 'look again' }] });
    const file = await exported(b, 'mail');
    assert.ok(listOf(file).includes('work/.docket/plans.jsonl'));
    const manifest = JSON.parse(spawnSync('tar', ['-xzOf', file, 'clavarium-conversation.json'], { encoding: 'utf8' }).stdout);
    assert.deepEqual(manifest.wakeups, { perHour: 3, items: [{ kind: 'every', on: true, minutes: 30, message: 'look again' }] });
    const asked = [];
    b.all.importReminders = async (name, work, wakeups) => { asked.push({ name, plans: readFileSync(join(work, '.docket/plans.jsonl'), 'utf8'), wakeups }); };
    /* Not asked: its work comes, its docket not (here, its own stays). */
    rmSync(join(b.work, 'f')); put(join(b.work, '.docket/plans.jsonl'), 'its own\n');
    await b.all.importState('mail', file, { replaceWork: true });
    assert.equal(readFileSync(join(b.work, 'f'), 'utf8'), 'w');
    assert.equal(readFileSync(join(b.work, '.docket/plans.jsonl'), 'utf8'), 'its own\n', 'its own docket kept, the export\'s not put in raw');
    assert.deepEqual(asked, []);
    /* Asked: given from the export's work, with its wake-ups. */
    await b.all.importState('mail', file, { replaceWork: true, reminders: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].name, 'mail'); assert.match(asked[0].plans, /standup/); assert.equal(asked[0].wakeups.perHour, 3);
});
