import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Talk, ASKED, ARRIVED } from '../server/talk.mjs';

const SCRIPT = fileURLToPath(new URL('../server/owner-mcp.mjs', import.meta.url));

/* Speaks MCP to the bridge as an agent would: one JSON message per line. */
async function agent(dir, calls, script = SCRIPT) {
    const child = spawn(process.execPath, [script, '--dir', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    calls.forEach((c, i) => send({ jsonrpc: '2.0', id: i + 1, ...c }));
    child.stdin.end();
    await new Promise((done) => child.on('close', done));
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const tool = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args } });
const said = (reply) => reply.result.content[0].text;

function bench(t, work = 'kept') {
    const dir = mkdtempSync(join(tmpdir(), 'clv-talk-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'helper'), { recursive: true });
    const typed = [];
    const vms = { exec: async (name, argv) => { const rest = argv.slice(argv.indexOf('send-keys') + 3); typed.push(rest[0] === '-l' ? rest.slice(2).join(' ') : rest.join(' ')); return { code: 0 }; } };
    const talk = new Talk({ store: new Store(join(dir, 'talk.json')), vms, conversations: { list: () => [{ name: 'helper', work }] }, resources: { workFolder: (name) => join(dir, 'work', name) } });
    return { dir, typed, talk, bridge: join(dir, 'work', 'helper', '.owner') };
}

test('the bridge speaks MCP: it says who it is, lists its four tools, and answers a call it does not know', async (t) => {
    const b = bench(t);
    const replies = await agent(b.dir, [{ method: 'tools/list' }, { method: 'ping' }, { method: 'resources/list' }, tool('launch_missiles')]);
    assert.equal(replies[0].result.serverInfo.name, 'owner'); assert.deepEqual(replies[0].result.capabilities, { tools: {} });
    assert.deepEqual(replies[1].result.tools.map((x) => x.name), ['tell_owner', 'ask_owner', 'show_owner', 'read_messages']);
    assert.ok(replies[1].result.tools.every((x) => x.inputSchema.type === 'object' && x.description.length > 20));
    assert.deepEqual(replies[2].result, {});
    assert.equal(replies[3].error.code, -32601);
    assert.equal(replies[4].result.isError, true);
    assert.equal(replies.length, 5, 'a notification is not answered');
});

test('off until the owner turns it on; turned on, the bridge is put in the work folder, and the tool is asked only when the owner says so', async (t) => {
    const b = bench(t);
    assert.deepEqual(b.talk.of('helper'), { on: false, possible: true, messages: [], waiting: 0 });
    await assert.rejects(b.talk.say('helper', 'hello'), /not turned on/);
    assert.throws(() => b.talk.of('nobody'), /No such conversation/);
    const on = await b.talk.set('helper', true);
    assert.equal(on.on, true); assert.deepEqual(on.declare, { command: ['node', '/work/.owner/server.mjs'], name: 'owner' });
    assert.equal(readFileSync(join(b.bridge, 'server.mjs'), 'utf8'), readFileSync(SCRIPT, 'utf8'));
    assert.deepEqual(b.typed, [], 'nothing is typed by turning it on');
    await b.talk.invite('helper');
    assert.deepEqual(b.typed, [ASKED, 'Enter']);
    const disk = bench(t, 'disk');
    await assert.rejects(disk.talk.set('helper', true), /nowhere to live/);
    assert.equal(disk.talk.of('helper').possible, false);
});

test('a whole exchange: the tool asks without waiting, the owner answers, the tool is told and reads it once', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const run = (calls) => agent(b.bridge, calls, join(b.bridge, 'server.mjs'));
    const first = await run([tool('tell_owner', { text: 'The report is half written.' }), tool('ask_owner', { question: 'Blue or red cover?', choices: ['blue', 'red'] }), tool('show_owner', { path: '/work/report.html', note: 'The draft.' }), tool('read_messages')]);
    assert.match(said(first[2]), /Do not wait here/);
    assert.equal(said(first[4]), 'No new message from your owner.');
    let seen = b.talk.of('helper');
    assert.deepEqual(seen.messages.map((m) => [m.from, m.kind, m.text]), [['tool', 'say', 'The report is half written.'], ['tool', 'ask', 'Blue or red cover?'], ['tool', 'show', 'The draft.']]);
    assert.deepEqual(seen.messages[1].choices, ['blue', 'red']); assert.equal(seen.messages[2].path, '/work/report.html'); assert.equal(seen.waiting, 1);
    /* The owner answers the question, then adds a word. Each time, one line in the terminal. */
    const answered = await b.talk.say('helper', 'blue', seen.messages[1].id);
    assert.equal(answered.told, true); assert.equal(answered.waiting, 0);
    await b.talk.say('helper', 'And keep it under two pages.\nThanks.');
    assert.deepEqual(b.typed, [ARRIVED, 'Enter', ARRIVED, 'Enter'], 'what the owner wrote is not typed: only that it arrived');
    const second = await run([tool('read_messages'), tool('read_messages')]);
    assert.equal(said(second[1]), 'Answer to your question "Blue or red cover?": blue\nMessage: And keep it under two pages.\nThanks.');
    assert.equal(said(second[2]), 'No new message from your owner.', 'read once');
    await assert.rejects(b.talk.say('helper', '   '), /Write something/);
});

test('what the tool posts is text chosen by a program: bounded, cleaned, never trusted', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    writeFileSync(join(b.bridge, 'to-owner.jsonl'), [
        JSON.stringify({ id: 'a', at: '2026-01-05T06:00:00.000Z', kind: 'say', text: `fine\u001b[31m red‮${'x'.repeat(9000)}` }),
        'this line is not JSON',
        JSON.stringify({ id: 'b', at: '2026-01-05T06:00:01.000Z', kind: 'launch', text: 'unknown kind' }),
        JSON.stringify({ id: 'c', at: '2026-01-05T06:00:02.000Z', kind: 'ask', text: 'q', choices: Array.from({ length: 30 }, (_, i) => `c${i}\n`) }),
        JSON.stringify('a string, not an object'),
    ].join('\n'));
    const { messages } = b.talk.of('helper');
    assert.equal(messages.length, 3);
    assert.equal(messages[0].text.startsWith('fine[31m redx'), true); assert.equal(messages[0].text.length, 4000);
    assert.equal(messages[1].kind, 'say', 'a kind it does not know is shown as something said');
    assert.equal(messages[2].choices.length, 8); assert.equal(messages[2].choices[0], 'c0');
    await b.talk.set('helper', false);
    assert.equal(b.talk.of('helper').messages.length, 0, 'turned off, nothing of it is read');
    assert.equal(existsSync(join(b.bridge, 'to-owner.jsonl')), true, 'and nothing is deleted');
});
