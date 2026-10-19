/* WHERE A TOOL IS: A SHORT GUIDE, MADE FROM THE REAL SETTINGS.
 *
 * A tool wakes up in a machine it knows nothing about. It is told, in a few
 * lines of facts and exact commands, where it is -- and is left to explore
 * the rest itself (ls, --help). Two parts:
 *
 *   /tools/CLAVARIUM.md              THE SAME FOR EVERY MACHINE: written in the
 *                                    tools folder (toolbox.mjs), which every
 *                                    machine sees read-only. Nothing in it
 *                                    belongs to one conversation.
 *   /etc/clavarium/conversation.md   THIS CONVERSATION: what it was given
 *                                    (read-only or read-write), whether its
 *                                    chat is on, and the owner's own lines.
 *                                    Written by this server into THAT machine
 *                                    only, on its own disk, through the host
 *                                    program's exec, root-owned and 0444. It
 *                                    is never on a shared folder, so no other
 *                                    machine can read it. The tool is root in
 *                                    its machine and could change it: it is
 *                                    written again at each start and each
 *                                    change of settings, and holds nothing
 *                                    the tool may not know.
 *
 * And one line in the tool's own instruction file (`instructions` in
 * config/tools.json: ~/.claude/CLAUDE.md, AGENTS.md, GEMINI.md...), inside
 * a marked block that is added or refreshed without touching the rest of
 * the file. A path that goes through a link is refused, a file that changed
 * between the look and the write is left as it is.
 *
 * NEVER IN IT: a secret's value (names only), an address, a port, a key, or
 * how the machine is held. Every name in it has been checked where it was
 * made; it is cleaned here again all the same, as are the owner's lines.
 */
import { createHash } from 'node:crypto';
import { Refusal } from './conversations.mjs';
import { isConversationName } from './names.mjs';
import { originFolder } from './resources.mjs';
import { TOOLS_PATH, NOTES } from './toolbox.mjs';

export const COMMON_PATH = `${TOOLS_PATH}/${NOTES}`;
export const OWN_PATH = '/etc/clavarium/conversation.md';
export const MARK_START = '<!-- clavarium -->';
export const MARK_END = '<!-- /clavarium -->';
export const POINTER = `Read ${COMMON_PATH} and ${OWN_PATH} first: where you are, what you were given, what your owner asks.`;
/* Typed in its terminal when the owner asks (never by itself). */
export const TELL_AGAIN = `Read ${COMMON_PATH} and ${OWN_PATH} again: your setup changed.`;
/* The owner's own lines: so many, so long each, so long in all. */
export const LINES_MAX = 12;
export const LINE_MAX = 200;
export const LINES_CHARS = 1200;
/* An instruction file larger than this is not rewritten. */
export const INSTRUCTIONS_MAX = 256 * 1024;
const SCRIPT_NAME = 'clavarium-guide';

/* One line of plain text: no control character, no line break, no
   direction override, no angle bracket (nothing a page or a Markdown
   reader would take for markup), spaces collapsed. */
export function plain(value, max = LINE_MAX) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
        .replace(/</g, '\u2039').replace(/>/g, '\u203a')
        .replace(/\s+/g, ' ').trim().slice(0, max);
}

/* The owner's lines, as given (a text, or a list): cleaned, checked. */
export function readLines(input) {
    const raw = Array.isArray(input) ? input.map((x) => String(x ?? '')).join('\n') : String(input ?? '');
    if (raw.length > LINES_CHARS * 2) throw new Refusal(400, `Your lines are ${LINES_CHARS} characters at most in all.`);
    const lines = raw.split(/\r\n|\r|\n/).map((l) => plain(l, Infinity)).filter(Boolean);
    if (lines.length > LINES_MAX) throw new Refusal(400, `${LINES_MAX} lines at most.`);
    const long = lines.findIndex((l) => l.length > LINE_MAX);
    if (long >= 0) throw new Refusal(400, `Line ${long + 1} is longer than ${LINE_MAX} characters.`);
    if (lines.join('\n').length > LINES_CHARS) throw new Refusal(400, `Your lines are ${LINES_CHARS} characters at most in all.`);
    return lines;
}

/* THE PART EVERY MACHINE READS. */
export function commonText() {
    return [
        '# Where you are (Clavarium)',
        '',
        '- A throw-away machine, yours alone: you are root (sudo works). Install what you need.',
        '- /work: where you work. /resources/<name>: folders and repositories you were given, read-only or read-write. /tools: tools offered, read-only (/tools/index.json says what each is).',
        `- What this conversation has, and what its owner asks of you: ${OWN_PATH} (read-only; written again by the server when your setup changes).`,
        '- Git: commit your work. The person reviews it and sends it from their screen, or the server sends it by itself where they allowed it. You have no push key: never push.',
        '- Check out branches in the main folder of the repository or under /work, never in /tmp: /tmp is emptied when the machine restarts.',
        '- Secrets are environment variables: never print them, never write them to a file or a commit.',
        /* Installed by the server in every machine (toolbox.mjs): the tool is never asked to install it. */
        '- To talk to the person, when their chat is on: parley guide says how (parley --help, every command).',
        /* Dictation into the terminal is marked once per message (app.js); in the chat, parley read says it. */
        '- A message in your terminal that starts with a microphone sign (U+1F3A4), or that parley read says was dictated, came by voice: a word may be misheard; when a key word seems wrong, ask rather than guess.',
        '- The rest is yours to explore (ls, --help).',
        '',
    ].join('\n');
}

const list = (items) => items.join(', ');

/* THE PART OF ONE CONVERSATION, from its facts:
   { name, tool, workKept, resources: [{ name, access, type, origin }], chat, online, secrets: [names], lines } */
export function ownText({ name, tool, workKept, resources = [], chat, online, secrets = [], lines = [] }) {
    const out = [`# This conversation: ${plain(name, 40)}`, ''];
    if (tool) out.push(`- Tool running here: ${plain(tool, 40)}.`);
    out.push(workKept ? '- /work is kept by the server: the person sees it in Files, and it outlives the machine.' : '- /work is on this machine\'s own disk: it goes with the machine.');
    const where = (r) => `/resources/${plain(r.name, 40)}${r.type === 'mailbox' ? ' (mail)' : r.type === 'git' ? ' (git)' : ''}`;
    const write = resources.filter((r) => r.access === 'write');
    const read = resources.filter((r) => r.access !== 'write');
    if (resources.length === 0) out.push('- Folders given: none.');
    if (write.length) out.push(`- Read-write: ${list(write.map(where))}.`);
    if (read.length) out.push(`- Read-only: ${list(read.map(where))}.`);
    for (const r of resources.filter((x) => x.type === 'git' && x.origin)) {
        const repo = `/resources/${plain(r.name, 40)}`; const origin = `/resources/${plain(r.origin, 40)}`;
        out.push(`- ${repo}: its origin, read-only and kept up to date, is ${origin}. Its branches: git -C ${repo} fetch ${origin} '+refs/heads/*:refs/remotes/origin/*'`);
    }
    out.push(!chat ? '- Chat with the person: off. Do not use parley.'
        : '- Chat with the person: on. Parley is installed: run parley guide.');
    /* How Parley is used is Parley's to say (parley guide); what is here is this chat's: it renders Markdown. */
    if (chat) out.push('- The chat shows Markdown (lists, tables, "> [!IMPORTANT]") and pictures of /work: ![before](/work/a.png).');
    out.push(online === false ? '- Internet: off.' : '- Internet: on.');
    if (secrets.length) out.push(`- Secrets given, by name only: ${list(secrets.map((s) => plain(s, 40)))}.`);
    const own = lines.map((l) => plain(l)).filter(Boolean).slice(0, LINES_MAX);
    if (own.length) out.push('', '## From the owner', '', ...own.map((l) => `- ${l}`));
    out.push('');
    return out.join('\n');
}

/* THE MARKED BLOCK: put in `text`, or refreshed where it is. Only a whole
   block (its two marks, each on a line of its own, no start mark between)
   is replaced; any other copy of it goes; nothing else changes. A mark
   left alone (no end) is left as it is, and the block is added after. */
export function withBlock(text, line) {
    const block = `${MARK_START}\n${line}\n${MARK_END}`;
    const before = String(text ?? '');
    const whole = /^<!-- clavarium -->[ \t]*\r?\n(?:(?!<!-- clavarium -->)[\s\S])*?^<!-- \/clavarium -->[ \t]*$/gm;
    let first = true;
    let after = before.replace(whole, () => (first ? ((first = false), block) : '\u0000'));
    /* The extra copies, with the line break that ended each. */
    after = after.replace(/\u0000(\r?\n)?/g, '');
    if (first) after = before === '' ? `${block}\n` : `${before}${before.endsWith('\n') ? '' : '\n'}\n${block}\n`;
    return after;
}

/* Read in the machine, as its user, in its home: every folder of the path
   and the file itself looked at, none may be a link. Absent: exit 9. */
export const READ_SCRIPT = `set -f
at=.
IFS=/
for part in $1; do at="$at/$part"; if [ -L "$at" ]; then echo "$at is a link: not followed" >&2; exit 3; fi; done
unset IFS
f="./$1"
[ -e "$f" ] || exit 9
[ -f "$f" ] || { echo "$f is not a file" >&2; exit 4; }
[ "$(wc -c < "$f")" -le ${INSTRUCTIONS_MAX} ] || { echo "$f is too large" >&2; exit 6; }
cat -- "$f"
`;
/* Written only if it is still what was read ($2: its checksum, or "none"),
   through a file of its own renamed over it; its mode kept. */
export const WRITE_SCRIPT = `set -f
at=.
IFS=/
for part in $1; do at="$at/$part"; if [ -L "$at" ]; then echo "$at is a link: not followed" >&2; exit 3; fi; done
unset IFS
f="./$1"
if [ -e "$f" ]; then
  [ -f "$f" ] || { echo "$f is not a file" >&2; exit 4; }
  now=$(sha256sum < "$f"); now=\${now%% *}
else now=none; fi
[ "$now" = "$2" ] || { echo "$f changed meanwhile" >&2; exit 5; }
mkdir -p -- "\${f%/*}" || exit 7
t="$f.clavarium-new"
rm -f -- "$t"
cat > "$t" || exit 7
if [ -e "$f" ]; then chmod --reference="$f" -- "$t" 2>/dev/null; else chmod 0644 -- "$t"; fi
mv -f -- "$t" "$f"
`;

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export class Guide {
    #store; #vms; #conversations; #resources; #secrets; #toolbox; #tools; #chat; #say; #written = new Map(); #pointed = new Set();

    /* `chat(name)`: is its chat on. `say(name, line)`: types a line in its terminal (wakeups.mjs). */
    constructor({ store, vms, conversations, resources, secrets = null, toolbox = null, tools = [], chat = () => false, say = async () => false }) {
        this.#store = store; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#secrets = secrets;
        this.#toolbox = toolbox; this.#tools = tools; this.#chat = chat; this.#say = say;
    }

    #known(name) {
        const c = isConversationName(name) ? this.#conversations.get(name) : undefined;
        if (!c) throw new Refusal(404, 'No such conversation.');
        return c;
    }
    #tool(c) { return this.#tools.find((t) => t.id === c.tool); }

    lines(name) { return [...(this.#store.get(name)?.lines ?? [])]; }

    common() { return commonText(); }

    own(name) {
        const c = this.#known(name);
        const resources = (this.#resources?.of(name) ?? []).map((r) => {
            const type = this.#resources.get(r.name)?.type ?? 'folder';
            return { name: r.name, access: r.access, type, origin: type === 'git' && this.#resources.hasOrigin?.(r.name) ? originFolder(r.name) : undefined };
        });
        return ownText({ name, tool: this.#tool(c)?.label ?? c.tool, workKept: c.work === 'kept', resources, chat: Boolean(this.#chat(name)), online: c.offline !== true, secrets: this.#secrets?.of(name) ?? [], lines: this.lines(name) });
    }

    /* What the page shows: the exact texts, where each is, and the line in the tool's own file. */
    about(name) {
        const c = this.#known(name);
        const file = this.#tool(c)?.instructions;
        return { common: this.common(), own: this.own(name), paths: { common: COMMON_PATH, own: OWN_PATH }, pointer: file ? { file: `~/${file}`, line: POINTER } : null, lines: this.lines(name), limits: { lines: LINES_MAX, line: LINE_MAX, chars: LINES_CHARS }, tellAgain: TELL_AGAIN };
    }

    async setLines(name, input) {
        this.#known(name);
        const lines = readLines(input);
        if (lines.length) this.#store.put({ name, lines }); else this.#store.remove(name);
        await this.changed(name);
        return this.about(name);
    }

    /* ---- into the machine ---- */
    async #writeOwn(name) {
        const text = this.own(name);
        const r = await this.#vms.exec(name, ['sudo', '-n', 'install', '-D', '-m', '0444', '-o', 'root', '-g', 'root', '/dev/stdin', OWN_PATH], { input: text, timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`its guide could not be written: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        this.#written.set(name, text);
    }

    /* The marked block in the tool's own instruction file. Resolves with
       'written', 'same', or throws with why it was left alone. */
    async pointer(name) {
        const file = this.#tool(this.#known(name))?.instructions;
        if (!file) return 'none';
        const read = await this.#vms.exec(name, ['sh', '-c', READ_SCRIPT, SCRIPT_NAME, file], { timeoutMs: 30_000, maxBytes: INSTRUCTIONS_MAX * 4 });
        if (read.code !== 0 && read.code !== 9) throw new Error(`~/${file} was left alone: ${firstLine(read.stderr) || `exit ${read.code}`}`);
        const before = read.code === 9 ? null : read.stdout;
        const after = withBlock(before ?? '', POINTER);
        if (after === before) return 'same';
        const wrote = await this.#vms.exec(name, ['sh', '-c', WRITE_SCRIPT, SCRIPT_NAME, file, before === null ? 'none' : sha(before)], { input: after, timeoutMs: 30_000 });
        if (wrote.code !== 0) throw new Error(`~/${file} was left alone: ${firstLine(wrote.stderr) || `exit ${wrote.code}`}`);
        return 'written';
    }

    /* At each opening (conversations.mjs `prepare`): everything when the
       machine has just started, its own part again when it changed. Never
       in the way of an opening: what fails is said in the server's log. */
    async prepared(name, woke) {
        try {
            if (woke || this.#written.get(name) !== this.own(name)) await this.#writeOwn(name);
            /* Once per machine start, and once after this server started. */
            if (woke || !this.#pointed.has(name)) { await this.pointer(name); this.#pointed.add(name); }
        } catch (error) { this.#written.delete(name); console.error(`${name}: ${error.message}`); }
    }

    /* A setting changed: written now into a machine that runs; any other
       gets it at its next start (nothing is woken for it). */
    async changed(name) {
        this.#written.delete(name);
        if (!this.#conversations.awake?.().includes(name)) return false;
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') return false;
        try { await this.#writeOwn(name); return true; } catch (error) { console.error(`${name}: ${error.message}`); return false; }
    }

    /* The owner asks: its files written again, then one line typed. */
    async tellAgain(name) {
        this.#known(name);
        if (!this.#conversations.awake?.().includes(name)) throw new Refusal(409, 'It is asleep: open it first.');
        try { await this.#writeOwn(name); await this.pointer(name); this.#pointed.add(name); }
        catch (error) { throw new Refusal(502, `Its machine could not be given its guide: ${error.message}`); }
        if (!(await this.#say(name, TELL_AGAIN))) throw new Refusal(502, 'The line could not be typed: is its tool running?');
        return { ...this.about(name), told: TELL_AGAIN };
    }

    forget(name) { this.#store.remove(name); this.#written.delete(name); this.#pointed.delete(name); }
}
