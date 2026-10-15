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
        { name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }, { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }]));
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
    /* `what`: the name of a conversation, or a chosen list [{ asset, rights }]. */
    async function pairPhone(what) {
        const shared = await (await (typeof what === 'string' ? operator(`/api/conversations/${what}/share`, {}) : operator('/api/shares', { grants: what }))).json();
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
    const me = await (await b.device(`/c/api/${phone.id}/me`, { cookie: phone.cookie })).json();
    assert.deepEqual([me.name, me.resources], ['family', [{ name: 'photos', access: 'write' }]]);
    assert.deepEqual((await (await b.device(`/c/api/${phone.id}/files?r=photos&p=`, { cookie: phone.cookie })).json()).entries.map((e) => e.name), ['beach.txt']);
    /* Asking for another conversation changes nothing: the answer is for the device's own. */
    assert.equal((await b.device(`/c/api/${phone.id}/files?c=work&r=accounts&p=`, { cookie: phone.cookie })).status, 404);
    assert.equal((await b.device(`/c/api/${phone.id}/files/download?c=work&r=accounts&p=bank.txt`, { cookie: phone.cookie })).status, 404);
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
    const any = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const path of [`/c/api/${any}/me`, `/c/api/${any}/files?r=photos&p=`, `/c/api/${any}/shortcuts`, `/c/api/${any}/voice`, '/c/api/me']) {
        assert.equal((await b.device(path)).status, 401, path);
        assert.equal((await b.device(path, { cookie: `clv_device_${any}=forged` })).status, 401, `${path} with a forged cookie`);
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
        const ws = new WebSocket(`${b.base.replace('http', 'ws')}/c/terminal?c=work&d=${phone.id}`, { headers: { origin: b.origin, ...(cookie ? { cookie } : {}) } });
        ws.on('open', () => { ws.close(); done('opened'); });
        ws.on('error', () => done('refused'));
    });
    assert.equal(await attach(undefined), 'refused', 'no session');
    assert.equal(await attach(phone.cookie), 'opened');
    assert.deepEqual((await (await b.operator('/api/conversations/family/devices')).json()).map((d) => d.label), ['Phone']);
    assert.equal((await b.operator(`/api/devices/${phone.id}/revoke`, {})).status, 200);
    assert.equal((await b.device(`/c/api/${phone.id}/me`, { cookie: phone.cookie })).status, 401);
    assert.equal(await attach(phone.cookie), 'refused');
    assert.deepEqual(await (await b.operator('/api/conversations/family/devices')).json(), []);
});

test('one device, two conversations: each pairing has its session, and neither speaks for the other', async (t) => {
    const b = await bench(t);
    const family = await b.pairPhone('family');
    const work = await b.pairPhone('work');
    /* What a browser sends: both cookies, on every request. */
    const cookie = `${family.cookie}; ${work.cookie}`;
    assert.notEqual(family.cookie.split('=')[0], work.cookie.split('=')[0], 'two cookies, not one replaced');
    const name = async (id) => (await (await b.device(`/c/api/${id}/me`, { cookie })).json()).name;
    assert.deepEqual([await name(family.id), await name(work.id)], ['family', 'work']);
    /* The session of one, presented under the name of the other: refused. */
    const swapped = `clv_device_${work.id}=${family.cookie.split('=')[1]}`;
    assert.equal((await b.device(`/c/api/${work.id}/me`, { cookie: swapped })).status, 401);
    assert.equal((await b.device(`/c/api/${family.id}/files?r=accounts&p=`, { cookie })).status, 404, 'the folder of the other conversation is not this one\'s');
    /* The device takes one off itself: the other goes on. */
    assert.equal((await b.device(`/c/api/${work.id}/leave`, { body: {}, cookie })).status, 200);
    assert.equal((await b.device(`/c/api/${work.id}/me`, { cookie })).status, 401);
    assert.equal(await name(family.id), 'family');
    assert.deepEqual(await (await b.operator('/api/conversations/work/devices')).json(), []);
});

test('a composed share: two conversations and a folder of its own, each with its rights -- and nothing more', async (t) => {
    const b = await bench(t);
    const tablet = await b.pairPhone([{ asset: 'conversation:family', rights: 'x' }, { asset: 'conversation:work', rights: 'x' }, { asset: 'folder:accounts', rights: 'r' }]);
    const get = (path) => b.device(`/c/api/${tablet.id}${path}`, { cookie: tablet.cookie });
    const me = await (await get('/me?c=work')).json();
    assert.deepEqual([me.name, me.conversations, me.shared], ['work', ['family', 'work'], [{ name: 'accounts', type: 'folder', access: 'read' }]]);
    assert.equal((await (await get('/me?c=family')).json()).name, 'family');
    assert.equal((await (await get('/me?c=someone-elses')).json()).name, 'family', 'a conversation it was not given falls back on its own');
    /* The folder given to the device itself: read, from any of its conversations; never written. */
    assert.deepEqual((await (await get('/files?c=family&r=accounts&p=')).json()).entries.map((e) => e.name), ['bank.txt']);
    const write = await fetch(`${b.base}/c/api/${tablet.id}/files/import?c=family&r=accounts&p=&name=x.txt`, { method: 'POST', headers: { origin: b.origin, 'content-type': 'application/octet-stream', cookie: tablet.cookie }, body: 'x' });
    assert.equal(write.status, 403);
    /* Through the conversation `work`, where that folder is attached to write, it may write: the larger of the two ways holds. */
    const through = await fetch(`${b.base}/c/api/${tablet.id}/files/import?c=work&r=accounts&p=&name=y.txt`, { method: 'POST', headers: { origin: b.origin, 'content-type': 'application/octet-stream', cookie: tablet.cookie }, body: 'y' });
    assert.equal(through.status, 201);
    /* The owner sees who has what, takes one thing back, and the rest stays. */
    const seen = (await (await b.operator('/api/devices')).json()).find((d) => d.id === tablet.id);
    assert.deepEqual(seen.grants.map((g) => `${g.asset} ${g.rights}`), ['conversation:family x', 'conversation:work x', 'folder:accounts r']);
    assert.equal((await b.operator(`/api/devices/${tablet.id}/take`, { asset: 'conversation:work' })).status, 200);
    assert.deepEqual((await (await get('/me?c=work')).json()).conversations, ['family']);
    /* What cannot be shared is refused when the share is made. */
    assert.equal((await b.operator('/api/shares', { grants: [{ asset: 'folder:nowhere', rights: 'r' }] })).status, 404);
    assert.equal((await b.operator('/api/shares', { grants: [{ asset: 'folder:accounts', rights: 'x' }] })).status, 400);
    assert.equal((await b.operator('/api/shares', { grants: [] })).status, 400);
});

test('a device given only a folder, and no conversation: it reads the folder, and has no terminal', async (t) => {
    const b = await bench(t);
    const reader = await b.pairPhone([{ asset: 'folder:photos', rights: 'rw' }]);
    const me = await (await b.device(`/c/api/${reader.id}/me`, { cookie: reader.cookie })).json();
    assert.deepEqual([me.name, me.conversations, me.shared], [null, [], [{ name: 'photos', type: 'folder', access: 'write' }]]);
    assert.deepEqual((await (await b.device(`/c/api/${reader.id}/files?r=photos&p=`, { cookie: reader.cookie })).json()).entries.map((e) => e.name), ['beach.txt']);
    assert.equal((await b.device(`/c/api/${reader.id}/files?r=accounts&p=`, { cookie: reader.cookie })).status, 404);
    assert.equal((await b.device(`/c/api/${reader.id}/shortcuts`, { cookie: reader.cookie })).status, 404);
    const refused = await new Promise((done) => { const ws = new WebSocket(`${b.base.replace('http', 'ws')}/c/terminal?d=${reader.id}`, { headers: { origin: b.origin, cookie: reader.cookie } }); ws.on('open', () => { ws.close(); done('opened'); }); ws.on('error', () => done('refused')); });
    assert.equal(refused, 'refused');
});

test('the owner reaches every folder, attached to the conversation shown or not', async (t) => {
    const b = await bench(t);
    /* `accounts` is attached to `work`, not to `family`: the owner still reads it, and writes in it, from there. */
    assert.deepEqual((await (await b.operator('/api/files?c=family&r=accounts&p=')).json()).entries.map((e) => e.name), ['bank.txt']);
    const put = await fetch(`${b.base}/api/files/import?c=family&r=accounts&p=&name=owner.txt`, { method: 'POST', headers: { 'x-forwarded-email': 'owner@example.com', origin: b.origin, 'content-type': 'application/octet-stream' }, body: 'x' });
    assert.equal(put.status, 201);
    assert.equal((await b.operator('/api/files?c=family&r=nowhere&p=')).status, 404);
});

test('a paired phone talks in ITS conversation\'s chat, where it is on: read, written to, reminded; never turned on or off from there', async (t) => {
    const b = await bench(t);
    const phone = await b.pairPhone('family');
    const as = { cookie: phone.cookie };
    assert.equal((await (await b.device(`/c/api/${phone.id}/conversations/family/talk`, as)).json()).on, false, 'off: nothing to read');
    assert.equal((await b.operator('/api/conversations/family/talk', { on: true })).status, 200);
    assert.equal((await b.operator('/api/conversations/work/talk', { on: true })).status, 200);
    assert.equal((await b.operator('/api/conversations/work/talk', { text: 'only for work' })).status, 201);
    assert.equal((await b.device(`/c/api/${phone.id}/conversations/family/talk`, { ...as, body: { text: 'From the phone.' } })).status, 201);
    /* Whatever conversation the address names, the answer is for the device's own. */
    const seen = await (await b.device(`/c/api/${phone.id}/conversations/work/talk`, as)).json();
    assert.deepEqual([seen.on, seen.messages.map((m) => m.text)], [true, ['From the phone.']]);
    assert.equal((await (await b.operator('/api/conversations/work/talk')).json()).messages.length, 1, 'nothing written into another conversation');
    assert.equal((await b.device(`/c/api/${phone.id}/conversations/family/talk/remind`, { ...as, body: {} })).status, 200);
    assert.equal((await (await b.device(`/c/api/${phone.id}/talk/words?lang=fr`, as)).json()).send, 'Envoyer');
    /* Turning it off, or inviting the tool, stays the owner's. */
    assert.equal((await b.device(`/c/api/${phone.id}/conversations/family/talk`, { ...as, body: { on: false } })).status, 400);
    assert.equal((await b.device(`/c/api/${phone.id}/conversations/family/talk/invite`, { ...as, body: {} })).status, 404);
    assert.equal((await (await b.operator('/api/conversations/family/talk')).json()).on, true);
    assert.equal((await b.device('/c/api/0f8fad5b-d9cb-469f-a165-70867728950e/conversations/family/talk')).status, 401, 'no session, no chat');
});
