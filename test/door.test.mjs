import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
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
    return { base, origin, operator, device, pairPhone, dir };
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

test('the terminal of a device is its conversation, named, and no other; revoked, the device is out everywhere', async (t) => {
    const b = await bench(t);
    const phone = await b.pairPhone('family');
    const attach = (cookie, c = 'family') => new Promise((done) => {
        const ws = new WebSocket(`${b.base.replace('http', 'ws')}/c/terminal?${c === null ? '' : `c=${c}&`}d=${phone.id}`, { headers: { origin: b.origin, ...(cookie ? { cookie } : {}) } });
        ws.on('open', () => { ws.close(); done('opened'); });
        ws.on('error', () => done('refused'));
    });
    assert.equal(await attach(undefined), 'refused', 'no session');
    assert.equal(await attach(phone.cookie), 'opened');
    /* A conversation it was not given is refused -- not answered with its own in its place. */
    assert.equal(await attach(phone.cookie, 'work'), 'refused');
    assert.equal(await attach(phone.cookie, 'nothing-here'), 'refused');
    assert.equal(await attach(phone.cookie, null), 'refused', 'no conversation named: nothing guessed');
    for (const route of ['/me?c=work', '/files?c=work&r=accounts&p=', '/conversations/work/talk', '/shortcuts?c=work']) {
        const r = await b.device(`/c/api/${phone.id}${route}`, { cookie: phone.cookie });
        const body = await r.json();
        assert.ok(r.status >= 400 || body.name === null, `${route}: nothing of the other conversation (${r.status})`);
        assert.ok(!JSON.stringify(body).includes('bank.txt'), `${route}: none of its files`);
    }
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
    assert.equal((await (await get('/me?c=someone-elses')).json()).name, null, 'a conversation it was not given is none: never another in its place');
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
    const phone = await b.pairPhone([{ asset: 'conversation:family', rights: 'rwx' }]);
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

/* A WebSocket to a device's terminal: 'opened' or 'refused'. */
const terminalOf = (b, phone, c) => new Promise((done) => {
    const ws = new WebSocket(`${b.base.replace('http', 'ws')}/c/terminal?d=${phone.id}${c ? `&c=${c}` : ''}`, { headers: { origin: b.origin, cookie: phone.cookie } });
    ws.on('open', () => { ws.close(); done('opened'); });
    ws.on('error', () => done('refused'));
});

test('a conversation shared in parts: what was not given is refused by the server, not only hidden -- the terminal; shortcuts and dictation unless it may write in the chat; the chat, its words; never turning it on or inviting the tool', async (t) => {
    const b = await bench(t);
    assert.equal((await b.operator('/api/conversations/family/talk', { on: true })).status, 200);
    const chatOnly = await b.pairPhone([{ asset: 'conversation:family', rights: 'rw' }]);
    const terminalOnly = await b.pairPhone([{ asset: 'conversation:family', rights: 'x' }]);
    const readOnly = await b.pairPhone([{ asset: 'conversation:family', rights: 'r' }]);
    const at = (phone, path, body) => b.device(`/c/api/${phone.id}${path}`, { cookie: phone.cookie, ...(body === undefined ? {} : { body }) });
    const status = async (phone, path, body) => (await at(phone, path, body)).status;
    /* What each was given, said to its page. */
    const parts = async (phone) => { const me = await (await at(phone, '/me')).json(); return [me.terminal, me.chat]; };
    assert.deepEqual([await parts(chatOnly), await parts(terminalOnly), await parts(readOnly)], [[false, 'write'], [true, null], [false, 'read']]);

    /* The chat alone: no terminal channel; it writes, reminds, dictates into the chat, and has the owner's ready answers there. */
    assert.equal(await terminalOf(b, chatOnly), 'refused');
    assert.equal(await terminalOf(b, chatOnly, 'family'), 'refused');
    assert.equal(await status(chatOnly, '/shortcuts'), 200);
    assert.equal(await status(chatOnly, '/conversations/family/talk'), 200);
    assert.equal(await status(chatOnly, '/conversations/family/talk', { text: 'Hello from Dad.' }), 201);
    assert.equal(await status(chatOnly, '/conversations/family/talk/remind', {}), 200);
    assert.equal(await status(chatOnly, '/talk/words?lang=fr'), 200);
    /* Not its files: those of the chat only (see below). */
    assert.equal(await status(chatOnly, '/files?r=photos&p='), 403);
    /* Never the owner's switches, whatever it sends. */
    assert.equal(await status(chatOnly, '/conversations/family/talk', { on: false }), 400);
    assert.equal(await status(chatOnly, '/conversations/family/talk/invite', { lang: 'en' }), 404);
    assert.equal((await (await b.operator('/api/conversations/family/talk')).json()).on, true);

    /* The terminal alone: none of the chat, its words included. */
    assert.equal(await terminalOf(b, terminalOnly, 'family'), 'opened');
    assert.equal(await terminalOf(b, terminalOnly), 'refused', 'no conversation named: nothing guessed');
    assert.equal(await status(terminalOnly, '/shortcuts'), 200);
    for (const path of ['/conversations/family/talk', '/talk/words?lang=en']) assert.equal(await status(terminalOnly, path), 403, path);
    assert.equal(await status(terminalOnly, '/conversations/family/talk', { text: 'sneaked in' }), 403);
    assert.equal(await status(terminalOnly, '/conversations/family/talk/remind', {}), 403);
    assert.equal((await (await b.operator('/api/conversations/family/talk')).json()).messages.map((m) => m.text).join('|'), 'Hello from Dad.');

    /* The chat to read only: read, and nothing written, typed or dictated; no ready answers to send. */
    assert.equal(await status(readOnly, '/conversations/family/talk'), 200);
    assert.equal(await status(readOnly, '/shortcuts'), 403);
    assert.equal(await status(readOnly, '/conversations/family/talk', { text: 'no' }), 403);
    assert.equal(await status(readOnly, '/conversations/family/talk/remind', {}), 403);
    assert.equal(await terminalOf(b, readOnly), 'refused');
    const dictated = await fetch(`${b.base}/c/api/${readOnly.id}/voice`, { method: 'POST', headers: { origin: b.origin, 'content-type': 'audio/wav', cookie: readOnly.cookie }, body: 'RIFF' });
    assert.equal(dictated.status, 403);
    assert.equal((await (await at(readOnly, '/voice')).json()).available, false);

    /* Changed later by the owner, without a new code: the terminal is given, the chat taken. */
    assert.equal((await b.operator(`/api/devices/${chatOnly.id}/give`, { asset: 'conversation:family', rights: 'x' })).status, 200);
    assert.equal(await terminalOf(b, chatOnly, 'family'), 'opened');
    assert.equal(await status(chatOnly, '/conversations/family/talk'), 403);
    /* At least one part: nothing at all is not a share. */
    assert.equal((await b.operator(`/api/devices/${chatOnly.id}/give`, { asset: 'conversation:family', rights: '' })).status, 400);
    assert.equal((await b.operator('/api/conversations/family/share', { rights: '' })).status, 400);
    assert.equal((await b.operator('/api/conversations/family/share', { rights: 'rw' })).status, 201);
});

test('a device paired before a conversation was shared in parts keeps what it had: its terminal, and its chat where it was on', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-door-old-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const key = publicKey.export({ format: 'jwk' });
    const [one, two] = ['0f8fad5b-d9cb-469f-a165-70867728950e', '1f8fad5b-d9cb-469f-a165-70867728950e'];
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([
        { name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }, { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }]));
    writeFileSync(join(dir, 'devices.json'), JSON.stringify([{ name: one, key, label: 'Phone', createdAt: '2030-01-01T00:00:00.000Z' }, { name: two, key, label: 'Tablet', createdAt: '2030-01-01T00:00:00.000Z' }]));
    writeFileSync(join(dir, 'grants.json'), JSON.stringify([
        { name: `pairing:${one}|conversation:family`, subject: `pairing:${one}`, asset: 'conversation:family', rights: 'x' },
        { name: `pairing:${two}|conversation:work`, subject: `pairing:${two}`, asset: 'conversation:work', rights: 'x' }]));
    writeFileSync(join(dir, 'talk.json'), JSON.stringify([{ name: 'family', on: true }]));
    const start = async () => startHome({ port: 0, host: ['true'], dataDir: dir, operators: ['owner@example.com'], publicOrigin: 'https://clav.example.com' });
    const devices = async (server) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/devices`, { headers: { 'x-forwarded-email': 'owner@example.com' } });
        return Object.fromEntries((await r.json()).map((d) => [d.label, d.grants.map((g) => `${g.asset} ${g.rights}`).join()]));
    };
    let server = await start();
    assert.deepEqual(await devices(server), { Phone: 'conversation:family rwx', Tablet: 'conversation:work x' });
    /* Once: the owner then takes the chat from the phone, and it stays taken after a restart. */
    await fetch(`http://127.0.0.1:${server.address().port}/api/devices/${one}/give`, { method: 'POST', headers: { 'x-forwarded-email': 'owner@example.com', origin: 'https://clav.example.com', 'content-type': 'application/json' }, body: JSON.stringify({ asset: 'conversation:family', rights: 'x' }) });
    server.close();
    server = await start();
    t.after(() => server.close());
    assert.deepEqual(await devices(server), { Phone: 'conversation:family x', Tablet: 'conversation:work x' });
});

test('a device given the chat alone has the files OF THE CHAT, both ways, and nothing more: no listing, no import, no file of the machine -- refused by the server', async (t) => {
    const b = await bench(t);
    assert.equal((await b.operator('/api/conversations/family/talk', { on: true })).status, 200);
    const work = join(b.dir, 'work', 'family');
    writeFileSync(join(work, 'report.txt'), '38 orders'); writeFileSync(join(work, 'private.txt'), 'not shown');
    /* The tool shows two files in the chat: one of its work folder, one of an attached folder. */
    const at = new Date().toISOString();
    appendFileSync(join(work, '.parley', 'from-agent.jsonl'), `${JSON.stringify({ id: 's1', at, kind: 'show', path: '/work/report.txt', text: '' })}\n${JSON.stringify({ id: 's2', at, kind: 'show', path: '/resources/photos/beach.txt', text: '' })}\n`);
    const dad = await b.pairPhone([{ asset: 'conversation:family', rights: 'rw' }]);
    const both = await b.pairPhone([{ asset: 'conversation:family', rights: 'rwx' }]);
    const get = (phone, path) => b.device(`/c/api/${phone.id}${path}`, { cookie: phone.cookie });
    const put = (phone, path, body) => fetch(`${b.base}/c/api/${phone.id}${path}`, { method: 'POST', headers: { origin: b.origin, cookie: phone.cookie, 'content-type': 'application/octet-stream' }, body });
    /* What the tool showed opens, from the chat. */
    assert.equal(await (await get(dad, '/files/download?r=work&p=report.txt')).text(), '38 orders');
    assert.equal((await get(dad, '/files/download?r=photos&p=beach.txt')).status, 200);
    /* Nothing else: not another file, not a listing, not an import, not a file of the machine's disk. */
    for (const path of ['/files/download?r=work&p=private.txt', '/files/page?r=work&p=private.txt', '/files?r=work&p=', '/files?r=photos&p=', '/files/machine?p=/work/private.txt']) assert.equal((await get(dad, path)).status, 403, path);
    assert.equal((await put(dad, '/files/import?r=photos&p=&name=x.txt', 'x')).status, 403);
    assert.equal(existsSync(join(b.dir, 'resources', 'photos', 'x.txt')), false);
    /* A device given its terminal too has the conversation's files, as before. */
    assert.equal((await get(both, '/files?r=work&p=')).status, 200);
    assert.equal((await get(both, '/files/download?r=work&p=private.txt')).status, 200);
    /* The other way: a file attached to a message, put where the tool finds it, announced with its path. */
    const sent = await put(dad, '/conversations/family/talk/file?name=photo%20of%20dad.jpg', 'JPEG');
    assert.equal(sent.status, 201);
    const file = await sent.json();
    assert.match(file.path, /^\/work\/\.parley\/files\/[0-9a-f-]{36}\/photo of dad\.jpg$/);
    assert.deepEqual([file.name, file.size], ['photo of dad.jpg', 4]);
    assert.equal(readFileSync(join(work, file.path.slice('/work/'.length)), 'utf8'), 'JPEG');
    assert.equal((await b.device(`/c/api/${dad.id}/conversations/family/talk`, { cookie: dad.cookie, body: { text: 'Here is the photo.', files: [file.path] } })).status, 201);
    const told = readFileSync(join(work, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([told.text, told.files], ['Here is the photo.', [{ path: file.path, name: 'photo of dad.jpg', size: 4 }]]);
    /* It opens from its message, on the device that sent it; nothing else of the bridge folder does. */
    const inner = file.path.slice('/work/'.length);
    assert.equal(await (await get(dad, `/files/download?r=work&p=${encodeURIComponent(inner)}`)).text(), 'JPEG');
    assert.equal((await get(dad, '/files/download?r=work&p=.parley/to-agent.jsonl')).status, 403);
    /* Only a file attached here first: no other path, no file that is not there. */
    for (const files of [['/etc/passwd'], ['/work/report.txt'], [file.path.replace(/[0-9a-f]{8}-/, '00000000-')]]) {
        assert.equal((await b.device(`/c/api/${dad.id}/conversations/family/talk`, { cookie: dad.cookie, body: { text: 'x', files } })).status, 400, files[0]);
    }
    /* A chat to read only attaches nothing. */
    const reader = await b.pairPhone([{ asset: 'conversation:family', rights: 'r' }]);
    assert.equal((await put(reader, '/conversations/family/talk/file?name=a.txt', 'a')).status, 403);
    /* Its terminal is not its to repair. */
    assert.equal((await b.device(`/c/api/${dad.id}/terminal/repair`, { cookie: dad.cookie, body: {} })).status, 403);
});

test('changes by hand in Files: the owner where it may write; a folder attached read-only refuses them, to the owner too; only from this site', async (t) => {
    const b = await bench(t);
    const own = (path, { body, type = 'application/json', origin = b.origin } = {}) => fetch(b.base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-forwarded-email': 'owner@example.com', origin, 'content-type': type }, body: type === 'application/json' && body !== undefined ? JSON.stringify(body) : body });
    const work = join(b.dir, 'work', 'family');
    mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'notes.md'), 'one');
    assert.equal((await own('/api/files/make?c=family&r=work&p=', { body: { name: 'drafts', folder: true } })).status, 201);
    assert.equal((await own('/api/files/move?c=family&r=work&p=notes.md', { body: { to: 'drafts' } })).status, 200);
    const read = await (await own('/api/files/text?c=family&r=work&p=drafts/notes.md')).json();
    assert.equal(read.text, 'one');
    assert.equal((await own(`/api/files/save?c=family&r=work&p=drafts/notes.md&version=${read.version}`, { body: 'two', type: 'application/octet-stream' })).status, 200);
    /* Saved again at the old version: the file changed meanwhile, nothing written. */
    const stale = await own(`/api/files/save?c=family&r=work&p=drafts/notes.md&version=${read.version}`, { body: 'three', type: 'application/octet-stream' });
    assert.deepEqual([stale.status, (await stale.json()).kind], [409, 'changed']);
    assert.equal(readFileSync(join(work, 'drafts', 'notes.md'), 'utf8'), 'two');
    /* Not from this site: refused, whatever the route. */
    assert.equal((await own('/api/files/remove?c=family&r=work&p=drafts', { body: {}, origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await own('/api/files/make?c=family&r=work&p=', { body: 'name=x', type: 'text/plain' })).status, 400);
    /* A thumbnail: only a proven picture, answered with rules that run nothing. */
    writeFileSync(join(work, 'red.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYQQwAHhYCAPmBfFgAAAAASUVORK5CYII=', 'base64'));
    const thumb = await own('/api/files/thumb?c=family&r=work&p=red.png');
    assert.deepEqual([thumb.status, thumb.headers.get('content-type'), thumb.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
    assert.match(thumb.headers.get('content-security-policy'), /sandbox/);
    writeFileSync(join(work, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal((await own('/api/files/thumb?c=family&r=work&p=logo.svg')).status, 415);
    /* `photos` attached to `family` read-only: read, and nothing changed in it from there -- by the owner either. */
    assert.equal((await b.operator('/api/conversations/family/resources', { resource: 'photos', access: 'read' })).status, 200);
    for (const [path, body] of [['/api/files/make?c=family&r=photos&p=', { name: 'x.txt' }], ['/api/files/rename?c=family&r=photos&p=beach.txt', { name: 'sea.txt' }],
        ['/api/files/remove?c=family&r=photos&p=beach.txt', {}], ['/api/files/taken?c=family&r=photos&p=', { names: ['a'] }]]) assert.equal((await own(path, { body })).status, 403, path);
    assert.equal((await own('/api/files/save?c=family&r=photos&p=beach.txt&version=any', { body: 'x', type: 'application/octet-stream' })).status, 403);
    assert.equal((await own('/api/files/import?c=family&r=photos&p=&name=x.txt', { body: 'x', type: 'application/octet-stream' })).status, 403);
    assert.equal((await own('/api/files/text?c=family&r=photos&p=beach.txt')).status, 200, 'still read');
    assert.equal(readFileSync(join(b.dir, 'resources', 'photos', 'beach.txt'), 'utf8'), 'sea');
});

test('changes by hand from a device: where it may write; never in a folder attached read-only; and a device given the chat alone has none of them', async (t) => {
    const b = await bench(t);
    const work = join(b.dir, 'work', 'family');
    mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'report.txt'), 'draft');
    const both = await b.pairPhone([{ asset: 'conversation:family', rights: 'rwx' }]);
    const dad = await b.pairPhone([{ asset: 'conversation:family', rights: 'rw' }]);
    const go = (phone, path, body, type = 'application/json') => fetch(`${b.base}/c/api/${phone.id}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { origin: b.origin, cookie: phone.cookie, 'content-type': type }, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
    assert.equal((await go(both, '/files/make?r=work&p=', { name: 'drafts', folder: true })).status, 201);
    assert.equal((await go(both, '/files/rename?r=work&p=report.txt', { name: 'report v2.txt' })).status, 200);
    const read = await (await go(both, '/files/text?r=work&p=report v2.txt')).json();
    assert.equal((await go(both, `/files/save?r=work&p=report v2.txt&version=${read.version}`, 'final', 'application/octet-stream')).status, 200);
    assert.equal(readFileSync(join(work, 'report v2.txt'), 'utf8'), 'final');
    /* Its chat alone: none of it, refused by the server -- not even a thumbnail or a text to read. */
    for (const [path, body, type] of [['/files/thumb?r=work&p=report v2.txt'], ['/files/text?r=work&p=report v2.txt'], ['/files/make?r=work&p=', { name: 'x.txt' }],
        ['/files/rename?r=work&p=drafts', { name: 'y' }], ['/files/move?r=work&p=report v2.txt', { to: 'drafts' }], ['/files/remove?r=work&p=drafts', {}],
        ['/files/taken?r=work&p=', { names: ['a'] }], ['/files/save?r=work&p=report v2.txt&version=any', 'x', 'application/octet-stream'],
        ['/files/make?r=photos&p=', { name: 'x.txt' }]]) assert.equal((await go(dad, path, body, type)).status, 403, path);
    assert.equal(readFileSync(join(work, 'report v2.txt'), 'utf8'), 'final');
    assert.equal(existsSync(join(work, 'drafts')), true);
    /* Attached read-only: read, never changed. */
    assert.equal((await b.operator('/api/conversations/family/resources', { resource: 'photos', access: 'read' })).status, 200);
    assert.equal((await go(both, '/files/text?r=photos&p=beach.txt')).status, 200);
    assert.equal((await go(both, '/files/remove?r=photos&p=beach.txt', {})).status, 403);
    assert.equal((await go(both, '/files/make?r=photos&p=', { name: 'x', folder: true })).status, 403);
    assert.equal(existsSync(join(b.dir, 'resources', 'photos', 'beach.txt')), true);
    /* Not from this site. */
    const foreign = await fetch(`${b.base}/c/api/${both.id}/files/remove?r=work&p=drafts`, { method: 'POST', headers: { origin: 'https://evil.example.com', cookie: both.cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
});
