/* ONE CONVERSATION, ONE VM. This file is the only one that knows how a VM is
   driven: every call is an argument vector handed to the VM manager, through
   whatever prefix the installation uses to reach it.
 *
 * Nothing here takes a string to parse: a conversation name has been checked
 * before it gets here, and it is checked again, because this is where it
 * turns into a command. */
import { execFile } from 'node:child_process';
import { isConversationName } from './names.mjs';

export const IMAGE = '24.04';
export const DISK_GB = 8;
/* Where the tool starts, in its VM. At the root rather than in a home
   directory: the path then names nobody, and sits next to /resources. */
export const WORK = '/work';
export const VM_USER = 'ubuntu';
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
    /* `run(argv, options)` reaches the VM manager; `prefix` is the same route
       as an argument vector, for the one caller that needs a terminal. */
    constructor(run, prefix) { this.run = run; this.prefix = prefix; }

    launch(conversation, memoryMb) {
        return this.run(['launch', IMAGE, '--name', vmName(conversation), '--memory', `${memoryMb}M`,
            '--disk', `${DISK_GB}G`, '--cpus', '1', '--timeout', String(LAUNCH_SECONDS)], { timeoutMs: (LAUNCH_SECONDS + 60) * 1000 });
    }

    exec(conversation, argv, options) {
        return this.run(['exec', vmName(conversation), '--', ...argv], options);
    }

    /* What a terminal attaches to: the same `exec`, as an argument vector. */
    execArgv(conversation, argv) {
        return [...this.prefix, 'exec', vmName(conversation), '--', ...argv];
    }

    /* "Running", "Stopped", "Suspended", ... or undefined when there is no VM. */
    async state(conversation) {
        const name = vmName(conversation);
        const r = await this.run(['info', name, '--format', 'json']);
        if (r.code !== 0) return undefined;
        try { return JSON.parse(r.stdout).info?.[name]?.state; } catch { return undefined; }
    }

    start(conversation) { return this.run(['start', vmName(conversation)], { timeoutMs: 300_000 }); }
    stop(conversation) { return this.run(['stop', vmName(conversation)], { timeoutMs: 300_000 }); }
    suspend(conversation) { return this.run(['suspend', vmName(conversation)], { timeoutMs: 300_000 }); }
    remove(conversation) { return this.run(['delete', '--purge', vmName(conversation)], { timeoutMs: 300_000 }); }
}
