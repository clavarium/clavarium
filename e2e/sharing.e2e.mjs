import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

/* The owner shares a conversation and gives back the address a QR code carries. */
/* From a conversation: it is in the basket already; a name, and the code. */
async function share(owner, label = 'A phone') {
    await owner.page.locator('#folders').click();
    await owner.until('its sheet is shown', async () => owner.page.locator('#share').isVisible());
    await owner.page.locator('#share').click();
    await owner.until('the basket holds the conversation', async () => (await owner.page.locator('#share-basket .folder').count()) === 1);
    await owner.page.fill('#sharing-label', label);
    await owner.page.locator('#sharing-new').click();
    await owner.until('a code is shown', async () => owner.page.locator('#sharing-qr').isVisible());
    const url = await owner.page.locator('#sharing-link').innerText();
    await owner.page.locator('#sharing-close').click();
    return url;
}

test('a phone that scans the code is welcomed in plain words, then sees that conversation and nothing else', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    await owner.create('private-work', 'Other tool');
    await owner.page.locator('#items .item', { hasText: 'family' }).click();
    await owner.until('family is live', async () => (await owner.state()) === 'live');
    const url = await share(owner);
    assert.match(url, /\/c\/#[A-Za-z0-9_-]{43}$/);

    const phone = await b.person({ phone: true, at: url.replace(/^https?:\/\/[^/]+/, '') });
    /* Before any dark screen: what this is, and what to do. */
    await phone.until('the welcome is shown', async () => /You are connected to "family"/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')));
    assert.equal(new URL(phone.page.url()).hash, '', 'the code has left the address bar');
    /* The welcome waits for the person: it is still there seconds later (on
       the live site the terminal's first output used to wipe it away). */
    await wait(3000);
    assert.equal(await phone.page.locator('#notice-action', { hasText: 'Start' }).isVisible(), true);
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('the phone is live', async () => (await phone.state()) === 'live');
    await phone.type('echo from-the-phone');
    await phone.sees('from-the-phone');
    /* Found by a tester: dictation was missing until the page was reloaded. */
    assert.equal(await phone.page.locator('#mic').isVisible(), true, 'Dictate is offered from the first visit');
    /* No list, nothing of the owner's side, and no other conversation by any address. */
    assert.equal(await phone.page.locator('#list').count(), 0);
    assert.equal(await phone.page.locator('#archive').count(), 0);
    /* (This bench has no sign-on in front, so the owner's side is not closed
       here: that it is closed to a device is proved in test/door.test.mjs.) */
    const id = await phone.page.evaluate(() => document.documentElement.dataset.pairing);
    assert.equal((await phone.api(`/c/api/${id}/me`)).body.name, 'family');
    assert.equal((await phone.api(`/c/api/${id}/files?c=private-work&r=anything&p=`)).status, 404);
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'nothing overflows a phone screen');
    assert.deepEqual(phone.errors, []);
});

test('a code works once; a removed device is out at once, with nothing left on screen that cannot work', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    const url = await share(owner);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const phone = await b.person({ phone: true, at: path });
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('the phone is live', async () => (await phone.state()) === 'live');

    const second = await b.person({ phone: true, at: path });
    await second.until('the second device is told the code is spent', async () => /already used|too old/.test(await second.page.locator('#notice-text').innerText().catch(() => '')));
    assert.equal(await second.page.locator('#keys').isVisible(), false);

    /* The owner removes the phone, in two clicks. */
    await owner.page.locator('#notice-action').click().catch(() => {});
    await owner.page.locator('#sharing-open').click();
    await owner.until('the phone is listed', async () => (await owner.page.locator('#sharing-devices .device').count()) === 1);
    await owner.page.locator('#sharing-devices .device button', { hasText: 'Revoke device' }).click();
    await owner.page.locator('#sharing-devices button.danger').click();
    await owner.until('no device left', async () => (await owner.page.locator('#sharing-devices .device').count()) === 0);
    await owner.page.locator('#sharing-close').click();

    await phone.until('the phone says it is out, in words', async () => /was closed, or this device was removed/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')), 25_000);
    for (const gone of ['#keys', '#shortcuts', '#files-open']) assert.equal(await phone.page.locator(gone).isVisible(), false, `${gone} is no longer offered`);

    /* A new code, opened in the SAME tab, pairs it again (it did nothing before the fix). */
    const again = (await share(owner, 'The same phone')).replace(/^https?:\/\/[^/]+/, '');
    await phone.page.evaluate((to) => { location.href = to; }, again);
    await phone.until('welcomed again', async () => /You are connected to "family"/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')));
});

test('shared with a phone: files of the conversation, and only where the owner allowed writing', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    for (const [folder, access] of [['photos', 'Write'], ['papers', 'Read']]) {
        await owner.newFolder(folder);
        await owner.access(folder, access);
        await owner.until(`${folder} is attached`, async () => (await owner.page.locator('#chips').innerText()).includes(`${folder} - ${access.toLowerCase()}`));
    }
    const url = await share(owner);
    const phone = await b.person({ phone: true, at: url.replace(/^https?:\/\/[^/]+/, '') });
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('the phone is live', async () => (await phone.state()) === 'live');

    const local = join(mkdtempSync(join(tmpdir(), 'clv-photo-')), 'beach.txt');
    writeFileSync(local, 'the sea\n');
    await phone.page.locator('#files-open').click();
    await phone.page.locator('#files-tabs button', { hasText: 'photos' }).click();
    const [chooser] = await Promise.all([phone.page.waitForEvent('filechooser'), phone.page.locator('#files-import').click()]);
    await chooser.setFiles(local);
    await phone.until('the import is listed', async () => (await phone.page.locator('#files-rows').innerText()).includes('beach.txt'));
    assert.match(await phone.page.locator('#files-rows').innerText(), /8 bytes/);
    /* The tool sees it at once, in its own machine. */
    await phone.page.locator('#files-close').click();
    await phone.type('cat ../resources/photos/beach.txt');
    await phone.sees('the sea');
    /* Read-only is said, and enforced by the server whatever the page shows. */
    await phone.page.locator('#files-open').click();
    await phone.page.locator('#files-tabs button', { hasText: 'papers' }).click();
    await phone.until('read-only is said', async () => phone.page.locator('#files-readonly').isVisible());
    assert.equal(await phone.page.evaluate(async () => (await fetch(`/c/api/${document.documentElement.dataset.pairing}/files/import?r=papers&p=&name=x.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status), 403);
});

test('several conversations on the same device: each code adds one, the device passes from one to the other, and can drop one', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    await owner.create('garden');
    const codeFor = async (name) => (await owner.api(`/api/conversations/${name}/share`, {})).body.url.replace(/^https?:\/\/[^/]+/, '');
    const phone = await b.person({ phone: true, at: await codeFor('family') });
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('family is live', async () => (await phone.state()) === 'live');
    assert.equal(await phone.page.locator('#others').innerText(), 'This device');
    await phone.type('echo typed-in-family');
    await phone.sees('typed-in-family');
    /* A second code, scanned on the same device: ADDED, and shown. */
    await phone.page.goto(b.origin + await codeFor('garden'));
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('garden is live', async () => (await phone.state()) === 'live' && (await phone.page.locator('#name').innerText()) === 'garden');
    assert.equal(await phone.page.locator('#others').innerText(), 'Conversations (2)');
    assert.deepEqual((await owner.api('/api/conversations/family/devices')).body.length, 1, 'the first pairing is still there');
    /* A third way in, for an installed app that cannot scan: the link, pasted. */
    await owner.create('workshop');
    await phone.page.locator('#others').click();
    await phone.page.fill('#others-link', 'not a link');
    await phone.page.locator('#others-add button[type=submit]').click();
    assert.match(await phone.page.locator('#others-error').innerText(), /not a link to a shared conversation/);
    await phone.page.fill('#others-link', b.origin + await codeFor('workshop'));
    await phone.page.locator('#others-add button[type=submit]').click();
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('workshop is live', async () => (await phone.state()) === 'live' && (await phone.page.locator('#name').innerText()) === 'workshop');
    assert.equal(await phone.page.locator('#others').innerText(), 'Conversations (3)');
    await phone.page.locator('#others').click();
    await phone.page.locator('#others-rows .folder', { hasText: 'workshop' }).locator('button', { hasText: 'Remove from this device' }).click();
    await phone.page.locator('#others-rows .folder', { hasText: 'workshop' }).locator('button', { hasText: 'Yes, remove it' }).click();
    await phone.until('back to two', async () => (await phone.page.locator('#others').innerText().catch(() => '')) === 'Conversations (2)' && (await phone.state()) === 'live');
    /* Back to the first one: its terminal is as it was left. */
    await phone.page.locator('#others').click();
    assert.match(await phone.page.locator('#others-rows').innerText(), /garden \(shown now\)/);
    await phone.page.locator('#others-rows .folder', { hasText: 'family' }).locator('button', { hasText: 'Open' }).click();
    await phone.until('family is shown again', async () => (await phone.state()) === 'live' && (await phone.page.locator('#name').innerText()) === 'family');
    await phone.sees('typed-in-family');
    /* The same conversation shared again with this device: still two, not three. */
    await phone.page.goto(b.origin + await codeFor('family'));
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('family again', async () => (await phone.state()) === 'live');
    assert.equal(await phone.page.locator('#others').innerText(), 'Conversations (2)');
    await owner.until('the older pairing was given back', async () => (await owner.api('/api/conversations/family/devices')).body.length === 1);
    /* The device drops one itself: gone here, gone for the owner; the other stays. */
    await phone.page.locator('#others').click();
    const garden = phone.page.locator('#others-rows .folder', { hasText: 'garden' });
    await garden.locator('button', { hasText: 'Remove from this device' }).click();
    await garden.locator('button', { hasText: 'Yes, remove it' }).click();
    await phone.until('one conversation is left', async () => (await phone.page.locator('#others').innerText().catch(() => '')) === 'This device' && (await phone.state()) === 'live');
    assert.equal(await phone.page.locator('#name').innerText(), 'family');
    assert.deepEqual((await owner.api('/api/conversations/garden/devices')).body, []);
    /* The owner removes the last one: the device says so, and offers nothing that cannot work. */
    const last = (await owner.api('/api/conversations/family/devices')).body[0].id;
    await owner.api(`/api/devices/${last}/revoke`, {});
    await phone.page.reload();
    await phone.until('the device says it was removed', async () => /removed from it|not connected/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')));
});

test('a device paired before several conversations were possible keeps its conversation, without a new code', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    const url = (await owner.api('/api/conversations/family/share', {})).body.url.replace(/^https?:\/\/[^/]+/, '');
    const phone = await b.person({ phone: true, at: url });
    await phone.page.locator('#notice-action', { hasText: 'Start' }).click();
    await phone.until('live', async () => (await phone.state()) === 'live');
    /* What that earlier version had written on the device: one key, one name. */
    await phone.page.evaluate(() => new Promise((done, failed) => {
        const open = indexedDB.open('clavarium-device', 1);
        open.onerror = () => failed(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite'); const keys = tx.objectStore('keys');
            const id = document.documentElement.dataset.pairing;
            const read = keys.get(`key:${id}`);
            read.onsuccess = () => { keys.put(read.result, 'private'); keys.put(id, 'device'); keys.delete(`key:${id}`); keys.delete('pairings'); keys.delete('current'); };
            tx.oncomplete = done; tx.onerror = () => failed(tx.error);
        };
    }));
    await phone.context.clearCookies();
    await phone.page.reload();
    await phone.until('it is in its conversation again', async () => (await phone.state()) === 'live' && (await phone.page.locator('#name').innerText()) === 'family', 30_000);
    assert.equal((await owner.api('/api/conversations/family/devices')).body.length, 1, 'the same pairing, not a new one');
});

test('a share is a basket: the conversation shown, one more, a folder to read -- named, coded, then seen by device and by thing', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    await owner.create('garden');
    await owner.api('/api/resources', { name: 'recipes' });
    await owner.api('/api/resources', { name: 'accounts' });
    await owner.page.locator('#folders').click();
    await owner.until('its sheet is shown', async () => owner.page.locator('#share').isVisible());
    await owner.page.locator('#share').click();
    /* Only the conversation the owner came from is in the basket; nothing else was chosen for them. */
    await owner.until('the basket is shown', async () => (await owner.page.locator('#share-basket .folder').count()) === 1);
    assert.match(await owner.page.locator('#share-basket').innerText(), /garden conversation\s+Use - the whole terminal/);
    const add = (name) => owner.page.locator('#share-add .folder', { hasText: name }).locator('button').click();
    await add('family');
    await add('recipes');
    /* Added to read: writing is asked for, never assumed. */
    const recipes = owner.page.locator('#share-basket .folder', { hasText: 'recipes' });
    assert.equal(await recipes.locator('.levels button[aria-pressed=true]').innerText(), 'Read');
    assert.equal(await owner.page.locator('#share-add .folder', { hasText: 'recipes' }).locator('button').innerText(), 'Added');
    /* No name, no code. */
    assert.equal(await owner.page.locator('#sharing-new').isDisabled(), true);
    await owner.page.fill('#sharing-label', "Dad's tablet");
    assert.match(await owner.page.locator('#sharing-summary').innerText(), /Dad's tablet will be able to use garden, family - the whole terminal, as root in its machine, with the files of that conversation; and read recipes\./);
    assert.equal(await owner.page.locator('#sharing-new').innerText(), "Show a code for Dad's tablet");
    await owner.page.locator('#sharing-new').click();
    await owner.until('the code is shown, counted down', async () => /Works once, for \d:\d\d\./.test(await owner.page.locator('#sharing-status').innerText()));
    assert.match(await owner.page.locator('#share-waiting').innerText(), /Waiting for Dad's tablet/);
    const url = (await owner.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    const tablet = await b.person({ phone: true, at: url });
    await tablet.page.locator('#notice-action', { hasText: 'Start' }).click();
    await tablet.until('live', async () => (await tablet.state()) === 'live');
    /* The owner's screen says so by itself. */
    await owner.until('it says the tablet is connected', async () => /Dad's tablet is connected/.test(await owner.page.locator('#share-waiting').innerText()), 20_000);
    await owner.page.locator('#share-done').click();
    assert.equal(await tablet.page.locator('#others').innerText(), 'Conversations (2)');
    await tablet.page.locator('#files-open').click();
    const tab = tablet.page.locator('#files-tabs button', { hasText: 'recipes' });
    assert.match(await tab.innerText(), /recipes - read \(given to this device\)/);
    await tablet.page.locator('#files-close').click();

    /* WHO HAS WHAT, by device: a card with a name, what it has, each thing with its way back. */
    const card = owner.page.locator('#sharing-devices .device', { hasText: "Dad's tablet" });
    await owner.until('the card lists what it has', async () => (await card.locator('.given-row').count()) === 3);
    /* A right is changed in place, with no new code... */
    await card.locator('.given-row', { hasText: 'recipes' }).locator('.levels button', { hasText: 'Write' }).click();
    await owner.until('recipes is to write now', async () => (await owner.api('/api/devices')).body[0].grants.some((g) => g.asset === 'folder:recipes' && g.rights === 'rw'));
    /* ...more is given the same way... */
    await card.locator('button', { hasText: '+ Give more' }).click();
    await owner.until('the basket is the tablet\'s', async () => (await owner.page.locator('#share-basket .folder').count()) === 3);
    await add('accounts');
    assert.equal(await owner.page.locator('#sharing-new').innerText(), 'Save changes');
    await owner.page.locator('#sharing-new').click();
    await owner.until('accounts is given', async () => (await card.locator('.given-row').count()) === 4);
    /* ...it is renamed in place... */
    await card.locator('button', { hasText: 'Rename' }).click();
    const only = owner.page.locator('#sharing-devices .device').first();      /* its name is a field now */
    await only.locator('input').fill('Papa');
    await only.locator('button', { hasText: 'Save' }).click();
    await owner.until('it is called Papa', async () => (await owner.page.locator('#sharing-devices .device', { hasText: 'Papa' }).count()) === 1);
    /* BY THING: who can see this folder? */
    await owner.page.locator('#share-by-thing').click();
    const thing = owner.page.locator('#share-things .thing', { hasText: 'recipes - folder - 1 device' });
    await owner.until('recipes names its one device', async () => /Papa/.test(await thing.innerText().catch(() => '')));
    /* Taken back from there, asked twice. */
    await thing.locator('button', { hasText: 'Take back' }).click();
    await owner.page.locator('#share-things button.danger').click();
    await owner.until('recipes is shared with nobody', async () => /Not shared \(\d\)/.test(await owner.page.locator('#share-things').innerText()) && !(await owner.api('/api/devices')).body[0].grants.some((g) => g.asset === 'folder:recipes'));
    await owner.page.locator('#sharing-close').click();
    /* Seen at a glance, outside the sheet. */
    await owner.until('the list marks both conversations as shared', async () => (await owner.page.locator('#items .shared-mark').count()) === 2);
    assert.match(await owner.page.locator('#sharing-open').innerText(), /Devices & sharing \(1\)/);
    /* The tablet finds the changes by itself: accounts given, recipes gone. */
    await tablet.page.reload();
    await tablet.until('live again', async () => (await tablet.state()) === 'live');
    await tablet.page.locator('#files-open').click();
    await tablet.until('its tabs follow', async () => { const tabs = (await tablet.page.locator('#files-tabs button').allInnerTexts()).join('|'); return /accounts/.test(tabs) && !/recipes/.test(tabs); });
    assert.deepEqual(owner.errors, []);
});

test('a folder is shared from its own row, alone and to read; a code not wanted any more is cancelled', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('private');
    await owner.api('/api/resources', { name: 'album' });
    await owner.page.locator('#assets-open').click();
    const album = owner.page.locator('#assets-folder .asset[data-name="album"]');
    await album.locator('.asset-head').click();
    await album.locator('button', { hasText: 'Share...' }).click();
    /* The folder, to read, and NOT the conversation behind the panel. */
    await owner.until('the basket holds the folder only', async () => (await owner.page.locator('#share-basket .folder').count()) === 1);
    assert.match(await owner.page.locator('#share-basket').innerText(), /album folder/);
    await owner.page.fill('#sharing-label', 'Aunt');
    await owner.page.locator('#sharing-new').click();
    await owner.until('a code is shown', async () => owner.page.locator('#sharing-qr').isVisible());
    const url = (await owner.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    /* Changed their mind: the code stops working at once, and the basket is as it was. */
    await owner.page.locator('#share-cancel').click();
    await owner.until('back to the basket', async () => (await owner.page.locator('#share-basket .folder').count()) === 1 && (await owner.page.locator('#sharing-label').inputValue()) === 'Aunt');
    const late = await b.person({ phone: true, at: url });
    await late.until('the cancelled code opens nothing', async () => /already used|too old/.test(await late.page.locator('#notice-text').innerText().catch(() => '')));
    assert.deepEqual((await owner.api('/api/devices')).body, []);
});

test('a device given a folder and no conversation shows its files, and nothing else', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('private');
    await owner.api('/api/resources', { name: 'album' });
    await owner.api('/api/conversations/private/resources', { resource: 'album', access: 'write' });
    await owner.type('echo "a picture" > ../resources/album/one.txt; echo ok');
    await owner.sees('\nok');
    const shared = await owner.api('/api/shares', { grants: [{ asset: 'folder:album', rights: 'rw' }] });
    const viewer = await b.person({ phone: true, at: shared.body.url.replace(/^https?:\/\/[^/]+/, '') });
    await viewer.until('its files are shown', async () => (await viewer.page.locator('#files-rows').innerText().catch(() => '')).includes('one.txt'));
    assert.equal(await viewer.page.locator('#name').innerText(), 'Shared files');
    assert.equal(await viewer.page.locator('#keys').isVisible(), false, 'no terminal, no keys');
    await viewer.page.locator('#files-rows .file', { hasText: 'one.txt' }).click();
    await viewer.until('the file is shown', async () => (await viewer.page.locator('#preview-body pre').innerText().catch(() => '')).includes('a picture'));
    assert.equal(await viewer.page.locator('#files-import').isVisible(), true, 'given to write: it can add a file');
});
