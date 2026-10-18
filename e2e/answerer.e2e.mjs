import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* Three readers that are not models. They say yes to going on; the second
   one will not answer for anything that deletes. */
const readers = async (url, init) => {
    const body = JSON.parse(init.body);
    const screen = body.messages.at(-1).content;
    const asked = /Shall I go on\? \(y\/n\)\s*\n?SCREEN>>>/.test(screen) || /Delete everything\? \(y\/n\)\s*\n?SCREEN>>>/.test(screen);
    const said = !asked ? { action: 'none', why: 'nothing is asked' }
        : screen.includes('Delete everything') && body.model === 'reader-two' ? { action: 'human', why: 'the charter does not allow deleting' }
            : { action: 'keys', keys: ['y', 'enter'], why: 'the charter allows going on' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(said) } }] }) };
};

test('away from the screen: the question of the tool is answered when all agree, and left to the owner when one doubts', { skip: SKIP }, async (t) => {
    const alerted = [];
    const b = await bench(t, { answerFetcher: readers, alertSend: async (subscription, payload) => { alerted.push(JSON.parse(payload)); } });
    const me = await b.person();
    await me.create('worker');
    /* A device asked to be told (a browser under test has no push service: the server is told as a browser would). */
    assert.equal((await me.api('/api/alerts', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a-device', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, label: 'Tablet' })).status, 201);
    assert.equal((await me.api('/api/alerts', { subscription: { endpoint: 'https://example.com/hook', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } } })).status, 400);
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-alerts');
    await me.until('Settings has its alerts', async () => (await me.page.locator('#alerts-state').innerText()).length > 0);
    await me.page.locator('#settings-close').click();
    /* Its place is in "This conversation"; off, and it says what turning it on means. */
    await me.page.locator('#folders').click();
    await me.chapter('answerer');
    await me.until('it says what it is', async () => /3 models answer.*THE SCREEN OF THIS CONVERSATION IS SENT to: reader-one, reader-two, reader-three/.test(await me.page.locator('#answerer-about').innerText()));
    assert.match(await me.page.locator('#answerer-state').innerText(), /Off: nobody answers but you/);
    /* No mandate, no answerer. */
    await me.page.locator('#answerer-on button[data-on=true]').click();
    await me.until('it is refused', async () => /objectives and its charter first/.test(await me.page.locator('#panel-error').innerText().catch(() => '')));
    await me.page.fill('#answerer-objectives', 'Finish the report.');
    await me.page.fill('#answerer-charter', 'You may say yes to going on. Never delete anything.');
    await me.page.fill('#answerer-limit', '5');
    await me.page.locator('#answerer-on button[data-on=true]').click();
    await me.until('it is on', async () => /0 answer\(s\) in a row of 5/.test(await me.page.locator('#answerer-state').innerText()));
    await me.page.locator('#panel-close').click();
    /* The tool asks; nobody types the answer. */
    await me.type('read -p "Shall I go on? (y/n) " a; echo "it got: $a"');
    await me.sees('it got: y', 30_000);
    await me.until('the list says who answered', async () => /answered in your place/.test(await me.page.locator('#items .item[aria-current=true]').innerText()), 20_000);
    /* A question the charter does not cover: one reader doubts, nothing is typed, the owner is asked. */
    await me.type('read -p "Delete everything? (y/n) " a; echo "it got: $a"');
    await me.until('the list says it waits for its owner', async () => /asks for you/.test(await me.page.locator('#items .item[aria-current=true]').innerText()), 30_000);
    assert.equal((await me.screen()).includes('it got: y\nready> read -p "Delete') && /it got: [yn]\s*$/.test((await me.screen()).trim().split('Delete everything?').at(-1)), false, 'nothing was answered');
    /* And the owner's phone is told, with where to go. */
    assert.deepEqual(alerted, [{ title: 'worker waits for you', body: 'reader-two: the charter does not allow deleting', url: '/?c=worker' }]);
    await me.page.locator('#folders').click();
    await me.chapter('answerer');
    await me.until('it says why', async () => /It stopped and waits for you\. reader-two: the charter does not allow deleting/.test(await me.page.locator('#answerer-state').innerText()));
    /* What it did is written down: who said what, on which screen. */
    await me.page.locator('#answerer-log-box summary').first().click();
    await me.until('the log is shown', async () => (await me.page.locator('#answerer-log .answered').count()) === 2);
    const log = await me.page.locator('#answerer-log').innerText();
    assert.match(log, /left to you: reader-two: the charter does not allow deleting/);
    assert.match(log, /answered y, enter/);
    await me.page.locator('#panel-close').click();
    /* The owner answers: one key, and the answerer is in service again. */
    await me.page.locator('#terminal').click(); await me.page.keyboard.type('n'); await me.page.keyboard.press('Enter');
    await me.sees('it got: n');
    await me.until('it no longer asks for the owner', async () => /answered in your place/.test(await me.page.locator('#items .item[aria-current=true]').innerText()), 20_000);
    /* Off: nobody answers. */
    assert.equal((await me.api('/api/conversations/worker/answerer', { on: false })).body.on, false);
    assert.deepEqual(me.errors, []);
});

test('where no models are named, the page says so and there is nothing to turn on', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('plain');
    await me.page.locator('#folders').click();
    await me.chapter('answerer');
    await me.until('it says none is set', async () => /None is set on this installation/.test(await me.page.locator('#answerer-about').innerText()));
    assert.equal(await me.page.locator('#answerer-fields').isVisible(), false);
    assert.equal((await me.api('/api/conversations/plain/answerer', { on: true, objectives: 'x', charter: 'y' })).status, 503);
});
