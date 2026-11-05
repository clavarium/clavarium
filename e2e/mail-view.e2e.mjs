import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A 1x1 PNG. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* A mail as a mail program sends it, written here by hand: HTML and plain words, a remote picture,
   a picture of its own (cid:), a script and a handler that must never run, two attachments. */
const mail = (remote) => `From: =?UTF-8?Q?Ren=C3=A9e_Example?= <renee@example.com>
To: Bo <bo@example.org>
Subject: =?UTF-8?Q?Caf=C3=A9_menu?=
Date: Tue, 03 Nov 2026 09:15:00 +0100
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8

The menu.
--alt
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><body><h1 id=3D"said">Le caf=C3=A9 est pr=C3=AAt</h1>
<img id=3D"logo" src=3D"cid:logo@example.com" alt=3D"logo">
<img id=3D"far" src=3D"${remote}/track.png" alt=3D"far">
<p id=3D"ran">no</p><script>document.getElementById('ran').textContent=3D'ran';</script>
<img src=3D"x" onerror=3D"document.getElementById('ran').textContent=3D'ran'">
<a id=3D"out" href=3D"https://example.org/menu">menu</a></body></html>
--alt--
--rel
Content-Type: image/png
Content-ID: <logo@example.com>
Content-Transfer-Encoding: base64

${PIXEL}
--rel--
--outer
Content-Type: text/plain; name="notes.txt"
Content-Disposition: attachment; filename="notes.txt"

Bring a cup.
--outer
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="data.bin"
Content-Transfer-Encoding: base64

AAECAw==
--outer--
`.replace(/\n/g, '\r\n');

test('a mail file is shown as a mail: its head, its words, its attachments; remote pictures only when asked; its source one tap away', { skip: SKIP }, async (t) => {
    /* "Remote": a server of this test, counting who asks it for a picture. */
    let asked = 0;
    const far = createServer((request, response) => { asked++; response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from(PIXEL, 'base64')); });
    await new Promise((ok) => far.listen(0, 'localhost', ok));
    t.after(() => far.close());
    const b = await bench(t);
    const me = await b.person();
    const errors = []; me.page.on('pageerror', (e) => errors.push(e.message));
    await me.create('mails');
    const work = join(b.dir, 'kept-work', 'mails', 'work');
    writeFileSync(join(work, 'menu.eml'), mail(`http://localhost:${far.address().port}`));
    await me.files('work');
    await me.page.locator('#files-rows .file', { hasText: 'menu.eml' }).click();
    /* Its head. */
    await me.until('the head is shown', async () => (await me.page.locator('#preview-body .mail-subject').innerText().catch(() => '')) === 'Café menu');
    assert.match(await me.page.locator('#preview-body .mail-from').innerText(), /Renée Example\s*<renee@example\.com>/);
    assert.match(await me.page.locator('#preview-body .mail-head').innerText(), /To\s*Bo\s*<bo@example\.org>/);
    assert.equal(await me.page.locator('#preview-body .mail-headers').isVisible(), false);
    await me.page.locator('#preview-body .mail-details').click();
    assert.match(await me.page.locator('#preview-body .mail-headers').innerText(), /MIME-Version: 1\.0/);
    /* Its words, in a frame that runs nothing; its own picture drawn, the remote one not asked for. */
    const frame = me.page.frameLocator('#preview-body iframe.mail-frame');
    await me.until('the body is shown', async () => (await frame.locator('#said').innerText().catch(() => '')) === 'Le café est prêt');
    assert.equal(await me.page.locator('#preview-body iframe.mail-frame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
    await me.until('its own picture is drawn', async () => frame.locator('#logo').evaluate((img) => img.complete && img.naturalWidth === 1).catch(() => false));
    assert.equal(await frame.locator('#ran').innerText(), 'no', 'nothing of it ran');
    assert.equal(await frame.locator('#out').getAttribute('target'), '_blank');
    assert.equal(await frame.locator('#far').getAttribute('src'), null);
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(asked, 0, 'no remote picture is fetched on opening');
    assert.match(await me.page.locator('#preview-body .mail-remote').innerText(), /Remote pictures blocked/);
    /* Its attachments, listed. */
    const files = await me.page.locator('#preview-body .mail-file-open').allInnerTexts();
    assert.equal(files.length, 2);
    assert.match(files[0], /notes\.txt/); assert.match(files[1], /data\.bin/);
    /* Its source, one tap away, and back. */
    await me.page.locator('#preview-body .md-switch button[data-show="source"]').click();
    assert.match(await me.page.locator('#preview-body pre.source').innerText(), /Content-Type: multipart\/mixed; boundary="outer"/);
    assert.equal(await me.page.locator('#preview-body .mail-view').isVisible(), false);
    await me.page.locator('#preview-body .md-switch button[data-show="mail"]').click();
    assert.equal(await me.page.locator('#preview-body pre.source').isVisible(), false);
    /* Remote pictures, when asked for: the server's page of it, still no script. */
    await me.page.locator('#preview-body .mail-remote-show').click();
    await me.until('the remote picture is fetched', async () => asked > 0, 15_000);
    await me.until('it is drawn', async () => me.page.frameLocator('#preview-body iframe.mail-frame').locator('#far').evaluate((img) => img.complete && img.naturalWidth === 1).catch(() => false));
    assert.equal(await me.page.frameLocator('#preview-body iframe.mail-frame').locator('#ran').innerText(), 'no');
    assert.equal(await me.page.locator('#preview-body .mail-remote').count(), 0);
    /* An attachment opens in the same window. */
    await me.page.locator('#preview-body .mail-file-open', { hasText: 'notes.txt' }).click();
    await me.until('the attachment is shown', async () => (await me.page.locator('#preview-body pre.source').innerText().catch(() => '')).includes('Bring a cup.'));
    assert.equal(await me.page.locator('#preview-name').innerText(), 'notes.txt');
    assert.match(await me.page.locator('#preview-note').innerText(), /An attachment of menu\.eml/);
    await me.page.locator('#preview-close').click();
    assert.deepEqual(errors, []);
});
