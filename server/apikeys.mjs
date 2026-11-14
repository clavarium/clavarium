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
 *   jobs      read what Clavarium does -- conversations built, copied,
 *             moved, restarted, its own updates of the day -- and each
 *             job's log, as Settings shows them (jobs.mjs; secrets
 *             masked)                                         server:jobs r
 *
 *   a conversation, given ONE BY ONE (never "all, and those to come"):
 *     read    read its chat                                   conversation:<name> r
 *     talk    and post a message in it, as the chat does,
 *             signed with the key's name, never as the person  conversation:<name> rw
 *     act     and wake it, put it to sleep, stop its turn --
 *             as the owner's buttons do                       conversation:<name> rwm
 *   A conversation archived takes its lines with it (devices.forget). Its
 *   terminal ("x") is never given to a key.
 *
 *   a room, given ONE BY ONE the same way:
 *     read    read its thread, as the page reads it (names, never ids;
 *             secrets masked)                                 room:<id> r
 *     talk    and post in it as the person does -- to its host, or to the AIs
 *             named -- signed with the key's name and look    room:<id> rw
 *     manage  and rename it, add or take away members, change
 *             its host, remove it -- its members only among the
 *             conversations and boxes the key was given        room:<id> rwm
 *   create rooms   make a room (its members as above): the room a key
 *             makes is given to it at "manage"                server:rooms w
 *
 *   a voice box, given ONE BY ONE:
 *     state   online, where it speaks, when it last heard, its volume --
 *             nothing it heard, never audio                   box:<id> r
 *     speak   and make it say a short text aloud (SPEAK_MAX characters,
 *             SPEAK_PER_MIN a minute per key and box): never listen, record,
 *             change its settings nor update it               box:<id> rw
 *   A room removed, a box withdrawn, takes its lines with it (main.mjs).
 *
 *   a binder list (Binder), given ONE BY ONE (07-11):
 *     read    list its records, read one with its notes (secrets masked)
 *     write   and add a record, change its title, description, fields and
 *             due date, move it between states, add a note, archive or
 *             restore it -- as a conversation given the list to change may
 *   Kept where Binder keeps a conversation's lists: the list's own access
 *   ("apikey:<id>": read | write), not this table. The key asks Binder as an
 *   agent, signed with its name: Binder's own rules hold -- past a gate only
 *   what a person approved; never approve, delete, give access, change a
 *   list. Revoked, a key's lists go with it.
 *
 *   a conversation's REMINDERS (its tool's Docket), folded into its level:
 *     read    sees them
 *     talk    and sets one: at a time, or a cron line, with a short text
 *     act     and takes one back
 *   Its chat must be on (a docket is there only then).
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
 * all together, so that they cannot flood the journal. What a key DOES (a
 * conversation woken, a room made...) is said in What happened too, with
 * its name.
 *
 * THE KEY'S RIGHTS ARE THE SECURITY (07-11, the owner): no approval card for
 * what a key was given. Three limits hold whatever it was given: a key never
 * reads a secret's value; never makes a key or an account; never changes its
 * own rights or any key's -- no route under /api/ext/ reaches any of them.
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
 *   POST /api/apikeys/<id>/binders      {binder, level: 'read'|'write'|null}
 *   (and on creation: rooms: {id: level}, boxes: {id: level}, binders: {id: level})
 *   POST /api/apikeys/<id>/revoke
 *   GET  /api/apikeys/<id>/journal      its last uses
 *
 *   Authorization: Bearer clv_... on each of these:
 *   GET  /api/ext/v1/status                              the state, as JSON
 *   GET  /api/ext/v1/jobs                                (jobs) what it does: {running, done}, newest first, without their logs
 *   GET  /api/ext/v1/jobs/<id>                           (jobs) that job, under way or done today, with its log [{at, text}] (404: unknown)
 *   GET  /api/ext/v1/conversations                       those it may read: {conversations: [{id, name, level, chat}]}
 *   GET  /api/ext/v1/conversations/<name>/messages       ?last=1..200 (50) | ?since=<cursor>: {chat, messages, cursor}
 *   POST /api/ext/v1/conversations/<name>/messages       {text}: posted in its chat, signed with the key's name
 *   POST /api/ext/v1/conversations/<name>/wake|sleep|stop  (act) woken, put to sleep, its turn stopped (Escape)
 *   GET  /api/ext/v1/rooms                               those it may read: {rooms: [{id, name, level, host, members}]}
 *   GET  /api/ext/v1/rooms/<id>/messages                 as a conversation's: {messages, cursor}
 *   POST /api/ext/v1/rooms/<id>/messages                 {text, to?: [names of its AIs]}: posted in the room, signed with the key
 *   POST /api/ext/v1/rooms                               (create rooms) {name, conversations?: [ids], boxes?: [ids], host?: id}
 *   POST /api/ext/v1/rooms/<id>                          (manage) {name?, host?: id, add?: {conversations, boxes}, remove?: {conversations, boxes}}
 *   POST /api/ext/v1/rooms/<id>/remove                   (manage) the room removed
 *   GET  /api/ext/v1/boxes                               {boxes: [{id, name, level, online, where, heardAt, volume}]}
 *   POST /api/ext/v1/boxes/<id>/say                      {text}: said aloud by the box
 *   GET  /api/ext/v1/conversations/<name>/reminders      (read) {reminders: [{id, text, cron, next}]}
 *   POST /api/ext/v1/conversations/<name>/reminders      (talk) {text, at: "2026-11-20 09:00" | cron: "0 9 * * 1"}
 *   POST /api/ext/v1/conversations/<name>/reminders/<id>/cancel  (act) taken back
 *   GET  /api/ext/v1/binders                             {binders: [{id, title, level, states, fields, count}]}
 *   GET  /api/ext/v1/binders/<list>/records              ?state=&archived=1: {records}
 *   GET  /api/ext/v1/binders/<list>/records/<id>         {record}: with its notes
 *   POST /api/ext/v1/binders/<list>/records              (write) {title, description?, state?, fields?, due?}
 *   POST /api/ext/v1/binders/<list>/records/<id>         (write) {title?, description?, fields?, due?}
 *   POST /api/ext/v1/binders/<list>/records/<id>/move    (write) {state}: never past a gate a person did not tick
 *   POST /api/ext/v1/binders/<list>/records/<id>/notes   (write) {text}
 *   POST /api/ext/v1/binders/<list>/records/<id>/archive|restore  (write)
 *   POST /api/ext/mcp                   the same as MCP tools (clavarium_status, clavarium_jobs, clavarium_job_log, clavarium_conversations,
 *                                       clavarium_read, clavarium_say, clavarium_rooms, clavarium_room_read,
 *                                       clavarium_room_say, clavarium_boxes, clavarium_box_say, clavarium_conversation_wake,
 *                                       clavarium_conversation_sleep, clavarium_conversation_stop, clavarium_room_create,
 *                                       clavarium_room_change, clavarium_room_remove, clavarium_reminders, clavarium_remind,
 *                                       clavarium_reminder_cancel, clavarium_binders, clavarium_binder_records,
 *                                       clavarium_binder_record, clavarium_binder_add, clavarium_binder_edit,
 *                                       clavarium_binder_move, clavarium_binder_note, clavarium_binder_archive), JSON-RPC over HTTP
 *                                       (Streamable HTTP, stateless, JSON answers; also at /api/ext/v1/mcp). A tool
 *                                       that needs a scope (status, jobs, create rooms) is listed only to a key given it.
 *   A conversation, room, box or list not given, or not there, is the same 403: a key learns nothing of what it was not given.
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
export const SCOPES = Object.freeze({ status: { asset: 'server:status', rights: 'r', label: 'Its state (memory, disk, versions)' },
    jobs: { asset: 'server:jobs', rights: 'r', label: 'Jobs: read what Clavarium does and its logs' },
    'create-rooms': { asset: 'server:rooms', rights: 'w', label: 'Create rooms' } });
/* What a key may do in one conversation: [rights in the table]. */
export const LEVELS = Object.freeze({ read: 'r', talk: 'rw', act: 'rwm' });
export const levelOf = (rights) => (String(rights).includes('m') ? 'act' : String(rights).includes('w') ? 'talk' : String(rights).includes('r') ? 'read' : null);
/* The messages one read gives, by default and at most. */
export const READ_DEFAULT = 50;
export const READ_MAX = 200;
export const SAY_MAX = 8000;
/* What a room and a voice box may be given: [rights in the table]. */
export const ROOM_LEVELS = Object.freeze({ read: 'r', talk: 'rw', manage: 'rwm' });
export const roomLevelOf = (rights) => (String(rights).includes('m') ? 'manage' : String(rights).includes('w') ? 'talk' : String(rights).includes('r') ? 'read' : null);
export const BOX_LEVELS = Object.freeze({ state: 'r', speak: 'rw' });
export const boxLevelOf = (rights) => (String(rights).includes('w') ? 'speak' : String(rights).includes('r') ? 'state' : null);
/* What a binder list may be given: Binder's own access words. */
export const BINDER_LEVELS = Object.freeze({ read: 'read', write: 'write' });
/* A reminder a key sets: a short text. */
export const REMINDER_MAX = 200;
/* A binder list's id, as Binder makes it. */
const LIST_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
/* Said aloud in the home: short, and a few a minute (per key and box). */
export const SPEAK_MAX = 300;
export const SPEAK_PER_MIN = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const digest = (text) => createHash('sha256').update(text).digest();
const oneLine = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= LABEL_MAX
    && ![...value].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0) || (p >= 0x200b && p <= 0x200f) || (p >= 0x202a && p <= 0x202e); });
const SECRET = /^clv_[A-Za-z0-9_-]{43}$/;

export class ApiKeys {
    #store; #grants; #now; #journal; #exists; #kinds; #binders;
    #used = new Map();       /* id -> { at, savedAt } */
    #calls = new Map();      /* id ('' for unknown keys) -> [times of the last minute] */

    /* `exists(name)`: whether a conversation is there (one is given only then); `roomExists(id)`,
       `boxExists(id)`: the same for a room, a voice box (none, without them). `binders`: Binder's lists, as a person
       sees them -- { lists() -> [{ id, title, archived, grants }], grant(list, subject, level | null, who) } (none, without). */
    constructor({ store, grants = new Grants(), journal = null, now = () => Date.now(), exists = () => true, roomExists = () => false, boxExists = () => false, binders = null }) {
        this.#store = store; this.#grants = grants; this.#journal = journal; this.#now = now; this.#exists = exists; this.#binders = binders;
        /* What is given one by one: its asset type, its levels, a valid name, whether it is there, its words. */
        this.#kinds = {
            room: { levels: ROOM_LEVELS, of: roomLevelOf, valid: (v) => typeof v === 'string' && UUID.test(v), exists: roomExists, what: 'room', the: 'a room' },
            box: { levels: BOX_LEVELS, of: boxLevelOf, valid: (v) => typeof v === 'string' && UUID.test(v), exists: boxExists, what: 'voice box', the: 'a voice box' },
        };
    }

    #scopesOf(id) { return Object.entries(SCOPES).filter(([, s]) => this.#grants.can(apiKeySubject(id), s.asset, s.rights)).map(([name]) => name); }
    #shown(k) {
        const used = this.#used.get(k.name)?.at ?? k.usedAt ?? null;
        return { id: k.name, label: k.label, scopes: this.#scopesOf(k.name), conversations: this.conversationsOf(k.name), rooms: this.roomsOf(k.name), boxes: this.boxesOf(k.name), binders: this.bindersOf(k.name), createdBy: k.createdBy ?? null, createdAt: k.createdAt, expiresAt: k.expiresAt ?? null,
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

    /* ITS BINDER LISTS: kept in Binder, on each list (see above). Archived lists are not given (nor shown). */
    #lists() { try { return (this.#binders?.lists() ?? []).filter((l) => l && typeof l.id === 'string'); } catch { return []; } }
    bindersOf(id) {
        const subject = apiKeySubject(id);
        return this.#lists().filter((l) => !l.archived && Object.hasOwn(BINDER_LEVELS, l.grants?.[subject] ?? '')).map((l) => ({ id: l.id, level: l.grants[subject] }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }
    #binderAsked(list, level) {
        if (!this.#binders || typeof list !== 'string' || !LIST_ID.test(list) || !this.#lists().some((l) => l.id === list && !l.archived)) throw new Refusal(404, 'No such binder.');
        if (level !== null && !Object.hasOwn(BINDER_LEVELS, level)) throw new Refusal(400, `A binder is given at one of: ${Object.keys(BINDER_LEVELS).join(', ')}.`);
    }
    /* One list given to a key, its level changed, or taken back (level null). `who`: the person, as Binder's history says it. */
    setBinder(id, list, level, who = '') {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#binderAsked(list, level);
        this.#binders.grant(list, apiKeySubject(id), level, who);
        return this.get(id);
    }
    /* Whether a key (already checked) may read ('read') or change ('write') one list; 403 if not -- the same for one
       not given, archived, or not there. */
    mayBinder(id, list, level = 'read') {
        const l = typeof list === 'string' && LIST_ID.test(list) ? this.#lists().find((x) => x.id === list && !x.archived) : undefined;
        const has = l?.grants?.[apiKeySubject(id)];
        if (!Object.hasOwn(BINDER_LEVELS, has ?? '')) throw Object.assign(new Refusal(403, 'This key was not given this binder.'), { key: id });
        if (level === 'write' && has !== 'write') throw Object.assign(new Refusal(403, 'This key may read this binder, not change it.'), { key: id });
        return has;
    }
    binderTitle(list) { return this.#lists().find((l) => l.id === list)?.title ?? list; }
    /* Who the key is to Binder: an agent, signed with its name -- never a person (a person approves, deletes, gives). */
    binderWho(id) { const k = this.#store.get(id); return k ? { id: apiKeySubject(id), kind: 'agent', name: k.label } : null; }

    #conversationAsked(name, level) {
        if (!isConversationName(name) || !this.#exists(name)) throw new Refusal(404, 'No such conversation.');
        if (level !== null && !Object.hasOwn(LEVELS, level)) throw new Refusal(400, `A conversation is given to read, to talk or to act: ${Object.keys(LEVELS).join(', ')}.`);
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
    create({ label, scopes = [], conversations = {}, rooms = {}, boxes = {}, binders = {}, days = DEFAULT_DAYS } = {}, who = '') {
        if (!oneLine(label)) throw new Refusal(400, `A key has a name: one line, ${LABEL_MAX} characters at most.`);
        if (!Array.isArray(scopes) || scopes.some((s) => !Object.hasOwn(SCOPES, s))) throw new Refusal(400, `Scopes are among: ${Object.keys(SCOPES).join(', ')}.`);
        if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) throw new Refusal(400, 'Conversations are given by name: {name: "read" | "talk"}.');
        for (const [name, level] of Object.entries(conversations)) this.#conversationAsked(name, level);
        this.#givenAll('room', rooms); this.#givenAll('box', boxes);
        if (!binders || typeof binders !== 'object' || Array.isArray(binders)) throw new Refusal(400, 'Binders are given by id: {id: level}.');
        for (const [list, level] of Object.entries(binders)) this.#binderAsked(list, level);
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
        for (const [list, level] of Object.entries(binders)) if (level !== null) this.#binders.grant(list, apiKeySubject(id), level, who);
        return { key: this.#shown(record), secret };
    }

    /* At once: the next call with it is refused. */
    revoke(id) {
        if (typeof id !== 'string' || !this.#store.get(id)) throw new Refusal(404, 'No such key.');
        this.#store.remove(id);
        this.#grants.forgetSubject(apiKeySubject(id));
        for (const l of this.#lists()) if (l.grants?.[apiKeySubject(id)]) { try { this.#binders.grant(l.id, apiKeySubject(id), null); } catch { /* gone already */ } }
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
        if (level === 'act' && !rights.includes('m')) throw Object.assign(new Refusal(403, 'This key may not act on this conversation (wake, sleep, stop).'), { key: id });
        return levelOf(rights);
    }

    /* Whether a key (already checked) may read ('read') or post in ('talk') one room; 403 if not, the same for one
       not given and one not there. */
    mayRoom(id, room, level = 'read') {
        const rights = typeof room === 'string' && UUID.test(room) && this.#kinds.room.exists(room) ? this.#grants.rightsOf(apiKeySubject(id), `room:${room}`) : '';
        if (!rights.includes('r')) throw Object.assign(new Refusal(403, 'This key was not given this room.'), { key: id });
        if (level === 'talk' && !rights.includes('w')) throw Object.assign(new Refusal(403, 'This key may read this room, not talk in it.'), { key: id });
        if (level === 'manage' && !rights.includes('m')) throw Object.assign(new Refusal(403, 'This key may not manage this room.'), { key: id });
        return roomLevelOf(rights);
    }

    /* A ROOM THE KEY MADE ITSELF (with "create rooms") is given to it at "manage". This is the one right a key ever
       gets on its own, and it is not a key changing its rights: it is scoped to what it created, and nothing else
       of this key or any other changes -- a room made by another, a conversation, a box, a scope stay as they were. */
    madeRoom(id, room) {
        if (!this.may(id, 'create-rooms')) throw Object.assign(new Refusal(403, `This key was not given the scope "${SCOPES['create-rooms'].label}".`), { key: id });
        if (typeof room !== 'string' || !UUID.test(room) || !this.#kinds.room.exists(room)) throw new Refusal(404, 'No such room.');
        this.#grants.give(apiKeySubject(id), `room:${room}`, ROOM_LEVELS.manage);
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

/* A job's id, as jobs.mjs makes it (its conversation and when it started). */
const JOB_ID = /^[A-Za-z0-9_-]{1,120}$/;
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
export const JOBS_TOOL = {
    name: 'clavarium_jobs',
    title: 'Jobs of this Clavarium',
    description: 'Read-only: what this Clavarium does or did today -- conversations built, copied, moved, restarted, and its own updates -- as {running, done}, newest first, each with its id, what, start and end, result. No logs: clavarium_job_log gives one job\'s.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const JOB_LOG_TOOL = {
    name: 'clavarium_job_log',
    title: 'Log of a job',
    description: 'Read-only: one job, under way or done today, with its log (lines {at, text}).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The job\'s id, as clavarium_jobs gives it.' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const CONVERSATIONS_TOOL = {
    name: 'clavarium_conversations',
    title: 'Conversations of this key',
    description: 'The conversations this key was given, each with its id, name, level (read, talk or act) and whether its chat is on.',
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
    description: 'The rooms this key was given, each with its id, name, level (read, talk or manage), its host and its members by name (with their id when this key was given them).',
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
/* To act on a conversation (level "act"), and to manage rooms (level "manage", or "create rooms"). */
const actTool = (act, title, description, destructive) => ({
    name: `clavarium_conversation_${act}`, title, description: `${description} The conversation must have been given to this key to act.`,
    inputSchema: { type: 'object', properties: { conversation: CONVERSATION_ARG }, required: ['conversation'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true, openWorldHint: false },
});
export const WAKE_TOOL = actTool('wake', 'Wake a conversation', 'Wake one conversation\'s machine (asleep: it starts again; awake: nothing changes).', false);
export const SLEEP_TOOL = actTool('sleep', 'Put a conversation to sleep', 'Put one conversation\'s machine to sleep, as the owner\'s Sleep button does: its files and chat are kept.', false);
export const STOP_TOOL = actTool('stop', 'Stop a conversation\'s turn', 'Stop what one conversation\'s AI is doing now (its current turn, as Escape does); the conversation stays awake.', true);
const IDS = { type: 'array', items: { type: 'string' }, maxItems: 40 };
const MEMBERS_ARG = { type: 'object', properties: { conversations: { ...IDS, description: 'Conversation ids, as clavarium_conversations gives them.' }, boxes: { ...IDS, description: 'Voice box ids, as clavarium_boxes gives them.' } }, additionalProperties: false };
export const ROOM_CREATE_TOOL = {
    name: 'clavarium_room_create',
    title: 'Create a room',
    description: 'Make a room with conversations (AIs) and voice boxes this key was given; one conversation at least, its host (the first by default). The room is then given to this key to manage. Needs the scope "Create rooms".',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, conversations: { ...IDS, minItems: 1, description: 'Conversation ids, as clavarium_conversations gives them.' }, boxes: { ...IDS, description: 'Voice box ids, as clavarium_boxes gives them.' }, host: CONVERSATION_ARG }, required: ['name', 'conversations'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};
export const ROOM_CHANGE_TOOL = {
    name: 'clavarium_room_change',
    title: 'Change a room',
    description: 'Rename a room, add or take away members (only conversations and voice boxes this key was given), or change its host (one of its conversations). The room must have been given to this key to manage.',
    inputSchema: { type: 'object', properties: { room: ROOM_ARG, name: { type: 'string', minLength: 1, maxLength: 60 }, host: CONVERSATION_ARG, add: MEMBERS_ARG, remove: MEMBERS_ARG }, required: ['room'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};
export const ROOM_REMOVE_TOOL = {
    name: 'clavarium_room_remove',
    title: 'Remove a room',
    description: 'Remove one room and its thread, for good. The room must have been given to this key to manage.',
    inputSchema: { type: 'object', properties: { room: ROOM_ARG }, required: ['room'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};
/* A conversation's reminders (its tool's Docket): seen at Read, set at Talk, taken back at Act. */
const tool = (name, title, description, properties, required, write, destructive = false) => ({ name, title, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: false } });
export const REMINDERS_TOOL = tool('clavarium_reminders', 'Reminders of a conversation',
    'The reminders set in one conversation\'s tool (its Docket): each with its id, text, cron line (if it recurs) and when it is next due. The conversation must have been given to this key, its chat on.',
    { conversation: CONVERSATION_ARG }, ['conversation'], false);
export const REMIND_TOOL = tool('clavarium_remind', 'Set a reminder in a conversation',
    `Set a reminder for one conversation's AI: once at a time ("at": "2026-11-20 09:00", in this server's time zone) or recurring ("cron": "0 9 * * 1", Mondays at 9:00), with a short text (${REMINDER_MAX} characters at most). It wakes the AI when due. The conversation must have been given to this key to talk.`,
    { conversation: CONVERSATION_ARG, text: { type: 'string', minLength: 1, maxLength: REMINDER_MAX }, at: { type: 'string' }, cron: { type: 'string' } }, ['conversation', 'text'], true);
export const REMINDER_CANCEL_TOOL = tool('clavarium_reminder_cancel', 'Take back a reminder',
    'Take back one reminder of a conversation, by its id (as clavarium_reminders gives it). The conversation must have been given to this key to act.',
    { conversation: CONVERSATION_ARG, reminder: { type: 'string' } }, ['conversation', 'reminder'], true, true);
const BINDER_ARG = { type: 'string', description: 'The binder list\'s id, as clavarium_binders gives it.' };
const RECORD_ARG = { type: 'string', description: 'The record\'s id, as clavarium_binder_records gives it.' };
const FIELDS_ARG = { type: 'object', description: 'Field values by field id or name, as clavarium_binders gives them; null clears one.', additionalProperties: { type: ['string', 'number', 'null'] } };
const DUE_ARG = { type: ['string', 'null'], description: 'A due date: "2026-11-20", or "2026-11-20 09:00"; null clears it.' };
export const BINDERS_TOOL = tool('clavarium_binders', 'Binders of this key',
    'The binder lists this key was given, each with its id, title, level (read or write), its states (a gate is one only a person approves past) and its fields.', {}, [], false);
export const BINDER_RECORDS_TOOL = tool('clavarium_binder_records', 'Records of a binder',
    'The records of one binder list, in the order of its states: id, title, state, fields, owners, due date. "state" keeps one state; "archived": true lists the archived ones instead.',
    { binder: BINDER_ARG, state: { type: 'string' }, archived: { type: 'boolean' } }, ['binder'], false);
export const BINDER_RECORD_TOOL = tool('clavarium_binder_record', 'Read a record',
    'One record of a binder list, with its description and its notes.', { binder: BINDER_ARG, record: RECORD_ARG }, ['binder', 'record'], false);
export const BINDER_ADD_TOOL = tool('clavarium_binder_add', 'Add a record',
    'Add a record to a binder list, signed with this key\'s name: a title, and a description, a state (not past a gate), fields, a due date. The list must have been given to this key to write.',
    { binder: BINDER_ARG, title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string' }, state: { type: 'string' }, fields: FIELDS_ARG, due: DUE_ARG }, ['binder', 'title'], true);
export const BINDER_EDIT_TOOL = tool('clavarium_binder_edit', 'Change a record',
    'Change a record\'s title, description, fields or due date. The list must have been given to this key to write.',
    { binder: BINDER_ARG, record: RECORD_ARG, title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: ['string', 'null'] }, fields: FIELDS_ARG, due: DUE_ARG }, ['binder', 'record'], true);
export const BINDER_MOVE_TOOL = tool('clavarium_binder_move', 'Move a record',
    'Move a record to another state of its list. Past a gate, only a record a person approved: a key never approves. The list must have been given to this key to write.',
    { binder: BINDER_ARG, record: RECORD_ARG, state: { type: 'string', description: 'A state\'s id or name.' } }, ['binder', 'record', 'state'], true);
export const BINDER_NOTE_TOOL = tool('clavarium_binder_note', 'Add a note to a record',
    'Add a note to a record, signed with this key\'s name. The list must have been given to this key to write.',
    { binder: BINDER_ARG, record: RECORD_ARG, text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['binder', 'record', 'text'], true);
export const BINDER_ARCHIVE_TOOL = tool('clavarium_binder_archive', 'Archive a record',
    'Archive a record (or restore it: "restore": true). Never deleted: only a person deletes. The list must have been given to this key to write.',
    { binder: BINDER_ARG, record: RECORD_ARG, restore: { type: 'boolean' } }, ['binder', 'record'], true);
const BINDER_TOOLS = [BINDERS_TOOL, BINDER_RECORDS_TOOL, BINDER_RECORD_TOOL, BINDER_ADD_TOOL, BINDER_EDIT_TOOL, BINDER_MOVE_TOOL, BINDER_NOTE_TOOL, BINDER_ARCHIVE_TOOL];
export const TOOLS = [STATUS_TOOL, JOBS_TOOL, JOB_LOG_TOOL, CONVERSATIONS_TOOL, READ_TOOL, SAY_TOOL, WAKE_TOOL, SLEEP_TOOL, STOP_TOOL, REMINDERS_TOOL, REMIND_TOOL, REMINDER_CANCEL_TOOL,
    ROOMS_TOOL, ROOM_READ_TOOL, ROOM_SAY_TOOL, ROOM_CREATE_TOOL, ROOM_CHANGE_TOOL, ROOM_REMOVE_TOOL, BOXES_TOOL, BOX_SAY_TOOL, ...BINDER_TOOLS];
/* The tools that need a scope of the server: listed only to a key given it. */
const TOOL_SCOPES = Object.freeze({ [STATUS_TOOL.name]: 'status', [JOBS_TOOL.name]: 'jobs', [JOB_LOG_TOOL.name]: 'jobs', [ROOM_CREATE_TOOL.name]: 'create-rooms' });

/* Returns true when the request was under /api/ext/ (answered here). `status()`: the state, as statusOf
   makes it. `chats`: { list() -> [{ id, name }], read(name, part) -> talk.of's answer, chatOn(name),
   say(name, text, by) -> { told } }. `rooms`: { list() -> [{ id, name, host, members: [{ name, kind }] }],
   read(id, part) -> rooms.read's answer, say(id, text, { as, to }) }. `boxes`: { list() -> [{ id, name, online, where,
   heardAt, volume }], say(id, text, by) -> { seconds? } }. `originOk(headers)`: whether an Origin is this site's (gate.mjs); a
   call from a page of another site is refused.
   To act (07-11): `chats` also { wake(name) -> { state }, sleep(name), stop(name) } -- the owner's own calls; `rooms` also
   { create({ name, conversations, boxes, host }) -> { id }, change(id, { name, host, add, remove }) -- by member ids, as the
   page asks --, remove(id) }, and its list's members carry `ref` (a conversation's name, a box's id) and `id` (the member's).
   `events`: What happened (events.mjs), where each act is said with the key's name.
   07-11: `reminders`: { of(name) -> { on, plans: [{ id, text, cron, next }] }, set(name, { at, cron, text }, by) -> plan,
   cancel(name, plan) -> bool } -- a conversation's Docket (dockets.mjs). `binder`: { act(op, args, who) -> { ok, text, data } }
   -- Binder's keeper, asked as the key (an agent): its rules are Binder's.
   14-11: `jobs`: { list() -> { running, done }, log(id) -> the job with its log | undefined } (jobs.mjs, withUpdates). */
export async function handleExternal(request, response, { keys, status, chats = null, rooms = null, boxes = null, reminders = null, binder = null, jobs = null, events = null, headers = {}, originOk = () => false, version = null }) {
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
        /* A member's id only when the key was given it (a conversation's, a box's): what it may add or take away. */
        const convs = new Set(keys.conversationsOf(id).map((c) => c.name)); const bs = new Set(keys.boxesOf(id).map((b) => b.id));
        const mine = (m) => (m.kind === 'ai' && convs.has(m.ref)) || (m.kind === 'box' && bs.has(m.ref));
        return { rooms: keys.roomsOf(id).filter((g) => there.has(g.id)).map((g) => { const r = there.get(g.id);
            return { id: g.id, name: String(r.name ?? ''), level: g.level, host: r.host ?? null, members: (Array.isArray(r.members) ? r.members : []).map((m) => ({ name: String(m.name ?? ''), kind: String(m.kind ?? ''), ...(typeof m.ref === 'string' && mine(m) ? { id: m.ref } : {}) })) }; }) };
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
    /* SAID IN WHAT HAPPENED, with the key's name: what a key did, never what it read. */
    const said = (id, kind, text, conversation = null) => {
        const label = keys.signature(id)?.name ?? '';
        try { events?.add({ kind, text, ...(conversation ? { conversation } : {}), who: `API key "${label}"` }); } catch { /* never in the way */ }
    };
    /* ACT on a conversation (level "act"): the owner's own calls -- woken, put to sleep, its turn stopped. */
    const ACTS = { wake: 'woken', sleep: 'put to sleep', stop: 'its turn stopped' };
    const acting = async (id, name, act) => {
        keys.mayConversation(id, name, 'act'); known(name);
        if (typeof chats?.[act] !== 'function') throw new Refusal(409, 'Not possible here.');
        const done = await chats[act](name);
        said(id, act === 'stop' ? 'conversation' : 'machine', act === 'stop' ? `${name}: its turn stopped` : `Machine of ${name} ${ACTS[act]}`, name);
        return { ok: true, ...(typeof done?.state === 'string' ? { state: done.state } : {}) };
    };
    /* MANAGE a room (level "manage"), or make one ("create rooms"). Its members are named as the key knows them --
       a conversation by its id, a box by its id -- and only among those this key was given (at any level): else 403,
       the same for one not there. The body takes these fields and no other: never a level, a right, a key. */
    const refs = (value, what) => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value) || value.length > 40 || value.some((x) => typeof x !== 'string')) throw new Refusal(400, `${what}: a list of ids.`);
        return [...new Set(value)];
    };
    const sides = (value, what) => {
        if (value === undefined || value === null) return { conversations: [], boxes: [] };
        if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['conversations', 'boxes'].includes(k))) throw new Refusal(400, `${what}: {conversations: [ids], boxes: [ids]}.`);
        return { conversations: refs(value.conversations, `${what}.conversations`), boxes: refs(value.boxes, `${what}.boxes`) };
    };
    const onlyFields = (body, fields) => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'Send JSON: an object.');
        const other = Object.keys(body).filter((k) => !fields.includes(k));
        if (other.length) throw new Refusal(400, `Not a field here: ${other[0].slice(0, 40)}. Only: ${fields.join(', ')}.`);
    };
    const givenMembers = (id, { conversations, boxes: bs }) => {
        const convs = new Set(keys.conversationsOf(id).map((c) => c.name));
        const there = new Set((chats?.list() ?? []).map((c) => c.id));
        for (const c of conversations) if (!convs.has(c) || !there.has(c)) throw Object.assign(new Refusal(403, 'This key was not given this conversation.'), { key: id });
        const given = new Set(keys.boxesOf(id).map((b) => b.id));
        const boxesThere = new Set((boxes?.list() ?? []).map((b) => b.id));
        for (const b of bs) if (!given.has(b) || !boxesThere.has(b)) throw Object.assign(new Refusal(403, 'This key was not given this voice box.'), { key: id });
    };
    const roomShown = (id, room) => roomsListed(id).rooms.find((r) => r.id === room) ?? null;
    const roomCreating = (id, body) => {
        if (!keys.may(id, 'create-rooms')) throw Object.assign(new Refusal(403, `This key was not given the scope "${SCOPES['create-rooms'].label}".`), { key: id });
        onlyFields(body, ['name', 'conversations', 'boxes', 'host']);
        const members = { conversations: refs(body.conversations, 'conversations'), boxes: refs(body.boxes, 'boxes') };
        if (body.host !== undefined && body.host !== null && (typeof body.host !== 'string' || !members.conversations.includes(body.host))) throw new Refusal(400, 'host: one of its conversations.');
        givenMembers(id, members);
        if (typeof rooms?.create !== 'function') throw new Refusal(409, 'Not possible here.');
        const made = rooms.create({ name: body.name, conversations: members.conversations, boxes: members.boxes, ...(body.host ? { host: body.host } : {}) });
        /* The one right a key gets on its own: the room it made, at "manage" (see madeRoom). */
        keys.madeRoom(id, made.id);
        const shown = roomShown(id, made.id);
        said(id, 'conversation', `Room "${String(shown?.name ?? made.name ?? '').slice(0, 60)}" made`);
        return { ok: true, room: shown };
    };
    const roomChanging = (id, room, body) => {
        keys.mayRoom(id, room, 'manage'); roomKnown(room);
        onlyFields(body, ['name', 'host', 'add', 'remove']);
        const add = sides(body.add, 'add'); const remove = sides(body.remove, 'remove');
        if (body.host !== undefined && body.host !== null && typeof body.host !== 'string') throw new Refusal(400, 'host: the id of one of its conversations.');
        const host = typeof body.host === 'string' ? body.host : null;
        givenMembers(id, { conversations: [...add.conversations, ...remove.conversations, ...(host ? [host] : [])], boxes: [...add.boxes, ...remove.boxes] });
        const before = rooms.list().find((r) => r.id === room);
        const members = Array.isArray(before?.members) ? before.members : [];
        const member = (kind, ref) => members.find((m) => m.kind === kind && m.ref === ref);
        const gone = [...remove.conversations.map((c) => ['ai', c]), ...remove.boxes.map((b) => ['box', b])].map(([kind, ref]) => {
            const m = member(kind, ref); if (!m) throw new Refusal(400, 'Not a member of this room.'); return m.id; });
        /* The host: one of its AIs once the change is made (one added now, too). */
        if (host && !(member('ai', host) && !remove.conversations.includes(host)) && !add.conversations.includes(host)) throw new Refusal(400, 'host: one of its conversations.');
        const name = body.name === undefined || body.name === null ? undefined : String(body.name);
        rooms.change(room, { ...(name !== undefined ? { name } : {}), add, remove: gone });
        if (host) {
            const now = rooms.list().find((r) => r.id === room)?.members ?? [];
            const m = now.find((x) => x.kind === 'ai' && x.ref === host);
            if (m && !m.host) rooms.change(room, { host: m.id });
        }
        const shown = roomShown(id, room);
        const what = [...(name !== undefined ? [`renamed "${String(shown?.name ?? name).slice(0, 60)}"`] : []), ...(add.conversations.length + add.boxes.length ? [`${add.conversations.length + add.boxes.length} added`] : []),
            ...(gone.length ? [`${gone.length} taken away`] : []), ...(host ? [`host ${host}`] : [])];
        said(id, 'conversation', `Room "${String(before?.name ?? '').slice(0, 60)}" changed${what.length ? `: ${what.join(', ')}` : ''}`);
        return { ok: true, room: shown };
    };
    const roomRemoving = (id, room) => {
        keys.mayRoom(id, room, 'manage'); roomKnown(room);
        const name = rooms.list().find((r) => r.id === room)?.name ?? '';
        rooms.remove(room);
        said(id, 'conversation', `Room "${String(name).slice(0, 60)}" removed`);
        return { ok: true, removed: room };
    };
    /* A CONVERSATION'S REMINDERS (its tool's Docket), folded into its level: seen at Read, set at Talk, taken back at Act. */
    const docketOf = (name) => {
        const d = reminders?.of(name);
        if (!d?.on) throw new Refusal(409, 'Its chat is off: it has no reminders.');
        return d;
    };
    const remindersListed = (id, name) => {
        keys.mayConversation(id, name, 'read'); known(name);
        return { reminders: (docketOf(name).plans ?? []).map((p) => ({ id: String(p.id), text: String(p.text ?? ''), cron: typeof p.cron === 'string' ? p.cron : null, next: p.next ?? null })) };
    };
    const reminding = (id, name, body) => {
        keys.mayConversation(id, name, 'talk'); known(name);
        onlyFields(body, ['text', 'at', 'cron']);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) throw new Refusal(400, 'Say what it is for: text.');
        if (text.length > REMINDER_MAX) throw new Refusal(400, `${REMINDER_MAX} characters at most: a short text.`);
        const at = typeof body.at === 'string' && body.at.trim() ? body.at.trim() : null;
        const cron = typeof body.cron === 'string' && body.cron.trim() ? body.cron.trim() : null;
        if (Boolean(at) === Boolean(cron)) throw new Refusal(400, 'Give one of: at ("2026-11-20 09:00") or cron ("0 9 * * 1").');
        docketOf(name);
        let plan;
        try { plan = reminders.set(name, { ...(at ? { at } : { cron }), text }, keys.signature(id)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, String(error?.message ?? 'Not a reminder.').slice(0, 200)); }
        said(id, 'conversation', `${name}: reminder set "${text.slice(0, 60)}"`, name);
        return { ok: true, reminder: { id: String(plan.id), text: String(plan.text ?? text), cron: plan.cron ?? null, next: plan.next ?? null } };
    };
    const unreminding = (id, name, plan) => {
        keys.mayConversation(id, name, 'act'); known(name);
        const d = docketOf(name);
        const p = typeof plan === 'string' ? (d.plans ?? []).find((x) => x.id === plan) : undefined;
        if (!p || !reminders.cancel(name, plan)) throw new Refusal(404, 'No such reminder.');
        said(id, 'conversation', `${name}: reminder taken back "${String(p.text ?? '').slice(0, 60)}"`, name);
        return { ok: true, cancelled: plan };
    };
    /* ITS BINDER LISTS: Binder asked as the key -- an agent, its name on what it writes. Only these asks, never a
       person's (approve, delete, grant, settings, a list's columns). What Binder refuses is refused: a gate a person
       did not tick says so (403). A record is reached through its own list only. */
    const asked = (id, op, args) => {
        if (typeof binder?.act !== 'function') throw new Refusal(409, 'Not possible here.');
        const r = binder.act(op, args, keys.binderWho(id));
        if (r?.ok) return r.data;
        const why = String(r?.text ?? 'Not done.').slice(0, 300);
        throw Object.assign(new Refusal(/^only a person/.test(why) ? 403 : 400, why), { key: id });
    };
    const clean = (v) => (typeof v === 'string' ? masked(v) : v);
    const stateOf = (l, sid) => l?.states?.find((x) => x.id === sid)?.name ?? null;
    const recordShown = (r, l, whole = false) => ({ id: String(r.id), title: masked(String(r.title ?? '')), state: String(r.state ?? ''), stateName: stateOf(l, r.state),
        fields: Object.fromEntries(Object.entries(r.fields ?? {}).map(([k, v]) => [k, clean(v)])), owners: Array.isArray(r.owners) ? r.owners.slice(0, 8) : [],
        due: r.due ?? null, ...(r.approved ? { approved: true } : {}), ...(r.archived ? { archived: true } : {}), changed: r.changed ?? null,
        ...(whole ? { description: masked(String(r.description ?? '')), created: r.created ?? null,
            notes: (Array.isArray(r.notes) ? r.notes : []).map((n) => ({ at: n.at, by: String(n.by?.name ?? ''), text: masked(String(n.text ?? '')) })),
            attached: (Array.isArray(r.attached) ? r.attached : []).map((a) => ({ kind: String(a.kind ?? ''), title: masked(String(a.title ?? '')) })) } : {}) });
    const bindersListed = (id) => {
        const given = keys.bindersOf(id);
        const shown = given.length ? asked(id, 'lists', {}) : [];
        const lists = new Map((Array.isArray(shown) ? shown : []).map((l) => [l.id, l]));
        return { binders: given.filter((g) => lists.has(g.id)).map((g) => { const l = lists.get(g.id);
            return { id: g.id, title: String(l.title ?? ''), level: g.level, count: l.count ?? 0,
                states: (l.states ?? []).map((x) => ({ id: x.id, name: x.name, ...(x.gate ? { gate: true } : {}), ...(x.done ? { done: true } : {}) })),
                fields: (l.fields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })) }; }) };
    };
    const recordsListed = (id, list, { state, archived } = {}) => {
        keys.mayBinder(id, list, 'read');
        if (state !== undefined && state !== null && typeof state !== 'string') throw new Refusal(400, 'state: a state\'s id or name.');
        const d = asked(id, 'show', { list, ...(state ? { state } : {}), archived: archived === true });
        return { records: (d.records ?? []).map((r) => recordShown(r, d.list)) };
    };
    /* The record, as the key may reach it: in this list, the list given. */
    const recordIn = (id, list, record, level) => {
        keys.mayBinder(id, list, level);
        if (typeof record !== 'string' || !/^\d{1,9}$/.test(record)) throw new Refusal(404, 'No such record in this binder.');
        let d;
        try { d = asked(id, 'get', { id: record }); } catch (error) { if (error instanceof Refusal && error.status === 400) throw new Refusal(404, 'No such record in this binder.'); throw error; }
        if (d?.record?.list !== list) throw new Refusal(404, 'No such record in this binder.');
        return d;
    };
    const recordRead = (id, list, record) => { const d = recordIn(id, list, record, 'read'); return { record: recordShown(d.record, d.list, true) }; };
    const binderSaid = (id, list, what) => said(id, 'asset', `Binder "${String(keys.binderTitle(list)).slice(0, 60)}": ${what}`);
    const RECORD_FIELDS = ['title', 'description', 'fields', 'due'];
    const recordAdding = (id, list, body) => {
        keys.mayBinder(id, list, 'write');
        onlyFields(body, ['title', 'description', 'state', 'fields', 'due']);
        const r = asked(id, 'add', { list, title: body.title, description: body.description, state: body.state, fields: body.fields, due: body.due });
        binderSaid(id, list, `#${r.id} added`);
        return { ok: true, record: recordRead(id, list, String(r.id)).record };
    };
    const recordEditing = (id, list, record, body) => {
        recordIn(id, list, record, 'write');
        onlyFields(body, RECORD_FIELDS);
        asked(id, 'edit', { id: record, ...Object.fromEntries(RECORD_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) });
        binderSaid(id, list, `#${record} changed`);
        return { ok: true, record: recordRead(id, list, record).record };
    };
    const recordMoving = (id, list, record, body) => {
        recordIn(id, list, record, 'write');
        onlyFields(body, ['state']);
        if (typeof body.state !== 'string' || !body.state) throw new Refusal(400, 'state: a state\'s id or name.');
        const r = asked(id, 'move', { id: record, state: body.state });
        binderSaid(id, list, `#${record} moved to ${String(r.stateName ?? r.state).slice(0, 40)}`);
        return { ok: true, record: recordRead(id, list, record).record };
    };
    const recordNoting = (id, list, record, body) => {
        recordIn(id, list, record, 'write');
        onlyFields(body, ['text']);
        if (typeof body.text !== 'string' || !body.text.trim()) throw new Refusal(400, 'Say something: text.');
        asked(id, 'note', { id: record, text: body.text });
        binderSaid(id, list, `#${record} noted`);
        return { ok: true, record: recordRead(id, list, record).record };
    };
    const recordArchiving = (id, list, record, restore) => {
        recordIn(id, list, record, 'write');
        asked(id, 'archive', { id: record, restore: restore === true });
        binderSaid(id, list, `#${record} ${restore === true ? 'restored' : 'archived'}`);
        return { ok: true, record: recordRead(id, list, record).record };
    };
    /* What Clavarium does (scope "jobs"), its texts masked as a room's are: a log line may quote what a program said. */
    const mayJobs = (id) => { if (!keys.may(id, 'jobs')) throw Object.assign(new Refusal(403, `This key was not given the scope "${SCOPES.jobs.label}".`), { key: id }); };
    const jobShown = ({ what, step, why, log, ...job }) => ({ ...job, what: masked(what), ...(step !== undefined ? { step: masked(step) } : {}), ...(why !== undefined ? { why: masked(why) } : {}),
        ...(Array.isArray(log) ? { log: log.map((l) => ({ at: l.at, text: masked(l.text) })) } : {}) });
    const jobsListed = (id) => {
        mayJobs(id);
        const { running = [], done = [] } = jobs?.list() ?? {};
        return { running: running.map(jobShown), done: done.map(jobShown) };
    };
    const jobRead = (id, job) => {
        mayJobs(id);
        const found = typeof job === 'string' && JOB_ID.test(job) ? jobs?.log(job) : undefined;
        if (!found) throw new Refusal(404, 'No such job (under way, or done today).');
        return jobShown(found);
    };
    const ownError = (error, id) => (error instanceof Refusal ? Object.assign(error, { key: error.key ?? id }) : error);
    try {
        const jobRoute = /^\/v1\/jobs(?:\/([^/]+))?$/.exec(route);
        if (jobRoute) {
            if (request.method !== 'GET') return send(405, { error: 'Call this address with GET.' }, { allow: 'GET' });
            let id;
            try { id = keys.check(request.headers.authorization, 'jobs'); } catch (error) { return refused(error); }
            try {
                let job = '';
                try { job = jobRoute[1] ? decodeURIComponent(jobRoute[1]) : ''; } catch { job = ''; }
                const body = jobRoute[1] ? jobRead(id, job) : jobsListed(id);
                note(id, 200);
                return send(200, body);
            } catch (error) { return refused(ownError(error, id)); }
        }
        if (route === '/v1/status') {
            if (request.method !== 'GET') return send(405, { error: 'Call this address with GET.' }, { allow: 'GET' });
            let id;
            try { id = keys.check(request.headers.authorization, 'status'); } catch (error) { return refused(error); }
            const body = await status();
            note(id, 200);
            return send(200, body);
        }
        /* A JSON body, or a refusal. */
        const jsonOf = async (max) => {
            if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON.');
            const text = await bodyOf(max);
            if (!text) return {};
            try { return JSON.parse(text); } catch { throw new Refusal(400, 'The request is not JSON.'); }
        };
        const reminder = /^\/v1\/conversations\/([^/]+)\/reminders(?:\/([^/]+)\/cancel)?$/.exec(route);
        if (reminder) {
            const allowed = reminder[2] ? 'POST' : 'GET, POST';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                let name; let plan = '';
                try { name = decodeURIComponent(reminder[1]); plan = reminder[2] ? decodeURIComponent(reminder[2]) : ''; } catch { name = ''; }
                if (reminder[2]) { const done = unreminding(id, name, plan); note(id, 200); return send(200, done); }
                if (request.method === 'GET') { const body = remindersListed(id, name); note(id, 200); return send(200, body); }
                const done = reminding(id, name, await jsonOf(4096));
                note(id, 201); return send(201, done);
            } catch (error) { return refused(ownError(error, id)); }
        }
        const binderRoute = /^\/v1\/binders(?:\/([^/]+)\/records(?:\/([^/]+)(?:\/(move|notes|archive|restore))?)?)?$/.exec(route);
        if (binderRoute) {
            const [, listRef, recordRef, verb] = binderRoute;
            const allowed = !listRef ? 'GET' : verb ? 'POST' : 'GET, POST';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!listRef) { const body = bindersListed(id); note(id, 200); return send(200, body); }
                let list; let record;
                try { list = decodeURIComponent(listRef); record = recordRef === undefined ? undefined : decodeURIComponent(recordRef); } catch { list = ''; }
                if (request.method === 'GET') {
                    const body = record === undefined ? recordsListed(id, list, { state: url.searchParams.get('state') || undefined, archived: url.searchParams.get('archived') === '1' }) : recordRead(id, list, record);
                    note(id, 200); return send(200, body);
                }
                if (verb === 'archive' || verb === 'restore') { const done = recordArchiving(id, list, record, verb === 'restore'); note(id, 200); return send(200, done); }
                const body = await jsonOf(16_384);
                const done = record === undefined ? recordAdding(id, list, body) : verb === 'move' ? recordMoving(id, list, record, body)
                    : verb === 'notes' ? recordNoting(id, list, record, body) : recordEditing(id, list, record, body);
                const code = record === undefined || verb === 'notes' ? 201 : 200;
                note(id, code); return send(code, done);
            } catch (error) { return refused(ownError(error, id)); }
        }
        const one = /^\/v1\/conversations(?:\/([^/]+)\/(messages|wake|sleep|stop))?$/.exec(route);
        if (one) {
            const allowed = one[2] && one[2] !== 'messages' ? 'POST' : one[1] ? 'GET, POST' : 'GET';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!one[1]) { const body = listed(id); note(id, 200); return send(200, body); }
                let name;
                try { name = decodeURIComponent(one[1]); } catch { name = ''; }
                if (one[2] !== 'messages') { const done = await acting(id, name, one[2]); const code = one[2] === 'wake' ? 202 : 200; note(id, code); return send(code, done); }
                if (request.method === 'GET') { const body = reading(id, name, readPart((k) => url.searchParams.get(k))); note(id, 200); return send(200, body); }
                if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON: {"text": "..."}.');
                let body;
                try { body = JSON.parse(await bodyOf(SAY_MAX * 4 + 1024)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, 'The request is not JSON.'); }
                const done = await saying(id, name, body?.text);
                note(id, 201);
                return send(201, done);
            } catch (error) { return refused(ownError(error, id)); }
        }
        const room = /^\/v1\/rooms(?:\/([^/]+)(\/messages|\/remove)?)?$/.exec(route);
        if (room) {
            const allowed = room[2] === '/messages' || !room[1] ? 'GET, POST' : 'POST';
            if (!allowed.split(', ').includes(request.method)) return send(405, { error: `Call this address with ${allowed}.` }, { allow: allowed });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error); }
            try {
                if (!room[1] && request.method === 'GET') { const body = roomsListed(id); note(id, 200); return send(200, body); }
                let ref;
                try { ref = decodeURIComponent(room[1] ?? ''); } catch { ref = ''; }
                if (room[2] === '/remove') { const done = roomRemoving(id, ref); note(id, 200); return send(200, done); }
                if (request.method === 'GET') { const body = roomReading(id, ref, readPart((k) => url.searchParams.get(k))); note(id, 200); return send(200, body); }
                if (room[2] !== '/messages') {
                    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refusal(415, 'Send JSON.');
                    let body;
                    try { body = JSON.parse(await bodyOf(16_384)); } catch (error) { if (error instanceof Refusal) throw error; throw new Refusal(400, 'The request is not JSON.'); }
                    const done = room[1] ? roomChanging(id, ref, body) : roomCreating(id, body);
                    const code = room[1] ? 200 : 201;
                    note(id, code); return send(code, done);
                }
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
        /* MCP at /api/ext/mcp and, beside the API it speaks for, /api/ext/v1/mcp: the same. */
        if (route === '/mcp' || route === '/v1/mcp') {
            if (request.method !== 'POST') return send(405, { error: 'MCP is spoken with POST here (no event stream).' }, { allow: 'POST' });
            let id;
            try { id = keys.check(request.headers.authorization); } catch (error) { return refused(error, route); }
            let text = '';
            for await (const piece of request) { text += piece; if (text.length > MCP_BODY_MAX) { note(id, 413, route); return send(413, { error: 'Too long.' }); } }
            /* A protocol version said in the header, and none spoken here: refused, as the spec asks (none said: the oldest assumed). */
            const said = request.headers['mcp-protocol-version'];
            if (typeof said === 'string' && said && !MCP_VERSIONS.includes(said)) { note(id, 400, route); return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${said.slice(0, 20)} (spoken: ${MCP_VERSIONS.join(', ')})` } }); }
            let msg;
            try { msg = JSON.parse(text); } catch { note(id, 400, route); return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
            if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
                note(id, 400, route); return send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            }
            const args = msg.params?.arguments && typeof msg.params.arguments === 'object' && !Array.isArray(msg.params.arguments) ? msg.params.arguments : {};
            /* The journal says which tool, and on which conversation, room or box. */
            const on = [args.conversation, args.room, args.box, args.binder, msg.params?.name === JOB_LOG_TOOL.name ? args.id : undefined].find((v) => typeof v === 'string');
            const what = `${route} ${msg.method.slice(0, 40)}${msg.method === 'tools/call' ? ` ${String(msg.params?.name ?? '').slice(0, 40)}${on ? ` ${on.slice(0, 36)}` : ''}` : ''}`;
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
                    instructions: 'This Clavarium, as far as this key was given it: its state (clavarium_status), what it does and each job\'s log (clavarium_jobs, clavarium_job_log), the conversations given to it (clavarium_conversations), to read (clavarium_read) or to talk in (clavarium_say); its rooms (clavarium_rooms, clavarium_room_read, clavarium_room_say); its voice boxes (clavarium_boxes; clavarium_box_say says a short text aloud in the home). Where it was given more: a conversation woken, put to sleep, its turn stopped (clavarium_conversation_wake, _sleep, _stop); rooms made, changed, removed (clavarium_room_create, clavarium_room_change, clavarium_room_remove); a conversation\'s reminders seen, set, taken back (clavarium_reminders, clavarium_remind, clavarium_reminder_cancel); binder lists read and written (clavarium_binders, clavarium_binder_records, clavarium_binder_record, clavarium_binder_add, _edit, _move, _note, _archive).' });
            }
            case 'ping': return answer({});
            /* A tool that needs a scope is shown only to a key given it (one called anyway is refused, 403). */
            case 'tools/list': return answer({ tools: TOOLS.filter((x) => !TOOL_SCOPES[x.name] || keys.may(id, TOOL_SCOPES[x.name])) });
            case 'tools/call': {
                const name = msg.params?.name;
                if (!TOOLS.some((x) => x.name === name)) return fail(-32602, `Unknown tool: ${String(name ?? '').slice(0, 60)}`);
                try {
                    if (name === STATUS_TOOL.name) {
                        if (!keys.may(id, 'status')) throw new Refusal(403, `This key was not given the scope "${SCOPES.status.label}".`);
                        return result(await status());
                    }
                    if (name === JOBS_TOOL.name) return result(jobsListed(id));
                    if (name === JOB_LOG_TOOL.name) {
                        if (typeof args.id !== 'string') return fail(-32602, 'id: the id of a job, as clavarium_jobs gives it.');
                        return result(jobRead(id, args.id));
                    }
                    if (name === CONVERSATIONS_TOOL.name) return result(listed(id));
                    if (name === ROOMS_TOOL.name) return result(roomsListed(id));
                    if (name === BOXES_TOOL.name) return result(boxesListed(id));
                    if (name === BINDERS_TOOL.name) return result(bindersListed(id));
                    if (BINDER_TOOLS.some((x) => x.name === name)) {
                        if (typeof args.binder !== 'string') return fail(-32602, 'binder: the id of a binder list.');
                        if (name === BINDER_RECORDS_TOOL.name) return result(recordsListed(id, args.binder, { state: args.state, archived: args.archived === true }));
                        if (name !== BINDER_ADD_TOOL.name && typeof args.record !== 'string') return fail(-32602, 'record: the id of a record.');
                        if (name === BINDER_RECORD_TOOL.name) return result(recordRead(id, args.binder, args.record));
                        const { binder: list, record, ...rest } = args;
                        const done = name === BINDER_ADD_TOOL.name ? recordAdding(id, list, rest) : name === BINDER_EDIT_TOOL.name ? recordEditing(id, list, record, rest)
                            : name === BINDER_MOVE_TOOL.name ? recordMoving(id, list, record, rest) : name === BINDER_NOTE_TOOL.name ? recordNoting(id, list, record, rest)
                            : recordArchiving(id, list, record, rest.restore === true);
                        note(id, 201, what);
                        return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(done) }], structuredContent: done, isError: false } });
                    }
                    const part = () => readPart((k) => (args[k] === undefined ? null : typeof args[k] === 'number' ? String(args[k]) : args[k]));
                    let done;
                    if (name === ROOM_CREATE_TOOL.name) {
                        done = roomCreating(id, args);
                    } else if (name === ROOM_READ_TOOL.name || name === ROOM_SAY_TOOL.name || name === ROOM_CHANGE_TOOL.name || name === ROOM_REMOVE_TOOL.name) {
                        if (typeof args.room !== 'string') return fail(-32602, 'room: the id of a room.');
                        if (name === ROOM_READ_TOOL.name) return result(roomReading(id, args.room, part()));
                        if (name === ROOM_CHANGE_TOOL.name) { const { room: target, ...change } = args; done = roomChanging(id, target, change); }
                        else if (name === ROOM_REMOVE_TOOL.name) done = roomRemoving(id, args.room);
                        else done = await roomSaying(id, args.room, args.text, args.to);
                    } else if (name === BOX_SAY_TOOL.name) {
                        if (typeof args.box !== 'string') return fail(-32602, 'box: the id of a voice box.');
                        done = await boxSaying(id, args.box, args.text);
                    } else {
                        if (typeof args.conversation !== 'string') return fail(-32602, 'conversation: the id of a conversation.');
                        if (name === READ_TOOL.name) return result(reading(id, args.conversation, part()));
                        if (name === REMINDERS_TOOL.name) return result(remindersListed(id, args.conversation));
                        if (name === REMIND_TOOL.name) { const { conversation: c, ...rest } = args; done = reminding(id, c, rest); }
                        else if (name === REMINDER_CANCEL_TOOL.name) done = unreminding(id, args.conversation, args.reminder);
                        else {
                        const act = { [WAKE_TOOL.name]: 'wake', [SLEEP_TOOL.name]: 'sleep', [STOP_TOOL.name]: 'stop' }[name];
                        done = act ? await acting(id, args.conversation, act) : await saying(id, args.conversation, args.text);
                        }
                    }
                    note(id, 201, what);
                    return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(done) }], structuredContent: done, isError: false } });
                } catch (error) {
                    if (!(error instanceof Refusal)) throw error;
                    /* Not given: refused as the API refuses it (too many, too). Anything else is the tool's own failure, said to the caller. */
                    if (error.status === 429) { note(id, 429, what); return send(429, { jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: error.message } }, { 'retry-after': String(error.retry ?? 60) }); }
                    /* (An HTTP 403 for a scope not given is what the MCP authorization spec says: kept, MCP review 11-11.) */
                    if (error.status === 403) { note(id, 403, what); return send(403, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: error.message } }); }
                    note(id, error.status, what);
                    return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
                }
            }
            default: return fail(-32601, 'Method not found');
            }
        }
        note(null, 404);
        return send(404, { error: 'Not found. GET /api/ext/v1/status, /api/ext/v1/conversations, /api/ext/v1/rooms, /api/ext/v1/boxes, /api/ext/v1/jobs, /api/ext/v1/binders, or MCP at /api/ext/v1/mcp.' });
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
            const made = keys.create({ label: body.label, scopes: body.scopes ?? [], conversations: body.conversations ?? {}, rooms: body.rooms ?? {}, boxes: body.boxes ?? {}, binders: body.binders ?? {}, days: body.days === undefined ? DEFAULT_DAYS : body.days }, who);
            /* Its name and scopes; never the secret. */
            const what = [...made.key.scopes, ...made.key.conversations.map((c) => `${c.name} ${c.level}`), ...made.key.rooms.map((r) => `room ${r.id.slice(0, 8)} ${r.level}`), ...made.key.boxes.map((b) => `voice box ${b.id.slice(0, 8)} ${b.level}`), ...made.key.binders.map((l) => `binder ${l.id.slice(0, 40)} ${l.level}`)];
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
        const binding = /^\/api\/apikeys\/([0-9a-f-]{36})\/binders$/.exec(pathname);
        if (binding) {
            const level = body.level === undefined ? null : body.level;
            const key = keys.setBinder(binding[1], body.binder, level, who);
            events?.add({ kind: 'access', text: `API key "${key.label}": binder ${String(body.binder).slice(0, 40)} ${level ?? 'taken back'}`, who: who || null });
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
