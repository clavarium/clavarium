/* DEMO: HIT A LIMIT? KEEP WORKING (#404). The most lived reason to change AI (personas, 26-11): Claude Code
 * reaches its usage limit mid-task; in its settings it is changed for Codex, which reads the same chat and
 * carries on; "Back to Claude Code" waits for when the limit resets. The change is made by hand, as today
 * (#406, offering it by itself, is not built). Plan: demos-plan #4. */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tool } from '../stage.mjs';

export default {
    name: 'switch-ai',
    title: 'Switch AI in one setting',
    opening: 'Hit a limit? Keep working.',
    page: 'built-to-last.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code'), tool('codex', 'Codex CLI'), tool('vibe', 'Mistral Vibe')],
    /* What is said, one line a take; the silence before each line (seconds). */
    lines: [
        'Your AI hits its usage limit, mid-task.',
        'Open its settings, and pick another one.',
        'Codex reads the same chat, and carries on.',
        'When the limit resets, switch back.',
        'Clavarium. Changing is easy.',
    ],
    gaps: [0.6, 0.6, 0.6, 0.6, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My app Lys', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'my-app-lys')?.phase === 'ready', 60_000);
        await me.api('/api/conversations/my-app-lys/talk', { on: true });
        const work = join(b.dir, 'kept-work', 'my-app-lys', 'work');
        mkdirSync(work, { recursive: true });
        writeFileSync(join(work, 'checkout.js'), 'export const SESSION_MINUTES = 5;\n');
        const agent = bridge(join(work, '.parley'));
        agent.tell('Found the login bug: the session ended after 5 minutes. The fix is in `checkout.js`.');
        agent.tell('Fixing the session timer now.');
        return { agent };
    },

    async play(f, cue, { b, agent }) {
        const { page, tap, point, spot, badge, reveal, card, uncard, me } = f;
        await page.goto(`${b.origin}/?c=my-app-lys`);
        await page.locator('#view-chat').waitFor();
        /* The app's "what to try next" banner has no place in the film. */
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.locator('#view-chat').click();
        await page.locator('#simple-thread', { hasText: 'Found the login bug' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        agent.tell('Claude usage limit reached. It resets at 3 pm.');
        const limit = page.locator('#simple-thread').getByText('usage limit reached').first();
        await limit.waitFor({ timeout: 15_000 });
        await cue(0);
        await spot(limit, 2400);
        await tap('#folders', 700);
        const generalTab = page.locator('#panel .settings-tabs button:visible', { hasText: 'General' }).first();
        if (await generalTab.count()) await tap(generalTab, 500);
        const general = page.locator('#chapter-general');
        if ((await general.getAttribute('open')) === null) await tap(general.locator('summary'), 500);
        await page.locator('#ai-box').waitFor({ state: 'visible', timeout: 10_000 });
        await reveal('#ai-box');
        await cue(1);
        await spot(page.locator('#ai-box .set-row').first(), 2200);
        await point('#ai-choice', 500);
        await page.selectOption('#ai-choice', 'codex');
        await tap('#ai-go', 400);
        await spot('#ai-said', 2600).catch(() => {});
        await me.until('it runs Codex', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'my-app-lys')?.tool === 'codex', 30_000);
        await tap('#view-chat', 500);
        agent.tell('Read the chat. Picking up the session fix: 60 minutes, tests next.');
        await me.until('Codex answers in the thread', async () => (await page.locator('#simple-thread', { hasText: 'Picking up the session fix' }).count()) > 0, 15_000).catch(async () => { console.log('not shown; thread:', (await page.locator('#simple-thread').innerText()).slice(-300)); });
        await cue(2);
        await spot(page.locator('#simple-thread').getByText('Picking up the session fix').first(), 2400).catch(() => {});
        await sleep(600);
        agent.status('working', 'Running the tests');
        await sleep(900);
        await tap('#folders', 600);
        if (!(await page.locator('#ai-back').isVisible().catch(() => false))) await tap('#folders', 600);
        if (!(await page.locator('#ai-back').isVisible().catch(() => false))) {
            const gTab = page.locator('#panel .settings-tabs button:visible', { hasText: 'General' }).first();
            if (await gTab.count()) await tap(gTab, 400);
        }
        await page.locator('#ai-back').waitFor({ state: 'visible', timeout: 10_000 });
        await reveal('#ai-back');
        await cue(3);
        await spot('#ai-back', 2000);
        await point('#ai-back', 900);
        await cue(4);
        await card('Changing is easy.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
