/* DEMO: GIVE, THEN TAKE BACK. An assistant is given a folder (read), a mailbox (propose) and a key (use); the
 * key is taken back in one gesture. Plan: demos-plan #11 (from the film desktop-assets). */
import { tool } from '../stage.mjs';

const MAILBOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'sam@example.com', host: 'mail.example.com', port: 993, smtpHost: 'mail.example.com', smtpPort: 587 } };
const mailConnector = { run: async (verb) => {
    if (verb === 'mail.send') return { text: 'Sent.', size: 5 };
    if (verb === 'mail.list' || verb === 'mail.search') return { text: 'listed', size: 6, messages: [] };
    throw new Error(`${verb} is not done here`);
} };

export default {
    name: 'give-take-back',
    title: 'Give, then take back',
    opening: 'You decide what each AI can touch.',
    page: 'assets-and-keys.html',
    formats: ['desk', 'phone'],
    tools: [tool('codex', 'Codex CLI')],
    bench: { tetherTargets: [MAILBOX], tetherConnectors: { mail: mailConnector } },
    lines: [
        'Give your assistant a folder, to read only.',
        'Your mailbox: it may propose, you send.',
        'And a key, just for this job.',
        'Done? Take it back, in one tap.',
        'Clavarium. Your rules.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.7, 0.6],

    async seed(b, me) {
        const made = await me.api('/api/conversations', { title: 'My work assistant', tool: 'codex' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'my-work-assistant')?.phase === 'ready', 60_000);
        await me.api('/api/resources', { name: 'client-files' });
        await me.api('/api/secrets', { name: 'BOOKING_KEY', value: 'demo-value-not-a-real-key' });
        return {};
    },

    async play(f, cue, { b }) {
        const { page, tap, spot, badge, card, uncard, me } = f;
        await page.goto(`${b.origin}/?c=my-work-assistant`);
        await page.locator('#view-assets').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-assets').click());
        await page.locator('#cassets-attach').waitFor({ state: 'visible', timeout: 30_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        const give = async (name, right, line) => {
            /* On a phone the picker stays open after a give: the next one is chosen in it directly. */
            if (await page.locator('#cassets-attach').isVisible().catch(() => false)) await tap('#cassets-attach', 400);
            await tap(page.locator('#cassets-detail .kit-aspick-row', { hasText: name }).first(), 400);
            const bar = page.locator('#cassets-detail .kit-aspick-give');
            await cue(line);
            await tap(bar.locator('.kit-rights-pick button', { hasText: right }).first(), 400);
            await tap(bar.locator('.kit-aspick-go'), 600);
            /* Given: in the list (computer), or gone from the picker that stays open (phone). */
            await me.until(`${name} is given`, async () => (await page.locator('#cassets-rows .as-row:visible', { hasText: name }).count()) > 0 || (await page.locator('#cassets-detail .kit-aspick-row', { hasText: name }).count()) === 0);
            const row = page.locator('#cassets-rows .as-row', { hasText: name }).first();
            if (await row.isVisible().catch(() => false)) await spot(row, 1400); else await sleep(900);
        };
        await give('client-files', 'Read', 0);
        await give('Work mailbox', 'Propose', 1);
        await give('BOOKING_KEY', 'Use', 2);
        await sleep(600);
        const back = page.locator('button:visible', { hasText: /^‹ Assets/ }).first();
        if (await back.count()) await tap(back, 600);
        const key = page.locator('#cassets-rows .as-row', { hasText: 'BOOKING_KEY' }).first();
        await tap(key, 800);
        const none = page.locator('#cassets-detail .kit-access-here .kit-rights-pick button', { hasText: 'None' }).first();
        await none.waitFor({ state: 'visible', timeout: 10_000 });
        await cue(3);
        await tap(none, 600);
        const sure = page.getByRole('button', { name: /^(Take back|Remove|Yes|Confirm)/ }).first();
        if (await sure.isVisible().catch(() => false)) await tap(sure, 500);
        await me.until('the key is taken back', async () => (await page.locator('#cassets-rows .as-row', { hasText: 'BOOKING_KEY' }).count()) === 0);
        await sleep(1200);
        await cue(4);
        await card('Your rules.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
