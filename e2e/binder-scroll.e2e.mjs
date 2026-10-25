import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';
/* A binder longer than the screen scrolls in its tab: its last card can be reached (they were cut off, 25-10). */
test('a long binder scrolls in its tab, to its last card', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 760 });
    await me.create('coder');
    await page.locator('#view-terminal').click();
    await me.type('clear; export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; binder new batches >/dev/null && for i in $(seq 1 14); do binder add Batches "Batch number $i" --description "What batch $i is, in a line." >/dev/null; done; echo rows-ok');
    await me.printed('rows-ok', 60_000);
    await page.locator('#view-lists').click();
    await page.waitForTimeout(3000);
    const info = await page.evaluate(() => { const h = document.getElementById('clists-binder'); h.scrollTop = 99999; const rows = [...document.querySelectorAll('#clists .binder-row')]; const last = rows.at(-1)?.getBoundingClientRect(); return { rows: rows.length, scrollH: h.scrollHeight, clientH: h.clientHeight, lastBottom: last?.bottom, view: innerHeight }; });
    assert.equal(info.rows, 14);
    assert.ok(info.scrollH > info.clientH, 'it scrolls');
    assert.ok(info.lastBottom <= info.view, 'the last card on the screen once scrolled');
});
