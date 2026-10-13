/* TALK: a conversation with a tool, on a screen that is not its terminal.
 *
 * THIS IS A BRANCHING ON PARLEY (server/parley, a project of its own, copied
 * here unchanged). Parley gives the tool five verbs through MCP -- tell, ask,
 * show, read, status -- and gives this server the other side: what the tool
 * posted, a way to write back, and two hooks. All that is of this product is
 * here, and it is little:
 *
 *   WHERE THE BRIDGE LIVES   in the conversation's own work folder, kept by
 *                            this server: /work/.parley in its machine. No
 *                            address, no port, nothing new in the machine.
 *   THE HOOK TO THE TOOL     the one line "a message arrived" is typed in
 *                            its terminal, which stays what it is: the
 *                            default, and the way everything else is done.
 *   THE HOOK TO THE OWNER    when the tool asks, or says it waits, the
 *                            owner's devices are alerted.
 *
 * Off by default, per conversation. Like the answerer, it is a place where
 * this server reads what a tool wrote: only where the owner turned it on.
 * And it works as far as the tool agrees to use it.
 */
import { install, Parley } from './parley/host/parley-host.mjs';
import { Refusal, SESSION } from './conversations.mjs';
import { SOCKET } from './tmux.mjs';
import { isConversationName } from './names.mjs';

export const FOLDER = '.parley';
const IN_MACHINE = `/work/${FOLDER}`;
const PANE = `=${SESSION}:`;

export class Talk {
    #store; #vms; #conversations; #resources; #warm; #alert; #listening = new Map(); #every;

    /* `alert(name, message)`: told when the tool asks or waits. */
    constructor({ store, vms, conversations, resources, warm = async () => {}, alert = () => {}, listenEveryMs = 2000 }) {
        this.#store = store; this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#warm = warm; this.#alert = alert; this.#every = listenEveryMs;
        for (const s of store.all()) if (s.on === true) this.#listen(s.name);
    }

    #known(name) {
        const c = isConversationName(name) ? this.#conversations.list().find((x) => x.name === name) : undefined;
        if (!c) throw new Refusal(404, 'No such conversation.');
        return c;
    }
    #dir(name) { return `${this.#resources.workFolder(name)}/${FOLDER}`; }

    async #type(name, line) {
        await this.#warm(name);
        const tmux = ['tmux', '-L', SOCKET, 'send-keys', '-t', PANE];
        if ((await this.#vms.exec(name, [...tmux, '-l', '--', line], { timeoutMs: 30_000 })).code !== 0) return false;
        return (await this.#vms.exec(name, [...tmux, 'Enter'], { timeoutMs: 30_000 })).code === 0;
    }

    #parley(name) {
        return new Parley(this.#dir(name), {
            toAgent: (line) => this.#type(name, line),
            toPerson: (message) => { if (message.kind === 'ask' || (message.kind === 'status' && message.state === 'waiting')) this.#alert(name, message); },
        });
    }
    #listen(name) { if (!this.#listening.has(name)) { try { this.#listening.set(name, this.#parley(name).listen({ every: this.#every })); } catch { /* its folder is not there yet */ } } }
    #deaf(name) { this.#listening.get(name)?.(); this.#listening.delete(name); }

    of(name) {
        const c = this.#known(name);
        const possible = c.work === 'kept';
        if (this.#store.get(name)?.on !== true || !possible) return { on: false, possible, messages: [], waiting: 0, status: null };
        return { on: true, possible, ...this.#parley(name).read(), declare: { name: 'parley', command: ['node', `${IN_MACHINE}/server.mjs`] } };
    }

    async set(name, on) {
        const c = this.#known(name);
        if (on === true) {
            if (c.work !== 'kept') throw new Refusal(409, 'This conversation works on the disk of its machine: its work folder is not kept here, so the bridge has nowhere to live.');
            install(this.#dir(name), { as: IN_MACHINE });
            this.#store.put({ name, on: true });
            this.#listen(name);
        } else {
            this.#store.put({ name, on: false });
            this.#deaf(name);
        }
        return this.of(name);
    }

    /* The tool is asked, in its terminal, to use the five verbs: once the server was declared to it. */
    async invite(name) {
        if (!this.of(name).on) throw new Refusal(409, 'Turn it on first.');
        if (!(await this.#parley(name).invite())) throw new Refusal(502, 'The line could not be typed: is its tool running?');
        return this.of(name);
    }

    async say(name, text, answers) {
        if (!this.of(name).on) throw new Refusal(409, 'Talking through the app is not turned on for this conversation.');
        let said;
        try { said = await this.#parley(name).say(text, answers); } catch (error) { if (error instanceof RangeError) throw new Refusal(400, error.message); throw error; }
        return { on: true, possible: true, ...said };
    }

    forget(name) { this.#deaf(name); this.#store.remove(name); }
    stop() { for (const name of [...this.#listening.keys()]) this.#deaf(name); }
}
