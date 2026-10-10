/* THE LIFE OF A CONVERSATION: created, built, opened, left running, rested,
   archived. See docs/blueprint/architecture.html, "When does a VM stop?".
 *
 *   - closing the page stops NOTHING: the tool keeps working in its VM;
 *   - once the tool has exited, the VM is stopped after a short delay;
 *   - Sleep is a button, never a guess: telling a long job from an idle tool
 *     cannot be done without reading the tool, and this server does not read.
 */
import { isConversationName } from './names.mjs';
import { attachCommand, SOCKET } from './tmux.mjs';
import { WORK, VM_USER } from './vm.mjs';

export const SESSION = 'main';
export const STOP_DELAY_MS = 60_000;
const STEP_MS = 15 * 60_000;

/* An error whose message is meant for the person, and safe to show. */
export class Refusal extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Conversations {
    #store; #vms; #tools; #stopDelayMs; #timers = new Map(); #watching = new Map();
    /* Set by the server: prepares the VM before the tool is attached, and
       names the program the tool is started through. See secrets.mjs. */
    prepare = async () => {};
    through = [];
    /* Set by the server: closes at once a terminal kept open for a screen
       that might come back. Called before a machine is slept, stopped or deleted. */
    drop = () => {};
    /* Set by the server: told when a conversation has just become usable. */
    ready = () => {};

    constructor({ store, vms, tools, stopDelayMs = STOP_DELAY_MS }) {
        this.#store = store; this.#vms = vms; this.#tools = tools; this.#stopDelayMs = stopDelayMs;
        /* A build interrupted by a restart of this server cannot be resumed
           blindly: it is marked failed, and says so. */
        for (const c of store.all()) {
            if (c.phase === 'building') store.patch(c.name, { phase: 'failed', error: 'The server restarted while this conversation was being built. Archive it and create it again.' });
        }
    }

    tools() { return this.#tools.map(({ id, label, memoryMb }) => ({ id, label, memoryMb })); }

    /* The sign-in rules of a conversation's tool, or undefined. */
    signinRules(name) { return this.#tools.find((t) => t.id === this.#store.get(name)?.tool)?.signin; }

    list() {
        return this.#store.all().map((c) => ({ ...c, toolLabel: this.#tools.find((t) => t.id === c.tool)?.label ?? c.tool }));
    }

    create({ name, tool, memoryMb }) {
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        const chosen = this.#tools.find((t) => t.id === tool);
        if (!chosen) throw new Refusal(400, 'Unknown tool.');
        const memory = memoryMb ?? chosen.memoryMb;
        if (!Number.isInteger(memory) || memory < chosen.memoryMb || memory > 16384) {
            throw new Refusal(400, `This tool needs at least ${chosen.memoryMb} MB of memory.`);
        }
        if (this.#store.get(name)) throw new Refusal(409, 'A conversation already has this name.');
        const conversation = { name, tool, memoryMb: memory, phase: 'building', step: 'Starting the machine', createdAt: new Date().toISOString(), buildingSince: new Date().toISOString() };
        this.#store.put(conversation);
        this.built = this.#build(name, chosen, memory);
        return conversation;
    }

    async #build(name, tool, memoryMb) {
        const fail = (what, r) => { this.#store.patch(name, { phase: 'failed', step: undefined, error: `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}` }); };
        const launched = await this.#vms.launch(name, memoryMb);
        if (launched.code !== 0) return fail('The machine did not start', launched);
        /* What sharing a folder needs inside the VM, put there NOW. Left to
           the first attachment, it made that one take over a minute -- longer
           than the edge waits for an answer, so the page said "failed" about
           an attachment that then succeeded (seen by a tester). */
        this.#store.patch(name, { step: 'Preparing the machine' });
        const sharing = await this.#vms.exec(name, ['sudo', '-n', 'snap', 'install', 'multipass-sshfs'], { timeoutMs: STEP_MS });
        if (sharing.code !== 0) return fail('The machine could not be prepared for shared folders', sharing);
        for (const argv of [['sudo', '-n', 'mkdir', '-p', WORK], ['sudo', '-n', 'chown', `${VM_USER}:${VM_USER}`, WORK]]) {
            const made = await this.#vms.exec(name, argv);
            if (made.code !== 0) return fail('The work folder could not be created', made);
        }
        for (const [i, step] of tool.steps.entries()) {
            if (!this.#store.get(name)) return undefined; /* archived meanwhile */
            this.#store.patch(name, { step: `Installing ${tool.label} (${i + 1}/${tool.steps.length})` });
            const r = await this.#vms.exec(name, step.argv, { input: step.input, timeoutMs: STEP_MS });
            if (r.code !== 0) return fail(`Installing ${tool.label} failed at step ${i + 1}`, r);
        }
        this.#store.patch(name, { phase: 'ready', step: undefined, buildingSince: undefined });
        this.ready(name);
        return undefined;
    }

    /* What a terminal must run to reach this conversation. Wakes the VM first. */
    async open(name, say = () => {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, c.phase === 'building' ? 'This conversation is still being built.' : 'This conversation could not be built.');
        this.#cancelStop(name);
        /* Opening is the explicit gesture that ends a sleep. */
        if (c.asleep) this.#store.patch(name, { asleep: false });
        this.#watching.set(name, (this.#watching.get(name) ?? 0) + 1);
        const state = await this.#vms.state(name);
        if (state === undefined) { this.left(name); throw new Refusal(410, 'The machine of this conversation no longer exists.'); }
        const woke = state !== 'Running';
        if (woke) {
            say('Waking the machine...');
            const started = await this.#vms.start(name);
            if (started.code !== 0) { this.left(name); throw new Refusal(502, `The machine did not wake: ${firstLine(started.stderr)}`); }
        }
        /* `woke` tells the preparation that the machine has just started:
           whatever was put in its memory before is gone. */
        try { await this.prepare(name, woke); }
        catch (error) { this.left(name); throw error; }
        const tool = this.#tools.find((t) => t.id === c.tool);
        return this.#vms.execArgv(name, attachCommand(SESSION, [...this.through, ...tool.command], WORK));
    }

    /* A screen takes over a terminal that was kept open: the machine is
       known to be running, nothing has to be asked or delivered. */
    rejoin(name) {
        this.#cancelStop(name);
        this.#watching.set(name, (this.#watching.get(name) ?? 0) + 1);
    }

    /* A screen went away, for whatever reason. */
    left(name) {
        const n = (this.#watching.get(name) ?? 1) - 1;
        if (n > 0) this.#watching.set(name, n); else this.#watching.delete(name);
    }

    /* The terminal ended BY ITSELF. Either the tool exited (the session is
       gone), or only the link broke (the session is still there). Asked, not
       guessed: tmux knows. */
    async ended(name) {
        if (!this.#store.get(name)) return false;
        const alive = await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'has-session', '-t', `=${SESSION}`]);
        /* true: the tool is still there, only the channel to it dropped. */
        if (alive.code === 0) return true;
        this.#cancelStop(name);
        const timer = setTimeout(() => {
            this.#timers.delete(name);
            if (!this.#watching.has(name)) { this.drop(name); void this.#vms.stop(name); }
        }, this.#stopDelayMs);
        timer.unref?.();
        this.#timers.set(name, timer);
        return false;
    }

    /* The conversations whose machine should be running: built, not asleep. */
    awake() { return this.#store.all().filter((c) => c.phase === 'ready' && c.asleep !== true).map((c) => c.name); }

    /* Whether the machine of a conversation runs right now. */
    async running(name) { return (await this.#vms.state(name)) === 'Running'; }

    async sleep(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        this.#cancelStop(name);
        this.drop(name);
        const r = await this.#vms.suspend(name);
        if (r.code !== 0) throw new Refusal(502, `The machine did not go to sleep: ${firstLine(r.stderr)}`);
        /* Remembered: a sleep that was asked for holds until somebody wakes
           it on purpose. A page that merely reloads must not wake it. */
        this.#store.patch(name, { asleep: true });
    }

    /* Online or offline: remembered here, enforced by network.mjs. */
    setOffline(name, offline) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        this.#store.patch(name, { offline: offline === true });
    }

    offline() { return this.#store.all().filter((c) => c.offline === true).map((c) => c.name); }

    async archive(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        this.#cancelStop(name);
        this.drop(name);
        this.#store.remove(name);
        if (await this.#vms.state(name) !== undefined) await this.#vms.remove(name);
    }

    #cancelStop(name) {
        const timer = this.#timers.get(name);
        if (timer) { clearTimeout(timer); this.#timers.delete(name); }
    }
}
