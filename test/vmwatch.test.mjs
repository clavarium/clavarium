/* THE VM MANAGER, WATCHED (server/vmwatch.mjs): said when it does not answer;
   its daemon restarted once when stuck for minutes, never in a loop. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VmWatch } from '../server/vmwatch.mjs';

function bench({ answers = true, hour = 3, mode } = {}) {
    const calls = []; const items = new Map(); const told = [];
    let clock = Date.parse('2026-10-19T12:00:00Z');
    const host = { answers, revive: 0, hour };
    const store = { get: (n) => (items.has(n) ? { ...items.get(n) } : undefined), put: (x) => { items.set(x.name, { ...x }); }, remove: (n) => { items.delete(n); } };
    const run = async (argv) => {
        calls.push(argv.join(' '));
        if (argv[1] === 'ping') return host.answers ? { code: 0, stdout: '' } : { code: 124, stderr: 'timed out' };
        if (argv[1] === 'revive') { host.revive += 1; host.answers = true; return { code: 0 }; }
        return { code: 64 };
    };
    const w = new VmWatch({ run, store, now: () => clock, hour: () => host.hour, log: () => {}, alert: (p) => told.push(p) });
    if (mode) w.setMode(mode);
    return { w, calls, host, told, later: (min) => { clock += min * 60_000; } };
}

test('the VM manager answers: nothing done, nothing said', async () => {
    const b = bench();
    assert.equal(await b.w.look(), 'ok');
    assert.equal(b.w.ok, true);
    assert.deepEqual(b.calls, ['vm ping']);
    assert.equal(b.w.mode(), 'night', 'the default');
});

test('hung at night (the default): its daemon restarted once, recorded, the owner told; never again within hours', async () => {
    const b = bench({ answers: false, hour: 3 });
    assert.equal(await b.w.look(), 'down');
    assert.equal(b.w.ok, false, 'the pages are told');
    b.later(1);
    assert.equal(await b.w.look(), 'down', 'one minute: not yet (a restart drops every terminal)');
    b.later(1);
    assert.equal(await b.w.look(), 'revived');
    assert.equal(b.host.revive, 1);
    assert.match(b.w.last().why, /did not answer for 2 minutes/);
    assert.deepEqual([b.w.last().result, b.w.last().by], ['done', 'server']);
    assert.deepEqual(b.told.map((x) => x.title), ['The machines could not be reached']);
    assert.equal(await b.w.look(), 'ok');
    /* Stuck again an hour later: said, not restarted again. */
    b.host.answers = false;
    b.later(60);
    await b.w.look(); b.later(3);
    assert.equal(await b.w.look(), 'down; restarted already');
    assert.equal(b.host.revive, 1);
    /* Hours later, it may be once more. */
    b.later(6 * 60);
    assert.equal(await b.w.look(), 'revived');
    assert.equal(b.host.revive, 2);
});

test('hung by day (night): its owner asked once, with the way to do it; restarted by hand, confirmed in the page', async () => {
    const b = bench({ answers: false, hour: 14 });
    await b.w.look(); b.later(2);
    assert.equal(await b.w.look(), 'asked');
    assert.equal(b.host.revive, 0, 'never by itself by day');
    assert.equal(b.told[0].title, 'The machine manager is stuck');
    assert.equal(b.told[0].url, '/?open=settings&at=machines');
    b.later(5);
    assert.equal(await b.w.look(), 'down; asked already', 'asked once a hang');
    assert.equal(b.told.length, 1);
    assert.ok(b.w.about().asked, 'the page shows it waits for its owner');
    const about = await b.w.revive();
    assert.equal(b.host.revive, 1);
    assert.deepEqual([about.last.by, about.last.result, about.asked], ['owner', 'done', null]);
    assert.equal(await b.w.look(), 'ok');
    /* By hand, it is the owner's call: again at once if asked. */
    await b.w.revive();
    assert.equal(b.host.revive, 2);
});

test('per setting: always restarts by day; ask never by itself, even at night; anything else refused', async () => {
    const a = bench({ answers: false, hour: 14, mode: 'always' });
    await a.w.look(); a.later(2);
    assert.equal(await a.w.look(), 'revived');
    const n = bench({ answers: false, hour: 3, mode: 'ask' });
    await n.w.look(); n.later(2);
    assert.equal(await n.w.look(), 'asked');
    assert.equal(n.host.revive, 0);
    assert.throws(() => n.w.setMode('sometimes'), /night, always or ask/);
    assert.equal(n.w.mode(), 'ask');
});
