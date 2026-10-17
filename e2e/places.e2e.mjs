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
const selected = (page, tab) => page.locator(`#tab-${tab}`).getAttribute('aria-selected');

test('three places at the bottom left; Access is Map, Devices, Assets with Export and Import always in sight; a conversation opens it filtered on itself; old addresses lead to their tab; Back walks the tabs', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await me.create('garden');
    await me.api('/api/resources', { name: 'seeds' });
    await pairDevice(me, b.origin, [{ asset: 'folder:seeds', rights: 'r' }], 'Kitchen tablet');
    /* On a wide screen the list above is the menu: the bar holds the places of the whole, Access and Settings. */
    assert.deepEqual(await page.locator('#nav button:visible').allInnerTexts(), ['Access', 'Settings']);
    const navBox = await page.locator('#nav').boundingBox(); const listBox = await page.locator('#list').boundingBox();
    assert.ok(navBox.x < 5 && navBox.y >= listBox.y + listBox.height - 1, 'under the list, bottom left');
    for (const id of ['#links-open', '#assets-open', '#sharing-open', '#settings-open']) assert.equal(await page.locator(id).count(), 0, `${id} has gone into the places`);
    /* Access: its tabs in this order, the map first. */
    await page.locator('#nav-access').click();
    /* The tablet was paired after the page was opened: counted on the way in. */
    await me.until('the tabs, with the devices counted', async () => (await page.locator('#access-tabs [role=tab]').allInnerTexts()).join('|') === 'Map|Devices (1)|Assets');
    assert.equal(await selected(page, 'map'), 'true');
    assert.equal(await page.locator('#nav-access').getAttribute('aria-current'), 'page');
    await me.until('the map is drawn', async () => (await page.locator('#links-board .lk-node').count()) === 3);
    /* Export and Import, whatever the tab; Flows is a switch of the map. */
    for (const tab of ['map', 'devices', 'assets']) {
        await page.locator(`#tab-${tab}`).click();
        assert.equal(await selected(page, tab), 'true');
        for (const id of ['#flows-export', '#flows-import']) assert.equal(await page.locator(id).isVisible(), true, `${id} on ${tab}`);
    }
    assert.equal(await page.locator('#sharing-devices .device').count(), 1, 'the devices tab is the former Devices & sharing');
    await page.locator('#tab-map').click();
    await page.locator('#map-mode [data-mode=flows]').click();
    await me.until('the flows are shown', async () => (await page.locator('#flows').isVisible()) && !(await page.locator('#links').isVisible()));
    assert.match(page.url(), /open=access&tab=flows/);
    /* Back: the map again, then the tab before, then out of Access. */
    await page.goBack();
    await me.until('back on the map', async () => (await page.locator('#links').isVisible()) && !(await page.locator('#flows').isVisible()));
    await page.goBack();
    await me.until('back on the assets tab', async () => (await selected(page, 'assets')) === 'true');
    await page.locator('#access-close').click();
    await me.until('Access is closed, and its address with it', async () => !(await page.locator('#access').isVisible()) && new URL(page.url()).searchParams.get('open') === null);
    /* From a conversation: Access, on that conversation alone. Attach an asset... */
    await page.locator('#folders').click();
    await me.chapter('access');
    await page.locator('#access-assets-here').click();
    await me.until('the assets tab, filtered', async () => (await selected(page, 'assets')) === 'true' && (await page.locator('#access-for').isVisible()));
    assert.equal(await page.locator('#access-for-name').innerText(), 'garden');
    const seeds = page.locator('#assets-folder .asset[data-name="seeds"]');
    await seeds.locator('.for-row[data-conversation="garden"] .levels button', { hasText: 'Read' }).click();
    await me.until('seeds is read by garden', async () => (await me.api('/api/conversations')).body[0].resources.some((r) => r.name === 'seeds' && r.access === 'read'));
    /* ...the badge takes the filter away. */
    await page.locator('#access-for-clear').click();
    await me.until('no filter', async () => !(await page.locator('#access-for').isVisible()) && (await page.locator('.for-row').count()) === 0);
    assert.equal(new URL(page.url()).searchParams.get('for'), null);
    /* Closed, it goes back to the conversation's own sheet it came from. */
    await page.locator('#access-close').click();
    await me.until('back on its sheet', async () => page.locator('#panel').isVisible());
    /* Share with a device: the devices, each with what it has of this conversation, given in one click. */
    await me.chapter('sharing');
    await page.locator('#access-devices-here').click();
    await me.until('the devices tab, filtered', async () => (await selected(page, 'devices')) === 'true' && (await page.locator('#access-for').isVisible()));
    const tablet = page.locator('#sharing-devices .device', { hasText: 'Kitchen tablet' });
    await me.until('the tablet says it has not garden', async () => /garden not shared/.test(await tablet.innerText()));
    await tablet.locator('button', { hasText: 'Give garden' }).click();
    await me.until('the tablet has garden', async () => (await me.api('/api/devices')).body[0].grants.some((g) => g.asset === 'conversation:garden'));
    await me.until('its line says so', async () => (await tablet.locator('.given-row[data-asset="conversation:garden"] label[data-part=terminal] input').count()) === 1);
    /* A card folds, as a chapter does. */
    await tablet.locator('.card-fold').click();
    await me.until('folded', async () => (await tablet.locator('.given-row').count()) === 0 || !(await tablet.locator('.given-row').first().isVisible()));
    /* The addresses of the screens that came before lead to their tab; Settings has its own. */
    for (const [old, tab, flows] of [['links', 'map', false], ['who-gets-what', 'map', false], ['flows', 'map', true], ['sharing', 'devices', false], ['assets', 'assets', false]]) {
        await page.goto(`${b.origin}/?c=garden&open=${old}`);
        await me.until(`?open=${old} opens ${tab}`, async () => (await page.locator('#access').isVisible()) && (await selected(page, tab)) === 'true');
        assert.equal(await page.locator('#flows').isVisible(), flows, `${old}: flows or map`);
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
    assert.equal(await items.count(), 3);
    for (let i = 0; i < 3; i += 1) {
        const item = items.nth(i);
        assert.equal(await item.locator('svg').count(), 1, 'an icon');
        assert.ok((await item.boundingBox()).height >= 44, 'a fingertip high');
    }
    assert.deepEqual(await items.allInnerTexts(), ['Conversations', 'Access', 'Settings']);
    /* Inside a conversation the bar gives its room to the terminal; back on the list, it is there again. */
    await page.locator('#items .item', { hasText: 'garden' }).click();
    await me.until('the conversation', async () => (await me.state()) === 'live');
    assert.equal(await page.locator('#nav').isVisible(), false);
    await page.locator('#back').click();
    await me.until('the bar again', async () => page.locator('#nav').isVisible());
    /* Access, the whole screen: no bar of a conversation over it; three tabs of one width. */
    await page.locator('#nav-access').click();
    await me.until('Access', async () => page.locator('#access').isVisible());
    assert.equal(await page.locator('#room > header').isVisible(), false);
    const widths = await page.locator('#access-tabs [role=tab]').evaluateAll((l) => l.map((x) => Math.round(x.getBoundingClientRect().width)));
    assert.equal(new Set(widths).size, 1, `segmented: ${widths}`);
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
