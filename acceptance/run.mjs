#!/usr/bin/env node
/* THE ACCEPTANCE RUN: a real browser against a REAL deployment, signed in
 * through its real sign-in page, one named check after another, each with its
 * pictures, and an HTML report at the end.
 *
 *   npm run acceptance -- --target https://clav.example.com [--conversation NAME] [--report DIR] [--dry]
 *
 * The person it signs in as comes from the environment, never from a file of
 * this repository: CLAVARIUM_ACCEPT_EMAIL and CLAVARIUM_ACCEPT_PASSWORD.
 * The browser comes from the `playwright` package, or from wherever
 * CLAVARIUM_E2E_PLAYWRIGHT points (as for the end-to-end bench).
 *
 * WHAT IT CHANGES, AND PUTS BACK. The conversation it is given goes into a
 * folder "Acceptance" and back to the one it was in; the name of the instance
 * is changed and put back; one labelled, harmless message is sent to its agent
 * (it is asked to answer, and to change no file). Without --dry, its machine
 * is restarted once, and given one step more memory, then its memory is put
 * back as it was (two more restarts). Nothing is created, nothing deleted,
 * nothing is ever sent from a review.
 *
 * Its report goes where --report says, else under the system's temporary
 * folder; never inside this repository (refused).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TABLET = { viewport: { width: 1024, height: 768 } };
export const MESSAGE = '[Clavarium acceptance test] Please reply with parley status working, then parley tell \'ok\', then parley status done. Do not change any file.';
const FOLDER = 'Acceptance';

/* ---------- arguments ---------- */
export function parseArgs(argv, env = process.env) {
    const o = { conversation: 'intranet-website', dry: false, report: '', target: '', chatMinutes: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
        if (a === '--target') o.target = value();
        else if (a === '--conversation') o.conversation = value();
        else if (a === '--report') o.report = value();
        else if (a === '--chat-minutes') o.chatMinutes = Number(value());
        else if (a === '--dry') o.dry = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    if (o.help) return o;
    if (!o.target) throw new Error('--target https://... is needed: the address of a real deployment');
    let url;
    try { url = new URL(o.target); } catch { throw new Error(`not an address: ${o.target}`); }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('the target is reached over https (its real sign-in), or on localhost');
    o.target = url.origin;
    if (!(o.chatMinutes > 0)) throw new Error('--chat-minutes is a number of minutes');
    o.report = resolve(o.report || join(tmpdir(), 'clavarium-acceptance', new Date().toISOString().replace(/[:.]/g, '-')));
    const inRepo = relative(REPO, o.report);
    if (inRepo === '' || (!inRepo.startsWith('..') && !isAbsolute(inRepo))) throw new Error('the report is never written inside the repository: choose another --report');
    o.email = env.CLAVARIUM_ACCEPT_EMAIL ?? '';
    o.password = env.CLAVARIUM_ACCEPT_PASSWORD ?? '';
    if (!o.email || !o.password) throw new Error('CLAVARIUM_ACCEPT_EMAIL and CLAVARIUM_ACCEPT_PASSWORD are needed (the person it signs in as)');
    return o;
}

/* ---------- the report ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function renderReport({ target, started, ended, checks, version, dry, notes = [] }) {
    const passed = checks.filter((c) => c.result === 'pass').length;
    const failed = checks.filter((c) => c.result === 'fail').length;
    const skipped = checks.filter((c) => c.result === 'skip').length;
    const verdict = failed === 0 && passed > 0 ? 'PASSED' : 'FAILED';
    const rows = checks.map((c, i) => `<tr class="${esc(c.result)}"><td>${i + 1}</td><td><b>${esc(c.name)}</b>${c.detail ? `<div class="d">${esc(c.detail)}</div>` : ''}</td><td class="r">${esc(c.result)}</td><td>${(c.ms / 1000).toFixed(1)} s</td><td class="shots">${c.shots.map((s) => `<a href="${esc(s)}"><img src="${esc(s)}" alt="${esc(s)}" loading="lazy"></a>`).join('')}</td></tr>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceptance report</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--mute:#666;--ok:#1a7f37;--bad:#c62828;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mute:#aaa;--line:#333;--ok:#4caf50;--bad:#ef5350}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px}
h1{font-size:1.4rem;margin:.2rem 0}.v{font-weight:700}.v.PASSED{color:var(--ok)}.v.FAILED{color:var(--bad)}
.meta{color:var(--mute)}table{border-collapse:collapse;width:100%;margin-top:1rem}td{border-top:1px solid var(--line);padding:.5rem;vertical-align:top}
tr.pass .r{color:var(--ok);font-weight:700}tr.fail .r{color:var(--bad);font-weight:700}tr.skip .r{color:var(--mute)}
.d{color:var(--mute);white-space:pre-wrap;font-size:.9em;overflow-wrap:anywhere}.shots img{height:120px;margin:2px;border:1px solid var(--line)}
@media (max-width:640px){td:nth-child(1),td:nth-child(4){display:none}.shots img{height:80px}}
</style></head><body>
<h1>Clavarium acceptance: <span class="v ${verdict}">${verdict}</span></h1>
<p class="meta">${esc(target)} &middot; version ${esc(version ?? 'unknown')} &middot; ${dry ? 'dry run (no restart, no resize)' : 'full run'}<br>
${esc(started)} to ${esc(ended)} &middot; ${passed} passed, ${failed} failed, ${skipped} skipped</p>
${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<table>${rows}</table></body></html>`;
}

/* ---------- the run ---------- */
async function loadPlaywright() {
    for (const from of [process.env.CLAVARIUM_E2E_PLAYWRIGHT && `${process.env.CLAVARIUM_E2E_PLAYWRIGHT}/index.mjs`, 'playwright']) {
        if (!from) continue;
        try { return await import(from); } catch { /* the next one */ }
    }
    throw new Error('no browser: install the "playwright" package, or set CLAVARIUM_E2E_PLAYWRIGHT');
}
/* A check that cannot be made here, and says why (not a failure). */
class Skip extends Error {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms = 20_000, every = 400) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { if (await check()) return; } catch (e) { last = e; }
        await wait(every);
    }
    throw new Error(`timed out (${Math.round(ms / 1000)} s): ${what}${last ? ` (${last.message.split('\n')[0]})` : ''}`);
}

export async function run(o, log = console.log) {
    const { chromium } = await loadPlaywright();
    mkdirSync(o.report, { recursive: true });
    const checks = []; const notes = [];
    const started = new Date().toISOString();
    let version = null;
    let shotNo = 0;
    const browser = await chromium.launch();
    const tablet = await browser.newContext(TABLET);
    let page = await tablet.newPage();
    let phone = null; let ppage = null;
    const shot = async (p, label) => {
        const file = `${String(++shotNo).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`;
        await p.screenshot({ path: join(o.report, file) }).catch(() => {});
        return file;
    };
    /* One named check: passed, failed (with a picture of where it stood), or skipped. */
    async function check(name, fn, { skip } = {}) {
        const c = { name, result: 'pass', detail: '', shots: [], ms: 0 };
        const t0 = Date.now();
        if (skip) { c.result = 'skip'; c.detail = skip; checks.push(c); log(`- ${name}: skipped (${skip})`); return c; }
        try {
            const said = await fn((p, label) => shot(p, label).then((f) => { c.shots.push(f); return f; }));
            if (typeof said === 'string') c.detail = said;
        } catch (e) {
            if (e instanceof Skip) { c.result = 'skip'; c.detail = e.message; c.ms = Date.now() - t0; checks.push(c); log(`- ${name}: skipped (${e.message})`); return c; }
            c.result = 'fail'; c.detail = e.message.split('\n').slice(0, 4).join('\n');
            for (const p of [page, ppage]) if (p && !p.isClosed()) c.shots.push(await shot(p, `${name}-failed`));
        }
        c.ms = Date.now() - t0;
        checks.push(c);
        log(`${c.result === 'pass' ? 'ok' : 'FAIL'} ${name}${c.detail ? `: ${c.detail.split('\n')[0]}` : ''}`);
        return c;
    }
    const api = async (path) => { const r = await tablet.request.get(o.target + path); if (!r.ok()) throw new Error(`${path}: ${r.status()}`); return r.json(); };
    const conv = async () => (await api('/api/conversations')).find((c) => c.name === o.conversation);
    const shown = (p, sel) => p.locator(sel).first().isVisible();
    const pressed = async (p, sel) => (await p.locator(sel).getAttribute('aria-pressed')) === 'true';
    const inChat = async (p) => (await pressed(p, '#view-chat')) && await shown(p, '#simple');
    const onList = async (p, isPhone) => new URL(p.url()).searchParams.get('c') === null && (!isPhone || await shown(p, '#list'));
    const escape = async (p) => { await p.evaluate(() => document.activeElement?.blur?.()); await p.keyboard.press('Escape'); };
    const bothWays = async (p, open, opened, closed, what) => {
        for (const how of ['Back', 'Escape']) {
            await open();
            await until(`${what} is open (${how})`, opened);
            if (how === 'Back') await p.goBack(); else await escape(p);
            await until(`${how} closes ${what}`, closed);
        }
    };
    const item = (p) => p.locator(`#items .item[data-name="${o.conversation}"]`);
    const openConversation = async (p) => {
        await p.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
        await until('the list', () => shown(p, '#items .item'), 30_000);
        await item(p).click();
        await until(`${o.conversation} is open`, async () => new URL(p.url()).searchParams.get('c') === o.conversation && await shown(p, '#views'));
    };
    /* A chapter of settings, unfolded (each device remembers which are). */
    const chapter = async (p, id, inside) => {
        await until(`the chapter ${id}`, async () => (await p.locator(`#${id}`).count()) === 1 && await p.locator(`#${id} > summary`).isVisible());
        if (!(await p.locator(`#${id}`).evaluate((d) => d.open))) await p.locator(`#${id} > summary`).click();
        await until(`the chapter ${id}, open`, () => shown(p, inside));
    };
    const openGeneral = async (p) => {
        await p.locator('#folders').click();
        await until('its settings', () => shown(p, '#panel'));
        await chapter(p, 'chapter-general', '#group-name');
    };
    const openMachineChapter = async (p) => {
        await p.locator('#folders').click();
        await until('its settings', () => shown(p, '#panel'));
        await chapter(p, 'chapter-machine', '#machine-memory');
        await until('its sizes', async () => /^\d+$/.test(await p.locator('#machine-memory').inputValue()) && /^\d+$/.test(await p.locator('#machine-disk').inputValue()));
    };
    /* The review, read: past "Looking at what was committed...". */
    const reviewRead = async (p) => (await shown(p, '#gitview')) && /\S/.test(await p.locator('#gitview-state').innerText()) && !(await p.locator('#gitview-state').innerText()).startsWith('Looking');
    /* Ready again after a restart: its phase, its tool, its terminal live. */
    const backAgain = async (p, what) => {
        await until(`${what}: it comes back`, async () => { const c = await conv(); return c?.phase === 'ready' && !c.progress && c.toolStarted !== false; }, 8 * 60_000, 3000);
        await p.goto(`${o.target}/?c=${encodeURIComponent(o.conversation)}`, { waitUntil: 'domcontentloaded' });
        await until(`${what}: its views`, () => shown(p, '#views'), 30_000);
        await p.locator('#view-terminal').click();
        await until(`${what}: its terminal is live`, async () => (await p.locator('#state').innerText()).trim() === 'live', 3 * 60_000, 1000);
        /* Its tool takes its last session up: never the dead end of a session it cannot find. */
        let text = '';
        for (let i = 0; i < 20; i++) {
            text = await p.locator('#terminal').innerText().catch(() => '');
            if (/No conversation found/i.test(text)) throw new Error(`${what}: its tool says "No conversation found"`);
            await wait(2000);
        }
        if (!text.trim()) throw new Error(`${what}: its terminal stays empty`);
        /* Its folders all there again (the server mounts them again after a start). */
        await until(`${what}: its folders mounted`, async () => { const h = (await conv())?.health; return !h || (h.answering !== false && (h.missing ?? []).length === 0); }, 3 * 60_000, 3000);
    };
    let original = null; let instance = null;
    try {
        /* 1. SIGN-IN, the real one. */
        const signed = await check('Sign in (Dex)', async (pic) => {
            await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            const start = page.locator('form[action="/oauth2/start"] button[type=submit]');
            if (await start.count()) { await start.first().click(); await page.waitForLoadState('domcontentloaded'); }
            if (await page.locator('#login').count()) {
                await pic(page, 'sign-in-page');
                await page.fill('#login', o.email); await page.fill('#password', o.password);
                await page.click('#submit-login');
                await page.waitForLoadState('domcontentloaded');
                if (page.url().includes('/approval')) await page.locator('button:has-text("Grant Access")').first().click();
            }
            await until('signed in: the list', async () => new URL(page.url()).origin === o.target && await page.locator('#items').count() === 1, 45_000);
            if (await page.locator('.dex-error, #login').count()) throw new Error('the sign-in page refused the credentials');
        });
        if (signed.result !== 'pass') throw new Error('not signed in: nothing else can be checked');
        phone = await browser.newContext({ ...PHONE, storageState: await tablet.storageState() });
        ppage = await phone.newPage();
        version = (await api('/api/updates').catch(() => ({}))).version ?? null;
        original = await conv();
        instance = await api('/api/instance').catch(() => null);
        if (!original) throw new Error(`no conversation "${o.conversation}" here`);
        notes.push(`Before: ${o.conversation} -- ${original.memoryMb} MB, ${original.diskGb ?? '?'} GB, phase ${original.phase}, tool started ${original.toolStarted}, folder "${original.group ?? ''}".`);

        await check('The list loads, with the name of the instance', async (pic) => {
            await until('the conversation is listed', () => shown(page, `#items .item[data-name="${o.conversation}"]`), 30_000);
            const title = (await page.locator('#list-title').innerText()).trim();
            if (!title) throw new Error('no name over the list');
            if (instance?.name && title !== instance.name) throw new Error(`the list says "${title}", the instance is "${instance.name}"`);
            await pic(page, 'tablet-list');
            await ppage.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list on a phone', () => shown(ppage, `#items .item[data-name="${o.conversation}"]`), 30_000);
            await pic(ppage, 'phone-list');
            return `"${title}"`;
        });

        await check('Search ("/") finds the conversation', async (pic) => {
            await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list', () => shown(page, '#items .item'), 30_000);
            await page.keyboard.press('/');
            await until('the search field, focused', async () => (await shown(page, '#search-field')) && await page.locator('#search-field').evaluate((f) => f === document.activeElement));
            await page.keyboard.type(o.conversation.slice(0, Math.min(6, o.conversation.length)).toUpperCase());
            await until('found', () => shown(page, `#items .item[data-name="${o.conversation}"]`));
            await pic(page, 'tablet-search');
            await page.locator('#search-field').fill('zz-nothing-is-named-so');
            await until('nothing found, said', () => shown(page, '#search-none'));
            await page.locator('#search-field').press('Escape');
            await until('Escape empties the field', async () => (await page.locator('#search-field').inputValue()) === '');
            await page.locator('#search-field').press('Escape');
            await until('Escape again closes it', async () => !(await shown(page, '#search')));
        });

        await check(`Folder: ${o.conversation} into "${FOLDER}"`, async (pic) => {
            await openConversation(page);
            await openGeneral(page);
            await page.fill('#group-name', FOLDER);
            await page.locator('#group-form button[type=submit]').click();
            await until('in the folder (server)', async () => (await conv()).group === FOLDER);
            await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list shows the folder with it', () => shown(page, `.group[data-group="${FOLDER}"] .item[data-name="${o.conversation}"]`), 20_000);
            await pic(page, 'tablet-folder');
        });

        await check('Navigation contract on a phone (Back and Escape on each screen)', async (pic) => {
            const p = ppage;
            await p.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list', () => shown(p, `#items .item[data-name="${o.conversation}"]`), 30_000);
            await bothWays(p, () => p.locator('#search-open').click(), () => shown(p, '#search-field'), async () => !(await shown(p, '#search')) && await onList(p, true), 'the search');
            for (const nav of ['assets', 'access', 'settings']) {
                await bothWays(p, () => p.locator(`#nav-${nav}`).click(), () => shown(p, `#${nav}`), async () => !(await shown(p, `#${nav}`)) && await onList(p, true), `${nav} (from the list)`);
            }
            await item(p).click();
            await until('the conversation', () => shown(p, '#views'));
            await p.goBack();
            await until('Back: the list', () => onList(p, true));
            if (new URL(p.url()).origin !== o.target) throw new Error('Back left the app');
            await item(p).click();
            await until('the conversation, on its chat', () => inChat(p), 20_000);
            await pic(p, 'phone-chat');
            for (const [tab, id] of [['terminal', '#view-terminal'], ['assets', '#view-assets'], ['settings', '#folders']]) {
                await bothWays(p, () => p.locator(id).click(), () => pressed(p, id), () => inChat(p), `the ${tab} tab`);
            }
            await p.locator('#back').click();
            await until('"<": the list', () => shown(p, '#list'));
        });

        /* ---------- WHAT A PHONE DOES, simulated: a touch screen (Chromium's mobile emulation) ---------- */
        const fingers = async (p) => {
            const cdp = await phone.newCDPSession(p);
            return (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
        };
        await check('Phone: search and folders by touch', async (pic) => {
            const p = ppage;
            await p.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list', () => shown(p, `#items .item[data-name="${o.conversation}"]`), 30_000);
            await p.locator('#search-open').tap();
            await until('the field, focused (the keyboard comes up)', async () => (await shown(p, '#search-field')) && await p.locator('#search-field').evaluate((f) => f === document.activeElement));
            await p.keyboard.type(o.conversation.slice(0, 4));
            await until('found', () => shown(p, `#items .item[data-name="${o.conversation}"]`));
            await pic(p, 'phone-search');
            await item(p).tap();
            await until('a tap opens it', () => shown(p, '#views'));
            await p.goBack();
            await until('Back: the list', () => onList(p, true));
            if (await shown(p, '#search')) { await p.goBack(); await until('Back closes the search', async () => !(await shown(p, '#search'))); }
            const head = p.locator(`.group-head[data-group="${FOLDER}"]`);
            await until(`the folder "${FOLDER}"`, () => shown(p, `.group-head[data-group="${FOLDER}"]`), 20_000);
            await head.tap();
            await until('folded by a tap', async () => (await p.locator(`.group[data-group="${FOLDER}"] .item`).count()) === 0);
            await pic(p, 'phone-folder-folded');
            await head.tap();
            await until('open again', () => shown(p, `.group[data-group="${FOLDER}"] .item[data-name="${o.conversation}"]`));
        });

        await check('Phone: a long press then a drag takes a conversation to move it; nothing is opened', async (pic) => {
            const p = ppage;
            const box = await item(p).boundingBox();
            const x = box.x + 30; const y = box.y + box.height / 2;
            const touch = await fingers(p);
            await touch('touchStart', [[x, y]]);
            await wait(700);
            let held = false;
            for (let i = 1; i <= 4; i++) { await touch('touchMove', [[x, y + i * 6]]); await wait(40); held = held || (await p.locator('#items[data-dragging="true"]').count()) === 1; }
            await pic(p, 'phone-long-press');
            for (let i = 3; i >= 0; i--) { await touch('touchMove', [[x, y + i * 6]]); await wait(40); }
            await touch('touchEnd', []);
            if (!held) throw new Error('a long press then a drag did not take it');
            await wait(500);
            if (new URL(p.url()).searchParams.get('c') !== null) throw new Error('held and dragged, it was opened');
            if ((await conv()).group !== FOLDER) throw new Error('dropped where it was, it changed folder');
            return 'taken and put back where it was (one conversation here: no other to move it past)';
        });

        await check('Phone: two fingers grow the text of the page, laid out again, never sideways', async (pic) => {
            const p = ppage;
            const before = await p.evaluate(() => window.clavariumText?.().scale);
            if (typeof before !== 'number') throw new Error('the text size cannot be read');
            const touch = await fingers(p);
            await touch('touchStart', [[195 - 40, 300], [195 + 40, 300]]);
            for (const d of [55, 70, 85]) { await touch('touchMove', [[195 - d, 300], [195 + d, 300]]); await wait(30); }
            await touch('touchEnd', []);
            await until('the text is larger', async () => (await p.evaluate(() => window.clavariumText().scale)) > before * 1.3);
            const sideways = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
            const page = await p.evaluate(() => window.visualViewport.scale);
            await pic(p, 'phone-text-larger');
            await p.evaluate(() => { try { localStorage.clear(); } catch { /* this test browser only */ } });
            if (sideways) throw new Error('the page scrolls sideways once the text is larger');
            if (page !== 1) throw new Error('the browser zoomed the page instead');
            return `text ${before} -> ${(await p.evaluate(() => window.clavariumText().scale)).toFixed(2)}`;
        });

        await check('Phone: a pinch on a picture in the viewer zooms the picture alone', async (pic) => {
            const p = ppage;
            await p.goto(`${o.target}/?c=${encodeURIComponent(o.conversation)}`, { waitUntil: 'domcontentloaded' });
            await until('its chat', () => inChat(p), 30_000);
            const pictures = p.locator('#simple-thread .parley-said[data-kind=show] img');
            await wait(2000);
            if ((await pictures.count()) === 0) throw new Skip('no picture shown in this chat to pinch: ask its agent to show one (parley show) and run again');
            await pictures.last().scrollIntoViewIfNeeded();
            await pictures.last().tap();
            const zoom = p.locator('#simple-thread .parley-zoom');
            await until('the viewer', () => zoom.isVisible());
            await until('the picture, loaded', () => zoom.locator('.parley-zoom-stage img').evaluate((i) => i.complete && i.naturalWidth > 0), 30_000);
            await wait(300);
            const scaleOf = () => zoom.locator('.parley-zoom-stage img').evaluate((i) => new DOMMatrix(getComputedStyle(i).transform).a);
            const fitted = await scaleOf();
            const b = await zoom.locator('.parley-zoom-stage img').boundingBox();
            const cx = b.x + b.width / 2; const cy = b.y + b.height / 2;
            const touch = await fingers(p);
            await touch('touchStart', [[cx - 20, cy], [cx + 20, cy]]);
            for (let d = 30; d <= 120; d += 10) { await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); await wait(16); }
            await touch('touchEnd', []);
            await until('the picture is zoomed', async () => (await scaleOf()) > fitted * 2);
            if ((await p.evaluate(() => window.visualViewport.scale)) !== 1) throw new Error('the page zoomed too');
            await pic(p, 'phone-viewer-pinch');
            await p.goBack();
            await until('Back closes the viewer only', async () => !(await zoom.isVisible()) && await inChat(p));
        });

        await check('Phone: installable, and the name chosen on this device is in its manifest (owner, then a device page)', async (pic) => {
            const p = await phone.newPage();
            try {
                await p.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
                await until('the list', () => shown(p, '#items .item'), 30_000);
                await p.evaluate(() => navigator.serviceWorker?.ready);
                const cdp = await phone.newCDPSession(p);
                const errors = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.map((e) => e.errorId);
                if (errors.length) throw new Error(`not installable: ${errors.join(', ')}`);
                /* The browser's offer, as Chrome makes it on Android (a stand-in event: an emulated phone is never offered one). */
                await p.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__offered = (window.__offered ?? 0) + 1; }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); dispatchEvent(e); });
                await p.locator('#nav-settings').tap();
                await until('Settings', () => shown(p, '#settings'), 20_000);
                await chapter(p, 'settings-ch-screen', '#install');
                await p.locator('#install').tap();
                await until('"Name on this device", filled with the name of the instance', async () => (await shown(p, '#install-name-form')) && (await p.locator('#install-name').inputValue()) === instance.name);
                await pic(p, 'phone-install-name');
                const chosen = 'Acceptance phone';
                await p.locator('#install-name').fill(chosen);
                await p.locator('#install-name-form button[type=submit]').tap();
                await until('the browser is asked to install', () => p.evaluate(() => window.__offered === 1), 10_000);
                await until('the page points at a manifest with that name', async () => new URL(await p.locator('link[rel="manifest"]').getAttribute('href'), o.target).searchParams.get('name') === chosen);
                /* As the browser reads it, kept by this device: the page opened again. */
                await p.reload({ waitUntil: 'domcontentloaded' });
                const manifestOf = async () => { const m = await cdp.send('Page.getAppManifest'); return { url: m.url, data: JSON.parse(m.data || '{}') }; };
                await until('the browser\'s manifest says the chosen name', async () => (await manifestOf()).data.name === chosen, 20_000);
                const owner = await manifestOf();
                /* A device's page (no pairing needed to read its manifest): its own chosen name. */
                const dev = await phone.newPage();
                try {
                    await dev.goto(`${o.target}/c/`, { waitUntil: 'domcontentloaded' });
                    await dev.evaluate((n) => { try { localStorage.setItem('clavarium-install-name', n); } catch { /* said below */ } }, 'Acceptance tablet');
                    await dev.reload({ waitUntil: 'domcontentloaded' });
                    const dcdp = await phone.newCDPSession(dev);
                    await until('the device page\'s manifest says its chosen name', async () => JSON.parse((await dcdp.send('Page.getAppManifest')).data || '{}').name === 'Acceptance tablet', 20_000);
                    await dev.evaluate(() => { try { localStorage.removeItem('clavarium-install-name'); } catch { /* this test browser only */ } });
                } finally { await dev.close(); }
                await p.evaluate(() => { try { localStorage.removeItem('clavarium-install-name'); } catch { /* this test browser only */ } });
                return `installable; owner manifest name "${owner.data.name}", short "${owner.data.short_name}"; device page too`;
            } finally { await p.close(); }
        });

        await check('Phone: alerts -- permission, push subscription, a notification shown by the service worker', async (pic) => {
            const p = await phone.newPage();
            try {
                await phone.grantPermissions(['notifications'], { origin: o.target });
                await p.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
                await until('the list', () => shown(p, '#items .item'), 30_000);
                const ready = await p.evaluate(async () => { const r = await navigator.serviceWorker.ready; return Boolean(r.active) && 'PushManager' in window; });
                if (!ready) throw new Error('no active service worker, or no push in this browser');
                if ((await p.evaluate(() => Notification.permission)) !== 'granted') {
                    /* Chromium's headless shell refuses notifications whatever is granted: what remains is said, and left to phone.md. */
                    await p.locator('#nav-settings').tap();
                    await until('Settings', () => shown(p, '#settings'), 20_000);
                    await chapter(p, 'settings-ch-alerts', '#alerts-state');
                    if (!(await shown(p, '#alerts-on')) && !(await shown(p, '#alerts-off'))) throw new Error(`alerts not offered: ${await p.locator('#alerts-state').innerText()}`);
                    await pic(p, 'phone-alerts');
                    return 'service worker active, push available, alerts offered; this browser refuses the permission itself (headless): subscription and delivery are left to phone.md';
                }
                const shownBySw = await p.evaluate(async () => {
                    const r = await navigator.serviceWorker.ready;
                    await r.showNotification('Clavarium acceptance', { body: 'A test from the acceptance run', tag: 'clavarium-acceptance' });
                    const n = await r.getNotifications({ tag: 'clavarium-acceptance' });
                    n.forEach((x) => x.close());
                    return n.length;
                });
                if (shownBySw !== 1) throw new Error('its service worker could not show a notification');
                await p.locator('#nav-settings').tap();
                await until('Settings', () => shown(p, '#settings'), 20_000);
                await chapter(p, 'settings-ch-alerts', '#alerts-state');
                if (!(await shown(p, '#alerts-on'))) throw new Error(`no "On": ${await p.locator('#alerts-state').innerText()}`);
                await p.locator('#alerts-on').tap();
                let said = '';
                await until('subscribed, or said why not', async () => { said = await p.locator('#alerts-state').innerText(); return (await shown(p, '#alerts-off')) || /could not|refused|cannot/.test(said); }, 30_000);
                await pic(p, 'phone-alerts');
                const subscribed = await shown(p, '#alerts-off');
                if (subscribed) {
                    /* Taken back at once: this test browser is not a device to alert. (No "Send a test": it would reach the real devices.) */
                    await p.locator('#alerts-off').tap();
                    await until('unsubscribed', () => shown(p, '#alerts-on'), 20_000);
                    return 'permission granted; subscribed then removed; a notification shown by its service worker';
                }
                if (/push service/i.test(said)) return `permission granted; a notification shown by its service worker; the subscription needs a real push service, absent from this test browser ("${said.slice(0, 90)}")`;
                throw new Error(said);
            } finally { await p.close(); }
        });

        await check('Chat: a labelled message, "Received, thinking...", then its agent answers', async (pic) => {
            const before = await api(`/api/conversations/${encodeURIComponent(o.conversation)}/talk`);
            const known = new Set((before.messages ?? []).map((m) => m.id));
            const knownSteps = new Set((before.steps ?? []).map((s) => s.id));
            await openConversation(page);
            await page.locator('#view-chat').click();
            await until('the chat', () => inChat(page));
            await page.locator('#simple .parley-box').fill(MESSAGE);
            await page.locator('#simple .parley-send').click();
            const sentAt = Date.now();
            let received = false; let working = false;
            await until('"Received, thinking..." or its agent working', async () => {
                received = received || await shown(page, '#simple .parley-received');
                working = working || (await page.locator('#simple .parley-status').getAttribute('data-state').catch(() => '')) === 'working';
                return received || working;
            }, 3 * 60_000, 250);
            await pic(page, 'tablet-chat-received');
            let said = null; let done = false;
            await until(`its agent says "ok" and is done (${o.chatMinutes} min)`, async () => {
                const t = await api(`/api/conversations/${encodeURIComponent(o.conversation)}/talk`);
                said = said ?? (t.messages ?? []).find((m) => !known.has(m.id) && m.from === 'agent' && /\bok\b/i.test(m.text ?? ''));
                const steps = (t.steps ?? []).filter((s) => !knownSteps.has(s.id));
                working = working || steps.some((s) => s.state === 'working');
                done = steps.some((s) => s.kind === 'status' && s.state === 'done');
                return Boolean(said) && done;
            }, o.chatMinutes * 60_000, 3000);
            await until('the answer is on the screen', async () => (await page.locator('#simple .parley-said[data-from="agent"]').last().innerText()).includes(said.text.slice(0, 20)), 30_000);
            await pic(page, 'tablet-chat-answer');
            await ppage.goto(`${o.target}/?c=${encodeURIComponent(o.conversation)}`, { waitUntil: 'domcontentloaded' });
            await until('the chat on a phone', () => inChat(ppage), 30_000);
            await wait(1500);
            await pic(ppage, 'phone-chat-answer');
            return `received shown: ${received}; status working: ${working}; answer "${said.text.slice(0, 60)}" after ${Math.round((Date.now() - sentAt) / 1000)} s; status done: ${done}`;
        });

        let repo = '';
        await check('Assets: Git repository, branch diagram, review, back', async (pic) => {
            await openConversation(page);
            await page.locator('#view-assets').click();
            const rows = page.locator('#cassets-rows .as-row[data-asset^="git:"]');
            await until('a Git repository is listed', async () => (await rows.count()) > 0);
            repo = (await rows.first().getAttribute('data-asset')).slice(4);
            await rows.first().click();
            await until('its branch diagram', async () => (await page.locator('#cassets-detail .gg-row').count()) > 0, 45_000);
            await pic(page, 'tablet-branches');
            await page.locator('#cassets-detail button[data-act="review"]').click();
            await until('the review, read', () => reviewRead(page), 90_000);
            await pic(page, 'tablet-review');
            await page.goBack();
            await until('Back: the repository again', async () => !(await shown(page, '#gitview')) && await shown(page, '#cassets-detail'));
            /* The same on a phone: the review unified, then Back. */
            await ppage.goto(`${o.target}/?c=${encodeURIComponent(o.conversation)}`, { waitUntil: 'domcontentloaded' });
            await until('phone: its views', () => shown(ppage, '#views'), 30_000);
            await ppage.locator('#view-assets').click();
            await ppage.locator(`#cassets-rows .as-row[data-asset="git:${repo}"]`).click();
            await until('phone: its branches', async () => (await ppage.locator('#cassets-detail .gg-row').count()) > 0, 45_000);
            await ppage.locator('#cassets-detail button[data-act="review"]').click();
            await until('phone: the review, read', () => reviewRead(ppage), 90_000);
            await pic(ppage, 'phone-review');
            await ppage.goBack();
            await until('phone: Back closes the review', async () => !(await shown(ppage, '#gitview')));
            return repo;
        });

        await check('The "Last checks" card of the repository', async (pic) => {
            if (!repo) throw new Error('no repository was opened');
            let ran = '';
            await until('the detail of the repository', async () => (await page.locator('#cassets-detail .gg-row').count()) > 0, 45_000);
            if (!(await page.locator('#cassets-detail .as-lastchecks').count())) {
                /* None kept yet (checks run only on a sending, or from a review with something to send): run them once,
                   as "Run again" of the card does, on the tip of the agent's branch. Nothing is sent. */
                const keep = await api(`/api/git/${encodeURIComponent(repo)}/keep`);
                const branch = keep.auto?.[o.conversation]?.at(-1) ?? 'main';
                const r = await page.evaluate(async ([name, branch]) => { const x = await fetch(`/api/git/${encodeURIComponent(name)}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ again: true, target: branch, branch }) }); return `${x.status} ${(await x.text()).slice(0, 200)}`; }, [repo, branch]);
                ran = `none kept yet: ran them once on ${branch} (${r.split(' ')[0]}); `;
                await page.reload({ waitUntil: 'domcontentloaded' });
                await until('its views', () => shown(page, '#views'), 30_000);
                await page.locator('#view-assets').click();
                await page.locator(`#cassets-rows .as-row[data-asset="git:${repo}"]`).click();
            }
            await until('the card', () => shown(page, '#cassets-detail .as-lastchecks'), 11 * 60_000, 2000);
            await page.locator('#cassets-detail .as-lastchecks').scrollIntoViewIfNeeded();
            await pic(page, 'tablet-last-checks');
            return ran + (await page.locator('#cassets-detail .as-lastchecks').innerText()).replace(/\s+/g, ' ').slice(0, 120);
        });

        await check('Settings tab, Machine: its sizes', async (pic) => {
            await openConversation(page);
            await openMachineChapter(page);
            const memory = await page.locator('#machine-memory').inputValue(); const disk = await page.locator('#machine-disk').inputValue();
            if (!/^\d+$/.test(memory) || !/^\d+$/.test(disk)) throw new Error(`sizes not shown: memory "${memory}", disk "${disk}"`);
            if (await page.locator('#machine-memory').isDisabled()) throw new Error('its sizes cannot be chosen though it is ready');
            await page.locator('#machine-size').scrollIntoViewIfNeeded();
            await pic(page, 'tablet-machine');
            return `${memory} MB, ${disk} GB`;
        });

        const full = o.dry ? 'dry run' : undefined;
        await check('Restart: the tool comes back on its session', async (pic) => {
            await openConversation(page);
            await openMachineChapter(page);
            await page.locator('#restart').click();
            await until('asked first', () => shown(page, '#notice-action'));
            await pic(page, 'tablet-restart-asked');
            await page.locator('#notice-action').click();
            await until('it restarts', async () => (await conv())?.phase !== 'ready' || /restart/i.test(await page.locator('#state').innerText()), 60_000, 500);
            await backAgain(page, 'after the restart');
            await pic(page, 'tablet-after-restart');
        }, { skip: full });

        await check('Resize: one step more memory, and it comes back with it', async (pic) => {
            const now = (await conv()).memoryMb;
            await openConversation(page);
            await openMachineChapter(page);
            const choices = (await page.locator('#machine-memory option').evaluateAll((all) => all.map((x) => Number(x.value)))).filter((m) => m > now).sort((a, b) => a - b);
            if (!choices.length) throw new Error('no larger memory offered');
            const next = choices[0];
            await page.selectOption('#machine-memory', String(next));
            await page.locator('#machine-size-apply').click();
            await until('asked first', async () => /Give "/.test(await page.locator('#notice-text').innerText()));
            await pic(page, 'tablet-resize-asked');
            await page.locator('#notice-action').click();
            await until('its new size', async () => (await conv())?.memoryMb === next, 8 * 60_000, 3000);
            await backAgain(page, 'after the resize');
            await openMachineChapter(page);
            if (Number(await page.locator('#machine-memory').inputValue()) !== next) throw new Error('the page does not say its new memory');
            await pic(page, 'tablet-resized');
            return `${now} MB -> ${next} MB`;
        }, { skip: full });

        await check('Access map: three "+" and "All devices"', async (pic) => {
            await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list', () => shown(page, '#items .item'), 30_000);
            await page.locator('#nav-access').click();
            await until('the map', () => shown(page, '#access-map'), 20_000);
            await until('three "+"', async () => (await page.locator('#links [data-add] >> visible=true').count()) === 3, 20_000);
            if (!(await shown(page, '#map-all-devices'))) throw new Error('no "All devices"');
            await pic(page, 'tablet-access-map');
            await ppage.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('phone: the list', () => shown(ppage, '#items .item'), 30_000);
            await ppage.locator('#nav-access').click();
            await until('phone: the map', () => shown(ppage, '#access-map'), 20_000);
            await pic(ppage, 'phone-access-map');
        });

        await check('Settings: the name of the instance, changed and put back', async (pic) => {
            await page.locator('#access-close').click().catch(() => {});
            await page.locator('#nav-settings').click();
            await until('Settings', () => shown(page, '#settings'), 20_000);
            await chapter(page, 'settings-ch-general', '#instance-name');
            const was = await page.locator('#instance-name').inputValue();
            const shownName = was || instance?.name || '';
            const trial = `${shownName || 'Clavarium'} ok`.slice(0, 40);
            await page.fill('#instance-name', trial);
            await page.locator('#instance-form button[type=submit]').click();
            await until('the new name, over the list too', async () => (await api('/api/instance')).name === trial && (await page.locator('#list-title').innerText()).trim() === trial);
            await pic(page, 'tablet-instance-name');
            await page.fill('#instance-name', instance?.given ? instance.name : '');
            await page.locator('#instance-form button[type=submit]').click();
            await until('the name put back', async () => (await api('/api/instance')).name === instance.name);
            return `"${instance.name}" -> "${trial}" -> "${instance.name}"`;
        });

        /* Looked at, never saved: no real key is ever chosen by this run. */
        await check('Settings, Dictation: the chapter, and a provider fills in its address and model', async (pic) => {
            await page.locator('#nav-settings').click().catch(() => {});
            await until('Settings', () => shown(page, '#settings'), 20_000);
            await chapter(page, 'settings-ch-dictation', '#dictation-provider');
            const before = await page.locator('#dictation-provider').inputValue();
            const was = await api('/api/dictation');
            await page.selectOption('#dictation-provider', 'mistral');
            const url = await page.locator('#dictation-url').inputValue();
            const model = await page.locator('#dictation-model').inputValue();
            if (url !== 'https://api.mistral.ai/v1/audio/transcriptions' || model !== 'voxtral-mini-latest') throw new Error(`Mistral filled in "${url}", "${model}"`);
            await page.selectOption('#dictation-provider', 'other');
            if (await page.locator('#dictation-url').inputValue() !== '' || !(await page.locator('#dictation-other-hint').isVisible())) throw new Error('"Other" did not empty the address or say where it may send');
            await pic(page, 'tablet-dictation');
            const said = (await page.locator('#settings-dictation').innerText()).trim();
            /* Nothing saved: the page is left as it came. */
            await page.selectOption('#dictation-provider', before);
            const now = await api('/api/dictation');
            if (JSON.stringify([now.source, now.provider, now.url]) !== JSON.stringify([was.source, was.provider, was.url])) throw new Error('the choice changed on the server');
            return `${said.slice(0, 90)}; Mistral and Other fill in as they should; nothing saved`;
        });

        await check('Settings, Updates: version and channel', async (pic) => {
            await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
            await until('the list', () => shown(page, '#items .item'), 30_000);
            await page.locator('#nav-settings').click();
            await until('Settings', () => shown(page, '#settings'), 20_000);
            await chapter(page, 'settings-updates-top', '#updates-version');
            await until('its version', async () => /^Clavarium \S+/.test(await page.locator('#updates-version').innerText()), 20_000);
            await page.locator('#updates').scrollIntoViewIfNeeded();
            const v = (await page.locator('#updates-version').innerText()).trim();
            const channel = await page.locator('#updates-channel').inputValue().catch(() => '');
            if (version && !v.includes(version)) throw new Error(`the page says "${v}", the server ${version}`);
            if (!channel) throw new Error('no channel shown');
            await pic(page, 'tablet-updates');
            return `${v}, channel ${channel}`;
        });
    } catch (e) {
        notes.push(`Stopped: ${e.message}`);
    } finally {
        /* PUT BACK what was changed: its folder, its memory, the name of the instance. */
        if (original) {
            await check(`Restore: ${o.conversation} as it was`, async (pic) => {
                const restored = [];
                const name = await api('/api/instance').catch(() => null);
                if (instance && name && name.name !== instance.name) {
                    await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
                    await page.locator('#nav-settings').click();
                    await until('Settings', () => shown(page, '#settings'), 20_000);
                    await chapter(page, 'settings-ch-general', '#instance-name');
                    await page.fill('#instance-name', instance.given ? instance.name : '');
                    await page.locator('#instance-form button[type=submit]').click();
                    await until('the name put back', async () => (await api('/api/instance')).name === instance.name);
                    restored.push('instance name');
                }
                let c = await conv();
                if ((c.group ?? '') !== (original.group ?? '')) {
                    await openConversation(page);
                    await openGeneral(page);
                    await page.fill('#group-name', original.group ?? '');
                    await page.locator('#group-form button[type=submit]').click();
                    await until('its folder put back', async () => ((await conv()).group ?? '') === (original.group ?? ''));
                    restored.push(`folder "${original.group ?? ''}"`);
                }
                c = await conv();
                if (c.memoryMb !== original.memoryMb) {
                    await until('ready before its size is put back', async () => (await conv())?.phase === 'ready', 8 * 60_000, 3000);
                    await openConversation(page);
                    await openMachineChapter(page);
                    await page.selectOption('#machine-memory', String(original.memoryMb));
                    await page.locator('#machine-size-apply').click();
                    await until('asked first', async () => /Give "/.test(await page.locator('#notice-text').innerText()));
                    await page.locator('#notice-action').click();
                    await until('its memory put back', async () => (await conv())?.memoryMb === original.memoryMb, 8 * 60_000, 3000);
                    await backAgain(page, 'after its memory was put back');
                    restored.push(`memory ${original.memoryMb} MB`);
                }
                c = await conv();
                await page.goto(`${o.target}/`, { waitUntil: 'domcontentloaded' });
                await until('the list', () => shown(page, '#items .item'), 30_000);
                await pic(page, 'tablet-restored');
                notes.push(`After: ${o.conversation} -- ${c.memoryMb} MB, ${c.diskGb ?? '?'} GB, phase ${c.phase}, tool started ${c.toolStarted}, folder "${c.group ?? ''}".`);
                if ((c.group ?? '') !== (original.group ?? '') || c.memoryMb !== original.memoryMb) throw new Error('not all was put back');
                return restored.length ? `put back: ${restored.join(', ')}` : 'nothing to put back';
            });
        }
        await browser.close().catch(() => {});
    }
    const ended = new Date().toISOString();
    const report = { target: o.target, started, ended, checks, version, dry: o.dry, notes };
    writeFileSync(join(o.report, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(o.report, 'index.html'), renderReport(report));
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let o;
    try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`acceptance: ${e.message}`); process.exit(64); }
    if (o.help) { console.log('usage: npm run acceptance -- --target https://... [--conversation NAME] [--report DIR] [--dry] [--chat-minutes N]\n(credentials: CLAVARIUM_ACCEPT_EMAIL, CLAVARIUM_ACCEPT_PASSWORD)'); process.exit(0); }
    const report = await run(o).catch((e) => { console.error(`acceptance: ${e.message}`); process.exit(1); });
    const failed = report.checks.filter((c) => c.result === 'fail').length;
    console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${report.checks.length - failed} of ${report.checks.length} -- report: ${join(o.report, 'index.html')}`);
    if (!existsSync(join(o.report, 'index.html'))) process.exitCode = 1;
    process.exitCode = failed ? 1 : 0;
}
