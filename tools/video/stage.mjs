/* THE STAGE OF A DEMO VIDEO: the repository's end-to-end bench (e2e/bench.mjs: the real server, page, API,
 * terminals, Parley and Tether; only the VM manager and the agents are stand-ins), a browser filmed at one
 * format, a visible pointer, title cards over the page, and cues that wait for the voice.
 *
 * Formats: desk (16:9, a 1280x720 page) and phone (9:16, a 414x736 page). The browser films at the page's own
 * size (a bigger film size only pads the picture: 26-11, a film stuck in a corner); the assembly scales it up
 * to 1920x1080 or 1080x1920. */
import { mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(process.env.CLAVARIUM_REPO || join(HERE, '..', '..'));
export const FORMATS = {
    desk: { viewport: { width: 1280, height: 720 }, scale: 1, size: { width: 1280, height: 720 }, out: { width: 1920, height: 1080 }, mobile: false },
    phone: { viewport: { width: 414, height: 736 }, scale: 1, size: { width: 414, height: 736 }, out: { width: 1080, height: 1920 }, mobile: true },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadBench() {
    if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to the path of playwright-core/index.mjs');
    process.env.CLAVARIUM_E2E_PLAYWRIGHT = dirname(resolve(process.env.PLAYWRIGHT));
    const load = (path) => import(pathToFileURL(join(REPO, path)).href);
    const { bench, SKIP } = await load('e2e/bench.mjs');
    if (SKIP) throw new Error(`The bench cannot run: ${SKIP}`);
    const { bridge } = await load('node_modules/clavarium-parley/server/parley-mcp.mjs');
    return { bench, bridge };
}

/* A tool on the bench: a plain shell under the name a reader knows; it can be changed for another (#404). */
export const tool = (id, label) => ({ id, label, instructions: `.${id}/NOTES.md`, state: { keep: [`.${id}`] }, command: ['env', 'PS1=agent@work:/work$ ', 'bash', '--norc', '--noprofile'], resume: ['env', 'PS1=agent@work:/work$ ', 'bash', '--norc', '--noprofile'], memoryMb: 2048, install: [['true']] });

/* The browser of the person filmed, at one format: pointer, taps, cards, cues. */
export async function filmed(b, format, vids, { theme = process.env.THEME || 'light', opening = '', at = '/' } = {}) {
    const F = FORMATS[format];
    mkdirSync(vids, { recursive: true });
    const context = await b.browser.newContext({ viewport: F.viewport, deviceScaleFactor: F.scale, isMobile: F.mobile, hasTouch: F.mobile, colorScheme: theme, locale: 'en-GB', recordVideo: { dir: vids, size: F.size } });
    /* The app's own theme choice, as a person would have set it. */
    await context.addInitScript((t) => { try { localStorage.setItem('clavarium-theme', t); } catch { /* none */ } }, theme);
    /* The opening card is on the page from its very first frame (26-11: a first image of the app still loading,
       "Building its machine", before the card): whatever is cut at the start, only the card is seen. */
    if (opening) await context.addInitScript((text) => {
        const put = () => {
            if (document.getElementById('film-card')) return;
            const d = document.createElement('div'); d.id = 'film-card';
            d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#f7f6f2;color:#1d1d1b;text-align:center;padding:8vw;z-index:2147483646;opacity:1;transition:opacity .45s;pointer-events:none';
            const inner = document.createElement('div');
            const logo = document.createElement('div'); logo.textContent = '>_ clavarium'; logo.style.cssText = 'font:700 clamp(14px,2.2vw,22px) ui-monospace,monospace;margin-bottom:3vh;color:#1d1d1b';
            const big = document.createElement('div'); big.textContent = text; big.style.cssText = 'font:800 clamp(30px,5.4vw,64px)/1.12 system-ui,sans-serif;text-wrap:balance';
            inner.append(logo, big); d.append(inner); document.documentElement.append(d);
        };
        if (document.documentElement) put(); addEventListener('DOMContentLoaded', put);
    }, opening);
    await context.addInitScript(() => {
        addEventListener('DOMContentLoaded', () => {
            const c = document.createElement('div'); c.id = 'film-pointer';
            c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(47,111,94,.35);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);z-index:2147483640;pointer-events:none;transition:transform .15s';
            document.documentElement.append(c);
            addEventListener('mousemove', (e) => { c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`; }, true);
            addEventListener('mousedown', () => { c.style.transform = 'scale(.65)'; }, true);
            addEventListener('mouseup', () => { c.style.transform = ''; }, true);
        });
    });
    const me = await b.person({ context, at });
    const page = me.page;
    const videoStart = Date.now();
    /* Taps like a hand: the pointer travels, presses, lets go. */
    const tap = async (target, wait = 700) => {
        const l = typeof target === 'string' ? page.locator(target).first() : target;
        await l.waitFor({ state: 'visible', timeout: 15_000 });
        await l.scrollIntoViewIfNeeded().catch(() => {});
        const box = await l.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
        await sleep(220);
        await page.mouse.down(); await sleep(70); await page.mouse.up();
        await sleep(wait);
    };
    /* Points at something without pressing it. */
    const point = async (target, wait = 600) => {
        const l = typeof target === 'string' ? page.locator(target).first() : target;
        await l.waitFor({ state: 'visible', timeout: 15_000 });
        const box = await l.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
        await sleep(wait);
    };
    /* Draws the eye to what the voice talks about: a soft ring around it for a moment. */
    const spot = async (target, ms = 1600) => {
        const l = typeof target === 'string' ? page.locator(target).first() : target;
        await l.waitFor({ state: 'visible', timeout: 15_000 });
        await l.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(250);
        /* A list drawn again meanwhile takes the element away: found again, a few times; else the pause alone. */
        const mark = (n) => l.evaluate((e, ms) => {
            /* On the element itself, so it follows it if the page moves. */
            const was = [e.style.outline, e.style.outlineOffset, e.style.borderRadius, e.style.transition];
            e.style.transition = 'outline-color .3s'; e.style.outline = '3px solid #3aa587'; e.style.outlineOffset = '5px'; e.style.borderRadius = e.style.borderRadius || '8px';
            setTimeout(() => { [e.style.outline, e.style.outlineOffset, e.style.borderRadius, e.style.transition] = was; }, ms);
        }, ms, { timeout: 3000 }).then(() => true, () => (n > 1 ? mark(n - 1) : false));
        if (!(await mark(3))) await sleep(ms);
    };
    /* A card over the page: the opening or the closing line, the site's colours. */
    /* The closing card: its time is kept (the insets end there). */
    const card = (text, { sub = '', id = 'film-card' } = {}) => (f.cardAt = (Date.now() - f.t0) / 1000, page.evaluate(({ text, sub, id }) => {
        document.getElementById(id)?.remove();
        const d = document.createElement('div'); d.id = id;
        d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#f7f6f2;color:#1d1d1b;text-align:center;padding:8vw;z-index:2147483646;opacity:0;transition:opacity .45s';
        const inner = document.createElement('div');
        const logo = document.createElement('div'); logo.textContent = '>_ clavarium'; logo.style.cssText = 'font:700 clamp(14px,2.2vw,22px) ui-monospace,monospace;margin-bottom:3vh;color:#1d1d1b';
        const big = document.createElement('div'); big.textContent = text; big.style.cssText = 'font:800 clamp(30px,5.4vw,64px)/1.12 system-ui,sans-serif;text-wrap:balance';
        inner.append(logo, big);
        if (sub) { const s = document.createElement('div'); s.textContent = sub; s.style.cssText = 'font:600 clamp(15px,2vw,22px) system-ui,sans-serif;color:#2f6f5e;margin-top:3vh'; inner.append(s); }
        d.append(inner); document.documentElement.append(d);
        requestAnimationFrame(() => { d.style.opacity = '1'; });
        const p = document.getElementById('film-pointer'); if (p) p.style.opacity = '0';
    }, { text, sub, id }));
    /* The honest line, small, in a corner, for the whole film (the site's films say the same). */
    const badge = (text = 'Demo: invented data, scripted agents') => page.evaluate((text) => {
        document.getElementById('film-badge')?.remove();
        const d = document.createElement('div'); d.id = 'film-badge'; d.textContent = text;
        d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:54px;font:600 11px system-ui,sans-serif;white-space:nowrap;color:#5b5b55;background:rgba(247,246,242,.88);border:1px solid #d9d6cc;border-radius:999px;padding:3px 9px;z-index:2147483645;pointer-events:none';
        document.documentElement.append(d);
    }, text);
    /* Waits until the app has nothing loading over it (its "Building its machine" / "Starting" veil). */
    const settled = async (ms = 60_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const busy = await page.evaluate(() => [...document.querySelectorAll('body *')].some((e) => e.offsetParent !== null && e.children.length === 0 && /^(Building its machine|Starting |Waking it up|Restarting its machine)/.test(e.textContent.trim())));
            if (!busy) return;
            await sleep(300);
        }
        throw new Error('the app is still loading');
    };
    /* Brings something into view at once (no visible scrolling), centred. */
    const reveal = async (target) => {
        const l = typeof target === 'string' ? page.locator(target).first() : target;
        await l.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await sleep(150);
    };
    const uncard = async (id = 'film-card') => {
        await page.evaluate((id) => { const d = document.getElementById(id); if (d) { d.style.opacity = '0'; setTimeout(() => d.remove(), 500); } const p = document.getElementById('film-pointer'); if (p) p.style.opacity = '1'; }, id);
        await sleep(500);
    };
    const f = { me, page, tap, point, spot, badge, reveal, settled, card, uncard, context, videoStart, t0: videoStart, format, mobile: F.mobile };
    /* The film starts here: what came before (loading) is cut at assembly. */
    f.begin = () => { f.t0 = Date.now(); };
    /* An ellipsis: a wait nobody needs to watch (a push, a slow check) is filmed, then taken out at assembly;
       a moment is kept on each side. The voice is let finish first, so that no line is cut. */
    f.cuts = [];
    f.skip = async (fn, keep = 0.4) => {
        await f.quiet?.();
        const a = (Date.now() - f.t0) / 1000;
        const r = await fn();
        const b = (Date.now() - f.t0) / 1000;
        if (b - a > 2 * keep + 0.3) f.cuts.push([a + keep, b - keep]);
        return r;
    };
    return f;
}

/* The voice follows the film: line i starts when the scenario reaches cue(i), but never before line i-1 has
   been said and its silence kept. What a slow step costs is a longer film, never a voice ahead of the picture.
   Returns the cue and the starts it recorded (seconds from the start of the film). */
export function cueing(f, said, gaps = []) {
    const starts = [];
    const cue = async (i) => {
        const gap = gaps[i] ?? 0.5;
        const free = i === 0 ? gap : starts[i - 1] + said[i - 1].seconds + gap;
        const now = (Date.now() - f.t0) / 1000;
        if (now < free) await sleep((free - now) * 1000);
        starts[i] = (Date.now() - f.t0) / 1000;
    };
    /* Until the last line said is over, with its silence. */
    f.quiet = async () => {
        const i = starts.length - 1;
        if (i < 0) return;
        const end = starts[i] + said[i].seconds + (gaps[i + 1] ?? 0.5);
        const now = (Date.now() - f.t0) / 1000;
        if (now < end) await sleep((end - now) * 1000);
    };
    return { cue, starts };
}
