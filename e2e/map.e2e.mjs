import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('who sees what: every agent, every thing, a line for each right given, and what an agent does not see', { skip: SKIP }, async (t) => {
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
    await me.page.locator('#assets-open').click();
    await me.page.locator('#map-open').click();
    await me.until('the map is drawn', async () => (await me.page.locator('#map-drawing .map-line').count()) === 4);
    assert.match(await me.page.locator('#map-said').innerText(), /2 agent\(s\), 4 thing\(s\) kept here, 4 right\(s\) given/);
    assert.deepEqual(await me.page.locator('#map-drawing .map-line').evaluateAll((l) => l.map((x) => x.dataset.access).sort()), ['read', 'use', 'write', 'write']);
    /* One agent alone: what it sees, and what does not exist for it. */
    await me.page.locator('#map-drawing .map-box[data-side=agent][data-name="client-a"]').click();
    await me.until('it says what client-a sees', async () => /client-a sees 3 of 4: .*site-a \(write\).*brand \(read\).*DEPLOY_A \(handed\)/.test(await me.page.locator('#map-said').innerText()));
    assert.deepEqual(await me.page.locator('#map-drawing .map-box[data-side=thing][data-seen=false]').evaluateAll((g) => g.map((x) => x.dataset.name)), ['site-b'], 'the other client\'s repository is crossed out');
    assert.equal(await me.page.locator('#map-drawing .map-line[data-dim=true]').count(), 1);
    /* One thing alone: who sees it. */
    await me.page.locator('#map-drawing .map-box[data-side=thing][data-name="site-b"]').click();
    await me.until('it says who sees site-b', async () => /site-b is seen by 1 of 2 agent\(s\): client-b \(write\)/.test(await me.page.locator('#map-said').innerText()));
    assert.deepEqual(await me.page.locator('#map-drawing .map-box[data-side=agent][data-seen=false]').evaluateAll((g) => g.map((x) => x.dataset.name)), ['client-a']);
    await me.page.screenshot({ path: process.env.CLV_SHOT ?? '/dev/null' }).catch(() => {});
    await me.page.locator('#map-close').click();
    assert.deepEqual(me.errors, []);
});
