import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('the simple screen: the same conversation without its terminal, for whoever does not read one', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('helper');
    await me.type('echo "The report is ready."; echo "38 orders, 3 late" > report.txt');
    await me.sees('\nThe report is ready.');
    assert.equal(await me.page.locator('#simple').isVisible(), false, 'the terminal first, as always');
    await me.page.locator('#simple-toggle').click();
    await me.until('it says what the tool says, as plain text', async () => (await me.page.locator('#simple-says').innerText()).includes('The report is ready.'));
    await me.until('what is ready to read is listed', async () => (await me.page.locator('#simple-files .file').first().innerText().catch(() => '')).includes('report.txt'));
    /* What is written in the box is typed into the same terminal, as one line. */
    await me.page.fill('#simple-text', 'echo "said from\nthe box"');
    await me.page.locator('#simple-say button[type=submit]').click();
    await me.until('the tool answered', async () => /\nsaid from the box/.test(await me.page.locator('#simple-says').innerText()));
    assert.equal(await me.page.inputValue('#simple-text'), '');
    /* A file is read in the window, as from Files. */
    await me.page.locator('#simple-files .file', { hasText: 'report.txt' }).click();
    await me.until('the report is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('38 orders, 3 late'));
    await me.page.locator('#preview-close').click();
    /* The keys of a terminal are put away; it is remembered on this device. */
    assert.equal(await me.page.locator('#keys button[data-keys=esc]').isVisible(), false);
    await me.page.reload();
    await me.until('simple again after a reload', async () => (await me.page.locator('#simple').isVisible()) && (await me.page.locator('#simple-says').innerText()).includes('said from the box'), 30_000);
    /* And back to its screen: nothing was lost, it was underneath all along. */
    await me.page.locator('#simple-toggle').click();
    assert.equal(await me.page.locator('#simple').isVisible(), false);
    assert.equal(await me.page.locator('#keys button[data-keys=esc]').isVisible(), true);
    await me.type('echo "typed in the terminal"');
    await me.sees('\ntyped in the terminal');
    assert.deepEqual(me.errors, []);
});
