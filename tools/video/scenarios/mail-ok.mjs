/* DEMO: NOTHING LEAVES WITHOUT YOUR OK. An assistant drafts a reminder to a client; the mail waits in the thread
 * with Send and Cancel; sent once approved. Plan: demos-plan #12 (from the film desktop-approval). */
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tool } from '../stage.mjs';

const MAILBOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'sam@example.com', host: 'mail.example.com', port: 993, smtpHost: 'mail.example.com', smtpPort: 587 } };
/* The mailbox of the film: it answers, and sends nothing. */
const mailConnector = { run: async (verb) => {
    if (verb === 'mail.send') return { text: 'Sent.', size: 5 };
    if (verb === 'mail.list' || verb === 'mail.search') return { text: 'listed', size: 6, messages: [] };
    throw new Error(`${verb} is not done here`);
} };

export default {
    name: 'mail-ok',
    title: 'A mail waits for your OK',
    opening: 'Nothing leaves without your OK.',
    page: 'security.html',
    formats: ['desk', 'phone'],
    tools: [tool('codex', 'Codex CLI')],
    bench: { tetherTargets: [MAILBOX], tetherConnectors: { mail: mailConnector } },
    lines: [
        'Your assistant drafts a reminder to a client.',
        'Before anything is sent, you see it.',
        'Send it, or not. You decide.',
        'Clavarium. Your rules.',
    ],
    gaps: [0.6, 0.6, 0.6, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My work assistant', tool: 'codex' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'my-work-assistant')?.phase === 'ready', 60_000);
        await me.api('/api/conversations/my-work-assistant/talk', { on: true });
        await me.api('/api/tether/level', { target: 'work-mail', agent: 'conversation:my-work-assistant', level: 'propose' });
        const work = join(b.dir, 'kept-work', 'my-work-assistant', 'work');
        mkdirSync(join(work, '.tether'), { recursive: true });
        const agent = bridge(join(work, '.parley'));
        agent.tell('3 invoices are unpaid for more than 30 days.');
        agent.ask('Send the 3 reminders?', ['Yes, send them', 'Not yet']);
        return { agent, side: join(work, '.tether') };
    },

    async play(f, cue, { b, agent, side }) {
        const { page, tap, spot, badge, card, uncard, me } = f;
        await page.goto(`${b.origin}/?c=my-work-assistant`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.locator('#view-chat').click();
        await page.locator('#simple-thread', { hasText: '3 invoices are unpaid' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        await tap(page.locator('#simple-thread button').filter({ hasText: 'Yes, send them' }).first(), 700);
        agent.read();
        agent.doing('Drafting the reminder to Harbor Print');
        await cue(0);
        await sleep(1500);
        appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'film-1', op: 'mail.send', args: { target: 'work-mail', to: 'accounts@harborprint.example.com', subject: 'Invoice 2026-114: a friendly reminder', body: 'Hello,\nOur invoice 2026-114 of 14 October is still open.\nCould you confirm the payment date?\nThank you,\nSam', why: 'you asked me to remind unpaid clients' }, at: new Date().toISOString() })}\n`);
        const request = page.locator('#simple-thread .parley-request').first();
        await me.until('the request is in the thread', async () => (await request.count()) > 0, 30_000);
        await request.scrollIntoViewIfNeeded();
        if ((await request.locator('.parley-request-head').getAttribute('aria-expanded')) !== 'true') await tap(request.locator('.parley-request-head'), 600);
        await cue(1);
        await spot(request, 2600);
        await cue(2);
        await tap(request.locator('.parley-request-yes'), 600);
        await me.until('Tether has the decision', async () => ((await me.api('/api/tether')).body.approvals ?? []).length === 0, 20_000);
        agent.tell('Sent to Harbor Print. Two reminders left.');
        await page.locator('#simple-thread', { hasText: 'Sent to Harbor Print' }).first().waitFor({ timeout: 15_000 }).catch(() => {});
        await sleep(900);
        await cue(3);
        await card('Your rules.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
