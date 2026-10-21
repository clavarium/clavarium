/* THE VM MANAGER, WATCHED (server/vmwatch.mjs): said when it does not answer;
   its daemon restarted once when stuck for minutes, never in a loop. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VmWatch } from '../server/vmwatch.mjs';

function bench({ answers = true } = {}) {
    const calls = []; const items = new Map(); const told = [];
    let clock = Date.parse('2026-10-19T12:00:00Z');
    const host = { answers, revive: 0 };
    const store = { get: (n) => (items.has(n) ? { ...items.get(n) } : undefined), put: (x) => { items.set(x.name, { ...x }); } };
    const run = async (argv) => {
        calls.push(argv.join(' '));
        if (argv[1] === 'ping') return host.answers ? { code: 0, stdout: '' } : { code: 124, stderr: 'timed out' };
        if (argv[1] === 'revive') { host.revive += 1; host.answers = true; return { code: 0 }; }
        return { code: 64 };
    };
    const w = new VmWatch({ run, store, now: () => clock, log: () => {}, alert: (p) => told.push(p.title) });
    return { w, calls, host, told, later: (min) => { clock += min * 60_000; } };
}

test('the VM manager answers: nothing done, nothing said', async () => {
    const b = bench();
    assert.equal(await b.w.look(), 'ok');
    assert.equal(b.w.ok, true);
    assert.deepEqual(b.calls, ['vm ping']);
});

test('stuck for ten minutes: its daemon restarted once, recorded, the owner told; never again within hours', async () => {
    const b = bench({ answers: false });
    assert.equal(await b.w.look(), 'down');
    assert.equal(b.w.ok, false, 'the pages are told');
    b.later(3);
    assert.equal(await b.w.look(), 'down');
    b.later(3);
    assert.equal(await b.w.look(), 'down', 'six minutes: not yet (a restart drops every terminal)');
    b.later(5);
    assert.equal(await b.w.look(), 'revived');
    assert.equal(b.host.revive, 1);
    assert.match(b.w.last().why, /did not answer for 11 minutes/);
    assert.equal(b.w.last().result, 'done');
    assert.deepEqual(b.told, ['The machines could not be reached']);
    assert.equal(await b.w.look(), 'ok');
    assert.equal(b.w.ok, true);
    /* Stuck again an hour later: said, not restarted again. */
    b.host.answers = false;
    b.later(60);
    await b.w.look(); b.later(10);
    assert.equal(await b.w.look(), 'down; restarted already');
    assert.equal(b.host.revive, 1);
    /* Hours later, it may be once more. */
    b.later(6 * 60);
    assert.equal(await b.w.look(), 'revived');
    assert.equal(b.host.revive, 2);
});
