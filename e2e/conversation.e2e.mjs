import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP, wait } from './bench.mjs';

test('a conversation is created from the page, built, and its terminal answers', { skip: SKIP }, async (t) => {
    const b = await bench(t, { launchSeconds: '2' });
    const me = await b.person();
    await me.page.locator('#new').click();
    await me.page.fill('#create-name', 'first-talk');
    await me.page.locator('#create-tools button', { hasText: 'Shell' }).click();
    await me.page.locator('#create button[type=submit]').click();
    /* While the machine is being built, the page says so, and offers nothing that cannot work yet. */
    await me.until('the page says it is building', async () => (await me.state()) === 'building');
    assert.match(await me.page.locator('#notice-text').innerText(), /a new machine takes a few minutes/);
    assert.equal(await me.page.locator('#keys').isVisible(), false);
    assert.equal(await me.page.locator('#sleep').isVisible(), false);
    await me.until('it is live', async () => (await me.state()) === 'live', 30_000);
    await me.sees('ready>');
    await me.type('echo $((6*7))-is-the-answer');
    await me.sees('42-is-the-answer');
    assert.deepEqual(await me.page.locator('#items .item b').allInnerTexts(), ['first-talk']);
    assert.deepEqual(me.errors, []);
});

test('reloading the page finds the same session, with what was on screen', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('keeps-going');
    await me.type('MARK=still-here; echo set');
    await me.sees('set');
    await me.page.reload();
    await me.until('live again', async () => (await me.state()) === 'live');
    await me.type('echo $MARK');
    await me.sees('still-here');
});

test('the Esc key of the key row reaches the tool, alone', { skip: SKIP }, async (t) => {
    /* Found by a tester: the button did nothing, because clicking it took the
       terminal's focus and the Escape arrived glued to the focus reports. */
    const b = await bench(t);
    const me = await b.person();
    await me.create('keys');
    await me.type('read -rsn1 k; printf "GOT-%q-END\\n" "$k"');
    await wait(400);
    await me.page.locator('#keys button[data-keys="esc"]').click();
    await me.sees("GOT-$'\\E'-END", 5000);
    /* The arrows and Tab too, each as the sequence a terminal sends. */
    await me.type('read -rsn3 k; printf "GOT-%q-END\\n" "$k"');
    await wait(400);
    await me.page.locator('#keys button[data-keys="up"]').click();
    await me.sees("GOT-$'\\E[A'-END", 5000);
});

test('what is on screen can be had as ordinary text, to select by touch or copy whole', { skip: SKIP }, async (t) => {
    /* Asked for by the owner, on a tablet: a long press on the terminal selects nothing. */
    const b = await bench(t);
    const me = await b.person();
    await me.create('copyable');
    await me.type('echo first-line; echo "the address is https://example.com/a?b=1"');
    await me.sees('https://example.com/a?b=1');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await me.page.locator('#copy-open').click();
    const text = await me.page.locator('#copy-text').inputValue();
    assert.match(text, /first-line\nthe address is https:\/\/example\.com\/a\?b=1\nready> ?$/);
    /* A real text field: the browser selects in it as in any other. */
    await me.page.locator('#copy-text').selectText();
    assert.equal(await me.page.evaluate(() => getSelection().toString().length > 0 || document.getElementById('copy-text').selectionEnd > 0), true);
    await me.page.locator('#copy-all').click();
    await me.until('copied', async () => (await me.page.locator('#copy-status').innerText()) === 'Copied.');
    assert.equal(await me.page.evaluate(() => navigator.clipboard.readText()), text);
    await me.page.locator('#copy-close').click();
    await me.type('echo still-typing');
    await me.sees('still-typing');
});

test('the newest screen takes the conversation; the other is told and can take it back', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const desk = await b.person();
    await desk.create('one-seat');
    const phone = await b.person({ phone: true, at: '/?c=one-seat' });
    await phone.until('the phone is live', async () => (await phone.state()) === 'live');
    await desk.until('the desk is told', async () => (await desk.state()) === 'open elsewhere');
    assert.match(await desk.page.locator('#notice-text').innerText(), /open on another screen/);
    await desk.page.locator('#notice-action').click();
    await desk.until('the desk has it back', async () => (await desk.state()) === 'live');
    await phone.until('the phone is told in turn', async () => (await phone.state()) === 'open elsewhere');
});

test('leaving the tool ends the session; its machine stops after the delay and starts again on request', { skip: SKIP }, async (t) => {
    const b = await bench(t, { stopDelayMs: 1500 });
    const me = await b.person();
    await me.create('comes-back');
    await me.type('exit');
    await me.until('the page says the tool has exited', async () => (await me.state()) === 'ended');
    assert.match(await me.page.locator('#notice-text').innerText(), /The tool has exited/);
    await me.until('its machine is stopped', async () => (await me.api('/api/conversations')).body.length === 1 && require_state(b, 'comes-back') === 'Stopped', 8000);
    await me.page.locator('#notice-action').click();
    await me.until('live again', async () => (await me.state()) === 'live', 20_000);
    await me.sees('ready>');
    assert.equal(require_state(b, 'comes-back'), 'Running');
});

test('a sleep that was asked for holds through a reload, shows in the list, and ends on "Wake it"', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('sleeper');
    await me.type('KEPT=through-sleep; echo ok');
    await me.sees('ok');
    await me.page.locator('#folders').click();
    await me.page.locator('#sleep').click();
    await me.until('asleep', async () => (await me.state()) === 'asleep');
    assert.equal(require_state(b, 'sleeper'), 'Suspended');
    await me.page.reload();
    await me.until('still asleep after a reload', async () => (await me.state()) === 'asleep');
    assert.equal(require_state(b, 'sleeper'), 'Suspended', 'reloading the page did not wake the machine');
    assert.match(await me.page.locator('#items .item').innerText(), /asleep/);
    assert.equal(await me.page.locator('#sleep').isVisible(), false);
    await me.page.locator('#notice-action', { hasText: 'Wake it' }).click();
    await me.until('awake', async () => (await me.state()) === 'live');
    await me.type('echo $KEPT');
    await me.sees('through-sleep');
});

test('archiving asks first, then removes the conversation and its machine', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('short-lived');
    await me.page.locator('#folders').click();
    await me.page.locator('#archive').click();
    assert.match(await me.page.locator('#notice-text').innerText(), /Its machine is deleted/);
    await me.page.locator('#notice-cancel').click();
    assert.equal(await me.state(), 'live', 'Cancel changes nothing');
    await me.page.locator('#folders').click();
    await me.page.locator('#archive').click();
    await me.page.locator('#notice-action', { hasText: 'Archive' }).click();
    await me.until('gone from the list', async () => (await me.page.locator('#items .item').count()) === 0);
    assert.equal(require_state(b, 'short-lived'), undefined);
});

test('a bad name, a taken name and an empty form are refused with words', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('taken');
    assert.match((await me.api('/api/conversations', { name: 'ends-with-', tool: 'shell' })).body.error, /does not end with a hyphen/);
    assert.match((await me.api('/api/conversations', { name: 'taken', tool: 'shell' })).body.error, /already has this name/);
    assert.equal((await me.api('/api/conversations', { name: 'fine', tool: 'no-such-tool' })).status, 400);
    assert.deepEqual(await me.page.locator('#items .item b').allInnerTexts(), ['taken']);
});

/* What the stand-in VM manager believes the machine is doing. */
import { readFileSync, existsSync } from 'node:fs';
function require_state(b, name) {
    const file = `${b.dir}/vms/clv-${name}/state`;
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}
