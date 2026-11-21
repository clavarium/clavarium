/* GROUPS OF ASSETS: a folder-style tidy-up, for the owner's convenience.
 *
 * The owner may have many assets -- folders, git repositories, mailboxes,
 * secrets, connexions. A GROUP is a named box they drop some of them into,
 * to calm the three places assets are shown (the Assets list, a
 * conversation's panel, the access map) and to hand a whole box to a
 * conversation at once.
 *
 * WHAT A GROUP IS NOT: a right. The table of rights (grants.mjs, and the
 * Tether levels) stays the ONE truth of who may do what. A group is only a
 * label an asset carries. "Give the group" is a shortcut that gives each of
 * its assets, one by one, each at a sensible default for its own type -- it
 * is never a line of its own in the rights table, and there is no
 * inheritance. So a group may hold assets of mixed types, and taking a right
 * back is still done on the one asset.
 *
 * THE MODEL IS A FOLDER: an asset sits in AT MOST ONE group; placing it in a
 * group takes it out of any other. Assets with no group ("loose") and
 * grouped assets live side by side. A group emptied of its assets is still a
 * group until it is removed.
 *
 * A MEMBER is an asset id, the same string the rest of the server uses:
 * "folder:reports", "git:site", "mailbox:news", "secret:MODEL_KEY",
 * "connexion:<id>". This store does not police what an id points at (assets
 * come and go, and a Tether connexion is not in grants.mjs), so it keeps ids
 * as given; a view resolves them against the assets that exist and ignores
 * the rest. `forget(asset)` drops a member whose asset is gone.
 */
import { randomBytes } from 'node:crypto';
import { Refusal } from './conversations.mjs';
import { titleProblem } from './names.mjs';

export const LABEL_MAX = 40;
/* An id a browser cannot forge into something else: short, random, lower. */
const ID = /^[0-9a-f]{12}$/;
/* A member is "<type>:<name>" -- a type of a few lower letters, then a name
   with no space or control character. Kept loose on purpose (see above). */
const MEMBER = /^[a-z]{2,16}:[^\s\u0000-\u001f]{1,64}$/;

export function labelProblem(value) {
    const problem = titleProblem(value);
    if (problem) return problem.replace('A name', 'A group name').replace('Give a name.', 'Give the group a name.');
    if ([...value].length > LABEL_MAX) return `A group name is ${LABEL_MAX} characters at most.`;
    return '';
}

export const isMember = (asset) => typeof asset === 'string' && MEMBER.test(asset);

export class Groups {
    #store;

    constructor({ store }) { this.#store = store; }

    /* [{ id, label, members: [asset...] }], in the order they were made. */
    list() {
        return this.#store.all().map((g) => ({ id: g.name, label: g.label, members: [...(g.members ?? [])] }));
    }

    /* The group an asset is in, or null. */
    groupOf(asset) {
        const g = this.#store.all().find((x) => (x.members ?? []).includes(asset));
        return g ? g.name : null;
    }

    /* A new, empty group. */
    create(label) {
        const problem = labelProblem(label);
        if (problem) throw new Refusal(400, problem);
        let id; do { id = randomBytes(6).toString('hex'); } while (this.#store.get(id));
        this.#store.put({ name: id, label, members: [] });
        return { id, label, members: [] };
    }

    rename(id, label) {
        const group = this.#require(id);
        const problem = labelProblem(label);
        if (problem) throw new Refusal(400, problem);
        this.#store.put({ ...group, label });
        return { id, label, members: [...(group.members ?? [])] };
    }

    remove(id) {
        this.#require(id);
        this.#store.remove(id);
    }

    /* Put an asset in a group, or take it out (group null). A folder move:
       the asset leaves whatever other group it was in. */
    place(asset, group) {
        if (!isMember(asset)) throw new Refusal(400, 'Not an asset: a type and a name, such as "folder:reports".');
        if (group !== null && group !== undefined) this.#require(group);
        for (const g of this.#store.all()) {
            const has = (g.members ?? []).includes(asset);
            if (g.name === group) { if (!has) this.#store.put({ ...g, members: [...(g.members ?? []), asset] }); }
            else if (has) this.#store.put({ ...g, members: (g.members ?? []).filter((a) => a !== asset) });
        }
        return { asset, group: group ?? null };
    }

    /* Drop a member everywhere its asset appears (the asset was removed). */
    forget(asset) {
        for (const g of this.#store.all()) {
            if ((g.members ?? []).includes(asset)) this.#store.put({ ...g, members: (g.members ?? []).filter((a) => a !== asset) });
        }
    }

    /* An asset renamed keeps its place under its new id. */
    renamed(from, to) {
        for (const g of this.#store.all()) {
            if ((g.members ?? []).includes(from)) this.#store.put({ ...g, members: (g.members ?? []).map((a) => (a === from ? to : a)).filter((a, i, all) => all.indexOf(a) === i) });
        }
    }

    #require(id) {
        if (typeof id !== 'string' || !ID.test(id)) throw new Refusal(400, 'Not a group.');
        const group = this.#store.get(id);
        if (!group) throw new Refusal(404, 'No such group.');
        return group;
    }
}
