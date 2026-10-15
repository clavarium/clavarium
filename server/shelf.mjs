/* THE READY-MADE MACHINE ("the shelf").
 *
 * Building a conversation's machine from the stock image takes about six
 * minutes: the image boots and sets itself up, the piece that shares folders
 * is installed, then Node.js and the tool. So that is done ONCE, in advance,
 * in a machine of its own -- then that machine is stopped, and each new
 * conversation gets a COPY of it (`multipass clone`): it only has to boot.
 *
 * What makes a machine itself (its machine-id, its SSH host keys, its
 * cloud-init instance) is wiped before it is stopped, so that every copy
 * makes its own at its first start: copies are not identical twins. That is
 * done by the host program ("shelf seal"), never from here.
 *
 * Rules, all of them here:
 *   - a conversation is copied from it only if it is younger than MAX_AGE
 *     and holds the tool, installed by exactly the steps the catalogue gives
 *     today. Otherwise the build goes the long way, as before: nothing is
 *     ever worse than without a shelf;
 *   - it is rebuilt once a month, in the background, and on demand. While
 *     that runs, new conversations are copied from the one there is;
 *   - at most two are kept (the one in use and the one before it): the one
 *     before is removed when a rebuild starts;
 *   - a rebuild is refused when the host has less than MIN_FREE_MB free, and
 *     the page says so;
 *   - copies are independent machines: removing or rebuilding the shelf
 *     never touches a conversation.
 */
import { createHash } from 'node:crypto';
import { Refusal } from './conversations.mjs';
import { NODE_STEPS, NPM_WRITABLE } from './tools.mjs';
import { SHARING_STEP } from './vm.mjs';

const DAY = 24 * 60 * 60_000;
export const REFRESH_MS = 30 * DAY;
/* A little more than a month: a monthly rebuild that failed for a few days
   does not send every new conversation the long way at once. */
export const MAX_AGE_MS = 40 * DAY;
export const MIN_FREE_MB = 6 * 1024;
/* After a failed or refused rebuild, the next automatic try waits this long. */
export const RETRY_MS = DAY;
export const CHECK_EVERY_MS = 60 * 60_000;
/* The first look after the server starts: not at once, so that a start is not
   slowed by a heavy job. */
export const FIRST_CHECK_MS = 5 * 60_000;
const LAUNCH_MS = 16 * 60_000;
const STEP_MS = 20 * 60_000;
const SHORT_MS = 5 * 60_000;
const NAME = /^clvshelf-\d{8}-\d{6}$/;
const KEY = 'shelf';
const APT = ['sudo', '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get'];

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';
const said = (r) => firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
const gb = (mb) => (mb / 1024).toFixed(1);

/* "clvshelf-" and the moment, in UTC: names sort by age, and never look like
   a conversation's machine ("clv-..."). */
export function shelfName(date) {
    const iso = date.toISOString();
    return `clvshelf-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

/* What a tool's install IS: its steps, exactly. A tool whose recipe changed
   in the catalogue is not taken from a shelf built with the old recipe. */
export function toolSignature(tool) {
    return createHash('sha256').update(JSON.stringify(tool.steps.map((s) => [s.argv, s.input ?? null]))).digest('hex').slice(0, 16);
}

/* Everything a conversation's build would do, done once: the system brought
   up to date (the image may be weeks older than its packages), sharing made
   possible, and every tool of the catalogue installed. A step that several
   tools share (Node.js) is done once. Then caches are emptied, as they would
   be copied into every conversation. */
export function preparation(tools) {
    const steps = [
        { label: 'Updating the system', argv: NODE_STEPS[0].argv },
        { label: 'Updating the system', argv: [...APT, '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'upgrade', '-y', '-q'] },
        { label: 'Preparing for shared folders', argv: SHARING_STEP },
    ];
    const seen = new Set(steps.map((s) => JSON.stringify([s.argv, null])));
    /* What npm installed becomes the machine user's AFTER every tool is
       installed: done once at the end, not where the first tool asked for it
       (a later tool's install, as root, would undo it). */
    for (const step of NPM_WRITABLE) seen.add(JSON.stringify([step.argv, null]));
    for (const tool of tools) {
        for (const step of tool.steps) {
            const key = JSON.stringify([step.argv, step.input ?? null]);
            if (seen.has(key)) continue;
            seen.add(key);
            steps.push({ label: `Installing ${tool.label}`, argv: step.argv, ...(step.input === undefined ? {} : { input: step.input }) });
        }
    }
    if (tools.some((tool) => tool.fixups?.length > 0)) for (const step of NPM_WRITABLE) steps.push({ label: 'Letting the tools update themselves', argv: step.argv });
    steps.push(
        { label: 'Tidying up', argv: ['sudo', '-n', 'apt-get', 'clean'] },
        { label: 'Tidying up', argv: ['sudo', '-n', 'rm', '-rf', '/root/.npm'] },
        { label: 'Tidying up', argv: ['rm', '-rf', '.npm'] },
    );
    return steps;
}

/* THE AGE RULE: a shelf is used until it is MAX_AGE old. */
export function fresh(record, now, maxAgeMs = MAX_AGE_MS) {
    const built = Date.parse(record?.builtAt ?? '');
    return Number.isFinite(built) && now - built <= maxAgeMs;
}

/* THE CHOICE: the name of the ready-made machine to copy for this tool, or
   undefined for the long way. */
export function readyMadeFor(record, tool, now, maxAgeMs = MAX_AGE_MS) {
    if (!record || !NAME.test(record.name ?? '') || !fresh(record, now, maxAgeMs)) return undefined;
    return record.tools?.[tool.id] === toolSignature(tool) ? record.name : undefined;
}

/* THE DISK RULE: what is free, plus what removing the previous shelf will
   give back, must reach the margin. */
export function enoughRoom(freeMb, freedMb = 0, minFreeMb = MIN_FREE_MB) {
    return Number.isFinite(freeMb) && freeMb + (freedMb || 0) >= minFreeMb;
}

export class Shelf {
    #store; #run; #tools; #now; #maxAgeMs; #refreshMs; #minFreeMb; #retryMs; #busy = false; #recovering = Promise.resolve();
    /* The rebuild running now, if any (for tests). */
    job;

    /* `run(argv, options)` reaches the host program, as in vm.mjs. */
    constructor({ store, run, tools, now = () => Date.now(), maxAgeMs = MAX_AGE_MS, refreshMs = REFRESH_MS, minFreeMb = MIN_FREE_MB, retryMs = RETRY_MS }) {
        this.#store = store; this.#run = run; this.#tools = tools; this.#now = now;
        this.#maxAgeMs = maxAgeMs; this.#refreshMs = refreshMs; this.#minFreeMb = minFreeMb; this.#retryMs = retryMs;
    }

    #get() { return this.#store.get(KEY) ?? { name: KEY }; }
    #set(changes) { this.#store.put({ ...this.#get(), ...changes }); }

    /* For a conversation's build: what to copy, or undefined. */
    pick(tool) { return readyMadeFor(this.#get().current, tool, this.#now(), this.#maxAgeMs); }

    /* What Settings shows. */
    about() {
        const s = this.#get();
        const now = this.#now();
        const describe = (r) => r && {
            builtAt: r.builtAt, sizeMb: r.sizeMb ?? null, fresh: fresh(r, now, this.#maxAgeMs),
            refreshAt: new Date(Date.parse(r.builtAt) + this.#refreshMs).toISOString(),
            tools: this.#tools.filter((t) => r.tools?.[t.id] === toolSignature(t)).map((t) => t.label),
        };
        return {
            current: describe(s.current) ?? null, previous: describe(s.previous) ?? null,
            building: s.building ? { since: s.building.since, step: s.building.step } : null,
            error: s.error ?? null, refused: s.refused ?? null,
            minFreeMb: this.#minFreeMb, maxAgeDays: Math.round(this.#maxAgeMs / DAY), refreshDays: Math.round(this.#refreshMs / DAY),
        };
    }

    /* At start: a rebuild cut short by a restart cannot be resumed; its
       machine is removed, and that is said. A recorded shelf that does not
       exist (a backup put back on another computer) is forgotten. A
       ready-made machine nobody knows of is removed: only ours are listed. */
    recover() {
        this.#recovering = this.#recover().catch(() => {});
        return this.#recovering;
    }

    async #recover() {
        const s = this.#get();
        const changes = {};
        if (s.building) Object.assign(changes, { building: undefined, error: 'The server restarted during a rebuild. It will be tried again.', failedAt: this.#now() });
        for (const which of ['current', 'previous']) {
            if (s[which] && (await this.#run(['shelf', 'info', s[which].name])).code !== 0) changes[which] = undefined;
        }
        if (Object.keys(changes).length) this.#set(changes);
        const known = new Set([this.#get().current?.name, this.#get().previous?.name].filter(Boolean));
        const listed = await this.#run(['shelf', 'list']);
        if (listed.code !== 0) return;
        for (const name of listed.stdout.split('\n').map((x) => x.trim()).filter((x) => NAME.test(x))) {
            if (!known.has(name)) await this.#run(['shelf', 'delete', name], { timeoutMs: SHORT_MS });
        }
    }

    /* Starts a rebuild in the background. Refused while one runs, and when
       the disk is short -- remembered, so that the page says it. */
    async rebuild() {
        if (this.#busy || this.#get().building) throw new Refusal(409, 'The ready-made machine is already being rebuilt.');
        /* Taken before the first wait: two clicks cannot start two rebuilds. */
        this.#busy = true;
        try {
            /* Not while the start-up tidying runs: it would take the new one
               for a leftover. */
            await this.#recovering;
            const room = await this.#run(['shelf', 'room']);
            const free = /^free (\d+)$/m.exec(room.stdout ?? '');
            if (room.code !== 0 || !free) throw new Refusal(502, `The room left on the server could not be read: ${said(room)}`);
            if (!enoughRoom(Number(free[1]), this.#get().previous?.sizeMb ?? 0, this.#minFreeMb)) {
                const text = `Not rebuilt: ${gb(Number(free[1]))} GB free on the server, ${gb(this.#minFreeMb)} GB needed. Make room (archive conversations you no longer need), then try again.`;
                this.#set({ refused: { at: new Date(this.#now()).toISOString(), text }, failedAt: this.#now() });
                throw new Refusal(409, text);
            }
        } catch (error) { this.#busy = false; throw error; }
        const name = shelfName(new Date(this.#now()));
        this.#set({ building: { name, since: new Date(this.#now()).toISOString(), step: 'Starting the machine' }, refused: undefined, error: undefined });
        this.job = this.#build(name).catch(() => this.#failed(name, 'The rebuild stopped on an unexpected error.')).finally(() => { this.#busy = false; });
        return this.about();
    }

    async #failed(name, text) {
        await this.#run(['shelf', 'delete', name], { timeoutMs: SHORT_MS });
        this.#set({ building: undefined, error: text, failedAt: this.#now() });
    }

    async #build(name) {
        const step = (text) => this.#set({ building: { ...this.#get().building, step: text } });
        /* At most two are kept: the one before the current goes now. */
        const before = this.#get().previous;
        if (before) { await this.#run(['shelf', 'delete', before.name], { timeoutMs: SHORT_MS }); this.#set({ previous: undefined }); }
        const launched = await this.#run(['shelf', 'launch', name], { timeoutMs: LAUNCH_MS });
        if (launched.code !== 0) return this.#failed(name, `The machine did not start: ${said(launched)}`);
        for (const s of preparation(this.#tools)) {
            step(s.label);
            const r = await this.#run(['shelf', 'exec', name, '--', ...s.argv], { input: s.input, timeoutMs: STEP_MS });
            if (r.code !== 0) return this.#failed(name, `${s.label} failed: ${said(r)}`);
        }
        step('Sealing');
        const sealed = await this.#run(['shelf', 'seal', name], { timeoutMs: SHORT_MS * 2 });
        if (sealed.code !== 0) return this.#failed(name, `Sealing failed: ${said(sealed)}`);
        const size = /^size (\d+)$/m.exec((await this.#run(['shelf', 'size', name])).stdout ?? '');
        this.#set({
            previous: this.#get().current,
            current: { name, builtAt: new Date(this.#now()).toISOString(), sizeMb: size ? Number(size[1]) : undefined, tools: Object.fromEntries(this.#tools.map((t) => [t.id, toolSignature(t)])) },
            building: undefined, error: undefined, failedAt: undefined,
        });
        return undefined;
    }

    /* Whether an automatic rebuild is due: none yet, a month old, or a tool
       of the catalogue it does not hold -- unless one failed lately. */
    due() {
        const s = this.#get();
        const now = this.#now();
        if (s.building || this.#busy) return false;
        if (s.failedAt && now - s.failedAt < this.#retryMs) return false;
        if (!s.current) return true;
        if (now - Date.parse(s.current.builtAt) >= this.#refreshMs) return true;
        return this.#tools.some((t) => s.current.tools?.[t.id] !== toolSignature(t));
    }

    async tick() { if (this.due()) await this.rebuild().catch(() => {}); }

    /* `everyMs` 0: never by itself (tests). Returns what stops it. */
    start(everyMs = CHECK_EVERY_MS, firstMs = FIRST_CHECK_MS) {
        if (!everyMs) return () => {};
        let timer;
        const first = setTimeout(() => {
            void this.tick();
            timer = setInterval(() => { void this.tick(); }, everyMs);
            timer.unref?.();
        }, firstMs);
        first.unref?.();
        return () => { clearTimeout(first); clearInterval(timer); };
    }
}
