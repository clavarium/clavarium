/* WHO MAY SIGN IN: the operators of the identity provider (Dex), changed from
 * the page through the host program ("operator ..."), run as root. Never by the
 * server itself: the identity file is root's, and holds the password hashes.
 *
 *   node operators.mjs list                     email<TAB>enabled|disabled, one per line
 *   node operators.mjs add EMAIL                the password on standard input
 *   node operators.mjs password EMAIL           the new password on standard input
 *   node operators.mjs disable EMAIL | enable EMAIL | remove EMAIL
 *   node operators.mjs failures MINUTES         email<TAB>count: failed sign-ins lately
 *
 * The identity file is the one install.sh wrote: its operators are the entries
 * after "staticPasswords:", four lines each, in that one form; nothing else of it
 * is touched. A disabled operator's entry is kept aside (DISABLED, root's), so
 * that enabling it gives back the same password. Dex is restarted after a
 * change, and must come back: otherwise the file is put back as it was.
 * A password never sits on a command line: hashed by Caddy, from standard input.
 */
import { readFileSync, writeFileSync, renameSync, statSync, chownSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DEX_CONFIG = '/etc/dex/config.yaml';
export const DISABLED = '/etc/clavarium/operators-disabled.json';
const EMAIL = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
const MARK = 'staticPasswords:';

export class Refused extends Error {}

/* The file as [head, entries]: each entry { email, hash, username, userID }. */
export function parse(text) {
    const at = text.indexOf(`\n${MARK}\n`);
    if (at < 0) throw new Refused('the identity file has no list of operators');
    const head = text.slice(0, at + MARK.length + 2);
    const lines = text.slice(at + MARK.length + 2).split('\n').filter((l) => l.trim() !== '');
    const entries = [];
    for (let i = 0; i < lines.length; i += 4) {
        const [e, h, u, id] = lines.slice(i, i + 4).map((l) => /^\s*-?\s*[a-zA-Z]+: "([^"]*)"$/.exec(l)?.[1]);
        if ([e, h, u, id].some((x) => x === undefined)) throw new Refused('the list of operators is not in the form install.sh writes: not changed here');
        entries.push({ email: e, hash: h, username: u, userID: id });
    }
    return { head, entries };
}
export function format({ head, entries }) {
    return head + entries.map((x) => `  - email: "${x.email}"\n    hash: "${x.hash}"\n    username: "${x.username}"\n    userID: "${x.userID}"\n`).join('');
}

/* The verbs, on files and commands given (the tests give their own). */
export function operators({ config = DEX_CONFIG, disabled = DISABLED, hash = caddyHash, restart = restartDex, journal = dexJournal } = {}) {
    const read = () => parse(readFileSync(config, 'utf8'));
    const aside = () => { try { return JSON.parse(readFileSync(disabled, 'utf8')); } catch { return []; } };
    /* Its owner and mode kept (root, group dex: Dex reads it, nobody else). */
    const write = (file, text) => { const was = statSync(file); writeFileSync(`${file}.new`, text, { mode: was.mode & 0o777 }); if (process.getuid?.() === 0) chownSync(`${file}.new`, was.uid, was.gid); renameSync(`${file}.new`, file); };
    const keep = (list) => { writeFileSync(`${disabled}.new`, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 }); renameSync(`${disabled}.new`, disabled); };
    /* A change of the identity file: Dex restarted on it, or the old file back. */
    const change = (next) => {
        const before = readFileSync(config, 'utf8');
        write(config, format(next));
        if (!restart()) { write(config, before); restart(); throw new Refused('the identity provider did not start with the change: nothing was changed'); }
    };
    const email = (x) => { const e = String(x ?? '').trim().toLowerCase(); if (!EMAIL.test(e)) throw new Refused('not an e-mail address'); return e; };
    const enabled = () => read().entries.filter((x) => x.email);
    return {
        list() { return [...enabled().map((x) => ({ email: x.email, enabled: true })), ...aside().map((x) => ({ email: x.email, enabled: false }))]; },
        add(who, password) {
            const e = email(who);
            if (this.list().some((x) => x.email === e)) throw new Refused(`${e} is an operator already`);
            const f = read();
            change({ ...f, entries: [...f.entries, { email: e, hash: hash(password), username: e.split('@')[0], userID: randomUUID() }] });
        },
        password(who, password) {
            const e = email(who);
            const f = read();
            const i = f.entries.findIndex((x) => x.email === e);
            if (i < 0) {
                const list = aside(); const j = list.findIndex((x) => x.email === e);
                if (j < 0) throw new Refused(`${e} is not an operator`);
                list[j] = { ...list[j], hash: hash(password) }; keep(list); return;
            }
            f.entries[i] = { ...f.entries[i], hash: hash(password) };
            change(f);
        },
        disable(who) {
            const e = email(who);
            const f = read();
            const one = f.entries.find((x) => x.email === e);
            if (!one) throw new Refused(`${e} is not an enabled operator`);
            if (f.entries.length === 1) throw new Refused('the last operator cannot be disabled: nobody could sign in any more');
            keep([...aside().filter((x) => x.email !== e), one]);
            change({ ...f, entries: f.entries.filter((x) => x.email !== e) });
        },
        enable(who) {
            const e = email(who);
            const list = aside(); const one = list.find((x) => x.email === e);
            if (!one) throw new Refused(`${e} is not a disabled operator`);
            const f = read();
            change({ ...f, entries: [...f.entries, one] });
            keep(list.filter((x) => x.email !== e));
        },
        remove(who) {
            const e = email(who);
            const f = read();
            if (f.entries.some((x) => x.email === e)) {
                if (f.entries.length === 1) throw new Refused('the last operator cannot be removed: nobody could sign in any more');
                change({ ...f, entries: f.entries.filter((x) => x.email !== e) });
            }
            keep(aside().filter((x) => x.email !== e));
        },
        /* Failed sign-ins in the last minutes, as Dex logs them: { email: count }. */
        failures(minutes) {
            const counts = {};
            for (const m of journal(minutes).matchAll(/msg="failed login attempt[^"]*" user=(\S+)/g)) { const e = m[1].toLowerCase(); counts[e] = (counts[e] ?? 0) + 1; }
            return counts;
        },
    };
}

function caddyHash(password) {
    const p = String(password ?? '');
    if (p.length < 12 || p.length > 200 || /[\r\n\0]/.test(p)) throw new Refused('a password is one line of 12 to 200 characters');
    const r = spawnSync('/usr/local/bin/caddy', ['hash-password'], { input: `${p}\n`, encoding: 'utf8' });
    const h = String(r.stdout ?? '').trim();
    if (r.status !== 0 || !h.startsWith('$2')) throw new Refused('the password could not be hashed');
    return h;
}
function restartDex() {
    spawnSync('systemctl', ['restart', 'dex.service']);
    for (let i = 0; i < 20; i += 1) {
        if (spawnSync('systemctl', ['is-active', '--quiet', 'dex.service']).status === 0) return true;
        spawnSync('sleep', ['0.5']);
    }
    return false;
}
function dexJournal(minutes) {
    const r = spawnSync('journalctl', ['-u', 'dex.service', '--since', `-${Number(minutes)}min`, '-o', 'cat', '--no-pager'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return String(r.stdout ?? '');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [verb, arg] = process.argv.slice(2);
    const ops = operators();
    const stdin = () => { try { return readFileSync(0, 'utf8').replace(/\r?\n$/, ''); } catch { return ''; } };
    try {
        if (verb === 'list') for (const o of ops.list()) console.log(`${o.email}\t${o.enabled ? 'enabled' : 'disabled'}`);
        else if (verb === 'add') ops.add(arg, stdin());
        else if (verb === 'password') ops.password(arg, stdin());
        else if (['disable', 'enable', 'remove'].includes(verb)) ops[verb](arg);
        else if (verb === 'failures') { const m = Number(arg); if (!Number.isInteger(m) || m < 1 || m > 1440) throw new Refused('failures MINUTES'); for (const [e, n] of Object.entries(ops.failures(m))) console.log(`${e}\t${n}`); }
        else throw new Refused('list | add EMAIL | password EMAIL | disable EMAIL | enable EMAIL | remove EMAIL | failures MINUTES');
    } catch (error) {
        console.error(error instanceof Refused ? `REFUSED: ${error.message}` : String(error?.message ?? error));
        process.exit(error instanceof Refused ? 78 : 1);
    }
}
