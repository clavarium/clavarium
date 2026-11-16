/* Its tool started again when a folder it was in came loose, or when it asks from outside /work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Revive, WAIT_MS, AGAIN_MS } from '../server/revive.mjs';
import { RESTART_OUTSIDE } from '../server/health.mjs';
import { ownText } from '../server/guide.mjs';

const well = { state: 'Running', answering: true };
function make({ busy = false, ok = true } = {}) {
    let now = 1_000_000;
    const said = []; const restarted = []; const taken = [];
    const box = { busy };
    const revive = new Revive({
        restart: async (name) => { restarted.push(name); return ok; },
        busy: () => box.busy,
        tell: (name, why, step) => said.push(`${name} ${why} ${step}`),
        taken: async (name) => { taken.push(name); },
        now: () => now,
    });
    return { revive, said, restarted, taken, box, advance: (ms) => { now += ms; } };
}

test('a stale tool is restarted at the next tick, its docket told before, its chat after', async () => {
    const m = make();
    m.revive.judged('demo', { ...well, stale: true });
    assert.deepEqual(await m.revive.tick(), ['demo']);
    assert.deepEqual(m.said, ['demo stale before', 'demo stale done']);
    assert.deepEqual(await m.revive.tick(), [], 'once');
});

test('busy, a stale tool waits for its turn to end, but not longer than WAIT_MS (its pulse is in the dead folder)', async () => {
    const m = make({ busy: true });
    m.revive.judged('demo', { ...well, stale: true });
    assert.deepEqual(await m.revive.tick(), []);
    m.advance(WAIT_MS);
    m.revive.judged('demo', { ...well, stale: true });
    assert.deepEqual(await m.revive.tick(), ['demo']);
});

test('a look that finds it well forgets it; a machine that does not run or answer changes nothing', async () => {
    const m = make({ busy: true });
    m.revive.judged('demo', { ...well, stale: true });
    m.revive.judged('demo', { state: 'Suspended', stale: false });
    assert.equal(m.revive.wanted('demo'), 'stale');
    m.revive.judged('demo', well);
    assert.equal(m.revive.wanted('demo'), null);
});

test('never a loop: not again within AGAIN_MS; a failure is said', async () => {
    const m = make({ ok: false });
    m.revive.judged('demo', { ...well, stale: true });
    assert.deepEqual(await m.revive.tick(), []);
    assert.deepEqual(m.said, ['demo stale before', 'demo stale failed']);
    m.revive.judged('demo', { ...well, stale: true });
    await m.revive.tick();
    assert.equal(m.restarted.length, 1);
    m.advance(AGAIN_MS);
    m.revive.judged('demo', { ...well, stale: true });
    await m.revive.tick();
    assert.equal(m.restarted.length, 2);
});

test('asked from outside /work: its request taken away, restarted once its turn ends', async () => {
    const m = make({ busy: true });
    m.revive.judged('demo', { ...well, restartAsked: true });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(m.taken, ['demo']);
    m.advance(WAIT_MS * 3);
    assert.deepEqual(await m.revive.tick(), [], 'a plain request waits for its turn to end');
    m.box.busy = false;
    assert.deepEqual(await m.revive.tick(), ['demo']);
    assert.deepEqual(m.said, ['demo asked before', 'demo asked done']);
});

test('the guide tells a tool where to ask when /work itself fails', () => {
    assert.ok(ownText({ name: 'demo', tool: 'Claude Code', workKept: true, chat: true }).includes(`touch ${RESTART_OUTSIDE}`));
});
