/* BROWSERS, THROUGH TETHER (08-11): a person's real Chrome or Firefox, paired once through the Tether extension, is a
 * target like a mailbox -- an asset given to a conversation at a level (Off / Read / All with approval / All / Custom).
 * The tabs the person grants in the extension's popup are all an AI can touch; Tether's browser connector refuses any
 * other tab before anything is sent, and the extension refuses it again on its side.
 *
 * THE EXTENSION CONNECTS OUT, to BROWSER_PATH on this server's public address (wss://), under /c/: the front lets /c/
 * through without the web sign-in (deploy/install.sh, skip_auth_routes), as it does for paired devices and voice boxes.
 * The extension cannot sign in; its right is the token it was handed when it was paired, and nothing else.
 *
 * PAIRING. A new extension says { t:"pair", code }: it waits here, in the lobby, its code shown in its popup. The person
 * types that code in Assets › New › Browser (pair): the socket goes to that target's own connector (one per browser,
 * Tether's `browser()`), which mints a long-lived token and hands it over. From then on the extension says
 * { t:"hello", token } each time it connects -- every start of the browser -- and is that browser again, with no code.
 * Paired again only when the person removes it (or pairs it again from its panel).
 *
 * TOKENS ARE NEVER KEPT IN CLEAR: only their SHA-256 (tether-browser-tokens.json). Never logged, never answered, never
 * journaled (Tether journals no token either). A code is never logged.
 *
 * RATE LIMITS, since the endpoint is open to anyone who reaches the address: new sockets per address and minute, sockets
 * waiting unpaired (per address and in all), a waiting socket dropped after a while, a message of a socket not yet paired
 * kept small; and on the person's side, wrong codes counted -- too many in a while, pairing waits. Two sockets offering
 * the same code are both refused (nobody can take a code someone else shows).
 */
import { createHash } from 'node:crypto';
import { browser as browserConnector } from 'clavarium-tether/connectors/browser';
import { no } from 'clavarium-tether/verbs';
import { JsonFile } from './store.mjs';
import { Refusal } from './conversations.mjs';

export const BROWSER_PATH = '/c/api/browser';
export const VERBS = ['browser.tabs', 'browser.open', 'browser.shot', 'browser.html', 'browser.console', 'browser.eval', 'browser.click', 'browser.type', 'browser.key', 'browser.scroll', 'browser.drag'];
/* The acting verbs, each set Yes or Ask under Custom (a verb rule of Tether's, at level frame). */
export const ACTS = ['browser.open', 'browser.click', 'browser.type', 'browser.key', 'browser.scroll', 'browser.drag', 'browser.eval'];
/* A socket's message: a screenshot comes back as a data URL. */
export const MESSAGE_MAX = 32 * 1024 * 1024;
/* What a socket not yet paired may say at once (hello, pair, its tabs). */
export const LOBBY_MESSAGE_MAX = 256 * 1024;
export const LOBBY_MAX = 50;
export const LOBBY_PER_ADDRESS = 4;
export const LOBBY_MS = 15 * 60_000;
export const CONNECTS_PER_MINUTE = 20;
export const WRONG_MAX = 5;
export const WRONG_WINDOW_MS = 10 * 60_000;
const TITLE_MAX = 80;
export const SITES_MAX = 100;

const hash = (token) => createHash('sha256').update(String(token)).digest('hex');
const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const isLoop = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip ?? ''));

/* Who connects: the address the front saw (the last one before it in X-Forwarded-For), else the socket's own. */
export function addressOf(request) {
    const own = request?.socket?.remoteAddress ?? '';
    if (!isLoop(own)) return own;
    const list = String(request?.headers?.['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = list.length - 1; i >= 0; i--) if (!isLoop(list[i])) return list[i];
    return own;
}

export class Browsers {
    #tokens; #store; #now; #log; #make;
    #inst = new Map();          /* target id -> Tether's browser connector for it */
    #lobby = new Set();         /* sockets not paired yet */
    #connects = new Map();      /* address -> times of its recent sockets */
    #wrong = [];                /* times of recent wrong codes */
    #listeners = new Set();
    #timer = null;

    /* `store()`: Tether's store (targets). `log(line)`: never handed a token or a code. `make`: the connector (tests). */
    constructor({ dataDir, store, now = () => Date.now(), log = () => {}, make = browserConnector } = {}) {
        this.#tokens = new JsonFile(dataDir ? `${dataDir}/tether-browser-tokens.json` : '', {});
        this.#store = store; this.#now = now; this.#log = log; this.#make = make;
        this.#timer = setInterval(() => this.#sweep(), 60_000); this.#timer.unref?.();
    }

    onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #changed() { for (const fn of this.#listeners) { try { fn(); } catch { /* its fault */ } } }

    /* ONE TARGET'S TOKENS, as Tether's connector asks for them: kept as hashes. */
    #tokensOf(id) {
        const read = () => this.#tokens.get()[id] ?? [];
        const write = (list) => { const all = this.#tokens.get(); if (list.length) all[id] = list; else delete all[id]; this.#tokens.set(all); };
        return {
            has: (t) => read().includes(hash(t)),
            add: (t) => { const h = hash(t); const l = read(); if (!l.includes(h)) write([...l, h]); },
            remove: (t) => { const h = hash(t); write(read().filter((x) => x !== h)); },
            list: () => [],
        };
    }
    #of(id) {
        let i = this.#inst.get(id);
        if (!i) { i = this.#make({ tokens: this.#tokensOf(id) }); i.onChange(() => this.#changed()); this.#inst.set(id, i); }
        return i;
    }
    #targets() { try { return (this.#store()?.targets() ?? []).filter((t) => t.kind === 'browser' && t.connector === 'browser'); } catch { return []; } }

    /* THE CONNECTOR THE KEEPER IS GIVEN (connectors.browser): each call goes to its own browser's connector. Rights and
       approvals were applied by the keeper before; this only carries the call. */
    get connector() {
        const self = this;
        return {
            name: 'browser',
            verbs: VERBS,
            async run(verb, target, a, ctx) {
                const i = self.#inst.get(target.id);
                if (!i?.status().connected) no(`${target.title} is not connected: open that browser, with the Tether extension on`);
                return i.run(verb, target, a, ctx);
            },
            /* The site of a granted tab's page, for Tether's site rules (frame: the sites the person allowed). */
            siteOf(target, a) { try { return self.#inst.get(target.id)?.siteOf?.(target, a) ?? ''; } catch { return ''; } },
            /* What a card shows of the act (Tether puts it in card.about): the tab, by its title and address, and what
               the card of Tether's leaves out (a script, a point, a drag). Never a token. */
            async describe(verb, target, a) {
                const tabs = self.#inst.get(target.id)?.status().tabs ?? [];
                const tab = a.tab !== undefined ? tabs.find((x) => String(x.id) === String(a.tab)) : null;
                const out = {};
                if (tab) out.tab = { id: tab.id, title: String(tab.title ?? '').slice(0, 200), url: String(tab.url ?? '').slice(0, 500), site: String(tab.site ?? '') };
                for (const k of ['script', 'selector', 'from', 'to', 'key']) if (typeof a[k] === 'string') out[k] = a[k];
                for (const k of ['x', 'y', 'dx', 'dy']) if (Number.isFinite(Number(a[k])) && a[k] !== undefined) out[k] = Number(a[k]);
                return out;
            },
            close(agent = '*') { for (const i of self.#inst.values()) { try { i.close(agent); } catch { /* gone */ } } },
            shutdown() { self.shutdown(); },
        };
    }

    /* A SOCKET THE EXTENSION OPENED, wrapped as Tether's channel: { send, onMessage, onClose, close }, and `size` of
       each message (the lobby keeps them small). Returns false when it was turned away. */
    accept(raw, address = '') {
        const now = this.#now();
        const recent = (this.#connects.get(address) ?? []).filter((t) => now - t < 60_000);
        recent.push(now); this.#connects.set(address, recent);
        const waiting = [...this.#lobby].filter((c) => c.address === address).length;
        if (recent.length > CONNECTS_PER_MINUTE || this.#lobby.size >= LOBBY_MAX || waiting >= LOBBY_PER_ADDRESS) { try { raw.close(); } catch { /* gone */ } return false; }
        const conn = { raw, address, since: now, code: null, tabs: null, handler: null, closers: new Set(), taken: false };
        this.#lobby.add(conn);
        raw.onMessage((msg, size = 0) => {
            if (conn.handler) { conn.handler(msg); return; }
            if (size > LOBBY_MESSAGE_MAX) { this.#drop(conn); return; }
            this.#lobbyMessage(conn, msg);
        });
        raw.onClose(() => { this.#lobby.delete(conn); for (const fn of conn.closers) { try { fn(); } catch { /* its fault */ } } if (conn.code) this.#changed(); });
        return true;
    }
    #drop(conn) { this.#lobby.delete(conn); try { conn.raw.close(); } catch { /* gone */ } }

    #lobbyMessage(conn, msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'ping') { conn.raw.send({ t: 'pong' }); return; }
        if (msg.t === 'tabs') { conn.tabs = msg; return; }
        if (msg.t === 'pair') {
            const code = typeof msg.code === 'string' ? msg.code.trim() : '';
            if (/^[0-9A-Za-z-]{4,32}$/.test(code)) { conn.code = code; this.#changed(); }
            return;
        }
        if (msg.t === 'hello' && typeof msg.token === 'string' && msg.token) {
            const h = hash(msg.token);
            const all = this.#tokens.get();
            const id = Object.keys(all).find((k) => (all[k] ?? []).includes(h));
            if (id && this.#targets().some((t) => t.id === id)) { this.#hand(conn, id, [msg]); return; }
            conn.raw.send({ t: 'pair-needed' });
        }
    }

    /* The socket leaves the lobby for its browser's connector, what it said replayed there. */
    #hand(conn, id, said) {
        this.#lobby.delete(conn);
        conn.taken = true;
        const channel = { send: (o) => conn.raw.send(o), onMessage: (fn) => { conn.handler = fn; }, onClose: (fn) => { conn.closers.add(fn); }, close: () => { try { conn.raw.close(); } catch { /* gone */ } } };
        const i = this.#of(id);
        i.accept(channel);
        for (const m of said) conn.handler?.(m);
        if (conn.tabs) conn.handler?.(conn.tabs);
        return i;
    }

    /* Is a browser waiting with a code (the page says so while the person types it)? */
    waiting() { return [...this.#lobby].filter((c) => c.code).length; }

    /* THE PERSON TYPED THE CODE: { code, name?, target? } -> the target, made (or the same one, paired again). */
    pair({ code, name = '', target = '' } = {}) {
        const now = this.#now();
        this.#wrong = this.#wrong.filter((t) => now - t < WRONG_WINDOW_MS);
        if (this.#wrong.length >= WRONG_MAX) throw new Refusal(429, 'Too many wrong codes. Wait a few minutes.');
        const given = String(code ?? '').replace(/\s+/g, '');
        if (!given) throw new Refusal(400, 'Type the code the extension shows.');
        const offered = [...this.#lobby].filter((c) => c.code === given);
        if (offered.length !== 1) {
            this.#wrong.push(now);
            this.#log(`browser: a pairing code was refused (${offered.length ? 'offered twice' : 'unknown'})`);
            /* Two sockets with one code: neither is trusted. */
            for (const c of offered) this.#drop(c);
            throw new Refusal(400, offered.length ? 'That code was offered twice. Open the popup again.' : 'No browser shows that code. Check it, and the address.');
        }
        const store = this.#store();
        let t;
        if (target) {
            t = store.target(String(target));
            if (!t || t.kind !== 'browser') throw new Refusal(404, 'No such browser.');
            /* Paired again: its old tokens go, the old socket too. */
            this.forget(t.id, { keepTarget: true });
        } else {
            const title = String(name ?? '').trim().slice(0, TITLE_MAX) || 'Browser';
            const base = `browser-${slug(title) || 'browser'}`;
            let id = base;
            for (let n = 2; store.target(id); n++) id = `${base}-${n}`;
            t = store.putTarget({ id, title, kind: 'browser', connector: 'browser', config: {} });
        }
        const [conn] = offered;
        const i = this.#hand(conn, t.id, [{ t: 'pair', code: given }]);
        i.pair(given);
        this.#log(`browser: ${t.id} paired`);
        this.#changed();
        return { id: t.id, title: t.title, kind: 'browser' };
    }

    /* THE SITES A CONVERSATION MAY ACT ON WITHOUT ASKING, at frame (« Encadrer »): Tether's site rules on its grant,
       replaced by this list (one host each, *.host allowed). Empty: nothing runs freely. -> the list kept. */
    async setSites(tethers, { target, agent, sites } = {}) {
        const t = this.#store().target(String(target ?? ''));
        if (!t || t.kind !== 'browser') throw new Refusal(404, 'No such browser.');
        const who = String(agent ?? '');
        if (!/^conversation:./.test(who)) throw new Refusal(400, 'Sites are given to a conversation.');
        const g = t.grants?.[who];
        if (!g) throw new Refusal(400, 'Give it the browser first.');
        const given = (Array.isArray(sites) ? sites : String(sites ?? '').split(/[\n,]+/)).map((x) => String(x).trim()).filter(Boolean);
        if (given.length > SITES_MAX) throw new Refusal(400, `${SITES_MAX} sites at most.`);
        const want = [];
        for (const x of given) {
            const v = x.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
            if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(v)) throw new Refusal(400, `Not a site: ${x.slice(0, 80)}. A host, or *.host.`);
            if (!want.includes(v)) want.push(v);
        }
        const had = (g.rules ?? []).filter((r) => r.kind === 'site').map((r) => r.value);
        for (const v of had) if (!want.includes(v)) { const r = await tethers.act('unallow', { target: t.id, agent: who, rule: { kind: 'site', value: v } }, ''); if (!r.ok) throw new Refusal(400, r.text); }
        for (const v of want) if (!had.includes(v)) { const r = await tethers.act('allow', { target: t.id, agent: who, rule: { kind: 'site', value: v } }, ''); if (!r.ok) throw new Refusal(400, r.text); }
        return { sites: (this.#store().target(t.id).grants?.[who]?.rules ?? []).filter((r) => r.kind === 'site').map((r) => r.value) };
    }

    /* Wrong codes counted now (the tests; the page says only that it must wait). */
    wrongCodes() { const now = this.#now(); return this.#wrong.filter((t) => now - t < WRONG_WINDOW_MS).length; }

    status(id) {
        const s = this.#inst.get(id)?.status();
        return { connected: !!s?.connected, tabs: (s?.tabs ?? []).map((x) => ({ id: x.id, title: x.title, url: x.url, site: x.site })) };
    }
    /* Every browser's state, for the page: { id: { connected, tabs } }. */
    all() { return Object.fromEntries(this.#targets().map((t) => [t.id, this.status(t.id)])); }

    /* A browser removed (or paired again): its tokens and its socket go. */
    forget(id, { keepTarget = false } = {}) {
        const all = this.#tokens.get();
        if (all[id]) { delete all[id]; this.#tokens.set(all); }
        const i = this.#inst.get(id);
        if (i) { try { i.shutdown(); } catch { /* gone */ } this.#inst.delete(id); }
        if (!keepTarget) this.#log(`browser: ${id} unpaired`);
        this.#changed();
    }

    #sweep() {
        const now = this.#now();
        for (const c of [...this.#lobby]) if (now - c.since > LOBBY_MS) this.#drop(c);
        for (const [a, list] of this.#connects) { const keep = list.filter((t) => now - t < 60_000); if (keep.length) this.#connects.set(a, keep); else this.#connects.delete(a); }
    }

    /* THE ENDPOINT on this server: a WebSocket at BROWSER_PATH. No sign-in is looked at (the front lets /c/ through
       without one); the token said on the socket is the right. */
    attach(server, WebSocketServer) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: MESSAGE_MAX });
        server.on('upgrade', (request, socket, head) => {
            const { pathname } = new URL(request.url ?? '/', 'http://local');
            if (pathname !== BROWSER_PATH) return;
            const address = addressOf(request);
            wss.handleUpgrade(request, socket, head, (ws) => this.accept(channelOf(ws), address));
        });
        return wss;
    }

    shutdown() {
        clearInterval(this.#timer);
        for (const i of this.#inst.values()) { try { i.shutdown(); } catch { /* gone */ } }
        this.#inst.clear();
        for (const c of [...this.#lobby]) this.#drop(c);
    }
}

/* A `ws` socket as a channel: JSON each way, each message's size given with it. */
export function channelOf(ws) {
    return {
        send: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
        onMessage: (fn) => ws.on('message', (data, binary) => { if (binary) return; let m; try { m = JSON.parse(String(data)); } catch { return; } fn(m, data.length ?? 0); }),
        onClose: (fn) => ws.on('close', () => fn()),
        close: () => { try { ws.close(); } catch { /* gone */ } },
    };
}
