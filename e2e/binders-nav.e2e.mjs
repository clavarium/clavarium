import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { bench, SKIP, wait } from './bench.mjs';

/* Pictures of each card page, to look at; nothing is compared with them. */
const SHOTS = process.env.CLAVARIUM_E2E_SHOTS ?? '';
const SCREENS = [
    { name: 'desktop', viewport: { width: 1280, height: 800 } },
    { name: 'tablet', viewport: { width: 1056, height: 660 }, hasTouch: true, isMobile: true },
    { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
];

/* The tool here is a plain shell: what an agent would run, the test types. */
test('Binders, walked back: a card is one step over its binder (Back, its "‹", a reload); a card opened beside the chat goes back to the chat; in Assets, Back closes the card first; on a desktop, a tablet and a phone, light and dark, nothing past the screen', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await me.create('coder');
    await page.locator('#folders').click();
    await page.locator('#talk-on button[data-on=true]').click();
    await page.goBack();
    await page.locator('#view-terminal').click();
    await me.type('clear; export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; parley tell "Ready." >/dev/null && binder new batches >/dev/null && echo made-ok');
    await me.printed('made-ok', 30_000);
    /* Enough cards for the list to scroll, and a card long enough for its page to scroll. */
    const add = (list, title, description) => me.api('/api/binder', { op: 'add', args: { list, title, ...(description ? { description } : {}) } });
    for (let i = 1; i <= 24; i++) await add('batches', `Batch ${i}`, i === 24 ? Array.from({ length: 40 }, (_, n) => `Line ${n + 1} of what this batch does.`).join('\n\n') : '');
    const clients = (await me.api('/api/binder', { op: 'create-list', args: { template: 'customers', title: 'Clients' } })).body.data;
    await me.api('/api/binder', { op: 'grant', args: { list: clients.id, to: 'conversation:coder', access: 'write' } });
    const alice = (await add(clients.id, 'Alice Martin')).body.data;
    await page.locator('#view-chat').click();
    await me.until('the batches beside the chat', async () => (await page.locator('#simple-thread .parley-panel-item').count()) === 24, 20_000);

    for (const screen of SCREENS) for (const scheme of ['light', 'dark']) {
        const at = `${screen.name}-${scheme}`;
        const context = await b.browser.newContext({ viewport: screen.viewport, hasTouch: screen.hasTouch ?? false, isMobile: screen.isMobile ?? false, colorScheme: scheme });
        /* This page's own theme, light or dark. */
        await context.addInitScript((theme) => { try { localStorage.setItem('clavarium-theme', theme); } catch { /* an opaque page */ } }, scheme);
        const who = await b.person({ context, at: '/?c=coder' });
        const p = who.page;
        const tap = (locator) => (screen.hasTouch ? locator.tap() : locator.click());
        const lists = p.locator('#clists-binder');
        const card = lists.locator('.binder-record');
        const backButton = lists.locator('.binder-record [data-act="back"]');
        const tab = (id) => p.locator(`#${id}`).getAttribute('aria-pressed');
        /* A binder chosen: its tab, or on a narrow screen its picker. */
        const choose = async (id) => {
            const picker = lists.locator('.binder-picker select');
            if (await picker.isVisible()) await picker.selectOption(id); else await tap(lists.locator(`.binder-tabs [data-list="${id}"]`));
        };
        const query = () => p.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
        /* Nothing past the edges of the screen, but in what scrolls sideways on purpose (the binder chips, a board). */
        const edges = () => p.evaluate(() => {
            const W = document.documentElement.clientWidth; const out = [];
            if (document.documentElement.scrollWidth > W + 1) out.push(`the page is ${document.documentElement.scrollWidth}px wide`);
            for (const e of document.querySelectorAll('#app *:not(#terminal *)')) {
                const r = e.getBoundingClientRect();
                if (!r.width || !r.height || (r.right <= W + 1 && r.left >= -1) || !e.checkVisibility?.()) continue;
                let held = false;
                for (let q = e.parentElement; q && !held; q = q.parentElement) { const s = getComputedStyle(q); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { const qr = q.getBoundingClientRect(); held = qr.right <= W + 1 && qr.left >= -1; } }
                if (!held) out.push(`${e.tagName.toLowerCase()}.${e.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
            }
            return out;
        });
        const inSight = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
        await who.until(`${at}: its chat`, async () => (await tab('view-chat')) === 'true', 30_000);

        /* Binders tab, Clients, a card; Back: its list, still in Binders. */
        await tap(p.locator('#view-lists'));
        await who.until(`${at}: its binders`, async () => (await lists.locator('.binder-tabs [role="tab"]').count()) === 2);
        await choose(clients.id);
        await who.until(`${at}: Clients`, async () => (await lists.locator('.binder-bar h2').innerText().catch(() => '')) === 'Clients');
        assert.equal((await query()).binder, clients.id, 'its binder in the address');
        await tap(lists.locator(`.binder-row[data-record="${alice.id}"]`));
        await who.until(`${at}: Alice's card`, async () => (await card.getAttribute('data-record').catch(() => null)) === alice.id);
        assert.equal((await query()).card, alice.id, 'its card in the address');
        assert.match(await backButton.innerText(), /Clients/);
        await p.goBack();
        await who.until(`${at}: Back, Clients again`, async () => (await card.count()) === 0 && (await lists.locator('.binder-bar h2').innerText().catch(() => '')) === 'Clients');
        assert.equal(await tab('view-lists'), 'true', 'still in Binders');
        assert.equal((await query()).card, undefined);

        /* Batches, scrolled down, its last card: kept in sight, its way back; "‹": the list, where it was. */
        await choose('batches');
        const last = lists.locator('.binder-row').filter({ has: p.locator('b', { hasText: /^Batch 24$/ }) });
        await who.until(`${at}: Batches`, async () => (await last.count()) === 1);
        await last.scrollIntoViewIfNeeded();
        const listTop = await lists.evaluate((e) => e.scrollTop);
        await tap(last);
        await who.until(`${at}: its card`, async () => (await card.count()) === 1 && /Line 40/.test(await card.innerText()));
        assert.ok(await inSight(lists.locator('.binder-record .binder-title')), 'the card shown from its top');
        const box = await backButton.boundingBox();
        assert.ok(box.height >= (screen.hasTouch ? 44 : 34), `its way back, a fingertip high (${box.height}px)`);
        assert.deepEqual(await edges(), [], `${at}: nothing past the edges, on a card`);
        if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/card-${at}.png` }); }
        await lists.evaluate((e) => { e.scrollTop = e.scrollHeight; });
        await wait(150);
        assert.ok(await inSight(backButton), 'scrolled to its end, its way back still in sight');
        if (SHOTS) await p.screenshot({ path: `${SHOTS}/card-end-${at}.png` });
        await tap(backButton);
        await who.until(`${at}: "‹", Batches again`, async () => (await card.count()) === 0 && (await last.count()) === 1);
        assert.ok(Math.abs((await lists.evaluate((e) => e.scrollTop)) - listTop) < 4, 'the list where it was');
        assert.deepEqual(await edges(), [], `${at}: nothing past the edges, on a list`);
        /* Back, now: the chat it came from. */
        await p.goBack();
        await who.until(`${at}: Back, the chat`, async () => (await tab('view-chat')) === 'true');
        assert.equal(await p.locator('#clists').isVisible(), false);
        assert.deepEqual(await query(), { c: 'coder' });

        /* From the batches beside the chat (a sheet on a phone): its card; Back, and its "‹ Chat", the chat. */
        const fromChat = async () => {
            const panel = p.locator('#simple-thread .parley-panel');
            if (!(await panel.isVisible())) await tap(p.locator('#simple-thread .parley-panel-open'));
            await who.until(`${at}: the batches`, async () => panel.isVisible());
            await tap(panel.locator('.parley-panel-title', { hasText: /^Batch 3$/ }));
            await who.until(`${at}: its card, from the chat`, async () => (await card.count()) === 1 && /Batch 3\b/.test(await card.locator('.binder-title').inputValue()));
        };
        await fromChat();
        assert.match(await backButton.innerText(), /Chat/);
        assert.match(await lists.locator('.binder-where').innerText(), /Batches/, 'its binder said');
        await p.goBack();
        await who.until(`${at}: Back from a card of the chat, the chat`, async () => (await tab('view-chat')) === 'true' && !(await p.locator('#clists').isVisible()));
        await fromChat();
        await tap(backButton);
        await who.until(`${at}: "‹ Chat", the chat`, async () => (await tab('view-chat')) === 'true' && !(await p.locator('#clists').isVisible()));
        /* The Binders tab again: its binder, not that card. */
        await tap(p.locator('#view-lists'));
        await who.until(`${at}: its binder, not the card`, async () => (await lists.locator('.binder-rows').count()) === 1 && (await card.count()) === 0);

        /* A reload on a card: that card; Back, its binder; Back, the chat. */
        await choose(clients.id);
        await tap(lists.locator(`.binder-row[data-record="${alice.id}"]`));
        await who.until(`${at}: Alice's card`, async () => (await card.count()) === 1);
        await p.reload();
        await who.until(`${at}: reloaded, the card`, async () => (await card.getAttribute('data-record').catch(() => null)) === alice.id, 30_000);
        await p.goBack();
        await who.until(`${at}: Back, its binder`, async () => (await card.count()) === 0 && (await lists.locator('.binder-bar h2').innerText().catch(() => '')) === 'Clients');
        await p.goBack();
        await who.until(`${at}: Back, the chat`, async () => (await tab('view-chat')) === 'true');

        /* In Assets: the binder opened, a card; Back: its binder, still there; "‹": the same; Back: Assets. */
        await p.goto(`${b.origin}/`);
        await who.until(`${at}: the conversations`, async () => p.locator('#nav-assets').isVisible(), 30_000);
        await tap(p.locator('#nav-assets'));
        const row = p.locator('#assets-rows .as-row[data-asset="list:batches"]');
        await who.until(`${at}: Assets`, async () => (await row.count()) === 1);
        await tap(row);
        await tap(p.locator('#assets-detail [data-act="open-list"]'));
        const here = p.locator('#assets-detail .as-binder');
        await who.until(`${at}: the binder in Assets`, async () => (await here.locator('.binder-row').count()) === 24);
        await tap(here.locator('.binder-row').filter({ has: p.locator('b', { hasText: /^Batch 2$/ }) }));
        await who.until(`${at}: its card in Assets`, async () => (await here.locator('.binder-record').count()) === 1);
        assert.equal((await query()).card, (await here.locator('.binder-record').getAttribute('data-record')));
        assert.ok(await inSight(here.locator('.binder-record [data-act="back"]')), 'its way back in sight');
        assert.deepEqual(await edges(), [], `${at}: nothing past the edges, a card in Assets`);
        if (SHOTS) await p.screenshot({ path: `${SHOTS}/assets-card-${at}.png` });
        await p.goBack();
        await who.until(`${at}: Back, the binder in Assets`, async () => (await here.locator('.binder-record').count()) === 0 && (await here.locator('.binder-row').count()) === 24);
        assert.ok(await p.locator('#assets-detail').isVisible());
        await tap(here.locator('.binder-row').filter({ has: p.locator('b', { hasText: /^Batch 5$/ }) }));
        await who.until(`${at}: another card in Assets`, async () => (await here.locator('.binder-record').count()) === 1);
        await tap(here.locator('.binder-record [data-act="back"]'));
        await who.until(`${at}: "‹", the binder in Assets`, async () => (await here.locator('.binder-record').count()) === 0 && (await here.locator('.binder-row').count()) === 24);
        await p.goBack();
        await who.until(`${at}: Back, Assets`, async () => (await p.locator('#assets').isVisible()) && (await p.locator('#assets-detail .as-binder').count()) === 0);

        assert.deepEqual(who.errors, [], `${at}: no error in the page`);
        await context.close();
    }
    assert.deepEqual(me.errors, []);
});
