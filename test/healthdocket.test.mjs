/* A machine short of room is told to its agent through its docket (server/healthdocket.mjs):
   once per level crossed, again only worse or back after going well under it; where its chat is on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthDocket, KIND, OOM_QUIET_MS } from '../server/healthdocket.mjs';
import { Dockets } from '../server/dockets.mjs';
import { Store } from '../server/store.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-health-docket-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const world = { on: true, now: Date.parse('2026-10-24T10:00:00.000Z'), fail: false };
    const posted = [];
    const dockets = { on: () => world.on, post: (name, e) => { if (world.fail) throw new Error('not writable'); posted.push({ name, ...e }); return { id: String(posted.length), ...e }; } };
    const make = () => new HealthDocket({ store: new Store(join(dir, 'health-docket.json')), dockets, now: () => world.now });
    return { dir, world, posted, make, h: make() };
}
/* A machine that runs and answered, its disk `usedPercent` full (of 10000 MB), its memory `memPercent` used. */
const look = ({ disk = 50, work, mem = 30, oom } = {}) => ({
    state: 'Running', answering: true,
    disks: { '/': { availableMb: 10000 - disk * 100, sizeMb: 10000 }, ...(work === undefined ? {} : { '/work': { availableMb: 10000 - work * 100, sizeMb: 10000 } }) },
    memory: { totalMb: 1000, availableMb: 1000 - mem * 10 },
    ...(oom === undefined ? {} : { oomKinds: { machine: oom, limit: 0 } }),
});
const texts = (b) => b.posted.map((p) => p.text);

test('disk: one event at 85%, one more at 95%, none while it stays; again only after going under 80%', (t) => {
    const b = bench(t);
    b.h.judged('site', look({ disk: 70 }));
    assert.equal(b.posted.length, 0);
    b.h.judged('site', look({ disk: 91 }));
    assert.deepEqual(texts(b), ['Disk of your machine at 91% (/): free space -- caches, temporary files, build outputs -- then say what you did (docket done ID "what").']);
    assert.equal(b.posted[0].kind, KIND);
    assert.deepEqual(b.posted[0].data, { health: 'disk', path: '/', percent: 91, level: 85 });
    b.h.judged('site', look({ disk: 92 })); b.h.judged('site', look({ disk: 86 })); b.h.judged('site', look({ disk: 81 }));
    assert.equal(b.posted.length, 1, 'no repeat while it stays at that level, nor just under it');
    b.h.judged('site', look({ disk: 96 }));
    assert.equal(b.posted.length, 2, 'worse: the next level');
    assert.match(b.posted[1].text, /at 96% \(\/\)/);
    b.h.judged('site', look({ disk: 99 })); b.h.judged('site', look({ disk: 91 }));
    assert.equal(b.posted.length, 2, 'under 95% but not under 90%: nothing');
    b.h.judged('site', look({ disk: 89 })); b.h.judged('site', look({ disk: 95 }));
    assert.equal(b.posted.length, 3, 'under 90%, then 95% again: told again');
    b.h.judged('site', look({ disk: 60 })); b.h.judged('site', look({ disk: 97 }));
    assert.equal(b.posted.length, 4, 'well again, then at once past both: one event, the worse');
    assert.equal(b.posted[3].data.level, 95);
});

test('the work folder is its own disk, said so', (t) => {
    const b = bench(t);
    b.h.judged('site', look({ disk: 50, work: 88 }));
    assert.deepEqual(texts(b), ['Work folder of your machine at 88% (/work): free space without losing work -- caches, build outputs -- then say what you did (docket done ID "what").']);
    b.h.judged('site', look({ disk: 87, work: 88 }));
    assert.equal(b.posted.length, 2);
    assert.equal(b.posted[1].data.path, '/');
});

test('memory: only when high at two looks in a row; once per level, again after going under it', (t) => {
    const b = bench(t);
    b.h.judged('site', look({ mem: 95 }));
    b.h.judged('site', look({ mem: 40 }));
    b.h.judged('site', look({ mem: 95 }));
    assert.equal(b.posted.length, 0, 'a peak is not news');
    b.h.judged('site', look({ mem: 93 }));
    assert.deepEqual(texts(b), ['Memory of your machine at 93% for several minutes: stop what is no longer needed -- servers, watchers, builds left running -- then say what you did (docket done ID "what").']);
    b.h.judged('site', look({ mem: 94 })); b.h.judged('site', look({ mem: 88 })); b.h.judged('site', look({ mem: 91 }));
    assert.equal(b.posted.length, 1);
    b.h.judged('site', look({ mem: 98 }));
    assert.equal(b.posted.length, 2, 'worse');
    assert.equal(b.posted[1].data.level, 97);
    b.h.judged('site', look({ mem: 50 })); b.h.judged('site', look({ mem: 92 })); b.h.judged('site', look({ mem: 92 }));
    assert.equal(b.posted.length, 3, 'back after going well under');
});

test('the whole machine out of memory: told when it happens again, an hour apart at least; a restart starts the count again', (t) => {
    const b = bench(t);
    b.h.judged('site', look({ oom: 0 }));
    assert.equal(b.posted.length, 0);
    b.h.judged('site', look({ oom: 1 }));
    assert.deepEqual(texts(b), ['Your machine ran out of memory: a program was stopped. Run less at once, then say what you did (docket done ID "what").']);
    b.h.judged('site', look({ oom: 1 }));
    b.world.now += 10 * 60_000;
    b.h.judged('site', look({ oom: 3 }));
    assert.equal(b.posted.length, 1, 'within the hour: not yet');
    b.world.now += OOM_QUIET_MS;
    b.h.judged('site', look({ oom: 3 }));
    assert.equal(b.posted.length, 2, 'told once the hour is over');
    assert.match(b.posted[1].text, /\(3 times since it started\)/);
    b.world.now += OOM_QUIET_MS;
    b.h.judged('site', look({ oom: 0 }));
    b.h.judged('site', look({ oom: 1 }));
    assert.equal(b.posted.length, 3, 'started again: its first is news');
    /* A program stopped at its own limit is not the machine's: nothing. */
    b.world.now += OOM_QUIET_MS;
    b.h.judged('site', { ...look(), oomKinds: { machine: 1, limit: 5 } });
    assert.equal(b.posted.length, 3);
});

test('nothing where the chat (its docket) is off, nor for a machine that does not run or does not answer', (t) => {
    const b = bench(t);
    b.world.on = false;
    b.h.judged('site', look({ disk: 99, oom: 2 }));
    assert.equal(b.posted.length, 0);
    assert.equal(new Store(join(b.dir, 'health-docket.json')).get('site'), undefined, 'nothing kept either');
    b.world.on = true;
    b.h.judged('site', { state: 'Running', answering: false, problems: [] });
    b.h.judged('site', { ...look({ disk: 99 }), answering: false });
    b.h.judged('site', { state: 'Suspended' });
    assert.equal(b.posted.length, 0);
    /* Not known while it does not answer: what was posted stays posted. */
    b.h.judged('site', look({ disk: 99 }));
    b.h.judged('site', { state: 'Running', answering: false });
    b.h.judged('site', look({ disk: 99 }));
    assert.equal(b.posted.length, 1);
});

test('no repeat across a restart of the server; a post that failed is tried again; forgotten with its conversation', (t) => {
    const b = bench(t);
    b.h.judged('site', look({ disk: 90, mem: 95 }));
    b.h.judged('site', look({ disk: 90, mem: 95 }));
    assert.equal(b.posted.length, 2);
    const again = b.make();
    again.judged('site', look({ disk: 90, mem: 95 }));
    assert.equal(b.posted.length, 2, 'what was posted is kept');
    again.judged('site', look({ disk: 96, mem: 95 }));
    assert.equal(b.posted.length, 3);

    b.world.fail = true;
    again.judged('other', look({ disk: 90 }));
    b.world.fail = false;
    again.judged('other', look({ disk: 90 }));
    assert.equal(b.posted.filter((p) => p.name === 'other').length, 1, 'tried again at the next look');

    again.forget('site');
    again.judged('site', look({ disk: 96 }));
    assert.equal(b.posted.length, 5);
});

test('posted into the real docket of the conversation: the agent sees it waiting', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-health-docket-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work');
    mkdirSync(work);
    const dockets = new Dockets({ store: new Store(join(dir, 'dockets.json')), resources: { workFolder: () => work }, say: async () => true, chatOn: () => true, listenEveryMs: 10 });
    t.after(() => dockets.stop());
    const h = new HealthDocket({ store: new Store(join(dir, 'health-docket.json')), dockets });
    h.judged('site', look({ disk: 90 }));
    const events = dockets.of('site').events;
    assert.equal(events.length, 1);
    assert.equal(events[0].state, 'waiting');
    assert.equal(events[0].kind, KIND);
    assert.match(events[0].text, /^Disk of your machine at 90% \(\/\)/);
});
