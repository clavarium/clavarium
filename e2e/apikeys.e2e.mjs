import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* API keys (server/apikeys.mjs), as a person makes one: Settings, Access, a new key with the status
   scope, its secret copied this once; a program reads the status with it; revoked in place, the
   next call is refused. */
test('API keys: made in Settings, copied once, read the status with it, revoked: then 401', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: b.origin });
    await me.create('alpha');
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
    assert.match(await row.innerText(), /Home automation[\s\S]*Status \(read\)[\s\S]*Never used[\s\S]*Expires/);
    assert.equal((await me.page.content()).includes(secret), false, 'never written into the page: only the value of its field');
    await me.page.locator('#apikeys-done').click();
    assert.equal(await me.page.locator('#apikeys-once').isVisible(), false);
    assert.equal(await me.page.locator('#apikeys-secret').inputValue(), '', 'Done: gone from the page');

    /* A program elsewhere: the status, with the key. */
    const status = (key) => fetch(`${b.origin}/api/ext/v1/status`, { headers: { authorization: `Bearer ${key}` } });
    const ok = await status(secret);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.conversations.map((c) => c.id), ['alpha']);
    assert.ok(['awake', 'working', 'needs-you'].includes(body.conversations[0].state));
    assert.equal(typeof body.versions.clavarium, 'string');

    /* Revoked, confirmed in place: the next call is refused. */
    await row.locator('button[data-act="revoke"]').click();
    await row.locator('.kit-confirm button.danger').click();
    await me.until('the list is empty again', async () => (await me.page.locator('#apikeys-rows .list-item').count()) === 0);
    const refused = await status(secret);
    assert.equal(refused.status, 401);
    assert.match((await refused.json()).error, /not valid/);

    assert.deepEqual(me.errors, [], 'no page error at any point');
});
