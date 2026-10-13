import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* What an agent would do through its MCP client, done here by hand in the terminal: one call to the bridge. */
const call = (name, args, then = '') => `printf '%s\\n' '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}' | node .parley/server.mjs ${then}`;

test('talk through the app: the tool asks on the simple screen, its owner answers there, the tool is told in its terminal and reads the answer', { skip: SKIP }, async (t) => {
    const alerted = [];
    const b = await bench(t, { alertSend: async (subscription, payload) => { alerted.push(JSON.parse(payload)); } });
    const me = await b.person();
    await me.create('helper');
    await me.api('/api/alerts', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a-device', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, label: 'Phone' });
    /* Off, and said plainly what turning it on means. */
    await me.page.locator('#folders').click();
    await me.until('it says what it is', async () => /WHAT THE TOOL POSTS THERE IS READ BY THIS SERVER/.test(await me.page.locator('#talk-about').innerText()));
    assert.equal(await me.page.locator('#talk-invite').isVisible(), false);
    await me.page.locator('#talk-on button[data-on=true]').click();
    await me.until('it says how to declare it to the tool', async () => /named "parley" started by: node \/work\/\.parley\/server\.mjs/.test(await me.page.locator('#talk-declare').innerText().catch(() => '')));
    await me.page.locator('#panel-close').click();
    /* The tool posts a question, and does not wait. */
    await me.type(`${call('ask', { question: 'Blue or red cover?', choices: ['blue', 'red'] }, '> /dev/null')}; echo posted`);
    await me.sees('\nposted');
    /* The owner's phone is told that the tool asks. */
    await me.until('the phone is told', async () => alerted.length === 1, 15_000);
    assert.deepEqual(alerted[0], { title: 'helper asks you something', body: 'Blue or red cover?', url: '/?c=helper' });
    await me.page.locator('#simple-toggle').click();
    await me.until('the question is on the simple screen', async () => (await me.page.locator('#simple-thread .parley-said[data-kind=ask]').innerText().catch(() => '')).includes('Blue or red cover?'));
    assert.equal(await me.page.locator('#simple-thread h1, #simple-thread script').count(), 0);
    /* The owner answers with one touch. */
    await me.page.locator('#simple-thread .parley-said[data-kind=ask] button', { hasText: 'blue' }).click();
    await me.until('the answer is in the thread, and the choices are gone', async () => (await me.page.locator('#simple-thread .parley-said[data-from=person]').innerText().catch(() => '')) === 'blue' && (await me.page.locator('#simple-thread .parley-said[data-kind=ask] button').count()) === 0);
    /* In its terminal, the tool was told that a message arrived -- and only that. */
    await me.until('the line was typed to the tool', async () => (await me.screen()).includes('A message arrived for you'), 20_000);
    assert.equal((await me.screen()).includes('\nblue'), false, 'the answer itself is not typed');
    /* Written in the box, a message goes the same way. */
    assert.equal(await me.page.locator('#simple-say').isVisible(), false, 'one box to write in, not two');
    await me.page.fill('#simple-thread .parley-box', 'Keep it under two pages.');
    await me.page.locator('#simple-thread .parley-send').click();
    await me.until('it is in the thread', async () => (await me.page.locator('#simple-thread').innerText()).includes('Keep it under two pages.'));
    /* The tool reads: the answer to its question, and the message. */
    await me.page.locator('#simple-toggle').click();
    await me.type(`clear; ${call('read', {})}`);
    await me.sees('Answer to your question', 20_000);
    /* A long line is folded by the terminal: read without its folds. */
    const screen = (await me.screen()).replace(/\n/g, '');
    assert.ok(screen.includes('Blue or red cover?') && screen.includes('\\": blue') && screen.includes('Keep it under two pages.'), screen);
    assert.deepEqual(me.errors, []);
});
