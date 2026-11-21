/* COPY OR MOVE (#221, 14-11): from a conversation's Settings, Resources, Machine, « Where it runs » and Copy...: a
   wizard over the page -- copy or move, and where (its own machine, a shared one there, a new one); then what goes
   and what does not. A move from its own machine is not offered its own machine again, and says its machine is
   deleted. Copy it: the wizard closes at once, the person stays where they are, the copy is « under way »; at its
   end, one line, « Copy ready », whose « Open it » opens the copy. With WIZARD_SHOTS set (a folder), pictures of
   each screen, on a desktop and a phone, light and dark. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const SHOTS = process.env.WIZARD_SHOTS ?? '';

test('Copy...: the wizard, its own machine, the copy under way, then « Copy ready » opens it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await me.create('mail', 'Shell', { chat: false });
    /* Its tool's memory, as its machine (the test's fake host) keeps it: what a copy reads. */
    const home = join(b.dir, 'vms', 'clv-mail', 'root', 'home', 'ubuntu');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.bash_history'), 'make deploy\n');
    /* Another one seen living in the shared machine assist (the fake host makes no shared machine); the theme
       follows the device, for pictures in both. */
    await page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const list = await (await route.fetch()).json();
        const mine = list.find((c) => c.name === 'mail');
        if (mine) list.push({ ...mine, name: 'diary', title: 'Diary', sharedMachine: 'assist', machineMb: 6144 });
        await route.fulfill({ json: list });
    });
    await page.evaluate(() => localStorage.setItem('clavarium-theme', 'system'));
    await page.reload();
    await me.until('mail open again', async () => (await page.locator('#name').innerText().catch(() => '')) === 'mail');
    const shots = async (label) => {
        if (!SHOTS) return;
        mkdirSync(SHOTS, { recursive: true });
        for (const [w, h] of [[1280, 800], [390, 800]]) {
            await page.setViewportSize({ width: w, height: h });
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                await page.waitForTimeout(300);
                await page.screenshot({ path: join(SHOTS, `${label}-${w}-${colorScheme}.png`) });
            }
        }
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.emulateMedia({ colorScheme: 'dark' });
    };

    await page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('where it runs', async () => page.locator('#where-row').isVisible());
    assert.equal(await page.locator('#where-now').innerText(), 'Its own machine');

    /* Screen 1: Copy chosen, its own machine first; the shared machine there, who lives in it, its memory. */
    await page.locator('#where-copy').click();
    await me.until('the wizard open', async () => page.locator('#cm').isVisible());
    assert.equal(await page.locator('#cm .cm-kinds [aria-checked="true"]').getAttribute('data-kind'), 'copy');
    assert.deepEqual(await page.locator('#cm-places .cm-card').allInnerTexts(), ['Its own machine', 'Shared machine « assist »\nWith Diary · 6 GB', 'A new shared machine']);
    assert.equal(await page.locator('#cm-places [aria-checked="true"]').getAttribute('data-place'), '');
    await shots('screen1-copy');

    /* A move from its own machine: never to its own machine again; checked, its own machine said deleted. */
    await page.locator('#cm .cm-card[data-kind="move"]').click();
    assert.deepEqual(await page.locator('#cm-places .cm-card').evaluateAll((x) => x.map((c) => c.dataset.place)), ['assist', 'new']);
    await shots('screen1-move');
    await page.locator('#cm-next').click();
    await me.until('its check', async () => page.locator('#cm-move-part').isVisible());
    assert.match(await page.locator('#cm-title').innerText(), /^Move mail into « assist »$/);
    assert.match(await page.locator('#cm-move-part').innerText(), /Its own machine is deleted/);
    assert.equal(await page.locator('#cm-go').innerText(), 'Move it');
    await shots('screen2-move');
    await page.locator('#cm-back').click();
    /* A new shared machine with no name: said, not sent. */
    await page.locator('#cm-places .cm-card[data-place="new"]').click();
    await page.locator('#cm-next').click();
    assert.equal(await page.locator('#cm-why').innerText(), 'Name the shared machine first');

    /* Back to Copy, its own machine: screen 2, its name, what goes and what does not. */
    await page.locator('#cm .cm-card[data-kind="copy"]').click();
    await page.locator('#cm-places .cm-card[data-place=""]').click();
    await page.locator('#cm-next').click();
    await me.until('its check', async () => page.locator('#cm-copy-part').isVisible());
    assert.equal(await page.locator('#cm-copy-title').inputValue(), 'mail (copy)');
    assert.equal(await page.locator('#cm-title').innerText(), 'Copy mail to its own machine');
    assert.deepEqual(await page.locator('#cm-copy-part .cm-goes li').allInnerTexts(), ['Its work folder', 'Its AI\'s memory', 'Its accesses']);
    assert.equal(await page.locator('#cm-move-part').isVisible(), false);
    await shots('screen2-copy');

    /* Copy it: closed at once, still here, the copy under way. */
    await page.locator('#cm-go').click();
    await me.until('the wizard closed', async () => !(await page.locator('#cm').isVisible()), 3000);
    assert.equal(await page.locator('#name').innerText(), 'mail');
    await me.until('the copy under way', async () => /under way/.test(await page.locator('#jobs-open').innerText().catch(() => '')) || (await page.locator('#jobs-room').isVisible()), 15_000);
    /* Its end: one line, « Copy ready »; « Open it » opens the copy. */
    await me.until('the copy ready', async () => page.locator('#cm-toast').isVisible(), 120_000);
    const said = await page.locator('#cm-toast').innerText();
    if (!/✓ Copy ready/.test(said)) assert.fail(`${said}: ${JSON.stringify((await me.api('/api/jobs')).body.done)}`);
    assert.match(said, /Open it/);
    await shots('toast');
    await page.locator('#cm-toast-go').click();
    await me.until('the copy open', async () => (await page.locator('#name').innerText().catch(() => '')) === 'mail (copy)', 20_000);
    assert.equal(await page.locator('#cm-toast').isVisible(), false);
    assert.deepEqual(me.errors, []);
});
