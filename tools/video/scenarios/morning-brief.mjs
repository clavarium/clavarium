/* DEMO: THE MORNING BRIEF. An assistant that reads the mail and the calendar prepares the day: what is due,
 * what waits for a reply, what it already did; then a question with buttons. Plan: demos-plan #31 (the film
 * demo-brief). The brief's text is the site's (tools/site/brief.mjs), invented from end to end. */
import { join } from 'node:path';
import { tool, REPO } from '../stage.mjs';
import { pathToFileURL } from 'node:url';

const { BRIEF, QUESTION } = await import(pathToFileURL(join(REPO, 'tools/site/brief.mjs')).href);

export default {
    name: 'morning-brief',
    title: 'The morning brief',
    opening: 'Your day, ready before you are.',
    page: 'mail-and-calendar.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'Every morning, your assistant reads your mail and your calendar.',
        'It tells you what is due, and what waits for a reply.',
        'And what it already handled for you.',
        'One question? Answer with a tap.',
        'Clavarium. Your day, your rules.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.6, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My personal assistant', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'my-personal-assistant')?.phase === 'ready', 60_000);
        await me.api('/api/conversations/my-personal-assistant/talk', { on: true });
        const agent = bridge(join(b.dir, 'kept-work', 'my-personal-assistant', 'work', '.parley'));
        agent.tell('Good morning. Reading your mail and calendar.');
        return { agent };
    },

    async play(f, cue, { b, agent }) {
        const { page, tap, spot, badge, card, uncard, reveal } = f;
        await page.goto(`${b.origin}/?c=my-personal-assistant`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        await page.locator('#simple-thread', { hasText: 'Good morning' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        agent.doing('Reading 23 mails and today\'s calendar');
        await cue(0);
        await sleep(1800);
        agent.tell(BRIEF);
        const thread = page.locator('#simple-thread');
        await thread.getByText('To handle').first().waitFor({ timeout: 15_000 });
        await reveal(thread.getByText('To handle').first());
        await cue(1);
        await spot(thread.getByText('To handle').first(), 1800);
        await reveal(thread.getByText('Waiting for replies').first());
        await sleep(900);
        await reveal(thread.getByText('Done since 10:40').first());
        await cue(2);
        await spot(thread.getByText('Done since 10:40').first(), 1800);
        agent.ask(QUESTION[0], QUESTION[1]);
        const choice = thread.locator('button').filter({ hasText: QUESTION[1][1] }).first();
        await choice.waitFor({ timeout: 15_000 });
        await reveal(choice);
        await cue(3);
        await tap(choice, 700);
        agent.read();
        agent.tell('Done: the 3 receipts are with your accountant.');
        await thread.getByText('the 3 receipts are with your accountant').first().waitFor({ timeout: 15_000 }).catch(() => {});
        await sleep(900);
        await cue(4);
        await card('Your day, your rules.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
