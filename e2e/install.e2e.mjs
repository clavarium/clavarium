import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('where the browser lets a page ask, "Install the app" appears and asks; once installed it is gone', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('at-hand');
    assert.equal(await me.page.locator('#install').isVisible(), false, 'nothing is offered that cannot be done');
    /* What a browser does when the page can be installed. */
    await me.page.evaluate(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        window.prompted = 0;
        event.prompt = () => { window.prompted += 1; };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        dispatchEvent(event);
        window.prevented = event.defaultPrevented;
    });
    assert.equal(await me.page.evaluate(() => window.prevented), true, 'the browser\'s own banner is held back: the button is the way');
    assert.equal(await me.page.locator('#install').isVisible(), true);
    await me.page.locator('#install').click();
    assert.equal(await me.page.evaluate(() => window.prompted), 1);
    await me.until('the offer is withdrawn', async () => !(await me.page.locator('#install').isVisible()));
});

test('on an iPhone no page can ask: the button explains the two taps, and that the app must be paired again', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('for-dad');
    const shared = await owner.api('/api/conversations/for-dad/share', {});
    const context = await owner.context.browser().newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(shared.body.url);
    await page.locator('#notice-action').waitFor({ state: 'visible', timeout: 20_000 });
    assert.match(await page.locator('#notice-text').innerText(), /"Install the app" at the top puts it on this device/);
    await page.locator('#notice-action').click();
    await page.locator('#install').click();
    const said = await page.locator('#notice-text').innerText();
    assert.match(said, /Share button .* "Add to Home Screen"/);
    assert.match(said, /paired again/);
});
