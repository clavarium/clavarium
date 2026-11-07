/* API KEYS: what a program elsewhere (an assistant, an automation) may ask of
 * this Clavarium, and the door it asks through.
 *
 * A key is a named USE ("home automation", "steering AI"), global to this
 * Clavarium, never tied to a person. It is a third kind of subject in the one
 * table of rights (grants.mjs, "apikey:<id>"): what it may do is lines of
 * that table, and a new key has none. Its scopes:
 *
 *   status    read the state: the server's memory, disk and CPU, the
 *             conversations (their free name and state, never what they
 *             say), the versions                              server:status r
 *
 *   a conversation, given ONE BY ONE (never "all, and those to come"):
 *     read    read its chat                                   conversation:<name> r
 *     talk    and post a message in it, as the chat does,
 *             signed with the key's name, never as the person  conversation:<name> rw
 *   A conversation archived takes its lines with it (devices.forget). Its
 *   terminal ("x") is never given to a key.
 *
 *   a room, given ONE BY ONE the same way:
 *     read    read its thread, as the page reads it (names, never ids;
 *             secrets masked)                                 room:<id> r
 *     talk    and post in it as the person does -- to its host, or to the AIs
 *             named -- signed with the key's name and look    room:<id> rw
 *
 *   a voice box, given ONE BY ONE:
 *     state   online, where it speaks, when it last heard, its volume --
 *             nothing it heard, never audio                   box:<id> r
 *     speak   and make it say a short text aloud (SPEAK_MAX characters,
 *             SPEAK_PER_MIN a minute per key and box): never listen, record,
 *             change its settings nor update it               box:<id> rw
 *   A room removed, a box withdrawn, takes its lines with it (main.mjs).
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
 *   POST /api/apikeys                   {label, scopes, conversations: {name: 'read'|'talk'}, days|null}
 *                                       -> {key, secret}: the secret this once
 *   POST /api/apikeys/<id>/conversations {conversation, level: 'read'|'talk'|null}: one given, changed, taken back
 *   POST /api/apikeys/<id>/rooms        {room, level: 'read'|'talk'|null}
 *   POST /api/apikeys/<id>/boxes        {box, level: 'state'|'speak'|null}
 *   (and on creation: rooms: {id: level}, boxes: {id: level})
 *   POST /api/apikeys/<id>/revoke
 *   GET  /api/apikeys/<id>/journal      its last uses
 *
 *   Authorization: Bearer clv_... on each of these:
 *   GET  /api/ext/v1/status                              the state, as JSON
 *   GET  /api/ext/v1/conversations                       those it may read: {conversations: [{id, name, level, chat}]}
 *   GET  /api/ext/v1/conversations/<name>/messages       ?last=1..200 (50) | ?since=<cursor>: {chat, messages, cursor}
 *   POST /api/ext/v1/conversations/<name>/messages       {text}: posted in its chat, signed with the key's name
 *   GET  /api/ext/v1/rooms                               those it may read: {rooms: [{id, name, level, host, members}]}
 *   GET  /api/ext/v1/rooms/<id>/messages                 as a conversation's: {messages, cursor}
 *   POST /api/ext/v1/rooms/<id>/messages                 {text, to?: [names of its AIs]}: posted in the room, signed with the key
 *   GET  /api/ext/v1/boxes                               {boxes: [{id, name, level, online, where, heardAt, volume}]}
 *   POST /api/ext/v1/boxes/<id>/say                      {text}: said aloud by the box
 *   POST /api/ext/mcp                   the same as MCP tools (clavarium_status, clavarium_conversations,
 *                                       clavarium_read, clavarium_say, clavarium_rooms, clavarium_room_read,
 *                                       clavarium_room_say, clavarium_boxes, clavarium_box_say), JSON-RPC over HTTP
 *   A conversation, room or box not given, or not there, is the same 403: a key learns nothing of what it was not given.
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
import { isConversationName } from './names.mjs';
import { masked, lookOf } from './rooms.mjs';

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
export const SCOPES = Object.freeze({ status: { asset: 'server:status', rights: 'r', label: 'Its state (memory, disk, versions)' } });
/* What a key may do in one conversation: [rights in the table]. */
export const LEVELS = Object.freeze({ read: 'r', talk: 'rw' });
export const levelOf = (rights) => (String(rights).includes('w') ? 'talk' : String(rights).includes('r') ? 'read' : null);
/* The messages one read gives, by default and at most. */
export const READ_DEFAULT = 50;
export const READ_MAX = 200;
export const SAY_MAX = 8000;
/* What a room and a voice box may be given: [rights in the table]. */
export const ROOM_LEVELS = Object.freeze({ read: 'r', talk: 'rw' });
export const BOX_LEVELS = Object.freeze({ state: 'r', speak: 'rw' });
export const boxLevelOf = (rights) => (String(rights).includes('w') ? 'speak' : String(rights).includes('r') ? 'state' : null);
/* Said aloud in the home: short, and a few a minute (per key and box). */
export const SPEAK_MAX = 300;
export const SPEAK_PER_MIN = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const digest = (text) => createHash('sha256').update(text).digest();
const oneLine = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= LABEL_MAX
    && ![...value].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0) || (p >= 0x200b && p <= 0x200f) || (p >= 0x202a && p <= 0x202e); });
const SECRET = /^clv_[A-Za-z0-9_-]{43}$/;

export class ApiKeys {
    #store; #grants; #now; #journal; #exists; #kinds;
    #used = new Map();       /* id -> { at, savedAt } */
    #calls = new Map();      /* id ('' for unknown keys) -> [times of the last minute] */

    /* `exists(name)`: whether a conversation is there (one is given only then); `roomExists(id)`,
       `boxExists(id)`: the same for a room, a voice box (none, without them). */
    constructor({ store, grants = new Grants(), journal = null, now = () => Date.now(), exists = () => true, roomExists = () => false, boxExists = () => false }) {
        this.#store = store; this.#grants = grants; this.#journal = journal; this.#now = now; this.#exists = exists;
        /* What is given one by one: its asset type, its levels, a valid name, whether it is there, its words. */
        this.#kinds = {
            room: { levels: ROOM_LEVELS, of: levelOf, valid: (v) => typeof v === 'string' && UUID.test(v), exists: roomExists, what: 'room', the: 'a room' },
            box: { levels: BOX_LEVELS, of: boxLevelOf, valid: (v) => typeof v === 'string' && UUID.test(v), exists: boxExists, what: 'voice box', the: 'a voice box' },
        };
    }

    #scopesOf(id) { return Object.entries(SCOPES).filter(([, s]) => this.#grants.can(apiKeySubject(id), s.asset, s.rights)).map(([name]) => name); }
    #shown(k) {
        const used = this.#used.get(k.name)?.at ?? k.usedAt ?? null;
        return { id: k.name, label: k.label, scopes: this.#scopesOf(k.name), conversations: this.conversationsOf(k.name), rooms: this.roomsOf(k.name), boxes: this.boxesOf(k.name), createdBy: k.createdBy ?? null, createdAt: k.createdAt, expiresAt: k.expiresAt ?? null,
            usedAt: used, expired: Boolean(k.expiresAt && Date.parse(k.expiresAt) <= this.#now()) };
    }

    /* Every key, newest first: never a secret, nor its hash. */
    list() { return this.#store.all().map((k) => this.#shown(k)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
    scopes() { return Object.entries(SCOPES).map(([id, s]) => ({ id, label: s.label })); }

    /* The conversations a key was given, each with its level: [{ name, level }]. */
    conversationsOf(id) {
        return this.#grants.of(apiKeySubject(id), 'conversation').map((g) => ({ name: g.name, level: levelOf(g.rights) })).filter((c) => c.level)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /* The rooms, the voice boxes a key was given, each with its level: [{ id, level }] -- only those still there. */
    #givenOf(id, type) {
        const k = this.#kinds[type];
        return this.#grants.of(apiKeySubject(id), type).map((g) => ({ id: g.name, level: k.of(g.rights) })).filter((x) => x.level && k.exists(x.id))
            .sort((a, b) => a.id.localeCompare(b.id));
    }
    roomsOf(id) { return this.#givenOf(id, 'room'); }
    boxesOf(id) { return this.#givenOf(id, 'box'); }
    #oneAsked(type, ref, level) {
        const k = this.#kinds[type];
        if (!k.valid(ref) || !k.exists(ref)) throw new Refusal(404, `No such ${k.what}.`);
        if (level !== null && !Object.hasOwn(k.levels, level)) throw new Refusal(400, `${k.the[0].toUpperCase()}${k.the.slice(1)} is given at one of: ${Object.keys(k.levels).join(', ')}.`);
    }
    #givenAll(type, given) {
        if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Refusal(400, `${type === 'room' ? 'Rooms' : 'Voice boxes'} are given by id: {id: level}.`);
        for (const [ref, level] of Object.entries(given)) this.#oneAsked(type, ref, level);
    }
    /* One room or voice box given to a key, its level changed, or taken back (level null). */
    #setOne(type, id, ref, level) {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#oneAsked(type, ref, level);
        if (level === null) this.#grants.take(apiKeySubject(id), `${type}:${ref}`);
        else this.#grants.give(apiKeySubject(id), `${type}:${ref}`, this.#kinds[type].levels[level]);
        return this.get(id);
    }
    setRoom(id, room, level) { return this.#setOne('room', id, room, level); }
    setBox(id, box, level) { return this.#setOne('box', id, box, level); }

    #conversationAsked(name, level) {
        if (!isConversationName(name) || !this.#exists(name)) throw new Refusal(404, 'No such conversation.');
        if (level !== null && !Object.hasOwn(LEVELS, level)) throw new Refusal(400, `A conversation is given to read or to talk: ${Object.keys(LEVELS).join(', ')}.`);
    }

    /* One conversation given to a key, its level changed, or taken back (level null). */
    setConversation(id, name, level) {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#conversationAsked(name, level);
        if (level === null) this.#grants.take(apiKeySubject(id), `conversation:${name}`);
        else this.#grants.give(apiKeySubject(id), `conversation:${name}`, LEVELS[level]);
        return this.get(id);
    }

    /* A new key: its secret is in the answer, this once. `days`: its life (null: it does not expire).
       `conversations`: { name: 'read' | 'talk' }, each named -- there is no "all". */
    create({ label, scopes = [], conversations = {}, rooms = {}, boxes = {}, days = DEFAULT_DAYS } = {}, who = '') {
        if (!oneLine(label)) throw new Refusal(400, `A key has a name: one line, ${LABEL_MAX} characters at most.`);
        if (!Array.isArray(scopes) || scopes.some((s) => !Object.hasOwn(SCOPES, s))) throw new Refusal(400, `Scopes are among: ${Object.keys(SCOPES).join(', ')}.`);
        if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) throw new Refusal(400, 'Conversations are given by name: {name: "read" | "talk"}.');
        for (const [name, level] of Object.entries(conversations)) this.#conversationAsked(name, level);
        this.#givenAll('room', rooms); this.#givenAll('box', boxes);
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
        for (const [name, level] of Object.entries(conversations)) if (level !== null) this.#grants.give(apiKeySubject(id), `conversation:${name}`, LEVELS[level]);
        for (const [ref, level] of Object.entries(rooms)) if (level !== null) this.#grants.give(apiKeySubject(id), `room:${ref}`, ROOM_LEVELS[level]);
        for (const [ref, level] of Object.entries(boxes)) if (level !== null) this.#grants.give(apiKeySubject(id), `box:${ref}`, BOX_LEVELS[level]);
        return { key: this.#shown(record), secret };
    }

    /* At once: the next call with it is refused. */
    revoke(id) {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#store.remove(id);
        this.#grants.forgetSubject(apiKeySubject(id));
        this.#used.delete(id); this.#calls.delete(id);
        for (const c of [...this.#calls.keys()]) if (c.startsWith(`speak:${id}:`)) this.#calls.delete(c);
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

    /* Whether a key (already checked) may read ('read') or talk in ('talk') one conversation; throws 403
       if not -- the same answer for a conversation not given and one that is not there. */
    mayConversation(id, name, level = 'read') {
        const rights = isConversationName(name) ? this.#grants.rightsOf(apiKeySubject(id), `conversation:${name}`) : '';
        if (!rights.includes('r')) throw Object.assign(new Refusal(403, 'This key was not given this conversation.'), { key: id });
        if (level === 'talk' && !rights.includes('w')) throw Object.assign(new Refusal(403, 'This key may read this conversation, not talk in it.'), { key: id });
        return levelOf(rights);
    }

    /* Whether a key (already checked) may read ('read') or post in ('talk') one room; 403 if not, the same for one
       not given and one not there. */
    mayRoom(id, room, level = 'read') {
        const rights = typeof room === 'string' && UUID.test(room) && this.#kinds.room.exists(room) ? this.#grants.rightsOf(apiKeySubject(id), `room:${room}`) : '';
        if (!rights.includes('r')) throw Object.assign(new Refusal(403, 'This key was not given this room.'), { key: id });
        if (level === 'talk' && !rights.includes('w')) throw Object.assign(new Refusal(403, 'This key may read this room, not talk in it.'), { key: id });
        return levelOf(rights);
    }
    /* Whether a key may see the state of ('state') or make speak ('speak') one voice box; 403 if not. */
    mayBox(id, box, level = 'state') {
        const rights = typeof box === 'string' && UUID.test(box) && this.#kinds.box.exists(box) ? this.#grants.rightsOf(apiKeySubject(id), `box:${box}`) : '';
        if (!rights.includes('r')) throw Object.assign(new Refusal(403, 'This key was not given this voice box.'), { key: id });
        if (level === 'speak' && !rights.includes('w')) throw Object.assign(new Refusal(403, 'This key may see this voice box, not make it speak.'), { key: id });
        return boxLevelOf(rights);
    }
    /* One sentence said aloud, counted: SPEAK_PER_MIN a minute for this key and box, then 429. */
    speakCounted(id, box) {
        const wait = this.#counted(`speak:${id}:${box}`, SPEAK_PER_MIN);
        if (wait) throw Object.assign(new Refusal(429, `Too many: ${SPEAK_PER_MIN} sentences a minute per voice box.`), { key: id, retry: wait });
    }

    /* Its name, as its messages are signed in a chat (Parley's "by"). */
    signature(id) { const k = this.#store.get(id); return k ? { id: apiKeySubject(id), name: k.label, kind: 'ai', place: 'API key' } : null; }
    /* In a room: its name and its look (the letter and colour the page draws it with). */
    roomSignature(id) { const s = this.signature(id); return s ? { ...s, look: lookOf(s.name) } : null; }

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

/* A CONVERSATION'S THREAD as a key reads it: the messages of the person and of the AI, field by field --
   its words, who said it, when; a file by its name only. Never the machine's own lines, a path, nor
   anything the page keeps for itself. `read`: what talk.of gives. */
const TEXT_MAX = 20_000;
const fileName = (p) => String(p ?? '').split('/').filter(Boolean).at(-1)?.slice(0, 120) ?? '';
export function threadOf(read) {
    if (!read?.on) return { chat: false, messages: [], cursor: null };
    const messages = (Array.isArray(read.messages) ? read.messages : []).filter((m) => m && (m.from === 'person' || m.from === 'agent')).map((m) => {
        const files = [...(Array.isArray(m.files) ? m.files.map((f) => fileName(f?.name || f?.path)) : []), ...(m.kind === 'show' && m.path ? [fileName(m.path)] : [])].filter(Boolean).slice(0, 12);
        const choices = Array.isArray(m.choices) ? m.choices.filter((c) => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 200)) : [];
        return { id: String(m.id ?? '').slice(0, 80), at: String(m.at ?? '').slice(0, 40), from: m.from, kind: String(m.kind ?? 'say').slice(0, 20),
            text: typeof m.text === 'string' ? m.text.slice(0, TEXT_MAX) : '', ...(typeof m.by?.name === 'string' && m.by.name ? { by: m.by.name.slice(0, 80) } : {}),
            ...(choices.length ? { choices } : {}), ...(files.length ? { files } : {}) };
    });
    return { chat: true, messages, cursor: typeof read.cursor === 'string' ? read.cursor : null };
}

/* A ROOM'S THREAD as a key reads it, as the page reads it: who said it by NAME (the person, an AI, a box, a key),
   whom it is for by name, its words with any secret masked, a file by its name only. Never a member's id, a path,
   nor what the page keeps for itself. `read`: what rooms.read gives. */
export function roomThreadOf(read) {
    const messages = (Array.isArray(read?.messages) ? read.messages : []).filter((m) => m && (m.from === 'person' || m.from === 'agent')).map((m) => {
        const files = [...(Array.isArray(m.files) ? m.files.map((f) => fileName(f?.name || f?.path)) : []), ...(m.kind === 'show' && m.path ? [fileName(m.path)] : [])].filter(Boolean).slice(0, 12);
        const choices = Array.isArray(m.choices) ? m.choices.filter((c) => typeof c === 'string').slice(0, 8).map((c) => masked(c).slice(0, 200)) : [];
        const to = Array.isArray(m.toNames) ? m.toNames.filter((x) => typeof x === 'string' && !UUID.test(x)).slice(0, 20).map((x) => x.slice(0, 80)) : [];
        /* No name: the person (the room's own side), as in a conversation's thread. */
        const by = typeof m.by?.name === 'string' && m.by.name ? m.by.name.slice(0, 80) : '';
        return { id: String(m.id ?? '').slice(0, 80), at: String(m.at ?? '').slice(0, 40), from: m.from, kind: String(m.kind ?? 'say').slice(0, 20),
            text: typeof m.text === 'string' ? masked(m.text).slice(0, TEXT_MAX) : '', ...(by ? { by } : {}),
            ...(to.length ? { to } : {}), ...(m.toYou ? { toPerson: true } : {}), ...(choices.length ? { choices } : {}), ...(files.length ? { files } : {}) };
    });
    return { messages, cursor: typeof read?.cursor === 'string' ? read.cursor : null };
}

/* What a read asks for: the newest `last` (READ_DEFAULT; READ_MAX at most), or what came `since` a cursor. */
export function readPart(get) {
    const last = Number(get('last') ?? READ_DEFAULT);
    const since = get('since');
    if (!Number.isInteger(last) || last < 1 || last > READ_MAX) throw new Refusal(400, `last: 1 to ${READ_MAX}.`);
    if (since !== null && since !== undefined && (typeof since !== 'string' || !/^[0-9A-Za-z.~-]{1,80}$/.test(since))) throw new Refusal(400, 'since: a cursor given by a read before.');
    return { last: String(last), ...(since ? { since } : {}) };
}

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_BODY_MAX = 64 * 1024;
const CONVERSATION_ARG = { type: 'string', description: 'The conversation\'s id, as clavarium_conversations gives it.' };
export const STATUS_TOOL = {
    name: 'clavarium_status',
    title: 'Clavarium status',
    description: 'Read-only state of this Clavarium: server memory, disk and CPU; each conversation with its name and state (asleep, awake, working, needs-you); versions. No conversation content.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const CONVERSATIONS_TOOL = {
    name: 'clavarium_conversations',
    title: 'Conversations of this key',
    description: 'The conversations this key was given, each with its id, name, level (read or talk) and whether its chat is on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const READ_TOOL = {
    name: 'clavarium_read',
    title: 'Read a conversation',
    description: `The newest messages of one conversation's chat (person and AI), oldest first, with a cursor; give the cursor back as "since" for only what came after. ${READ_DEFAULT} by default, ${READ_MAX} at most.`,
    inputSchema: { type: 'object', properties: { conversation: CONVERSATION_ARG, last: { type: 'integer', minimum: 1, maximum: READ_MAX }, since: { type: 'string' } }, required: ['conversation'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const SAY_TOOL = {
    name: 'clavarium_say',
    title: 'Post a message in a conversation',
    description: 'Post a message in one conversation\'s chat, as the person would; it is shown signed with this key\'s name. The conversation must have been given to this key to talk.',
    inputSchema: { type: 'object', properties: { conversation: CONVERSATION_ARG, text: { type: 'string', minLength: 1, maxLength: SAY_MAX } }, required: ['conversation', 'text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
const ROOM_ARG = { type: 'string', description: 'The room\'s id, as clavarium_rooms gives it.' };
const BOX_ARG = { type: 'string', description: 'The voice box\'s id, as clavarium_boxes gives it.' };
export const ROOMS_TOOL = {
    name: 'clavarium_rooms',
    title: 'Rooms of this key',
    description: 'The rooms this key was given, each with its id, name, level (read or talk), its host and its members by name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const ROOM_READ_TOOL = {
    name: 'clavarium_room_read',
    title: 'Read a room',
    description: `The newest messages of one room's thread (the person, its AIs, its voice boxes, keys), oldest first, by names; secrets masked. A cursor as for clavarium_read. ${READ_DEFAULT} by default, ${READ_MAX} at most.`,
    inputSchema: { type: 'object', properties: { room: ROOM_ARG, last: { type: 'integer', minimum: 1, maximum: READ_MAX }, since: { type: 'string' } }, required: ['room'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const ROOM_SAY_TOOL = {
    name: 'clavarium_room_say',
    title: 'Post a message in a room',
    description: 'Post a message in one room, as the person would: it goes to the room\'s host, or to the AIs named in "to" (their names, as clavarium_rooms gives them). Shown signed with this key\'s name. The room must have been given to this key to talk.',
    inputSchema: { type: 'object', properties: { room: ROOM_ARG, text: { type: 'string', minLength: 1, maxLength: SAY_MAX }, to: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['room', 'text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
export const BOXES_TOOL = {
    name: 'clavarium_boxes',
    title: 'Voice boxes of this key',
    description: 'The voice boxes this key was given, each with its id, name, level (state or speak), whether it is online, where it speaks, when it last heard someone, and its volume. Nothing it heard.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const BOX_SAY_TOOL = {
    name: 'clavarium_box_say',
    title: 'Say a short text aloud on a voice box',
    description: `Make one voice box say a short text aloud, in the home: ${SPEAK_MAX} characters at most, ${SPEAK_PER_MIN} a minute. It does not listen after. The box must have been given to this key to speak.`,
    inputSchema: { type: 'object', properties: { box: BOX_ARG, text: { type: 'string', minLength: 1, maxLength: SPEAK_MAX } }, required: ['box', 'text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
export const TOOLS = [STATUS_TOOL, CONVERSATIONS_TOOL, READ_TOOL, SAY_TOOL, ROOMS_TOOL, ROOM_READ_TOOL, ROOM_SAY_TOOL, BOXES_TOOL, BOX_SAY_TOOL];

/* Returns true when the request was under /api/ext/ (answered here). `status()`: the state, as statusOf
   makes it. `chats`: { list() -> [{ id, name }], read(name, part) -> talk.of's answer, chatOn(name),
   say(name, text, by) -> { told } }. `rooms`: { list() -> [{ id, name, host, members: [{ name, kind }] }],
   read(id, part) -> rooms.read's answer, say(id, text, { as, to }) }. `boxes`: { list() -> [{ id, name, online, where,
   heardAt, volume }], say(id, text, by) -> { seconds? } }. `originOk(headers)`: whether an Origin is this site's (gate.mjs); a
   call from a page of another site is refused. */
export async function handleExternal(request, response, { keys, status, chats = null, rooms = null, boxes = null, headers = {}, originOk = () => false, version = null }) {
    const url = new URL(request.url ?? '/', 'http://local');
    const { pathname } = url;
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
    const bodyOf = async (max) => {
        let text = '';
        for await (const piece of request) { text += piece; if (text.length > max) throw new Refusal(413, 'Too long.'); }
        return text;
    };
    /* What a key does with conversations, the same for the API and MCP. Each throws a Refusal. */
    const given = (id) => keys.conversationsOf(id);
    const listed = (id) => {
        const names = new Map((chats?.list() ?? []).map((c) => [c.id, c.name]));
        return { conversations: given(id).filter((c) => names.has(c.name)).map((c) => ({ id: c.name, name: names.get(c.name), level: c.level, chat: Boolean(chats?.chatOn(c.name)) })) };
    };
    const known = (name) => { if (!(chats?.list() ?? []).some((c) => c.id === name)) throw new Refusal(403, 'This key was not given this conversation.'); };
    const reading = (id, name, part) => {
        keys.mayConversation(id, name, 'read'); known(name);
        return threadOf(chats.read(name, part));
    };
    const saying = async (id, name, text) => {
        keys.mayConversation(id, name, 'talk'); known(name);
        if (typeof text !== 'string' || !text.trim()) throw new Refusal(400, 'Say something: text.');
        if (text.length > SAY_MAX) throw new Refusal(400, `${SAY_MAX} characters at most.`);
        const said = await chats.say(name, text, keys.signature(id));
        return { ok: true, told: typeof said?.told === 'string' ? said.told : null };
    };
    /* The same for rooms and voice boxes. */
    const roomsListed = (id) => {
        const there = new Map((rooms?.list() ?? []).map((r) => [r.id, r]));
        return { rooms: keys.roomsOf(id).filter((g) => there.has(g.id)).map((g) => { const r = there.get(g.id);
            return { id: g.id, name: String(r.name ?? ''), level: g.level, host: r.host ?? null, members: (Array.isArray(r.members) ? r.members : []).map((m) => ({ name: String(m.name ?? ''), kind: String(m.kind ?? '') })) }; }) };
    };
    const roomKnown = (room) => { if (!(rooms?.list() ?? []).some((r) => r.id === room)) throw new Refusal(403, 'This key was not given this room.'); };
    const roomReading = (id, room, part) => {
        keys.mayRoom(id, room, 'read'); roomKnown(room);
        return roomThreadOf(rooms.read(room, part));
    };
    const roomSaying = async (id, room, text, to) => {
        keys.mayRoom(id, room, 'talk'); roomKnown(room);
        if (typeof text !== 'string' || !text.trim()) throw new Refusal(400, 'Say something: text.');
        if (text.length > SAY_MAX) throw new Refusal(400, `${SAY_MAX} characters at most.`);
        if (to !== undefined && to !== null && (!Array.isArray(to) || to.length > 20 || to.some((x) => typeof x !== 'string'))) throw new Refusal(400, 'to: the names of AIs of this room.');
        const done = await rooms.say(room, text, { as: keys.roomSignature(id), to: Array.isArray(to) ? to : [] });
        /* Posted; an AI it could not reach (its chat off) said by name. */
        return done?.missed?.length ? { ok: true, notReached: done.missed.map((m) => m.name) } : { ok: true };
    };
    const boxesListed = (id) => {
        const there = new Map((boxes?.list() ?? []).map((b) => [b.id, b]));
        return { boxes: keys.boxesOf(id).filter((g) => there.has(g.id)).map((g) => { const b = there.get(g.id);
            return { id: g.id, name: String(b.name ?? ''), level: g.level, online: Boolean(b.online), where: b.where ?? null, heardAt: b.heardAt ?? null, volume: Number.isFinite(b.volume) ? b.volume : null }; }) };
    };
    const boxSaying = async (id, box, text) => {
        keys.mayBox(id, box, 'speak');
        if (!(boxes?.list() ?? []).some((b) => b.id === box)) throw new Refusal(403, 'This key was not given this voice box.');
        if (typeof text !== 'string' || !text.trim()) throw new Refusal(400, 'Say something: text.');
        if (text.length > SPEAK_MAX) throw new Refusal(400, `${SPEAK_MAX} characters at most, said aloud.`);
        keys.speakCounted(id, box);
        const done = await boxes.say(box, text, keys.signature(id));
        return { ok: true, ...(Number.isFinite(done?.seconds) ? { seconds: done.seconds } : {}) };
    };
    const ownError = (error, id) => (error instanceof Refusal ? Object.assign(error, { key: error.key ?? id }) : error);
    try {
        if (route === '/v1/status') {
            if (request.method !== 'GET') return send(405, { error: 'Call this address with GET.' }, { allow: 'GET' });
            let id;
            try { id = keys.check(request.headers.authorization, 'status'); } catch (error) { return refused(error); }
            const body = await status();
            note(id, 200);
            return send(200, body);
        }
        const one = /^\/v1\/conversations(?:\/([^/]+)\/messages)?$/.exec(route);
        if (one) {
            const allowed = one[1] ? 'GET, POST' : 'GET';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!one[1]) { const body = listed(id); note(id, 200); return send(200, body); }
                let name;
                try { name = decodeURIComponent(one[1]); } catch { name = ''; }
                if (request.method === 'GET') { const body = reading(id, name, readPart((k) => url.searchParams.get(k))); note(id, 200); return send(200, body); }
                if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON: {"text": "..."}.');
                let body;
                try { body = JSON.parse(await bodyOf(SAY_MAX * 4 + 1024)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, 'The request is not JSON.'); }
                const done = await saying(id, name, body?.text);
                note(id, 201);
                return send(201, done);
            } catch (error) { return refused(ownError(error, id)); }
        }
        const room = /^\/v1\/rooms(?:\/([^/]+)\/messages)?$/.exec(route);
        if (room) {
            const allowed = room[1] ? 'GET, POST' : 'GET';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!room[1]) { const body = roomsListed(id); note(id, 200); return send(200, body); }
                let ref;
                try { ref = decodeURIComponent(room[1]); } catch { ref = ''; }
                if (request.method === 'GET') { const body = roomReading(id, ref, readPart((k) => url.searchParams.get(k))); note(id, 200); return send(200, body); }
                if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON: {"text": "..."}.');
                let body;
                try { body = JSON.parse(await bodyOf(SAY_MAX * 4 + 4096)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, 'The request is not JSON.'); }
                const done = await roomSaying(id, ref, body?.text, body?.to);
                note(id, 201);
                return send(201, done);
            } catch (error) { return refused(ownError(error, id)); }
        }
        const box = /^\/v1\/boxes(?:\/([^/]+)\/say)?$/.exec(route);
        if (box) {
            const allowed = box[1] ? 'POST' : 'GET';
            if (request.method !== allowed) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!box[1]) { const body = boxesListed(id); note(id, 200); return send(200, body); }
                let ref;
                try { ref = decodeURIComponent(box[1]); } catch { ref = ''; }
                if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON: {"text": "..."}.');
                let body;
                try { body = JSON.parse(await bodyOf(SPEAK_MAX * 4 + 1024)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, 'The request is not JSON.'); }
                const done = await boxSaying(id, ref, body?.text);
                note(id, 200);
                return send(200, done);
            } catch (error) { return refused(ownError(error, id)); }
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
            const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? msg.params.arguments : {};
            /* The journal says which tool, and on which conversation, room or box. */
            const on = [args.conversation, args.room, args.box].find((v) => typeof v === 'string');
            const what = `/mcp ${msg.method.slice(0, 40)}${msg.method === 'tools/call' ? ` ${String(msg.params?.name ?? '').slice(0, 40)}${on ? ` ${on.slice(0, 36)}` : ''}` : ''}`;
            /* A notification (no id) is taken, never answered. */
            if (msg.id === undefined || msg.id === null) { note(id, 202, what); response.writeHead(202, { ...headers, 'cache-control': 'no-store' }).end(); return true; }
            const answer = (result, code = 200) => { note(id, code, what); return send(200, { jsonrpc: '2.0', id: msg.id, result }); };
            const fail = (code, message, http = 200) => { note(id, http === 200 ? 400 : http, what); return send(http, { jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
            const result = (body) => answer({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: false });
            switch (msg.method) {
            case 'initialize': {
                const asked = String(msg.params?.protocolVersion ?? '');
                return answer({ protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'clavarium', title: 'Clavarium', version: version ?? '0' },
                    instructions: 'This Clavarium, as far as this key was given it: its state (clavarium_status), the conversations given to it (clavarium_conversations), to read (clavarium_read) or to talk in (clavarium_say); its rooms (clavarium_rooms, clavarium_room_read, clavarium_room_say); its voice boxes (clavarium_boxes; clavarium_box_say says a short text aloud in the home).' });
            }
            case 'ping': return answer({});
            case 'tools/list': return answer({ tools: TOOLS });
            case 'tools/call': {
                const name = msg.params?.name;
                if (!TOOLS.some((x) => x.name === name)) return fail(-32602, `Unknown tool: ${String(name ?? '').slice(0, 60)}`);
                try {
                    if (name === STATUS_TOOL.name) {
                        if (!keys.may(id, 'status')) throw new Refusal(403, `This key was not given the scope "${SCOPES.status.label}".`);
                        return result(await status());
                    }
                    if (name === CONVERSATIONS_TOOL.name) return result(listed(id));
                    if (name === ROOMS_TOOL.name) return result(roomsListed(id));
                    if (name === BOXES_TOOL.name) return result(boxesListed(id));
                    const part = () => readPart((k) => (args[k] === undefined ? null : typeof args[k] === 'number' ? String(args[k]) : args[k]));
                    let done;
                    if (name === ROOM_READ_TOOL.name || name === ROOM_SAY_TOOL.name) {
                        if (typeof args.room !== 'string') return fail(-32602, 'room: the id of a room.');
                        if (name === ROOM_READ_TOOL.name) return result(roomReading(id, args.room, part()));
                        done = await roomSaying(id, args.room, args.text, args.to);
                    } else if (name === BOX_SAY_TOOL.name) {
                        if (typeof args.box !== 'string') return fail(-32602, 'box: the id of a voice box.');
                        done = await boxSaying(id, args.box, args.text);
                    } else {
                        if (typeof args.conversation !== 'string') return fail(-32602, 'conversation: the id of a conversation.');
                        if (name === READ_TOOL.name) return result(reading(id, args.conversation, part()));
                        done = await saying(id, args.conversation, args.text);
                    }
                    note(id, 201, what);
                    return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(done) }], structuredContent: done, isError: false } });
                } catch (error) {
                    if (!(error instanceof Refusal)) throw error;
                    /* Not given: refused as the API refuses it (too many, too). Anything else is the tool's own failure, said to the caller. */
                    if (error.status === 429) { note(id, 429, what); return send(429, { jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: error.message } }, { 'retry-after': String(error.retry ?? 60) }); }
                    if (error.status === 403) { note(id, 403, what); return send(403, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: error.message } }); }
                    note(id, error.status, what);
                    return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
                }
            }
            default: return fail(-32601, 'Method not found');
            }
        }
        note(null, 404);
        return send(404, { error: 'Not found. GET /api/ext/v1/status, /api/ext/v1/conversations, /api/ext/v1/rooms, /api/ext/v1/boxes, or MCP at /api/ext/mcp.' });
    } catch (error) {
        if (error instanceof Refusal) return refused(error);
        note(null, 500);
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
        for await (const piece of request) { text += piece; if (text.length > 16_384) return send(413, { error: 'Too long.' }); }
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { return send(400, { error: 'The request is not JSON.' }); }
        if (!body || typeof body !== 'object') body = {};
        if (pathname === '/api/apikeys') {
            const made = keys.create({ label: body.label, scopes: body.scopes ?? [], conversations: body.conversations ?? {}, rooms: body.rooms ?? {}, boxes: body.boxes ?? {}, days: body.days === undefined ? DEFAULT_DAYS : body.days }, who);
            /* Its name and scopes; never the secret. */
            const what = [...made.key.scopes, ...made.key.conversations.map((c) => `${c.name} ${c.level}`), ...made.key.rooms.map((r) => `room ${r.id.slice(0, 8)} ${r.level}`), ...made.key.boxes.map((b) => `voice box ${b.id.slice(0, 8)} ${b.level}`)];
            events?.add({ kind: 'access', text: `API key "${made.key.label}" made${what.length ? ` (${what.join(', ')})` : ' (no scope)'}`, who: who || null });
            return send(201, made);
        }
        const giving = /^\/api\/apikeys\/([0-9a-f-]{36})\/conversations$/.exec(pathname);
        if (giving) {
            const level = body.level === undefined ? null : body.level;
            const key = keys.setConversation(giving[1], body.conversation, level);
            events?.add({ kind: 'access', text: `API key "${key.label}": ${body.conversation} ${level ?? 'taken back'}`, who: who || null });
            return send(200, { key });
        }
        const one = /^\/api\/apikeys\/([0-9a-f-]{36})\/(rooms|boxes)$/.exec(pathname);
        if (one) {
            const level = body.level === undefined ? null : body.level;
            const room = one[2] === 'rooms';
            const ref = room ? body.room : body.box;
            const key = room ? keys.setRoom(one[1], ref, level) : keys.setBox(one[1], ref, level);
            events?.add({ kind: 'access', text: `API key "${key.label}": ${room ? 'room' : 'voice box'} ${String(ref).slice(0, 8)} ${level ?? 'taken back'}`, who: who || null });
            return send(200, { key });
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
