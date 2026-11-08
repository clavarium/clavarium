import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { bench, SKIP } from './bench.mjs';

/* A PERSON'S BROWSER THROUGH THE TETHER EXTENSION (08-11): Assets › New › Browser makes one line to copy into the
   extension (its address, a key good once); a fake extension (a WebSocket of this test) comes with it, and the page,
   waiting, opens the new browser, connected, its granted tabs listed; given to a conversation with the usual levels;
   Frame shows its sites; a click asked is a card in the thread, « Click in the tab … ». The token never in the page. */
test('a browser: paired by a configuration copied once, its tabs, given at a level, Frame\'s sites, a click asked as a card', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.create('asker');
    assert.equal((await me.api('/api/conversations/asker/talk', { on: true })).status, 200);

    await me.addAsset('browser');
    /* The page makes one line; the extension (this test's WebSocket, as the real one speaks) is given it. */
    await me.page.fill('#browser-name', 'Laptop');
    await me.page.locator('#browser-make').click();
    await me.until('the configuration shown', async () => (await me.page.inputValue('#browser-config')) !== '', 10_000);
    const config = JSON.parse(await me.page.inputValue('#browser-config'));
    assert.equal(config.url, `${b.origin.replace(/^http/, 'ws')}/c/api/browser`);
    assert.ok(config.key.length >= 40);
    const got = [];
    const ws = new WebSocket(config.url);
    t.after(() => ws.terminate());
    ws.on('message', (d) => { const m = JSON.parse(String(d)); got.push(m); if (m.t === 'call') ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, text: 'clicked' })); });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello' })); ws.send(JSON.stringify({ t: 'claim', key: config.key }));
    await me.until('paired', async () => got.some((m) => m.t === 'paired'), 15_000);
    const token = got.find((m) => m.t === 'paired').token;
    ws.send(JSON.stringify({ t: 'tabs', tabs: [{ id: 7, url: 'https://shop.example.com/basket', title: 'Basket', site: 'shop.example.com' }] }));

    /* Made, then opened in Assets. */
    const panel = me.page.locator('#assets-detail');
    await me.until('the new browser is opened', async () => (await panel.locator('h2').innerText().catch(() => '')).includes('Laptop'), 20_000);
    await me.until('connected, its tab listed', async () => (await panel.locator('.br-tabs li').allInnerTexts()).join() === 'Basket', 20_000);
    assert.match(await panel.locator('[data-act="browser-state"]').innerText(), /Connected · 1 tab/);

    /* Given to asker with the usual levels; Frame shows its sites. */
    await panel.locator('.kit-access-give').click();
    const row = panel.locator('.given-row[data-conversation="asker"]');
    assert.deepEqual(await row.locator('.kit-rights-pick button').evaluateAll((x) => x.map((y) => y.dataset.value)), ['none', 'watch', 'propose', 'frame', 'free']);
    await row.locator('.kit-rights-pick button[data-value="frame"]').click();
    const sites = panel.locator('.br-sites[data-conversation="asker"]');
    await me.until('its sites', async () => (await sites.count()) === 1, 15_000);
    await sites.locator('textarea').fill('*.example.org');
    await sites.locator('button[data-act="browser-sites"]').click();
    await me.until('kept', async () => (await me.api('/api/tether')).body.targets.find((x) => x.id === 'browser-laptop')?.grants?.['conversation:asker']?.rules?.some((r) => r.kind === 'site' && r.value === '*.example.org'), 15_000);
    const shots = process.env.BROWSER_SHOTS ?? b.dir;
    for (const [w, h] of [[1280, 800], [820, 1100], [390, 844]]) for (const scheme of ['light', 'dark']) {
        await me.page.setViewportSize({ width: w, height: h });
        await me.page.emulateMedia({ colorScheme: scheme });
        await me.page.screenshot({ path: join(shots, `browser-panel-${w}-${scheme}.png`), fullPage: false });
    }
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.page.emulateMedia({ colorScheme: 'light' });

    /* A click on a site not listed: asked, its card in asker's thread. */
    const side = join(b.dir, 'kept-work', 'asker', 'work', '.tether');
    mkdirSync(side, { recursive: true });
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'b1', op: 'browser.click', args: { target: 'browser-laptop', tab: 7, selector: '.buy', why: 'you asked to order' }, at: new Date().toISOString() })}\n`);
    await me.page.goto(`${b.origin}/?c=asker`);
    const card = me.page.locator('#simple-thread .parley-request').first();
    await me.until('the click is a card in the thread', async () => (await card.count()) === 1, 30_000);
    const text = await card.innerText();
    for (const said of ['Click in the tab « Basket »', 'shop.example.com']) assert.ok(text.includes(said), `${said} in: ${text}`);
    await me.page.screenshot({ path: join(shots, 'browser-card.png') });
    assert.ok(!(await me.page.content()).includes(token), 'the token never in the page');
    assert.ok(!JSON.stringify((await me.api('/api/tether')).body).includes(token));
    assert.deepEqual(me.errors, [], 'no error in the page');
});
