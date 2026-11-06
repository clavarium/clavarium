/* API KEYS: what a program elsewhere (an assistant, an automation) may ask of
 * this Clavarium, and the door it asks through.
 *
 * A key is a named USE ("home automation", "steering AI"), global to this
 * Clavarium, never tied to a person. It is a third kind of subject in the one
 * table of rights (grants.mjs, "apikey:<id>"): what it may do is lines of
 * that table, and a new key has none. Step 1 has one scope:
 *
 *   status    read the state: the server's memory, disk and CPU, the
 *             conversations (their free name and state, never what they
 *             say), the versions                              server:status r
 *
 * THE SECRET IS SHOWN ONCE. It is made here (32 random bytes, "clv_" before
 * them), given back by `create` and never again: only its sha256 is kept, as
 * a pairing's session is (devices.mjs). A 256-bit random secret needs no salt
 * nor slow hash: nobody guesses it, and a copy of the store opens nothing.
 * Compared in constant time, with every key looked at.
 *
 * REVOKED IS AT ONCE: the record and its lines of rights go; the next call is
 * refused. EXPIRED is refused the same way (90 days unless chosen otherwise).
 *
 * EVERY USE IS JOURNALED: the key's id, the route, the answer, the time --
 * never the secret, nor anything of it. Its own file, one JSON line each,
 * cut to its newest half past JOURNAL_MAX. Each key is limited to
 * RATE_PER_MIN calls a minute; calls with a key nobody has are limited too,
 * all together, so that they cannot flood the journal.
 *
 * Who manages keys: whoever passes the gate (an administrator), from
 * Settings, Access. A device (/c/) never reaches these routes; a key never
 * makes a key.
 *
 *   GET  /api/apikeys                   {keys, scopes, defaultDays}
 *   POST /api/apikeys                   {label, scopes, days|null} -> {key, secret}: the secret this once
 *   POST /api/apikeys/<id>/revoke
 *   GET  /api/apikeys/<id>/journal      its last uses
 *
 *   GET  /api/ext/v1/status             Authorization: Bearer clv_...   the state, as JSON
 *   POST /api/ext/mcp                   the same, as one MCP tool (clavarium_status), JSON-RPC over HTTP
 *
 * The front lets /api/ext/ through without sign-on, as it does /c/
 * (deploy/install.sh, skip_auth_routes; deploy/updater.mjs for installs made
 * before), and strips the identity headers there: nothing under /api/ext/
 * ever looks at who the operator is, only at the key.
 */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { Grants, apiKeySubject } from './grants.mjs';

export const KEY_PREFIX = 'clv_';
export const DEFAULT_DAYS = 90;
export const DAYS_MAX = 3650;
export const KEYS_MAX = 50;
export const LABEL_MAX = 40;
export const RATE_PER_MIN = 60;
/* All calls with a key nobody has, together. */
export const UNKNOWN_PER_MIN = 60;
const JOURNAL_MAX = 1024 * 1024;
const JOURNAL_SHOWN = 200;
/* The time a key was last used is written at most this often (it is known at once in memory). */
const USED_SAVE_MS = 60_000;
export const EXT_PREFIX = '/api/ext/';

/* The scopes a key may be given: [asset, rights] in the table. */
export const SCOPES = Object.freeze({ status: { asset: 'server:status', rights: 'r', label: 'Status (read)' } });

const digest = (text) => createHash('sha256').update(text).digest();
const oneLine = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= LABEL_MAX
    && ![...value].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0) || (p >= 0x200b && p <= 0x200f) || (p >= 0x202a && p <= 0x202e); });
const SECRET = /^clv_[A-Za-z0-9_-]{43}$/;

export class ApiKeys {
    #store; #grants; #now; #journal;
    #used = new Map();       /* id -> { at, savedAt } */
    #calls = new Map();      /* id ('' for unknown keys) -> [times of the last minute] */

    constructor({ store, grants = new Grants(), journal = null, now = () => Date.now() }) {
        this.#store = store; this.#grants = grants; this.#journal = journal; this.#now = now;
    }

    #scopesOf(id) { return Object.entries(SCOPES).filter(([, s]) => this.#grants.can(apiKeySubject(id), s.asset, s.rights)).map(([name]) => name); }
    #shown(k) {
        const used = this.#used.get(k.name)?.at ?? k.usedAt ?? null;
        return { id: k.name, label: k.label, scopes: this.#scopesOf(k.name), createdBy: k.createdBy ?? null, createdAt: k.createdAt, expiresAt: k.expiresAt ?? null,
            usedAt: used, expired: Boolean(k.expiresAt && Date.parse(k.expiresAt) <= this.#now()) };
    }

    /* Every key, newest first: never a secret, nor its hash. */
    list() { return this.#store.all().map((k) => this.#shown(k)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
    scopes() { return Object.entries(SCOPES).map(([id, s]) => ({ id, label: s.label })); }

    /* A new key: its secret is in the answer, this once. `days`: its life (null: it does not expire). */
    create({ label, scopes = [], days = DEFAULT_DAYS } = {}, who = '') {
        if (!oneLine(label)) throw new Refusal(400, `A key has a name: one line, ${LABEL_MAX} characters at most.`);
        if (!Array.isArray(scopes) || scopes.some((s) => !Object.hasOwn(SCOPES, s))) throw new Refusal(400, `Scopes are among: ${Object.keys(SCOPES).join(', ')}.`);
        if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= DAYS_MAX)) throw new Refusal(400, `A key lasts 1 to ${DAYS_MAX} days, or does not expire.`);
        if (this.#store.all().length >= KEYS_MAX) throw new Refusal(409, `At most ${KEYS_MAX} keys: revoke one first.`);
        const name = label.trim();
        if (this.#store.all().some((k) => k.label.toLowerCase() === name.toLowerCase())) throw new Refusal(409, 'A key has this name already: one name per use.');
        const id = randomUUID();
        const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
        const now = this.#now();
        const record = { name: id, label: name, hash: digest(secret).toString('hex'), createdAt: new Date(now).toISOString(),
            ...(who ? { createdBy: String(who).slice(0, 120) } : {}), expiresAt: days === null ? null : new Date(now + days * 86_400_000).toISOString() };
        this.#store.put(record);
        for (const s of new Set(scopes)) this.#grants.give(apiKeySubject(id), SCOPES[s].asset, SCOPES[s].rights);
        return { key: this.#shown(record), secret };
    }

    /* At once: the next call with it is refused. */
    revoke(id) {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#store.remove(id);
        this.#grants.forgetSubject(apiKeySubject(id));
        this.#used.delete(id); this.#calls.delete(id);
    }

    get(id) { const k = this.#store.get(id); return k ? this.#shown(k) : undefined; }

    /* The key a secret is, or undefined -- every key compared, in constant time each. */
    #find(secret) {
        if (typeof secret !== 'string' || !SECRET.test(secret)) return undefined;
        const asked = digest(secret);
        let found;
        for (const k of this.#store.all()) {
            if (typeof k.hash !== 'string' || !/^[0-9a-f]{64}$/.test(k.hash)) continue;
            if (timingSafeEqual(Buffer.from(k.hash, 'hex'), asked) && found === undefined) found = k;
        }
        return found;
    }

    #counted(who, max) {
        const now = this.#now();
        const recent = (this.#calls.get(who) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= max) { this.#calls.set(who, recent); return Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000)); }
        recent.push(now); this.#calls.set(who, recent);
        return 0;
    }

    /* WHO ASKS, from the Authorization header, and may it read `scope`? Returns the key's id, or throws:
       401 no key, or one nobody has (unknown, revoked, expired); 429 too many calls; 403 not this scope. */
    check(authorization, scope) {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(String(authorization ?? ''));
        if (!m) throw Object.assign(new Refusal(401, 'An API key is needed: Authorization: Bearer clv_...'), { key: null });
        const k = this.#find(m[1]);
        if (!k || (k.expiresAt && Date.parse(k.expiresAt) <= this.#now())) {
            const wait = this.#counted('', UNKNOWN_PER_MIN);
            if (wait) throw Object.assign(new Refusal(429, 'Too many calls with keys that are not valid. Wait a minute.'), { key: null, retry: wait });
            throw Object.assign(new Refusal(401, 'This API key is not valid: unknown, revoked or expired.'), { key: k?.name ?? null });
        }
        const wait = this.#counted(k.name, RATE_PER_MIN);
        if (wait) throw Object.assign(new Refusal(429, `Too many calls: ${RATE_PER_MIN} a minute per key.`), { key: k.name, retry: wait });
        this.#seen(k.name);
        if (scope !== undefined && !this.#scopesOf(k.name).includes(scope)) throw Object.assign(new Refusal(403, `This key was not given the scope "${SCOPES[scope]?.label ?? scope}".`), { key: k.name });
        return k.name;
    }

    /* Whether a key (already checked) has a scope. */
    may(id, scope) { return this.#scopesOf(id).includes(scope); }

    #seen(id) {
        const now = this.#now();
        const u = this.#used.get(id) ?? { at: null, savedAt: 0 };
        u.at = new Date(now).toISOString();
        if (now - u.savedAt >= USED_SAVE_MS) { u.savedAt = now; this.#store.patch(id, { usedAt: u.at }); }
        this.#used.set(id, u);
    }

    /* One line of the journal: never the secret -- only the id of the key, if it is one. */
    note({ key = null, route, status, method = 'GET' }) {
        if (!this.#journal) return;
        const line = { at: new Date(this.#now()).toISOString(), key: typeof key === 'string' ? key : null, method: String(method).slice(0, 8), route: String(route ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 120), status };
        try {
            appendFileSync(this.#journal, `${JSON.stringify(line)}\n`, { mode: 0o600 });
            if (statSync(this.#journal).size > JOURNAL_MAX) {
                const lines = readFileSync(this.#journal, 'utf8').split('\n').filter(Boolean);
                writeFileSync(`${this.#journal}.tmp`, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
                renameSync(`${this.#journal}.tmp`, this.#journal);
            }
        } catch { /* said nowhere: never a reason to fail the call */ }
    }

    /* The last uses of one key, newest first. */
    journal(id) {
        if (!this.#store.get(id)) throw new Refusal(404, 'No such key.');
        if (!this.#journal) return [];
        let text = '';
        try { text = readFileSync(this.#journal, 'utf8'); } catch { return []; }
        const out = [];
        for (const l of text.split('\n').reverse()) {
            if (!l) continue;
            try { const e = JSON.parse(l); if (e.key === id) out.push({ at: e.at, method: e.method, route: e.route, status: e.status }); } catch { /* a torn line */ }
            if (out.length >= JOURNAL_SHOWN) break;
        }
        return out;
    }
}

/* THE STATE, as a key with "status" reads it. Only what is picked here, field by field: never what a
   conversation says (its messages, its last words), nor a secret, a file or an address. */
export async function statusOf({ conversations, talk, health, answerer, capacity, history, platform, updates, components = {} }) {
    const needs = (c) => {
        const t = talk?.brief(c.name);
        const asks = Boolean(t && (t.needs ?? (t.waiting > 0 || t.state === 'waiting')));
        const h = health?.of(c.name);
        const unwell = c.phase === 'ready' && (h?.problems ?? []).some((p) => p.level === 'bad' && !(h.seen ?? []).includes(p.key));
        return { asks: asks || Boolean(answerer?.of(c.name)?.needs) || c.phase === 'failed' || unwell, working: t?.state === 'working' };
    };
    const list = (conversations?.list() ?? []).map((c) => {
        const n = needs(c);
        const state = c.asleep === true ? 'asleep' : n.asks ? 'needs-you' : n.working ? 'working' : 'awake';
        return { id: c.name, name: typeof c.title === 'string' && c.title ? c.title : c.name, state, phase: String(c.phase ?? ''), tool: String(c.toolLabel ?? c.tool ?? '') };
    });
    const brief = capacity ? await capacity.brief().catch(() => null) : null;
    const room = capacity ? await capacity.room().catch(() => null) : null;
    const cpu = (() => { const v = history?.series('server', '1h').cpu ?? []; for (let i = v.length - 1; i >= 0; i -= 1) if (v[i] !== null && v[i] !== undefined) return v[i]; return null; })();
    const part = (x) => (x ? { usedPercent: x.usedPercent ?? null, freeMb: x.freeMb ?? null, high: Boolean(x.high) } : null);
    let update = null;
    try { const u = updates?.about(); if (u?.installed) update = { channel: u.channel ?? null, available: u.available ?? null }; } catch { /* not said */ }
    return {
        at: new Date().toISOString(),
        server: { known: Boolean(brief?.known), memory: part(brief?.memory), disk: part(brief?.disk), cpu: { usedPercent: cpu, cores: room?.cpu?.cores ?? null } },
        conversations: list,
        counts: Object.fromEntries(['awake', 'working', 'needs-you', 'asleep'].map((s) => [s, list.filter((c) => c.state === s).length])),
        versions: { clavarium: platform?.version ?? null, ...components, ...(update ? { update } : {}) },
    };
}

/* ---- the door for programs: /api/ext/ ---- */

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_BODY_MAX = 64 * 1024;
export const STATUS_TOOL = {
    name: 'clavarium_status',
    title: 'Clavarium status',
    description: 'Read-only state of this Clavarium: server memory, disk and CPU; each conversation with its name and state (asleep, awake, working, needs-you); versions. No conversation content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/* Returns true when the request was under /api/ext/ (answered here). `status()`: the state, as statusOf
   makes it. `originOk(headers)`: whether an Origin is this site's (gate.mjs); a call from a page of
   another site is refused. */
export async function handleExternal(request, response, { keys, status, headers = {}, originOk = () => false, version = null }) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (!pathname.startsWith(EXT_PREFIX) && pathname !== EXT_PREFIX.slice(0, -1)) return false;
    const route = pathname.slice(EXT_PREFIX.length - 1);
    const send = (code, body, more = {}) => {
        response.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...more });
        response.end(body === undefined ? undefined : JSON.stringify(body));
        return true;
    };
    const note = (key, code, what = route) => keys.note({ key, route: what, status: code, method: request.method });
    /* A browser on another site: never (MCP asks servers to look at Origin). Programs send none. */
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !originOk(request.headers)) { note(null, 403); return send(403, { error: 'Not from another site.' }); }
    const refused = (error, what) => {
        if (!(error instanceof Refusal)) throw error;
        note(error.key ?? null, error.status, what);
        const more = error.status === 401 ? { 'www-authenticate': 'Bearer realm="clavarium"' } : error.status === 429 ? { 'retry-after': String(error.retry ?? 60) } : {};
        return send(error.status, { error: error.message }, more);
    };
    try {
        if (route === '/v1/status') {
            if (request.method !== 'GET') return send(405, { error: 'Call this address with GET.' }, { allow: 'GET' });
            let id;
            try { id = keys.check(request.headers.authorization, 'status'); } catch (error) { return refused(error); }
            const body = await status();
            note(id, 200);
            return send(200, body);
        }
        if (route === '/mcp') {
            if (request.method !== 'POST') return send(405, { error: 'MCP is spoken with POST here (no event stream).' }, { allow: 'POST' });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error, '/mcp'); }
            let text = '';
            for await (const piece of request) { text += piece; if (text.length > MCP_BODY_MAX) { note(id, 413, '/mcp'); return send(413, { error: 'Too long.' }); } }
            let msg;
            try { msg = JSON.parse(text); } catch { note(id, 400, '/mcp'); return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
            if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
                note(id, 400, '/mcp'); return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            }
            const what = `/mcp ${msg.method.slice(0, 40)}${msg.method === 'tools/call' ? ` ${String(msg.params?.name ?? '').slice(0, 40)}` : ''}`;
            /* A notification (no id) is taken, never answered. */
            if (msg.id === undefined || msg.id === null) { note(id, 202, what); response.writeHead(202, { ...headers, 'cache-control': 'no-store' }).end(); return true; }
            const answer = (result) => { note(id, 200, what); return send(200, { jsonrpc: '2.0', id: msg.id, result }); };
            const fail = (code, message, http = 200) => { note(id, http === 200 ? 400 : http, what); return send(http, { jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
            switch (msg.method) {
            case 'initialize': {
                const asked = String(msg.params?.protocolVersion ?? '');
                return answer({ protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'clavarium', title: 'Clavarium', version: version ?? '0' }, instructions: 'Read-only state of this Clavarium. One tool: clavarium_status.' });
            }
            case 'ping': return answer({});
            case 'tools/list': return answer({ tools: [STATUS_TOOL] });
            case 'tools/call': {
                if (msg.params?.name !== STATUS_TOOL.name) return fail(-32602, `Unknown tool: ${String(msg.params?.name ?? '').slice(0, 60)}`);
                if (!keys.may(id, 'status')) {
                    note(id, 403, what);
                    return send(403, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: `This key was not given the scope "${SCOPES.status.label}".` } });
                }
                const body = await status();
                return answer({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: false });
            }
            default: return fail(-32601, 'Method not found');
            }
        }
        note(null, 404);
        return send(404, { error: 'Not found. GET /api/ext/v1/status, or MCP at /api/ext/mcp.' });
    } catch (error) {
        if (error instanceof Refusal) return refused(error);
        return send(500, { error: 'Something failed on the server.' });
    }
}

/* Settings, Access, "API keys": for whoever passed the gate. */
export async function handleApiKeys(request, response, keys, originOk, headers = {}, events = null) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (pathname !== '/api/apikeys' && !pathname.startsWith('/api/apikeys/')) return false;
    const send = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body)); return true; };
    const who = String(request.headers['x-forwarded-email'] ?? '').trim().toLowerCase();
    try {
        if (request.method === 'GET' && pathname === '/api/apikeys') return send(200, { keys: keys.list(), scopes: keys.scopes(), defaultDays: DEFAULT_DAYS, me: who || null });
        const journal = /^\/api\/apikeys\/([0-9a-f-]{36})\/journal$/.exec(pathname);
        if (request.method === 'GET' && journal) return send(200, { uses: keys.journal(journal[1]) });
        if (request.method !== 'POST') return false;
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) return send(403, { error: 'This request does not come from this site.' });
        let text = '';
        for await (const piece of request) { text += piece; if (text.length > 4096) return send(413, { error: 'Too long.' }); }
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { return send(400, { error: 'The request is not JSON.' }); }
        if (!body || typeof body !== 'object') body = {};
        if (pathname === '/api/apikeys') {
            const made = keys.create({ label: body.label, scopes: body.scopes ?? [], days: body.days === undefined ? DEFAULT_DAYS : body.days }, who);
            /* Its name and scopes; never the secret. */
            events?.add({ kind: 'access', text: `API key "${made.key.label}" made${made.key.scopes.length ? ` (${made.key.scopes.join(', ')})` : ' (no scope)'}`, who: who || null });
            return send(201, made);
        }
        const revoke = /^\/api\/apikeys\/([0-9a-f-]{36})\/revoke$/.exec(pathname);
        if (revoke) {
            const label = keys.get(revoke[1])?.label;
            keys.revoke(revoke[1]);
            events?.add({ kind: 'access', text: `API key "${label}" revoked`, who: who || null });
            return send(200, { ok: true });
        }
        return false;
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message });
        return send(500, { error: 'Something failed on the server.' });
    }
}
