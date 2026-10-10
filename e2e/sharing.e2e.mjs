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
    assert.equal((await phone.api('/c/api/me')).body.name, 'family');
    assert.equal((await phone.api('/c/api/files?c=private-work&r=anything&p=')).status, 404);
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
    assert.equal(await phone.page.evaluate(async () => (await fetch('/c/api/files/import?r=papers&p=&name=x.txt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status), 403);
});
