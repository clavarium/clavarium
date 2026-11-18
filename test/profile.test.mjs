/* What holds this server, from its own profiler (server/profile.mjs; Settings, Load, Measure). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, placeOf, Profiler } from '../server/profile.mjs';

const node = (id, functionName, url, lineNumber, children = []) => ({ id, callFrame: { functionName, url, lineNumber }, children });

test('a profile told in short: idle, gc and program apart; self and with what they call, the most first', () => {
    const profile = {
        nodes: [
            node(1, '(root)', '', -1, [2, 3, 4, 5]),
            node(2, '(idle)', '', -1),
            node(3, '(garbage collector)', '', -1),
            node(4, 'tick', 'file:///srv/app/node_modules/clavarium/server/talk.mjs', 9, [6]),
            node(5, '(program)', '', -1),
            node(6, 'readFileSync', 'node:fs', 440, [7]),
            node(7, 'parse', '', -1),
        ],
        samples: [2, 2, 3, 4, 6, 6, 6, 7, 5],
        timeDeltas: [1000, 1000, 2000, 3000, 4000, 4000, 4000, 5000, 1000],
    };
    const s = summarize(profile, 10);
    assert.equal(s.sampledMs, 25); assert.equal(s.idleMs, 2); assert.equal(s.gcMs, 2); assert.equal(s.programMs, 1);
    assert.deepEqual(s.self[0], { fn: 'readFileSync', at: 'node:fs:441', ms: 12 });
    assert.deepEqual(s.total[0], { fn: 'tick', at: 'clavarium/server/talk.mjs:10', ms: 20 }, 'its own time and all it called');
    assert.equal(s.total.find((f) => f.fn === 'readFileSync').ms, 17);
    assert.ok(!s.self.some((f) => f.fn.startsWith('(idle')), 'idle is not a function');
});

test('a place is short: a package by its name, a file outside by its name only', () => {
    assert.equal(placeOf('file:///opt/x/node_modules/ws/lib/websocket.js', 3), 'ws/lib/websocket.js:4');
    assert.equal(placeOf('/somewhere/else/thing.mjs', 0), 'thing.mjs:1');
    assert.equal(placeOf('', -1), '');
});

test('one measure at a time, bounded; the session closed after', async () => {
    const said = []; let disconnected = 0; let waited = 0; let release;
    const session = () => ({
        connect() {}, disconnect() { disconnected += 1; },
        async post(method) { said.push(method); return method === 'Profiler.stop' ? { profile: { nodes: [node(1, '(root)', '', -1)], samples: [], timeDeltas: [] } } : {}; },
    });
    const p = new Profiler({ session, wait: (ms) => { waited = ms; return new Promise((ok) => { release = ok; }); } });
    const a = p.profile(999); const b = p.profile(5);
    assert.equal(a, b, 'asked again meanwhile: the same');
    await new Promise((ok) => setImmediate(ok));
    assert.equal(waited, 30_000, 'at most 30 s');
    release();
    const r = await a;
    assert.equal(r.seconds, 30); assert.equal(typeof r.cpuMs, 'number');
    assert.deepEqual(said, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop', 'Profiler.disable']);
    assert.equal(disconnected, 1);
});

test('the real profiler answers in-process (a short measure)', async () => {
    const r = await new Profiler().profile(2);
    assert.equal(r.seconds, 2);
    assert.ok(r.sampledMs > 1000, `sampled ${r.sampledMs} ms`);
    assert.ok(r.idleMs > 0);
});

test('measured by itself: only when the loop is slow, at most once in 30 min, the last 5 kept with why', async () => {
    const { AutoProfile, AUTO_EVERY_MS, AUTO_KEPT } = await import('../server/profile.mjs');
    let now = Date.parse('2026-11-18T05:00:00Z'); let delay = { p50: 20, p99: 30 }; let measured = 0;
    let stored = {};
    const file = { get: () => structuredClone(stored), set: (v) => { stored = structuredClone(v); } };
    const profiler = { profile: async (s) => { measured += 1; return { seconds: s, cpuMs: 9000, self: [{ fn: 'tick', at: 'server/talk.mjs:10', ms: 8000 }], total: [] }; } };
    const auto = new AutoProfile({ profiler, file, now: () => now, delay: () => delay, log: () => {} });
    assert.equal(await auto.check(), null, 'a quick loop: nothing');
    delay = { p50: 950, p99: 1100 };
    const first = await auto.check();
    assert.equal(first.why, 'loop p50 950 ms, p99 1100 ms over the last minute');
    assert.equal(first.at, '2026-11-18T05:00:00.000Z');
    now += 60_000;
    assert.equal(await auto.check(), null, 'not again before 30 min');
    for (let i = 0; i < AUTO_KEPT + 2; i++) { now += AUTO_EVERY_MS; await auto.check(); }
    assert.equal(measured, AUTO_KEPT + 3);
    assert.equal(auto.kept().length, AUTO_KEPT, 'the last 5 only');
    assert.ok(auto.kept()[0].at > auto.kept()[1].at, 'the newest first');
    const again = new AutoProfile({ profiler, file, now: () => now + 60_000, delay: () => delay, log: () => {} });
    assert.equal(await again.check(), null, 'after a restart, the last measure still counts');
});
