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
 * So a read attachment mounts the VIEW, never the folder itself. If the view
 * is not in place, what gets mounted is an empty directory: the failure is an
 * empty folder in the VM, never a writable one.
 */
import { mkdirSync } from 'node:fs';
import { isConversationName } from './names.mjs';
import { Refusal } from './conversations.mjs';
import { RESOURCES } from './vm.mjs';

export const ACCESS = ['read', 'write'];
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Resources {
    #store; #vms; #host; #root; #uid; #gid;

    /* `host(argv)` runs a privileged command on the host (the view needs it). */
    constructor({ store, vms, host, dataDir, uid = process.getuid(), gid = process.getgid() }) {
        this.#store = store; this.#vms = vms; this.#host = host; this.#root = dataDir; this.#uid = uid; this.#gid = gid;
    }

    folder(name) { return `${this.#root}/resources/${name}`; }
    view(name) { return `${this.#root}/views/${name}`; }

    list() { return this.#store.all(); }

    /* What one conversation has attached: [{ name, access }]. */
    of(conversation) {
        return this.#store.all().filter((r) => r.attachments?.[conversation])
            .map((r) => ({ name: r.name, access: r.attachments[conversation] }));
    }

    create({ name }) {
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens, and starts with a letter.');
        if (this.#store.get(name)) throw new Refusal(409, 'A resource already has this name.');
        mkdirSync(this.folder(name), { recursive: true });
        const resource = { name, type: 'folder', attachments: {}, createdAt: new Date().toISOString() };
        this.#store.put(resource);
        return resource;
    }

    /* The read-only view of a folder, made if it is not already there. */
    async ensureView(name) {
        const view = this.view(name);
        mkdirSync(view, { recursive: true });
        if ((await this.#host(['mountpoint', '-q', view])).code === 0) return;
        const r = await this.#host(['bindfs', '-r', '-o', 'allow_other', this.folder(name), view]);
        if (r.code !== 0) throw new Refusal(502, `The read-only view could not be made: ${firstLine(r.stderr)}`);
    }

    /* After a restart of the host the views are gone: they are put back before
       any VM is started, so a read attachment never meets a bare directory. */
    async ensureViews() {
        for (const r of this.#store.all()) {
            if (Object.values(r.attachments ?? {}).includes('read')) await this.ensureView(r.name);
        }
    }

    /* access: 'read', 'write', or 'none' to detach. */
    async attach(conversation, name, access) {
        const resource = this.#store.get(name);
        if (!resource) throw new Refusal(404, 'No such resource.');
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        if (access !== 'none' && !ACCESS.includes(access)) throw new Refusal(400, 'Access is "read", "write" or "none".');
        const target = `${RESOURCES}/${name}`;
        const before = resource.attachments[conversation];
        if (before === access || (before === undefined && access === 'none')) return;
        if (before !== undefined) {
            const r = await this.#vms.umount(conversation, target);
            if (r.code !== 0) throw new Refusal(502, `The folder could not be detached: ${firstLine(r.stderr)}`);
            delete resource.attachments[conversation];
            this.#store.put(resource);
        }
        if (access === 'none') return;
        if (access === 'read') await this.ensureView(name);
        const source = access === 'read' ? this.view(name) : this.folder(name);
        const r = await this.#vms.mount(conversation, source, target, this.#uid, this.#gid);
        if (r.code !== 0) throw new Refusal(502, `The folder could not be attached: ${firstLine(r.stderr)}`);
        resource.attachments[conversation] = access;
        this.#store.put(resource);
    }

    /* A conversation was archived: its VM is gone, and its attachments with it. */
    forget(conversation) {
        for (const r of this.#store.all()) {
            if (r.attachments?.[conversation]) { delete r.attachments[conversation]; this.#store.put(r); }
        }
    }
}
