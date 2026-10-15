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
    await page.locator('#links-open').click();
    await page.locator('#links-tabs [data-view=convs]').click();
    const node = (id) => page.locator(`#links-board .lk-node[data-id="${id}"]`);
    await me.until('the map is drawn', async () => (await page.locator('#links-board .lk-node').count()) === 6);
    /* At rest no line: a count on each box. All at once: a line for each right given. */
    assert.equal(await node('conversation:client-a').locator('.lk-cnt').innerText(), '3');
    assert.equal(await page.locator('#links-svg path[data-kind]:visible').count(), 0);
    await page.locator('#links-all').check();
    assert.deepEqual(await page.locator('#links-svg path[data-kind]').evaluateAll((l) => l.map((x) => x.dataset.kind).sort()), ['read', 'use', 'write', 'write']);
    await page.locator('#links-all').uncheck();
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
    await page.locator('.lk-pop button', { hasText: 'Detach brand from client-b' }).click();
    await me.until('brand is detached from client-b', async () => (await brandOf()) === undefined);
    /* Traced: what reaches it, what it reaches. */
    await node('conversation:client-a').click();
    await page.locator('#links-trace-it').click();
    await me.until('the trace of client-a', async () => (await page.locator('#flows-trace .lk-tnode').count()) >= 4);
    assert.equal(await page.locator('#flows-of').inputValue(), 'conversation:client-a');
    assert.match(await page.locator('#flows-trace .lk-steps').evaluate((e) => e.textContent), /client-a writes in site-a/);
    /* Exported: the configuration, never a value. */
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
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(me.errors, []);
});
