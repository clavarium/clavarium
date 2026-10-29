/* TALK: a conversation with a tool, on a screen that is not its terminal.
 *
 * THIS IS A BRANCHING ON PARLEY (clavarium-parley, a project of its own, an npm
 * dependency at an exact version: server/parley.mjs). Parley gives the tool six verbs -- a command, `parley`,
 * which this server installs in every machine from /tools (toolbox.mjs) -- and
 * gives this server the other side. PARLEY ANNOUNCES, THIS SERVER DECIDES:
 *
 *   WHERE THE BRIDGE LIVES   in the conversation's own work folder, kept by
 *                            this server: /work/.parley in its machine. No
 *                            address, no port, nothing new in the machine.
 *   THE INVITATION           typed once in its terminal when the owner asks:
 *                            Parley is installed, use it, write
 *                            to the person in their language; and, this
 *                            server's own sentence, where to check out its
 *                            branches (BRANCHES).
 *   person-wrote             one line, WAKE, typed in its terminal: once
 *                            until the tool has read, never while somebody
 *                            types there, never into a machine that does not
 *                            run (the message waits, and the line is typed
 *                            when it runs again).
 *   agent-asked, waiting     the owner's devices are alerted.
 *   agent-showed             a file under /work or in an attached folder is
 *                            opened from the page; any other is said to be
 *                            outside the shared folders.
 *   agent-doing              nothing: the page shows it, nobody is alerted.
 *   person-reacted           as Parley's set says: "stop" wakes it at once,
 *                            even while it works (WAKE typed again if it was
 *                            told already); "go", "disagree", "unclear",
 *                            "redo" wake it as a message does; "agree",
 *                            "later", "love" wake nobody (read with the next
 *                            message).
 *
 * And this server's own part of the thread:
 *
 *   LINES OF THE MACHINE     what its health says is wrong (memory, disk, a
 *                            machine that does not answer), and its restarts,
 *                            put in the thread where they happened, kept here
 *                            (never in the bridge folder: the tool writes
 *                            there), each with what can be done about it.
 *   AFTER A RESTART          the tool starts again with no memory of the
 *                            chat: once it had time to start, REREAD is typed
 *                            in its terminal, once (it reads the end of the
 *                            thread, as far as the owner chose, and further
 *                            back as it needs).
 *   THE THREAD, KEPT HERE    Parley's own copy (its `keep`): every line read
 *                            or written is kept in this server's data, one
 *                            folder per conversation, out of the machine's
 *                            reach. That copy is what the page shows; a line
 *                            the tool rewrote or deleted in /work/.parley --
 *                            the person's too -- is said in the thread
 *                            ("History changed here"), never taken.
 *   FILES OF THE PERSON      attached to a message, put under
 *                            /work/.parley/files/<id>/<name>, and the message
 *                            gives the tool their paths.
 *
 * Off by default, per conversation. Like the answerer, it is a place where
 * this server reads what a tool wrote: only where the owner turned it on.
 * What the tool prints in its terminal is never read. And it works as far as
 * the tool agrees to use it.
 */
import { posix, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, rmSync, readFileSync } from 'node:fs';
import { install, Parley, WAKE, reread, texts, fill, LANGUAGES, SHOWN_MAX, FILES_MAX } from 'clavarium-parley/host';
import { importFile } from './files.mjs';
import { KEYS } from 'clavarium-parley/ui';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';
import { isConversationName } from './names.mjs';

export const FOLDER = '.parley';
const IN_MACHINE = `/work/${FOLDER}`;
/* A part of the thread as the page asks for it (?last=200, ?days=3, ?before=ID, ?from=ID, ?since=CURSOR): Parley's options, or null. */
export function partOf(query) {
    if (!query || typeof query !== 'object') return null;
    const get = (k) => (typeof query.get === 'function' ? query.get(k) : query[k]);
    /* ?state=1: whether it is on, and no message (the page asks it often). */
    if (String(get('state') ?? '') === '1') return { state: true };
    const out = {};
    for (const k of ['last', 'days']) { const v = get(k); if (v !== null && v !== undefined && /^[1-9]\d{0,4}$/.test(String(v))) out[k] = Number(v); }
    for (const k of ['before', 'from', 'since']) { const v = get(k); if (typeof v === 'string' && PART.test(v)) out[k] = v; }
    return Object.keys(out).length ? out : null;
}
const PANE = `=${SESSION}:`;
/* Nothing is typed in a terminal somebody typed in this recently. */
export const TYPING_QUIET_MS = 4000;
/* A line that waits is tried again this often (a machine that does not run is not touched: only its state is asked). */
export const RETRY_MS = 10_000;
/* THE LINE AND ITS ENTER ARE TYPED APART, this long apart. Arriving in one
   read, "text" and Enter look like a paste to a tool that guesses pastes from
   how fast the keys come (measured in tmux: send-keys of both in one command
   gives the program one read, "text\r"): the Enter is then a new line in its
   input, not a send. Waited inside the same tmux command (run-shell -d) or
   by the terminal bridge: no second call into the machine. */
export const ENTER_AFTER_MS = 200;
/* WHAT IS KNOWN, NOT ASKED. Asking the VM manager whether the machine runs
   costs half a second for every message (measured on a real server). The
   machine is known to run when its terminal is kept open (it is closed before
   any sleep or stop), when a line was typed into it this recently, or when
   its health was looked at this recently and found it running -- in both
   cases only if its terminal was not closed since. Anything else is asked. */
export const TYPED_KNOWN_MS = 60_000;
export const HEALTH_KNOWN_MS = 150_000;
/* The one tmux command that types a line, waits, and presses Enter: an
   argument vector, no shell. tmux reads an argument that ENDS with ";" as the
   end of a command: such a last ";" is written "\;", which tmux gives back
   as ";" (tried). */
export const enterCommand = () => ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE, 'Enter'];
export function typeCommand(line) {
    const text = line.endsWith(';') ? `${line.slice(0, -1)}\\;` : line;
    return ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE, '-l', '--', text, ';', 'run-shell', '-d', String(ENTER_AFTER_MS / 1000), ';', 'send-keys', '-t', PANE, 'Enter'];
}
/* Added to Parley's invitation, this server's own sentence: a branch can be
   checked out in one folder only, and /tmp is emptied when the machine
   restarts, with the work left there. Typed in a terminal: no quote, no
   backquote, nothing a shell would run. */
export const BRANCHES = 'Check out your branches in the main folder of the repository or under /work, never in /tmp: a branch can be checked out in one folder only, and /tmp is emptied when the machine restarts.';
/* After a restart, the tool is given this long to start before REREAD is typed. */
export const REREAD_AFTER_MS = 10_000;
/* READY, NOT JUST STARTED. The tool starts when its terminal is opened, which
   may be well after the restart was said; and a tool still starting does not
   read its keyboard yet: the line and its Enter then wait together, and are
   read at once as a paste -- the Enter becomes a new line in its input box,
   never sent (seen on a real deployment). REREAD is typed once its terminal
   has been open REREAD_AFTER_MS and nothing has come out of it for
   SETTLED_MS; after READY_MAX_MS open, typed anyway (a tool that never stops
   drawing). */
export const SETTLED_MS = 2_000;
export const READY_MAX_MS = 60_000;
/* Lines of the machine kept for one conversation, at most. */
export const SYSTEM_MAX = 50;
/* THE THREAD'S OWN LINES, by kind of event, and how much each matters --
   said by this server, which knows what happened, never guessed by the page
   from the words. The page (Parley) shows "needs-you" in every view, "news"
   in the simple view as a compact line (grouped when several follow), and
   "trace" in the detailed view only. A successful send is news whatever the
   branch: the owner allowed each one. The owner may move a kind to another
   level (Settings); nothing else of a line changes with it. */
export const LEVELS = Object.freeze(['needs-you', 'news', 'trace']);
export const EVENT_LEVELS = Object.freeze({
    sent: 'news',
    refused: 'needs-you',
    'sent-by-hand': 'news',
    origin: 'trace',
    wakeup: 'trace',
    'machine-problem': 'needs-you',
    restarted: 'news',
    /* New tools in its machine that its tool reads only when it starts: a restart recommended (main.mjs). */
    'tools-updated': 'news',
    /* Its docket (dockets.mjs): what it handled, what it could not, what it never did; a reminder it set itself. */
    /* What it handled is a trace by default: one line, in the detailed view; what failed or was never handled calls. */
    'docket-done': 'trace',
    'docket-failed': 'needs-you',
    'docket-unhandled': 'needs-you',
    'docket-reminder': 'trace',
    /* A Tether call its agent asks the owner to allow (tethers.mjs): offered in the thread with
       Accept / Refuse, the same block a machine problem uses. Its closing line (decided here, from
       Assets, or by the agent) is a trace that carries the call's id, so the buttons close with it. */
    'tether-demande': 'needs-you',
    'tether-done': 'trace',
});
const TONES = ['warn', 'bad'];
/* Bounds of a line: its text, its group (topic), what the grouped line says of it (brief), its buttons. */
const EVENT_TEXT_MAX = 500;
const TOPIC_MAX = 40;
const BRIEF_MAX = 60;
const ACTIONS_MAX = 4;
const ACTION = /^[a-z]{1,20}(:[a-z0-9][a-z0-9._-]{0,63})?$/;
/* Where the person's files go, in the bridge folder; one folder per file, named by an id. */
const FILES = 'files';
const ATTACHED = new RegExp(`^/work/\\${FOLDER}/${FILES}/([0-9a-f-]{36})/([^/]+)$`);
/* An operator's own dictionary: so many words, so long each, at most. */
const OWN_MAX = 200;
const WORD_MAX = 500;
/* The words of the page and of the alerts. */
const WORDS = Object.freeze([...KEYS, 'alert-asks', 'alert-waits']);

/* WHAT IS READ OF THE THREAD AT FIRST: the newest messages, or those of the last days. The
   screen chooses for itself (each device, app.js); the tool's choice is the owner's, here:
   what REREAD asks it to read after a restart, and what its guide says. Either way the rest
   is there, read on demand: the thread is never cut, summarised nor compacted. */
export const WINDOWS = Object.freeze(['messages:100', 'messages:200', 'messages:500', 'days:1', 'days:3', 'days:7']);
export const AI_WINDOW = 'messages:100';
export const windowOf = (choice) => { const [kind, n] = String(choice).split(':'); return kind === 'days' ? { days: Number(n) } : { last: Number(n) }; };
/* What the page may ask for: a part of the thread (Parley's read(options)), its own cursor for "since". */
const PART = /^[A-Za-z0-9._~-]{1,200}$/;
export class Talk {
    #store; #words; #vms; #conversations; #resources; #toolbox; #warm; #alert; #listening = new Map(); #every; #now;
    #typedAt = new Map(); #nextTry = new Map(); #trying = new Map(); #timer; #lastLang = 'en'; #rereadAfter;
    #terminal; #health; #ranAt = new Map(); #kept; #screen; #dropSecret;

    /* `alert({ title, body, url })`: told when the tool asks, or waits.
       `words`: a store for the owner's choice of words (one record). */
    /* `terminal`: the terminals the bridge keeps open (bridge.mjs): `open(name)`,
       `type(name, line, enterAfterMs)`, `droppedAt(name)`. `health`: what was
       last seen of each machine (health.mjs), `of(name)`. Both optional. */
    /* `keptDir`: where each conversation's thread is kept (its own folder),
       in this server's data -- never in the work folder, which its machine
       writes. Without it, the bridge folder is all there is. */
    constructor({ store, words, vms, conversations, resources, toolbox = null, warm = async () => {}, alert = () => {}, listenEveryMs = 2000, now = () => Date.now(), rereadAfterMs = REREAD_AFTER_MS, terminal = null, health = null, keptDir = null, screen = null, dropSecret = null }) {
        this.#terminal = terminal; this.#health = health; this.#kept = keptDir; this.#screen = screen; this.#dropSecret = dropSecret;
        this.#store = store; this.#words = words; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#toolbox = toolbox; this.#warm = warm; this.#alert = alert; this.#every = listenEveryMs; this.#now = now; this.#rereadAfter = rereadAfterMs;
        for (const s of store.all()) if (s.on === true) this.#listen(s.name);
        this.#timer = setInterval(() => { void this.#tick(); }, Math.min(listenEveryMs, 1000));
        this.#timer.unref?.();
    }

    #known(name) {
        const c = isConversationName(name) ? this.#conversations.list().find((x) => x.name === name) : undefined;
        if (!c) throw new Refusal(404, 'No such conversation.');
        return c;
    }
    #dir(name) { return `${this.#resources.workFolder(name)}/${FOLDER}`; }
    #keep(name) { return this.#kept && isConversationName(name) ? join(this.#kept, name) : undefined; }

    /* ---- the words a person reads ---- */
    settings() {
        const s = this.#words?.get('words') ?? {};
        return { lang: s.lang ?? 'device', own: s.own ?? {}, languages: [...LANGUAGES], english: texts('en') };
    }
    /* `lang`: 'device' (each screen its own language) or one of LANGUAGES.
       `own`: whole or partial, any word replaced by any text: only the
       words that exist are taken, and they are shown as text. */
    setWords({ lang, own } = {}) {
        if (lang !== 'device' && !LANGUAGES.includes(lang)) throw new Refusal(400, `The language is "device" or one of: ${LANGUAGES.join(', ')}.`);
        const given = own ?? {};
        if (typeof given !== 'object' || Array.isArray(given)) throw new Refusal(400, 'Your words are a list of "word": "text" pairs, written as JSON: {"send": "Go"}.');
        const entries = Object.entries(given);
        if (entries.length > OWN_MAX) throw new Refusal(400, `${OWN_MAX} words at most.`);
        const unknown = entries.map(([key]) => key).filter((key) => !WORDS.includes(key));
        if (unknown.length > 0) throw new Refusal(400, `There is no such word: ${unknown.slice(0, 5).join(', ')}. The words are: ${WORDS.join(', ')}.`);
        const bad = entries.filter(([, value]) => typeof value !== 'string' || value.length > WORD_MAX).map(([key]) => key);
        if (bad.length > 0) throw new Refusal(400, `Each word is a text of ${WORD_MAX} characters at most: ${bad.slice(0, 5).join(', ')}.`);
        this.#words.put({ name: 'words', lang, own: Object.fromEntries(entries) });
        return this.settings();
    }
    /* What the thread shows of each kind of event: the level the owner
       chose for it, or its own. Kept with the words (one more record). */
    thread() {
        const own = this.#words?.get('thread')?.levels ?? {};
        const levels = Object.fromEntries(Object.entries(EVENT_LEVELS).map(([kind, level]) => [kind, LEVELS.includes(own[kind]) ? own[kind] : level]));
        return { levels, defaults: { ...EVENT_LEVELS }, choices: [...LEVELS] };
    }
    /* `levels`: whole or partial, { kind: level }. A kind left out keeps its
       own level; only what differs from it is kept, so that a later change
       of a default reaches the owners who never chose. */
    setThread({ levels } = {}) {
        if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) throw new Refusal(400, 'The levels are a list of "kind": "level" pairs: {"origin": "news"}.');
        const entries = Object.entries(levels);
        const unknown = entries.map(([kind]) => kind).filter((kind) => !Object.hasOwn(EVENT_LEVELS, kind));
        if (unknown.length > 0) throw new Refusal(400, `There is no such kind of event: ${unknown.slice(0, 5).join(', ')}. The kinds are: ${Object.keys(EVENT_LEVELS).join(', ')}.`);
        const bad = entries.filter(([, level]) => !LEVELS.includes(level)).map(([kind]) => kind);
        if (bad.length > 0) throw new Refusal(400, `A level is one of: ${LEVELS.join(', ')} (${bad.slice(0, 5).join(', ')}).`);
        const merged = { ...this.thread().levels, ...Object.fromEntries(entries) };
        this.#words.put({ name: 'thread', levels: Object.fromEntries(Object.entries(merged).filter(([kind, level]) => EVENT_LEVELS[kind] !== level)) });
        return this.thread();
    }
    /* The words for a screen whose own language is `device`. */
    words(device) {
        const s = this.settings();
        const lang = s.lang === 'device' ? String(device ?? 'en') : s.lang;
        const words = texts(lang, s.own);
        this.#lastLang = words.lang;
        return words;
    }

    /* ---- what the tool posts ---- */
    #reach(name, path) {
        const p = posix.normalize(String(path ?? ''));
        if (!p.startsWith('/') || p.includes('/../')) return null;
        if (p.startsWith('/work/')) {
            const inner = p.slice('/work/'.length);
            /* The bridge folder is not the tool's to show -- but for the files the person attached there. */
            if (!inner || inner === FOLDER || (inner.startsWith(`${FOLDER}/`) && !ATTACHED.test(p))) return null;
            return this.#conversations.list().find((x) => x.name === name)?.work === 'kept' ? `work:${inner}` : null;
        }
        const m = /^\/resources\/([a-z][a-z0-9-]{0,31})\/(.+)$/.exec(p);
        return m && this.#resources.of(name).some((x) => x.name === m[1]) ? `${m[1]}:${m[2]}` : null;
    }

    #parley(name, reacted = () => {}) {
        return new Parley(this.#dir(name), {
            keep: this.#keep(name),
            reach: (path) => this.#reach(name, path),
            on: (event) => {
                if (event.type === 'person-reacted') { reacted(event); return; }
                if (event.type === 'person-wrote') { this.#want(name); return; }
                const words = texts(this.#lastLang, this.settings().own);
                if (event.type === 'agent-asked') this.#alert({ title: fill(words['alert-asks'], { name }), body: event.message.text ?? '', url: `/?c=${name}` });
                if (event.type === 'agent-status' && event.message.state === 'waiting') this.#alert({ title: fill(words['alert-waits'], { name }), body: event.message.text ?? '', url: `/?c=${name}` });
            },
        });
    }
    #listen(name) { if (!this.#listening.has(name)) { try { this.#listening.set(name, this.#parley(name).listen({ every: this.#every })); } catch { /* its folder is not there yet */ } } }
    #deaf(name) { this.#listening.get(name)?.(); this.#listening.delete(name); }

    /* `part`: a part of the thread (the page's window, the page before it, what changed since its
       cursor: Parley's read(options)); none, the newest SHOWN_MAX, as before. The cursor given back
       is Parley's and this server's own lines', together. */
    of(name, part) {
        const c = this.#known(name);
        const possible = c.work === 'kept';
        const record = this.#store.get(name);
        const tools = Boolean(this.#toolbox?.find('parley'));
        if (record?.on !== true || !possible) return { on: false, possible, tools, messages: [], waiting: 0, status: null, steps: [], files: [], unread: 0 };
        const wake = { waits: record.pending === true || record.reread === true, typed: record.typedAt ?? null, why: record.reread === true ? 'restarting' : record.why ?? null };
        /* The machine's lines go among the messages, where they happened. */
        const lines = (record.system ?? []).map((l) => ({ from: 'system', kind: 'system', choices: [], ...l }));
        const asked = partOf(part);
        if (asked?.state) return { on: true, possible, tools, wake };
        if (!asked) {
            const read = this.#parley(name).read();
            const messages = [...read.messages, ...lines].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-SHOWN_MAX);
            return { on: true, possible, tools, ...read, messages, wake };
        }
        /* Its own lines change apart from the thread (and their buttons with what was marked seen): their stamp is part of the cursor. */
        const stamp = createHash('sha256').update(JSON.stringify([record.system ?? [], this.#health?.of?.(name)?.seenAt ?? null])).digest('hex').slice(0, 10);
        const [thread, ours] = asked.since ? String(asked.since).split('~') : [];
        const read = this.#parley(name).read({ ...asked, ...(asked.since ? { since: thread } : {}) });
        const cursor = `${read.cursor}~${stamp}`;
        if (read.since === true) return { on: true, possible, tools, ...read, messages: [...read.messages, ...(ours === stamp ? [] : lines)].sort((a, b) => String(a.at).localeCompare(String(b.at))), cursor, wake };
        /* A part: the lines of its time. */
        const w = read.window ?? {};
        const mine = lines.filter((l) => (!(w.more > 0) || String(l.at) >= String(w.from ?? '')) && (w.until === null || w.until === undefined || String(l.at) < String(w.until)));
        return { on: true, possible, tools, ...read, messages: [...read.messages, ...mine].sort((a, b) => String(a.at).localeCompare(String(b.at))), cursor, wake };
    }

    /* The whole thread searched, however little of it a screen shows (Parley's search). */
    search(name, text) {
        if (!this.of(name).on) throw new Refusal(409, 'Its chat is off.');
        return this.#parley(name).search(String(text ?? '').slice(0, 200));
    }

    /* What the tool reads of its chat after a restart (REREAD), the owner's choice of WINDOWS. */
    window() {
        const ai = this.#words?.get('window')?.ai;
        return { ai: WINDOWS.includes(ai) ? ai : AI_WINDOW, default: AI_WINDOW, choices: [...WINDOWS] };
    }
    setWindow({ ai } = {}) {
        if (!WINDOWS.includes(ai)) throw new Refusal(400, `The window is one of: ${WINDOWS.join(', ')}.`);
        this.#words.put({ name: 'window', ai });
        return this.window();
    }
    /* The line typed after a restart, and the command it names (for its guide). */
    rereadLine() { return reread(windowOf(this.window().ai)); }
    rereadCommand() { const w = windowOf(this.window().ai); return w.days ? `parley read --days ${w.days}` : `parley read --last ${w.last}`; }

    /* For the list of conversations: does it wait for its owner? Cheap: two small files read. */
    brief(name) {
        const r = this.#store.get(name);
        if (r?.on !== true) return null;
        /* On, but unreadable just now: still said to be on (the share sheet offers its chat by that). */
        try {
            /* Its open questions, however old, come with the newest messages (Parley's window). */
            const now = this.#parley(name).read({ last: SHOWN_MAX });
            /* Its last message, either way: the list says when it last spoke, and what (app.js, Recent). */
            /* What the person or the tool said -- never a line of this server (a restart, a machine put to sleep):
               those are no one using it, and would lift it in Recent. */
            const last = (now.messages ?? []).filter((m) => m.kind !== 'doing' && (m.from === 'person' || m.from === 'agent')).at(-1);
            /* IT NEEDS ITS OWNER while a question of it is open (neither answered nor closed) and the owner wrote
               nothing since -- but the answer to ANOTHER question, which says nothing of this one (two asked, one
               answered: the other still waits, seen 22-10); or while it said it waits, and the owner wrote nothing since. */
            const messages = now.messages ?? [];
            const person = messages.filter((m) => m.from === 'person');
            const personAt = person.map((m) => m.at).sort().at(-1) ?? '';
            const answered = new Set(person.map((m) => m.answers).filter(Boolean));
            const open = messages.filter((m) => m.from === 'agent' && m.kind === 'ask' && !m.closed && !answered.has(m.id));
            const asks = open.some((q) => !person.some((p) => p.at >= q.at && !(p.answers && p.answers !== q.id)));
            const needs = asks || (now.status?.state === 'waiting' && String(now.status.at ?? '') > personAt);
            /* What it said it does (status, doing): it is at work, even without a message. */
            const stepAt = (now.steps ?? []).map((m) => m.at).sort().at(-1) ?? null;
            return { waiting: now.waiting, state: now.status?.state ?? null, needs, ...(stepAt ? { stepAt } : {}), ...(last ? { lastAt: last.at, lastFrom: last.from === 'person' ? 'person' : 'agent', lastText: String(last.short || last.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) } : {}) };
        } catch { return { waiting: 0, state: null }; }
    }

    /* Is its chat on? (cheap: the record alone) */
    isOn(name) { return this.#store.get(name)?.on === true; }

    /* Its tool's pulse (Parley): { busy, at }, or null. Where the chat is off: null. */
    pulse(name) {
        if (this.#store.get(name)?.on !== true) return null;
        try { return this.#parley(name).read().pulse ?? null; } catch { return null; }
    }

    async set(name, on) {
        const c = this.#known(name);
        if (on === true) {
            if (c.work !== 'kept') throw new Refusal(409, 'This conversation works on the disk of its machine: its work folder is not kept here, so the bridge has nowhere to live.');
            install(this.#dir(name), { as: IN_MACHINE });
            this.#store.put({ ...this.#store.get(name), name, on: true });
            this.#listen(name);
        } else {
            this.#store.put({ name, on: false });
            this.#deaf(name);
        }
        return this.of(name);
    }

    /* Types a line and Enter in the tool's terminal. Through the terminal the
       bridge keeps open into the same tmux pane when there is one (nothing
       sent into the machine: the bytes go down a channel already open), or
       else one command in the machine. */
    async #type(name, line) {
        await this.#warm(name);
        const down = this.#terminal?.open(name) ? await Promise.resolve(this.#terminal.type(name, line, ENTER_AFTER_MS)).catch(() => false) : false;
        if (down === true) { this.#ranAt.set(name, this.#now()); return true; }
        /* The line went, its Enter did not (the channel closed meanwhile): the Enter alone, never the line twice. */
        const ok = (await this.#vms.exec(name, down === 'enter' ? enterCommand() : typeCommand(line), { timeoutMs: 30_000 })).code === 0;
        if (ok) this.#ranAt.set(name, this.#now());
        return ok;
    }

    /* Whether its machine runs: true when known without asking (see
       HEALTH_KNOWN_MS), else asked of the VM manager. */
    async #runs(name) {
        if (this.#terminal?.open(name)) return true;
        const since = this.#terminal?.droppedAt?.(name) ?? -Infinity;
        const fresh = (at, ms) => Number.isFinite(at) && at > since && this.#now() - at < ms;
        if (fresh(this.#ranAt.get(name), TYPED_KNOWN_MS)) return true;
        const seen = this.#health?.of(name);
        if (seen?.state === 'Running' && seen.answering !== false && fresh(Date.parse(seen.at), HEALTH_KNOWN_MS)) return true;
        return (await this.#vms.state(name).catch(() => undefined)) === 'Running';
    }

    /* The tool is asked, in its terminal, to use the command -- installed in
       its machine by this server, never by the tool (toolbox.mjs) -- writing
       to the person in `lang`. Typed once, when the owner asks. */
    async invite(name, lang) {
        const c = this.#known(name);
        if (!this.of(name).on) throw new Refusal(409, 'Turn it on first.');
        const tool = this.#toolbox?.find('parley');
        if (!tool) throw new Refusal(503, 'The tools folder is not in place on this server yet: try again in a moment, or restart the server.');
        if (!this.#conversations.awake().includes(name)) throw new Refusal(409, 'It is asleep: open it first.');
        const why = await this.#toolbox.installIn(name);
        if (why) throw new Refusal(502, `Parley could not be installed in its machine: ${why}.`);
        const text = `${this.#parley(name).invite(lang, { shared: c.work === 'kept' ? '/work' : undefined })} ${BRANCHES}`;
        if (!(await this.#type(name, text).catch(() => false))) throw new Refusal(502, 'The invitation could not be typed: is its tool running?');
        return { ...this.of(name), invited: text };
    }

    async say(name, text, answers, files, via, extra) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        const given = files === undefined || files === null ? [] : files;
        if (!Array.isArray(given) || given.length > FILES_MAX) throw new Refusal(400, `A message has ${FILES_MAX} files at most.`);
        /* Only files put here by `attach`: their paths are this server's, and each is there. Each is
           its path, or { path, note }: what the person wrote about that file alone (Parley bounds it). */
        const attached = given.map((item) => {
            const path = item && typeof item === 'object' && !Array.isArray(item) ? item.path : item;
            const m = typeof path === 'string' ? ATTACHED.exec(path) : null;
            const file = m ? join(this.#dir(name), FILES, m[1], m[2]) : undefined;
            const info = file ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
            if (!info?.isFile()) throw new Refusal(400, 'A file of this message was not attached here first.');
            const note = item && typeof item === 'object' && typeof item.note === 'string' ? item.note : '';
            return { path, name: m[2], size: info.size, ...(note ? { note } : {}) };
        });
        /* A secret pasted in the message (a token, a key) is lifted into a
           short-lived store, and the message keeps only a reference -- the
           thread never holds the value (secret-scan.mjs, secrets.mjs). It must
           never lose a message: on any trouble the text is sent as it came. */
        let said = text ?? '';
        if (this.#screen && said) { try { said = await this.#screen(name, said); } catch { said = text ?? ''; } }
        try { this.#parley(name).say(said, answers, attached, { via: via === 'voice' ? 'voice' : undefined, ...(extra && typeof extra === 'object' ? { picked: extra.picked, replies: extra.replies, about: extra.about } : {}) }); } catch (error) { if (error instanceof RangeError) throw new Refusal(400, error.message); throw error; }
        const told = await this.#wake(name);
        return { ...this.of(name), told };
    }

    /* THE OWNER REACTS to a message of the tool (`reaction` null: taken
       back). Whether, and how soon, the tool is told is Parley's set's hint. */
    async react(name, to, reaction) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        if (typeof to !== 'string' || (reaction !== null && typeof reaction !== 'string')) throw new Refusal(400, 'Say which message (to) and which reaction, or null to take it back.');
        let wakes = false;
        try { this.#parley(name, (event) => { wakes = event.wakes; }).react(to, reaction); } catch (error) { if (error instanceof RangeError) throw new Refusal(400, error.message); throw error; }
        let told = 'kept';
        if (wakes === 'now') { this.#want(name); told = await this.#wake(name, true); }
        else if (wakes === true) { this.#want(name); told = await this.#wake(name); }
        return { ...this.of(name), told };
    }

    /* A FILE THE PERSON ATTACHES, before the message that carries it: put in
       the bridge folder, in a folder of its own, under the name it had.
       Resolves with where the tool finds it. */
    async attach(name, fileName, request) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        const id = randomUUID();
        /* The bridge folder is in the tool's work folder: the tool may have put a link where a folder is
           expected. Neither it nor its files folder may be anything but a real folder of its own. */
        const own = (path) => { const i = lstatSync(path, { throwIfNoEntry: false }); return i === undefined || (i.isDirectory() && !i.isSymbolicLink()); };
        if (!own(this.#dir(name)) || !own(join(this.#dir(name), FILES))) throw new Refusal(409, 'The chat folder of this conversation is not as it should be: a file cannot be attached.');
        if (!lstatSync(join(this.#dir(name), FILES), { throwIfNoEntry: false })) mkdirSync(join(this.#dir(name), FILES));
        if (!own(join(this.#dir(name), FILES))) throw new Refusal(409, 'The chat folder of this conversation is not as it should be: a file cannot be attached.');
        mkdirSync(join(this.#dir(name), FILES, id));
        const kept = await importFile(join(this.#dir(name), FILES), id, String(fileName ?? ''), request);
        return { path: `${IN_MACHINE}/${FILES}/${id}/${kept.name}`, name: kept.name, size: kept.size };
    }

    /* Whether a file (as the page opens it: "work:report.html") is one of
       this chat: shown by the tool, cited in one of its messages (a path, a
       picture placed in the text), or attached by the person. */
    shown(name, reference) {
        if (!this.of(name).on || typeof reference !== 'string' || !reference) return false;
        return this.#parley(name).read({ all: true }).messages.some((m) => m.open === reference || (m.files ?? []).some((f) => f.open === reference) || (m.refs ?? []).some((r) => r.open === reference));
    }

    /* ---- lines of the machine, and of what happened to its repositories ---- */
    #line(name, line) {
        const r = this.#store.get(name);
        if (r?.on !== true) return null;
        const kept = { id: randomUUID(), at: new Date(this.#now()).toISOString(), ...line };
        this.#store.put({ ...r, system: [...(r.system ?? []), kept].slice(-SYSTEM_MAX) });
        return kept;
    }

    /* ONE LINE IN THE THREAD for something that happened to this
       conversation: `kind` one of EVENT_LEVELS, `level` its own unless given,
       and in either case replaced by the owner's choice for that kind.
       Only where the chat is on; never counted as unread (the page counts
       the tool's messages only); at most SYSTEM_MAX kept. Resolves with the
       line kept, or null. `actions`: ids the page maps to buttons. */
    event(name, { kind, text, level, tone, topic, brief, actions = [] } = {}) {
        if (!Object.hasOwn(EVENT_LEVELS, kind)) throw new RangeError(`No such kind of event: ${kind}`);
        const said = String(text ?? '').trim();
        if (!said) return null;
        /* The owner's choice when there is one (stored only where it differs from the kind's own). */
        const chosen = this.thread().levels[kind];
        const line = {
            /* Not `kind`: the page reads that of every message ('system' for these). */
            event: kind,
            text: said.slice(0, EVENT_TEXT_MAX),
            level: chosen !== EVENT_LEVELS[kind] ? chosen : LEVELS.includes(level) ? level : chosen,
            ...(TONES.includes(tone) ? { tone } : {}),
            ...(topic ? { topic: String(topic).slice(0, TOPIC_MAX) } : {}),
            ...(brief ? { brief: String(brief).slice(0, BRIEF_MAX) } : {}),
            actions: (Array.isArray(actions) ? actions : []).filter((a) => typeof a === 'string' && ACTION.test(a)).slice(0, ACTIONS_MAX),
        };
        return this.#line(name, line);
    }

    /* What the health of its machine says (health.mjs), as it is judged. A
       problem is said once, when it appears: said again only once it went
       away and came back (or, for memory, when it ran out once more). */
    machine(name, record) {
        const r = this.#store.get(name);
        if (r?.on !== true || !record) return;
        const serious = (record.problems ?? []).filter((p) => p.level === 'warn' || p.level === 'bad');
        /* A machine asleep, stopped or starting was not looked at inside: what was wrong is not known to be gone. */
        if (serious.length === 0 && record.state !== 'Running') return;
        const keys = serious.map((p) => p.key ?? p.text);
        const before = new Set(r.machineKeys ?? []);
        const fresh = serious.filter((p) => !before.has(p.key ?? p.text));
        if (keys.join('|') !== (r.machineKeys ?? []).join('|')) this.#store.put({ ...r, machineKeys: keys });
        if (fresh.length === 0) return;
        this.event(name, {
            kind: 'machine-problem',
            text: fresh.map((p) => p.text).join(' '),
            tone: fresh.some((p) => p.level === 'bad') ? 'bad' : 'warn',
            topic: 'Machine',
            /* What can be done: a disk short of room is looked at (what takes it) or made larger --
               a restart frees nothing; otherwise more memory where memory is short, a restart, its terminal. */
            actions: [...(fresh.every((p) => p.kind === 'disk') ? ['room', 'disk'] : [...(fresh.some((p) => p.kind === 'memory') ? ['memory'] : []), 'restart', 'terminal']), 'seen'],
        });
    }

    /* Its machine was restarted, or built again (conversations.mjs): said in
       the thread, and, the tool having started again with nothing of the
       chat in mind, REREAD is typed with the person's next message (never alone). */
    renewed(name, text, started = true) {
        const r = this.#store.get(name);
        if (r?.on !== true) return;
        if (text) this.event(name, started ? { kind: 'restarted', text, topic: 'Restarted' } : { kind: 'machine-problem', text, tone: 'bad', topic: 'Machine', actions: ['restart', 'terminal'] });
        if (started) {
            this.#store.put({ ...this.#store.get(name), reread: true });
            this.#nextTry.set(`reread:${name}`, this.#now() + this.#rereadAfter);
        }
    }

    async #tryReread(name) {
        const r = this.#store.get(name);
        if (r?.on !== true || r.reread !== true) return 'done';
        if (this.#now() < (this.#nextTry.get(`reread:${name}`) ?? 0)) return 'later';
        const later = (ms) => { this.#nextTry.set(`reread:${name}`, this.#now() + ms); return 'later'; };
        /* Typed only when the person has written since: a line typed while the tool
           reloads a long session after a restart sat in its input box, never sent
           (seen on a real deployment). By then the tool has long been ready. */
        if (this.#parley(name).unread() === 0) return later(RETRY_MS);
        if (!this.#conversations.awake().includes(name)) return later(RETRY_MS);
        const quiet = this.#now() - (this.#typedAt.get(name) ?? 0);
        if (quiet < TYPING_QUIET_MS) return later(TYPING_QUIET_MS - quiet + 100);
        if (!(await this.#runs(name))) return later(RETRY_MS);
        if (this.#terminal?.settled) {
            await this.#warm(name);
            const s = this.#terminal.settled(name);
            if (s) {
                const wait = Math.max(this.#rereadAfter - s.openFor, s.openFor < READY_MAX_MS ? SETTLED_MS - s.quietFor : 0);
                if (wait > 0) return later(wait + 100);
            }
        }
        if (!(await this.#type(name, this.rereadLine()).catch(() => false))) return later(RETRY_MS);
        /* Reading the whole thread, it reads what waits too: that line is not typed after it. */
        const waits = this.#parley(name).unread() > 0;
        this.#store.put({ ...this.#store.get(name), reread: false, ...(waits ? { pending: false, woke: true, why: null, again: false } : {}), typedAt: new Date(this.#now()).toISOString() });
        return 'typed';
    }

    /* ---- the line that wakes the tool ---- */
    /* Somebody typed in its terminal: nothing is typed over them. */
    typed(name) { this.#typedAt.set(name, this.#now()); }

    #want(name) {
        const r = this.#store.get(name);
        if (r?.on === true && r.woke !== true) this.#store.put({ ...r, pending: true });
    }

    /* Types WAKE if it should be typed now. Resolves with what happened:
       'typed', 'read' (nothing waits), 'told' (typed already, not read yet),
       'asleep', 'typing', 'failed' -- the last three wait, and are tried
       again. `again`: the owner asked to remind it, typed before or not. */
    #wake(name, again = false) {
        const going = this.#trying.get(name);
        if (going) return going;
        const run = this.#tryWake(name, again).finally(() => this.#trying.delete(name));
        this.#trying.set(name, run);
        return run;
    }
    async #tryWake(name, again) {
        const r = this.#store.get(name);
        if (r?.on !== true) return 'read';
        const waits = (why, ms) => { this.#store.put({ ...this.#store.get(name), pending: true, why, again }); this.#nextTry.set(name, this.#now() + ms); return why; };
        if (this.#parley(name).unread() === 0) { if (r.pending || r.woke) this.#store.put({ ...r, pending: false, woke: false, why: null, again: false }); return 'read'; }
        /* Its machine has just restarted: the line that will be typed tells it to read everything. */
        if (r.reread === true) { this.#store.put({ ...r, pending: true, why: 'restarting', again }); return 'restarting'; }
        if (r.woke === true && !again) { if (r.pending) this.#store.put({ ...r, pending: false, why: null }); return 'told'; }
        if (!this.#conversations.awake().includes(name)) return waits('asleep', RETRY_MS);
        const quiet = this.#now() - (this.#typedAt.get(name) ?? 0);
        if (quiet < TYPING_QUIET_MS) return waits('typing', TYPING_QUIET_MS - quiet + 100);
        if (!(await this.#runs(name))) return waits('asleep', RETRY_MS);
        if (!(await this.#type(name, WAKE).catch(() => false))) return waits('failed', RETRY_MS);
        this.#store.put({ ...this.#store.get(name), pending: false, woke: true, why: null, again: false, typedAt: new Date(this.#now()).toISOString() });
        return 'typed';
    }

    /* The owner asks to remind it: the line is typed again, now if it can be. */
    async remind(name) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        const told = await this.#wake(name, true);
        return { ...this.of(name), told };
    }

    async #tick() {
        for (const r of this.#store.all()) {
            if (r.on === true) this.#reapForgets(r);
            if (r.on === true && r.reread === true) { await this.#tryReread(r.name).catch(() => {}); continue; }
            if (r.on !== true || (!r.pending && !r.woke)) continue;
            /* It has read: what waited is done, and the next message wakes it again. */
            if (r.woke && !r.pending) { try { if (this.#parley(r.name).unread() === 0) this.#store.put({ ...r, woke: false }); } catch { /* its folder went */ } continue; }
            if (this.#now() < (this.#nextTry.get(r.name) ?? 0)) continue;
            await this.#wake(r.name, r.again === true).catch(() => {});
        }
    }

    /* The agent asked to forget short-lived secrets (parley forget -> forget.jsonl beside its thread): the
       parloir drops each from its vault and machine at once. Each request is acted on once, counted in the store. */
    #reapForgets(r) {
        if (!this.#dropSecret) return;
        let lines;
        try { lines = readFileSync(`${this.#dir(r.name)}/forget.jsonl`, 'utf8').split('\n').filter(Boolean); } catch { return; }
        const done = r.forgotten ?? 0;
        if (lines.length <= done) return;
        for (const line of lines.slice(done)) {
            try { const name = JSON.parse(line)?.name; if (typeof name === 'string' && /^SECRET_[0-9A-F]{10}$/.test(name)) void this.#dropSecret(r.name, name); } catch { /* a stray line */ }
        }
        this.#store.put({ ...r, forgotten: lines.length });
    }

    forget(name) { this.#deaf(name); if (this.#keep(name)) rmSync(this.#keep(name), { recursive: true, force: true }); this.#store.remove(name); this.#typedAt.delete(name); this.#ranAt.delete(name); this.#nextTry.delete(name); this.#nextTry.delete(`reread:${name}`); }
    stop() { clearInterval(this.#timer); for (const name of [...this.#listening.keys()]) this.#deaf(name); }
}
