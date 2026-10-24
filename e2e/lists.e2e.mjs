import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('Lists: the owner makes a list and gives it to a conversation; its tool adds to it with binder, never approves; the owner ticks, the tool goes on', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    const page = me.page;
    await page.setViewportSize({ width: 1180, height: 820 });

    /* Installed by the server in every machine, as Parley and Docket are. */
    const installs = join(process.env.FAKE_VM_DIR, 'vms', 'clv-coder', 'npm-installs');
    await me.until('binder is installed in its machine', async () => existsSync(installs) && /clavarium-binder-/.test(readFileSync(installs, 'utf8')), 60_000);

    /* Lists, in the menu: nothing yet; a list made from a template. */
    await page.locator('#nav-lists').click();
    await me.until('Lists is open', async () => /No list yet\./.test(await page.locator('#lists-binder').innerText().catch(() => '')));
    await page.locator('#lists-binder .binder-empty .binder-primary').click();
    await page.locator('#lists-binder [data-template="batches"]').click();
    await page.locator('#lists-binder .binder-page .binder-primary').click();
    await me.until('the list is made', async () => (await page.locator('#lists-binder .binder-tabs [role="tab"]').count()) === 1);
    /* Given to the conversation, to change. */
    await page.locator('#lists-binder [data-act="settings"]').click();
    await page.locator('#lists-binder select[data-grant="conversation:coder"]').selectOption('write');
    await me.until('given', async () => (await me.api('/api/binder', { op: 'lists', args: {} })).body.data[0].grants['conversation:coder'] === 'write');
    await page.locator('#lists-binder [data-act="save"]').click();

    /* What its tool runs, in its terminal (under Lists: Lists closed first, opened again after). */
    const run = async (line, mark) => {
        await page.locator('#lists-close').click();
        await me.type(`clear; ${line}`);
        await me.printed(mark, 30_000);
        const said = await me.screen();
        await page.locator('#nav-lists').click();
        return said;
    };
    /* Its tool proposes, through its own folder: the server answers, and says who asked by the folder. */
    await run('export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; binder add Batches "Dark mode" && echo added-ok', 'added-ok');
    await me.until('the page shows it', async () => /Dark mode/.test(await page.locator('#lists-binder').innerText()), 15_000);
    const row = page.locator('#lists-binder .binder-row').filter({ hasText: 'Dark mode' });
    assert.match(await row.innerText(), /Proposed/);
    const kept = (await me.api('/api/binder', { op: 'get', args: { id: '1' } })).body.data.record;
    assert.equal(kept.by, 'conversation:coder');
    /* It cannot approve: refused, and said so in its terminal. */
    assert.match(await run('binder move 1 Doing || echo refused-ok', 'refused-ok'), /only a person approves/);

    /* The owner ticks it; the tool goes on. */
    await row.locator('.binder-tick').click();
    await me.until('approved', async () => (await row.locator('.binder-tick').getAttribute('aria-checked')) === 'true');
    await run('binder move 1 Doing && binder note 1 "started" && echo moved-ok', 'moved-ok');
    await me.until('the page shows it doing', async () => /Doing/.test(await row.innerText()), 15_000);

    /* A list it was not given, it does not see. */
    await me.api('/api/binder', { op: 'create-list', args: { template: 'customers' } });
    const listed = await run('binder; echo listed-ok', 'listed-ok');
    assert.match(listed, /Batches/);
    assert.doesNotMatch(listed, /Customers/);
});
