/* THE HEALTH OF A CONVERSATION'S MACHINE, said in the page instead of a
   terminal that stays silent.
 *
 * What is looked at, and how cheaply:
 *   - the state the VM manager gives (Running, Stopped, Suspended, Starting,
 *     Unknown): one question to the VM manager, which never wakes a machine;
 *   - only when it runs, ONE short command inside it (PROBE, below): does
 *     it answer at all, how much memory is left, did the kernel kill a
 *     program for lack of memory, how full is its disk, and is each folder
 *     that should be mounted really there and readable.
 *
 * A FOLDER THAT CAME LOOSE IS PUT BACK. The VM manager may believe a folder
 * is mounted while the link that served it is dead: it then answers "already
 * mounted" and does nothing. So what is missing inside the machine is looked
 * at a second time a moment later (a machine that has just started may still
 * be mounting), then unmounted and mounted again (resources.mjs, repair).
 *
 * Never on a machine that does not run: a machine asleep or stopped is left
 * as it is, and only its state is said. Looked at after a start, a wake, a
 * restart, and every few minutes while it runs (`start`).
 */

/* The command run inside the machine. Its arguments are the paths that
   should be mounted; they are passed as arguments, never parsed by the
   shell. It prints one fact per line; the server reads only these lines. */
export const PROBE = [
    'awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print "memory", t+0, a+0}\' /proc/meminfo',
    'awk \'$1=="oom_kill"{n=$2} END{print "oom", n+0}\' /proc/vmstat',
    'df -Pm / | awk \'NR==2{print "disk /", $4, $2}\'',
    'for p in "$@"; do',
    '  if awk -v p="$p" \'$2==p{f=1} END{exit !f}\' /proc/mounts; then',
    '    if timeout 5 ls -- "$p" >/dev/null 2>&1; then echo "mount ok $p"; else echo "mount unreadable $p"; fi',
    '  else echo "mount missing $p"; fi',
    'done',
    'if [ -d /work ] && awk \'$2=="/work"{f=1} END{exit !f}\' /proc/mounts; then timeout 5 df -Pm /work 2>/dev/null | awk \'NR==2{print "disk /work", $4, $2}\'; fi',
].join('\n');
export const PROBE_NAME = 'clavarium-health';

export const EVERY_MS = 120_000;
const PROBE_MS = 15_000;
/* What the clock waits for one conversation's look before it goes on. */
const LOOK_MS = 60_000;
/* Below this, memory or disk is said to be almost full. */
const MEMORY_LOW_MB = 120;
const DISK_LOW_MB = 1024;

/* WHAT THE PROBE PRINTS IS THE AGENT'S TO WRITE: it is root in its machine,
   and awk, df or sh there are whatever it put there. So only what was asked
   is read -- the disks / and /work (only when expected), a mount line only
   for a path that should be mounted, with a state of ours, numbers that are
   whole -- and no more than PROBE_BYTES of it, in PROBE_LINES lines. */
export const PROBE_BYTES = 16 * 1024;
export const PROBE_LINES = 200;
const MOUNT_STATES = new Set(['ok', 'unreadable', 'missing']);
const whole = (text) => (/^\d{1,15}$/.test(text) ? Number(text) : undefined);

/* What the probe printed, as facts. `paths`: what should be mounted (what
   the probe was given). */
export function readProbe(text, paths = []) {
    const facts = { mounts: {}, disks: {} };
    const expected = new Set(paths);
    const disks = new Set(['/', ...(expected.has('/work') ? ['/work'] : [])]);
    for (const line of String(text ?? '').slice(0, PROBE_BYTES).split('\n').slice(0, PROBE_LINES)) {
        const parts = line.trim().split(' ');
        const [a, b, c] = parts.slice(1).map(whole);
        if (parts[0] === 'memory' && parts.length === 3 && a !== undefined && b !== undefined) facts.memory = { totalMb: Math.round(a / 1024), availableMb: Math.round(b / 1024) };
        if (parts[0] === 'oom' && parts.length === 2 && a !== undefined) facts.oomKills = a;
        if (parts[0] === 'disk' && parts.length === 4 && disks.has(parts[1]) && b !== undefined && c !== undefined) facts.disks[parts[1]] = { availableMb: b, sizeMb: c };
        if (parts[0] === 'mount' && parts.length === 3 && expected.has(parts[2]) && MOUNT_STATES.has(parts[1])) facts.mounts[parts[2]] = parts[1];
    }
    return facts;
}
/* What is kept and shown for one conversation, at most. */
const PROBLEMS_MAX = 20;
/* A machine that did not answer is left alone this long, twice as long each time, up to QUIET_MAX_MS. */
export const QUIET_MS = 60_000;
export const QUIET_MAX_MS = 10 * 60_000;
const TEXT_MAX = 300;

/* The sentences the page shows, and how serious they are: 'ok', 'info',
   'warn' (something to act on), 'bad' (the machine does not serve). Each
   says what it is about (`kind`: state, answer, memory, disk, mount), and
   `key` names it whatever its numbers: the same problem seen at the next
   look has the same key (a chat says a problem once: see talk.mjs). */
export function judge(record) {
    const problems = [];
    const add = (level, kind, key, text) => problems.push({ level, kind, key, text });
    const s = record.state;
    if (s === undefined) add('bad', 'state', 'gone', 'Its machine no longer exists.');
    else if (s === 'Starting' || s === 'Restarting') add('info', 'state', 'starting', 'Its machine is starting.');
    else if (s === 'Suspended') add('info', 'state', 'asleep', 'Its machine is asleep. It wakes when you open the conversation.');
    else if (s === 'Stopped') add('info', 'state', 'stopped', 'Its machine is stopped. It starts when you open the conversation.');
    /* The VM manager did not answer: nothing is known of the machine, and nothing is said of it. */
    else if (s === 'Unknown') add('info', 'state', 'unknown', 'The VM manager does not answer just now: its machine is looked at again in a moment.');
    else if (s !== 'Running') add('bad', 'state', `state:${s}`, `The VM manager says its machine is "${s}".`);
    if (s === 'Running') {
        if (record.answering === false) add('bad', 'answer', 'silent', 'Its machine does not answer. Restarting it usually helps.');
        /* Said once a day at most, with how many: a tool that runs out of memory again and again (on purpose, sometimes) is one line, not one a look. */
        if (record.oomKills > 0) add('warn', 'memory', `oom:${String(record.at ?? new Date().toISOString()).slice(0, 10)}`, `It ran out of memory${record.oomKills === 1 ? '' : ` ${record.oomKills} times`} since it started: a program in it was stopped. Its files are safe.`);
        if (record.memory && record.memory.totalMb > 0 && record.memory.availableMb < Math.max(MEMORY_LOW_MB, record.memory.totalMb * 0.05)) add('warn', 'memory', 'memory-low', `Its memory is almost full: ${record.memory.availableMb} MB free of ${record.memory.totalMb} MB.`);
        for (const [path, d] of Object.entries(record.disks ?? {})) {
            if (d.sizeMb > 0 && d.availableMb < Math.max(DISK_LOW_MB, d.sizeMb * 0.1)) add('warn', 'disk', `disk:${path}`, `${path === '/' ? 'Its disk' : `Its work folder (${path})`} is almost full: ${d.availableMb} MB left of ${d.sizeMb} MB.`);
        }
        for (const path of record.remounted ?? []) add('info', 'mount', `remounted:${path}`, `${path} had come loose in the machine: it was mounted again.`);
        for (const { path, why } of record.failed ?? []) add('bad', 'mount', `failed:${path}`, `${path} is not reachable in the machine and could not be mounted again${why ? `: ${why}` : ''}.`);
        for (const path of record.missing ?? []) if (!(record.failed ?? []).some((f) => f.path === path)) add('warn', 'mount', `missing:${path}`, `${path} is not reachable in the machine.`);
    }
    const order = ['ok', 'info', 'warn', 'bad'];
    const level = problems.reduce((worst, p) => (order.indexOf(p.level) > order.indexOf(worst) ? p.level : worst), 'ok');
    return { level, problems: problems.slice(0, PROBLEMS_MAX).map((p) => ({ ...p, text: p.text.slice(0, TEXT_MAX) })) };
}

export class Health {
    #vms; #conversations; #resources; #records = new Map(); #running = new Map(); #quiet = new Map(); #settleMs; #probeMs; #lookMs; #seen;
    /* Set by the server: told each judgment (the chat of a conversation says what is wrong: talk.mjs). */
    judged = () => {};

    /* `settleMs`: how long a missing folder is given before it is mounted
       again (a machine that has just started may still be mounting it).
       `lookMs`: how long the clock waits for one conversation's look. */
    /* `seen`: a store of the problems its owner marked seen ("Seen"), by conversation. */
    constructor({ vms, conversations, resources, settleMs = 5000, probeMs = PROBE_MS, lookMs = LOOK_MS, seen = null }) {
        this.#seen = seen;
        this.#vms = vms; this.#conversations = conversations; this.#resources = resources; this.#settleMs = settleMs; this.#probeMs = probeMs; this.#lookMs = lookMs;
    }

    /* The last thing known, or null. Cheap: nothing is asked. */
    of(name) { const r = this.#records.get(name); return r ? { ...r, seen: this.#seen?.get(name)?.keys ?? [] } : null; }
    /* "Seen": what it says now no longer calls its owner (Needs you); a problem of another kind, or one
       that comes back after it went away, does. */
    markSeen(name) {
        const r = this.#records.get(name);
        const keys = (r?.problems ?? []).filter((p) => p.level === 'warn' || p.level === 'bad').map((p) => p.key);
        this.#seen?.put({ name, keys });
        return this.of(name);
    }
    forget(name) { this.#records.delete(name); this.#quiet.delete(name); this.#seen?.remove?.(name); }

    /* The look under way (it may be mounting a folder again), or null. */
    busy(name) { return this.#running.get(name) ?? null; }

    /* Looks now. One look at a time per conversation: a second caller gets the same. */
    /* `asked`: by its owner, or after its machine was started: even one left alone is asked. */
    check(name, { repair = true, asked = false } = {}) {
        const going = this.#running.get(name);
        if (going) return going;
        const look = this.#look(name, repair, asked).finally(() => this.#running.delete(name));
        this.#running.set(name, look);
        return look;
    }

    async #look(name, repair, asked = false) {
        const c = this.#conversations.get(name);
        if (!c) return null;
        const at = new Date().toISOString();
        /* A machine being built, moved or restarted is somebody else's business just now. */
        if (c.phase !== 'ready') return this.#keep(name, { at, state: c.phase === 'restarting' ? 'Restarting' : 'Starting', busy: true });
        const state = await this.#vms.state(name).catch(() => 'Unknown');
        if (state !== 'Running') return this.#keep(name, { at, state });
        const paths = this.#resources ? this.#resources.expected(name, c.work === 'kept') : (c.work === 'kept' ? ['/work'] : []);
        /* A machine that did not answer is not asked again at once: each question about it holds
           the VM manager for seconds, and every other machine waits behind it (21-10). */
        const quiet = this.#quiet.get(name);
        if (quiet && !asked && Date.now() < quiet.until) return this.#keep(name, { at, state, answering: false });
        let facts = await this.#probe(name, paths);
        if (!facts) {
            const times = (quiet?.times ?? 0) + 1;
            this.#quiet.set(name, { times, until: Date.now() + Math.min(QUIET_MAX_MS, QUIET_MS * 2 ** (times - 1)) });
            return this.#keep(name, { at, state, answering: false });
        }
        this.#quiet.delete(name);
        const loose = () => paths.filter((p) => facts.mounts[p] !== 'ok');
        const remounted = []; const failed = [];
        if (loose().length > 0 && repair && this.#resources) {
            await new Promise((r) => setTimeout(r, this.#settleMs));
            facts = (await this.#probe(name, paths)) ?? facts;
            /* Looked at again just before acting: never on a machine that went to sleep meanwhile. */
            const still = loose();
            if (still.length > 0 && this.#conversations.get(name)?.phase === 'ready' && (await this.#vms.state(name).catch(() => undefined)) === 'Running') {
                for (const path of still) {
                    const why = await this.#resources.repair(name, path).catch((error) => error.message);
                    if (why) failed.push({ path, why });
                }
                facts = (await this.#probe(name, paths)) ?? facts;
                for (const path of still) {
                    if (facts.mounts[path] === 'ok') remounted.push(path);
                    else if (!failed.some((f) => f.path === path)) failed.push({ path, why: 'still not there after mounting it again' });
                }
            }
        }
        return this.#keep(name, {
            at, state, answering: true, memory: facts.memory, oomKills: facts.oomKills ?? 0, disks: facts.disks,
            missing: loose(), ...(remounted.length ? { remounted } : {}), ...(failed.length ? { failed } : {}),
            /* What was put back stays said until a later look finds nothing to put back. */
        });
    }

    async #probe(name, paths) {
        /* Its output is the agent's: not more than a few pages of it are even taken in. */
        const r = await this.#vms.exec(name, ['sh', '-c', PROBE, PROBE_NAME, ...paths], { timeoutMs: this.#probeMs, maxBytes: PROBE_BYTES * 4 }).catch(() => ({ code: 1, stdout: '' }));
        const facts = readProbe(r.stdout, paths);
        if (r.code !== 0 && !facts.memory) return undefined;
        return facts;
    }

    #keep(name, record) {
        const kept = { ...record, ...judge(record) };
        /* What was marked seen and is gone is forgotten: back later, it calls its owner again. */
        const seen = this.#seen?.get(name);
        if (seen && record.state === 'Running' && record.answering === true) { const still = seen.keys.filter((k) => kept.problems.some((p) => p.key === k)); if (still.length !== seen.keys.length) this.#seen.put({ name, keys: still }); }
        this.#records.set(name, kept);
        try { this.judged(name, kept); } catch { /* told, nothing more */ }
        return kept;
    }

    /* Every so often, each conversation whose machine should run. A machine
       that does not run is not touched (its state alone is asked). */
    start(everyMs = EVERY_MS) {
        if (!everyMs) return () => {};
        let going = false;
        const timer = setInterval(async () => {
            if (going) return;
            going = true;
            /* All at once, each within its own time: one machine slow to
               answer (or a mount that hangs) does not hold up the others.
               A look still going when its time is up goes on; the next tick
               joins it rather than starting another (check). */
            try {
                await Promise.all(this.#conversations.awake().map((name) => {
                    let timer;
                    const bound = new Promise((resolve) => { timer = setTimeout(resolve, this.#lookMs); timer.unref?.(); });
                    return Promise.race([this.check(name).catch(() => {}), bound]).finally(() => clearTimeout(timer));
                }));
            } finally { going = false; }
        }, everyMs);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
