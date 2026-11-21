/* THE TAB OF A CONVERSATION'S SETTINGS STAYS (14-11): opened again with its button, they show the tab the person
   was on -- not Access each time, as they did (« I am on Resources, and pof, it moves to Access by itself »). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('the settings button opens the tab the person was on; the first time, Access', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('helper');
    const page = me.page;
    const tab = () => page.locator('#panel').getAttribute('data-tab');
    await page.locator('#folders').click();
    await me.until('its settings, on Access the first time', async () => (await tab()) === 'access');
    await page.locator('#panel .settings-tabs button[data-group="resources"]').click();
    await me.until('on Resources', async () => (await tab()) === 'resources');
    await page.locator('#view-terminal').click();
    await page.locator('#folders').click();
    await me.until('its settings shown again', async () => page.locator('#panel').isVisible());
    await page.waitForTimeout(800);
    assert.equal(await tab(), 'resources', 'the tab it was on');
    assert.deepEqual(me.errors, []);
});
