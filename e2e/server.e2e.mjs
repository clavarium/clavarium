import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

const SHORT = ['place machines 2049 102400 4000', 'place data 2049 102400 4000', 'place folders 2049 102400 4000', 'memory 16384 1500', 'machine clv-alpha 800'].join('\n');

test('This server: its disk and memory in Settings; a small gauge only when it is short of room, which opens them; the reserve refuses a new machine, in words, and can be lowered', { skip: SKIP }, async (t) => {
    const b = await bench(t, { serverRoomMs: 200 });
    t.after(() => { delete process.env.FAKE_SERVER_ROOM; });
    const me = await b.person();
    await me.create('alpha');
    const gauge = me.page.locator('#server-gauge');
    assert.equal(await gauge.isVisible(), false, 'plenty of room: no gauge');
    await me.page.locator('#nav-settings').click();
    const disk = me.page.locator('#server-disks .server-block').first();
    await me.until('the disk is said', async () => (await disk.locator('.server-figures').innerText().catch(() => '')) === '60 GB free of 100 GB');
    assert.equal(await disk.locator('.server-note').innerText(), '57 GB above the 3.0 GB reserve');
    assert.equal(await me.page.locator('#server-memory-figures').innerText(), '12 GB free of 16 GB');
    await me.until('what takes the disk is said', async () => /This server's data[\s\S]*Shared folders[\s\S]*folders given to machines[\s\S]*Machines[\s\S]*alpha[\s\S]*images[\s\S]*The system and other programs/.test(await disk.locator('.server-parts').innerText()));
    assert.match(await me.page.locator('#server-memory-parts').innerText(), /Running machines \(1\)[\s\S]*alpha\s+uses 0\.9 GB · given 0\.8 GB/);
    assert.deepEqual([await me.page.inputValue('#reserve-disk'), await me.page.inputValue('#reserve-memory')], ['3', '1']);
    assert.equal(await disk.locator('.server-state').isVisible(), false);
    await me.page.locator('#settings-close').click();
    /* Short of room: the gauge comes, and opens This server. */
    process.env.FAKE_SERVER_ROOM = SHORT;
    await me.page.reload();
    await me.until('the gauge is shown', async () => gauge.isVisible());
    assert.match(await gauge.innerText(), /This server is short of room[\s\S]*Disk[\s\S]*0\.9 GB left[\s\S]*Memory[\s\S]*0\.5 GB left[\s\S]*See what takes room/);
    await gauge.click();
    await me.until('This server is open', async () => (await me.page.locator('#settings').isVisible()) && (await me.page.locator('#server-disks .server-state').first().innerText()) === 'Short');
    assert.ok(await me.page.locator('#settings-server-top').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; }), 'scrolled to it');
    /* A new machine would eat into the reserve: refused, with why and what to do. */
    const made = await me.api('/api/conversations', { name: 'beta', tool: 'shell' });
    assert.equal(made.status, 409);
    assert.match(made.body.error, /^Not created: this server cannot spare .* GB of memory for a new machine\. It has 1\.5 GB free for machines and keeps 1\.0 GB in reserve\. Put a conversation you are not using to sleep, or choose less memory, or lower the reserve in Settings, This server\.$/);
    /* The owner lowers the reserve: allowed. */
    await me.page.fill('#reserve-disk', '0');
    await me.page.fill('#reserve-memory', '0.5');
    await me.page.locator('#reserve-save').click();
    await me.until('saved', async () => (await me.page.locator('#reserve-saved').innerText()) === 'Saved.');
    assert.deepEqual((await me.api('/api/server')).body.reserve, { diskMb: 0, memoryMb: 512 });
    /* On a phone, the gauge sits at the bottom of the list, within the screen. */
    const phone = await b.person({ phone: true });
    const small = phone.page.locator('#server-gauge');
    await phone.until('the gauge is on the phone', async () => small.isVisible());
    const box = await small.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 780, JSON.stringify(box));
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
});
