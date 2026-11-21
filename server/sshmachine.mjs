/* A MACHINE REACHED OVER SSH, MADE FROM THE PAGE (17-11): Tether's SSH access (its `ssh` connector), opened
 * with a key MADE HERE -- the same keys as the git repositories (gitaccess.mjs), one list. Its private half
 * never leaves this server: the target names it (`secrets.key` = "sshkey:<name>"), and the keeper asks it
 * of this server at connect time (tethers.mjs reveal), for the connector alone. The person adds the public
 * half to the machine's ~/.ssh/authorized_keys.
 *
 * THE SERVER'S IDENTITY IS PINNED AT ONCE: before the target is made, this server reaches the machine once
 * and reads its host key (no login: the key comes before any authentication). The fingerprint is kept
 * in the target (`config.pin`); a different key later is refused by the connector. A pin given by the
 * person is checked against what the machine shows: they must match.
 *
 *   addMachine({ tethers, keys, probe }, body)   body { title, host, port?, user, key, pin? }
 *   probeHostKey(host, port)                     -> "SHA256:…" (ssh2, no login)
 */
import { createHash } from 'node:crypto';
import { Refusal } from './conversations.mjs';

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\]|[0-9A-Fa-f:.]{2,45})$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const KEY = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
export const PROBE_MS = 8000;
export const SSH_KEY_PREFIX = 'sshkey:';

export const fingerprint = (keyBuf) => `SHA256:${createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;
const samePrint = (a, b) => String(a).replace(/=+$/, '').toLowerCase() === String(b).replace(/=+$/, '').toLowerCase();

/* The machine's host key, read once without logging in. */
export async function probeHostKey(host, port = 22, { Client = null, ms = PROBE_MS } = {}) {
    const C = Client ?? (await import('ssh2')).Client;
    return new Promise((ok, fail) => {
        const client = new C();
        let seen = null; let done = false;
        const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { client.end(); } catch { /* gone */ } fn(v); };
        const timer = setTimeout(() => end(fail, new Error('no answer')), ms);
        client.on('error', (e) => (seen ? end(ok, seen) : end(fail, e)));
        client.on('close', () => (seen ? end(ok, seen) : end(fail, new Error('closed'))));
        client.on('ready', () => end(seen ? ok : fail, seen ?? new Error('no host key')));
        try {
            client.connect({ host, port, username: 'probe', readyTimeout: ms, tryKeyboard: false,
                hostVerifier: (key, cb) => { seen = fingerprint(Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'base64')); if (typeof cb === 'function') { cb(false); return undefined; } return false; } });
        } catch (e) { end(fail, e); }
    });
}

/* An id for the target: from its title, lower case, never taken. */
const idFrom = (title, taken) => {
    const base = String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'machine';
    let id = base; for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    return id;
};

export async function addMachine({ tethers, keys, probe = probeHostKey }, body) {
    const title = String(body?.title ?? '').trim().slice(0, 80);
    const host = String(body?.host ?? '').trim();
    const user = String(body?.user ?? '').trim();
    const key = String(body?.key ?? '').trim();
    const port = body?.port === undefined || body?.port === '' || body?.port === null ? 22 : Number(body.port);
    if (!title) throw new Refusal(400, 'Give the machine a name.');
    if (!HOST.test(host)) throw new Refusal(400, 'The address is a host name or an IP address, without user or port.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal(400, 'The port is a number from 1 to 65535.');
    if (!USER.test(user)) throw new Refusal(400, 'The user is a login name: letters, digits, dot, hyphen, underscore.');
    if (!KEY.test(key) || !keys?.keys?.().some((k) => k.name === key)) throw new Refusal(400, 'Choose a key made here, or make one.');
    let seen;
    try { seen = await probe(host, port); } catch (e) { throw new Refusal(502, `The machine could not be reached at ${host}:${port} (${String(e?.message ?? e).slice(0, 120)}).`); }
    const given = String(body?.pin ?? '').trim();
    if (given && !samePrint(given, seen)) throw new Refusal(409, `The machine shows ${seen}, not the fingerprint given: nothing was made. It may not be the machine you think.`);
    const store = tethers.store();
    const id = idFrom(title, new Set(store.targets().map((t) => t.id)));
    const t = store.putTarget({ id, title, kind: 'ssh', connector: 'ssh', config: { host, port, user, pin: seen }, secrets: { key: `${SSH_KEY_PREFIX}${key}` } });
    return { id: t.id, title: t.title, pin: seen };
}

/* The machines a key opens (their titles), for "used by". */
export const machinesUsing = (tethers) => (key) => {
    try { return tethers.store().targets().filter((t) => t.kind === 'ssh' && (t.secrets?.key ?? '') === `${SSH_KEY_PREFIX}${key}`).map((t) => t.title || t.id); } catch { return []; }
};
