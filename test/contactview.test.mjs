/* AN ADDRESS BOOK SEEN BY ITS OWNER (contactview.mjs, 16-11): POST /api/tether/contacts and contact read a contacts
   asset's list and one contact through Tether -- the connector an agent's contacts-list uses -- as the owner's own
   read; never a sign-in in the answer. A contacts connector of the test answers; example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';
import { handleApi } from '../server/api.mjs';
import { readContacts, readContact, contactsOfText, contactOfText, contactOf } from '../server/contactview.mjs';

const BOOK = { id: 'contacts-someone-example-com', title: 'Contacts — someone@example.com (Microsoft)', kind: 'contacts', connector: 'contacts', config: { provider: 'microsoft', user: 'someone@example.com' }, secrets: { refresh: 'oauth-microsoft-someone' } };
const BOX = { id: 'mail-someone-example-com', title: 'Mail', kind: 'mail', connector: 'mail', config: {} };
/* What Tether's contacts-list says today (0.1.0-next.69). */
const LIST = ['AAMkC-2', '  Zoé Sample  <zoe@example.com>  tel +33 6 00 00 00 01', 'AAMkC-1', '  Alex Example  <alex@example.com, alex.work@example.com>', '/book/3.vcf', '  (no name)  tel 0100000000',
    '', '(Showing the first 50 of 120 contacts — use contacts-search to find one.)'].join('\n');
/* Its contacts-read: Microsoft's lines; a CardDAV book's, its vCard after. */
const MS_READ = ['Alex Example', '  email: alex@example.com', '  email: alex.work@example.com', '  tel (mobile): +33 6 00 00 00 02', '  tel (work): +33 1 00 00 00 03', '  company: Example SA, Engineer',
    '  address (work): 1 rue de l\'Exemple, 75000 Paris, France', '  birthday: 1990-01-02', '', 'Met at <b>the fair</b>: https://fair.example.com/2026', '', 'id: AAMkC-1'].join('\n');
const DAV_READ = ['Zoé Sample', '  email: zoe@example.com', '  tel: +33 6 00 00 00 01', '  (has a photo)', '',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Zoé Sample', 'ORG:Example;Design', 'TITLE:Lead', 'NOTE:Line one\\nline two\\, with a comma', 'PHOTO;ENCODING=b:AAAA', 'END:VCARD'].join('\n');
const OWNER = { id: 'person:owner', name: 'Owner' };

function world(t, answer = (verb, a) => (verb === 'contacts.read' ? { text: a.id.endsWith('.vcf') ? DAV_READ : MS_READ, size: 1 } : { text: LIST, size: 1 })) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-contactview-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked = [];
    const book = { run: async (verb, target, a, ctx) => { asked.push({ verb, a, person: ctx.person?.id, agent: ctx.agent }); return answer(verb, a, target); } };
    const tethers = new Tethers({ dataDir: dir, resources: { workFolder: () => dir }, conversations: () => [], secrets: { reveal: async () => 'never-shown-token' }, connectors: { contacts: book, mail: book } });
    tethers.store().putTarget(BOOK); tethers.store().putTarget(BOX);
    return { tethers, asked, dir };
}

test('Tether\'s text lines, read back: id, name, emails, phones (one line: a phone has spaces too)', () => {
    const cs = contactsOfText(LIST);
    assert.deepEqual(cs.map((c) => [c.id, c.name, c.emails, c.phones, c.company]), [
        ['AAMkC-2', 'Zoé Sample', ['zoe@example.com'], ['+33 6 00 00 00 01'], null],
        ['AAMkC-1', 'Alex Example', ['alex@example.com', 'alex.work@example.com'], [], null],
        ['/book/3.vcf', '(no name)', [], ['0100000000'], null],
    ]);
    assert.deepEqual(contactsOfText('No contact.'), []);
    assert.deepEqual(contactsOfText('No contact matches.\n\n(Looked at the first 1000 contacts.)'), []);
});

test('one contact read back: Microsoft\'s lines, its notes as text; a CardDAV vCard\'s company, title and note', () => {
    const m = contactOfText(MS_READ, 'AAMkC-1');
    assert.deepEqual([m.name, m.emails, m.phones, m.company], ['Alex Example', ['alex@example.com', 'alex.work@example.com'], ['+33 6 00 00 00 02 (mobile)', '+33 1 00 00 00 03 (work)'], 'Example SA, Engineer']);
    assert.deepEqual(m.facts, [['address (work)', '1 rue de l\'Exemple, 75000 Paris, France'], ['birthday', '1990-01-02']]);
    assert.equal(m.notes, 'Met at <b>the fair</b>: https://fair.example.com/2026', 'text, as written; the page shows it as text');
    const d = contactOfText(DAV_READ, '/book/3.vcf');
    assert.deepEqual([d.name, d.emails, d.phones, d.company], ['Zoé Sample', ['zoe@example.com'], ['+33 6 00 00 00 01'], 'Example, Design']);
    assert.deepEqual(d.facts, [['title', 'Lead']]);
    assert.equal(d.notes, 'Line one\nline two, with a comma');
    assert.equal(JSON.stringify(d).includes('PHOTO'), false, 'the vCard itself is not handed on');
});

test('a contact given as data: kept to what the page shows', () => {
    assert.deepEqual(contactOf({ id: 'c', name: 'A\nB', email: 'a@example.com', phones: ['1', ''], company: 'Co', secret: 'x' }), { id: 'c', name: 'A B', emails: ['a@example.com'], phones: ['1'], company: 'Co' });
    assert.equal(contactOf({ name: 'no id' }), null);
});

test('the list and a search, read through Tether as the owner\'s own read: by name, partial while Tether gives text', async (t) => {
    const { tethers, asked, dir } = world(t);
    const got = await readContacts(tethers, { target: BOOK.id }, { who: OWNER });
    assert.deepEqual(asked.map((x) => [x.verb, x.a]), [['contacts.list', { target: BOOK.id }]]);
    assert.equal(asked[0].person, 'person:owner');
    assert.equal(asked[0].agent, 'person:owner', 'never an agent');
    assert.deepEqual(got.contacts.map((c) => c.name), ['(no name)', 'Alex Example', 'Zoé Sample']);
    assert.equal(got.partial, true);
    assert.equal(got.more, true);
    assert.equal(JSON.stringify(got).includes('never-shown-token'), false);
    await readContacts(tethers, { target: BOOK.id, text: ' alex ' }, { who: OWNER });
    assert.deepEqual(asked[1].a, { target: BOOK.id, text: 'alex' });
    assert.equal(asked[1].verb, 'contacts.search');
    const one = await readContact(tethers, { target: BOOK.id, id: 'AAMkC-1' }, { who: OWNER });
    assert.deepEqual(asked[2], { verb: 'contacts.read', a: { target: BOOK.id, id: 'AAMkC-1' }, person: 'person:owner', agent: 'person:owner' });
    assert.equal(one.company, 'Example SA, Engineer');
    assert.equal(one.partial, true);
    const journal = readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(journal.filter((l) => l.op === 'read' && l.by?.id === 'person:owner' && !l.agent).length, 3);
});

test('contacts given as data: all their fields', async (t) => {
    const { tethers } = world(t, (verb) => (verb === 'contacts.read'
        ? { text: 'read', size: 4, contact: { id: 'c1', name: 'Alex', emails: ['alex@example.com'], phones: ['1'], company: 'Co', title: 'Lead', addresses: ['1 street'], notes: 'hi' } }
        : { text: 'listed', size: 6, contacts: [{ id: 'c1', name: 'Alex', emails: ['alex@example.com'], company: 'Co' }], more: true }));
    const list = await readContacts(tethers, { target: BOOK.id }, { who: OWNER });
    assert.deepEqual(list.contacts, [{ id: 'c1', name: 'Alex', emails: ['alex@example.com'], phones: [], company: 'Co' }]);
    assert.equal(list.partial, false);
    assert.equal(list.more, true);
    const one = await readContact(tethers, { target: BOOK.id, id: 'c1' }, { who: OWNER });
    assert.deepEqual(one.facts, [['title', 'Lead'], ['address', '1 street']]);
    assert.equal(one.notes, 'hi');
    assert.equal(one.partial, false);
});

test('refused in plain words: not an address book, failing, late, no id', async (t) => {
    const { tethers } = world(t, () => { throw new Error('401 the sign-in expired'); });
    await assert.rejects(readContacts(tethers, { target: BOX.id }, { who: OWNER }), (e) => e.status === 404 && e.message === 'No such address book.');
    await assert.rejects(readContacts(tethers, { target: BOOK.id }, { who: OWNER }), (e) => e.status === 502 && e.message.includes('sign-in expired'));
    await assert.rejects(readContact(tethers, { target: BOOK.id, id: '' }, { who: OWNER }), (e) => e.status === 400);
    const slow = world(t, () => new Promise(() => {}));
    await assert.rejects(readContacts(slow.tethers, { target: BOOK.id }, { who: OWNER, wait: 20 }), (e) => e.status === 504);
    await assert.rejects(readContacts(null, { target: BOOK.id }, { who: OWNER }), (e) => e.status === 503);
});

const PARAMS = /^async function handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.trim().split('=')[0].trim());
async function post(path, body, given, { sameSite = true, type = 'application/json' } = {}) {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: { 'content-type': type, 'x-forwarded-email': 'someone@example.com' } });
    const out = { status: 0, chunks: [] };
    const response = new Writable({ write(c, e, done) { out.chunks.push(Buffer.from(c)); done(); } });
    response.writeHead = (s) => { out.status = s; return response; };
    const ended = new Promise((done) => response.on('finish', done));
    const conversations = { list: () => [] };
    await handleApi(...PARAMS.map((n) => (n === 'request' ? request : n === 'response' ? response : n === 'originOk' ? () => sameSite : n === 'headers' ? {} : n === 'conversations' ? conversations : given[n])));
    await ended;
    return { status: out.status, json: JSON.parse(Buffer.concat(out.chunks).toString('utf8')) };
}

test('POST /api/tether/contacts and contact: this site\'s pages only; read as the signed-in person\'s', async (t) => {
    const { tethers, asked, dir } = world(t);
    const list = await post('/api/tether/contacts', { target: BOOK.id }, { tethers });
    assert.equal(list.status, 200);
    assert.equal(list.json.contacts.length, 3);
    const one = await post('/api/tether/contact', { target: BOOK.id, id: 'AAMkC-1' }, { tethers });
    assert.equal(one.status, 200);
    assert.equal(one.json.name, 'Alex Example');
    assert.equal(JSON.stringify([list.json, one.json]).includes('never-shown-token'), false);
    assert.match(readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8'), /"by":\{"id":"person:someone@example.com"/);
    const n = asked.length;
    for (const path of ['/api/tether/contacts', '/api/tether/contact']) {
        assert.equal((await post(path, { target: BOOK.id, id: 'AAMkC-1' }, { tethers }, { sameSite: false })).status, 403);
        assert.equal((await post(path, { target: BOOK.id, id: 'AAMkC-1' }, { tethers }, { type: 'text/plain' })).status, 403);
    }
    assert.equal(asked.length, n, 'nothing read for another site');
    const gone = await post('/api/tether/contacts', { target: 'contacts-gone-example-com' }, { tethers });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, 'No such address book.');
});
