import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clausesOf, trimmed, GAP_S, POCKET_SHA256 } from '../server/pocket.mjs';

test('Pocket TTS is said clause by clause, a longer silence after a sentence than after a comma', () => {
    assert.deepEqual(clausesOf('Bonjour ! Il est huit heures, dimanche. La messe : dix heures…'), [
        { text: 'Bonjour !', gap: GAP_S.sentence }, { text: 'Il est huit heures,', gap: GAP_S.comma }, { text: 'dimanche.', gap: GAP_S.sentence },
        { text: 'La messe :', gap: GAP_S.pause }, { text: 'dix heures…', gap: GAP_S.sentence },
    ]);
    assert.deepEqual(clausesOf(' ... , '), []);
    assert.equal(POCKET_SHA256.x64.length, 64);
});

test('the quiet at both ends of a clause is cut, a little kept', () => {
    const pcm = Buffer.alloc(2 * 10_000); for (let i = 5000; i < 6000; i++) pcm.writeInt16LE(3000, i * 2);
    const t = trimmed(pcm);
    assert.equal(t.length / 2, 800 + 1000 + 1600 - 1);
    assert.equal(trimmed(Buffer.alloc(100)).length, 0);
});

test('Pocket is never waited for: not ready, it says so at once and gets ready behind', async () => {
    const { Pocket } = await import('../server/pocket.mjs');
    let fetched = 0;
    const p = new Pocket({ dir: '/nonexistent-dir-for-test', fetcher: async () => { fetched++; await new Promise((r) => setTimeout(r, 50)); return { ok: false, status: 503 }; }, log: () => {} });
    const t = Date.now();
    await assert.rejects(p.speak('Bonjour.'), /getting ready/);
    assert.ok(Date.now() - t < 40, 'at once');
});
