import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeGate, makeOriginCheck, readOperators } from '../server/gate.mjs';
import { startHome } from '../server/main.mjs';

test('with operators declared, only their address opens the gate: no header, another address or two addresses do not', () => {
    const gate = makeGate(readOperators('Owner@Example.com, second@example.com'));
    assert.equal(gate({ 'x-forwarded-email': 'owner@example.com' }), 'owner@example.com');
    assert.equal(gate({ 'x-forwarded-email': ' OWNER@example.com ' }), 'owner@example.com');
    for (const headers of [{}, { 'x-forwarded-email': 'guest@example.com' }, { 'x-forwarded-email': 'owner@example.com, guest@example.com' }, { 'x-forwarded-email': '' }]) {
        assert.equal(gate(headers), undefined, JSON.stringify(headers));
    }
    assert.equal(makeGate([])({}), 'local', 'no operator declared is development mode');
    assert.throws(() => readOperators('not-an-address'), /not an email/);
});

test('behind the edge, the origin is compared with the declared public address, whatever Host says', () => {
    const check = makeOriginCheck('https://clav.example.com/');
    assert.equal(check({ origin: 'https://clav.example.com', host: '127.0.0.1:4180' }), true);
    assert.equal(check({ origin: 'https://evil.example', host: 'clav.example.com' }), false);
    assert.equal(check({ host: 'clav.example.com' }), false);
});

test('a real server behind the edge: pages, API and terminal all refuse whoever is not an operator', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-gate-'));
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: ['owner@example.com'], publicOrigin: 'https://clav.example.com' });
    t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const as = (email) => (email ? { 'x-forwarded-email': email } : {});

    for (const path of ['/', '/app.js', '/api/conversations', '/api/tools']) {
        assert.equal((await fetch(base + path)).status, 403, `${path} with no identity`);
        assert.equal((await fetch(base + path, { headers: as('guest@example.com') })).status, 403, `${path} as a stranger`);
        assert.equal((await fetch(base + path, { headers: as('owner@example.com') })).status, 200, `${path} as the operator`);
    }
    const create = (headers) => fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"name":"x","tool":"nope"}' });
    assert.equal((await create({ ...as('owner@example.com'), origin: 'https://evil.example' })).status, 403, 'the operator, but from another site');
    assert.equal((await create({ ...as('owner@example.com'), origin: 'https://clav.example.com' })).status, 400, 'reaches the API (which refuses the tool)');

    const attach = (headers) => new Promise((done) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/terminal?c=demo`, { headers });
        ws.on('open', () => { ws.close(); done('opened'); });
        ws.on('error', () => done('refused'));
    });
    assert.equal(await attach({ origin: 'https://clav.example.com' }), 'refused', 'terminal with no identity');
    assert.equal(await attach({ origin: 'https://clav.example.com', ...as('guest@example.com') }), 'refused', 'terminal as a stranger');
    assert.equal(await attach({ origin: 'https://evil.example', ...as('owner@example.com') }), 'refused', 'terminal from another site');
    assert.equal(await attach({ origin: 'https://clav.example.com', ...as('owner@example.com') }), 'opened');
});
