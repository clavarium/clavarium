import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('Lists: the owner makes a list in Assets and gives it to a conversation, which shows it in its Lists tab; its tool adds to it with binder, never approves; the owner ticks, the tool goes on', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    const page = me.page;
    await page.setViewportSize({ width: 1180, height: 820 });

    /* Installed by the server in every machine, as Parley and Docket are. */
    const installs = join(process.env.FAKE_VM_DIR, 'vms', 'clv-coder', 'npm-installs');
    await me.until('binder is installed in its machine', async () => existsSync(installs) && /clavarium-binder-/.test(readFileSync(installs, 'utf8')), 60_000);

    /* No Lists in the menu: a kind of asset. Nothing yet; a list made from a template. */
    assert.equal(await page.locator('#nav-lists').count(), 0);
    assert.equal(await page.locator('#view-lists').isVisible(), false, 'no Lists tab before it was given one');
    await page.locator('#nav-assets').click();
    const kind = page.locator('#assets-rows .as-kind[data-kind="list"]');
    await me.until('Lists, among the assets', async () => /None yet/.test(await kind.innerText().catch(() => '')));
    await kind.locator('.as-add').click();
    await me.until('the templates', async () => (await page.locator('#listnew-template option').count()) > 1);
    await page.locator('#listnew-template').selectOption('batches');
    await page.locator('#list-new button[type=submit]').click();
    await me.until('the list is made, and opened', async () => (await kind.locator('.as-row').count()) === 1 && /Batches/.test(await page.locator('#assets-detail .as-title').innerText().catch(() => '')));
    await me.until('the list itself, below', async () => /Nothing here/.test(await page.locator('#assets-detail .as-binder').innerText().catch(() => '')));
    /* Given to the conversation, to change: Used by, as every asset. */
    await page.locator('#assets-detail .as-chapter .as-add').click();
    await page.locator('#assets-detail .as-picker .given-row[data-conversation="coder"] button', { hasText: 'Write' }).click();
    await me.until('given', async () => (await me.api('/api/binder', { op: 'lists', args: {} })).body.data[0].grants['conversation:coder'] === 'write');
    await me.until('used by it', async () => /coder/.test(await page.locator('#assets-detail .as-users:not(.as-picker)').innerText()));
    await page.locator('#assets-close').click();

    /* In the conversation, a Lists tab: its lists alone. */
    await me.until('the Lists tab', async () => page.locator('#view-lists').isVisible(), 15_000);
    await page.locator('#view-lists').click();
    await me.until('its list, there', async () => (await page.locator('#clists-binder .binder-tabs [role="tab"]').count()) === 1);
    const lists = page.locator('#clists-binder');

    /* What its tool runs, in its terminal (the Terminal tab, then Lists again). */
    const run = async (line, mark) => {
        await page.locator('#view-terminal').click();
        await me.type(`clear; ${line}`);
        await me.printed(mark, 30_000);
        const said = await me.screen();
        await page.locator('#view-lists').click();
        return said;
    };
    /* Its tool proposes, through its own folder: the server answers, and says who asked by the folder. */
    await run('export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; binder add Batches "Dark mode" && echo added-ok', 'added-ok');
    await me.until('the page shows it', async () => /Dark mode/.test(await lists.innerText()), 15_000);
    const row = lists.locator('.binder-row').filter({ hasText: 'Dark mode' });
    assert.match(await row.innerText(), /Proposed/);
    /* Counted on the tab: one waits for the owner's tick. */
    await me.until('counted', async () => (await page.locator('#lists-count').innerText()) === '1', 15_000);
    const kept = (await me.api('/api/binder', { op: 'get', args: { id: '1' } })).body.data.record;
    assert.equal(kept.by, 'conversation:coder');
    /* It cannot approve: refused, and said so in its terminal. */
    assert.match(await run('binder move 1 Doing || echo refused-ok', 'refused-ok'), /only a person approves/);

    /* The owner ticks it; the tool goes on. */
    await row.locator('.binder-tick').click();
    await me.until('approved', async () => (await row.locator('.binder-tick').getAttribute('aria-checked')) === 'true');
    await me.until('no longer counted', async () => (await page.locator('#lists-count').innerText()) === '', 15_000);
    await run('binder move 1 Doing && binder note 1 "started" && echo moved-ok', 'moved-ok');
    await me.until('the page shows it doing', async () => /Doing/.test(await row.innerText()), 15_000);

    /* A list it was not given, it does not see; nor does its Lists tab. */
    await me.api('/api/binder', { op: 'create-list', args: { template: 'customers' } });
    const listed = await run('binder; echo listed-ok', 'listed-ok');
    assert.match(listed, /Batches/);
    assert.doesNotMatch(listed, /Customers/);
    await me.until('its tab, read again', async () => /Doing/.test(await row.innerText()));
    assert.deepEqual(await lists.locator('.binder-tabs [role="tab"]').evaluateAll((tabs) => tabs.map((x) => x.dataset.list)), ['batches']);

    /* Taken back, in Assets: the tab goes. */
    await page.locator('#nav-assets').click();
    await kind.locator('.as-row', { hasText: 'Batches' }).click();
    await page.locator('#assets-detail .as-users:not(.as-picker) .given-row[data-conversation="coder"] button', { hasText: 'Off' }).click();
    await me.until('taken back', async () => !(await me.api('/api/binder', { op: 'lists', args: {} })).body.data.find((l) => l.id === 'batches').grants['conversation:coder']);
    await page.locator('#assets-close').click();
    await me.until('no Lists tab', async () => !(await page.locator('#view-lists').isVisible()), 15_000);
    assert.equal(await page.locator('#assets').isVisible(), false);
    assert.deepEqual(me.errors, [], 'no error in the page');
});
