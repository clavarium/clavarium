/* NOTHING JUMPS WHILE IT LOADS (14-11): the figures of both Settings -- the whole Clavarium's (its three
   tiles, its curves, its disk and memory with their donut) and a conversation's (its three tiles, its
   Machine chapter's curves) -- are read late on purpose here; meanwhile each area already has its final
   size and says it is being read (bones, « … »), never a figure made up; then what arrives takes the same
   room. Measured as a browser measures it (layout-shift), on a wide screen and a phone, light and dark.
   NO_SHIFT_SHOTS=folder keeps a picture while it loads and once loaded; NO_SHIFT_OLD=1 runs the page as
   it was before this change (HEAD), only to measure it -- nothing is asserted then. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bench, SKIP, wait } from './bench.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD = process.env.NO_SHIFT_OLD === '1';
const SHOTS = process.env.NO_SHIFT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/* What is read late: what both Settings show of the machines. */
const LATE = /\/api\/(server|history|updates|events|boxes|wifi|meshcentral|jobs)(\/|\?|$)/;
const DELAY = 1500;
const head = (file) => spawnSync('git', ['-C', ROOT, 'show', `HEAD:web/${file}`], { encoding: 'utf8' }).stdout;

/* Every layout shift the page saw, with its time; counted whether or not a click came just before. */
const watchShifts = () => {
    window.noShift = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.noShift.push({ v: e.value, t: e.startTime, what: (e.sources ?? []).map((s) => s.node?.id || s.node?.className || s.node?.nodeName).join(',') }); }).observe({ type: 'layout-shift', buffered: true });
};
const since = (page, t0) => page.evaluate((t) => window.noShift.filter((x) => x.t >= t), t0);
const now = (page) => page.evaluate(() => performance.now());
const boxOf = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: Math.round(r.top), h: Math.round(r.height) } : null; }, sel);

test('both Settings keep their size while their figures are read, say they are being read, then fill the same room', { skip: SKIP }, async (t) => {
    const b = await bench(t, { historyEveryMs: 300, serverRoomMs: 100 });
    const first = await b.person();
    await first.create('alpha');
    /* A few looks for the curves and the small lines. */
    await wait(2000);
    const report = [];
    for (const [screen, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
        for (const scheme of ['light', 'dark']) {
            const phone = screen === 'phone';
            const context = await b.browser.newContext({ viewport, colorScheme: scheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
            await context.addInitScript(() => { try { if (localStorage.getItem('clavarium-tab-settings') === null) { localStorage.setItem('clavarium-tab-settings', 'resources'); localStorage.setItem('clavarium-tab-panel', 'resources'); } } catch { /* an opaque page */ } });
            await context.addInitScript((theme) => { try { localStorage.setItem('clavarium-theme', theme); } catch { /* an opaque page */ } }, scheme);
            await context.addInitScript(watchShifts);
            if (OLD) for (const file of ['app.js', 'kit.js', 'style.css']) { const body = head(file); await context.route(`**/${file}`, (route) => route.fulfill({ body, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' })); }
            const me = await b.person({ context, chapters: { machine: true, 's-resources': true } });
            const { page } = me;
            const name = `${OLD ? 'old' : 'new'}-${screen}-${scheme}`;
            /* Once without waiting: the sizes this device remembers (a size, never a figure). */
            const settled = async (scope) => {
                if (OLD) { await wait(DELAY + 1500); return; }
                await me.until(`${scope} has read everything`, async () => (await page.locator(`${scope} [aria-busy="true"]`).count()) === 0, 15_000);
                await wait(400);
            };
            await page.locator('#nav-settings').click();
            await me.until('Settings are shown', async () => page.locator('#settings').isVisible());
            await settled('#settings');
            /* Back to the list, Settings closed (a folded list unfolded), as a person comes to it. */
            const toList = async () => {
                await page.goto(`${b.origin}/`);
                await me.until('the list is shown', async () => {
                    if (await page.locator('#nav-settings').isVisible()) return true;
                    if (await page.locator('#fold').isVisible()) await page.locator('#fold').click().catch(() => {});
                    else if (await page.locator('#back').isVisible()) await page.locator('#back').click().catch(() => {});
                    return false;
                });
            };
            await toList();

            /* THE WHOLE CLAVARIUM'S SETTINGS, read late. */
            await page.route(LATE, async (route) => { await wait(DELAY); await route.continue().catch(() => {}); });
            await wait(300);
            await page.locator('#nav-settings').click();
            await me.until('Settings are shown', async () => page.locator('#settings').isVisible());
            await wait(250);
            const t0 = await now(page);
            const areas = ['#settings-hand', '#settings-tiles', '#settings-nav', '#server-curves', '#server-disks', '#server-memory', '#settings-ch-machines'];
            const before = Object.fromEntries(await Promise.all(areas.map(async (s) => [s, await boxOf(page, s)])));
            if (!OLD) {
                /* While read: the tiles, the curves and the memory say so, with bones; no figure made up. */
                assert.equal(await page.locator('#settings-tiles[aria-busy="true"] .kit-bone').first().isVisible(), true, 'the tiles say they are being read');
                assert.deepEqual(await page.locator('#settings-tiles .tile-n').allInnerTexts(), ['…', '…', '…']);
                assert.equal(await page.locator('#server-curves[aria-busy="true"] .curve').count(), 3, 'the curves keep their room');
                assert.equal(await page.locator('#server-memory[aria-busy="true"] .share-donut.kit-bone').isVisible(), true, 'the donut keeps its room');
                assert.doesNotMatch(await page.locator('#settings-hand').innerText(), /\d+ %/, 'no figure while it is read');
            }
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-settings-loading.png`) });
            await settled('#settings');
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-settings-loaded.png`) });
            const after = Object.fromEntries(await Promise.all(areas.map(async (s) => [s, await boxOf(page, s)])));
            const shifts = await since(page, t0);
            const total = shifts.reduce((a, x) => a + x.v, 0);
            report.push({ name: `${name} settings`, total: Number(total.toFixed(4)), moved: areas.filter((s) => JSON.stringify(before[s]) !== JSON.stringify(after[s])).map((s) => `${s} ${JSON.stringify(before[s])}→${JSON.stringify(after[s])}`), shifts });
            if (!OLD) {
                assert.match((await page.locator('#settings-tiles .tile-n').allInnerTexts()).join(' '), /\d+ %/, 'the figures came');
                assert.ok(total < 0.01, `${name}: Settings shifted by ${total}: ${JSON.stringify(shifts)}`);
                for (const s of ['#settings-tiles', '#settings-nav', '#server-curves']) assert.deepEqual(after[s], before[s], `${name}: ${s} kept its place and size`);
            }

            /* A CONVERSATION'S SETTINGS, read late: its tiles, its curves. */
            await page.unroute(LATE);
            await page.goto(`${b.origin}/?c=alpha`);
            await me.until('alpha is live', async () => (await me.state()) === 'live', 30_000);
            await page.locator('#folders').click();
            await settled('#panel');
            await page.goto(`${b.origin}/?c=alpha`);
            await page.route(LATE, async (route) => { await wait(DELAY); await route.continue().catch(() => {}); });
            await me.until('alpha is live again', async () => (await me.state()) === 'live', 30_000);
            await wait(300);
            const t1 = await now(page);
            await page.locator('#folders').click();
            await me.until('its settings are shown', async () => page.locator('#panel').isVisible());
            await wait(250);
            const parts = ['#panel-tiles', '#panel-hand', '#panel-nav', '#machine-curves', '#chapter-machine'];
            const was = Object.fromEntries(await Promise.all(parts.map(async (s) => [s, await boxOf(page, s)])));
            if (!OLD) {
                assert.equal(await page.locator('#panel-tiles[aria-busy="true"] .kit-bone').first().isVisible(), true, 'its tiles say they are being read');
                assert.equal(await page.locator('#machine-curves[aria-busy="true"] .curve').count(), 3, 'its curves keep their room');
                assert.doesNotMatch(await page.locator('#panel-tiles').innerText(), /\d+ %/, 'no figure while it is read');
            }
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-conversation-loading.png`) });
            await settled('#panel');
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-conversation-loaded.png`) });
            const is = Object.fromEntries(await Promise.all(parts.map(async (s) => [s, await boxOf(page, s)])));
            /* From the click: the panel coming into sight is not a shift; what moves after it is. */
            const moved = (await since(page, t1)).filter((x) => x.t >= t1 + 250);
            const sum = moved.reduce((a, x) => a + x.v, 0);
            report.push({ name: `${name} conversation`, total: Number(sum.toFixed(4)), moved: parts.filter((s) => JSON.stringify(was[s]) !== JSON.stringify(is[s])).map((s) => `${s} ${JSON.stringify(was[s])}→${JSON.stringify(is[s])}`), shifts: moved });
            if (!OLD) {
                assert.match((await page.locator('#panel-tiles .tile-n').allInnerTexts()).join(' '), /\d+ %/, 'its figures came');
                assert.ok(sum < 0.01, `${name}: its settings shifted by ${sum}: ${JSON.stringify(moved)}`);
                for (const s of ['#panel-tiles', '#machine-curves']) assert.deepEqual(is[s], was[s], `${name}: ${s} kept its place and size`);
            }
            assert.deepEqual(me.errors, []);
            await context.close();
        }
    }
    console.log(JSON.stringify(report.map(({ name, total, moved }) => ({ name, total, moved })), null, 1));
});
