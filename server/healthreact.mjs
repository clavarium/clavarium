/* WHAT A CONVERSATION DOES WHEN ITS MACHINE IS SHORT (health.mjs: its disk
 * almost full, its memory almost full), chosen by the owner for each one --
 * never by default. The owner is told either way (talk.mjs, the alert);
 * this is what is done on top of that, once per problem (said again only
 * once it went away and came back):
 *
 *   an agent (Claude Code, OpenCode...)   is told, in a line the owner can
 *                                          change; {problem} is replaced by
 *                                          what health.mjs found
 *   a tool with no agent (a shell)         a command of the owner's is run in
 *                                          its machine, as its user, bounded
 *
 * What was said or run is in the conversation's chat (talk.mjs, an event).
 *
 *   settings(name)        { on, message, command } (message: the default when unset)
 *   set(name, body)       { on?, message?, command? }
 *   judged(name, record)  told each judgment by health.mjs
 */
import { Refusal } from './conversations.mjs';

export const KINDS = ['disk', 'memory'];
export const DEFAULT_MESSAGE = 'Clavarium: {problem} Free some room without losing anything: caches, temporary files, old builds. Then say in one line what you removed.';
const MESSAGE_MAX = 500;
const COMMAND_MAX = 500;
const COMMAND_SECONDS = 120;

export class HealthReact {
    #store; #say; #exec; #isAgent; #event;
    /* `say(name, line)`: typed to its agent (wakeups.mjs); `exec(name, argv, options)`: run in its
       machine; `isAgent(name)`: its tool has an agent; `event(name, line)`: said in its chat. */
    constructor({ store, say, exec, isAgent, event = () => {} }) {
        this.#store = store; this.#say = say; this.#exec = exec; this.#isAgent = isAgent; this.#event = event;
    }
    settings(name) {
        const r = this.#store.get(name) ?? {};
        return { on: r.on === true, message: r.message || DEFAULT_MESSAGE, command: r.command ?? '', agent: Boolean(this.#isAgent(name)) };
    }
    set(name, body = {}) {
        const r = { name, ...(this.#store.get(name) ?? {}) };
        if (body.on !== undefined) { if (typeof body.on !== 'boolean') throw new Refusal(400, 'Say true or false.'); r.on = body.on; }
        if (body.message !== undefined) {
            const m = String(body.message).trim();
            if (m.length > MESSAGE_MAX || /[\r\n\0]/.test(m)) throw new Refusal(400, `The message is one line, ${MESSAGE_MAX} characters at most.`);
            r.message = m || undefined;
        }
        if (body.command !== undefined) {
            const c = String(body.command).trim();
            if (c.length > COMMAND_MAX || /[\r\n\0]/.test(c)) throw new Refusal(400, `The command is one line, ${COMMAND_MAX} characters at most.`);
            r.command = c;
        }
        this.#store.put(r);
        return this.settings(name);
    }
    forget(name) { this.#store.remove?.(name); }

    async judged(name, record) {
        const r = this.#store.get(name);
        if (!r?.on || !record) return;
        const short = (record.problems ?? []).filter((p) => KINDS.includes(p.kind) && (p.level === 'warn' || p.level === 'bad'));
        /* A machine not looked at inside: what was wrong is not known to be gone. */
        if (short.length === 0 && record.state !== 'Running') return;
        const keys = short.map((p) => p.key ?? p.text);
        const before = new Set(r.reacted ?? []);
        const fresh = short.filter((p) => !before.has(p.key ?? p.text));
        if (keys.join('|') !== (r.reacted ?? []).join('|')) this.#store.put({ ...r, reacted: keys });
        if (fresh.length === 0) return;
        const problem = fresh.map((p) => p.text).join(' ');
        if (this.#isAgent(name)) {
            const line = (r.message || DEFAULT_MESSAGE).replaceAll('{problem}', problem);
            const typed = await this.#say(name, line).catch(() => false);
            this.#event(name, { kind: 'machine-problem', topic: 'Machine', tone: 'warn', text: typed ? `Said to its agent: ${line}` : `Not said to its agent (its tool is not running): ${line}` });
            return;
        }
        if (!r.command) return;
        const ran = await this.#exec(name, ['timeout', '-k', '10', String(COMMAND_SECONDS), 'sh', '-c', r.command], { timeoutMs: (COMMAND_SECONDS + 30) * 1000 }).catch((error) => ({ code: -1, stdout: '', stderr: String(error?.message ?? error) }));
        const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        this.#event(name, { kind: 'machine-problem', topic: 'Machine', tone: ran.code === 0 ? 'warn' : 'bad', text: `Ran: ${r.command} (exit ${ran.code})${out ? `: ${out}` : ''}` });
    }
}
