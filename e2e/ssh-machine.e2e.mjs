import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A MACHINE OVER SSH, MADE FROM THE PAGE (17-11): New asset > Machine (SSH): its name, address, user; a key made
   here in place (the same keys as the git repositories), the line for its authorized_keys shown to copy; the
   server's fingerprint read and kept. A machine not reached says so and nothing is made. The key list then says
   which machine uses the key, and refuses to remove it. Desktop and phone. The host key is read from a stand-in
   (no network). example.com only. */
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const PRINT = 'SHA256:qWl6liNTB8c2XckaX85x+11b2zRuWAng34K5kKH73KU';

test('a machine over SSH is made from the page with a key made here, its fingerprint kept; on a phone too', { skip: SKIP }, async (t) => {
    const probe = async (host) => { if (host === 'down.example.com') throw new Error('connect ECONNREFUSED'); return PRINT; };
    const b = await bench(t, { sshProbe: probe });
    const me = await b.person();
    const page = me.page;
    for (const [name, w, h] of [['desktop', 1280, 900], ['phone', 390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        if (name === 'phone') await page.goto(`${b.origin}/`);
        await me.addAsset('machine');
        const form = page.locator('#machine-box');
        await me.until('the machine form', async () => form.isVisible());
        const title = name === 'desktop' ? 'Serveur maison' : 'Serveur bureau';
        await page.locator('#machine-title').fill(title);
        await page.locator('#machine-host').fill('down.example.com');
        await page.locator('#machine-user').fill('admin');
        /* A key made in place: its line for authorized_keys, at once. */
        if (name === 'desktop') {
            await form.locator('#machine-key-new').click();
            await me.until('the key name, suggested', async () => (await page.locator('#machine-key-name').inputValue()) === 'serveur-maison');
            await form.locator('#machine-key-make-go').click();
        }
        await me.until('the line to paste', async () => /^ssh-ed25519 \S+ clavarium-serveur-maison$/.test(await page.locator('#machine-key-line').inputValue()), 20_000);
        assert.equal(await page.locator('#machine-key').inputValue(), 'serveur-maison');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no sideways scroll`);
        await shot(page, `${name}-machine-form`);
        /* Not reached: said, nothing made. */
        await page.locator('#machine-add').click();
        await me.until('not reached, said', async () => /could not be reached/.test(await page.locator('#machine-error').innerText()), 20_000);
        assert.equal((await me.api('/api/tether')).body.targets.filter((x) => x.kind === 'ssh').length, name === 'desktop' ? 0 : 1);
        /* Reached: made, its fingerprint kept and said. */
        await page.locator('#machine-host').fill('server.example.com');
        await page.locator('#machine-add').click();
        await me.until('made', async () => (await page.locator('#assets-detail').innerText()).includes(PRINT), 20_000);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('.kit-na-made .hint')].every((n) => n.scrollWidth <= n.clientWidth + 1)), `${name}: the fingerprint fits`);
        await shot(page, `${name}-machine-made`);
    }
    const targets = (await me.api('/api/tether')).body.targets.filter((x) => x.kind === 'ssh');
    assert.deepEqual(targets.map((x) => [x.title, x.config.host, x.config.user, x.config.pin]), [['Serveur maison', 'server.example.com', 'admin', PRINT], ['Serveur bureau', 'server.example.com', 'admin', PRINT]]);
    assert.doesNotMatch(JSON.stringify(targets), /PRIVATE KEY/);
    /* The key says who uses it, and is not removed while they do. */
    const keys = (await me.api('/api/git-keys')).body;
    assert.deepEqual(keys.map((k) => [k.name, k.usedBy]), [['serveur-maison', ['Serveur maison', 'Serveur bureau']]]);
    assert.equal((await me.api('/api/git-keys/serveur-maison/remove', {})).status, 409);
    assert.deepEqual(me.errors, []);
});
