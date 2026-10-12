import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Wakeups, look, withFiles, cleanMessage, plainName } from '../server/wakeups.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-wake-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ['handoff', 'site', 'mail']) mkdirSync(join(dir, name));
    const typed = [];
    const world = { now: new Date(2026, 0, 5, 6, 0, 0), awake: ['worker'], attached: ['handoff', 'site', 'mail'], runs: true };
    const vms = { exec: async (name, argv) => { if (!world.runs) return { code: 1 }; const rest = argv.slice(argv.indexOf('send-keys') + 3); typed.push(rest[0] === '-l' ? rest.slice(2).join(' ') : rest.join(' ')); return { code: 0 }; } };
    const conversations = { list: () => [{ name: 'worker' }], awake: () => world.awake };
    const resources = { of: () => world.attached.map((name) => ({ name, access: 'write' })), folder: (name) => join(dir, name), get: (name) => ({ name, type: name === 'site' ? 'git' : name === 'mail' ? 'mailbox' : 'folder' }) };
    const warmed = [];
    const wakeups = new Wakeups({ store: new Store(join(dir, 'wakeups.json')), vms, conversations, resources, warm: async (name) => { warmed.push(name); }, now: () => new Date(world.now) });
    const later = (minutes) => { world.now = new Date(world.now.getTime() + minutes * 60_000); };
    return { dir, typed, world, wakeups, later, warmed };
}

test('a folder is looked at, not read: names, sizes, dates; nothing hidden, no link followed', (t) => {
    const b = bench(t);
    mkdirSync(join(b.dir, 'handoff', 'in', '.git'), { recursive: true });
    writeFileSync(join(b.dir, 'handoff', 'in', 'request.md'), 'please');
    writeFileSync(join(b.dir, 'handoff', '.hidden'), 'x');
    writeFileSync(join(b.dir, 'handoff', 'in', '.git', 'HEAD'), 'x');
    symlinkSync('/etc', join(b.dir, 'handoff', 'outside'));
    assert.deepEqual([...look(join(b.dir, 'handoff')).keys()], ['in/request.md']);
});

test('what is typed is one plain line; a file name is reduced to plain characters', () => {
    assert.equal(cleanMessage('  do this\nthen\tthat\u001b[A  '), 'do this then that[A');
    assert.equal(cleanMessage('x'.repeat(2000)).length, 1000);
    assert.equal(plainName('a b.md; rm -rf $(x) `y` ‮'), 'a b.md? rm -rf ??x? ?y? ?');
    assert.equal(withFiles('New: {files}.', ['a.md', 'b.md']), 'New: a.md, b.md.');
    assert.equal(withFiles('New: {files}.', ['1', '2', '3', '4', '5', '6', '7']), 'New: 1, 2, 3, 4, 5 and 2 more.');
    assert.equal(withFiles('Look at the folder.', ['a.md']), 'Look at the folder.');
});

test('a wake-up is refused unless it is whole', (t) => {
    const b = bench(t);
    assert.throws(() => b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', message: '  ' }), /Write what is typed/);
    assert.throws(() => b.wakeups.add('worker', { kind: 'arrival', resource: 'elsewhere', message: 'go' }), /attached to this conversation/);
    assert.throws(() => b.wakeups.add('worker', { kind: 'every', minutes: 0, message: 'go' }), /whole number, 1 at least/);
    assert.throws(() => b.wakeups.add('worker', { kind: 'daily', at: '7h30', message: 'go' }), /Written like 07:30/);
    assert.throws(() => b.wakeups.add('worker', { kind: 'whenever', message: 'go' }), /an arrival, every so many minutes/);
    assert.throws(() => b.wakeups.add('nobody', { kind: 'every', minutes: 5, message: 'go' }), /No such conversation/);
    assert.throws(() => b.wakeups.setLimit('worker', -1), /whole number/);
    for (let i = 0; i < 8; i++) b.wakeups.add('worker', { kind: 'every', minutes: 5, message: 'go' });
    assert.throws(() => b.wakeups.add('worker', { kind: 'every', minutes: 5, message: 'go' }), /at most 8/);
});

test('an arrival: what was there wakes nobody; a new file does, once it has stopped being written', async (t) => {
    const b = bench(t);
    writeFileSync(join(b.dir, 'handoff', 'old.md'), 'there before');
    b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', quiet: 0, message: 'Arrived: {files}. Do them.' });
    await b.wakeups.tick(); await b.wakeups.tick();
    assert.deepEqual(b.typed, []);
    writeFileSync(join(b.dir, 'handoff', 'need-a-banner.md'), 'a ban');
    await b.wakeups.tick();
    assert.deepEqual(b.typed, [], 'seen once: it may still be written');
    appendFileSync(join(b.dir, 'handoff', 'need-a-banner.md'), 'ner, 1200x400');
    await b.wakeups.tick();
    assert.deepEqual(b.typed, [], 'it grew: still being written');
    await b.wakeups.tick();
    assert.deepEqual(b.typed, ['Arrived: need-a-banner.md. Do them.', 'Enter']);
    assert.deepEqual(b.warmed, ['worker'], 'its terminal is opened if it was not');
    await b.wakeups.tick(); await b.wakeups.tick();
    assert.equal(b.typed.length, 2, 'once');
    /* A file that was there and changes: only when asked for. */
    appendFileSync(join(b.dir, 'handoff', 'old.md'), ' and more');
    await b.wakeups.tick(); await b.wakeups.tick(); await b.wakeups.tick();
    assert.equal(b.typed.length, 2);
    const [first] = b.wakeups.of('worker').items;
    assert.match(first.last.what, /^Typed: Arrived: need-a-banner\.md/); assert.equal(first.last.ok, true);
    b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', onlyNew: false, quiet: 0, message: 'Something changed.' });
    await b.wakeups.tick();
    appendFileSync(join(b.dir, 'handoff', 'old.md'), ' and more again');
    await b.wakeups.tick(); await b.wakeups.tick();
    assert.deepEqual(b.typed.slice(2), ['Something changed.', 'Enter']);
});

test('a file rewritten ten times is one arrival: it is told once nothing has moved for as long as the owner said', async (t) => {
    const b = bench(t);
    b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', quiet: 30, message: 'Arrived: {files}.' });
    assert.equal(b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', message: 'x' }).items[1].quiet, 10, 'ten seconds unless said otherwise');
    b.wakeups.remove('worker', b.wakeups.of('worker').items[1].id);
    assert.throws(() => b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', quiet: 4000, message: 'x' }), /an hour at most/);
    await b.wakeups.tick();
    const second = (n) => { b.world.now = new Date(b.world.now.getTime() + n * 1000); };
    for (let i = 0; i < 10; i++) { appendFileSync(join(b.dir, 'handoff', 'report.md'), `part ${i}\n`); second(5); await b.wakeups.tick(); }
    assert.deepEqual(b.typed, [], 'it keeps moving');
    second(5); await b.wakeups.tick(); second(20); await b.wakeups.tick();
    assert.deepEqual(b.typed, [], 'still for 25 seconds: not yet');
    second(5); await b.wakeups.tick();
    assert.deepEqual(b.typed, ['Arrived: report.md.', 'Enter'], 'still for 30 seconds: told, once');
});

test('a commit in a repository is an arrival, told from the date of its journal alone', async (t) => {
    const b = bench(t);
    mkdirSync(join(b.dir, 'site', '.git', 'logs'), { recursive: true });
    writeFileSync(join(b.dir, 'site', '.git', 'logs', 'HEAD'), 'one\n');
    b.wakeups.add('worker', { kind: 'arrival', resource: 'site', quiet: 0, message: 'Arrived: {files}.' });
    await b.wakeups.tick(); await b.wakeups.tick();
    appendFileSync(join(b.dir, 'site', '.git', 'logs', 'HEAD'), 'two\n');
    await b.wakeups.tick(); await b.wakeups.tick();
    assert.deepEqual(b.typed, ['Arrived: new commits.', 'Enter']);
});

test('the clock: every so many minutes, and every day at a time, not caught up when missed', async (t) => {
    const b = bench(t);
    b.wakeups.add('worker', { kind: 'every', minutes: 30, message: 'Check the queue.' });
    b.wakeups.add('worker', { kind: 'daily', at: '07:30', message: 'Morning report.' });
    await b.wakeups.tick(); b.later(29); await b.wakeups.tick();
    assert.deepEqual(b.typed, []);
    b.later(1); await b.wakeups.tick(); await b.wakeups.tick();
    assert.deepEqual(b.typed, ['Check the queue.', 'Enter']);
    b.later(30); await b.wakeups.tick();                     /* 07:00 */
    b.later(30); await b.wakeups.tick(); await b.wakeups.tick(); /* 07:30 */
    assert.deepEqual(b.typed.slice(2), ['Check the queue.', 'Enter', 'Check the queue.', 'Enter', 'Morning report.', 'Enter']);
    /* The next day, the server was busy elsewhere until 08:00: the morning is not caught up. */
    b.wakeups.turn('worker', b.wakeups.of('worker').items[0].id, false);
    const before = b.typed.length;
    b.later(24 * 60 + 30); await b.wakeups.tick();
    assert.equal(b.typed.length, before);
    b.later(24 * 60 - 25); await b.wakeups.tick();            /* 07:35 the day after */
    assert.deepEqual(b.typed.slice(before), ['Morning report.', 'Enter']);
});

test('a cap an hour, which the owner sets and may remove; asleep, detached or off: nobody is woken', async (t) => {
    const b = bench(t);
    b.wakeups.add('worker', { kind: 'every', minutes: 1, message: 'Go.' });
    b.wakeups.setLimit('worker', 2);
    for (let i = 0; i < 4; i++) { b.later(1); await b.wakeups.tick(); }
    assert.equal(b.typed.length, 4, 'two wake-ups, each a line and Enter');
    assert.match(b.wakeups.of('worker').items[0].last.what, /Not sent: 2 wake-up\(s\) this hour already, the cap you set/);
    assert.equal(b.wakeups.of('worker').sentThisHour, 2);
    b.wakeups.setLimit('worker', 0);
    for (let i = 0; i < 5; i++) { b.later(1); await b.wakeups.tick(); }
    assert.equal(b.typed.length, 14, 'no cap');
    b.world.awake = [];
    b.later(5); await b.wakeups.tick();
    assert.equal(b.typed.length, 14, 'asleep: not woken');
    b.world.awake = ['worker']; b.world.runs = false;
    b.later(5); await b.wakeups.tick();
    assert.match(b.wakeups.of('worker').items[0].last.what, /Could not be typed/); assert.equal(b.wakeups.of('worker').items[0].last.ok, false);
    b.world.runs = true;
    const id = b.wakeups.of('worker').items[0].id;
    b.wakeups.turn('worker', id, false); b.later(5); await b.wakeups.tick();
    assert.equal(b.typed.length, 14, 'off');
    b.wakeups.remove('worker', id);
    assert.deepEqual(b.wakeups.of('worker').items, []);
    /* A folder taken back wakes nobody. */
    b.wakeups.add('worker', { kind: 'arrival', resource: 'handoff', quiet: 0, message: 'Arrived.' });
    await b.wakeups.tick();
    b.world.attached = ['site'];
    writeFileSync(join(b.dir, 'handoff', 'late.md'), 'x');
    await b.wakeups.tick(); await b.wakeups.tick(); await b.wakeups.tick();
    assert.equal(b.typed.length, 14);
    b.wakeups.forget('worker');
    assert.deepEqual(b.wakeups.of('worker'), { perHour: 12, items: [], sentThisHour: 0 });
});
