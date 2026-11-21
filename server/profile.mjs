/* WHAT HOLDS THIS SERVER, measured (18-11: the owner's server waited about a second at every turn of its
 * event loop, with little CPU seen -- Settings, Load): a few seconds of this server sampled by its own
 * V8 profiler (node:inspector, in-process: no port opened), then said in short, the functions that
 * took the most time themselves and with what they called. Text only, nothing kept.
 *
 *   profile(seconds)  { seconds, sampledMs, idleMs, gcMs, programMs, self: [{ fn, at, ms }], total: [...] }
 *                     one at a time: asked again while one runs, the same one
 */
import { Session } from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';

export const PROFILE_MIN_S = 2;
export const PROFILE_MAX_S = 30;
export const PROFILE_TOP = 15;
export const SAMPLE_US = 10_000;
const APP = fileURLToPath(new URL('..', import.meta.url));

/* Where a function is, short: within the application from its folder, a package by its name, else the file's name. */
export function placeOf(url, line) {
    let path = String(url ?? '');
    if (!path) return '';
    if (path.startsWith('file://')) { try { path = fileURLToPath(path); } catch { /* left as it is */ } }
    const inModules = path.lastIndexOf('/node_modules/');
    if (inModules >= 0) path = path.slice(inModules + '/node_modules/'.length);
    else if (path.startsWith(APP)) path = path.slice(APP.length);
    else if (path.startsWith('/')) path = path.split('/').pop();
    return line >= 0 ? `${path}:${line + 1}` : path;
}

/* A V8 CPU profile told in short: each sample's time to its node, then by function. */
export function summarize(profile, seconds, top = PROFILE_TOP) {
    const nodes = new Map((profile.nodes ?? []).map((n) => [n.id, n]));
    const selfUs = new Map();
    const samples = profile.samples ?? []; const deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + Math.max(0, deltas[i] ?? 0));
    const parent = new Map();
    for (const n of nodes.values()) for (const c of n.children ?? []) parent.set(c, n.id);
    const special = { '(idle)': 0, '(garbage collector)': 0, '(program)': 0, '(root)': 0 };
    const self = new Map(); const total = new Map();
    const keyOf = (n) => { const f = n.callFrame ?? {}; return `${f.functionName || '(anonymous)'}\t${placeOf(f.url, f.lineNumber)}`; };
    for (const [id, us] of selfUs) {
        const n = nodes.get(id); if (!n) continue;
        const name = n.callFrame?.functionName ?? '';
        if (name in special && !n.callFrame?.url) { special[name] += us; continue; }
        const k = keyOf(n); self.set(k, (self.get(k) ?? 0) + us);
        /* Its time counted once to every function above it (a recursive one once). */
        const seen = new Set();
        for (let at = id; at !== undefined; at = parent.get(at)) {
            const up = nodes.get(at); if (!up || (up.callFrame?.functionName === '(root)' && !up.callFrame?.url)) break;
            const uk = keyOf(up); if (seen.has(uk)) continue; seen.add(uk);
            total.set(uk, (total.get(uk) ?? 0) + us);
        }
    }
    const list = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, us]) => { const [fn, at] = k.split('\t'); return { fn, at, ms: Math.round(us / 1000) }; });
    const all = [...selfUs.values()].reduce((a, b) => a + b, 0);
    return {
        seconds, sampledMs: Math.round(all / 1000), idleMs: Math.round(special['(idle)'] / 1000),
        gcMs: Math.round(special['(garbage collector)'] / 1000), programMs: Math.round(special['(program)'] / 1000),
        self: list(self), total: list(total),
    };
}

export class Profiler {
    #running = null; #session; #wait;
    constructor({ session = () => new Session(), wait = (ms) => new Promise((ok) => { setTimeout(ok, ms); }) } = {}) { this.#session = session; this.#wait = wait; }
    profile(seconds = 10) {
        const s = Math.min(PROFILE_MAX_S, Math.max(PROFILE_MIN_S, Math.round(Number(seconds) || 10)));
        if (this.#running) return this.#running;
        this.#running = (async () => {
            const session = this.#session();
            session.connect();
            try {
                await session.post('Profiler.enable');
                /* 100 samples a second: light on a busy server (18-11: at 1000 a second, the owner's busy server stopped answering). */
                await session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
                await session.post('Profiler.start');
                const began = process.cpuUsage();
                await this.#wait(s * 1000);
                const { profile } = await session.post('Profiler.stop');
                const cpu = process.cpuUsage(began);
                return { ...summarize(profile, s), cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
            } finally {
                try { await session.post('Profiler.disable'); } catch { /* closing anyway */ }
                session.disconnect();
            }
        })().finally(() => { this.#running = null; });
        return this.#running;
    }
}

/* MEASURED BY ITSELF (18-11, the owner: an intermittent stall needs nobody before the screen): every
   WATCH_EVERY_MS the event loop's delay of the last minute is looked at; past SLOW_P50_MS, a measure is
   taken (as Measure 10 s), at most once in AUTO_EVERY_MS (a measure costs a little itself), the last
   AUTO_KEPT kept with when and why, in `file` (JsonFile: they outlive a restart). */
export const WATCH_EVERY_MS = 60_000;
export const SLOW_P50_MS = 200;
export const AUTO_EVERY_MS = 30 * 60_000;
export const AUTO_KEPT = 5;
export const AUTO_SECONDS = 10;
/* Never in its first minutes (18-11: 0.2.232 measured itself during the updater's health watch on the owner's slow
   server, and did not answer in time: put back). */
export const AUTO_AFTER_START_MS = 15 * 60_000;
export class AutoProfile {
    #profiler; #file; #now; #delay; #log; #last = 0; #timer = null; #started;
    /* `delay()`: the loop's delay of the last minute, { p50, p99 } in ms, then started again (a histogram of its own). */
    constructor({ profiler, file, now = () => Date.now(), delay, log = (line) => console.log(line) }) {
        this.#profiler = profiler; this.#file = file; this.#now = now; this.#delay = delay; this.#log = log; this.#started = now();
        const kept = this.kept(); this.#last = kept[0] ? Date.parse(kept[0].at) || 0 : 0;
    }
    kept() { const v = this.#file?.get(); return Array.isArray(v?.profiles) ? v.profiles : []; }
    start(everyMs = WATCH_EVERY_MS) { this.#timer = setInterval(() => { void this.check(); }, everyMs); this.#timer.unref?.(); return this; }
    stop() { clearInterval(this.#timer); }
    async check() {
        const d = this.#delay();
        if (this.#now() - this.#started < AUTO_AFTER_START_MS) return null;
        if (!d || !(d.p50 > SLOW_P50_MS)) return null;
        if (this.#now() - this.#last < AUTO_EVERY_MS) return null;
        this.#last = this.#now();
        const why = `loop p50 ${d.p50} ms, p99 ${d.p99} ms over the last minute`;
        this.#log(`profile: measuring ${AUTO_SECONDS} s by itself (${why})`);
        try {
            const p = await this.#profiler.profile(AUTO_SECONDS);
            const entry = { at: new Date(this.#last).toISOString(), why, ...p };
            this.#file?.set({ profiles: [entry, ...this.kept()].slice(0, AUTO_KEPT) });
            this.#log(`profile: ${p.self.slice(0, 5).map((f) => `${f.fn} ${f.ms}ms ${f.at}`).join('; ')}`);
            return entry;
        } catch (error) { this.#log(`profile: not measured (${error?.message ?? error})`); return null; }
    }
}
