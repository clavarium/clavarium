import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

/* The owner shares a conversation and gives back the address a QR code carries. */
async function share(owner) {
    await owner.page.locator('#share').click();
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
    await owner.page.locator('#share').click();
    await owner.until('the phone is listed', async () => (await owner.page.locator('#sharing-devices .device').count()) === 1);
    await owner.page.locator('#sharing-devices .device button', { hasText: 'Revoke' }).click();
    await owner.page.locator('#sharing-devices button.danger').click();
    await owner.until('no device left', async () => (await owner.page.locator('#sharing-devices .device').count()) === 0);

    await phone.until('the phone says it is out, in words', async () => /was closed, or this device was removed/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')), 25_000);
    for (const gone of ['#keys', '#shortcuts', '#files-open']) assert.equal(await phone.page.locator(gone).isVisible(), false, `${gone} is no longer offered`);

    /* A new code, opened in the SAME tab, pairs it again (it did nothing before the fix). */
    await owner.page.locator('#sharing-new').click();
    await wait(600);
    const again = (await owner.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    await phone.page.evaluate((to) => { location.href = to; }, again);
    await phone.until('welcomed again', async () => /You are connected to "family"/.test(await phone.page.locator('#notice-text').innerText().catch(() => '')));
});

test('shared with a phone: files of the conversation, and only where the owner allowed writing', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    for (const [folder, access] of [['photos', 'Write'], ['papers', 'Read']]) {
        await owner.page.locator('#folders').click();
        await owner.page.fill('#folder-name', folder);
        await owner.page.locator('#folder-new button[type=submit]').click();
        await owner.until(`${folder} is listed`, async () => (await owner.page.locator('.folder', { hasText: folder }).count()) > 0);
        await owner.page.locator('.folder', { hasText: folder }).locator('button', { hasText: access }).click();
        await owner.until(`${folder} is attached`, async () => (await owner.page.locator('#chips').innerText()).includes(`${folder} - ${access.toLowerCase()}`));
        await owner.page.locator('#panel-close').click();
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

test('a share is composed: two conversations and a folder to read, in one code; the owner sees who has what and takes one thing back', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('family');
    await owner.create('garden');
    await owner.api('/api/resources', { name: 'recipes' });
    await owner.type('echo "soup" > ../resources/x 2>/dev/null; echo ok');
    await owner.page.locator('#share').click();
    const choose = (label, level) => owner.page.locator('#sharing-what .folder', { hasText: label }).locator('.levels button', { hasText: level }).click();
    /* The conversation shown is chosen already; the rest is asked for. */
    assert.equal(await owner.page.locator('#sharing-what .folder', { hasText: 'garden - conversation' }).locator('button[aria-pressed=true]').innerText(), 'Use');
    await choose('family - conversation', 'Use');
    await choose('recipes - folder', 'Read');
    /* Said in a sentence before the code is made, and the device gets a name the owner will recognise. */
    assert.match(await owner.page.locator('#sharing-summary').innerText(), /the whole of family, garden - its terminal, as root in its machine; and recipes \(read\)/);
    await owner.page.fill('#sharing-label', "Dad's tablet");
    await owner.page.locator('#sharing-new').click();
    await owner.until('the code is shown', async () => owner.page.locator('#sharing-link').isVisible());
    const url = (await owner.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    const tablet = await b.person({ phone: true, at: url });
    await tablet.page.locator('#notice-action', { hasText: 'Start' }).click();
    await tablet.until('live', async () => (await tablet.state()) === 'live');
    assert.equal(await tablet.page.locator('#others').innerText(), 'Conversations (2)');
    /* The folder given to the device itself: read, never written. */
    await tablet.page.locator('#files-open').click();
    const tab = tablet.page.locator('#files-tabs button', { hasText: 'recipes' });
    assert.match(await tab.innerText(), /recipes - read \(given to this device\)/);
    await tab.click();
    await tablet.until('read-only is said', async () => tablet.page.locator('#files-readonly').isVisible());
    await tablet.page.locator('#files-close').click();
    /* The owner sees all of it on that device, and takes the folder back: the rest stays. */
    await owner.page.locator('#sharing-close').click();
    await owner.page.locator('#share').click();
    const device = owner.page.locator('#sharing-devices .device', { hasText: "Dad's tablet" });
    await owner.until('what it was given is listed', async () => /family \(conversation\): use/.test(await device.innerText()) && /recipes \(folder\): read/.test(await device.innerText()));
    /* Taking a thing back asks once more, as revoking does. */
    const chip = device.locator('.given .chip', { hasText: 'recipes' }).locator('button');
    await chip.click();
    assert.equal(await chip.innerText(), 'Take back?');
    await chip.click();
    await owner.until('the folder is taken back', async () => !/recipes/.test(await owner.page.locator('#sharing-devices').innerText()));
    await tablet.page.reload();
    await tablet.until('live again', async () => (await tablet.state()) === 'live');
    await tablet.page.locator('#files-open').click();
    assert.equal(await tablet.page.locator('#files-tabs button', { hasText: 'recipes' }).count(), 0);
    assert.equal(await tablet.page.locator('#others').innerText(), 'Conversations (2)');
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
