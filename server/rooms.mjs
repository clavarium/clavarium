/* ROOMS (#268, #279): a thread shared by several conversations (AIs), the person and voice boxes.
 *
 * A room is kept here, never in a machine: its thread is a Parley folder of this server's (rooms/<id>/),
 * written by this server alone -- the person's side (the person, a box) and, signed, each AI's words. No
 * AI can write there: what it answers comes from its own folder, and is signed by WHERE it came from
 * (which conversation), never by what it says of itself (03-11).
 *
 *   members      each with an id of its own (a uuid), whatever it is: the person, an AI (a conversation),
 *                a box. The name is only shown; the kind picks the shape of its chip.
 *   the host     one AI of the room: what is said with nobody named goes to it alone (it answers, or
 *                hands it on -- #280).
 *   to an AI     a person's message goes to the host; the host's (and any AI's) answer comes back here
 *                when it says so (parley tell --room), and only to a room it is a member of.
 *
 * Each conversation of a room is told which rooms it is in, and who is there (Parley's rooms.json).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Parley } from 'clavarium-parley/host';
import { Refusal } from './conversations.mjs';
import { scan } from './secret-scan.mjs';

export const ROOM_NAME_MAX = 60;
export const ROOMS_MAX = 20;
export const MEMBERS_MAX = 40;
/* Hand-overs between AIs after the person (or a box) last spoke in a room: a few, never a loop. */
export const HOPS_MAX = 8;
/* How long an AI given a message is said to be thinking, at most (it may never answer). */
export const THINKING_MS = 10 * 60_000;
const KINDS = ['person', 'ai', 'box'];
const nameOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);

/* A SECRET IN A ROOM (06-11): a room's thread is read by all its members, now and later -- a token, a key pasted
   there is never kept: the thread shows it as stars, and only the AI the message goes to gets it (lifted into its
   own short-lived store by its chat, as any secret said to it). What an AI writes in a room is masked the same way:
   a secret never passes from one AI to another through a room. */
export const masked = (text) => { const str = String(text ?? ''); const hits = scan(str); if (!hits.length) return str; let out = ''; let last = 0; for (const h of hits) { out += str.slice(last, h.start) + '••••••'; last = h.end; } return out + str.slice(last); };

/* A sign as the cards draw it (web/kit.js hueOf, initialOf): the same name, the same letter and colour. */
export const lookOf = (name) => { const text = String(name ?? ''); let h = 0; for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0; return { initial: ([...text.trim()][0] ?? '?').toUpperCase(), hue: h % 360 }; };

export class Rooms {
    #file; #dir; #say; #rooms; #conversations; #boxes; #now; #speak; #hops = new Map(); #thinking = new Map();
    /* file: a JsonFile of the rooms; dir: where their threads are; say(name, text, extra): a message written in a
       conversation's own chat (talk.say); rooms(name, list): what a conversation is told of its rooms (talk.rooms);
       conversations(): the conversations there are; boxes(): the voice boxes there are. */
    constructor({ file, dir, say, rooms = () => {}, conversations = () => [], boxes = () => [], speak = () => {}, now = () => new Date() }) {
        this.#speak = speak;
        this.#file = file; this.#dir = dir; this.#say = say; this.#rooms = rooms; this.#conversations = conversations; this.#boxes = boxes; this.#now = now;
    }
    #all() { const v = this.#file.get(); return Array.isArray(v) ? v : []; }
    #save(list) { this.#file.set(list); this.#tellConversations(list); }
    #thread(id) { mkdirSync(`${this.#dir}/${id}`, { recursive: true }); return new Parley(`${this.#dir}/${id}`, { room: true, now: this.#now }); }
    #find(id) { const r = this.#all().find((x) => x.id === id); if (!r) throw new Refusal(404, 'No such room.'); return r; }

    /* Its members as they are now: names of the moment (a conversation renamed, a box renamed). */
    #shown(room) {
        const boxes = new Map(this.#boxes().map((b) => [b.id, b]));
        /* An AI is named as its chat names it (the name the owner gave it in its chat settings), else its title, else its name. */
        const convs = new Map(this.#conversations().map((c) => [c.name, c.chatName || c.title || c.name]));
        /* Its sign (06-11): an AI by its conversation's card (letter and colour of its title), anyone else by its name. */
        const titles = new Map(this.#conversations().map((c) => [c.name, c.title || c.name]));
        return room.members.filter((m) => (m.kind === 'ai' ? convs.has(m.ref) : m.kind === 'box' ? boxes.has(m.ref) : true))
            .map((m) => { const name = m.kind === 'box' ? (boxes.get(m.ref)?.name ?? m.name) : m.kind === 'ai' ? convs.get(m.ref) : m.name;
                return { id: m.id, kind: m.kind, name, ref: m.ref, look: lookOf(m.kind === 'ai' ? titles.get(m.ref) : name), ...(m.id === room.host ? { host: true } : {}) }; });
    }
    #think(room, member, on) { const m = this.#thinking.get(room) ?? new Map(); if (on) m.set(member, Date.now()); else m.delete(member); this.#thinking.set(room, m); }
    has(id) { return this.#all().some((r) => r.id === id); }
    /* What came since the owner last looked (#282): the AIs' and the boxes' messages after it. */
    #unread(r) { try { const seen = Date.parse(r.seen ?? '') || 0; return this.#thread(r.id).read({ last: 200 }).messages.filter((m) => (m.from === 'agent' || m.by) && (Date.parse(m.at) || 0) > seen).length; } catch { return 0; } }
    /* Its last message, for the list: when, and its first words. */
    #last(r) { try { const m = this.#thread(r.id).read({ last: 1 }).messages.at(-1); return m ? { at: m.at, text: String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 120), ...(m.by?.name ? { by: m.by.name } : {}) } : null; } catch { return null; } }
    /* Who has a message of the room and has not answered yet (#282), by their names of the moment: « Hugo parle… »
       in its row of the list and on its bar, « Hugo réfléchit… » in its thread. */
    #thinkingOf(id, members) { return [...(this.#thinking.get(id) ?? new Map()).entries()].filter(([, at]) => Date.now() - at < THINKING_MS).map(([mid]) => members.find((m) => m.id === mid)?.name).filter(Boolean); }
    list() { return this.#all().map((r) => { const members = this.#shown(r); return { id: r.id, name: r.name, host: r.host, members, at: r.at, unread: this.#unread(r), last: this.#last(r), thinking: this.#thinkingOf(r.id, members) }; }); }
    get(id) { const r = this.#find(id); return { id: r.id, name: r.name, host: r.host, members: this.#shown(r), at: r.at }; }

    /* A new room: its name, its AIs (conversation names), its boxes (ids), and which AI is the host (the first by default). */
    create({ name, conversations = [], boxes = [], host } = {}) {
        const n = nameOf(name);
        if (!n) throw new Refusal(400, 'Give the room a name.');
        const list = this.#all();
        if (list.length >= ROOMS_MAX) throw new Refusal(409, `${ROOMS_MAX} rooms at most.`);
        if (list.some((r) => r.name.toLowerCase() === n.toLowerCase())) throw new Refusal(409, 'A room has that name already.');
        const room = { id: randomUUID(), name: n, at: this.#now().toISOString(), members: [{ id: randomUUID(), kind: 'person', ref: 'owner', name: 'Toi' }] };
        this.#add(room, conversations, boxes);
        const ais = room.members.filter((m) => m.kind === 'ai');
        if (!ais.length) throw new Refusal(400, 'A room has one AI at least: its host.');
        room.host = (ais.find((m) => m.ref === host) ?? ais[0]).id;
        this.#save([...list, room]);
        this.#thread(room.id);
        return this.get(room.id);
    }
    #add(room, conversations, boxes) {
        const known = new Set(this.#conversations().map((c) => c.name));
        const knownBoxes = new Map(this.#boxes().map((b) => [b.id, b]));
        for (const c of Array.isArray(conversations) ? conversations : []) {
            if (!known.has(c)) throw new Refusal(400, `No conversation is called ${String(c).slice(0, 40)}.`);
            if (!room.members.some((m) => m.kind === 'ai' && m.ref === c)) room.members.push({ id: randomUUID(), kind: 'ai', ref: c, name: c });
        }
        for (const b of Array.isArray(boxes) ? boxes : []) {
            const box = knownBoxes.get(b);
            if (!box) throw new Refusal(400, 'No such voice box.');
            if (!room.members.some((m) => m.kind === 'box' && m.ref === b)) room.members.push({ id: randomUUID(), kind: 'box', ref: b, name: box.name });
        }
        /* One name, one member (03-11): who is who is never in doubt, in the thread or said aloud. */
        const names = this.#shown({ ...room, host: null }).map((m) => m.name.toLowerCase());
        if (new Set(names).size !== names.length) throw new Refusal(409, 'Two members of a room cannot have the same name: rename one first.');
        if (room.members.length > MEMBERS_MAX) throw new Refusal(409, `${MEMBERS_MAX} members at most.`);
    }
    /* Its name, its host, members added or taken away. */
    change(id, { name, host, add = {}, remove = [] } = {}) {
        const list = this.#all(); const room = list.find((r) => r.id === id);
        if (!room) throw new Refusal(404, 'No such room.');
        if (name !== undefined) {
            const n = nameOf(name); if (!n) throw new Refusal(400, 'Give the room a name.');
            if (list.some((r) => r.id !== id && r.name.toLowerCase() === n.toLowerCase())) throw new Refusal(409, 'A room has that name already.');
            room.name = n;
        }
        room.members = room.members.filter((m) => m.kind === 'person' || !(Array.isArray(remove) ? remove : []).includes(m.id));
        this.#add(room, add.conversations ?? [], add.boxes ?? []);
        const ais = room.members.filter((m) => m.kind === 'ai');
        if (!ais.length) throw new Refusal(400, 'A room keeps one AI at least: its host.');
        if (host !== undefined) { if (!ais.some((m) => m.id === host)) throw new Refusal(400, 'The host is one of its AIs.'); room.host = host; }
        if (!ais.some((m) => m.id === room.host)) room.host = ais[0].id;
        this.#save(list);
        return this.get(id);
    }
    remove(id) { this.#find(id); this.#save(this.#all().filter((r) => r.id !== id)); rmSync(`${this.#dir}/${id}`, { recursive: true, force: true }); }

    /* ITS THREAD, as a screen reads it (Parley's read, the members' names of the moment). */
    read(id, options) {
        const room = this.#find(id); const t = this.#thread(room.id); const members = this.#shown(room);
        t.setSpeakers(members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, look: m.look })));
        const read = t.read(options);
        /* A member named in a text (@{id}): its name of the moment, on the screen. */
        const named = (text) => String(text ?? '').replace(/@\{([0-9a-f-]{36})\}/g, (whole, mid) => { const m = members.find((x) => x.id === mid); return m ? `@${m.name}` : whole; });
        if (options?.seen !== false) { const list = this.#all(); const r = list.find((x) => x.id === id); if (r) { r.seen = this.#now().toISOString(); this.#file.set(list); } }
        const thinking = this.#thinkingOf(id, members);
        return { room: this.get(id), thinking, ...read, messages: (read.messages ?? []).map((m) => (typeof m.text === 'string' && m.text.includes('@{') ? { ...m, text: named(m.text) } : m)) };
    }

    /* SOMEONE OF THE PERSON'S SIDE SPEAKS (the person here, a box): kept in the room, given to the host -- or to the
       AIs named (to: their member ids). */
    async say(id, text, { by, box, to } = {}) {
        const room = this.#find(id); const members = this.#shown(room);
        /* A box bound to this room speaks in it in its own name (#281): found by its box id. */
        const who = box ? members.find((m) => m.kind === 'box' && m.ref === box) : by ? members.find((m) => m.id === by && m.kind !== 'ai') : members.find((m) => m.kind === 'person');
        if (!who) throw new Refusal(400, 'Not a member of this room.');
        const t = this.#thread(room.id);
        this.#hops.set(room.id, 0);
        /* The owner is the room's own side (no name over their words, as in any chat); anyone else is named. */
        const now = t.say(masked(text), undefined, [], who.ref === 'owner' ? {} : { by: { id: who.id, name: who.name, kind: who.kind, look: who.look } });
        const said = now.messages.at(-1);
        const named = (Array.isArray(to) ? to : []).map((x) => members.find((m) => m.id === x && m.kind === 'ai')).filter(Boolean);
        const host = members.find((m) => m.id === room.host);
        for (const ai of named.length ? named : host ? [host] : []) {
            this.#think(room.id, ai.id, true);
            await this.#say(ai.ref, text, { by: { id: who.id, name: who.name, kind: who.kind, look: who.look }, room: { id: room.id, name: room.name, message: said.id } });
        }
        /* Handed to its AIs: read, as a conversation's agent would say it (06-11: the clock stayed on every message). */
        try { t.seen?.(); } catch { /* an older Parley */ }
        return this.read(id);
    }

    /* AN AI ANSWERS IN A ROOM (what its own folder says, entry.room): only to a room it is in; signed by where it
       came from; the message it answers found by its id or its first characters. */
    answered(conversation, entry, kind = 'say') {
        const room = this.#all().find((r) => r.id === entry?.room);
        if (!room) return null;
        const members = this.#shown(room);
        const me = members.find((m) => m.kind === 'ai' && m.ref === conversation);
        if (!me) return null;
        const t = this.#thread(room.id);
        const all = () => t.read({ all: true }).messages;
        const find = (id) => (typeof id === 'string' && id.length >= 8 ? all().find((m) => m.id.startsWith(id)) : undefined);
        const re = find(entry.re)?.id;
        if (kind !== 'doing') this.#think(room.id, me.id, false);
        const ids = new Set(members.map((m) => m.id));
        const to = Array.isArray(entry.to) ? entry.to.filter((x) => ids.has(x) && x !== me.id) : [];
        /* The other AIs it is sent to (#280): they get it in their own chat, as said in the room -- never beyond a few
           hand-overs after the person last spoke (no two AIs talking for ever). */
        const ais = to.map((x) => members.find((m) => m.id === x && m.kind === 'ai')).filter(Boolean);
        const handOver = (ai, text, from, message) => {
            const n = (this.#hops.get(room.id) ?? 0) + 1;
            if (n > HOPS_MAX) return false;
            this.#hops.set(room.id, n);
            this.#think(room.id, ai.id, true);
            void this.#say(ai.ref, text, { by: from, room: { id: room.id, name: room.name, message } }).catch(() => {});
            return true;
        };
        /* Handed on as it is: the message itself, by who said it; the room's thread keeps no copy. */
        const forwarded = find(entry.forward);
        if (forwarded) {
            const from = forwarded.by ? { id: forwarded.by.id, name: forwarded.by.name, kind: forwarded.by.kind ?? 'person', ...(forwarded.by.look ? { look: forwarded.by.look } : {}) } : { id: members.find((m) => m.kind === 'person')?.id ?? 'owner', name: members.find((m) => m.kind === 'person')?.name ?? 'Owner', kind: 'person' };
            for (const ai of ais) handOver(ai, forwarded.text, from, forwarded.id);
            if (!String(entry.text ?? '').trim()) return forwarded.id;
        }
        if (!String(entry.text ?? '').trim()) return null;
        /* @Name of a member, exactly: kept as its id (the screen says its name of the moment). */
        const text = masked(entry.text).replace(/@([^\s@{][^@\n]{0,40}?)(?=[\s,.;:!?)]|$)/g, (whole, name) => { const m = members.find((x) => x.name.toLowerCase() === name.toLowerCase()); return m ? `@{${m.id}}` : whole; });
        const id = t.relay({ text, by: { id: me.id, name: me.name, kind: 'ai', look: me.look }, to, re, kind: kind === 'doing' ? 'doing' : 'say' });
        /* The boxes it is sent to say it aloud (#281): its words, a member named by its name, never an id. */
        const boxes = to.map((x) => members.find((m) => m.id === x && m.kind === 'box')).filter(Boolean).map((m) => m.ref);
        if (boxes.length) { const aloud = text.replace(/@\{([0-9a-f-]{36})\}/g, (w, mid) => members.find((x) => x.id === mid)?.name ?? ''); try { this.#speak(`room:${room.id}`, aloud, boxes, { doing: kind === 'doing', asked: kind === 'ask' }); } catch { /* the boxes' */ } }
        if (!forwarded && kind !== 'doing') for (const ai of ais) handOver(ai, text, { id: me.id, name: me.name, kind: 'ai', look: me.look }, id);
        return id;
    }

    /* Each conversation told the rooms it is in, and who is there. */
    #tellConversations(list) {
        const shown = list.map((r) => ({ ...r, members: this.#shown(r) }));
        for (const c of this.#conversations()) {
            const mine = shown.filter((r) => r.members.some((m) => m.kind === 'ai' && m.ref === c.name))
                .map((r) => ({ id: r.id, name: r.name, members: r.members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, look: m.look })) }));
            try { this.#rooms(c.name, mine); } catch { /* its folder is not there yet */ }
        }
    }
    refresh() { this.#tellConversations(this.#all()); }
    /* The boxes bound to a room (their conversation 'room:<id>') are members of it, by themselves (#281). */
    boxesBound(boxes) {
        const list = this.#all(); let changed = false;
        for (const b of Array.isArray(boxes) ? boxes : []) {
            const m = /^room:([0-9a-f-]{36})$/.exec(String(b.conversation ?? '')); if (!m) continue;
            const room = list.find((r) => r.id === m[1]);
            if (room && !room.members.some((x) => x.kind === 'box' && x.ref === b.id)) { room.members.push({ id: randomUUID(), kind: 'box', ref: b.id, name: b.name }); changed = true; }
        }
        if (changed) this.#save(list);
    }
    /* A conversation renamed: its member follows it. */
    conversationRenamed(from, to) { const list = this.#all(); let moved = false; for (const r of list) for (const m of r.members) if (m.kind === 'ai' && m.ref === from) { m.ref = to; m.name = to; moved = true; } if (moved) this.#save(list); }
}
export { KINDS };
