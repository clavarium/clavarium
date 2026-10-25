import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Binders } from '../server/binders.mjs';

function bench(t, { now = () => Date.now(), dir = null } = {}) {
    if (!dir) { dir = mkdtempSync(join(tmpdir(), 'clv-binders-')); t.after(() => rmSync(dir, { recursive: true, force: true })); }
    const posted = []; const events = []; const alerts = [];
    const names = ['coder', 'writer'];
    for (const n of names) mkdirSync(join(dir, 'work', n), { recursive: true });
    const b = new Binders({ dataDir: join(dir, 'data'), resources: { workFolder: (n) => join(dir, 'work', n) }, conversations: () => names,
        dockets: { post: (name, e) => { posted.push([name, e.text]); events.push([name, e]); } }, alert: (m) => { alerts.push(m); }, now });
    return { b, dir, posted, events, alerts };
}

test('each conversation is given its .binder; one that is a link is left out', (t) => {
    const { b, dir } = bench(t);
    rmSync(join(dir, 'work', 'writer'), { recursive: true });
    mkdirSync(join(dir, 'work', 'writer'));
    symlinkSync(tmpdir(), join(dir, 'work', 'writer', '.binder'));
    b.pump();
    assert.ok(lstatSync(join(dir, 'work', 'coder', '.binder')).isDirectory());
    assert.ok(lstatSync(join(dir, 'work', 'writer', '.binder')).isSymbolicLink(), 'left as it was, and not used');
    assert.equal(existsSync(join(dir, 'data', 'binder', 'state.json')), false);
});

test('the owner acts as a person; a tool is told by its docket when given a record, when it is approved, when it comes due', (t) => {
    let clock = Date.parse('2026-11-04T08:00:00');
    const { b, posted } = bench(t, { now: () => clock });
    const l = b.act('create-list', { template: 'batches' }, 'owner@example.com').data;
    assert.equal(b.act('create-list', {}, '').ok, true, 'without sign-in, the owner');
    const r = b.act('add', { list: l.id, title: 'Dark mode', due: '2026-11-04 09:00' }, 'owner@example.com').data;
    assert.equal(r.by, 'person:owner@example.com');
    b.act('edit', { id: r.id, owners: ['conversation:coder'] }, 'owner@example.com');
    b.act('approve', { id: r.id }, 'owner@example.com');
    assert.deepEqual(posted.map(([n]) => n), ['coder', 'coder']);
    assert.match(posted[0][1], /Given to you in Binder: #1 Dark mode/);
    assert.match(posted[1][1], /Approved in Binder: #1 Dark mode/);
    assert.ok(b.changes() >= 4);
    assert.deepEqual(b.people('').map((p) => p.id), ['person:owner', 'conversation:coder', 'conversation:writer']);
    clock = Date.parse('2026-11-04T09:05:00');
    assert.equal(posted.length, 2);
});

test('what each conversation was given: its lists, and the records waiting for a tick', (t) => {
    const { b } = bench(t);
    const batches = b.act('create-list', { template: 'batches' }).data;
    const tasks = b.act('create-list', { template: 'simple' }).data;
    assert.deepEqual(b.given(), {});
    b.act('grant', { list: batches.id, to: 'conversation:coder', access: 'write' });
    b.act('grant', { list: tasks.id, to: 'conversation:coder', access: 'read' });
    b.act('grant', { list: tasks.id, to: 'conversation:writer', access: 'read' });
    b.act('add', { list: batches.id, title: 'Dark mode' });
    const r = b.act('add', { list: batches.id, title: 'Search' }).data;
    b.act('add', { list: tasks.id, title: 'No gate here' });
    assert.deepEqual(b.given(), { coder: { lists: 2, waiting: 2 }, writer: { lists: 1, waiting: 0 } });
    b.act('approve', { id: r.id });
    assert.equal(b.given().coder.waiting, 1);
    b.act('archive-list', { list: batches.id });
    assert.deepEqual(b.given().coder, { lists: 1, waiting: 0 });
});

test('a card come due: each conversation that owns it gets one event, the devices one alert; a restart says nothing again', (t) => {
    let clock = Date.parse('2026-11-04T08:00:00');
    const { b, dir, events, alerts } = bench(t, { now: () => clock });
    const l = b.act('create-list', { template: 'batches', title: 'Batches' }).data;
    const card = b.act('add', { list: l.id, title: 'Renew the domain', due: '2026-11-04', owners: ['conversation:coder', 'conversation:writer', 'person:owner'] }).data;
    const timed = b.act('add', { list: l.id, title: 'Call back', due: '2026-11-04 15:30', owners: ['conversation:coder'] }).data;
    const done = b.act('add', { list: l.id, title: 'Old', due: '2026-11-04', state: 'done', owners: ['conversation:coder'] }).data;
    const put = b.act('add', { list: l.id, title: 'Put away', due: '2026-11-04', owners: ['conversation:coder'] }).data;
    b.act('archive', { id: put.id });
    events.length = 0;
    assert.deepEqual(b.remind(), [], 'before 09:00, nothing');
    clock = Date.parse('2026-11-04T09:00:00');
    assert.deepEqual(b.remind(), [card.id]);
    assert.deepEqual(events.map(([n, e]) => [n, e.kind, e.text, e.data.card]), [
        ['coder', 'binder/due', `Échéance : #${card.id} Renew the domain (Batches)`, card.id],
        ['writer', 'binder/due', `Échéance : #${card.id} Renew the domain (Batches)`, card.id]]);
    assert.deepEqual(alerts, [{ title: 'Échéance', body: 'Renew the domain (Batches)', url: `/?open=lists&a=list%3A${l.id}` }]);
    assert.deepEqual(b.remind(), [], 'once');
    clock = Date.parse('2026-11-04T15:30:00');
    assert.deepEqual(b.remind(), [timed.id], 'a time: at that time; a person owns none: no alert');
    assert.equal(alerts.length, 1);
    assert.ok(done);

    const again = bench(t, { now: () => clock, dir });
    assert.deepEqual(again.b.remind(), [], 'a restart says nothing again');
    again.b.act('edit', { id: card.id, due: '2026-11-06' });
    clock = Date.parse('2026-11-06T09:01:00');
    assert.deepEqual(again.b.remind(), [card.id], 'moved later: said again');
    assert.equal(again.alerts.length, 1);
    assert.deepEqual(again.events.filter(([, e]) => e.kind === 'binder/due').map(([n]) => n), ['coder', 'writer']);
});

test('a docket or a device that fails stops nothing', (t) => {
    let clock = Date.parse('2026-11-04T10:00:00');
    const dir = mkdtempSync(join(tmpdir(), 'clv-binders-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'coder'), { recursive: true });
    const b = new Binders({ dataDir: join(dir, 'data'), resources: { workFolder: (n) => join(dir, 'work', n) }, conversations: () => ['coder'],
        dockets: { post: () => { throw new Error('off'); } }, alert: () => Promise.reject(new Error('no device')), now: () => clock });
    const l = b.act('create-list', { template: 'simple' }).data;
    const r = b.act('add', { list: l.id, title: 'Pay', due: '2026-11-04', owners: ['conversation:coder', 'person:owner'] }).data;
    assert.deepEqual(b.remind(), [r.id]);
});

test('a lead reminder is delivered once ahead of the due, the due once at the due, no repeat across a restart', (t) => {
    let clock = Date.parse('2026-10-27T08:00:00');
    const { b, dir, events, alerts } = bench(t, { now: () => clock });
    const l = b.act('create-list', { template: 'simple', title: 'Projets' }).data;
    const card = b.act('add', { list: l.id, title: 'Voyage à Paris', due: '2026-11-04 09:00', remindBefore: 7, owners: ['conversation:coder', 'person:owner'] }).data;
    events.length = 0;
    assert.deepEqual(b.remind(), [], 'before the lead moment, nothing');
    clock = Date.parse('2026-10-28T09:00:00');            // due − 7 days
    assert.deepEqual(b.remind(), [card.id], 'the lead fires');
    assert.deepEqual(events.map(([n, e]) => [n, e.text, e.data.days]), [
        ['coder', `Dans 7 jours : #${card.id} Voyage à Paris (Projets)`, 7]]);
    assert.deepEqual(alerts, [{ title: 'Dans 7 jours', body: 'Voyage à Paris (Projets)', url: `/?open=lists&a=list%3A${l.id}` }]);
    assert.deepEqual(b.remind(), [], 'the lead is delivered only once');
    events.length = 0;
    clock = Date.parse('2026-11-04T09:00:00');            // the due time
    assert.deepEqual(b.remind(), [card.id], 'the due fires');
    assert.deepEqual(events.map(([, e]) => [e.text, e.data.days]), [[`Échéance : #${card.id} Voyage à Paris (Projets)`, undefined]]);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].title, 'Échéance');
    assert.deepEqual(b.remind(), [], 'the due is delivered only once');

    const again = bench(t, { now: () => clock, dir });
    assert.deepEqual(again.b.remind(), [], 'a restart delivers neither again');
});

test('a failing docket or device does not stop a lead reminder', (t) => {
    const clock = Date.parse('2026-10-28T09:00:00');
    const dir = mkdtempSync(join(tmpdir(), 'clv-binders-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'coder'), { recursive: true });
    const b = new Binders({ dataDir: join(dir, 'data'), resources: { workFolder: (n) => join(dir, 'work', n) }, conversations: () => ['coder'],
        dockets: { post: () => { throw new Error('off'); } }, alert: () => Promise.reject(new Error('no device')), now: () => clock });
    const l = b.act('create-list', { template: 'simple' }).data;
    const r = b.act('add', { list: l.id, title: 'Trip', due: '2026-11-04 09:00', remindBefore: 7, owners: ['conversation:coder', 'person:owner'] }).data;
    assert.deepEqual(b.remind(), [r.id], 'the lead is still marked delivered');
});
