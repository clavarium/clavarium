/* THE OPERATORS, from the page: who may sign in, each with a password of their
 * own (deploy/operators.mjs, as root, through the host program).
 *
 *   list()                       [{ email, enabled, locked }]
 *   add(email)                   { email, password }: the password shown once, then never again
 *   password(email)              { email, password }: a new one, shown once
 *   disable / enable / remove    the last enabled operator cannot be disabled nor removed
 *
 * Whoever signs in is checked against this list at each request (gate.mjs):
 * an operator added comes in at once, one disabled or removed is out at once,
 * even with a session still open.
 *
 * LOCKED AFTER FAILED ATTEMPTS: FAILS_MAX failed sign-ins within WINDOW_MIN
 * minutes (as the identity provider logs them) disable the address for
 * LOCK_MIN minutes, the owner told; it is enabled again by itself after. The
 * last enabled operator is never locked out: the owner is told instead.
 */
import { randomBytes } from 'node:crypto';
import { Refusal } from './conversations.mjs';

export const FAILS_MAX = 5;
export const WINDOW_MIN = 15;
export const LOCK_MIN = 15;
const EMAIL = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 200) ?? '';
/* 24 characters a person can read aloud and type: no 0/O, no 1/l/I. */
export function newPassword() {
    const set = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return [...randomBytes(24)].map((b) => set[b % set.length]).join('').replace(/(.{6})(?=.)/g, '$1-');
}

export class Operators {
    #host; #store; #alerts; #now; #list; #said = new Map();
    /* `initial`: the operators the server was started with (--operators), until the host says. */
    constructor({ host, store, alerts, initial = [], now = Date.now }) {
        this.#host = host; this.#store = store; this.#alerts = alerts; this.#now = now;
        this.#list = initial.map((email) => ({ email, enabled: true }));
    }
    /* Those who may come in now: for the gate. */
    allowed() { return this.#list.filter((o) => o.enabled).map((o) => o.email); }
    list() {
        const locks = this.#store.get('locks') ?? {};
        return this.#list.map((o) => ({ ...o, locked: locks[o.email]?.until && new Date(locks[o.email].until) > this.#now() ? locks[o.email].until : null }));
    }
    async refresh() {
        const r = await this.#host(['operator', 'list']);
        if (r.code !== 0) throw new Refusal(502, `Who may sign in could not be read: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        const read = String(r.stdout).split('\n').map((l) => l.split('\t')).filter(([e, s]) => EMAIL.test(e ?? '') && ['enabled', 'disabled'].includes(s));
        if (read.length) this.#list = read.map(([email, state]) => ({ email, enabled: state === 'enabled' }));
        return this.list();
    }
    async #do(argv, input) {
        const r = await this.#host(argv, input === undefined ? {} : { input });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 400 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        await this.refresh();
    }
    #email(given) {
        const e = String(given ?? '').trim().toLowerCase();
        if (!EMAIL.test(e)) throw new Refusal(400, 'An operator is an e-mail address.');
        return e;
    }
    async add(email) {
        const e = this.#email(email); const password = newPassword();
        await this.#do(['operator', 'add', e], `${password}\n`);
        /* What the identity provider now says, not what was hoped: a password given for nobody is no use. */
        if (!this.#list.some((o) => o.email === e && o.enabled)) throw new Refusal(502, `${e} was not added: the identity provider does not list it.`);
        return { email: e, password };
    }
    async password(email) {
        const e = this.#email(email); const password = newPassword();
        await this.#do(['operator', 'password', e], `${password}\n`);
        return { email: e, password };
    }
    async disable(email) { await this.#do(['operator', 'disable', this.#email(email)]); this.#unlock(this.#email(email)); return this.list(); }
    async enable(email) { await this.#do(['operator', 'enable', this.#email(email)]); this.#unlock(this.#email(email)); return this.list(); }
    async remove(email) { await this.#do(['operator', 'remove', this.#email(email)]); this.#unlock(this.#email(email)); return this.list(); }
    #unlock(email) { const locks = { ...(this.#store.get('locks') ?? {}) }; delete locks[email]; this.#store.put({ name: 'locks', ...locks }); }

    /* At each turn: too many failed sign-ins lock an address for a while; a lock that is over is lifted. */
    async watch() {
        const locks = { ...(this.#store.get('locks') ?? {}) }; delete locks.name;
        const now = this.#now();
        for (const [email, lock] of Object.entries(locks)) {
            if (new Date(lock.until) > now) continue;
            delete locks[email];
            if (this.#list.some((o) => o.email === email && !o.enabled)) await this.#do(['operator', 'enable', email]).catch(() => {});
        }
        const r = await this.#host(['operator', 'failures', String(WINDOW_MIN)]);
        if (r.code === 0) {
            for (const [email, n] of String(r.stdout).split('\n').map((l) => l.split('\t')).filter(([e]) => EMAIL.test(e ?? ''))) {
                if (Number(n) < FAILS_MAX || locks[email]) continue;
                const one = this.#list.find((o) => o.email === email && o.enabled);
                if (!one) continue;
                if (this.allowed().length === 1) {
                    if (this.#said.get(email) !== 'last') { this.#said.set(email, 'last'); this.#tell(`${n} failed sign-ins as ${email}`, 'It is the last operator: not locked out. Change its password if this was not you.'); }
                    continue;
                }
                const until = new Date(now + LOCK_MIN * 60_000).toISOString();
                await this.#do(['operator', 'disable', email]).then(() => { locks[email] = { until, fails: Number(n) }; this.#tell(`${email} is locked for ${LOCK_MIN} minutes`, `${n} failed sign-ins in ${WINDOW_MIN} minutes. Enabled again by itself after; or now, from Settings.`); }).catch(() => {});
            }
        }
        this.#store.put({ name: 'locks', ...locks });
    }
    /* Made before the alerts are: given them once they are. */
    useAlerts(alerts) { this.#alerts = alerts; }
    #tell(title, body) { if (this.#alerts) void this.#alerts.tell({ title, body, url: '/?open=settings&at=operators' })?.catch?.(() => {}); }
}
