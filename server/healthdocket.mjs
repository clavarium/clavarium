/* A MACHINE SHORT OF ROOM, TOLD TO ITS AGENT THROUGH ITS DOCKET (dockets.mjs),
 * where its chat is on -- nowhere else. Its owner is told as before (talk.mjs,
 * healthreact.mjs); this is on top: one event per threshold crossed, which the
 * agent handles and acknowledges (docket done / failed: said in its chat).
 *
 *   disk (/ and /work, each)   at DISK_LEVELS of its size used
 *   memory                     at MEMORY_LEVELS used, at SUSTAINED looks in a row
 *                              (health.mjs looks every two minutes: a peak is not news)
 *   out of memory              the whole machine (not a program at its own limit),
 *                              each time it happens again, OOM_QUIET_MS apart at least
 *
 * NO REPEAT: a level is posted once; again only when it got worse (the next
 * level) or after it went below its REARM (a few points under it) and came
 * back. What was posted is kept in a store, so a restart of the server does
 * not post it again.
 *
 * Not where its owner chose its own reaction (healthreact.mjs): its agent is told
 * one way, not two.
 *
 * Only a machine that runs and answered is judged: one that does not answer
 * cannot read its docket, and what it has is not known (nothing changes).
 *
 *   judged(name, record)   told each judgment by health.mjs
 *   forget(name)
 */
export const DISK_LEVELS = [85, 95];
export const MEMORY_LEVELS = [90, 97];
/* Below this many points under a level, it may be posted again. */
export const REARM = 5;
export const SUSTAINED = 2;
export const OOM_QUIET_MS = 60 * 60_000;
export const KIND = 'machine-health';

const ACK = 'then say what you did (docket done ID "what")';

/* The highest level reached by `percent`, 0 when none. */
const reached = (percent, levels) => levels.reduce((n, l, i) => (percent >= l ? i + 1 : n), 0);
/* What is kept of `before` once at `percent`: a level stays posted until it is REARM under it. */
const kept = (before, percent, levels) => { let n = before; while (n > 0 && percent < levels[n - 1] - REARM) n -= 1; return n; };

export function diskText(path, percent) {
    return path === '/'
        ? `Disk of your machine at ${percent}% (/): free space -- caches, temporary files, build outputs -- ${ACK}.`
        : `Work folder of your machine at ${percent}% (${path}): free space without losing work -- caches, build outputs -- ${ACK}.`;
}
export function memoryText(percent) {
    return `Memory of your machine at ${percent}% for several minutes: stop what is no longer needed -- servers, watchers, builds left running -- ${ACK}.`;
}
export function oomText(times) {
    return `Your machine ran out of memory${times > 1 ? ` (${times} times since it started)` : ''}: a program was stopped. Run less at once, ${ACK}.`;
}

export class HealthDocket {
    #store; #dockets; #now;
    #reacting;
    /* `dockets`: { on(name), post(name, {kind, text, data}) } (dockets.mjs). `reacting(name)`: its owner
       turned on its own reaction to a machine short of room (healthreact.mjs). */
    constructor({ store, dockets, reacting = () => false, now = () => Date.now() }) { this.#store = store; this.#dockets = dockets; this.#reacting = reacting; this.#now = now; }

    forget(name) { this.#store.remove?.(name); }

    judged(name, record) {
        if (!record || record.state !== 'Running' || record.answering !== true) return [];
        if (!this.#dockets.on(name) || this.#reacting(name)) return [];
        const before = this.#store.get(name) ?? {};
        const r = { name, disks: { ...(before.disks ?? {}) }, memory: { ...(before.memory ?? {}) }, ...(before.oom ? { oom: { ...before.oom } } : {}) };
        const posted = [];
        /* Posted, or not (its folder cannot be written): then tried again at the next look. */
        const post = (text, data) => {
            try { posted.push(this.#dockets.post(name, { kind: KIND, text, data })); return true; } catch { return false; }
        };

        for (const [path, d] of Object.entries(record.disks ?? {})) {
            if (!(d.sizeMb > 0)) continue;
            const percent = Math.round(100 * (d.sizeMb - d.availableMb) / d.sizeMb);
            const was = kept(r.disks[path] ?? 0, percent, DISK_LEVELS);
            const now = reached(percent, DISK_LEVELS);
            r.disks[path] = now > was && post(diskText(path, percent), { health: 'disk', path, percent, level: DISK_LEVELS[now - 1] }) ? now : was;
        }

        const m = record.memory;
        if (m && m.totalMb > 0) {
            const percent = Math.round(100 * (m.totalMb - m.availableMb) / m.totalMb);
            const now = reached(percent, MEMORY_LEVELS);
            /* Looks in a row at a level or above. */
            const high = now > 0 ? (r.memory.high ?? 0) + 1 : 0;
            const was = kept(r.memory.level ?? 0, percent, MEMORY_LEVELS);
            const sent = now > was && high >= SUSTAINED && post(memoryText(percent), { health: 'memory', percent, level: MEMORY_LEVELS[now - 1] });
            r.memory = { level: sent ? now : was, high };
        }

        /* The whole machine out of memory (the kernel's own words: health.mjs). Within the quiet time,
           the count kept is not raised: told once it is over. A count lower than the one kept: the
           machine started again, the count with it. */
        const times = record.oomKinds?.machine;
        if (Number.isInteger(times)) {
            const last = r.oom ?? { count: 0, at: 0 };
            const sent = times > last.count && this.#now() - last.at >= OOM_QUIET_MS && post(oomText(times), { health: 'oom', times });
            r.oom = sent ? { count: times, at: this.#now() } : { count: Math.min(times, last.count), at: last.at };
        }

        const state = (x) => JSON.stringify([x.disks ?? {}, x.memory ?? {}, x.oom ?? null]);
        if (state(r) !== state(before)) this.#store.put(r);
        return posted;
    }
}
