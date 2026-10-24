/* BINDER, AS CLAVARIUM USES IT (clavarium-binder, a project of its own, an
 * npm dependency installed in every machine as Parley and Docket are:
 * toolbox.mjs). Lists of records -- batches, tasks, customers, people --
 * kept together by the owner and the tools of the conversations.
 *
 * THE BINDER IS KEPT HERE, in this server's data (binder/), never in a
 * machine: what a tool could write, it could rewrite. A tool asks through
 * its work folder's .binder (beside .parley and .docket), and is answered
 * there; who asks is said by the folder -- conversation:<name> -- never by
 * the ask. The owner changes it from the page (Lists).
 *
 * A TOOL SEES ONLY THE LISTS IT WAS GIVEN (read, or change), and never
 * approves: a gate (Batches: "Approved") is the owner's tick.
 *
 * ITS DOCKET IS TOLD (dockets.mjs) when the owner gives it a record, approves
 * one it owns, or a record it owns comes due.
 */
import { mkdirSync, lstatSync } from 'node:fs';
import { keeper } from 'clavarium-binder/host';

export const FOLDER = '.binder';
export const PUMP_MS = 1000;
export const DUE_MS = 30_000;
const AGENT = 'conversation:';

export class Binders {
    #keeper; #resources; #conversations; #dockets; #team; #timers = []; #changes = 0; #ready = new Set();

    /* `conversations()`: the names of the conversations. `dockets`: Dockets (optional): a tool told.
       `team`: the operators (optional), each a person who may own a record. */
    constructor({ dataDir, resources, conversations, dockets = null, team = null, now = () => Date.now() }) {
        this.#resources = resources; this.#conversations = conversations; this.#dockets = dockets; this.#team = team;
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
    #tell(id, text) {
        if (!this.#dockets || !id.startsWith(AGENT)) return;
        const name = id.slice(AGENT.length);
        try { this.#dockets.post(name, { kind: 'binder', text }); } catch { /* its docket may be off */ }
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
        this.#timers.push(setInterval(() => {
            try { for (const { record: r } of this.#keeper.due()) for (const id of r.owners) this.#tell(id, `Due in Binder: #${r.id} ${r.title} (${r.due})`); } catch { /* the next turn */ }
        }, DUE_MS));
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
    /* A number that moves with every change: the page reads again when it moved. */
    changes() { return this.#changes; }
}
