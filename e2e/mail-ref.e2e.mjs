import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from 'clavarium-tether/verbs';
import { bench, SKIP } from './bench.mjs';

/* A MAIL CITED BY ITS REFERENCE (06-11): a card's mail opens the .eml viewer as a sheet over the page, its
   bytes read through Tether when it is opened; its HTML in a frame that runs nothing, its remote pictures
   only when asked; Reply writes the start of a request in the chat, never sends. A mail gone, and a device
   that may not read that mailbox: one line each. The mailbox is a connector of this test (Tether's own is
   proved in Tether): it answers mail.open from the mails below. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const mail = (remote) => `Message-ID: <quote-1@example.com>
From: Plomberie Example <contact@example.com>
To: me@example.org
Subject: Re: Bathroom leak
Date: Thu, 05 Nov 2026 08:41:00 +0100
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: text/html; charset=utf-8

<html><body><h1 id="said">Thursday 8 am works</h1>
<img id="far" src="${remote}/logo.png" alt="logo">
<p id="ran">no</p><script>document.getElementById('ran').textContent='ran';</script>
<img src="x" onerror="document.getElementById('ran').textContent='ran'">
<p>Please pay the deposit first, as the quote says.</p></body></html>
--outer
Content-Type: application/pdf; name="quote-118.pdf"
Content-Disposition: attachment; filename="quote-118.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
`.replace(/\n/g, '\r\n');
const BOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'me@example.org', host: 'mail.example.org' } };
const REF = 'mail:work-mail/quote-1%40example.com?in=INBOX&uid=7';

test('a mail cited by its reference: from a card and from a link, the viewer as a sheet; nothing runs, remote pictures when asked; Reply prefills the chat; gone and not-yours said in one line', { skip: SKIP }, async (t) => {
    let pictures = 0;
    const far = createServer((request, response) => { pictures++; response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from(PIXEL, 'base64')); });
    await new Promise((ok) => far.listen(0, 'localhost', ok));
    t.after(() => far.close());
    const raw = mail(`http://localhost:${far.address().port}`);
    const reads = [];
    const connector = { run: async (verb, target, a, ctx) => {
        reads.push({ verb, ref: a.ref, by: ctx.person?.id ?? ctx.agent });
        if (verb !== 'mail.open') throw new Refused(`${verb} is not done here`);
        if (!a.ref.startsWith('mail:work-mail/quote-1%40example.com')) throw Object.assign(new Refused(`${target.title}: this mail is no longer in the mailbox`), { code: 'gone' });
        return { text: 'Found in Archive.', size: raw.length, raw: Buffer.from(raw, 'utf8'), folder: 'Archive', ref: 'mail:work-mail/quote-1%40example.com?in=Archive&uid=3', cut: false };
    } };
    const b = await bench(t, { tetherTargets: [BOX], tetherConnectors: { mail: connector } });
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.create('asker');
    assert.equal((await me.api('/api/conversations/asker/talk', { on: true })).status, 200);
    /* Its binder, a card, the mail attached by its reference. */
    const list = (await me.api('/api/binder', { op: 'create-list', args: { template: 'batches' } })).body.data;
    assert.equal((await me.api('/api/binder', { op: 'grant', args: { list: list.id, to: 'conversation:asker', access: 'write' } })).body.ok, true);
    const card = (await me.api('/api/binder', { op: 'add', args: { list: list.id, title: 'Bathroom leak' } })).body.data;
    assert.equal((await me.api('/api/binder', { op: 'attach', args: { id: card.id, kind: 'mail', ref: REF, title: 'Re: Bathroom leak · Plomberie' } })).body.ok, true);
    /* A bare number is not taken any more. */
    assert.equal((await me.api('/api/binder', { op: 'attach', args: { id: card.id, kind: 'mail', ref: '42' } })).body.ok, false);
    assert.equal(reads.length, 0, 'nothing read before it is opened');

    /* Desktop, dark: the card, its mail. */
    await me.page.evaluate(() => localStorage.setItem('clavarium-theme', 'dark'));
    await me.page.goto(`${b.origin}/?c=asker`);
    await me.until('the Binders tab', async () => me.page.locator('#view-lists').isVisible(), 20_000);
    await me.page.locator('#view-lists').click();
    const opened = me.page.locator(`#clists-binder .binder-record[data-record="${card.id}"]`);
    const row = me.page.locator(`#clists-binder [data-record="${card.id}"]:not(.binder-record)`);
    await me.until('the card in the list', async () => (await opened.isVisible()) || (await row.count()) === 1, 15_000);
    if (!(await opened.isVisible())) await row.click();
    await me.until('the card open', async () => opened.isVisible(), 15_000);
    assert.equal(reads.length, 0, 'a card shown reads no mail');
    await opened.locator('.binder-att[data-kind="mail"] .binder-link').click();
    const view = me.page.locator('#preview-body .mail-view');
    await me.until('the mail is shown', async () => (await me.page.locator('#preview-body .mail-subject').innerText().catch(() => '')) === 'Re: Bathroom leak', 15_000);
    assert.deepEqual(reads.map((r) => [r.verb, r.ref, r.by]), [['mail.open', REF, 'person:owner']], 'read once, when opened, as the owner\'s read');
    assert.equal(await me.page.locator('#viewer').getAttribute('class'), 'viewer-sheet', 'a sheet over the page');
    const box = await me.page.locator('#viewer-card').boundingBox();
    assert.ok(box.x > 500 && Math.round(box.x + box.width) === 1280, 'a panel at the right on a wide screen');
    assert.equal(await me.page.locator('#preview-name').innerText(), 'Re: Bathroom leak');
    assert.equal(await view.locator('.mail-where').innerText(), 'Work mailbox · Archive', 'where it is now');
    assert.match(await view.locator('.mail-from').innerText(), /Plomberie Example\s*<contact@example\.com>/);
    assert.match(await view.locator('.mail-file-open').innerText(), /quote-118\.pdf/);
    /* The same frame as an .eml's: nothing runs, nothing fetched. */
    const frame = me.page.frameLocator('#preview-body iframe.mail-frame');
    await me.until('its words', async () => (await frame.locator('#said').innerText().catch(() => '')) === 'Thursday 8 am works');
    assert.equal(await me.page.locator('#preview-body iframe.mail-frame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
    assert.equal(await frame.locator('#ran').innerText(), 'no', 'nothing of it ran');
    assert.equal(await frame.locator('#far').getAttribute('src'), null);
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal(pictures, 0, 'no remote picture on opening');
    assert.match(await view.locator('.mail-remote').innerText(), /Remote pictures blocked/);
    const SHOTS = process.env.MAIL_REF_SHOTS ?? b.dir;
    mkdirSync(SHOTS, { recursive: true });
    await me.page.screenshot({ path: join(SHOTS, 'ref-desktop-dark.png') });
    /* Asked for: the server's page of the same mail, read again then; still nothing runs. */
    await view.locator('.mail-remote-show').click();
    await me.until('the remote picture is fetched', async () => pictures > 0, 15_000);
    assert.match(await me.page.locator('#preview-body iframe.mail-frame').getAttribute('src'), /^\/api\/mail\/page\?ref=mail%3Awork-mail%2Fquote-1%2540example\.com%3Fin%3DArchive%26uid%3D3/);
    await me.until('drawn', async () => frame.locator('#far').evaluate((img) => img.complete && img.naturalWidth === 1).catch(() => false));
    assert.equal(await frame.locator('#ran').innerText(), 'no');
    /* Reply: the chat of its conversation, the start of a request to its AI -- not sent. */
    const toAgent = join(b.dir, 'kept-work', 'asker', 'work', '.parley', 'to-agent.jsonl');
    const said = () => (existsSync(toAgent) ? readFileSync(toAgent, 'utf8') : '');
    const before = said();
    await view.locator('.mail-reply').click();
    await me.until('the viewer closed', async () => me.page.locator('#viewer').isHidden());
    const chatBox = me.page.locator('textarea.parley-box:visible').first();
    await me.until('the chat box holds the request', async () => (await chatBox.inputValue().catch(() => '')).startsWith('Reply to this mail: mail:work-mail/quote-1%40example.com?in=Archive&uid=3'), 15_000);
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(said(), before, 'nothing was sent');

    /* A link to a mail (?mail=...): the same sheet; on a phone, light, from the bottom. */
    const phone = await b.person({ phone: true });
    await phone.page.evaluate(() => localStorage.setItem('clavarium-theme', 'light'));
    await phone.page.goto(`${b.origin}/?c=asker&mail=${encodeURIComponent(REF)}`);
    await phone.until('the mail on the phone', async () => (await phone.page.locator('#preview-body .mail-subject').innerText().catch(() => '')) === 'Re: Bathroom leak', 20_000);
    const sheet = await phone.page.locator('#viewer-card').boundingBox();
    assert.ok(sheet.y > 20 && Math.round(sheet.y + sheet.height) === 780 && Math.round(sheet.width) === 390, 'a sheet from the bottom, the page seen above it');
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'nothing past the edge');
    await phone.page.screenshot({ path: join(SHOTS, 'ref-phone-light.png') });
    /* Gone: one line, no download. */
    await phone.page.goto(`${b.origin}/?c=asker&mail=${encodeURIComponent('mail:work-mail/gone%40example.com')}`);
    await phone.until('the line that says it is gone', async () => (await phone.page.locator('#preview-body .mail-state-line').innerText().catch(() => '')) === 'This mail is no longer in the mailbox.', 20_000);
    assert.equal(await phone.page.locator('#preview-download').isVisible(), false);
    await phone.page.screenshot({ path: join(SHOTS, 'ref-phone-light-gone.png') });

    /* A device given the chat, not that mailbox: not its to open -- and nothing read for it. */
    const shared = await me.api('/api/conversations/asker/share', { rights: 'rw' });
    assert.equal(shared.status, 201);
    const device = await b.person({ phone: true, at: shared.body.url.replace(/^https?:\/\/[^/]+/, '') });
    await device.until('the device is paired', async () => Boolean(await device.page.evaluate(() => document.documentElement.dataset.pairing)), 20_000);
    const pairing = await device.page.evaluate(() => document.documentElement.dataset.pairing);
    const count = reads.length;
    const refused = await device.api(`/c/api/${pairing}/mail/open?ref=${encodeURIComponent(REF)}`);
    assert.equal(refused.status, 403); assert.equal(refused.body.kind, 'not-yours');
    assert.equal((await device.api(`/c/api/${pairing}/mail/page?ref=${encodeURIComponent(REF)}`)).status, 403);
    await device.page.goto(`${b.origin}/c/?mail=${encodeURIComponent(REF)}`);
    await device.until('the line that says it is not theirs', async () => (await device.page.locator('#preview-body .mail-state-line').innerText().catch(() => '')) === 'This mailbox is not yours to open.', 20_000);
    assert.equal(reads.length, count, 'nothing was read for a device that may not');
    await device.page.screenshot({ path: join(SHOTS, 'ref-phone-not-yours.png') });
    assert.deepEqual(me.errors, []); assert.deepEqual(phone.errors, []); assert.deepEqual(device.errors, []);
});
