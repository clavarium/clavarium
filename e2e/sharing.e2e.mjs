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
