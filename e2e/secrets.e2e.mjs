import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a secret handed to the tool is a variable of the tool after it restarts, and gone once switched off', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-key');
    /* Made in Assets; a value goes in and is nowhere afterwards. */
    await me.addAsset('secret');
    await me.page.fill('#secret-name', 'MODEL_KEY');
    await me.page.fill('#secret-value', 'sk-not-shown-again');
    await me.page.locator('#secret-new button[type=submit]').click();
    await me.until('the secret is listed', async () => (await me.page.locator('#assets-rows .as-row[data-asset="secret:MODEL_KEY"]').count()) === 1);
    assert.equal((await me.page.content()).includes('sk-not-shown-again'), false, 'the value is nowhere in the page');
    assert.equal(JSON.stringify((await me.api('/api/secrets')).body).includes('sk-not-shown-again'), false, 'nor in what the server gives back');
    await me.page.locator('#assets-close').click();
    /* Handed to this conversation's tool from Access, in two taps. */
    await me.page.locator('#folders').click();
    await me.page.locator('#attach-open').click();
    await me.page.locator('#attach-rows .folder[data-name="MODEL_KEY"]').locator('button', { hasText: 'Use' }).click();
    await me.until('the reminder is shown', async () => /next time it starts/.test(await me.page.locator('#secret-note').innerText()));
    await me.until('it is listed as handed', async () => (await me.page.locator('#access-secrets .folder[data-name="MODEL_KEY"]').count()) === 1);
    await me.page.goBack();

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
    await me.page.goBack();
    await restart();
    await me.type('echo "off=[$MODEL_KEY]"');
    await me.sees('off=[]');
});

test('a secret of several lines (a key) pasted into the line comes whole into its own box, masked, and arrives in the machine exactly as it was', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-pem');
    await me.addAsset('secret');
    await me.page.fill('#secret-name', 'DEPLOY_KEY');
    const key = '-----BEGIN TEST KEY-----\nAAAA line one\nBBBB line two\n-----END TEST KEY-----\n';
    /* Pasted into the line: the line keeps one line only, so the box of several lines takes it. */
    await me.page.locator('#secret-value').focus();
    await me.page.evaluate((text) => {
        const data = new DataTransfer(); data.setData('text/plain', text);
        document.getElementById('secret-value').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, key.replace(/\n/g, '\r\n'));
    await me.until('its own box is shown', async () => me.page.locator('#secret-lines').isVisible());
    assert.equal(await me.page.locator('#secret-value').isVisible(), false);
    assert.equal(await me.page.locator('#secret-lines').inputValue(), key, 'whole, its line breaks those of Unix');
    assert.equal(await me.page.locator('#secret-lines').evaluate((x) => getComputedStyle(x).webkitTextSecurity ?? getComputedStyle(x).getPropertyValue('-webkit-text-security')), 'disc', 'masked as it is typed');
    await me.page.locator('#secret-new button[type=submit]').click();
    await me.until('the secret is listed', async () => (await me.page.locator('#assets-rows .as-row[data-asset="secret:DEPLOY_KEY"]').count()) === 1);
    assert.equal((await me.page.content()).includes('line one'), false, 'the value is nowhere in the page');
    assert.equal(await me.page.locator('#secret-lines').isVisible(), false, 'back to one line for the next one');
    await me.page.locator('#assets-close').click();
    await me.page.locator('#folders').click();
    await me.page.locator('#attach-open').click();
    await me.page.locator('#attach-rows .folder[data-name="DEPLOY_KEY"]').locator('button', { hasText: 'Use' }).click();
    await me.until('it is listed as handed', async () => (await me.page.locator('#access-secrets .folder[data-name="DEPLOY_KEY"]').count()) === 1);
    await me.page.goBack();
    await me.type('exit');
    await me.until('the tool has exited', async () => (await me.state()) === 'ended');
    await me.page.locator('#notice-action').click();
    await me.until('live again', async () => (await me.state()) === 'live');
    /* Its variable holds it, line breaks and all (the shell drops the last one, as $(cat) does:
       put back here; the file /run/secrets/DEPLOY_KEY keeps it as it is). */
    await me.type('printf "%s\\n" "$DEPLOY_KEY" | wc -l; printf "%s\\n" "$DEPLOY_KEY" | sha256sum | cut -c1-16');
    const { createHash } = await import('node:crypto');
    await me.sees(createHash('sha256').update(key).digest('hex').slice(0, 16));
    await me.sees('\n4\n');
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
