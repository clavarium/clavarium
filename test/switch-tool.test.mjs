/* CHANGING THE AI OF AN EXISTING CONVERSATION (#404). The VM manager is a stand-in that records what it is asked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, Refusal, FIXES } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';

const ai = (id, more = {}) => ({ id, label: id.toUpperCase(), instructions: `.${id}/NOTES.md`, command: [id], resume: [id, '--continue'], memoryMb: 2048, state: { keep: [`.${id}`] }, rights: { full: ['--all'], ask: [] }, install: [['sudo', '-n', 'setup', id], ['write-settings', id]], ...more });
const TOOLS = readTools(JSON.stringify([ai('alpha'), ai('beta'), ai('big', { memoryMb: 4096 }), { id: 'shell', label: 'Shell', command: ['bash'], memoryMb: 768, install: [] }]));

function bench(t, { installed = ['alpha'], failInstall = false, dies = [], withState = ['alpha'], looseTools = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-switch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = []; const door = []; const present = new Set(installed); const homes = new Set(withState); const state = { vm: 'Running' };
    let store;
    const run = async (argv) => {
        const [area, verb, vm] = argv;
        if (area !== 'vm') return { code: 0, stdout: '', stderr: '' };
        if (verb === 'states') return { code: 0, stdout: JSON.stringify({ list: ['clv-demo', 'clv-common'].map((name) => ({ name, state: state.vm })) }), stderr: '' };
        if (verb === 'info') return { code: 0, stdout: JSON.stringify({ info: { [vm]: { state: state.vm } } }), stderr: '' };
        if (verb !== 'exec') return { code: 0, stdout: '', stderr: '' };
        let inner = argv.slice(argv.indexOf('--') + 1);
        /* Through the door of a shared machine: what runs behind it, marked. */
        if (inner[2] === 'clavarium-enter') { inner = inner.slice(5); door.push(inner.join(' ')); }
        calls.push(inner.join(' '));
        if (inner[0] === 'sh' && inner[2]?.startsWith('command -v')) return { code: present.has(inner[4]) ? 0 : 1, stdout: '', stderr: '' };
        if (inner[0] === 'sh' && inner[2]?.startsWith('for p in')) return { code: inner.slice(4).some((p) => homes.has(p.slice(1))) ? 0 : 3, stdout: '', stderr: '' };
        if (inner[0] === 'sudo' && inner[2] === 'setup') { if (failInstall) return { code: 1, stdout: '', stderr: 'no network' }; present.add(inner[3]); }
        if (inner[0] === 'write-settings') homes.add(inner[1]);
        if (inner[0] === 'timeout' && inner[2] === 'ls' && looseTools) return { code: 2, stdout: '', stderr: 'not connected' };
        if (inner.includes('has-session')) return { code: dies.includes(store.get('demo').tool) ? 1 : 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    store = new Store(join(dir, 'conversations.json'));
    const all = new Conversations({ store, vms: new Vms(run, ['vmm'], { freshMs: 0, machineOf: (n) => store.get(n)?.sharedMachine }), tools: TOOLS });
    all.switchSettleMs = 0;
    const told = []; all.toolChanged = (name, said, line, ok) => told.push({ said, line, ok });
    const put = (extra = {}) => store.put({ name: 'demo', tool: 'alpha', memoryMb: 2048, diskGb: 8, work: 'kept', phase: 'ready', fixed: FIXES, toolStarted: true, ...extra });
    return { all, store, calls, door, told, put, state, present };
}
const go = async (b, to) => { await b.all.switchTool('demo', to); return b.all.switched; };
/* What its next start runs, without the rights. */
const startOf = async (b) => { const argv = await b.all.open('demo'); b.all.left('demo'); return argv.join(' ').replaceAll("'", ''); };

test('A -> B starts B fresh, installed by its recipe, and tells the new AI', async (t) => {
    const b = bench(t); b.put();
    assert.equal(await go(b, 'beta'), true);
    const c = b.store.get('demo');
    assert.equal(c.tool, 'beta'); assert.equal(c.previousTool, 'alpha'); assert.equal(c.toolStarted, false); assert.deepEqual(c.toolsStarted, { alpha: true });
    assert.ok(b.calls.includes('sudo -n setup beta')); assert.ok(b.calls.includes('write-settings beta'));
    assert.ok(b.calls.some((x) => x.includes('kill-server')));
    assert.match(b.told[0].said, /now BETA \(was ALPHA\)/); assert.match(b.told[0].line, /parley read --last 100/);
    const start = await startOf(b);
    assert.match(start, / beta --all/); assert.doesNotMatch(start, /--continue/, 'a first start resumes nothing');
});

test('A -> B -> A resumes the session of A, and installs nothing again', async (t) => {
    const b = bench(t); b.put();
    await go(b, 'beta'); await startOf(b);
    b.calls.length = 0;
    await go(b, 'alpha');
    const c = b.store.get('demo');
    assert.equal(c.tool, 'alpha'); assert.equal(c.previousTool, 'beta'); assert.equal(c.toolStarted, true); assert.deepEqual(c.toolsStarted, { beta: true });
    assert.ok(!b.calls.some((x) => x.includes('setup') || x.includes('write-settings')), 'its settings are not written over');
    assert.match(await startOf(b), /alpha --continue/);
    await go(b, 'beta');
    assert.match(await startOf(b), /beta --continue/, 'and B has its session too');
});

test('a failed install leaves A running, untouched, and says why', async (t) => {
    const b = bench(t, { failInstall: true }); b.put();
    assert.equal(await go(b, 'beta'), false);
    const c = b.store.get('demo');
    assert.equal(c.tool, 'alpha'); assert.equal(c.toolStarted, true); assert.equal(c.previousTool, undefined); assert.equal(c.toolSwitch, undefined);
    assert.match(c.toolSwitchFailed, /stays ALPHA.*no network/);
    assert.ok(!b.calls.some((x) => x.includes('kill-server')), 'its session was never stopped');
    assert.equal(b.told[0].ok, false);
    await assert.doesNotReject(b.all.restartTool('demo'), 'the lock is given back');
});

test('a new AI that does not stay up: back to A, which resumes', async (t) => {
    const b = bench(t, { dies: ['beta'] }); b.put();
    assert.equal(await go(b, 'beta'), false);
    const c = b.store.get('demo');
    assert.equal(c.tool, 'alpha'); assert.equal(c.toolStarted, true); assert.equal(c.toolsStarted, undefined); assert.equal(c.previousTool, undefined);
    assert.match(c.toolSwitchFailed, /BETA did not start/);
    assert.match(await startOf(b), /alpha --continue/);
});

test('an old record, without any per-tool state, can leave and come back to its session', async (t) => {
    const b = bench(t); b.put({ toolStarted: undefined });
    await go(b, 'beta');
    assert.deepEqual(b.store.get('demo').toolsStarted, { alpha: true });
    await go(b, 'alpha');
    assert.match(await startOf(b), /alpha --continue/);
});

test('a tool never started on this disk is not said to have a session', async (t) => {
    const b = bench(t); b.put({ toolStarted: false });
    await go(b, 'beta');
    assert.equal(b.store.get('demo').toolsStarted, undefined);
});

test('in a shared machine: the machine-wide step as root, its settings as its own user', async (t) => {
    const b = bench(t); b.put({ sharedMachine: 'common', machineMb: 4096 });
    assert.equal(await go(b, 'beta'), true);
    assert.ok(b.calls.includes('sudo -n setup beta')); assert.ok(!b.door.includes('sudo -n setup beta'));
    assert.ok(b.door.includes('write-settings beta'));
});

test('there already, with no state of its own here: only its own settings are written', async (t) => {
    const b = bench(t, { installed: ['alpha', 'beta'] }); b.put();
    await go(b, 'beta');
    assert.ok(!b.calls.includes('sudo -n setup beta')); assert.ok(b.calls.includes('write-settings beta'));
});

test('stopped mid-turn: the turn of the old AI is said ended', async (t) => {
    const b = bench(t); b.put();
    await go(b, 'beta');
    const kill = b.calls.findIndex((x) => x.includes('kill-server')); const end = b.calls.findIndex((x) => x.includes('parley pulse --end'));
    assert.ok(kill >= 0 && end > kill);
});

test('refused before anything is touched', async (t) => {
    const b = bench(t); b.put();
    const refused = async (to, re) => { await assert.rejects(b.all.switchTool('demo', to), (e) => e instanceof Refusal && re.test(e.message)); };
    await refused('nope', /not offered/); await refused(undefined, /not offered/);
    await refused('alpha', /already runs/); await refused('shell', /cannot change to/); await refused('big', /needs 4096 MB/);
    b.state.vm = 'Stopped'; await refused('beta', /not running/); b.state.vm = 'Running';
    b.put({ phase: 'building' }); await refused('beta', /not ready/);
    b.put({ tool: 'shell' }); await refused('beta', /cannot be changed/);
    b.put({ lentTo: 'other' }); await refused('beta', /being copied/);
    assert.deepEqual(b.calls.filter((x) => x.includes('setup') || x.includes('kill-server')), []);
});

test('one change at a time; meanwhile copy, export and other actions are refused', async (t) => {
    const b = bench(t); b.put();
    await b.all.switchTool('demo', 'beta');
    await assert.rejects(b.all.switchTool('demo', 'alpha'), /busy: changing its AI/);
    await assert.rejects(b.all.copy('demo'), /busy: changing its AI/);
    await assert.rejects(b.all.exportState('demo'), /busy: changing its AI/);
    await assert.rejects(b.all.restartTool('demo'), /busy: changing its AI/);
    await b.all.switched;
    assert.equal(b.store.get('demo').tool, 'beta');
});

test('a server restarted during a change: it keeps its AI, and the page says so', async (t) => {
    const b = bench(t); b.put({ toolSwitch: { to: 'beta', label: 'BETA', step: 'Installing' } });
    const again = new Conversations({ store: b.store, vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), []), tools: TOOLS });
    const c = again.get('demo');
    assert.equal(c.tool, 'alpha'); assert.equal(c.toolSwitch, undefined); assert.match(c.toolSwitchFailed, /keeps its AI/);
});

test('the catalogue says which tools can be changed to; the real one offers the AIs, never a shell', async () => {
    const { loadTools } = await import('../server/tools.mjs');
    const all = new Conversations({ store: new Store(join(mkdtempSync(join(tmpdir(), 'clv-switch-')), 'c.json')), vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), []), tools: loadTools() });
    const can = all.tools().filter((x) => x.switches).map((x) => x.id);
    for (const id of ['claude-code', 'vibe', 'codex']) assert.ok(can.includes(id), id);
    assert.ok(!can.includes('shell')); assert.ok(!can.includes('guichet'));
});

test('an install cut off is marked: the mark goes only once it is done and written to disk', async (t) => {
    const cut = bench(t, { failInstall: true }); cut.put();
    await go(cut, 'beta');
    assert.ok(cut.calls.some((c) => c.includes('touch') && c.includes('.clavarium-installing-beta')));
    assert.ok(!cut.calls.some((c) => c.includes('rm -f') && c.includes('.clavarium-installing-beta')));
    const whole = bench(t); whole.put();
    await go(whole, 'beta');
    const setup = whole.calls.findIndex((c) => c.includes('setup'));
    const gone = whole.calls.findIndex((c) => c.includes('rm -f') && c.includes('.clavarium-installing-beta'));
    assert.ok(setup >= 0 && gone > setup);
    assert.match(whole.calls[gone], /^sh -c sync;/);
});

test('a tools folder that came loose is said, with what to do', async (t) => {
    const loose = bench(t, { installed: ['alpha', 'beta'], withState: ['alpha', 'beta'], dies: ['beta'], looseTools: true }); loose.put();
    await go(loose, 'beta');
    assert.equal(loose.store.get('demo').tool, 'alpha');
    assert.match(loose.store.get('demo').toolSwitchFailed, /tools folder came loose\. Restart its machine/);
    const plain = bench(t, { installed: ['alpha', 'beta'], withState: ['alpha', 'beta'], dies: ['beta'] }); plain.put();
    await go(plain, 'beta');
    assert.doesNotMatch(plain.store.get('demo').toolSwitchFailed, /came loose/);
});
