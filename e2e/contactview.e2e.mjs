import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* AN ADDRESS BOOK'S CONTACTS (16-11): Settings > Assets, a contacts asset opened: under who has it, its contacts --
   name, email, phone, company; one opened says its details as text (its notes inert, its https address a link); a
   search. On a phone too, nothing wider than the screen. The book is a connector of this test: it answers with
   contacts as data. example.com only. */
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const BOOK = { id: 'work-contacts', title: 'Contacts — someone@example.com (Microsoft)', kind: 'contacts', connector: 'contacts', config: { provider: 'microsoft', user: 'someone@example.com' } };

test('a contacts asset shows its contacts: one opened as text, a search; on a phone too', { skip: SKIP }, async (t) => {
    const reads = [];
    const people = [
        { id: 'c1', name: 'Alex Example', emails: ['alex@example.com'], phones: ['+33 6 00 00 00 01'], company: 'Example SA' },
        { id: 'c2', name: 'Bea Sample', emails: ['bea@example.com'], phones: [], company: null },
        { id: 'c3', name: 'Chris Demo', emails: [], phones: ['+33 1 00 00 00 02'], company: 'Demo Ltd' },
    ];
    const connector = { run: async (verb, target, a, ctx) => {
        reads.push({ verb, a, by: ctx.person?.id });
        if (verb === 'contacts.list') return { text: 'listed', size: 6, contacts: people };
        if (verb === 'contacts.search') return { text: 'found', size: 5, contacts: people.filter((p) => p.name.toLowerCase().includes(a.text.toLowerCase())) };
        if (verb === 'contacts.read') return { text: 'read', size: 4, contact: { ...people[0], title: 'Engineer', addresses: ['1 rue de l\'Exemple, Paris'], notes: 'Met at the fair <img src=x onerror="window.pwned=1"> https://fair.example.com/2026' } };
        throw new Error(`${verb} is not done here`);
    } };
    const b = await bench(t, { tetherTargets: [BOOK], tetherConnectors: { contacts: connector } });
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${b.origin}/`);
    await page.locator('#nav-assets').click();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    await page.locator('#assets-rows .as-row[data-asset="connexion:work-contacts"]').click();
    const book = page.locator('#assets-detail .as-contacts');
    await me.until('its contacts', async () => (await book.locator('.ct-person').count()) === 3, 20_000);
    assert.deepEqual(await book.locator('.ct-person .ag-title').allInnerTexts(), ['Alex Example', 'Bea Sample', 'Chris Demo']);
    assert.match(await book.locator('.ct-person').first().innerText(), /alex@example\.com · Example SA[\s\S]*\+33 6 00 00 00 01/);
    assert.match(String(reads[0].by), /^person:/, 'a person\'s own read');
    /* One opened: its details as text. */
    await book.locator('.ct-person', { hasText: 'Alex' }).locator('summary').click();
    const facts = book.locator('.ct-person[open] .ag-facts');
    await me.until('its details', async () => (await facts.count()) === 1);
    const said = await facts.innerText();
    assert.match(said, /Engineer/);
    assert.match(said, /1 rue de l'Exemple, Paris/);
    assert.match(said, /<img src=x onerror=/);
    assert.equal(await facts.locator('img, script').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned ?? null), null);
    assert.equal(await facts.locator('.ag-notes a').getAttribute('href'), 'https://fair.example.com/2026');
    assert.equal(await facts.locator('a[href^="mailto:"]').getAttribute('href'), 'mailto:alex@example.com');
    await shot(page, 'desktop-contacts');
    await page.waitForTimeout(3000);
    assert.deepEqual(reads.map((r) => r.verb), ['contacts.list', 'contacts.read'], 'kept, not read again by a paint');
    /* A search. */
    await page.locator('#assets-detail .mv-search input').fill('bea');
    await page.locator('#assets-detail .mv-search input').press('Enter');
    await me.until('found', async () => (await book.locator('.ct-person').count()) === 1);
    assert.equal(reads.at(-1).verb, 'contacts.search');

    await page.evaluate(() => localStorage.setItem('clavarium-theme', 'light'));
    await page.setViewportSize({ width: 375, height: 760 });
    await page.reload();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    const row = page.locator('#assets-rows .as-row[data-asset="connexion:work-contacts"]');
    if (await row.isVisible()) await row.click();
    await me.until('its contacts on a phone', async () => (await page.locator('#assets-detail .as-contacts .ct-person').count()) >= 1, 20_000);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    await page.locator('#assets-detail .as-contacts').scrollIntoViewIfNeeded();
    await shot(page, 'phone-contacts-light');
});
