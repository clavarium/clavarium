#!/usr/bin/env node
/* A BRIDGE BETWEEN A COMMAND-LINE AGENT AND AN APPLICATION WITH A SCREEN OF
 * ITS OWN. One file, no dependency, meant to be lifted out as it is.
 *
 * A command-line agent lives in a terminal: whoever does not read a terminal
 * cannot talk with it. This file gives the agent seven verbs -- TELL the
 * person it works for something, ASK something, SHOW a file, READ what was
 * written back, CLOSE a question answered another way, say its STATUS, say
 * what it is DOING now -- in two ways that
 * write the same files:
 *
 *   a command    `parley tell "..."` (bin/parley.mjs imports this file):
 *                any agent that can run a command can use it;
 *   MCP          `node parley-mcp.mjs [--dir FOLDER]`: for an agent that
 *                was given it as an MCP server, over standard input and
 *                output (JSON-RPC 2.0, one message per line).
 *
 * NOTHING HERE WAITS. A verb never blocks until a person answers: the agent
 * posts, and goes on or stops. When the person has written, the application
 * tells the agent, in one line of its own choosing, that a message arrived;
 * the agent then reads. So an answer may come two minutes or two days later.
 *
 * HOW IT REACHES THE APPLICATION: through two files in one folder, which the
 * application reads and writes from its side. No address, no port, no key.
 *   from-agent.jsonl  what the agent posted, one JSON object per line
 *   to-agent.jsonl    what was written to the agent, one JSON object per line
 *   read.json         how far the agent has read
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const VERSION = '0.7.0';
/* A message may be long: the screen folds it, and shows its short version first. */
export const TEXT_MAX = 16000;
/* Its short version: a title of one or two lines. */
export const SHORT_MAX = 200;
/* What it is doing now is one short line: a screen shows it while it works. */
export const DOING_MAX = 200;
export const CHOICES_MAX = 8;
export const STATES = ['working', 'waiting', 'done'];
export const FOLDER = '.parley';

const plain = (value, max = TEXT_MAX) => String(value ?? '').slice(0, max);
/* What `read --all` gives back at most: the newest entries, and so many characters. */
export const ALL_ENTRIES = 200;
export const ALL_CHARS = 100_000;
/* Each line of a file that only grows, as an object, or null where it is not one: counted, and skipped. */
const lines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } }); } catch { return []; } };
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
/* The files the person attached to a message, one line each: where they are, for the agent to open. */
const attached = (m) => (Array.isArray(m.files) ? m.files.slice(0, 10).map((f) => `\n  Attached file: ${plain(f?.path, 1000)}${Number.isInteger(f?.size) ? ` (${size(f.size)})` : ''}`).join('') : '');
/* The short version of a message, when given: one or two lines. */
const brief = (short) => { const line = plain(short, SHORT_MAX * 2).replace(/\s+/g, ' ').trim().slice(0, SHORT_MAX); return line ? { short: line } : {}; };
/* So many characters of a question's id are shown, and enough to close it. */
export const ID_SHOWN = 8;
/* How many reads are remembered, with their time: the screen says when each message was read. */
export const READS_KEPT = 200;
const isFolder = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/* WHICH FOLDER: the one given, else $PARLEY_DIR, else the nearest ".parley"
   from `from` up, as git finds its repository. Undefined when none is found. */
export function findFolder({ dir, env = process.env, from = process.cwd() } = {}) {
    if (dir) return resolve(from, dir);
    if (env.PARLEY_DIR) return resolve(from, env.PARLEY_DIR);
    for (let at = resolve(from); ; at = dirname(at)) {
        if (isFolder(join(at, FOLDER))) return join(at, FOLDER);
        if (dirname(at) === at) return undefined;
    }
}

/* The seven verbs on one folder. `how` is what the agent is told to do when a
   message arrives: run a command, or call a tool. */
export function bridge(dir, { how = 'run `parley read`' } = {}) {
    const OUT = join(dir, 'from-agent.jsonl');
    const IN = join(dir, 'to-agent.jsonl');
    const READ = join(dir, 'read.json');
    const post = (entry) => {
        mkdirSync(dir, { recursive: true });
        const id = randomUUID();
        appendFileSync(OUT, `${JSON.stringify({ id, at: new Date().toISOString(), ...entry })}\n`);
        return id;
    };
    return {
        tell(text, { short } = {}) {
            if (!plain(text).trim()) throw new Error('the text is empty');
            post({ kind: 'say', text: plain(text), ...brief(short) });
            return 'Posted. They will read it on their screen.';
        },
        ask(question, choices, { short } = {}) {
            if (!plain(question).trim()) throw new Error('the question is empty');
            const picked = Array.isArray(choices) ? choices.slice(0, CHOICES_MAX).map((c) => plain(c, 200).trim()).filter(Boolean) : [];
            post({ kind: 'ask', text: plain(question), choices: picked, ...brief(short) });
            return `Posted. Do not wait here: you will be told in the terminal when they answer; then ${how}.`;
        },
        /* A question they answered another way (a message typed later): closed
           by the agent, with the answer it understood. The screen says so; the
           person may still answer it with its buttons. `id`: the question's, or
           the first characters of it that `read` shows. */
        close(id, answer) {
            const given = plain(id, 100).trim().replace(/^\[|\]$/g, '');
            if (given.length < ID_SHOWN) throw new Error(`give the id of the question, as "read" shows it (${ID_SHOWN} characters at least)`);
            const said = plain(answer, 500).replace(/\s+/g, ' ').trim();
            if (!said) throw new Error('say the answer you understood');
            const found = lines(OUT).filter((m) => m && m.kind === 'ask' && typeof m.id === 'string' && m.id.startsWith(given));
            if (found.length === 0) throw new Error(`no question has the id ${given}`);
            if (found.length > 1) throw new Error(`several questions start with ${given}: give more of it`);
            post({ kind: 'close', answers: found[0].id, text: said });
            return 'Closed. Their screen shows the answer you understood; they may still correct it.';
        },
        /* A relative path is the agent's own, from where it stands: it is
           posted whole, so that the application knows which file it is. */
        show(path, note, { from = process.cwd() } = {}) {
            if (!plain(path).trim()) throw new Error('the path is empty');
            const whole = resolve(from, plain(path, 1000));
            if (!existsSync(whole)) throw new Error(`no such file: ${whole}`);
            post({ kind: 'show', path: whole, text: plain(note, 500) });
            return 'Posted. They can open it from their screen if it is in a folder they share with you.';
        },
        status(state, note) {
            if (!STATES.includes(state)) throw new Error(`the state is one of: ${STATES.join(', ')}`);
            post({ kind: 'status', state, text: plain(note, 300) });
            return 'Noted.';
        },
        /* One line, said each time it moves to something new: it is shown while
           it works, and goes when its next message comes; what came before stays
           one click away. */
        doing(text) {
            const line = plain(text).replace(/\s+/g, ' ').trim().slice(0, DOING_MAX);
            if (!line) throw new Error('the text is empty');
            post({ kind: 'doing', text: line });
            return 'Noted.';
        },
        /* What was written since the last read; `all`: the whole exchange,
           both sides, oldest first -- for an agent that lost its memory (a
           restart, a new session) and must pick up the thread. Either way,
           everything is read afterwards. */
        read({ all = false } = {}) {
            const written = lines(IN);
            let seen = 0;
            try { seen = Number(JSON.parse(readFileSync(READ, 'utf8')).lines) || 0; } catch { /* nothing was read yet */ }
            if (seen > written.length) seen = 0;
            let reads = [];
            try { const r = JSON.parse(readFileSync(READ, 'utf8')).reads; if (Array.isArray(r)) reads = r.filter((x) => x && Number.isInteger(x.lines) && typeof x.at === 'string'); } catch { /* none kept yet */ }
            if (written.length > seen) reads = [...reads, { lines: written.length, at: new Date().toISOString() }].slice(-READS_KEPT);
            mkdirSync(dir, { recursive: true });
            writeFileSync(READ, JSON.stringify({ lines: written.length, reads }));
            /* The questions still open: neither answered nor closed. */
            const answered = new Set(written.map((m) => m?.answers).filter(Boolean));
            const posted = lines(OUT).filter(Boolean);
            const closed = new Set(posted.filter((m) => m.kind === 'close').map((m) => m.answers));
            const open = posted.filter((m) => m.kind === 'ask' && typeof m.id === 'string' && !answered.has(m.id) && !closed.has(m.id));
            const pending = open.length === 0 ? '' : `\nOpen questions (one they answered another way: close it with parley close ID "the answer you understood"):${open.slice(-10).map((m) => `\n  [${m.id.slice(0, ID_SHOWN)}] ${plain(m.text, 200).replace(/\s+/g, ' ')}`).join('')}`;
            const fromThem = (m) => `${m.answers ? `They answered your question "${plain(m.question, 200)}": ` : 'They wrote: '}${plain(m.text)}${attached(m)}`;
            if (all) {
                const theirs = written.flatMap((m, i) => (m ? [{ at: String(m.at ?? ''), text: `${fromThem(m)}${i >= seen ? ' (new)' : ''}` }] : []));
                const mine = lines(OUT).filter((m) => m && ['say', 'ask', 'show', 'close'].includes(m.kind)).map((m) => ({ at: String(m.at ?? ''),
                    text: m.kind === 'close' ? `You closed a question, the answer you understood being: ${plain(m.text, 500)}` : m.kind === 'ask' ? `You asked them: ${plain(m.text)}${Array.isArray(m.choices) && m.choices.length ? ` (choices: ${m.choices.map((c) => plain(c, 200)).join(', ')})` : ''}`
                        : m.kind === 'show' ? `You showed them a file: ${plain(m.path, 1000)}${m.text ? ` (${plain(m.text, 500)})` : ''}` : `You told them: ${plain(m.text)}` }));
                const both = [...mine, ...theirs].sort((a, b) => a.at.localeCompare(b.at)).slice(-ALL_ENTRIES).map((e) => `[${e.at.slice(0, 16).replace('T', ' ')}] ${e.text}`);
                while (both.length > 1 && both.join('\n').length > ALL_CHARS) both.shift();
                if (both.length === 0) return `Nothing was written yet, on either side.${pending}`;
                return `The whole exchange with the person, oldest first (${both.length}):\n${both.join('\n')}\nEnd of the exchange: everything is read now.${pending}`;
            }
            const fresh = written.slice(seen).filter(Boolean);
            if (fresh.length === 0) return `No new message.${pending}`;
            return `${fresh.map((m) => `${m.answers ? `Answer to your question "${plain(m.question, 200)}": ` : 'Message: '}${plain(m.text)}${attached(m)}`).join('\n')}${pending}`;
        },
    };
}

/* ---- MCP ---- */
/* How an agent is asked to write, in every text it reads: the screen renders Markdown. */
export const WRITING = 'The chat renders Markdown: write as you do in your terminal -- short lists, a bold label per point, one idea per line, a heading or a short title when long, one key sentence in a "> [!IMPORTANT]" block (an action, a decision, a blocker). Tables, code blocks and mermaid diagrams are shown; ==text== is highlighted; [ok] [todo] [blocked] [warn] are small badges; a picture from a shared folder is shown where you put it, and pictures on one line side by side: ![before](/work/before.png) ![after](/work/after.png).';
export const SHORTER = 'For anything longer than a few lines, give a short version too (short): a title of one or two lines, shown first, the rest one tap away. Whatever asks them for an action or a decision, or says you are blocked, MUST be in the short version.';
export const TOOLS = [
    { name: 'tell', description: `Tell the person you work for something: where you are, what you did, what you found. They read it on their own screen, not in this terminal. It does not wait for an answer. ${WRITING} ${SHORTER}`,
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to tell them, in Markdown.' }, short: { type: 'string', description: 'Optional, for a long text: its title, one or two lines.' } }, required: ['text'] } },
    { name: 'ask', description: `Ask the person you work for a question, instead of asking it in the terminal. It does NOT wait: it posts the question and returns at once. Stop or go on with something else; you will be told in the terminal when a message arrives, then call read. A question they answered another way (a message typed later): close it with close. ${WRITING}`,
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional: the answers they can pick from.' }, short: { type: 'string', description: 'Optional, for a long question: its title, one or two lines.' } }, required: ['question'] } },
    { name: 'show', description: 'Point the person you work for to a file you made (a report, a picture, a page), so that they can open it from their screen. Put it in a folder you share with them.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The path of the file.' }, note: { type: 'string', description: 'One line on what it is.' } }, required: ['path'] } },
    { name: 'read', description: 'Read what was written to you since you last read: new instructions, answers to your questions, files they attached, and the questions still open with their ids. Call it when you are told a message arrived, and before you finish a task. With all: true, the whole exchange, both sides, oldest first: to pick up the thread after a restart.',
        inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Optional: the whole exchange, not only what is new.' } } } },
    { name: 'close', description: 'Close a question of yours that they answered another way (in a message typed later, not with its buttons), saying the answer you understood. Their screen shows it; they may still correct it. The id is the one read shows.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id of the question, as read shows it.' }, answer: { type: 'string', description: 'The answer you understood, in one line.' } }, required: ['id', 'answer'] } },
    { name: 'doing', description: 'Say in one short line what you are doing right now ("reading the 12 recordings", "running the tests"), each time you move to something new. Their screen shows it while you work, and keeps what came before. It does not wait.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'One short line, in their language.' } }, required: ['text'] } },
    { name: 'status', description: 'Say in one word where you are, so that their screen shows it: "working" when you start, "waiting" when you need them, "done" when the task is finished.',
        inputSchema: { type: 'object', properties: { state: { type: 'string', enum: STATES }, note: { type: 'string', description: 'Optional: one short line.' } }, required: ['state'] } },
];

export function serve(dir, { input = process.stdin, output = process.stdout } = {}) {
    const verbs = bridge(dir, { how: 'call read' });
    const call = (name, args = {}) => {
        if (name === 'tell') return verbs.tell(args.text, { short: args.short });
        if (name === 'ask') return verbs.ask(args.question, args.choices, { short: args.short });
        if (name === 'close') return verbs.close(args.id, args.answer);
        if (name === 'show') return verbs.show(args.path, args.note);
        if (name === 'read') return verbs.read({ all: args.all === true });
        if (name === 'status') return verbs.status(args.state, args.note);
        if (name === 'doing') return verbs.doing(args.text);
        throw new Error(`unknown tool: ${name}`);
    };
    const send = (message) => output.write(`${JSON.stringify(message)}\n`);
    createInterface({ input }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (!m || typeof m !== 'object' || m.id === undefined) return;         /* a notification: nothing to answer */
        const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'parley', version: VERSION } });
        if (m.method === 'ping') return ok({});
        if (m.method === 'tools/list') return ok({ tools: TOOLS });
        if (m.method === 'tools/call') {
            try { return ok({ content: [{ type: 'text', text: call(m.params?.name, m.params?.arguments ?? {}) }] }); }
            catch (error) { return ok({ content: [{ type: 'text', text: `Not done: ${error.message}` }], isError: true }); }
        }
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    });
}

/* Run as a program: the MCP server. Its folder is --dir, else $PARLEY_DIR,
   else the folder it was put in by an application (install(), next to the
   two files), else the nearest .parley from where it was started. */
const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const at = process.argv.indexOf('--dir');
    const given = at > 0 ? process.argv[at + 1] : undefined;
    const beside = existsSync(join(dirname(HERE), 'from-agent.jsonl')) ? dirname(HERE) : undefined;
    serve(findFolder({ dir: given ?? (process.env.PARLEY_DIR ? undefined : beside) }) ?? beside ?? dirname(HERE));
}
