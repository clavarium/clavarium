#!/usr/bin/env node
/* A BRIDGE BETWEEN A COMMAND-LINE AGENT AND AN APPLICATION WITH A SCREEN OF
 * ITS OWN. One file, no dependency, meant to be lifted out as it is.
 *
 * A command-line agent lives in a terminal: whoever does not read a terminal
 * cannot talk with it. But nearly all of them can be given MCP servers. This
 * is one: a few tools through which the agent TELLS its owner something, ASKS
 * something, SHOWS a file, and READS what its owner wrote back. The
 * application shows that as a conversation, on any screen.
 *
 * NOTHING HERE WAITS. A tool never blocks until a person answers: the agent
 * posts, and goes on or stops. When the owner has answered, the application
 * tells the agent, in its terminal, in one line: "a message arrived". The
 * agent then calls read_messages. So an answer may come two minutes or two
 * days later.
 *
 * HOW IT REACHES THE APPLICATION: through two files in one folder, which the
 * application reads and writes from its side. No address, no port, no key.
 *   to-owner.jsonl    what the agent posted, one JSON object per line
 *   to-agent.jsonl    what the owner wrote, one JSON object per line
 *   read.json         how far the agent has read
 *
 * It speaks MCP over standard input and output: JSON-RPC 2.0, one message
 * per line.   node owner-mcp.mjs [--dir FOLDER]     (default: beside this file)
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const at = process.argv.indexOf('--dir');
const DIR = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'to-owner.jsonl');
const IN = join(DIR, 'to-agent.jsonl');
const READ = join(DIR, 'read.json');
const TEXT_MAX = 4000;
const CHOICES_MAX = 8;
mkdirSync(DIR, { recursive: true });

const plain = (value, max = TEXT_MAX) => String(value ?? '').slice(0, max);
const post = (entry) => { const id = randomUUID(); appendFileSync(OUT, `${JSON.stringify({ id, at: new Date().toISOString(), ...entry })}\n`); return id; };

const TOOLS = [
    { name: 'tell_owner', description: 'Tell your owner something: where you are, what you did, what you found. They read it on their own screen, not in this terminal. It does not wait for an answer.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to tell them, in plain words.' } }, required: ['text'] } },
    { name: 'ask_owner', description: 'Ask your owner a question instead of asking it in the terminal. It does NOT wait: it posts the question and returns at once. Stop or go on with something else; you will be told in the terminal when a message arrives, then call read_messages.',
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional: the answers they can pick from.' } }, required: ['question'] } },
    { name: 'show_owner', description: 'Point your owner to a file you made (a report, a picture, a page), so that they can open it from their screen.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The path of the file.' }, note: { type: 'string', description: 'One line on what it is.' } }, required: ['path'] } },
    { name: 'read_messages', description: 'Read what your owner wrote to you since you last read: new instructions, and answers to your questions. Call it when you are told a message arrived, and before you finish a task.',
        inputSchema: { type: 'object', properties: {} } },
];

function readMessages() {
    let lines = [];
    try { lines = readFileSync(IN, 'utf8').split('\n').filter(Boolean); } catch { /* nothing was written yet */ }
    let seen = 0;
    try { seen = Number(JSON.parse(readFileSync(READ, 'utf8')).lines) || 0; } catch { /* nothing was read yet */ }
    if (seen > lines.length) seen = 0;
    const fresh = lines.slice(seen).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    writeFileSync(READ, JSON.stringify({ lines: lines.length }));
    if (fresh.length === 0) return 'No new message from your owner.';
    return fresh.map((m) => `${m.answers ? `Answer to your question "${plain(m.question, 200)}": ` : 'Message: '}${plain(m.text)}`).join('\n');
}

function call(name, args = {}) {
    if (name === 'tell_owner') { if (!plain(args.text).trim()) throw new Error('text is empty'); post({ kind: 'say', text: plain(args.text) }); return 'Posted. Your owner will read it on their screen.'; }
    if (name === 'ask_owner') {
        if (!plain(args.question).trim()) throw new Error('question is empty');
        const choices = Array.isArray(args.choices) ? args.choices.slice(0, CHOICES_MAX).map((c) => plain(c, 200)).filter(Boolean) : [];
        post({ kind: 'ask', text: plain(args.question), choices });
        return 'Posted. Do not wait here: you will be told in the terminal when a message arrives; then call read_messages.';
    }
    if (name === 'show_owner') { if (!plain(args.path).trim()) throw new Error('path is empty'); post({ kind: 'show', path: plain(args.path, 1000), text: plain(args.note, 500) }); return 'Posted. Your owner can open it from their screen.'; }
    if (name === 'read_messages') return readMessages();
    throw new Error(`unknown tool: ${name}`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || m.id === undefined) return;         /* a notification: nothing to answer */
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owner', version: '0.1.0' } });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
        try { return ok({ content: [{ type: 'text', text: call(m.params?.name, m.params?.arguments ?? {}) }] }); }
        catch (error) { return ok({ content: [{ type: 'text', text: `Not done: ${error.message}` }], isError: true }); }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
