/* TETHER, AS CLAVARIUM USES IT (clavarium-tether, a project of its own, installed in every machine
 * as Parley, Docket and Binder are: toolbox.mjs). An agent reaches the accesses it was given -- a
 * machine over SSH (its terminal and files), an online folder (WebDAV, Microsoft Graph), later a
 * remote screen and a browser -- each created and given by a person.
 *
 * THE KEEPER IS KEPT HERE, in this server's data (tether/), never in a machine: what a tool could
 * write, it could rewrite, and the keeper holds the targets AND THEIR SECRETS. It checks the rights,
 * asks a person when it must, runs the connector, answers, and journals. A tool asks through its work
 * folder's .tether (beside .parley, .docket, .binder); who asks is said by the folder --
 * conversation:<name> -- never by the ask. The owner creates and gives the targets from the page
 * (Assets > Access).
 *
 * SECRETS COME FROM THIS SERVER by name (the vault's reveal), never written to the store, never given
 * to the agent or the journal: a target's config holds a secret's NAME, and the keeper reveals it for
 * the connector alone. The person sets each target's level (watch / propose / frame / free); a call
 * that must be decided waits, and the person decides it.
 *
 * The SSH and online-folder connectors are wired by the keeper itself (each a client that holds
 * nothing until a target asks it to connect). The screen and browser connectors, which need an engine
 * or a paired socket, are wired in a later step.
 */
import { mkdirSync, lstatSync } from 'node:fs';
import { keeper } from 'clavarium-tether/host';

export const FOLDER = '.tether';
/* The keeper takes what the agents asked, this often. */
export const PUMP_MS = 1000;
const AGENT = 'conversation:';

export class Tethers {
    #keeper; #resources; #conversations; #secrets; #timers = []; #changes = 0; #seen = new Map();
    /* Set by the server once the thread is ready (main.mjs): (name, event) => talk.event(...).
       A call waiting for the owner is said in its conversation's thread when there is one. */
    announce = null;

    /* `resources`: Resources (workFolder). `conversations()`: the names of the conversations.
       `secrets`: the vault, read by name for a connector only (reveal). */
    constructor({ dataDir, resources, conversations, secrets, connectors, now = () => Date.now() }) {
        this.#resources = resources; this.#conversations = conversations; this.#secrets = secrets;
        this.#keeper = keeper(`${dataDir}/tether`, { sides: () => this.#sides(), secrets: (name) => this.#reveal(name), now, ...(connectors ? { connectors } : {}) });
        /* Every change a page shows -- a new approval waiting, one decided, the targets,
           the journal -- bumps the counter the client watches, so the approvals screen
           sees them all at once, not only when a store change happens to wake it. */
        this.#keeper.onChange(() => { this.#changes++; this.#tellNew(); });
    }

    /* A new call waiting for the owner is said in its conversation's thread -- the same block a
       machine problem uses -- with Accept / Refuse; when it leaves the queue (decided here or from
       Assets, or taken back by the agent) a trace carrying its id closes those buttons. Nothing is
       said until the server wired `announce` (it holds the thread), and nothing to a conversation
       whose chat is off keeps the line waiting for when it opens. */
    #tellNew() {
        if (!this.announce) return;
        let now;
        try { now = this.#keeper.approvals() ?? []; } catch { return; }
        const live = new Set(now.map((r) => r.id));
        for (const r of now) {
            if (this.#seen.has(r.id)) continue;
            const who = r.agent?.id ?? '';
            if (!who.startsWith(AGENT)) continue;
            const name = who.slice(AGENT.length);
            this.#seen.set(r.id, { name, verb: r.verb ?? 'action' });
            const what = [r.verb ?? 'action', r.detail].filter(Boolean).join(' ');
            const text = [what, r.target?.title ? `(${r.target.title})` : '', r.why ? `-- ${r.why}` : ''].filter(Boolean).join(' ');
            try { this.announce(name, { kind: 'tether-demande', text: text || (r.verb ?? 'A Tether call'), topic: 'Demande', tone: 'warn', actions: [`allow:${r.id}`, `deny:${r.id}`] }); } catch { /* its chat is off */ }
        }
        for (const [id, info] of [...this.#seen]) {
            if (live.has(id)) continue;
            this.#seen.delete(id);
            try { this.announce(info.name, { kind: 'tether-done', text: `Request handled: ${info.verb}`, topic: 'Demande', brief: id }); } catch { /* its chat is off */ }
        }
    }

    /* A secret's value for a connector, by name, from this server's vault; never seen by the agent.
       An unknown or expired secret is a plain refusal the connector turns into "Refused". */
    async #reveal(name) {
        const value = this.#secrets?.reveal?.(name);
        if (value === undefined || value === null) throw new Error(`no secret named "${name}" on this server`);
        return value;
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

    start() {
        this.#timers.push(setInterval(() => { try { this.#keeper.pump(); } catch { /* the next turn */ } }, PUMP_MS));
        for (const t of this.#timers) t.unref?.();
        return () => { for (const t of this.#timers) clearInterval(t); this.#timers = []; };
    }
    pump() { return this.#keeper.pump(); }

    /* The owner, from the page (Assets > Access): create and give targets, read the queue, decide a
       call that waited. `identity` is who signed in ('' on a server without sign-in). */
    act(op, args, identity = '') {
        const who = { id: `person:${identity || 'owner'}`, kind: 'person', name: identity || 'Owner' };
        return this.#keeper.act(String(op ?? ''), args && typeof args === 'object' ? args : {}, who);
    }

    /* The store behind it, for the Assets page to create/give/remove targets. */
    store() { return this.#keeper.store; }

    /* A first read of a target not saved yet, its password given here: does the account
       answer? Used when a classic account is connected, before anything is kept. */
    async probe(target, password) {
        const verb = { mail: 'mail.list', calendar: 'calendar.list', contacts: 'contacts.list' }[target.connector];
        const conn = this.#keeper.connectors?.[target.connector];
        if (!verb || !conn) throw new Error(`no ${target.connector} connector`);
        await conn.run(verb, target, {}, { agent: 'person:owner', secret: async () => password });
    }

    /* What each conversation was given: { name: count } -- the targets it may use. */
    given() {
        const out = {};
        for (const t of this.#keeper.store.targets()) {
            for (const id of Object.keys(t.grants ?? {})) if (id.startsWith(AGENT)) out[id.slice(AGENT.length)] = (out[id.slice(AGENT.length)] ?? 0) + 1;
        }
        return out;
    }

    /* A number that moves with every change: the page reads again when it moved. */
    changes() { return this.#changes; }
}
