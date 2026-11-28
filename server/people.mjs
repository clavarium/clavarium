/* WHO IS AN ADMINISTRATOR, WHO A MEMBER (24-11, #419).
 *
 * BEFORE ANY MEMBER (no file): every account that may sign in (operators.mjs) is an ADMINISTRATOR, as every account
 * was before this file existed -- an update changes nothing for the accounts already there.
 *
 * THE FIRST MEMBER writes the file, and from then on BOTH lists are written out: the administrators by name (every
 * account there was then, but the new member) and the members. An account in neither -- added outside the page,
 * or between two steps -- is a MEMBER: nothing is ever given by default (audit 24-11).
 *
 * Two rules on top, never broken:
 *   - ONE ACCOUNT, AN ADMINISTRATOR: when only one account exists (enabled or not: a member must never become the
 *     only one by having the others locked out), it is an administrator, whatever was written;
 *   - THE LAST ADMINISTRATOR stays one: it cannot be made a member (nor, in operators.mjs, disabled, removed or
 *     locked out after failed sign-ins).
 *
 * KEPT where nothing half-written is ever read: written to a new file renamed over the old one, the good one before
 * it kept as `.bak`. Both unreadable: the lists last read stay in use; at a start with none, the accounts the
 * server was installed with (`install`, its --operators) are the administrators and every other one a member --
 * never everybody locked out, never a member made an administrator. It is said, loudly.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refusal } from './conversations.mjs';

export const ROLES = Object.freeze(['admin', 'member']);
/* What deploy/updater.mjs looks for in a release before going back to it: it reads these lists (#419). */
export const PEOPLE_LISTS = 1;
const low = (e) => String(e ?? '').trim().toLowerCase();

export class People {
    #path; #lists = null; #damaged = false; #accounts; #tell; #install; #changed = () => {};
    /* `accounts()`: every account there is, enabled or not ([{ email, enabled }], operators.mjs).
       `install`: the accounts the server was started with (--operators), the administrators of last resort. */
    #leaving;
    /* `leaving()`: the accounts being disabled or removed right now (operators.mjs), already not counted. */
    constructor({ path, accounts = () => [], tell = () => {}, install = [], leaving = () => [] }) {
        this.#path = path; this.#accounts = accounts; this.#tell = tell; this.#install = install.map(low); this.#leaving = leaving;
        mkdirSync(dirname(path), { recursive: true });
        this.#load();
    }
    /* Told when a role changes: the terminals of whoever lost something end at once (bridge.recheck). */
    useChanged(fn) { this.#changed = fn; }
    changed() { try { this.#changed(); } catch { /* the minute's recheck sees it */ } }

    #read(file) {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!data || !Array.isArray(data.admins) || !Array.isArray(data.members)) throw new Error('not a roles file');
        return { admins: [...new Set(data.admins.map(low))], members: [...new Set(data.members.map(low))] };
    }
    #load() {
        if (!existsSync(this.#path) && !existsSync(`${this.#path}.bak`)) { this.#lists = null; return; }
        for (const file of [this.#path, `${this.#path}.bak`]) {
            try { this.#lists = this.#read(file); this.#damaged = false; return; } catch { /* the next one */ }
        }
        this.#damaged = true;
        this.#tell('The file of who is an administrator cannot be read', `${this.#path}: until it is repaired, the accounts this server was installed with are its administrators, every other one a member.`);
    }
    #save() {
        const tmp = `${this.#path}.new`;
        writeFileSync(tmp, `${JSON.stringify(this.#lists, null, 1)}\n`, { mode: 0o600 });
        if (existsSync(this.#path)) { try { this.#read(this.#path); copyFileSync(this.#path, `${this.#path}.bak`); } catch { /* the old one was bad: no copy of it */ } }
        renameSync(tmp, this.#path);
        this.#damaged = false;
    }

    #all() { return (this.#accounts() ?? []).map((a) => ({ email: low(a.email), enabled: a.enabled !== false })); }

    /* 'admin' or 'member'. */
    roleOf(email) {
        const e = low(email);
        if (this.#all().length <= 1) return 'admin';
        if (this.#damaged) return this.#install.includes(e) ? 'admin' : 'member';
        if (this.#lists === null) return 'admin';
        return this.#lists.admins.includes(e) && !this.#lists.members.includes(e) ? 'admin' : 'member';
    }
    /* The enabled administrators. */
    admins() { const out = new Set([...this.#leaving()].map(low)); return this.#all().filter((a) => a.enabled && !out.has(a.email) && this.roleOf(a.email) === 'admin').map((a) => a.email); }
    /* Whether taking `email` out of the administrators (made a member, disabled, removed, locked out) leaves none. */
    isLastAdmin(email) {
        const e = low(email);
        const admins = this.admins();
        return admins.length <= 1 && (admins.length === 0 || admins[0] === e);
    }

    /* The lists written out at the first member: every account there is now an administrator, as it was. */
    #seed() { if (this.#lists === null) this.#lists = { admins: this.#all().map((a) => a.email), members: [] }; }
    #put(e, role) {
        this.#lists.admins = this.#lists.admins.filter((x) => x !== e);
        this.#lists.members = this.#lists.members.filter((x) => x !== e);
        (role === 'admin' ? this.#lists.admins : this.#lists.members).push(e);
    }

    setRole(email, role) {
        const e = low(email);
        if (!ROLES.includes(role)) throw new Refusal(400, 'A role is admin or member.');
        if (!this.#all().some((a) => a.email === e)) throw new Refusal(404, 'No such account.');
        if (this.#damaged) throw new Refusal(503, 'The file of who is an administrator cannot be read: repair it first.');
        if (role === this.roleOf(e)) return this.list();
        if (role === 'member' && this.isLastAdmin(e)) throw new Refusal(409, 'The last administrator cannot be made a member.');
        this.#seed(); this.#put(e, role); this.#save();
        this.changed();
        return this.list();
    }
    /* An account ABOUT TO BE added, its role said first: never an administrator for a moment by mistake, and an
       account removed then added again does not come back as it was. */
    /* Returns what puts it back as it was, when the account could not be added after all (audit 13): no file left
       where there was none -- an owner without members keeps everything as before. */
    adding(email, role) {
        const e = low(email);
        if (!ROLES.includes(role) || this.#damaged) return () => {};
        if (this.#lists === null && role === 'admin') return () => {};
        const before = this.#lists === null ? null : { admins: [...this.#lists.admins], members: [...this.#lists.members] };
        this.#seed(); this.#put(e, role); this.#save();
        return () => {
            if (before === null) { this.#lists = null; rmSync(this.#path, { force: true }); rmSync(`${this.#path}.bak`, { force: true }); return; }
            this.#lists = before; this.#save();
        };
    }
    /* An account removed: its role forgotten with it. */
    removed(email) {
        const e = low(email);
        if (this.#lists === null || this.#damaged) return;
        this.#lists.admins = this.#lists.admins.filter((x) => x !== e);
        this.#lists.members = this.#lists.members.filter((x) => x !== e);
        this.#save();
    }
    /* Accounts gone outside the page (the host program): their roles forgotten. Returns the addresses forgotten. */
    prune() {
        if (this.#lists === null || this.#damaged) return [];
        const here = new Set(this.#all().map((a) => a.email));
        if (here.size === 0) return [];
        const gone = [...this.#lists.admins, ...this.#lists.members].filter((e) => !here.has(e));
        if (!gone.length) return [];
        this.#lists.admins = this.#lists.admins.filter((e) => here.has(e)); this.#lists.members = this.#lists.members.filter((e) => here.has(e));
        this.#save();
        return gone;
    }
    /* The role a new account gets when none is said: a member (24-11, its owner's choice); an administrator is ticked. */
    defaultRole() { return 'member'; }
    list() { return this.#all().map((a) => ({ ...a, role: this.roleOf(a.email) })); }
}
