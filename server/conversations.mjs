/* THE LIFE OF A CONVERSATION: created, built, opened, left running, rested,
   archived. See blueprint/architecture.html, "When does a VM stop?".
 *
 *   - closing the page stops NOTHING: the tool keeps working in its VM;
 *   - once the tool has exited, the VM is stopped after a short delay;
 *   - Sleep is a button, never a guess: telling a long job from an idle tool
 *     cannot be done without reading the tool, and this server does not read.
 */
import { isConversationName, identifierFrom, titleProblem, groupProblem } from './names.mjs';
import { JsonFile } from './store.mjs';
import { attachCommand, SOCKET } from './tmux.mjs';
import { WORK, VM_USER, SHARING_STEP, stepLine, vmName } from './vm.mjs';
import { resumeOrFresh } from './tools.mjs';
import { TOOLS_PATH, LAUNCH } from './toolbox.mjs';
import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SESSION = 'main';
export const STOP_DELAY_MS = 60_000;
const STEP_MS = 15 * 60_000;
/* The door of a conversation in a shared machine (#221), put in the machine by the server. */
export const DOOR = new URL('../config/machine/clavarium-enter', import.meta.url);
/* The most programs one conversation may run in a shared machine. */
export const SHARED_PROCS = 1024;
/* A NEW SHARED MACHINE's memory (12-11, operator): chosen when it is made, 4 GB unless said; the conversations
   that live in it share it, each within its own limit. */
export const SHARED_MB = 4096;
/* Moving a work folder: what must stay free after it, and how long a copy may take. */
export const ROOM_MB = 1024;
/* A file shown straight from a machine's disk: where, and how large at most. */
const MACHINE_PATH = /^\/work(\/[A-Za-z0-9._@+%~-]+)+$/;
export const MACHINE_FILE_MAX = 5 * 1024 * 1024;
const MOVE_MS = 30 * 60_000;
/* A clean stop is given this long; then the machine is stopped by force. */
export const STOP_MS = 120_000;
/* What a conversation's machine may be given. Memory in megabytes, disk in
   gigabytes: a disk only ever grows (the VM manager cannot shrink one). */
export const MEMORY_MAX_MB = 16384;
export const DISK_MAX_GB = 256;
/* A machine is made with this disk (DISK in deploy/clavarium-host). */
export const DISK_GB = 8;
/* Repairs made once on machines built before they were part of the recipe
   (see tools.mjs, "npm-writable"): the number goes up when one is added. */
export const FIXES = 1;
/* A machine the VM manager is starting already is waited for this long. */
export const STARTING_MS = 180_000;
/* A machine just started is asked to answer for this long before a terminal is opened into it. */
export const ANSWER_MS = 90_000;
/* What the folders of a machine just started are waited for, at most, before its tool starts. */
const MOUNTED_MS = 30_000;
/* How long a stop waits for folders being mounted (six folders took a minute on a real host). */
const CALM_MS = 180_000;
const POLL_MS = 2000;
/* The tool's screen not drawn this long after its terminal was opened: its
   start is said to be over all the same (the page then opens it itself). */
export const DRAWN_MS = 15_000;
/* Asked of a machine to know that it answers: a command that does nothing (and no install step uses). */
export const ANSWER_PROBE = Object.freeze(['test', '-d', '/']);

/* An error whose message is meant for the person, and safe to show.
   `retry`: what was refused may work in a moment, by itself (a machine
   that is starting): the page tries again without being asked. */
/* The name a chat gives its tool, at most. */
export const CHAT_NAME_MAX = 40;
/* WHAT AN OWNER DOES TO A MACHINE (machineAction, 09-11): start it, stop it, restart it, put it to
   sleep, or force it off as a power cut would. One at a time per machine; Force stop takes the place
   of any other. */
export const MACHINE_KINDS = Object.freeze(['start', 'stop', 'restart', 'sleep', 'force']);
/* How long each step is given (seconds), as the host program bounds it: past it, the page offers
   "Force now", which moves on to the next step. */
export const STEP_LIMITS = Object.freeze({ polite: 60, force: 30, term: 5, kill: 5, check: 10, start: 180, suspend: 120, resleep: 300, stop: 120 });
/* The way down, in order (the host program's `vm halt`), and the step "Force now" moves on to. */
const DOWN = ['polite', 'force', 'term', 'kill', 'check'];
const NEXT = Object.freeze({ polite: 'force', force: 'term', term: 'kill' });
/* Each step in words, for the journal and the chat (the page has its own, web/app.js). */
const STEP_WORDS = Object.freeze({ polite: 'polite stop', force: 'forced stop', term: 'SIGTERM', kill: 'SIGKILL', check: 'check', start: 'start', suspend: 'sleep', resleep: 'wake and sleep again', stop: 'clean stop' });
const KIND_DOING = Object.freeze({ start: 'starting', stop: 'stopping', restart: 'restarting', sleep: 'going to sleep', force: 'being forced off', resize: 'being resized', move: 'moving to a shared machine' });
/* THE WATCHDOG of a machine (watchdog.mjs), as its owner set it: on, with how long it may stay mute or
   full before it is forced off and started again. The defaults, and what may be chosen (minutes). */
export const WATCHDOG_DELAY_MIN = 60;
export const WATCHDOG_MIN = 10;
export const WATCHDOG_MAX = 24 * 60;
const KIND_WORDS = Object.freeze({ start: ['Started', 'Not started'], stop: ['Stopped', 'Not stopped'], restart: ['Restarted', 'Not restarted'], sleep: ['Asleep', 'Not asleep'], force: ['Stopped by force', 'Not stopped by force'], resize: ['Resized', 'Not resized'] });

export class Refusal extends Error {
    constructor(status, message, { retry = false } = {}) { super(message); this.status = status; if (retry) this.retry = true; }
}

/* A machine built: it starts, is prepared, gets its tool, its folders, and
   the tool starts -- a new disk holds no session to take up. */
const buildProgress = (since) => ({ kind: 'build', steps: ['starting', 'preparing', 'installing', 'folders', 'tool'], at: 0, since, stepSince: since });

/* What a machine has, in words: what its record says, else what was asked (`asked`). */
const sizeSaid = (c, asked = {}) => {
    const cpus = c?.cpus ?? asked.cpus;
    return `${c?.memoryMb ?? asked.memoryMb} MB of memory, ${cpus} core${cpus > 1 ? 's' : ''}, ${c?.diskGb ?? asked.diskGb} GB of disk`;
};

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Conversations {
    #layout; #store; #vms; #tools; #stopDelayMs; #timers = new Map(); #watching = new Map(); #fresh = new Set(); #mountAgain = new Set(); #holding = new Set(); #borrowed = new Set(); #uid; #gid;
    /* THE ONE ACTION RUNNING ON EACH MACHINE (machineAction), by name: a start, a stop, a restart, a
       sleep, a resize, a force stop. A second one is refused while it runs; Force stop ends it and
       takes its place. */
    #acts = new Map();
    /* Set by the server: an action's outcome, in words -- written in the journal (events.mjs), and
       said in its chat when `chat` (a restart says it already, through `renewed`). */
    machineSaid = () => {};
    /* Set by the server: prepares the VM before the tool is attached, and
       names the program the tool is started through. See secrets.mjs. */
    prepare = async () => {};
    /* (name, file) -> '' when the launcher of its tool is in its machine (toolbox.mjs, launcherIn). */
    launcherReady = async () => '';
    through = [];
    /* Set by the server: closes at once a terminal kept open for a screen
       that might come back. Called before a machine is slept, stopped or deleted. */
    drop = () => {};
    /* Set by the server: told when a conversation has just become usable. */
    ready = () => {};
    /* Set by the server: the ready-made machine to copy for a tool, or
       undefined for the long way. See shelf.mjs. */
    shelf = { pick: () => undefined };
    /* Set by the server: makes sure the folders of a machine that has just
       started are there, and waits for it -- mounted again first (`again`)
       when it was just built, restarted or its work moved; otherwise only
       looked at, and put back if they came loose (health.mjs). */
    mounted = async () => {};
    /* Set by the server: what is being done to its machine's folders just
       now (a look of health.mjs that may mount one again), or null. */
    quiet = () => null;
    /* Folders being mounted again after a start, by name: a stop waits for
       them (#calm). Stopping a machine while the VM manager mounts a folder
       in it was seen to hang the VM manager itself, for every machine. */
    #mounting = new Map();
    /* A size kept for its wake being applied, by name: a second opening waits
       for it, and a restart, a resize or a move is refused meanwhile. */
    #resizing = new Map();
    /* Set by the server: told when its machine was restarted or built again
       by this server, in words for its chat, and whether the tool runs again
       (its chat says it, and the tool is told to read it again: talk.mjs). */
    renewed = () => {};
    /* Set by the server: throws a Refusal, in words, when creating, starting
       or growing a machine would leave this server less than its reserve
       (capacity.mjs). `{ kind: 'create'|'start'|'grow', name, memoryMb, diskMb }`. */
    room = async () => {};
    /* Set by the server: a COPY's work folder made from its original's (host side, its own files only), and the
       accesses of the original given to the copy (copy, below). */
    copyWork = async () => {};
    copyRights = async () => {};

    /* `uid`/`gid`: the account this server runs as; files the tool writes in
       its kept work folder belong to it on the host. */
    #startingMs; #answerMs; #pollMs;
    constructor({ store, vms, tools, layout = new JsonFile(undefined, {}), stopDelayMs = STOP_DELAY_MS, uid = process.getuid(), gid = process.getgid(), startingMs = STARTING_MS, answerMs = ANSWER_MS, pollMs = POLL_MS }) {
        this.#layout = layout; this.#store = store; this.#vms = vms; this.#tools = tools; this.#stopDelayMs = stopDelayMs; this.#uid = uid; this.#gid = gid;
        this.#startingMs = startingMs; this.#answerMs = answerMs; this.#pollMs = pollMs;
        /* A build interrupted by a restart of this server cannot be resumed
           blindly: it is marked failed, and says so. */
        for (const c of store.all()) {
            /* A move cut short leaves the machine as it was at that moment:
               it is said, with where to look, rather than guessed at. */
            if (c.phase === 'moving') store.patch(c.name, { phase: 'ready', step: undefined, moved: 'The server restarted while the work folder was being moved. The files are safe, in the machine: look at /work, /work.before-move and /work.moving.' });
            if (c.phase === 'building') store.patch(c.name, { phase: 'failed', error: 'The server restarted while this conversation was being built. Build it again, or archive it.' });
            if (c.phase === 'restarting') store.patch(c.name, { phase: 'ready', step: undefined, restartingSince: undefined, restarted: 'The server restarted while this machine was being restarted: look at its state, and restart it again if needed.' });
            /* An action cut short: said as such, never left running on the page. */
            if (store.get(c.name)?.machine) store.patch(c.name, { machine: undefined, machineReport: { kind: c.machine.kind, ok: false, cut: true, at: new Date().toISOString(), steps: (c.machine.steps ?? []).filter((x) => x.state !== 'todo').map(({ id, state, s }) => ({ id, result: state === 'run' ? 'cut' : state, ...(s !== undefined ? { s } : {}) })), advice: 'look', said: 'The server restarted during this action: look at its state.' } });
            /* Nothing of a start is going on any more: a page must not wait for it. */
            if (store.get(c.name)?.progress) store.patch(c.name, { progress: undefined });
        }
    }

    /* WHERE A START IS, FOR THE PAGE: a build, a restart (or a new size), a
     * wake. `progress` on the record: { kind, steps, at, since, stepSince,
     * detail }. `steps` are names the page puts in words (web/app.js); `at`
     * only goes forward. The steps run all the way to the tool: its machine
     * stops, starts, answers, its folders are there, the tool starts -- and
     * takes up its last session, a step of its own, when it does. What the
     * VM manager says of the machine moves it on (#watched), never what the
     * tool prints. It ends when the tool's screen is drawn (`attached`), or
     * when the start fails. */
    #begin(name, kind, steps, since = new Date().toISOString()) {
        this.#store.patch(name, { progress: { kind, steps, at: 0, since, stepSince: new Date().toISOString() } });
    }
    #reach(name, id, detail) {
        const p = this.#store.get(name)?.progress;
        const at = p ? p.steps.indexOf(id) : -1;
        if (at < 0 || at < p.at || (at === p.at && detail === p.detail)) return;
        this.#store.patch(name, { progress: { ...p, at, stepSince: at === p.at ? p.stepSince : new Date().toISOString(), detail } });
    }
    /* The steps from the tool's own on, once what the tool will do is known. */
    #tail(name, tail) {
        const p = this.#store.get(name)?.progress;
        const from = p ? p.steps.findIndex((id) => id === 'tool' || id === 'back') : -1;
        if (from < 0) return;
        this.#store.patch(name, { progress: { ...p, steps: [...p.steps.slice(0, from), ...tail] } });
    }
    #end(name) { if (this.#store.get(name)?.progress) this.#store.patch(name, { progress: undefined }); }
    /* Told by the server: the tool's screen is being drawn (or did not come
       in time). Its start is over. */
    attached(name) { this.#end(name); }
    /* SOMEBODY USED IT (typed in its terminal): when, for the list (Recent), at most once a minute. */
    touch(name) {
        const c = this.#store.get(name);
        if (!c || (c.lastActiveAt && Date.now() - new Date(c.lastActiveAt).getTime() < 60_000)) return;
        this.#store.patch(name, { lastActiveAt: new Date().toISOString() });
    }

    /* WHAT THE TOOL DOES AT ITS NEXT START, as the step after "The tool
       starts": takes up its last session ('resume'), starts a new one as its
       owner chose ('fresh'), or starts one because none was ever made on this
       disk ('first': known only when this server built the disk and never
       started the tool on it; a record older than that knowledge is said
       'fresh', which is what happens). None for a tool that cannot resume.
       Whether the tool, told to resume, finds a session of its own cannot
       be known here: it is said 'resume'. Mirrors #command. */
    #resumeStep(c, tool) {
        if (!tool?.resume) return [];
        if (c.resume === false) return ['fresh'];
        if (c.toolStarted === true) return ['resume'];
        return [c.toolStarted === false ? 'first' : 'fresh'];
    }

    /* Polls the VM manager's state while `work` (a start or a stop this
       server launched: `how`) runs: only questions, which never wake or
       disturb a machine. What it says moves the steps on: a machine seen
       running before its start command returned is waited for to answer. */
    async #watched(name, how, work) {
        let done = false;
        void (async () => {
            while (!done) {
                await new Promise((r) => { setTimeout(r, this.#pollMs).unref?.(); });
                if (done) return;
                const state = await this.#vms.state(name).catch(() => undefined);
                if (done) return;
                if (how === 'stop' && (state === 'Stopping' || state === 'Suspending')) this.#reach(name, 'stopping');
                if (how === 'start' && state === 'Running') this.#reach(name, 'answering');
            }
        })();
        try { return await work; } finally { done = true; }
    }

    /* `resumes`: the tool can take up its last session when it starts (`resume` in config/tools.json). */
    /* `rights`: it can be started with every right in its machine (`rights` in config/tools.json). */
    /* `ai`: an agent that reads instructions (`instructions`), not a bare terminal. */
    tools() { return this.#tools.map(({ id, label, memoryMb, resume, rights, instructions }) => ({ id, label, memoryMb, resumes: Boolean(resume), rights: Boolean(rights), ai: Boolean(instructions) })); }

    /* The sign-in rules of a conversation's tool, or undefined. */
    signinRules(name) { return this.#tools.find((t) => t.id === this.#store.get(name)?.tool)?.signin; }

    /* THE ORDER OF THE LIST, the same on every device: the conversations
     * (one order; a folder shows its own in it) and the folders. Kept in a
     * file of its own; what is not in it (made before, or by an older
     * version) comes after, in the order it was made. A folder is only a
     * word on its conversations: with none left, it is gone. */
    #order() {
        const all = this.#store.all();
        const names = new Set(all.map((c) => c.name));
        const kept = this.#layout.get();
        const order = [...new Set((Array.isArray(kept.order) ? kept.order : []).filter((n) => names.has(n)))];
        for (const c of all) if (!order.includes(c.name)) order.push(c.name);
        const present = [...new Set(all.map((c) => c.group).filter(Boolean))];
        const groups = [...new Set((Array.isArray(kept.groups) ? kept.groups : []).filter((g) => present.includes(g)))];
        for (const g of present) if (!groups.includes(g)) groups.push(g);
        return { order, groups };
    }
    #keepOrder({ order, groups }) { this.#layout.set({ order, groups }); }

    list() {
        const { order, groups } = this.#order();
        return this.#store.all().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)).map((c) => {
            const tool = this.#tools.find((t) => t.id === c.tool);
            /* An AI tool has an instruction file; a shell has none: what is dictated there is never marked. */
            return { ...c, rank: order.indexOf(c.name), ...(c.group ? { groupRank: groups.indexOf(c.group) } : {}), toolLabel: tool?.label ?? c.tool, memoryMinMb: tool?.memoryMb, resumes: Boolean(tool?.resume), rights: Boolean(tool?.rights), ai: Boolean(tool?.instructions), voiceMark: Boolean(tool?.instructions) && c.voiceMark !== false, cpus: c.cpus ?? 1, hostCpus: availableParallelism() };
        });
    }

    get(name) { return this.#store.get(name); }

    /* Whether a new machine may be made for this request: what `create`
       checks, and the server's room (capacity.mjs). Asked before `create`. */
    async admit({ name, title, tool, memoryMb, machine, machineMb } = {}) {
        if (!name && typeof title === 'string' && !titleProblem(title)) ({ name } = this.#naming({ title }));
        /* Into a shared machine that is there already: no new machine, no room asked for it. */
        if (typeof machine === 'string' && this.#machineMbOf(machine) !== undefined) return;
        const chosen = this.#tools.find((t) => t.id === tool);
        /* What `create` refuses anyway is said by `create`. */
        if (!chosen || !isConversationName(name) || this.#store.get(name)) return;
        /* A new shared machine: the room it takes is its own size, not the conversation's. */
        const memory = typeof machine === 'string' ? (machineMb ?? SHARED_MB) : (memoryMb ?? chosen.memoryMb);
        if (!Number.isInteger(memory)) return;
        await this.room({ kind: 'create', memoryMb: memory });
    }

    /* `workOnDisk`: the tool works on its machine's own disk instead of in a
       folder kept by the server. Faster for a large code project; but what
       it makes is then not seen from the page, and goes with the machine. */
    /* A conversation is made from the name a person reads (`title`), its
       identifier drawn from it, or from an identifier alone (the advanced
       options, a blueprint). The identifier never changes afterwards. */
    #naming({ name, title }) {
        if (title !== undefined) { const problem = titleProblem(title); if (problem) throw new Refusal(400, problem); }
        const id = name || (title !== undefined ? identifierFrom(title, (x) => Boolean(this.#store.get(x))) : name);
        return { name: id, title: title !== undefined && title !== id ? title : undefined };
    }

    /* The size of a shared machine: what its first conversation made it with (each of its conversations carries
       it); undefined while none lives in it. */
    #machineMbOf(machine) {
        const there = this.#store.all().filter((x) => x.sharedMachine === machine);
        if (!there.length) return undefined;
        return there.map((x) => x.machineMb).find(Number.isInteger) ?? Math.max(...there.map((x) => Number(x.memoryMb) || 0));
    }

    create({ name: given, title: read, tool, memoryMb, cpus, diskGb, workOnDisk, group, machine, machineMb }) {
        const { name, title } = this.#naming({ name: given, title: read });
        /* IN A SHARED MACHINE (#221), named: its work is always kept here (mounted into its place there). */
        if (machine !== undefined && (typeof machine !== 'string' || !isConversationName(machine))) throw new Refusal(400, 'A machine name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter.');
        if (machine !== undefined && machine === given) throw new Refusal(400, 'A shared machine has a name of its own, not a conversation\'s.');
        if (group !== undefined) { const problem = groupProblem(group); if (problem) throw new Refusal(400, problem); }
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        const chosen = this.#tools.find((t) => t.id === tool);
        if (!chosen) throw new Refusal(400, 'Unknown tool.');
        const memory = memoryMb ?? chosen.memoryMb;
        if (!Number.isInteger(memory) || memory < chosen.memoryMb || memory > 16384) {
            throw new Refusal(400, `This tool needs at least ${chosen.memoryMb} MB of memory.`);
        }
        /* Cores and disk, chosen at creation like the memory; their defaults when not given. */
        const cores = cpus ?? 1;
        if (!Number.isInteger(cores) || cores < 1 || cores > availableParallelism()) throw new Refusal(400, `Cores are 1 to ${availableParallelism()} (what this server has).`);
        const disk = diskGb ?? DISK_GB;
        if (!Number.isInteger(disk) || disk < DISK_GB || disk > DISK_MAX_GB) throw new Refusal(400, `Disk is ${DISK_GB} to ${DISK_MAX_GB} GB.`);
        /* Its shared machine's size: chosen when it is made (4 GB unless said), then the same for all in it; a
           conversation never asks more than its machine has. */
        let size;
        if (machine !== undefined) {
            const there = this.#machineMbOf(machine);
            size = there ?? machineMb ?? SHARED_MB;
            if (there === undefined && (!Number.isInteger(size) || size < 1024 || size > 16384)) throw new Refusal(400, 'A shared machine has 1024 to 16384 MB of memory.');
            if (memory > size) throw new Refusal(400, `The machine ${machine} has ${size} MB of memory: this conversation cannot have more (${memory} MB).`);
        }
        if (this.#store.get(name)) throw new Refusal(409, 'A conversation already has this name.');
        const now = new Date().toISOString();
        const conversation = { name, ...(title ? { title } : {}), ...(group ? { group } : {}), tool, memoryMb: memory, cpus: cores, diskGb: disk, fixed: FIXES, ...(machine ? { sharedMachine: machine, machineMb: size } : {}), work: workOnDisk === true && !machine ? 'disk' : 'kept', phase: 'building', step: 'Starting the machine', createdAt: now, buildingSince: now, progress: buildProgress(now) };
        /* A new one comes first in its folder (or first of those in none). */
        const { order, groups } = this.#order();
        this.#store.put(conversation);
        this.#keepOrder({ order: [name, ...order], groups: group && !groups.includes(group) ? [...groups, group] : groups });
        this.built = this.#build(name, chosen, memory);
        return conversation;
    }

    /* `again`: a machine built anew for a conversation that had one. */
    async #build(name, tool, memoryMb, again = false) {
        if (this.#store.get(name)?.sharedMachine) return this.#buildShared(name, tool, memoryMb);
        const fail = (what, r) => { this.#store.patch(name, { phase: 'failed', step: undefined, progress: undefined, error: `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}` }); };
        /* The size chosen at creation (stored by create, kept on a rebuild): launched with it, or, for a
           copy of a ready-made machine, brought to it while the copy is still stopped. */
        const made = this.#store.get(name);
        const diskGb = made?.diskGb ?? DISK_GB; const cpus = made?.cpus ?? 1;
        const custom = diskGb !== DISK_GB || cpus !== 1;
        /* A COPY OF THE READY-MADE MACHINE when there is one that holds this
           tool (see shelf.mjs): it only has to boot. Anything wrong with the
           copy -- an older VM manager without "clone", a copy that does not
           start -- and it is removed and the machine is built the long way,
           as if there were no shelf. */
        const from = this.shelf.pick(tool);
        let readyMade = false;
        if (from) {
            const cloned = await this.#vms.clone(name, from, memoryMb);
            if (cloned.code === 0 && custom) {
                /* Still stopped, like the memory the clone set: its cores, and its disk grown to the chosen size. */
                if (cpus !== 1) await this.#vms.setCpus(name, cpus).catch(() => {});
                if (diskGb !== DISK_GB) await this.#vms.setDisk(name, diskGb).catch(() => {});
            }
            const started = cloned.code === 0 ? await this.#vms.start(name) : cloned;
            readyMade = started.code === 0;
            if (!readyMade && await this.#vms.state(name, { fresh: true }) !== undefined) await this.#vms.remove(name);
            if (!this.#store.get(name)) return undefined; /* archived meanwhile */
        }
        if (!readyMade) {
            const launched = await this.#vms.launch(name, memoryMb, custom ? diskGb : undefined, custom ? cpus : undefined);
            if (launched.code !== 0) return fail('The machine did not start', launched);
        }
        this.#store.patch(name, { step: 'Preparing the machine', readyMade: readyMade || undefined });
        this.#reach(name, 'preparing');
        if (readyMade) {
            /* A copy's first start is a first start: it makes its own identity
               (host keys, network). Waited for, so that nothing below meets a
               machine half set up. Its answer is not judged: "done with
               warnings" is common and harmless. */
            await this.#vms.exec(name, ['cloud-init', 'status', '--wait'], { timeoutMs: STEP_MS });
        } else {
            /* What sharing a folder needs inside the VM, put there NOW. Left to
               the first attachment, it made that one take over a minute -- longer
               than the edge waits for an answer, so the page said "failed" about
               an attachment that then succeeded (seen by a tester). */
            const sharing = await this.#vms.exec(name, [...SHARING_STEP], { timeoutMs: STEP_MS });
            if (sharing.code !== 0) return fail('The machine could not be prepared for shared folders', sharing);
        }
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
        /* The tool came with the copy: one look that it is there, and the
           step is passed. Not there after all: installed the usual way. */
        let installed = false;
        if (readyMade) {
            this.#store.patch(name, { step: `Installing ${tool.label} (already on the machine)` });
            this.#reach(name, 'installing', 'came');
            installed = tool.steps.length === 0 || (await this.#vms.exec(name, ['which', tool.command[0]])).code === 0;
        }
        for (const [i, step] of (installed ? [] : tool.steps).entries()) {
            if (!this.#store.get(name)) return undefined; /* archived meanwhile */
            this.#store.patch(name, { step: `Installing ${tool.label} (${i + 1}/${tool.steps.length})` });
            this.#reach(name, 'installing', `${i + 1}/${tool.steps.length}`);
            const r = await this.#vms.exec(name, step.argv, { input: step.input, timeoutMs: STEP_MS });
            if (r.code !== 0) return fail(`Installing ${tool.label} failed at step ${i + 1}`, r);
        }
        /* A new disk holds no session of the tool: its first start is a plain
           one (`false`: known, as opposed to a record made before this was kept). */
        /* A copy being made (copy): built, but not usable until its work and its state are in. */
        if (this.#holding.has(name)) { this.#store.patch(name, { step: 'Copying', toolStarted: false }); this.#fresh.add(name); this.#mountAgain.add(name); return undefined; }
        this.#store.patch(name, { phase: 'ready', step: undefined, buildingSince: undefined, toolStarted: false });
        this.#reach(name, 'folders');
        /* A machine that has just been built holds nothing of what was put
           in the one before it: the next opening prepares it from nothing.
           (Without this, a machine built again started with no runner, and
           its tool "exited" at once -- caught by an end-to-end test.) */
        this.#fresh.add(name);
        this.#mountAgain.add(name);
        this.ready(name);
        if (again) this.renewed(name, 'Its machine was built again: what was on its own disk is gone, its work folder and this chat are kept. The tool started again.', true);
        return undefined;
    }

    /* A CONVERSATION IN A SHARED MACHINE (#221): the machine made by the first one that lives in it (its door
       installed), started if it sleeps; then this one's place in it -- told to the host, its own user made by its
       door, its work mounted there for that user, its tool installed (what runs as root for the machine, the rest
       as its user). The same end as a machine of its own: ready, its tool started by the next opening. */
    async #buildShared(name, tool, memoryMb) {
        const c = this.#store.get(name);
        const fail = (what, r) => { this.#store.patch(name, { phase: 'failed', step: undefined, progress: undefined, error: `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`, buildingSince: undefined }); return undefined; };
        let state = await this.#vms.state(name, { fresh: true }).catch(() => undefined);
        if (state === undefined) {
            this.#store.patch(name, { step: `Making the shared machine ${c.sharedMachine}` });
            const launched = await this.#vms.launch(name, Number.isInteger(c.machineMb) ? c.machineMb : memoryMb);
            if (launched.code !== 0) return fail('The shared machine did not start', launched);
            const sharing = await this.#vms.execMachine(name, [...SHARING_STEP], { timeoutMs: STEP_MS });
            if (sharing.code !== 0) return fail('The shared machine could not be prepared for shared folders', sharing);
        } else if (state !== 'Running') {
            this.#store.patch(name, { step: `Starting the shared machine ${c.sharedMachine}` });
            const started = await this.#vms.start(name);
            if (started.code !== 0) return fail('The shared machine did not start', started);
        }
        /* Its door, always the one of this version (put again: an older one is replaced). The page's steps follow
           (preparing, installing): a new shared machine takes minutes, never one frozen "Starting". */
        this.#reach(name, 'preparing');
        this.#store.patch(name, { step: `Opening its door in the shared machine ${c.sharedMachine}` });
        const door = await this.#vms.execMachine(name, ['sudo', '-n', 'install', '-m', '0755', '-o', 'root', '-g', 'root', '/dev/stdin', '/usr/local/sbin/clavarium-enter'], { input: readFileSync(DOOR, 'utf8'), timeoutMs: STEP_MS });
        if (door.code !== 0) return fail('The door of the shared machine could not be put in place', door);
        this.#store.patch(name, { step: 'Making its place in the shared machine' });
        const told = await this.#vms.share(name);
        if (told.code !== 0) return fail('The host did not take it into the shared machine', told);
        const me = await this.#vms.execMachine(name, ['sudo', '-n', 'clavarium-enter', name, '--', 'sh', '-c', 'id -u; id -g'], { timeoutMs: STEP_MS });
        const [uid, gid] = String(me.stdout ?? '').trim().split('\n').map(Number);
        if (me.code !== 0 || !Number.isInteger(uid) || !Number.isInteger(gid)) return fail('Its own user could not be made', me);
        this.#store.patch(name, { machineUser: { uid, gid } });
        /* Its limits, read by its door at each entry: the memory chosen for it, and a bound on its programs -- one
           conversation that runs away never takes the machine from the others. */
        const limits = await this.#vms.execMachine(name, ['sudo', '-n', 'install', '-D', '-m', '0644', '-o', 'root', '-g', 'root', '/dev/stdin', `/etc/clavarium/limits/${name}`],
            { input: `mem=${Number(c.memoryMb) || tool.memoryMb}\nprocs=${SHARED_PROCS}\n`, timeoutMs: STEP_MS });
        if (limits.code !== 0) return fail('Its limits could not be set in the shared machine', limits);
        const kept = await this.#vms.workMake(name);
        const shown = kept.code === 0 ? await this.#vms.workMount(name, this.#uid, this.#gid) : kept;
        if (shown.code !== 0) return fail('The work folder could not be shown in the shared machine', shown);
        /* Its tool: there already (another conversation installed it), or installed -- a step as root for the
           machine, any other as its own user (its settings, in its home). */
        const there = tool.steps.length === 0 || (await this.#vms.exec(name, ['sh', '-c', `command -v ${tool.command[0]}`])).code === 0;
        /* There already: its own steps still (its settings, in its own home), the machine's not. */
        const steps = there ? tool.steps.filter((s) => s.argv[0] !== 'sudo') : tool.steps;
        this.#reach(name, 'installing', there ? 'came' : undefined);
        for (const [i, step] of steps.entries()) {
            if (!this.#store.get(name)) return undefined;
            this.#store.patch(name, { step: `Installing ${tool.label} (${i + 1}/${steps.length})` });
            this.#reach(name, 'installing', `${i + 1}/${steps.length}`);
            const r = await this.#vms.exec(name, step.argv, { input: step.input, timeoutMs: STEP_MS });
            if (r.code !== 0) return fail(`Installing ${tool.label} failed at step ${i + 1}`, r);
        }
        if (this.#holding.has(name)) { this.#store.patch(name, { step: 'Copying', toolStarted: false }); this.#fresh.add(name); this.#mountAgain.add(name); return undefined; }
        this.#store.patch(name, { phase: 'ready', step: undefined, buildingSince: undefined, toolStarted: false });
        this.#reach(name, 'folders');
        this.#fresh.add(name);
        this.#mountAgain.add(name);
        this.ready(name);
        return undefined;
    }

    /* Builds the machine of a conversation AGAIN: after a build that failed,
       or when the machine is gone (a backup put back on a new computer brings
       the conversation's name, tool and folders, not its machine). What was
       on the old machine's disk is not brought back: nothing here can.
       A conversation that has a working machine is refused -- this is not a
       reset button. */
    /* `reset` (01-11, its owner's ask, confirmed by typing its name): a working machine too -- deleted with
       everything on it and its work files, and built anew; its settings and what is attached to it stay. */
    async rebuild(name, { reset = false } = {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase === 'building' && !reset) throw new Refusal(409, 'This conversation is still being built.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool) throw new Refusal(400, 'The tool of this conversation is no longer offered.');
        const state = await this.#vms.state(name, { fresh: true });
        if (state !== undefined && c.phase !== 'failed' && !reset) throw new Refusal(409, 'This conversation has its machine: there is nothing to build again.');
        /* A reset replaces its own machine: the room it takes is given back first. */
        if (!(reset && state !== undefined)) await this.room({ kind: 'create', name, memoryMb: c.memoryMb });
        this.#cancelStop(name);
        this.drop(name);
        /* Marked first: two requests cannot both start a build. */
        const now = new Date().toISOString();
        this.#store.patch(name, { phase: 'building', step: 'Starting the machine', error: undefined, asleep: false, buildingSince: now, progress: buildProgress(now) });
        this.built = (async () => {
            /* What a failed build left behind is cleared away first; a reset, its files too. */
            if (state !== undefined) await this.#vms.remove(name);
            if (reset && c.work === 'kept') await this.#vms.workErase(name);
            return this.#build(name, tool, c.memoryMb, true);
        })();
        return this.#store.get(name);
    }

    /* What a terminal must run to reach this conversation. Wakes the VM first. */
    async open(name, say = () => {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, c.phase === 'building' ? 'This conversation is still being built.' : c.phase === 'moving' ? 'This conversation is moving its work folder.' : 'This conversation could not be built.');
        /* Being stopped, put to sleep or forced off: not woken under it; the page tries again after. */
        const acting = this.#acts.get(name);
        if (acting && ['stop', 'force', 'sleep', 'start'].includes(acting.kind)) throw new Refusal(409, 'Its machine is being changed: wait for the end of it.', { retry: true });
        this.#cancelStop(name);
        /* Opening is the explicit gesture that ends a sleep, or a stop its owner asked for. */
        if (c.asleep) this.#store.patch(name, { asleep: false });
        if (c.stopped) this.#store.patch(name, { stopped: undefined });
        this.#watching.set(name, (this.#watching.get(name) ?? 0) + 1);
        /* Another screen is applying the size kept for its wake: this one opens once it is over. */
        await this.#resizing.get(name)?.catch(() => {});
        /* A start that fails here ends what the page was shown of it: the
           page then opens the terminal itself, and says what went wrong. */
        try { return await this.#opening(name, c, say); } catch (error) { this.#end(name); throw error; }
    }

    async #opening(name, c, say) {
        const tool = this.#tools.find((t) => t.id === c.tool);
        /* Each step reached is told to the screen that opens, with the steps
           (the record has them too, for any other page). */
        const tell = (text) => say(text, this.#store.get(name)?.progress);
        let state = await this.#vms.state(name, { fresh: true });
        if (state === undefined) { this.left(name); throw new Refusal(410, 'The machine of this conversation no longer exists.'); }
        /* What a wake goes through, unless a build or a restart is already
           being told. From sleep, its tool is most likely there as it was
           (sleep is offered while it runs): looked at once it answers. */
        const waking = (first) => { if (!this.#store.get(name)?.progress) this.#begin(name, 'wake', [first, 'answering', 'folders', ...(first === 'waking' ? ['back'] : ['tool', ...this.#resumeStep(c, tool)])]); };
        /* STARTED ALREADY BY SOMEBODY ELSE -- the VM manager, after the host
           restarted: it is waited for, not started a second time (which the
           VM manager refuses, and the page used to stay on an error). */
        if (state === 'Starting' || state === 'Restarting') {
            waking('starting');
            tell('Its machine is starting...');
            state = await this.#until(name, (s) => s !== 'Starting' && s !== 'Restarting', this.#startingMs);
            if (state === 'Starting' || state === 'Restarting') { this.left(name); throw new Refusal(504, 'Its machine is still starting.', { retry: true }); }
            this.#reach(name, 'answering');
        }
        /* A NEW SIZE WAS CHOSEN WHILE IT SLEPT: applied now, before anything
           else; it runs after, with the new size or, failing that, the old. */
        let resized = false;
        if (this.#store.get(name)?.sizeAtWake) {
            const applying = this.#wakeResized(name, c, tool, state, tell);
            this.#resizing.set(name, applying);
            try { state = await applying; } catch (error) { this.left(name); throw error; }
            finally { this.#resizing.delete(name); }
            resized = true;
        }
        const stopped = state !== 'Running';
        /* Asleep, its memory was kept: the tool may still be there, as it was. */
        const asleep = state === 'Suspended';
        let woke = this.#fresh.delete(name) || stopped || resized;
        if (stopped) {
            try { await this.room({ kind: 'start', name, memoryMb: c.memoryMb }); } catch (error) { this.left(name); throw error; }
            waking(asleep ? 'waking' : 'starting');
            tell('Waking the machine...');
            const started = await this.#watched(name, 'start', this.#vms.start(name));
            if (started.code !== 0) {
                this.left(name);
                /* Starting meanwhile, after all: the page tries again by itself. */
                const now = await this.#vms.state(name).catch(() => undefined);
                throw new Refusal(502, `The machine did not wake: ${firstLine(started.stderr)}`, { retry: now === 'Starting' || now === 'Running' });
            }
            woke = true;
        }
        /* JUST STARTED: it runs before it answers (its system is still coming
           up). A terminal opened before it answers fails, and the tool would
           be said to have exited: it is asked first, a few times. */
        if (woke) {
            this.#reach(name, 'answering'); tell();
            if (!(await this.#answers(name))) { this.left(name); throw new Refusal(504, 'Its machine runs but does not answer yet.', { retry: true }); }
        }
        /* ITS FOLDERS: mounted again after a build, a restart or a move;
           after a wake, looked at (and put back if they came loose). Waited
           for, within a bound: the tool starts in them. */
        const again = this.#mountAgain.delete(name);
        if (again || stopped) {
            this.#reach(name, 'folders'); tell();
            const mounting = Promise.resolve().then(() => this.mounted(name, again)).catch(() => {});
            this.#mounting.set(name, mounting);
            void mounting.finally(() => { if (this.#mounting.get(name) === mounting) this.#mounting.delete(name); });
            await Promise.race([mounting, new Promise((r) => { setTimeout(r, MOUNTED_MS).unref?.(); })]);
        }
        /* Woken from sleep: its tool is still there when its session is. */
        if (asleep) {
            const kept = (await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'has-session', '-t', `=${SESSION}`], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }))).code === 0;
            if (!kept) this.#tail(name, ['tool', ...this.#resumeStep(c, tool)]);
        }
        this.#reach(name, 'tool'); this.#reach(name, 'back'); tell();
        /* `woke` tells the preparation that the machine has just started:
           whatever was put in its memory before is gone. */
        try { await this.prepare(name, woke); }
        catch (error) { this.left(name); throw error; }
        /* A machine built before a repair was part of the recipe gets it
           once, beside the opening, not in its way. */
        if ((c.fixed ?? 0) < FIXES && tool.fixups.length > 0) void this.#fixup(name, tool);
        /* Its launcher, in /tools: repaired if missing; not there, the tool does not start. */
        if (tool.launch) {
            const why = await this.launcherReady(name, tool.launch).catch((error) => error.message || 'not there');
            if (why) { this.left(name); throw new Refusal(503, `Its tool cannot start: ${why}. Try again.`, { retry: true }); }
        }
        const argv = this.#vms.execArgv(name, attachCommand(SESSION, [...this.through, ...this.#command(name, tool)], WORK));
        for (const id of ['resume', 'fresh', 'first']) this.#reach(name, id);
        tell();
        return argv;
    }

    /* THE SIZE KEPT FOR ITS WAKE, APPLIED as it wakes. Taken out of its
     * record first: it is tried once, and its outcome said either way.
     *   1. this server's reserve, looked at again (what is free may have
     *      changed since it was chosen); refused, it wakes as it was;
     *   2. asleep, it is woken first: a machine asleep cannot be stopped
     *      cleanly, and a stop by force would lose what its memory holds;
     *   3. stopped cleanly (by force if that hangs), set, started (#cycle);
     *   4. not running after that, what was set is put back where it can be
     *      (a disk never shrinks) and it is started again: never left stopped.
     * Said in Settings (`restarted`) and in its chat. The tool is started by
     * the opening, which takes up its last session, as after any restart.
     * Resolves with the state of its machine. */
    async #wakeResized(name, c, tool, state, tell) {
        const want = this.#store.get(name).sizeAtWake;
        this.#store.patch(name, { sizeAtWake: undefined, restarted: undefined });
        const had = { memoryMb: c.memoryMb, cpus: c.cpus ?? 1, diskGb: c.diskGb ?? DISK_GB };
        try { await this.#roomAtWake(name, had, want, state, true); } catch (error) {
            const why = error instanceof Refusal ? error.message : 'the room of this server could not be looked at.';
            this.#store.patch(name, { restarted: `Not changed as it woke: ${why} It kept ${sizeSaid(had)}.` });
            try { this.renewed(name, `Its machine was not changed as it woke: ${why} It kept ${sizeSaid(had)}.`, false); } catch { /* told, nothing more */ }
            return state;
        }
        this.#begin(name, 'wake', [...(state === 'Suspended' ? ['waking'] : []), ...(state === 'Stopped' ? [] : ['stopping']), 'setting', 'starting', 'answering', 'folders', 'tool', ...this.#resumeStep(c, tool)]);
        tell('Changing its machine as it wakes...');
        if (state === 'Suspended') await this.#watched(name, 'start', this.#vms.start(name)).catch(() => {});
        this.#reach(name, 'stopping'); tell();
        const set = [];
        let failure = await this.#cycle(name, c, this.#setter(name, c, want, (what) => set.push(what)), true);
        let now = await this.#vms.state(name).catch(() => undefined);
        if (now !== 'Running') {
            if (set.includes('memory')) await this.#vms.setMemory(name, had.memoryMb).catch(() => {});
            if (set.includes('cpus')) await this.#vms.setCpus(name, had.cpus).catch(() => {});
            const again = await this.#watched(name, 'start', this.#vms.start(name)).catch(() => ({ code: 1 }));
            now = await this.#vms.state(name).catch(() => undefined);
            if (again.code === 0 || now === 'Running') { this.#fresh.add(name); this.#mountAgain.add(name); }
            failure ??= 'the machine did not start.';
        }
        await this.reconcile(name);
        const said = sizeSaid(this.#store.get(name), had);
        const running = now === 'Running';
        this.#store.patch(name, { restarted: failure ? `Not changed as it woke: ${failure} It has ${said}.` : `Changed as it woke: it now has ${said}.` });
        try { this.renewed(name, failure ? `Its machine was not changed as it woke: ${failure} It has ${said}.` : `Its machine was restarted as it woke, with ${said}: the tool started again.`, running); } catch { /* told, nothing more */ }
        if (!running) throw new Refusal(502, `The machine did not wake: ${failure}`);
        return now;
    }

    /* This server's reserve, for a size kept for its wake: running, it holds
       its memory already; otherwise it takes all of it as it starts -- and
       its old size first, when it is woken to be stopped (`woken`). */
    async #roomAtWake(name, had, want, state, woken) {
        const growth = Math.max(0, want.diskGb - had.diskGb) * 1024;
        await this.room(state === 'Running'
            ? { kind: 'grow', name, memoryMb: Math.max(0, want.memoryMb - had.memoryMb), diskMb: growth }
            : { kind: 'start', name, memoryMb: woken && state === 'Suspended' ? Math.max(want.memoryMb, had.memoryMb) : want.memoryMb });
        if (state !== 'Running' && growth > 0) await this.room({ kind: 'grow', name, memoryMb: 0, diskMb: growth });
    }

    /* WHAT STARTS THE TOOL. Its last session is taken up (`resume` in
       config/tools.json: "claude --continue"...) unless the owner chose to
       start fresh -- but never at its very first start on a disk: there is no
       session yet, and not every tool says so quietly. Used only when its tmux
       session is made: a screen that comes back attaches to the tool as it is. */
    #command(name, tool) {
        const c = this.#store.get(name);
        const resume = tool.resume && c.resume !== false && c.toolStarted === true;
        if (c.toolStarted !== true) this.#store.patch(name, { toolStarted: true });
        /* Every right in its own machine, unless the owner chose to be asked
           first: added at EVERY start, a resume included (a tool does not
           keep it from its last session). */
        const rights = tool.rights ? (c.askFirst === true ? tool.rights.ask : tool.rights.full) : [];
        const run = resume ? resumeOrFresh([...tool.resume, ...rights], [...tool.command, ...rights]) : [...tool.command, ...rights];
        /* Through its launcher: told the rights chosen, it sets what the tool needs, then runs it. */
        return tool.launch ? ['sh', `${TOOLS_PATH}/${LAUNCH}/${tool.launch}`, c.askFirst === true ? 'ask' : 'full', ...run] : run;
    }

    /* Whether its tool asks before acting (true), or acts without asking in
       its machine (false, the default). From its next start. */
    setAskFirst(name, on) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say true (it asks before acting) or false (it acts without asking, in its machine).');
        this.#store.patch(name, { askFirst: on ? true : undefined });
        return this.#store.get(name);
    }

    /* THE NAME ITS CHAT GIVES ITS TOOL, above its messages: '' (none) for the
       neutral word of the dictionary ("Assistant"); never the tool's brand. */
    setChatName(name, given) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof given !== 'string') throw new Refusal(400, 'Give a name, or nothing for the neutral one.');
        const said = given.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, ' ').replace(/\s+/g, ' ').trim();
        if (said.length > CHAT_NAME_MAX) throw new Refusal(400, `${CHAT_NAME_MAX} characters at most.`);
        this.#store.patch(name, { chatName: said || undefined });
        return this.#store.get(name);
    }

    /* WHICH BINDER ITS CHAT SHOWS BESIDE IT (the side panel), the same on every device:
       '' for the automatic choice (the first binder of batches it was given), '-' for none,
       else a binder's id. Which binders it was given is Binder's: one it no longer has
       falls back to the automatic choice on the page. */
    setTasksBinder(name, given) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof given !== 'string' || given.length > 100 || !/^(|-|[a-z0-9][a-z0-9._-]*)$/.test(given)) throw new Refusal(400, 'Give a binder\'s id, "-" for none, or nothing for the automatic choice.');
        this.#store.patch(name, { tasksBinder: given || undefined });
        return this.#store.get(name);
    }

    /* THE NAME A PERSON READS, changed at any time; its identifier stays.
       Kept only when it differs from the identifier: a conversation made
       before free names is read by its identifier, and nothing is rewritten. */
    setTitle(name, title) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        const problem = titleProblem(title);
        if (problem) throw new Refusal(400, problem);
        this.#store.patch(name, { title: title === name ? undefined : title });
        return this.#store.get(name);
    }

    /* Hidden from the list, like a hidden file: it runs, keeps its rights,
       and is still in Access; the list says how many are hidden. */
    setHidden(name, on) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say true (hidden from the list) or false (shown).');
        this.#store.patch(name, { hidden: on ? true : undefined });
        return this.#store.get(name);
    }

    /* ITS FOLDER in the list ('' for none): first among those of that folder. */
    setGroup(name, group) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        const problem = groupProblem(group);
        if (problem) throw new Refusal(400, problem);
        if ((c.group ?? '') === group) return c;
        const { order, groups } = this.#order();
        this.#store.patch(name, { group: group || undefined });
        this.#keepOrder({ order: [name, ...order.filter((n) => n !== name)], groups: group && !groups.includes(group) ? [...groups, group] : groups });
        return this.#store.get(name);
    }

    /* A folder renamed, for all its conversations; to the name of another, they join it. */
    renameGroup(from, to) {
        const problem = groupProblem(to);
        if (problem) throw new Refusal(400, problem);
        if (!to) throw new Refusal(400, 'Give the new name of the folder.');
        const inside = this.#store.all().filter((c) => typeof from === 'string' && from && c.group === from);
        if (inside.length === 0) throw new Refusal(404, 'No such folder.');
        const { order, groups } = this.#order();
        for (const c of inside) this.#store.patch(c.name, { group: to });
        const renamed = groups.includes(to) ? groups.filter((g) => g !== from) : groups.map((g) => (g === from ? to : g));
        this.#keepOrder({ order, groups: renamed });
        return { renamed: inside.length, group: to };
    }

    /* One place up or down among the others of its folder (`to`: 'up' or 'down').
       A hidden one is passed over by one that is shown: it is not in sight. */
    move(name, to) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (to !== 'up' && to !== 'down') throw new Refusal(400, 'Say up or down.');
        const { order, groups } = this.#order();
        const byName = new Map(this.#store.all().map((x) => [x.name, x]));
        const peers = order.filter((n) => (byName.get(n).group ?? '') === (c.group ?? '') && (c.hidden === true || byName.get(n).hidden !== true || n === name));
        const at = peers.indexOf(name);
        const other = peers[to === 'up' ? at - 1 : at + 1];
        if (other === undefined) return { order: this.list().map((x) => x.name) };
        const i = order.indexOf(name); const j = order.indexOf(other);
        [order[i], order[j]] = [order[j], order[i]];
        this.#keepOrder({ order, groups });
        return { order };
    }

    /* A folder one place up or down among the folders. */
    moveGroup(group, to) {
        if (to !== 'up' && to !== 'down') throw new Refusal(400, 'Say up or down.');
        const { order, groups } = this.#order();
        const at = groups.indexOf(group);
        if (typeof group !== 'string' || at < 0) throw new Refusal(404, 'No such folder.');
        const j = to === 'up' ? at - 1 : at + 1;
        if (j >= 0 && j < groups.length) [groups[at], groups[j]] = [groups[j], groups[at]];
        this.#keepOrder({ order, groups });
        return { groups };
    }

    /* A whole order, as a drag and drop leaves it: names it does not know are
       left out, and those it forgets keep their places after the others. */
    setOrder({ order: wanted, groups: wantedGroups } = {}) {
        const { order, groups } = this.#order();
        const pick = (list, known) => {
            if (list === undefined) return known;
            if (!Array.isArray(list) || list.length > 10_000 || list.some((x) => typeof x !== 'string')) throw new Refusal(400, 'Give a list of names.');
            const chosen = [...new Set(list.filter((x) => known.includes(x)))];
            return [...chosen, ...known.filter((x) => !chosen.includes(x))];
        };
        const next = { order: pick(wanted, order), groups: pick(wantedGroups, groups) };
        this.#keepOrder(next);
        return next;
    }

    /* What is dictated into its terminal starts with a microphone sign, once
       per message (true, the default for a tool that is an AI), or not. */
    setVoiceMark(name, on) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say true (a microphone sign before what is dictated) or false.');
        this.#store.patch(name, { voiceMark: on ? undefined : false });
        return this.#store.get(name);
    }

    /* When its tool starts: its last session taken up (true, the default), or a new one. */
    setResume(name, on) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (typeof on !== 'boolean') throw new Refusal(400, 'Say true (take up its last session) or false (start a new one).');
        this.#store.patch(name, { resume: on ? undefined : false });
        return this.#store.get(name);
    }

    /* The state of its machine once `done(state)` holds, or as it is when the time is up. */
    async #until(name, done, ms) {
        const end = Date.now() + ms;
        for (;;) {
            const state = await this.#vms.state(name).catch(() => 'Unknown');
            if (done(state) || Date.now() >= end) return state;
            await new Promise((r) => setTimeout(r, this.#pollMs));
        }
    }

    /* Whether its machine answers a command, asked again for a while. */
    async #answers(name) {
        const end = Date.now() + this.#answerMs;
        for (;;) {
            if ((await this.#vms.exec(name, [...ANSWER_PROBE], { timeoutMs: 15_000 }).catch(() => ({ code: 1 }))).code === 0) return true;
            if (Date.now() >= end) return false;
            await new Promise((r) => setTimeout(r, this.#pollMs));
        }
    }

    /* A TERMINAL THAT DOES NOT COME, though its machine runs: asked by the
       page once it has waited. The channel kept open into it is closed (it
       is opened again by the next screen); the tool's tmux session is
       looked at: there and answering, it is kept as it is -- the tool goes on
       -- otherwise its tmux is stopped, and made again at the next opening.
       Refused, with why, when that cannot help: a machine that does not run,
       or does not answer. */
    async repairTerminal(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, 'Its machine is being changed: the terminal comes back by itself after.', { retry: true });
        const state = await this.#vms.state(name).catch(() => undefined);
        if (state !== 'Running') throw new Refusal(409, `Its machine is not running (${state ?? 'gone'}): it is started when the conversation is opened.`, { retry: state === 'Starting' });
        this.drop(name);
        const session = await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'list-panes', '-t', `=${SESSION}`], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }));
        if (session.code === 0) return { session: 'kept' };
        if ((await this.#vms.exec(name, [...ANSWER_PROBE], { timeoutMs: 10_000 }).catch(() => ({ code: 1 }))).code !== 0) throw new Refusal(502, 'Its machine does not answer: its terminal cannot be repaired from here.');
        await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'kill-server'], { timeoutMs: 10_000 }).catch(() => {});
        return { session: 'renewed' };
    }

    /* RESTARTS ONLY ITS TOOL (04-11), for a tool that asks to be restarted (to take up new tools): its
       machine is not touched -- a whole-machine restart may not start again, and a tool has no need of
       it. Its tmux is ended and the tool started again in its terminal (`ready`), taking up its last
       session, as after any start. A machine that does not run is left as it is: its next opening starts
       the tool anyway. Resolves with whether the tool was restarted. */
    async restartTool(name) {
        this.#busyCheck(name);
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') return false;
        this.drop(name);
        await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'kill-server'], { timeoutMs: 10_000 }).catch(() => {});
        this.ready(name);
        return true;
    }

    /* CARRIED ELSEWHERE (11-11, #351): what the conversation is beyond /work -- its tool's state, where its
       entry in config/tools.json says it is (`state.keep`, without `state.skip`) -- as one .tar.gz streamed
       from its machine, a manifest first (clavarium-conversation.json: its tool, its name, its size). Nothing
       of the tool is known here: any tool that says where its state is can be exported, imported, moved.
       The machine must run (its home is in it). -> { name: the file's name, stream } */
    async exportState(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool?.state) throw new Refusal(409, `${tool?.label ?? c.tool} does not say where it keeps its state: it cannot be exported.`);
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') throw new Refusal(409, 'Its machine is not running: open the conversation first.', { retry: false });
        const manifest = JSON.stringify({ kind: 'clavarium-conversation', version: 1, tool: c.tool, name: c.name, ...(c.title ? { title: c.title } : {}), memoryMb: c.memoryMb, cpus: c.cpus ?? 1, diskGb: c.diskGb ?? DISK_GB, at: new Date().toISOString() });
        /* In its machine: the manifest written aside, then one archive -- the manifest first, then what is kept
           (a path it has not made yet left out), the cache left out. */
        /* (Its paths are plain -- letters, digits, . _ / - -- checked by tools.mjs: given as words.) */
        const script = 'set -e; m=$(mktemp -d); printf "%s" "$1" > "$m/clavarium-conversation.json"; '
            + 'ex=""; for a in $2; do ex="$ex --exclude=./$a"; done; ks=""; for a in $3; do if [ -e "$HOME/$a" ]; then ks="$ks ./$a"; fi; done; '
            + 'tar -czf - -C "$m" clavarium-conversation.json -C "$HOME" $ex $ks; rm -rf "$m"';
        const argv = this.#vms.execArgv(name, ['sh', '-c', script, 'export', manifest, tool.state.skip.join(' '), tool.state.keep.join(' ')]);
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        /* What it said when it failed: kept short, for the message that says why (a copy, a move). */
        child.said = '';
        child.stderr.on('data', (d) => { child.said = (child.said + d).slice(-2000); });
        return { name: `${name}-${new Date().toISOString().slice(0, 10)}.clavarium.tar.gz`, stream: child.stdout, child };
    }

    /* PUT BACK an exported state in this conversation (same tool): its tool stopped, the archive unpacked in
       its home, its tool started again, taking up its last session. -> { tool, from } */
    async importState(name, input) {
        const c = this.#busyCheck(name);
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool?.state) throw new Refusal(409, `${tool?.label ?? c.tool} does not say where it keeps its state: nothing can be imported in it.`);
        if ((await this.#vms.state(name).catch(() => undefined)) !== 'Running') throw new Refusal(409, 'Its machine is not running: open the conversation first.', { retry: false });
        this.drop(name);
        await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'kill-server'], { timeoutMs: 10_000 }).catch(() => {});
        try { return { tool: c.tool, from: await this.#unpack(name, c.tool, input) }; } finally { this.ready(name); }
    }

    /* An exported state unpacked into its home (its tool stopped by the caller): its manifest checked, then each
       part put in place of the old. -> the manifest's { name, at }, or null. */
    async #unpack(name, toolId, input) {
        /* Unpacked aside first: its manifest read, its tool checked; then moved into the home. */
        /* Aside in the home itself (never /tmp, which may be memory): then each part moved in place of the old. */
        const script = 'set -e; m=$(mktemp -d "$HOME/.clavarium-import.XXXXXX"); trap \'rm -rf "$m"\' EXIT; tar -xzf - -C "$m"; '
            + 'grep -q "\\"kind\\":\\"clavarium-conversation\\"" "$m/clavarium-conversation.json" || { echo "not an exported conversation" >&2; exit 3; }; '
            + 'grep -q "\\"tool\\":\\"$1\\"" "$m/clavarium-conversation.json" || { echo "another tool" >&2; exit 4; }; '
            + 'cat "$m/clavarium-conversation.json"; rm -f "$m/clavarium-conversation.json"; '
            + 'for e in "$m"/.[!.]* "$m"/*; do if [ ! -e "$e" ]; then continue; fi; b=$(basename "$e"); rm -rf "$HOME/$b"; mv "$e" "$HOME/$b"; done';
        const argv = this.#vms.execArgv(name, ['sh', '-c', script, 'import', toolId]);
        const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = []; const err = [];
        child.stdout.on('data', (d) => out.push(d)); child.stderr.on('data', (d) => err.push(d));
        input.pipe(child.stdin);
        child.stdin.on('error', () => { /* it stopped reading: said below */ });
        const code = await new Promise((ok) => child.on('close', ok));
        if (code === 3) throw new Refusal(400, 'This is not an exported conversation.');
        if (code === 4) throw new Refusal(400, `This export is of another tool: import it into a conversation with that tool.`);
        if (code !== 0) throw new Refusal(502, `Not imported: ${firstLine(Buffer.concat(err).toString()) || `exit ${code}`}`);
        let from = null; try { from = JSON.parse(Buffer.concat(out).toString()); } catch { /* said nothing */ }
        return from ? { name: from.name, at: from.at } : null;
    }

    /* A COPY OF A CONVERSATION (#221, 13-11, its owner's ask: safer than a move -- nothing is destroyed). A new
       conversation, in a machine of its own or a shared one, with what its original has: its work folder (its
       chat with it), its tool's state (the AI's memory), its settings, and the accesses it was given. Its devices,
       its reminders and its pending asks are NOT copied: one of the two answers them, the original. Its original is
       not touched; asleep, its machine is woken the time to read its tool's state, then put to sleep again.
       -> the copy's record, at once; `this.copied`: the end of it. */
    async copy(name, { title, machine, machineMb } = {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, 'It is busy: copy it once it is ready.');
        if (c.work !== 'kept') throw new Refusal(409, 'Its work is on its own machine\'s disk: it cannot be copied from here. Keep it here first (Its files), then copy it.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool) throw new Refusal(400, 'The tool of this conversation is no longer offered.');
        const shared = machine !== undefined && machine !== null && machine !== '';
        const size = shared ? this.#machineMbOf(machine) ?? machineMb ?? SHARED_MB : undefined;
        const memory = shared ? Math.max(tool.memoryMb, Math.min(Number(c.memoryMb) || tool.memoryMb, Number(size) || SHARED_MB)) : Number(c.memoryMb) || tool.memoryMb;
        const label = typeof title === 'string' && title.trim() ? title.trim() : `${c.title ?? c.name} (copy)`;
        await this.admit({ title: label, tool: c.tool, memoryMb: memory, ...(shared ? { machine, machineMb } : {}) });
        const made = this.create({ title: label, tool: c.tool, memoryMb: memory, ...(shared ? { machine, machineMb } : { cpus: c.cpus, diskGb: c.diskGb }), ...(c.group ? { group: c.group } : {}) });
        /* Before its build can end (it awaits first): held, never usable half made. */
        this.#holding.add(made.name);
        this.#store.patch(made.name, { copyOf: name });
        const building = this.built;
        this.copied = this.#copying(name, made.name, c, tool, building);
        return this.#store.get(made.name);
    }

    async #copying(from, to, c, tool, building) {
        const dir = mkdtempSync(join(tmpdir(), 'clv-copy-'));
        const carried = join(dir, 'state.tar.gz');
        let woke = false;
        try {
            await building;
            const built = this.#store.get(to);
            if (!built) return undefined;   /* erased meanwhile */
            if (built.phase === 'failed') throw new Error(built.error ?? 'its machine could not be made.');
            this.#store.patch(to, { step: 'Copying its work' });
            await this.copyWork(from, to);
            if (tool.state) {
                this.#store.patch(to, { step: `Copying ${tool.label}'s memory` });
                const state = await this.#vms.state(from, { fresh: true }).catch(() => undefined);
                if (state !== 'Running') {
                    await this.room({ kind: 'start', name: from, memoryMb: Number(c.memoryMb) || tool.memoryMb });
                    /* Woken outside a wake, it is still marked asleep: borrowed, so that the server's sweep of sleepers
                       holding memory (capacity.mjs, reclaimSleepers) does not put it back to sleep while it is read --
                       the reading would end cut (13-11: exit 255). */
                    this.#borrowed.add(from);
                    const started = await this.#vms.start(from);
                    if (started.code !== 0) throw new Error(`its original's machine did not start: ${firstLine(started.stderr) || `exit ${started.code}`}.`);
                    woke = true;
                    /* Started is not yet reachable: its commands wait for it, two minutes at most. */
                    for (let i = 0; i < 24 && (await this.#vms.exec(from, ['true'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }))).code !== 0; i++) await new Promise((ok) => setTimeout(ok, 5000));
                }
                /* Read once more if the VM manager could not reach it (255): a machine just woken may still be settling. */
                let code; let child;
                for (let attempt = 0; attempt < 2 && code !== 0; attempt++) {
                    if (attempt) await new Promise((ok) => setTimeout(ok, 10_000));
                    const out = await this.exportState(from);
                    child = out.child;
                    const failed = new Promise((ok) => child.on('error', () => ok(-1)));
                    const file = createWriteStream(carried, { mode: 0o600 });
                    out.stream.pipe(file);
                    code = await Promise.race([new Promise((ok) => child.on('close', ok)), failed]);
                    await new Promise((ok) => (file.writableFinished ? ok() : file.on('finish', ok)));
                    if (code !== 255) break;
                }
                if (code !== 0) throw new Error(`its tool's memory could not be read (exit ${code}${firstLine(child.said) ? `: ${firstLine(child.said)}` : ''}).`);
                if ((await this.#vms.state(to, { fresh: true }).catch(() => undefined)) !== 'Running') {
                    const started = await this.#vms.start(to);
                    if (started.code !== 0) throw new Error(`its machine did not start: ${firstLine(started.stderr) || `exit ${started.code}`}.`);
                }
                await this.#unpack(to, c.tool, createReadStream(carried));
            }
            this.#store.patch(to, { step: 'Giving it the same accesses' });
            await this.copyRights(from, to);
            this.#holding.delete(to);
            if (!this.#store.get(to)) return undefined;
            this.#store.patch(to, { phase: 'ready', step: undefined, progress: undefined, buildingSince: undefined, error: undefined });
            this.ready(to);
            return undefined;
        } catch (error) {
            this.#holding.delete(to);
            if (this.#store.get(to)) this.#store.patch(to, { phase: 'failed', step: undefined, progress: undefined, buildingSince: undefined, error: `Not copied: ${String(error?.message ?? error).replace(/\.?$/, '.')} Its original is untouched; erase this copy.` });
            return undefined;
        } finally {
            rmSync(dir, { recursive: true, force: true });
            if (woke) await this.sleep(from).catch(() => {});
            this.#borrowed.delete(from);
        }
    }

    /* MOVED INTO A SHARED MACHINE (#221, 12-11, its owner's ask: put existing conversations together). From a
       machine of its own: its tool's state carried (state.keep, as an export), its machine stopped -- kept until the
       end, to go back to -- its place made in the shared machine as for a new one, the state put back in its home,
       then its old machine deleted. Its work folder is kept by the server: it simply follows. One on its machine's
       own disk is refused (its files would stay behind): kept first (its settings, Its files).
       -> the record, at once; `this.built`: the end of it. */
    async moveToShared(name, { machine, machineMb } = {}) {
        const c = this.#busyCheck(name);
        if (c.sharedMachine) throw new Refusal(409, `It lives in the shared machine ${c.sharedMachine} already.`);
        if (typeof machine !== 'string' || !isConversationName(machine)) throw new Refusal(400, 'A machine name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter.');
        if (machine === name || this.#store.get(machine)) throw new Refusal(400, 'A shared machine has a name of its own, not a conversation\'s.');
        if (c.work !== 'kept') throw new Refusal(409, 'Its work is on its own machine\'s disk: it would stay behind. Keep it here first (Its files), then move it.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (!tool) throw new Refusal(400, 'The tool of this conversation is no longer offered.');
        const there = this.#machineMbOf(machine);
        const size = there ?? machineMb ?? SHARED_MB;
        if (there === undefined && (!Number.isInteger(size) || size < 1024 || size > 16384)) throw new Refusal(400, 'A shared machine has 1024 to 16384 MB of memory.');
        const memory = Math.max(tool.memoryMb, Math.min(Number(c.memoryMb) || tool.memoryMb, size));
        if (memory > size) throw new Refusal(400, `The machine ${machine} has ${size} MB of memory: ${tool.label} needs ${tool.memoryMb} MB.`);
        const state = await this.#vms.state(name, { fresh: true }).catch(() => undefined);
        if (tool.state && state !== 'Running') throw new Refusal(409, 'Its machine is not running: open the conversation first, so that its tool\'s state can come along.', { retry: false });
        /* A new shared machine takes its size; its own, running, is stopped before it starts: that memory is given back. */
        if (there === undefined) await this.room({ kind: 'create', memoryMb: Math.max(0, size - (state === 'Running' ? Number(c.memoryMb) || 0 : 0)) });
        const act = this.#take(name, 'move');
        this.#cancelStop(name);
        const now = new Date().toISOString();
        this.#store.patch(name, { phase: 'building', step: `Moving to the shared machine ${machine}`, buildingSince: now, progress: buildProgress(now) });
        this.built = this.#moving(name, c, tool, machine, size, memory, state).finally(() => this.#give(name, act));
        return this.#store.get(name);
    }

    async #moving(name, c, tool, machine, size, memory, state) {
        const old = vmName(name);
        const dir = mkdtempSync(join(tmpdir(), 'clv-move-'));
        const carried = join(dir, 'state.tar.gz');
        const back = (why) => {
            /* Back to its own machine, as it was (stopped: the next opening wakes it). */
            this.#store.patch(name, { sharedMachine: undefined, machineMb: undefined, machineUser: undefined, memoryMb: c.memoryMb, phase: 'ready', step: undefined, progress: undefined, buildingSince: undefined, error: undefined });
            this.#fresh.add(name); this.#mountAgain.add(name);
            try { this.renewed(name, `Not moved to the shared machine ${machine}: ${why} It stays in its own machine, as it was.`, false); } catch { /* told, nothing more */ }
        };
        try {
            this.drop(name);
            if (state === 'Running') await this.#vms.exec(name, ['tmux', '-L', SOCKET, 'kill-server'], { timeoutMs: 10_000 }).catch(() => {});
            if (tool.state) {
                this.#store.patch(name, { step: `Taking ${tool.label}'s state along` });
                const { stream, child } = await this.exportState(name);
                const failed = new Promise((ok) => child.on('error', () => ok(-1)));
                const file = createWriteStream(carried, { mode: 0o600 });
                stream.pipe(file);
                const code = await Promise.race([new Promise((ok) => child.on('close', ok)), failed]);
                await new Promise((ok) => (file.writableFinished ? ok() : file.on('finish', ok)));
                if (code !== 0) return back(`its tool's state could not be taken (exit ${code}${firstLine(child.said) ? `: ${firstLine(child.said)}` : ''}).`);
            }
            if (state !== undefined) {
                this.#store.patch(name, { step: 'Stopping its own machine' });
                const stopped = await this.#vms.stop(name);
                if (stopped.code !== 0) return back(`its machine did not stop: ${firstLine(stopped.stderr) || `exit ${stopped.code}`}.`);
            }
            this.#store.patch(name, { sharedMachine: machine, machineMb: size, memoryMb: memory });
            await this.#buildShared(name, tool, memory);
            const now = this.#store.get(name);
            if (!now) return undefined; /* archived meanwhile */
            if (now.phase !== 'ready') {
                const why = now.error ?? 'its place there could not be made.';
                await this.#vms.unshare(name).catch(() => {});
                return back(`${why.replace(/\.?$/, '.')}`);
            }
            if (tool.state) {
                /* Not opened while its state is put back: building still, to the end. */
                this.#store.patch(name, { phase: 'building', step: `Putting ${tool.label}'s state back` });
                this.drop(name);
                try { await this.#unpack(name, c.tool, createReadStream(carried)); } catch (error) {
                    this.#store.patch(name, { phase: 'ready', step: undefined });
                    this.ready(name);
                    this.renewed(name, `Moved to the shared machine ${machine}, but ${tool.label}'s state did not come along (${error.message}): it starts afresh. Its old machine is kept, stopped.`, true);
                    return undefined;
                }
                this.#store.patch(name, { phase: 'ready', step: undefined });
                this.ready(name);
            }
            await this.#vms.removeVm(old).catch(() => {});
            this.renewed(name, `Moved to the shared machine ${machine}: its work folder${tool.state ? `, ${tool.label}'s state` : ''} and this chat came along. Its own machine is deleted.`, true);
            return undefined;
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }

    async #fixup(name, tool) {
        for (const step of tool.fixups) {
            const r = await this.#vms.exec(name, step.argv, { timeoutMs: 120_000 }).catch(() => ({ code: 1 }));
            if (r.code !== 0) return;
        }
        if (this.#store.get(name)) this.#store.patch(name, { fixed: FIXES });
    }

    /* RESTARTS THE MACHINE, as asked by its owner: a clean stop, a stop by
       force if the clean one hangs or fails, then a start. The tool and its
       terminal come back as after any start (`ready`); its folders are
       looked at after (health.mjs). The answer comes at once; `restarted`
       says how it ended. A machine asleep is restarted too: that is what
       was asked -- and the size kept for its wake is applied on the way. */
    async restart(name) {
        const c = this.#busyCheck(name);
        const want = c.sizeAtWake;
        const had = { memoryMb: c.memoryMb, cpus: c.cpus ?? 1, diskGb: c.diskGb ?? DISK_GB };
        const act = this.#take(name, 'restart');
        const claimed = this.#claim(name, 'restarting', 'Looking at the machine');
        const release = () => { claimed(); this.#give(name, act); };
        let state;
        try {
            state = await this.#vms.state(name);
            if (state === undefined) throw new Refusal(410, 'The machine of this conversation no longer exists.');
            /* A machine that does not run is started: it takes its memory again. */
            if (want) await this.#roomAtWake(name, had, want, state, false);
            else if (state !== 'Running') await this.room({ kind: 'start', name, memoryMb: c.memoryMb });
        } catch (error) { release(); throw error; }
        this.#cancelStop(name);
        const since = new Date().toISOString();
        this.#store.patch(name, { phase: 'restarting', restartingSince: since, step: 'Stopping the machine', restarted: undefined, sizeAtWake: undefined });
        const tool = this.#tools.find((t) => t.id === c.tool);
        this.#begin(name, 'restart', [...(state === 'Stopped' ? [] : ['stopping']), ...(want ? ['setting'] : []), 'starting', 'answering', 'folders', 'tool', ...this.#resumeStep(c, tool)], since);
        this.#plan(name, act, [...this.#downSteps(name), 'start']);
        this.restarted = this.#cycle(name, c, want ? this.#setter(name, c, want) : async () => undefined, true, act).then(async (failure) => {
            this.#report(name, act, { ok: !failure, why: failure, chat: false });
            if (!want) return this.#settle(name, failure ? `Not restarted: ${failure}` : 'Restarted.', failure ? `Its machine was not restarted: ${failure}` : 'Its machine was restarted: the tool started again.', Boolean(failure));
            await this.reconcile(name);
            const said = sizeSaid(this.#store.get(name), had);
            return this.#settle(name, failure ? `Not changed: ${failure} It has ${said}.` : `Restarted: it now has ${said}.`, failure ? `Its machine was not changed: ${failure} It has ${said}.` : `Its machine was restarted with ${said}: the tool started again.`, Boolean(failure));
        }).finally(() => this.#give(name, act));
        return this.#store.get(name);
    }

    /* GIVES ITS MACHINE MORE OR LESS MEMORY, OR A LARGER DISK. The VM
       manager takes it only from a stopped machine: a running one is
       stopped (cleanly first), set, and started again -- its work folder,
       its folders and its branches are not touched. A disk only grows.
       What is recorded afterwards is what the VM manager says it has.
       Asleep, it is not woken for it: the choice is kept for its wake (#later). */
    async resize(name, asked = {}) {
        const c = this.#busyCheck(name);
        const tool = this.#tools.find((t) => t.id === c.tool);
        if (c.sharedMachine) return this.#limitShared(name, c, tool, asked);
        const { memory, disk, cpus } = this.#sizeAsked(c, tool, asked);
        if (c.asleep === true) return this.#later(name, c, { memoryMb: memory, cpus, diskGb: disk });
        const act = this.#take(name, 'resize');
        const claimed = this.#claim(name, 'restarting', 'Looking at the machine');
        const release = () => { claimed(); this.#give(name, act); };
        let state;
        try {
            state = await this.#vms.state(name);
            if (state === undefined) throw new Refusal(410, 'The machine of this conversation no longer exists.');
            /* More memory is taken only by a machine started again; a disk grows on the host whatever. */
            await this.room({ kind: 'grow', name, memoryMb: state === 'Running' ? Math.max(0, memory - c.memoryMb) : 0, diskMb: Math.max(0, disk - (c.diskGb ?? DISK_GB)) * 1024 });
        } catch (error) { release(); throw error; }
        this.#cancelStop(name);
        const since = new Date().toISOString();
        this.#store.patch(name, { phase: 'restarting', restartingSince: since, step: state === 'Running' ? 'Stopping the machine' : 'Setting its memory and disk', restarted: undefined });
        /* Started again only when it ran: then the page is told each step to its tool. */
        if (state === 'Running') this.#begin(name, 'resize', ['stopping', 'setting', 'starting', 'answering', 'folders', 'tool', ...this.#resumeStep(c, tool)], since);
        const set = this.#setter(name, c, { memoryMb: memory, cpus, diskGb: disk });
        if (state === 'Running') this.#plan(name, act, [...this.#downSteps(name), 'start']);
        this.resized = this.#cycle(name, c, set, state === 'Running', act).then(async (failure) => {
            if (state === 'Running') this.#report(name, act, { ok: !failure, why: failure, chat: false });
            else this.#store.patch(name, { machine: undefined });
            await this.reconcile(name);
            const said = sizeSaid(this.#store.get(name), { memoryMb: memory, cpus, diskGb: disk });
            await this.#settle(name, failure ? `Not changed: ${failure} It has ${said}.` : `It now has ${said}.`, failure ? `Its machine was not changed: ${failure} It has ${said}.` : `Its machine was restarted with ${said}: the tool started again.`, Boolean(failure));
        }).finally(() => this.#give(name, act));
        return this.#store.get(name);
    }

    /* WHAT A NEW SIZE ASKS, checked the same whether it is applied now or at
       its wake. Refused, with why, before anything is touched. */
    #sizeAsked(c, tool, { memoryMb, diskGb, cpus: cpusAsked } = {}) {
        const memory = memoryMb === undefined || memoryMb === null || memoryMb === '' ? c.memoryMb : Number(memoryMb);
        const disk = diskGb === undefined || diskGb === null || diskGb === '' ? c.diskGb ?? DISK_GB : Number(diskGb);
        const cpusNow = c.cpus ?? 1;
        const cpus = cpusAsked === undefined || cpusAsked === null || cpusAsked === '' ? cpusNow : Number(cpusAsked);
        const hostCpus = availableParallelism();
        if (cpus !== cpusNow && (!Number.isInteger(cpus) || cpus < 1 || cpus > hostCpus)) throw new Refusal(400, `Cores: 1 to ${hostCpus}, those of this server, which its machines share.`);
        const least = tool?.memoryMb ?? 512;
        /* Memory is checked only when it changes: a machine made when its tool
           needed less keeps what it has, and its disk can still grow. */
        if (memory !== c.memoryMb && (!Number.isInteger(memory) || memory < least || memory > MEMORY_MAX_MB)) throw new Refusal(400, `Memory is between ${least} MB (what ${tool?.label ?? 'its tool'} needs) and ${MEMORY_MAX_MB} MB.`);
        if (!Number.isInteger(disk) || disk > DISK_MAX_GB) throw new Refusal(400, `A disk is at most ${DISK_MAX_GB} GB.`);
        if (disk < (c.diskGb ?? DISK_GB)) throw new Refusal(400, `A disk can only grow: it has ${c.diskGb ?? DISK_GB} GB.`);
        if (memory === c.memoryMb && disk === (c.diskGb ?? DISK_GB) && cpus === cpusNow) throw new Refusal(409, 'Nothing to change: it already has this.');
        return { memory, disk, cpus };
    }

    /* What sets the sizes `want` on its stopped machine, beside what it has
       (`c`): only what differs. Returns what went wrong, in words, or
       undefined; `done` is told each one that was set. */
    #setter(name, c, want, done = () => {}) {
        return async () => {
            this.#reach(name, 'setting');
            if (want.memoryMb !== c.memoryMb) {
                this.#store.patch(name, { step: `Setting its memory to ${want.memoryMb} MB` });
                const r = await this.#vms.setMemory(name, want.memoryMb);
                if (r.code !== 0) return `its memory could not be set (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}).`;
                done('memory');
            }
            if (want.cpus !== (c.cpus ?? 1)) {
                this.#store.patch(name, { step: `Setting its cores to ${want.cpus}` });
                const r = await this.#vms.setCpus(name, want.cpus);
                if (r.code !== 0) return `its cores could not be set (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}).`;
                done('cpus');
            }
            if (want.diskGb !== (c.diskGb ?? DISK_GB)) {
                this.#store.patch(name, { step: `Growing its disk to ${want.diskGb} GB` });
                const r = await this.#vms.setDisk(name, want.diskGb);
                if (r.code !== 0) return `its disk could not be grown (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}).`;
                done('disk');
            }
            return undefined;
        };
    }

    /* A NEW SIZE CHOSEN WHILE IT SLEEPS. A machine asleep cannot be set (the
       VM manager sets only a stopped one), and stopping it would throw away
       what its memory holds: the choice is checked as a resize would be --
       its bounds, and this server's reserve for what it grows by -- then
       kept in its record, which outlives a restart of this server, and
       applied at its wake (#wakeResized). A second choice replaces the first. */
    async #later(name, c, want) {
        await this.room({ kind: 'grow', name, memoryMb: Math.max(0, want.memoryMb - c.memoryMb), diskMb: Math.max(0, want.diskGb - (c.diskGb ?? DISK_GB)) * 1024 });
        /* Woken while the room was looked at: it is no longer for later. */
        const now = this.#store.get(name);
        if (!now) throw new Refusal(404, 'No such conversation.');
        if (now.asleep !== true) throw new Refusal(409, 'It has just woken: choose its size again.');
        this.#store.patch(name, { sizeAtWake: { ...want, at: new Date().toISOString() }, restarted: undefined });
        return this.#store.get(name);
    }

    /* The size kept for its wake, given up: it wakes as it is. */
    cancelResize(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (!c.sizeAtWake) throw new Refusal(409, 'No new size is waiting for its wake.');
        this.#store.patch(name, { sizeAtWake: undefined });
        return this.#store.get(name);
    }

    /* What the VM manager says the machine has, written in its record. */
    async reconcile(name) {
        /* In a shared machine (#221): what the machine has is the machine's; its memory is its own limit there. */
        if (!this.#store.get(name) || this.#store.get(name).sharedMachine) return;
        const real = await this.#vms.size(name).catch(() => ({}));
        const patch = {};
        if (real.memoryMb !== undefined && real.memoryMb !== this.#store.get(name).memoryMb) patch.memoryMb = real.memoryMb;
        if (real.diskGb !== undefined && real.diskGb !== this.#store.get(name).diskGb) patch.diskGb = real.diskGb;
        if (real.cpus !== undefined && real.cpus !== (this.#store.get(name).cpus ?? 1)) patch.cpus = real.cpus;
        if (Object.keys(patch).length > 0 && this.#store.get(name)) this.#store.patch(name, patch);
    }
    async reconcileAll() {
        for (const c of this.#store.all()) if (c.phase === 'ready') await this.reconcile(c.name);
    }

    /* TAKES THE CONVERSATION FOR ONE CHANGE OF ITS MACHINE, at once: the
       phase is set before anything is awaited, so that a second restart, a
       resize or a move asked meanwhile is refused by #busyCheck instead of
       running alongside. Returns what gives it back as it was, for a change
       refused before it started. */
    #claim(name, phase, step) {
        const before = this.#store.get(name);
        this.#store.patch(name, { phase, step });
        return () => {
            if (this.#store.get(name)?.phase === phase) this.#store.patch(name, { phase: before.phase, step: before.step });
        };
    }

    #busyCheck(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (c.phase !== 'ready') throw new Refusal(409, c.phase === 'restarting' ? 'Its machine is being restarted already.' : c.phase === 'moving' ? 'It is moving its work folder.' : 'This conversation is not ready.');
        if (this.#resizing.has(name)) throw new Refusal(409, 'Its machine is being given its new size as it wakes.', { retry: true });
        if (this.#acts.has(name)) throw this.#busy(name);
        return c;
    }

    /* Stops the machine (cleanly, then by force), runs `between` on the
       stopped machine, and starts it again when `restart`. Returns what
       went wrong, in words, or undefined. */
    /* `act`: the action it runs for (restart, resize); one of its own when none is given (a size
       applied at a wake), taken and given back here. The stop is the way down (#down): its steps
       told to the page, "Force now" taken, Force stop taking its place. */
    async #cycle(name, c, between, restart, given = null) {
        const act = given ?? this.#take(name, 'resize');
        if (!given) this.#plan(name, act, [...this.#downSteps(name), ...(restart ? ['start'] : [])]);
        const step = (text) => { if (this.#store.get(name)) this.#store.patch(name, { step: text }); };
        try {
            await this.#calm(name, step);
            this.drop(name);
            let state = await this.#vms.state(name);
            if (state !== 'Stopped') {
                step('Stopping the machine');
                const down = await this.#down(name, act);
                if (down.preempted) return 'it was stopped by force instead.';
                state = await this.#vms.state(name).catch(() => undefined);
                if (state !== 'Stopped') return `the machine did not stop (${state ? `it is ${state}` : 'its state could not be read'}).`;
            } else this.#skipDown(name, act);
            const failed = await between();
            if (!restart) return failed;
            step('Starting the machine');
            this.#reach(name, 'starting');
            if (act.preempted) return 'it was stopped by force instead.';
            this.#stepAt(name, act, 'start', 'start');
            act.ctl = new AbortController();
            const started = await this.#watched(name, 'start', this.#vms.start(name, { signal: act.ctl.signal }));
            if (started.aborted) return 'it was stopped by force instead.';
            this.#stepAt(name, act, 'start', started.code === 0 ? 'ok' : 'fail');
            /* The VM manager may fail its start for its own mounts while the machine runs: those are mounted again here. */
            if (started.code !== 0 && (await this.#vms.state(name).catch(() => undefined)) !== 'Running') return `${failed ? `${failed} And ` : ''}the machine did not start (${firstLine(started.stderr) || firstLine(started.stdout) || `exit ${started.code}`}).`;
            /* Whatever was put in its memory is gone: the next opening prepares it again, its folders first. */
            this.#fresh.add(name);
            this.#mountAgain.add(name);
            this.#reach(name, 'answering');
            return failed;
        } catch { return 'it stopped on an unexpected error.'; }
        finally { if (!given) { this.#store.patch(name, { machine: undefined }); this.#give(name, act); } }
    }

    /* Before its machine is stopped: its folders being mounted again are
       left to finish, within a bound (a new look does not start meanwhile:
       health.mjs leaves a machine that is not `ready` alone). */
    async #calm(name, step) {
        const pending = [this.#mounting.get(name), this.quiet(name)].filter(Boolean);
        if (pending.length === 0) return;
        step('Waiting for its folders to be mounted');
        let timer;
        await Promise.race([Promise.allSettled(pending), new Promise((r) => { timer = setTimeout(r, CALM_MS); timer.unref?.(); })]);
        clearTimeout(timer);
    }

    /* `chat`: the same, as its chat says it. */
    async #settle(name, said, chat, failed = false) {
        if (!this.#store.get(name)) return;
        const running = (await this.#vms.state(name).catch(() => undefined)) === 'Running';
        this.#store.patch(name, { phase: 'ready', step: undefined, restartingSince: undefined, asleep: false, stopped: undefined, restarted: said });
        /* Its steps go on to the tool only when it runs; a failure ends them, said in `restarted`. */
        if (!running || failed) this.#end(name);
        /* The tool is started again in its terminal, as after any start. */
        if (running) this.ready(name);
        try { this.renewed(name, chat ?? said, running); } catch { /* told, nothing more */ }
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
        /* Before its machine stops (and its kernel's memory of the night with it): why the tool
           ended, kept on the conversation and said -- a person without access to the server
           sees it in Machine, and is told at once when it was cut for lack of memory. */
        const report = await this.exitReport(name).catch(() => null);
        if (report) { this.#store.patch(name, { lastExit: report }); try { this.onToolExit?.(name, report); } catch { /* telling is best effort */ } }
        this.#cancelStop(name);
        const timer = setTimeout(() => {
            this.#timers.delete(name);
            /* Not under an action of its owner's (a restart, a sleep): that one decides. */
            if (!this.#watching.has(name) && !this.#acts.has(name)) { this.drop(name); void this.#stopUnlessShared(name); }
        }, this.#stopDelayMs);
        timer.unref?.();
        this.#timers.set(name, timer);
        return false;
    }

    /* WHY ITS TOOL ENDED, read inside the machine while it still runs: the kernel's kills for
       lack of memory since it started (with the program's name), its memory, and the last
       lines of the tool's own log (`logs` in config/tools.json). Read as the machine's
       ordinary user; dmesg through sudo when it may. Nothing is changed. */
    async exitReport(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (await this.#vms.state(name) !== 'Running') throw new Refusal(409, 'Its machine is not running.');
        const tool = this.#tools.find((t) => t.id === c.tool);
        const logs = Array.isArray(tool?.logs) ? tool.logs.filter((d) => /^[A-Za-z0-9._/-]+$/.test(d)) : [];
        const script = [
            '( sudo -n dmesg -T 2>/dev/null || dmesg -T 2>/dev/null ) | grep -E "Killed process|Out of memory|Memory cgroup out of memory" | tail -n 4 | sed "s/^/oom /"',
            'awk \'/^MemTotal:/{print "memory", int($2/1024)}\' /proc/meminfo',
            'for d in "$@"; do f=$(ls -t "$HOME/$d"/*.log 2>/dev/null | head -1); [ -n "$f" ] && { echo "logfile $f"; tail -n 25 "$f" | cut -c1-300 | sed "s/^/log /"; }; done; true',
        ].join('\n');
        const r = await this.#vms.exec(name, ['bash', '-c', script, 'report', ...logs], { timeoutMs: 20_000 });
        const lines = String(r.stdout ?? '').split('\n');
        const pick = (p) => lines.filter((l) => l.startsWith(`${p} `)).map((l) => l.slice(p.length + 1));
        const memoryMb = Number(pick('memory')[0]) || null;
        return { at: new Date().toISOString(), oom: pick('oom'), memoryMb, logFile: pick('logfile')[0] ?? null, log: pick('log') };
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
        this.#busyCheck(name);
        if ((c.work ?? 'disk') === to) throw new Refusal(409, to === 'kept' ? 'Its work is already kept here.' : 'It already works on the disk of its machine.');
        /* Its own phase from here: what must hold is looked at in a machine
           nobody restarts, resizes or moves meanwhile. */
        const release = this.#claim(name, 'moving', 'Looking at the work folder');
        try { await this.#moveChecks(name, to); } catch (error) { release(); throw error; }
        this.#cancelStop(name);
        this.#store.patch(name, { phase: 'moving', step: 'Stopping the tool', moved: undefined });
        this.moved = this.#move(name, to);
        return this.#store.get(name);
    }

    async #moveChecks(name, to) {
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
    }

    #move(name, to) {
        const inVm = (argv, timeoutMs = 60_000) => this.#vms.exec(name, ['sudo', '-n', ...argv], { timeoutMs });
        const said = (r) => firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
        return (async () => {
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
            /* The tool is started again, where its work now is, its folders mounted again first. */
            this.#mountAgain.add(name);
            this.ready(name);
        })();
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

    /* Whether its machine is being given the size kept for its wake just now (it stops and starts meanwhile). */
    resizing(name) { return this.#resizing.has(name); }

    /* The conversations whose machine should be running: built, not asleep. */
    /* (Stopped by its owner: not running either, until somebody starts it.) */
    awake() { return this.#store.all().filter((c) => c.phase === 'ready' && c.asleep !== true && c.stopped !== true).map((c) => c.name); }
    /* Put to sleep, and nothing else: not one being built (02-11: a reset machine was taken for a sleeper and
       suspended mid-build), not a failed one. */
    /* (One woken the time a copy reads it -- #borrowed -- is not asleep then: its memory is never "reclaimed" under it.) */
    asleep() { return this.#store.all().filter((c) => c.phase === 'ready' && c.asleep === true && !this.#borrowed.has(c.name)).map((c) => c.name); }

    /* Whether the machine of a conversation runs right now. */
    async running(name) { return (await this.#vms.state(name)) === 'Running'; }

    /* PUT TO SLEEP, through the one lock of its machine: refused while another action runs on it.
       Resolves once asleep; throws, in words, when it could not be. */
    async sleep(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        if (this.#acts.has(name)) throw this.#busy(name);
        const act = this.#take(name, 'sleep');
        const report = await this.#perform(name, act);
        if (!report.ok) throw new Refusal(502, `The machine did not go to sleep: ${report.why ?? 'it did not answer.'}`);
    }

    /* ---------- ONE ACTION AT A TIME ON A MACHINE (09-11) ---------- */
    /* Taken at once, before anything is awaited, so that a second action asked meanwhile sees it. */
    #take(name, kind) {
        let finish;
        const act = { kind, since: new Date().toISOString(), steps: [], ctl: null, next: null, current: null, preempted: false, until: kind !== 'force' && this.#store.get(name)?.stopEscalate === false ? 'force' : 'kill' };
        act.done = new Promise((r) => { finish = r; });
        act.finish = finish;
        this.#acts.set(name, act);
        return act;
    }
    /* Refused while another action runs: which one, since when, and what can be done. */
    #busy(name) {
        const act = this.#acts.get(name);
        const s = act ? Math.max(0, Math.round((Date.now() - Date.parse(act.since)) / 1000)) : 0;
        return new Refusal(409, `Its machine is busy: ${KIND_DOING[act?.kind] ?? 'another action'} for ${s} s. Wait, or force it off.`, { retry: true });
    }
    #give(name, act) { if (this.#acts.get(name) === act) this.#acts.delete(name); act.finish(); }
    /* The steps the page shows, in order: done, running, to come (`todo`). */
    #plan(name, act, ids) {
        act.steps = ids.map((id) => ({ id, state: 'todo' }));
        this.#show(name, act);
    }
    #show(name, act) {
        if (!this.#store.get(name)) return;
        this.#store.patch(name, { machine: { kind: act.kind, since: act.since, until: act.until, steps: act.steps.map((x) => ({ ...x })) } });
    }
    /* The way down's steps, as this machine's owner chose: to its own qemu, or the VM manager's ways only. */
    #downSteps(name) { return this.#store.get(name)?.stopEscalate === false ? ['polite', 'force', 'check'] : [...DOWN]; }
    /* A step reached (`start`) or ended (ok|fail|timeout|skip|cut), with its seconds. */
    #stepAt(name, act, id, result, { s, more, freedGb } = {}) {
        let at = act.steps.find((x) => x.id === id);
        if (!at) { at = { id, state: 'todo' }; const check = act.steps.findIndex((x) => x.id === 'check' || x.id === 'start'); act.steps.splice(check < 0 || id === 'start' ? act.steps.length : check, 0, at); }
        if (result === 'start') { at.state = 'run'; at.since = new Date().toISOString(); act.current = id; }
        else {
            at.state = result;
            at.s = s ?? (at.since ? Math.round((Date.now() - Date.parse(at.since)) / 1000) : 0);
            if (more) at.more = more;
            if (freedGb !== undefined) at.freedGb = freedGb;
            if (act.current === id) act.current = null;
            /* Nothing left to stop: the steps before the check are not needed. */
            if (result === 'skip' && more === 'gone') for (const x of act.steps) if (x.state === 'todo' && x.id !== 'check' && x.id !== 'start') x.state = 'skip';
        }
        this.#show(name, act);
    }
    /* Nothing to stop: the way down is skipped whole. */
    #skipDown(name, act) { for (const x of act.steps) if (DOWN.includes(x.id)) x.state = 'skip'; this.#show(name, act); }
    /* A line of the host program's output. */
    #seen(name, act, line) {
        const step = stepLine(line);
        if (!step) return;
        if (step.result === 'start') this.#reach(name, 'stopping');
        this.#stepAt(name, act, step.id, step.result, step);
    }

    /* THE WAY DOWN (the host program's `vm halt`, or `vm hardstop` for Force stop): a polite stop, a
       stop by force, SIGTERM then SIGKILL to its own qemu, then the check -- each step said as it
       goes. "Force now" ends the step running and starts the next (#forceNow); Force stop ends it
       all (`preempted`). Resolves with { ok, freedGb, more } or { preempted }. */
    async #down(name, act, { hard = false } = {}) {
        let from = hard ? 'term' : 'polite';
        let first = true;
        for (;;) {
            /* Force stop asked before this step began: it does not begin. */
            if (act.preempted) return { ok: false, preempted: true };
            act.ctl = new AbortController(); act.next = null;
            const options = { signal: act.ctl.signal, onLine: (line) => this.#seen(name, act, line) };
            const r = hard && first ? await this.#vms.hardstop(name, options) : await this.#vms.halt(name, { from, until: act.until, ...options });
            first = false;
            if (r.aborted && act.next && !act.preempted) {
                if (act.current) this.#stepAt(name, act, act.current, 'skip', { more: 'moved on' });
                from = act.next;
                continue;
            }
            if (r.aborted) return { ok: false, preempted: true };
            /* A step still said running when the program ended (it was cut): ended so. */
            if (act.current) this.#stepAt(name, act, act.current, 'fail', { more: 'cut' });
            const check = act.steps.find((x) => x.id === 'check');
            return { ok: r.code === 0, freedGb: check?.freedGb, more: check?.more ?? (r.code === 0 ? '' : firstLine(r.stderr)) };
        }
    }

    /* WHAT AN OWNER ASKS OF A MACHINE (`kind`, MACHINE_KINDS; 'force-now' moves the running action
       to its next step). Answers at once with what the page reads (machineState); the action goes
       on, its steps on the record (`machine`), its report kept after it (`machineReport`), said in
       the journal and in its chat. `this.acted`: its end, for whoever waits for it. */
    /* `wait`: resolves with its report instead, once it is done (the watchdog, the memory watch, the
       server's list: callers that act on it, so that no other action's end is taken for theirs). */
    async machineAction(name, kind, { wait = false } = {}) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        if (kind === 'force-now') return this.#forceNow(name);
        if (!MACHINE_KINDS.includes(kind)) throw new Refusal(400, 'Not an action of a machine.');
        if (kind === 'restart') { await this.restart(name); const done = this.restarted; this.acted = done; return wait ? done : this.machineState(name); }
        const running = this.#acts.get(name);
        if (kind !== 'force') this.#busyCheck(name);
        else {
            if (c.phase === 'building' || c.phase === 'moving') throw new Refusal(409, c.phase === 'building' ? 'This conversation is still being built.' : 'It is moving its work folder.');
            if (running) { running.preempted = true; running.ctl?.abort(); await running.done; }
        }
        if (kind === 'start' && (c.asleep !== true && (await this.#vms.state(name).catch(() => undefined)) === 'Running')) throw new Refusal(409, 'Its machine runs already.');
        if (kind === 'start') await this.room({ kind: 'start', name, memoryMb: c.memoryMb });
        if (this.#acts.has(name)) throw this.#busy(name);
        const act = this.#take(name, kind);
        const done = this.#perform(name, act);
        this.acted = done;
        return wait ? done : this.machineState(name);
    }

    /* "FORCE NOW": the step running is ended and the next one started (polite -> forced -> SIGTERM ->
       SIGKILL). Past the VM manager's own ways, for an owner who chose them alone, it is the owner's
       choice now: the way goes on to its qemu. */
    #forceNow(name) {
        const act = this.#acts.get(name);
        const now = act?.steps.find((x) => x.state === 'run');
        if (!act || !now || !NEXT[now.id] || !act.ctl) throw new Refusal(409, 'Nothing to move on from just now.');
        if (now.id === 'force' && act.until === 'force') {
            act.until = 'kill';
            const check = act.steps.findIndex((x) => x.id === 'check');
            act.steps.splice(check, 0, { id: 'term', state: 'todo' }, { id: 'kill', state: 'todo' });
        }
        act.next = NEXT[now.id]; act.current = now.id;
        this.#show(name, act);
        act.ctl.abort();
        return this.machineState(name);
    }

    /* What the page reads: the action running (its steps, each with its state and since when), the
       last report, each step's bound, and the owner's choice for the way down. */
    machineState(name) {
        const c = this.#store.get(name);
        if (!c) throw new Refusal(404, 'No such conversation.');
        return { action: c.machine ?? null, report: c.machineReport ?? null, limits: STEP_LIMITS, escalate: c.stopEscalate !== false, watchdog: this.watchdog(name) };
    }

    /* ITS WATCHDOG, as its owner set it (a default, changed per conversation): on, and how long its
       machine may stay mute or full before it is forced off and started again (watchdog.mjs). */
    watchdog(name) {
        const w = this.#store.get(name)?.watchdog;
        return { on: w?.on !== false, delayMin: Number.isInteger(w?.delayMin) ? w.delayMin : WATCHDOG_DELAY_MIN };
    }
    setWatchdog(name, { on, delayMin } = {}) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        const now = this.watchdog(name);
        const minutes = delayMin === undefined ? now.delayMin : delayMin;
        if (!Number.isInteger(minutes) || minutes < WATCHDOG_MIN || minutes > WATCHDOG_MAX) throw new Refusal(400, `The watchdog waits ${WATCHDOG_MIN} to ${WATCHDOG_MAX} minutes.`);
        const next = { on: on === undefined ? now.on : on !== false, delayMin: minutes };
        /* Kept only where it differs from the default. */
        const kept = { ...(next.on ? {} : { on: false }), ...(next.delayMin === WATCHDOG_DELAY_MIN ? {} : { delayMin: next.delayMin }) };
        this.#store.patch(name, { watchdog: Object.keys(kept).length ? kept : undefined });
        return this.machineState(name);
    }

    /* THE WAY DOWN, AS ITS OWNER CHOSE (a default, changed per conversation): on (the default), a stop
       that hangs goes on to its own qemu by itself; off, it stops after the VM manager's own ways, and
       the page offers to go further. */
    setStopEscalate(name, on) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        this.#store.patch(name, { stopEscalate: on === false ? false : undefined });
        return this.machineState(name);
    }

    /* AN ACTION, RUN TO ITS END: start, stop, sleep, force (a restart and a resize run #cycle). Gives
       its machine back, writes its report, resolves with it. */
    async #perform(name, act) {
        const c = this.#store.get(name);
        const kind = act.kind;
        let result = { ok: false };
        try {
            this.#cancelStop(name);
            if (kind === 'start') {
                const before = await this.#vms.state(name).catch(() => undefined);
                this.#plan(name, act, ['start']);
                this.#stepAt(name, act, 'start', 'start');
                act.ctl = new AbortController();
                if (act.preempted) act.ctl.abort();
                const r = act.preempted ? { code: 143, aborted: true } : await this.#vms.start(name, { signal: act.ctl.signal });
                if (r.aborted) result = { ok: false, preempted: true };
                else {
                    const now = await this.#vms.state(name).catch(() => undefined);
                    this.#stepAt(name, act, 'start', now === 'Running' ? 'ok' : 'fail');
                    result = now === 'Running' ? { ok: true } : { ok: false, more: firstLine(r.stderr) || firstLine(r.stdout) || `it is ${now ?? 'in a state that could not be read'}` };
                    if (now === 'Running') {
                        /* From a stop, whatever was in its memory is gone: the next opening prepares it again, its folders
                           first. From sleep, it is as it was. */
                        if (before !== 'Suspended') { this.#fresh.add(name); this.#mountAgain.add(name); }
                        this.#store.patch(name, { asleep: false, stopped: undefined });
                    }
                }
            } else if (kind === 'sleep') {
                this.#plan(name, act, ['suspend']);
                this.drop(name);
                act.ctl = new AbortController();
                const r = await this.#vms.suspend(name, { signal: act.ctl.signal, onLine: (line) => this.#seen(name, act, line) });
                if (r.aborted) result = { ok: false, preempted: true };
                else {
                    if (act.current) this.#stepAt(name, act, act.current, r.code === 0 ? 'ok' : 'fail');
                    if (!act.steps.some((x) => x.state !== 'todo')) this.#stepAt(name, act, 'suspend', r.code === 0 ? 'ok' : 'fail');
                    result = r.code === 0 ? { ok: true } : { ok: false, more: firstLine(r.stderr) || `exit ${r.code}` };
                    /* Remembered: a sleep that was asked for holds until somebody wakes
                       it on purpose. A page that merely reloads must not wake it. */
                    if (r.code === 0) this.#store.patch(name, { asleep: true, stopped: undefined });
                }
            } else {
                /* stop, force: the way down, all of it or from its own qemu. */
                this.#plan(name, act, kind === 'force' ? ['term', 'kill', 'check'] : this.#downSteps(name));
                await this.#calm(name, () => {});
                this.drop(name);
                result = await this.#down(name, act, { hard: kind === 'force' });
                /* Stopped: no longer asleep (its saved state is gone); it stays stopped until somebody starts it. */
                if (result.ok) this.#store.patch(name, { asleep: false, stopped: true });
            }
        } catch (error) { result = { ok: false, more: error instanceof Refusal ? error.message : 'an unexpected error' }; }
        let report;
        try { report = this.#report(name, act, { ...result, why: result.preempted ? 'Force stop took its place.' : undefined, chat: true }); }
        finally { this.#give(name, act); }
        /* Started: its tool starts in its terminal, as after any start (once the machine is given back). */
        if (kind === 'start' && result.ok) try { this.ready(name); } catch { /* the next opening starts it */ }
        return report;
    }

    /* THE REPORT OF AN ACTION, kept on the conversation (`machineReport`), the steps it took with
       their seconds, the memory freed, and what to do when it failed (`advice`: force | manager |
       again | look); said in the journal, and in its chat when `chat`. */
    #report(name, act, { ok, freedGb, more, why, chat = true, preempted = false }) {
        const steps = act.steps.filter((x) => x.state !== 'todo').map(({ id, state, s }) => ({ id, result: state, ...(s !== undefined ? { s } : {}) }));
        const check = act.steps.find((x) => x.id === 'check');
        const freed = freedGb ?? check?.freedGb;
        const left = /qemu-left/.test(more ?? check?.more ?? '');
        const mute = /mute/.test(more ?? check?.more ?? '');
        const advice = ok || preempted ? undefined : left ? (act.until === 'force' ? 'force' : 'manager') : mute ? 'manager' : act.kind === 'sleep' ? 'force' : act.kind === 'force' || act.kind === 'stop' ? 'manager' : 'again';
        const seconds = Math.max(0, Math.round((Date.now() - Date.parse(act.since)) / 1000));
        const [yes, no] = KIND_WORDS[act.kind] ?? ['Done', 'Not done'];
        const listed = steps.filter((x) => x.result !== 'skip').map((x) => `${STEP_WORDS[x.id] ?? x.id} ${x.result === 'ok' ? '' : `${x.result} `}${x.s ?? 0} s`).join(', ');
        const advised = { force: ' Use Force stop.', manager: ' The VM manager may need a restart: that is your call.', again: ' Try again in a moment.', look: ' Look at its state.' }[advice] ?? '';
        const said = `${ok ? yes : no} in ${seconds} s${listed ? ` (${listed})` : ''}${ok && freed ? `, ${freed.toFixed(1)} GB freed` : ''}.${!ok && why ? ` ${why}` : ''}${!ok && !why && more ? ` ${more}.` : ''}${advised}`;
        const report = { kind: act.kind, ok: Boolean(ok), at: new Date().toISOString(), s: seconds, steps, ...(freed !== undefined ? { freedGb: freed } : {}), ...(advice ? { advice } : {}), ...(preempted ? { preempted: true } : {}), said };
        if (this.#store.get(name)) this.#store.patch(name, { machine: undefined, machineReport: report });
        try { this.machineSaid(name, said, Boolean(ok), chat); } catch { /* told, nothing more */ }
        return { ...report, ...(why ? { why } : more ? { why: more } : {}) };
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
        if (this.#store.get(name).sharedMachine) await this.#leaveShared(name, { erase: false });
        else {
            this.#store.remove(name);
            if (await this.#vms.state(name, { fresh: true }) !== undefined) await this.#vms.remove(name);
        }
        /* Its work is moved aside on the server, not erased. */
        if (kept) await this.#vms.workAside(name);
    }

    /* OUT OF A SHARED MACHINE (#221): its programs ended, its work taken out of its place there, the host told;
       its user and home removed when it is erased (kept when archived). The machine itself goes only with the last
       conversation that lived in it. The record is removed here, before the machine is looked at. */
    async #leaveShared(name, { erase }) {
        const shared = this.#store.get(name).sharedMachine;
        const others = this.#store.all().filter((x) => x.name !== name && x.sharedMachine === shared);
        const running = (await this.#vms.state(name, { fresh: true }).catch(() => undefined)) === 'Running';
        if (running) {
            await this.#vms.execMachine(name, ['sudo', '-n', 'pkill', '-KILL', '-u', `c-${name}`], { timeoutMs: 30_000 }).catch(() => {});
            await this.#vms.workUnmount(name).catch(() => {});
            if (erase) await this.#vms.execMachine(name, ['sudo', '-n', 'userdel', '--remove', `c-${name}`], { timeoutMs: 60_000 }).catch(() => {});
            if (erase) await this.#vms.execMachine(name, ['sudo', '-n', 'rm', '-f', `/etc/clavarium/limits/${name}`], { timeoutMs: 30_000 }).catch(() => {});
        }
        await this.#vms.unshare(name).catch(() => {});
        const last = others.length === 0;
        const state = last ? await this.#vms.state(name, { fresh: true }).catch(() => undefined) : undefined;
        this.#store.remove(name);
        /* (Its name gone from the store, the VM manager is still reached through the machine's own name.) */
        if (last && state !== undefined) await this.#vms.removeVm(`clv-${shared}`);
    }

    /* DELETED FOR GOOD (01-11, its owner's ask, confirmed by typing its name): as archived, but its work is
       erased, not put aside. Whatever state its machine is in -- one that never started too. */
    async erase(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such conversation.');
        this.#cancelStop(name);
        this.drop(name);
        const kept = this.#store.get(name).work === 'kept';
        if (this.#store.get(name).sharedMachine) await this.#leaveShared(name, { erase: true });
        else {
            this.#store.remove(name);
            if (await this.#vms.state(name, { fresh: true }) !== undefined) await this.#vms.remove(name);
        }
        if (kept) {
            const r = await this.#vms.workErase(name);
            if (r?.code) throw new Refusal(500, `Its machine is deleted, but its files could not be erased: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        }
    }

    /* ITS TOOL ENDED, ITS MACHINE STOPPED -- unless it is a shared machine (#221) where another conversation still
       has its tool, a screen or an action: then only this one's programs end, the others go on. */
    async #stopUnlessShared(name) {
        const shared = this.#store.get(name)?.sharedMachine;
        if (!shared) return this.#vms.stop(name);
        for (const other of this.#store.all().filter((x) => x.name !== name && x.sharedMachine === shared)) {
            if (this.#watching.has(other.name) || this.#acts.has(other.name) || this.#timers.has(other.name)) return this.#endShared(name);
            const alive = await this.#vms.exec(other.name, ['tmux', '-L', SOCKET, 'has-session', '-t', `=${SESSION}`]).catch(() => ({ code: 1 }));
            if (alive.code === 0) return this.#endShared(name);
        }
        return this.#vms.stop(name);
    }
    #endShared(name) { return this.#vms.execMachine(name, ['sudo', '-n', 'pkill', '-KILL', '-u', `c-${name}`], { timeoutMs: STEP_MS }).catch(() => undefined); }

    /* ITS SHARE OF A SHARED MACHINE (#221): its memory there is its limit, at most the machine's; set without
       stopping anything, read by its door when its tool starts again. Cores and disk are the machine's. */
    async #limitShared(name, c, tool, { memoryMb, diskGb, cpus } = {}) {
        if ((diskGb !== undefined && diskGb !== null && diskGb !== '' && Number(diskGb) !== (c.diskGb ?? DISK_GB)) || (cpus !== undefined && cpus !== null && cpus !== '' && Number(cpus) !== (c.cpus ?? 1))) throw new Refusal(400, `Cores and disk are those of the shared machine ${c.sharedMachine}.`);
        const memory = Number(memoryMb);
        const size = this.#machineMbOf(c.sharedMachine);
        const least = tool?.memoryMb ?? 512;
        if (!Number.isInteger(memory) || memory < least || memory > size) throw new Refusal(400, `Its memory is between ${least} MB (what ${tool?.label ?? 'its tool'} needs) and ${size} MB (its shared machine's).`);
        if (memory === c.memoryMb) throw new Refusal(409, 'Nothing to change: it already has this.');
        const r = await this.#vms.execMachine(name, ['sudo', '-n', 'install', '-D', '-m', '0644', '-o', 'root', '-g', 'root', '/dev/stdin', `/etc/clavarium/limits/${name}`], { input: `mem=${memory}\nprocs=${SHARED_PROCS}\n`, timeoutMs: STEP_MS });
        if (r.code !== 0) throw new Refusal(502, `Its limit could not be set: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        this.#store.patch(name, { memoryMb: memory, restarted: `Its limit is now ${memory} MB, from its tool's next start.` });
        return this.#store.get(name);
    }

    /* A SHARED MACHINE GIVEN MORE OR LESS MEMORY (#221), from the settings of any conversation in it: never less than
       the largest limit of those in it; stopped cleanly, set, started again -- every conversation in it is
       interrupted, the page says so before. Each then finds its place again (its work mounted) at its next opening. */
    async resizeShared(name, { machineMb } = {}) {
        const c = this.#busyCheck(name);
        if (!c.sharedMachine) throw new Refusal(400, 'Not in a shared machine.');
        const all = this.#store.all().filter((x) => x.sharedMachine === c.sharedMachine);
        const now = this.#machineMbOf(c.sharedMachine);
        const size = Number(machineMb);
        const largest = Math.max(...all.map((x) => Number(x.memoryMb) || 0));
        if (!Number.isInteger(size) || size < Math.max(1024, largest) || size > 16384) throw new Refusal(400, `The machine ${c.sharedMachine} has ${Math.max(1024, largest)} to 16384 MB (no less than the largest of its conversations).`);
        if (size === now) throw new Refusal(409, 'Nothing to change: it already has this.');
        for (const x of all) if (this.#acts.has(x.name)) throw this.#busy(x.name);
        const state = await this.#vms.state(name, { fresh: true }).catch(() => undefined);
        if (state === undefined) throw new Refusal(410, 'The shared machine no longer exists.');
        await this.room({ kind: 'grow', name, memoryMb: state === 'Running' ? Math.max(0, size - now) : 0, diskMb: 0 });
        for (const x of all) { this.#cancelStop(x.name); this.drop(x.name); }
        const fail = (what, r) => new Refusal(502, `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
        if (state !== 'Stopped') { const r = await this.#vms.stop(name); if (r.code !== 0) throw fail('The shared machine did not stop', r); }
        const set = await this.#vms.setMemory(name, size);
        if (set.code !== 0) { await this.#vms.start(name).catch(() => undefined); throw fail('Its memory could not be set', set); }
        const started = await this.#vms.start(name);
        for (const x of all) {
            this.#store.patch(x.name, { machineMb: size, toolStarted: false, restarted: `Its shared machine was restarted with ${size} MB.` });
            this.#mountAgain.add(x.name); this.#fresh.add(x.name);
        }
        if (started.code !== 0) throw fail('The shared machine did not start again', started);
        return this.#store.get(name);
    }

    #cancelStop(name) {
        const timer = this.#timers.get(name);
        if (timer) { clearTimeout(timer); this.#timers.delete(name); }
    }
}
