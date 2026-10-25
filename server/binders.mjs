/* BINDER, AS CLAVARIUM USES IT (clavarium-binder, a project of its own, an
 * npm dependency installed in every machine as Parley and Docket are:
 * toolbox.mjs). Lists of records -- batches, tasks, customers, people --
 * kept together by the owner and the tools of the conversations.
 *
 * THE BINDER IS KEPT HERE, in this server's data (binder/), never in a
 * machine: what a tool could write, it could rewrite. A tool asks through
 * its work folder's .binder (beside .parley and .docket), and is answered
 * there; who asks is said by the folder -- conversation:<name> -- never by
 * the ask. The owner changes it from the page: Assets > Lists, and a
 * conversation's Lists tab (only the lists it was given).
 *
 * A TOOL SEES ONLY THE LISTS IT WAS GIVEN (read, or change), and never
 * approves: a gate (Batches: "Approved") is the owner's tick.
 *
 * ITS DOCKET IS TOLD (dockets.mjs) when the owner gives it a record, approves
 * one it owns, or a record it owns comes due.
 *
 * A CARD COMES DUE (Binder's rule: a date alone at 09:00 this server's time,
 * a date and time at that time; not done, not archived): each conversation
 * that owns it is posted one event (kind binder/due, its title and list, data
 * the card), and where a person owns it, the owner's devices are told once
 * (alerts.mjs). A card may also carry a lead time (remindBefore days): then it
 * is told once that many days ahead too -- "Dans 7 jours : ...", the due itself
 * staying "Échéance : ...". Binder keeps what it gave, so a restart says
 * nothing again; a due date or a lead moved says it again when its time comes.
 */
import { mkdirSync, lstatSync } from 'node:fs';
import { keeper } from 'clavarium-binder/host';

export const FOLDER = '.binder';
export const PUMP_MS = 1000;
export const DUE_MS = 30_000;
export const DUE_KIND = 'binder/due';
const AGENT = 'conversation:';
const PERSON = 'person:';
/* A lead time in words: "Dans 1 jour", "Dans 7 jours". */
const ahead = (days) => `Dans ${days} jour${days > 1 ? 's' : ''}`;

export class Binders {
    #keeper; #resources; #conversations; #dockets; #team; #alert; #timers = []; #changes = 0; #ready = new Set();

    /* `conversations()`: the names of the conversations. `dockets`: Dockets (optional): a tool told.
       `team`: the operators (optional), each a person who may own a record. `alert({title, body, url})`:
       the owner's devices (optional), told of a card a person owns that came due. */
    constructor({ dataDir, resources, conversations, dockets = null, team = null, alert = null, now = () => Date.now() }) {
        this.#resources = resources; this.#conversations = conversations; this.#dockets = dockets; this.#team = team; this.#alert = alert;
        this.#keeper = keeper(`${dataDir}/binder`, { sides: () => this.#sides(), now });
        this.#keeper.store.onChange((line) => { this.#changes++; this.#heard(line); });
    }

    /* Each conversation's folder, made when missing; one that is anything but a folder of its own is left out. */
    #sides() {
        const out = [];
        for (const name of this.#conversations()) {
            let dir;
            try { dir = `${this.#resources.workFolder(name)}/${FOLDER}`; } catch { continue; }
            const info = lstatSync(dir, { throwIfNoEntry: false });
            if (info === undefined) { try { mkdirSync(dir); } catch { continue; } }
            else if (!info.isDirectory() || info.isSymbolicLink()) continue;
            out.push({ dir, who: { id: `${AGENT}${name}`, kind: 'agent', name } });
        }
        return out;
    }

    /* A tool told, through its docket, of what concerns it. */
    #tell(id, text, kind = 'binder', data = undefined) {
        if (!this.#dockets || !id.startsWith(AGENT)) return;
        const name = id.slice(AGENT.length);
        try { this.#dockets.post(name, { kind, text, ...(data ? { data } : {}) }); } catch { /* its docket may be off */ }
    }
    /* The moments come since the last look: told to who owns them, once each.
       The lead reminder (kind due-soon) leads with "Dans N jours", the due itself
       with "Échéance"; both short, high level, the card in the event's data. */
    remind() {
        const told = [];
        for (const { kind, days, record: r, list: l } of this.#keeper.due()) {
            const soon = kind === 'due-soon';
            const head = soon ? ahead(days) : 'Échéance';
            for (const id of r.owners) this.#tell(id, `${head} : #${r.id} ${r.title} (${l.title})`, DUE_KIND, { card: r.id, list: l.id, due: r.due, ...(soon ? { days } : {}) });
            if (this.#alert && r.owners.some((id) => id.startsWith(PERSON))) {
                try { void Promise.resolve(this.#alert({ title: head, body: `${r.title} (${l.title})`, url: `/?open=lists&a=${encodeURIComponent(`list:${l.id}`)}` })).catch(() => {}); } catch { /* as said */ }
            }
            told.push(r.id);
        }
        return told;
    }
    #heard(line) {
        if (line.by?.kind !== 'person' || !line.record) return;
        let r;
        try { r = this.#keeper.store.record(line.record, line.by).record; } catch { return; }
        if (line.op === 'edit' && Array.isArray(line.change?.owners)) {
            for (const id of line.change.owners) this.#tell(id, `Given to you in Binder: #${r.id} ${r.title} (binder get ${r.id})`);
        }
        if (line.op === 'move' && r.approved) for (const id of r.owners) this.#tell(id, `Approved in Binder: #${r.id} ${r.title}`);
    }

    start() {
        this.#timers.push(setInterval(() => { try { this.#keeper.pump(); } catch { /* the next turn */ } }, PUMP_MS));
        this.#timers.push(setInterval(() => { try { this.remind(); } catch { /* the next turn */ } }, DUE_MS));
        for (const t of this.#timers) t.unref?.();
        return () => { for (const t of this.#timers) clearInterval(t); this.#timers = []; };
    }
    pump() { return this.#keeper.pump(); }

    /* The owner, from the page: `identity` is who signed in ('' on a server without sign-in). */
    act(op, args, identity = '') {
        const who = { id: `person:${identity || 'owner'}`, kind: 'person', name: identity || 'Owner' };
        return this.#keeper.act(String(op ?? ''), args && typeof args === 'object' ? args : {}, who);
    }
    /* Who may own a record, or be given a list. */
    people(identity = '') {
        const persons = (this.#team?.list?.() ?? []).map((o) => ({ id: `person:${String(o.email ?? o.id ?? '').toLowerCase()}`, kind: 'person', name: String(o.email ?? o.id ?? '') })).filter((p) => p.name);
        if (!persons.length) persons.push({ id: `person:${identity || 'owner'}`, kind: 'person', name: identity || 'Owner' });
        return [...persons, ...this.#conversations().map((name) => ({ id: `${AGENT}${name}`, kind: 'agent', name }))];
    }
    /* What each conversation was given: { name: { lists, waiting } }, waiting being the
       records of those lists that wait for a person's tick (a list with a gate, not approved). */
    given() {
        const keeper = { id: 'person:keeper', kind: 'person', name: 'keeper' };
        const out = {};
        for (const l of this.#keeper.store.lists(keeper)) {
            const to = Object.keys(l.grants ?? {}).filter((id) => id.startsWith(AGENT));
            if (l.archived || !to.length) continue;
            const waiting = l.states.some((s) => s.gate) ? this.#keeper.store.list(l.id, keeper).records.filter((r) => !r.approved).length : 0;
            for (const id of to) { const one = (out[id.slice(AGENT.length)] ??= { lists: 0, waiting: 0 }); one.lists++; one.waiting += waiting; }
        }
        return out;
    }
    /* A number that moves with every change: the page reads again when it moved. */
    changes() { return this.#changes; }
}
