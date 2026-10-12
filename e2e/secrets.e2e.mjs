import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a secret handed to the tool is a variable of the tool after it restarts, and gone once switched off', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-key');
    /* Made in Assets; a value goes in and is nowhere afterwards. */
    await me.page.locator('#assets-open').click();
    await me.page.locator('#secret-box summary').click();
    await me.page.fill('#secret-name', 'MODEL_KEY');
    await me.page.fill('#secret-value', 'sk-not-shown-again');
    await me.page.locator('#secret-new button[type=submit]').click();
    await me.until('the secret is listed', async () => (await me.page.locator('#secret-rows .asset[data-name="MODEL_KEY"]').count()) === 1);
    assert.equal((await me.page.content()).includes('sk-not-shown-again'), false, 'the value is nowhere in the page');
    assert.equal(JSON.stringify((await me.api('/api/secrets')).body).includes('sk-not-shown-again'), false, 'nor in what the server gives back');
    await me.page.locator('#assets-close').click();
    /* Handed to this conversation's tool from Access, in two taps. */
    await me.page.locator('#folders').click();
    await me.page.locator('#attach-open').click();
    await me.page.locator('#attach-rows .folder[data-name="MODEL_KEY"]').locator('button', { hasText: 'Use' }).click();
    await me.until('the reminder is shown', async () => /next time it starts/.test(await me.page.locator('#secret-note').innerText()));
    await me.until('it is listed as handed', async () => (await me.page.locator('#access-secrets .folder[data-name="MODEL_KEY"]').count()) === 1);
    await me.page.locator('#panel-close').click();

    const restart = async () => {
        await me.type('exit');
        await me.until('the tool has exited', async () => (await me.state()) === 'ended');
        await me.page.locator('#notice-action').click();
        await me.until('live again', async () => (await me.state()) === 'live');
    };
    await me.type('echo "before=[$MODEL_KEY]"');
    await me.sees('before=[]');
    await restart();
    await me.type('echo "after=[$MODEL_KEY]"');
    await me.sees('after=[sk-not-shown-again]');

    await me.page.locator('#folders').click();
    await me.page.locator('#access-secrets .folder[data-name="MODEL_KEY"]').locator('button', { hasText: 'Detach' }).click();
    await me.until('it is no longer handed', async () => (await me.page.locator('#access-secrets .folder').count()) === 0);
    await me.page.locator('#panel-close').click();
    await restart();
    await me.type('echo "off=[$MODEL_KEY]"');
    await me.sees('off=[]');
});

test('reloading the page sends nothing into the machine: its terminal is already open', { skip: SKIP }, async (t) => {
    /* Asked by the owner: "when I reload, the terminal takes time to connect;
       the tunnel should stay open while the machine runs". Asking the VM
       manager for the machine's state and opening a channel into it cost
       seconds; neither happens any more for a machine whose terminal is kept. */
    const b = await bench(t);
    const me = await b.person();
    await me.create('quick');
    await me.type('echo before-the-reload');
    await me.sees('before-the-reload');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const log = `${b.dir}/exec-log`;
    process.env.FAKE_VM_LOG = log;
    writeFileSync(log, '');
    const started = Date.now();
    await me.page.reload();
    await me.until('live again', async () => (await me.state()) === 'live');
    await me.sees('before-the-reload');
    const took = Date.now() - started;
    const sent = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    delete process.env.FAKE_VM_LOG;
    assert.deepEqual(sent, [], `nothing is asked of the VM manager: ${sent.join(' ; ')}`);
    assert.ok(took < 4000, `the page and its terminal were back in ${took} ms`);
});
