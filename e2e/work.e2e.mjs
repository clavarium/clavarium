import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('what the tool makes where it works is seen in Files, at once, and can be downloaded', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('writer');
    await me.type('pwd; echo "the report" > report.txt; mkdir drafts; echo ok');
    await me.sees('\nok');
    await me.page.locator('#files-open').click();
    /* Nothing was attached, nothing was asked of the tool: its work is there. */
    assert.deepEqual(await me.page.locator('#files-tabs button').allInnerTexts(), ['work - where the tool works']);
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('report.txt'));
    assert.equal(await me.page.locator('#files-import').isVisible(), true, 'and a file can be handed to the tool the same way');
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#files-rows .file', { hasText: 'report.txt' }).click()]);
    assert.equal(download.suggestedFilename(), 'report.txt');
    await me.page.locator('#files-close').click();
    /* Archived: its work is put aside on the server, not erased. */
    assert.equal((await me.api('/api/conversations/writer/archive', {})).status, 200);
    assert.match((await me.api('/api/resources', { name: 'work' })).body.error, /where each conversation works/);
    assert.deepEqual(me.errors, []);
});

test('asked to work on the disk of its machine, a conversation keeps nothing here, and Files says so', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('big-project', 'Shell', { onDisk: true });
    await me.type('echo x > built.txt; echo ok');
    await me.sees('\nok');
    assert.equal((await me.api('/api/conversations')).body[0].work, 'disk');
    await me.page.locator('#files-open').click();
    assert.equal(await me.page.locator('#files-tabs button').count(), 0);
    assert.match(await me.page.locator('#files-none').innerText(), /works on the disk of its machine/);
    assert.equal((await me.page.evaluate(async () => (await fetch('/api/files?c=big-project&r=work&p=')).status)), 404);
});
