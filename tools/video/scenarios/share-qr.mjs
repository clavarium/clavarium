/* DEMO: SHARE BY QR CODE. One conversation shared with another device: a code to scan, the other screen sees
 * that conversation and nothing else; taken back in two taps, and the other screen says so. Plan: demos-plan
 * #30. Two screens: the owner's, and the shared device in the corner (f.inset). */
import { join } from 'node:path';
import { tool } from '../stage.mjs';

const CONV = 'family';
const DEVICE = "Grandma's tablet";

export default {
    name: 'share-qr',
    title: 'Share by QR code',
    opening: 'Share one conversation. Only that one.',
    page: 'family.html',
    formats: ['desk'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'Share one conversation, with a QR code.',
        'The other device sees this conversation. Nothing else.',
        'Changed your mind? Take it back, in two taps.',
        'Clavarium. Shared, and revocable.',
    ],
    gaps: [0.6, 0.5, 0.6, 0.6],

    async seed(b, me, { bridge }) {
        for (const [title, name] of [['Family', CONV], ['My work', 'my-work']]) {
            const made = await me.api('/api/conversations', { title, tool: 'claude-code' });
            if (made.status !== 201) throw new Error(`create: ${made.status}`);
            await me.until(`${name} is ready`, async () => (await me.api('/api/conversations')).body.find((c) => c.name === name)?.phase === 'ready', 60_000);
            await me.api(`/api/conversations/${name}/talk`, { on: true });
        }
        const agent = bridge(join(b.dir, 'kept-work', CONV, 'work', '.parley'));
        agent.tell('Sunday lunch: 9 people. I listed who brings what; the shopping list is ready.');
        return { agent };
    },

    async play(f, cue, { b, agent }) {
        const { page, tap, spot, badge, card, uncard, reveal, me } = f;
        await page.goto(`${b.origin}/?c=${CONV}`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        await page.locator('#simple-thread', { hasText: 'Sunday lunch' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        await tap('#folders', 600);
        const box = page.locator('details.chapter[data-chapter="sharing"]');
        const [sheet, tab] = await box.evaluate((d) => [d.closest('.sheet')?.id ?? '', d.closest('.settings-group.tab-off')?.dataset.group ?? '']);
        if (tab) await tap(page.locator(`#${sheet} .settings-tabs button[data-group="${tab}"]`), 500);
        if (!(await box.evaluate((d) => d.open))) await tap(box.locator(':scope > summary'), 500);
        await tap('#share', 700);
        await me.until('the basket holds the conversation', async () => (await page.locator('#share-basket .folder').count()) === 1);
        await page.locator('#sharing-label').click();
        await page.keyboard.type(DEVICE, { delay: 40 });
        await tap('#sharing-new', 700);
        await page.locator('#sharing-qr').waitFor({ state: 'visible', timeout: 15_000 });
        await cue(0);
        await spot('#sharing-qr', 2000);
        const url = await page.locator('#sharing-link').innerText();
        const tablet = await f.inset('phone', url.replace(/^https?:\/\/[^/]+/, ''));
        await tablet.page.locator('#notice-action', { hasText: 'Start' }).waitFor({ timeout: 30_000 });
        await sleep(1200);
        await tablet.tap(tablet.page.locator('#notice-action', { hasText: 'Start' }), 600);
        await tap('#sharing-close', 500).catch(() => {});
        await tablet.page.locator('#simple-thread', { hasText: 'Sunday lunch' }).first().waitFor({ timeout: 30_000 }).catch(() => {});
        await cue(1);
        await sleep(2600);
        /* Taken back: its card on the map of Access. */
        await page.evaluate(() => { const app = document.getElementById('app'); if (app?.dataset.list === 'folded' && innerWidth > 700) document.getElementById('fold').click(); });
        await tap('#nav-access', 700);
        const node = page.locator('#links .lk-node[data-id^="device:"]', { hasText: DEVICE }).first();
        await me.until('the tablet is on the map', async () => (await node.count()) === 1);
        const shown = async () => (await page.locator('#links-card .device-panel', { hasText: DEVICE }).count()) === 1 && page.locator('#links-card').isVisible();
        if (!(await shown())) await tap(node, 700);
        await me.until('its card', shown);
        await cue(2);
        await tap(page.locator('#links-card .device-panel button', { hasText: 'Revoke device' }), 700);
        await tap('#links-card button.danger', 700);
        await me.until('no device left', async () => (await page.locator('#links .lk-node[data-id^="device:"]').count()) === 0);
        /* The other screen learns it within seconds: that wait is taken out of the film. */
        await f.skip(() => tablet.page.locator('#notice-text', { hasText: 'this device was removed' }).waitFor({ state: 'visible', timeout: 60_000 }));
        await sleep(2200);
        await cue(3);
        await card('Shared, and revocable.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
