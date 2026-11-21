import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* On a wide screen, a pick in the list column that changes the right pane folds the list,
   as opening a conversation does; pinned, it stays open. */
test('List fold: Settings in the nav folds the open list on a wide screen; pinned, it stays', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const state = () => page.evaluate(() => document.getElementById('app').dataset.list ?? '');
    await page.evaluate(() => { localStorage.setItem('clavarium-list-pin', 'off'); localStorage.setItem('clavarium-list', 'open'); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await me.until('the nav', async () => page.locator('#nav-settings').isVisible(), 30_000);
    assert.notEqual(await state(), 'folded', 'the list starts open');
    await page.locator('#nav-settings').click();
    await me.until('the list folded', async () => (await state()) === 'folded', 10_000);

    /* Another page, the list pinned: Settings leaves it open. */
    const two = await b.person();
    const q = two.page;
    await q.setViewportSize({ width: 1280, height: 800 });
    await q.evaluate(() => { localStorage.setItem('clavarium-list-pin', 'on'); localStorage.setItem('clavarium-list', 'open'); });
    await q.reload({ waitUntil: 'domcontentloaded' });
    await two.until('the nav, pinned', async () => (await q.locator('#nav-settings').isVisible()) && (await q.locator('#list-pin').getAttribute('aria-pressed')) === 'true', 30_000);
    await q.locator('#nav-settings').click();
    await two.until('settings shown', async () => (await q.locator('#nav-settings').getAttribute('aria-current')) === 'page', 10_000);
    assert.notEqual(await q.evaluate(() => document.getElementById('app').dataset.list ?? ''), 'folded', 'pinned, the list stays open');
});
