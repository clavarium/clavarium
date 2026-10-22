/* When updates happen, as Settings says it (server/updates.mjs, schedule). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, LOOK_EVERY_MS, ASK_EVERY_MS } from '../server/updates.mjs';

const at = (h, m = 0) => new Date(2026, 9, 21, h, m);

test('automatic: outside the window, when it opens; inside, the next look and when it closes; a window over midnight', () => {
    const out = schedule({ mode: 'auto', window: '02:00-05:00', lastLookAt: at(10).getTime() - 5 * 60_000, now: at(10) });
    assert.equal(out.inWindow, false);
    assert.equal(out.windowOpensAt, at(26).getTime(), 'tomorrow at 2');
    assert.equal(out.nextLookAt, at(10).getTime() + 10 * 60_000);
    const inside = schedule({ mode: 'auto', window: '22:00-03:00', lastLookAt: null, now: at(23) });
    assert.equal(inside.inWindow, true);
    assert.equal(inside.windowOpensAt, null);
    assert.equal(inside.windowClosesAt, at(27).getTime(), 'closes after midnight');
    assert.equal(inside.nextLookAt, null, 'not known: "in a few minutes"');
});

test('as soon as out: the next look; ask: the registry asked every six hours; a look that is late is not said in the past', () => {
    assert.equal(schedule({ mode: 'asap', window: '02:00-05:00', lastLookAt: at(10).getTime(), now: at(10, 5) }).nextLookAt, at(10).getTime() + LOOK_EVERY_MS);
    assert.equal(schedule({ mode: 'asap', window: '02:00-05:00', lastLookAt: at(9).getTime(), now: at(10) }).nextLookAt, null);
    assert.equal(schedule({ mode: 'ask', window: '02:00-05:00', checkedAt: at(9).getTime(), now: at(10) }).askNextAt, at(9).getTime() + ASK_EVERY_MS);
    assert.equal(schedule({ mode: 'off', window: '02:00-05:00', now: at(10) }).windowOpensAt, undefined);
});

test('what became of the relay at the updater\'s last turn is said with the rest; anything else in that file is not', async (t) => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { Updates } = await import('../server/updates.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'clv-relay-state-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: '0.2.18' }));
    writeFileSync(join(dir, 'update.conf'), 'MODE=auto\n');
    const u = new Updates({ host: async () => ({ code: 0 }), version: '0.2.18', stateFile: join(dir, 'state.json'), confFile: join(dir, 'update.conf'), lastLook: () => null });
    assert.equal(u.about().relay, null, 'nothing said yet');
    writeFileSync(join(dir, 'relay.json'), JSON.stringify({ state: 'refused', version: '0.1.1', why: 'the relay does not take this server\'s maintenance key', at: '2026-10-22T20:00:00.000Z' }));
    assert.deepEqual(u.about().relay, { state: 'refused', version: '0.1.1', why: 'the relay does not take this server\'s maintenance key', at: '2026-10-22T20:00:00.000Z' });
    writeFileSync(join(dir, 'relay.json'), JSON.stringify({ state: '<script>' }));
    assert.equal(u.about().relay, null, 'a state it does not know: nothing');
});
