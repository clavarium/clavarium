import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import WebSocket from 'ws';
import { startHome } from '../server/main.mjs';

/* A whole server behind the edge, with two ready conversations, and a phone. */
async function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-door-'));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([
        { name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready' }, { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready' }]));
    mkdirSync(join(dir, 'resources', 'photos'), { recursive: true }); mkdirSync(join(dir, 'resources', 'accounts'), { recursive: true });
    writeFileSync(join(dir, 'resources', 'photos', 'beach.txt'), 'sea'); writeFileSync(join(dir, 'resources', 'accounts', 'bank.txt'), 'secret');
    writeFileSync(join(dir, 'resources.json'), JSON.stringify([
        { name: 'photos', type: 'folder', attachments: { family: 'write' } }, { name: 'accounts', type: 'folder', attachments: { work: 'write' } }]));
    const origin = 'https://clav.example.com';
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: ['owner@example.com'], publicOrigin: origin });
    t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const operator = (path, body) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-forwarded-email': 'owner@example.com', origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    /* A device never carries the operator's header: the edge strips it under /c/. */
    const device = (path, { body, cookie, method } = {}) => fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    async function pairPhone(conversation) {
        const shared = await (await operator(`/api/conversations/${conversation}/share`, {})).json();
        const code = new URL(shared.url).hash.slice(1);
        const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const { device: id } = await (await device('/c/api/pair', { body: { code, key: publicKey.export({ format: 'jwk' }), label: 'Phone' } })).json();
        const { nonce } = await (await device('/c/api/challenge', { body: { device: id } })).json();
        const signature = sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        const opened = await device('/c/api/session', { body: { device: id, signature } });
        return { id, cookie: opened.headers.get('set-cookie').split(';')[0], shared, raw: opened.headers.get('set-cookie') };
    }
    return { base, origin, operator, device, pairPhone };
}

test('a shared conversation: the pairing address carries the code in its fragment, with a QR code of it', async (t) => {
    const b = await bench(t);
    const shared = await (await b.operator('/api/conversations/family/share', {})).json();
    assert.match(shared.url, /^https:\/\/clav\.example\.com\/c\/#[A-Za-z0-9_-]{43}$/);
    assert.ok(shared.qr.startsWith('<svg'));
    assert.equal(shared.minutes, 10);
    assert.equal((await b.operator('/api/conversations/nope/share', {})).status, 404);
});

test('a paired phone sees ITS conversation and nothing of the others, by any route', async (t) => {
    const b = await bench(t);
    const phone = await b.pairPhone('family');
    assert.match(phone.raw, /HttpOnly/); assert.match(phone.raw, /Path=\/c\//); assert.match(phone.raw, /Secure/);
    const me = await (await b.device('/c/api/me', { cookie: phone.cookie })).json();
    assert.deepEqual([me.name, me.resources], ['family', [{ name: 'photos', access: 'write' }]]);
    assert.deepEqual((await (await b.device('/c/api/files?r=photos&p=', { cookie: phone.cookie })).json()).entries.map((e) => e.name), ['beach.txt']);
    /* Asking for another conversation changes nothing: the answer is for the device's own. */
    assert.equal((await b.device('/c/api/files?c=work&r=accounts&p=', { cookie: phone.cookie })).status, 404);
    assert.equal((await b.device('/c/api/files/download?c=work&r=accounts&p=bank.txt', { cookie: phone.cookie })).status, 404);
    /* The operator's side stays closed to it: no identity, no entry. */
    for (const path of ['/', '/api/conversations', '/api/resources', '/api/conversations/work/devices']) {
        assert.equal((await b.device(path, { cookie: phone.cookie })).status, 403, path);
    }
    assert.equal((await b.device('/api/conversations/work/share', { body: {}, cookie: phone.cookie })).status, 403);
});

test('without a session the door gives the page and pairing, and nothing else', async (t) => {
    const b = await bench(t);
    assert.equal((await b.device('/c/')).status, 200);
    assert.equal((await b.device('/c/app.js')).status, 200);
    for (const path of ['/c/api/me', '/c/api/files?r=photos&p=', '/c/api/shortcuts', '/c/api/voice']) {
        assert.equal((await b.device(path)).status, 401, path);
        assert.equal((await b.device(path, { cookie: 'clv_device=forged' })).status, 401, `${path} with a forged cookie`);
    }
    assert.equal((await b.device('/c/api/pair', { body: { code: 'guess', key: {} } })).status, 403);
    /* A request from another site is refused before anything is looked at. */
    const elsewhere = await fetch(`${b.base}/c/api/pair`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(elsewhere.status, 403);
});

test('the terminal of a device is its conversation; revoked, the device is out everywhere', async (t) => {
    const b = await bench(t);
    const phone = await b.pairPhone('family');
    const attach = (cookie) => new Promise((done) => {
        const ws = new WebSocket(`${b.base.replace('http', 'ws')}/c/terminal?c=work`, { headers: { origin: b.origin, ...(cookie ? { cookie } : {}) } });
        ws.on('open', () => { ws.close(); done('opened'); });
        ws.on('error', () => done('refused'));
    });
    assert.equal(await attach(undefined), 'refused', 'no session');
    assert.equal(await attach(phone.cookie), 'opened');
    assert.deepEqual((await (await b.operator('/api/conversations/family/devices')).json()).map((d) => d.label), ['Phone']);
    assert.equal((await b.operator(`/api/devices/${phone.id}/revoke`, {})).status, 200);
    assert.equal((await b.device('/c/api/me', { cookie: phone.cookie })).status, 401);
    assert.equal(await attach(phone.cookie), 'refused');
    assert.deepEqual(await (await b.operator('/api/conversations/family/devices')).json(), []);
});
