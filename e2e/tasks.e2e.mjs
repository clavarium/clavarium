import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('Batches beside the chat: none until its tool makes its binder of batches; what its tool adds is shown, the owner ticks there, a click opens the card in Binders; folded, remembered per conversation; on a phone, a sheet', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 820 });
    await me.create('coder');
    await page.locator('#folders').click();
    await page.locator('#talk-on button[data-on=true]').click();
    await page.goBack();
    const run = async (line, mark) => {
        await page.locator('#view-terminal').click();
        await me.type(`clear; ${line}`);
        await me.printed(mark, 30_000);
        await page.locator('#view-chat').click();
    };
    await run('export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; parley tell "Ready." >/dev/null && echo told-ok', 'told-ok');
    const chat = page.locator('#simple-thread');
    const button = chat.locator('.parley-panel-open');
    const panel = chat.locator('.parley-panel');

    /* No binder of batches: no panel, no button. */
    await me.until('its chat', async () => /Ready\./.test(await chat.innerText()), 20_000);
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(await button.isVisible(), false);
    assert.equal(await panel.isVisible(), false);
    /* Its tool makes one, as its guide says: given to it alone, to change; then the panel and its button. */
    await run('binder new batches && echo made-ok', 'made-ok');
    const lists = (await me.api('/api/binder', { op: 'lists', args: {} })).body.data;
    assert.equal(lists.length, 1);
    assert.equal(lists[0].template, 'batches');
    assert.deepEqual(lists[0].grants, { 'conversation:coder': 'write' });
    await me.until('the panel, beside the chat, with its button', async () => (await panel.isVisible()) && (await button.isVisible()) && /Batches/.test(await panel.innerText()), 15_000);
    assert.match(await panel.innerText(), /Nothing yet/);

    /* Its tool adds a batch: shown, waiting for the owner's tick, counted. */
    await run('binder add Batches "Fix diff line numbers" --description "They **slide** off their lines when the page scrolls." >/dev/null && binder add Batches "Dictation language" >/dev/null && echo added-ok', 'added-ok');
    const row = panel.locator('.parley-panel-item').filter({ hasText: 'Fix diff line numbers' });
    await me.until('shown beside the chat', async () => (await row.count()) === 1, 15_000);
    assert.match(await row.innerText(), /Proposed/);
    assert.equal(await row.locator('.parley-panel-text').innerText(), 'They slide off their lines when the page scrolls.', 'what it is, in plain words');
    await me.until('counted on its button', async () => (await button.locator('.parley-panel-count').innerText()) === '2');

    /* Ticked here: approved in Binder; the tool may go on. */
    await row.locator('.parley-panel-tick').click();
    await me.until('approved', async () => (await me.api('/api/binder', { op: 'get', args: { id: '1' } })).body.data.record.approved === true);
    await me.until('ticked, and no longer counted', async () => (await row.locator('.parley-panel-tick').getAttribute('aria-checked')) === 'true' && (await button.locator('.parley-panel-count').innerText()) === '1', 15_000);
    await run('binder move 1 Doing >/dev/null && echo moved-ok', 'moved-ok');
    await me.until('doing, said beside the chat', async () => /Doing/.test(await row.innerText()), 15_000);

    /* Folded: remembered for this conversation, after a reload. */
    await panel.locator('.parley-panel-fold').click();
    assert.equal(await panel.isVisible(), false);
    await page.reload();
    await me.until('its chat again', async () => button.isVisible(), 30_000);
    await me.until('the panel stays folded', async () => (await panel.locator('.parley-panel-item').count()) === 2);
    assert.equal(await panel.isVisible(), false);
    await button.click();
    await me.until('unfolded', async () => panel.isVisible());

    /* A click on a batch: its card, in the Binders tab. */
    await row.locator('.parley-panel-title').click();
    await me.until('its card in Binders', async () => (await page.locator('#clists').isVisible()) && (await page.locator('#clists-binder .binder-record[data-record="1"]').count()) === 1, 15_000);
    assert.equal(await page.locator('#view-lists').getAttribute('aria-pressed'), 'true');

    /* On a phone: never beside the thread; a sheet from its button. */
    const phone = await b.person({ phone: true });
    await phone.page.goto(`${b.origin}/?c=coder`);
    const small = phone.page.locator('#simple-thread');
    await phone.until('its button on the phone', async () => small.locator('.parley-panel-open').isVisible(), 30_000);
    assert.equal(await small.locator('.parley-panel').isVisible(), false, 'the thread keeps the whole width');
    await small.locator('.parley-panel-open').tap();
    await phone.until('a sheet', async () => small.locator('.parley-panel[data-sheet="true"]').isVisible());
    assert.match(await small.locator('.parley-panel').innerText(), /Dictation language/);
    await phone.page.goBack();
    await phone.until('Back closes it', async () => !(await small.locator('.parley-panel').isVisible()));

    assert.deepEqual([...me.errors, ...phone.errors], []);
});
