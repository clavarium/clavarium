/* A MACHINE'S SHARED CONSOLE, the person's side (server/sshconsole.mjs): a WebSocket for this site's own pages, past the
   gate, for a machine (an ssh target) only; keys go to Tether's handle as they are, what the machine prints comes back
   as bytes, never read here; its short journal never holds what the person typed. Tether is a stand-in here (its own
   console is proved in Tether); example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { attachConsole, consoleJournal, CONSOLE_PATH } from '../server/sshconsole.mjs';
import { makeOriginCheck } from '../server/gate.mjs';

const MACHINE = { id: 'box', title: 'Box', kind: 'ssh', config: { host: 'server.example.com', user: 'deploy' } };
const MAIL = { id: 'inbox', title: 'Mail', kind: 'mail' };

function fakeTethers({ fail = false } = {}) {
    const seen = { keys: [], said: [], who: null, detached: 0, onEvent: null };
    return {
        seen,
        store: () => ({ target: (id) => [MACHINE, MAIL].find((t) => t.id === id) ?? null }),
        async console(id, who, onEvent) {
            if (fail) throw new Error('cannot reach Box');
            seen.who = who; seen.onEvent = onEvent;
            return {
                replay: 'Welcome\r\n$ ',
                state: () => ({ open: true, typing: null, hidden: null, hideAi: false, agents: [], persons: 1 }),
                write: (d) => seen.keys.push(d),
                resize: (c, r) => seen.said.push(['resize', c, r]),
                hidden: (on) => seen.said.push(['hidden', on]),
                hideFromAi: (on) => seen.said.push(['hide-ai', on]),
                takeBack: () => seen.said.push(['take-back']),
                interrupt: () => seen.said.push(['interrupt']),
                detach: () => { seen.detached++; },
            };
        },
        async act(op, args) {
            assert.equal(op, 'journal'); assert.equal(args.target, 'box');
            return { ok: true, data: [
                { at: '2026-11-16T10:02:00Z', op: 'console', target: { id: 'box' }, detail: 'control taken back from the AI', by: { id: 'person:owner', name: 'Owner' } },
                { at: '2026-11-16T10:01:00Z', agent: { id: 'conversation:ops', name: 'ops' }, target: { id: 'box' }, verb: 'terminal.type', detail: 'sudo rm -rf /var/log/x⏎', decision: 'no', by: { name: 'Owner' }, risk: 'erase' },
                { at: '2026-11-16T10:00:30Z', agent: { id: 'conversation:ops', name: 'ops' }, target: { id: 'box' }, verb: 'terminal.read', detail: '' },
                { at: '2026-11-16T10:00:00Z', agent: { id: 'conversation:ops', name: 'ops' }, target: { id: 'box' }, verb: 'terminal.type', detail: 'df -h⏎', decision: 'auto', ok: true },
                { at: '2026-11-16T09:00:00Z', agent: { id: 'conversation:ops', name: 'ops' }, target: { id: 'other' }, verb: 'mail.send', detail: 'x' },
            ] };
        },
    };
}

async function serve(tethers, { gate = () => 'local' } = {}) {
    const server = createServer((q, r) => r.end());
    const consoles = attachConsole(server, { tethers, gate, originOk: makeOriginCheck() });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const host = `127.0.0.1:${server.address().port}`;
    return { server, host, consoles, close: () => new Promise((ok) => server.close(ok)) };
}
const open = (host, query, headers = { origin: `http://${host}` }) => new Promise((ok) => {
    const ws = new WebSocket(`ws://${host}${CONSOLE_PATH}?${query}`, { headers });
    const got = { texts: [], bytes: '', ws, closed: null, opened: false };
    ws.on('message', (data, binary) => { if (binary) got.bytes += Buffer.from(data).toString('utf8'); else got.texts.push(JSON.parse(String(data))); });
    ws.on('open', () => { got.opened = true; ok(got); });
    ws.on('close', (code) => { got.closed = code; ok(got); });
    ws.on('error', () => { got.closed = got.closed ?? 'refused'; ok(got); });
});
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('waited too long'); await new Promise((r) => setTimeout(r, 10)); } };

test('the console socket: this site, past the gate, a machine; the screen so far, then keys and switches carried as they are', async () => {
    const tethers = fakeTethers();
    const s = await serve(tethers);
    try {
        const got = await open(s.host, 'target=box&cols=100&rows=30', { origin: `http://${s.host}`, 'x-forwarded-email': 'someone@example.com' });
        await until(() => got.texts.some((m) => m.type === 'ready') && got.bytes.includes('Welcome'));
        assert.deepEqual(tethers.seen.who, { id: 'person:someone@example.com', name: 'someone@example.com' });
        assert.deepEqual(tethers.seen.said[0], ['resize', 100, 30]);
        got.ws.send(Buffer.from('ls -la\r'));
        for (const m of [{ type: 'resize', cols: 80, rows: 24 }, { type: 'hidden', on: true }, { type: 'hide-ai', on: true }, { type: 'take-back' }, { type: 'interrupt' }, { type: 'nonsense' }]) got.ws.send(JSON.stringify(m));
        await until(() => tethers.seen.said.length >= 6 && tethers.seen.keys.length === 1);
        assert.deepEqual(tethers.seen.keys, ['ls -la\r']);
        assert.deepEqual(tethers.seen.said.slice(1), [['resize', 80, 24], ['hidden', true], ['hide-ai', true], ['take-back'], ['interrupt']]);
        /* What the machine prints, and its state, come as they are. */
        tethers.seen.onEvent({ type: 'data', data: '<img src=x onerror=alert(1)>\r\n' });
        tethers.seen.onEvent({ type: 'state', state: { typing: { agent: 'conversation:ops', name: 'ops' } } });
        await until(() => got.bytes.includes('<img src=x') && got.texts.some((m) => m.type === 'state'));
        /* The shell ends: the socket closes 1000; the handle is let go. */
        tethers.seen.onEvent({ type: 'closed' });
        await until(() => got.closed === 1000);
        await until(() => tethers.seen.detached === 1);
    } finally { await s.close(); }
});

test('the console socket refuses another site, a page past no gate, a target that is no machine, an unknown one', async () => {
    const tethers = fakeTethers();
    const s = await serve(tethers, { gate: (h) => (h['x-forwarded-email'] ? 'someone' : undefined) });
    try {
        const id = { 'x-forwarded-email': 'someone@example.com' };
        assert.equal((await open(s.host, 'target=box', { origin: 'https://evil.example.com', ...id })).opened, false);
        assert.equal((await open(s.host, 'target=box', { origin: `http://${s.host}` })).opened, false, 'no gate');
        assert.equal((await open(s.host, 'target=inbox', { origin: `http://${s.host}`, ...id })).opened, false, 'a mailbox has no console');
        assert.equal((await open(s.host, 'target=nope', { origin: `http://${s.host}`, ...id })).opened, false);
        assert.equal(tethers.seen.who, null, 'Tether never asked');
    } finally { await s.close(); }
});

test('a console that cannot open says why, then closes', async () => {
    const s = await serve(fakeTethers({ fail: true }));
    try {
        const got = await open(s.host, 'target=box');
        await until(() => got.closed !== null);
        assert.equal(got.closed, 1011);
        assert.match(got.texts.find((m) => m.type === 'error').text, /cannot reach Box/);
    } finally { await s.close(); }
});

test('the console\'s short journal: the AI\'s inputs and the console\'s events, newest first; no reads, no other target', async () => {
    const r = await consoleJournal(fakeTethers(), { target: 'box' });
    assert.deepEqual(r.lines.map((l) => l.op ?? l.verb), ['console', 'terminal.type', 'terminal.type']);
    assert.equal(r.lines[0].detail, 'control taken back from the AI'); assert.equal(r.lines[0].by, 'Owner');
    assert.equal(r.lines[1].risk, 'erase'); assert.equal(r.lines[1].decision, 'no');
    await assert.rejects(consoleJournal(fakeTethers(), { target: 'inbox' }), /No such machine/);
});

test('a destructive terminal line, as a request card in the chat: irreversible, said as final', async () => {
    const { demandeView } = await import('../server/demandes.mjs');
    const base = { id: 'r', verb: 'terminal.type', target: { id: 'box', title: 'Box' }, agent: { id: 'conversation:ops', name: 'ops' }, detail: 'x' };
    const risky = demandeView({ ...base, card: { kind: 'terminal', action: 'type', text: 'sudo rm -rf /var/log/x', destructive: 'erase' } });
    const plain = demandeView({ ...base, card: { kind: 'terminal', action: 'type', text: 'df -h' } });
    assert.equal(risky.irreversible, true); assert.notEqual(plain.irreversible, true);
    assert.ok((risky.risk ?? []).length > (plain.risk ?? []).length);
});

test('a console whose person is no longer let in ends as soon as it is looked at again (a role changed, #419), not 30 s later', async () => {
    const tethers = fakeTethers();
    let allowed = true;
    const s = await serve(tethers, { gate: () => (allowed ? 'someone@example.com' : undefined) });
    try {
        const got = await open(s.host, 'target=box&cols=100&rows=30');
        await until(() => got.texts.some((m) => m.type === 'ready'));
        allowed = false;
        s.consoles.recheck();
        await until(() => got.closed !== null, 1000);
        assert.equal(got.closed, 4403);
    } finally { await s.close(); }
});
