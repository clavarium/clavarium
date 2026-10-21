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
