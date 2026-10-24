/* DOCKET, AS CLAVARIUM USES IT (clavarium-docket, a project of its own, an npm
 * dependency installed in every machine as Parley is: toolbox.mjs).
 *
 * WHAT WAKES A TOOL IS AN EVENT IT ACKNOWLEDGES, where its chat is on: a
 * wake-up (wakeups.mjs) posts one to its docket instead of typing its line,
 * and one line is typed instead -- WAKE, 'You have something to handle: run
 * "docket".' The tool lists what waits, does it, and says done or failed.
 * Where the chat is off, a wake-up types its line as before.
 *
 * NOTHING IS LOST: an event not acknowledged is told again, when the tool is
 * idle (its pulse, Parley's, says it is not in a turn), every AGAIN_MS, at
 * most TOLD_MAX times; then its chat says it was not handled.
 *
 * THE TOOL'S OWN REMINDERS (docket remind --at/--in/--cron) are turned into
 * events here (tick), and told the same way. Its owner sees them in the
 * conversation's settings, and may take one back.
 *
 * ITS CHAT SAYS what was handled, what failed (and why: the owner is alerted)
 * and what was never handled; a reminder the tool set is a trace.
 *
 * The folder is the work folder's .docket, beside .parley: the tool writes
 * there, so nothing in it is trusted (the library bounds and cleans it).
 */
import { mkdirSync, lstatSync } from 'node:fs';
import { Docket, WAKE } from 'clavarium-docket/host';

export { WAKE };
export const FOLDER = '.docket';
export const TICK_MS = 5000;
/* An event not acknowledged is told again after this long, the tool idle... */
export const AGAIN_MS = 30 * 60_000;
/* ...this many times at most (the first included); then its chat says so. */
export const TOLD_MAX = 3;

/* One line in the chat: what was handled, cut short; the docket keeps it whole. */
const cut = (text, max) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export class Dockets {
    #resources; #store; #say; #event; #alert; #idle; #awake; #chatOn; #now; #every; #zone;
    #listening = new Map(); #zoned = new Set(); #busy = false;

    /* `say(name, line)`: types one line into its terminal (true when typed). `event(name, line)`: a line
       in its chat (Talk.event). `alert({title, body, url})`: the owner's devices. `idle(name)`: not in a
       turn (its pulse). `awake()`: the conversations whose machine runs. `chatOn(name)`. `now()`: ms. */
    /* `zone`: the time zone the tool's times are read in -- this server's, as its wake-ups' (a machine runs in UTC). */
    constructor({ store, resources, say, event = () => {}, alert = () => {}, idle = () => true, awake = () => [], chatOn = () => false, now = () => Date.now(), listenEveryMs = 2000,
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
        this.#zone = zone; this.#store = store; this.#resources = resources; this.#say = say; this.#event = event; this.#alert = alert; this.#idle = idle; this.#awake = awake; this.#chatOn = chatOn; this.#now = now; this.#every = listenEveryMs;
    }

    #dir(name) { return `${this.#resources.workFolder(name)}/${FOLDER}`; }
    /* Its folder, made when missing; refused when it is anything but a folder of its own (the tool may have put a link there). */
    #ready(name) {
        const dir = this.#dir(name);
        const info = lstatSync(dir, { throwIfNoEntry: false });
        if (info === undefined) mkdirSync(dir);
        else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${FOLDER} in its work folder is not a folder of its own`);
        return dir;
    }
    #docket(name) {
        const d = new Docket(this.#ready(name), { now: this.#now, on: (e) => this.#heard(name, e) });
        if (!this.#zoned.has(name)) { try { d.zone(this.#zone); } catch { /* not a zone: the machine's */ } this.#zoned.add(name); }
        return d;
    }
    #line(name, line) { try { this.#event(name, line); } catch { /* its chat may be off */ } }

    /* Does a wake-up of this conversation go through its docket? */
    on(name) { return this.#chatOn(name) === true; }

    /* A wake-up: posted, and told at the next tick. Resolves with the event. */
    post(name, { kind, text, data }) {
        const event = this.#docket(name).post({ from: 'clavarium', kind, text, data });
        this.#listen(name);
        return event;
    }

    /* For the owner: the tool's reminders (each with when it is next due, or taken back) and the newest events. */
    of(name) {
        if (!this.on(name)) return { on: false, plans: [], events: [] };
        let s;
        try { s = this.#docket(name).read(); } catch { return { on: true, plans: [], events: [] }; }
        const told = this.#store.get(name)?.told ?? {};
        return {
            on: true,
            plans: s.plans.filter((p) => !p.off && p.next !== null && !(p.due !== undefined && s.events.some((e) => e.plan === p.id))).map((p) => ({ id: p.id, text: p.text, cron: p.cron ?? null, next: new Date(p.next).toISOString(), tz: p.tz })),
            events: s.events.slice(-20).reverse().map((e) => ({ id: e.id, at: e.at, from: e.from, kind: e.kind, text: e.text, state: e.state, ...(e.ack ? { note: e.ack.note } : {}), told: told[e.id]?.count ?? 0 })),
            waiting: s.waiting,
        };
    }
    /* The owner takes back a reminder of the tool. */
    cancel(name, plan) {
        const d = this.#docket(name);
        if (!d.read().plans.some((p) => p.id === plan)) return false;
        d.cancel(plan);
        return true;
    }

    #listen(name) { if (!this.#listening.has(name)) { try { this.#listening.set(name, this.#docket(name).listen({ every: this.#every })); } catch { /* not there yet */ } } }
    stop() { for (const off of this.#listening.values()) off(); this.#listening.clear(); }

    /* What the tool did: said in its chat; a failure alerts its owner. */
    #heard(name, e) {
        if (e.type === 'acked' && e.ack.kind === 'done') this.#line(name, { kind: 'docket-done', text: `Handled: ${cut(e.event.text, 80)}${e.ack.note ? ` -- ${cut(e.ack.note, 120)}` : ''}`, topic: 'Handled', brief: e.event.text.slice(0, 60) });
        if (e.type === 'acked' && e.ack.kind === 'failed') {
            this.#line(name, { kind: 'docket-failed', text: `Could not be handled: ${e.event.text} -- ${e.ack.note}`, tone: 'warn', topic: 'Not handled' });
            try { this.#alert({ title: `${name}: could not be handled`, body: `${e.event.text}: ${e.ack.note}`, url: `/?c=${name}` }); } catch { /* as said */ }
        }
        if (e.type === 'planned') this.#line(name, { kind: 'docket-reminder', text: `Reminder set by the tool: ${e.plan.text} (${e.plan.cron ? `"${e.plan.cron}", next ` : ''}${new Date(e.plan.next ?? e.plan.due).toISOString().slice(0, 16).replace('T', ' ')} UTC)`, topic: 'Reminder' });
    }

    /* Every few seconds: the reminders due posted; what waits told, or told again; what was never handled said. */
    async tick() {
        if (this.#busy) return;
        this.#busy = true;
        try {
            const now = this.#now();
            for (const name of this.#awake()) {
                if (!this.on(name)) continue;
                let d;
                try { d = this.#docket(name); } catch { continue; }
                this.#listen(name);
                try { d.tick(now); } catch { /* a folder that cannot be written: nothing posted */ }
                const waiting = d.read().events.filter((e) => e.state === 'waiting');
                const record = this.#store.get(name) ?? { name, told: {} };
                const told = Object.fromEntries(Object.entries(record.told ?? {}).filter(([id]) => waiting.some((e) => e.id === id)));
                const due = waiting.filter((e) => {
                    const t = told[e.id];
                    return !t || (t.count < TOLD_MAX && now - t.at >= AGAIN_MS);
                });
                /* Told again only while it is not in a turn: a busy tool reads its docket when its turn ends. */
                const fresh = due.filter((e) => !told[e.id]);
                if (due.length && (fresh.length || this.#idle(name))) {
                    if (await this.#say(name, WAKE).catch(() => false)) for (const e of due) told[e.id] = { count: (told[e.id]?.count ?? 0) + 1, at: now };
                }
                for (const e of waiting) {
                    const t = told[e.id];
                    if (t && t.count >= TOLD_MAX && !t.said && now - t.at >= AGAIN_MS) {
                        this.#line(name, { kind: 'docket-unhandled', text: `Not handled, told ${t.count} times: ${e.text}`, tone: 'warn', topic: 'Not handled' });
                        t.said = true;
                    }
                }
                if (JSON.stringify(told) !== JSON.stringify(record.told ?? {})) this.#store.put({ ...record, told });
            }
        } finally { this.#busy = false; }
    }

    start(everyMs = TICK_MS) {
        const timer = setInterval(() => { void this.tick(); }, everyMs);
        timer.unref?.();
        return timer;
    }
}
