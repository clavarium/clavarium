/* THE WATCHDOG OF A MACHINE (09-11): a machine that stays mute, or whose memory stays full, is forced
 * off and started again, once, by this server -- never by its AI, which is the thing stuck.
 *
 * What it looks at is what health.mjs found (told each look: `judged`): the machine runs, and either it
 * did not answer the probe, or its memory had less than FULL_PERCENT free. Nothing more is asked of it.
 *
 *   - Its owner's setting, per conversation (conversations.mjs, watchdog): on by default, after an hour.
 *   - Seen so for the whole delay (a look that finds it well, or not running, starts the count again):
 *     forced off (`vm hardstop`, as a power cut: it is the one way that works on a frozen machine), then
 *     started -- both through the one lock of its machine (machineAction), so never during another action.
 *   - Its AI told in its chat (the tool reads it again once started), its owner alerted with the report.
 *   - NEVER A LOOP: not again on the same machine within AGAIN_MS, nor before it was seen well once
 *     since. Stuck again within that time: its owner is told, once, and nothing else is done.
 *   - A machine that is starting, being restarted or moved is not judged (health says it busy).
 */
export const FULL_PERCENT = 5;
export const AGAIN_MS = 6 * 3600_000;

/* "1 h", "30 min", "1 h 30". */
export function delayWords(minutes) {
    const h = Math.floor(minutes / 60); const m = minutes % 60;
    return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* What one look says: 'mute', 'full', 'well', or null (nothing to judge: not running, busy). */
export function lookOf(record) {
    if (!record || record.busy || record.state !== 'Running') return null;
    if (record.answering === false) return 'mute';
    const m = record.memory;
    if (record.answering === true && m && m.totalMb > 0 && m.availableMb < (m.totalMb * FULL_PERCENT) / 100) return 'full';
    return record.answering === true ? 'well' : null;
}

export class Watchdog {
    #conversations; #store; #act; #tell; #alert; #now; #trouble = new Map(); #acting = new Set();

    /* `conversations`: get(name), watchdog(name). `store`: the last time each machine was restarted
       (kept across a restart of this server, so that it never loops). `act(name)`: forced off then
       started, resolves with { ok, said }. `tell(name, text, started)`: its chat, read by its AI.
       `alert(payload)`: its owner's alerts. */
    constructor({ conversations, store, act, tell = () => {}, alert = () => {}, now = () => Date.now() }) {
        this.#conversations = conversations; this.#store = store; this.#act = act; this.#tell = tell; this.#alert = alert; this.#now = now;
    }

    /* What is known of one machine: since when it is mute or full, its last restart by the watchdog. */
    of(name) {
        const t = this.#trouble.get(name);
        const last = this.#store.get(name);
        return { trouble: t ? { kind: t.kind, since: new Date(t.since).toISOString() } : null, last: last ? { at: last.at, ok: last.ok, why: last.why } : null, acting: this.#acting.has(name) };
    }
    forget(name) { this.#trouble.delete(name); this.#store.remove?.(name); }

    /* One look of health.mjs. Resolves with what was done: null, 'watching', 'restarted', 'failed',
       'held' (stuck again too soon: said, not done). */
    async judged(name, record) {
        const c = this.#conversations.get(name);
        const set = c ? this.#conversations.watchdog(name) : null;
        const look = lookOf(record);
        if (!c || !set?.on || look === null || look === 'well') {
            this.#trouble.delete(name);
            /* Seen well since its last restart: the watchdog may act again, after AGAIN_MS. */
            const last = this.#store.get(name);
            if (look === 'well' && last && !last.wellSince) this.#store.put({ ...last, wellSince: new Date(this.#now()).toISOString() });
            return null;
        }
        if (this.#acting.has(name)) return null;
        const now = this.#now();
        const t = this.#trouble.get(name) ?? { since: now, kind: look, full: false };
        t.kind = look; t.full ||= look === 'full';
        this.#trouble.set(name, t);
        if (now - t.since < set.delayMin * 60_000) return 'watching';
        const last = this.#store.get(name);
        if (last && (now - Date.parse(last.at) < AGAIN_MS || !last.wellSince)) {
            if (last.held) return null;
            this.#store.put({ ...last, held: true });
            this.#alert({ title: `${name}: its machine is stuck again`, body: `Restarted by its watchdog at ${hhmm(Date.parse(last.at))}, stuck again: not restarted twice. Force stop or restart it yourself.`, url: `/?c=${encodeURIComponent(name)}&open=settings` });
            return 'held';
        }
        return this.#restart(name, set, t);
    }

    async #restart(name, set, t) {
        this.#acting.add(name);
        const at = this.#now();
        const why = t.kind === 'mute' ? (t.full ? 'memory full' : 'no answer') : 'memory full';
        this.#store.put({ name, at: new Date(at).toISOString(), why, ok: null });
        try {
            const report = await Promise.resolve(this.#act(name)).catch((error) => ({ ok: false, said: String(error?.message ?? error) }));
            const when = hhmm(this.#now());
            const head = t.kind === 'mute' ? `Your machine did not answer for ${delayWords(set.delayMin)}${t.full ? ' (memory full)' : ''}` : `Your machine's memory stayed full for ${delayWords(set.delayMin)}`;
            const text = report?.ok ? `${head}: it was restarted automatically at ${when}.` : `${head}: it was forced off at ${when} but did not start again. ${report?.said ?? ''}`.trim();
            this.#store.put({ name, at: new Date(at).toISOString(), why, ok: Boolean(report?.ok) });
            try { this.#tell(name, text, Boolean(report?.ok)); } catch { /* its chat may be off */ }
            this.#alert({ title: report?.ok ? `${name}: restarted by its watchdog` : `${name}: its watchdog could not restart it`, body: `${text}${report?.said ? ` ${report.said}` : ''}`.slice(0, 200), url: `/?c=${encodeURIComponent(name)}&open=settings` });
            return report?.ok ? 'restarted' : 'failed';
        } finally {
            this.#trouble.delete(name);
            this.#acting.delete(name);
        }
    }
}
