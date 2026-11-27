/* DEMO: A NEW CONVERSATION, AN AI. A name, the AI chosen among those installed, created; it starts in its own
 * machine and says hello. Plan: demos-plan #2. On the bench the tools are stand-ins; the start is the real one. */
import { join } from 'node:path';
import { tool } from '../stage.mjs';

const NAME = 'Tax papers 2026';
const CONV = 'tax-papers-2026';

export default {
    name: 'new-conversation',
    title: 'A new conversation, an AI',
    opening: 'A new task? A new conversation.',
    page: 'how-to-use-it.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code'), tool('codex', 'Codex CLI'), tool('vibe', 'Mistral Vibe'), tool('opencode', 'OpenCode')],
    lines: [
        'One conversation per task. Give it a name.',
        'Pick the AI you want.',
        'It starts in its own space, kept apart.',
        'And it is ready to work.',
        'Clavarium. One task, one place.',
    ],
    gaps: [0.6, 0.4, 0.5, 0.5, 0.6],

    async seed(b, me, { bridge }) {
        /* Two conversations already there: a list that looks lived in. */
        for (const title of ['My app Lys', 'Family photos']) {
            const made = await me.api('/api/conversations', { title, tool: 'claude-code' });
            if (made.status !== 201) throw new Error(`create: ${made.status}`);
        }
        return { bridge };
    },

    async play(f, cue, { b, bridge }) {
        const { page, tap, spot, badge, card, uncard, me } = f;
        await page.goto(`${b.origin}/`);
        await page.locator('#items .item').first().waitFor({ state: 'attached', timeout: 60_000 });
        await page.evaluate(() => { const app = document.getElementById('app'); if (app?.dataset.list === 'folded' && innerWidth > 700) document.getElementById('fold').click(); });
        await sleep(800);
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        await tap('#new', 700);
        await page.locator('#newconv-name').waitFor({ state: 'visible' });
        await cue(0);
        await page.locator('#newconv-name').click();
        await page.keyboard.type(NAME, { delay: 45 });
        await sleep(300);
        await cue(1);
        await spot('#newconv-tools', 1500);
        await tap(page.locator('#newconv-tools button', { hasText: 'Claude Code' }).first(), 700);
        await tap('#newconv-create', 800);
        await cue(2);
        await f.skip(() => me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === CONV)?.phase === 'ready', 60_000).then(() => me.until('its page is live', async () => (await me.state()) === 'live', 60_000)));
        await me.api(`/api/conversations/${CONV}/talk`, { on: true });
        const agent = bridge(join(b.dir, 'kept-work', CONV, 'work', '.parley'));
        agent.tell('Hello! I am ready. Send me your tax papers, and I will sort them by year and type.');
        if (!(await page.locator('#simple-thread').isVisible().catch(() => false))) await page.evaluate(() => document.getElementById('view-chat')?.click());
        const hello = page.locator('#simple-thread').getByText('I am ready').first();
        await hello.waitFor({ timeout: 20_000 });
        await cue(3);
        await spot(hello, 1800);
        await cue(4);
        await card('One task, one place.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
