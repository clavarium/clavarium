/* THE VM MANAGER, WATCHED. Every machine goes through it; when it stops
 * answering, nothing about a machine can be done, while this server itself
 * must go on serving its pages. So it is asked now and then (host program:
 * `vm ping`: `multipass list`, bounded to 30 s), and:
 *   - while it does not answer, `ok` is false: the pages say "the machines
 *     cannot be reached just now";
 *   - when it has not answered for STUCK_MS it is HUNG, and its owner's
 *     choice (`mode`, kept here) says what is done (09-11):
 *       night   (the default) its daemon restarted by itself only between
 *               NIGHT_FROM and NIGHT_UNTIL, this server's local time; by day
 *               its owner is alerted and asked (Settings, Machines);
 *       always  restarted by itself, at any hour;
 *       ask     never by itself: alerted and asked.
 *     By itself, ONCE (host program: `vm revive`), recorded, the owner told;
 *     not again within REVIVE_EVERY_MS, so that it never loops.
 *   - its owner may restart it by hand (`revive`), confirmed in the page:
 *     every machine is suspended and resumed, every terminal drops.
 */
export const EVERY_MS = 60_000;
/* Restarting it suspends and resumes EVERY machine: every terminal drops (21-10). Only when it
   has said nothing at all for this long: mute (30 s each) on three looks in a row. */
export const STUCK_MS = 2 * 60_000;
export const REVIVE_EVERY_MS = 6 * 3600_000;
/* After a cut, how long a machine is given to answer before it is restarted: 2 min. */
export const ANSWER_TRIES = 5;
export const ANSWER_EVERY_MS = 30_000;
export const MANAGER_MODES = Object.freeze(['night', 'always', 'ask']);
export const NIGHT_FROM = 0;
export const NIGHT_UNTIL = 7;
/* What a look waits for the host program, which bounds `multipass list` to 30 s itself. */
const PING_MS = 40_000;

const said = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || `exit ${r?.code}`;

/* Name -> state, from `multipass list --format csv`. */
export function statesOf(csv) {
    const out = new Map();
    for (const line of String(csv ?? '').split('\n').slice(1)) { const [name, state] = line.split(','); if (/^clv-[a-z0-9-]+$/.test(name ?? '') && state) out.set(name, state); }
    return out;
}

export class VmWatch {
    #run; #store; #now; #hour; #log; #alert; #stuckMs; #reviveEveryMs; #downSince = null; #reviving = null; #running = new Set(); #wait;
    ok = true;
    /* `hour()`: this server's local hour, 0-23 (injected for tests). */
    constructor({ run, store, now = () => Date.now(), hour = () => new Date().getHours(), log = (line) => console.error(line), alert = () => {}, stuckMs = STUCK_MS, reviveEveryMs = REVIVE_EVERY_MS, wait = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); }) }) {
        this.#wait = wait;
        this.#run = run; this.#store = store; this.#now = now; this.#hour = hour; this.#log = log; this.#alert = alert; this.#stuckMs = stuckMs; this.#reviveEveryMs = reviveEveryMs;
    }

    /* What the last restart of the VM manager was, if any: { at, why, result, by }. */
    last() { const r = this.#store.get('revive'); return r ? { at: r.at, why: r.why, result: r.result ?? null, by: r.by ?? 'server' } : null; }

    /* Its owner's choice when it hangs: night (the default), always, ask. */
    mode() { const m = this.#store.get('mode')?.mode; return MANAGER_MODES.includes(m) ? m : 'night'; }
    setMode(mode) {
        if (!MANAGER_MODES.includes(mode)) { const e = new Error('Choose night, always or ask.'); e.status = 400; throw e; }
        this.#store.put({ name: 'mode', mode });
        return this.about();
    }

    /* For Settings, Machines: does it answer, since when not, what its owner chose, whether it waits for
       its owner (`asked`), the last restart, and one running now. */
    about() {
        const asked = this.#store.get('asked');
        return { ok: this.ok, downSince: this.#downSince === null ? null : new Date(this.#downSince).toISOString(), mode: this.mode(), asked: asked?.at && !this.ok ? { at: asked.at, why: asked.why } : null, last: this.last(), reviving: Boolean(this.#reviving) };
    }

    #night() { const h = this.#hour(); return h >= NIGHT_FROM && h < NIGHT_UNTIL; }

    /* One look: 'ok', 'down', 'down; restarted already', 'asked', 'down; asked already', 'revived' or 'revive failed'. */
    async look() {
        const r = await this.#run(['vm', 'ping'], { timeoutMs: PING_MS }).catch((e) => ({ code: 1, stderr: e.message }));
        if (r.code === 0) {
            const was = !this.ok;
            if (was) this.#log('vm manager: it answers again');
            this.ok = true; this.#downSince = null;
            this.#store.remove?.('asked');
            const states = statesOf(r.stdout);
            if (was) await this.#bringBack(states);
            else this.#running = new Set([...states].filter(([, s]) => s === 'Running').map(([n]) => n));
            return 'ok';
        }
        if (this.ok) this.#log(`vm manager: it does not answer (${said(r)})`);
        this.ok = false;
        this.#downSince ??= this.#now();
        if (this.#now() - this.#downSince < this.#stuckMs) return 'down';
        if (this.#reviving) return 'down';
        const minutes = Math.max(1, Math.round((this.#now() - this.#downSince) / 60_000));
        const why = `the VM manager did not answer for ${minutes} minute${minutes === 1 ? '' : 's'} (${said(r)})`;
        const mode = this.mode();
        /* By day (night), or never by itself (ask): its owner asked, once a hang. */
        if (mode === 'ask' || (mode === 'night' && !this.#night())) {
            if (this.#store.get('asked')) return 'down; asked already';
            this.#store.put({ name: 'asked', at: new Date(this.#now()).toISOString(), why });
            this.#log(`vm manager: ${why}: its owner is asked`);
            this.#alert({ title: 'The machine manager is stuck', body: `${why}. Restarting it resumes every machine: Settings, Machines.`, url: '/?open=settings&at=machines' });
            return 'asked';
        }
        const before = this.#store.get('revive');
        if (before?.at && this.#now() - Date.parse(before.at) < this.#reviveEveryMs) return 'down; restarted already';
        this.#log(`vm manager: ${why}: its daemon is restarted, once`);
        const result = await this.#revive(why, 'server');
        this.#alert({ title: 'The machines could not be reached', body: `${why}: it was restarted (${result}).`, url: '/?open=settings&at=machines' });
        return result === 'done' ? 'revived' : 'revive failed';
    }

    /* BACK AFTER A CUT (23-11, on real machines: Multipass updated by snap left every machine suspended, and a machine
       suspended reads as a conversation asleep; and Multipass can say « Running » of a machine whose process is gone,
       which nothing can reach). Only those that ran at the last look before it: the suspended started again, then each
       asked if it answers, for a while; one that never does is stopped for sure and started. */
    async #bringBack(states) {
        const ran = [...this.#running].filter((n) => states.has(n));
        this.#running = new Set(ran);
        if (!ran.length) return;
        const failed = [];
        const start = async (name) => {
            const done = await this.#run(['vm', 'start', name], { timeoutMs: 300_000 }).catch((e) => ({ code: 1, stderr: e.message }));
            if (done.code !== 0) { failed.push(name); this.#log(`vm manager: ${name} could not be started again (${said(done)})`); }
            return done.code === 0;
        };
        const asleep = ran.filter((n) => states.get(n) === 'Suspended');
        if (asleep.length) this.#log(`vm manager: ${asleep.length} machine(s) left suspended by the cut: started again`);
        for (const name of asleep) await start(name);
        let silent = ran.filter((n) => !failed.includes(n));
        for (let i = 0; i < ANSWER_TRIES && silent.length; i += 1) {
            if (i) await this.#wait(ANSWER_EVERY_MS);
            const said_ = await Promise.all(silent.map(async (n) => (await this.#run(['vm', 'exec', n, '--', 'true'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }))).code === 0));
            silent = silent.filter((_, k) => !said_[k]);
        }
        for (const name of silent) {
            this.#log(`vm manager: ${name} does not answer after the cut: stopped for sure and started`);
            await this.#run(['vm', 'halt', name, 'force', 'kill'], { timeoutMs: 180_000 }).catch(() => {});
            await start(name);
        }
        for (const n of failed) this.#running.delete(n);
        if (failed.length) this.#alert({ title: 'Machines still down', body: `After the machine manager was cut, ${failed.length} could not be started again: open them.`, url: '/?open=settings&at=machines' });
    }

    /* RESTARTED BY ITS OWNER (Settings, Machines; confirmed there): now, whatever the hour or the last one.
       One at a time. Resolves with what the server records: { at, why, result, by }. */
    async revive() {
        if (this.#reviving) { const e = new Error('The machine manager is being restarted already.'); e.status = 409; throw e; }
        this.#log('vm manager: restarted by its owner');
        await this.#revive('asked by its owner', 'owner');
        return this.about();
    }

    #revive(why, by) {
        this.#reviving = (async () => {
            this.#store.put({ name: 'revive', at: new Date(this.#now()).toISOString(), why, result: null, by });
            const done = await this.#run(['vm', 'revive'], { timeoutMs: 180_000 }).catch((e) => ({ code: 1, stderr: e.message }));
            const result = done.code === 0 ? 'done' : `failed: ${said(done)}`;
            this.#store.put({ name: 'revive', at: new Date(this.#now()).toISOString(), why, result, by });
            this.#log(`vm manager: restart ${result}`);
            if (done.code === 0) { this.#store.remove?.('asked'); this.#downSince = null; }
            return result;
        })().finally(() => { this.#reviving = null; });
        return this.#reviving;
    }

    /* Looked at every `everyMs` (0: never), one look at a time. */
    start(everyMs = EVERY_MS, firstMs = 5_000) {
        if (!everyMs) return () => {};
        let busy = false;
        const turn = () => { if (busy) return; busy = true; void this.look().catch(() => {}).finally(() => { busy = false; }); };
        const first = setTimeout(turn, firstMs); first.unref?.();
        const timer = setInterval(turn, everyMs); timer.unref?.();
        return () => { clearTimeout(first); clearInterval(timer); };
    }
}
