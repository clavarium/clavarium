/* PINNED MESSAGES (10-11): the person pins a message of the chat from its menu; the newest pinned
   stays on a bar at the top of the chat, all of them a tap away; a tap on one goes back to it;
   unpinned from the list. The tool reads each pin as it reads a reaction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const id = (x) => `${x}-0000-4000-8000-000000000000`.slice(0, 36);
const line = (x, s, rest) => `${JSON.stringify({ id: id(x), at: at(s), ...rest })}\n`;

test('a message pinned from its menu: on a bar at the top of the chat, a tap goes back to it, two or more in a list, unpinned from there; the tool is told', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('pins');
    assert.equal((await me.api('/api/conversations/pins/talk', { on: true })).status, 200);
    const work = join(b.dir, 'data', 'work', 'pins');
    writeFileSync(join(work, '.parley', 'from-agent.jsonl'),
        line('p1', 0, { kind: 'say', text: 'Rule: firm wakes only, until the v4 model.' })
        + line('p2', 1, { kind: 'say', text: 'Beta 0.2.191 is out: Settings, Check for an update.' })
        + line('p3', 2, { kind: 'say', text: 'Something else, of no lasting use.' }));
    await me.page.goto(`${b.origin}/?c=pins`);
    const thread = me.page.locator('#simple-thread');
    const bar = thread.locator('.parley-pins');
    await me.until('the messages', async () => (await thread.locator('.parley-said[data-kind=say]').count()) === 3);
    assert.equal(await bar.isVisible(), false, 'no bar without a pin');
    const pin = async (x) => {
        const m = thread.locator(`.parley-said[data-id="${id(x)}"]`);
        await m.hover();
        await m.locator('.parley-react-open').click();
        await thread.locator('.parley-react-pin:visible').click();
    };
    await pin('p1');
    await me.until('on the bar', async () => (await bar.isVisible()) && /firm wakes only/.test(await thread.locator('.parley-pins-text').innerText()));
    assert.equal(await thread.locator(`.parley-said[data-id="${id('p1')}"]`).getAttribute('data-pinned'), 'true');
    /* The tool reads it, with the words of the message. */
    const last = readFileSync(join(work, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([last.pin, last.removed ?? false], [id('p1'), false]);
    await pin('p2');
    await me.until('the newest on the bar, two in all', async () => /0\.2\.191/.test(await thread.locator('.parley-pins-text').innerText()) && /2/.test(await thread.locator('.parley-pins-count').innerText().catch(() => '')));
    if (process.env.CLAVARIUM_E2E_SHOTS) {
        await thread.locator('.parley-pins-more').click();
        for (const [w, h, name] of [[1280, 900, 'desktop'], [900, 1200, 'tablet'], [390, 844, 'phone']]) {
            await me.page.setViewportSize({ width: w, height: h });
            await me.page.screenshot({ path: `${process.env.CLAVARIUM_E2E_SHOTS}/pins-${name}.png` });
        }
        await me.page.setViewportSize({ width: 1280, height: 900 });
        await me.page.keyboard.press('Escape');
    }
    /* The chat's own settings stay within reach: the bar never covers them. */
    const prefs = await thread.locator('.parley-prefs-open').boundingBox();
    assert.equal(await me.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.parley-prefs-open') !== null, [prefs.x + prefs.width / 2, prefs.y + prefs.height / 2]), true, 'the settings button is not under the bar');
    /* The list, newest first; unpinned from there. */
    await thread.locator('.parley-pins-more').click();
    await me.until('the list', async () => (await thread.locator('.parley-pins-item').count()) === 2);
    assert.deepEqual(await thread.locator('.parley-pins-item').evaluateAll((all) => all.map((x) => x.dataset.id)), [id('p2'), id('p1')]);
    await thread.locator(`.parley-pins-item[data-id="${id('p2')}"] .parley-pins-unpin`).click();
    await me.until('one left, back on the bar', async () => /firm wakes only/.test(await thread.locator('.parley-pins-text').innerText()) && (await thread.locator('.parley-pins-more').isVisible()) === false);
    const pins = (await me.api('/api/conversations/pins/talk')).body.pins;
    assert.deepEqual(pins.map((p) => [p.id, p.by]), [[id('p1'), 'person']]);
    assert.deepEqual(me.errors, []);
});
