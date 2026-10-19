/* THE VM MANAGER, WATCHED. Every machine goes through it; when it stops
 * answering, nothing about a machine can be done, while this server itself
 * must go on serving its pages. So it is asked now and then (host program:
 * `vm ping`, bounded), and:
 *   - while it does not answer, `ok` is false: the pages say "the machines
 *     cannot be reached just now";
 *   - when it has not answered for STUCK_MS, its daemon is restarted ONCE
 *     (host program: `vm revive`), recorded, and the owner told; not again
 *     within REVIVE_EVERY_MS, so that it never loops.
 */
export const EVERY_MS = 60_000;
export const STUCK_MS = 5 * 60_000;
export const REVIVE_EVERY_MS = 6 * 3600_000;

const said = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || `exit ${r?.code}`;

export class VmWatch {
    #run; #store; #now; #log; #alert; #stuckMs; #reviveEveryMs; #downSince = null;
    ok = true;
    constructor({ run, store, now = () => Date.now(), log = (line) => console.error(line), alert = () => {}, stuckMs = STUCK_MS, reviveEveryMs = REVIVE_EVERY_MS }) {
        this.#run = run; this.#store = store; this.#now = now; this.#log = log; this.#alert = alert; this.#stuckMs = stuckMs; this.#reviveEveryMs = reviveEveryMs;
    }

    /* What the last restart of the VM manager was, if any: { at, why, result }. */
    last() { const r = this.#store.get('revive'); return r ? { at: r.at, why: r.why, result: r.result ?? null } : null; }

    /* One look: 'ok', 'down', 'down; restarted already', 'revived' or 'revive failed'. */
    async look() {
        const r = await this.#run(['vm', 'ping'], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stderr: e.message }));
        if (r.code === 0) {
            if (!this.ok) this.#log('vm manager: it answers again');
            this.ok = true; this.#downSince = null;
            return 'ok';
        }
        if (this.ok) this.#log(`vm manager: it does not answer (${said(r)})`);
        this.ok = false;
        this.#downSince ??= this.#now();
        if (this.#now() - this.#downSince < this.#stuckMs) return 'down';
        const before = this.#store.get('revive');
        if (before?.at && this.#now() - Date.parse(before.at) < this.#reviveEveryMs) return 'down; restarted already';
        const minutes = Math.round((this.#now() - this.#downSince) / 60_000);
        const why = `the VM manager did not answer for ${minutes} minutes (${said(r)})`;
        this.#store.put({ name: 'revive', at: new Date(this.#now()).toISOString(), why, result: null });
        this.#log(`vm manager: ${why}: its daemon is restarted, once`);
        const done = await this.#run(['vm', 'revive'], { timeoutMs: 180_000 }).catch((e) => ({ code: 1, stderr: e.message }));
        const result = done.code === 0 ? 'done' : `failed: ${said(done)}`;
        this.#store.put({ name: 'revive', at: new Date(this.#now()).toISOString(), why, result });
        this.#log(`vm manager: restart ${result}`);
        this.#alert({ title: 'The machines could not be reached', body: `${why}: it was restarted (${result}).`, url: '/?open=settings' });
        this.#downSince = null;
        return done.code === 0 ? 'revived' : 'revive failed';
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
