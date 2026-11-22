#!/usr/bin/env node
/* THE DEMO FILMS: what differs from a chat with Claude or ChatGPT, recorded from the REAL Parley
 * chat UI, never by hand.
 *
 *   node tools/site/make-demo.mjs [name ...]   (all when none; films into docs/shots)
 *
 * Env: PARLEY_DIR (default: the installed clavarium-parley), PLAYWRIGHT (playwright-core's index.mjs),
 * OUT (default docs/shots).
 *
 * Each thread is written with Parley's own host and agent bridge (the code a real conversation uses):
 * doing lines, statuses, a room's AIs (relay), a box's words (by, via voice), a pasted key (the
 * lifted-secret marker Clavarium's host writes in place of the value: drawn as stars). What the
 * application adds is given as its own lines: the request card (Accept / Refuse) and the news lines.
 * The thread goes to ui/parley-ui.js mount() through a load() that grows; this script raises it step
 * by step, typing and tapping in the real screen. Title cards are plain pages. Phone 390x844, light;
 * Playwright records at 1x (the posters are 2x). Invented names, example.com only, fixed day, frozen
 * clock: a run gives the same films.
 * Output: shots/demo-<name>.webm and shots/demo-<name>-poster.png for each film below.
 */
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* Parley as this repository has it installed (node_modules/clavarium-parley), or PARLEY_DIR. */
const PARLEY = process.env.PARLEY_DIR || (await import('../../server/parley.mjs')).packageDir('clavarium-parley');
/* A Playwright of yours (not a dependency of Clavarium): PLAYWRIGHT=/path/to/playwright-core/index.mjs, or one npm can find. */
const PW = process.env.PLAYWRIGHT || 'playwright-core';
const OUT = resolve(process.env.OUT || join(HERE, '..', '..', 'docs', 'shots'));
const { Parley, texts } = await import(pathToFileURL(join(PARLEY, 'host/parley-host.mjs')).href);
const { bridge } = await import(pathToFileURL(join(PARLEY, 'server/parley-mcp.mjs')).href);
const { chromium } = await import(PW.startsWith('/') ? pathToFileURL(PW).href : PW);
const { BRIEF, MATRIX, QUESTION } = await import('./brief.mjs');

const DAY = Date.UTC(2026, 10, 20, 0, 0);
const NOW = Date.UTC(2026, 10, 20, 18, 0);
const tick = () => { const t = Date.now(); while (Date.now() < t + 2) { /* keep the order of lines */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (min) => new Date(DAY + min * 60_000).toISOString();
const hm = (h, m = 0) => h * 60 + m;
/* What Clavarium's host leaves in a message in place of a pasted key (Parley draws it as stars). */
const SECRET = '⟨secret:SECRET_4F2A9C0B1D⟩';
const BOX = (name) => ({ id: `box-${name.toLowerCase().replace(/\W+/g, '-')}`, name, kind: 'box' });

/* The read of a thread, made into one ordered list: its messages and its steps (doing, status) by when
   they were written, the application's own lines put in at their place (`inserts`: [index, line]), each
   laid on the fixed day at the minutes given and numbered (_o): the page shows the first N. The
   throw-away folder is never shown. */
function clean(read, dir, minutes, inserts = []) {
    const r = JSON.parse(JSON.stringify(read).split(join(dir, '..')).join(''));
    const items = [...r.messages.map((x) => ({ k: 'm', x })), ...(r.steps ?? []).map((x) => ({ k: 's', x }))]
        .sort((p, q) => String(p.x.at).localeCompare(String(q.x.at)));
    for (const [i, entry] of inserts) items.splice(i, 0, { k: 'm', x: { from: 'system', level: 'news', ...entry } });
    items.forEach((it, i) => { it.x.at = at(minutes[i] ?? minutes.at(-1)); it.x._o = i; delete it.x.seenAt; });
    const out = { ...r, messages: items.filter((i) => i.k === 'm').map((i) => i.x), steps: items.filter((i) => i.k === 's').map((i) => i.x) };
    for (const p of out.pins ?? []) p.at = at(minutes.at(-1));
    delete out.cursor; delete out.status; delete out.waiting; delete out.pulse;
    return out;
}

/* THE THREADS */
function yourOk(dir) {
    const agent = bridge(dir); const p = new Parley(dir);
    p.say('Anna wants to move Thursday\'s meeting. Answer her.'); agent.read(); tick();
    agent.doing('Reading 3 new mails'); tick();
    agent.doing('Checking Thursday in your calendar'); tick();
    agent.doing('Opening report.pdf'); tick();
    agent.doing('Looking up Anna Berg in your contacts'); tick();
    agent.tell('Thursday 10:00 is free. I drafted a reply to Anna.'); tick();
    agent.status('waiting', 'Waiting for your OK to send the mail.'); tick();
    agent.tell('Sent. Anna has her answer.'); tick();
    agent.tell('To book the meeting room, paste the key of the booking service.'); tick();
    p.say(`Here it is: ${SECRET}`); agent.read(); tick();
    agent.tell('Got it. It never shows in the chat.'); tick();
    return clean(p.read(), dir, [hm(9), hm(9), hm(9), hm(9, 1), hm(9, 1), hm(9, 2), hm(9, 2), hm(9, 2), hm(9, 4), hm(9, 5), hm(9, 6), hm(9, 6)],
        /* The application's request: the mail waits for the person's OK. */
        [[7, { id: 'req-mail', level: 'needs-you', text: 'A mail waits for your OK', topic: { k: 'line-topic-request', t: 'Request' },
            request: { kind: 'mail', title: 'Send this mail to anna.berg@example.com?', sub: 'Re: Thursday meeting',
                facts: [['To', 'anna.berg@example.com'], ['Subject', 'Re: Thursday meeting']],
                quote: 'Hi Anna,\n\nThursday at 10:00 works for me. I will bring the updated figures.\n\nSee you then,\nSam',
                yes: { id: 'send', label: 'Accept' }, no: { id: 'no', label: 'Refuse' } } }]]);
}
function alwaysOn(dir) {
    const agent = bridge(dir); const p = new Parley(dir);
    agent.doing('Checking last night\'s backups'); tick();
    agent.doing('Preparing 3 invoices'); tick();
    agent.tell('Night work done: backups fine, 3 invoices ready for you to check.'); tick();
    agent.doing('Reading 14 new mails'); tick();
    agent.doing('Checking today in your calendar'); tick();
    agent.tell('Good morning. **Today:** 2 meetings, 10:00 and 14:30.\n**Mail:** 14 new, 2 need you.\n**Invoices:** 3 to check.'); tick();
    p.say('Thanks. Remind me to call the bank at 11.'); agent.read(); tick();
    agent.tell('Done. I will remind you at 11:00.'); tick();
    agent.tell('It is 11:00: time to call the bank.'); tick();
    return clean(p.read(), dir, [hm(2), hm(2), hm(2, 1), hm(2, 6), hm(7), hm(7), hm(7, 1), hm(7, 3), hm(8, 30), hm(8, 30), hm(11)],
        [[0, { id: 'wake-2', text: 'Woken: every night at 2:00' }], [4, { id: 'wake-7', text: 'Woken: every day at 7:00' }]]);
}
function aisTogether(dir) {
    /* Each AI for its strength (tools of config/tools.json): Mistral Vibe on a European provider for the
       client's confidential data, Claude Code for the code, Codex (OpenAI) for the picture, made by calling
       OpenAI's image model from its machine with a key the owner gave it. The picture is a demo card the
       script draws, not a photo. */
    const p = new Parley(dir, { room: true });
    const work = join(dir, '..', 'work'); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'product.png'), FILES['product.png'] ?? Buffer.alloc(0));
    const ask = p.say('Make a small product page for our client Lys, with a picture. Their price list stays confidential.').messages.at(-1).id; tick();
    p.relay({ text: 'Confidential part done here, in Europe: 3 products and tone summed up in brief.md, prices left out. Claude Code, can you build the page?', by: { id: 'vibe', name: 'Mistral Vibe', kind: 'ai' }, to: ['claude'], re: ask }); tick();
    p.relay({ text: 'Page built: product.html, 2 commits, no price in the code. Codex, can you make the product picture?', by: { id: 'claude', name: 'Claude Code', kind: 'ai' }, to: ['codex'], re: ask }); tick();
    p.relay({ kind: 'doing', text: 'Making the picture: OpenAI images, with your key', by: { id: 'codex', name: 'Codex', kind: 'ai' } }); tick();
    p.relay({ kind: 'show', text: 'The picture for the page: product.png. Ready for your review.', path: join(work, 'product.png'), by: { id: 'codex', name: 'Codex', kind: 'ai' }, re: ask }); tick();
    p.say('Thanks. I review at 18:00.'); tick();
    return clean(p.read(), dir, [hm(16), hm(16, 4), hm(16, 9), hm(16, 10), hm(16, 12), hm(16, 12), hm(16, 13)],
        [[5, { id: 'cap', text: 'Hand-overs: 2 of 60 this hour' }]]);
}

function home(dir) {
    const agent = bridge(dir); const p = new Parley(dir);
    p.say('What\'s on today?', undefined, [], { via: 'voice', by: BOX('Living room') }); agent.read(); tick();
    agent.tell('Good morning, Marcel. At ten, the nurse comes. At one, lunch with Claire.'); tick();
    p.say('Play the radio.', undefined, [], { via: 'voice', by: BOX('Kitchen') }); agent.read(); tick();
    agent.tell('Playing City Radio on the kitchen box.'); tick();
    p.say('What do I have tomorrow?', undefined, [], { via: 'voice', by: BOX('Kitchen') }); agent.read(); tick();
    agent.tell('Tomorrow: the dentist at nine thirty, then football practice for Leo at five.'); tick();
    return clean(p.read(), dir, [hm(8), hm(8), hm(12), hm(12), hm(18), hm(18)]);
}

function lifeOf(who, account, said, reply) {
    return (dir) => {
        const agent = bridge(dir); const p = new Parley(dir);
        p.say(said); agent.read(); tick();
        agent.doing(`Reading ${account}`); tick();
        agent.tell(reply); tick();
        return clean(p.read(), dir, [hm(9), hm(9), hm(9, 1)]);
    };
}
const work = lifeOf('Work', 'sam@work.example.com', 'Anything urgent at work?', 'At work: 2 mails need you today. The budget review moved to 15:00.');
const personal = lifeOf('Personal', 'sam@home.example.com', 'And at home?', 'At home: the school trip form is due Friday. Nothing else.');
const club = lifeOf('Club', 'board@club.example.com', 'And the club?', 'Club: 3 new members asked to join. The board meets Tuesday.');

/* The browser: the agent works in the person's own tab through Tether (open, read, type: allowed on
   that site; the click that books waits for the person's OK, as Tether's Propose level does). */
function browserThread(dir) {
    const agent = bridge(dir); const p = new Parley(dir);
    const work = join(dir, '..', 'work'); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'booking.png'), FILES['booking.png'] ?? Buffer.alloc(0));
    p.say('Book a table for 4 at Little Bistro, Friday at 8 pm.'); agent.read(); tick();
    agent.doing('Opening bookings.example.com in your browser'); tick();
    agent.doing('Reading the booking page'); tick();
    agent.doing('Filling in: 4 people, Friday, 20:00'); tick();
    agent.show(join(work, 'booking.png'), 'The form, filled in. One click left: Confirm.', { from: join(dir, '..') }); tick();
    agent.status('waiting', 'Waiting for your OK to click Confirm.'); tick();
    agent.tell('Booked: Friday 20:00, 4 people. The confirmation mail is on its way.'); tick();
    return clean(p.read(), dir, [hm(17), hm(17), hm(17, 1), hm(17, 1), hm(17, 2), hm(17, 2), hm(17, 2), hm(17, 4)],
        [[6, { id: 'req-click', level: 'needs-you', text: 'A click waits for your OK', topic: { k: 'line-topic-request', t: 'Request' },
            request: { kind: 'browser', title: 'Click "Confirm booking" on bookings.example.com?', sub: 'Little Bistro · Friday 20:00 · 4 people',
                yes: { id: 'send', label: 'Accept' }, no: { id: 'no', label: 'Refuse' } } }]]);
}
/* The booking page the agent sees: a demo page, rendered by the browser itself (made in run()). */
const FILES = {};
const PRODUCT = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;height:100vh;background:linear-gradient(135deg,#e8f0ec,#f6e7dd);font:700 28px system-ui,sans-serif;color:#1d1d1b}
.c{width:260px;height:260px;border-radius:28px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.12);display:grid;place-items:center;text-align:center}
.c i{display:block;width:110px;height:110px;margin:0 auto 14px;border-radius:50%;background:#2f6f5e}small{display:block;font:600 13px system-ui;color:#888;margin-top:6px}</style></head>
<body><div class="c"><div><i></i>Lys<small>Demo picture</small></div></div></body></html>`;
const BOOKING = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px system-ui,sans-serif;background:#fff;color:#222}
header{background:#7a2e1f;color:#fff;padding:14px 20px;font-weight:700}main{padding:18px 20px}label{display:block;margin:10px 0 4px;color:#555;font-size:14px}
.f{border:1px solid #bbb;border-radius:6px;padding:8px 10px}button{margin-top:16px;background:#7a2e1f;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-weight:700}
small{display:block;margin-top:10px;color:#888}</style></head><body><header>Little Bistro · bookings.example.com</header><main>
<label>People</label><div class="f">4</div><label>Day</label><div class="f">Friday</div><label>Time</label><div class="f">20:00</div>
<button>Confirm booking</button><small>Demo page</small></main></body></html>`;

/* A busy person's daily brief (invented), then the day as an Eisenhower matrix (a Markdown table). */
function brief(dir) {
    const agent = bridge(dir); const p = new Parley(dir);
    agent.doing('Reading 23 new mails'); tick();
    agent.doing('Checking your calendar and your followed topics'); tick();
    agent.tell(BRIEF); tick();
    agent.tell(MATRIX); tick();
    agent.ask(QUESTION[0], QUESTION[1], { recommended: QUESTION[1][0] }); tick();
    return clean(p.read(), dir, [hm(12, 4), hm(12, 4), hm(12, 5), hm(12, 5), hm(12, 6)]);
}

/* THE FILMS: each a script over the real screen. `api`: go, show(n, ms), type(text), tap(label), card(text, ms), poster(). */
const FILMS = {
    /* Home page: the strongest one, under 20 s. */
    'your-ok-mini': { thread: yourOk, async play(a) {
        await a.go('your-ok-mini');
        await a.show(1, 1100); await a.poster();
        await a.show(2, 700); await a.show(3, 700); await a.show(4, 700); await a.show(5, 800);
        await a.show(6, 1300); await a.show(8, 900);
        await a.open('Preview', 3000);
        await a.tap('Accept', 900);
        await a.show(9, 1300); await a.show(10, 1100);
        await a.type('demo-key-not-a-real-one', 20);
        await a.show(11, 1300); await a.show(12, 1600);
        await a.card('You choose what needs your OK.', 2200);
    } },
    'your-ok': { thread: yourOk, async play(a) {
        await a.go('your-ok');
        await a.type('Anna wants to move Thursday\'s meeting. Answer her.', 45);
        await a.show(1, 1500); await a.poster();
        await a.show(2, 1800); await a.show(3, 1800); await a.show(4, 1800); await a.show(5, 2000);
        await a.show(6, 2300); await a.show(7, 1000); await a.show(8, 1500);
        await a.open('Preview', 3500);
        await a.tap('Accept', 1500);
        await a.show(9, 2500); await a.show(10, 2200);
        await a.type('demo-key-not-a-real-one', 40);
        await a.show(11, 2200); await a.show(12, 2800);
        await a.card('You choose what needs your OK.', 3200);
    } },
    'always-on': { thread: alwaysOn, async play(a) {
        await a.go('always-on');
        await a.show(1, 1800); await a.poster();
        await a.show(2, 1600); await a.show(3, 1600); await a.show(4, 2800);
        await a.show(5, 1800); await a.show(6, 1600); await a.show(7, 1600); await a.show(8, 4500);
        await a.type('Thanks. Remind me to call the bank at 11.', 40);
        await a.show(9, 1500); await a.show(10, 2500); await a.show(11, 3500);
        await a.card('It keeps working.<br>You stay in charge.', 3200);
    } },
    'ais-together': { thread: aisTogether, agent: 'Room', async play(a) {
        await a.go('ais-together');
        await a.show(1, 2000); await a.poster();
        await a.show(2, 3000); await a.show(3, 1500); await a.open('Between the AIs', 5000); await a.show(4, 2500); await a.show(5, 3500); await a.show(6, 2500);
        await a.type('Thanks. I review at 18:00.', 45);
        await a.show(7, 3000);
        await a.card('Each AI for its strength.<br>One room.', 3200);
    } },
    'apart-work': { thread: work, agent: 'Work assistant', async play() {} },
    'apart-personal': { thread: personal, agent: 'Personal assistant', async play() {} },
    'apart-club': { thread: club, agent: 'Club assistant', async play() {} },
    /* Work, home, club: three assistants, three machines, three mailboxes; switching between them. */
    apart: { threads: ['apart-work', 'apart-personal', 'apart-club'], async play(a) {
        await a.card('Work. Home. Club.<br>Kept apart.', 2200);
        await a.go('apart-work'); await a.show(1, 1200); await a.poster(); await a.show(2, 1600); await a.show(3, 3200);
        await a.go('apart-personal'); await a.show(1, 1200); await a.show(2, 1600); await a.show(3, 3200);
        await a.go('apart-club'); await a.show(1, 1200); await a.show(2, 1600); await a.show(3, 3200);
        await a.card('One assistant per life.<br>Nothing crosses over.', 3200);
    } },
    browser: { thread: browserThread, async play(a) {
        await a.go('browser');
        await a.type('Book a table for 4 at Little Bistro, Friday at 8 pm.', 40);
        await a.show(1, 1500); await a.poster();
        await a.show(2, 2000); await a.show(3, 2000); await a.show(4, 2200);
        await a.show(5, 4500); await a.show(6, 1000); await a.show(7, 3500);
        await a.tap('Accept', 1500);
        await a.show(8, 3500);
        await a.card('It uses your browser.<br>It asks before it commits.', 3200);
    } },
    brief: { thread: brief, async play(a) {
        await a.go('brief');
        await a.show(1, 1500); await a.show(2, 1500); await a.show(3, 2000); await a.poster();
        await a.scroll(260, 2200); await a.scroll(260, 2200); await a.scroll(300, 2200); await a.scroll(300, 2000);
        await a.show(4, 3500); await a.scroll(400, 2500);
        await a.show(5, 3500);
        await a.card('Your day, in one message.', 2800);
    } },
    home: { thread: home, agent: 'Home assistant', async play(a) {
        await a.go('home');
        await a.show(1, 2200); await a.poster();
        await a.show(2, 4500); await a.show(3, 2200); await a.show(4, 3500); await a.show(5, 2200); await a.show(6, 5000);
        await a.card('A box in every room.', 3200);
    } }
};

const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/ui/parley-ui.css"><style>html,body{margin:0;height:100%}body{background:#fff;font:16px/1.45 system-ui,sans-serif}
#root{height:100vh;box-sizing:border-box;padding:12px;display:flex;flex-direction:column}#root>.parley{flex:1;min-height:0}</style></head>
<body><div id="root"></div><script type="module">
import { mount } from '/ui/parley-ui.js';
const q = new URLSearchParams(location.search);
const all = await (await fetch('/thread/' + q.get('film') + '.json')).json();
const words = await (await fetch('/words.json')).json();
window.shown = 0; window.accepted = false;
mount(document.getElementById('root'), {
  load: async () => {
    const n = window.shown;
    const messages = all.messages.filter((m) => m._o < n).map((m) => (m.request && window.accepted ? { ...m, request: { ...m.request, state: { decision: 'yes', at: m.at } } } : m));
    const steps = (all.steps || []).filter((x) => x._o < n);
    /* A status stands until the agent's next message (as a real agent ends it by talking again). */
    const last = steps.filter((x) => x.kind === 'status').at(-1);
    const after = last && messages.some((m) => m.from === 'agent' && m._o > last._o);
    return { ...all, messages, steps, ...(last && !after ? { status: { state: last.state, note: last.note, at: last.at } } : {}) };
  },
  send: async () => true, words, every: 300, touch: false, act: (id) => { if (id === 'send') window.accepted = true; }, markdown: true,
  agentName: q.get('agent') || 'Assistant', locale: 'en-GB', timeZone: 'UTC', view: 'simple', open: () => {}, picture: (f) => (f && /\\.png$/.test(f.path) ? '/files/' + f.path.split('/').pop() : null) });
document.body.dataset.ready = '1';
</script></body></html>`;

const CARD = (text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#f7f6f2;color:#1d1d1b;font:700 30px/1.25 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
small{display:block;font:600 15px system-ui,sans-serif;color:#2f6f5e;margin-top:16px;letter-spacing:.04em}</style></head>
<body data-ready="1"><div>${text}<small>clavarium.org</small></div></body></html>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function run(names) {
    mkdirSync(OUT, { recursive: true });
    const threads = {};
    {
        const b = await chromium.launch();
        let pg = await b.newPage({ viewport: { width: 420, height: 380 }, deviceScaleFactor: 2 });
        await pg.setContent(BOOKING); FILES['booking.png'] = await pg.screenshot(); await pg.close();
        pg = await b.newPage({ viewport: { width: 420, height: 360 }, deviceScaleFactor: 2 });
        await pg.setContent(PRODUCT); FILES['product.png'] = await pg.screenshot(); await b.close();
    }
    for (const name of names.flatMap((n) => FILMS[n].threads ?? [n])) {
        const base = mkdtempSync(join(tmpdir(), 'parley-demo-'));
        try { threads[name] = FILMS[name].thread(join(base, '.parley')); } finally { rmSync(base, { recursive: true, force: true }); }
    }
    const words = JSON.stringify(texts('en'));
    let cardText = '';
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body; let type = 'text/plain';
        if (url.pathname === '/h.html') { body = HARNESS; type = 'text/html'; }
        else if (url.pathname === '/card.html') { body = CARD(cardText); type = 'text/html'; }
        else if (url.pathname === '/words.json') { body = words; type = 'application/json'; }
        else if (url.pathname.startsWith('/files/') && FILES[url.pathname.slice(7)]) { body = FILES[url.pathname.slice(7)]; type = 'image/png'; }
        else if (url.pathname.startsWith('/thread/')) { const t = threads[url.pathname.slice(8, -5)]; if (t) { body = JSON.stringify(t); type = 'application/json'; } }
        else if (url.pathname.startsWith('/ui/')) {
            const f = resolve(PARLEY, 'ui', url.pathname.slice(4));
            if (f.startsWith(resolve(PARLEY, 'ui')) && existsSync(f)) { body = readFileSync(f); type = TYPES[extname(f)] || 'application/octet-stream'; }
        }
        if (body === undefined) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': type }); res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    try {
        for (const name of names) {
            const film = FILMS[name];
            const vids = mkdtempSync(join(tmpdir(), 'parley-video-'));
            const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-GB', timezoneId: 'UTC',
                recordVideo: { dir: vids, size: { width: 390, height: 844 } } });
            const page = await ctx.newPage();
            /* The frozen clock: just after the film's last line, so nothing reads as late ("No answer yet"). */
            const last = Math.max(...(film.threads ?? [name]).flatMap((t) => [...threads[t].messages, ...(threads[t].steps ?? [])].map((m) => Date.parse(m.at))));
            await page.clock.setFixedTime(new Date(last + 60_000));
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            const box = () => page.getByPlaceholder('Write here').first();
            const started = Date.now();
            let current = name;
            const api = {
                go: async (film) => { current = film; await page.goto(`${base}/h.html?film=${film}&agent=${encodeURIComponent(FILMS[film].agent || 'Assistant')}`); await page.waitForSelector('[data-ready="1"]'); await sleep(400); },
                /* The clock follows the story: just after the newest line shown, so nothing reads as late. */
                show: async (n, ms) => {
                    const t = threads[current]; const shown = [...t.messages, ...(t.steps ?? [])].filter((m) => m._o < n).map((m) => Date.parse(m.at));
                    if (shown.length) await page.clock.setFixedTime(new Date(Math.max(...shown) + 20_000));
                    await page.evaluate((x) => { window.shown = x; }, n); await sleep(ms);
                },
                type: async (text, delay) => { await box().click(); await box().pressSequentially(text, { delay }); await sleep(400); await box().fill(''); },
                tap: async (label, ms) => {
                    const b = page.getByRole('button', { name: label, exact: true }).first();
                    if (!(await b.count())) { errors.push(`no ${label} button`); return; }
                    await b.hover(); await sleep(500); await b.click({ noWaitAfter: true }).catch(() => {}); await sleep(ms);
                },
                open: async (text, ms) => { const t = page.getByText(text).first(); if (await t.count()) { await t.click({ noWaitAfter: true }).catch(() => {}); } else errors.push(`nothing says ${text}`); await sleep(ms); },
                scroll: async (dy, ms) => { await page.mouse.move(195, 400); await page.mouse.wheel(0, dy); await sleep(ms); },
                card: async (text, ms) => { cardText = text; await page.goto(`${base}/card.html`); await sleep(ms); },
                poster: async () => { await page.screenshot({ path: join(OUT, `demo-${name}-poster.png`) }); }
            };
            await film.play(api);
            const seconds = (Date.now() - started) / 1000;
            if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
            const video = page.video();
            await page.close(); await ctx.close();
            copyFileSync(await video.path(), join(OUT, `demo-${name}.webm`));
            rmSync(vids, { recursive: true, force: true });
            console.log(`demo-${name}.webm  ${(statSync(join(OUT, `demo-${name}.webm`)).size / 1024).toFixed(0)} KB  ~${seconds.toFixed(0)} s`);
        }
    } finally { await browser.close(); server.close(); }
}
const asked = process.argv.slice(2);
for (const n of asked) if (!FILMS[n]) { console.error(`no film ${n}: ${Object.keys(FILMS).join(', ')}`); process.exit(2); }
await run(asked.length ? asked : Object.keys(FILMS).filter((n) => !n.startsWith('apart-')));
