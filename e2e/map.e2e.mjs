import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bench, SKIP } from './bench.mjs';

test('who gets what: every agent, every thing, a line for each right, what an agent does not see; a link made there is the one Access makes; traced; a setup exported and a file shown before import', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('client-b', 'Other tool');
    await me.create('client-a');
    for (const [name, type] of [['site-a', 'git'], ['brand', 'folder'], ['site-b', 'git']]) await me.api('/api/resources', type === 'git' ? { name, type } : { name });
    await me.api('/api/conversations/client-a/resources', { resource: 'site-a', access: 'write' });
    await me.api('/api/conversations/client-a/resources', { resource: 'brand', access: 'read' });
    await me.api('/api/conversations/client-b/resources', { resource: 'site-b', access: 'write' });
    await me.api('/api/secrets', { name: 'DEPLOY_A', value: 'not-a-real-value' });
    await me.api('/api/conversations/client-a/secrets', { secret: 'DEPLOY_A', attached: true });
    const page = me.page;
    /* The map is what Access opens on. */
    await page.locator('#nav-access').click();
    await me.until('the map is shown', async () => page.locator('#links').isVisible());
    /* Everything first, and shown by default. */
    assert.deepEqual(await page.locator('#links-tabs [data-view]').evaluateAll((b) => b.map((x) => x.dataset.view)), ['all', 'convs', 'devices']);
    await me.until('everything is the view at first', async () => (await page.locator('#links-tabs [data-view=all]').getAttribute('aria-selected')) === 'true');
    await page.locator('#links-tabs [data-view=convs]').click();
    const node = (id) => page.locator(`#links-board .lk-node[data-id="${id}"]`);
    await me.until('the map is drawn', async () => (await page.locator('#links-board .lk-node').count()) === 6);
    /* No column scrolls, either way: the board is laid out whole, and fitted to its window. */
    assert.deepEqual(await page.locator('#links-board .lk-col').evaluateAll((cols) => cols.filter((c) => getComputedStyle(c).overflowY !== 'visible' || getComputedStyle(c).overflowX !== 'visible').length), 0);
    const inside = () => page.evaluate(() => { const w = document.getElementById('links-scroller').getBoundingClientRect(); return [...document.querySelectorAll('#links-board .lk-node')].every((n) => { const r = n.getBoundingClientRect(); return r.top >= w.top - 1 && r.bottom <= w.bottom + 1 && r.left >= w.left - 1 && r.right <= w.right + 1; }); });
    assert.equal(await inside(), true, 'every box in sight at first');
    /* One line a box: its name; what it is, in its title. */
    assert.equal(await page.locator('#links-board .lk-node .lk-sb').count(), 0);
    assert.match(await node('git:site-a').getAttribute('title'), /site-a · repository/);
    /* At rest every link is drawn, a line for each right given; this device may hide them, a count staying on each box. */
    const kinds = () => page.locator('#links-svg path[data-kind]').evaluateAll((l) => l.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.dataset.kind).sort().join());
    await me.until('every link is drawn at rest', async () => (await kinds()) === 'read,use,write,write');
    /* No arrowheads: the colour says the right. */
    assert.equal(await page.locator('#links-svg [marker-end], #links-svg marker').count(), 0);
    await page.locator('#links-all').uncheck();
    assert.equal(await node('conversation:client-a').locator('.lk-cnt').innerText(), '3');
    assert.equal(await page.locator('#links-svg path[data-kind]:visible').count(), 0);
    await page.locator('#links-all').check();
    /* The map's own zoom: the buttons, ctrl + wheel; the page's text size never moves with it. */
    const scale = () => page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.getElementById('links-board').style.transform)?.[1]));
    const textSize = await page.evaluate(() => window.clavariumText().scale);
    const fitted = await scale();
    await page.locator('#links-zoom-in').click();
    assert.ok(await scale() > fitted * 1.2, 'zoomed in by its button');
    const w = await page.locator('#links-scroller').boundingBox();
    await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 200); await page.keyboard.up('Control');
    await me.until('zoomed out by ctrl + wheel', async () => (await scale()) < fitted * 1.2);
    assert.equal(await page.evaluate(() => window.clavariumText().scale), textSize, 'the text size is left alone');
    await page.locator('#links-zoom-in').click(); await page.locator('#links-zoom-in').click();
    await page.locator('#links-zoom-fit').click();
    assert.equal(await scale(), fitted);
    assert.equal(await inside(), true, 'everything in sight again');
    /* One agent alone: what it sees, in words; what it does not see, greyed. */
    await node('conversation:client-a').click();
    await me.until('it says what client-a sees', async () => /its agent: read and write of site-a[\s\S]*its agent: read of brand[\s\S]*its agent: use of DEPLOY_A/.test(await page.locator('#links-card').innerText()));
    assert.deepEqual(await page.locator('#links-board .lk-node.faded').evaluateAll((g) => g.map((x) => x.dataset.id).sort()), ['conversation:client-b', 'git:site-b']);
    /* One thing alone: who sees it (the agent let go first: a box outlined in dashes, tapped, would be linked to it). */
    await page.locator('#links-card button', { hasText: 'See everything' }).click();
    await node('git:site-b').click();
    await me.until('it says who sees site-b', async () => /client-b's agent: read and write/.test(await page.locator('#links-card').innerText()));
    assert.deepEqual(await page.locator('#links-board .lk-node.faded').evaluateAll((g) => g.map((x) => x.dataset.id).sort()), ['conversation:client-a', 'folder:brand', 'git:site-a', 'secret:DEPLOY_A']);
    /* A link made here: tap one box, then the other; changed by its knob; taken away there. The very requests of Access. */
    const brandOf = async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'client-b').resources.find((r) => r.name === 'brand')?.access;
    await node('conversation:client-b').click();
    await node('folder:brand').click();
    await me.until('brand is read by client-b', async () => (await brandOf()) === 'read');
    await page.locator('.lk-pop input[value=rw]').check();
    await me.until('brand is written by client-b', async () => (await brandOf()) === 'write');
    await page.locator('.lk-pop .lk-rm').click();
    /* Asked in words, then two short buttons. */
    assert.equal(await page.locator('.lk-pop .lk-ask').innerText(), 'Detach brand from client-b?');
    await page.locator('.lk-pop button', { hasText: /^Remove$/ }).click();
    await me.until('brand is detached from client-b', async () => (await brandOf()) === undefined);
    /* Zoomed in, a link is still drawn from the dot of a box to another. */
    await page.locator('#links-zoom-in').click();
    const dot = await node('conversation:client-b').locator('.lk-handle').boundingBox();
    const to = await node('folder:brand').boundingBox();
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 }); await page.mouse.up();
    await me.until('brand is read by client-b, dragged', async () => (await brandOf()) === 'read');
    await page.locator('.lk-pop .lk-rm').click();
    await page.locator('.lk-pop button', { hasText: /^Remove$/ }).click();
    await me.until('brand is detached again', async () => (await brandOf()) === undefined);
    await page.locator('#links-zoom-fit').click();
    /* Traced: what reaches it, what it reaches. */
    await node('conversation:client-a').click();
    await page.locator('#links-trace-it').click();
    await me.until('the trace of client-a', async () => (await page.locator('#flows-trace .lk-tnode').count()) >= 4);
    assert.equal(await page.locator('#flows-of').inputValue(), 'conversation:client-a');
    assert.match(await page.locator('#flows-trace .lk-steps').evaluate((e) => e.textContent), /client-a writes in site-a/);
    /* Exported, from Settings: the configuration, never a value. */
    await page.locator('#nav-settings').click();
    await page.locator('#settings-ch-backup > summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#flows-export').click()]);
    const text = readFileSync(await download.path(), 'utf8');
    assert.ok(text.includes('"id": "secret:DEPLOY_A"') && !text.includes('not-a-real-value'));
    /* A file from elsewhere: shown whole, its texts as text, the unknown refused; nothing made before it is asked. */
    const friend = JSON.stringify({ clavarium: 'flow', version: 2, nodes: [
        { id: 'conversation:night', kind: 'conversation', name: 'night', tool: 'shell', wakeups: { items: [{ kind: 'every', minutes: 60, message: 'Look <img src=x onerror="window.owned=1">' }] } },
        { id: 'conversation:odd', kind: 'conversation', name: 'odd', tool: 'curl | sh' }] });
    await page.locator('#flows-file').setInputFiles({ name: 'friend.clavarium.json', mimeType: 'application/json', buffer: Buffer.from(friend) });
    await me.until('the file is shown', async () => (await page.locator('#flows-preview .lk-plan[data-status=refused] li').count()) === 1);
    assert.equal(await page.locator('#flows-preview pre').innerText(), 'Look <img src=x onerror="window.owned=1">');
    assert.equal(await page.locator('#flows-preview img').count(), 0);
    assert.equal((await me.api('/api/conversations')).body.length, 2, 'nothing made yet');
    /* Many links (a map of 4 agents x 5 folders, as the server would send it): every one still drawn, thin and
       pale, without knobs; the box touched has its own in full, with their knobs. */
    const many = { nodes: [...[1, 2, 3, 4].map((i) => ({ id: `conversation:c${i}`, kind: 'conversation', name: `c${i}`, sub: 'Shell', phase: 'ready' })), ...[1, 2, 3, 4, 5].map((i) => ({ id: `folder:f${i}`, kind: 'folder', name: `f${i}`, sub: 'folder' }))], flows: [] };
    many.links = many.nodes.filter((n) => n.kind === 'conversation').flatMap((c) => [1, 2, 3, 4, 5].map((i) => ({ from: c.id, to: `folder:f${i}`, rights: 'r' })));
    await page.route('**/api/flows', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(many) }));
    await page.locator('#map-mode [data-mode=map]').click();
    await me.until('20 links, all thin', async () => (await page.locator('#links-svg path.pale[data-kind]').count()) === 20);
    assert.equal(await page.locator('#links-board .lk-knob').count(), 0);
    await node('conversation:c2').click();
    await me.until('its own in full', async () => (await page.locator('#links-svg path.on[data-from="conversation:c2"]').count()) === 5);
    const knobs = await page.locator('#links-board .lk-knob').evaluateAll((l) => l.map((x) => x.dataset.from));
    assert.ok(knobs.length > 0 && knobs.every((x) => x === 'conversation:c2'), `knobs only on its own: ${knobs}`);
    /* No count of links out of sight, no pill at a column's end: every link is drawn end to end. */
    assert.equal(await page.locator('#links-board .lk-hook, #links-board .lk-edge').count(), 0);
    await page.unroute('**/api/flows');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(me.errors, []);
});
