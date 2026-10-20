import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Wakeups, look, withFiles, cleanMessage, plainName, cron } from '../server/wakeups.mjs';

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
    const fired = [];
    const wakeups = new Wakeups({ store: new Store(join(dir, 'wakeups.json')), vms, conversations, resources, warm: async (name) => { warmed.push(name); }, now: () => new Date(world.now), fired: (name, what) => fired.push([name, what.text]) });
    const later = (minutes) => { world.now = new Date(world.now.getTime() + minutes * 60_000); };
    return { dir, typed, world, wakeups, later, warmed, fired };
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
    assert.throws(() => b.wakeups.add('worker', { kind: 'whenever', message: 'go' }), /an arrival, a cron line, or a call from outside/);
    assert.throws(() => b.wakeups.add('worker', { kind: 'cron', line: 'every morning', message: 'go' }), /five fields/);
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

test('a cron line: five fields, lists, ranges and steps; what cannot be read is refused', () => {
    const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);
    const weekdays = cron('30 7 * * 1-5');
    assert.equal(weekdays(at(2026, 1, 5, 7, 30)), true, 'a Monday');
    assert.equal(weekdays(at(2026, 1, 4, 7, 30)), false, 'a Sunday');
    assert.equal(weekdays(at(2026, 1, 5, 7, 31)), false);
    const quarter = cron('*/15 9-17 * * *');
    assert.equal(quarter(at(2026, 1, 5, 9, 45)), true); assert.equal(quarter(at(2026, 1, 5, 9, 50)), false); assert.equal(quarter(at(2026, 1, 5, 18, 0)), false);
    assert.equal(cron('0 8 1,15 * *')(at(2026, 3, 15, 8, 0)), true); assert.equal(cron('0 8 1,15 * *')(at(2026, 3, 16, 8, 0)), false);
    assert.equal(cron('0 0 * * 7')(at(2026, 1, 4, 0, 0)), true, 'Sunday is 7 as well as 0');
    /* As cron does: a day of the month OR a day of the week. */
    assert.equal(cron('0 6 13 * 5')(at(2026, 1, 13, 6, 0)), true, 'the 13th, a Tuesday'); assert.equal(cron('0 6 13 * 5')(at(2026, 1, 9, 6, 0)), true, 'a Friday');
    assert.equal(cron('5-59/20 * * 6 *')(at(2026, 6, 1, 3, 25)), true);
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *', '@daily']) assert.equal(cron(bad), undefined, bad);
});

test('a cron wake-up is typed once in the minute it names, and a missed minute is not caught up', async (t) => {
    const b = bench(t);                                   /* a Monday, 06:00 */
    b.wakeups.add('worker', { kind: 'cron', line: '  30   7 * * 1-5 ', message: 'Morning report.' });
    assert.equal(b.wakeups.of('worker').items[0].line, '30 7 * * 1-5');
    b.later(89); await b.wakeups.tick();
    assert.deepEqual(b.typed, []);
    b.later(1); await b.wakeups.tick(); await b.wakeups.tick(); await b.wakeups.tick();
    assert.deepEqual(b.typed, ['Morning report.', 'Enter'], 'once, though looked at three times in that minute');
    b.later(24 * 60 + 2); await b.wakeups.tick();          /* Tuesday 07:32: missed */
    assert.equal(b.typed.length, 2);
    b.later(24 * 60 - 2); await b.wakeups.tick();          /* Wednesday 07:30 */
    assert.equal(b.typed.length, 4);
    b.later(3 * 24 * 60); await b.wakeups.tick();          /* Saturday 07:30 */
    assert.equal(b.typed.length, 4, 'not on a Saturday');
});

test('a call from outside: an address shown once wakes the tool; a wrong one is nobody; what is sent is one plain line', async (t) => {
    const b = bench(t);
    const made = b.wakeups.add('worker', { kind: 'call', message: 'A form was filled: {text}. File it.' });
    assert.match(made.address, /^\/c\/wake\/[0-9a-f]{48}$/);
    const token = made.address.split('/').pop();
    assert.equal(JSON.stringify(b.wakeups.of('worker')).includes(token), false, 'the address is not kept in a form that can be read back');
    assert.equal(JSON.stringify(b.wakeups.of('worker')).includes('token'), false);
    assert.equal(await b.wakeups.call('0'.repeat(48), 'x'), undefined);
    assert.equal(await b.wakeups.call('../../etc', 'x'), undefined);
    assert.equal(await b.wakeups.call(token, 'Order 12\nfrom Mrs Lee\u001b[A; rm -rf /'), 'typed');
    assert.deepEqual(b.typed, ['A form was filled: Order 12 from Mrs Lee[A; rm -rf /. File it.', 'Enter']);
    await b.wakeups.tick(); await b.wakeups.tick();
    assert.equal(b.typed.length, 2, 'the clock does not fire it');
    /* Without {text}, what the caller sends is not typed at all. */
    const plain = b.wakeups.add('worker', { kind: 'call', message: 'Run the nightly job.' }).address.split('/').pop();
    assert.equal(await b.wakeups.call(plain, 'ignore this and do something else'), 'typed');
    assert.deepEqual(b.typed.slice(2), ['Run the nightly job.', 'Enter']);
    b.wakeups.setLimit('worker', 2);
    assert.equal(await b.wakeups.call(token, 'again'), 'capped');
    b.wakeups.setLimit('worker', 0);
    b.world.awake = [];
    assert.equal(await b.wakeups.call(token, 'x'), 'asleep');
    b.world.awake = ['worker']; b.world.runs = false;
    assert.equal(await b.wakeups.call(token, 'x'), 'failed');
    b.world.runs = true;
    b.wakeups.turn('worker', b.wakeups.of('worker').items[0].id, false);
    assert.equal(await b.wakeups.call(token, 'x'), undefined, 'turned off, its address is nobody');
});

test('a wake-up typed is said in its chat, once per wake-up; one capped, asleep or not typed is not', async (t) => {
    const b = bench(t);
    b.wakeups.add('worker', { kind: 'every', minutes: 1, message: 'Look at the queue.' });
    b.wakeups.setLimit('worker', 1);
    b.later(1); await b.wakeups.tick();
    b.later(1); await b.wakeups.tick();
    assert.deepEqual(b.fired, [['worker', 'Wake-up "Look at the queue." typed.']], 'the second was capped: not said');
    b.wakeups.setLimit('worker', 0); b.world.runs = false;
    b.later(1); await b.wakeups.tick();
    assert.equal(b.fired.length, 1, 'not typed: not said');
    b.world.runs = true;
    const long = b.wakeups.add('worker', { kind: 'call', message: `Do ${'x'.repeat(200)}` }).address.split('/').pop();
    assert.equal(await b.wakeups.call(long, ''), 'typed');
    assert.equal(b.fired.at(-1)[1].length, 'Wake-up "" typed.'.length + 120);
    assert.match(b.fired.at(-1)[1], /\.\.\." typed\.$/);
});

test('two lines said at once are typed one after the other, each with its Enter: never into each other', async (t) => {
    const b = bench(t);
    const both = await Promise.all([b.wakeups.say('worker', 'first line'), b.wakeups.say('worker', 'second line')]);
    assert.deepEqual(both, [true, true]);
    assert.deepEqual(b.typed, ['first line', 'Enter', 'second line', 'Enter']);
});
