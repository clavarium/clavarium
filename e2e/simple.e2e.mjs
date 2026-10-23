import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

/* Its chat off, the Chat tab says so, with the one button that turns it on and asks its tool to use it. */
test('the Chat tab of a conversation whose chat is off: said, turned on in one click, its tool asked; its terminal one click away', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('helper');
    await me.type('echo "The report is ready."');
    await me.sees('\nThe report is ready.');
    assert.equal(await me.page.locator('#simple').isVisible(), false, 'the terminal first, as always');
    await me.page.locator('#view-chat').click();
    await me.until('it says the chat is off', async () => await me.page.locator('#chat-turn').isVisible());
    assert.match(await me.page.locator('#chat-turn').innerText(), /The chat is off for this conversation\.[\s\S]*Its terminal stays one click away\.[\s\S]*Turn the chat on/);
    assert.equal(await me.page.locator('#simple-plain').isVisible(), false, 'not the old screen that copies its terminal');
    assert.equal(await me.page.locator('#shortcuts').isVisible(), false, 'nothing typed into a terminal that is not shown');
    await shot(me.page, 'chat-off');
    assert.equal(await me.page.locator('#simple-says').isVisible(), false);
    /* One click: on, and its tool is asked (one line typed in its terminal). */
    await me.page.locator('#chat-turn-on').click();
    await me.until('the chat is shown', async () => await me.page.locator('#simple-thread').isVisible() && !(await me.page.locator('#chat-turn').isVisible()), 20_000);
    assert.equal((await me.api('/api/conversations/helper/talk')).body.on, true);
    await shot(me.page, 'chat-turned-on');
    await me.page.locator('#view-terminal').click();
    await me.sees('Parley is installed');
    /* Off again, from its settings: the Chat tab says so again. */
    await me.api('/api/conversations/helper/talk', { on: false });
    await me.page.reload();
    await me.page.locator('#view-chat').click();
    await me.until('off again, said', async () => await me.page.locator('#chat-turn').isVisible(), 20_000);
    /* And back to its screen: nothing was lost, it was underneath all along. */
    await me.page.locator('#view-terminal').click();
    assert.equal(await me.page.locator('#simple').isVisible(), false);
    await me.type('echo "typed in the terminal"');
    await me.sees('\ntyped in the terminal');
    assert.deepEqual(me.errors, []);
});
