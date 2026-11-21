/* GIVE AN ASSET TO EVERY AI OF A ROOM (06-11), through the API: POST /api/rooms/<id>/give. There is no room asset:
   each AI of the room gets the ordinary right of its own conversation, taken back one by one; a box gets nothing;
   an AI taken out of the room gets nothing; a secret goes to conversations only, and one the server holds is
   refused; the rights are those a single conversation could be given. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../server/api.mjs';
import { Rooms } from '../server/rooms.mjs';
import { JsonFile } from '../server/store.mjs';
import { Grants, conversationSubject } from '../server/grants.mjs';
import { Refusal } from '../server/conversations.mjs';

/* The API's arguments by name, the rest undefined. */
const PARAMS = /^async function handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.trim().split('=')[0].trim());
async function post(path, body, given) {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: { 'content-type': 'application/json' } });
    let status; let text = '';
    const response = { writeHead: (s) => { status = s; return { end: (t) => { text = t; } }; } };
    await handleApi(...PARAMS.map((n) => (n === 'request' ? request : n === 'response' ? response : n === 'originOk' ? () => true : n === 'headers' ? {} : given[n])));
    return { status, body: JSON.parse(text) };
}

function world(t, { phases = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'api-roomgive-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const list = ['hugo', 'compta', 'devoirs'].map((name) => ({ name, phase: phases[name] ?? 'ready' }));
    const conversations = { list: () => list };
    const grants = new Grants();
    /* As resources.mjs and secrets.mjs keep them: one line of the grants table per conversation and asset. */
    const store = [{ name: 'photos', type: 'folder' }, { name: 'site', type: 'git' }, { name: 'news', type: 'mailbox' }];
    const assetOf = (r) => `${r.type}:${r.name}`;
    const resources = {
        list: () => store.map((r) => ({ ...r })), assetOf,
        of: (c) => store.map((r) => ({ name: r.name, rights: grants.rightsOf(conversationSubject(c), assetOf(r)) })).filter((r) => r.rights).map((r) => ({ name: r.name, access: r.rights.includes('w') ? 'write' : 'read' })),
        attach: async (c, name, access) => {
            const r = store.find((x) => x.name === name);
            if (r.type === 'mailbox' && access === 'write') throw new Refusal(400, 'A mailbox is read-only.');
            grants.take(conversationSubject(c), assetOf(r));
            if (access !== 'none') grants.give(conversationSubject(c), assetOf(r), access === 'write' ? 'rw' : 'r');
        },
    };
    const vault = [{ name: 'MODEL_KEY' }, { name: 'ACCOUNT_TOKEN', hostOnly: true }];
    const delivered = [];
    const secrets = {
        list: () => vault.map((s) => ({ name: s.name, conversations: grants.on(`secret:${s.name}`).map((g) => g.subject) })),
        attach: (c, name, attached) => {
            if (attached && vault.find((s) => s.name === name)?.hostOnly) throw new Refusal(403, 'This secret is held by the server.');
            if (attached) grants.give(conversationSubject(c), `secret:${name}`, 'x'); else grants.take(conversationSubject(c), `secret:${name}`);
        },
        deliver: async (c) => { delivered.push(c); },
    };
    const boxes = [{ id: 'b1', name: 'Kitchen box' }];
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async () => {}, conversations: () => list, boxes: () => boxes });
    const room = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'], boxes: ['b1'] });
    return { rooms, room, grants, delivered, list, given: { conversations, resources, secrets, rooms } };
}

test('each AI of the room gets its own right on the asset; the box and the others nothing; taken back one by one', async (t) => {
    const { room, grants, given } = world(t);
    const r = await post(`/api/rooms/${room.id}/give`, { asset: 'folder:photos', rights: 'r' }, given);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.given, [{ conversation: 'hugo', ok: true }, { conversation: 'compta', ok: true }]);
    assert.deepEqual(grants.on('folder:photos').map((g) => [g.subject, g.rights]).sort(), [['conversation:compta', 'r'], ['conversation:hugo', 'r']], 'two ordinary lines, no room line, nothing for the box nor devoirs');
    /* Taken back from one, as from its own settings: the other keeps it. */
    assert.equal((await post('/api/conversations/hugo/resources', { resource: 'photos', access: 'none' }, given)).status, 200);
    assert.deepEqual(grants.on('folder:photos').map((g) => g.subject), ['conversation:compta']);
});

test('write gives read and write; a right already wider is kept, never lowered', async (t) => {
    const { room, grants, given } = world(t);
    await post('/api/conversations/hugo/resources', { resource: 'site', access: 'write' }, given);
    const r = await post(`/api/rooms/${room.id}/give`, { asset: 'git:site', rights: 'r' }, given);
    assert.deepEqual(r.body.given, [{ conversation: 'hugo', ok: true, kept: 'write' }, { conversation: 'compta', ok: true }]);
    assert.equal(grants.rightsOf('conversation:hugo', 'git:site'), 'rw');
    assert.equal(grants.rightsOf('conversation:compta', 'git:site'), 'r');
    await post(`/api/rooms/${room.id}/give`, { asset: 'git:site', rights: 'w' }, given);
    assert.equal(grants.rightsOf('conversation:compta', 'git:site'), 'rw');
});

test('a secret: handed to each AI, delivered to their machines; one the server holds is refused for each, nothing given', async (t) => {
    const { room, grants, given, delivered } = world(t);
    const r = await post(`/api/rooms/${room.id}/give`, { asset: 'secret:MODEL_KEY', rights: 'x' }, given);
    assert.deepEqual(r.body.given.map((g) => [g.conversation, g.ok]), [['hugo', true], ['compta', true]]);
    assert.deepEqual(grants.on('secret:MODEL_KEY').map((g) => [g.subject, g.rights]).sort(), [['conversation:compta', 'x'], ['conversation:hugo', 'x']]);
    assert.deepEqual(delivered, ['hugo', 'compta']);
    const held = await post(`/api/rooms/${room.id}/give`, { asset: 'secret:ACCOUNT_TOKEN', rights: 'x' }, given);
    assert.equal(held.status, 200);
    assert.ok(held.body.given.every((g) => g.ok === false && /held by the server/.test(g.error)));
    assert.deepEqual(grants.on('secret:ACCOUNT_TOKEN'), []);
});

test('rights a single conversation could not be given are refused before anything is given', async (t) => {
    const { room, grants, given } = world(t);
    for (const [asset, rights] of [['secret:MODEL_KEY', 'r'], ['mailbox:news', 'rw'], ['folder:photos', 'x'], ['folder:photos', '']]) {
        const r = await post(`/api/rooms/${room.id}/give`, { asset, rights }, given);
        assert.equal(r.status, 400, `${asset} ${rights}`);
    }
    assert.equal((await post(`/api/rooms/${room.id}/give`, { asset: 'folder:nowhere', rights: 'r' }, given)).status, 404);
    assert.equal((await post(`/api/rooms/${room.id}/give`, { asset: 'secret:NOWHERE', rights: 'x' }, given)).status, 404);
    assert.equal((await post(`/api/rooms/${room.id}/give`, { asset: 'conversation:hugo', rights: 'r' }, given)).status, 400, 'a conversation is never given to a conversation');
    assert.equal((await post('/api/rooms/00000000-0000-4000-8000-000000000000/give', { asset: 'folder:photos', rights: 'r' }, given)).status, 404);
    assert.equal(grants.of('conversation:hugo').length + grants.of('conversation:compta').length, 0);
});

test('an AI taken out of the room is not given; a conversation not ready says so, the others get it', async (t) => {
    const { rooms, room, grants, given } = world(t, { phases: { compta: 'creating' } });
    rooms.change(room.id, { add: { conversations: ['devoirs'] } });
    const hugo = rooms.get(room.id).members.find((m) => m.ref === 'hugo');
    rooms.change(room.id, { remove: [hugo.id] });
    const r = await post(`/api/rooms/${room.id}/give`, { asset: 'folder:photos', rights: 'r' }, given);
    assert.deepEqual(r.body.given.map((g) => [g.conversation, g.ok]), [['compta', false], ['devoirs', true]]);
    assert.match(r.body.given[0].error, /not ready/);
    assert.equal(grants.rightsOf('conversation:hugo', 'folder:photos'), '');
    assert.equal(grants.rightsOf('conversation:compta', 'folder:photos'), '');
    assert.equal(grants.rightsOf('conversation:devoirs', 'folder:photos'), 'r');
});

test('a room whose AIs are all gone (their conversations removed): refused, nothing given', async (t) => {
    const { room, grants, list, given } = world(t);
    list.splice(0, list.length, ...list.filter((c) => c.name === 'devoirs'));
    assert.equal((await post(`/api/rooms/${room.id}/give`, { asset: 'folder:photos', rights: 'r' }, given)).status, 409);
    assert.deepEqual(grants.on('folder:photos'), []);
});
