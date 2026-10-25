import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const T0 = Date.now() - 3 * 3600_000;
const at = (i) => new Date(T0 + i * 30_000).toISOString();
const id = (side, i) => `${side}${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
const LINK = 'https://example.invalid/the-spec';

/* A card links to a message of its chat, a file of its shared folders, a page: a click opens each. */
test('a card\'s message opens its chat at that message (further back than shown too), its file in the viewer, its link in a new tab; on a desktop, a touch tablet and a phone', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.create('links');
    /* A long thread, both sides: the owner's message pointed to is older than the 200 shown at first. */
    const work = join(b.dir, 'data', 'work', 'links');
    mkdirSync(join(work, '.parley'), { recursive: true });
    writeFileSync(join(work, 'plan.md'), '# The plan\n\nFirst the parser, then the screen.');
    const agent = []; const person = [];
    for (let i = 0; i < 320; i += 1) {
        if (i % 2 === 0) agent.push(JSON.stringify({ id: id('a', i), at: at(i), kind: 'say', text: `Agent message ${i}` }));
        else person.push(JSON.stringify({ id: id('b', i), at: at(i), text: i === 7 ? 'Keep the diff lines where they are.' : `Person message ${i}` }));
    }
    writeFileSync(join(work, '.parley', 'from-agent.jsonl'), `${agent.join('\n')}\n`);
    writeFileSync(join(work, '.parley', 'to-agent.jsonl'), `${person.join('\n')}\n`);
    writeFileSync(join(work, '.parley', 'read.json'), JSON.stringify({ lines: person.length, reads: [] }));
    /* Written before the chat is turned on: the server's own copy takes the thread as it was. */
    assert.equal((await me.api('/api/conversations/links/talk', { on: true })).status, 200);
    const pointed = id('b', 7);
    /* Its binder, with a card that links to that message (its id as read shows it), the file, a page. */
    const made = (await me.api('/api/binder', { op: 'create-list', args: { template: 'batches' } })).body.data;
    assert.equal((await me.api('/api/binder', { op: 'grant', args: { list: made.id, to: 'conversation:links', access: 'write' } })).body.ok, true);
    const card = (await me.api('/api/binder', { op: 'add', args: { list: made.id, title: 'Diff lines' } })).body.data;
    for (const [kind, ref, title] of [['message', pointed.slice(0, 8), 'What they asked'], ['file', '/work/plan.md', ''], ['link', LINK, 'The spec']]) {
        assert.equal((await me.api('/api/binder', { op: 'attach', args: { id: card.id, kind, ref, title } })).body.ok, true, kind);
    }

    async function walk(who, { touch = false, label }) {
        const page = who.page;
        await page.context().route('https://example.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>spec</title>the spec' }));
        await page.goto(`${b.origin}/?c=links`);
        const thread = page.locator('#simple-thread');
        await who.until(`${label}: its chat`, async () => /Agent message 318/.test(await thread.innerText().catch(() => '')), 30_000);
        const tap = (l) => (touch ? l.tap() : l.click());
        const card2 = page.locator(`#clists-binder .binder-record[data-record="${card.id}"]`);
        const openCard = async () => {
            await who.until(`${label}: the Binders tab`, async () => page.locator('#view-lists').isVisible(), 15_000);
            await tap(page.locator('#view-lists'));
            const row = page.locator(`#clists-binder [data-record="${card.id}"]:not(.binder-record)`);
            await who.until(`${label}: its card in the list, or open`, async () => (await card2.isVisible()) || (await row.count()) === 1, 15_000);
            if (!(await card2.isVisible())) await tap(row);
            await who.until(`${label}: the card open`, async () => card2.isVisible(), 15_000);
        };
        /* The message: the Chat tab, the thread brought back to it, it in sight and marked. */
        await openCard();
        assert.equal(await thread.locator(`.parley-said[data-id="${pointed}"]`).count(), 0, 'not among those shown at first');
        await tap(card2.locator('.binder-att[data-kind="message"] .binder-link'));
        await who.until(`${label}: its Chat tab`, async () => (await page.locator('#view-chat').getAttribute('aria-pressed')) === 'true');
        /* A Parley without reveal (before 0.17): the Chat tab alone. */
        if (await page.evaluate(async () => (await (await fetch('/vendor/parley-ui.js')).text()).includes('reveal,'))) {
            await page.waitForSelector(`#simple-thread .parley-said[data-id="${pointed}"][data-found="true"]`, { timeout: 20_000 });
            const seen = await page.evaluate((key) => {
                const box = document.querySelector('#simple-thread .parley-thread') ?? document.querySelector('#simple-thread');
                const it = [...document.querySelectorAll('#simple-thread .parley-said')].find((x) => x.dataset.id === key).getBoundingClientRect();
                const b2 = box.getBoundingClientRect();
                return { inside: it.top >= b2.top - 1 && it.bottom <= b2.bottom + 1 && it.left >= 0 && it.right <= innerWidth + 1, wide: document.documentElement.scrollWidth <= innerWidth };
            }, pointed);
            assert.deepEqual(seen, { inside: true, wide: true }, `${label}: the message in sight, nothing past the edge`);
            await page.screenshot({ path: join(process.env.CARD_LINKS_SHOTS ?? b.dir, `card-links-${label}-message.png`) });
        } else t.diagnostic(`${label}: this Parley has no reveal: the message itself not checked`);
        /* The file: the viewer, as from the chat. */
        await openCard();
        await tap(card2.locator('.binder-att[data-kind="file"] .binder-link'));
        await who.until(`${label}: the file shown`, async () => (await page.locator('#preview-body').innerText().catch(() => '')).includes('First the parser'), 15_000);
        assert.equal(await page.locator('#preview-name').innerText(), 'plan.md');
        await page.screenshot({ path: join(process.env.CARD_LINKS_SHOTS ?? b.dir, `card-links-${label}-file.png`) });
        await tap(page.locator('#preview-close'));
        await who.until(`${label}: the viewer closed`, async () => !(await page.locator('#viewer').isVisible()));
        assert.equal(await card2.isVisible(), true, 'the card is there again');
        /* The link: a new tab, which cannot reach this page. */
        const [tab] = await Promise.all([page.context().waitForEvent('page'), tap(card2.locator('.binder-att[data-kind="link"] .binder-link'))]);
        await tab.waitForLoadState();
        assert.equal(tab.url(), LINK);
        assert.equal(await tab.evaluate(() => window.opener), null, 'noopener');
        await tab.close();
    }

    await walk(me, { label: 'desktop' });
    const tablet = await b.person({ context: await b.browser.newContext({ viewport: { width: 1056, height: 660 }, isMobile: true, hasTouch: true }) });
    await walk(tablet, { touch: true, label: 'tablet' });
    const phone = await b.person({ context: await b.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }) });
    await walk(phone, { touch: true, label: 'phone' });
    assert.deepEqual([...me.errors, ...tablet.errors, ...phone.errors], [], 'no error in the pages');
});
