/* THE DESK (desk.js, desktop.mjs): the home page on the bare address, filled the first time with the home
   cards; a thing put in any cell, one put on a taken cell sending the other to the first free cell, one dropped
   on another making a folder, sizes, the arrows of the keyboard, « Tidy »; kept by the server: the same after
   a reload and on a phone (a place a phone cannot show is shown elsewhere there, and kept).
   With CLAVARIUM_SHOTS set to a directory, the screens are saved there as pictures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const tile = (id) => `#desk > .desk-tile[data-id="${id}"]`;
const placeOf = (page, id) => page.locator(tile(id)).evaluate((t) => [Number(t.dataset.c), Number(t.dataset.r)]);
const seen = (page) => page.locator('#desk > .desk-tile').evaluateAll((all) => Object.fromEntries(all.map((t) => [t.dataset.id, [Number(t.dataset.c), Number(t.dataset.r), [...t.classList].find((c) => /^desk-[sml]$/.test(c))]])));

/* Dragged as a hand does: pressed low in its middle (its « ⋯ » is at its top left), moved in steps, let go.
   `cell`: the point its top left corner should land on (the cell is read there); `point`: where the hand lets go
   (on the middle of another: a folder). */
async function dragTo(page, from, { cell, point, hold = 0 }) {
    await page.locator(from).waitFor({ state: 'visible' });
    const b = await page.locator(from).boundingBox();
    const ox = b.width / 2; const oy = b.height - 8;
    await page.mouse.move(b.x + ox, b.y + oy);
    await page.mouse.down();
    await page.mouse.move(b.x + ox + 12, b.y + oy + 12, { steps: 3 });
    const [x, y] = point ?? [cell[0] - Math.min(20, b.width / 4) + ox, cell[1] - Math.min(20, b.height / 4) + oy];
    await page.mouse.move(x, y, { steps: 12 });
    if (hold) { await wait(hold); await page.mouse.move(x + 1, y + 1); }
    await page.mouse.up();
}
const cellPoint = async (page, c, r) => { await page.locator(`#desk > .desk-cell[data-c="${c}"][data-r="${r}"]`).waitFor({ state: 'visible' }); const b = await page.locator(`#desk > .desk-cell[data-c="${c}"][data-r="${r}"]`).boundingBox(); return [b.x + 14, b.y + 14]; };

test('the desk: the page of arrival, placed anywhere, moved, folded, sized, tidied; kept for every screen', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) assert.equal((await me.api('/api/conversations', { title, tool: 'shell' })).status, 201, title);
    await me.until('all are ready', async () => (await me.api('/api/conversations')).body.filter((c) => c.phase === 'ready').length === 4, 30_000);
    assert.equal((await me.api('/api/resources', { name: 'photos' })).status, 201);
    const errors = [];
    me.page.on('pageerror', (e) => errors.push(String(e)));
    /* Without the wobble of edit mode (the browser's « reduce motion »): a moving button is never "stable" to click. */
    await me.page.emulateMedia({ reducedMotion: 'reduce' });

    /* The bare address opens on the desk; the first time, the home cards are on it, kept at once. */
    await me.page.goto(new URL('/', me.page.url()).href);
    await me.until('the desk is the page of arrival', async () => (await me.page.locator('#deck').isVisible()) && (await me.page.locator('#desk > .desk-tile').count()) === 4);
    assert.equal(new URL(me.page.url()).search, '', 'the bare address stays bare');
    const kept = async () => (await me.api('/api/desktop')).body;
    await me.until('the first desk is kept', async () => (await kept()).saved === true);
    assert.deepEqual((await kept()).items.map((x) => x.id).sort(), ['c:alpha', 'c:beta', 'c:delta', 'c:gamma']);
    assert.ok((await kept()).items.every((x) => x.size === 'm'), 'as the home cards: wide');
    /* The cards are the kit's, as in the list: a conversation's name, as text. */
    assert.equal(await me.page.locator(`${tile('c:alpha')} .kit-conv-head b`).innerText(), 'Alpha');
    await shot(me.page, 'bureau-ordi-jour1');

    /* EDIT: free cells dotted, « ⋯ » on each. Alpha made an icon from its menu. */
    await me.page.locator('.desk-edit').click();
    await me.until('edit mode', async () => (await me.page.locator('#desk > .desk-cell').count()) > 0 && me.page.locator('.desk-tidy').isVisible());
    await me.page.locator(`${tile('c:alpha')} .desk-more`).click();
    await me.page.locator('.desk-menu [data-act="size-s"]').click();
    await me.until('alpha is an icon', async () => (await me.page.locator(`${tile('c:alpha')}.desk-s`).count()) === 1);
    await me.page.keyboard.press('Escape');
    await me.until('the menu is closed', async () => (await me.page.locator('.desk-menu').count()) === 0);
    const cols = await me.page.evaluate(() => getComputedStyle(document.getElementById('desk')).gridTemplateColumns.split(' ').length);
    assert.ok(cols >= 6, `${cols} columns on a wide screen`);

    /* Put in any cell, far from the others. */
    await dragTo(me.page, tile('c:alpha'), { cell: await cellPoint(me.page, cols, 3) });
    await me.until('alpha where it was put', async () => (await placeOf(me.page, 'c:alpha')).join() === `${cols},3`);
    await me.until('kept by the server', async () => { const a = (await kept()).items.find((x) => x.id === 'c:alpha'); return a?.c === cols && a?.r === 3 && a.size === 's'; });
    await shot(me.page, 'bureau-ordi-edition');

    /* A PHONE of the same person: the same desk; alpha's column is past its edge: shown in the first free cell, its place kept. */
    /* On a phone the list is the first screen; the desk is its title, one tap away. */
    const phone = await b.person({ phone: true });
    await phone.until('the list first on a phone', async () => phone.page.locator('#items').isVisible());
    await phone.page.locator('#list-title').click();
    await phone.until('the desk on the phone', async () => (await phone.page.locator('#desk > .desk-tile').count()) === 4);
    const phoneCols = await phone.page.evaluate(() => getComputedStyle(document.getElementById('desk')).gridTemplateColumns.split(' ').length);
    assert.ok(phoneCols < cols && phoneCols >= 3, `${phoneCols} columns on a phone`);
    assert.notEqual((await placeOf(phone.page, 'c:alpha'))[0], cols);
    assert.ok(await phone.page.locator(`${tile('c:alpha')}.desk-s`).count() === 1, 'its size, the same');
    await shot(phone.page, 'bureau-tel');
    await phone.page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await shot(phone.page, 'bureau-tel-clair');
    assert.equal((await kept()).items.find((x) => x.id === 'c:alpha').c, cols, 'a phone never rewrites a place');
    await phone.page.context().close();
    /* A tablet's width: the same desk, fewer columns, nothing over the edge. */
    const was = me.page.viewportSize();
    await me.page.setViewportSize({ width: 820, height: 1180 });
    await me.until('the desk on a tablet', async () => (await me.page.locator('#desk > .desk-tile').count()) === 4);
    assert.ok(await me.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a tablet');
    await shot(me.page, 'bureau-tablette');
    await me.page.setViewportSize(was);

    /* Put on a taken cell: the one there goes to the first free cell. */
    await dragTo(me.page, tile('c:beta'), { cell: await (async () => { await me.page.locator(tile('c:alpha')).waitFor({ state: 'visible' }); const bx = await me.page.locator(tile('c:alpha')).boundingBox(); return [bx.x + 14, bx.y + 14]; })() });
    /* Beta is wide: on the last column it takes the two last cells, alpha's among them. */
    await me.until('beta took alpha\'s cell', async () => (await placeOf(me.page, 'c:beta')).join() === `${cols - 1},3`);
    assert.notEqual((await placeOf(me.page, 'c:alpha')).join(), `${cols},3`);

    /* Dropped on the middle of another, held a moment: a folder, opened to be named. */
    await me.page.locator(tile('c:alpha')).waitFor({ state: 'visible' });
    const onto = await me.page.locator(tile('c:alpha')).boundingBox();
    await dragTo(me.page, tile('c:gamma'), { point: [onto.x + onto.width / 2, onto.y + onto.height / 2], hold: 500 });
    await me.until('a folder is made and opened', async () => me.page.locator('.desk-sheet .desk-folder-input').isVisible());
    await me.page.locator('.desk-folder-input').fill('Projets <b>');
    assert.equal(await me.page.locator('.desk-sheet > .desk-in-folder > .desk-tile').count(), 2);
    await me.page.locator('.desk-sheet .desk-close').click();
    const folder = me.page.locator('#desk > .desk-tile.desk-is-folder');
    await me.until('the folder on the desk, named as text', async () => (await folder.count()) === 1 && (await folder.locator('.desk-folder-name').innerText()) === 'Projets <b>');
    assert.equal(await folder.locator('.desk-folder-name b').count(), 0, 'never markup');
    const folderId = await folder.getAttribute('data-id');
    await me.until('the folder is kept', async () => { const f = (await kept()).items.find((x) => x.id === folderId); return f?.folder === 'Projets <b>' && f.items.join() === 'c:alpha,c:gamma'; });
    /* The list did not change: its groups are not the desk's folders. */
    assert.equal(await me.page.locator('#items .group[data-group="Projets <b>"]').count(), 0);

    /* Sizes: the folder large, Delta wide still; the keyboard moves Delta down one row. */
    await folder.locator('.desk-more').click();
    await me.page.locator('.desk-menu [data-act="size-l"]').click();
    await me.page.keyboard.press('Escape');
    await me.until('the folder is large', async () => (await me.page.locator(`${tile(folderId)}.desk-l`).count()) === 1);
    const before = await placeOf(me.page, 'c:delta');
    await me.page.locator(tile('c:delta')).focus();
    await me.page.keyboard.press('ArrowDown');
    await me.until('delta one row down', async () => (await placeOf(me.page, 'c:delta')).join() === `${before[0]},${before[1] + 1}`);
    await shot(me.page, 'bureau-ordi-dossier');

    /* TIDY: packed to the top left. */
    await me.page.locator('.desk-tidy').click();
    /* The folder (large), Delta and Beta (wide), in their reading order: side by side on the first row. */
    await me.until('packed', async () => JSON.stringify(Object.values(await seen(me.page)).map(([c, r]) => [c, r]).sort((x, y) => x[0] - y[0])) === '[[1,1],[3,1],[5,1]]');
    await me.until('kept packed', async () => (await kept()).items.every((x) => x.c === undefined && x.r === undefined));
    await me.page.locator('.desk-edit').click();
    await me.until('edit mode left', async () => (await me.page.locator('#desk > .desk-cell').count()) === 0);

    /* + Add: an asset of the server, as a shortcut. */
    await me.page.locator('.desk-add').click();
    await me.page.locator('.desk-pick-row[data-id="a:folder:photos"]').click();
    await me.page.keyboard.press('Escape');
    await me.until('the folder of photos on the desk', async () => (await me.page.locator(tile('a:folder:photos')).count()) === 1);
    await wait(600);
    const layout = await seen(me.page);
    await me.until('kept with it', async () => (await kept()).items.some((x) => x.id === 'a:folder:photos'));

    /* RELOAD: the same desk, from the server. */
    await me.page.reload();
    await me.until('the desk again, its assets read', async () => (await me.page.locator('#desk > .desk-tile').count()) === 4);
    assert.deepEqual(await seen(me.page), layout);
    assert.equal(await me.page.locator(`${tile(folderId)} .desk-folder-name`).innerText(), 'Projets <b>');
    if (SHOTS) await me.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot(me.page, 'bureau-ordi');
    await me.page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await shot(me.page, 'bureau-ordi-clair');

    /* A folder opens; a thing in it opens its conversation. */
    await me.page.locator(tile(folderId)).click();
    await me.until('the folder is open', async () => (await me.page.locator('.desk-sheet .desk-in-folder > .desk-tile').count()) === 2);
    await me.page.locator('.desk-sheet .desk-tile[data-id="c:gamma"]').click();
    await me.until('gamma is open', async () => new URL(me.page.url()).searchParams.get('c') === 'gamma' && !(await me.page.locator('#deck').isVisible()));

    /* « Home » in the menu brings the desk back, and folds the list away as the other places do. */
    if ((await me.page.locator('#app').getAttribute('data-list')) === 'folded') await me.page.locator('#fold').click();
    /* The four places under the list, two by two (17-11): two rows, two columns, each label whole. */
    await me.until('the places shown', async () => me.page.locator('#nav-home').isVisible());
    const places = await me.page.evaluate(() => ['nav-home', 'nav-assets', 'nav-access', 'nav-settings'].map((id) => { const b = document.getElementById(id); const r = b.getBoundingClientRect(); const t = b.querySelector('span'); return { top: Math.round(r.top), left: Math.round(r.left), whole: t.scrollWidth <= t.clientWidth + 1 }; }));
    assert.equal(new Set(places.map((p) => p.top)).size, 2, JSON.stringify(places));
    assert.equal(new Set(places.map((p) => p.left)).size, 2, JSON.stringify(places));
    assert.ok(places.every((p) => p.whole), 'each label whole');
    await shot(me.page, 'bureau-lieux-2x2');
    await me.page.locator('#nav-home').click();
    await me.until('the desk again by Home', async () => me.page.locator('#deck').isVisible());
    assert.equal(await me.page.locator('#nav-home').getAttribute('aria-current'), 'page');
    await me.until('the list folded', async () => (await me.page.locator('#app').getAttribute('data-list')) === 'folded');

    /* A TAP on a touch screen opens a folder, and it stays open (16-11: the click after the tap closed it). */
    const touch = await b.person({ phone: true });
    await touch.page.locator('#nav-home').tap();
    await touch.until('the desk on the touch screen', async () => (await touch.page.locator(tile(folderId)).count()) === 1);
    await touch.page.locator(tile(folderId)).tap();
    await touch.until('the folder open after a tap', async () => (await touch.page.locator('.desk-sheet .desk-in-folder > .desk-tile').count()) === 2);
    await wait(500);
    assert.equal(await touch.page.locator('.desk-sheet .desk-in-folder > .desk-tile').count(), 2, 'still open');
    await touch.page.context().close();
    assert.deepEqual(errors, []);
});
