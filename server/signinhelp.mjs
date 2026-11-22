/* DELEGATED SIGN-IN (15-11, #362): a tool that must sign in, served by ANOTHER conversation.
 *
 * A tool (Claude Code, Codex...) that is not signed in, at its start or signed out on the way, shows a
 * link to open in a browser. Its screen-watch (config/launch/screen-watch.mjs) reads it there, by the
 * rules of config/tools.json ("signin.screen"), and asks here where it goes, in its chat folder:
 *
 *   signin-ask.json     { id, at, link, around, told? }   written by screen-watch (the machine: untrusted)
 *   signin-route.json   { id, route, companion? }         written here: companion, person or done
 *
 * THE COMPANION: a conversation whose agent drives a browser the person already signed in to (Tether's
 * browser verbs). One for all, set in Settings, and/or one per conversation that wins over it. They may
 * cross (A helps B, B helps C, C helps A); one that cannot serve (asleep, its chat off, no browser,
 * signing in itself) is passed over for another companion that can -- so the last one signed in serves
 * the others. A companion never serves itself.
 *
 * WHAT HAPPENS. The link is written in the companion's docket folder (a file of its work folder, nowhere
 * else), and an event of kind KIND is posted to its docket: open it in its browser, let the person click
 * Authorize, read the code the page shows, give it back as the note of `docket done`. That note is typed
 * here into the asking tool, once. The asking chat says
 * one line ("Signing in through « B »...") with a button that shows the link to the person instead.
 * No answer in WAIT_MS, a failure, or no code: the link goes to the person, as before.
 *
 * WHAT IS KEPT AWAY. The link and the code are never in a log, a chat line, an alert, or this server's
 * files: the link only in the companion's docket folder (taken away when it is over), the code only in its
 * docket's answer (Dockets hides it from its chat and its owner's view), then typed. A code is typed once.
 * The link must be HTTPS and lead to a domain the tool declares ("signin.links"): an agent that writes a
 * forged ask in its own chat folder can have the companion open nothing else -- and the person still
 * sees the page and decides to click. No link is made here, none is reachable without signing in.
 *
 * THE PERSON'S OWN CODE (22-11, #405). Told the link, the person gets a line in the chat with a button that opens
 * a small field. What is pasted there comes to enterCode: checked, typed into the tool once, and kept nowhere (not
 * the thread, the inbox, a log, an event). A chat message is never typed as a code: the secret scan treats it as any
 * other message.
 */
import { lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CODE } from '../config/launch/screen-watch.mjs';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';

export const KIND = 'signin-help';
export const ASK = 'signin-ask.json';
export const ROUTE = 'signin-route.json';
/* The folders of a work folder they live in: its chat's (talk.mjs FOLDER) and its docket's (dockets.mjs FOLDER). */
export const CHAT = '.parley';
export const DOCKET = '.docket';
export const WAIT_MS = 10 * 60_000;
/* How long after its tool asked its code field stays open. */
export const CODE_WAIT_MS = 30 * 60_000;
export const TICK_MS = 3000;
/* How often the screen of a tool told its link is read, until it shows its code prompt. */
export const OFFER_EVERY_MS = 6000;
const SCREEN_LINES = 12;
export const CODE_LINE = 'Once signed in, paste the code.';
export const CODE_SENT = 'Code sent to the tool.';
export const NONE = 'none';
const ASK_BYTES = 16_384;
const LINK_MAX = 4000;
const AROUND_MAX = 1000;
const ID = /^[0-9a-f-]{8,64}$/;
/* Tether's levels that may open a page (watch only reads). */
const ACTS = (level) => Boolean(level) && level !== 'off' && level !== 'watch';

const inDomain = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));
/* A link the tool may send the companion to: HTTPS, to one of its declared domains, no user part. */
export function linkAllowed(link, domains = []) {
    if (typeof link !== 'string' || link.length > LINK_MAX || /\s/.test(link)) return false;
    let u; try { u = new URL(link); } catch { return false; }
    return u.protocol === 'https:' && !u.username && !u.password && inDomain(u.hostname.toLowerCase(), domains);
}
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/* The code typed into the tool, then Enter. Never logged. */
export async function typeInto(vms, name, text) {
    const tmux = ['tmux', '-L', SOCKET, 'send-keys', '-t', `=${SESSION}:`];
    if ((await vms.exec(name, [...tmux, '-l', '--', text], { timeoutMs: 30_000 })).code !== 0) return false;
    return (await vms.exec(name, [...tmux, 'Enter'], { timeoutMs: 30_000 })).code === 0;
}

export class SigninHelp {
    #store; #conversations; #tools; #awake; #chatOn; #work; #browsers; #post; #type; #event; #now; #exec;
    /* asker -> { id (its ask), companion, event (the docket event's id), at, file, code (a code is awaited) } */
    #open = new Map();
    /* asker -> the id of the last ask looked at: each is routed once. */
    #seen = new Map();
    #busy = false;
    /* asker -> the ask whose field was offered in its chat; when its screen was last read for that; a code being typed. */
    #offered = new Map();
    #looked = new Map();
    #typing = new Set();

    /* `store`: { get(), set(v) } of { general, per: { name: companion | NONE } }. `conversations()`: [{ name, tool }].
       `tools()`: config/tools.json as read. `awake()`, `chatOn(name)`. `workFolder(name)`. `browsers(name)`: the
       browser targets it was given, [{ id, level }]. `post(name, {kind, text, data})`: its docket. `type(name, text)`:
       typed into its tool, then Enter (resolves true when typed). `event(name, line)`: a line in its chat.
       `exec(name, argv, options)`: a command in its machine (to read its tool's screen). */
    constructor({ store, conversations, tools, awake, chatOn, workFolder, browsers, post, type, event = () => {}, now = () => Date.now(), exec = null }) {
        this.#exec = exec;
        this.#store = store; this.#conversations = conversations; this.#tools = tools; this.#awake = awake; this.#chatOn = chatOn;
        this.#work = workFolder; this.#browsers = browsers; this.#post = post; this.#type = type; this.#event = event; this.#now = now;
    }

    #settings() { const s = this.#store.get() ?? {}; return { general: typeof s.general === 'string' ? s.general : '', per: s.per && typeof s.per === 'object' ? { ...s.per } : {}, clicks: s.clicks === true }; }
    #exists(name) { return this.#conversations().some((c) => c.name === name); }
    #usable(name) { try { return (this.#browsers(name) ?? []).filter((b) => ACTS(b.level)); } catch { return []; } }

    /* FOR THE PAGE: the general companion, each conversation's own, and which of them has a browser to open with. */
    view() {
        const s = this.#settings();
        const named = new Set([s.general, ...Object.values(s.per)].filter((c) => c && c !== NONE));
        return { general: s.general, per: s.per, clicks: s.clicks, browsers: Object.fromEntries([...named].map((c) => [c, this.#usable(c).map((b) => b.id)])) };
    }
    /* '' for none. */
    setGeneral(companion) {
        if (typeof companion !== 'string' || (companion && !this.#exists(companion))) throw new Refusal(400, 'Give a conversation, or nothing for none.');
        this.#store.set({ ...this.#settings(), general: companion });
        return this.view();
    }
    /* THE COMPANION CLICKS « AUTHORIZE » ITSELF (15-11, its owner's go): off unless its owner says so; then the
       person has nothing to do. Only that button, on the page the link opened -- nothing else is clicked. */
    setClicks(on) {
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say true or false.');
        this.#store.set({ ...this.#settings(), clicks: on });
        return this.view();
    }
    /* null: as the general one; NONE: none for it; else that conversation -- never itself. */
    setFor(name, companion) {
        if (!this.#exists(name)) throw new Refusal(404, 'No such conversation.');
        if (companion !== null && (typeof companion !== 'string' || (companion !== NONE && !this.#exists(companion)))) throw new Refusal(400, 'Give a conversation, "none", or null for the general one.');
        if (companion === name) throw new Refusal(400, 'A conversation cannot sign itself in: choose another one.');
        const s = this.#settings();
        if (companion === null) delete s.per[name]; else s.per[name] = companion;
        this.#store.set(s);
        return this.view();
    }
    /* WHO SIGNS `name` IN: its own companion, else the general one; one that cannot serve now is passed over
       for any other companion that can (crossed companions, the last one signed in). Never itself. */
    companionFor(name) {
        const s = this.#settings();
        const own = s.per[name];
        if (own === NONE) return null;
        const chosen = own ?? s.general;
        if (!chosen) return null;
        const awake = new Set(this.#awake());
        const can = (c) => c && c !== NONE && c !== name && this.#exists(c) && awake.has(c) && this.#chatOn(c) && !this.#open.has(c) && this.#usable(c).length > 0;
        if (can(chosen)) return chosen;
        return [...new Set([s.general, ...Object.values(s.per)])].find(can) ?? null;
    }

    #chat(name) { return join(this.#work(name), CHAT); }
    #own(dir) { const i = lstatSync(dir, { throwIfNoEntry: false }); return i !== undefined && i.isDirectory() && !i.isSymbolicLink(); }
    #readAsk(name) {
        const dir = this.#chat(name);
        if (!this.#own(dir)) return null;
        const i = lstatSync(join(dir, ASK), { throwIfNoEntry: false });
        if (!i || !i.isFile() || i.size > ASK_BYTES) return null;
        try { const a = JSON.parse(readFileSync(join(dir, ASK), 'utf8')); return a && typeof a === 'object' && ID.test(String(a.id)) ? a : null; } catch { return null; }
    }
    #route(name, route) {
        const dir = this.#chat(name);
        if (!this.#own(dir)) return;
        try { writeFileSync(join(dir, `.${ROUTE}.new`), JSON.stringify(route)); renameSync(join(dir, `.${ROUTE}.new`), join(dir, ROUTE)); } catch { /* its chat folder cannot be written: screen-watch tells the person itself */ }
    }
    /* The ask is the person's to answer: told the link, or routed to them, a short while ago. */
    #personsAsk(name) {
        const ask = this.#readAsk(name); if (!ask) return null;
        const at = Date.parse(ask.at); if (!Number.isFinite(at) || this.#now() - at > CODE_WAIT_MS || at > this.#now() + 60_000) return null;
        if (this.#open.has(name)) return null;
        if (ask.told === true) return ask;
        const route = this.#readRoute(name);
        return route?.id === ask.id && route.route === 'person' ? ask : null;
    }
    /* DURING AN UPDATE: a tool started before #405 keeps its old screen-watch until it restarts (the launcher is read at
       its start), and that one types the next code-like message of the chat. Its ask has no `field`. Such a message is
       then lifted whole as a secret: what reaches the inbox is a marker, which it cannot take for a code. */
    oldWatcherArmed(name, text) {
        if (!CODE.test(String(text ?? '').trim())) return false;
        const ask = this.#personsAsk(name);
        return ask !== null && ask.field !== true;
    }
    /* THE CODE PASTED IN ITS FIELD (#405). Typed once, only while its tool shows its prompt; the value is in no answer,
       no error, no log, no file. */
    async enterCode(name, value) {
        if (!this.#exists(name)) throw new Refusal(404, 'No such conversation.');
        const code = typeof value === 'string' ? value.trim() : '';
        if (!CODE.test(code)) throw new Refusal(400, 'This is not a sign-in code.');
        const ask = this.#personsAsk(name);
        if (!ask) throw new Refusal(409, 'No sign-in is waiting for a code here.');
        if (this.#typing.has(name)) throw new Refusal(409, 'A code is already being sent.');
        this.#typing.add(name);
        try {
            const exec = (argv, options) => this.#exec(name, argv, options);
            const at = this.#exec ? await this.atCodePrompt(name, exec).catch(() => false) : false;
            if (!at) throw new Refusal(409, 'Its tool is not waiting for a code now.');
            const typed = await Promise.resolve(this.#type(name, code)).catch(() => false);
            if (!typed) throw new Refusal(502, 'The code could not be typed into the tool.');
            /* Typed: the ask is over, whatever comes next is not this code. */
            const dir = this.#chat(name);
            if (this.#own(dir)) { try { rmSync(join(dir, ASK), { force: true }); } catch { /* it runs out by itself */ } }
            this.#route(name, { id: ask.id, route: 'done' });
            this.#offered.delete(name); this.#looked.delete(name);
            this.#line(name, { kind: KIND, text: CODE_SENT, topic: 'Sign-in', brief: 'Code sent' });
            return { ok: true };
        } finally { this.#typing.delete(name); }
    }
    /* Its tool shows its prompt, its link told: one line in its chat, with the button that opens the field. */
    async #offerCode(name, ask) {
        if (ask.told !== true || !this.#exec || this.#offered.get(name) === ask.id || this.#open.has(name)) return;
        if (this.#now() - (this.#looked.get(name) ?? -Infinity) < OFFER_EVERY_MS) return;
        this.#looked.set(name, this.#now());
        const at = await this.atCodePrompt(name, (argv, options) => this.#exec(name, argv, options)).catch(() => false);
        if (!at || this.#readAsk(name)?.id !== ask.id) return;
        this.#offered.set(name, ask.id);
        this.#line(name, { kind: KIND, text: CODE_LINE, level: 'needs-you', topic: 'Sign-in', brief: 'Paste the code', actions: ['signincode'] });
    }
    /* ITS TOOL IS AT ITS « PASTE THE CODE » PROMPT (22-11, seen on a real machine): a line typed now goes into that field
       and the sign-in fails. Asked of its screen, only while a sign-in is open and its tool has such a prompt. */
    async atCodePrompt(name, exec) {
        const ask = this.#readAsk(name); if (!ask) return false;
        const at = Date.parse(ask.at); if (!Number.isFinite(at) || this.#now() - at > CODE_WAIT_MS) return false;
        const rules = (this.#tool(name)?.signin?.screen ?? []).filter((r) => String(r).startsWith('code:')).map((r) => String(r).slice(5));
        if (!rules.length) return false;
        const r = await exec(['tmux', '-L', SOCKET, 'capture-pane', '-p', '-t', `=${SESSION}:`], { timeoutMs: 10_000 });
        if (r.code !== 0) return false;
        /* As screen-watch reads it: the bottom of the screen, whatever the case. A prompt left higher up is over, and a
           code typed then would go to the AI as a message. */
        const bottom = String(r.stdout).replace(/\s+$/u, '').split('\n').slice(-SCREEN_LINES).join('\n');
        return rules.some((p) => { try { return new RegExp(p, 'i').test(bottom); } catch { return false; } });
    }
    #readRoute(name) { try { return JSON.parse(readFileSync(join(this.#chat(name), ROUTE), 'utf8')); } catch { return null; } }
    #line(name, line) { try { this.#event(name, line); } catch { /* its chat may be off */ } }
    #tool(name) { const id = this.#conversations().find((c) => c.name === name)?.tool; return this.#tools().find((t) => t.id === id); }

    /* Every few seconds: each new ask routed; what waited too long given back to the person. */
    async tick() {
        if (this.#busy) return;
        this.#busy = true;
        try {
            for (const [name, o] of [...this.#open]) if (this.#now() - o.at > WAIT_MS) this.#toPerson(name, `« ${o.companion} » did not answer in ${Math.round(WAIT_MS / 60_000)} minutes: the sign-in link is shown to you.`);
            const offers = [];
            for (const name of this.#awake()) {
                if (!this.#chatOn(name)) continue;
                const ask = this.#readAsk(name);
                if (!ask) continue;
                if (this.#seen.get(name) !== ask.id) { this.#seen.set(name, ask.id); this.#ask(name, ask); }
                offers.push(this.#offerCode(name, ask).catch(() => {}));
            }
            await Promise.all(offers);
        } finally { this.#busy = false; }
    }

    #ask(name, ask) {
        const before = this.#readRoute(name);
        /* Already routed (this server restarted meanwhile): what was handed over and is no longer followed goes to the person. */
        if (before?.id === ask.id) { if (before.route === 'companion' && !this.#open.has(name)) this.#route(name, { id: ask.id, route: 'person' }); return; }
        /* Told to the person already (this server was late): nobody else. */
        if (ask.told === true) return;
        const tool = this.#tool(name);
        const companion = this.companionFor(name);
        if (!companion || !tool?.signin || !linkAllowed(ask.link, tool.signin.links)) { this.#route(name, { id: ask.id, route: 'person' }); return; }
        /* The link, in the companion's docket folder only: its agent reads it there, nobody else is told it. */
        const docket = join(this.#work(companion), DOCKET);
        const file = `signin-${ask.id.slice(0, 8)}.txt`;
        const target = this.#usable(companion)[0].id;
        const code = (tool.signin.screen ?? []).some((r) => r.startsWith('code:'));
        let event;
        try {
            /* The link itself is not in the event (an event is shown to the companion's owner): only where it is. */
            const at = `/work/${DOCKET}/${file}`;
            event = this.#post(companion, { kind: KIND, text: `Sign in « ${name} » (${tool.label}) with your browser. 1) tether browser ${target} open "$(head -n1 ${at})" `
                + (this.#settings().clicks
                    ? '2) Your owner allowed you: on that page only, click the button that authorizes (Authorize, Allow, Continue, Accept) -- nothing else, no other page. '
                    : '2) Tell your person, one line: "Click Authorize in your browser". ')
                + (code ? `3) Read the code the page then shows (tether browser ${target} html --readable). 4) docket done ID "<the code>": the code alone, never in a chat. ` : '3) Once the page says it is done: docket done ID "ok". ')
                + 'Over 10 min old, or not possible: docket failed ID "why".', data: { conversation: name, tool: tool.id, link: at, browser: target } });
            if (!this.#own(docket)) throw new Error('its docket folder is not its own');
            writeFileSync(join(docket, file), `${ask.link}\n${ask.around ? `\nBeside the link on its screen (a code to type on the page, maybe):\n${String(ask.around).slice(0, AROUND_MAX)}\n` : ''}`);
        } catch { this.#route(name, { id: ask.id, route: 'person' }); return; }
        this.#open.set(name, { id: ask.id, companion, event: event.id, at: this.#now(), file: join(docket, file), code });
        this.#route(name, { id: ask.id, route: 'companion', companion });
        this.#line(name, { kind: KIND, text: `Signing in through « ${companion} »…`, topic: 'Sign-in', brief: companion, actions: ['signinlink'] });
    }

    #end(name, route) {
        const o = this.#open.get(name);
        if (!o) return null;
        this.#open.delete(name);
        rmSync(o.file, { force: true });
        this.#route(name, { id: o.id, route });
        return o;
    }
    #toPerson(name, why) { if (this.#end(name, 'person')) this.#line(name, { kind: KIND, text: why, tone: 'warn', topic: 'Sign-in' }); }

    /* THE COMPANION ANSWERED (Dockets, on an ack of a KIND event). `e`: { event, ack }. The note is never kept or said. */
    async acked(companion, e) {
        if (e?.event?.kind !== KIND) return;
        const name = [...this.#open].find(([, o]) => o.event === e.event.id && o.companion === companion)?.[0];
        if (!name) return;
        const o = this.#open.get(name);
        if (e.ack?.kind !== 'done') { this.#toPerson(name, `« ${companion} » could not sign it in (${cut(e.ack?.note, 120)}): the sign-in link is shown to you.`); return; }
        if (!o.code) { this.#end(name, 'done'); this.#line(name, { kind: KIND, text: `Signed in through « ${companion} ».`, topic: 'Sign-in', brief: 'Signed in' }); return; }
        const note = String(e.ack.note ?? '').trim();
        if (!CODE.test(note)) { this.#toPerson(name, `« ${companion} » gave back no code: the sign-in link is shown to you.`); return; }
        /* Once: taken out of what waits before it is typed. */
        this.#end(name, 'done');
        const typed = await Promise.resolve(this.#type(name, note)).catch(() => false);
        if (typed) this.#line(name, { kind: KIND, text: `Signed in through « ${companion} ».`, topic: 'Sign-in', brief: 'Signed in' });
        else { this.#route(name, { id: o.id, route: 'person' }); this.#line(name, { kind: KIND, text: 'The code could not be typed into the tool: the sign-in link is shown to you.', tone: 'warn', topic: 'Sign-in' }); }
    }

    /* THE PERSON ASKED for the link (the button of the line): shown to them, the companion's answer no longer awaited. */
    showLink(name) {
        if (!this.#open.has(name)) throw new Refusal(409, 'No sign-in is waiting for another conversation here.');
        this.#toPerson(name, 'The sign-in link is shown to you.');
        return { ok: true };
    }
    /* Is a sign-in of `name` waiting for a companion? (the page's line, its button) */
    waiting(name) { const o = this.#open.get(name); return o ? { companion: o.companion, since: new Date(o.at).toISOString() } : null; }

    start(everyMs = TICK_MS) {
        const timer = setInterval(() => { void this.tick(); }, everyMs);
        timer.unref?.();
        return timer;
    }
}
