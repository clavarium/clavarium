/* A MAILBOX SEEN BY ITS OWNER (mailview.mjs, 16-11): POST /api/tether/mail-list and mail-read read a mailbox asset's
   latest messages and one of them through Tether -- the connector an agent's mail-list uses -- as the owner's own
   read; never a sign-in in the answer, never marked read, its words as text. A mail connector of the test answers;
   example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';
import { handleApi } from '../server/api.mjs';
import { readMailList, readMail, messagesOfText, messageOfText, messageOf, dateOf, wordsOf, textOfHtml, MESSAGES_MAX } from '../server/mailview.mjs';

const BOX = { id: 'mail-someone-example-com', title: 'Mail — someone@example.com (Microsoft)', kind: 'mail', connector: 'mail', config: { provider: 'microsoft', user: 'someone@example.com' }, secrets: { refresh: 'oauth-microsoft-someone' } };
const IMAP = { id: 'mail-box-example-com', title: 'Mail — box@example.com', kind: 'mail', connector: 'mail', config: { user: 'box@example.com', imap: 'imap.example.com:993' }, secrets: { password: 'box-password' } };
const CAL = { id: 'calendar-someone-example-com', title: 'Agenda', kind: 'calendar', connector: 'calendar', config: {} };
/* What Tether's mail-list says today (0.1.0-next.69): Graph's text lines, then IMAP's. */
const GRAPH_LIST = [
    '#AAMk-1', '  2026-11-16T08:30:00Z', '  From: boss@example.com', '  Subject: Budget', '  ref: mail:mail-someone-example-com/<a1@example.com>?uid=AAMk-1',
    '#AAMk-2', '  2026-11-16T09:45:00Z', '  From: team@example.com', '  Subject: Lunch?', '  ref: mail:mail-someone-example-com/<a2@example.com>?uid=AAMk-2',
    '', '(Showing the first 30 most recent — use since/before to move the window.)',
].join('\n');
const IMAP_LIST = ['#12  16-Nov-2026 09:30:00 +0100', '  From: Friend <friend@example.com>', '  Subject: Photos', '  ref: mail:mail-box-example-com/<p@example.com>?in=INBOX&uid=12',
    '#11  15-Nov-2026 18:00:00 +0100', '  From: shop@example.com', '  Subject: Your order'].join('\n');
/* What Tether's mail-read says: Graph's, its HTML made text there; IMAP's. */
const GRAPH_READ = ['ref: mail:mail-someone-example-com/<a1@example.com>?uid=AAMk-1', 'From: boss@example.com', 'To: someone@example.com', 'Date: 2026-11-16T08:30:00Z', 'Subject: Budget', '',
    'Hello,', 'the figures: https://files.example.com/budget', '', 'Attachments:', '  - budget.xlsx (application/vnd.ms-excel, 24 KB)', '  - logo.png (image/png, 3 KB)'].join('\n');
const IMAP_READ = ['ref: mail:mail-box-example-com/<p@example.com>?in=INBOX&uid=12', 'From: Friend <friend@example.com>', 'To: box@example.com', 'Date: Mon, 16 Nov 2026 09:30:00 +0100', 'Subject: Photos', '',
    'Look!', '', '--- Attachments (1) ---', '  beach.jpg (image/jpeg, ~2048 KB)', '', '(Large message — showing the first 512 KB.)'].join('\n');
const OWNER = { id: 'person:owner', name: 'Owner' };

function world(t, answer = (verb, a, target) => (verb === 'mail.read' ? { text: target.id === IMAP.id ? IMAP_READ : GRAPH_READ, size: 1 } : { text: target.id === IMAP.id ? IMAP_LIST : GRAPH_LIST, size: 1 })) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mailview-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked = [];
    const mail = { run: async (verb, target, a, ctx) => { asked.push({ verb, a, person: ctx.person?.id, agent: ctx.agent }); return answer(verb, a, target); } };
    const tethers = new Tethers({ dataDir: dir, resources: { workFolder: () => dir }, conversations: () => [], secrets: { reveal: async () => 'never-shown-token' }, connectors: { mail, calendar: mail } });
    for (const x of [BOX, IMAP, CAL]) tethers.store().putTarget(x);
    return { tethers, asked, dir };
}

test('times: Graph\'s ISO, IMAP\'s INTERNALDATE, a Date header -- each made one instant', () => {
    assert.equal(dateOf('2026-11-16T08:30:00Z'), '2026-11-16T08:30:00.000Z');
    assert.equal(dateOf('16-Nov-2026 09:30:00 +0100'), '2026-11-16T08:30:00.000Z');
    assert.equal(dateOf(' 6-Jul-2026 09:30:00 +0200'), '2026-07-06T07:30:00.000Z', 'a day of one digit, space-padded');
    assert.equal(dateOf('Mon, 16 Nov 2026 09:30:00 +0100'), '2026-11-16T08:30:00.000Z');
    assert.equal(dateOf('soon'), null);
});

test('Tether\'s text lines, read back: Graph\'s and IMAP\'s; no unread or file mark in them', () => {
    const g = messagesOfText(GRAPH_LIST);
    assert.deepEqual(g.map((m) => [m.id, m.from, m.subject, m.date, m.unread, m.attachments]), [
        ['AAMk-1', 'boss@example.com', 'Budget', '2026-11-16T08:30:00.000Z', null, null],
        ['AAMk-2', 'team@example.com', 'Lunch?', '2026-11-16T09:45:00.000Z', null, null],
    ]);
    assert.equal(g[0].ref, 'mail:mail-someone-example-com/<a1@example.com>?uid=AAMk-1');
    const i = messagesOfText(IMAP_LIST);
    assert.deepEqual(i.map((m) => [m.id, m.from, m.subject, m.date]), [['12', 'Friend <friend@example.com>', 'Photos', '2026-11-16T08:30:00.000Z'], ['11', 'shop@example.com', 'Your order', '2026-11-15T17:00:00.000Z']]);
    assert.equal(i[1].ref, null);
    assert.deepEqual(messagesOfText('No message in the last 30 days.'), []);
    assert.deepEqual(messagesOfText('Nothing found.'), []);
});

test('a message read back: its head, its words, its files by name and size, a cut said', () => {
    const g = messageOfText(GRAPH_READ);
    assert.equal(g.from, 'boss@example.com');
    assert.equal(g.text, 'Hello,\nthe figures: https://files.example.com/budget');
    assert.deepEqual(g.attachments, [{ name: 'budget.xlsx', type: 'application/vnd.ms-excel', size: 24 * 1024 }, { name: 'logo.png', type: 'image/png', size: 3 * 1024 }]);
    assert.equal(g.cut, false);
    const i = messageOfText(IMAP_READ);
    assert.equal(i.text, 'Look!');
    assert.deepEqual(i.attachments, [{ name: 'beach.jpg', type: 'image/jpeg', size: 2048 * 1024 }]);
    assert.equal(i.cut, true);
});

test('words as text: HTML still in them made text, what runs dropped; plain text kept as written', () => {
    const hostile = '<html><body><p>Hi <b>you</b></p><img src=x onerror="alert(1)"><script>alert(2)</script><style>p{}</style>a &lt;tag&gt; &amp; more<br>end</body></html>';
    assert.equal(textOfHtml(hostile), 'Hi you\na <tag> & more\nend');
    assert.equal(wordsOf(hostile).text, 'Hi you\na <tag> & more\nend');
    assert.equal(wordsOf('if a < b and c > d\u0007\r\nthen').text, 'if a < b and c > d\nthen', 'not HTML: kept, a control character dropped');
    const long = wordsOf('x'.repeat(200_000));
    assert.equal(long.cut, true);
    assert.equal(long.text.length, 100_000);
});

test('a message given as data: kept to what the page shows', () => {
    assert.deepEqual(messageOf({ id: 'm1', ref: 'mail:x/<y>', from: 'a@example.com', subject: 'Hi\nthere', date: '2026-11-16T08:30:00Z', unread: true, attachments: 2, extra: 'dropped' }),
        { id: 'm1', ref: 'mail:x/<y>', from: 'a@example.com', subject: 'Hi there', date: '2026-11-16T08:30:00.000Z', unread: true, attachments: true });
    assert.equal(messageOf({ id: 'm2' }).subject, '(no subject)');
    assert.equal(messageOf({ subject: 'no id' }), null);
});

test('the list, read through Tether as the owner\'s own read: newest first, partial while Tether gives text; a search; a folder on Microsoft only', async (t) => {
    const { tethers, asked, dir } = world(t);
    const got = await readMailList(tethers, { target: BOX.id }, { who: OWNER });
    assert.deepEqual(asked.map((x) => [x.verb, x.a]), [['mail.list', { target: BOX.id }]]);
    assert.equal(asked[0].person, 'person:owner');
    assert.equal(asked[0].agent, 'person:owner', 'never an agent');
    assert.deepEqual(got.messages.map((m) => m.id), ['AAMk-2', 'AAMk-1'], 'newest first');
    assert.equal(got.partial, true);
    assert.equal(got.more, true, 'Tether said it cut the list');
    assert.equal(got.folder, 'inbox');
    assert.deepEqual(got.folders, ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']);
    assert.equal(JSON.stringify(got).includes('never-shown-token'), false);
    await readMailList(tethers, { target: BOX.id, folder: 'Sent', text: ' budget ' }, { who: OWNER });
    assert.deepEqual(asked[1], { verb: 'mail.search', a: { target: BOX.id, text: 'budget', mailbox: 'sent' }, person: 'person:owner', agent: 'person:owner' });
    const imap = await readMailList(tethers, { target: IMAP.id }, { who: OWNER });
    assert.deepEqual(imap.folders, ['inbox']);
    await assert.rejects(readMailList(tethers, { target: IMAP.id, folder: 'sent' }, { who: OWNER }), (e) => e.status === 400 && e.kind === 'bad-folder');
    const journal = readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(journal.filter((l) => l.op === 'read' && l.by?.id === 'person:owner' && !l.agent).length >= 3);
});

test('messages given as data: their marks, 25 at most', async (t) => {
    const many = Array.from({ length: MESSAGES_MAX + 5 }, (_, i) => ({ id: `m${i}`, from: 'a@example.com', subject: `Mail ${i}`, date: new Date(Date.UTC(2026, 10, 1 + (i % 28), 8)).toISOString(), unread: i % 2 === 0, attachments: i % 3 === 0 }));
    const { tethers } = world(t, () => ({ text: 'listed', size: 6, messages: many }));
    const got = await readMailList(tethers, { target: BOX.id }, { who: OWNER });
    assert.equal(got.partial, false);
    assert.equal(got.messages.length, MESSAGES_MAX);
    assert.equal(got.more, true);
    assert.ok(got.messages.every((m, i, all) => i === 0 || all[i - 1].date >= m.date), 'newest first');
    assert.ok(got.messages.some((m) => m.unread === true) && got.messages.some((m) => m.attachments === true));
});

test('one message, read as the owner\'s, never marked read (mail.read only, no flag); its uid and folder passed', async (t) => {
    const { tethers, asked } = world(t);
    const g = await readMail(tethers, { target: BOX.id, id: 'AAMk-1' }, { who: OWNER });
    assert.deepEqual(asked.map((x) => [x.verb, x.a]), [['mail.read', { target: BOX.id, uid: 'AAMk-1' }]]);
    assert.equal(g.subject, 'Budget');
    assert.equal(g.to, 'someone@example.com');
    assert.equal(g.ref, 'mail:mail-someone-example-com/<a1@example.com>?uid=AAMk-1');
    assert.equal(g.attachments.length, 2);
    assert.equal(g.partial, true);
    const i = await readMail(tethers, { target: IMAP.id, id: '12' }, { who: OWNER });
    assert.equal(i.cut, true);
    assert.equal(i.date, '2026-11-16T08:30:00.000Z');
    await readMail(tethers, { target: BOX.id, id: 'AAMk-9', folder: 'archive' }, { who: OWNER });
    assert.deepEqual(asked.at(-1).a, { target: BOX.id, uid: 'AAMk-9', mailbox: 'archive' });
    assert.ok(asked.every((x) => x.verb === 'mail.read' || x.verb === 'mail.list' || x.verb === 'mail.search'), 'nothing but reads');
    await assert.rejects(readMail(tethers, { target: BOX.id, id: '' }, { who: OWNER }), (e) => e.status === 400);
    await assert.rejects(readMail(tethers, { target: BOX.id, id: 'a b' }, { who: OWNER }), (e) => e.status === 400);
});

test('a message given as data, its words still HTML: made text, its files kept by name and size', async (t) => {
    const { tethers } = world(t, () => ({ text: 'read', size: 4, message: { id: 'm', from: 'x@example.com', subject: 'Offer', date: '2026-11-16T08:30:00Z', text: '<div>Buy <img src="https://track.example.com/p.gif" onerror="alert(1)"><script>steal()</script>now</div>', attachments: [{ name: 'a.pdf', type: 'application/pdf', size: 1234 }, { name: '' }] } }));
    const got = await readMail(tethers, { target: BOX.id, id: 'm' }, { who: OWNER });
    assert.equal(got.text, 'Buy now');
    assert.deepEqual(got.attachments, [{ name: 'a.pdf', type: 'application/pdf', size: 1234 }]);
    assert.equal(got.partial, false);
});

test('refused in plain words: not a mailbox, the mailbox failing, late, a mail gone', async (t) => {
    const { tethers } = world(t, () => { throw new Error('401 the sign-in expired'); });
    await assert.rejects(readMailList(tethers, { target: CAL.id }, { who: OWNER }), (e) => e.status === 404 && e.message === 'No such mailbox.');
    await assert.rejects(readMail(tethers, { target: 'nothing', id: '1' }, { who: OWNER }), (e) => e.status === 404);
    await assert.rejects(readMailList(tethers, { target: BOX.id }, { who: OWNER }), (e) => e.status === 502 && e.message.startsWith(`${BOX.title} could not be read:`) && e.message.includes('sign-in expired'));
    const slow = world(t, () => new Promise(() => {}));
    await assert.rejects(readMail(slow.tethers, { target: BOX.id, id: '1' }, { who: OWNER, wait: 20 }), (e) => e.status === 504 && e.message.includes('did not answer in time'));
    await assert.rejects(readMailList(null, { target: BOX.id }, { who: OWNER }), (e) => e.status === 503);
});

/* THE ROUTES: the API's arguments by name, the rest undefined. */
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

test('POST /api/tether/mail-list and mail-read: this site\'s pages only; read as the signed-in person\'s', async (t) => {
    const { tethers, asked, dir } = world(t);
    const list = await post('/api/tether/mail-list', { target: BOX.id }, { tethers });
    assert.equal(list.status, 200);
    assert.equal(list.json.messages.length, 2);
    const one = await post('/api/tether/mail-read', { target: BOX.id, id: 'AAMk-1' }, { tethers });
    assert.equal(one.status, 200);
    assert.equal(one.json.subject, 'Budget');
    assert.equal(JSON.stringify([list.json, one.json]).includes('never-shown-token'), false);
    assert.match(readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8'), /"by":\{"id":"person:someone@example.com"/);
    const n = asked.length;
    for (const path of ['/api/tether/mail-list', '/api/tether/mail-read']) {
        assert.equal((await post(path, { target: BOX.id, id: 'AAMk-1' }, { tethers }, { sameSite: false })).status, 403);
        assert.equal((await post(path, { target: BOX.id, id: 'AAMk-1' }, { tethers }, { type: 'text/plain' })).status, 403);
    }
    assert.equal(asked.length, n, 'nothing read for another site');
    const gone = await post('/api/tether/mail-list', { target: 'mail-gone-example-com' }, { tethers });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, 'No such mailbox.');
    const bad = await post('/api/tether/mail-list', { target: IMAP.id, folder: 'trash' }, { tethers });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.kind, 'bad-folder');
});
