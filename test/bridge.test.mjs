import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachBridge, sameOrigin, CLOSE_ENDED, CLOSE_TAKEN } from '../server/bridge.mjs';

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

async function bench(t) {
    const terminals = fakeTerminals();
    const server = createServer();
    attachBridge(server, terminals);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const host = `127.0.0.1:${server.address().port}`;
    const open = (query, origin = `http://${host}`) => new WebSocket(`ws://${host}/terminal?${query}`, { headers: { origin } });
    t.after(() => server.close());
    const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'condition never became true'); };
    return { terminals, host, open, until };
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

    const received = once(ws, 'message');
    term.data('\x1b[32mhello\x1b[0m');
    const [data, binary] = await received;
    assert.equal(binary, true);
    assert.equal(data.toString(), '\x1b[32mhello\x1b[0m');

    ws.close();
    await b.until(() => term.killed === 1);
});

test('the newest screen takes over: the first is told, then closed with its own code, and is not unseated twice', async (t) => {
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
    await b.until(() => b.terminals.made[0].killed === 1);
    assert.equal(b.terminals.made[1].killed, 0, 'the screen that took over keeps its terminal');
    second.send(Buffer.from('x'));
    await b.until(() => b.terminals.made[1].written.length === 1);
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
