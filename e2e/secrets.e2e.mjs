import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a secret handed to the tool is a variable of the tool after it restarts, and gone once switched off', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-key');
    await me.page.locator('#folders').click();
    await me.page.fill('#secret-name', 'MODEL_KEY');
    await me.page.fill('#secret-value', 'sk-not-shown-again');
    await me.page.locator('#secret-new button[type=submit]').click();
    await me.until('the secret is listed', async () => (await me.page.locator('#secret-rows .folder').count()) === 1);
    assert.equal((await me.page.content()).includes('sk-not-shown-again'), false, 'the value is nowhere in the page');
    assert.equal(JSON.stringify((await me.api('/api/secrets')).body).includes('sk-not-shown-again'), false, 'nor in what the server gives back');
    await me.page.locator('#secret-rows .folder button', { hasText: 'Handed to the tool' }).click();
    await me.until('the reminder is shown', async () => /next time it starts/.test(await me.page.locator('#secret-note').innerText()));
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
    await me.page.locator('#secret-rows .folder button', { hasText: 'Off' }).click();
    await me.page.locator('#panel-close').click();
    await restart();
    await me.type('echo "off=[$MODEL_KEY]"');
    await me.sees('off=[]');
});

test('opening a conversation again does not deliver again what is already there', { skip: SKIP }, async (t) => {
    /* Asked by the owner: "it takes a few seconds to connect". Each command
       sent into a machine costs time; a second opening must send only what
       the terminal itself needs. */
    const b = await bench(t);
    const me = await b.person();
    await me.create('quick');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const log = `${b.dir}/exec-log`;
    process.env.FAKE_VM_LOG = log;
    writeFileSync(log, '');
    await me.page.reload();
    await me.until('live again', async () => (await me.state()) === 'live');
    const sent = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    delete process.env.FAKE_VM_LOG;
    /* (The terminal's own attachment goes through its PTY and is not in this
       log: what is counted here is every OTHER command sent to the machine.) */
    assert.deepEqual(sent.map((l) => l.split(' ')[0]), ['info'], `only the machine's state is asked: ${sent.join(' ; ')}`);
});
