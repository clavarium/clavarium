#!/usr/bin/env node
/* SCREENSHOTS OF THE REAL PARLEY CHAT, made from code, never by hand, never from real data.
 *
 *   node tools/site/make-shots.mjs   (pictures into docs/preview/shots)
 *
 * Env: PARLEY_DIR (default: the installed clavarium-parley), PLAYWRIGHT (path to playwright-core's
 * index.mjs), OUT (default docs/preview/shots).
 *
 * How: each demo thread is written with Parley's own host and agent bridge (the same code a real
 * conversation uses) into a throw-away folder; its read() is then handed to the real UI
 * (ui/parley-ui.js mount()) in a small harness page served from here, with the English words of the
 * host's texts('en'). Times are re-laid on a fixed day and the browser clock is frozen on it, so a run
 * gives the same pictures. Invented names, example.com addresses only.
 * Output: shots/chat-<demo>-<tel|ordi>-<light|dark>.png
 */
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* Parley as this repository has it installed (node_modules/clavarium-parley), or PARLEY_DIR. */
const PARLEY = process.env.PARLEY_DIR || (await import('../../server/parley.mjs')).packageDir('clavarium-parley');
/* A Playwright of yours (not a dependency of Clavarium): PLAYWRIGHT=/path/to/playwright-core/index.mjs, or one npm can find. */
const PW = process.env.PLAYWRIGHT || 'playwright-core';
const OUT = resolve(process.env.OUT || join(HERE, '..', '..', 'docs', 'preview', 'shots'));
const { Parley, texts } = await import(pathToFileURL(join(PARLEY, 'host/parley-host.mjs')).href);
const { bridge } = await import(pathToFileURL(join(PARLEY, 'server/parley-mcp.mjs')).href);
const { chromium } = await import(PW.startsWith('/') ? pathToFileURL(PW).href : PW);
const { BRIEF, MATRIX, QUESTION } = await import('./brief.mjs');

/* The fixed day every demo happens on, and the frozen "now" of the browser (that evening). */
const DAY = Date.UTC(2026, 10, 20, 7, 30);
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const tick = () => { const t = Date.now(); while (Date.now() < t + 2) { /* keep the order of lines */ } };

/* Lays the thread on the fixed day: the messages in their order, at the minutes given (one per message). */
function relay(read, minutes) {
    const at = (i) => new Date(DAY + (minutes[i] ?? (minutes.at(-1) + i)) * 60_000).toISOString();
    const map = new Map();
    read.messages.forEach((m, i) => { map.set(m.at, at(i)); m.at = at(i); });
    for (const p of read.pins ?? []) { p.toAt = map.get(p.toAt) ?? p.toAt; p.at = new Date(NOW - 3600_000).toISOString(); }
    delete read.cursor;
    return read;
}

const hm = (h, m = 0) => h * 60 + m - 7 * 60 - 30;
const BOX = (name) => ({ id: `box-${name.toLowerCase().replace(/\W+/g, '-')}`, name, kind: 'box' });

const DEMOS = {
    /* A busy person's daily brief (invented), then the day as an Eisenhower matrix (a Markdown table). */
    brief(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        agent.tell(BRIEF); tick();
        agent.tell(MATRIX); tick();
        agent.ask(QUESTION[0], QUESTION[1], { recommended: QUESTION[1][0] }); tick();
        return { read: relay(p.read(), [hm(12, 5), hm(12, 5), hm(12, 6)]), agentName: 'Assistant', tall: { tel: 1950, ordi: 1500 }, unfold: true };
    },
    /* Family: Marcel talks to the box in his living room; short spoken-style answers; a reminder. */
    family(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        p.say('What\'s on today?', undefined, [], { via: 'voice', by: BOX('Living room') }); agent.read(); tick();
        agent.tell('Good morning, Marcel. Two things today. At ten, the nurse comes. At one, lunch with Claire. It will rain this afternoon.'); tick();
        p.say('Remind me to call Paul at five.', undefined, [], { via: 'voice', by: BOX('Living room') }); agent.read(); tick();
        agent.tell('Done. At five, I will remind you to call Paul.'); tick();
        agent.tell('It is five o\'clock, Marcel. Time to call Paul.'); tick();
        return { read: relay(p.read(), [0, 1, 3, 4, 570]), agentName: 'Home assistant' };
    },
    /* Coding agents: the agent asks with two buttons, the person taps one. */
    coding(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        p.say('Fix the login bug on the shop site, then tell me.'); agent.read(); tick();
        agent.tell('Found it: the session expired after 5 minutes instead of 60. Two ways to fix it.'); tick();
        agent.ask('Which fix do you prefer?', ['Set the timeout to 60 min', 'Refresh the session on each click']); tick();
        const q = p.read().messages.at(-1).id;
        p.say('Refresh the session on each click', q); agent.read(); tick();
        agent.tell('Done. Tests pass (42 of 42). Two commits are ready for your review.'); tick();
        return { read: relay(p.read(), [0, 6, 7, 9, 21]), agentName: 'shop-site' };
    },
    /* Mail & calendar assistant: it proposes a reply, the person sends or edits. */
    mail(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        agent.tell('3 new mails this morning. Two are newsletters. One needs you: Anna Berg asks to move Thursday\'s meeting. I drafted a reply.'); tick();
        const read = relay(p.read(), [0]);
        read.messages.push({ from: 'system', id: 'req-1', at: new Date(DAY + 60_000).toISOString(), level: 'needs-you', text: 'A reply waits for you',
            topic: { k: 'line-topic-request', t: 'Request' },
            request: { kind: 'mail', title: 'Reply to Anna Berg', sub: 'anna.berg@example.com',
                facts: [['To', 'anna.berg@example.com'], ['Subject', 'Re: Thursday meeting']],
                quote: 'Hi Anna,\n\nThursday at 10:00 works for me. See you then.\n\nBest,\nSam',
                yes: { id: 'send', label: 'Send' }, no: { id: 'no', label: 'Refuse' }, more: { id: 'edit', label: 'Edit' } } });
        return { read, agentName: 'Mail assistant' };
    },
    /* Rooms: two AIs hand over in a room, with the limit line. */
    rooms(dir) {
        const p = new Parley(dir, { room: true });
        const ask = p.say('Plan Saturday: a dinner for six, and the shopping list.').messages.at(-1).id; tick();
        p.relay({ text: 'Menu: leek soup, roast chicken, apple tart. I hand the list to Shopper.', by: { id: 'chef', name: 'Chef', kind: 'ai' }, re: ask }); tick();
        p.relay({ text: 'Shopping list ready: 14 items, one shop. Delivery Saturday 9:00?', by: { id: 'shopper', name: 'Shopper', kind: 'ai' }, re: ask }); tick();
        const read = relay(p.read(), [0, 2, 4]);
        read.messages.push({ from: 'system', id: 'cap-1', at: new Date(DAY + 5 * 60_000).toISOString(), level: 'news', text: 'Hand-overs: 1 of 60 this hour' });
        return { read, agentName: 'Saturday', room: true };
    },
    /* Chat from anywhere: a dictated message, a file shown, a pinned rule. */
    parley(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        mkdirSync(join(dir, '..', 'work'), { recursive: true });
        writeFileSync(join(dir, '..', 'work', 'report.pdf'), '%PDF-1.4 demo\n');
        const rule = p.say('Rule: never send a mail without asking me.').messages.at(-1).id; agent.read(); tick();
        agent.tell('Understood. I will always ask first.'); tick();
        p.say('Add the meeting notes to the report and send me the PDF.', undefined, [], { via: 'voice' }); agent.read(); tick();
        agent.show(join(dir, '..', 'work', 'report.pdf'), 'The report, with the notes on page 3.', { from: join(dir, '..') }); tick();
        agent.status('done', 'The report is ready.');
        p.pin(rule);
        /* The throw-away folder is never shown: its files read as the agent's own /work. */
        const base = join(dir, '..');
        const read = JSON.parse(JSON.stringify(p.read()).split(base).join(''));
        return { read: relay(read, [0, 1, 300, 304]), agentName: 'Assistant', view: 'detailed' };
    },
    /* Home and voice: questions and the radio, from the kitchen box. */
    home(dir) {
        const agent = bridge(dir); const p = new Parley(dir);
        p.say('What do I have tomorrow?', undefined, [], { via: 'voice', by: BOX('Kitchen') }); agent.read(); tick();
        agent.tell('Tomorrow: the dentist at nine thirty, then football practice for Leo at five.'); tick();
        p.say('Play the radio.', undefined, [], { via: 'voice', by: BOX('Kitchen') }); agent.read(); tick();
        agent.tell('Playing City Radio on the kitchen box.'); tick();
        return { read: relay(p.read(), [600, 601, 602, 602]), agentName: 'Home assistant' };
    }
};

const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/ui/parley-ui.css"><style>html,body{margin:0;height:100%}body{background:#fff;font:16px/1.45 system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#0f1115}}#root{height:100vh;box-sizing:border-box;padding:12px;display:flex;flex-direction:column}#root>.parley{flex:1;min-height:0}</style></head>
<body><div id="root"></div><script type="module">
import { mount } from '/ui/parley-ui.js';
const name = new URLSearchParams(location.search).get('demo');
const demo = await (await fetch('/demo/' + name + '.json')).json();
const words = await (await fetch('/words.json')).json();
mount(document.getElementById('root'), { load: async () => demo.read, send: async () => {}, words, every: 0, touch: false, act: () => {},
  markdown: true, agentName: demo.agentName, locale: 'en-GB', timeZone: 'UTC', view: demo.view || 'simple', open: () => {} });
document.body.dataset.ready = '1';
</script></body></html>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

async function main() {
    mkdirSync(OUT, { recursive: true });
    const data = {};
    for (const [name, make] of Object.entries(DEMOS)) {
        const base = mkdtempSync(join(tmpdir(), 'parley-demo-'));
        try { data[name] = make(join(base, '.parley')); } finally { rmSync(base, { recursive: true, force: true }); }
    }
    const words = JSON.stringify(texts('en'));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body; let type = 'text/plain';
        if (url.pathname === '/h.html') { body = HARNESS; type = 'text/html'; }
        else if (url.pathname === '/words.json') { body = words; type = 'application/json'; }
        else if (url.pathname.startsWith('/demo/')) { const d = data[url.pathname.slice(6).replace(/\.json$/, '')]; if (d) { body = JSON.stringify(d); type = 'application/json'; } }
        else if (url.pathname.startsWith('/ui/')) {
            const f = resolve(PARLEY, 'ui', url.pathname.slice(4));
            if (f.startsWith(resolve(PARLEY, 'ui')) && existsSync(f)) { body = readFileSync(f); type = TYPES[extname(f)] || 'application/octet-stream'; }
        }
        if (body === undefined) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': type }); res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const browser = await chromium.launch();
    const made = [];
    try {
        for (const [size, vp] of [['tel', { width: 390, height: 640 }], ['ordi', { width: 800, height: 500 }]]) {
            for (const scheme of ['light', 'dark']) {
                const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'UTC' });
                for (const name of Object.keys(DEMOS)) {
                    const page = await ctx.newPage();
                    if (data[name].tall) await page.setViewportSize({ width: vp.width, height: data[name].tall[size] });
                    await page.clock.setFixedTime(new Date(NOW));
                    const errors = [];
                    page.on('pageerror', (e) => errors.push(e.message));
                    await page.goto(`http://127.0.0.1:${port}/h.html?demo=${name}`);
                    await page.waitForSelector('[data-ready="1"]');
                    await page.waitForTimeout(600);
                    if (data[name].unfold) { for (const b of await page.getByText('See more', { exact: false }).all()) await b.click().catch(() => {}); await page.waitForTimeout(500); }
                    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
                    const file = join(OUT, `chat-${name}-${size}-${scheme}.png`);
                    await page.screenshot({ path: file });
                    made.push(file);
                    await page.close();
                }
                await ctx.close();
            }
        }
    } finally { await browser.close(); server.close(); }
    console.log(made.join('\n'));
}
await main();
