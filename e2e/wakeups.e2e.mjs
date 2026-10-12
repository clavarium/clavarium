import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('two tools work together: one leaves a request in a folder they share, the other is told and gets to it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('painter', 'Other tool');
    await me.create('writer');
    await me.api('/api/resources', { name: 'handoff' });
    await me.api('/api/conversations/writer/resources', { resource: 'handoff', access: 'write' });
    await me.api('/api/conversations/painter/resources', { resource: 'handoff', access: 'write' });
    /* The owner sets it on the one that must be woken, in "This conversation". */
    await me.page.goto(`${b.origin}/?c=painter`);
    await me.until('painter is shown', async () => (await me.state()) === 'live' && (await me.page.locator('#name').innerText()) === 'painter');
    await me.page.locator('#folders').click();
    await me.page.locator('#wakeups-new-box summary').click();
    /* Nothing to type: refused, and said. */
    await me.page.locator('#wakeups-new button[type=submit]').click();
    await me.until('it is refused', async () => /Write what is typed/.test(await me.page.locator('#panel-error').innerText().catch(() => '')));
    await me.page.selectOption('#wakeup-resource', 'handoff');
    /* The tool here is a shell: what is typed to it is run, which shows it arrived. */
    await me.page.fill('#wakeup-message', 'echo "told of: {files}"');
    await me.page.locator('#wakeups-new button[type=submit]').click();
    await me.until('it is listed', async () => /When something new arrives in handoff/.test(await me.page.locator('#wakeups-rows').innerText()));
    assert.match(await me.page.locator('#wakeups-rows .wakeup-last').innerText(), /Not yet/);
    await me.page.locator('#panel-close').click();
    assert.match(await me.page.locator('#items .item[aria-current=true]').innerText(), /1 wake-up/);
    /* The other tool leaves its request. Nobody touches the painter. */
    await me.page.goto(`${b.origin}/?c=writer`);
    await me.until('writer is shown', async () => (await me.state()) === 'live' && (await me.page.locator('#name').innerText()) === 'writer');
    await me.type('echo "a banner, 1200x400" > ../resources/handoff/need-a-banner.md; echo left');
    await me.sees('\nleft');
    const woken = async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'painter').wakeups.items[0].last;
    await me.until('the painter was told', async () => (await woken())?.ok === true, 30_000);
    assert.equal((await woken()).what, 'Typed: echo "told of: need-a-banner.md"');
    await me.page.goto(`${b.origin}/?c=painter`);
    await me.sees('\ntold of: need-a-banner.md', 30_000);
    /* Turned off: the next arrival wakes nobody. */
    await me.page.locator('#folders').click();
    await me.until('its last time is said', async () => /Last, .*Typed: echo/.test(await me.page.locator('#wakeups-rows .wakeup-last').innerText()));
    await me.page.locator('#wakeups-rows .wakeup .levels button', { hasText: 'Off' }).click();
    await me.until('it is off', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'painter').wakeups.items[0].on === false);
    await me.page.locator('#panel-close').click();
    await me.type('echo "another" > ../resources/handoff/second.md; sleep 3; echo quiet');
    await me.sees('\nquiet', 30_000);
    assert.equal((await me.screen()).includes('told of: second.md'), false);
    assert.deepEqual(me.errors, []);
});
