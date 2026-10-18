import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { bench, SKIP } from './bench.mjs';

/* A device paired by the API, as a phone that scanned the code would be. */
async function pairDevice(me, origin, grants, label) {
    const shared = (await me.api('/api/shares', { grants, label })).body;
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const r = await fetch(`${origin}/c/api/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(shared.url).hash.slice(1), key: publicKey.export({ format: 'jwk' }), label }) });
    assert.equal(r.status, 201);
}
test('three places at the bottom left -- Assets, Access, Settings; Access is the map alone, a device is a card on it; Export and Import are in Settings; a conversation opens its own Assets; old addresses lead to their place; Back walks them', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await me.create('garden');
    await me.api('/api/resources', { name: 'seeds' });
    await pairDevice(me, b.origin, [{ asset: 'folder:seeds', rights: 'r' }], 'Kitchen tablet');
    /* On a wide screen the list above is the menu: the bar holds the places of the whole. */
    assert.deepEqual(await page.locator('#nav button:visible').allInnerTexts(), ['Assets', 'Access', 'Settings']);
    const navBox = await page.locator('#nav').boundingBox(); const listBox = await page.locator('#list').boundingBox();
    assert.ok(navBox.x < 5 && navBox.y >= listBox.y + listBox.height - 1, 'under the list, bottom left');
    for (const id of ['#links-open', '#assets-open', '#sharing-open', '#settings-open', '#access-tabs', '#tab-devices']) assert.equal(await page.locator(id).count(), 0, `${id} is gone`);
    /* Access: the map alone; a device is a card on it; a new device starts there. */
    await page.locator('#nav-access').click();
    assert.equal(await page.locator('#nav-access').getAttribute('aria-current'), 'page');
    await me.until('the map is drawn', async () => (await page.locator('#links-board .lk-node').count()) === 3);
    assert.equal(await page.locator('#map-new-device').isVisible(), true);
    assert.equal(await page.locator('#flows-export').isVisible(), false, 'Export is in Settings now');
    const card = await me.openDevice('Kitchen tablet');
    assert.deepEqual(await card.locator('.device-acts button').allInnerTexts(), ['+ Give more', 'Rename', 'Revoke device']);
    assert.equal(await card.locator('.given-row').count(), 1, 'what it has');
    await page.locator('#map-mode [data-mode=flows]').click();
    await me.until('the flows are shown', async () => (await page.locator('#flows').isVisible()) && !(await page.locator('#links').isVisible()));
    assert.match(page.url(), /open=access&tab=flows/);
    await page.goBack();
    await me.until('back on the map', async () => (await page.locator('#links').isVisible()) && !(await page.locator('#flows').isVisible()));
    await page.locator('#access-close').click();
    await me.until('Access is closed, and its address with it', async () => !(await page.locator('#access').isVisible()) && new URL(page.url()).searchParams.get('open') === null);
    /* Assets, a place of its own, with its address. */
    await page.locator('#nav-assets').click();
    await me.until('the Assets place', async () => (await page.locator('#assets').isVisible()) && /open=assets/.test(page.url()));
    await page.locator('#assets-rows .as-row[data-asset="folder:seeds"]').click();
    await me.until('seeds, opened', async () => /a=folder%3Aseeds/.test(page.url()));
    await page.locator('#assets-close').click();
    /* Export and Import: in Settings. */
    await page.locator('#nav-settings').click();
    await page.locator('#settings-ch-backup > summary').click();
    for (const id of ['#flows-export', '#flows-import']) assert.equal(await page.locator(id).isVisible(), true, id);
    await page.locator('#settings-close').click();
    /* From a conversation: its own Assets, and "+" to attach. */
    await page.locator('#folders').click();
    await me.chapter('access');
    await page.locator('#access-assets-here').click();
    await me.until('its own Assets', async () => (await page.locator('#cassets').isVisible()) && (await page.locator('#view-assets').getAttribute('aria-pressed')) === 'true');
    await page.locator('#cassets-rows .as-list-top .as-add').click();
    await me.until('the attach picker', async () => page.locator('#attach-picker').isVisible());
    await page.locator('#attach-rows .folder[data-name="seeds"]').locator('button', { hasText: 'Read' }).click();
    await me.until('seeds is read by garden', async () => (await me.api('/api/conversations')).body[0].resources.some((r) => r.name === 'seeds' && r.access === 'read'));
    /* Share with a device: the map, on this conversation. */
    await me.chapter('sharing');
    await page.locator('#access-devices-here').click();
    await me.until('the map, on garden', async () => (await page.locator('#links-card').isVisible()) && /garden/.test(await page.locator('#links-card h3').innerText()));
    /* The addresses of the screens that came before lead to their place; Settings has its own. */
    for (const [old, where, flows] of [['links', 'access', false], ['who-gets-what', 'access', false], ['flows', 'access', true], ['sharing', 'access', false], ['devices', 'access', false], ['assets', 'assets', false]]) {
        await page.goto(`${b.origin}/?c=garden&open=${old}`);
        await me.until(`?open=${old} opens ${where}`, async () => page.locator(`#${where}`).isVisible());
        if (where === 'access') assert.equal(await page.locator('#flows').isVisible(), flows, `${old}: flows or map`);
    }
    await page.goto(`${b.origin}/?open=settings`);
    await me.until('settings', async () => page.locator('#settings').isVisible());
    assert.equal(await page.locator('#nav-settings').getAttribute('aria-current'), 'page');
    /* A conversation touched in the list: Settings gives way to it. */
    await page.locator('#items .item', { hasText: 'garden' }).click();
    await me.until('settings gave way to garden', async () => !(await page.locator('#settings').isVisible()) && (await page.locator('#items .item[aria-current=true]').innerText()).includes('garden'));
    assert.deepEqual(me.errors, []);
});

test('on a phone: the list first, a bar along the bottom with the three items, Access on the whole screen, a box of the map rises from the bottom with its links and Edit', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    const page = me.page;
    await me.create('garden');
    await me.api('/api/resources', { name: 'seeds' });
    await me.api('/api/conversations/garden/resources', { resource: 'seeds', access: 'write' });
    await page.locator('#back').click();
    await me.until('the list', async () => page.locator('#list').isVisible());
    /* The bar: fixed along the bottom, the three items with an icon and a word, each a fingertip high. */
    const bar = await page.locator('#nav').boundingBox();
    const height = page.viewportSize().height;
    assert.ok(Math.abs(bar.y + bar.height - height) <= 1, `at the very bottom (${bar.y + bar.height} of ${height})`);
    assert.ok(bar.width >= page.viewportSize().width - 1, 'across the screen');
    const items = page.locator('#nav button');
    assert.equal(await items.count(), 4);
    for (let i = 0; i < 4; i += 1) {
        const item = items.nth(i);
        assert.equal(await item.locator('svg').count(), 1, 'an icon');
        assert.ok((await item.boundingBox()).height >= 44, 'a fingertip high');
    }
    assert.deepEqual(await items.allInnerTexts(), ['Conversations', 'Assets', 'Access', 'Settings']);
    /* Inside a conversation the bar gives its room to the terminal; back on the list, it is there again. */
    await page.locator('#items .item', { hasText: 'garden' }).click();
    await me.until('the conversation', async () => (await me.state()) === 'live');
    assert.equal(await page.locator('#nav').isVisible(), false);
    await page.locator('#back').click();
    await me.until('the bar again', async () => page.locator('#nav').isVisible());
    /* Access, the whole screen: no bar of a conversation over it; the map alone. */
    await page.locator('#nav-access').click();
    await me.until('Access', async () => page.locator('#access').isVisible());
    assert.equal(await page.locator('#room > header').isVisible(), false);
    assert.equal(await page.locator('#nav').isVisible(), true);
    /* A box touched: its links, from the bottom, and Edit. */
    await page.locator('#links-phone .lk-kinds button', { hasText: 'Conversations' }).click();
    await page.locator('#links-phone .lk-item[data-id="conversation:garden"]').click();
    await me.until('the sheet rises', async () => page.locator('#links-sheet').isVisible());
    assert.match(await page.locator('#links-sheet').innerText(), /its agent: read and write of seeds/);
    const sheet = await page.locator('#links-sheet').boundingBox();
    assert.ok(Math.abs(sheet.y + sheet.height - height) <= 1, 'from the bottom');
    await page.locator('#links-sheet-edit').click();
    await me.until('its links as rows', async () => (await page.locator('#links-phone .lk-ptitle').innerText().catch(() => '')) === 'garden');
    assert.equal(await page.locator('#links-phone .lk-prow[data-to="folder:seeds"]').count(), 1);
    /* Settings, then the list again, from the bar. */
    await page.locator('#nav-settings').click();
    await me.until('settings', async () => page.locator('#settings').isVisible());
    await page.locator('#nav-conversations').click();
    await me.until('the list', async () => (await page.locator('#list').isVisible()) && !(await page.locator('#settings').isVisible()));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(me.errors, []);
});
