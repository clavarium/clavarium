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
import { JsonFile } from './store.mjs';
import { demandeView } from './demandes.mjs';

export const FOLDER = '.tether';
/* The keeper takes what the agents asked, this often. */
export const PUMP_MS = 1000;
const AGENT = 'conversation:';
export const USB_DEVICE = 'usb-device';
/* Accepted calls whose result is awaited, at most (an act that never ends is forgotten after these). */
const ACTING_MAX = 200;
/* Notices already said (their ids), at most: each said once, across restarts. */
const NOTICES_MAX = 1000;

/* SOMETHING THAT HAPPENED LATER to what an agent did (Tether's notices: a mail that came back, a scheduled
   send that failed, an invitation declined). One short head per kind, said before Tether's own sentence;
   a failure, a bounce, a decline is a warning (needs the person), a delay or a late send is news. */
const NOTICE_HEADS = {
    'mail.bounced': 'Mail came back',
    'mail.delayed': 'Mail delayed',
    'mail.send-failed': 'Mail not sent',
    'mail.later-failed': 'Scheduled mail not sent',
    'mail.later-unsure': 'Scheduled mail maybe sent',
    'mail.later-late': 'Scheduled mail sent late',
    'mail.sent-late': 'Mail sent late',
    'mail.later-draft-kept': 'Scheduled mail sent, draft kept',
    'calendar.declined': 'Invitation declined',
};
const NOTICE_INFO = /\.(delayed|later-late|sent-late)$/;
export const noticeHead = (kind) => NOTICE_HEADS[kind] ?? 'Later news';
export const noticeWarns = (kind) => !NOTICE_INFO.test(String(kind ?? ''));

export class Tethers {
    #keeper; #resources; #conversations; #secrets; #dockets; #timers = []; #changes = 0; #seen = new Map(); #offered; #noticed; #ended = new Map(); #acting = [];
    /* Set by the server once the thread is ready (main.mjs): (name, event) => talk.event(...).
       A call waiting for the owner is said in its conversation's thread when there is one. */
    announce = null;

    /* `resources`: Resources (workFolder). `conversations()`: the names of the conversations.
       `secrets`: the vault, read by name for a connector only (reveal). `dockets`: { on(name), post(name,
       {kind, text, data}) } (dockets.mjs): what wakes an agent told of a notice. `make`: the keeper (tests). */
    constructor({ dataDir, resources, conversations, secrets, connectors, dockets = null, now = () => Date.now(), make = keeper }) {
        this.#resources = resources; this.#conversations = conversations; this.#secrets = secrets; this.#dockets = dockets;
        this.#offered = new JsonFile(`${dataDir}/tether-offered.json`, []);
        this.#noticed = new JsonFile(`${dataDir}/tether-notices-seen.json`, []);
        this.#keeper = make(`${dataDir}/tether`, { sides: () => this.#sides(), secrets: (name) => this.#reveal(name), notify: (n) => this.#notified(n), now, ...(connectors ? { connectors } : {}) });
        /* Every change a page shows -- a new approval waiting, one decided, the targets,
           the journal -- bumps the counter the client watches, so the approvals screen
           sees them all at once, not only when a store change happens to wake it. */
        this.#keeper.onChange((what) => {
            /* How a call ended (yes, always, no, timeout, withdrawn, stopped): said on the line that closes its card. */
            const end = what?.approvals;
            if (end?.op === 'end' && end.id) this.#ended.set(end.id, String(end.decision ?? ''));
            this.#changes++; this.#tellNew();
            /* An accepted call is said again once it was done, with how it went: Tether journals each act
               when it ends (ok, or its error). */
            if (what?.journal) this.#tellResult(what.journal);
        });
        /* A device plugged into the owner's computer: one target, always there, flashed from the
           owner's browser (Tether's device connector). The owner gives it to a conversation as any other. */
        try {
            if (!this.#keeper.store.target(USB_DEVICE)) this.#keeper.store.putTarget({ id: USB_DEVICE, title: 'USB device (your browser)', kind: 'device', connector: 'device' });
        } catch { /* a Tether without devices */ }
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
            this.#seen.set(r.id, { name, verb: r.verb ?? 'action', agent: who, target: r.target?.id ?? '' });
            const what = [r.verb ?? 'action', r.detail].filter(Boolean).join(' ');
            const text = [what, r.target?.title ? `(${r.target.title})` : '', r.why ? `-- ${r.why}` : ''].filter(Boolean).join(' ');
            /* `request`: the card Parley draws (demandes.mjs); the text and its buttons stay for an older screen. */
            let request;
            try { request = demandeView(r); } catch { request = undefined; }
            try { this.announce(name, { kind: 'tether-demande', text: text || (r.verb ?? 'A Tether call'), topic: 'Demande', tone: 'warn', actions: [`allow:${r.id}`, `deny:${r.id}`], ...(request ? { request } : {}) }); } catch { /* its chat is off */ }
        }
        /* An approved call only the owner's browser can do (a device to flash): said once, with where to do it. */
        let jobs = [];
        try { jobs = this.#keeper.jobs?.() ?? []; } catch { jobs = []; }
        for (const j of jobs) {
            live.add(j.id);
            if (this.#seen.has(j.id)) continue;
            const who = String(j.agent ?? '');
            if (!who.startsWith(AGENT)) continue;
            const name = who.slice(AGENT.length);
            this.#seen.set(j.id, { name, verb: j.verb });
            try { this.announce(name, { kind: 'tether-job', text: `To do in your browser: ${j.args?.name ? `flash ${j.args.name}` : 'flash a device'}. Plug it in by USB here, then start.`, topic: 'Demande', tone: 'warn', actions: [`flash:${j.id}`] }); } catch { /* its chat is off */ }
        }
        for (const [id, info] of [...this.#seen]) {
            if (live.has(id)) continue;
            this.#seen.delete(id);
            const outcome = this.#ended.get(id) ?? '';
            this.#ended.delete(id);
            /* Accepted is not done (05-11: "Request handled (yes)" was said before the act, which could still
               fail): said as being done, and its result said when Tether journals it (#tellResult). */
            const accepted = outcome === 'yes' || outcome === 'always';
            if (accepted) { this.#acting.push({ id, ...info }); if (this.#acting.length > ACTING_MAX) this.#acting.shift(); }
            const text = accepted ? `Accepted: ${info.verb} — being done` : `Request handled: ${info.verb}${outcome ? ` (${outcome})` : ''}`;
            try { this.announce(info.name, { kind: 'tether-done', text, topic: 'Demande', brief: id, ...(outcome ? { outcome } : {}) }); } catch { /* its chat is off */ }
        }
        for (const id of [...this.#ended.keys()]) if (!this.#seen.has(id)) this.#ended.delete(id);
    }

    /* AN ACCEPTED CALL, DONE OR FAILED: the journal line of the act (it carries ok, or its error). Matched by
       the request's id where Tether writes it in the line (0.1.0-next.52 on), else by who, which target and
       which verb -- the oldest accepted call of that kind still waiting for its result. Said in its thread:
       done, a trace; failed, it needs the person, with the reason. */
    #tellResult(l) {
        if (!this.announce || !l || l.op || l.ok === undefined || !(l.decision === 'yes' || l.decision === 'always')) return;
        const i = l.request ? this.#acting.findIndex((x) => x.id === l.request)
            : this.#acting.findIndex((x) => x.agent === l.agent?.id && x.target === (l.target?.id ?? '') && x.verb === l.verb);
        if (i < 0) return;
        const [call] = this.#acting.splice(i, 1);
        const failed = l.ok === false;
        const text = failed ? `Failed: ${call.verb}${l.error ? ` — ${l.error}` : ''}` : `Done: ${call.verb}`;
        try { this.announce(call.name, { kind: 'tether-done', text, topic: 'Demande', ...(failed ? { tone: 'bad', level: 'needs-you' } : {}) }); } catch { /* its chat is off */ }
    }

    /* A NOTICE (Tether calls `notify`): said once in the thread of the conversation whose agent did it,
       and that agent woken through its docket where its chat is on (elsewhere its next Tether call
       tells it: Tether puts what is new first in its answer). Each notice id kept, so a notice handed
       twice -- or again after a restart -- is said once. An agent that is no conversation of this server: nothing. */
    #notified(n) {
        const id = String(n?.id ?? '');
        const who = String(n?.agent ?? '');
        if (!id || !who.startsWith(AGENT)) return;
        const name = who.slice(AGENT.length);
        let names;
        try { names = this.#conversations(); } catch { return; }
        if (!name || !names.includes(name)) return;
        const seen = this.#noticed.get();
        if (!Array.isArray(seen) || seen.includes(id)) return;
        try { this.#noticed.set([...seen, id].slice(-NOTICES_MAX)); } catch { /* said anyway, this once */ }
        const kind = String(n.kind ?? '');
        const head = noticeHead(kind);
        const warns = noticeWarns(kind);
        const said = String(n.text ?? '').trim();
        const where = n.target?.title ? ` (${n.target.title})` : '';
        const text = `${head}${where}${said ? `: ${said}` : ''}`;
        try { this.announce?.(name, { kind: 'tether-notice', text, topic: 'Notice', ...(warns ? { tone: 'warn', level: 'needs-you' } : {}) }); } catch { /* its chat is off */ }
        try {
            if (this.#dockets?.on(name)) {
                this.#dockets.post(name, { kind: 'tether-notice', text: `${text}${/[.!?]$/.test(text) ? '' : '.'} See more: tether notices.`,
                    data: { notice: id, kind, ...(n.ref ? { ref: String(n.ref) } : {}), ...(n.target?.id ? { target: String(n.target.id) } : {}) } });
            }
        } catch { /* its docket: its next Tether call tells it */ }
    }

    /* A secret's value for a connector, by name, from this server's vault; never seen by the agent.
       An unknown or expired secret is a plain refusal the connector turns into "Refused". */
    async #reveal(name) {
        const value = this.#secrets?.reveal?.(name);
        if (value === undefined || value === null) throw new Error(`no secret named "${name}" on this server`);
        return value;
    }

    /* The USB device is offered to every conversation once, at "propose": each flash still asks the
       owner. Offered once only (the target remembers it): taken back by the owner, it stays taken back. */
    #offerDevice(agent) {
        try {
            const offered = this.#offered.get();
            if (offered.includes(agent) || !this.#keeper.store.target(USB_DEVICE)) return;
            if (!this.#keeper.store.target(USB_DEVICE).grants?.[agent]) this.#keeper.store.grant(USB_DEVICE, agent, 'propose');
            this.#offered.set([...offered, agent]);
        } catch { /* a Tether without devices */ }
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
            this.#offerDevice(`${AGENT}${name}`);
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
            if (t.kind === 'device' || t.kind === 'voicebox') continue;   /* offered with a conversation or a box: not an access worth counting */
            for (const id of Object.keys(t.grants ?? {})) if (id.startsWith(AGENT)) out[id.slice(AGENT.length)] = (out[id.slice(AGENT.length)] ?? 0) + 1;
        }
        return out;
    }

    /* A number that moves with every change: the page reads again when it moved. */
    changes() { return this.#changes; }
}
