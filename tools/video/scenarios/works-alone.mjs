/* DEMO: IT WORKS WITHOUT YOU. Wake-ups: by the clock (weekdays 07:30, the brief), and when something arrives in a
 * folder (an invoice); later, what it did is in the thread. Plan: demos-plan #22. The wake-ups are set in the
 * real screen; what the agent then says is scripted (the agent of the bench is a stand-in). */
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tool, REPO } from '../stage.mjs';

const { state, verbs } = await import(pathToFileURL(join(REPO, 'node_modules/clavarium-docket/server/docket.mjs')).href);

const CONV = 'my-assistant';

export default {
    name: 'works-alone',
    title: 'It works without you',
    opening: 'It keeps working. Even without you.',
    page: 'how-to-use-it.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'Tell your assistant when to wake up.',
        'Every weekday at seven thirty, for your brief.',
        'Or when a new invoice arrives.',
        'Later, what it did is waiting for you.',
        'Clavarium. It keeps working.',
    ],
    gaps: [0.6, 0.4, 0.5, 0.6, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My assistant', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === CONV)?.phase === 'ready', 60_000);
        await me.api(`/api/conversations/${CONV}/talk`, { on: true });
        await me.api('/api/resources', { name: 'invoices' });
        await me.api(`/api/conversations/${CONV}/resources`, { resource: 'invoices', access: 'write' });
        /* Giving it a folder told it "read your setup again" through its docket: a real agent reads, says done,
           and that line stays in its history. The film starts later in its life: that setup line is left out. */
        const docket = join(b.dir, 'kept-work', CONV, 'work', '.docket');
        await me.until('it was told', async () => state(docket).events.some((e) => e.state === 'waiting'), 20_000).catch(() => {});
        for (const e of state(docket).events.filter((x) => x.state === 'waiting')) verbs(docket).done(e.id, 'Read again.');
        for (const file of ['events.jsonl', 'acks.jsonl']) if (existsSync(join(docket, file))) writeFileSync(join(docket, file), '');
        const agent = bridge(join(b.dir, 'kept-work', CONV, 'work', '.parley'));
        agent.tell('Hello! Tell me what to keep an eye on.');
        return { agent };
    },

    async play(f, cue, { b, agent }) {
        const { page, tap, spot, badge, card, uncard, reveal, me } = f;
        await page.goto(`${b.origin}/?c=${CONV}`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        await page.locator('#simple-thread', { hasText: 'Tell me what to keep an eye on' }).first().waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        const open = async () => {
            await tap('#folders', 600);
            const box = page.locator('details.chapter[data-chapter="wakeups"]');
            const [sheet, tab] = await box.evaluate((d) => [d.closest('.sheet')?.id ?? '', d.closest('.settings-group.tab-off')?.dataset.group ?? '']);
            if (tab) await tap(page.locator(`#${sheet} .settings-tabs button[data-group="${tab}"]`), 500);
            if (!(await box.evaluate((d) => d.open))) await tap(box.locator(':scope > summary'), 500);
            await reveal(box);
            if (!(await page.locator('#wakeups-new-box').evaluate((d) => d.open))) await tap('#wakeups-new-box summary', 500);
            await reveal('#wakeups-new');
        };
        await open();
        await cue(0);
        await page.selectOption('#wakeup-kind', 'cron');
        await sleep(400);
        await page.selectOption('#wakeup-often', 'weekdays');
        await page.fill('#wakeup-at', '07:30');
        await page.locator('#wakeup-message').click();
        await page.keyboard.type('Prepare my morning brief from my mail and calendar.', { delay: 18 });
        await cue(1);
        await spot('#wakeups-new', 1500);
        await tap('#wakeups-new button[type=submit]', 600);
        await me.until('it is listed', async () => /By the clock/.test(await page.locator('#wakeups-rows').innerText()));
        await open();
        await page.selectOption('#wakeup-kind', 'arrival');
        await page.selectOption('#wakeup-resource', 'invoices');
        await page.locator('#wakeup-message').fill('');
        await page.locator('#wakeup-message').click();
        await page.keyboard.type('A new invoice arrived: {files}. File it and tell me.', { delay: 18 });
        await cue(2);
        await tap('#wakeups-new button[type=submit]', 600);
        await me.until('both listed', async () => /arrives in invoices/.test(await page.locator('#wakeups-rows').innerText()));
        await reveal('#wakeups-rows');
        await spot('#wakeups-rows', 1600);
        await tap('#view-chat', 600);
        agent.tell('Woken at 07:30. Your brief: 2 meetings today, 3 mails need an answer, nothing urgent.');
        agent.tell('Woken: invoice-0412.pdf arrived in invoices. Filed under November, 240 €.');
        const last = page.locator('#simple-thread').getByText('Filed under November').first();
        await last.waitFor({ timeout: 15_000 });
        await reveal(last);
        await cue(3);
        await spot(page.locator('#simple-thread').getByText('Woken at 07:30').first(), 1300);
        await spot(last, 1400);
        await cue(4);
        await card('It keeps working.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
