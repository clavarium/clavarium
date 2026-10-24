import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a free name: the identifier drawn from it, the name changed later and shown as text; hidden from the list, and "N hidden" shows it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const list = () => me.api('/api/conversations').then((r) => r.body);
    await me.page.locator('#new').click();
    await me.page.fill('#newconv-name', 'Location voiture');
    await me.until('the identifier it will have is shown', async () => (await me.page.locator('#newconv-id').getAttribute('placeholder')) === 'location-voiture');
    await me.page.locator('#newconv-tools button', { hasText: 'Shell' }).click();
    await me.page.locator('#newconv-create').click();
    await me.until('it is live', async () => (await me.state()) === 'live', 30_000);
    assert.deepEqual((await list()).map((c) => [c.name, c.title]), [['location-voiture', 'Location voiture']]);
    assert.equal(await me.page.locator('#name').innerText(), 'Location voiture');
    /* Renamed at any time; markup in a name is only text. */
    await me.page.locator('#folders').click();
    await me.chapter('general');
    await me.until('its identifier is said, small', async () => /Identifier\s+location-voiture/.test(await me.page.locator('#general-facts').innerText()));
    await me.until('its name is ready to change', async () => (await me.page.locator('#title-name').inputValue()) === 'Location voiture');
    await me.page.fill('#title-name', 'Car <b>rental</b> 🚗');
    await me.page.locator('#title-form button[type=submit]').click();
    await me.until('the new name is in the bar', async () => (await me.page.locator('#name').innerText()) === 'Car <b>rental</b> 🚗');
    assert.equal(await me.page.locator('#items b').innerText(), 'Car <b>rental</b> 🚗');
    assert.equal(await me.page.locator('#items b b').count(), 0, 'never markup');
    const refused = await me.api('/api/conversations/location-voiture/title', { title: `evil${String.fromCodePoint(0x202e)}txt` });
    assert.equal(refused.status, 400);
    assert.equal((await list())[0].name, 'location-voiture', 'the identifier stays');
    /* Hidden: it stays in sight while it is open; gone from the list once another place is shown. */
    await me.page.locator('#hide-on button[data-on=true]').click();
    await me.until('it is hidden', async () => (await list())[0].hidden === true);
    await me.page.goBack();
    const made = await me.api('/api/conversations', { title: 'Other', tool: 'shell' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await me.until('the other one is listed', async () => (await me.page.locator('#items .item').count()) >= 1 && /Other/.test(await me.page.locator('#items').innerText()));
    await me.page.locator('#items .item', { hasText: 'Other' }).click();
    await me.until('the hidden one left the list', async () => !/Car/.test(await me.page.locator('#items').innerText()));
    assert.equal(await me.page.locator('#hidden-toggle').innerText(), '1 hidden');
    await me.page.locator('#hidden-toggle').click();
    await me.until('shown on a click', async () => /Car/.test(await me.page.locator('#items').innerText()));
    assert.equal(await me.page.locator('#hidden-toggle').innerText(), 'Hide 1 hidden');
    await me.page.locator('#hidden-toggle').click();
    await me.until('hidden again', async () => !/Car/.test(await me.page.locator('#items').innerText()));
    assert.deepEqual(me.errors, []);
});

test('a new conversation, a page of its own: its tools, an error under its field, the memory chosen reaching the server, a reload finding it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    const list = () => me.api('/api/conversations').then((r) => r.body);
    assert.equal((await me.api('/api/conversations', { name: 'taken', tool: 'shell' })).status, 201);
    await me.until('listed', async () => (await page.locator('#items .item').count()) === 1);
    await page.locator('#new').click();
    await me.until('the page, "+ New" marked', async () => (await page.locator('#newconv').isVisible()) && (await page.locator('#new').getAttribute('aria-pressed')) === 'true');
    assert.equal(await page.locator('#create').count(), 0, 'no form in the list any more');
    /* Its tools are the server's, each a card; the first is chosen. */
    await me.until('the tools of the server', async () => (await page.locator('#newconv-tools button b').allInnerTexts()).join() === 'Shell,Other tool');
    assert.equal(await page.locator('#newconv-tools button[aria-checked=true] b').innerText(), 'Shell');
    assert.equal(await page.locator('#newconv-more').evaluate((d) => d.open), false, 'More is folded');
    /* No name: said under the name, nothing asked of the server. */
    await page.locator('#newconv-create').click();
    await me.until('the name is asked for, under it', async () => (await page.locator('#newconv-name-error').isVisible()) && (await page.locator('#newconv-name').getAttribute('aria-invalid')) === 'true');
    /* An identifier taken: said under the identifier, More opened for it. */
    await page.fill('#newconv-name', 'Second');
    assert.equal(await page.locator('#newconv-name-error').isVisible(), false, 'typing takes the error away');
    await page.locator('#newconv-more summary').click();
    await page.fill('#newconv-id', 'taken');
    await page.locator('#newconv-create').click();
    await me.until('the identifier is taken, said under it', async () => (await page.locator('#newconv-id-error').innerText()) === 'Already used by another conversation');
    assert.equal(await page.locator('#newconv-id').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#newconv-name-error').isVisible(), false);
    assert.equal(await page.locator('#newconv').isVisible(), true, 'still open');
    /* A malformed one is refused here. */
    await page.fill('#newconv-id', 'Bad id');
    await page.locator('#newconv-create').click();
    await me.until('its shape is said', async () => (await page.locator('#newconv-id-error').innerText()) === 'Lower-case letters, digits, hyphens');
    /* Memory: from what the tool needs; the one chosen reaches the server. */
    await page.fill('#newconv-id', 'second');
    assert.equal(await page.locator('#newconv-memory-least').innerText(), 'Shell needs 768 MB at least');
    assert.equal(await page.locator('#newconv-memory').inputValue(), '768');
    assert.deepEqual((await page.locator('#newconv-memory option').allInnerTexts()).slice(0, 3), ['768 MB', '1 GB', '1.5 GB']);
    await page.selectOption('#newconv-memory', '3072');
    /* Its address: a reload finds it again. */
    assert.equal(new URL(page.url()).searchParams.get('open'), 'new');
    await page.locator('#newconv-work [data-work="disk"]').click();
    await page.locator('#newconv-create').click();
    await me.until('made, and selected: the page gave way', async () => new URL(page.url()).searchParams.get('c') === 'second' && !(await page.locator('#newconv').isVisible()));
    const second = (await list()).find((c) => c.name === 'second');
    assert.equal(second.memoryMb, 3072);
    assert.equal(second.title, 'Second');
    assert.equal(second.work, 'disk');
    assert.equal(await page.locator('#new').getAttribute('aria-pressed'), 'false');
    /* Opened again: empty, the files kept here again. */
    await page.locator('#new').click();
    await me.until('open again', () => page.locator('#newconv').isVisible());
    assert.equal(await page.locator('#newconv-name').inputValue(), '');
    assert.equal(await page.locator('#newconv-work [data-work="kept"]').getAttribute('aria-checked'), 'true');
    await page.reload();
    await me.until('a reload finds it again', async () => page.locator('#newconv').isVisible());
    await me.until('its tools again', async () => (await page.locator('#newconv-tools button').count()) === 2);
    await page.locator('#newconv-cancel').click();
    await me.until('Cancel closes it', async () => !(await page.locator('#newconv').isVisible()) && new URL(page.url()).searchParams.get('open') === null);
    /* Both machines built before the bench is taken down: nothing left writing in its folder. */
    await me.until('both are ready', async () => (await list()).every((c) => c.phase === 'ready'), 30_000);
    assert.deepEqual(me.errors, []);
});
