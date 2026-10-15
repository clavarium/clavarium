/* TALK: a conversation with a tool, on a screen that is not its terminal.
 *
 * THIS IS A BRANCHING ON PARLEY (server/parley, a project of its own, copied
 * here unchanged). Parley gives the tool six verbs -- a command, `parley`,
 * which the tool installs by itself from /tools (see toolbox.mjs) -- and
 * gives this server the other side. PARLEY ANNOUNCES, THIS SERVER DECIDES:
 *
 *   WHERE THE BRIDGE LIVES   in the conversation's own work folder, kept by
 *                            this server: /work/.parley in its machine. No
 *                            address, no port, nothing new in the machine.
 *   THE INVITATION           typed once in its terminal when the owner asks:
 *                            install the command from /tools, use it, write
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
 * Off by default, per conversation. Like the answerer, it is a place where
 * this server reads what a tool wrote: only where the owner turned it on.
 * What the tool prints in its terminal is never read. And it works as far as
 * the tool agrees to use it.
 */
import { posix } from 'node:path';
import { install, Parley, WAKE, texts, fill, LANGUAGES } from './parley/host/parley-host.mjs';
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
/* An operator's own dictionary: so many words, so long each, at most. */
const OWN_MAX = 200;
const WORD_MAX = 500;
/* The words of the page and of the alerts. */
const WORDS = Object.freeze([...KEYS, 'alert-asks', 'alert-waits']);

export class Talk {
    #store; #words; #vms; #conversations; #resources; #toolbox; #warm; #alert; #listening = new Map(); #every; #now;
    #typedAt = new Map(); #nextTry = new Map(); #trying = new Map(); #timer; #lastLang = 'en';

    /* `alert({ title, body, url })`: told when the tool asks, or waits.
       `words`: a store for the owner's choice of words (one record). */
    constructor({ store, words, vms, conversations, resources, toolbox = null, warm = async () => {}, alert = () => {}, listenEveryMs = 2000, now = () => Date.now() }) {
        this.#store = store; this.#words = words; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#toolbox = toolbox; this.#warm = warm; this.#alert = alert; this.#every = listenEveryMs; this.#now = now;
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
            if (!inner || inner === FOLDER || inner.startsWith(`${FOLDER}/`)) return null;
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
        return { on: true, possible, tools, ...this.#parley(name).read(), wake: { waits: record.pending === true, typed: record.typedAt ?? null, why: record.why ?? null } };
    }

    /* For the list of conversations: does it wait for its owner? Cheap: two small files read. */
    brief(name) {
        const r = this.#store.get(name);
        if (r?.on !== true) return null;
        try { const now = this.#parley(name).read(); return { waiting: now.waiting, state: now.status?.state ?? null }; } catch { return null; }
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

    /* The tool is asked, in its terminal, to install the command and use it,
       writing to the person in `lang`. Typed once, when the owner asks. */
    async invite(name, lang) {
        const c = this.#known(name);
        if (!this.of(name).on) throw new Refusal(409, 'Turn it on first.');
        const tool = this.#toolbox?.find('parley');
        if (!tool) throw new Refusal(503, 'The tools folder is not in place on this server yet: try again in a moment, or restart the server.');
        if (!this.#conversations.awake().includes(name)) throw new Refusal(409, 'It is asleep: open it first.');
        const text = `${this.#parley(name).invite(lang, { install: `npm install -g ${tool.path}`, shared: c.work === 'kept' ? '/work' : undefined })} ${BRANCHES}`;
        if (!(await this.#type(name, text).catch(() => false))) throw new Refusal(502, 'The invitation could not be typed: is its tool running?');
        return { ...this.of(name), invited: text };
    }

    async say(name, text, answers) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        try { this.#parley(name).say(text, answers); } catch (error) { if (error instanceof RangeError) throw new Refusal(400, error.message); throw error; }
        const told = await this.#wake(name);
        return { ...this.of(name), told };
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
            if (r.on !== true || (!r.pending && !r.woke)) continue;
            /* It has read: what waited is done, and the next message wakes it again. */
            if (r.woke && !r.pending) { try { if (this.#parley(r.name).unread() === 0) this.#store.put({ ...r, woke: false }); } catch { /* its folder went */ } continue; }
            if (this.#now() < (this.#nextTry.get(r.name) ?? 0)) continue;
            await this.#wake(r.name, r.again === true).catch(() => {});
        }
    }

    forget(name) { this.#deaf(name); this.#store.remove(name); this.#typedAt.delete(name); this.#nextTry.delete(name); }
    stop() { clearInterval(this.#timer); for (const name of [...this.#listening.keys()]) this.#deaf(name); }
}
