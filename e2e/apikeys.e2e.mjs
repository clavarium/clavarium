import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* API keys (server/apikeys.mjs), as a person makes one: Settings, Access, a new key with the status
   scope and one conversation to talk in, its secret copied this once; a program reads the status with
   it, and posts in that conversation (signed with the key's name); the key's journal says it; the
   conversation turned to Read, the next post is refused; revoked in place, the next call is refused. */
test('API keys: made in Settings, copied once, read the status, talk in a conversation, journal, revoked: then 401', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: b.origin });
    await me.create('alpha');
    await me.create('beta');
    await me.page.locator('#nav-settings').click();
    await me.until('Settings are shown', async () => me.page.locator('#settings').isVisible());
    await me.until('the chapter is there', async () => !(await me.page.locator('#settings-ch-apikeys').evaluate((d) => d.hidden)));
    await me.chapter('s-apikeys');
    await me.until('no key yet', async () => me.page.locator('#apikeys-empty').isVisible());

    /* A new key: a name, the one scope ticked (none is, at first), 90 days proposed. */
    await me.page.locator('#apikeys-new').click();
    assert.equal(await me.page.locator('#apikeys-scopes input[value="status"]').isChecked(), false, 'no scope until ticked');
    assert.equal(await me.page.locator('#apikeys-days').inputValue(), '90');
    await me.page.fill('#apikeys-label', 'Home automation');
    await me.page.locator('#apikeys-scopes input[value="status"]').check();
    /* Its conversations, one by one: Off until chosen. */
    const pick = me.page.locator('#apikeys-convs .apikey-conv[data-name="alpha"] .kit-seg');
    assert.equal(await pick.locator('button[aria-pressed="true"]').getAttribute('data-value'), '', 'Off until chosen');
    await pick.locator('button[data-value="talk"]').click();
    await me.page.locator('#apikeys-form button[type="submit"]').click();

    /* Shown this once, copied. */
    await me.until('the secret is shown', async () => me.page.locator('#apikeys-once').isVisible());
    const shown = await me.page.locator('#apikeys-secret').inputValue();
    assert.match(shown, /^clv_[A-Za-z0-9_-]{43}$/);
    await me.page.locator('#apikeys-copy').click();
    await me.until('it says copied', async () => (await me.page.locator('#apikeys-copy').innerText()) === 'Copied');
    const secret = await me.page.evaluate(() => navigator.clipboard.readText());
    assert.equal(secret, shown);
    await me.until('the key is listed', async () => (await me.page.locator('#apikeys-rows .list-item').count()) === 1);
    const row = me.page.locator('#apikeys-rows .list-item').first();
    assert.match(await row.innerText(), /Home automation[\s\S]*Status \(read\)[\s\S]*alpha · Talk[\s\S]*Never used[\s\S]*Expires/);
    await me.page.locator('#apikeys-done').click();
    assert.equal(await me.page.locator('#apikeys-once').isVisible(), false);
    assert.equal(await me.page.locator('#apikeys-secret').inputValue(), '', 'Done: gone from the page');
    /* Shown that once (its field, the configuration to paste, the curl line), then nowhere in the page. */
    assert.equal((await me.page.content()).includes(secret), false, 'Done: nowhere in the page');

    /* A program elsewhere: the status, with the key. */
    const status = (key) => fetch(`${b.origin}/api/ext/v1/status`, { headers: { authorization: `Bearer ${key}` } });
    const ok = await status(secret);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.conversations.map((c) => c.id).sort(), ['alpha', 'beta']);
    assert.ok(['awake', 'working', 'needs-you'].includes(body.conversations[0].state));
    assert.equal(typeof body.versions.clavarium, 'string');

    /* Its conversation: listed, read, and a message posted in it -- signed with the key's name, never as the person. */
    const ext = (path, more = {}) => fetch(`${b.origin}/api/ext/v1${path}`, { ...more, headers: { authorization: `Bearer ${secret}`, ...(more.body ? { 'content-type': 'application/json' } : {}) } });
    await me.until('its chat is on', async () => (await (await ext('/conversations')).json()).conversations?.[0]?.chat === true, 30_000);
    assert.deepEqual((await (await ext('/conversations')).json()).conversations.map((c) => [c.id, c.level]), [['alpha', 'talk']]);
    const posted = await ext('/conversations/alpha/messages', { method: 'POST', body: JSON.stringify({ text: 'The heating is on' }) });
    assert.equal(posted.status, 201);
    const thread = await (await ext('/conversations/alpha/messages?last=10')).json();
    const mine = thread.messages.find((m) => m.text === 'The heating is on');
    assert.equal(mine?.from, 'person'); assert.equal(mine?.by, 'Home automation');
    assert.equal((await ext('/conversations/beta/messages')).status, 403, 'a conversation not given');

    /* Its journal, under it: its last calls, the newest first. */
    await row.locator('button[data-act="journal"]').click();
    await me.until('the journal is shown', async () => (await row.locator('.apikey-more .apikey-use').count()) >= 4);
    assert.match(await row.locator('.apikey-more .apikey-use').first().innerText(), /GET \/v1\/conversations\/beta\/messages[\s\S]*403/);
    assert.match(await row.locator('.apikey-more').innerText(), /POST \/v1\/conversations\/alpha\/messages[\s\S]*201/);

    /* Turned to Read in place: the next post is refused. */
    await row.locator('button[data-act="convs"]').click();
    const level = row.locator('.apikey-more .apikey-conv[data-name="alpha"] .kit-seg');
    await level.locator('button[data-value="read"]').click();
    await me.until('the row says Read', async () => /alpha · Read/.test(await me.page.locator('#apikeys-rows .list-item').first().innerText()));
    assert.equal((await ext('/conversations/alpha/messages', { method: 'POST', body: JSON.stringify({ text: 'Again' }) })).status, 403);

    /* Revoked, confirmed in place: the next call is refused. */
    await row.locator('button[data-act="revoke"]').click();
    await row.locator('.kit-confirm button.danger').click();
    await me.until('the list is empty again', async () => (await me.page.locator('#apikeys-rows .list-item').count()) === 0);
    const refused = await status(secret);
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error, /not valid/);

    assert.deepEqual(me.errors, [], 'no page error at any point');
});
