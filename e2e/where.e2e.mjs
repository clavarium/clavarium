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

test('in a machine of its own, its settings: moved into a shared machine -- one there offered, a new one asks its memory, asked first', { skip: SKIP }, async (t) => {
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
    await me.until('offered', async () => me.page.locator('#into-shared').isVisible());
    assert.equal(await me.page.locator('#shared-size').isVisible(), false);
    assert.equal(await me.page.locator('#into-shared-name').inputValue(), 'assist', 'the shared machine there, offered first');
    assert.equal(await me.page.locator('#into-shared-mb').isVisible(), false, 'its memory is its own');
    await me.page.fill('#into-shared-name', 'helpers');
    assert.equal(await me.page.locator('#into-shared-mb').isVisible(), true, 'a new one: its memory asked');
    if (process.env.WHERE_SHOTS) for (const [w, h, name] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const theme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
            await me.page.locator('#into-shared').scrollIntoViewIfNeeded();
            await me.page.screenshot({ path: join(process.env.WHERE_SHOTS, `into-shared-${name}-${theme}.png`) });
        }
    }
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.page.fill('#into-shared-name', 'assist');
    await me.page.locator('#into-shared-apply').click();
    await me.until('asked first', async () => /ITS OWN MACHINE IS DELETED/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.match(await me.page.locator('#notice').innerText(), /« assist »/);
    await me.page.locator('#notice button', { hasText: 'Move it' }).click();
    await me.until('sent', async () => asked !== null);
    assert.deepEqual(asked, { machine: 'assist' });
    await me.until('the refusal said', async () => /Stopped here by the test/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.deepEqual(me.errors.filter((e) => !/409/.test(e)), []);
});

test('its settings: a copy of it -- its own machine by default, a shared one asks its name (a new one, its memory), asked first', { skip: SKIP }, async (t) => {
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
    await me.until('offered', async () => me.page.locator('#copy-it').isVisible());
    assert.match(await me.page.locator('#copy-title').inputValue(), /\(copy\)$/);
    assert.equal(await me.page.locator('#copy-machine').isVisible(), false, 'its own machine by default');
    await me.page.selectOption('#copy-where', 'shared');
    assert.equal(await me.page.locator('#copy-machine').inputValue(), 'assist', 'the shared machine there, offered first');
    assert.equal(await me.page.locator('#copy-mb').isVisible(), false);
    await me.page.fill('#copy-machine', 'helpers');
    assert.equal(await me.page.locator('#copy-mb').isVisible(), true, 'a new one: its memory asked');
    if (process.env.WHERE_SHOTS) for (const [w, h, name] of [[1280, 900, 'desktop'], [900, 1200, 'tablet'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const theme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, theme);
            await me.page.locator('#copy-it').scrollIntoViewIfNeeded();
            await me.page.screenshot({ path: join(process.env.WHERE_SHOTS, `copy-${name}-${theme}.png`) });
        }
    }
    await me.page.setViewportSize({ width: 1280, height: 900 });
    await me.page.fill('#copy-title', 'Mail two');
    await me.page.fill('#copy-machine', 'assist');
    await me.page.locator('#copy-apply').click();
    await me.until('asked first', async () => /The original is untouched/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.match(await me.page.locator('#notice').innerText(), /« Mail two »/);
    await me.page.locator('#notice button', { hasText: 'Copy it' }).click();
    await me.until('sent', async () => asked !== null);
    assert.deepEqual(asked, { title: 'Mail two', machine: 'assist' });
    await me.until('the refusal said', async () => /Stopped here by the test/.test(await me.page.locator('#notice').innerText().catch(() => '')));
    assert.deepEqual(me.errors.filter((e) => !/409/.test(e)), []);
});
