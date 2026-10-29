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
    #keeper; #resources; #conversations; #secrets; #timers = []; #changes = 0;

    /* `resources`: Resources (workFolder). `conversations()`: the names of the conversations.
       `secrets`: the vault, read by name for a connector only (reveal). */
    constructor({ dataDir, resources, conversations, secrets, connectors, now = () => Date.now() }) {
        this.#resources = resources; this.#conversations = conversations; this.#secrets = secrets;
        this.#keeper = keeper(`${dataDir}/tether`, { sides: () => this.#sides(), secrets: (name) => this.#reveal(name), now, ...(connectors ? { connectors } : {}) });
        /* Every change a page shows -- a new approval waiting, one decided, the targets,
           the journal -- bumps the counter the client watches, so the approvals screen
           sees them all at once, not only when a store change happens to wake it. */
        this.#keeper.onChange(() => { this.#changes++; });
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
