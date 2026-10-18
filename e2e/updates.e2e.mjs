import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

test('Settings, Updates: the version, what is out, the mode and its window, the channel; update, a failed update said, going back; small screens too', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const at = join(process.env.FAKE_VM_DIR, 'update');
    const p = me.page;
    /* Run from a working tree: said, nothing offered. */
    await p.locator('#nav-settings').click();
    await me.until('the version is said', async () => /^Clavarium \S+/.test(await p.locator('#updates-version').innerText()));
    assert.equal(await p.locator('#updates-state').innerText(), 'Not installed with install.sh: no updates here.');
    assert.equal(await p.locator('#updates-check').isVisible(), false);
    assert.equal(await p.locator('#updates-mode').isVisible(), false);
    /* Installed: the updater's files. */
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'update.conf'), 'MODE=auto\nCHANNEL=latest\nWINDOW=02:00-05:00\nPORT=7717\n');
    writeFileSync(join(at, 'state.json'), JSON.stringify({ version: '0.1.0', releases: [{ id: '0.1.0', version: '0.1.0', current: true }], history: [], checkedAt: new Date().toISOString() }));
    await p.locator('#settings-close').click();
    await p.locator('#nav-settings').click();
    await me.until('installed', async () => (await p.locator('#updates-version').innerText()) === 'Clavarium 0.1.0');
    assert.equal(await p.locator('#updates-state').innerText(), 'Up to date · checked just now');
    assert.equal(await p.inputValue('#updates-mode'), 'auto');
    assert.deepEqual([await p.inputValue('#updates-from'), await p.inputValue('#updates-to')], ['02:00', '05:00']);
    assert.equal(await p.locator('#updates-history-box').isVisible(), false, 'no history yet: nothing shown');
    /* The window, then the mode and the channel: saved through the host program. */
    await p.fill('#updates-from', '01:30');
    await me.until('the window is saved', async () => /WINDOW=01:30-05:00/.test(readFileSync(join(at, 'update.conf'), 'utf8')));
    await p.selectOption('#updates-mode', 'ask');
    await me.until('the mode is saved', async () => /MODE=ask/.test(readFileSync(join(at, 'update.conf'), 'utf8')));
    await me.until('no window for "Ask me"', async () => !(await p.locator('#updates-from').isVisible()));
    await p.selectOption('#updates-channel', 'next');
    await me.until('the channel is saved', async () => /CHANNEL=next/.test(readFileSync(join(at, 'update.conf'), 'utf8')));
    assert.equal(await p.locator('#updates-saved').innerText(), 'Saved.');
    /* Check now: a version is out, and offered. */
    writeFileSync(join(at, 'registry'), '0.2.0');
    await p.locator('#updates-check').click();
    await me.until('it is out', async () => (await p.locator('#updates-state').innerText()) === '0.2.0 is out.');
    await p.locator('#updates-apply', { hasText: 'Update to 0.2.0' }).click();
    await me.until('updated', async () => (await p.locator('#updates-version').innerText()) === 'Clavarium 0.2.0');
    assert.equal(await p.locator('#updates-apply').isVisible(), false);
    await p.locator('#updates-history-box summary').click();
    assert.match(await p.locator('#updates-history').innerText(), /0\.1\.0 → 0\.2\.0 · Done/);
    /* A version that does not come up: said in words, and in the history. */
    writeFileSync(join(at, 'registry'), '0.3.0'); writeFileSync(join(at, 'broken'), '0.3.0');
    await p.locator('#updates-check').click();
    await p.locator('#updates-apply', { hasText: 'Update to 0.3.0' }).click();
    await me.until('the failure is said', async () => (await p.locator('#updates-news').innerText().catch(() => '')) === 'The update to 0.3.0 did not work, so 0.2.0 was put back. It did not answer');
    assert.equal(await p.locator('#updates-version').innerText(), 'Clavarium 0.2.0');
    assert.match(await p.locator('#updates-history').innerText(), /0\.2\.0 → 0\.3\.0 · Did not work: went back\s+it did not answer/);
    /* Going back, asked once more in place. */
    await p.locator('#updates-back button', { hasText: 'Go back to 0.1.0' }).click();
    assert.equal(await p.locator('#updates-back .hint').innerText(), 'The server restarts on 0.1.0.');
    await p.locator('#updates-back button', { hasText: /^Go back$/ }).click();
    await me.until('gone back', async () => (await p.locator('#updates-version').innerText()) === 'Clavarium 0.1.0');
    assert.match(await p.locator('#updates-history').innerText(), /0\.2\.0 → 0\.1\.0 · Went back/);
    assert.equal(await p.locator('#updates-news').isVisible(), false, 'what worked is not news');
    /* On a phone, dark: within the screen, no sideways scroll. */
    const phone = await b.person({ phone: true });
    await phone.page.emulateMedia({ colorScheme: 'dark' });
    await phone.page.locator('#nav-settings').click();
    await phone.until('Updates on the phone', async () => (await phone.page.locator('#updates-version').innerText().catch(() => '')) === 'Clavarium 0.1.0');
    await phone.page.locator('#settings-updates-top').scrollIntoViewIfNeeded();
    for (const id of ['#updates-check', '#updates-mode', '#updates-channel']) {
        const box = await phone.page.locator(id).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${id}: ${JSON.stringify(box)}`);
    }
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(me.errors ?? [], []);
});
