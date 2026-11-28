/* DEMO: QUESTIONS AS BUTTONS. The agent needs a decision; it asks with choices, one is recommended; a tap
 * answers and it goes on. Plan: demos-plan #6. */
import { join } from 'node:path';
import { tool } from '../stage.mjs';

const CONV = 'my-shop-site';
const Q = 'The photos are 8 MB each, and the page loads slowly. What should I do?';
const CHOICES = ['Shrink them to 300 KB', 'Keep them as they are', 'Ask me per photo'];

export default {
    name: 'ask-buttons',
    title: 'Questions as buttons',
    opening: 'Your agent asks. You tap.',
    page: 'parley.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'When your agent needs a decision, it asks.',
        'With the choices as buttons, and its advice.',
        'One tap, and it carries on.',
        'Clavarium. No typing needed.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My shop site', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === CONV)?.phase === 'ready', 60_000);
        await me.api(`/api/conversations/${CONV}/talk`, { on: true });
        const agent = bridge(join(b.dir, 'kept-work', CONV, 'work', '.parley'));
        agent.tell('Adding the 12 new products to the shop page.');
        return { agent };
    },

    async play(f, cue, { b, agent }) {
        const { page, tap, spot, badge, card, uncard, reveal } = f;
        await page.goto(`${b.origin}/?c=${CONV}`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        await page.locator('#simple-thread', { hasText: 'Adding the 12 new products' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        agent.doing('Adding the product photos');
        await sleep(900);
        agent.ask(Q, CHOICES, { recommended: CHOICES[0] });
        const thread = page.locator('#simple-thread');
        const asked = thread.getByText('What should I do?').first();
        await asked.waitFor({ timeout: 15_000 });
        await reveal(asked);
        await cue(0);
        await spot(asked, 1800);
        const pick = thread.locator('button').filter({ hasText: CHOICES[0] }).first();
        await reveal(pick);
        await cue(1);
        await spot(pick.locator('xpath=..'), 2000);
        await tap(pick, 700);
        agent.read();
        agent.doing('Shrinking 12 photos');
        await sleep(1200);
        agent.tell('Done: 12 photos, 96 MB down to 3.4 MB. The page loads in under a second.');
        const done = thread.getByText('96 MB down to 3.4 MB').first();
        await done.waitFor({ timeout: 15_000 });
        await reveal(done);
        await cue(2);
        await spot(done, 1800);
        await cue(3);
        await card('No typing needed.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
