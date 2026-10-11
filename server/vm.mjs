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
/* Attached folders appear in every VM under /resources/<name>: the host
   program decides that path. */
/* The host program gives a launch this long; a little more is waited here. */
const LAUNCH_SECONDS = 900;
const PREFIX = 'clv-';

export function vmName(conversation) {
    if (!isConversationName(conversation)) throw new Error('not a conversation name');
    return `${PREFIX}${conversation}`;
}

/* Runs one command and resolves with what happened; it never throws for a
   non-zero exit, because "the VM does not exist" is an answer, not a crash. */
export function runner(prefix) {
    return (argv, { input, timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
        const all = [...prefix, ...argv];
        const child = execFile(all[0], all.slice(1), { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
            (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(input ?? '');
    });
}

export class Vms {
    /* `run(argv, options)` reaches the host program; `prefix` is the same
       route as an argument vector, for the one caller that needs a terminal. */
    constructor(run, prefix) { this.run = run; this.prefix = prefix; }

    launch(conversation, memoryMb) {
        return this.run(['vm', 'launch', vmName(conversation), String(memoryMb)], { timeoutMs: (LAUNCH_SECONDS + 60) * 1000 });
    }

    exec(conversation, argv, options) {
        return this.run(['vm', 'exec', vmName(conversation), '--', ...argv], options);
    }

    /* What a terminal attaches to: the same `exec`, as an argument vector. */
    execArgv(conversation, argv) {
        return [...this.prefix, 'vm', 'exec', vmName(conversation), '--', ...argv];
    }

    /* "Running", "Stopped", "Suspended", ... or undefined when there is no VM. */
    async state(conversation) {
        const name = vmName(conversation);
        const r = await this.run(['vm', 'info', name]);
        if (r.code !== 0) return undefined;
        try { return JSON.parse(r.stdout).info?.[name]?.state; } catch { return undefined; }
    }

    /* Shows a folder kept by this server in the VM, under /resources/<name>.
       `kind` is 'folder' (the folder itself: read and write) or 'view' (its
       read-only view). A NAME is given, never a path: which directory that
       is on the host is decided by the host program, not here. `uid`/`gid`:
       files written in the VM belong, on the host, to this account. */
    mount(conversation, kind, name, uid, gid) {
        return this.run(['vm', 'mount', vmName(conversation), kind, name, String(uid), String(gid)], { timeoutMs: 600_000 });
    }

    /* The work folder of a conversation: kept on the host, shown in its
       machine at /work. Made (or found again) before it is mounted. */
    workMake(conversation) { vmName(conversation); return this.run(['work', 'make', conversation]); }
    workMount(conversation, uid, gid) {
        return this.run(['vm', 'mount', vmName(conversation), 'work', conversation, String(uid), String(gid)], { timeoutMs: 600_000 });
    }
    workAside(conversation) { vmName(conversation); return this.run(['work', 'aside', conversation]); }

    umount(conversation, name) {
        return this.run(['vm', 'umount', vmName(conversation), name], { timeoutMs: 120_000 });
    }

    start(conversation) { return this.run(['vm', 'start', vmName(conversation)], { timeoutMs: 300_000 }); }
    stop(conversation) { return this.run(['vm', 'stop', vmName(conversation)], { timeoutMs: 300_000 }); }
    suspend(conversation) { return this.run(['vm', 'suspend', vmName(conversation)], { timeoutMs: 300_000 }); }
    remove(conversation) { return this.run(['vm', 'delete', vmName(conversation)], { timeoutMs: 300_000 }); }
}
