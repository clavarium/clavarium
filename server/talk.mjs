/* TALK: a conversation with a tool, on a screen that is not its terminal.
 *
 * The tool is given a small MCP server (owner-mcp.mjs, beside this file) through which it
 * tells its owner something, asks something, shows a file, and reads what was
 * written back. This file is the other side of that bridge: it shows what the
 * tool posted, takes what the owner writes, and TELLS THE TOOL, in its
 * terminal, in one line, that a message arrived. The terminal stays what it
 * is: the default, and the way everything else is done.
 *
 * HOW THE TWO SIDES MEET: two files in a folder of the conversation's own
 * work folder, /work/.owner in its machine. No address, no port. The bridge
 * itself is put there by this server, so the machine needs nothing new.
 *
 * WHAT IS READ HERE IS WRITTEN BY THE TOOL, so it is treated as what it is:
 * text chosen by a program. It is bounded, cleaned of what a screen obeys
 * rather than shows, and shown as text, never built. And it is read only
 * where the owner turned this on, conversation by conversation: like the
 * answerer, it is a place where the server reads what a tool wrote.
 *
 * IT DEPENDS ON THE TOOL'S GOOD WILL. The tool uses the bridge because it was
 * asked to; it may forget. What it asks in its terminal is not seen here.
 *
 * A MIRROR is possible and not built: the "owner" of one tool's bridge could
 * be another tool's bridge, and two tools would talk, whatever each one is.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';
import { isConversationName } from './names.mjs';

export const FOLDER = '.owner';
export const IN_MACHINE = `/work/${FOLDER}/server.mjs`;
export const TEXT_MAX = 4000;
export const SHOWN_MAX = 200;
export const FILE_MAX = 2 * 1024 * 1024;
const SCRIPT = fileURLToPath(new URL('./owner-mcp.mjs', import.meta.url));
const PANE = `=${SESSION}:`;
/* Typed to the tool once, when this is turned on: what it is asked to do. */
export const ASKED = 'From now on, use the tools of the MCP server named "owner" to talk with me: tell_owner to tell me something, ask_owner to ask me a question (do not ask it here), show_owner to point me to a file. When I tell you a message arrived, call read_messages. Start now: tell me in one line, with tell_owner, that you are ready.';
export const ARRIVED = 'A message from your owner arrived: call the read_messages tool of the "owner" server and act on it.';

// eslint-disable-next-line no-control-regex
const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const clean = (text, max = TEXT_MAX) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').slice(0, max);
const oneLine = (text, max) => clean(text, max).replace(/\s+/g, ' ').trim();

/* The last lines of a file that only grows, without reading more than is wanted. */
function lines(file) {
    try {
        if (lstatSync(file).isSymbolicLink() || statSync(file).size > 16 * FILE_MAX) return [];
        const text = readFileSync(file, 'utf8');
        return (text.length > FILE_MAX ? text.slice(-FILE_MAX) : text).split('\n').filter(Boolean).flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? [j] : []; } catch { return []; } });
    } catch { return []; }
}

export class Talk {
    #store; #vms; #conversations; #resources; #warm; #now;

    constructor({ store, vms, conversations, resources, warm = async () => {}, now = () => new Date() }) {
        this.#store = store; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#warm = warm; this.#now = now;
    }

    #known(name) {
        const c = isConversationName(name) ? this.#conversations.list().find((x) => x.name === name) : undefined;
        if (!c) throw new Refusal(404, 'No such conversation.');
        return c;
    }
    #dir(name) { return `${this.#resources.workFolder(name)}/${FOLDER}`; }

    /* What the page shows: both sides, in the order they were written. */
    of(name) {
        const c = this.#known(name);
        const on = this.#store.get(name)?.on === true;
        const possible = c.work === 'kept';
        if (!on || !possible) return { on: false, possible, messages: [], waiting: 0 };
        const dir = this.#dir(name);
        const fromTool = lines(`${dir}/to-owner.jsonl`).map((m) => ({ from: 'tool', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: ['say', 'ask', 'show'].includes(m.kind) ? m.kind : 'say',
            text: clean(m.text), choices: Array.isArray(m.choices) ? m.choices.slice(0, 8).map((x) => oneLine(x, 200)).filter(Boolean) : [], path: m.kind === 'show' ? oneLine(m.path, 1000) : undefined }));
        const fromOwner = lines(`${dir}/to-agent.jsonl`).map((m) => ({ from: 'owner', id: String(m.id ?? ''), at: String(m.at ?? ''), kind: 'say', text: clean(m.text), answers: m.answers ? String(m.answers) : undefined }));
        const answered = new Set(fromOwner.map((m) => m.answers).filter(Boolean));
        const all = [...fromTool, ...fromOwner].sort((a, b) => a.at.localeCompare(b.at)).slice(-SHOWN_MAX);
        return { on: true, possible, messages: all, waiting: fromTool.filter((m) => m.kind === 'ask' && !answered.has(m.id)).length, declare: { command: ['node', IN_MACHINE], name: 'owner' } };
    }

    async #type(name, text) {
        await this.#warm(name);
        const tmux = ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE];
        if ((await this.#vms.exec(name, [...tmux, '-l', '--', text], { timeoutMs: 30_000 })).code !== 0) return false;
        return (await this.#vms.exec(name, [...tmux, 'Enter'], { timeoutMs: 30_000 })).code === 0;
    }

    /* Turned on: the bridge is put in the tool's work folder, and the tool is asked to use it. */
    async set(name, on) {
        const c = this.#known(name);
        if (on === true) {
            if (c.work !== 'kept') throw new Refusal(409, 'This conversation works on the disk of its machine: its work folder is not kept here, so the bridge has nowhere to live.');
            const dir = this.#dir(name);
            mkdirSync(dir, { recursive: true });
            copyFileSync(SCRIPT, `${dir}/server.mjs`);
            for (const file of ['to-owner.jsonl', 'to-agent.jsonl']) if (!existsSync(`${dir}/${file}`)) writeFileSync(`${dir}/${file}`, '');
            this.#store.put({ name, on: true });
        } else {
            this.#store.put({ name, on: false });
        }
        return this.of(name);
    }

    /* The tool is asked, in its terminal, to use the bridge: once it has been declared to it. */
    async invite(name) {
        if (!this.of(name).on) throw new Refusal(409, 'Turn it on first.');
        if (!(await this.#type(name, ASKED))) throw new Refusal(502, 'The line could not be typed: is its tool running?');
        return this.of(name);
    }

    /* The owner writes; the tool is told, in its terminal, that a message arrived. */
    async say(name, text, answers) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        const said = clean(text).trim();
        if (!said) throw new Refusal(400, 'Write something.');
        const entry = { id: randomUUID(), at: this.#now().toISOString(), text: said };
        if (typeof answers === 'string' && answers) {
            const asked = this.of(name).messages.find((m) => m.from === 'tool' && m.kind === 'ask' && m.id === answers);
            if (asked) { entry.answers = asked.id; entry.question = oneLine(asked.text, 300); }
        }
        appendFileSync(`${this.#dir(name)}/to-agent.jsonl`, `${JSON.stringify(entry)}\n`);
        const told = await this.#type(name, ARRIVED).catch(() => false);
        return { ...this.of(name), told };
    }

    forget(name) { this.#store.remove(name); }
}
