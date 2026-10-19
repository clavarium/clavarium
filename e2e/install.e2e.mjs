import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('where the browser lets a page ask, "Install the app" appears and asks; once installed it is gone', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('at-hand');
    /* For the owner, it is in Settings, under "This device". */
    await me.page.locator('#nav-settings').click();
    await me.until('Settings are shown', async () => me.page.locator('#settings').isVisible());
    await me.chapter('s-screen');
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
    /* First a name for this device, prefilled with the name of this Clavarium. */
    await me.page.locator('#install').click();
    await me.until('the name step', async () => me.page.locator('#install-name-form').isVisible());
    assert.equal(await me.page.locator('#install-name').inputValue(), 'Clavarium');
    assert.equal(await me.page.evaluate(() => window.prompted), 0, 'not asked yet');
    if (process.env.CLAVARIUM_NAV_SHOTS) {
        await me.page.setViewportSize({ width: 1024, height: 768 });
        await me.page.screenshot({ path: `${process.env.CLAVARIUM_NAV_SHOTS}/tablet-install-name.png` });
    }
    /* Named: the manifest's address carries it, and Chrome's new offer (it read the manifest again) is the one used. */
    await me.page.fill('#install-name', 'Kitchen <b>');
    await me.page.locator('#install-name-form button[type=submit]').click();
    await me.page.evaluate(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        window.fresh = 0;
        event.prompt = () => { window.fresh += 1; };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        dispatchEvent(event);
    });
    await me.until('the browser is asked, with the fresh offer', async () => (await me.page.evaluate(() => window.fresh)) === 1);
    assert.equal(await me.page.evaluate(() => window.prompted), 0);
    const href = await me.page.locator('link[rel=manifest]').getAttribute('href');
    assert.equal(href, `/manifest.webmanifest?name=${encodeURIComponent('Kitchen <b>')}`);
    assert.equal((await me.page.evaluate(async (h) => (await fetch(h)).json(), href)).name, 'Kitchen <b>');
    await me.until('the offer is withdrawn', async () => !(await me.page.locator('#install').isVisible()));
    /* Kept on this device: the next start points at the same manifest. */
    await me.page.reload();
    await me.until('the same manifest after a reload', async () => (await me.page.locator('link[rel=manifest]').getAttribute('href')) === href);
});

test('on a paired Android device: the name step, then the browser; the manifest of the door carries that name', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const owner = await b.person();
    await owner.create('for-mum');
    const shared = await owner.api('/api/conversations/for-mum/share', {});
    const context = await owner.context.browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(shared.body.url);
    await page.locator('#notice-action').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('#notice-action').click();
    await page.evaluate(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        window.prompted = 0;
        event.prompt = () => { window.prompted += 1; };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        dispatchEvent(event);
    });
    await page.locator('#install').click();
    await page.locator('#install-name-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#install-name').inputValue(), 'Clavarium');
    if (process.env.CLAVARIUM_NAV_SHOTS) await page.screenshot({ path: `${process.env.CLAVARIUM_NAV_SHOTS}/phone-install-name.png` });
    await page.fill('#install-name', 'Mum');
    await page.locator('#install-name-form button[type=submit]').click();
    /* No fresh offer comes: the one there was is used, after a moment. */
    await page.waitForFunction(() => window.prompted === 1, null, { timeout: 5000 });
    assert.equal(await page.locator('link[rel=manifest]').getAttribute('href'), '/c/manifest.webmanifest?name=Mum');
    assert.equal((await page.evaluate(async () => (await fetch('/c/manifest.webmanifest?name=Mum')).json())).name, 'Mum');
    assert.equal(await page.title(), 'for-mum - Clavarium');
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
