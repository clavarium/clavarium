import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a free name: the identifier drawn from it, the name changed later and shown as text; hidden from the list, and "N hidden" shows it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const list = () => me.api('/api/conversations').then((r) => r.body);
    await me.page.locator('#new').click();
    await me.page.fill('#create-name', 'Location voiture');
    await me.until('the identifier it will have is shown', async () => (await me.page.locator('#create-id').getAttribute('placeholder')) === 'location-voiture');
    await me.page.locator('#create-tools button', { hasText: 'Shell' }).click();
    await me.page.locator('#create button[type=submit]').click();
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
    await me.page.locator('#panel-close').click();
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
