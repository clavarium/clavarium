/* DEMO: IT USES YOUR BROWSER, AND ASKS BEFORE IT COMMITS. The assistant books a table in the person's own
 * browser (through the Tether extension): it reads and fills the form; the click that books waits in the thread
 * with Accept, Refuse and, behind "...", Always. Plan: demos-plan #13. The extension is a stand-in that speaks
 * its protocol (as e2e/browser.e2e.mjs does); the request, its card and the decision are the real server's. */
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tool, REPO } from '../stage.mjs';

const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');
const CONV = 'my-assistant';
const BOOKING = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px system-ui,sans-serif;background:#fff;color:#222}
header{background:#7a2e1f;color:#fff;padding:14px 20px;font-weight:700}main{padding:18px 20px}label{display:block;margin:10px 0 4px;color:#555;font-size:14px}
.f{border:1px solid #bbb;border-radius:6px;padding:8px 10px}button{margin-top:16px;background:#7a2e1f;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-weight:700}
small{display:block;margin-top:10px;color:#888}</style></head><body><header>Little Bistro · bookings.example.com</header><main>
<label>People</label><div class="f">4</div><label>Day</label><div class="f">Friday</div><label>Time</label><div class="f">20:00</div>
<button>Confirm booking</button><small>Demo page</small></main></body></html>`;

export default {
    name: 'browser',
    title: 'It uses your browser, and asks',
    opening: 'It uses your browser. It asks first.',
    page: 'tether.html',
    formats: ['desk', 'phone'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'Your assistant books a table, in your own browser.',
        'It fills in the form, and shows you.',
        'The click that commits waits for you.',
        'Accept, refuse, or always allow this site.',
        'Clavarium. It asks before it commits.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.3, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My assistant', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === CONV)?.phase === 'ready', 60_000);
        await me.api(`/api/conversations/${CONV}/talk`, { on: true });
        /* The person's browser, paired: the stand-in extension claims the key the page would show once. */
        const offer = (await me.api('/api/tether/browser-offer', { name: 'My browser' })).body;
        const ws = new WebSocket(`${b.origin.replace(/^http/, 'ws')}/c/api/browser`);
        const got = [];
        ws.on('message', (d) => { const m = JSON.parse(String(d)); got.push(m); if (m.t === 'call') ws.send(JSON.stringify({ t: 'result', id: m.id, ok: true, text: 'clicked' })); });
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        ws.send(JSON.stringify({ t: 'hello' })); ws.send(JSON.stringify({ t: 'claim', key: offer.key }));
        await me.until('paired', async () => got.some((m) => m.t === 'paired'), 15_000);
        ws.send(JSON.stringify({ t: 'tabs', tabs: [{ id: 7, url: 'https://bookings.example.com/little-bistro', title: 'Little Bistro', site: 'bookings.example.com' }] }));
        const target = await (async () => { let id = null; await me.until('the browser is a target', async () => { id = (await me.api('/api/tether')).body.targets.find((x) => x.kind === 'browser')?.id; return Boolean(id); }, 15_000); return id; })();
        await me.api('/api/tether/level', { target, agent: `conversation:${CONV}`, level: 'propose' });
        /* What the agent shows: the form filled in, a picture of the demo page. */
        const work = join(b.dir, 'kept-work', CONV, 'work');
        const shot = await b.browser.newPage({ viewport: { width: 420, height: 380 } });
        await shot.setContent(BOOKING); await shot.screenshot({ path: join(work, 'booking.png') }); await shot.close();
        mkdirSync(join(work, '.tether'), { recursive: true });
        const agent = bridge(join(work, '.parley'));
        return { agent, ws, target, work };
    },

    async play(f, cue, { b, agent, ws, target, work }) {
        const { page, tap, spot, badge, card, uncard, reveal, me } = f;
        await page.goto(`${b.origin}/?c=${CONV}`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        const thread = page.locator('#simple-thread');
        const box = thread.locator('textarea.parley-box').first();
        await box.waitFor({ timeout: 60_000 });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        await tap(box, 400);
        await page.keyboard.type('Book a table for 4 at Little Bistro, Friday at 8 pm.', { delay: 24 });
        if (f.mobile) await tap(thread.locator('button.parley-send').first(), 500); else await page.keyboard.press('Enter');
        await thread.getByText('Little Bistro, Friday').first().waitFor({ timeout: 15_000 });
        agent.read();
        agent.doing('Opening bookings.example.com in your browser');
        await cue(0);
        await sleep(1200);
        agent.doing('Filling in: 4 people, Friday, 20:00');
        await sleep(1200);
        /* Shown as its tool would: the path as its machine sees it (/work/...), written as the bridge writes it. */
        appendFileSync(join(work, '.parley', 'from-agent.jsonl'), `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), kind: 'show', path: '/work/booking.png', text: 'The form, filled in. One click left: Confirm.' })}\n`);
        const pic = thread.locator('img').last();
        await pic.waitFor({ timeout: 15_000 }).catch(() => {});
        await reveal(pic);
        await cue(1);
        await spot(pic, 1600).catch(() => {});
        appendFileSync(join(work, '.tether', 'asks.jsonl'), `${JSON.stringify({ id: 'film-click', op: 'browser.click', args: { target, tab: 7, selector: 'button', why: 'to confirm the booking you asked for' }, at: new Date().toISOString() })}\n`);
        const request = thread.locator('.parley-request').first();
        await me.until('the click waits in the thread', async () => (await request.count()) > 0, 30_000);
        await reveal(request);
        await cue(2);
        await spot(request, 1800);
        const dots = request.locator('.parley-request-dots');
        if (await dots.count()) await tap(dots, 700);
        await cue(3);
        if (await dots.count()) await spot(request.locator('.parley-request-acts'), 1400);
        await tap(request.locator('.parley-request-yes'), 700);
        await me.until('Tether has the decision', async () => ((await me.api('/api/tether')).body.approvals ?? []).length === 0, 20_000).catch(() => {});
        agent.tell('Booked: Friday 20:00, 4 people. The confirmation mail is on its way.');
        const done = thread.getByText('Booked: Friday 20:00').first();
        await done.waitFor({ timeout: 15_000 });
        await reveal(done);
        await spot(done, 1400);
        await cue(4);
        await card('It asks before it commits.', { sub: 'clavarium.org' });
        ws.terminate();
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
