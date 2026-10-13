/* What is of this product in "talk": where Parley's bridge lives, the line
   typed to the tool, the alert to the owner. The bridge itself, its five
   verbs and its cleaning are tested where they live, in Parley. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Talk } from '../server/talk.mjs';
import { INVITE, ARRIVED } from '../server/parley/host/parley-host.mjs';

const BRIDGE = fileURLToPath(new URL('../server/parley/server/parley-mcp.mjs', import.meta.url));

async function agent(dir, calls) {
    const child = spawn(process.execPath, [join(dir, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    calls.forEach((c, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: c[0], arguments: c[1] ?? {} } })}\n`));
    child.stdin.end();
    await new Promise((done) => child.on('close', done));
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l).result.content[0].text);
}

function bench(t, work = 'kept') {
    const dir = mkdtempSync(join(tmpdir(), 'clv-talk-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'helper'), { recursive: true });
    const typed = []; const alerted = []; const warmed = [];
    const world = { runs: true };
    const vms = { exec: async (name, argv) => { if (!world.runs) return { code: 1 }; const rest = argv.slice(argv.indexOf('send-keys') + 3); typed.push(rest[0] === '-l' ? rest.slice(2).join(' ') : rest.join(' ')); return { code: 0 }; } };
    const make = () => new Talk({ store: new Store(join(dir, 'talk.json')), vms, conversations: { list: () => [{ name: 'helper', work }] }, resources: { workFolder: (name) => join(dir, 'work', name) },
        warm: async (name) => { warmed.push(name); }, alert: (name, m) => alerted.push([name, m.kind, m.text ?? '', m.state ?? '']), listenEveryMs: 40 });
    const talk = make();
    t.after(() => talk.stop());
    return { dir, typed, alerted, warmed, world, talk, make, bridge: join(dir, 'work', 'helper', '.parley') };
}

test('off until the owner turns it on; turned on, Parley\'s bridge is put in the work folder, as it is, and nothing is typed', async (t) => {
    const b = bench(t);
    assert.deepEqual(b.talk.of('helper'), { on: false, possible: true, messages: [], waiting: 0, status: null });
    await assert.rejects(b.talk.say('helper', 'hello'), /not turned on/);
    assert.throws(() => b.talk.of('nobody'), /No such conversation/);
    const on = await b.talk.set('helper', true);
    assert.equal(on.on, true); assert.deepEqual(on.declare, { name: 'parley', command: ['node', '/work/.parley/server.mjs'] });
    assert.equal(readFileSync(join(b.bridge, 'server.mjs'), 'utf8'), readFileSync(BRIDGE, 'utf8'), 'unchanged');
    assert.deepEqual(b.typed, []);
    const disk = bench(t, 'disk');
    await assert.rejects(disk.talk.set('helper', true), /nowhere to live/);
    assert.equal(disk.talk.of('helper').possible, false);
});

test('the hook to the tool is its terminal: one line, opened first if it was not', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    await b.talk.invite('helper');
    assert.deepEqual(b.typed, [INVITE, 'Enter']); assert.deepEqual(b.warmed, ['helper']);
    const said = await b.talk.say('helper', 'Keep it under two pages.');
    assert.equal(said.told, true);
    assert.deepEqual(b.typed.slice(2), [ARRIVED, 'Enter'], 'what the owner wrote is not typed: only that it arrived');
    assert.deepEqual(await agent(b.bridge, [['read']]), ['Message: Keep it under two pages.']);
    await assert.rejects(b.talk.say('helper', '  '), /Write something/);
    b.world.runs = false;
    assert.equal((await b.talk.say('helper', 'while its tool is down')).told, false, 'written all the same');
    await assert.rejects(b.talk.invite('helper'), /could not be typed/);
});

test('the hook to the owner is the alert: when the tool asks, or says it waits; not for the rest', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    await agent(b.bridge, [['tell', { text: 'Half written.' }], ['status', { state: 'working' }], ['ask', { question: 'Blue or red cover?', choices: ['blue', 'red'] }], ['status', { state: 'waiting' }]]);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(b.alerted, [['helper', 'ask', 'Blue or red cover?', ''], ['helper', 'status', '', 'waiting']]);
    const seen = b.talk.of('helper');
    assert.equal(seen.waiting, 1); assert.equal(seen.status.state, 'waiting');
    assert.equal((await b.talk.say('helper', 'blue', seen.messages.find((m) => m.kind === 'ask').id)).waiting, 0);
    /* After a restart of this server, it listens again without being asked. */
    b.talk.stop();
    const again = b.make(); t.after(() => again.stop());
    await agent(b.bridge, [['ask', { question: 'One page or two?' }]]);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(b.alerted.at(-1), ['helper', 'ask', 'One page or two?', '']);
    /* Turned off: nothing of it is read, nobody is alerted, nothing is deleted. */
    await again.set('helper', false);
    const before = b.alerted.length;
    await agent(b.bridge, [['ask', { question: 'Anybody?' }]]);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.alerted.length, before); assert.equal(again.of('helper').messages.length, 0);
    assert.equal(existsSync(join(b.bridge, 'from-agent.jsonl')), true);
});
