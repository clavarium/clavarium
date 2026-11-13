/* ONE CONVERSATION, ONE VM. This file is the only one that knows how a VM is
   driven. The server has no rights of its own: every call is an argument
   vector handed to the HOST PROGRAM (deploy/clavarium-host), the one bounded
   thing it may run as root, which checks each name again and refuses any
   verb it does not know. What is written here is that program's language.
 *
 * Nothing here takes a string to parse: a conversation name has been checked
 * before it gets here, and it is checked again, because this is where it
 * turns into a command. */
import { execFile } from 'node:child_process';
import { isConversationName } from './names.mjs';

/* Where the tool starts, in its VM. At the root rather than in a home
   directory: the path then names nobody, and sits next to /resources. */
export const WORK = '/work';
export const VM_USER = 'ubuntu';
/* In a shared machine (#221), what is a conversation's own though machine-wide in a machine of its own: written
   by the server here, shown by its door at the usual place (/run/secrets, /etc/clavarium/conversation.md). */
export const ownSecretsDir = (conversation) => `/run/clavarium/own/${conversation}/secrets`;
export const ownGuideFile = (conversation) => `/etc/clavarium/own/${conversation}.md`;
export const sharedUser = (conversation) => `c-${conversation}`;
/* What sharing a folder needs inside a machine (see conversations.mjs). */
export const SHARING_STEP = Object.freeze(['sudo', '-n', 'snap', 'install', 'multipass-sshfs']);
/* Attached folders appear in every VM under /resources/<name>: the host
   program decides that path. */
/* The host program gives a launch this long; a little more is waited here. */
const LAUNCH_SECONDS = 900;
const PREFIX = 'clv-';
/* Copying a ready-made disk of a few gigabytes: slow disks are given time. */
const CLONE_MS = 15 * 60_000;
/* The bounds of the host program's ways down (its own steps are bounded: these only catch a host
   program that hangs). */
const HALT_MS = 360_000;
const HARDSTOP_MS = 120_000;
/* A line of a way down: `step <id> <start|ok|fail|timeout|skip> [<n>s] [what more]`. */
export function stepLine(line) {
    const m = /^step ([a-z]+) (start|ok|fail|timeout|skip)(?: (\d+)s)?(?: (.*))?$/.exec(String(line ?? '').trim());
    if (!m) return null;
    const more = m[4] ?? '';
    const freed = /(?:^| )freed (\d+(?:\.\d)?)G\b/.exec(more);
    return { id: m[1], result: m[2], ...(m[3] !== undefined ? { s: Number(m[3]) } : {}), ...(more ? { more } : {}), ...(freed ? { freedGb: Number(freed[1]) } : {}) };
}

export function vmName(conversation) {
    if (!isConversationName(conversation)) throw new Error('not a conversation name');
    return `${PREFIX}${conversation}`;
}

/* A size as the VM manager writes it ("2G", "2.0GiB", "1024M", "1073741824")
   in megabytes, or undefined. A bare number is bytes. */
export function megabytes(text) {
    const m = /^(\d+(?:\.\d+)?)([KMGT]?)(?:i?B)?$/i.exec(String(text ?? '').trim());
    if (!m) return undefined;
    const power = { '': -2, K: -1, M: 0, G: 1, T: 2 }[m[2].toUpperCase()];
    return Number(m[1]) * 1024 ** power;
}

/* Runs one command and resolves with what happened; it never throws for a
   non-zero exit, because "the VM does not exist" is an answer, not a crash. */
export function runner(prefix) {
    /* `maxBytes`: what is taken in of its output, at most (8 MB unless said). `onLine`: told each
       line of its output as it comes (the steps of a stop, for the page). `signal`: an AbortSignal
       that ends it at once (a step the owner moves on from: "Force now"). */
    return (argv, { input, timeoutMs = 120_000, maxBytes = 8 * 1024 * 1024, onLine, signal } = {}) => new Promise((resolve) => {
        const all = [...prefix, ...argv];
        const child = execFile(all[0], all.slice(1), { timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'utf8', ...(signal ? { signal } : {}) },
            (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, ...(error?.name === 'AbortError' ? { aborted: true } : {}) }));
        if (onLine) {
            let rest = '';
            child.stdout.on('data', (chunk) => {
                rest += chunk;
                const lines = rest.split('\n'); rest = lines.pop();
                for (const line of lines) try { onLine(line); } catch { /* a listener's trouble is not the command's */ }
            });
        }
        child.stdin.on('error', () => {});
        child.stdin.end(input ?? '');
    });
}

/* The verbs that change a machine: its state is asked again after them. */
const CHANGES = new Set(['launch', 'clone', 'start', 'stop', 'suspend', 'kill', 'halt', 'hardstop', 'delete', 'purge', 'set', 'rename', 'restore', 'snapshot', 'revive', 'reclaim']);
export const STATES_FRESH_MS = 3000;
/* The VM manager did not say what a machine is in: not an answer about the machine. */
export class VmUnknown extends Error {
    constructor(why) { super(`The VM manager does not answer just now (${why}): try again in a moment.`); this.status = 503; this.retry = true; }
}

export class Vms {
    /* `run(argv, options)` reaches the host program; `prefix` is the same
       route as an argument vector, for the one caller that needs a terminal. */
    #ask; #snapshot = null; #asking = null; #now; #freshMs; #machineOf; #userOf;
    /* `freshMs`: how long one answer serves every caller (0: only those asking meanwhile). */
    /* `machineOf(conversation)`: the shared machine it lives in (#221), or nothing -- its own, `clv-<conversation>`. */
    constructor(run, prefix, { now = () => Date.now(), freshMs = STATES_FRESH_MS, machineOf = () => undefined, userOf = () => undefined } = {}) {
        /* `userOf(conversation)`: its own user in a shared machine, { uid, gid } -- what its mounts are owned by there. */
        this.#ask = run; this.prefix = prefix; this.#now = now; this.#freshMs = freshMs; this.#machineOf = machineOf; this.#userOf = userOf;
        /* What changes a machine makes the states asked again (not taken from before it). */
        this.run = async (argv, options) => {
            const changes = argv[0] === 'vm' && CHANGES.has(argv[1]);
            if (changes) this.#snapshot = null;
            try { return await this.#ask(argv, options); } finally { if (changes) this.#snapshot = null; }
        };
    }

    /* EVERY MACHINE'S STATE, in one question to the VM manager, shared by every caller for a
       few seconds (and by those who ask while it is being asked). */
    async #states(fresh = false) {
        if (!fresh && this.#snapshot && this.#now() - this.#snapshot.at < this.#freshMs) return this.#snapshot;
        if (this.#asking) return this.#asking;
        this.#asking = (async () => {
            const r = await this.#ask(['vm', 'states'], { timeoutMs: 130_000 }).catch((error) => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
            let states = null; let why = '';
            if (r.code === 0) {
                try { states = new Map((JSON.parse(r.stdout).list ?? []).map((x) => [x.name, x.state])); } catch { why = 'its answer could not be read'; }
            } else why = String(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').pop().slice(0, 200);
            const snap = { at: this.#now(), states, why };
            /* Not kept when it did not answer: the next caller asks again. */
            this.#snapshot = states ? snap : null;
            return snap;
        })().finally(() => { this.#asking = null; });
        return this.#asking;
    }

    /* Whether it lives in a shared machine (#221). */
    shared(conversation) { return this.#machineOf(conversation) !== undefined; }
    /* ITS MACHINE (#221): a conversation's own (`clv-<name>`, as always), or the shared one it lives in. */
    vmOf(conversation) {
        const shared = this.#machineOf(conversation);
        if (shared === undefined) return vmName(conversation);
        vmName(conversation);   /* its own name checked all the same */
        return vmName(shared);
    }
    /* In a shared machine, everything run for a conversation goes through its door (clavarium-enter, as root):
       its own /work, its own home and user, its limits -- each tool sees what it sees in a machine of its own. */
    #door(conversation, argv) {
        /* A command run as root (sudo) is the server's own work on the machine (an install, a mount): not
           through the door. Everything else -- a terminal, a tool, a probe -- is the conversation's. */
        if (this.#machineOf(conversation) === undefined || argv[0] === 'sudo') return argv;
        return ['sudo', '-n', 'clavarium-enter', conversation, '--', ...argv];
    }
    /* In a shared machine: its machine-wide work, as its admin user, never through a door (the door itself installed). */
    execMachine(conversation, argv, options) { return this.run(['vm', 'exec', this.vmOf(conversation), '--', ...argv], options); }
    /* The host's list of who lives in a shared machine (vm share / unshare). */
    share(conversation) { return this.run(['vm', 'share', this.vmOf(conversation), conversation]); }
    unshare(conversation) { return this.run(['vm', 'unshare', this.vmOf(conversation), conversation]); }

    launch(conversation, memoryMb, diskGb, cpus) {
        /* The disk and cores go with the memory only when they are the chosen size, not the defaults. */
        const size = diskGb && cpus ? [String(diskGb), String(cpus)] : [];
        return this.run(['vm', 'launch', this.vmOf(conversation), String(memoryMb), ...size], { timeoutMs: (LAUNCH_SECONDS + 60) * 1000 });
    }

    /* The machine of a conversation as a COPY of the ready-made one (see
       shelf.mjs), with its own memory. Left stopped: started by the caller. */
    clone(conversation, shelf, memoryMb) {
        return this.run(['vm', 'clone', shelf, this.vmOf(conversation), String(memoryMb)], { timeoutMs: CLONE_MS });
    }

    exec(conversation, argv, options) {
        return this.run(['vm', 'exec', this.vmOf(conversation), '--', ...this.#door(conversation, argv)], options);
    }

    /* What a terminal attaches to: the same `exec`, as an argument vector. */
    execArgv(conversation, argv) {
        return [...this.prefix, 'vm', 'exec', this.vmOf(conversation), '--', ...this.#door(conversation, argv)];
    }

    /* Every machine's state, by VM name (a Map); throws VmUnknown when the VM manager did not answer. */
    async states({ fresh = false } = {}) {
        const snap = await this.#states(fresh);
        if (!snap.states) throw new VmUnknown(snap.why);
        return new Map(snap.states);
    }

    /* "Running", "Stopped", "Suspended", ... or undefined when there is no VM. */
    /* Its state, or undefined when the VM manager lists every machine and not this one. A VM
       manager that does not answer (busy, timed out, restarting) says nothing of the machine:
       that throws (VmUnknown), and is never taken for a machine that is gone (21-10: a machine
       frozen inside had "multipass info" fail, read as "no longer exists"). */
    /* `fresh`: asked now (an owner opening it, building it again), not taken from a few seconds ago. */
    async state(conversation, { fresh = false } = {}) {
        const name = this.vmOf(conversation);
        const snap = await this.#states(fresh);
        if (!snap.states) throw new VmUnknown(snap.why);
        return snap.states.get(name);
    }

    /* Shows a folder kept by this server in the VM, under /resources/<name>.
       `kind` is 'folder' (the folder itself: read and write) or 'view' (its
       read-only view). A NAME is given, never a path: which directory that
       is on the host is decided by the host program, not here. `uid`/`gid`:
       files written in the VM belong, on the host, to this account. */
    mount(conversation, kind, name, uid, gid) {
        /* In a shared machine (#221): into its own place there, where its door finds it. */
        if (this.shared(conversation)) { const u = this.#userOf(conversation); if (!u) throw new Error('its own user in the shared machine is not known yet'); return this.run(['vm', 'smount', this.vmOf(conversation), conversation, kind, name, String(uid), String(gid), String(u.uid), String(u.gid)], { timeoutMs: 600_000 }); }
        return this.run(['vm', 'mount', this.vmOf(conversation), kind, name, String(uid), String(gid)], { timeoutMs: 600_000 });
    }

    /* The work folder of a conversation: kept on the host, shown in its
       machine at /work. Made (or found again) before it is mounted. */
    workMake(conversation) { this.vmOf(conversation); return this.run(['work', 'make', conversation]); }
    workMount(conversation, uid, gid) {
        if (this.shared(conversation)) { const u = this.#userOf(conversation); if (!u) throw new Error('its own user in the shared machine is not known yet'); return this.run(['vm', 'smount', this.vmOf(conversation), conversation, 'work', conversation, String(uid), String(gid), String(u.uid), String(u.gid)], { timeoutMs: 600_000 }); }
        return this.run(['vm', 'mount', this.vmOf(conversation), 'work', conversation, String(uid), String(gid)], { timeoutMs: 600_000 });
    }
    workUnmount(conversation) {
        if (this.shared(conversation)) return this.run(['vm', 'sumount', this.vmOf(conversation), conversation, 'work'], { timeoutMs: 120_000 });
        return this.run(['vm', 'unwork', this.vmOf(conversation)], { timeoutMs: 120_000 });
    }
    /* Megabytes left: { disk, host }, or undefined if it cannot be told. */
    async workRoom(conversation) {
        this.vmOf(conversation);
        const r = await this.run(['work', 'room', conversation]);
        const m = /^disk (\d+) host (\d+)$/m.exec(r.stdout ?? '');
        return r.code === 0 && m ? { disk: Number(m[1]), host: Number(m[2]) } : undefined;
    }
    workAside(conversation) { this.vmOf(conversation); return this.run(['work', 'aside', conversation]); }
    /* Deleted for good, or reset, by its owner: its work disk erased, not put aside. */
    workErase(conversation) { this.vmOf(conversation); return this.run(['work', 'erase', conversation]); }

    /* The tools folder (see toolbox.mjs), shown read-only at /tools. */
    mountTools(conversation, uid, gid) {
        return this.run(['vm', 'mount', this.vmOf(conversation), 'tools', 'tools', String(uid), String(gid)], { timeoutMs: 600_000 });
    }
    unmountTools(conversation) { return this.run(['vm', 'untools', this.vmOf(conversation)], { timeoutMs: 120_000 }); }

    umount(conversation, name) {
        if (this.shared(conversation)) return this.run(['vm', 'sumount', this.vmOf(conversation), conversation, name], { timeoutMs: 120_000 });
        return this.run(['vm', 'umount', this.vmOf(conversation), name], { timeoutMs: 120_000 });
    }

    /* `signal`: a start given up (Force stop asked meanwhile). */
    start(conversation, { signal } = {}) { return this.run(['vm', 'start', this.vmOf(conversation)], { timeoutMs: 300_000, ...(signal ? { signal } : {}) }); }
    stop(conversation, timeoutMs = 300_000) { return this.run(['vm', 'stop', this.vmOf(conversation)], { timeoutMs }); }
    /* Stopped without waiting for the system inside: after a clean stop hung. */
    kill(conversation) { return this.run(['vm', 'kill', this.vmOf(conversation)], { timeoutMs: 300_000 }); }
    /* STOPPED FOR SURE, step by step (the host program's `vm halt`): a polite stop, a stop by force,
       then its own qemu ended (SIGTERM, SIGKILL), then checked. `from`/`until`: the first and last
       step (polite|force|term|kill; until force|kill). Each `step ...` line is told to `onLine`. */
    halt(conversation, { from = 'polite', until = 'kill', onLine, signal } = {}) {
        return this.run(['vm', 'halt', this.vmOf(conversation), from, until], { timeoutMs: HALT_MS, onLine, signal });
    }
    /* "Force stop", as a power cut: its qemu ended, nothing asked of the VM manager (`vm hardstop`). */
    hardstop(conversation, { onLine, signal } = {}) { return this.run(['vm', 'hardstop', this.vmOf(conversation)], { timeoutMs: HARDSTOP_MS, onLine, signal }); }
    /* Memory in megabytes, disk in gigabytes: only on a stopped machine. */
    setMemory(conversation, mb) { return this.run(['vm', 'set', this.vmOf(conversation), 'memory', String(mb)], { timeoutMs: 120_000 }); }
    setCpus(conversation, n) { return this.run(['vm', 'set', this.vmOf(conversation), 'cpus', String(n)], { timeoutMs: 120_000 }); }
    setDisk(conversation, gb) { return this.run(['vm', 'set', this.vmOf(conversation), 'disk', String(gb)], { timeoutMs: 600_000 }); }
    /* What the machine really has: { memoryMb, diskGb }, each undefined when it cannot be told. */
    async size(conversation) {
        const r = await this.run(['vm', 'size', this.vmOf(conversation)], { timeoutMs: 60_000 });
        if (r.code !== 0) return { memoryMb: undefined, diskGb: undefined };
        const line = (key) => new RegExp(`^${key} (\\S+)$`, 'm').exec(r.stdout ?? '')?.[1];
        const mb = megabytes(line('memory'));
        const disk = megabytes(line('disk'));
        const cpus = /^\d{1,3}$/.test(line('cpus') ?? '') ? Number(line('cpus')) : undefined;
        return { memoryMb: mb === undefined ? undefined : Math.round(mb), diskGb: disk === undefined ? undefined : Math.round(disk / 1024), cpus };
    }
    /* Its steps (`step suspend ...`, then a wake and sleep again, then a clean stop) told to `onLine`. */
    suspend(conversation, { signal, onLine } = {}) { return this.run(['vm', 'suspend', this.vmOf(conversation)], { timeoutMs: 600_000, ...(signal ? { signal } : {}), ...(onLine ? { onLine } : {}) }); }
    /* Free the RAM of a machine that is asleep but whose qemu still holds it (a
       suspend that did not end the process): wake+resleep, then a clean stop. */
    reclaim(conversation) { return this.run(['vm', 'reclaim', this.vmOf(conversation)], { timeoutMs: 300_000 }); }
    remove(conversation) { return this.run(['vm', 'delete', this.vmOf(conversation)], { timeoutMs: 300_000 }); }
    /* A shared machine deleted by its own name (its last conversation gone: no conversation leads to it any more). */
    removeVm(vm) { if (!/^clv-[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/.test(vm)) throw new Error('not one of our machines'); return this.run(['vm', 'delete', vm], { timeoutMs: 300_000 }); }
}
