/* WHAT CLAVARIUM IS DOING (the « under way » badge, 14-11): every conversation in a busy phase -- built, copied,
 * moved, restarted -- is a job under way, its step said as it goes; when it leaves that phase the job ends, done
 * or failed with why, and is kept a day. Nothing is asked of the machines: it is read off the conversations' own
 * record as it changes (Store's onChange), so it adds no wait.
 *
 *   seen(before, after)   a conversation's record changed (before or after undefined: made or removed)
 *   list(now?)            { running: [...], done: [...] } newest first, done within KEEP_MS
 */
import { JsonFile } from './store.mjs';

export const BUSY = ['building', 'moving', 'restarting'];
const KEEP_MS = 24 * 3600_000;
const DONE_MAX = 50;

const titleOf = (c) => c?.title ?? c?.name ?? '?';

/* Its words: what it is, from the phase and the record (a copy names its original, a move its machine). */
export function jobWords(c) {
    if (c.phase === 'moving') return `Moving ${titleOf(c)}${c.sharedMachine ? ` into « ${c.sharedMachine} »` : ''}`;
    if (c.phase === 'restarting') return `Restarting ${titleOf(c)}`;
    if (c.copyOf) return `Copy ${titleOf(c)}${c.sharedMachine ? ` in « ${c.sharedMachine} »` : ''}`;
    return `Building ${titleOf(c)}${c.sharedMachine ? ` in « ${c.sharedMachine} »` : ''}`;
}

export class Jobs {
    #open = new Map();
    #file;
    #done;
    #now;

    constructor({ path, now = () => Date.now() } = {}) {
        this.#now = now;
        this.#file = path ? new JsonFile(path, []) : undefined;
        const kept = this.#file?.get();
        this.#done = Array.isArray(kept) ? kept : [];
    }

    seen(before, after) {
        const name = after?.name ?? before?.name;
        if (!name) return;
        const busy = after && BUSY.includes(after.phase);
        if (busy && !this.#open.has(name)) this.#open.set(name, { conversation: name, what: jobWords(after), startedAt: new Date(this.#now()).toISOString() });
        else if (busy) this.#open.get(name).what = jobWords(after);
        if (busy || !this.#open.has(name)) return;
        const job = this.#open.get(name);
        this.#open.delete(name);
        const ok = after?.phase === 'ready';
        this.#end({ ...job, endedAt: new Date(this.#now()).toISOString(), result: after ? (ok ? 'done' : 'failed') : 'removed', ...(after && !ok && after.error ? { why: String(after.error).slice(0, 300) } : {}) });
    }

    #end(job) {
        const since = this.#now() - KEEP_MS;
        this.#done = [job, ...this.#done.filter((j) => Date.parse(j.endedAt) >= since)].slice(0, DONE_MAX);
        this.#file?.set(this.#done);
    }

    /* `records`: the conversations as they are now, for their live step. */
    list(records = []) {
        const since = this.#now() - KEEP_MS;
        /* Read off the records: one busy since before a restart of the server is under way too, and ends here. */
        for (const c of records) if (BUSY.includes(c.phase) && !this.#open.has(c.name)) this.seen(undefined, c);
        const byName = new Map(records.map((c) => [c.name, c]));
        const running = [...this.#open.values()].map((j) => {
            const c = byName.get(j.conversation);
            return { ...j, ...(c ? { what: jobWords(c), step: c.step ?? '', progress: c.progress } : {}) };
        });
        return { running, done: this.#done.filter((j) => Date.parse(j.endedAt) >= since) };
    }
}
