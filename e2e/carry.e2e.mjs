/* A CONVERSATION'S TOOL MEMORY CARRIED ELSEWHERE (11-11, #351), from its settings: Export downloads one file (what
   its tool keeps, where its entry says); Import puts it into another conversation of the same tool, asked first,
   its tool restarted. The machine is the test's (fake host): the server's own scripts run in its home. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const homeOf = (b, name) => join(b.dir, 'vms', `clv-${name}`, 'root', 'home', 'ubuntu');

test('its tool memory: exported from its settings as one file, imported into another conversation of the same tool', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.create('first', 'Shell', { chat: false });
    mkdirSync(homeOf(b, 'first'), { recursive: true });
    writeFileSync(join(homeOf(b, 'first'), '.bash_history'), 'make deploy\n');
    writeFileSync(join(homeOf(b, 'first'), 'not-its-state.txt'), 'x');
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('its tool memory', async () => me.page.locator('#carry-box').isVisible());
    assert.match(await me.page.locator('#carry-export').getAttribute('href'), /\/api\/conversations\/first\/export$/);
    if (process.env.CARRY_SHOTS) for (const [w, h, name] of [[1280, 900, 'desktop'], [900, 1200, 'tablet'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const theme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
            await me.page.locator('#carry-box').scrollIntoViewIfNeeded();
            await me.page.locator('#carry-box').screenshot({ path: join(process.env.CARRY_SHOTS, `carry-${name}-${theme}.png`) });
        }
    }
    await me.page.setViewportSize({ width: 1280, height: 900 });
    /* Export: the download the person gets. */
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#carry-export').click()]);
    assert.match(download.suggestedFilename(), /^first-\d{4}-\d{2}-\d{2}\.clavarium\.tar\.gz$/);
    const file = join(b.dir, download.suggestedFilename());
    await download.saveAs(file);
    /* Import into another conversation of the same tool, from its settings. */
    await me.create('second', 'Shell', { chat: false });
    mkdirSync(homeOf(b, 'second'), { recursive: true });
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.page.locator('#carry-file').setInputFiles(file);
    await me.until('asked first', async () => /second/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    await me.page.locator('#notice button', { hasText: /^Import$/ }).click();
    await me.until('imported', async () => /Imported from « first »/.test(await me.page.locator('#notice').innerText().catch(() => '')), 20_000);
    assert.equal(readFileSync(join(homeOf(b, 'second'), '.bash_history'), 'utf8'), 'make deploy\n');
    assert.ok(!existsSync(join(homeOf(b, 'second'), 'not-its-state.txt')), 'only what its tool keeps');
    /* Its tool started again (the server's own start, after the import): let it end before the bench does. */
    await me.until('its tool back', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'second')?.phase === 'ready');
    await me.page.waitForTimeout(2500);
    assert.deepEqual(me.errors, []);
});
