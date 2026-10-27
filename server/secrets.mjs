/* SECRETS HANDED TO A TOOL.
 *
 * Some tools need a key to run. Such a secret is attached to a conversation
 * and arrives in its VM two ways at once:
 *   - a file in memory, /run/secrets/<NAME>, gone when the VM stops;
 *   - a variable of the tool's own process, <NAME>.
 *
 * HOW IT TRAVELS: sealed on the host; opened only at the moment of delivery;
 * sent on the STANDARD INPUT of the command that writes it. Never in an
 * argument list -- arguments show in process lists, here and in the VM --
 * never on a shared folder, never written to the VM's disk by this server,
 * never in a log, never back to a browser: once saved, a value cannot be
 * read again from the page, only replaced.
 *
 * EXPIRY (optional, a day, like a token's): from that day on the secret is
 * kept -- never deleted by itself -- but no longer delivered; WARN_DAYS
 * before, the page says it is near. Days are those of this server's clock.
 *
 * WHAT IT IS NOT: protected from the tool. The agent is root in its VM and
 * can read and send anywhere whatever is delivered there. A secret the host
 * should use on the agent's behalf (a push key, a mailbox password) does not
 * belong here, and never enters a VM.
 */
import { randomBytes } from 'node:crypto';
import { Refusal } from './conversations.mjs';
import { Grants, conversationSubject } from './grants.mjs';
import { isConversationName } from './names.mjs';
import { VM_USER } from './vm.mjs';

export const SECRETS_DIR = '/run/secrets';
export const RUNNER = '/usr/local/bin/clv-run';
export const VALUE_MAX = 8 * 1024;
export const WARN_DAYS = 7;
/* A secret lifted from a message (secret-scan.mjs): a random name, a short
   life in MINUTES (not days), swept when it runs out. */
export const EPHEMERAL_PREFIX = 'SECRET_';
export const TTL_DEFAULT_MS = 10 * 60_000;
export const TTL_MIN_MS = 60_000;
export const TTL_MAX_MS = 60 * 60_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
/* Names the tool's own start depends on must not be replaced by a secret. */
const RESERVED = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'PWD', 'IFS', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);

export const isSecretName = (name) => typeof name === 'string' && NAME.test(name) && !RESERVED.has(name);

/* The tool is started THROUGH this, inside the VM: it turns each delivered
   file into a variable, then BECOMES the tool (exec): no shell stays behind
   it. Written to the VM by this server at each opening. */
export const RUNNER_SCRIPT = `#!/bin/sh
# Written by the host. Exports each delivered secret, then becomes the tool.
for f in ${SECRETS_DIR}/*; do
  n=$(basename "$f")
  # Only what is named like a variable: anything else left there is ignored.
  case "$n" in *[!A-Z0-9_]*|[!A-Z]*) continue ;; esac
  [ -f "$f" ] && export "$n=$(cat "$f")"
done
exec "$@"
`;

/* A day as YYYY-MM-DD, or '' / null for none; anything else is refused. */
export function expiryOf(value) {
    if (value === undefined || value === null || value === '') return null;
    const m = DAY.exec(String(value));
    const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (!d || d.toISOString().slice(0, 10) !== value || Number(m[1]) < 2000) throw new Refusal(400, 'An expiry is a day, as YYYY-MM-DD.');
    return value;
}
/* Whole days from today (this server's local day) to that day: 0 or less, expired. */
export function daysTo(day, now = new Date()) {
    const m = DAY.exec(day);
    return Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
}

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Secrets {
    #store; #vault; #vms; #grants; #now; #timers = new Map();

    /* `grants`: the one table of rights. "Handed to a conversation" is a
       line of it: the conversation may USE the secret. */
    constructor({ store, vault, vms, grants = new Grants(), now = () => new Date() }) {
        this.#store = store; this.#vault = vault; this.#vms = vms; this.#grants = grants; this.#now = now;
        for (const s of store.all()) {
            if (s.attachments === undefined) continue;
            for (const conversation of Object.keys(s.attachments)) this.#grants.give(conversationSubject(conversation), `secret:${s.name}`, 'x');
            delete s.attachments; store.put(s);
        }
        /* A restart loses the sweep timers: drop the ephemeral secrets that ran
           out while down, and set a fresh timer for those still alive. */
        for (const s of store.all()) {
            if (s.ephemeral !== true) continue;
            const who = this.#users(s.name)[0];
            const left = who ? Date.parse(s.expiresAt) - this.#now().getTime() : 0;
            if (!who || !(left > 0)) { store.remove(s.name); this.#grants.forgetAsset(`secret:${s.name}`); }
            else this.#schedule(who, s.name, left);
        }
    }
    #handed(conversation, name) { return this.#grants.can(conversationSubject(conversation), `secret:${name}`, 'x'); }
    /* Ephemeral: gone at its moment (minutes). Otherwise: gone from its day on. */
    #expired(s) { return s.expiresAt ? Date.parse(s.expiresAt) <= this.#now().getTime() : (Boolean(s.expires) && daysTo(s.expires, this.#now()) <= 0); }
    #users(name) { return this.#grants.on(`secret:${name}`).map((g) => g.subject.slice('conversation:'.length)); }
    /* What is delivered to this conversation: handed, and not expired. */
    #given(conversation) { return this.#store.all().filter((s) => this.#handed(conversation, s.name) && !this.#expired(s)); }

    /* Names, where they are attached, the expiry. Never a value. `days`: whole
       days left (null without an expiry); `expired`: no longer delivered. A
       host-only secret (an account token the server holds) is left out -- it is
       never given to a machine, so the page never lists it; `held` includes it. */
    list({ held = false } = {}) {
        return this.#store.all().filter((s) => held || !s.hostOnly).map((s) => ({ name: s.name, conversations: this.#users(s.name), createdAt: s.createdAt,
            expires: s.expires ?? null, days: s.expires ? daysTo(s.expires, this.#now()) : null, expired: this.#expired(s), ...(s.hostOnly ? { hostOnly: true } : {}),
            ...(s.ephemeral ? { ephemeral: true, expiresAt: s.expiresAt, expiresInMs: Math.max(0, Date.parse(s.expiresAt) - this.#now().getTime()) } : {}) }));
    }
    /* Past its expiry day: kept, not used (nor by dictation, voice.mjs). */
    isExpired(name) { const s = this.#store.get(name); return Boolean(s) && this.#expired(s); }
    /* Handed to it, expired or not (its Assets show both). */
    of(conversation) { return this.#store.all().filter((s) => this.#handed(conversation, s.name)).map((s) => s.name); }
    /* Delivered to it at its next start. */
    given(conversation) { return this.#given(conversation).map((s) => s.name); }
    /* The EPHEMERAL secrets live for it now (a message of it holds their marker), each with how long it has
       left -- the chat shows the stars with that, and a way to forget it (talk/parley-ui). Never a value. */
    liveFor(conversation) { return this.#given(conversation).filter((s) => s.ephemeral === true).map((s) => ({ name: s.name, expiresInMs: Math.max(0, Date.parse(s.expiresAt) - this.#now().getTime()) })); }

    /* The value, for this server's own use only (the key of the dictation
       engine, put in a request's header): never returned by any route. */
    reveal(name) { const s = this.#store.get(name); return s ? this.#vault.open(s.sealed) : undefined; }

    /* Creates, or replaces the value of, a secret. `expires`: a day, '' for
       none, left out to keep the one it had. */
    set({ name, value, expires, hostOnly }) {
        if (!isSecretName(name)) throw new Refusal(400, 'A secret is named like a variable: capitals, digits and underscores, starting with a letter.');
        const sealed = this.#seal(value);
        const day = expires === undefined ? undefined : expiryOf(expires);
        const before = this.#store.get(name);
        /* hostOnly: a secret the server uses on the agent's behalf (an account token the
           keeper reveals by name). It is never attached to a conversation, so never
           delivered to a machine; attach() refuses it, so this cannot be undone by hand. */
        this.#write({ ...before, name, sealed, createdAt: before?.createdAt ?? new Date().toISOString(), ...(hostOnly ? { hostOnly: true } : {}) }, day);
        return { name };
    }

    /* REPLACED in place, without being seen: a new value (empty keeps the
       one it has) and/or a new expiry ('' removes it). Its name and the
       conversations it is handed to stay; they get it at their next start. */
    replace(name, { value, expires } = {}) {
        const before = this.#store.get(name);
        if (!before) throw new Refusal(404, 'No such secret.');
        const keep = value === undefined || value === null || value === '';
        const day = expires === undefined ? undefined : expiryOf(expires);
        if (keep && day === undefined) throw new Refusal(400, 'Nothing to change: a new value or an expiry.');
        this.#write({ ...before, sealed: keep ? before.sealed : this.#seal(value) }, day);
        return { name, expires: this.#store.get(name).expires ?? null };
    }

    #seal(value) {
        if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > VALUE_MAX) throw new Refusal(400, `A value is between 1 byte and ${VALUE_MAX / 1024} KB.`);
        if (value.includes('\0')) throw new Refusal(400, 'A value cannot contain a null byte.');
        return this.#vault.seal(value);
    }
    /* `day`: undefined keeps the expiry, null removes it. */
    #write(record, day) {
        const next = { ...record };
        if (day !== undefined) { if (day) next.expires = day; else delete next.expires; }
        this.#store.put(next);
        this.check();
    }

    /* Said once, when it expires (`expired(name, conversations)`): remembered
       with the day said, so a new expiry is said again when it comes. */
    check() {
        for (const s of this.#store.all()) {
            if (!this.#expired(s) || s.expiredSaid === s.expires) continue;
            this.#store.patch(s.name, { expiredSaid: s.expires });
            try { this.expired(s.name, this.#users(s.name)); } catch { /* said nowhere: never a reason to fail */ }
        }
    }
    expired = () => {};

    /* RENAMED: its value (still sealed, never opened) and the conversations it is handed to go with
       it; `renamed(from, to)` tells what else names it (dictation's key). Delivered under its new
       name at each conversation's next start. */
    rename(from, to) {
        const secret = this.#store.get(from);
        if (!secret) throw new Refusal(404, 'No such secret.');
        if (!isSecretName(to)) throw new Refusal(400, 'A secret is named like a variable: capitals, digits and underscores, starting with a letter.');
        if (to === from) return { name: to };
        if (this.#store.get(to)) throw new Refusal(409, `A secret is already named ${to}.`);
        this.#store.put({ ...secret, name: to });
        for (const g of this.#grants.on(`secret:${from}`)) this.#grants.give(g.subject, `secret:${to}`, g.rights);
        this.#grants.forgetAsset(`secret:${from}`);
        this.#store.remove(from);
        this.renamed(from, to);
        return { name: to };
    }
    renamed = () => {};

    remove(name) {
        if (!this.#store.get(name)) throw new Refusal(404, 'No such secret.');
        this.#store.remove(name);
        this.#grants.forgetAsset(`secret:${name}`);
    }

    attach(conversation, name, attached) {
        const secret = this.#store.get(name);
        if (!secret) throw new Refusal(404, 'No such secret.');
        if (attached && secret.hostOnly) throw new Refusal(403, 'This secret is held by the server (an account token) and is never put in a machine.');
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        if (attached) this.#grants.give(conversationSubject(conversation), `secret:${name}`, 'x'); else this.#grants.take(conversationSubject(conversation), `secret:${name}`);
    }

    forget(conversation) {
        for (const s of this.#store.all()) this.#grants.take(conversationSubject(conversation), `secret:${s.name}`);
    }

    /* AN EPHEMERAL SECRET lifted from a message of `conversation` (talk.mjs):
       a random name, a few minutes to live, handed at once to that
       conversation, swept when it runs out. Returns { name, expiresAt } -- the
       name is the reference the message keeps (its value is masked there). As
       with every secret the value is sealed and never returned by any route;
       the tool uses it only as /run/secrets/<name>, and never sees it. */
    stash(conversation, value, { ttlMs } = {}) {
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        const sealed = this.#seal(value);
        const ttl = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Number.isFinite(ttlMs) ? ttlMs : TTL_DEFAULT_MS));
        let name; do { name = EPHEMERAL_PREFIX + randomBytes(5).toString('hex').toUpperCase(); } while (this.#store.get(name));
        const expiresAt = new Date(this.#now().getTime() + ttl).toISOString();
        this.#store.put({ name, sealed, createdAt: this.#now().toISOString(), expiresAt, ephemeral: true });
        this.#grants.give(conversationSubject(conversation), `secret:${name}`, 'x');
        this.#schedule(conversation, name, ttl);
        return { name, expiresAt };
    }

    /* Forgotten before it runs out, on the tool's word or the owner's: gone
       from the vault and, at once, from the running machine. */
    async drop(conversation, name) {
        const s = this.#store.get(name);
        if (!s || s.ephemeral !== true) throw new Refusal(404, 'No such short-lived secret.');
        const t = this.#timers.get(name); if (t) { clearTimeout(t); this.#timers.delete(name); }
        await this.#reap(conversation, name);
        return { name };
    }

    #schedule(conversation, name, ttl) {
        const t = setTimeout(() => { this.#timers.delete(name); void this.#reap(conversation, name); }, ttl);
        t.unref?.();
        this.#timers.set(name, t);
    }
    /* Remove it, then rewrite the machine's /run/secrets without it (a tmpfs
       already cleared if the machine is gone -- so a failure here is fine). */
    async #reap(conversation, name) {
        if (this.#store.get(name)) { this.#store.remove(name); this.#grants.forgetAsset(`secret:${name}`); }
        try { await this.deliver(conversation); } catch { /* machine asleep or busy: /run/secrets is tmpfs */ }
        try { this.reaped(conversation, name); } catch { /* told nowhere: never a reason to fail */ }
    }
    reaped = () => {};

    /* What a delivery to this conversation would contain, as one string that
       changes whenever a delivery would differ: names and sealed values. */
    signature(conversation) {
        return this.#given(conversation).map((s) => `${s.name}=${s.sealed}`).sort().join('|');
    }

    /* Puts in the VM exactly the secrets attached NOW and not expired, and the
       runner. Called each time the conversation is opened: a detached or
       expired secret disappears from the VM, a new one appears, and a
       restarted VM gets them back. */
    async deliver(conversation) {
        const run = async (argv, input) => {
            const r = await this.#vms.exec(conversation, argv, { input });
            if (r.code !== 0) throw new Refusal(502, `The machine could not be prepared: ${firstLine(r.stderr)}`);
        };
        await run(['sudo', '-n', 'install', '-m', '0755', '/dev/stdin', RUNNER], RUNNER_SCRIPT);
        await run(['sudo', '-n', 'install', '-d', '-m', '0755', SECRETS_DIR]);
        await run(['sudo', '-n', 'find', SECRETS_DIR, '-mindepth', '1', '-delete']);
        for (const secret of this.#given(conversation)) {
            await run(['sudo', '-n', 'install', '-m', '0600', '-o', VM_USER, '-g', VM_USER, '/dev/stdin', `${SECRETS_DIR}/${secret.name}`], this.#vault.open(secret.sealed));
        }
    }
}
