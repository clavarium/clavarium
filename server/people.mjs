/* WHO IS AN ADMINISTRATOR, WHO A MEMBER (24-11, #419).
 *
 * Every account that may sign in (operators.mjs) is, by default, an ADMINISTRATOR: it may do everything, as
 * every account did before this file existed -- an update changes nothing for the accounts already there. An
 * administrator makes another account a MEMBER, who sees only the conversations given to it (grants.mjs,
 * `person:<email>`), through its own door (/m/, door.mjs), and nothing else: the gate of everything else
 * (gate.mjs, main.mjs) admits administrators only.
 *
 * Two rules on top, never broken:
 *   - ONE ACCOUNT, AN ADMINISTRATOR: when only one account exists (enabled or not: a member must never become
 *     the only one by having the others locked out), it is an administrator, whatever was written;
 *   - THE LAST ADMINISTRATOR stays one: it cannot be made a member (nor, in operators.mjs, disabled, removed or
 *     locked out after failed sign-ins).
 *
 * KEPT where nothing half-written is ever read: written to a new file renamed over the old one, the good one
 * before it kept as `.bak`. Unreadable both: nobody is taken for an administrator but the one account alone,
 * and it is said -- a damaged file never hands a member everything.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refusal } from './conversations.mjs';

export const ROLES = Object.freeze(['admin', 'member']);

export class People {
    #path; #roles = {}; #damaged = false; #accounts; #tell; #changed = () => {};
    /* Told when a role changes: the terminals of whoever lost something end at once (bridge.recheck). */
    useChanged(fn) { this.#changed = fn; }
    /* `accounts()`: every account there is, enabled or not ([{ email, enabled }], operators.mjs). */
    constructor({ path, accounts = () => [], tell = () => {} }) {
        this.#path = path; this.#accounts = accounts; this.#tell = tell;
        mkdirSync(dirname(path), { recursive: true });
        this.#load();
    }

    #read(file) {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || !data.roles || typeof data.roles !== 'object') throw new Error('not a roles file');
        return Object.fromEntries(Object.entries(data.roles).filter(([e, r]) => typeof e === 'string' && ROLES.includes(r)));
    }
    #load() {
        if (!existsSync(this.#path) && !existsSync(`${this.#path}.bak`)) { this.#roles = {}; return; }
        for (const file of [this.#path, `${this.#path}.bak`]) {
            try { this.#roles = this.#read(file); this.#damaged = false; return; } catch { /* the next one */ }
        }
        this.#damaged = true; this.#roles = {};
        this.#tell('The file of who is an administrator cannot be read', `${this.#path}: until it is repaired, only an account alone is an administrator.`);
    }
    #save() {
        const tmp = `${this.#path}.new`;
        writeFileSync(tmp, `${JSON.stringify({ roles: this.#roles }, null, 1)}\n`, { mode: 0o600 });
        if (existsSync(this.#path)) { try { this.#read(this.#path); copyFileSync(this.#path, `${this.#path}.bak`); } catch { /* the old one was bad: no copy of it */ } }
        renameSync(tmp, this.#path);
    }

    #all() { return (this.#accounts() ?? []).map((a) => ({ email: String(a.email).toLowerCase(), enabled: a.enabled !== false })); }

    /* 'admin' or 'member'. */
    roleOf(email) {
        const e = String(email ?? '').toLowerCase();
        const all = this.#all();
        if (all.length <= 1) return 'admin';
        if (this.#damaged) return 'member';
        return this.#roles[e] === 'member' ? 'member' : 'admin';
    }
    damaged() { return this.#damaged; }
    /* The enabled administrators. */
    admins() { return this.#all().filter((a) => a.enabled && this.roleOf(a.email) === 'admin').map((a) => a.email); }
    /* Whether taking `email` out of the administrators (made a member, disabled, removed, locked out) leaves none. */
    isLastAdmin(email) {
        const e = String(email ?? '').toLowerCase();
        const admins = this.admins();
        return admins.length <= 1 && (admins.length === 0 || admins[0] === e);
    }

    setRole(email, role) {
        const e = String(email ?? '').toLowerCase();
        if (!ROLES.includes(role)) throw new Refusal(400, 'A role is admin or member.');
        if (!this.#all().some((a) => a.email === e)) throw new Refusal(404, 'No such account.');
        if (this.#damaged) throw new Refusal(503, 'The file of who is an administrator cannot be read: repair it first.');
        if (role === 'member' && this.roleOf(e) === 'admin' && this.isLastAdmin(e)) throw new Refusal(409, 'The last administrator cannot be made a member.');
        if (role === 'admin') delete this.#roles[e]; else this.#roles[e] = 'member';
        this.#save();
        try { this.#changed(); } catch { /* the minute's recheck sees it */ }
        return this.list();
    }
    /* An account added: its role, said at once (a removed account added again does not come back as it was). */
    added(email, role) {
        const e = String(email ?? '').toLowerCase();
        if (!ROLES.includes(role)) return;
        if (role === 'admin') delete this.#roles[e]; else this.#roles[e] = 'member';
        if (!this.#damaged) this.#save();
    }
    /* An account removed: its role forgotten with it. */
    removed(email) {
        const e = String(email ?? '').toLowerCase();
        if (!(e in this.#roles) || this.#damaged) return;
        delete this.#roles[e]; this.#save();
    }
    /* Said to whoever waits on a change (a right taken: its terminal ends). */
    changed() { try { this.#changed(); } catch { /* the minute's recheck sees it */ } }
    /* The role a new account gets when none is said: a member (24-11, its owner's choice); an administrator is ticked. */
    defaultRole() { return 'member'; }
    list() { return this.#all().map((a) => ({ ...a, role: this.roleOf(a.email) })); }
}
