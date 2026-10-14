/* WAKE-UPS: a tool is told to get to work without its owner at the screen.
 *
 * Two things can wake it, both set by the owner, per conversation:
 *
 *   AN ARRIVAL    something new lands in a folder, a repository or a mailbox
 *                 attached to the conversation: a file, a mail, a commit. This is how tools work
 *                 TOGETHER: one leaves a request in a folder they share, the
 *                 other is told, and gets to it.
 *   A CALL        an address of its own, called by what the owner already
 *                 runs elsewhere: a scheduler, a workflow tool, a script.
 *   THE CLOCK     every so many minutes, every day at a given time, or a
 *                 cron line (minute hour day month weekday).
 *
 * What is then done is small: a MESSAGE THE OWNER WROTE is typed into the
 * tool's terminal, followed by Enter. Nothing is run, nothing is decided
 * here; the tool does what it would do had its owner typed that line.
 *
 * What holds it:
 *   - the message is the owner's. The only thing that is not, the names of
 *     the files that arrived (asked for with "{files}"), is reduced to plain
 *     characters, a few names, bounded: a file name is chosen by whoever
 *     wrote the file, and it is about to be typed into a terminal;
 *   - a cap of wake-ups per hour for the conversation, which the owner sets
 *     (0: none). Two tools that wake each other through one folder go round
 *     in circles: the cap is what stops them;
 *   - a conversation the owner put to sleep stays asleep: nothing wakes it;
 *   - a folder is only LOOKED AT here (names, sizes, dates), links are never
 *     followed, and nothing in it is read.
 *
 * NOT KEPT ACROSS A RESTART: what a folder held is remembered in memory. A
 * file that arrives while this server is down is part of what is there when
 * it starts again, and wakes nobody.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';
import { isConversationName } from './names.mjs';

export const TICK_MS = 5000;
export const MESSAGE_MAX = 1000;
export const ITEMS_MAX = 8;
export const DEFAULT_PER_HOUR = 12;
/* An arrival is told once NOTHING HAS MOVED for this long: a file written in
   ten goes is one arrival, not ten. The one setting of an arrival. */
export const DEFAULT_QUIET_SECONDS = 10;
export const QUIET_MAX_SECONDS = 3600;
export const FILES_NAMED = 5;
export const SCAN_MAX = 5000;
export const SCAN_DEPTH = 5;
/* A daily wake-up missed by more than this (the server was down, the
   conversation asleep) is not caught up: it waits for the next day. */
export const LATE_MS = 15 * 60_000;
const KINDS = ['arrival', 'every', 'daily', 'cron', 'call'];
/* A CALL FROM OUTSIDE: an address that, when called, wakes the tool. That is
   how what the owner already runs (a scheduler, a workflow tool, a script)
   starts an agent here. The address IS the right to wake it: long, random,
   shown once when it is made, kept here only as its fingerprint. What the
   caller sends is typed only where the owner wrote "{text}", and only as
   one plain line. */
export const CALL_PATH = '/c/wake/';
export const CALL_TEXT_MAX = 500;
const TOKEN = /^[0-9a-f]{48}$/;
const fingerprintOf = (token) => createHash('sha256').update(token).digest('hex');

/* A CRON LINE, the five usual fields: minute hour day-of-month month
   day-of-week. Numbers, "*", lists (1,15), ranges (1-5), steps (every 10
   minutes is written with a slash: star slash 10). Sunday is 0 or 7. As
   cron does: when both the day of the month and the day of the week are
   given, either one is enough. Resolves with a function (date) -> boolean,
   or undefined when the line cannot be read. */
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
export function cron(line) {
    const parts = String(line ?? '').trim().split(/\s+/);
    if (parts.length !== 5) return undefined;
    const sets = [];
    for (const [n, part] of parts.entries()) {
        const [low, high] = FIELDS[n];
        const set = new Set();
        for (const piece of part.split(',')) {
            const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(piece);
            if (!m) return undefined;
            const step = m[2] === undefined ? 1 : Number(m[2]);
            let [from, to] = m[1] === '*' ? [low, high] : m[1].split('-').map(Number);
            if (to === undefined) to = m[2] === undefined ? from : high;
            if (step < 1 || from < low || to > high || from > to) return undefined;
            for (let v = from; v <= to; v += step) set.add(n === 4 && v === 7 ? 0 : v);
        }
        sets.push(set);
    }
    const [minute, hour, day, month, weekday] = sets;
    const anyDay = parts[2] === '*'; const anyWeekday = parts[4] === '*';
    return (date) => minute.has(date.getMinutes()) && hour.has(date.getHours()) && month.has(date.getMonth() + 1)
        && (anyDay && anyWeekday ? true : anyDay ? weekday.has(date.getDay()) : anyWeekday ? day.has(date.getDate()) : day.has(date.getDate()) || weekday.has(date.getDay()));
}
const PANE = `=${SESSION}:`;
/* How new commits are named among what arrived. */
export const COMMITS = 'new commits';

// eslint-disable-next-line no-control-regex
const NOT_TYPED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const cleanMessage = (raw) => String(raw ?? '').replace(/[\r\n\t]+/gu, ' ').replace(NOT_TYPED, '').trim().slice(0, MESSAGE_MAX);
/* A file name, as it may be typed: plain characters, bounded. */
export const plainName = (name) => String(name).replace(/[^A-Za-z0-9._/@+%~ -]/gu, '?').slice(0, 80);
export function withFiles(message, files) {
    const named = files.slice(0, FILES_NAMED).map(plainName).join(', ') + (files.length > FILES_NAMED ? ` and ${files.length - FILES_NAMED} more` : '');
    return message.includes('{files}') ? message.replaceAll('{files}', named) : message;
}

/* What a folder holds: path -> "size:date". Hidden names are left out (a
   repository's own .git changes all the time), links are not followed. */
export function look(root) {
    const found = new Map();
    const walk = (dir, under, depth) => {
        let names;
        try { names = readdirSync(dir); } catch { return; }
        for (const name of names.sort()) {
            if (name.startsWith('.') || found.size >= SCAN_MAX) continue;
            let info;
            try { info = lstatSync(`${dir}/${name}`); } catch { continue; }
            const path = under ? `${under}/${name}` : name;
            if (info.isDirectory()) { if (depth < SCAN_DEPTH) walk(`${dir}/${name}`, path, depth + 1); } else if (info.isFile()) found.set(path, `${info.size}:${Math.floor(info.mtimeMs)}`);
        }
    };
    walk(root, '', 0);
    return found;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export class Wakeups {
    #store; #vms; #conversations; #resources; #warm; #now; #held = new Map(); #busy = false;

    /* `warm(name)`: opens the terminal of a machine that runs, if it is not open. */
    constructor({ store, vms, conversations, resources, warm = async () => {}, now = () => new Date() }) {
        this.#store = store; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#warm = warm; this.#now = now;
    }

    #record(name) { return this.#store.get(name) ?? { name, perHour: DEFAULT_PER_HOUR, sent: [], items: [] }; }
    of(name) { const r = this.#record(name); return { perHour: r.perHour, items: r.items.map(({ token, ...i }) => ({ ...i })), sentThisHour: this.#recent(r).length }; }
    #recent(r) { const hourAgo = this.#now().getTime() - 3_600_000; return (r.sent ?? []).filter((at) => new Date(at).getTime() > hourAgo); }

    #known(name) { if (!isConversationName(name) || !this.#conversations.list().some((c) => c.name === name)) throw new Refusal(404, 'No such conversation.'); }

    /* `perHour`: wake-ups an hour at most, for the whole conversation; 0 is no cap. */
    setLimit(name, perHour) {
        this.#known(name);
        const n = Number(perHour);
        if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Refusal(400, 'The cap is a whole number of wake-ups an hour; 0 is no cap.');
        this.#store.put({ ...this.#record(name), perHour: n });
        return this.of(name);
    }

    add(name, { kind, resource, onlyNew, minutes, at, message, quiet, line }) {
        this.#known(name);
        const r = this.#record(name);
        if (r.items.length >= ITEMS_MAX) throw new Refusal(400, `A conversation has at most ${ITEMS_MAX} wake-ups.`);
        if (!KINDS.includes(kind)) throw new Refusal(400, 'A wake-up is an arrival, a cron line, or a call from outside.');
        const text = cleanMessage(message);
        if (text === '') throw new Refusal(400, 'Write what is typed to the tool when it is woken.');
        let once;
        const item = { id: randomUUID(), kind, on: true, message: text, made: this.#now().toISOString(), last: null };
        if (kind === 'arrival') {
            if (!this.#resources.of(name).some((x) => x.name === resource)) throw new Refusal(400, 'Choose a folder, a repository or a mailbox attached to this conversation.');
            const calm = quiet === undefined || quiet === '' ? DEFAULT_QUIET_SECONDS : Number(quiet);
            if (!Number.isInteger(calm) || calm < 0 || calm > QUIET_MAX_SECONDS) throw new Refusal(400, 'How many seconds must it stay still? A whole number, an hour at most.');
            item.resource = resource; item.onlyNew = onlyNew !== false; item.quiet = calm;
        } else if (kind === 'every') {
            const n = Number(minutes);
            if (!Number.isInteger(n) || n < 1 || n > 60 * 24 * 31) throw new Refusal(400, 'Every how many minutes? A whole number, 1 at least.');
            item.minutes = n; item.fired = item.made;
        } else if (kind === 'call') {
            once = randomBytes(24).toString('hex');
            item.token = fingerprintOf(once);
        } else if (kind === 'cron') {
            const written = String(line ?? '').trim().replace(/\s+/g, ' ');
            if (!cron(written)) throw new Refusal(400, 'A cron line has five fields: minute hour day month weekday. For example: 30 7 * * 1-5');
            item.line = written; item.fired = item.made;
        } else {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new Refusal(400, 'At what time? Written like 07:30.');
            item.at = at; item.fired = item.made;
        }
        this.#store.put({ ...r, items: [...r.items, item] });
        /* `address`: said once, now, and never again. */
        return once ? { ...this.of(name), address: `${CALL_PATH}${once}` } : this.of(name);
    }

    #change(name, id, change) {
        this.#known(name);
        const r = this.#record(name);
        if (!r.items.some((i) => i.id === id)) throw new Refusal(404, 'No such wake-up.');
        this.#held.delete(`${name}/${id}`);
        this.#store.put({ ...r, items: change(r.items) });
        return this.of(name);
    }
    /* Turned on again, it starts from now: what happened meanwhile wakes nobody. */
    turn(name, id, on) { return this.#change(name, id, (items) => items.map((i) => (i.id === id ? { ...i, on: on === true, ...(i.kind === 'arrival' ? {} : { fired: this.#now().toISOString() }) } : i))); }
    remove(name, id) { return this.#change(name, id, (items) => items.filter((i) => i.id !== id)); }
    forget(name) { this.#store.remove(name); for (const key of [...this.#held.keys()]) if (key.startsWith(`${name}/`)) this.#held.delete(key); }

    /* Is it time? Resolves with the message to type, or undefined. */
    #due(name, item) {
        const now = this.#now();
        if (item.kind === 'call') return undefined;
        if (item.kind === 'every') return now.getTime() - new Date(item.fired).getTime() >= item.minutes * 60_000 ? item.message : undefined;
        if (item.kind === 'cron') {
            /* Once in the minute it names; a minute that was missed is not caught up. */
            const minuteOf = (d) => Math.floor(d.getTime() / 60_000);
            return cron(item.line)?.(now) && minuteOf(now) !== minuteOf(new Date(item.fired)) ? item.message : undefined;
        }
        if (item.kind === 'daily') {
            const [h, m] = item.at.split(':').map(Number);
            const today = new Date(now); today.setHours(h, m, 0, 0);
            const late = now.getTime() - today.getTime();
            if (late < 0 || late > LATE_MS) return undefined;
            return new Date(item.fired).getTime() < today.getTime() ? item.message : undefined;
        }
        /* An arrival. The folder must still be attached: what was taken back wakes nobody. */
        if (!this.#resources.of(name).some((x) => x.name === item.resource)) return undefined;
        const key = `${name}/${item.id}`;
        const seen = look(this.#resources.folder(item.resource));
        /* A repository: a commit is an arrival too. Only the date and size of
           its journal are looked at; git is never run here. */
        if (this.#resources.get(item.resource)?.type === 'git') {
            try { const j = lstatSync(`${this.#resources.folder(item.resource)}/.git/logs/HEAD`); if (j.isFile()) seen.set(COMMITS, `${j.size}:${Math.floor(j.mtimeMs)}`); } catch { /* no commit yet */ }
        }
        const held = this.#held.get(key);
        const when = this.#now().getTime();
        if (!held) { this.#held.set(key, { base: seen, last: seen, moved: when }); return undefined; }
        const arrived = [...seen.keys()].filter((path) => !held.base.has(path) || ((!item.onlyNew || path === COMMITS) && held.base.get(path) !== seen.get(path)));
        /* Still being written: wait until two looks in a row find the same
           thing, and until nothing has moved for as long as the owner said. */
        const still = seen.size === held.last.size && [...seen].every(([path, mark]) => held.last.get(path) === mark);
        held.last = seen;
        if (!still) held.moved = when;
        if (arrived.length === 0) { held.base = seen; return undefined; }
        if (!still || when - held.moved < (item.quiet ?? DEFAULT_QUIET_SECONDS) * 1000) return undefined;
        held.base = seen;
        return withFiles(item.message, arrived);
    }

    async #type(name, text) {
        await this.#warm(name);
        const tmux = ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE];
        if ((await this.#vms.exec(name, [...tmux, '-l', '--', text], { timeoutMs: 30_000 })).code !== 0) return false;
        return (await this.#vms.exec(name, [...tmux, 'Enter'], { timeoutMs: 30_000 })).code === 0;
    }

    /* A line from this server itself (a repository that could not be read,
       see gitkeeper.mjs), typed as a wake-up is: only into a conversation
       that is awake, cleaned the same way. Not counted in the owner's cap:
       the server says each such line once. */
    async say(name, text) {
        if (!this.#conversations.awake().includes(name)) return false;
        return this.#type(name, cleanMessage(text)).catch(() => false);
    }

    /* The address was called. Resolves with 'typed', 'capped', 'asleep',
       'failed', or undefined when the address is nobody's (said as 404, the
       same as any address that does not exist). */
    async call(token, text) {
        if (!TOKEN.test(String(token))) return undefined;
        const print = fingerprintOf(token);
        for (const record of this.#store.all()) {
            const item = record.items.find((i) => i.kind === 'call' && i.on && i.token === print);
            if (!item) continue;
            if (!this.#conversations.awake().includes(record.name)) return 'asleep';
            const said = cleanMessage(text).slice(0, CALL_TEXT_MAX);
            const line = item.message.includes('{text}') ? item.message.replaceAll('{text}', said) : item.message;
            const at = this.#now().toISOString();
            const r = this.#record(record.name);
            const capped = r.perHour > 0 && this.#recent(r).length >= r.perHour;
            const typed = capped ? false : await this.#type(record.name, line).catch(() => false);
            const what = capped ? `Not sent: ${r.perHour} wake-up(s) this hour already, the cap you set.` : typed ? `Typed: ${line}` : 'Could not be typed: is its tool running?';
            const again = this.#record(record.name);
            this.#store.put({ ...again, sent: typed ? [...this.#recent(again), at] : this.#recent(again), items: again.items.map((i) => (i.id === item.id ? { ...i, last: { at, what: what.slice(0, 300), ok: typed } } : i)) });
            return capped ? 'capped' : typed ? 'typed' : 'failed';
        }
        return undefined;
    }

    async tick() {
        if (this.#busy) return;
        this.#busy = true;
        try {
            const awake = new Set(this.#conversations.awake());
            for (const record of this.#store.all()) {
                if (!awake.has(record.name)) continue;
                for (const item of record.items.filter((i) => i.on)) {
                    let text;
                    try { text = this.#due(record.name, item); } catch { text = undefined; }
                    if (text === undefined) continue;
                    const r = this.#record(record.name);
                    const at = this.#now().toISOString();
                    const capped = r.perHour > 0 && this.#recent(r).length >= r.perHour;
                    const typed = capped ? false : await this.#type(record.name, text).catch(() => false);
                    const what = capped ? `Not sent: ${r.perHour} wake-up(s) this hour already, the cap you set.` : typed ? `Typed: ${text}` : 'Could not be typed: is its tool running?';
                    const again = this.#record(record.name);
                    this.#store.put({ ...again, sent: typed ? [...this.#recent(again), at] : this.#recent(again), items: again.items.map((i) => (i.id === item.id ? { ...i, last: { at, what: what.slice(0, 300), ok: typed }, ...(i.kind === 'arrival' ? {} : { fired: at }) } : i)) });
                }
            }
        } finally { this.#busy = false; }
    }

    start(everyMs = TICK_MS) {
        const timer = setInterval(() => { void this.tick(); }, everyMs);
        timer.unref?.();
        return timer;
    }
}
