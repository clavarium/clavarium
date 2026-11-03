/* ROOMS (#268): one thread for several AIs, the person and boxes; the host takes what nobody named; an AI's
   answer comes back signed by where it came from, and only into a room it is in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../server/rooms.mjs';
import { JsonFile } from '../server/store.mjs';

const setup = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const said = []; const told = new Map();
    const convs = [{ name: 'hugo', chatName: 'Hugo' }, { name: 'compta', title: 'Compta' }, { name: 'jardin' }];
    const boxes = [{ id: 'box-1', name: 'Cuisine' }, { id: 'box-2', name: 'Jardin' }];
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async (name, text, extra) => { said.push({ name, text, extra }); }, rooms: (name, list) => told.set(name, list), conversations: () => convs, boxes: () => boxes });
    return { rooms, said, told };
};

test('a room: its members each with an id of their own, its host the first AI by default, one name one member', (t) => {
    const { rooms, told } = setup(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'], boxes: ['box-1'] });
    assert.equal(r.members.length, 4, 'the person, two AIs, a box');
    assert.ok(r.members.every((m) => /^[0-9a-f-]{36}$/.test(m.id)), 'each a uuid');
    assert.deepEqual(r.members.map((m) => m.kind), ['person', 'ai', 'ai', 'box']);
    assert.equal(r.members.find((m) => m.host).ref, 'hugo');
    assert.deepEqual(told.get('compta').map((x) => x.name), ['La maison'], 'each of its AIs is told the room');
    assert.deepEqual(told.get('jardin'), [], 'not the others');
    assert.throws(() => rooms.create({ name: 'Le jardin', conversations: ['jardin'], boxes: ['box-2'] }), /same name/, 'an AI and a box both "jardin": refused');
    assert.throws(() => rooms.create({ name: 'Vide' }), /one AI at least/);
    assert.throws(() => rooms.create({ name: 'la maison', conversations: ['hugo'] }), /has that name/);
});

test('what the person says goes to the host alone, with who said it and where; an AI named gets it instead', async (t) => {
    const { rooms, said } = setup(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'], boxes: ['box-1'] });
    const box = r.members.find((m) => m.kind === 'box'); const compta = r.members.find((m) => m.ref === 'compta');
    await rooms.say(r.id, 'On a payé la facture ?', { by: box.id });
    assert.equal(said.length, 1); assert.equal(said[0].name, 'hugo');
    assert.deepEqual(said[0].extra.by, { id: box.id, name: 'Cuisine', kind: 'box' });
    assert.equal(said[0].extra.room.name, 'La maison');
    const thread = rooms.read(r.id);
    assert.equal(thread.messages.at(-1).text, 'On a payé la facture ?');
    assert.equal(said[0].extra.room.message, thread.messages.at(-1).id);
    await rooms.say(r.id, 'Compta, et l’assurance ?', { to: [compta.id] });
    assert.equal(said.at(-1).name, 'compta');
    await assert.rejects(rooms.say(r.id, 'x', { by: compta.id }), /Not a member/, 'an AI never speaks on the person’s side');
});

test('an AI answers in a room: signed by where it came from, linked to the message, only in a room it is in', async (t) => {
    const { rooms } = setup(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'], boxes: ['box-1'] });
    await rooms.say(r.id, 'On a payé la facture ?');
    const asked = rooms.read(r.id).messages.at(-1);
    const box = r.members.find((m) => m.kind === 'box');
    assert.ok(rooms.answered('compta', { room: r.id, text: 'Oui, le 28.', re: asked.id.slice(0, 8), to: [box.id, 'nobody'] }));
    const answer = rooms.read(r.id).messages.at(-1);
    assert.equal(answer.from, 'agent');
    assert.equal(answer.by.name, 'Compta', 'named as its chat names it'); assert.equal(answer.by.kind, 'ai');
    assert.equal(answer.re, asked.id, 'its first characters: the whole id');
    assert.deepEqual(answer.to, [box.id], 'only members');
    assert.equal(rooms.answered('jardin', { room: r.id, text: 'Moi aussi.' }), null, 'not a member: nothing');
    assert.equal(rooms.answered('hugo', { room: 'no-room', text: 'x' }), null);
});

test('a room changed: host, members, name; a conversation renamed follows; removed, its thread goes', (t) => {
    const { rooms, told } = setup(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo'] });
    const c = rooms.change(r.id, { name: 'Maison', add: { conversations: ['compta'] } });
    const compta = c.members.find((m) => m.ref === 'compta');
    assert.equal(rooms.change(r.id, { host: compta.id }).members.find((m) => m.host).ref, 'compta');
    const hugo = c.members.find((m) => m.ref === 'hugo');
    assert.equal(rooms.change(r.id, { remove: [compta.id] }).members.find((m) => m.host).ref, 'hugo', 'the host gone: the first AI left');
    assert.throws(() => rooms.change(r.id, { remove: [hugo.id] }), /one AI at least/);
    rooms.remove(r.id);
    assert.deepEqual(rooms.list(), []);
    assert.deepEqual(told.get('hugo'), []);
});

test('#280: an AI sent a message hands it on (forward: as it is, by who said it), or writes to another AI (split); @Name kept as an id, shown by name; never a loop', async (t) => {
    const { rooms, said } = setup(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'], boxes: ['box-1'] });
    const box = r.members.find((m) => m.kind === 'box'); const compta = r.members.find((m) => m.ref === 'compta'); const hugo = r.members.find((m) => m.ref === 'hugo');
    await rooms.say(r.id, 'On a payé la facture ?', { by: box.id });
    const asked = rooms.read(r.id).messages.at(-1);
    said.length = 0;
    /* Forward: Compta gets the box's own words, by the box; nothing new in the room. */
    assert.equal(rooms.answered('hugo', { room: r.id, text: '', to: [compta.id], forward: asked.id.slice(0, 8) }), asked.id);
    await new Promise((x) => setImmediate(x));
    assert.equal(said.length, 1); assert.equal(said[0].name, 'compta'); assert.equal(said[0].text, 'On a payé la facture ?');
    assert.deepEqual(said[0].extra.by, { id: box.id, name: 'Cuisine', kind: 'box' }); assert.equal(said[0].extra.room.message, asked.id);
    assert.equal(rooms.read(r.id).messages.length, 1, 'no copy in the room');
    /* Split: Hugo asks Compta in the room; Compta gets it from Hugo. */
    said.length = 0;
    const sub = rooms.answered('hugo', { room: r.id, text: 'Le budget suit, @Compta ?', to: [compta.id], re: asked.id });
    await new Promise((x) => setImmediate(x));
    assert.equal(said[0].name, 'compta'); assert.deepEqual(said[0].extra.by, { id: hugo.id, name: 'Hugo', kind: 'ai' }); assert.equal(said[0].extra.room.message, sub);
    assert.match(said[0].text, new RegExp(`@\\{${compta.id}\\}`), 'kept as its id');
    const shown = rooms.read(r.id).messages.find((m) => m.id === sub);
    assert.equal(shown.text, 'Le budget suit, @Compta ?', 'shown by its name of the moment');
    assert.deepEqual(shown.toNames, ['Compta']);
    /* Two AIs sending to each other stop after a few. */
    said.length = 0;
    for (let i = 0; i < 20; i++) rooms.answered(i % 2 ? 'hugo' : 'compta', { room: r.id, text: `ping ${i}`, to: [i % 2 ? compta.id : hugo.id] });
    await new Promise((x) => setImmediate(x));
    assert.ok(said.length <= 8, `a few hand-overs, not ${said.length}`);
    await rooms.say(r.id, 'Merci.');
    said.length = 0; rooms.answered('hugo', { room: r.id, text: 'Compta, note-le.', to: [compta.id] }); await new Promise((x) => setImmediate(x));
    assert.equal(said.length, 1, 'the person spoke: hand-overs again');
});
