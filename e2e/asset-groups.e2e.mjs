/* Groups of assets (assets step 5): the groups first in Assets, a group opened in the same panel as an asset,
   a level given to a conversation on every member that takes it (the others skipped, said once), « None » from
   all, a group made from any view and from an asset's chip, renamed, removed (its assets stay), a drag kept.
   A right stays stored asset by asset: the group is only a label. With CLAVARIUM_SHOTS set, pictures too. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('a group: listed first, opened in the asset panel, given to every member, made from any view, renamed, removed', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await me.create('cuisine');
    for (const name of ['photos', 'recipes', 'invoices']) assert.equal((await me.api('/api/resources', { name })).status, 201, name);
    assert.equal((await me.api('/api/secrets', { name: 'SHOP_KEY', value: 'a-key-never-shown' })).status, 201);
    const home = (await me.api('/api/asset-groups', { label: 'Home' })).body;
    for (const asset of ['folder:photos', 'folder:recipes', 'secret:SHOP_KEY']) assert.equal((await me.api('/api/asset-groups/place', { asset, group: home.id })).status, 200, asset);
    const attached = async (name) => (await me.api('/api/resources')).body.find((r) => r.name === name)?.attachments?.cuisine ?? 'none';
    const handed = async () => (await me.api('/api/secrets')).body.find((s) => s.name === 'SHOP_KEY').conversations.includes('cuisine');

    /* The groups first, by default once one exists; then « No group ». */
    await me.openAccess('assets');
    await me.until('the groups view', async () => (await page.locator('#assets-rows .kit-aslist-sec').count()) === 2);
    assert.equal(await page.locator('#assets-view button[aria-pressed="true"]').getAttribute('data-value'), 'group');
    assert.deepEqual(await page.locator('#assets-rows .kit-aslist-sec').evaluateAll((s) => s.map((x) => x.dataset.drop)), [home.id, '']);
    const head = page.locator(`#assets-rows .kit-aslist-open[data-group="${home.id}"]`);
    assert.match(await head.innerText(), /Home\s*3/i);
    /* ▾ folds it (its rows go), again opens it. */
    await page.locator(`#assets-rows .kit-aslist-sec[data-drop="${home.id}"] .kit-aslist-fold`).click();
    await me.until('folded', async () => (await page.locator(`#assets-rows .kit-aslist-sec[data-drop="${home.id}"] .as-row`).count()) === 0);
    await page.locator(`#assets-rows .kit-aslist-sec[data-drop="${home.id}"] .kit-aslist-fold`).click();
    await me.until('open', async () => (await page.locator(`#assets-rows .kit-aslist-sec[data-drop="${home.id}"] .as-row`).count()) === 3);

    /* Its name opens it in the asset panel: who has it, its members, rename, remove. */
    await head.click();
    const panel = page.locator('#assets-detail .as-group-panel');
    await me.until('the group opened', async () => (await panel.count()) === 1 && (await panel.locator('h2').innerText()) === 'Home');
    assert.equal(await head.getAttribute('aria-current'), 'true');
    assert.equal(await panel.locator('.as-group-members .as-row').count(), 3);
    assert.match(await panel.innerText(), /No conversation uses it/);
    await shot(page, 'desktop-group-opened');
    /* Read for cuisine: both folders read; the secret skipped, said once. */
    await panel.locator('.as-chapter .as-add').click();
    await panel.locator('.as-picker .given-row[data-conversation="cuisine"] button', { hasText: 'Read' }).click();
    await me.until('both folders read', async () => (await attached('photos')) === 'read' && (await attached('recipes')) === 'read');
    assert.equal(await handed(), false, 'a secret only takes Use');
    await me.until('the skip said', async () => (await page.locator('#assets-detail .as-group-skipped').innerText().catch(() => '')) === '1 skipped: Secret, Use only');
    const row = page.locator('#assets-detail .kit-access-given .given-row[data-conversation="cuisine"]');
    await me.until('2 of 3, no level pressed', async () => /2 of 3/.test(await row.innerText().catch(() => '')) && (await row.locator('button[aria-pressed="true"]').count()) === 0);
    await shot(page, 'desktop-group-given');
    /* Use: the secret too; the folders keep their Read. */
    await row.locator('button', { hasText: 'Use' }).click();
    await me.until('the secret handed', handed);
    assert.equal(await attached('photos'), 'read');
    await me.until('the folders said skipped', async () => /2 skipped: Folder, Read \/ Write only/.test(await page.locator('#assets-detail .as-group-skipped').innerText().catch(() => '')));
    /* Write: every folder writes, nothing else changes. */
    await row.locator('button', { hasText: 'Write' }).click();
    await me.until('both folders write', async () => (await attached('photos')) === 'write' && (await attached('recipes')) === 'write');
    assert.equal(await handed(), true);
    /* None: from every member. */
    await row.locator('button', { hasText: 'None' }).click();
    await me.until('taken from all', async () => (await attached('photos')) === 'none' && (await attached('recipes')) === 'none' && !(await handed()));
    await me.until('nobody again', async () => /No conversation uses it/.test(await panel.innerText()));
    /* A member opens. */
    await panel.locator('.as-group-members .as-row[data-asset="folder:recipes"]').click();
    await me.until('recipes opened', async () => (await page.locator('#assets-detail h2').innerText()) === 'recipes');

    /* An asset's group, a chip on its head: « New group… » made there, the asset placed in it. */
    const chip = page.locator('#assets-detail .kit-groupchip-sel');
    assert.equal(await chip.inputValue(), home.id);
    await chip.selectOption('+new');
    await page.fill('#assets-detail .kit-groupchip-form input', 'Kitchen');
    await page.locator('#assets-detail .kit-groupchip-form button[type=submit]').click();
    await me.until('recipes in Kitchen', async () => (await me.api('/api/asset-groups')).body.find((g) => g.label === 'Kitchen')?.members.includes('folder:recipes'));
    assert.deepEqual((await me.api('/api/asset-groups')).body.find((g) => g.id === home.id).members, ['folder:photos', 'secret:SHOP_KEY'], 'a folder move');
    await me.until('the chip says Kitchen', async () => (await chip.locator('option:checked').innerText()) === 'Kitchen');
    /* Out of any group, from the chip. */
    await chip.selectOption('');
    await me.until('recipes in no group', async () => !(await me.api('/api/asset-groups')).body.some((g) => g.members.includes('folder:recipes')));

    /* Made from the Types view too: then opened, empty. */
    await page.locator('#assets-view button[data-value="type"]').click();
    await me.until('the types view', async () => (await page.locator('#assets-rows .kit-aslist[data-view="type"]').count()) === 1);
    await page.locator('#assets-rows .as-group-add').click();
    await page.fill('#assets-rows .as-group-form input', 'Spare');
    await page.locator('#assets-rows .as-group-form button[type=submit]').click();
    await me.until('Spare opened', async () => (await panel.count()) === 1 && (await panel.locator('h2').innerText()) === 'Spare');
    assert.match(await panel.innerText(), /Empty: pick this group on an asset/);
    /* Renamed in place. */
    await panel.locator('.as-group-rename-open').click();
    await page.fill('#assets-detail .as-group-rename input', 'Garage');
    await page.locator('#assets-detail .as-group-rename button[type=submit]').click();
    await me.until('renamed', async () => (await panel.locator('h2').innerText().catch(() => '')) === 'Garage');
    /* Removed, asked in place: the label goes, the assets stay. */
    await page.locator('#assets-view button[data-value="group"]').click();
    await head.click();
    await me.until('Home opened', async () => (await panel.locator('h2').innerText().catch(() => '')) === 'Home');
    await panel.locator('.danger-link').click();
    assert.match(await panel.locator('.kit-confirm').innerText(), /Its assets stay; only the group goes/);
    await panel.locator('.kit-confirm button', { hasText: 'Remove' }).click();
    await me.until('Home is gone', async () => !(await me.api('/api/asset-groups')).body.some((g) => g.id === home.id));
    assert.deepEqual((await me.api('/api/resources')).body.map((r) => r.name).filter((n) => ['photos', 'recipes', 'invoices'].includes(n)).sort(), ['invoices', 'photos', 'recipes']);
    assert.ok((await me.api('/api/secrets')).body.some((s) => s.name === 'SHOP_KEY'), 'the secret stays');

    /* Dragged onto a group, still (a mouse, after a few pixels). */
    const kitchen = (await me.api('/api/asset-groups')).body.find((g) => g.label === 'Kitchen');
    const from = page.locator('#assets-rows .as-row[data-asset="folder:invoices"]');
    const to = page.locator(`#assets-rows .kit-aslist-sec[data-drop="${kitchen.id}"]`);
    await me.until('both shown', async () => (await from.count()) === 1 && (await to.count()) === 1);
    const a = await from.boundingBox(); const z = await to.boundingBox();
    await page.mouse.move(a.x + 40, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + 50, a.y + a.height / 2 + 10, { steps: 3 });
    await page.mouse.move(z.x + 60, z.y + 12, { steps: 8 }); await page.mouse.up();
    await me.until('invoices in Kitchen', async () => (await me.api('/api/asset-groups')).body.find((g) => g.id === kitchen.id).members.includes('folder:invoices'));

    /* A phone: the list, then the group; « ‹ Assets » back. */
    const phone = await b.person({ phone: true });
    await phone.page.locator('#nav-assets').tap();
    const phead = phone.page.locator(`#assets-rows .kit-aslist-open[data-group="${kitchen.id}"]`);
    await phone.until('the groups on a phone', async () => (await phead.count()) === 1);
    await shot(phone.page, 'phone-groups');
    await phead.tap();
    await phone.until('the group on a phone', async () => (await phone.page.locator('#assets-detail .as-group-panel h2').innerText().catch(() => '')) === 'Kitchen');
    await shot(phone.page, 'phone-group-opened');
    await phone.page.locator('#assets-detail .as-back').tap();
    await phone.until('the list again', async () => await phone.page.locator('#assets-rows').isVisible() && !(await phone.page.locator('#assets-detail').isVisible()));
    assert.deepEqual(me.errors, []);
    assert.deepEqual(phone.errors, []);
});
