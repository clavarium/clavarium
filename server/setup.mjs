/* WHO GETS WHAT, AND A WHOLE SETUP IN ONE FILE.
 *
 * Three things, all made of what the other parts already keep -- nothing
 * here stores a right (grants.mjs does):
 *
 *   the map     every device, conversation and asset, and the rights between
 *               them, as nodes and links; cut into FLOWS: groups that touch
 *               nothing else (connected components), each named after its
 *               most linked conversation, or a name the owner gave it.
 *   export      the configuration, NEVER the data, as one readable file:
 *               stable order, no time in it, a format number and the version
 *               of Clavarium. Secrets by name only; a repository by its
 *               address, the commit it is at and how it is reached, never a
 *               key; a mailbox without its password; a device as "to pair",
 *               never its keys. All of it, or one flow.
 *   import      a file read, shown in full before anything is done (what is
 *               new, what exists already, what is missing), then made: assets
 *               first, then the machines one at a time, then the links.
 *
 * A FILE IS UNTRUSTED (it may come from a friend): it is only ever read as
 * data. Nothing in it is run on this server; a tool not in tools.json is
 * refused; a name that is not a plain name is refused; texts that will be
 * typed to a tool (wake-ups) or given to models (the answerer) are shown in
 * full in the preview; nothing is ever shown as HTML by the page.
 *
 * What cannot be made from a file (a secret's value, a mailbox's password, a
 * private repository's token, a device's pairing) is REMEMBERED AS TO DO, with
 * its links, in a small store of its own: it is drawn dashed on the map,
 * exported again as it came, and done by itself when the owner adds what was
 * missing (a secret of that name, a repository or a mailbox of that name), or
 * pairs a device of that name.
 *
 * The file (format 2), kept close to the setups of the public site (format 1,
 * still read: see fromV1):
 *
 *   { "clavarium": "flow", "version": 2, "made with": "Clavarium 0.0.0", "name": "...",
 *     "nodes": [ { "id": "conversation:writer", "kind": "conversation", "name": "writer", "tool": "opencode", ... } ],
 *     "links": [ { "from": "conversation:writer", "to": "folder:book", "gives": "write" } ],
 *     "shortcuts": [ ... ], "flows": [ { "around": "conversation:writer", "name": "The family book" } ] }
 */
import { readFileSync, lstatSync, openSync, readSync, closeSync, fstatSync, realpathSync, constants } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { isConversationName } from './names.mjs';
import { isSecretName } from './secrets.mjs';
import { cleanMessage, cron } from './wakeups.mjs';
import { readLines, plain } from './guide.mjs';

export const FORMAT = 2;
export const FILE_MAX = 512 * 1024;
export const NODES_MAX = 400;
export const LINKS_MAX = 2000;
export const FLOW_NAME_MAX = 60;
const LABEL_MAX = 40;
const TEXT_MAX = 4000;
const KINDS = ['device', 'conversation', 'folder', 'git', 'mailbox', 'secret'];
const ASSETS = ['folder', 'git', 'mailbox', 'secret'];
const ACCESS = ['none', 'ssh-key', 'token', 'password'];
const BUILD_MS = 20 * 60_000;

/* What a link gives, in words: the same words in the file and on the page. */
const DEVICE_PARTS = { x: 'terminal', rw: 'chat', rwx: 'terminal and chat', r: 'chat, read only', rx: 'terminal and chat, read only' };
const GIVES = { conversation: DEVICE_PARTS, folder: { r: 'read', rw: 'write' }, git: { r: 'read', rw: 'write' }, mailbox: { r: 'read' }, secret: { x: 'use' } };
export const wordsOf = (type, rights) => GIVES[type]?.[rights];
export const rightsOf = (type, words) => Object.entries(GIVES[type] ?? {}).find(([, w]) => w === words)?.[0];

const typeOf = (id) => String(id).slice(0, String(id).indexOf(':'));
const nameOf = (id) => String(id).slice(String(id).indexOf(':') + 1);
const oneLine = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\r\n\0]/.test(v);
const byKindThenName = (a, b) => (KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byEnds = (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);

/* The commit a repository is at, read from its files: git is never run in a
   repository a tool has written. Anything odd (a link, a ref that is not a
   commit) is "not known". */
export function headOf(folder) {
    /* The folder is the tool's: any part of the path may be a link, a file
       may be a FIFO. Read only regular files that really are under its .git,
       never following a link and never waiting on a pipe; only a hash comes out. */
    let root;
    try { root = realpathSync(`${folder}/.git`); if (root !== `${realpathSync(folder)}/.git`) return null; } catch { return null; }
    const small = (rel, max = 256) => {
        let fd;
        try {
            const at = `${root}/${rel}`;
            if (realpathSync(at) !== at) return '';
            fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            if (!fstatSync(fd).isFile()) return '';
            const buf = Buffer.alloc(max); const n = readSync(fd, buf, 0, max, 0);
            return buf.subarray(0, n).toString('utf8');
        } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* gone */ } }
    };
    const head = small('HEAD').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]{1,200})$/.exec(head)?.[1];
    if (!ref || ref.includes('..')) return null;
    const loose = small(ref).trim();
    if (/^[0-9a-f]{40}$/.test(loose)) return loose;
    const packed = small('packed-refs', 2_000_000);
    for (const line of packed.split('\n')) { const m = /^([0-9a-f]{40}) (.+)$/.exec(line); if (m && m[2] === ref) return m[1]; }
    return null;
}

/* FLOWS: the groups of a map that touch nothing else. A group of one is not
   a flow. Each is named after its conversation with the most links (or its
   most linked box when it has none): that box is its `around`. */
export function flowsOf(nodes, links) {
    const near = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const l of links) { near.get(l.from)?.add(l.to); near.get(l.to)?.add(l.from); }
    const seen = new Set(); const groups = [];
    for (const n of [...nodes].sort(byKindThenName)) {
        if (seen.has(n.id)) continue;
        const group = []; const stack = [n.id]; seen.add(n.id);
        while (stack.length) { const x = stack.pop(); group.push(x); for (const y of near.get(x) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
        if (group.length > 1) groups.push(group);
    }
    const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
    const nameOfNode = new Map(nodes.map((n) => [n.id, n.name]));
    return groups.map((group) => {
        const degree = (id) => near.get(id)?.size ?? 0;
        const rank = (a, b) => (degree(b) - degree(a)) || (nameOfNode.get(a) < nameOfNode.get(b) ? -1 : 1);
        const convs = group.filter((id) => kindOf.get(id) === 'conversation').sort(rank);
        const around = convs[0] ?? [...group].sort(rank)[0];
        return { around, nodes: [...group].sort() };
    }).sort((a, b) => (b.nodes.length - a.nodes.length) || (a.around < b.around ? -1 : 1));
}

/* ---------- reading a file ---------- */

const slug = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');

/* A SETUP OF THE PUBLIC SITE (format 1): drawings of what Clavarium does,
   with people, agents, assets and scripts. Read as far as it goes: a person
   is a device to pair; an agent a conversation (its tool found by name); an
   asset an empty folder; a key a secret's name. A script is not built here
   yet: said, not made. */
function fromV1(doc, tools, notes) {
    const nodes = []; const links = []; const ids = new Map();
    const toolOf = (label) => tools.find((t) => t.id === label || t.label.toLowerCase() === String(label ?? '').toLowerCase())?.id ?? String(label ?? '');
    for (const n of Array.isArray(doc.nodes) ? doc.nodes : []) {
        if (!n || typeof n !== 'object' || typeof n.id !== 'string') continue;
        if (n.kind === 'person') { ids.set(n.id, `device:${String(n.name ?? '').slice(0, LABEL_MAX)}`); nodes.push({ id: ids.get(n.id), kind: 'device', name: String(n.name ?? '').slice(0, LABEL_MAX) }); }
        else if (n.kind === 'asset') { const name = slug(n.name); ids.set(n.id, `folder:${name}`); nodes.push({ id: `folder:${name}`, kind: 'folder', name, was: String(n.name ?? '') }); }
        else if (n.kind === 'agent') {
            const name = slug(n.name); ids.set(n.id, `conversation:${name}`);
            nodes.push({ id: `conversation:${name}`, kind: 'conversation', name, was: String(n.name ?? ''), tool: toolOf(n.tool), chat: n.mode === 'conversation', ...(typeof n.does === 'string' ? { does: n.does } : {}), ...(typeof n.wake === 'string' ? { wakeInWords: n.wake } : {}) });
            if (typeof n.key === 'string') { nodes.push({ id: `secret:${n.key}`, kind: 'secret', name: n.key }); links.push({ from: `conversation:${name}`, to: `secret:${n.key}`, gives: 'use' }); }
        } else if (n.kind === 'script') notes.push(`"${String(n.name ?? '')}" is a script (${String(n.source ?? 'no address')}${n.pin ? ` at ${String(n.pin)}` : ''}): scripts are not built in Clavarium yet. Not made.`);
    }
    for (const l of Array.isArray(doc.links) ? doc.links : []) {
        const a = ids.get(l?.from); const b = ids.get(l?.to);
        if (!a || !b) continue;
        const [ta, tb] = [typeOf(a), typeOf(b)];
        if (l.kind === 'talk') {
            if (ta === 'device' && tb === 'conversation') links.push({ from: a, to: b, gives: 'chat' });
            else if (ta === 'conversation' && tb === 'device') links.push({ from: b, to: a, gives: 'chat' });
        } else if (ta === 'folder' && (tb === 'conversation' || tb === 'device')) links.push({ from: b, to: a, gives: l.kind === 'both' || l.kind === 'write' ? 'write' : 'read' });
        else if ((ta === 'conversation' || ta === 'device') && tb === 'folder') links.push({ from: a, to: b, gives: 'write' });
    }
    /* Two links between the same two: the larger one. */
    const merged = new Map();
    for (const l of links) {
        const key = `${l.from}|${l.to}`; const before = merged.get(key);
        if (!before) { merged.set(key, l); continue; }
        if (before.gives === 'read' && l.gives === 'write') merged.set(key, l);
        if (before.gives === 'chat' && l.gives === 'terminal') merged.set(key, { ...l, gives: 'terminal and chat' });
    }
    const unique = new Map(nodes.map((n) => [n.id, n]));
    return { clavarium: 'flow', version: FORMAT, name: typeof doc.name === 'string' ? doc.name : '', nodes: [...unique.values()], links: [...merged.values()], shortcuts: [], flows: [] };
}

/* A file, read and checked: the document, or a refusal that says why. The
   whole file is refused when it cannot be read as a setup; a part of it
   that cannot be made here is refused alone, in the preview. */
export function readSetup(text, tools) {
    if (typeof text !== 'string' || text.trim() === '') throw new Refusal(400, 'The file is empty.');
    if (Buffer.byteLength(text) > FILE_MAX) throw new Refusal(413, `The file is too large: a setup is at most ${FILE_MAX / 1024} KB.`);
    let doc;
    try { doc = JSON.parse(text); } catch { throw new Refusal(400, 'This file is not a Clavarium setup: it is not JSON.'); }
    if (!doc || typeof doc !== 'object' || doc.clavarium !== 'flow') throw new Refusal(400, 'This file is not a Clavarium setup.');
    const notes = [];
    if (doc.version === 1) doc = fromV1(doc, tools, notes);
    else if (doc.version !== FORMAT) throw new Refusal(400, `This setup is of format ${String(doc.version).slice(0, 10)}; this Clavarium reads formats 1 and ${FORMAT}.`);
    if (doc.links === undefined) doc = { ...doc, links: [] };
    if (!Array.isArray(doc.nodes) || !Array.isArray(doc.links)) throw new Refusal(400, 'This setup has no list of nodes or of links.');
    if (doc.nodes.length > NODES_MAX) throw new Refusal(413, `Too many things in one setup: at most ${NODES_MAX}.`);
    if (doc.links.length > LINKS_MAX) throw new Refusal(413, `Too many links in one setup: at most ${LINKS_MAX}.`);
    const nodes = new Map(); const names = new Set();
    for (const n of doc.nodes) {
        if (!n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.name !== 'string' || !KINDS.includes(n.kind)) throw new Refusal(400, 'A node of this setup has no id, name or known kind.');
        if (n.id !== `${n.kind}:${n.name}`) throw new Refusal(400, `A node's id is its kind and its name: "${n.id.slice(0, 60)}".`);
        if (nodes.has(n.id)) throw new Refusal(400, `Two nodes have the same name: "${n.name.slice(0, 60)}".`);
        /* One name for one thing: a folder and a repository of the same name would be one folder here. */
        const named = `${n.kind === 'device' || n.kind === 'secret' || n.kind === 'conversation' ? n.kind : 'asset'}:${n.name}`;
        if (names.has(named)) throw new Refusal(400, `Two nodes have the same name: "${n.name.slice(0, 60)}".`);
        names.add(named); nodes.set(n.id, n);
    }
    const links = new Map();
    for (const l of doc.links) {
        if (!l || typeof l !== 'object' || !nodes.has(l.from) || !nodes.has(l.to)) throw new Refusal(400, 'A link of this setup joins things that are not in it.');
        const key = `${l.from}|${l.to}`;
        if (links.has(key)) throw new Refusal(400, `Two links join the same two: ${key.slice(0, 120)}.`);
        links.set(key, l);
    }
    const shortcuts = Array.isArray(doc.shortcuts) ? doc.shortcuts.slice(0, 100) : [];
    const flows = Array.isArray(doc.flows) ? doc.flows.slice(0, 100) : [];
    return { doc: { ...doc, nodes: [...nodes.values()], links: [...links.values()], shortcuts, flows }, notes };
}

/* What each node of a file would become here, checked: { ok, why } for the
   node itself, its settings made plain. */
function checkNode(n, tools) {
    const bad = (why) => ({ ok: false, why });
    if (n.kind === 'device') return oneLine(n.name, LABEL_MAX) ? { ok: true } : bad(`A device's name is one line of at most ${LABEL_MAX} characters.`);
    if (n.kind === 'secret') return isSecretName(n.name) ? { ok: true } : bad('A secret is named like a variable: capitals, digits and underscores.');
    if (!isConversationName(n.name)) return bad('Not a plain name: lower-case letters, digits and hyphens, 32 at most. Refused.');
    if (n.kind === 'conversation') {
        const tool = tools.find((t) => t.id === n.tool);
        if (!tool) return bad(`Its tool, "${String(n.tool ?? '').slice(0, 40)}", is not one of this Clavarium: refused.`);
        if (n.memoryMb !== undefined && (!Number.isInteger(n.memoryMb) || n.memoryMb < tool.memoryMb || n.memoryMb > 16384)) return bad(`Its memory must be between ${tool.memoryMb} and 16384 MB.`);
        if (n.diskGb !== undefined && (!Number.isInteger(n.diskGb) || n.diskGb < 1 || n.diskGb > 256)) return bad('Its disk must be between 1 and 256 GB.');
        if (n.resume !== undefined && typeof n.resume !== 'boolean') return bad('When its tool starts is "resume": true or false.');
        if (n.askFirst !== undefined && typeof n.askFirst !== 'boolean') return bad('Whether its tool asks before acting is "askFirst": true or false.');
        if (n.chatName !== undefined && (typeof n.chatName !== 'string' || n.chatName.length > 40)) return bad('The name its chat gives its tool is "chatName": a text of 40 characters at most.');
        if (n.voiceMark !== undefined && typeof n.voiceMark !== 'boolean') return bad('Whether what is dictated into its terminal is marked is "voiceMark": true or false.');
        if (n.guide !== undefined) { try { readLines(n.guide); } catch (error) { return bad(`What its tool is told, its owner's lines: ${error.message}`); } }
        return { ok: true };
    }
    if (n.kind === 'git') {
        if (n.source !== undefined && n.source !== null && (typeof n.source !== 'string' || n.source.length > 500)) return bad('Its address is not one.');
        if (n.pin !== undefined && n.pin !== null && !/^[0-9a-f]{7,40}$/.test(String(n.pin))) return bad('Its pinned commit is not one.');
        if (n.access !== undefined && !ACCESS.includes(n.access)) return bad('How it is reached is not one of: none, ssh-key, token, password.');
        return { ok: true };
    }
    if (n.kind === 'mailbox') {
        if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(String(n.host ?? '')) || !String(n.host).includes('.')) return bad('Its mail server is not a host name.');
        return { ok: true };
    }
    return { ok: true };
}

/* The texts a node carries that will be typed to a tool or read by models:
   shown in full before anything is made. */
function textsOf(n) {
    const out = [];
    if (typeof n.does === 'string') out.push({ label: 'What it does, in the file', text: n.does.slice(0, TEXT_MAX) });
    if (typeof n.wakeInWords === 'string') out.push({ label: 'When it wakes, in the file (not set: set it yourself)', text: n.wakeInWords.slice(0, TEXT_MAX) });
    for (const w of Array.isArray(n.wakeups?.items) ? n.wakeups.items : []) out.push({ label: `Wake-up (${wakeWords(w)}): typed to its tool exactly so`, text: cleanMessage(w?.message) });
    if (n.kind === 'conversation' && n.guide !== undefined) out.push({ label: 'Your lines in its guide: read by its tool', text: (Array.isArray(n.guide) ? n.guide : [n.guide]).map((l) => plain(l, Infinity)).filter(Boolean).join('\n').slice(0, TEXT_MAX) });
    if (n.answerer && typeof n.answerer === 'object') {
        out.push({ label: 'Answerer objectives: read by models', text: String(n.answerer.objectives ?? '').slice(0, TEXT_MAX) });
        out.push({ label: 'Answerer charter: read by models', text: String(n.answerer.charter ?? '').slice(0, TEXT_MAX) });
    }
    return out;
}
function wakeWords(w) {
    if (w?.kind === 'arrival') return `when something arrives in ${String(w.resource ?? '?')}`;
    if (w?.kind === 'every') return `every ${Number(w.minutes)} min`;
    if (w?.kind === 'daily') return `every day at ${String(w.at ?? '?')}`;
    if (w?.kind === 'cron') return `cron ${String(w.line ?? '?')}`;
    if (w?.kind === 'call') return 'called from outside (a new address is made)';
    return 'unknown';
}

export class Setup {
    #store; #p; #tools; #version; #job = null; #pollMs;

    /* `parts`: what keeps each thing (conversations, resources, secrets,
       devices, shortcuts, wakeups, answerer, talk, gitKeeper, gitAccess,
       mailboxes, signin, network). `store`: the names of flows, and what an
       import could not make yet. */
    constructor({ store, version = '0.0.0', pollMs = 1000, ...parts }) {
        this.#store = store; this.#p = parts; this.#version = version; this.#pollMs = pollMs;
        this.#tools = () => parts.conversations.tools();
    }

    #todo(kind) { return this.#store.all().filter((x) => x.kind === kind); }

    /* ---------- the map ---------- */

    /* Everything there is, as the page draws it and as a file says it. A
       device is known here by its pairing; in a file, by its name. */
    #model() {
        const p = this.#p;
        const nodes = []; const links = [];
        const conversations = p.conversations.list();
        const resources = p.resources.list();
        const secrets = p.secrets?.list() ?? [];
        const devices = p.devices?.all() ?? [];
        const kindOfResource = (r) => (r.type === 'mailbox' || r.type === 'git' ? r.type : 'folder');
        for (const c of conversations) {
            const chat = Boolean(p.talk?.brief(c.name));
            nodes.push({ id: `conversation:${c.name}`, kind: 'conversation', name: c.name, sub: `${c.toolLabel ?? c.tool}${chat ? ' - chat on' : ''}`, chat, phase: c.phase, asleep: c.asleep === true, record: c });
        }
        for (const r of resources) {
            const kind = kindOfResource(r);
            nodes.push({ id: `${kind}:${r.name}`, kind, name: r.name, sub: kind === 'git' ? 'repository' : kind, record: r });
            for (const [c, access] of Object.entries(r.attachments ?? {})) links.push({ from: `conversation:${c}`, to: `${kind}:${r.name}`, rights: access === 'write' ? 'rw' : 'r' });
        }
        for (const s of secrets) {
            nodes.push({ id: `secret:${s.name}`, kind: 'secret', name: s.name, sub: 'secret' });
            for (const c of s.conversations) links.push({ from: `conversation:${c}`, to: `secret:${s.name}`, rights: 'x' });
        }
        const labels = new Set();
        for (const d of devices) {
            nodes.push({ id: `device:${d.id}`, kind: 'device', name: d.label, sub: 'paired' });
            labels.add(d.label);
            for (const g of d.grants) links.push({ from: `device:${d.id}`, to: g.asset, rights: g.rights });
        }
        const has = new Set(nodes.map((n) => n.id));
        /* What an import could not make yet. */
        for (const t of this.#todo('secret')) {
            if (has.has(`secret:${t.secret}`)) continue;
            nodes.push({ id: `secret:${t.secret}`, kind: 'secret', name: t.secret, sub: 'secret: its value is missing', pending: 'missing' }); has.add(`secret:${t.secret}`);
        }
        for (const t of this.#todo('asset')) {
            if (has.has(t.asset) || resources.some((r) => r.name === nameOf(t.asset))) continue;
            nodes.push({ id: t.asset, kind: typeOf(t.asset), name: nameOf(t.asset), sub: `${typeOf(t.asset) === 'git' ? 'repository' : 'mailbox'}: to connect`, pending: 'connect', record: t.settings }); has.add(t.asset);
        }
        for (const t of this.#todo('device')) {
            if (labels.has(t.label)) continue;
            nodes.push({ id: `pair:${t.label}`, kind: 'device', name: t.label, sub: 'to pair', pending: 'pair' }); has.add(`pair:${t.label}`);
            for (const g of t.grants) if (has.has(g.asset) || g.asset.startsWith('conversation:')) links.push({ from: `pair:${t.label}`, to: g.asset, rights: g.rights, pending: true });
        }
        for (const t of [...this.#todo('secret'), ...this.#todo('asset')]) {
            for (const l of t.links ?? []) {
                const to = t.kind === 'secret' ? `secret:${t.secret}` : t.asset;
                if (!links.some((x) => x.from === l.from && x.to === to)) links.push({ from: l.from, to, rights: l.rights, pending: true, ...(l.autoSend ? { autoSend: l.autoSend } : {}) });
            }
        }
        const known = new Set(nodes.map((n) => n.id));
        return { nodes, links: links.filter((l) => known.has(l.from) && known.has(l.to)) };
    }

    /* What the page draws: nodes, links, and the flows with their names. */
    graph() {
        this.tidy();
        const { nodes, links } = this.#model();
        const flows = flowsOf(nodes, links).map((f) => ({ ...f, name: this.#flowName(f.around, nodes) }));
        return { nodes: nodes.map(({ record, ...n }) => n), links, flows };
    }
    #flowName(around, nodes) {
        const named = this.#store.get(`flow:${around}`)?.label;
        return named ?? nodes.find((n) => n.id === around)?.name ?? around;
    }
    rename(around, name) {
        const id = String(around ?? '');
        if (!this.graph().flows.some((f) => f.around === id)) throw new Refusal(404, 'No such flow.');
        const label = String(name ?? '').trim();
        if (label === '') { this.#store.remove(`flow:${id}`); return this.graph(); }
        if (!oneLine(label, FLOW_NAME_MAX)) throw new Refusal(400, `A flow's name is one line of at most ${FLOW_NAME_MAX} characters.`);
        this.#store.put({ name: `flow:${id}`, kind: 'flow', label });
        return this.graph();
    }

    /* ---------- export ---------- */

    /* The file, as text. `flow`: the `around` of one flow, or all. */
    exportText({ flow } = {}) {
        const { nodes, links } = this.#model();
        const flows = flowsOf(nodes, links);
        let keep = null;
        if (flow !== undefined && flow !== null && flow !== '') {
            const f = flows.find((x) => x.around === flow);
            if (!f) throw new Refusal(404, 'No such flow.');
            keep = new Set(f.nodes);
        }
        const p = this.#p;
        /* A device is named in a file: two of the same name are told apart. */
        const fileId = new Map(); const taken = new Set();
        for (const n of [...nodes].sort(byKindThenName)) {
            let name = n.name;
            if (n.kind === 'device') { let i = 2; while (taken.has(name)) name = `${n.name.slice(0, LABEL_MAX - 4)} (${i++})`; taken.add(name); }
            fileId.set(n.id, `${n.kind}:${name}`);
        }
        const out = [];
        for (const n of nodes) {
            if (keep && !keep.has(n.id)) continue;
            const id = fileId.get(n.id); const name = nameOf(id);
            if (n.kind === 'conversation') out.push(this.#conversationOut(id, n.record));
            else if (n.kind === 'git') {
                const r = n.record ?? {};
                const via = n.pending ? { method: r.access ?? 'none', key: r.key } : p.gitAccess?.describe(n.name, r.from) ?? { method: 'none' };
                const pin = n.pending ? r.pin ?? null : (r.from ? headOf(p.resources.folder(n.name)) : null);
                out.push({ id, kind: 'git', name, source: (n.pending ? r.source : r.from) ?? null, pin: pin ?? null, access: via.method ?? 'none', ...(via.method === 'ssh-key' && via.key ? { key: via.key } : {}) });
            } else if (n.kind === 'mailbox') {
                const m = n.pending ? n.record : p.mailboxes?.list().find((x) => x.name === n.name);
                out.push({ id, kind: 'mailbox', name, host: m?.host ?? '', port: m?.port ?? 993, user: m?.user ?? '' });
            } else out.push({ id, kind: n.kind, name });
        }
        const outLinks = [];
        for (const l of links) {
            if (keep && !(keep.has(l.from) && keep.has(l.to))) continue;
            const type = typeOf(l.to);
            const line = { from: fileId.get(l.from), to: fileId.get(l.to), gives: wordsOf(type, l.rights) ?? l.rights };
            if (type === 'git' && l.rights === 'rw' && typeOf(l.from) === 'conversation') {
                const auto = l.pending ? l.autoSend : this.#autoOf(nameOf(l.to), nameOf(l.from));
                if (auto) line.autoSend = auto;
            }
            outLinks.push(line);
        }
        const flowNames = [];
        for (const f of flows) {
            const label = this.#store.get(`flow:${f.around}`)?.label;
            if (label && (!keep || keep.has(f.around))) flowNames.push({ around: fileId.get(f.around), name: label });
        }
        const shortcuts = keep ? [] : (p.shortcuts?.list() ?? []).map((s) => ({ label: s.label, text: s.text, enter: s.enter === true })).sort((a, b) => (a.label < b.label ? -1 : 1));
        const name = keep ? this.#flowName(flows.find((x) => x.around === flow).around, nodes) : 'Everything';
        const file = { clavarium: 'flow', version: FORMAT, 'made with': `Clavarium ${this.#version}`, name, nodes: out.sort(byKindThenName), links: outLinks.sort(byEnds), shortcuts, flows: flowNames.sort((a, b) => (a.around < b.around ? -1 : 1)) };
        return { name, text: `${JSON.stringify(file, null, 2)}\n` };
    }
    #autoOf(repository, conversation) {
        try {
            const s = this.#p.gitKeeper?.auto(repository, conversation)?.settings;
            if (!s || s.branches.length === 0) return undefined;
            return { branches: [...s.branches], quietSeconds: s.quietSeconds, perHour: s.perHour, create: s.create, checks: s.checks };
        } catch { return undefined; }
    }
    #conversationOut(id, c) {
        const p = this.#p;
        const out = { id, kind: 'conversation', name: c.name, tool: c.tool, memoryMb: c.memoryMb, diskGb: c.diskGb ?? 8, work: c.work === 'disk' ? 'disk' : 'kept', online: c.offline !== true, chat: Boolean(p.talk?.brief(c.name)), ...(c.resume === false ? { resume: false } : {}), ...(c.askFirst === true ? { askFirst: true } : {}),
            ...(c.chatName ? { chatName: c.chatName } : {}), ...(p.conversations.get?.(c.name)?.voiceMark === false ? { voiceMark: false } : {}) };
        const w = p.wakeups?.of(c.name);
        if (w && (w.items.length > 0 || w.perHour !== 12)) {
            out.wakeups = { perHour: w.perHour, items: w.items.map((i) => ({ kind: i.kind, on: i.on !== false, message: i.message,
                ...(i.kind === 'arrival' ? { resource: i.resource, onlyNew: i.onlyNew !== false, quiet: i.quiet ?? 10 } : {}),
                ...(i.kind === 'every' ? { minutes: i.minutes } : {}), ...(i.kind === 'daily' ? { at: i.at } : {}), ...(i.kind === 'cron' ? { line: i.line } : {}) })) };
        }
        /* The owner's own lines in its guide (guide.mjs): added in format 2, read by older ones as unknown. */
        const lines = p.guide?.lines(c.name) ?? [];
        if (lines.length) out.guide = lines;
        const a = p.answerer?.of(c.name);
        if (a && (a.on || a.objectives || a.charter)) out.answerer = { on: a.on, objectives: a.objectives, charter: a.charter, limit: a.limit };
        const s = p.signin?.settings(c.name);
        const todo = this.#store.get(`signin:${c.name}`);
        if (s?.configured) out.signin = { host: s.host, port: s.port ?? 993, user: s.user };
        else if (todo) out.signin = { host: todo.host, port: todo.port, user: todo.user };
        return out;
    }

    /* ---------- import: the preview ---------- */

    /* Everything the file would do here, said before anything is done.
       `choices`: { flow?: <index of one flow of the file>, items: { <id>: { do: 'keep' | 'rename' | 'replace', as?: <new name> } }, confirm: { '<from>|<to>': true } } */
    preview(text, choices = {}) {
        const tools = this.#tools();
        const { doc, notes } = readSetup(text, tools);
        const p = this.#p;
        const fileFlows = flowsOf(doc.nodes, doc.links);
        let nodes = doc.nodes; let links = doc.links;
        const only = choices?.flow;
        if (only !== undefined && only !== null && only !== '') {
            const f = fileFlows[Number(only)];
            if (!f) throw new Refusal(400, 'There is no such flow in this file.');
            const keep = new Set(f.nodes);
            nodes = nodes.filter((n) => keep.has(n.id)); links = links.filter((l) => keep.has(l.from) && keep.has(l.to));
        }
        const here = this.#model();
        const items = []; const target = new Map();
        const existing = (n) => {
            if (n.kind === 'device') return here.nodes.some((x) => x.kind === 'device' && x.name === n.name && !x.pending);
            if (n.kind === 'conversation') return p.conversations.list().some((c) => c.name === n.name);
            if (n.kind === 'secret') return (p.secrets?.list() ?? []).some((s) => s.name === n.name);
            return p.resources.list().some((r) => r.name === n.name);
        };
        const takenNames = new Set([...p.conversations.list().map((c) => `conversation:${c.name}`), ...p.resources.list().map((r) => `asset:${r.name}`)]);
        for (const n of [...nodes].sort(byKindThenName)) {
            const check = checkNode(n, tools);
            const item = { id: n.id, kind: n.kind, name: n.name, ...(n.was && n.was !== n.name ? { was: n.was } : {}), texts: textsOf(n), notes: [] };
            if (!check.ok) { items.push({ ...item, status: 'refused', why: check.why }); continue; }
            const exists = existing(n);
            const asked = choices?.items?.[n.id] ?? {};
            let act = exists ? (['keep', 'rename', 'replace'].includes(asked.do) ? asked.do : 'keep') : 'new';
            if (exists && act === 'replace' && !(n.kind === 'conversation')) act = 'keep';
            let name = n.name;
            if (act === 'rename') {
                name = String(asked.as ?? '').trim();
                const ok = n.kind === 'device' ? oneLine(name, LABEL_MAX) : n.kind === 'secret' ? false : isConversationName(name);
                const clash = n.kind === 'device' ? here.nodes.some((x) => x.kind === 'device' && x.name === name) : takenNames.has(`${n.kind === 'conversation' ? 'conversation' : 'asset'}:${name}`) || nodes.some((m) => m !== n && m.name === name && m.kind === n.kind);
                if (!ok || clash) { items.push({ ...item, status: 'exists', act: 'rename', choices: n.kind === 'conversation' ? ['keep', 'rename', 'replace'] : ['keep', 'rename'], as: name, why: !ok ? 'Not a plain name for it.' : 'This name is taken too.', blocked: true }); target.set(n.id, null); continue; }
            }
            target.set(n.id, `${n.kind}:${name}`);
            const status = exists && act !== 'rename' ? 'exists' : n.kind === 'device' ? 'to pair' : n.kind === 'secret' ? (exists ? 'exists' : 'missing')
                : n.kind === 'mailbox' ? 'to connect' : n.kind === 'git' ? this.#gitPlan(n) : 'new';
            const out = { ...item, status, act, ...(exists ? { choices: n.kind === 'conversation' ? ['keep', 'rename', 'replace'] : n.kind === 'secret' ? ['keep'] : ['keep', 'rename'] } : {}), ...(act === 'rename' ? { as: name } : {}) };
            if (n.kind === 'conversation') {
                const tool = tools.find((t) => t.id === n.tool);
                out.sub = `${tool.label}, ${n.memoryMb ?? tool.memoryMb} MB${n.work === 'disk' ? ', works on its own disk' : ''}${n.chat ? ', chat on' : ''}${n.online === false ? ', offline' : ''}${n.askFirst === true ? ', asks before acting' : ''}`;
                if (n.answerer && !p.answerer?.about()) out.notes.push('Its answerer is not set: this Clavarium has none.');
                if (n.signin) out.notes.push(`Its sign-in mailbox (${String(n.signin.user ?? '')} at ${String(n.signin.host ?? '')}) needs its password: set it in the conversation.`);
                if (n.chat && n.work === 'disk') out.notes.push('Its chat needs its work kept here: left off.');
                if (act === 'replace') out.notes.push('Its wake-ups, answerer, chat and network become the file\'s; its links are added.');
            }
            if (n.kind === 'git') {
                out.sub = n.source ? `${String(n.source)}${n.pin ? ` at ${String(n.pin).slice(0, 12)}` : ''}` : 'an empty repository';
                if (status === 'to connect') out.why = n.access === 'ssh-key' ? `It is reached with an SSH key${n.key ? ` ("${String(n.key)}")` : ''} this Clavarium does not have: add it in Assets with its key, under this name.` : `It is reached with a ${n.access === 'token' ? 'token' : 'password'}: add it in Assets with yours, under this name.`;
            }
            if (n.kind === 'mailbox') { out.sub = `${String(n.user ?? '')} at ${String(n.host)}`; out.why = 'Its password is not in the file: add it in Assets, under this name.'; }
            if (n.kind === 'secret' && status === 'missing') out.why = 'Its value is not in the file: add a secret of this name in Assets. It is then handed where the file says.';
            if (n.kind === 'device') out.why = exists && act === 'keep' ? 'A device of this name is paired here: it is given what the file says.' : 'Pair it from the map (Pair) once imported: it gets what the file says.';
            items.push(out);
        }
        /* The links, each said in words, with what stops one. */
        const itemOf = new Map(items.map((i) => [i.id, i]));
        const outLinks = [];
        for (const l of [...links].sort(byEnds)) {
            const a = itemOf.get(l.from); const b = itemOf.get(l.to);
            const line = { from: l.from, to: l.to, fromName: a?.as ?? a?.name, toName: b?.as ?? b?.name, gives: String(l.gives ?? '') };
            const refuse = (why) => outLinks.push({ ...line, status: 'refused', why });
            if (!a || !b || a.status === 'refused' || b.status === 'refused' || a.blocked || b.blocked) { refuse('One end is not made.'); continue; }
            const [ta, tb] = [a.kind, b.kind];
            const fits = (ta === 'device' && ['conversation', 'folder', 'git', 'mailbox'].includes(tb)) || (ta === 'conversation' && ASSETS.includes(tb));
            const rights = fits ? rightsOf(tb, line.gives) : undefined;
            if (!fits || !rights) { refuse(`"${line.gives.slice(0, 40)}" from a ${ta} to a ${tb} is not a right here.`); continue; }
            line.rights = rights;
            if (l.autoSend && tb === 'git' && rights === 'rw' && ta === 'conversation') {
                const s = l.autoSend; const branches = (Array.isArray(s.branches) ? s.branches : []).map(String).slice(0, 20);
                line.autoSend = { branches, quietSeconds: s.quietSeconds, perHour: s.perHour, create: s.create === true, checks: s.checks !== false };
                line.confirm = `Automatic sending to ${branches.join(', ') || '(none)'}: this conversation would send its commits by itself. Tick to set it now; otherwise set it later in its Access.`;
                line.confirmed = choices?.confirm?.[`${l.from}|${l.to}`] === true;
            }
            line.status = a.status === 'to pair' || b.status === 'missing' || b.status === 'to connect' ? 'later' : 'new';
            if (line.status === 'later') line.why = a.status === 'to pair' ? 'Given once the device is paired.' : 'Made once it is added here.';
            outLinks.push(line);
        }
        const shortcuts = only !== undefined && only !== null && only !== '' ? [] : doc.shortcuts.map((s) => {
            const label = String(s?.label ?? ''); const text = String(s?.text ?? '');
            const ok = oneLine(label, 40) && oneLine(text, 2000);
            const exists = (p.shortcuts?.list() ?? []).find((x) => x.label === label.trim());
            const same = exists && exists.text === text && exists.enter === (s.enter === true);
            const asked = choices?.items?.[`shortcut:${label}`]?.do;
            return { label, text, enter: s?.enter === true, status: !ok ? 'refused' : same ? 'same' : exists ? 'exists' : 'new', act: exists && !same ? (asked === 'replace' ? 'replace' : 'keep') : 'new', ...(!ok ? { why: 'A shortcut is one line: a label of 40 characters at most, a text of 2000.' } : {}) };
        });
        const counts = (status) => items.filter((i) => i.status === status).length;
        return {
            name: typeof doc.name === 'string' ? doc.name.slice(0, 80) : '',
            madeWith: typeof doc['made with'] === 'string' ? doc['made with'].slice(0, 60) : '',
            format: doc.version,
            flows: fileFlows.map((f, i) => ({ index: i, around: f.around, name: (doc.flows.find((x) => x?.around === f.around)?.name ?? nameOf(f.around)).toString().slice(0, FLOW_NAME_MAX), size: f.nodes.length })),
            flow: only === undefined || only === null || only === '' ? null : Number(only),
            items, links: outLinks, shortcuts, notes,
            missing: { secrets: items.filter((i) => i.kind === 'secret' && i.status === 'missing').map((i) => i.name), connect: items.filter((i) => i.status === 'to connect').map((i) => i.name), pair: items.filter((i) => i.status === 'to pair').map((i) => i.as ?? i.name) },
            said: `${[[counts('new'), 'to make'], [counts('exists'), 'already here'], [counts('missing') + counts('to connect'), 'to add yourself'], [counts('to pair'), 'to pair'], [counts('refused'), 'refused']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(', ') || 'Nothing'}.`,
            ready: !items.some((i) => i.blocked),
            target: Object.fromEntries(target),
        };
    }
    #gitPlan(n) {
        if (!n.source) return 'new';
        const access = n.access ?? 'none';
        if (access === 'none') return 'new';
        if (access === 'ssh-key' && n.key && (this.#p.gitAccess?.keys() ?? []).some((k) => k.name === n.key)) return 'new';
        return 'to connect';
    }

    /* ---------- import: doing it ---------- */

    job() { return this.#job ? { ...this.#job, steps: this.#job.steps.map((s) => ({ ...s })) } : null; }

    /* Starts making what the preview said; one import at a time. */
    start(text, choices = {}) {
        if (this.#job?.running) throw new Refusal(409, 'An import is already being made.');
        const plan = this.preview(text, choices);
        if (!plan.ready) throw new Refusal(400, 'Some names are still to choose.');
        const { doc } = readSetup(text, this.#tools());
        const job = { running: true, steps: [], done: false, plan: { said: plan.said, missing: plan.missing }, failed: 0 };
        this.#job = job;
        this.done = this.#run(job, plan, doc).catch((error) => { this.#step(job, `Stopped: ${error.message}`, 'failed'); }).finally(() => { job.running = false; job.done = true; });
        return this.job();
    }
    #step(job, text, state = 'doing') { const s = { text, state }; job.steps.push(s); if (state === 'failed') job.failed += 1; return s; }
    async #try(job, text, work) {
        const s = this.#step(job, text);
        try { const said = await work(); s.state = said === 'skipped' ? 'skipped' : 'done'; if (typeof said === 'string' && said !== 'skipped') s.why = said; }
        catch (error) { s.state = 'failed'; s.why = error.message; job.failed += 1; }
        return s.state === 'done';
    }

    async #run(job, plan, doc) {
        const p = this.#p;
        const node = new Map(doc.nodes.map((n) => [n.id, n]));
        const items = plan.items.filter((i) => i.status !== 'refused');
        const to = (id) => plan.target[id];
        const nm = (id) => nameOf(to(id));
        /* Assets first: folders and repositories made, the rest remembered. */
        for (const i of items.filter((x) => ['folder', 'git', 'mailbox', 'secret'].includes(x.kind))) {
            const n = node.get(i.id);
            if (i.status === 'exists') continue;
            if (i.kind === 'folder') await this.#try(job, `Folder ${nm(i.id)}: made, empty`, () => p.resources.create({ name: nm(i.id) }));
            else if (i.kind === 'git' && i.status === 'new') {
                await this.#try(job, n.source ? `Repository ${nm(i.id)}: cloned from ${n.source}` : `Repository ${nm(i.id)}: made, empty`, async () => {
                    const made = await p.resources.create({ name: nm(i.id), type: 'git', from: n.source ?? undefined, ...(n.source && n.access === 'ssh-key' ? { via: { method: 'ssh-key', key: n.key } } : {}), ...(n.source && n.pin ? { pin: n.pin } : {}) });
                    return made.pinned === false ? `at its newest commit: ${n.pin} was not found` : undefined;
                });
            } else if (i.kind === 'git' || i.kind === 'mailbox') {
                const settings = i.kind === 'git' ? { source: n.source ?? null, pin: n.pin ?? null, access: n.access ?? 'none', ...(n.key ? { key: n.key } : {}) } : { host: n.host, port: Number.isInteger(n.port) ? n.port : 993, user: String(n.user ?? '') };
                this.#store.put({ name: `asset:${to(i.id)}`, kind: 'asset', asset: to(i.id), settings, links: [] });
                this.#step(job, `${i.kind === 'git' ? 'Repository' : 'Mailbox'} ${nm(i.id)}: to connect (add it in Assets under this name)`, 'skipped');
            } else if (i.kind === 'secret') {
                this.#store.put({ name: `secret:${nm(i.id)}`, kind: 'secret', secret: nm(i.id), links: this.#store.get(`secret:${nm(i.id)}`)?.links ?? [] });
                this.#step(job, `Secret ${nm(i.id)}: its value is missing (add it in Assets)`, 'skipped');
            }
        }
        for (const s of plan.shortcuts) {
            if (s.status === 'refused' || s.status === 'same' || (s.status === 'exists' && s.act !== 'replace')) continue;
            await this.#try(job, `Shortcut "${s.label}"`, () => {
                const before = p.shortcuts.list().find((x) => x.label === s.label.trim());
                if (before) p.shortcuts.remove(before.id);
                return p.shortcuts.add({ label: s.label, text: s.text, enter: s.enter });
            });
        }
        /* Devices: remembered, to pair; one of the same name already paired is given its part. */
        for (const i of items.filter((x) => x.kind === 'device')) {
            const grants = plan.links.filter((l) => l.from === i.id && l.status !== 'refused').map((l) => ({ asset: to(l.to), rights: l.rights }));
            const real = (p.devices?.all() ?? []).find((d) => d.label === nameOf(to(i.id)));
            if (i.status === 'exists' && real) {
                for (const g of grants) await this.#try(job, `${real.label}: ${wordsOf(typeOf(g.asset), g.rights)} of ${nameOf(g.asset)}`, async () => { if (!this.#exists(g.asset)) { this.#later(g.asset, `device:${real.id}`, g.rights); return 'skipped'; } p.devices.give(real.id, g.asset, g.rights); return undefined; });
                continue;
            }
            this.#store.put({ name: `device:${nameOf(to(i.id))}`, kind: 'device', label: nameOf(to(i.id)), grants });
            this.#step(job, `Device ${nameOf(to(i.id))}: to pair`, 'skipped');
        }
        /* The machines, one at a time; each, once ready, gets its links and settings. */
        for (const i of items.filter((x) => x.kind === 'conversation')) {
            const n = node.get(i.id); const name = nm(i.id);
            if (i.status !== 'exists' || i.act === 'rename') {
                const made = await this.#try(job, `Conversation ${name}: its machine is built`, async () => {
                    await p.conversations.admit?.({ name, tool: n.tool, ...(n.memoryMb ? { memoryMb: n.memoryMb } : {}) });
                    p.conversations.create({ name, tool: n.tool, ...(n.memoryMb ? { memoryMb: n.memoryMb } : {}), workOnDisk: n.work === 'disk' });
                    const end = Date.now() + BUILD_MS;
                    for (;;) {
                        const c = p.conversations.get(name);
                        if (!c) throw new Refusal(410, 'It was archived meanwhile.');
                        if (c.phase === 'ready') return undefined;
                        if (c.phase === 'failed') throw new Refusal(502, c.error ?? 'Its machine could not be built.');
                        if (Date.now() > end) throw new Refusal(504, 'Its machine took too long.');
                        await new Promise((r) => setTimeout(r, this.#pollMs));
                    }
                });
                if (!made) continue;
                await this.#settings(job, name, n, false);
            } else if (i.act === 'replace') await this.#settings(job, name, n, true);
            for (const l of plan.links.filter((x) => x.from === i.id && x.status !== 'refused')) await this.#link(job, name, l, to(l.to));
            if (i.status !== 'exists' || i.act === 'replace') await this.#wakeups(job, name, n, i.act === 'replace');
            const c = p.conversations.get(name);
            if (Number.isInteger(n.diskGb) && n.diskGb > (c?.diskGb ?? 8) && (i.status !== 'exists' || i.act === 'replace')) {
                await this.#try(job, `Conversation ${name}: its disk grown to ${n.diskGb} GB`, () => p.conversations.resize(name, { diskGb: n.diskGb }));
            }
        }
        for (const f of doc.flows) {
            const around = to(String(f?.around ?? ''));
            if (!around || !oneLine(String(f?.name ?? ''), FLOW_NAME_MAX)) continue;
            const live = around.startsWith('device:') ? (this.graph().nodes.find((x) => x.kind === 'device' && x.name === nameOf(around))?.id ?? `pair:${nameOf(around)}`) : around;
            this.#store.put({ name: `flow:${live}`, kind: 'flow', label: String(f.name).trim() });
        }
        this.#step(job, job.failed ? `Done, ${job.failed} step(s) failed.` : 'Done.', job.failed ? 'failed' : 'done');
    }

    #exists(asset) {
        const p = this.#p;
        if (asset.startsWith('secret:')) return (p.secrets?.list() ?? []).some((s) => s.name === nameOf(asset));
        if (asset.startsWith('conversation:')) return p.conversations.list().some((c) => c.name === nameOf(asset));
        return p.resources.list().some((r) => r.name === nameOf(asset));
    }
    /* A link to what is not here yet, remembered with it. */
    #later(asset, from, rights, autoSend) {
        const key = asset.startsWith('secret:') ? asset : `asset:${asset}`;
        const t = this.#store.get(key) ?? (asset.startsWith('secret:') ? { name: key, kind: 'secret', secret: nameOf(asset), links: [] } : { name: key, kind: 'asset', asset, settings: {}, links: [] });
        t.links = [...(t.links ?? []).filter((l) => l.from !== from), { from, rights, ...(autoSend ? { autoSend } : {}) }];
        this.#store.put(t);
    }

    async #settings(job, name, n, replace) {
        const p = this.#p;
        if (n.online === false || replace) {
            await this.#try(job, `${name}: ${n.online === false ? 'offline' : 'online'}`, async () => { p.conversations.setOffline(name, n.online === false); if (p.network && !(await p.network.apply())) throw new Refusal(502, 'The network rules could not be applied.'); });
        }
        /* When its tool starts: its last session (the default), or a new one. */
        if (n.resume === false || (replace && p.conversations.get(name)?.resume === false)) await this.#try(job, `${name}: its tool ${n.resume === false ? 'starts fresh' : 'takes up its last session'}`, async () => p.conversations.setResume(name, n.resume !== false));
        /* Its tool acts without asking in its machine (the default), or asks first. */
        if (n.askFirst === true || (replace && p.conversations.get(name)?.askFirst === true)) await this.#try(job, `${name}: its tool ${n.askFirst === true ? 'asks before acting' : 'acts without asking, in its machine'}`, async () => p.conversations.setAskFirst(name, n.askFirst === true));
        /* The name its chat gives its tool; whether what is dictated into its terminal is marked. */
        if (n.chatName || (replace && p.conversations.get(name)?.chatName)) await this.#try(job, `${name}: its chat calls its tool ${n.chatName ? `"${n.chatName}"` : 'by the neutral name'}`, async () => p.conversations.setChatName(name, n.chatName ?? ''));
        if (n.voiceMark === false || (replace && p.conversations.get(name)?.voiceMark === false)) await this.#try(job, `${name}: dictation into its terminal ${n.voiceMark === false ? 'not marked' : 'marked'}`, async () => p.conversations.setVoiceMark(name, n.voiceMark !== false));
        if ((n.chat === true && n.work !== 'disk') || (replace && n.chat !== true && p.talk?.brief(name))) await this.#try(job, `${name}: chat ${n.chat ? 'on' : 'off'}`, () => p.talk.set(name, n.chat === true));
        if (p.guide && (n.guide !== undefined || (replace && p.guide.lines(name).length))) await this.#try(job, `${name}: your lines in its guide`, () => p.guide.setLines(name, n.guide ?? []));
        if (n.answerer && typeof n.answerer === 'object') {
            if (!p.answerer?.about()) this.#step(job, `${name}: its answerer is not set (this Clavarium has none)`, 'skipped');
            else await this.#try(job, `${name}: its answerer${n.answerer.on ? ' (on)' : ''}`, () => p.answerer.set(name, { on: n.answerer.on === true, objectives: String(n.answerer.objectives ?? ''), charter: String(n.answerer.charter ?? ''), limit: Number.isInteger(n.answerer.limit) ? n.answerer.limit : undefined }));
        }
        if (n.signin && typeof n.signin === 'object') {
            this.#store.put({ name: `signin:${name}`, kind: 'signin', host: String(n.signin.host ?? '').slice(0, 253), port: Number.isInteger(n.signin.port) ? n.signin.port : 993, user: String(n.signin.user ?? '').slice(0, 200) });
            this.#step(job, `${name}: its sign-in mailbox needs its password (in the conversation)`, 'skipped');
        }
    }

    async #wakeups(job, name, n, replace) {
        const p = this.#p; const w = n.wakeups;
        if (!p.wakeups || !w || typeof w !== 'object') return;
        if (replace) for (const i of p.wakeups.of(name).items) p.wakeups.remove(name, i.id);
        if (Number.isInteger(w.perHour)) await this.#try(job, `${name}: ${w.perHour} wake-ups an hour at most`, () => p.wakeups.setLimit(name, w.perHour));
        for (const item of (Array.isArray(w.items) ? w.items : []).slice(0, 8)) {
            if (!item || typeof item !== 'object') continue;
            if (item.kind === 'cron' && !cron(String(item.line ?? '').trim().replace(/\s+/g, ' '))) { this.#step(job, `${name}: a cron line that is not one, refused`, 'failed'); continue; }
            await this.#try(job, `${name}: a wake-up ${wakeWords(item)}`, () => {
                const made = p.wakeups.add(name, { kind: item.kind, resource: item.resource, onlyNew: item.onlyNew, minutes: item.minutes, at: item.at, message: item.message, quiet: item.quiet, line: item.line });
                const last = made.items.at(-1);
                if (item.on === false && last) p.wakeups.turn(name, last.id, false);
                return made.address ? `its new address: ${made.address}` : undefined;
            });
        }
    }

    async #link(job, conversation, l, asset) {
        const p = this.#p; const type = typeOf(asset); const name = nameOf(asset);
        const said = `${conversation}: ${l.gives} of ${name}`;
        if (!this.#exists(asset)) { this.#later(asset, `conversation:${conversation}`, l.rights, l.autoSend); this.#step(job, `${said}: once ${name} is added`, 'skipped'); return; }
        if (type === 'secret') { await this.#try(job, said, () => p.secrets.attach(conversation, name, true)); return; }
        const access = l.rights === 'rw' ? 'write' : 'read';
        const ok = await this.#try(job, said, async () => {
            if (access === 'write') p.gitKeeper?.beforeWriter(name, conversation, l.confirmed === true);
            if (access !== 'write') p.gitKeeper?.forgetAttachment(name, conversation);
            await p.resources.attach(conversation, name, access);
        });
        if (!ok || !l.autoSend) return;
        if (!l.confirmed) { this.#step(job, `${conversation}: automatic sending from ${name} not set (not confirmed)`, 'skipped'); return; }
        await this.#try(job, `${conversation}: automatic sending from ${name} to ${l.autoSend.branches.join(', ')}`, () => p.gitKeeper.setAuto(name, conversation, { ...l.autoSend, sure: true, shared: true }));
    }

    /* ---------- what was missing, added since ---------- */

    /* A secret of a name an import was waiting for: handed where the file said. */
    secretAdded(name) {
        const t = this.#store.get(`secret:${name}`);
        if (!t) return;
        for (const l of t.links ?? []) if (l.from.startsWith('conversation:') && this.#exists(l.from)) { try { this.#p.secrets.attach(nameOf(l.from), name, true); } catch { /* gone meanwhile */ } }
        this.#store.remove(`secret:${name}`);
    }
    /* A repository or a mailbox of a name an import was waiting for: attached where the file said (automatic sending is asked again, in Access). */
    async assetAdded(resource) {
        const r = this.#p.resources.get(resource);
        if (!r) return;
        const asset = `${r.type === 'mailbox' || r.type === 'git' ? r.type : 'folder'}:${r.name}`;
        const t = this.#store.get(`asset:${asset}`);
        if (!t) return;
        this.#store.remove(`asset:${asset}`);
        for (const l of t.links ?? []) {
            try {
                if (l.from.startsWith('conversation:') && this.#p.conversations.get(nameOf(l.from))?.phase === 'ready') await this.#p.resources.attach(nameOf(l.from), r.name, r.type !== 'mailbox' && l.rights === 'rw' ? 'write' : 'read');
                else if (l.from.startsWith('device:')) this.#p.devices.give(nameOf(l.from), asset, l.rights);
            } catch { /* said by the map: the link is simply not there */ }
        }
    }
    /* A device to pair: what it will get, for a code made by the usual way
       (POST /api/shares). Forgotten once a device of that name is paired. */
    toPair(label) {
        const t = this.#store.get(`device:${String(label ?? '')}`);
        if (!t) throw new Refusal(404, 'No device of this name waits to be paired.');
        return { label: t.label, grants: t.grants.filter((g) => this.#exists(g.asset) && !g.asset.startsWith('secret:')) };
    }
    /* Not wanted after all. */
    drop(id) {
        const key = String(id ?? '');
        if (!/^(device|secret|asset|signin):/.test(key) || !this.#store.get(key)) throw new Refusal(404, 'Nothing of this name waits.');
        this.#store.remove(key);
    }
    /* The page's map shows a device to pair until one of that name is paired. */
    tidy() { const labels = new Set((this.#p.devices?.all() ?? []).map((d) => d.label)); for (const t of this.#todo('device')) if (labels.has(t.label)) this.#store.remove(t.name); }
}
