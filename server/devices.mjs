/* THE DEVICE DOOR: a phone or a tablet that sees the conversations shared
   with it -- each one by a pairing of its own.
 *
 * (It began as ONE conversation per device. The owner asked for several on
 * the same device: a device now holds several PAIRINGS, each with its own
 * key and its own session, and each still sees one conversation and nothing
 * else. What follows describes one pairing.)
 *
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
import { Grants, readRights, pairingSubject, typeOf, nameOf } from './grants.mjs';

export const CODE_MINUTES = 10;
export const SESSION_HOURS = 12;
export const CHALLENGE_SECONDS = 60;
export const DEVICES_MAX = 20;       /* per conversation */
export const SHARE_MAX = 30;         /* things given by one code */
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
    #store; #now; #grants;
    #codes = new Map();        /* sha256(code) -> { grants: [{ asset, rights }], expires } */
    #challenges = new Map();   /* device id -> { nonce, expires } */
    #sessions = new Map();     /* sha256(session) -> { device, expires } */

    /* `grants`: the one table of rights. What a code gives a device is lines
       of it: use this conversation, read that folder. */
    constructor(store, now = () => Date.now(), grants = new Grants()) {
        this.#store = store; this.#now = now; this.#grants = grants;
        /* An earlier version bound a pairing to one conversation, in its own
           record: taken over into the table, once. */
        for (const d of store.all()) {
            if (d.conversation === undefined) continue;
            this.#grants.give(pairingSubject(d.name), `conversation:${d.conversation}`, 'x');
            delete d.conversation; store.put(d);
        }
    }

    /* What one pairing was given: [{ asset, type, name, rights }]. */
    grantsOf(id) { return this.#grants.of(pairingSubject(id)); }
    conversationsOf(id) { return this.#grants.of(pairingSubject(id), 'conversation').map((g) => g.name); }
    #shown(d) { return { id: d.name, label: d.label, createdAt: d.createdAt, seenAt: d.seenAt ?? null, grants: this.grantsOf(d.name).map(({ asset, rights }) => ({ asset, rights })) }; }

    /* ---- operator side ---- */

    /* A code for ONE device, giving it a chosen list: conversations to use,
       folders, mailboxes or repositories to read or to write. `what` is that
       list, [{ asset, rights }] -- or, for short, the name of a conversation. */
    share(what, label) {
        const asked = typeof what === 'string' ? [{ asset: `conversation:${what}`, rights: 'x' }] : what;
        if (!Array.isArray(asked) || asked.length === 0) throw new Refusal(400, 'A share gives at least one thing.');
        if (asked.length > SHARE_MAX) throw new Refusal(400, `A share gives at most ${SHARE_MAX} things.`);
        const given = new Map();
        for (const g of asked) {
            const rights = readRights(g?.asset, g?.rights);
            if (typeOf(g.asset) === 'secret') throw new Refusal(400, 'A secret is handed to a conversation, never shared with a device.');
            given.set(g.asset, rights);
        }
        for (const asset of given.keys()) {
            if (typeOf(asset) === 'conversation' && this.of(nameOf(asset)).length >= DEVICES_MAX) throw new Refusal(409, `A conversation is shared with at most ${DEVICES_MAX} devices.`);
        }
        const code = token();
        /* Only a digest is kept: a code read from memory or a dump opens nothing. */
        this.#codes.set(digest(code).toString('hex'), { grants: [...given].map(([asset, rights]) => ({ asset, rights })), label: oneLine(label) ? label.trim() : undefined, expires: this.#now() + CODE_MINUTES * 60_000 });
        return { code, minutes: CODE_MINUTES };
    }

    /* The devices that may use this conversation, each with all it was given. */
    of(conversation) {
        return this.#store.all().filter((d) => this.#grants.can(pairingSubject(d.name), `conversation:${conversation}`, 'x')).map((d) => this.#shown(d));
    }
    /* Every device, each with all it was given. */
    all() { return this.#store.all().map((d) => this.#shown(d)); }

    /* One thing is taken back from one device; a device left with nothing is removed. */
    take(id, asset) {
        if (!this.#store.get(id)) throw new Refusal(404, 'No such device.');
        this.#grants.take(pairingSubject(id), String(asset));
        if (this.grantsOf(id).length === 0) this.revoke(id);
    }

    revoke(id) {
        if (!this.#store.get(id)) throw new Refusal(404, 'No such device.');
        this.#store.remove(id);
        this.#grants.forgetSubject(pairingSubject(id));
        this.#challenges.delete(id);
        for (const [key, s] of this.#sessions) if (s.device === id) this.#sessions.delete(key);
    }

    /* Something is gone (a conversation archived, a folder removed): nobody
       has a right on it any more, and a device left with nothing goes too. */
    forget(conversation) { this.forgetAsset(`conversation:${conversation}`); }
    forgetAsset(asset) {
        this.#grants.forgetAsset(asset);
        for (const d of this.#store.all()) if (this.grantsOf(d.name).length === 0) this.revoke(d.name);
    }

    /* ---- device side ---- */

    pair({ code, key, label }) {
        const entry = typeof code === 'string' ? this.#codes.get(digest(code).toString('hex')) : undefined;
        /* One use: the code is spent whether or not what follows succeeds. */
        if (typeof code === 'string') this.#codes.delete(digest(code).toString('hex'));
        if (!entry || entry.expires < this.#now()) throw new Refusal(403, 'This code is not valid any more. Ask for a new one.');
        const publicKey = readPublicKey(key);
        const device = { name: randomUUID(), key: publicKey,
            /* The name the owner chose for whom the code was made, if any: every device otherwise looks the same in the list. */
            label: entry.label ?? (oneLine(label) ? label.trim() : 'A device'), createdAt: new Date(this.#now()).toISOString() };
        this.#store.put(device);
        for (const g of entry.grants) this.#grants.give(pairingSubject(device.name), g.asset, g.rights);
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

    /* The pairing a session was opened for, or undefined. `pairing`, when
       given, must be that one: a device that holds several cannot use the
       session of one to speak for another. */
    pairingOf(session, pairing) {
        if (typeof session !== 'string' || session === '') return undefined;
        const key = digest(session);
        for (const [stored, s] of this.#sessions) {
            if (!timingSafeEqual(Buffer.from(stored, 'hex'), key)) continue;
            if (s.expires < this.#now()) { this.#sessions.delete(stored); return undefined; }
            if (pairing !== undefined && s.device !== pairing) return undefined;
            return this.#store.get(s.device) ? s.device : undefined;
        }
        return undefined;
    }
    /* The conversation a session speaks for: the one it names if it may use
       it, otherwise the first it was given -- never one it was not given. */
    conversationOf(session, pairing, wanted) {
        const id = this.pairingOf(session, pairing);
        if (id === undefined) return undefined;
        const mine = this.conversationsOf(id);
        return mine.includes(wanted) ? wanted : mine[0];
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
/* One cookie PER PAIRING, named after it: a device that holds several
   conversations keeps a session for each, and they do not replace each other. */
export const isPairingId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export const cookieNameOf = (pairing) => `${SESSION_COOKIE}_${pairing}`;
export function sessionCookie(pairing, session, hours, secure) {
    if (!isPairingId(pairing)) throw new Refusal(400, 'Not a pairing.');
    return `${cookieNameOf(pairing)}=${session}; Path=/c/; Max-Age=${hours * 3600}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
