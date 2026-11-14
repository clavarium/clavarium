/* THE BAR OF A CONVERSATION ON A PHONE (13-11): its five buttons -- chat, terminal, assets with their count, its
   binders, its settings -- all within the screen, the settings never cut off; its name gives way, never the bar. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('on a phone, the bar of a conversation stays within the screen, its settings button whole', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('clavarium-dev');
    const page = me.page;
    for (const width of [320, 360, 390]) {
        await page.setViewportSize({ width, height: 780 });
        /* As with a binder given, 24 assets, and 2 jobs under way (14-11). */
        await page.evaluate(() => { document.getElementById('view-lists').hidden = false; document.getElementById('folders').hidden = false; document.getElementById('assets-count').textContent = '24'; const j = document.getElementById('jobs-room'); j.hidden = false; j.textContent = '2'; document.getElementById('back').dataset.jobs = 'on'; });
        await me.until('the bar laid out', async () => page.locator('#folders').isVisible());
        const right = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#room > header *')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().right)));
        assert.ok(right <= width, `${width}px: the bar ends at ${Math.round(right)}px`);
        const name = await page.evaluate(() => document.getElementById('name').getBoundingClientRect().width);
        if (process.env.HEADER_SHOTS) await page.locator('#room > header').screenshot({ path: `${process.env.HEADER_SHOTS}/header-${width}.png` });
        assert.ok(name >= 40, `${width}px: its name still shows a little (${Math.round(name)}px)`);
    }
    assert.deepEqual(me.errors, []);
});
