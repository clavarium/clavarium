/* THE DEVICE DOOR: a phone or a tablet that sees ONE conversation.
 *
 * The operator shares a conversation with a QR code. The device that scans it
 * makes its own key pair, keeps the private half where it cannot be read back
 * out, and gives the public half once. From then on it proves, by signing,
 * only this: "I am the device that was paired". Not a name, not an email.
 *
 *   share     the operator asks for a one-use code, valid a few minutes
 *   pair      the device presents the code and its public key: bound to ONE
 *             conversation, for good, until revoked
 *   session   the device signs a fresh challenge and gets a short session
 *   revoke    the operator removes the device: its sessions end at once
 *
 * A device never chooses its conversation: every request it makes is answered
 * for the conversation it was bound to, whatever it asks.
 */
import { randomBytes, randomUUID, createPublicKey, verify, timingSafeEqual, createHash } from 'node:crypto';
import { Refusal } from './conversations.mjs';

export const CODE_MINUTES = 10;
export const SESSION_HOURS = 12;
export const CHALLENGE_SECONDS = 60;
export const DEVICES_MAX = 20;       /* per conversation */
export const LABEL_MAX = 40;

const token = () => randomBytes(32).toString('base64url');
const digest = (text) => createHash('sha256').update(text).digest();
const oneLine = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= LABEL_MAX
    && ![...value].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0); });

/* Only the curve and the form the pairing page produces are accepted. */
function readPublicKey(jwk) {
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.d !== undefined) {
        throw new Refusal(400, 'This is not a device key.');
    }
    try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }); }
    catch { throw new Refusal(400, 'This is not a device key.'); }
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

export class Devices {
    #store; #now;
    #codes = new Map();        /* sha256(code) -> { conversation, expires } */
    #challenges = new Map();   /* device id -> { nonce, expires } */
    #sessions = new Map();     /* sha256(session) -> { device, expires } */

    constructor(store, now = () => Date.now()) { this.#store = store; this.#now = now; }

    /* ---- operator side ---- */

    share(conversation) {
        if (this.of(conversation).length >= DEVICES_MAX) throw new Refusal(409, `A conversation is shared with at most ${DEVICES_MAX} devices.`);
        const code = token();
        /* Only a digest is kept: a code read from memory or a dump opens nothing. */
        this.#codes.set(digest(code).toString('hex'), { conversation, expires: this.#now() + CODE_MINUTES * 60_000 });
        return { code, minutes: CODE_MINUTES };
    }

    of(conversation) {
        return this.#store.all().filter((d) => d.conversation === conversation)
            .map(({ name, label, createdAt, seenAt }) => ({ id: name, label, createdAt, seenAt: seenAt ?? null }));
    }

    revoke(id) {
        if (!this.#store.get(id)) throw new Refusal(404, 'No such device.');
        this.#store.remove(id);
        this.#challenges.delete(id);
        for (const [key, s] of this.#sessions) if (s.device === id) this.#sessions.delete(key);
    }

    /* The conversation is archived: its devices go with it. */
    forget(conversation) {
        for (const d of this.#store.all()) if (d.conversation === conversation) this.revoke(d.name);
    }

    /* ---- device side ---- */

    pair({ code, key, label }) {
        const entry = typeof code === 'string' ? this.#codes.get(digest(code).toString('hex')) : undefined;
        /* One use: the code is spent whether or not what follows succeeds. */
        if (typeof code === 'string') this.#codes.delete(digest(code).toString('hex'));
        if (!entry || entry.expires < this.#now()) throw new Refusal(403, 'This code is not valid any more. Ask for a new one.');
        const publicKey = readPublicKey(key);
        const device = { name: randomUUID(), conversation: entry.conversation, key: publicKey,
            label: oneLine(label) ? label.trim() : 'A device', createdAt: new Date(this.#now()).toISOString() };
        this.#store.put(device);
        return { device: device.name };
    }

    challenge(id) {
        /* The same answer for a known and an unknown device: nothing to probe. */
        const nonce = token();
        if (this.#store.get(id)) this.#challenges.set(id, { nonce, expires: this.#now() + CHALLENGE_SECONDS * 1000 });
        return { nonce };
    }

    /* `signature` is the device's signature of the nonce, base64url. */
    open(id, signature) {
        const device = this.#store.get(id);
        const pending = this.#challenges.get(id);
        this.#challenges.delete(id);
        const refused = new Refusal(403, 'This device is not paired, or was removed.');
        if (!device || !pending || pending.expires < this.#now() || typeof signature !== 'string') throw refused;
        let good = false;
        try {
            good = verify('sha256', Buffer.from(pending.nonce), { key: createPublicKey({ key: device.key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
        } catch { good = false; }
        if (!good) throw refused;
        const session = token();
        this.#sessions.set(digest(session).toString('hex'), { device: id, expires: this.#now() + SESSION_HOURS * 3_600_000 });
        this.#store.patch(id, { seenAt: new Date(this.#now()).toISOString() });
        return { session, hours: SESSION_HOURS };
    }

    /* The conversation a session may see, or undefined. */
    conversationOf(session) {
        if (typeof session !== 'string' || session === '') return undefined;
        const key = digest(session);
        for (const [stored, s] of this.#sessions) {
            if (!timingSafeEqual(Buffer.from(stored, 'hex'), key)) continue;
            if (s.expires < this.#now()) { this.#sessions.delete(stored); return undefined; }
            return this.#store.get(s.device)?.conversation;
        }
        return undefined;
    }
}

export const SESSION_COOKIE = 'clv_device';

export function readCookie(header, name) {
    for (const part of String(header ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return undefined;
}

/* HttpOnly: the page's scripts cannot read it. Path=/c/: the operator's side
   never receives it. SameSite=Strict: another site cannot make it travel. */
export function sessionCookie(session, hours, secure) {
    return `${SESSION_COOKIE}=${session}; Path=/c/; Max-Age=${hours * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
