/* What wakes a tool whose chat is on is an event it acknowledges (dockets.mjs), told
   again until it says done or failed; its own reminders come the same way. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Dockets, WAKE, AGAIN_MS, TOLD_MAX } from '../server/dockets.mjs';
import { Wakeups } from '../server/wakeups.mjs';
import { pathToFileURL } from 'node:url';
import { packageFile } from '../server/parley.mjs';

/* The command the tool runs in its machine, as installed here (its package exports no command). */
const { run: docket } = await import(pathToFileURL(packageFile('clavarium-docket', 'bin/docket.mjs')).href);

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-docket-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'work', 'worker');
    mkdirSync(work, { recursive: true });
    const world = { now: Date.parse('2026-10-22T10:00:00.000Z'), awake: ['worker'], chat: true, idle: true, types: true };
    const said = []; const lines = []; const alerts = [];
    const resources = { workFolder: () => work };
    const dockets = new Dockets({ store: new Store(join(dir, 'dockets.json')), resources, now: () => world.now, listenEveryMs: 10,
        say: async (name, line) => { said.push([name, line]); return world.types; },
        event: (name, line) => lines.push([name, line.kind, line.text]), alert: (a) => alerts.push(a),
        idle: () => world.idle, awake: () => world.awake, chatOn: () => world.chat, zone: 'Europe/Paris' });
    t.after(() => dockets.stop());
    /* The tool, in its machine: the command, from its work folder. */
    /* As in a machine: no time zone of its own (UTC); the folder's, written by this server. */
    const tool = (...args) => docket(args, { cwd: work, env: { DOCKET_TZ: '', DOCKET_DIR: '', TZ: 'UTC' }, now: () => world.now });
    const later = (ms) => { world.now += ms; };
    return { dir, work, world, said, lines, alerts, dockets, tool, later };
}
const settle = () => new Promise((r) => { setTimeout(r, 60); });

test('a wake-up where the chat is on is an event in its docket: told in one line, told again when idle, then said not handled', async (t) => {
    const b = bench(t);
    const e = b.dockets.post('worker', { kind: 'arrival', text: 'New in handoff: a.md', data: { wakeup: 'w1' } });
    assert.match(b.tool().out, /Waiting \(1\).*\n {2}\[\w{8}\] 2026-10-22 12:00 clavarium\/arrival: New in handoff: a\.md/s, 'the tool sees it with "docket"');
    await b.dockets.tick();
    assert.deepEqual(b.said, [['worker', WAKE]], 'told once, in one line: what woke it is never on that line');
    await b.dockets.tick();
    assert.equal(b.said.length, 1, 'not told again at once');
    /* Busy in a turn: not told again; idle, after a while: told again, at most TOLD_MAX times. */
    b.later(AGAIN_MS); b.world.idle = false;
    await b.dockets.tick();
    assert.equal(b.said.length, 1);
    b.world.idle = true;
    await b.dockets.tick();
    assert.equal(b.said.length, 2);
    b.later(AGAIN_MS); await b.dockets.tick();
    assert.equal(b.said.length, TOLD_MAX);
    b.later(AGAIN_MS); await b.dockets.tick();
    assert.equal(b.said.length, TOLD_MAX, 'no more');
    assert.deepEqual(b.lines.filter((l) => l[1] === 'docket-unhandled'), [['worker', 'docket-unhandled', `Not handled, told ${TOLD_MAX} times: New in handoff: a.md`]]);
    await b.dockets.tick();
    assert.equal(b.lines.filter((l) => l[1] === 'docket-unhandled').length, 1, 'said once');
    assert.equal(b.dockets.of('worker').events[0].told, TOLD_MAX);
    assert.equal(e.from, 'clavarium');
});

test('the tool says done or failed: its chat says so; a failure alerts its owner; nothing is told again', async (t) => {
    const b = bench(t);
    const a = b.dockets.post('worker', { kind: 'cron', text: 'Morning review' });
    const f = b.dockets.post('worker', { kind: 'call', text: 'Deploy the site' });
    await b.dockets.tick();
    assert.equal(b.said.length, 1, 'one line for both');
    assert.equal(b.tool('done', a.id.slice(0, 8), 'three PRs reviewed').code, 0);
    assert.equal(b.tool('failed', f.id.slice(0, 8), 'the server is down').code, 0);
    await settle();
    assert.deepEqual(b.lines.map((l) => [l[1], l[2]]), [['docket-done', 'Handled: Morning review -- three PRs reviewed'], ['docket-failed', 'Could not be handled: Deploy the site -- the server is down']]);
    assert.deepEqual(b.alerts.map((x) => [x.title, x.body]), [['worker: could not be handled', 'Deploy the site: the server is down']]);
    b.later(AGAIN_MS * 2); await b.dockets.tick();
    assert.equal(b.said.length, 1, 'acknowledged: never told again');
    assert.deepEqual(b.dockets.of('worker').events.map((e) => [e.text, e.state]), [['Deploy the site', 'failed'], ['Morning review', 'done']]);
});

test('the tool sets itself a reminder: its chat says so, its owner sees it and may take it back; when due it wakes the tool', async (t) => {
    const b = bench(t);
    await b.dockets.tick();
    assert.match(b.tool('remind', '--in', '2h', 'call the client back').out, /^Set \[\w{8}\]: 2026-10-22 14:00 \(Europe\/Paris\)\.\n$/);
    b.tool('remind', '--cron', '0 9 * * 1', 'Monday review');
    await settle();
    assert.deepEqual(b.lines.map((l) => l[2]), ['Reminder set by the tool: call the client back (2026-10-22 12:00 UTC)', 'Reminder set by the tool: Monday review ("0 9 * * 1", next 2026-10-26 08:00 UTC)']);
    const seen = b.dockets.of('worker');
    assert.deepEqual(seen.plans.map((p) => [p.text, p.next, p.cron]), [['call the client back', '2026-10-22T12:00:00.000Z', null], ['Monday review', '2026-10-26T08:00:00.000Z', '0 9 * * 1']]);
    assert.equal(b.dockets.cancel('worker', seen.plans[1].id), true, 'its owner takes one back');
    assert.equal(b.dockets.cancel('worker', 'nope'), false);
    assert.deepEqual(b.dockets.of('worker').plans.map((p) => p.text), ['call the client back']);
    b.later(2 * 3_600_000 + 1000);
    await b.dockets.tick();
    assert.deepEqual(b.said, [['worker', WAKE]], 'due: posted, and the tool told');
    assert.match(b.tool().out, /docket\/reminder: call the client back/);
    assert.deepEqual(b.dockets.of('worker').plans, [], 'a reminder that came is an event now');
});

test('asleep, or its chat off, nothing is told; a link where its folder should be is refused', async (t) => {
    const b = bench(t);
    b.dockets.post('worker', { kind: 'arrival', text: 'x' });
    b.world.awake = [];
    await b.dockets.tick();
    assert.deepEqual(b.said, [], 'asleep: told once it wakes');
    b.world.awake = ['worker']; b.world.chat = false;
    await b.dockets.tick();
    assert.deepEqual(b.said, []);
    assert.deepEqual(b.dockets.of('worker'), { on: false, plans: [], events: [] });
    b.world.chat = true; b.world.types = false;
    await b.dockets.tick();
    assert.equal(b.dockets.of('worker').events[0].told, 0, 'not typed: not counted as told');
    const other = bench(t);
    symlinkSync('/tmp', join(other.work, '.docket'));
    assert.throws(() => other.dockets.post('worker', { kind: 'arrival', text: 'x' }), /not a folder of its own/);
});

test('a wake-up of a conversation whose chat is on goes to its docket; with the chat off, it is typed as before', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-docket-wake-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const typed = []; const fired = []; const posted = [];
    let on = true;
    const world = { now: new Date(2026, 0, 5, 6, 0, 0) };
    const wakeups = new Wakeups({ store: new Store(join(dir, 'w.json')), conversations: { list: () => [{ name: 'worker' }], awake: () => ['worker'] }, resources: { of: () => [] },
        vms: { exec: async (name, argv) => { if (argv.includes('-l')) typed.push(argv.at(-1)); return { code: 0 }; } }, now: () => new Date(world.now), fired: (name, what) => fired.push(what.text),
        docket: { on: () => on, post: (name, e) => { posted.push([name, e]); return { id: 'e1' }; } } });
    const { items: [item] } = wakeups.add('worker', { kind: 'every', minutes: 5, message: 'Look at the inbox.' });
    world.now = new Date(world.now.getTime() + 5 * 60_000);
    await wakeups.tick();
    assert.deepEqual(posted, [['worker', { kind: 'every', text: 'Look at the inbox.', data: { wakeup: item.id } }]]);
    assert.deepEqual(typed, [], 'not typed: the docket tells it');
    assert.deepEqual(fired, ['Wake-up "Look at the inbox." posted to its docket.']);
    assert.match(wakeups.of('worker').items[0].last.what, /^Posted to its docket: Look at the inbox\./);
    on = false;
    world.now = new Date(world.now.getTime() + 5 * 60_000);
    await wakeups.tick();
    assert.deepEqual(typed, ['Look at the inbox.'], 'chat off: typed, as before');
    assert.equal(posted.length, 1);
    assert.equal(readFileSync(join(dir, 'w.json'), 'utf8').includes('Typed: Look at the inbox.'), true);
});
