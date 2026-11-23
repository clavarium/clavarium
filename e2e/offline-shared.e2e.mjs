/* OFFLINE NEEDS ITS OWN MACHINE (#410): in a shared machine its button is off, and says why; in its own, it works. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('offline is greyed out in a shared machine, and works in its own', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const errors = []; me.page.on('pageerror', (e) => errors.push(e.message));
    await me.create('alone', 'Shell', { chat: false });
    await me.page.locator('#folders').click();
    await me.chapter('access');
    const off = me.page.locator('#network [data-online="false"]');
    await me.until('the button is shown', () => off.isVisible());
    assert.equal(await off.isDisabled(), false);
    assert.equal(await me.page.locator('#network-shared').isVisible(), false);
    /* The fake host makes no shared machine: it is seen living in one. */
    await me.page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const r = await route.fetch(); const list = await r.json();
        await route.fulfill({ response: r, json: list.map((c) => (c.name === 'alone' ? { ...c, sharedMachine: 'common', machineMb: 6144 } : c)) });
    });
    await me.page.reload();
    await me.page.locator('#folders').click();
    await me.chapter('access');
    await me.until('it is off, and says why', async () => (await off.isDisabled()) && (await me.page.locator('#network-shared').isVisible()));
    assert.match(await me.page.locator('#network-shared').innerText(), /own machine/);
    for (const width of [1280, 820, 390]) {
        await me.page.setViewportSize({ width, height: 800 });
        await me.page.waitForTimeout(500);
        const over = await me.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `${width}: sideways scroll of ${over} px`);
    }
    assert.deepEqual(errors, [], 'no error on the page');
});
