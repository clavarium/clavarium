/* WHO MAY DO WHAT WITH WHAT: one table, for everything.
 *
 * Everything this server keeps is an ASSET with a type: a conversation, a
 * folder, a mailbox, a git repository, a secret. A right is one line:
 *
 *      subject            asset              rights
 *      conversation:a     folder:reports     rw      (what used to be "attached, write")
 *      pairing:<id>       conversation:a     x       (what used to be "shared by a code")
 *      pairing:<id>       folder:reports     r
 *      conversation:a     secret:MODEL_KEY   x
 *
 * Three rights, as on a file -- read, write, use -- and each type takes only
 * those that mean something for it:
 *
 *                     r                       w                        x
 *   conversation      -                       -                        open its terminal
 *   folder            list, show, download    import, change           -
 *   mailbox           read the messages       (send, file: not built)  -
 *   git               see the files           change them              -
 *   secret            never                   -                        be handed to a conversation
 *
 * Two kinds of subject: a CONVERSATION (what is attached to it reaches its
 * machine) and a PAIRING (what a device was given by a code). The owner is
 * not in the table: the owner may do everything, always.
 *
 * No groups, no inheritance. One rule sits on top, in the door: whoever may
 * use a conversation sees the files of that conversation -- where its tool
 * works, and what is attached to it.
 */
import { Refusal } from './conversations.mjs';

export const RIGHTS = Object.freeze({ conversation: 'x', folder: 'rw', mailbox: 'r', git: 'rw', secret: 'x' });
const SUBJECT = /^(conversation:[a-z]([a-z0-9-]{0,30}[a-z0-9])?|pairing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ASSET = /^(conversation|folder|mailbox|git):[a-z]([a-z0-9-]{0,30}[a-z0-9])?$|^secret:[A-Z][A-Z0-9_]{0,39}$/;

export const typeOf = (asset) => String(asset).split(':')[0];
export const nameOf = (asset) => String(asset).slice(String(asset).indexOf(':') + 1);
export const conversationSubject = (name) => `conversation:${name}`;
export const pairingSubject = (id) => `pairing:${id}`;

/* The rights asked for, in the one order they are written, or a refusal:
   only letters this type of asset takes, at least one, none twice. */
export function readRights(asset, rights) {
    if (typeof asset !== 'string' || !ASSET.test(asset)) throw new Refusal(400, 'Not an asset: a type and a name, such as "folder:reports".');
    const allowed = RIGHTS[typeOf(asset)];
    const asked = [...new Set(String(rights ?? ''))];
    if (asked.length === 0 || asked.some((r) => !allowed.includes(r))) {
        throw new Refusal(400, `A ${typeOf(asset)} takes these rights: ${[...allowed].join(', ')}.`);
    }
    /* Writing without reading is not a thing here: "w" brings "r" with it. */
    if (asked.includes('w') && allowed.includes('r') && !asked.includes('r')) asked.push('r');
    return [...'rwx'].filter((r) => asked.includes(r)).join('');
}

export class Grants {
    #store;
    constructor(store) { this.#store = store; }

    #key(subject, asset) { return `${subject}|${asset}`; }

    give(subject, asset, rights) {
        if (typeof subject !== 'string' || !SUBJECT.test(subject)) throw new Refusal(400, 'Not somebody a right can be given to.');
        const clean = readRights(asset, rights);
        /* A secret is handed to a conversation, never to a device: a device
           would be a way to read it. */
        if (typeOf(asset) === 'secret' && !subject.startsWith('conversation:')) throw new Refusal(400, 'A secret is handed to a conversation, never shared with a device.');
        if (typeOf(asset) === 'conversation' && !subject.startsWith('pairing:')) throw new Refusal(400, 'A conversation is shared with a device, not with another conversation.');
        this.#store.put({ name: this.#key(subject, asset), subject, asset, rights: clean });
        return clean;
    }

    take(subject, asset) { this.#store.remove(this.#key(subject, asset)); }

    /* '' when there is no line. */
    rightsOf(subject, asset) { return this.#store.get(this.#key(subject, asset))?.rights ?? ''; }
    can(subject, asset, right) { return this.rightsOf(subject, asset).includes(right); }

    /* What one subject has: [{ asset, type, name, rights }]. */
    of(subject, type) {
        return this.#store.all().filter((g) => g.subject === subject && (type === undefined || typeOf(g.asset) === type))
            .map((g) => ({ asset: g.asset, type: typeOf(g.asset), name: nameOf(g.asset), rights: g.rights }));
    }

    /* Who has something on one asset: [{ subject, rights }]. */
    on(asset) { return this.#store.all().filter((g) => g.asset === asset).map((g) => ({ subject: g.subject, rights: g.rights })); }

    forgetSubject(subject) { for (const g of this.#store.all()) if (g.subject === subject) this.#store.remove(g.name); }
    forgetAsset(asset) { for (const g of this.#store.all()) if (g.asset === asset) this.#store.remove(g.name); }
}
