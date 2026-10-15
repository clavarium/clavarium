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
import { execFile } from 'node:child_process';
import { Refusal } from './conversations.mjs';
import { Grants, conversationSubject } from './grants.mjs';
import { readAddress, explain } from './gitaccess.mjs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ACCESS = ['read', 'write'];
export const TYPES = ['folder', 'mailbox', 'git'];

/* Runs git as this server's own account: `git(argv, cwd, env)` -> { code, stderr }.
   `env` carries what opens a private remote (see gitaccess.mjs): never argv. */
const runGit = (argv, cwd, env = {}) => new Promise((resolve) => {
    execFile('git', argv, { cwd, timeout: 600_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent', LC_ALL: 'C', ...env } },
        (error, _stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr ?? '') }));
});
/* THE ORIGIN OF A REPOSITORY, KEPT UP TO DATE, IN REACH OF THE TOOL.
 *
 * A tool works in its repository and would like to see what others pushed
 * to its origin. It cannot fetch from the origin itself: what opens the
 * origin (a key, a token) is kept on this server and never enters a machine.
 * So the SERVER fetches the origin, with that key, into a bare repository of
 * its own -- a mirror -- and the mirror is shown in the machine READ-ONLY,
 * next to the repository: /resources/<name>-origin. The tool then runs, in
 * its own repository, in its own machine:
 *
 *     git fetch /resources/<name>-origin '+refs/heads/*:refs/remotes/origin/*'
 *
 * and has the origin's branches, with no key and no network. Git is never
 * run here in the tool's repository: only in the mirror, which nothing but
 * this server writes.
 *
 * WHY THIS SHAPE: it is how every folder is already shown in a machine. The
 * mirror is a folder of resources/, made by the host program like any other
 * (so it cannot be swapped for a link), and it is mounted through its
 * read-only view (bindfs -r), the one way a read-only folder is proven to
 * hold against root in the machine. Nothing new is asked of the host
 * program. The mirror is not a resource of the list: it cannot be attached
 * on its own, written, shared or removed from the page; it follows its
 * repository (shown wherever the repository is attached, put aside with it). */
export const ORIGIN_SUFFIX = '-origin';
/* The mirror's folder name: "<name>-origin" when that is a valid name (32
   characters at most); a longer one is shortened, with a part of a hash so
   that two long names do not meet. */
export function originFolder(name) {
    const plain = `${name}${ORIGIN_SUFFIX}`;
    if (plain.length <= 32) return plain;
    const hash = createHash('sha256').update(String(name)).digest('hex').slice(0, 6);
    return `${String(name).slice(0, 18).replace(/-+$/, '')}-${hash}${ORIGIN_SUFFIX}`;
}

/* How the page names a conversation's own work folder, next to its attached folders. */
export const WORK_TAB = 'work';
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Resources {
    #store; #vms; #host; #mnt; #uid; #gid; #grants; #git; #access;
    /* ONE LOCK PER (conversation, resource). Attaching, repairing and
       mounting again all unmount and mount the same place in the same
       machine; interleaved, a repair that read "write" before an owner
       switched to read would mount the folder itself after the view. So
       they take turns, and whoever mounts reads the access under the lock. */
    #locks = new Map();
    #locked(conversation, name, work) {
        const key = `${conversation}\0${name}`;
        const before = this.#locks.get(key) ?? Promise.resolve();
        const run = before.then(work, work);
        const tail = run.then(() => {}, () => {});
        this.#locks.set(key, tail);
        tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
        return run;
    }

    /* `host(argv)` reaches the host program (making a view needs root). */
    /* `grants`: the one table of rights. "Attached, read" is a line of it:
       the conversation may read the folder. */
    /* `access`: how private repositories are reached (gitaccess.mjs). Without
       it, only a public https address can be cloned. */
    /* `mntDir`: where the folders, their read-only views and the work
       folders live ($MNT of the host program: a chain of directories root
       owns, see deploy/clavarium-host). The data directory when not given
       (development, tests). */
    constructor({ store, vms, host, dataDir, mntDir = dataDir, uid = process.getuid(), gid = process.getgid(), grants = new Grants(), git = runGit, access = null }) {
        this.#store = store; this.#vms = vms; this.#host = host; this.#mnt = mntDir; this.#uid = uid; this.#gid = gid; this.#grants = grants; this.#git = git; this.#access = access;
        /* What an earlier version kept inside each folder's own record is
           taken over into the table, once. */
        for (const r of store.all()) {
            if (r.attachments === undefined) continue;
            for (const [conversation, access] of Object.entries(r.attachments)) this.#grants.give(conversationSubject(conversation), this.assetOf(r), access === 'write' ? 'rw' : 'r');
            delete r.attachments; store.put(r);
        }
    }

    folder(name) { return `${this.#mnt}/resources/${name}`; }
    view(name) { return `${this.#mnt}/views/${name}`; }
    /* Where the tool of a conversation works, when that is kept here. */
    workFolder(conversation) {
        if (!isConversationName(conversation)) throw new Refusal(400, 'Not a conversation.');
        return `${this.#mnt}/work/${conversation}`;
    }

    /* How the table of rights names one of these. */
    assetOf(resource) { return `${resource.type === 'mailbox' || resource.type === 'git' ? resource.type : 'folder'}:${resource.name}`; }
    #attachments(resource) {
        const map = {};
        for (const g of this.#grants.on(this.assetOf(resource))) if (g.subject.startsWith('conversation:')) map[g.subject.slice('conversation:'.length)] = g.rights.includes('w') ? 'write' : 'read';
        return map;
    }

    /* Each with where it is attached, as the page shows it -- and, for a
       repository, how it is reached (never the secret that opens it). */
    list() {
        return this.#store.all().map((r) => ({ ...r, attachments: this.#attachments(r), ...(r.type === 'git' && this.#access ? { via: this.#access.describe(r.name, r.from) } : {}) }));
    }
    get(name) { return this.#store.get(name); }

    /* What one conversation has attached: [{ name, access }]. */
    of(conversation) {
        return this.#store.all().map((r) => ({ name: r.name, access: this.#attachments(r)[conversation] })).filter((r) => r.access !== undefined);
    }

    /* The folder is MADE BY THE HOST PROGRAM, in a directory that belongs to
       root: this server fills its folders but cannot replace one by a link
       to somewhere else, which is what would otherwise get mounted. */
    /* A GIT REPOSITORY is a folder that starts as one: made empty (git init)
       or cloned from a remote: a public https address, or a private one
       reached over ssh or https with what `via` says (gitaccess.mjs), used
       here and kept here. It is then attached and shared like any folder --
       read, or read and write.
       GIT IS RUN HERE ONCE, in a folder nobody else has touched yet, and
       never again: a repository that a tool can write in could make git run
       what it likes (hooks, filters). Its history is the tool's business, in
       its own machine. */
    async create({ name, type = 'folder', from, via }) {
        if (!TYPES.includes(type)) throw new Refusal(400, 'A resource is a folder, a mailbox or a git repository.');
        const address = type === 'git' ? readAddress(from) : undefined;
        /* Everything is checked before anything is made. */
        const credential = this.#access ? this.#access.prepare(address, via) : undefined;
        if (!this.#access && address && (address.transport !== 'https' || (via?.method && via.method !== 'none'))) throw new Refusal(400, 'Only a public https address can be cloned on this server.');
        const origin = address?.url;
        if (!isConversationName(name)) throw new Refusal(400, 'A name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        if (name === WORK_TAB) throw new Refusal(409, 'This name is taken: "work" is where each conversation works.');
        if (name.endsWith(ORIGIN_SUFFIX)) throw new Refusal(409, `A name that ends with "${ORIGIN_SUFFIX}" is kept for the origin of a repository.`);
        if (this.#store.get(name)) throw new Refusal(409, 'A resource already has this name.');
        const made = await this.#host(['folder', 'make', name]);
        if (made.code !== 0) throw new Refusal(502, `The folder could not be made: ${firstLine(made.stderr)}`);
        let firstSeen = [];
        if (type === 'git') {
            const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never'];
            const clone = (env) => this.#git([...options, 'clone', '--quiet', '--no-recurse-submodules', '--', origin, '.'], this.folder(name), env);
            let r;
            try {
                r = origin
                    ? (this.#access ? await this.#access.run(credential, address, clone).then((x) => { firstSeen = x.firstSeen; return x.result; }) : await clone({}))
                    : await this.#git([...options, 'init', '--quiet', '--initial-branch=main'], this.folder(name));
            } catch (error) { r = { code: 1, stderr: error.message }; }
            if (r.code !== 0) {
                await this.#host(['folder', 'aside', name]);
                throw new Refusal(502, origin ? `The repository could not be cloned: ${explain(r.stderr)}` : `The repository could not be made: ${firstLine(r.stderr)}`);
            }
        }
        if (credential) this.#access.remember(name, credential);
        const resource = { name, type, ...(origin ? { from: origin } : {}), createdAt: new Date().toISOString() };
        this.#store.put(resource);
        /* firstSeen: the host keys recorded by this very clone, to be shown once. */
        return { ...resource, attachments: {}, ...(type === 'git' && this.#access ? { via: this.#access.describe(name, origin) } : {}), ...(firstSeen.length ? { firstSeen } : {}) };
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
            if (r.type === 'git' && Object.keys(this.#attachments(r)).length > 0 && this.hasOrigin(r.name)) await this.ensureView(originFolder(r.name)).catch(() => {});
        }
    }

    /* ---- the origin of a repository: see ORIGIN at the top of this file ---- */
    originPath(name) { return this.folder(originFolder(name)); }
    /* Is the mirror there yet (made, and git init done in it)? */
    hasOrigin(name) { return existsSync(`${this.originPath(name)}/HEAD`); }
    /* Its folder, made by the host program, empty. Refused when a resource
       of the list (an earlier one) already has that name. */
    async makeOrigin(name) {
        const folder = originFolder(name);
        if (this.#store.get(folder)) throw new Refusal(409, `A folder named ${folder} is in the way of this repository's origin.`);
        if (existsSync(this.folder(folder))) return;
        const made = await this.#host(['folder', 'make', folder]);
        if (made.code !== 0) throw new Refusal(502, `The folder of the origin could not be made: ${firstLine(made.stderr)}`);
    }
    /* Shows the mirror, read-only, in one conversation's machine. A machine
       that does not run just now gets it at its next start (remount). */
    async #showOrigin(conversation, name) {
        if (!this.hasOrigin(name)) return;
        const folder = originFolder(name);
        await this.ensureView(folder);
        const r = await this.#vms.mount(conversation, 'view', folder, this.#uid, this.#gid);
        if (r.code !== 0 && !/already mounted/i.test(`${r.stderr}${r.stdout}`)) throw new Refusal(502, `The origin could not be shown: ${firstLine(r.stderr)}`);
    }
    /* The mirror was just made: it is shown wherever its repository is attached. */
    async shareOrigin(name) {
        const resource = this.#store.get(name);
        if (resource?.type !== 'git') return;
        for (const conversation of Object.keys(this.#attachments(resource))) await this.#showOrigin(conversation, name).catch(() => {});
    }

    /* access: 'read', 'write', or 'none' to detach. */
    async attach(conversation, name, access) {
        return this.#locked(conversation, name, () => this.#attach(conversation, name, access));
    }
    async #attach(conversation, name, access) {
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
        if (access === 'none') {
            /* The origin goes with its repository. */
            if (resource.type === 'git' && this.hasOrigin(name)) await this.#vms.umount(conversation, originFolder(name)).catch(() => {});
            return;
        }
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
        /* A repository newly attached: its origin is shown next to it. Not
           shown is not a failure of the attachment: it comes at the next start. */
        if (resource.type === 'git' && before === undefined) await this.#showOrigin(conversation, name).catch(() => {});
    }

    /* The machine of a conversation was built again: what was attached to
       it is shown in the new one. A folder that cannot be shown just now
       stays in the list, and the failure is returned, not thrown: the
       conversation itself is fine. */
    async remount(conversation) {
        const failed = [];
        for (const { name } of this.of(conversation)) await this.#locked(conversation, name, async () => {
            /* Read again under the lock: it may have changed meanwhile. */
            const access = this.of(conversation).find((x) => x.name === name)?.access;
            if (access === undefined) return;
            try {
                if (access === 'read') await this.ensureView(name);
                const r = await this.#vms.mount(conversation, access === 'read' ? 'view' : 'folder', name, this.#uid, this.#gid);
                if (r.code !== 0 && !/already mounted/i.test(`${r.stderr}${r.stdout}`)) failed.push(name);
                if (this.#store.get(name)?.type === 'git') await this.#showOrigin(conversation, name).catch(() => failed.push(originFolder(name)));
            } catch { failed.push(name); }
        });
        return failed;
    }

    /* WHAT SHOULD BE MOUNTED IN A MACHINE, as paths of that machine: its
       work folder when it is kept here, each attached folder, and the
       origin of each attached repository that has one. */
    expected(conversation, workKept) {
        const paths = workKept ? ['/work'] : [];
        for (const { name } of this.of(conversation)) {
            paths.push(`/resources/${name}`);
            if (this.#store.get(name)?.type === 'git' && this.hasOrigin(name)) paths.push(`/resources/${originFolder(name)}`);
        }
        return paths;
    }

    /* ONE MOUNT THAT CAME LOOSE IS PUT BACK. The VM manager may still
       believe a folder is mounted while the link that served it is dead
       (seen: "already mounted", and nothing in the machine). So it is
       unmounted first, whatever it believes, then mounted again exactly as
       it was: the same folder or view, the same owner. Returns '' when it
       is back, or what went wrong. Only called on a machine known to run. */
    async repair(conversation, path) {
        const said = (r) => firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
        if (path === '/work') {
            await this.#vms.workUnmount(conversation);
            const made = await this.#vms.workMake(conversation);
            if (made.code !== 0) return said(made);
            const r = await this.#vms.workMount(conversation, this.#uid, this.#gid);
            return r.code === 0 ? '' : said(r);
        }
        const name = path.slice('/resources/'.length);
        const find = () => ({
            attached: this.of(conversation).find((x) => x.name === name),
            originOf: this.of(conversation).find((x) => this.#store.get(x.name)?.type === 'git' && originFolder(x.name) === name),
        });
        const first = find();
        if (!first.attached && !first.originOf) return 'it is not attached any more';
        /* The lock of the resource this place belongs to: the repository, for its origin. */
        return this.#locked(conversation, first.attached ? name : first.originOf.name, async () => {
            let { attached, originOf } = find();
            if (!attached && !originOf) return 'it is not attached any more';
            try {
                if (!attached || attached.access === 'read') await this.ensureView(name);
            } catch (error) { return error.message; }
            await this.#vms.umount(conversation, name);
            /* The access is read again just before mounting: never mount with a stale one. */
            ({ attached, originOf } = find());
            if (!attached && !originOf) return 'it is not attached any more';
            if (attached?.access === 'read') {
                try { await this.ensureView(name); } catch (error) { return error.message; }
            }
            const r = await this.#vms.mount(conversation, attached?.access === 'write' ? 'folder' : 'view', name, this.#uid, this.#gid);
            return r.code === 0 ? '' : said(r);
        });
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
        /* Its origin, if one was kept, is put aside with it. */
        if (resource.type === 'git' && existsSync(this.originPath(name))) {
            await this.#host(['view', 'close', originFolder(name)]);
            await this.#host(['folder', 'aside', originFolder(name)]);
        }
        this.#store.remove(name);
        /* Whoever else had a right on it (a device it was shared with) loses it. */
        this.#grants.forgetAsset(this.assetOf(resource));
    }

    /* A conversation was archived: its VM is gone, and its attachments with it. */
    forget(conversation) {
        for (const r of this.#store.all()) this.#grants.take(conversationSubject(conversation), this.assetOf(r));
    }
}
