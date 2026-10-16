/* TALK: a conversation with a tool, on a screen that is not its terminal.
 *
 * THIS IS A BRANCHING ON PARLEY (server/parley, a project of its own, copied
 * here unchanged). Parley gives the tool six verbs -- a command, `parley`,
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
 *                            in its terminal, once (it reads the whole thread).
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
import { randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { install, Parley, WAKE, REREAD, texts, fill, LANGUAGES, SHOWN_MAX, FILES_MAX } from './parley/host/parley-host.mjs';
import { importFile } from './files.mjs';
import { KEYS } from './parley/ui/parley-ui.js';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';
import { isConversationName } from './names.mjs';

export const FOLDER = '.parley';
const IN_MACHINE = `/work/${FOLDER}`;
const PANE = `=${SESSION}:`;
/* Nothing is typed in a terminal somebody typed in this recently. */
export const TYPING_QUIET_MS = 4000;
/* A line that waits is tried again this often (a machine that does not run is not touched: only its state is asked). */
export const RETRY_MS = 10_000;
/* Added to Parley's invitation, this server's own sentence: a branch can be
   checked out in one folder only, and /tmp is emptied when the machine
   restarts, with the work left there. Typed in a terminal: no quote, no
   backquote, nothing a shell would run. */
export const BRANCHES = 'Check out your branches in the main folder of the repository or under /work, never in /tmp: a branch can be checked out in one folder only, and /tmp is emptied when the machine restarts.';
/* After a restart, the tool is given this long to start before REREAD is typed. */
export const REREAD_AFTER_MS = 10_000;
/* Lines of the machine kept for one conversation, at most. */
export const SYSTEM_MAX = 50;
/* Where the person's files go, in the bridge folder; one folder per file, named by an id. */
const FILES = 'files';
const ATTACHED = new RegExp(`^/work/\\${FOLDER}/${FILES}/([0-9a-f-]{36})/([^/]+)$`);
/* An operator's own dictionary: so many words, so long each, at most. */
const OWN_MAX = 200;
const WORD_MAX = 500;
/* The words of the page and of the alerts. */
const WORDS = Object.freeze([...KEYS, 'alert-asks', 'alert-waits']);

export class Talk {
    #store; #words; #vms; #conversations; #resources; #toolbox; #warm; #alert; #listening = new Map(); #every; #now;
    #typedAt = new Map(); #nextTry = new Map(); #trying = new Map(); #timer; #lastLang = 'en'; #rereadAfter;

    /* `alert({ title, body, url })`: told when the tool asks, or waits.
       `words`: a store for the owner's choice of words (one record). */
    constructor({ store, words, vms, conversations, resources, toolbox = null, warm = async () => {}, alert = () => {}, listenEveryMs = 2000, now = () => Date.now(), rereadAfterMs = REREAD_AFTER_MS }) {
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

    #parley(name) {
        return new Parley(this.#dir(name), {
            reach: (path) => this.#reach(name, path),
            on: (event) => {
                if (event.type === 'person-wrote') { this.#want(name); return; }
                const words = texts(this.#lastLang, this.settings().own);
                if (event.type === 'agent-asked') this.#alert({ title: fill(words['alert-asks'], { name }), body: event.message.text ?? '', url: `/?c=${name}` });
                if (event.type === 'agent-status' && event.message.state === 'waiting') this.#alert({ title: fill(words['alert-waits'], { name }), body: event.message.text ?? '', url: `/?c=${name}` });
            },
        });
    }
    #listen(name) { if (!this.#listening.has(name)) { try { this.#listening.set(name, this.#parley(name).listen({ every: this.#every })); } catch { /* its folder is not there yet */ } } }
    #deaf(name) { this.#listening.get(name)?.(); this.#listening.delete(name); }

    of(name) {
        const c = this.#known(name);
        const possible = c.work === 'kept';
        const record = this.#store.get(name);
        const tools = Boolean(this.#toolbox?.find('parley'));
        if (record?.on !== true || !possible) return { on: false, possible, tools, messages: [], waiting: 0, status: null, steps: [], files: [], unread: 0 };
        const read = this.#parley(name).read();
        /* The machine's lines go among the messages, where they happened. */
        const lines = (record.system ?? []).map((l) => ({ from: 'system', kind: 'system', choices: [], ...l }));
        const messages = [...read.messages, ...lines].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-SHOWN_MAX);
        return { on: true, possible, tools, ...read, messages, wake: { waits: record.pending === true || record.reread === true, typed: record.typedAt ?? null, why: record.reread === true ? 'restarting' : record.why ?? null } };
    }

    /* For the list of conversations: does it wait for its owner? Cheap: two small files read. */
    brief(name) {
        const r = this.#store.get(name);
        if (r?.on !== true) return null;
        /* On, but unreadable just now: still said to be on (the share sheet offers its chat by that). */
        try { const now = this.#parley(name).read(); return { waiting: now.waiting, state: now.status?.state ?? null }; } catch { return { waiting: 0, state: null }; }
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

    async #type(name, line) {
        await this.#warm(name);
        const tmux = ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE];
        if ((await this.#vms.exec(name, [...tmux, '-l', '--', line], { timeoutMs: 30_000 })).code !== 0) return false;
        return (await this.#vms.exec(name, [...tmux, 'Enter'], { timeoutMs: 30_000 })).code === 0;
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

    async say(name, text, answers, files) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        const given = files === undefined || files === null ? [] : files;
        if (!Array.isArray(given) || given.length > FILES_MAX) throw new Refusal(400, `A message has ${FILES_MAX} files at most.`);
        /* Only files put here by `attach`: their paths are this server's, and each is there. */
        const attached = given.map((path) => {
            const m = typeof path === 'string' ? ATTACHED.exec(path) : null;
            const file = m ? join(this.#dir(name), FILES, m[1], m[2]) : undefined;
            const info = file ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
            if (!info?.isFile()) throw new Refusal(400, 'A file of this message was not attached here first.');
            return { path, name: m[2], size: info.size };
        });
        try { this.#parley(name).say(text ?? '', answers, attached); } catch (error) { if (error instanceof RangeError) throw new Refusal(400, error.message); throw error; }
        const told = await this.#wake(name);
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
       this chat: shown by the tool, or attached by the person. */
    shown(name, reference) {
        if (!this.of(name).on || typeof reference !== 'string' || !reference) return false;
        return this.#parley(name).read().messages.some((m) => m.open === reference || (m.files ?? []).some((f) => f.open === reference));
    }

    /* ---- lines of the machine ---- */
    #line(name, line) {
        const r = this.#store.get(name);
        if (r?.on !== true) return;
        this.#store.put({ ...r, system: [...(r.system ?? []), { id: randomUUID(), at: new Date(this.#now()).toISOString(), ...line }].slice(-SYSTEM_MAX) });
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
        this.#line(name, {
            text: fresh.map((p) => p.text).join(' '),
            level: fresh.some((p) => p.level === 'bad') ? 'bad' : 'warn',
            /* What can be done: more memory where memory is short, a restart, its terminal. */
            actions: [...(fresh.some((p) => p.kind === 'memory') ? ['memory'] : []), 'restart', 'terminal'],
        });
    }

    /* Its machine was restarted, or built again (conversations.mjs): said in
       the thread, and, the tool having started again with nothing of the
       chat in mind, REREAD is typed once it had time to start. */
    renewed(name, text, started = true) {
        const r = this.#store.get(name);
        if (r?.on !== true) return;
        if (text) this.#line(name, { text, level: started ? 'info' : 'bad', actions: started ? [] : ['restart', 'terminal'] });
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
        if (!this.#conversations.awake().includes(name)) return later(RETRY_MS);
        const quiet = this.#now() - (this.#typedAt.get(name) ?? 0);
        if (quiet < TYPING_QUIET_MS) return later(TYPING_QUIET_MS - quiet + 100);
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') return later(RETRY_MS);
        if (!(await this.#type(name, REREAD).catch(() => false))) return later(RETRY_MS);
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
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') return waits('asleep', RETRY_MS);
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
            if (r.on === true && r.reread === true) { await this.#tryReread(r.name).catch(() => {}); continue; }
            if (r.on !== true || (!r.pending && !r.woke)) continue;
            /* It has read: what waited is done, and the next message wakes it again. */
            if (r.woke && !r.pending) { try { if (this.#parley(r.name).unread() === 0) this.#store.put({ ...r, woke: false }); } catch { /* its folder went */ } continue; }
            if (this.#now() < (this.#nextTry.get(r.name) ?? 0)) continue;
            await this.#wake(r.name, r.again === true).catch(() => {});
        }
    }

    forget(name) { this.#deaf(name); this.#store.remove(name); this.#typedAt.delete(name); this.#nextTry.delete(name); this.#nextTry.delete(`reread:${name}`); }
    stop() { clearInterval(this.#timer); for (const name of [...this.#listening.keys()]) this.#deaf(name); }
}
