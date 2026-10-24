import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A day as the date field and the server take it, `n` days from today. */
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/* CLAVARIUM_SHOTS: a folder; the sheets of a secret are photographed there. */
const SHOTS = process.env.CLAVARIUM_SHOTS;

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

test('a secret is renamed: its value and the conversation it is handed to go with it; its tool sees it under the new name at its next start', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('renamer');
    await me.api('/api/secrets', { name: 'OLD_KEY', value: 'kept-value' });
    await me.api('/api/conversations/renamer/secrets', { secret: 'OLD_KEY', attached: true });
    await me.page.reload();
    await me.until('live', async () => (await me.state()) === 'live');
    await me.openAsset('secret', 'OLD_KEY');
    await me.page.fill('#secret-rename-name', 'NEW_KEY');
    await me.page.locator('.secret-rename button[type=submit]').click();
    await me.until('listed under its new name', async () => (await me.page.locator('#assets-rows .as-row[data-asset="secret:NEW_KEY"]').count()) === 1);
    const list = (await me.api('/api/secrets')).body;
    assert.deepEqual(list.map((x) => [x.name, x.conversations]), [['NEW_KEY', ['renamer']]]);
    assert.equal((await me.api('/api/secrets/NEW_KEY/rename', { name: 'A B' })).status, 400);
    await me.api('/api/secrets', { name: 'TAKEN', value: 'x' });
    assert.equal((await me.api('/api/secrets/NEW_KEY/rename', { name: 'TAKEN' })).status, 409);
    await me.page.locator('#assets-close').click();
    await me.type('exit');
    await me.until('the tool has exited', async () => (await me.state()) === 'ended');
    await me.page.locator('#notice-action').click();
    await me.until('live again', async () => (await me.state()) === 'live');
    await me.type('echo "new=[$NEW_KEY] old=[$OLD_KEY]"');
    await me.sees('new=[kept-value] old=[]');
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

test('an expiry: said a few days ahead, with a dot on Assets; past it the secret is kept, shown Expired, and no longer given; its value replaced without being seen', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('expiring');
    /* Made with an expiry three days ahead. */
    await me.addAsset('secret');
    await me.page.fill('#secret-name', 'SOON_KEY');
    await me.page.fill('#secret-value', 'sk-soon-first');
    await me.page.fill('#secret-expires', day(3));
    await me.page.locator('#secret-new button[type=submit]').click();
    const soonRow = me.page.locator('#assets-rows .as-row[data-asset="secret:SOON_KEY"] .as-sub');
    await me.until('its row says it is near', async () => (await soonRow.innerText().catch(() => '')) === 'Expires in 3 days');
    assert.equal(await soonRow.getAttribute('data-tone'), 'warn');
    await me.until('its sheet says it, with the day', async () => (await me.page.locator('#assets-detail .secret-expiry-state').innerText().catch(() => '')) === `Expires in 3 days · ${day(3)}`);
    assert.equal(await me.page.locator('#assets-detail .secret-expiry-state').getAttribute('data-tone'), 'warn');
    await me.until('a dot on Assets', async () => (await me.page.locator('#nav-assets[data-attention]').count()) === 1);
    /* One past its day, made through the API: expired at once. */
    await me.api('/api/secrets', { name: 'PAST_KEY', value: 'sk-past-value', expires: day(-1) });
    await me.api('/api/conversations/expiring/secrets', { secret: 'SOON_KEY', attached: true });
    await me.api('/api/conversations/expiring/secrets', { secret: 'PAST_KEY', attached: true });
    const listed = (await me.api('/api/secrets')).body;
    assert.deepEqual(listed.map((x) => [x.name, x.expired, x.days]).sort(), [['PAST_KEY', true, -1], ['SOON_KEY', false, 3]]);
    await me.page.locator('#assets-close').click();
    await me.openAsset('secret', 'PAST_KEY');
    await me.until('shown Expired, in red', async () => (await me.page.locator('#assets-detail .secret-expiry-state').innerText().catch(() => '')).startsWith('Expired'));
    assert.equal(await me.page.locator('#assets-detail .secret-expiry-state').getAttribute('data-tone'), 'bad');
    assert.equal(await me.page.locator('#assets-rows .as-row[data-asset="secret:PAST_KEY"] .as-sub').innerText(), 'Expired');
    /* Said once in What happened, with who had it. */
    await me.until('said in What happened', async () => (await me.api('/api/events?q=PAST_KEY')).body.some((e) => e.text.startsWith('Secret PAST_KEY expired')));

    /* Replace the value of SOON_KEY, and take its expiry away. */
    await me.openAsset('secret', 'SOON_KEY');
    await me.page.locator('#secret-replace-open').click();
    await me.page.fill('#secret-replace-value', 'sk-soon-second');
    await me.page.fill('#secret-replace-expires', '');
    await me.page.locator('#secret-replace button[type=submit]').click();
    await me.until('said once replaced', async () => (await me.page.locator('#assets-detail .secret-replace-said').innerText().catch(() => '')) === 'Machines get it at their next start');
    await me.until('no expiry any more', async () => (await me.page.locator('#assets-detail .secret-expiry-state').innerText()) === 'No expiry');
    assert.equal((await me.page.content()).includes('sk-soon'), false, 'no value in the page, old or new');
    assert.equal(JSON.stringify((await me.api('/api/secrets')).body).match(/sk-soon|sk-past|sealed/), null, 'nor in what the server gives back');
    assert.deepEqual((await me.api('/api/secrets')).body.find((x) => x.name === 'SOON_KEY').conversations, ['expiring'], 'still given to it');

    /* Its own Assets show the expired one too. */
    await me.page.locator('#assets-close').click();
    await me.page.locator('#view-assets').click();
    const pastHere = me.page.locator('#cassets-rows .as-row[data-asset="secret:PAST_KEY"] .as-sub');
    await me.until('its own Assets say it expired', async () => (await pastHere.innerText().catch(() => '')) === 'Expired');
    assert.equal(await pastHere.getAttribute('data-tone'), 'bad');
    await me.until('a dot on its Assets', async () => (await me.page.locator('#view-assets[data-attention]').count()) === 1);
    await me.page.locator('#view-terminal').click();

    /* At its next start: the new value, and nothing of the expired one. */
    await me.type('exit');
    await me.until('the tool has exited', async () => (await me.state()) === 'ended');
    await me.page.locator('#notice-action').click();
    await me.until('live again', async () => (await me.state()) === 'live');
    await me.type('echo "soon=[$SOON_KEY] past=[$PAST_KEY]"');
    await me.sees('soon=[sk-soon-second] past=[]');
    assert.equal(me.errors.length, 0, me.errors.join('\n'));
});

test('the sheets of a secret, photographed: near its expiry, expired, and Replace the value', { skip: SHOTS ? SKIP : 'set CLAVARIUM_SHOTS to a folder' }, async (t) => {
    const b = await bench(t);
    const first = await b.person();
    await first.create('builder');
    await first.api('/api/secrets', { name: 'NPM_TOKEN', value: 'shot-value-one', expires: day(3) });
    await first.api('/api/secrets', { name: 'OLD_TOKEN', value: 'shot-value-two', expires: day(-2) });
    await first.api('/api/secrets', { name: 'MODEL_KEY', value: 'shot-value-three' });
    for (const n of ['NPM_TOKEN', 'OLD_TOKEN']) await first.api('/api/conversations/builder/secrets', { secret: n, attached: true });
    mkdirSync(SHOTS, { recursive: true });
    const looks = [['tablet-light', { viewport: { width: 1180, height: 820 }, colorScheme: 'light' }], ['tablet-dark', { viewport: { width: 1180, height: 820 }, colorScheme: 'dark' }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' }]];
    for (const [look, options] of looks) {
        const context = await b.browser.newContext(options);
        await context.addInitScript((theme) => { try { localStorage.setItem('clavarium-theme', theme); } catch { /* an opaque page */ } }, options.colorScheme);
        const me = await b.person({ context });
        /* On a phone the list is hidden behind an opened sheet: back to it first. */
        const open = async (name) => { const back = me.page.locator('#assets-detail .as-back'); if (await back.isVisible().catch(() => false)) await back.click(); await me.openAsset('secret', name); };
        await me.openAsset('secret', 'NPM_TOKEN');
        await me.page.screenshot({ path: join(SHOTS, `secrets-1-${look}-near.png`) });
        await open('OLD_TOKEN');
        await me.page.screenshot({ path: join(SHOTS, `secrets-1-${look}-expired.png`) });
        await open('NPM_TOKEN');
        await me.page.locator('#secret-replace-open').click();
        await me.page.fill('#secret-replace-value', 'typed-not-shown');
        await me.page.screenshot({ path: join(SHOTS, `secrets-1-${look}-replace.png`) });
        await me.page.locator('#assets-close').click();
        await me.addAsset('secret');
        await me.page.screenshot({ path: join(SHOTS, `secrets-1-${look}-new.png`) });
        assert.equal(me.errors.length, 0, me.errors.join('\n'));
    }
});
