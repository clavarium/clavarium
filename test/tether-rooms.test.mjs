/* A TETHER CALL HELD FOR AN AI AT WORK FOR A ROOM (07-11): said in its chat AND in the room it works for, the same
   card, with Accept / Refuse; decided anywhere, its closing line goes to that room too. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';
import { Rooms } from '../server/rooms.mjs';
import { JsonFile } from '../server/store.mjs';

test('a call held while its AI works for a room: its card in that room; none in a room it does not work for; decided, folded there', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-trooms-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work'); mkdirSync(work);
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const mail = { name: 'mail', verbs: ['mail.send'], async run() { return { text: 'Sent.', size: 0 }; }, close() {}, shutdown() {} };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha', 'beta'], secrets: { reveal: () => undefined }, connectors: { mail } });
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async () => {}, conversations: () => [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }] });
    const said = [];
    tethers.announce = (name, e) => said.push({ name, ...e });
    tethers.rooms = { held: (name, e) => rooms.held(name, e), closed: (ids, e) => rooms.closed(ids, e) };
    tethers.store().putTarget({ id: 'box', title: 'Box', kind: 'mail', connector: 'mail' });
    for (const n of ['alpha', 'beta']) tethers.store().grant('box', `conversation:${n}`, 'propose');
    const room = rooms.create({ name: 'Maison', conversations: ['alpha', 'beta'] });
    const other = rooms.create({ name: 'Bureau', conversations: ['beta'] });
    await rooms.say(room.id, 'Send the quote');
    const ask = (name, id, subject) => { const side = join(work, name, '.tether'); mkdirSync(side, { recursive: true }); appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id, op: 'mail.send', args: { target: 'box', to: 'bob@example.com', subject, body: 'hi', why: 'test' }, at: new Date().toISOString() })}\n`); };
    const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn()); }; // eslint-disable-line no-await-in-loop
    const lines = (id) => rooms.read(id, { seen: false }).messages.filter((m) => m.from === 'system');

    ask('alpha', 'q1', 'Quote'); ask('beta', 'q2', 'Other');
    tethers.pump();
    await until(() => said.filter((e) => e.kind === 'tether-demande').length === 2);
    const card = lines(room.id);
    assert.equal(card.length, 1, 'alpha works for the room (its host was given the message); beta does not');
    assert.equal(card[0].event, 'tether-demande');
    const mine = said.find((e) => e.name === 'alpha' && e.kind === 'tether-demande');
    assert.deepEqual(card[0].actions, mine.actions, 'the same Accept / Refuse as in its chat');
    assert.equal(card[0].request.yes.id, mine.request.yes.id, 'the same card');
    assert.equal(card[0].request.sub[0], 'Alpha', 'named by the AI that asks');
    assert.equal(lines(other.id).length, 0, 'nothing in a room nobody of it works for');

    const id = card[0].actions[0].slice('allow:'.length);
    await tethers.act('decide', { id, decision: 'no' }, '');
    await until(() => lines(room.id).some((m) => m.event === 'tether-done'));
    const done = lines(room.id).find((m) => m.event === 'tether-done');
    assert.equal(done.brief, id, 'its id: the card folds as in its chat'); assert.equal(done.outcome, 'no');
    assert.equal(lines(other.id).length, 0);
});
