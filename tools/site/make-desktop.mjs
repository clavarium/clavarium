#!/usr/bin/env node
/* DESKTOP FILMS OF THE REAL CLAVARIUM WEB APP (1280x800), what a chatbot does not have.
 *
 *   PLAYWRIGHT=/path/to/playwright-core/index.mjs node tools/site/make-desktop.mjs [name ...]
 *
 * Env: PLAYWRIGHT (required), CLAVARIUM_REPO (default this repository), OUT (default docs/preview/shots).
 * Films: overview, machine, assets, approval. Output: shots/desktop-<name>.webm + -poster.png
 *
 * What is real: the server, the page, its API, tmux terminals, files, rights, Parley and Tether, on the
 * repository's own end-to-end bench (e2e/bench.mjs). No VM is started.
 * What is a stand-in, as on that bench: the VM manager (a "machine" is a folder, its gauges are the
 * stand-in's), the agents (a plain shell under the label of each tool; their words are posted through
 * Parley's own agent bridge) and the mailbox (a connector that answers here and sends nothing).
 * The round pointer and the closing line are added over the page for the film.
 * Invented names, example.com only.
 */
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.CLAVARIUM_REPO || join(HERE, '..', '..'));
const OUT = resolve(process.env.OUT || join(HERE, '..', '..', 'docs', 'preview', 'shots'));
if (!process.env.PLAYWRIGHT) { console.error('Set PLAYWRIGHT to the path of playwright-core/index.mjs'); process.exit(2); }
process.env.CLAVARIUM_E2E_PLAYWRIGHT = dirname(resolve(process.env.PLAYWRIGHT));
const load = (path) => import(pathToFileURL(join(REPO, path)).href);
const { bench, SKIP } = await load('e2e/bench.mjs');
const { bridge } = await load('node_modules/clavarium-parley/server/parley-mcp.mjs');
if (SKIP) { console.error(`The bench cannot run: ${SKIP}`); process.exit(2); }

const VIEW = { width: 1280, height: 800 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (id, label) => ({ id, label, command: ['env', 'PS1=agent@work:/work$ ', 'bash', '--norc', '--noprofile'], memoryMb: 2048, install: [['true']] });
const TOOLS = [tool('claude-code', 'Claude Code'), tool('codex', 'Codex CLI'), tool('opencode', 'OpenCode'), tool('vibe', 'Mistral Vibe')];
const TEAM = [['Archive search', 'claude-code'], ['Newsletter', 'opencode'], ['Client data', 'vibe'], ['Invoices', 'codex'], ['Shop site', 'claude-code']];
const MAILBOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'sam@example.com', host: 'mail.example.com', port: 993, smtpHost: 'mail.example.com', smtpPort: 587 } };
/* The mailbox of the film: it answers, and sends nothing. */
const mailConnector = { run: async (verb) => {
    if (verb === 'mail.send') return { text: 'Sent.', size: 5 };
    if (verb === 'mail.list' || verb === 'mail.search') return { text: 'listed', size: 6, messages: [] };
    throw new Error(`${verb} is not done here`);
} };

const parleyDir = (b, name) => join(b.dir, 'kept-work', name, 'work', '.parley');

async function seed(b, me) {
    for (const [title, id] of TEAM) {
        const made = await me.api('/api/conversations', { title, tool: id });
        if (made.status !== 201) throw new Error(`${title}: ${made.status}`);
    }
    await me.until('the team is ready', async () => (await me.api('/api/conversations')).body.filter((c) => c.phase === 'ready').length === TEAM.length, 60_000);
    for (const [title] of TEAM) await me.api(`/api/conversations/${title.toLowerCase().replace(/ /g, '-')}/talk`, { on: true });
    const agents = Object.fromEntries(TEAM.map(([title]) => { const name = title.toLowerCase().replace(/ /g, '-'); return [name, bridge(parleyDir(b, name))]; }));
    agents.newsletter.tell('November issue drafted: 4 articles, ready for you to read.');
    agents['client-data'].tell('Summary of the 12 interviews is in `summary.md`.');
    agents['client-data'].status('working', 'Removing names from the interviews');
    agents.invoices.tell('3 invoices are unpaid for more than 30 days.');
    agents.invoices.ask('Send the 3 reminders?', ['Yes, send them', 'Not yet']);
    agents['shop-site'].tell('Found the login bug: the session ended after 5 minutes.');
    agents['shop-site'].status('working', 'Running the tests');
    agents['archive-search'].tell('The 2019 contracts are indexed.');
    await me.api('/api/conversations/archive-search/sleep', {});
    await me.until('one is asleep', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'archive-search')?.stopped !== false, 8000).catch(() => {});
    /* The app's "what to try next" banner has no place in the film. */
    await me.page.goto(`${b.origin}/`);
    const x = me.page.locator('.ft-x').first();
    await x.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    if (await x.count()) await x.click().catch(() => {});
    await sleep(500);
    return agents;
}

/* A person whose page is filmed: a visible pointer, a pulse on each click, the closing line. */
async function filmed(b, vids, at) {
    const context = await b.browser.newContext({ viewport: VIEW, colorScheme: 'dark', locale: 'en-GB', recordVideo: { dir: vids, size: VIEW } });
    await context.addInitScript(() => {
        addEventListener('DOMContentLoaded', () => {
            const c = document.createElement('div'); c.id = 'film-pointer';
            c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.35);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.6);z-index:2147483647;pointer-events:none;transition:transform .15s';
            document.documentElement.append(c);
            addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
            addEventListener('mousedown', () => { c.style.transform = 'scale(.65)'; }, true);
            addEventListener('mouseup', () => { c.style.transform = ''; }, true);
        });
    });
    const me = await b.person({ context, at });
    const page = me.page;
    await page.mouse.move(640, 420);
    const tap = async (target, wait = 900) => {
        const l = typeof target === 'string' ? page.locator(target).first() : target;
        await l.waitFor({ state: 'visible', timeout: 15_000 });
        await l.scrollIntoViewIfNeeded().catch(() => {});
        const box = await l.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
        await sleep(280);
        await page.mouse.down(); await sleep(70); await page.mouse.up();
        await sleep(wait);
    };
    const closing = async (text, ms = 3200) => {
        await page.evaluate((t) => {
            const d = document.createElement('div');
            d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#f7f6f2;color:#1d1d1b;font:700 44px/1.2 system-ui,sans-serif;text-align:center;padding:40px;z-index:2147483646;opacity:0;transition:opacity .45s';
            const inner = document.createElement('div'); inner.textContent = t;
            const s = document.createElement('small'); s.textContent = 'clavarium.org'; s.style.cssText = 'display:block;font:600 18px system-ui,sans-serif;color:#2f6f5e;margin-top:18px';
            inner.append(s); d.append(inner); document.body.append(d); requestAnimationFrame(() => { d.style.opacity = '1'; });
            document.getElementById('film-pointer')?.remove();
        }, text);
        await sleep(ms);
    };
    /* A line the bench alone says (it has no tools archive): not something a real install shows. */
    const noBenchLine = () => page.evaluate(() => {
        for (const e of document.querySelectorAll('p, small, div, span')) if (e.children.length === 0 && /tools folder \(\/tools\) is not in place/.test(e.textContent)) e.style.visibility = 'hidden';
    });
    /* The list of conversations, opened with its own button if it is folded. */
    const list = async () => {
        if (await page.evaluate(() => document.getElementById('app')?.dataset.list !== 'folded')) return;
        await tap(page.locator('.topbar-fold:visible').first(), 500);
        await me.until('the list is open', () => page.evaluate(() => document.getElementById('app')?.dataset.list === 'open'), 5000);
    };
    return { me, page, tap, closing, noBenchLine, list };
}

const FILMS = {
    async overview(b, f, agents) {
        const { page, tap, closing, list } = f;
        await page.goto(`${b.origin}/`);
        await page.locator('#desk > .desk-tile').first().waitFor();
        await sleep(1000);
        /* The list, kept open beside whatever is shown: who works, who waits, who sleeps. */
        await list();
        await tap(page.locator('#list-pin'), 500);
        await f.poster();
        await sleep(1400);
        agents['shop-site'].tell('Login fixed. 42 tests pass.');
        await sleep(1700);
        await tap(page.locator('#list .item[data-name="invoices"]:visible').first(), 2300);
        agents['client-data'].doing('Removing names from the interviews');
        await tap(page.locator('#list .item[data-name="client-data"]:visible').first(), 2400);
        agents['shop-site'].doing('Writing the release notes');
        await tap(page.locator('#list .item[data-name="shop-site"]:visible').first(), 2400);
        await tap('#nav-home', 2000);
        await closing('A team of agents, on your server.', 2800);
    },
    async machine(b, f, agents) {
        const { page, tap, closing, me, noBenchLine } = f;
        writeFileSync(join(b.dir, 'kept-work', 'shop-site', 'work', 'checkout.js'), 'export const SESSION_MINUTES = 60;\nexport const cart = (items) => items.length;\n');
        writeFileSync(join(b.dir, 'kept-work', 'shop-site', 'work', 'notes.md'), '# Shop site\nLogin: session was 5 min, now 60.\n');
        await page.goto(`${b.origin}/?c=shop-site`);
        await page.locator('#view-chat').waitFor();
        await page.locator('#view-chat').click();
        await sleep(1800);
        await tap('#view-terminal', 700);
        await page.locator('#terminal').click();
        for (const line of ['clear', 'ls', 'cat notes.md', 'grep -n SESSION checkout.js']) {
            await page.keyboard.type(line, { delay: 55 }); await page.keyboard.press('Enter'); await sleep(line === 'clear' ? 300 : 1200);
        }
        await f.poster();
        await sleep(900);
        await tap('#view-assets', 700);
        await tap(page.locator('#cassets-rows .as-row[data-name="work"]').first(), 2000);
        await tap('#folders', 700);
        await noBenchLine();
        await sleep(2000);
        const offline = page.getByRole('button', { name: 'Offline', exact: true }).first();
        await tap(offline, 400);
        await me.until('it is offline', async () => (await offline.getAttribute('aria-pressed')) === 'true', 8000);
        await noBenchLine();
        await sleep(1400);
        const online = page.getByRole('button', { name: 'Online', exact: true }).first();
        await tap(online, 400);
        await me.until('it is online again', async () => (await online.getAttribute('aria-pressed')) === 'true', 8000);
        await sleep(700);
        await closing('Each agent has its own computer.');
        void me; void agents;
    },
    async assets(b, f) {
        const { page, tap, closing, me } = f;
        await page.goto(`${b.origin}/?c=invoices`);
        await page.locator('#view-assets').waitFor();
        await tap('#view-assets', 900);
        const give = async (name, right) => {
            await tap('#cassets-attach', 450);
            await tap(page.locator('#cassets-detail .kit-aspick-row', { hasText: name }).first(), 450);
            const bar = page.locator('#cassets-detail .kit-aspick-give');
            await tap(bar.locator('.kit-rights-pick button', { hasText: right }).first(), 400);
            await tap(bar.locator('.kit-aspick-go'), 800);
            await me.until(`${name} is given`, async () => (await page.locator('#cassets-rows .as-row', { hasText: name }).count()) > 0);
        };
        await give('client-files', 'Read');
        await give('Work mailbox', 'Propose');
        await give('BOOKING_KEY', 'Use');
        await f.poster();
        await sleep(900);
        /* Taken back. */
        await tap(page.locator('#cassets-rows .as-row', { hasText: 'BOOKING_KEY' }).first(), 1000);
        await tap(page.locator('#cassets-detail .kit-access-here .kit-rights-pick button', { hasText: 'None' }).first(), 600);
        const sure = page.getByRole('button', { name: /^(Take back|Remove|Yes|Confirm)/ }).first();
        if (await sure.isVisible().catch(() => false)) await tap(sure, 500);
        await me.until('the key is taken back', async () => (await page.locator('#cassets-rows .as-row', { hasText: 'BOOKING_KEY' }).count()) === 0);
        await sleep(1700);
        await closing('You decide what each agent can touch.');
    },
    async approval(b, f, agents) {
        const { page, tap, closing, me } = f;
        const side = join(b.dir, 'kept-work', 'invoices', 'work', '.tether');
        mkdirSync(side, { recursive: true });
        await page.goto(`${b.origin}/?c=invoices`);
        await page.locator('#view-chat').waitFor();
        await page.locator('#view-chat').click();
        await sleep(1300);
        await tap(page.locator('#simple-thread .parley-replies button, #simple-thread button').filter({ hasText: 'Yes, send them' }).first(), 900);
        agents.invoices.read();
        agents.invoices.doing('Reading the 3 unpaid invoices');
        await sleep(1800);
        agents.invoices.doing('Drafting the reminder to Harbor Print');
        await sleep(1500);
        appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'film-1', op: 'mail.send', args: { target: 'work-mail', to: 'accounts@harborprint.example.com', subject: 'Invoice 2026-114: a friendly reminder', body: 'Hello,\nOur invoice 2026-114 of 14 October is still open.\nCould you confirm the payment date?\nThank you,\nSam', why: 'you asked me to remind unpaid clients' }, at: new Date().toISOString() })}\n`);
        const card = page.locator('#simple-thread .parley-request').first();
        await me.until('the request is in the thread', async () => (await card.count()) > 0, 30_000);
        await card.scrollIntoViewIfNeeded();
        await sleep(1000);
        await f.poster();
        if ((await card.locator('.parley-request-head').getAttribute('aria-expanded')) !== 'true') await tap(card.locator('.parley-request-head'), 800);
        await sleep(3200);
        await tap(card.locator('.parley-request-yes'), 800);
        await me.until('Tether has the decision', async () => ((await me.api('/api/tether')).body.approvals ?? []).length === 0, 20_000);
        agents.invoices.tell('Sent to Harbor Print. Two reminders left.');
        await sleep(3400);
        await closing('Nothing leaves without your OK.');
    },
};

async function run(names) {
    mkdirSync(OUT, { recursive: true });
    for (const name of names) {
        const after = [];
        const vids = mkdtempSync(join(tmpdir(), 'clv-film-'));
        try {
            const b = await bench({ after: (fn) => after.push(fn) }, { tools: TOOLS, tetherTargets: [MAILBOX], tetherConnectors: { mail: mailConnector } });
            const setup = await b.person();
            await setup.page.setViewportSize(VIEW);
            const agents = await seed(b, setup);
            if (name === 'assets') {
                await setup.api('/api/resources', { name: 'client-files' });
                await setup.api('/api/secrets', { name: 'BOOKING_KEY', value: 'demo-value-not-a-real-key' });
            }
            if (name === 'approval') await setup.api('/api/tether/level', { target: 'work-mail', agent: 'conversation:invoices', level: 'propose' });
            await setup.page.close();
            const f = await filmed(b, vids);
            f.poster = () => f.page.screenshot({ path: join(OUT, `desktop-${name}-poster.png`) });
            const started = Date.now();
            await FILMS[name](b, f, agents);
            if (f.me.errors.length) throw new Error(`${name}: ${f.me.errors.join('; ')}`);
            const video = f.page.video();
            await f.page.context().close();
            const file = join(OUT, `desktop-${name}.webm`);
            copyFileSync(await video.path(), file);
            console.log(`desktop-${name}.webm  ${(statSync(file).size / 1024).toFixed(0)} KB  ~${((Date.now() - started) / 1000).toFixed(0)} s`);
        } finally {
            for (const fn of after.reverse()) await fn();
            rmSync(vids, { recursive: true, force: true });
        }
    }
}

const asked = process.argv.slice(2);
for (const n of asked) if (!FILMS[n]) { console.error(`no film ${n}: ${Object.keys(FILMS).join(', ')}`); process.exit(2); }
await run(asked.length ? asked : Object.keys(FILMS));
process.exit(0);
