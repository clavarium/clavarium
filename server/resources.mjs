/* RESOURCES: everything a conversation may see, as folders.
 *
 * A resource is a folder kept by this server. Attached to a conversation, it
 * appears in that conversation's VM under /resources/<name>, read-only or
 * read-write. The level belongs to the ATTACHMENT, so the same folder can be
 * written by one conversation and only read by another, live.
 *
 * READ-ONLY IS ENFORCED ON THE HOST, and how was settled by an experiment, not
 * by reasoning. The agent is root in its VM, so nothing set inside the VM
 * counts. And the VM manager's own mount has no read-only option. Two ways
 * were tried against a real VM, attacking as root from inside:
 *
 *   - a bind mount remounted read-only on the host: FAILED. The VM manager
 *     serves the folder from its own mount namespace, where the read-only
 *     flag did not apply. Root in the VM created a file and deleted another.
 *   - a read-only VIEW made by a userspace filesystem (bindfs -r): held.
 *     Create, delete, rename, chmod and remount were all refused, while a
 *     file added on the host appeared in the VM at once.
 *
 * So a read attachment mounts the VIEW, never the folder itself. The host
 * program refuses to mount a view that is not in place: the failure is a
 * folder that is not there, never a writable one.
 */
import { isConversationName } from './names.mjs';
import { Refusal } from './conversations.mjs';
import { Grants, conversationSubject } from './grants.mjs';

export const ACCESS = ['read', 'write'];
/* How the page names a conversation's own work folder, next to its attached folders. */
export const WORK_TAB = 'work';
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Resources {
    #store; #vms; #host; #root; #uid; #gid; #grants;

    /* `host(argv)` reaches the host program (making a view needs root). */
    /* `grants`: the one table of rights. "Attached, read" is a line of it:
       the conversation may read the folder. */
    constructor({ store, vms, host, dataDir, uid = process.getuid(), gid = process.getgid(), grants = new Grants() }) {
        this.#store = store; this.#vms = vms; this.#host = host; this.#root = dataDir; this.#uid = uid; this.#gid = gid; this.#grants = grants;
        /* What an earlier version kept inside each folder's own record is
           taken over into the table, once. */
        for (const r of store.all()) {
            if (r.attachments === undefined) continue;
            for (const [conversation, access] of Object.entries(r.attachments)) this.#grants.give(conversationSubject(conversation), this.assetOf(r), access === 'write' ? 'rw' : 'r');
            delete r.attachments; store.put(r);
        }
    }

    folder(name) { return `${this.#root}/resources/${name}`; }
    view(name) { return `${this.#root}/views/${name}`; }
    /* Where the tool of a conversation works, when that is kept here. */
    workFolder(conversation) {
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        return `${this.#root}/work/${conversation}`;
    }

    /* How the table of rights names one of these. */
    assetOf(resource) { return `${resource.type === 'mailbox' || resource.type === 'git' ? resource.type : 'folder'}:${resource.name}`; }
    #attachments(resource) {
        const map = {};
        for (const g of this.#grants.on(this.assetOf(resource))) if (g.subject.startsWith('conversation:')) map[g.subject.slice('conversation:'.length)] = g.rights.includes('w') ? 'write' : 'read';
        return map;
    }

    /* Each with where it is attached, as the page shows it. */
    list() { return this.#store.all().map((r) => ({ ...r, attachments: this.#attachments(r) })); }
    get(name) { return this.#store.get(name); }

    /* What one conversation has attached: [{ name, access }]. */
    of(conversation) {
        return this.#store.all().map((r) => ({ name: r.name, access: this.#attachments(r)[conversation] })).filter((r) => r.access !== undefined);
    }

    /* The folder is MADE BY THE HOST PROGRAM, in a directory that belongs to
       root: this server fills its folders but cannot replace one by a link
       to somewhere else, which is what would otherwise get mounted. */
    async create({ name, type = 'folder' }) {
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        if (name === WORK_TAB) throw new Refusal(409, 'This name is taken: "work" is where each conversation works.');
        if (this.#store.get(name)) throw new Refusal(409, 'A resource already has this name.');
        const made = await this.#host(['folder', 'make', name]);
        if (made.code !== 0) throw new Refusal(502, `The folder could not be made: ${firstLine(made.stderr)}`);
        const resource = { name, type, createdAt: new Date().toISOString() };
        this.#store.put(resource);
        return { ...resource, attachments: {} };
    }

    /* The read-only view of a folder, made if it is not already there. */
    async ensureView(name) {
        const r = await this.#host(['view', 'make', name]);
        if (r.code !== 0) throw new Refusal(502, `The read-only view could not be made: ${firstLine(r.stderr)}`);
    }

    /* After a restart of the host the views are gone: they are put back before
       any VM is started, so a read attachment never meets a bare directory. */
    async ensureViews() {
        for (const r of this.#store.all()) {
            if (Object.values(this.#attachments(r)).includes('read')) await this.ensureView(r.name);
        }
    }

    /* access: 'read', 'write', or 'none' to detach. */
    async attach(conversation, name, access) {
        const resource = this.#store.get(name);
        if (!resource) throw new Refusal(404, 'No such resource.');
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        if (access !== 'none' && !ACCESS.includes(access)) throw new Refusal(400, 'Access is "read", "write" or "none".');
        /* A mailbox is somebody's mail: a tool reads it, and never writes in it. */
        if (resource.type === 'mailbox' && access === 'write') throw new Refusal(400, 'A mailbox is read-only.');
        const subject = conversationSubject(conversation); const asset = this.assetOf(resource);
        const had = this.#grants.rightsOf(subject, asset);
        const before = had === '' ? undefined : had.includes('w') ? 'write' : 'read';
        if (before === access || (before === undefined && access === 'none')) return;
        if (before !== undefined) {
            const r = await this.#vms.umount(conversation, name);
            if (r.code !== 0) throw new Refusal(502, `The folder could not be detached: ${firstLine(r.stderr)}`);
            this.#grants.take(subject, asset);
        }
        if (access === 'none') return;
        if (access === 'read') await this.ensureView(name);
        const kind = access === 'read' ? 'view' : 'folder';
        let r = await this.#vms.mount(conversation, kind, name, this.#uid, this.#gid);
        /* The VM manager already has a mount there that our list does not
           know about (an earlier attempt that outlived its request): it is
           replaced rather than reported as a failure. */
        if (r.code !== 0 && /already mounted/i.test(`${r.stderr}${r.stdout}`)) {
            await this.#vms.umount(conversation, name);
            r = await this.#vms.mount(conversation, kind, name, this.#uid, this.#gid);
        }
        if (r.code !== 0) throw new Refusal(502, `The folder could not be attached: ${firstLine(r.stderr)}`);
        this.#grants.give(subject, asset, access === 'write' ? 'rw' : 'r');
    }

    /* The machine of a conversation was built again: what was attached to
       it is shown in the new one. A folder that cannot be shown just now
       stays in the list, and the failure is returned, not thrown: the
       conversation itself is fine. */
    async remount(conversation) {
        const failed = [];
        for (const { name, access } of this.of(conversation)) {
            try {
                if (access === 'read') await this.ensureView(name);
                const r = await this.#vms.mount(conversation, access === 'read' ? 'view' : 'folder', name, this.#uid, this.#gid);
                if (r.code !== 0 && !/already mounted/i.test(`${r.stderr}${r.stdout}`)) failed.push(name);
            } catch { failed.push(name); }
        }
        return failed;
    }

    /* Removes a folder from the list. Only one that is attached nowhere; and
       its content is MOVED ASIDE, not erased: deleting somebody's files is
       not something a click on a web page should be able to finish. */
    async remove(name) {
        const resource = this.#store.get(name);
        if (!resource) throw new Refusal(404, 'No such folder.');
        const used = Object.keys(this.#attachments(resource));
        if (used.length > 0) throw new Refusal(409, `This folder is still attached to: ${used.join(', ')}. Switch it Off there first.`);
        const closed = await this.#host(['view', 'close', name]);
        if (closed.code !== 0) throw new Refusal(502, `The read-only view could not be closed: ${firstLine(closed.stderr)}`);
        const aside = await this.#host(['folder', 'aside', name]);
        if (aside.code !== 0) throw new Refusal(502, `The folder could not be put aside: ${firstLine(aside.stderr)}`);
        this.#store.remove(name);
        /* Whoever else had a right on it (a device it was shared with) loses it. */
        this.#grants.forgetAsset(this.assetOf(resource));
    }

    /* A conversation was archived: its VM is gone, and its attachments with it. */
    forget(conversation) {
        for (const r of this.#store.all()) this.#grants.take(conversationSubject(conversation), this.assetOf(r));
    }
}
