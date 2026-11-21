import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A MAILBOX'S MAIL (16-11): Settings > Assets, a mailbox opened: under who has it, its latest messages -- who,
   subject, when, unread, a file; one opened says its words as text (a hostile HTML body stays inert: nothing runs,
   no picture is loaded), its files by name and size; a search; another folder. Never marked read: nothing but reads
   is asked. On a phone too, nothing wider than the screen. The mailbox is a connector of this test (Tether's own is
   proved in Tether): it answers with messages as data. example.com only. */
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const BOX = { id: 'work-mail', title: 'Mail — someone@example.com (Microsoft)', kind: 'mail', connector: 'mail', config: { provider: 'microsoft', user: 'someone@example.com' } };
const HOSTILE = '<div>Hello,<br>the offer <img src="https://track.example.com/p.gif" onerror="window.pwned=1"><script>window.pwned=2</script>'
    + ' &lt;img src=x onerror="window.pwned=3"&gt; is at https://offers.example.com/2026 <a href="javascript:window.pwned=4">here</a></div>';

test('a mailbox asset shows its latest mail: a message opened as text, inert; a search, a folder; on a phone too', { skip: SKIP }, async (t) => {
    const reads = [];
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    const messages = [
        { id: 'm1', ref: 'mail:work-mail/<m1@example.com>', from: 'Boss <boss@example.com>', subject: 'An offer for the team', date: ago(5), unread: true, attachments: true },
        { id: 'm2', from: 'team@example.com', subject: 'Lunch on Friday?', date: ago(60 * 26), unread: false, attachments: false },
        { id: 'm3', from: 'news@example.com', subject: 'Weekly letter', date: ago(60 * 24 * 9), unread: false, attachments: false },
    ];
    const connector = { run: async (verb, target, a, ctx) => {
        reads.push({ verb, a, by: ctx.person?.id });
        if (verb === 'mail.list') return { text: 'listed', size: 6, messages: a.mailbox === 'sent' ? [{ id: 's1', from: 'someone@example.com', subject: 'Sent one', date: ago(30) }] : messages };
        if (verb === 'mail.search') return { text: 'found', size: 5, messages: messages.filter((m) => m.subject.toLowerCase().includes(a.text.toLowerCase())) };
        if (verb === 'mail.read') return { text: 'read', size: 4, message: { ...messages[0], to: 'someone@example.com', text: HOSTILE, attachments: [{ name: 'offer.pdf', type: 'application/pdf', size: 245_000 }] } };
        throw new Error(`${verb} is not done here`);
    } };
    const b = await bench(t, { tetherTargets: [BOX], tetherConnectors: { mail: connector } });
    const me = await b.person();
    const page = me.page;
    const far = [];
    page.on('request', (r) => { if (!r.url().startsWith(b.origin)) far.push(r.url()); });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${b.origin}/`);
    await page.locator('#nav-assets').click();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    await page.locator('#assets-rows .as-row[data-asset="connexion:work-mail"]').click();
    const mail = page.locator('#assets-detail .as-mail');
    await me.until('its mail', async () => (await mail.locator('.mv-msg').count()) === 3, 20_000);
    assert.deepEqual(await mail.locator('.mv-subject').allInnerTexts(), ['An offer for the team', 'Lunch on Friday?', 'Weekly letter']);
    assert.equal(await mail.locator('.mv-msg[data-unread] .mv-dot').count(), 1, 'one unread');
    assert.equal(await mail.locator('.mv-clip').count(), 1, 'one with a file');
    assert.equal(reads.length, 1);
    assert.match(String(reads[0].by), /^person:/, 'a person\'s own read, never an agent\'s');
    await shot(page, 'desktop-mail-list');
    /* A message opened: its words as text, nothing in them runs, no picture loaded; its file named. */
    await mail.locator('.mv-msg', { hasText: 'An offer' }).locator('summary').click();
    const body = mail.locator('.mv-msg[open] .mv-body');
    await me.until('its words', async () => (await body.locator('.mv-text').count()) === 1);
    const text = await body.locator('.mv-text').innerText();
    assert.match(text, /Hello,\nthe offer/);
    assert.match(text, /<img src=x onerror="window.pwned=3">/, 'a tag written in the text is shown as text');
    assert.equal(await body.locator('img, script, iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned ?? null), null);
    assert.deepEqual(await body.locator('.mv-text a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))), ['https://offers.example.com/2026'], 'its web address alone is a link');
    assert.match(await body.locator('.mv-files').innerText(), /offer\.pdf\s+239 KB/);
    assert.deepEqual(far, [], 'nothing loaded from elsewhere');
    await shot(page, 'desktop-mail-open');
    /* Painted again (Tether's count moved with the read): no second read, the message stays open. */
    await page.waitForTimeout(3000);
    assert.deepEqual(reads.map((r) => r.verb), ['mail.list', 'mail.read'], 'kept, not read again by a paint');
    assert.equal(await mail.locator('.mv-msg[open] .mv-text').count(), 1, 'it stays open');
    /* A search, then another folder. */
    await page.locator('#assets-detail .mv-search input').fill('lunch');
    await page.locator('#assets-detail .mv-search input').press('Enter');
    await me.until('found', async () => (await mail.locator('.mv-msg').count()) === 1);
    assert.deepEqual(reads.at(-1), { verb: 'mail.search', a: { target: 'work-mail', text: 'lunch' }, by: reads[0].by });
    await page.locator('#assets-detail .mv-search input').fill('');
    await me.until('the list again', async () => (await mail.locator('.mv-msg').count()) === 3);
    await page.locator('#assets-detail .mv-folder').selectOption('sent');
    await me.until('sent mail', async () => (await mail.locator('.mv-subject').allInnerTexts()).join() === 'Sent one');
    assert.equal(reads.at(-1).a.mailbox, 'sent');
    assert.ok(reads.every((r) => ['mail.list', 'mail.search', 'mail.read'].includes(r.verb)), 'nothing but reads: never marked read');
    await page.locator('#assets-detail .mv-folder').selectOption('inbox');
    await me.until('the inbox again', async () => (await mail.locator('.mv-msg').count()) === 3);

    /* A phone, light: the same, nothing wider than the screen. */
    await page.evaluate(() => localStorage.setItem('clavarium-theme', 'light'));
    await page.setViewportSize({ width: 375, height: 760 });
    await page.reload();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    const row = page.locator('#assets-rows .as-row[data-asset="connexion:work-mail"]');
    if (await row.isVisible()) await row.click();
    await me.until('its mail on a phone', async () => (await page.locator('#assets-detail .as-mail .mv-msg').count()) === 3, 20_000);
    await page.locator('#assets-detail .mv-msg', { hasText: 'An offer' }).locator('summary').click();
    await me.until('its words on a phone', async () => (await page.locator('#assets-detail .mv-msg[open] .mv-text').count()) === 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    await page.locator('#assets-detail .as-mail').scrollIntoViewIfNeeded();
    await shot(page, 'phone-mail-light');
});
