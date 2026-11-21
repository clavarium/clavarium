/* ITS TOOL STARTED AGAIN WHEN A FOLDER IT WAS IN CAME LOOSE (16-11).
 *
 * Seen in production: /work of a conversation came loose ("socket is not connected"). Putting the
 * folder back (health.mjs, resources.mjs repair) makes a NEW mount; its tool, and every program it
 * started (its shell, Parley, Docket), stays in the old one, dead, until it is started again. It cannot
 * even ask to be restarted: that request is a file in /work. Its owner typed exit by hand; this does it.
 *
 * Told by health.mjs, each look (`judged`):
 *   - `stale`: a program of its tool's session is in a folder that cannot be entered;
 *   - `restartAsked`: its tool asked from outside /work (health.mjs, RESTART_OUTSIDE);
 *   - `stuckWork`: its work folder cannot be mounted again (health.mjs, STUCK_MOUNT): its MACHINE is restarted
 *     (`restartMachine`), the one thing that mounts it again; it outranks the others.
 * Then, at the next tick: its tool only is restarted (conversations.mjs restartTool, never its
 * machine), once its turn has ended -- or after WAIT_MS anyway when stale: a tool stuck in a dead
 * folder cannot say its turn ended (its pulse is in /work). Never a loop: not again within AGAIN_MS.
 * Its tool told through its docket before it starts again, its owner through What happened.
 */
export const WAIT_MS = 5 * 60_000;
export const AGAIN_MS = 30 * 60_000;

export class Revive {
    #restart; #restartMachine; #busy; #tell; #taken; #now; #wanted = new Map(); #lastAt = new Map(); #going = new Set();

    /* `restart(name)`: its tool restarted, resolves with whether it was. `busy(name)`: its turn goes on.
       `tell(name, why, step)`: said where it should be, step 'before' (its docket), then 'done' or 'failed' (main.mjs).
       `taken(name)`: the request outside /work removed (in its machine). */
    constructor({ restart, restartMachine = async () => false, busy = () => false, tell = () => {}, taken = async () => {}, now = Date.now }) {
        this.#restart = restart; this.#restartMachine = restartMachine; this.#busy = busy; this.#tell = tell; this.#taken = taken; this.#now = now;
    }

    /* What one look found. A look that finds it well forgets a stale one not yet acted on. */
    judged(name, record) {
        if (!record || record.state !== 'Running' || record.answering !== true) return;
        if (record.restartAsked) { void Promise.resolve().then(() => this.#taken(name)).catch(() => {}); this.#want(name, 'asked'); }
        if (record.stuckWork) this.#want(name, 'stuck');
        else if (record.stale) this.#want(name, 'stale');
        else if (['stale', 'stuck'].includes(this.#wanted.get(name)?.why)) this.#wanted.delete(name);
    }

    #want(name, why) {
        const had = this.#wanted.get(name);
        /* stuck over stale over a plain request: the stronger is acted on, even while it looks busy. */
        const rank = { asked: 0, stale: 1, stuck: 2 };
        if (!had || rank[why] > rank[had.why]) this.#wanted.set(name, { why, since: had?.since ?? this.#now() });
    }

    wanted(name) { return this.#wanted.get(name)?.why ?? null; }
    forget(name) { this.#wanted.delete(name); this.#lastAt.delete(name); }

    /* One pass: each one wanted, restarted when it may be. Resolves with the names restarted. */
    async tick() {
        const done = [];
        for (const [name, { why, since }] of [...this.#wanted]) {
            if (this.#going.has(name)) continue;
            const busy = (() => { try { return this.#busy(name); } catch { return false; } })();
            if (busy && !(why !== 'asked' && this.#now() - since >= WAIT_MS)) continue;
            this.#wanted.delete(name);
            if (this.#now() - (this.#lastAt.get(name) ?? -Infinity) < AGAIN_MS) continue;
            this.#lastAt.set(name, this.#now());
            this.#going.add(name);
            try {
                try { this.#tell(name, why, 'before'); } catch { /* told, nothing more */ }
                const ok = await (why === 'stuck' ? this.#restartMachine(name) : this.#restart(name)).catch(() => false);
                if (ok) done.push(name);
                try { this.#tell(name, why, ok ? 'done' : 'failed'); } catch { /* told, nothing more */ }
            } finally { this.#going.delete(name); }
        }
        return done;
    }
}
