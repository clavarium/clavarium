/* A person's browser through the Tether extension (browsers.mjs, the /api/tether/browser-* routes, the endpoint at
 * /c/api/browser): paired once with the code its popup shows, then trusted by its token on every reconnection; a
 * wrong code refused and counted, too many and pairing waits; a code offered twice trusted to neither; the token never
 * in an answer, a log line, a file in clear; only the tabs the person granted are touched; at Frame the allowed sites
 * act without a card, the others ask. A fake extension on a fake socket, and once on a real WebSocket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { keeper } from 'clavarium-tether/host';
import { handleApi } from '../server/api.mjs';
import { Tethers } from '../server/tethers.mjs';
import { Browsers, BROWSER_PATH, WRONG_MAX, LOBBY_PER_ADDRESS, LOBBY_MESSAGE_MAX, addressOf } from '../server/browsers.mjs';
import { demandeView } from '../server/demandes.mjs';

const AGENT = { id: 'conversation:alpha', kind: 'agent', name: 'alpha' };
const PARAMS = /handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.split('=')[0].trim());
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/* The socket's two ends: what one sends, the other gets (JSON, with its size). */
function socketPair() {
    const end = () => ({ msgs: new Set(), closes: new Set(), closed: false });
    const a = end(); const b = end();
    const wire = (self, other) => {
        self.send = (obj) => { if (self.closed) return; const text = JSON.stringify(obj); queueMicrotask(() => { for (const fn of [...other.msgs]) fn(JSON.parse(text), text.length); }); };
        self.onMessage = (fn) => { self.msgs.add(fn); };
        self.onClose = (fn) => { self.closes.add(fn); };
        self.close = () => { if (self.closed) return; self.closed = true; other.closed = true; queueMicrotask(() => { for (const fn of [...self.closes, ...other.closes]) fn(); }); };
    };
    wire(a, b); wire(b, a);
    return { server: a, ext: b };
}

/* A fake extension: says hello (with its token once it has one), shows a code, pushes its granted tabs, answers calls. */
function extension(browsers, { address = 'client-a.example', token = null, code = '482913' } = {}) {
    const { server, ext } = socketPair();
    const e = { token, said: [], calls: [], ext, accepted: false };
    ext.onMessage((m) => {
        e.said.push(m.t);
        if (m.t === 'paired') e.token = m.token;
        if (m.t === 'pair-needed') ext.send({ t: 'pair', code });
        if (m.t === 'call') { e.calls.push(m); ext.send({ t: 'result', id: m.id, ok: true, text: m.verb === 'shot' ? 'data:image/png;base64,AAAA' : `${m.verb} done` }); }
    });
    e.accepted = browsers.accept(server, address);
    e.start = () => { ext.send(e.token ? { t: 'hello', token: e.token } : { t: 'hello' }); if (!e.token) ext.send({ t: 'pair', code }); };
    e.tabs = (tabs) => ext.send({ t: 'tabs', tabs });
    e.close = () => ext.close();
    return e;
}

function bench(t, { dir = mkdtempSync(join(tmpdir(), 'clv-browsers-')) } = {}) {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const logs = [];
    let k = null;
    const work = join(dir, 'work'); mkdirSync(work, { recursive: true });
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    let tethers = null;
    const browsers = new Browsers({ dataDir: dir, store: () => tethers.store(), log: (line) => logs.push(line) });
    tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha'], secrets: { reveal: () => null }, browsers, make: (d, o) => (k = keeper(d, o)) });
    t.after(() => { browsers.shutdown(); return k?.close(); });
    const call = async (method, path, body) => {
        const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        const named = { conversations: { list: () => [{ name: 'alpha', phase: 'ready' }] }, headers: {}, originOk: () => true, tethers };
        await handleApi(request, response, ...PARAMS.slice(2).map((p) => named[p]));
        return { status, text, body: JSON.parse(text) };
    };
    /* Everything this server wrote, in one string (the token must be in none of it). */
    const written = () => {
        const out = [];
        const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.push(readFileSync(p, 'utf8')); } };
        walk(dir); return out.join('\n');
    };
    return { dir, browsers, tethers, keeper: () => k, call, logs, written };
}

async function paired(t, b, opts = {}) {
    const e = extension(b.browsers, opts);
    e.start(); await tick();
    const r = await b.call('POST', '/api/tether/browser-pair', { code: opts.code ?? '482913', name: 'Laptop · Firefox' });
    await tick();
    return { e, r };
}

test('pairing: the code typed makes a browser asset; the extension is handed a token no answer, log or file holds', async (t) => {
    const b = bench(t);
    const { e, r } = await paired(t, b);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: 'browser-laptop-firefox', title: 'Laptop · Firefox', kind: 'browser' });
    assert.ok(e.token && e.token.length > 30, 'the extension holds its token');
    assert.ok(e.said.includes('paired'));
    assert.equal(b.tethers.store().target('browser-laptop-firefox').kind, 'browser');
    e.tabs([{ id: 7, url: 'https://shop.example.com/a', title: 'Shop', site: 'shop.example.com' }]); await tick();
    const state = await b.call('GET', '/api/tether');
    assert.deepEqual(state.body.browsers['browser-laptop-firefox'], { connected: true, tabs: [{ id: 7, title: 'Shop', url: 'https://shop.example.com/a', site: 'shop.example.com' }] });
    for (const text of [r.text, state.text, b.logs.join('\n'), b.written()]) {
        assert.ok(!text.includes(e.token), 'never the token');
        assert.ok(!text.includes('482913'), 'never the code');
    }
    assert.match(b.written(), /tether-browser-tokens|[0-9a-f]{64}/, 'only its hash is kept');
});

test('pairing lasts: the browser started again says its token and is the same asset, no code asked; a stranger token is told to pair', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-browsers-'));
    const b = bench(t, { dir });
    const { e } = await paired(t, b);
    const token = e.token;
    e.close(); await tick();
    assert.equal(b.browsers.status('browser-laptop-firefox').connected, false);
    /* This server restarted: a new Browsers on the same data. */
    const b2 = bench(t, { dir });
    b2.tethers.store();
    const again = extension(b2.browsers, { token });
    again.start(); await tick();
    assert.ok(again.said.includes('welcome'), 'welcomed by its token');
    assert.ok(!again.said.includes('pair-needed'));
    assert.equal(b2.browsers.status('browser-laptop-firefox').connected, true);
    const stranger = extension(b2.browsers, { token: 'x'.repeat(43), address: 'client-b.example' });
    stranger.start(); await tick();
    assert.ok(stranger.said.includes('pair-needed'));
    assert.equal(b2.browsers.waiting(), 1, 'it waits with its code');
});

test('a wrong code is refused and counted; after too many, pairing waits; a code offered twice is trusted to neither', async (t) => {
    const b = bench(t);
    const e = extension(b.browsers); e.start(); await tick();
    for (let i = 0; i < WRONG_MAX; i++) {
        const r = await b.call('POST', '/api/tether/browser-pair', { code: '000000', name: 'X' });
        assert.equal(r.status, 400); assert.match(r.body.error, /No browser shows that code/);
    }
    assert.equal(b.browsers.wrongCodes(), WRONG_MAX);
    const late = await b.call('POST', '/api/tether/browser-pair', { code: '482913', name: 'X' });
    assert.equal(late.status, 429, 'even the right code waits now');
    assert.equal(b.tethers.store().targets().filter((x) => x.kind === 'browser').length, 0);

    const c = bench(t);
    const one = extension(c.browsers, { code: '555111' }); one.start();
    const two = extension(c.browsers, { code: '555111', address: 'client-c.example' }); two.start();
    await tick();
    const r = await c.call('POST', '/api/tether/browser-pair', { code: '555111', name: 'X' });
    assert.equal(r.status, 400); assert.match(r.body.error, /offered twice/);
    assert.ok(!one.token && !two.token, 'neither got a token');
    assert.ok(c.logs.every((l) => !l.includes('555111')), 'the code is never logged');
});

test('the endpoint is rate-limited: sockets waiting per address, a big message before pairing drops the socket', async (t) => {
    const b = bench(t);
    const many = Array.from({ length: LOBBY_PER_ADDRESS + 2 }, (_, i) => extension(b.browsers, { code: `70000${i}` }));
    assert.equal(many.filter((x) => x.accepted).length, LOBBY_PER_ADDRESS, 'a few sockets wait per address, the rest turned away');
    assert.equal(extension(b.browsers, { address: 'client-d.example' }).accepted, true, 'another address still comes in');
    const big = extension(b.browsers, { address: 'client-e.example', code: '123123' });
    big.ext.send({ t: 'tabs', tabs: [{ id: 1, url: `https://example.com/${'a'.repeat(LOBBY_MESSAGE_MAX)}` }] }); await tick();
    big.ext.send({ t: 'pair', code: '123123' }); await tick();
    assert.equal((await b.call('POST', '/api/tether/browser-pair', { code: '123123', name: 'X' })).status, 400, 'dropped: its code is not waiting');
    /* The address the front saw: the last before it in X-Forwarded-For; a socket from outside is its own. */
    assert.equal(addressOf({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': 'spoofed.example, client-f.example, 127.0.0.1' } }), 'client-f.example');
    assert.equal(addressOf({ socket: { remoteAddress: 'client-g.example' }, headers: { 'x-forwarded-for': 'spoofed.example' } }), 'client-g.example');
});

test('tab scoping and the levels: only granted tabs; watch reads; propose asks with its card; frame acts on the allowed sites only', async (t) => {
    const b = bench(t);
    const { e } = await paired(t, b);
    const id = 'browser-laptop-firefox';
    e.tabs([{ id: 7, url: 'https://shop.example.com/a', title: 'Shop', site: 'shop.example.com' }, { id: 9, url: 'https://bank.example.org/', title: 'Bank', site: 'bank.example.org' }]); await tick();
    const k = b.keeper();
    const act = (verb, args) => k.act(verb, { target: id, ...args }, AGENT);
    await b.call('POST', '/api/tether/level', { target: id, agent: AGENT.id, level: 'watch' });
    assert.match((await act('browser.tabs', {})).text, /Shop/);
    assert.equal((await act('browser.shot', { tab: 7 })).ok, true);
    assert.match((await act('browser.click', { tab: 7, selector: '.go' })).text, /level watch/);
    assert.match((await act('browser.html', { tab: 404 })).text, /not granted/, 'a tab not granted is refused');
    assert.ok(e.calls.every((c) => String(c.args.tab) !== '404'), 'nothing was sent for it');

    await b.call('POST', '/api/tether/level', { target: id, agent: AGENT.id, level: 'propose' });
    const asked = act('browser.eval', { tab: 7, script: 'document.title' });
    await tick(30);
    const waiting = (await b.call('GET', '/api/tether')).body.approvals;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].view.title.t, 'Run a script in « Shop »', 'its card names the tab');
    assert.equal(waiting[0].view.code, 'document.title');
    assert.equal(demandeView(waiting[0]).irreversible, true);
    await b.call('POST', '/api/tether/decide', { id: waiting[0].id, decision: 'yes' });
    assert.equal((await asked).ok, true);

    /* Frame: the sites listed act without a card; the others ask. Empty, all asked. */
    await b.call('POST', '/api/tether/level', { target: id, agent: AGENT.id, level: 'frame' });
    const bad = await b.call('POST', '/api/tether/browser-sites', { target: id, agent: AGENT.id, sites: ['ex*ample.com'] });
    assert.equal(bad.status, 400);
    const set = await b.call('POST', '/api/tether/browser-sites', { target: id, agent: AGENT.id, sites: ['https://*.Example.com/', '', 'shop.example.com'] });
    assert.deepEqual(set.body.sites, ['*.example.com', 'shop.example.com']);
    for (const [verb, args] of [['browser.click', { selector: '.buy' }], ['browser.type', { text: 'hi' }], ['browser.eval', { script: '1' }]]) assert.equal((await act(verb, { tab: 7, ...args })).ok, true, verb);
    assert.equal((await b.call('GET', '/api/tether')).body.approvals.length, 0, 'nothing asked on an allowed site');
    const other = act('browser.click', { tab: 9, selector: '.pay' });
    await tick(30);
    const q = (await b.call('GET', '/api/tether')).body.approvals;
    assert.equal(q.length, 1, 'another site is asked');
    assert.equal(q[0].view.title.t, 'Click in the tab « Bank »');
    await b.call('POST', '/api/tether/decide', { id: q[0].id, decision: 'no' });
    assert.equal((await other).ok, false);
    assert.deepEqual((await b.call('POST', '/api/tether/browser-sites', { target: id, agent: AGENT.id, sites: [] })).body.sites, []);
    /* Free: everywhere. */
    await b.call('POST', '/api/tether/level', { target: id, agent: AGENT.id, level: 'free' });
    assert.equal((await act('browser.click', { tab: 9, selector: '.x' })).ok, true);
    assert.ok(!b.written().includes(e.token), 'the token in no journal');
});

test('a browser removed: its tokens go, its socket closes, the extension must pair again', async (t) => {
    const b = bench(t);
    const { e } = await paired(t, b);
    const token = e.token;
    const r = await b.call('POST', '/api/tether/remove-target', { target: 'browser-laptop-firefox' });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(b.browsers.status('browser-laptop-firefox').connected, false);
    assert.ok(!readFileSync(join(b.dir, 'tether-browser-tokens.json'), 'utf8').includes('browser-laptop-firefox'));
    const back = extension(b.browsers, { token }); back.start(); await tick();
    assert.ok(back.said.includes('pair-needed'));
});

test('the real endpoint: a WebSocket at /c/api/browser, paired, a call answered; any other path is not taken', async (t) => {
    const b = bench(t);
    const server = createServer((req, res) => res.writeHead(404).end());
    b.browsers.attach(server, WebSocketServer);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.close(); server.closeAllConnections(); });
    const port = server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_PATH}`);
    t.after(() => ws.terminate());
    const got = [];
    ws.on('message', (d) => { const m = JSON.parse(String(d)); got.push(m); if (m.t === 'call') ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, text: 'Shop' })); });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello' })); ws.send(JSON.stringify({ t: 'pair', code: '246810' }));
    await tick(50);
    const r = await b.call('POST', '/api/tether/browser-pair', { code: '246810', name: 'Desk' });
    assert.equal(r.status, 201);
    await tick(50);
    assert.ok(got.some((m) => m.t === 'paired' && m.token));
    ws.send(JSON.stringify({ t: 'tabs', tabs: [{ id: 3, url: 'https://example.com/', title: 'Example', site: 'example.com' }] }));
    await tick(50);
    await b.call('POST', '/api/tether/level', { target: r.body.id, agent: AGENT.id, level: 'free' });
    const out = await b.keeper().act('browser.eval', { target: r.body.id, tab: 3, script: 'document.title' }, AGENT);
    assert.equal(out.text, 'Shop');
    const other = new WebSocket(`ws://127.0.0.1:${port}/c/api/elsewhere`);
    const failed = await new Promise((res) => { other.on('error', () => res(true)); other.on('open', () => res(false)); setTimeout(() => res(true), 1500).unref(); });
    other.terminate();
    assert.equal(failed, true);
});
