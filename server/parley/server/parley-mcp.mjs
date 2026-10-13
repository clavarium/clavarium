#!/usr/bin/env node
/* A BRIDGE BETWEEN A COMMAND-LINE AGENT AND AN APPLICATION WITH A SCREEN OF
 * ITS OWN. One file, no dependency, meant to be lifted out as it is.
 *
 * A command-line agent lives in a terminal: whoever does not read a terminal
 * cannot talk with it. But nearly all of them can be given MCP servers. This
 * is one: five tools through which the agent TELLS the person it works for
 * something, ASKS something, SHOWS a file, READS what was written back, and
 * says its STATUS. The application shows that as a conversation, on any
 * screen.
 *
 * NOTHING HERE WAITS. A tool never blocks until a person answers: the agent
 * posts, and goes on or stops. When the person has answered, the application
 * tells the agent, in its terminal, in one line: "a message arrived". The
 * agent then calls read. So an answer may come two minutes or two days
 * later.
 *
 * HOW IT REACHES THE APPLICATION: through two files in one folder, which the
 * application reads and writes from its side. No address, no port, no key.
 *   from-agent.jsonl  what the agent posted, one JSON object per line
 *   to-agent.jsonl    what was written to the agent, one JSON object per line
 *   read.json         how far the agent has read
 *
 * It speaks MCP over standard input and output: JSON-RPC 2.0, one message
 * per line.   node parley-mcp.mjs [--dir FOLDER]     (default: beside this file)
 *
 * FIVE VERBS, and no more: tell, ask, show, read, status.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const at = process.argv.indexOf('--dir');
const DIR = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'from-agent.jsonl');
const IN = join(DIR, 'to-agent.jsonl');
const READ = join(DIR, 'read.json');
const TEXT_MAX = 4000;
const CHOICES_MAX = 8;
const STATES = ['working', 'waiting', 'done'];
mkdirSync(DIR, { recursive: true });

const plain = (value, max = TEXT_MAX) => String(value ?? '').slice(0, max);
const post = (entry) => { const id = randomUUID(); appendFileSync(OUT, `${JSON.stringify({ id, at: new Date().toISOString(), ...entry })}\n`); return id; };

const TOOLS = [
    { name: 'tell', description: 'Tell the person you work for something: where you are, what you did, what you found. They read it on their own screen, not in this terminal. It does not wait for an answer.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to tell them, in plain words.' } }, required: ['text'] } },
    { name: 'ask', description: 'Ask the person you work for a question, instead of asking it in the terminal. It does NOT wait: it posts the question and returns at once. Stop or go on with something else; you will be told in the terminal when a message arrives, then call read.',
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional: the answers they can pick from.' } }, required: ['question'] } },
    { name: 'show', description: 'Point the person you work for to a file you made (a report, a picture, a page), so that they can open it from their screen.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The path of the file.' }, note: { type: 'string', description: 'One line on what it is.' } }, required: ['path'] } },
    { name: 'read', description: 'Read what was written to you since you last read: new instructions, and answers to your questions. Call it when you are told a message arrived, and before you finish a task.',
        inputSchema: { type: 'object', properties: {} } },
    { name: 'status', description: 'Say in one word where you are, so that their screen shows it: "working" when you start, "waiting" when you need them, "done" when the task is finished.',
        inputSchema: { type: 'object', properties: { state: { type: 'string', enum: STATES }, note: { type: 'string', description: 'Optional: one short line.' } }, required: ['state'] } },
];

function readMessages() {
    let lines = [];
    try { lines = readFileSync(IN, 'utf8').split('\n').filter(Boolean); } catch { /* nothing was written yet */ }
    let seen = 0;
    try { seen = Number(JSON.parse(readFileSync(READ, 'utf8')).lines) || 0; } catch { /* nothing was read yet */ }
    if (seen > lines.length) seen = 0;
    const fresh = lines.slice(seen).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    writeFileSync(READ, JSON.stringify({ lines: lines.length }));
    if (fresh.length === 0) return 'No new message.';
    return fresh.map((m) => `${m.answers ? `Answer to your question "${plain(m.question, 200)}": ` : 'Message: '}${plain(m.text)}`).join('\n');
}

function call(name, args = {}) {
    if (name === 'tell') { if (!plain(args.text).trim()) throw new Error('text is empty'); post({ kind: 'say', text: plain(args.text) }); return 'Posted. They will read it on their screen.'; }
    if (name === 'ask') {
        if (!plain(args.question).trim()) throw new Error('question is empty');
        const choices = Array.isArray(args.choices) ? args.choices.slice(0, CHOICES_MAX).map((c) => plain(c, 200)).filter(Boolean) : [];
        post({ kind: 'ask', text: plain(args.question), choices });
        return 'Posted. Do not wait here: you will be told in the terminal when a message arrives; then call read.';
    }
    if (name === 'show') { if (!plain(args.path).trim()) throw new Error('path is empty'); post({ kind: 'show', path: plain(args.path, 1000), text: plain(args.note, 500) }); return 'Posted. They can open it from their screen.'; }
    if (name === 'read') return readMessages();
    if (name === 'status') {
        if (!STATES.includes(args.state)) throw new Error(`state must be one of: ${STATES.join(', ')}`);
        post({ kind: 'status', state: args.state, text: plain(args.note, 300) });
        return 'Noted.';
    }
    throw new Error(`unknown tool: ${name}`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || m.id === undefined) return;         /* a notification: nothing to answer */
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'parley', version: '0.1.0' } });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
        try { return ok({ content: [{ type: 'text', text: call(m.params?.name, m.params?.arguments ?? {}) }] }); }
        catch (error) { return ok({ content: [{ type: 'text', text: `Not done: ${error.message}` }], isError: true }); }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
