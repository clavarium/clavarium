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
    /* The tabs are painted a moment after the sheet opens: waited for, not read at once. */
    await me.until('its work folder is the one tab', async () => JSON.stringify(await me.page.locator('#files-tabs button').allInnerTexts()) === JSON.stringify(['work - where the tool works']));
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('report.txt'));
    assert.equal(await me.page.locator('#files-import').isVisible(), true, 'and a file can be handed to the tool the same way');
    await me.page.locator('#files-rows .file', { hasText: 'report.txt' }).click();
    await me.until('the text is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('the report'));
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#preview-download').click()]);
    assert.equal(download.suggestedFilename(), 'report.txt');
    /* Closing the window leaves the list as it was. */
    await me.page.locator('#preview-close').click();
    assert.equal(await me.page.locator('#files-rows').isVisible(), true);
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
    await me.until('no folder is shown', async () => (await me.page.locator('#files-tabs button').count()) === 0);
    assert.match(await me.page.locator('#files-none').innerText(), /works on the disk of its machine/);
    assert.equal((await me.page.evaluate(async () => (await fetch('/api/files?c=big-project&r=work&p=')).status)), 404);
});

test('the work of a conversation moves to a kept folder and back, with a warning each time, and the tool starts again', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('mover', 'Shell', { onDisk: true });
    await me.type('echo "made before the move" > early.txt; mkdir sub; echo deep > sub/deep.txt; echo ok');
    await me.sees('\nok');
    const move = async (button, warning) => {
        const before = (await me.api('/api/conversations')).body[0].work;
        await me.page.locator('#folders').click();
        await me.page.evaluate(() => { document.getElementById('access-advanced').open = true; });
        await me.until('the way to the other place is offered', async () => (await me.page.locator('#work-move').innerText()).startsWith(button));
        await me.page.locator('#work-move').click();
        assert.match(await me.page.locator('#notice-text').innerText(), warning);
        assert.match(await me.page.locator('#notice-text').innerText(), /THE TOOL IS STOPPED AND STARTED AGAIN/);
        await me.page.locator('#notice-action').click();
        await me.until('the move is over', async () => { const c = (await me.api('/api/conversations')).body[0]; return c.phase === 'ready' && typeof c.moved === 'string' && (c.work !== before || /Not moved/.test(c.moved)); }, 60_000);
        const said = (await me.api('/api/conversations')).body[0].moved;
        assert.doesNotMatch(said, /Not moved/, said);
        await me.until('the tool is back', async () => (await me.state()) === 'live', 30_000);
    };
    /* To a folder kept here: its files are then in Files. */
    await move('Keep its work here', /less than 1 GB would stay free, or if the work holds symbolic links that a kept folder refuses/);
    assert.equal((await me.api('/api/conversations')).body[0].work, 'kept');
    await me.page.locator('#files-open').click();
    await me.until('what was made before the move is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('early.txt'));
    await me.page.locator('#files-close').click();
    await me.type('cat early.txt sub/deep.txt; echo "made after" > late.txt; echo seen');
    await me.sees('made before the move\ndeep');
    /* And back to the disk of its machine: nothing is shown here any more, nothing is lost. */
    await move('Move its work to the disk', /less than 1 GB would stay free\./);
    assert.equal((await me.api('/api/conversations')).body[0].work, 'disk');
    await me.type('cat early.txt late.txt; echo both-there');
    await me.sees('made before the move\nmade after');
    await me.page.locator('#files-open').click();
    await me.until('no folder is shown', async () => (await me.page.locator('#files-tabs button').count()) === 0);
    await me.page.locator('#files-close').click();
    /* A link made by the tool travels as a link. */
    await me.type('ln -s early.txt link-to-it; echo linked');
    await me.sees('\nlinked');
    await move('Keep its work here', /less than 1 GB would stay free, or if the work holds symbolic links that a kept folder refuses/);
    await me.type('readlink link-to-it; cat link-to-it; echo read');
    await me.sees('\nearly.txt\nmade before the move');
    /* But a link that points upwards, as installed packages make, is refused
       by a kept folder: the move back is said to be impossible BEFORE the
       tool is stopped. */
    await move('Move its work to the disk', /less than 1 GB would stay free\./);
    await me.type('mkdir -p node_modules/.bin; ln -s ../../early.txt node_modules/.bin/tool; echo installed');
    await me.sees('\ninstalled');
    const refused = await me.api('/api/conversations/mover/work', { to: 'kept' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /point upwards or outside \(the first: .*node_modules\/\.bin\/tool\)/);
    assert.equal(await me.state(), 'live', 'the tool was not stopped');
});
