import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';
import { todayIn, addDays } from '../server/agenda.mjs';

/* A CALENDAR'S AGENDA (16-11): Settings > Assets, a calendar opened: under who has it, its week -- days, times,
   titles, places, « now » on today; an event opened says its place, link and organiser; next week, Today. On a
   phone too, nothing wider than the screen. The calendar is a connector of this test (Tether's own is proved in
   Tether): it answers calendar.list with events as data. example.com only. */
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const CAL = { id: 'work-calendar', title: 'Agenda — someone@example.com (Microsoft)', kind: 'calendar', connector: 'calendar', config: { provider: 'microsoft', user: 'someone@example.com' } };

test('a calendar asset shows its agenda: its week, an event opened, next week and back; on a phone too', { skip: SKIP }, async (t) => {
    const today = todayIn();
    const reads = [];
    const connector = { run: async (verb, target, a, ctx) => {
        reads.push({ verb, from: a.from, by: ctx.person?.id });
        if (verb !== 'calendar.list') throw new Error(`${verb} is not done here`);
        const at = (n, hm) => `${addDays(today, n)}T${hm}`;
        return { text: 'listed', size: 6, events: [
            { id: 'e1', title: 'Early call', start: at(0, '00:05'), end: at(0, '00:35'), location: 'Room 2', show: 'busy' },
            { id: 'e2', title: 'Team review', start: at(0, '23:30'), end: at(0, '23:55'), organizer: 'lead@example.com', online: 'https://meet.example.com/abc', attendees: 5, show: 'tentative', notes: 'Ordre du jour <img src=x onerror="window.pwned=1"> <script>window.pwned=2</script>\nRejoindre : https://teams.example.com/l/meetup-join/abc' },
            { id: 'e3', title: 'Conference', start: addDays(today, 2), end: addDays(today, 4), allDay: true },
        ] };
    } };
    const b = await bench(t, { tetherTargets: [CAL], tetherConnectors: { calendar: connector } });
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${b.origin}/`);
    await page.locator('#nav-assets').click();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    await page.locator('#assets-rows .as-row[data-asset="connexion:work-calendar"]').click();
    const agenda = page.locator('#assets-detail .as-agenda');
    await me.until('its week', async () => (await agenda.locator('.ag-event').count()) === 4, 20_000);
    assert.equal(await agenda.locator('.ag-day[data-today] .ag-now').count(), 1, 'now, once, on today');
    assert.deepEqual(await agenda.locator('.ag-day[data-today] .ag-title').allInnerTexts(), ['Early call', 'Team review']);
    assert.equal(await agenda.locator('.ag-day').count(), 3, 'today, and the two days of the conference');
    assert.equal(reads.filter((r) => r.verb === 'calendar.list').length, 1, 'one read');
    assert.match(String(reads[0].by), /^person:/, 'a person\'s own read, never an agent\'s');
    /* An event opened: its facts. */
    await agenda.locator('.ag-event', { hasText: 'Team review' }).locator('summary').click();
    const facts = agenda.locator('.ag-event[open] .ag-facts');
    assert.match(await facts.innerText(), /lead@example\.com/);
    assert.equal(await facts.locator('a').first().getAttribute('href'), 'https://meet.example.com/abc');
    /* Its invitation's text: shown as text, nothing in it runs; its web address alone is a link. */
    const notes = facts.locator('.ag-notes');
    assert.match(await notes.innerText(), /<img src=x onerror=/);
    assert.equal(await notes.locator('img, script').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned ?? null), null);
    assert.equal(await notes.locator('a').getAttribute('href'), 'https://teams.example.com/l/meetup-join/abc');
    await shot(page, 'desktop-agenda');
    /* Painted again (Tether's count moved with the read): no second read. */
    await page.waitForTimeout(3000);
    assert.equal(reads.length, 1, 'kept, not read again by a paint');
    assert.equal(await agenda.locator('.ag-event[open]').count(), 1, 'the event stays open');
    /* Next week: read from 7 days on; Today: back. */
    await page.locator('#assets-detail .ag-bar button').nth(2).click();
    await me.until('next week read', async () => reads.length === 2);
    await me.until('no today there', async () => (await agenda.locator('.ag-day[data-today]').count()) === 0);
    await page.locator('#assets-detail .ag-bar button').nth(1).click();
    await me.until('this week again', async () => (await agenda.locator('.ag-day[data-today]').count()) === 1);

    /* A phone, light: the same, nothing wider than the screen. */
    await page.evaluate(() => localStorage.setItem('clavarium-theme', 'light'));
    await page.setViewportSize({ width: 375, height: 760 });
    await page.reload();
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    const row = page.locator('#assets-rows .as-row[data-asset="connexion:work-calendar"]');
    if (await row.isVisible()) await row.click();
    await me.until('its week on a phone', async () => (await page.locator('#assets-detail .as-agenda .ag-event').count()) === 4, 20_000);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    await shot(page, 'phone-agenda-light');
});
