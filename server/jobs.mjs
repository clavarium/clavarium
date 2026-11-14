/* WHAT CLAVARIUM IS DOING (the « under way » badge, 14-11): every conversation in a busy phase -- built, copied,
 * moved, restarted -- is a job under way, its step said as it goes; when it leaves that phase the job ends, done
 * or failed with why, and is kept a day. Nothing is asked of the machines: it is read off the conversations' own
 * record as it changes (Store's onChange), so it adds no wait.
 *
 *   seen(before, after)   a conversation's record changed (before or after undefined: made or removed)
 *   note(name, text)      a line added to the log of that conversation's job under way (none: nothing)
 *   list(now?)            { running: [...], done: [...] } newest first, done within KEEP_MS; without their logs
 *   log(id)               that job, under way or done, with its log; undefined if unknown
 *   withUpdates(...)      list() with Clavarium's own updates of the day among the done (the owner's page, an API key)
 *
 * Each job keeps a LOG (14-11), for the owner in Settings and for the conversation's AI, rather than diagnostics
 * on screen: each new step, the lines noted, its end. A step that only counts on ("… 12 MB read") is kept once
 * every PROGRESS_MS, and its last. Kept with the done jobs on disk, LOG_MAX lines of LINE_MAX characters at most.
 */
import { JsonFile } from './store.mjs';

export const BUSY = ['building', 'moving', 'restarting'];
const KEEP_MS = 24 * 3600_000;
const DONE_MAX = 50;
const LOG_MAX = 300;
const LINE_MAX = 300;
const PROGRESS_MS = 10_000;

const titleOf = (c) => c?.title ?? c?.name ?? '?';
/* Its id: its conversation and when it started, in letters an address carries as they are. */
const idOf = (j) => `${j.conversation}-${j.startedAt}`.replace(/[^A-Za-z0-9_-]/g, '-');
/* A line that says the same as another but for its numbers: a count going on. */
const shapeOf = (text) => text.replace(/\d+(?:[.,]\d+)?/g, '#');
const bare = ({ log, ...job }) => job;

/* Its words: what it is, from the phase and the record (a copy names its original, a move its machine). */
export function jobWords(c) {
    if (c.phase === 'moving') return `Moving ${titleOf(c)}${c.sharedMachine ? ` into « ${c.sharedMachine} »` : ''}`;
    if (c.phase === 'restarting') return `Restarting ${titleOf(c)}`;
    if (c.copyOf) return `Copy ${titleOf(c)}${c.sharedMachine ? ` in « ${c.sharedMachine} »` : ''}`;
    return `Building ${titleOf(c)}${c.sharedMachine ? ` in « ${c.sharedMachine} »` : ''}`;
}

/* The jobs as the owner's page and an API key read them (/api/jobs, /api/ext/v1/jobs): those of the
   conversations, and Clavarium's own updates of the day (updates.mjs history) among the done, newest first. */
export function withUpdates(jobs, records = [], history = [], now = Date.now()) {
    const said = jobs.list(records);
    const day = now - KEEP_MS;
    const updated = history.filter((h) => h.at && Date.parse(h.at) >= day)
        .map((h) => ({ what: `Clavarium ${h.action === 'rollback' ? 'back to' : 'updated to'} ${h.to ?? '?'}`, endedAt: h.at, result: h.result === 'done' ? 'done' : 'failed', ...(h.result === 'done' ? {} : { why: h.why ?? h.result ?? '' }) }));
    const done = [...said.done, ...updated].sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    return { running: said.running, done };
}

export class Jobs {
    #open = new Map();
    /* A job under way's log, and the count line held back, said only if no other comes after it. */
    #logs = new Map();
    #file;
    #done;
    #now;

    constructor({ path, now = () => Date.now() } = {}) {
        this.#now = now;
        this.#file = path ? new JsonFile(path, []) : undefined;
        const kept = this.#file?.get();
        this.#done = Array.isArray(kept) ? kept.map((j) => ({ ...j, id: j.id ?? idOf(j) })) : [];
    }

    /* A line to a job's log: a step that only counts on is held back if the last one kept is less than
       PROGRESS_MS old -- said when the next different line comes, or at the end, so its last is never lost. */
    #add(name, text, { thin = false } = {}) {
        const kept = this.#logs.get(name);
        if (!kept) return;
        const line = { at: new Date(this.#now()).toISOString(), text: String(text).slice(0, LINE_MAX) };
        const last = kept.log.at(-1);
        if (last?.text === line.text || kept.held?.text === line.text) return;
        if (thin && last && shapeOf(last.text) === shapeOf(line.text) && Date.parse(line.at) - Date.parse(last.at) < PROGRESS_MS) { kept.held = line; return; }
        if (kept.held && !(thin && last && shapeOf(kept.held.text) === shapeOf(line.text))) kept.log.push(kept.held);
        kept.held = undefined;
        kept.log.push(line);
        /* Too long: its oldest lines go, its end is what tells what happened. */
        if (kept.log.length > LOG_MAX) kept.log.splice(0, kept.log.length - LOG_MAX);
    }

    note(name, text) { if (this.#open.has(name)) this.#add(name, text); }

    seen(before, after) {
        const name = after?.name ?? before?.name;
        if (!name) return;
        const busy = after && BUSY.includes(after.phase);
        if (busy && !this.#open.has(name)) {
            const job = { conversation: name, what: jobWords(after), startedAt: new Date(this.#now()).toISOString() };
            this.#open.set(name, { id: idOf(job), ...job });
            this.#logs.set(name, { log: [] });
        } else if (busy) this.#open.get(name).what = jobWords(after);
        if (busy && after.step) this.#add(name, after.step, { thin: true });
        if (busy || !this.#open.has(name)) return;
        const job = this.#open.get(name);
        this.#open.delete(name);
        const ok = after?.phase === 'ready';
        const why = after && !ok && after.error ? String(after.error).slice(0, 300) : '';
        this.#add(name, after ? (ok ? 'Done' : `Failed${why ? `: ${why}` : ''}`) : 'Removed');
        const { log } = this.#logs.get(name);
        this.#logs.delete(name);
        this.#end({ ...job, endedAt: new Date(this.#now()).toISOString(), result: after ? (ok ? 'done' : 'failed') : 'removed', ...(why ? { why } : {}), log });
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
        return { running, done: this.#done.filter((j) => Date.parse(j.endedAt) >= since).map(bare) };
    }

    log(id) {
        for (const [name, job] of this.#open) {
            if (job.id !== id) continue;
            const { log, held } = this.#logs.get(name);
            return { ...job, log: held ? [...log, held] : [...log] };
        }
        const since = this.#now() - KEEP_MS;
        const done = this.#done.find((j) => j.id === id && Date.parse(j.endedAt) >= since);
        return done && { ...done, log: done.log ?? [] };
    }
}
