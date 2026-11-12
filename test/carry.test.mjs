/* A CONVERSATION CARRIED ELSEWHERE (11-11, #351): its tool's state -- where its entry says it is -- exported as one
   archive from its machine, a manifest first; imported into a conversation of the same tool, its tool stopped and
   started again; the cache left out; another tool's export or anything else refused. The machine here is a
   folder of this test (its home), the same shell commands run in it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Conversations, Refusal } from '../server/conversations.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';
import { readTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'tool', label: 'Tool', command: ['tool'], memoryMb: 1024, install: [], state: { keep: ['.tool', '.tool.json', '.never-made'], skip: ['.tool/cache'] } },
    { id: 'other', label: 'Other', command: ['other'], memoryMb: 1024, install: [], state: { keep: ['.other'] } },
    { id: 'bare', label: 'Bare', command: ['bare'], memoryMb: 1024, install: [] },
]));

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-carry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const homes = {};
    const calls = [];
    const run = async (argv) => {
        calls.push(argv.slice(1).join(' '));
        if (argv[1] === 'info') return { code: 0, stdout: JSON.stringify({ info: { [argv[2]]: { state: 'Running' } } }), stderr: '' };
        if (argv[1] === 'states') return { code: 0, stdout: JSON.stringify({ list: Object.keys(homes).map((n) => ({ name: `clv-${n}`, state: 'Running' })) }), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const vms = new Vms(run, ['vmm'], { freshMs: 0 });
    /* "In its machine": the same command, run here with its home. */
    vms.execArgv = (name, argv) => ['env', `HOME=${homes[name]}`, ...argv];
    const store = new Store(join(dir, 'conversations.json'));
    const all = new Conversations({ store, vms, tools: TOOLS });
    const conversation = (name, tool) => {
        homes[name] = join(dir, name); mkdirSync(homes[name]);
        store.put({ name, tool, memoryMb: 1024, cpus: 1, diskGb: 8, phase: 'ready', work: 'kept' });
        return homes[name];
    };
    return { dir, all, conversation, calls };
}

const save = async (exported, file) => { await pipeline(exported.stream, createWriteStream(file)); return file; };
const listed = (file) => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.trim().split('\n');

test('exported: the manifest first, what the tool keeps, never its cache nor the rest of the home; imported into the same tool, its tool restarted', async (t) => {
    const b = bench(t);
    const home = b.conversation('alpha', 'tool');
    mkdirSync(join(home, '.tool', 'projects'), { recursive: true }); mkdirSync(join(home, '.tool', 'cache'));
    writeFileSync(join(home, '.tool', 'projects', 'memory.md'), 'remember this');
    writeFileSync(join(home, '.tool', 'cache', 'big.bin'), 'cache');
    writeFileSync(join(home, '.tool.json'), '{"a":1}');
    writeFileSync(join(home, 'notes.txt'), 'not the tool\'s');
    const exported = await b.all.exportState('alpha');
    assert.match(exported.name, /^alpha-\d{4}-\d{2}-\d{2}\.clavarium\.tar\.gz$/);
    const file = await save(exported, join(b.dir, exported.name));
    const names = listed(file);
    assert.equal(names[0], 'clavarium-conversation.json', 'the manifest first');
    assert.ok(names.includes('./.tool/projects/memory.md') && names.includes('./.tool.json'), names.join(' '));
    assert.ok(!names.some((n) => n.includes('cache')), 'never its cache');
    assert.ok(!names.some((n) => n.includes('notes.txt')), 'never the rest of the home');

    /* Into another conversation of the same tool: its old state replaced, its tool stopped then ready again. */
    const there = b.conversation('beta', 'tool');
    mkdirSync(join(there, '.tool')); writeFileSync(join(there, '.tool', 'old.md'), 'old');
    writeFileSync(join(there, 'mine.txt'), 'kept');
    b.calls.length = 0;
    const done = await b.all.importState('beta', createReadStream(file));
    assert.deepEqual(done, { tool: 'tool', from: { name: 'alpha', at: done.from.at } });
    assert.equal(readFileSync(join(there, '.tool', 'projects', 'memory.md'), 'utf8'), 'remember this');
    assert.ok(!existsSync(join(there, '.tool', 'old.md')), 'its old state replaced, not mixed');
    assert.equal(readFileSync(join(there, 'mine.txt'), 'utf8'), 'kept', 'the rest of its home untouched');
    assert.ok(!existsSync(join(there, 'clavarium-conversation.json')), 'no manifest left behind');
    assert.ok(b.calls.some((c) => c.includes('tmux') && c.includes('kill-server')), 'its tool stopped first');
});

test('refused: another tool\'s export, a file that is not one, a tool that does not say where its state is', async (t) => {
    const b = bench(t);
    const home = b.conversation('alpha', 'tool');
    mkdirSync(join(home, '.tool'));
    const file = await save(await b.all.exportState('alpha'), join(b.dir, 'a.tar.gz'));
    const other = b.conversation('gamma', 'other');
    await assert.rejects(b.all.importState('gamma', createReadStream(file)), (e) => e instanceof Refusal && /another tool/.test(e.message));
    assert.ok(!existsSync(join(other, '.tool')), 'nothing of it put in');
    b.conversation('delta', 'tool');
    await assert.rejects(b.all.importState('delta', Readable.from([Buffer.from('not an archive')])), (e) => e instanceof Refusal && e.status === 502);
    const plain = join(b.dir, 'plain.tar.gz'); writeFileSync(join(b.dir, 'x.txt'), 'x');
    spawnSync('tar', ['-czf', plain, '-C', b.dir, 'x.txt']);
    await assert.rejects(b.all.importState('delta', createReadStream(plain)), (e) => e instanceof Refusal && /not an exported conversation/.test(e.message));
    b.conversation('epsilon', 'bare');
    await assert.rejects(b.all.exportState('epsilon'), (e) => e instanceof Refusal && /does not say where it keeps its state/.test(e.message));
});
