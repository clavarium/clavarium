import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeys, handleExternal, handleApiKeys, TOOLS } from '../server/apikeys.mjs';
import { Grants, MemoryStore, apiKeySubject, pairingSubject } from '../server/grants.mjs';
import { Rooms } from '../server/rooms.mjs';
import { Boxes } from '../server/boxes.mjs';
import { Store, JsonFile } from '../server/store.mjs';

/* API keys that ACT and MANAGE (07-11): a conversation given at "act" is woken, put to sleep, its turn stopped; a
   room given at "manage" is renamed, its members and host changed, removed; "create rooms" makes a room, given to
   the key at "manage". The key's rights are the security: no approval card -- and three limits, always. */
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'clv-apikeys-am-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const statusOfError = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.status; } };

class MemoryFile { #v; constructor(v) { this.#v = v; } get() { return structuredClone(this.#v); } set(v) { this.#v = structuredClone(v); } }

async function call(opts, { method = 'GET', path, secret, body, headers = {} }) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const request = { method, url: path, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        async *[Symbol.asyncIterator]() { if (text) yield text; } };
    const out = { status: 0, text: '' };
    const response = { writeHead(code) { out.status = code; return response; }, end(x) { out.text = x ?? ''; } };
    await handleExternal(request, response, opts);
    return { status: out.status, body: out.text ? JSON.parse(out.text) : null };
}

/* Three conversations (hugo, compta, zed), two voice boxes, real rooms behind the door; the owner's calls faked. */
function home(t) {
    const dir = folder(t);
    const grants = new Grants(new MemoryStore());
    const acts = []; const events = [];
    const convs = [{ name: 'hugo', chatName: 'Hugo' }, { name: 'compta', title: 'Compta' }, { name: 'zed', title: 'Zed' }];
    let boxes;
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async () => {},
        conversations: () => convs, boxes: () => boxes.all(), removed: (id) => grants.forgetAsset(`room:${id}`) });
    boxes = new Boxes({ file: new MemoryFile([]), exists: (c) => c === 'hugo', hear: async () => '', say: async () => {}, speak: async () => Buffer.alloc(64, 1),
        removed: (id) => grants.forgetAsset(`box:${id}`) });
    const kitchen = boxes.pair({ code: boxes.code('hugo', 'Cuisine').code });
    const garden = boxes.pair({ code: boxes.code('hugo', 'Jardin').code });
    const house = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'] });
    const office = rooms.create({ name: 'Bureau', conversations: ['zed'] });
    const keys = new ApiKeys({ store: new Store(join(dir, 'apikeys.json')), grants, journal: join(dir, 'apikeys.log'), exists: (n) => convs.some((c) => c.name === n),
        roomExists: (id) => rooms.has(id), boxExists: (id) => boxes.all().some((b) => b.id === id) });
    const opts = { keys, status: async () => ({}), events: { add: (e) => events.push(e) },
        chats: { list: () => convs.map((c) => ({ id: c.name, name: c.title ?? c.name })), chatOn: () => true, read: () => ({ on: true, messages: [] }), say: async () => ({}),
            wake: (name) => { acts.push(['wake', name]); return { state: 'waking' }; },
            sleep: async (name) => { acts.push(['sleep', name]); return { state: 'asleep' }; },
            stop: async (name) => { acts.push(['stop', name]); return { state: 'awake' }; } },
        rooms: {
            list: () => rooms.list().map((r) => ({ id: r.id, name: r.name, host: r.members.find((m) => m.host)?.name ?? null, members: r.members.map((m) => ({ id: m.id, ref: m.ref, name: m.name, kind: m.kind, ...(m.host ? { host: true } : {}) })) })),
            read: (id, part) => rooms.read(id, { ...part, ...(part.last ? { last: Number(part.last) } : {}), seen: false }),
            say: (id, text, how) => rooms.say(id, text, how),
            create: (asked) => rooms.create(asked), change: (id, asked) => rooms.change(id, asked), remove: (id) => rooms.remove(id),
        },
        boxes: { list: () => boxes.all().map((b) => ({ id: b.id, name: b.name, online: b.online, volume: b.volume, heardAt: b.heardAt, where: null })), say: async () => ({}) } };
    const mcp = (secret, name, args) => call(opts, { method: 'POST', path: '/api/ext/mcp', secret, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    /* Every line of the table of rights, to see nothing else changed. */
    const table = () => keys.list().map((k) => ({ id: k.id, lines: grants.of(apiKeySubject(k.id)).map((g) => `${g.asset} ${g.rights}`).sort() }));
    return { dir, grants, keys, rooms, boxes, house, office, kitchen, garden, acts, events, opts, mcp, table };
}

test('a conversation at "act": Talk, and woken, put to sleep, its turn stopped; given one by one, never to a device', (t) => {
    const { keys, grants } = home(t);
    const { key } = keys.create({ label: 'Steering', conversations: { hugo: 'act', compta: 'talk' } });
    assert.deepEqual(key.conversations, [{ name: 'compta', level: 'talk' }, { name: 'hugo', level: 'act' }]);
    assert.equal(grants.rightsOf(apiKeySubject(key.id), 'conversation:hugo'), 'rwm');
    assert.equal(keys.setConversation(key.id, 'compta', 'act').conversations.find((c) => c.name === 'compta').level, 'act');
    assert.equal(keys.setConversation(key.id, 'compta', 'read').conversations.find((c) => c.name === 'compta').level, 'read');
    assert.equal(statusOfError(() => keys.setConversation(key.id, 'compta', 'manage')), 400);
    assert.throws(() => grants.give(pairingSubject('11111111-2222-4333-8444-666666666666'), 'conversation:hugo', 'm'), /API key only/);
    for (const level of ['read', 'talk', 'act']) assert.equal(keys.mayConversation(key.id, 'hugo', level), 'act', level);
    assert.equal(statusOfError(() => keys.mayConversation(key.id, 'compta', 'act')), 403);
});

test('the door, act: wake (202), sleep, stop at "act"; 403 below it, for another, or one not there; each said with the key\'s name, journaled', async (t) => {
    const { keys, acts, events, opts, mcp } = home(t);
    const none = keys.create({ label: 'Nothing' });
    const reader = keys.create({ label: 'Reader', conversations: { hugo: 'read' } });
    const talker = keys.create({ label: 'Talker', conversations: { hugo: 'talk' } });
    const actor = keys.create({ label: 'Steering', conversations: { hugo: 'act' } });
    const act = (secret, name, what) => call(opts, { method: 'POST', path: `/api/ext/v1/conversations/${name}/${what}`, secret });

    for (const what of ['wake', 'sleep', 'stop']) {
        for (const k of [none, reader, talker]) assert.equal((await act(k.secret, 'hugo', what)).status, 403, `${k.key.label} ${what}`);
        for (const name of ['compta', 'nobody', '..%2Fetc']) assert.equal((await act(actor.secret, name, what)).status, 403, `${name} ${what}`);
        assert.equal((await call(opts, { path: `/api/ext/v1/conversations/hugo/${what}`, secret: actor.secret })).status, 405, 'POST only');
    }
    assert.match((await act(talker.secret, 'hugo', 'stop')).body.error, /not act/);
    assert.deepEqual(acts, [], 'nothing done below "act"');

    assert.deepEqual(await act(actor.secret, 'hugo', 'wake'), { status: 202, body: { ok: true, state: 'waking' } });
    assert.deepEqual(await act(actor.secret, 'hugo', 'sleep'), { status: 200, body: { ok: true, state: 'asleep' } });
    assert.deepEqual(await act(actor.secret, 'hugo', 'stop'), { status: 200, body: { ok: true, state: 'awake' } });
    assert.deepEqual(acts, [['wake', 'hugo'], ['sleep', 'hugo'], ['stop', 'hugo']]);
    assert.equal((await call(opts, { path: '/api/ext/v1/conversations', secret: actor.secret })).body.conversations[0].level, 'act');

    /* MCP: the same rights, the same calls. */
    assert.equal((await mcp(talker.secret, 'clavarium_conversation_sleep', { conversation: 'hugo' })).status, 403);
    assert.equal((await mcp(actor.secret, 'clavarium_conversation_stop', { conversation: 'compta' })).status, 403);
    assert.equal((await mcp(actor.secret, 'clavarium_conversation_wake', {})).body.error.code, -32602);
    for (const [tool, state] of [['clavarium_conversation_wake', 'waking'], ['clavarium_conversation_sleep', 'asleep'], ['clavarium_conversation_stop', 'awake']]) {
        const r = await mcp(actor.secret, tool, { conversation: 'hugo' });
        assert.equal(r.status, 200, tool); assert.deepEqual(r.body.result.structuredContent, { ok: true, state }, tool);
    }
    assert.equal(acts.length, 6);

    /* What happened: each act, with the key's name. */
    assert.deepEqual(events.map((e) => [e.kind, e.text, e.conversation, e.who]), [
        ['machine', 'Machine of hugo woken', 'hugo', 'API key "Steering"'],
        ['machine', 'Machine of hugo put to sleep', 'hugo', 'API key "Steering"'],
        ['conversation', 'hugo: its turn stopped', 'hugo', 'API key "Steering"'],
        ['machine', 'Machine of hugo woken', 'hugo', 'API key "Steering"'],
        ['machine', 'Machine of hugo put to sleep', 'hugo', 'API key "Steering"'],
        ['conversation', 'hugo: its turn stopped', 'hugo', 'API key "Steering"'],
    ]);
    /* Its journal, as for the other calls. */
    const journal = keys.journal(actor.key.id).map((u) => [u.method, u.route, u.status]);
    assert.ok(journal.some(([m, r, s]) => m === 'POST' && r === '/v1/conversations/hugo/wake' && s === 202));
    assert.ok(journal.some(([, r, s]) => r === '/v1/conversations/compta/sleep' && s === 403));
    assert.ok(journal.some(([, r, s]) => r === '/mcp tools/call clavarium_conversation_stop hugo' && s === 201));
    assert.ok(keys.journal(talker.key.id).some((u) => u.route === '/v1/conversations/hugo/stop' && u.status === 403));
});

test('a room at "manage": renamed, members added and taken away, its host changed, removed; 403 below it', async (t) => {
    const { keys, house, office, kitchen, events, opts, rooms } = home(t);
    const talker = keys.create({ label: 'Talker', rooms: { [house.id]: 'talk' }, conversations: { zed: 'read' } });
    const manager = keys.create({ label: 'Organiser', rooms: { [house.id]: 'manage', [office.id]: 'read' }, conversations: { hugo: 'read', compta: 'talk', zed: 'read' }, boxes: { [kitchen.id]: 'state' } });
    const change = (secret, id, body) => call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${id}`, secret, body });

    assert.equal((await change(talker.secret, house.id, { name: 'Renamed' })).status, 403, 'talk cannot manage');
    assert.equal((await call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${house.id}/remove`, secret: talker.secret })).status, 403);
    assert.equal((await change(manager.secret, office.id, { name: 'Mine' })).status, 403, 'another room, read only');
    assert.equal((await change(manager.secret, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', { name: 'Ghost' })).status, 403, 'one not there');
    assert.equal(rooms.get(house.id).name, 'La maison', 'nothing changed');

    /* Its listing names the members the key was given by their id: what it may add or take away. */
    const listed = (await call(opts, { path: '/api/ext/v1/rooms', secret: manager.secret })).body.rooms.find((r) => r.id === house.id);
    assert.equal(listed.level, 'manage');
    assert.deepEqual(listed.members.map((m) => [m.name, m.id]), [['Toi', undefined], ['Hugo', 'hugo'], ['Compta', 'compta']]);
    assert.deepEqual((await call(opts, { path: '/api/ext/v1/rooms', secret: talker.secret })).body.rooms[0].members.map((m) => m.id), [undefined, undefined, undefined], 'not given: names only');

    const renamed = await change(manager.secret, house.id, { name: 'Le salon' });
    assert.equal(renamed.status, 200); assert.equal(renamed.body.room.name, 'Le salon');
    const added = await change(manager.secret, house.id, { add: { conversations: ['zed'], boxes: [kitchen.id] }, host: 'zed' });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.room.members.map((m) => m.name), ['Toi', 'Hugo', 'Compta', 'Zed', 'Cuisine']);
    assert.equal(added.body.room.host, 'Zed', 'its host: one added now');
    const taken = await change(manager.secret, house.id, { remove: { conversations: ['hugo'], boxes: [kitchen.id] } });
    assert.deepEqual(taken.body.room.members.map((m) => m.name), ['Toi', 'Compta', 'Zed']);
    assert.equal((await change(manager.secret, house.id, { host: 'compta' })).body.room.host, 'Compta');
    for (const body of [{ host: 'hugo' }, { remove: { conversations: ['hugo'] } }, { add: ['zed'] }, { add: { people: ['x'] } }, { name: '' }, { add: { conversations: 'zed' } }]) {
        assert.equal((await change(manager.secret, house.id, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await change(manager.secret, house.id, 'not json')).status, 400);

    /* Removed: its lines go with it. */
    const removed = await call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${house.id}/remove`, secret: manager.secret });
    assert.deepEqual(removed, { status: 200, body: { ok: true, removed: house.id } });
    assert.equal(rooms.has(house.id), false);
    assert.deepEqual(keys.get(manager.key.id).rooms, [{ id: office.id, level: 'read' }]);
    assert.deepEqual(keys.get(talker.key.id).rooms, []);

    assert.deepEqual(events.map((e) => [e.text, e.who]), [
        ['Room "La maison" changed: renamed "Le salon"', 'API key "Organiser"'],
        ['Room "Le salon" changed: 2 added, host zed', 'API key "Organiser"'],
        ['Room "Le salon" changed: 2 taken away', 'API key "Organiser"'],
        ['Room "Le salon" changed: host compta', 'API key "Organiser"'],
        ['Room "Le salon" removed', 'API key "Organiser"'],
    ]);
    const journal = keys.journal(manager.key.id).map((u) => [u.method, u.route, u.status]);
    assert.deepEqual(journal[0], ['POST', `/v1/rooms/${house.id}/remove`, 200]);
    assert.ok(journal.some(([, r, s]) => r === `/v1/rooms/${office.id}` && s === 403));
});

test('a room\'s members: only conversations and boxes the key was given (any level), else 403 and nothing changes', async (t) => {
    const { keys, house, kitchen, garden, opts, rooms, mcp } = home(t);
    const manager = keys.create({ label: 'Organiser', scopes: ['create-rooms'], rooms: { [house.id]: 'manage' }, conversations: { hugo: 'read' }, boxes: { [kitchen.id]: 'state' } });
    const change = (body) => call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${house.id}`, secret: manager.secret, body });
    const before = JSON.stringify(rooms.get(house.id));
    for (const body of [
        { add: { conversations: ['zed'] } },               /* not given */
        { add: { conversations: ['nobody'] } },            /* not there */
        { add: { boxes: [garden.id] } },                   /* a box not given */
        { remove: { conversations: ['compta'] } },         /* a member, not given to the key */
        { host: 'compta' },                                /* the host: a conversation given too */
        { name: 'Renamed', add: { conversations: ['zed'] } },
    ]) {
        const r = await change(body);
        assert.equal(r.status, 403, JSON.stringify(body)); assert.match(r.body.error, /not given this (conversation|voice box)/);
    }
    assert.equal(JSON.stringify(rooms.get(house.id)), before, 'nothing changed');
    /* Made the same: never with one it was not given; no room is made. */
    const count = rooms.list().length;
    for (const body of [{ name: 'New', conversations: ['zed'] }, { name: 'New', conversations: ['hugo'], boxes: [garden.id] }, { name: 'New', conversations: ['hugo'], host: 'compta' }]) {
        assert.ok([400, 403].includes((await call(opts, { method: 'POST', path: '/api/ext/v1/rooms', secret: manager.secret, body })).status), JSON.stringify(body));
    }
    assert.equal((await mcp(manager.secret, 'clavarium_room_change', { room: house.id, add: { conversations: ['zed'] } })).status, 403);
    assert.equal((await mcp(manager.secret, 'clavarium_room_create', { name: 'New', conversations: ['zed'] })).status, 403);
    assert.equal(rooms.list().length, count, 'no room made');
    /* Given at any level: a box to see its state is enough to add it. */
    assert.equal((await change({ add: { boxes: [kitchen.id] } })).status, 200);
});

test('"create rooms": a room made by a key is given to it at "manage", and nothing else changes; without the scope, 403', async (t) => {
    const { keys, house, kitchen, opts, mcp, rooms, table, events, grants } = home(t);
    const without = keys.create({ label: 'No scope', conversations: { hugo: 'talk' } });
    const maker = keys.create({ label: 'Maker', scopes: ['create-rooms'], conversations: { hugo: 'read', compta: 'act' }, boxes: { [kitchen.id]: 'speak' }, rooms: { [house.id]: 'read' } });
    const other = keys.create({ label: 'Other', scopes: ['status', 'create-rooms'], conversations: { hugo: 'act' }, rooms: { [house.id]: 'manage' } });
    assert.deepEqual(maker.key.scopes, ['create-rooms']);
    assert.deepEqual(grants.of(apiKeySubject(maker.key.id), 'server'), [{ asset: 'server:rooms', type: 'server', name: 'rooms', rights: 'w' }]);
    const make = (secret, body) => call(opts, { method: 'POST', path: '/api/ext/v1/rooms', secret, body });

    const refused = await make(without.secret, { name: 'Kitchen', conversations: ['hugo'] });
    assert.equal(refused.status, 403); assert.match(refused.body.error, /Create rooms/);
    assert.equal(statusOfError(() => keys.madeRoom(without.key.id, house.id)), 403, 'never given a room by itself without the scope');
    assert.equal(rooms.list().length, 2);

    const before = table();
    const made = await make(maker.secret, { name: 'Kitchen', conversations: ['hugo', 'compta'], boxes: [kitchen.id], host: 'compta' });
    assert.equal(made.status, 201);
    const room = made.body.room;
    assert.deepEqual([room.name, room.level, room.host], ['Kitchen', 'manage', 'Compta']);
    assert.deepEqual(room.members.map((m) => [m.name, m.id ?? null]), [['Toi', null], ['Hugo', 'hugo'], ['Compta', 'compta'], ['Cuisine', kitchen.id]]);
    /* The one line added: this room, to this key, at "manage". Every other line of every key as it was. */
    const after = table();
    assert.deepEqual(after.find((k) => k.id === maker.key.id).lines, [...before.find((k) => k.id === maker.key.id).lines, `room:${room.id} rwm`].sort());
    for (const k of after.filter((x) => x.id !== maker.key.id)) assert.deepEqual(k.lines, before.find((x) => x.id === k.id).lines, k.id);
    assert.deepEqual(events.at(-1), { kind: 'conversation', text: 'Room "Kitchen" made', who: 'API key "Maker"' });

    /* Then managed by it, as any room given at "manage". */
    assert.equal((await call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${room.id}`, secret: maker.secret, body: { name: 'Cuisine' } })).status, 200);
    assert.equal((await call(opts, { method: 'POST', path: `/api/ext/v1/rooms/${room.id}`, secret: other.secret, body: { name: 'Taken' } })).status, 403, 'not the other key\'s');
    /* MCP: the same. */
    const viaMcp = await mcp(maker.secret, 'clavarium_room_create', { name: 'Hall', conversations: ['hugo'] });
    assert.equal(viaMcp.status, 200); assert.equal(viaMcp.body.result.structuredContent.room.level, 'manage');
    const hall = viaMcp.body.result.structuredContent.room.id;
    assert.equal((await mcp(maker.secret, 'clavarium_room_change', { room: hall, name: 'Entrée' })).body.result.structuredContent.room.name, 'Entrée');
    assert.equal((await mcp(without.secret, 'clavarium_room_create', { name: 'Nope', conversations: ['hugo'] })).status, 403);
    assert.equal((await mcp(maker.secret, 'clavarium_room_remove', { room: hall })).status, 200);
    assert.equal(rooms.has(hall), false);
    assert.equal((await mcp(maker.secret, 'clavarium_room_remove', { room: house.id })).status, 403, 'a room it may only read');
    assert.equal((await make(maker.secret, { name: 'Cuisine', conversations: ['hugo'] })).status, 409, 'rooms.mjs\' own refusals pass through (a name taken)');
});

test('the three limits, through every new path: a key never reads a secret, never makes a key or an account, never changes any key\'s rights', async (t) => {
    const { keys, house, opts, mcp, table } = home(t);
    const strong = keys.create({ label: 'Strong', scopes: ['status', 'create-rooms'], conversations: { hugo: 'act', compta: 'act', zed: 'act' }, rooms: { [house.id]: 'manage' } });
    const weak = keys.create({ label: 'Weak', conversations: { hugo: 'read' } });
    const before = table();
    const count = keys.list().length;
    const post = (path, body) => call(opts, { method: 'POST', path, secret: strong.secret, body });

    /* No route makes a key or an account, gives a right, or reads a secret. */
    for (const path of ['/api/ext/v1/apikeys', `/api/ext/v1/apikeys/${weak.key.id}/conversations`, `/api/ext/v1/apikeys/${strong.key.id}/rooms`, '/api/ext/v1/operators', '/api/ext/v1/accounts',
        '/api/ext/v1/secrets', '/api/ext/v1/secrets/MODEL_KEY', '/api/ext/v1/conversations/hugo/secrets', '/api/ext/v1/conversations/hugo/level', '/api/ext/v1/conversations/hugo/share',
        `/api/ext/v1/rooms/${house.id}/level`, `/api/ext/v1/rooms/${house.id}/rights`, `/api/ext/v1/rooms/${house.id}/keys`, '/api/ext/v1/scopes']) {
        assert.equal((await post(path, { level: 'manage', label: 'Mine', scopes: ['status'] })).status, 404, path);
    }
    /* A body that names a right, a level, a key, a scope: refused, whole -- nothing of it done. */
    for (const body of [{ level: 'manage' }, { name: 'X', rights: 'rwm' }, { keys: { [weak.key.id]: 'manage' } }, { name: 'X', scopes: ['create-rooms'] }, { name: 'X', apikey: weak.key.id }]) {
        assert.equal((await post(`/api/ext/v1/rooms/${house.id}`, body)).status, 400, JSON.stringify(body));
        assert.equal((await post('/api/ext/v1/rooms', { conversations: ['hugo'], ...body, name: 'Made' })).status, 400, JSON.stringify(body));
    }
    for (const what of ['wake', 'sleep', 'stop']) assert.equal((await post(`/api/ext/v1/conversations/hugo/${what}`, { level: 'act', key: weak.key.id })).status < 300, true, 'acts take no body: nothing of it is read');
    for (const [tool, args] of [['clavarium_room_change', { room: house.id, level: 'read' }], ['clavarium_room_create', { name: 'Y', conversations: ['hugo'], rights: 'rwm' }]]) {
        const r = await mcp(strong.secret, tool, args);
        assert.equal(r.body.result?.isError, true, tool);
    }
    assert.equal((await mcp(strong.secret, 'clavarium_apikeys_create', { label: 'x' })).body.error.code, -32602, 'no such tool');
    assert.deepEqual(TOOLS.map((x) => x.name).filter((n) => /key|secret|account|operator|right|grant|scope/.test(n)), [], 'no tool for any of them');
    /* Nothing changed: the same keys, every line of rights as it was. */
    assert.equal(keys.list().length, count);
    assert.deepEqual(table(), before);
    /* And a key never reaches the page's own door for keys: that one is for whoever passed the gate, from this site. */
    const out = { status: 0 };
    const response = { writeHead(code) { out.status = code; return response; }, end() {} };
    const request = { method: 'POST', url: `/api/apikeys/${weak.key.id}/conversations`, headers: { authorization: `Bearer ${strong.secret}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ conversation: 'hugo', level: 'act' }); } };
    await handleApiKeys(request, response, keys, () => false);
    assert.equal(out.status, 403, 'not from this site');
    assert.deepEqual(table(), before);
});

test('Settings: a key given "act", "manage" and "create rooms" from the page, said in What happened', async (t) => {
    const { keys, house } = home(t);
    const events = [];
    const ask = async (path, body) => {
        const request = { method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'owner@example.com' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
        const out = { status: 0, text: '' };
        const response = { writeHead(code) { out.status = code; return response; }, end(x) { out.text = x ?? ''; } };
        await handleApiKeys(request, response, keys, () => true, {}, { add: (e) => events.push(e) });
        return { status: out.status, body: out.text ? JSON.parse(out.text) : null };
    };
    const made = await ask('/api/apikeys', { label: 'Organiser', scopes: ['create-rooms'], conversations: { hugo: 'act' }, rooms: { [house.id]: 'manage' } });
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.key.scopes, made.body.key.conversations, made.body.key.rooms], [['create-rooms'], [{ name: 'hugo', level: 'act' }], [{ id: house.id, level: 'manage' }]]);
    assert.match(events[0].text, /create-rooms, hugo act, room .* manage/);
    assert.equal((await ask(`/api/apikeys/${made.body.key.id}/rooms`, { room: house.id, level: 'talk' })).body.key.rooms[0].level, 'talk');
    assert.equal((await ask(`/api/apikeys/${made.body.key.id}/conversations`, { conversation: 'hugo', level: 'manage' })).status, 400, 'manage is a room\'s');
    assert.ok(keys.scopes().some((s) => s.id === 'create-rooms' && s.label === 'Create rooms'));
});
