/* THE OTHER SIDE OF THE BRIDGE: for the application that shows the exchange.
 *
 * The agent's side is server/parley-mcp.mjs (the `parley` command and the
 * MCP server). This is what an application uses to read what the agent
 * posted and to write what the person says. It knows nothing of screens
 * (see ui/), nothing of how an agent is reached, nor of how a person is
 * alerted.
 *
 * PARLEY ANNOUNCES, THE APPLICATION DECIDES.
 *
 *   events, to `on(event)`          actions, called by the application
 *   person-wrote  {message, unread} say(text, answers, files)
 *   agent-said    {message}         read()
 *   agent-asked   {message}         invite(lang, options)  -> a text
 *   agent-showed  {message}
 *   agent-status  {message}
 *   agent-doing   {message}
 *
 * Nothing is typed anywhere from here: when the person wrote, the
 * application is told so, with how many messages the agent has not read,
 * and decides whether, when and how to tell the agent (WAKE is the line it
 * may use). The invitation is a text it may use, or replace.
 *
 * WHAT IS READ HERE WAS WRITTEN BY AN AGENT: text chosen by a program. It is
 * bounded, cleaned of what a screen obeys rather than shows, and handed over
 * as text. Showing it as text, never building it, is the application's part.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TEXT_MAX = 4000;
export const SHOWN_MAX = 200;
export const LISTED_MAX = 50;
/* Steps (what it said it was doing, and its states) kept for the screen. */
export const STEPS_MAX = 500;
export const FILE_MAX = 2 * 1024 * 1024;
export const STATES = ['working', 'waiting', 'done'];
/* Files the person attaches to one message, at most. */
export const FILES_MAX = 10;
const KINDS = ['say', 'ask', 'show', 'status', 'doing'];
const STEP = new Set(['status', 'doing']);
const SERVER = fileURLToPath(new URL('../server/parley-mcp.mjs', import.meta.url));
const TEXTS = fileURLToPath(new URL('../ui/texts/', import.meta.url));

/* THE TEXTS AN AGENT READS are English: models read it best, and one text is
   one text to check. The person's language is said in it. They are typed in
   a terminal, where a shell may be listening instead of an agent: no
   backquote, no single quote, nothing a shell would run or wait on. */
export const WAKE = 'You have a new message: run "parley read".';
/* What an application may type after the agent lost its memory (its machine
   restarted, a new session): the exchange is still there to be read whole. */
export const REREAD = 'Your chat with the person is kept: run "parley read --all" before going on.';
const NAMES = { en: 'English', fr: 'French' };
/* The name of a language, in English, for a sentence an agent reads. */
export function languageName(lang) {
    const tag = String(lang ?? '').trim();
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(tag)) return 'English';
    const base = tag.split('-')[0].toLowerCase();
    if (NAMES[base]) return NAMES[base];
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(base) ?? 'English'; } catch { return 'English'; }
}
/* What an agent is asked once, to use Parley. `install`: how it gets the
   command, when the application has not installed it itself (a command
   line of the application's: it is put in double quotes as it is); without
   it, the agent is told Parley is installed. `shared`: the folder
   whose files the person can open. */
export function invitation({ lang = 'en', install, shared } = {}) {
    return [
        install ? `Install Parley, a small command to talk with the person you work for on their screen: run "${install}", then read "parley --help".` : 'Parley is installed: run "parley --help". It is how you talk with the person you work for, on their screen.',
        'From now on, talk with them through it, not in this terminal: "parley tell" to tell them something, "parley ask" to ask them something (with the choices when you can), "parley show" for a file you made, "parley doing" in one short line each time you start something new, "parley status" to say where you are.',
        shared ? `Put any file you show under ${shared}: it is the folder they can open.` : '',
        `Write to them in ${languageName(lang)}.`,
        'When you see "You have a new message", run "parley read".',
        'Start now: tell them in one line that you are ready.',
    ].filter(Boolean).join(' ');
}

/* THE WORDS A PERSON READS: one dictionary per language (ui/texts/<lang>.json);
   a word missing there is the English one; `own`, a dictionary of the
   application's or its operator's, whole or partial, replaces any word,
   whatever it says. They are always shown as text, never as markup. */
const dictionary = (lang) => { try { const d = JSON.parse(readFileSync(`${TEXTS}${lang}.json`, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
export const LANGUAGES = Object.freeze(readdirSync(TEXTS).filter((f) => /^[a-z]{2,3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort());
export function texts(lang, own) {
    const base = String(lang ?? '').toLowerCase().split('-')[0];
    const words = { ...dictionary('en'), ...(LANGUAGES.includes(base) && base !== 'en' ? dictionary(base) : {}) };
    if (own && typeof own === 'object' && !Array.isArray(own)) {
        for (const [key, value] of Object.entries(own)) if (Object.hasOwn(words, key) && typeof value === 'string') words[key] = value.slice(0, 500);
    }
    return { ...words, lang: LANGUAGES.includes(base) ? base : 'en' };
}
/* A word with its {places} filled, as text. */
export const fill = (word, values = {}) => String(word ?? '').replace(/\{([a-z]+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));

// eslint-disable-next-line no-control-regex
const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const clean = (text, max = TEXT_MAX) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').slice(0, max);
const oneLine = (text, max) => clean(text, max).replace(/\s+/g, ' ').trim();
const parsed = (line) => { try { const j = JSON.parse(line); return j && typeof j === 'object' && !Array.isArray(j) ? j : undefined; } catch { return undefined; } };

/* The lines of a file that only grows: the last part of it, never a link,
   never more than is wanted, and a line that is not an object is skipped. */
function lines(file) {
    try {
        if (lstatSync(file).isSymbolicLink() || statSync(file).size > 16 * FILE_MAX) return [];
        const text = readFileSync(file, 'utf8');
        return (text.length > FILE_MAX ? text.slice(-FILE_MAX) : text).split('\n').filter(Boolean).map(parsed).filter(Boolean);
    } catch { return []; }
}
/* How many whole lines the agent has read, as it wrote it. */
function readCount(dir) { try { return Math.max(0, Number(JSON.parse(readFileSync(`${dir}/read.json`, 'utf8')).lines) || 0); } catch { return 0; } }
function lineCount(file) { try { if (lstatSync(file).isSymbolicLink()) return 0; return readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }

/* Puts the bridge in `dir`: the two files, and the MCP server for an agent
   that is given it that way. Resolves with how that server is declared to an
   agent. `as`: where that folder is seen FROM THE AGENT, when that is not
   the same path (a mounted folder). */
export function install(dir, { as = dir } = {}) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(SERVER, `${dir}/server.mjs`);
    for (const file of ['from-agent.jsonl', 'to-agent.jsonl']) if (!existsSync(`${dir}/${file}`)) writeFileSync(`${dir}/${file}`, '');
    return { name: 'parley', command: ['node', `${as}/server.mjs`] };
}

export class Parley {
    #dir; #on; #reach; #now;

    /* `on(event)`: told what happens (see the top of this file).
       `reach(path)`: how the person opens a file the agent showed -- a
       reference of the application's (a link, a path) or null when it
       cannot be opened from their screen. Every path, by default. */
    constructor(dir, { on, reach = (path) => path, now = () => new Date() } = {}) { this.#dir = dir; this.#on = on; this.#reach = reach; this.#now = now; }

    #tell(event) { try { this.#on?.(event); } catch { /* a hook that fails stops nothing */ } }

    /* One line the agent wrote, as it is handed over. */
    #fromAgent(m) {
        const kind = KINDS.includes(m.kind) ? m.kind : 'say';
        const entry = { from: 'agent', id: String(m.id ?? ''), at: String(m.at ?? ''), kind, text: clean(m.text), choices: kind === 'ask' && Array.isArray(m.choices) ? m.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [] };
        if (kind === 'show') {
            entry.path = oneLine(m.path, 1000);
            let open = null;
            try { const r = this.#reach(entry.path); open = typeof r === 'string' && r ? r : null; } catch { open = null; }
            entry.open = open;
        }
        if (kind === 'status') entry.state = STATES.includes(m.state) ? m.state : 'working';
        if (kind === 'doing') { entry.text = oneLine(m.text, 200); entry.state = 'working'; }
        return entry;
    }

    /* The files of a message of the person, as handed over: each opened by
       the application's own way (`reach`), like a file the agent showed. */
    #files(list) {
        return list.slice(0, FILES_MAX).filter((f) => f && typeof f === 'object').map((f) => {
            const path = oneLine(f.path, 1000);
            let open = null;
            try { const r = this.#reach(path); open = typeof r === 'string' && r ? r : null; } catch { open = null; }
            return { path, name: oneLine(f.name, 200) || path.split('/').pop(), size: Number.isInteger(f.size) && f.size >= 0 ? f.size : null, open };
        });
    }

    /* How many messages of the person the agent has not read. */
    unread() { return Math.max(0, lineCount(`${this.#dir}/to-agent.jsonl`) - readCount(this.#dir)); }

    /* Both sides, in the order they were written; how many questions wait;
       where the agent says it is; its steps -- every state it said and every
       line of what it was doing, in order, for the screen to put between the
       messages; the files it showed; how many of the person's messages it has
       not read (each says `seen`). Saying what it does means it works: a
       `doing` after "done" or "waiting" makes the status "working" again. */
    read() {
        const agent = lines(`${this.#dir}/from-agent.jsonl`).map((m) => this.#fromAgent(m));
        const unread = this.unread();
        const written = lines(`${this.#dir}/to-agent.jsonl`);
        const person = written.map((m, i) => ({ from: 'person', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: 'say', text: clean(m.text), choices: [], seen: i < written.length - unread, ...(m.answers ? { answers: String(m.answers) } : {}), ...(Array.isArray(m.files) && m.files.length ? { files: this.#files(m.files) } : {}) }));
        const answered = new Set(person.map((m) => m.answers).filter(Boolean));
        const messages = [...agent.filter((m) => !STEP.has(m.kind)), ...person].sort((a, b) => a.at.localeCompare(b.at)).slice(-SHOWN_MAX);
        /* Steps older than the first message kept would sit before a conversation that is no longer there. */
        const since = messages.length === SHOWN_MAX ? messages[0].at : '';
        const steps = agent.filter((m) => STEP.has(m.kind));
        const last = steps.filter((m) => m.kind === 'status').at(-1);
        const after = steps.at(-1)?.kind === 'doing' && last?.state !== 'working';
        return {
            messages,
            waiting: agent.filter((m) => m.kind === 'ask' && !answered.has(m.id)).length,
            status: after ? { state: 'working', note: '', at: steps.at(-1).at } : last ? { state: last.state, note: last.text, at: last.at } : null,
            steps: steps.filter((m) => m.at >= since).sort((a, b) => a.at.localeCompare(b.at)).slice(-STEPS_MAX).map((m) => ({ id: m.id, kind: m.kind, state: m.state, note: m.text, at: m.at })),
            files: agent.filter((m) => m.kind === 'show').slice(-LISTED_MAX).map((m) => ({ path: m.path, note: m.text, at: m.at, open: m.open })),
            unread,
        };
    }

    /* The person writes. `answers`: the id of the question this answers.
       `files`: what they attached, put where the agent can open them by the
       application ({ path, name?, size? }: `path` as the agent sees it); a
       message may be files alone. The application is told (person-wrote),
       and decides how to tell the agent. */
    say(text, answers, files = []) {
        const said = clean(text).trim();
        const given = Array.isArray(files) ? files : [];
        if (given.length > FILES_MAX) throw new RangeError(`${FILES_MAX} files at most in one message.`);
        const attached = given.map((f) => ({ path: oneLine(f?.path, 1000), name: oneLine(f?.name, 200), size: Number.isInteger(f?.size) && f.size >= 0 ? f.size : undefined }));
        if (attached.some((f) => !f.path.startsWith('/'))) throw new RangeError('A file is given by its whole path.');
        if (!said && attached.length === 0) throw new RangeError('Write something.');
        const entry = { id: randomUUID(), at: this.#now().toISOString(), text: said };
        if (attached.length) entry.files = attached.map((f) => ({ path: f.path, name: f.name || f.path.split('/').pop(), ...(f.size === undefined ? {} : { size: f.size }) }));
        if (typeof answers === 'string' && answers) {
            const asked = this.read().messages.find((m) => m.from === 'agent' && m.kind === 'ask' && m.id === answers);
            if (asked) { entry.answers = asked.id; entry.question = oneLine(asked.text, 300); }
        }
        mkdirSync(this.#dir, { recursive: true });
        appendFileSync(`${this.#dir}/to-agent.jsonl`, `${JSON.stringify(entry)}\n`);
        const now = this.read();
        this.#tell({ type: 'person-wrote', message: now.messages.find((m) => m.id === entry.id) ?? { from: 'person', ...entry }, unread: now.unread });
        return now;
    }

    /* The text that asks an agent to use Parley: English, in the person's
       language `lang`. The application types it, changes it, or does not. */
    invite(lang, options = {}) { return invitation({ ...options, lang }); }

    /* Starts announcing each thing the agent posts FROM NOW ON: agent-said,
       agent-asked, agent-showed, agent-status, agent-doing. Resolves with a function that
       stops it. The file is looked at, nothing is pushed: what was posted
       while nobody listened is still in `read()`. Each line is announced
       once, by where it sits in the file, and only once it is whole. */
    listen({ every = 2000 } = {}) {
        const file = `${this.#dir}/from-agent.jsonl`;
        const size = () => { try { return lstatSync(file).isSymbolicLink() ? 0 : statSync(file).size; } catch { return 0; } };
        let offset = size();
        let rest = Buffer.alloc(0);
        const TYPES = { say: 'agent-said', ask: 'agent-asked', show: 'agent-showed', status: 'agent-status', doing: 'agent-doing' };
        const look = () => {
            const now = size();
            if (now < offset) { offset = 0; rest = Buffer.alloc(0); }        /* the file was started again */
            if (now === offset) return;
            let from = offset;
            if (now - from > FILE_MAX) { from = now - FILE_MAX; rest = Buffer.alloc(0); }
            const chunk = Buffer.alloc(now - from);
            let fd;
            try { fd = openSync(file, 'r'); readSync(fd, chunk, 0, chunk.length, from); } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
            offset = now;
            const all = Buffer.concat([rest, chunk]);
            const end = all.lastIndexOf(0x0a);
            if (end < 0) { rest = all; return; }
            rest = all.subarray(end + 1);
            for (const line of all.subarray(0, end).toString('utf8').split('\n')) {
                const m = line ? parsed(line) : undefined;
                if (!m) continue;
                const message = this.#fromAgent(m);
                this.#tell({ type: TYPES[message.kind], message });
            }
        };
        const timer = setInterval(look, every);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
