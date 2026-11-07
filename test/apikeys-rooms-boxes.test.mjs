import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeys, handleExternal, handleApiKeys, roomThreadOf, TOOLS, SPEAK_MAX, SPEAK_PER_MIN } from '../server/apikeys.mjs';
import { Grants, MemoryStore, apiKeySubject, pairingSubject } from '../server/grants.mjs';
import { Rooms } from '../server/rooms.mjs';
import { Boxes } from '../server/boxes.mjs';
import { Store, JsonFile } from '../server/store.mjs';

/* API keys given rooms and voice boxes (07-11), one by one, as conversations are: a room to read or to talk in,
   a box to see or to make speak aloud. */
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'clv-apikeys-rb-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const bearer = (secret) => `Bearer ${secret}`;
const statusOfError = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.status; } };
const SECRET_LIKE = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD';

class MemoryFile { #v; constructor(v) { this.#v = v; } get() { return structuredClone(this.#v); } set(v) { this.#v = structuredClone(v); } }
class FakeSocket extends EventEmitter {
    readyState = 1; sent = []; closed = null;
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : { bytes: data.length }); }
    close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
}

async function call(opts, { method = 'GET', path, secret, body, headers = {} }) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const request = { method, url: path, headers: { ...(secret ? { authorization: bearer(secret) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        async *[Symbol.asyncIterator]() { if (text) yield text; } };
    const out = { status: 0, text: '' };
    const response = { writeHead(code) { out.status = code; return response; }, end(t) { out.text = t ?? ''; } };
    await handleExternal(request, response, opts);
    return { status: out.status, body: out.text ? JSON.parse(out.text) : null };
}

/* A real room (rooms.mjs, its thread a Parley folder) and a real box (boxes.mjs, a fake socket), behind the door. */
function home(t) {
    const dir = folder(t);
    const grants = new Grants(new MemoryStore());
    const toAi = []; const spoken = [];
    const convs = [{ name: 'hugo', chatName: 'Hugo' }, { name: 'compta', title: 'Compta' }];
    let boxes;
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async (name, text, extra) => { toAi.push({ name, text, extra }); },
        conversations: () => convs, boxes: () => boxes.all(), removed: (id) => grants.forgetAsset(`room:${id}`) });
    boxes = new Boxes({ file: new MemoryFile([]), exists: (c) => c === 'hugo', hear: async () => '', say: async () => {}, speak: async (text) => { spoken.push(text); return Buffer.alloc(32_000 * 2, 1); },
        removed: (id) => grants.forgetAsset(`box:${id}`) });
    const kitchen = boxes.pair({ code: boxes.code('hugo', 'Cuisine').code });
    const garden = boxes.pair({ code: boxes.code('hugo', 'Jardin').code });
    const socket = new FakeSocket();
    boxes.accept(socket, boxes.byKey(kitchen.key));
    const house = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'] });
    const office = rooms.create({ name: 'Bureau', conversations: ['compta'] });
    const keys = new ApiKeys({ store: new Store(join(dir, 'apikeys.json')), grants, journal: join(dir, 'apikeys.log'), exists: (n) => convs.some((c) => c.name === n),
        roomExists: (id) => rooms.has(id), boxExists: (id) => boxes.all().some((b) => b.id === id) });
    const opts = { keys, status: async () => ({}), chats: { list: () => [], chatOn: () => false, read: () => ({}), say: async () => ({}) },
        rooms: {
            list: () => rooms.list().map((r) => ({ id: r.id, name: r.name, host: r.members.find((m) => m.host)?.name ?? null, members: r.members.map((m) => ({ name: m.name, kind: m.kind })) })),
            read: (id, part) => rooms.read(id, { ...part, ...(part.last ? { last: Number(part.last) } : {}), seen: false }),
            say: (id, text, how) => rooms.say(id, text, how),
        },
        boxes: { list: () => boxes.all().map((b) => ({ id: b.id, name: b.name, online: b.online, volume: b.volume, heardAt: b.heardAt, where: { kind: 'conversation', name: 'Hugo' } })), say: (id, text, by) => boxes.announce(id, text, by) } };
    return { dir, grants, keys, rooms, boxes, house, office, kitchen, garden, socket, toAi, spoken, opts };
}

test('rights: a room and a box are given to an API key only, at their own levels; never "x", never to a device', () => {
    const grants = new Grants(new MemoryStore());
    const key = apiKeySubject('11111111-2222-4333-8444-555555555555');
    const room = 'room:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; const box = 'box:aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
    assert.equal(grants.give(key, room, 'r'), 'r'); assert.equal(grants.give(key, room, 'w'), 'rw');
    assert.equal(grants.give(key, box, 'r'), 'r'); assert.equal(grants.give(key, box, 'rw'), 'rw');
    for (const asset of [room, box]) {
        assert.throws(() => grants.give(key, asset, 'x'), /rights/, asset);
        assert.throws(() => grants.give(pairingSubject('11111111-2222-4333-8444-666666666666'), asset, 'r'), /API key only/, asset);
        assert.throws(() => grants.give('conversation:alpha', asset, 'r'), /API key only/, asset);
    }
    for (const asset of ['room:all', 'room:*', 'box:kitchen', 'room:', 'box:../x']) assert.throws(() => grants.give(key, asset, 'r'), /Not an asset/, asset);
});

test('rooms and boxes are given one by one, Off first; never "all"; one that is not there, never; removed takes its lines', (t) => {
    const { keys, grants, rooms, boxes, house, office, kitchen, garden } = home(t);
    const bare = keys.create({ label: 'Nothing yet' });
    assert.deepEqual([bare.key.rooms, bare.key.boxes], [[], []], 'nothing until chosen');
    const { key } = keys.create({ label: 'Home automation', rooms: { [house.id]: 'talk', [office.id]: 'read' }, boxes: { [kitchen.id]: 'speak', [garden.id]: 'state' } });
    assert.deepEqual(key.rooms, [{ id: house.id, level: 'talk' }, { id: office.id, level: 'read' }].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(key.boxes, [{ id: kitchen.id, level: 'speak' }, { id: garden.id, level: 'state' }].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(grants.rightsOf(apiKeySubject(key.id), `room:${house.id}`), 'rw');
    assert.equal(grants.rightsOf(apiKeySubject(key.id), `box:${garden.id}`), 'r');
    for (const [rs, bs] of [[{ '*': 'read' }, {}], [{ all: 'read' }, {}], [{ [house.id]: 'speak' }, {}], [{}, { [kitchen.id]: 'talk' }], [{}, { [kitchen.id]: 'listen' }],
        [{ 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': 'read' }, {}], [[house.id], {}], [{}, [kitchen.id]]]) {
        assert.ok([400, 404].includes(statusOfError(() => keys.create({ label: `Bad ${Math.random()}`.slice(0, 30), rooms: rs, boxes: bs }))), JSON.stringify([rs, bs]));
    }
    assert.equal(keys.list().length, 2, 'a refused key is not made');
    assert.deepEqual(keys.setRoom(key.id, office.id, 'talk').rooms.find((r) => r.id === office.id).level, 'talk');
    assert.equal(keys.setRoom(key.id, office.id, null).rooms.length, 1);
    assert.equal(keys.setBox(key.id, garden.id, 'speak').boxes.find((b) => b.id === garden.id).level, 'speak');
    assert.equal(statusOfError(() => keys.setBox(key.id, garden.id, 'read')), 400);
    assert.equal(statusOfError(() => keys.setRoom(key.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'read')), 404);
    /* A room removed, a box withdrawn: its lines go with it. */
    rooms.remove(house.id);
    boxes.revoke(garden.id);
    assert.deepEqual(keys.get(key.id).rooms, []);
    assert.deepEqual(keys.get(key.id).boxes, [{ id: kitchen.id, level: 'speak' }]);
    assert.deepEqual(grants.of(apiKeySubject(key.id)).map((g) => g.asset), [`box:${kitchen.id}`]);
});

test('the door, rooms: none given -> 403; read-only cannot talk; another room -> 403; posted as the person does, signed with the key, secrets masked; revoked -> 401', async (t) => {
    const { keys, house, office, toAi, opts } = home(t);
    const none = keys.create({ label: 'Nothing' });
    const reader = keys.create({ label: 'Reader', rooms: { [house.id]: 'read' } });
    const talker = keys.create({ label: 'Home automation', rooms: { [house.id]: 'talk' } });
    const messages = (id = house.id) => `/api/ext/v1/rooms/${id}/messages`;

    assert.deepEqual((await call(opts, { path: '/api/ext/v1/rooms', secret: none.secret })).body, { rooms: [] });
    for (const id of [house.id, office.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '..%2Fetc']) assert.equal((await call(opts, { path: messages(id), secret: none.secret })).status, 403, id);
    assert.equal((await call(opts, { method: 'POST', path: messages(), secret: none.secret, body: { text: 'hi' } })).status, 403);

    const listed = (await call(opts, { path: '/api/ext/v1/rooms', secret: reader.secret })).body.rooms;
    assert.deepEqual(listed.map((r) => [r.id, r.name, r.level, r.host]), [[house.id, 'La maison', 'read', 'Hugo']]);
    assert.deepEqual(listed[0].members.map((m) => m.name), ['Toi', 'Hugo', 'Compta'], 'by names');
    const refused = await call(opts, { method: 'POST', path: messages(), secret: reader.secret, body: { text: 'hi' } });
    assert.equal(refused.status, 403); assert.match(refused.body.error, /read this room, not talk/);
    assert.equal(toAi.length, 0, 'nothing said');

    /* Talk: as the person posts in a room -- to its host, or to the AIs named -- signed with the key's name and look. */
    const posted = await call(opts, { method: 'POST', path: messages(), secret: talker.secret, body: { text: `The heating is on, ${SECRET_LIKE}` } });
    assert.equal(posted.status, 201);
    assert.equal(toAi.at(-1).name, 'hugo', 'to the host');
    assert.deepEqual(toAi.at(-1).extra.by, { id: `apikey:${talker.key.id}`, name: 'Home automation', kind: 'ai', look: toAi.at(-1).extra.by.look });
    assert.ok(Number.isInteger(toAi.at(-1).extra.by.look.hue), 'its look');
    const named = await call(opts, { method: 'POST', path: messages(), secret: talker.secret, body: { text: 'For the books', to: ['compta'] } });
    assert.equal(named.status, 201); assert.equal(toAi.at(-1).name, 'compta', 'to the AI named, by its name');
    for (const body of [{}, { text: '' }, { text: 7 }, { text: 'x'.repeat(8001) }, { text: 'hi', to: ['nobody'] }, { text: 'hi', to: 'compta' }, { text: 'hi', to: [7] }]) {
        assert.equal((await call(opts, { method: 'POST', path: messages(), secret: talker.secret, body })).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal((await call(opts, { method: 'POST', path: messages(office.id), secret: talker.secret, body: { text: 'hi' } })).status, 403, 'another room');

    /* Read: names, never ids; the secret masked; never marked seen for the owner. */
    const read = await call(opts, { path: `${messages()}?last=10`, secret: reader.secret });
    assert.equal(read.status, 200);
    const mine = read.body.messages.find((m) => m.text.startsWith('The heating'));
    assert.equal(mine.by, 'Home automation'); assert.equal(mine.from, 'person');
    assert.ok(!mine.text.includes(SECRET_LIKE) && mine.text.includes('••••••'), mine.text);
    assert.equal(JSON.stringify(read.body).includes(SECRET_LIKE), false);
    for (const m of read.body.messages) assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify({ ...m, id: '' })), false, 'no member id');
    assert.equal(toAi.find((x) => x.text.startsWith('The heating')).text.includes(SECRET_LIKE), true, 'the AI it goes to gets it, as from the page (its chat lifts it)');
    for (const q of ['last=0', 'last=201', 'since=%3Cx%3E']) assert.equal((await call(opts, { path: `${messages()}?${q}`, secret: reader.secret })).status, 400, q);
    assert.equal((await call(opts, { method: 'DELETE', path: messages(), secret: talker.secret })).status, 405);

    keys.revoke(talker.key.id);
    assert.equal((await call(opts, { method: 'POST', path: messages(), secret: talker.secret, body: { text: 'hi' } })).status, 401);
    assert.equal((await call(opts, { path: '/api/ext/v1/rooms', secret: talker.secret })).status, 401);
});

test('a room thread as a key reads it: names only, masked, no member ids, no paths', () => {
    const t = roomThreadOf({ cursor: 'c', messages: [
        { from: 'agent', id: 'a', at: 't', kind: 'show', text: `Here ${SECRET_LIKE}`, path: '/work/report.html', open: 'ai:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:work:report.html', by: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Hugo', kind: 'ai' },
            to: ['aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff'], toNames: ['Compta', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000'], toYou: true },
        { from: 'system', text: 'x' },
    ] });
    assert.deepEqual(t, { cursor: 'c', messages: [{ id: 'a', at: 't', from: 'agent', kind: 'show', text: 'Here ••••••', by: 'Hugo', to: ['Compta'], toPerson: true, files: ['report.html'] }] });
});

test('the door, voice boxes: none -> 403; state cannot speak; another box -> 403; length cap, rate limit; said aloud, never listened after; revoked -> 401', async (t) => {
    const { keys, kitchen, garden, socket, spoken, opts } = home(t);
    const none = keys.create({ label: 'Nothing' });
    const watcher = keys.create({ label: 'Watcher', boxes: { [kitchen.id]: 'state' } });
    const speaker = keys.create({ label: 'Doorbell', boxes: { [kitchen.id]: 'speak' } });
    const say = (secret, id = kitchen.id, body = { text: 'Someone is at the door.' }) => call(opts, { method: 'POST', path: `/api/ext/v1/boxes/${id}/say`, secret, body });

    assert.deepEqual((await call(opts, { path: '/api/ext/v1/boxes', secret: none.secret })).body, { boxes: [] });
    for (const id of [kitchen.id, garden.id, 'nope']) assert.equal((await say(none.secret, id)).status, 403, id);
    const seen = (await call(opts, { path: '/api/ext/v1/boxes', secret: watcher.secret })).body.boxes;
    assert.deepEqual(seen, [{ id: kitchen.id, name: 'Cuisine', level: 'state', online: true, where: { kind: 'conversation', name: 'Hugo' }, heardAt: null, volume: 80 }], 'its state: nothing it heard');
    const refused = await say(watcher.secret);
    assert.equal(refused.status, 403); assert.match(refused.body.error, /not make it speak/);
    assert.equal(spoken.length, 0);

    const before = socket.sent.length;
    const ok = await say(speaker.secret);
    assert.equal(ok.status, 200); assert.equal(ok.body.ok, true);
    assert.deepEqual(spoken, ['Someone is at the door.']);
    const played = socket.sent.slice(before).filter((m) => m.t);
    assert.deepEqual(played.map((m) => m.t), ['speak.start', 'speak.end']);
    assert.equal(played.at(-1).then, undefined, 'never listens after');
    assert.equal((await say(speaker.secret, garden.id)).status, 403, 'another box');
    for (const body of [{}, { text: '' }, { text: 7 }, { text: 'x'.repeat(SPEAK_MAX + 1) }]) assert.equal((await say(speaker.secret, kitchen.id, body)).status, 400, JSON.stringify(body).slice(0, 30));
    /* SPEAK_PER_MIN a minute, the first included; refused sentences are not counted. */
    for (let i = 1; i < SPEAK_PER_MIN; i += 1) assert.equal((await say(speaker.secret)).status, 200);
    assert.equal((await say(speaker.secret)).status, 429);
    assert.equal(spoken.length, SPEAK_PER_MIN);

    keys.revoke(speaker.key.id);
    assert.equal((await say(speaker.secret)).status, 401);
    assert.equal((await call(opts, { path: '/api/ext/v1/boxes', secret: speaker.secret })).status, 401);
});

test('a box offline is not spoken to (409); nothing of its settings is reachable by a key', async (t) => {
    const { keys, garden, opts } = home(t);
    const speaker = keys.create({ label: 'Doorbell', boxes: { [garden.id]: 'speak' } });
    const offline = await call(opts, { method: 'POST', path: `/api/ext/v1/boxes/${garden.id}/say`, secret: speaker.secret, body: { text: 'Hello' } });
    assert.equal(offline.status, 409);
    for (const path of [`/api/ext/v1/boxes/${garden.id}/volume`, `/api/ext/v1/boxes/${garden.id}/listen`, `/api/ext/v1/boxes/${garden.id}/update`, `/api/ext/v1/boxes/${garden.id}`]) {
        assert.equal((await call(opts, { method: 'POST', path, secret: speaker.secret, body: { level: 10 } })).status, 404, path);
    }
});

test('MCP: the tools listed; rooms and boxes refused as the API refuses them; journaled with what they were on', async (t) => {
    const { keys, house, office, kitchen, garden, toAi, spoken, opts } = home(t);
    const key = keys.create({ label: 'Steering', rooms: { [house.id]: 'read' }, boxes: { [kitchen.id]: 'speak', [garden.id]: 'state' } });
    const mcp = (body) => call(opts, { method: 'POST', path: '/api/ext/mcp', secret: key.secret, body: { jsonrpc: '2.0', id: 1, ...body } });
    const tool = (name, args) => mcp({ method: 'tools/call', params: { name, arguments: args } });
    const listed = (await mcp({ method: 'tools/list' })).body.result.tools.map((x) => x.name);
    assert.deepEqual(listed, TOOLS.map((x) => x.name));
    for (const n of ['clavarium_rooms', 'clavarium_room_read', 'clavarium_room_say', 'clavarium_boxes', 'clavarium_box_say']) assert.ok(listed.includes(n), n);
    assert.deepEqual((await tool('clavarium_rooms', {})).body.result.structuredContent.rooms.map((r) => r.name), ['La maison']);
    assert.equal((await tool('clavarium_room_read', { room: house.id, last: 5 })).status, 200);
    assert.equal((await tool('clavarium_room_say', { room: house.id, text: 'hi' })).status, 403, 'read-only cannot talk');
    assert.equal((await tool('clavarium_room_read', { room: office.id })).status, 403, 'another room');
    assert.equal((await tool('clavarium_room_read', {})).body.error.code, -32602);
    assert.deepEqual((await tool('clavarium_boxes', {})).body.result.structuredContent.boxes.map((b) => b.level).sort(), ['speak', 'state']);
    assert.equal((await tool('clavarium_box_say', { box: garden.id, text: 'hi' })).status, 403, 'state cannot speak');
    const said = await tool('clavarium_box_say', { box: kitchen.id, text: 'Dinner is ready.' });
    assert.equal(said.status, 200); assert.equal(said.body.result.isError, false);
    assert.equal((await tool('clavarium_box_say', { box: kitchen.id, text: 'x'.repeat(SPEAK_MAX + 1) })).body.result.isError, true, 'too long: the tool\'s own failure');
    for (let i = 1; i < SPEAK_PER_MIN; i += 1) await tool('clavarium_box_say', { box: kitchen.id, text: 'Again.' });
    assert.equal((await tool('clavarium_box_say', { box: kitchen.id, text: 'Once more.' })).status, 429);
    assert.equal(toAi.length, 0); assert.equal(spoken.length, SPEAK_PER_MIN);
    const journal = keys.journal(key.key.id).map((u) => [u.route, u.status]);
    assert.deepEqual(journal.slice(0, 2), [[`/mcp tools/call clavarium_box_say ${kitchen.id}`, 429], [`/mcp tools/call clavarium_box_say ${kitchen.id}`, 201]]);
    assert.ok(journal.some(([r, s]) => r === `/mcp tools/call clavarium_room_say ${house.id}` && s === 403));
    assert.ok(journal.some(([r, s]) => r === `/mcp tools/call clavarium_box_say ${garden.id}` && s === 403));
});

test('every room and box call is journaled for its key: the route, the answer -- never what was said', async (t) => {
    const { dir, keys, house, kitchen, opts } = home(t);
    const key = keys.create({ label: 'Doorbell', rooms: { [house.id]: 'talk' }, boxes: { [kitchen.id]: 'speak' } });
    await call(opts, { path: '/api/ext/v1/rooms', secret: key.secret });
    await call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${house.id}/messages`, secret: key.secret, body: { text: 'Private words here' } });
    await call(opts, { path: '/api/ext/v1/boxes', secret: key.secret });
    await call(opts, { method: 'POST', path: `/api/ext/v1/boxes/${kitchen.id}/say`, secret: key.secret, body: { text: 'Spoken words here' } });
    assert.deepEqual(keys.journal(key.key.id).map((u) => [u.method, u.route, u.status]), [
        ['POST', `/v1/boxes/${kitchen.id}/say`, 200],
        ['GET', '/v1/boxes', 200],
        ['POST', `/v1/rooms/${house.id}/messages`, 201],
        ['GET', '/v1/rooms', 200],
    ]);
    const text = readFileSync(join(dir, 'apikeys.log'), 'utf8');
    for (const words of ['Private words', 'Spoken words', key.secret.slice(4, 20)]) assert.equal(text.includes(words), false, words);
});

test('Settings: rooms and boxes given on creation and one by one, each said in What happened', async (t) => {
    const { keys, house, kitchen } = home(t);
    const events = [];
    const ask = async (method, path, body) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        const request = { method, url: path, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'owner@example.com' }, async *[Symbol.asyncIterator]() { if (text) yield text; } };
        const out = { status: 0, text: '' };
        const response = { writeHead(code) { out.status = code; return response; }, end(x) { out.text = x ?? ''; } };
        await handleApiKeys(request, response, keys, () => true, {}, { add: (e) => events.push(e) });
        return { status: out.status, body: out.text ? JSON.parse(out.text) : null };
    };
    const made = await ask('POST', '/api/apikeys', { label: 'Doorbell', rooms: { [house.id]: 'read' }, boxes: { [kitchen.id]: 'speak' } });
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.key.rooms, made.body.key.boxes], [[{ id: house.id, level: 'read' }], [{ id: kitchen.id, level: 'speak' }]]);
    const id = made.body.key.id;
    assert.equal((await ask('POST', `/api/apikeys/${id}/rooms`, { room: house.id, level: 'talk' })).body.key.rooms[0].level, 'talk');
    assert.deepEqual((await ask('POST', `/api/apikeys/${id}/boxes`, { box: kitchen.id, level: null })).body.key.boxes, []);
    assert.equal((await ask('POST', `/api/apikeys/${id}/boxes`, { box: kitchen.id, level: 'talk' })).status, 400);
    assert.equal((await ask('POST', `/api/apikeys/${id}/rooms`, { room: 'nope', level: 'read' })).status, 404);
    assert.equal(events.length, 3);
    assert.match(events[0].text, /room .* read.*voice box .* speak/);
    assert.match(events[2].text, /voice box .* taken back/);
});
