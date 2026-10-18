/* THE LIFE OF A CONVERSATION: created, built, opened, left running, rested,
   archived. See blueprint/architecture.html, "When does a VM stop?".
 *
 *   - closing the page stops NOTHING: the tool keeps working in its VM;
 *   - once the tool has exited, the VM is stopped after a short delay;
 *   - Sleep is a button, never a guess: telling a long job from an idle tool
 *     cannot be done without reading the tool, and this server does not read.
 */
import { isConversationName } from './names.mjs';
import { attachCommand, SOCKET } from './tmux.mjs';
import { WORK, VM_USER, SHARING_STEP } from './vm.mjs';
import { resumeOrFresh } from './tools.mjs';

export const SESSION = 'main';
export const STOP_DELAY_MS = 60_000;
const STEP_MS = 15 * 60_000;
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
export class Refusal extends Error {
    constructor(status, message, { retry = false } = {}) { super(message); this.status = status; if (retry) this.retry = true; }
}

/* A machine built: it starts, is prepared, gets its tool, its folders, and
   the tool starts -- a new disk holds no session to take up. */
const buildProgress = (since) => ({ kind: 'build', steps: ['starting', 'preparing', 'installing', 'folders', 'tool'], at: 0, since, stepSince: since });

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Conversations {
    #store; #vms; #tools; #stopDelayMs; #timers = new Map(); #watching = new Map(); #fresh = new Set(); #mountAgain = new Set(); #uid; #gid;
    /* Set by the server: prepares the VM before the tool is attached, and
       names the program the tool is started through. See secrets.mjs. */
    prepare = async () => {};
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
    /* Set by the server: told when its machine was restarted or built again
       by this server, in words for its chat, and whether the tool runs again
       (its chat says it, and the tool is told to read it again: talk.mjs). */
    renewed = () => {};
    /* Set by the server: throws a Refusal, in words, when creating, starting
       or growing a machine would leave this server less than its reserve
       (capacity.mjs). `{ kind: 'create'|'start'|'grow', name, memoryMb, diskMb }`. */
    room = async () => {};

    /* `uid`/`gid`: the account this server runs as; files the tool writes in
       its kept work folder belong to it on the host. */
    #startingMs; #answerMs; #pollMs;
    constructor({ store, vms, tools, stopDelayMs = STOP_DELAY_MS, uid = process.getuid(), gid = process.getgid(), startingMs = STARTING_MS, answerMs = ANSWER_MS, pollMs = POLL_MS }) {
        this.#store = store; this.#vms = vms; this.#tools = tools; this.#stopDelayMs = stopDelayMs; this.#uid = uid; this.#gid = gid;
        this.#startingMs = startingMs; this.#answerMs = answerMs; this.#pollMs = pollMs;
        /* A build interrupted by a restart of this server cannot be resumed
           blindly: it is marked failed, and says so. */
        for (const c of store.all()) {
            /* A move cut short leaves the machine as it was at that moment:
               it is said, with where to look, rather than guessed at. */
            if (c.phase === 'moving') store.patch(c.name, { phase: 'ready', step: undefined, moved: 'The server restarted while the work folder was being moved. The files are safe, in the machine: look at /work, /work.before-move and /work.moving.' });
            if (c.phase === 'building') store.patch(c.name, { phase: 'failed', error: 'The server restarted while this conversation was being built. Build it again, or archive it.' });
            if (c.phase === 'restarting') store.patch(c.name, { phase: 'ready', step: undefined, restartingSince: undefined, restarted: 'The server restarted while this machine was being restarted: look at its state, and restart it again if needed.' });
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
    tools() { return this.#tools.map(({ id, label, memoryMb, resume, rights }) => ({ id, label, memoryMb, resumes: Boolean(resume), rights: Boolean(rights) })); }

    /* The sign-in rules of a conversation's tool, or undefined. */
    signinRules(name) { return this.#tools.find((t) => t.id === this.#store.get(name)?.tool)?.signin; }

    list() {
        return this.#store.all().map((c) => {
            const tool = this.#tools.find((t) => t.id === c.tool);
            /* An AI tool has an instruction file; a shell has none: what is dictated there is never marked. */
            return { ...c, toolLabel: tool?.label ?? c.tool, memoryMinMb: tool?.memoryMb, resumes: Boolean(tool?.resume), rights: Boolean(tool?.rights), ai: Boolean(tool?.instructions), voiceMark: Boolean(tool?.instructions) && c.voiceMark !== false };
        });
    }

    get(name) { return this.#store.get(name); }

    /* Whether a new machine may be made for this request: what `create`
       checks, and the server's room (capacity.mjs). Asked before `create`. */
    async admit({ name, tool, memoryMb } = {}) {
        const chosen = this.#tools.find((t) => t.id === tool);
        /* What `create` refuses anyway is said by `create`. */
        if (!chosen || !isConversationName(name) || this.#store.get(name)) return;
        const memory = memoryMb ?? chosen.memoryMb;
        if (!Number.isInteger(memory)) return;
        await this.room({ kind: 'create', memoryMb: memory });
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
        const now = new Date().toISOString();
        const conversation = { name, tool, memoryMb: memory, diskGb: DISK_GB, fixed: FIXES, work: workOnDisk === true ? 'disk' : 'kept', phase: 'building', step: 'Starting the machine', createdAt: now, buildingSince: now, progress: buildProgress(now) };
        this.#store.put(conversation);
        this.built = this.#build(name, chosen, memory);
        return conversation;
    }

    /* `again`: a machine built anew for a conversation that had one. */
    async #build(name, tool, memoryMb, again = false) {
        const fail = (what, r) => { this.#store.patch(name, { phase: 'failed', step: undefined, progress: undefined, error: `${what}: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}` }); };
        /* A COPY OF THE READY-MADE MACHINE when there is one that holds this
           tool (see shelf.mjs): it only has to boot. Anything wrong with the
           copy -- an older VM manager without "clone", a copy that does not
           start -- and it is removed and the machine is built the long way,
           as if there were no shelf. */
        const from = this.shelf.pick(tool);
        let readyMade = false;
        if (from) {
            const cloned = await this.#vms.clone(name, from, memoryMb);
            const started = cloned.code === 0 ? await this.#vms.start(name) : cloned;
            readyMade = started.code === 0;
            if (!readyMade && await this.#vms.state(name) !== undefined) await this.#vms.remove(name);
            if (!this.#store.get(name)) return undefined; /* archived meanwhile */
        }
        if (!readyMade) {
            const launched = await this.#vms.launch(name, memoryMb);
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
        await this.room({ kind: 'create', name, memoryMb: c.memoryMb });
        this.#cancelStop(name);
        this.drop(name);
        /* Marked first: two requests cannot both start a build. */
        const now = new Date().toISOString();
        this.#store.patch(name, { phase: 'building', step: 'Starting the machine', error: undefined, asleep: false, buildingSince: now, progress: buildProgress(now) });
        this.built = (async () => {
            /* What a failed build left behind is cleared away first. */
            if (state !== undefined) await this.#vms.remove(name);
            return this.#build(name, tool, c.memoryMb, true);
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
        /* A start that fails here ends what the page was shown of it: the
           page then opens the terminal itself, and says what went wrong. */
        try { return await this.#opening(name, c, say); } catch (error) { this.#end(name); throw error; }
    }

    async #opening(name, c, say) {
        const tool = this.#tools.find((t) => t.id === c.tool);
        /* Each step reached is told to the screen that opens, with the steps
           (the record has them too, for any other page). */
        const tell = (text) => say(text, this.#store.get(name)?.progress);
        let state = await this.#vms.state(name);
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
        const stopped = state !== 'Running';
        /* Asleep, its memory was kept: the tool may still be there, as it was. */
        const asleep = state === 'Suspended';
        let woke = this.#fresh.delete(name) || stopped;
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
            await Promise.race([Promise.resolve().then(() => this.mounted(name, again)).catch(() => {}), new Promise((r) => { setTimeout(r, MOUNTED_MS).unref?.(); })]);
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
        const argv = this.#vms.execArgv(name, attachCommand(SESSION, [...this.through, ...this.#command(name, tool)], WORK));
        for (const id of ['resume', 'fresh', 'first']) this.#reach(name, id);
        tell();
        return argv;
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
        return resume ? resumeOrFresh([...tool.resume, ...rights], [...tool.command, ...rights]) : [...tool.command, ...rights];
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
       was asked. */
    async restart(name) {
        const c = this.#busyCheck(name);
        const release = this.#claim(name, 'restarting', 'Looking at the machine');
        let state;
        try {
            state = await this.#vms.state(name);
            if (state === undefined) throw new Refusal(410, 'The machine of this conversation no longer exists.');
            /* A machine that does not run is started: it takes its memory again. */
            if (state !== 'Running') await this.room({ kind: 'start', name, memoryMb: c.memoryMb });
        } catch (error) { release(); throw error; }
        this.#cancelStop(name);
        const since = new Date().toISOString();
        this.#store.patch(name, { phase: 'restarting', restartingSince: since, step: 'Stopping the machine', restarted: undefined });
        const tool = this.#tools.find((t) => t.id === c.tool);
        this.#begin(name, 'restart', [...(state === 'Stopped' ? [] : ['stopping']), 'starting', 'answering', 'folders', 'tool', ...this.#resumeStep(c, tool)], since);
        this.restarted = this.#cycle(name, c, async () => undefined, true)
            .then((failure) => this.#settle(name, failure ? `Not restarted: ${failure}` : 'Restarted.', failure ? `Its machine was not restarted: ${failure}` : 'Its machine was restarted: the tool started again.', Boolean(failure)));
        return this.#store.get(name);
    }

    /* GIVES ITS MACHINE MORE OR LESS MEMORY, OR A LARGER DISK. The VM
       manager takes it only from a stopped machine: a running one is
       stopped (cleanly first), set, and started again -- its work folder,
       its folders and its branches are not touched. A disk only grows.
       What is recorded afterwards is what the VM manager says it has. */
    async resize(name, { memoryMb, diskGb } = {}) {
        const c = this.#busyCheck(name);
        const tool = this.#tools.find((t) => t.id === c.tool);
        const memory = memoryMb === undefined || memoryMb === null || memoryMb === '' ? c.memoryMb : Number(memoryMb);
        const disk = diskGb === undefined || diskGb === null || diskGb === '' ? c.diskGb ?? DISK_GB : Number(diskGb);
        const least = tool?.memoryMb ?? 512;
        /* Memory is checked only when it changes: a machine made when its tool
           needed less keeps what it has, and its disk can still grow. */
        if (memory !== c.memoryMb && (!Number.isInteger(memory) || memory < least || memory > MEMORY_MAX_MB)) throw new Refusal(400, `Memory is between ${least} MB (what ${tool?.label ?? 'its tool'} needs) and ${MEMORY_MAX_MB} MB.`);
        if (!Number.isInteger(disk) || disk > DISK_MAX_GB) throw new Refusal(400, `A disk is at most ${DISK_MAX_GB} GB.`);
        if (disk < (c.diskGb ?? DISK_GB)) throw new Refusal(400, `A disk can only grow: it has ${c.diskGb ?? DISK_GB} GB.`);
        if (memory === c.memoryMb && disk === (c.diskGb ?? DISK_GB)) throw new Refusal(409, 'Nothing to change: it already has this.');
        if (c.asleep === true) throw new Refusal(409, 'It is asleep: wake it first, then change its memory or its disk.');
        const release = this.#claim(name, 'restarting', 'Looking at the machine');
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
        const set = async () => {
            this.#reach(name, 'setting');
            if (memory !== c.memoryMb) {
                this.#store.patch(name, { step: `Setting its memory to ${memory} MB` });
                const r = await this.#vms.setMemory(name, memory);
                if (r.code !== 0) return `its memory could not be set (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}).`;
            }
            if (disk !== (c.diskGb ?? DISK_GB)) {
                this.#store.patch(name, { step: `Growing its disk to ${disk} GB` });
                const r = await this.#vms.setDisk(name, disk);
                if (r.code !== 0) return `its disk could not be grown (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}).`;
            }
            return undefined;
        };
        this.resized = this.#cycle(name, c, set, state === 'Running').then(async (failure) => {
            await this.reconcile(name);
            const now = this.#store.get(name);
            const said = `${now?.memoryMb ?? memory} MB of memory, ${now?.diskGb ?? disk} GB of disk`;
            await this.#settle(name, failure ? `Not changed: ${failure} It has ${said}.` : `It now has ${said}.`, failure ? `Its machine was not changed: ${failure} It has ${said}.` : `Its machine was restarted with ${said}: the tool started again.`, Boolean(failure));
        });
        return this.#store.get(name);
    }

    /* What the VM manager says the machine has, written in its record. */
    async reconcile(name) {
        if (!this.#store.get(name)) return;
        const real = await this.#vms.size(name).catch(() => ({}));
        const patch = {};
        if (real.memoryMb !== undefined && real.memoryMb !== this.#store.get(name).memoryMb) patch.memoryMb = real.memoryMb;
        if (real.diskGb !== undefined && real.diskGb !== this.#store.get(name).diskGb) patch.diskGb = real.diskGb;
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
        return c;
    }

    /* Stops the machine (cleanly, then by force), runs `between` on the
       stopped machine, and starts it again when `restart`. Returns what
       went wrong, in words, or undefined. */
    async #cycle(name, c, between, restart) {
        const step = (text) => { if (this.#store.get(name)) this.#store.patch(name, { step: text }); };
        try {
            this.drop(name);
            let state = await this.#vms.state(name);
            if (state !== 'Stopped') {
                step('Stopping the machine');
                /* A machine asleep cannot be stopped cleanly: it is not running. */
                const clean = state === 'Suspended' ? { code: 1 } : await this.#watched(name, 'stop', this.#vms.stop(name, STOP_MS));
                state = await this.#vms.state(name);
                if (clean.code !== 0 || state !== 'Stopped') {
                    step('Stopping the machine by force');
                    await this.#watched(name, 'stop', this.#vms.kill(name));
                    state = await this.#vms.state(name);
                }
                if (state !== 'Stopped') return `the machine did not stop (it is ${state ?? 'gone'}).`;
            }
            const failed = await between();
            if (!restart) return failed;
            step('Starting the machine');
            this.#reach(name, 'starting');
            const started = await this.#watched(name, 'start', this.#vms.start(name));
            if (started.code !== 0) return `${failed ? `${failed} And ` : ''}the machine did not start (${firstLine(started.stderr) || firstLine(started.stdout) || `exit ${started.code}`}).`;
            /* Whatever was put in its memory is gone: the next opening prepares it again, its folders first. */
            this.#fresh.add(name);
            this.#mountAgain.add(name);
            this.#reach(name, 'answering');
            return failed;
        } catch { return 'it stopped on an unexpected error.'; }
    }

    /* `chat`: the same, as its chat says it. */
    async #settle(name, said, chat, failed = false) {
        if (!this.#store.get(name)) return;
        const running = (await this.#vms.state(name).catch(() => undefined)) === 'Running';
        this.#store.patch(name, { phase: 'ready', step: undefined, restartingSince: undefined, asleep: false, restarted: said });
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
