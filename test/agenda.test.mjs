/* A CALENDAR SEEN BY ITS OWNER (agenda.mjs, 16-11): POST /api/tether/agenda reads a calendar asset's events of a
   window through Tether -- the connector an agent's calendar-list uses -- as the owner's own read; never a
   sign-in in the answer. A calendar connector of the test answers; example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';
import { handleApi } from '../server/api.mjs';
import { readAgenda, windowOf, startOf, todayIn, eventsOfText, eventOf, EVENTS_MAX, DAYS_MAX } from '../server/agenda.mjs';

const CAL = { id: 'calendar-someone-example-com', title: 'Agenda — someone@example.com (Microsoft)', kind: 'calendar', connector: 'calendar', config: { provider: 'microsoft', user: 'someone@example.com' }, secrets: { refresh: 'oauth-microsoft-someone' } };
const BOX = { id: 'mail-someone-example-com', title: 'Mail', kind: 'mail', connector: 'mail', config: { user: 'someone@example.com' } };
/* What Tether's calendar-list says today (0.1.0-next.67): its text lines. */
const TEXT = [
    'AAMk-1', '  2026-11-16 09:30 — Stand-up  @ Room 2  [Work]',
    'AAMk-2', '  2026-11-17 14:00 — Review with the team',
    '/cal/3.ics  (repeats: this id is the WHOLE series)', '  2026-11-18 — Holiday',
    '', '(Showing the first 200 events in this window, to keep the reply readable — narrow it with from/to to see the rest.)',
].join('\n');
const NOW = Date.parse('2026-11-16T10:00:00Z');

/* A Tether keeping its store in a folder of the test, its calendar answering `answer(a)`. */
function world(t, answer = () => ({ text: TEXT, size: TEXT.length })) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-agenda-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked = [];
    const calendar = { run: async (verb, target, a, ctx) => { asked.push({ verb, a, person: ctx.person?.id, agent: ctx.agent }); return answer(a, target); } };
    const tethers = new Tethers({ dataDir: dir, resources: { workFolder: () => dir }, conversations: () => [], secrets: { reveal: async () => 'never-shown-token' }, connectors: { calendar, mail: calendar } });
    tethers.store().putTarget(CAL); tethers.store().putTarget(BOX);
    return { tethers, asked, dir };
}
const OWNER = { id: 'person:owner', name: 'Owner' };

test('a window: one week from today by default (pages follow each other), in the calendar\'s zone; six weeks at most', () => {
    assert.equal(todayIn('Europe/Paris', Date.parse('2026-11-16T23:30:00Z')), '2026-11-17', 'past midnight in Paris');
    assert.deepEqual(windowOf({}, { now: NOW }), { from: '2026-11-16', to: '2026-11-23' });
    assert.deepEqual(windowOf({ from: '2026-11-23', to: '2026-11-30' }), { from: '2026-11-23', to: '2026-11-30' });
    assert.equal(startOf('2026-11-16'), '2026-11-15T23:00:00.000Z', 'winter: UTC+1');
    assert.equal(startOf('2026-07-01'), '2026-06-30T22:00:00.000Z', 'summer: UTC+2');
    for (const bad of [{ from: 'monday' }, { from: '2026-02-30' }, { from: '2026-11-16', to: '2026-11-16' }, { from: '2026-11-16', to: '2026-11-10' }]) {
        assert.throws(() => windowOf(bad), (e) => e.status === 400 && e.kind === 'bad-window', JSON.stringify(bad));
    }
    assert.throws(() => windowOf({ from: '2026-11-01', to: '2027-01-01' }), (e) => e.status === 400 && e.message.includes(String(DAYS_MAX)));
});

test('Tether\'s text lines, read back: id, start, title, place; the whole series\' note and categories left out', () => {
    const evs = eventsOfText(TEXT);
    assert.equal(evs.length, 3);
    assert.deepEqual(evs.map((e) => [e.id, e.start, e.title, e.location, e.allDay]), [
        ['AAMk-1', '2026-11-16T09:30', 'Stand-up', 'Room 2', false],
        ['AAMk-2', '2026-11-17T14:00', 'Review with the team', '', false],
        ['/cal/3.ics', '2026-11-18', 'Holiday', '', true],
    ]);
    assert.deepEqual(eventsOfText('No event in that range.'), []);
});

test('an event given as data: kept to what the page shows; a link only when it is https', () => {
    const e = eventOf({ id: 'x', title: 'Call\nnow', start: '2026-11-16T10:00:00', end: '2026-11-16T10:30', location: 'Online', organizer: 'boss@example.com', online: 'https://meet.example.com/a', attendees: 4, show: 'tentative', notes: 'never sent' });
    assert.deepEqual(e, { id: 'x', title: 'Call now', start: '2026-11-16T10:00', end: '2026-11-16T10:30', allDay: false, location: 'Online', organizer: 'boss@example.com', online: 'https://meet.example.com/a', attendees: 4, show: 'tentative' });
    assert.equal(eventOf({ start: '2026-11-16T10:00', online: 'javascript:alert(1)' }).online, null);
    assert.equal(eventOf({ start: '2026-11-16T10:00', show: 'oof' }).show, 'away');
    assert.equal(eventOf({ start: 'soon' }), null);
});

test('read through Tether as the owner\'s own read: the window in the calendar\'s zone, partial while Tether gives text', async (t) => {
    const { tethers, asked, dir } = world(t);
    const got = await readAgenda(tethers, { target: CAL.id }, { who: OWNER, now: NOW });
    assert.deepEqual(asked.map((x) => [x.verb, x.a]), [['calendar.list', { target: CAL.id, from: '2026-11-15T23:00:00.000Z', to: '2026-11-22T23:00:00.000Z' }]]);
    assert.equal(asked[0].person, 'person:owner', 'the person\'s read');
    assert.equal(asked[0].agent, 'person:owner', 'never an agent');
    assert.equal(got.title, CAL.title);
    assert.equal(got.events.length, 3);
    assert.equal(got.partial, true);
    assert.equal(got.more, true, 'Tether said it cut the list');
    assert.equal(JSON.stringify(got).includes('never-shown-token'), false);
    const journal = readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(journal.some((l) => l.op === 'read' && l.verb === 'calendar.list' && l.by?.id === 'person:owner' && !l.agent));
});

test('events given as data: all their fields, soonest first, 200 at most', async (t) => {
    const many = Array.from({ length: EVENTS_MAX + 5 }, (_, i) => ({ id: `e${i}`, title: `Event ${i}`, start: `2026-11-${String(16 + (i % 7)).padStart(2, '0')}T${String(8 + (i % 10)).padStart(2, '0')}:00`, end: null }));
    const { tethers } = world(t, () => ({ text: 'listed', size: 6, events: many.reverse() }));
    const got = await readAgenda(tethers, { target: CAL.id, from: '2026-11-16', to: '2026-11-23' }, { who: OWNER });
    assert.equal(got.partial, false);
    assert.equal(got.events.length, EVENTS_MAX);
    assert.equal(got.more, true);
    assert.ok(got.events.every((e, i, all) => i === 0 || all[i - 1].start <= e.start), 'sorted');
});

test('refused in plain words: not a calendar, the calendar failing, the calendar late', async (t) => {
    const { tethers } = world(t, () => { throw new Error('401 the sign-in expired'); });
    await assert.rejects(readAgenda(tethers, { target: BOX.id }, { who: OWNER }), (e) => e.status === 404 && e.message === 'No such calendar.');
    await assert.rejects(readAgenda(tethers, { target: 'nothing' }, { who: OWNER }), (e) => e.status === 404);
    await assert.rejects(readAgenda(tethers, { target: CAL.id }, { who: OWNER }), (e) => e.status === 502 && e.message.startsWith(`${CAL.title} could not be read:`) && e.message.includes('sign-in expired'));
    const slow = world(t, () => new Promise(() => {}));
    await assert.rejects(readAgenda(slow.tethers, { target: CAL.id }, { who: OWNER, wait: 20 }), (e) => e.status === 504 && e.message.includes('did not answer in time'));
    await assert.rejects(readAgenda(null, { target: CAL.id }, { who: OWNER }), (e) => e.status === 503);
});

/* THE ROUTE: the API's arguments by name, the rest undefined. */
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

test('POST /api/tether/agenda: this site\'s pages only; the events, read as the signed-in person\'s', async (t) => {
    const { tethers, asked, dir } = world(t);
    const ok = await post('/api/tether/agenda', { target: CAL.id, from: '2026-11-16', to: '2026-11-23' }, { tethers });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.events.length, 3);
    assert.deepEqual([ok.json.from, ok.json.to, ok.json.zone], ['2026-11-16', '2026-11-23', 'Europe/Paris']);
    assert.equal(JSON.stringify(ok.json).includes('never-shown-token'), false);
    const journal = readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8');
    assert.match(journal, /"by":\{"id":"person:someone@example.com"/);
    const n = asked.length;
    const other = await post('/api/tether/agenda', { target: CAL.id }, { tethers }, { sameSite: false });
    assert.equal(other.status, 403);
    assert.equal(asked.length, n, 'nothing read for another site');
    const form = await post('/api/tether/agenda', { target: CAL.id }, { tethers }, { type: 'text/plain' });
    assert.equal(form.status, 403);
    const bad = await post('/api/tether/agenda', { target: CAL.id, from: 'tomorrow' }, { tethers });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.kind, 'bad-window');
    const gone = await post('/api/tether/agenda', { target: 'calendar-gone-example-com' }, { tethers });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.error, 'No such calendar.');
});
