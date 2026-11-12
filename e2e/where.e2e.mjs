/* WHERE A CONVERSATION LIVES (#221), at its creation: its own machine (the default, as always) or a shared one --
   a machine name asked then (and, for a new one, its memory), its files always kept here (that choice hidden); a name that is not one refused here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

test('the creation form: its own machine by default; a shared one asks its name and hides where its files go', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.page.locator('#new').click();
    await me.until('the form', async () => me.page.locator('#newconv').isVisible());
    assert.equal(await me.page.locator('#newconv-where [data-where="own"]').getAttribute('aria-checked'), 'true');
    assert.equal(await me.page.locator('#newconv-machine-row').isVisible(), false);
    assert.equal(await me.page.locator('#newconv-files-card').isVisible(), true);
    await me.page.locator('#newconv-where [data-where="shared"]').click();
    assert.equal(await me.page.locator('#newconv-machine-row').isVisible(), true);
    assert.equal(await me.page.locator('#newconv-files-card').isVisible(), false, 'its files always kept here');
    await me.page.fill('#newconv-name', 'Mail');
    await me.page.fill('#newconv-machine', 'Not A Name');
    await me.page.locator('#newconv-create').click();
    await me.until('refused here', async () => /lower-case/.test(await me.page.locator('#newconv-machine-error').innerText().catch(() => '')));
    await me.page.fill('#newconv-machine', 'assistants');
    /* A new machine: its memory asked, 4 GB unless changed. */
    assert.equal(await me.page.locator('#newconv-machine-mb-row').isVisible(), true);
    assert.equal(await me.page.locator('#newconv-machine-mb').inputValue(), '4096');
    if (process.env.WHERE_SHOTS) for (const [w, h, name] of [[1280, 900, 'desktop'], [900, 1200, 'tablet'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const theme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
            await me.page.locator('#newconv-where-card').scrollIntoViewIfNeeded();
            await me.page.locator('#newconv-where-card').screenshot({ path: join(process.env.WHERE_SHOTS, `where-${name}-${theme}.png`) });
        }
    }
    await me.page.locator('#newconv-where [data-where="own"]').click();
    assert.equal(await me.page.locator('#newconv-files-card').isVisible(), true, 'back to its own: the choice of its files again');
    assert.deepEqual(me.errors, []);
});
