import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* The remote screen (MeshCentral) in Settings: off at first, turned on and off in a few clicks,
   its progress and its address shown. The host program is the e2e stand-in (fake-clavarium-host). */
test('Remote screen: off, turned on (progress then the address), turned off', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('alpha');
    await me.page.locator('#nav-settings').click();
    await me.until('Settings are shown', async () => me.page.locator('#settings').isVisible());
    await me.chapter('s-remote-screen');

    const state = me.page.locator('#mesh-state');
    const toggle = me.page.locator('#mesh-toggle');
    await me.until('it is off at first', async () => (await state.innerText()) === 'Off' && (await toggle.innerText()) === 'Turn on');
    assert.equal(await me.page.locator('#mesh-url').isVisible(), false);

    /* Turned on: install then start, in the background; its progress is shown. */
    await toggle.click();
    await me.until('it says it is turning on', async () => (await state.innerText()) === 'Turning on...');
    assert.match(await me.page.locator('#mesh-progress').innerText(), /Installing/);

    /* Then on, with its address. */
    await me.until('it is on, with its address', async () => (await state.innerText()) === 'On'
        && (await me.page.locator('#mesh-url a').getAttribute('href')) === 'https://clav.example.com/meshcentral/', 15_000);
    assert.equal(await toggle.innerText(), 'Turn off');

    /* Turned off: what was installed is kept, the server is stopped. */
    await toggle.click();
    await me.until('it is off again', async () => (await state.innerText()) === 'Installed, off' && (await toggle.innerText()) === 'Turn on');
    assert.equal(await me.page.locator('#mesh-url').isVisible(), false);

    assert.deepEqual(me.errors, [], 'no page error at any point');
});
