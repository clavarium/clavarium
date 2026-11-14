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

test('in a shared machine, its settings: its limit (no cores nor disk of its own) and the machine\'s memory, asked first naming all in it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.create('mail', 'Shell', { chat: false });
    /* Seen by the page as living in a shared machine with another one (the fake host makes no shared machine). */
    await me.page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const list = await (await route.fetch()).json();
        const mine = list.find((c) => c.name === 'mail');
        if (mine) Object.assign(mine, { sharedMachine: 'assist', machineMb: 4096 });
        list.push({ ...mine, name: 'diary', title: 'Diary', memoryMb: 2048 });
        await route.fulfill({ json: list });
    });
    await me.page.reload();
    await me.until('in the list', async () => me.page.locator('[data-name="mail"], [data-conversation="mail"]').first().isVisible().catch(() => false), 20_000).catch(() => {});
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('its shared size', async () => me.page.locator('#shared-size').isVisible());
    assert.equal(await me.page.locator('#machine-cpus').isVisible(), false, 'cores: the machine\'s');
    assert.equal(await me.page.locator('#machine-disk').isVisible(), false, 'disk: the machine\'s');
    assert.match(await me.page.locator('label[for="machine-memory"]').innerText(), /Its limit/);
    const limits = await me.page.locator('#machine-memory option').evaluateAll((o) => o.map((x) => Number(x.value)));
    assert.ok(Math.max(...limits) <= 4096, `never more than the machine: ${limits}`);
    const sizes = await me.page.locator('#shared-memory option').evaluateAll((o) => o.map((x) => Number(x.value)));
    assert.ok(Math.min(...sizes) >= 2048, `never less than the largest in it: ${sizes}`);
    if (process.env.WHERE_SHOTS) for (const [w, h, name] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const theme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
            await me.page.locator('#machine-size').scrollIntoViewIfNeeded();
            await me.page.screenshot({ path: join(process.env.WHERE_SHOTS, `shared-size-${name}-${theme}.png`) });
        }
    }
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.page.selectOption('#shared-memory', '8192');
    await me.page.locator('#shared-size-apply').click();
    await me.until('asked first', async () => /Diary/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.match(await me.page.locator('#notice').innerText(), /IT IS STOPPED AND STARTED AGAIN/);
    assert.deepEqual(me.errors, []);
});

test('in a machine of its own, its settings: Move... into a shared machine -- one there offered first, a new one asks its memory, its machine said deleted', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.create('mail', 'Shell', { chat: false });
    /* Another one seen living in the shared machine assist (the fake host makes no shared machine). */
    await me.page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const list = await (await route.fetch()).json();
        const mine = list.find((c) => c.name === 'mail');
        if (mine) list.push({ ...mine, name: 'diary', title: 'Diary', sharedMachine: 'assist', machineMb: 4096 });
        await route.fulfill({ json: list });
    });
    let asked = null;
    await me.page.route('**/api/conversations/mail/into-machine', async (route) => { asked = route.request().postDataJSON(); await route.fulfill({ status: 409, json: { error: 'Stopped here by the test.' } }); });
    await me.page.reload();
    await me.until('in the list', async () => me.page.locator('[data-name="mail"], [data-conversation="mail"]').first().isVisible().catch(() => false), 20_000).catch(() => {});
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('offered', async () => me.page.locator('#where-move').isVisible());
    assert.equal(await me.page.locator('#shared-size').isVisible(), false);
    await me.page.locator('#where-move').click();
    await me.until('the wizard open', async () => me.page.locator('#cm').isVisible());
    assert.equal(await me.page.locator('#cm-places [aria-checked="true"]').getAttribute('data-place'), 'assist', 'the shared machine there, offered first');
    assert.equal(await me.page.locator('#cm-new').isVisible(), false, 'its memory is its own');
    await me.page.locator('#cm-places .cm-card[data-place="new"]').click();
    await me.page.fill('#cm-new-name', 'helpers');
    assert.equal(await me.page.locator('#cm-new-mb').isVisible(), true, 'a new one: its memory asked');
    await me.page.fill('#cm-new-name', 'assist');
    assert.equal(await me.page.locator('#cm-new-mb').isVisible(), false, 'a name there already: its own memory');
    await me.page.locator('#cm-next').click();
    await me.until('its check', async () => me.page.locator('#cm-move-part').isVisible());
    assert.match(await me.page.locator('#cm-title').innerText(), /« assist »/);
    assert.match(await me.page.locator('#cm-move-part').innerText(), /Its own machine is deleted/);
    await me.page.locator('#cm-go').click();
    await me.until('sent', async () => asked !== null);
    assert.deepEqual(asked, { machine: 'assist' });
    assert.equal(await me.page.locator('#cm').isVisible(), false);
    await me.until('the refusal said', async () => /Stopped here by the test/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.deepEqual(me.errors.filter((e) => !/409/.test(e)), []);
});

test('its settings: Copy... into a shared machine -- its name given, sent, a refusal said in one line; in a shared machine, Move... out is not yet', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.create('mail', 'Shell', { chat: false });
    await me.page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const list = await (await route.fetch()).json();
        const mine = list.find((c) => c.name === 'mail');
        if (mine) list.push({ ...mine, name: 'diary', title: 'Diary', sharedMachine: 'assist', machineMb: 4096 });
        await route.fulfill({ json: list });
    });
    let asked = null;
    await me.page.route('**/api/conversations/mail/copy', async (route) => { asked = route.request().postDataJSON(); await route.fulfill({ status: 409, json: { error: 'Stopped here by the test.' } }); });
    await me.page.reload();
    await me.until('in the list', async () => me.page.locator('[data-name="mail"], [data-conversation="mail"]').first().isVisible().catch(() => false), 20_000).catch(() => {});
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('offered', async () => me.page.locator('#where-copy').isVisible());
    await me.page.locator('#where-copy').click();
    await me.until('the wizard open', async () => me.page.locator('#cm').isVisible());
    assert.equal(await me.page.locator('#cm-places [aria-checked="true"]').getAttribute('data-place'), '', 'its own machine by default');
    await me.page.locator('#cm-places .cm-card[data-place="assist"]').click();
    await me.page.locator('#cm-next').click();
    await me.until('its check', async () => me.page.locator('#cm-copy-part').isVisible());
    assert.match(await me.page.locator('#cm-copy-title').inputValue(), /\(copy\)$/);
    await me.page.fill('#cm-copy-title', 'Mail two');
    await me.page.locator('#cm-go').click();
    await me.until('sent', async () => asked !== null);
    assert.deepEqual(asked, { title: 'Mail two', machine: 'assist' });
    await me.until('the refusal said', async () => /✗ Stopped here by the test/.test(await me.page.locator('#cm-toast').innerText().catch(() => '')));
    /* Diary, in the shared machine: its own machine for a move is not yet, and nothing can be chosen. */
    await me.page.locator('#cm-toast-close').click();
    await me.page.evaluate(() => { document.querySelector('[data-name="diary"], [data-conversation="diary"]')?.click(); });
    await me.until('diary open', async () => (await me.page.locator('#name').innerText().catch(() => '')) === 'Diary');
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    await me.until('its place said', async () => /Shared machine « assist », alone in it/.test(await me.page.locator('#where-now').innerText().catch(() => '')));
    /* (Diary is only seen, its machine never made: its page is veiled, its button pressed from the page.) */
    await me.page.evaluate(() => document.getElementById('where-move').click());
    await me.until('the wizard open', async () => me.page.locator('#cm').isVisible());
    assert.deepEqual(await me.page.locator('#cm-places .cm-card').allInnerTexts(), ['Its own machine\nNot yet']);
    assert.equal(await me.page.locator('#cm-places .cm-card').isDisabled(), true);
    assert.equal(await me.page.locator('#cm-next').isDisabled(), true);
    assert.deepEqual(me.errors.filter((e) => !/409/.test(e)), []);
});
