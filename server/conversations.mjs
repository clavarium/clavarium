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
/* Moving a work folder: what must stay free after it, and how long a copy may take. */
export const ROOM_MB = 1024;
/* A file shown straight from a machine's disk: where, and how large at most. */
const MACHINE_PATH = /^\/work(\/[A-Za-z0-9._@+%~-]+)+$/;
export const MACHINE_FILE_MAX = 5 * 1024 * 1024;
const MOVE_MS = 30 * 60_000;

/* An error whose message is meant for the person, and safe to show. */
export class Refusal extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Conversations {
    #store; #vms; #tools; #stopDelayMs; #timers = new Map(); #watching = new Map(); #fresh = new Set(); #uid; #gid;
    /* Set by the server: prepares the VM before the tool is attached, and
       names the program the tool is started through. See secrets.mjs. */
    prepare = async () => {};
    through = [];
    /* Set by the server: closes at once a terminal kept open for a screen
       that might come back. Called before a machine is slept, stopped or deleted. */
    drop = () => {};
    /* Set by the server: told when a conversation has just become usable. */
    ready = () => {};

    /* `uid`/`gid`: the account this server runs as; files the tool writes in
       its kept work folder belong to it on the host. */
    constructor({ store, vms, tools, stopDelayMs = STOP_DELAY_MS, uid = process.getuid(), gid = process.getgid() }) {
        this.#store = store; this.#vms = vms; this.#tools = tools; this.#stopDelayMs = stopDelayMs; this.#uid = uid; this.#gid = gid;
        /* A build interrupted by a restart of this server cannot be resumed
           blindly: it is marked failed, and says so. */
        for (const c of store.all()) {
            /* A move cut short leaves the machine as it was at that moment:
               it is said, with where to look, rather than guessed at. */
            if (c.phase === 'moving') store.patch(c.name, { phase: 'ready', step: undefined, moved: 'The server restarted while the work folder was being moved. The files are safe, in the machine: look at /work, /work.before-move and /work.moving.' });
            if (c.phase === 'building') store.patch(c.name, { phase: 'failed', error: 'The server restarted while this conversation was being built. Build it again, or archive it.' });
        }
    }

    tools() { return this.#tools.map(({ id, label, memoryMb }) => ({ id, label, memoryMb })); }

    /* The sign-in rules of a conversation's tool, or undefined. */
    signinRules(name) { return this.#tools.find((t) => t.id === this.#store.get(name)?.tool)?.signin; }

    list() {
        return this.#store.all().map((c) => ({ ...c, toolLabel: this.#tools.find((t) => t.id === c.tool)?.label ?? c.tool }));
    }

    /* `workOnDisk`: the tool works on its machine's own disk instead of in a
       folder kept by the server. Faster for a large code project; but what
       it makes is then not seen from the page, and goes with the machine. */
    create({ name, tool, memoryMb, workOnDisk }) {
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        const chosen = this.#tools.find((t) => t.id === tool);
        if (!chosen) throw new Refusal(400, 'Unknown tool.');
        const memory = memoryMb ?? chosen.memoryMb;
        if (!Number.isInteger(memory) || memory < chosen.memoryMb || memory > 16384) {
            throw new Refusal(400, `This tool needs at least ${chosen.memoryMb} MB of memory.`);
        }
        if (this.#store.get(name)) throw new Refusal(409, 'A conversation already has this name.');
        const conversation = { name, tool, memoryMb: memory, work: workOnDisk === true ? 'disk' : 'kept', phase: 'building', step: 'Starting the machine', createdAt: new Date().toISOString(), buildingSince: new Date().toISOString() };
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
        if (this.#store.get(name)?.work === 'kept') {
            /* Where the tool works is a folder kept by the server: what it
               makes there is seen from the page (Files) and outlives the
               machine. Asked for by the owner, who could not find a file his
               tool had just made. */
            const kept = await this.#vms.workMake(name);
            const shown = kept.code === 0 ? await this.#vms.workMount(name, this.#uid, this.#gid) : kept;
            if (shown.code !== 0) return fail('The work folder could not be shown in the machine', shown);
        } else {
            for (const argv of [['sudo', '-n', 'mkdir', '-p', WORK], ['sudo', '-n', 'chown', `${VM_USER}:${VM_USER}`, WORK]]) {
                const made = await this.#vms.exec(name, argv);
                if (made.code !== 0) return fail('The work folder could not be created', made);
            }
        }
        for (const [i, step] of tool.steps.entries()) {
            if (!this.#store.get(name)) return undefined; /* archived meanwhile */
            this.#store.patch(name, { step: `Installing ${tool.label} (${i + 1}/${tool.steps.length})` });
            const r = await this.#vms.exec(name, step.argv, { input: step.input, timeoutMs: STEP_MS });
            if (r.code !== 0) return fail(`Installing ${tool.label} failed at step ${i + 1}`, r);
        }
        this.#store.patch(name, { phase: 'ready', step: undefined, buildingSince: undefined });
        /* A machine that has just been built holds nothing of what was put
           in the one before it: the next opening prepares it from nothing.
           (Without this, a machine built again started with no runner, and
           its tool "exited" at once -- caught by an end-to-end test.) */
        this.#fresh.add(name);
        this.ready(name);
        return undefined;
    }

    /* Builds the machine of a conversation AGAIN: after a build that failed,
       or when the machine is gone (a backup put back on a new computer brings
       the conversation's name, tool and folders, not its machine). What was
       on the old machine's disk is not brought back: nothing here can.
       A conversation that has a working machine is refused -- this is not a
       reset button. */
    async rebuild(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase === 'building') throw new Refusal(409, 'This conversation is still being built.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool) throw new Refusal(400, 'The tool of this conversation is no longer offered.');
        const state = await this.#vms.state(name);
        if (state !== undefined && c.phase !== 'failed') throw new Refusal(409, 'This conversation has its machine: there is nothing to build again.');
        this.#cancelStop(name);
        this.drop(name);
        /* Marked first: two requests cannot both start a build. */
        this.#store.patch(name, { phase: 'building', step: 'Starting the machine', error: undefined, asleep: false, buildingSince: new Date().toISOString() });
        this.built = (async () => {
            /* What a failed build left behind is cleared away first. */
            if (state !== undefined) await this.#vms.remove(name);
            return this.#build(name, tool, c.memoryMb);
        })();
        return this.#store.get(name);
    }

    /* What a terminal must run to reach this conversation. Wakes the VM first. */
    async open(name, say = () => {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, c.phase === 'building' ? 'This conversation is still being built.' : c.phase === 'moving' ? 'This conversation is moving its work folder.' : 'This conversation could not be built.');
        this.#cancelStop(name);
        /* Opening is the explicit gesture that ends a sleep. */
        if (c.asleep) this.#store.patch(name, { asleep: false });
        this.#watching.set(name, (this.#watching.get(name) ?? 0) + 1);
        const state = await this.#vms.state(name);
        if (state === undefined) { this.left(name); throw new Refusal(410, 'The machine of this conversation no longer exists.'); }
        const stopped = state !== 'Running';
        const woke = this.#fresh.delete(name) || stopped;
        if (stopped) {
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

    /* ONE FILE OF THE MACHINE'S OWN DISK, read for the person who asked to
       see it (a path on their screen, clicked). Only under /work, only a
       plain path, only a regular file of a modest size; read as the
       machine's ordinary user, never as root. Nothing is kept of it here. */
    async machineFile(name, path) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, 'This conversation is not ready.');
        if (typeof path !== 'string' || path.length > 1024 || !MACHINE_PATH.test(path) || path.split('/').includes('..') || path.split('/').includes('.')) {
            throw new Refusal(400, 'Only a file under /work can be shown, by a plain path.');
        }
        if (await this.#vms.state(name) !== 'Running') throw new Refusal(409, 'Its machine is not running: open the conversation first.');
        const stat = await this.#vms.exec(name, ['stat', '-L', '-c', '%F %s', '--', path]);
        if (stat.code !== 0) throw new Refusal(404, 'This file is not on the machine (any more).');
        const size = Number(stat.stdout.trim().split(' ').pop());
        if (!stat.stdout.startsWith('regular') || !Number.isInteger(size)) throw new Refusal(400, 'This is not a file.');
        if (size > MACHINE_FILE_MAX) throw new Refusal(413, `This file is too large to be shown from the machine's disk (${Math.round(size / 1048576)} MB). Ask the tool to copy it into an attached folder.`);
        /* As text on the way out of the machine: a channel made for commands
           is not trusted with raw bytes. */
        const read = await this.#vms.exec(name, ['base64', '-w', '0', '--', path], { timeoutMs: 120_000 });
        if (read.code !== 0) throw new Refusal(502, `The file could not be read: ${firstLine(read.stderr)}`);
        return { name: path.split('/').pop(), bytes: Buffer.from(read.stdout, 'base64') };
    }

    /* MOVES WHERE THE TOOL WORKS, with its files: to a folder kept by the
       server ('kept': seen in Files, outlives the machine, of a fixed size)
       or to the machine's own disk ('disk': faster for a large project).
     *
     * The tool is stopped for the move and started again after it: it runs
     * IN that folder. Nothing is touched before these are known to hold:
     *   - the destination keeps at least ROOM_MB free after the copy;
     *   - going to a kept folder, no symbolic link of the work points upwards
     *     ("../") or to an absolute path. Tried on a real machine: a kept
     *     folder takes a link to a file next to it, and REFUSES those -- which
     *     is what a project's installed packages are full of.
     * A copy that fails is undone: the work stays where it was.
     * The answer comes at once; the move goes on, and `moved` says how it
     * ended. */
    async moveWork(name, to) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (to !== 'kept' && to !== 'disk') throw new Refusal(400, 'The work goes to "kept" or to "disk".');
        if (c.phase !== 'ready') throw new Refusal(409, 'This conversation is not ready.');
        if ((c.work ?? 'disk') === to) throw new Refusal(409, to === 'kept' ? 'Its work is already kept here.' : 'It already works on the disk of its machine.');
        if (await this.#vms.state(name) !== 'Running') throw new Refusal(409, 'Its machine is not running: open the conversation first.');
        const inVm = (argv, timeoutMs = 60_000) => this.#vms.exec(name, ['sudo', '-n', ...argv], { timeoutMs });
        const said = (r) => firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;

        /* --- what must hold, before anything is touched --- */
        const measured = await inVm(['du', '-sm', WORK], MOVE_MS);
        const size = Number.parseInt(measured.stdout, 10);
        if (measured.code !== 0 || !Number.isInteger(size)) throw new Refusal(502, `The size of the work folder could not be read: ${said(measured)}`);
        if (to === 'kept') {
            const link = await inVm(['find', WORK, '-type', 'l', '(', '-lname', '/*', '-o', '-lname', '*..*', ')', '-print', '-quit'], MOVE_MS);
            if (link.code !== 0) throw new Refusal(502, `The work folder could not be looked through: ${said(link)}`);
            if (link.stdout.trim() !== '') throw new Refusal(409, `Not moved: its work holds symbolic links that point upwards or outside (the first: ${firstLine(link.stdout)}). A folder kept here refuses those: this project stays on the disk of its machine.`);
            const made = await this.#vms.workMake(name);
            if (made.code !== 0) throw new Refusal(502, `The kept folder could not be made: ${said(made)}`);
            const room = await this.#vms.workRoom(name);
            const short = !room ? 'the room left could not be read' : size + ROOM_MB > room.disk ? `it holds ${size} MB and its kept folder has ${room.disk} MB` : size + ROOM_MB > room.host ? `it holds ${size} MB and the server has ${room.host} MB left` : undefined;
            if (short) { await this.#vms.workAside(name); throw new Refusal(409, `Not moved: ${short}. At least ${ROOM_MB} MB must stay free after the move.`); }
        } else {
            const free = await inVm(['df', '-m', '--output=avail', '/']);
            const left = Number.parseInt(free.stdout.trim().split('\n').pop(), 10);
            if (free.code !== 0 || !Number.isInteger(left)) throw new Refusal(502, `The room left on the machine's disk could not be read: ${said(free)}`);
            if (size + ROOM_MB > left) throw new Refusal(409, `Not moved: its work holds ${size} MB and the disk of its machine has ${left} MB left. At least ${ROOM_MB} MB must stay free after the move.`);
        }

        this.#cancelStop(name);
        this.#store.patch(name, { phase: 'moving', step: 'Stopping the tool', moved: undefined });
        this.moved = (async () => {
            const step = (text) => this.#store.patch(name, { step: text });
            let failure;
            try {
                this.drop(name);
                await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'kill-server']);
                failure = to === 'kept' ? await this.#toKept(name, inVm, said, step) : await this.#toDisk(name, inVm, said, step);
            } catch { failure = 'The move stopped on an unexpected error.'; }
            if (!this.#store.get(name)) return;
            this.#store.patch(name, {
                phase: 'ready', step: undefined, ...(failure ? {} : { work: to }),
                moved: failure ? `Not moved: ${failure} Its work is where it was.` : to === 'kept' ? 'Its work is now kept here: see it in Files.' : 'It now works on the disk of its machine.',
            });
            /* The tool is started again, where its work now is. */
            this.ready(name);
        })();
        return this.#store.get(name);
    }

    async #toKept(name, inVm, said, step) {
        const before = `${WORK}.before-move`;
        const undo = async () => { await this.#vms.workUnmount(name); await inVm(['rmdir', WORK]); await inVm(['mv', '-T', before, WORK]); await this.#vms.workAside(name); };
        const aside = await inVm(['mv', '-T', WORK, before]);
        if (aside.code !== 0) { await this.#vms.workAside(name); return `the work folder could not be set aside (${said(aside)}).`; }
        const shown = await this.#vms.workMount(name, this.#uid, this.#gid);
        if (shown.code !== 0) { await undo(); return `the kept folder could not be shown in the machine (${said(shown)}).`; }
        step('Copying its files');
        const copied = await inVm(['cp', '-r', '--no-dereference', '--preserve=mode,timestamps', `${before}/.`, `${WORK}/`], MOVE_MS);
        if (copied.code !== 0) { await undo(); return `the copy failed (${said(copied)}).`; }
        await inVm(['rm', '-rf', before], MOVE_MS);
        return undefined;
    }

    async #toDisk(name, inVm, said, step) {
        const moving = `${WORK}.moving`;
        step('Copying its files');
        await inVm(['rm', '-rf', moving], MOVE_MS);
        const made = await inVm(['mkdir', moving]);
        const copied = made.code === 0 ? await inVm(['cp', '-r', '--no-dereference', '--preserve=mode,timestamps', `${WORK}/.`, `${moving}/`], MOVE_MS) : made;
        if (copied.code !== 0) { await inVm(['rm', '-rf', moving], MOVE_MS); return `the copy failed (${said(copied)}).`; }
        await inVm(['chown', '-R', `${VM_USER}:${VM_USER}`, moving], MOVE_MS);
        const out = await this.#vms.workUnmount(name);
        if (out.code !== 0) { await inVm(['rm', '-rf', moving], MOVE_MS); return `the kept folder could not be taken out of the machine (${said(out)}).`; }
        await inVm(['rmdir', WORK]);
        const placed = await inVm(['mv', '-T', moving, WORK]);
        if (placed.code !== 0) { await this.#vms.workMount(name, this.#uid, this.#gid); return `the copy could not be put in place (${said(placed)}).`; }
        /* What was kept here is put aside on the server, not erased. */
        await this.#vms.workAside(name);
        return undefined;
    }

    /* After a restart of the host, the disks the conversations work in are
       not mounted any more: they are put back before any machine is started
       or any terminal opened. One that cannot be is reported, not thrown. */
    async ensureWork() {
        const failed = [];
        for (const c of this.#store.all()) {
            if (c.work === 'kept' && c.phase === 'ready' && (await this.#vms.workMake(c.name)).code !== 0) failed.push(c.name);
        }
        return failed;
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
        const kept = this.#store.get(name).work === 'kept';
        this.#store.remove(name);
        if (await this.#vms.state(name) !== undefined) await this.#vms.remove(name);
        /* Its work is moved aside on the server, not erased. */
        if (kept) await this.#vms.workAside(name);
    }

    #cancelStop(name) {
        const timer = this.#timers.get(name);
        if (timer) { clearTimeout(timer); this.#timers.delete(name); }
    }
}
