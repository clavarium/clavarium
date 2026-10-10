import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachBridge, sameOrigin, CLOSE_ENDED, CLOSE_TAKEN } from '../server/bridge.mjs';

/* The next piece of terminal output a screen receives (the bridge's own
   words, such as "ready", are text frames and are skipped). */
const nextOutput = (ws) => new Promise((resolve) => {
    const listen = (data, binary) => { if (binary) { ws.off('message', listen); resolve(data.toString()); } };
    ws.on('message', listen);
});

/* A PTY that records what it is told and says what the test wants. */
function fakeTerminals() {
    const made = [];
    const spawn = (name, cols, rows) => {
        const t = { name, cols, rows, written: [], sizes: [], killed: 0, data: () => {}, exit: () => {} };
        made.push(t);
        return {
            write: (x) => t.written.push(x), resize: (c, r) => t.sizes.push([c, r]), kill: () => { t.killed++; },
            onData: (f) => { t.data = f; }, onExit: (f) => { t.exit = f; },
        };
    };
    return { made, spawn };
}

async function bench(t, hooks = {}) {
    const terminals = fakeTerminals();
    const server = createServer();
    const bridge = attachBridge(server, { ...terminals, ...hooks });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const host = `127.0.0.1:${server.address().port}`;
    const open = (query, origin = `http://${host}`) => new WebSocket(`ws://${host}/terminal?${query}`, { headers: { origin } });
    t.after(() => server.close());
    const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'condition never became true'); };
    return { terminals, host, open, until, bridge };
}

test('keystrokes go in as they are, output comes out as it is, a resize is obeyed within bounds', async (t) => {
    const b = await bench(t);
    const ws = b.open('c=demo&cols=120&rows=40');
    await once(ws, 'open');
    const term = b.terminals.made[0];
    assert.deepEqual([term.name, term.cols, term.rows], ['demo', 120, 40]);

    ws.send(Buffer.from('ls\r'));
    ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    ws.send(JSON.stringify({ type: 'resize', cols: 9000, rows: 30 }));
    ws.send('not json');
    await b.until(() => term.sizes.length === 1);
    assert.deepEqual([term.written, term.sizes], [['ls\r'], [[90, 30]]]);

    const received = nextOutput(ws);
    term.data('\x1b[32mhello\x1b[0m');
    assert.equal(await received, '\x1b[32mhello\x1b[0m');

    /* The screen leaves: the terminal stays open for the next one. */
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(term.killed, 0);
});

test('a screen that comes back finds the terminal as it was, at once, and the tool is asked to redraw', async (t) => {
    const b = await bench(t);
    const first = b.open('c=demo&cols=100&rows=30');
    await once(first, 'open');
    first.close();
    await once(first, 'close');
    const second = b.open('c=demo&cols=90&rows=20');
    /* Listening from the very first frame: "ready" is said at once. */
    const got = [];
    second.on('message', (d, binary) => got.push(binary ? d.toString() : JSON.parse(d.toString()).type));
    await once(second, 'open');
    const term = b.terminals.made[0];
    await b.until(() => term.sizes.length === 2);
    assert.equal(b.terminals.made.length, 1, 'no second terminal was opened');
    assert.deepEqual(term.sizes, [[90, 19], [90, 20]], 'a line short, then right, a moment apart: a full redraw');
    term.data('still here');
    await b.until(() => got.includes('still here'));
    assert.ok(got.includes('ready'), 'the screen is told in words that its terminal is attached');
    second.send(Buffer.from('x'));
    await b.until(() => term.written.includes('x'));
    second.close();
});

test('a channel that drops while the tool still runs is reopened by itself; when the tool has exited, it is not', async (t) => {
    let running = true;
    const b = await bench(t, { onEnded: async () => running });
    const ws = b.open('c=demo');
    await once(ws, 'open');
    b.terminals.made[0].exit();                      /* the channel dropped */
    await b.until(() => b.terminals.made.length === 2);
    assert.equal(ws.readyState, 1, 'the screen was not closed');
    const received = nextOutput(ws);
    b.terminals.made[1].data('back');
    assert.equal(await received, 'back');
    running = false;
    const closed = once(ws, 'close');
    b.terminals.made[1].exit();                      /* the tool exited */
    assert.equal((await closed)[0], CLOSE_ENDED);
    assert.equal(b.terminals.made.length, 2);
});

test('a machine known to run has its terminal opened before any screen asks; a dropped one is closed at once', async (t) => {
    const b = await bench(t);
    await b.bridge.warm('demo');
    assert.equal(b.terminals.made.length, 1);
    const ws = b.open('c=demo');
    await once(ws, 'open');
    await b.until(() => b.terminals.made[0].sizes.length === 2);
    assert.equal(b.terminals.made.length, 1, 'the screen took the one already open');
    b.bridge.drop('demo');
    assert.equal(b.terminals.made[0].killed, 1);
    ws.close();
});

test('the newest screen takes over: the first is told, then closed with its own code, and the terminal passes to the newcomer', async (t) => {
    const b = await bench(t);
    const first = b.open('c=demo');
    await once(first, 'open');
    const told = [];
    first.on('message', (d, binary) => { if (!binary) told.push(JSON.parse(d.toString())); });
    const closed = once(first, 'close');
    const second = b.open('c=demo');
    await once(second, 'open');
    const [code] = await closed;
    assert.deepEqual([told, code], [[{ type: 'taken' }], CLOSE_TAKEN]);
    assert.equal(b.terminals.made.length, 1, 'one terminal, handed over');
    assert.equal(b.terminals.made[0].killed, 0);
    /* What the first screen still sends is no longer typed. */
    second.send(Buffer.from('x'));
    await b.until(() => b.terminals.made[0].written.length === 1);
    assert.deepEqual(b.terminals.made[0].written, ['x']);
    second.close();
});

test('when the tool exits, the screen is told the session is over', async (t) => {
    const b = await bench(t);
    const ws = b.open('c=demo');
    await once(ws, 'open');
    const closed = once(ws, 'close');
    b.terminals.made[0].exit();
    assert.equal((await closed)[0], CLOSE_ENDED);
});

test('another site, a bad name or another path never reaches a terminal', async (t) => {
    const b = await bench(t);
    for (const [query, origin] of [['c=demo', 'http://evil.example'], ['c=Bad;name', undefined], ['c=', undefined]]) {
        const ws = origin ? b.open(query, origin) : b.open(query);
        /* A refused upgrade ends as an error, a close, or both: either is a refusal. */
        await new Promise((done) => { ws.on('error', done); ws.on('close', done); });
    }
    assert.equal(b.terminals.made.length, 0);
    assert.equal(sameOrigin({ origin: 'https://host.example', host: 'host.example' }), true);
    assert.equal(sameOrigin({ origin: 'https://host.example.evil.example', host: 'host.example' }), false);
    assert.equal(sameOrigin({ host: 'host.example' }), false, 'no Origin header is not a browser we know');
});
