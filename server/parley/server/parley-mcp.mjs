#!/usr/bin/env node
/* A BRIDGE BETWEEN A COMMAND-LINE AGENT AND AN APPLICATION WITH A SCREEN OF
 * ITS OWN. One file, no dependency, meant to be lifted out as it is.
 *
 * A command-line agent lives in a terminal: whoever does not read a terminal
 * cannot talk with it. This file gives the agent five verbs -- TELL the
 * person it works for something, ASK something, SHOW a file, READ what was
 * written back, say its STATUS -- in two ways that write the same files:
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

export const VERSION = '0.2.0';
export const TEXT_MAX = 4000;
export const CHOICES_MAX = 8;
export const STATES = ['working', 'waiting', 'done'];
export const FOLDER = '.parley';

const plain = (value, max = TEXT_MAX) => String(value ?? '').slice(0, max);
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

/* The five verbs on one folder. `how` is what the agent is told to do when a
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
        tell(text) {
            if (!plain(text).trim()) throw new Error('the text is empty');
            post({ kind: 'say', text: plain(text) });
            return 'Posted. They will read it on their screen.';
        },
        ask(question, choices) {
            if (!plain(question).trim()) throw new Error('the question is empty');
            const picked = Array.isArray(choices) ? choices.slice(0, CHOICES_MAX).map((c) => plain(c, 200).trim()).filter(Boolean) : [];
            post({ kind: 'ask', text: plain(question), choices: picked });
            return `Posted. Do not wait here: you will be told in the terminal when they answer; then ${how}.`;
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
        read() {
            let lines = [];
            try { lines = readFileSync(IN, 'utf8').split('\n').filter(Boolean); } catch { /* nothing was written yet */ }
            let seen = 0;
            try { seen = Number(JSON.parse(readFileSync(READ, 'utf8')).lines) || 0; } catch { /* nothing was read yet */ }
            if (seen > lines.length) seen = 0;
            const fresh = lines.slice(seen).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
            mkdirSync(dir, { recursive: true });
            writeFileSync(READ, JSON.stringify({ lines: lines.length }));
            if (fresh.length === 0) return 'No new message.';
            return fresh.map((m) => `${m.answers ? `Answer to your question "${plain(m.question, 200)}": ` : 'Message: '}${plain(m.text)}`).join('\n');
        },
    };
}

/* ---- MCP ---- */
export const TOOLS = [
    { name: 'tell', description: 'Tell the person you work for something: where you are, what you did, what you found. They read it on their own screen, not in this terminal. It does not wait for an answer.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to tell them, in plain words.' } }, required: ['text'] } },
    { name: 'ask', description: 'Ask the person you work for a question, instead of asking it in the terminal. It does NOT wait: it posts the question and returns at once. Stop or go on with something else; you will be told in the terminal when a message arrives, then call read.',
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional: the answers they can pick from.' } }, required: ['question'] } },
    { name: 'show', description: 'Point the person you work for to a file you made (a report, a picture, a page), so that they can open it from their screen. Put it in a folder you share with them.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The path of the file.' }, note: { type: 'string', description: 'One line on what it is.' } }, required: ['path'] } },
    { name: 'read', description: 'Read what was written to you since you last read: new instructions, and answers to your questions. Call it when you are told a message arrived, and before you finish a task.',
        inputSchema: { type: 'object', properties: {} } },
    { name: 'status', description: 'Say in one word where you are, so that their screen shows it: "working" when you start, "waiting" when you need them, "done" when the task is finished.',
        inputSchema: { type: 'object', properties: { state: { type: 'string', enum: STATES }, note: { type: 'string', description: 'Optional: one short line.' } }, required: ['state'] } },
];

export function serve(dir, { input = process.stdin, output = process.stdout } = {}) {
    const verbs = bridge(dir, { how: 'call read' });
    const call = (name, args = {}) => {
        if (name === 'tell') return verbs.tell(args.text);
        if (name === 'ask') return verbs.ask(args.question, args.choices);
        if (name === 'show') return verbs.show(args.path, args.note);
        if (name === 'read') return verbs.read();
        if (name === 'status') return verbs.status(args.state, args.note);
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
