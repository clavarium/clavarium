/* LINKS A SHARED FOLDER CANNOT SERVE, found on the server and, where it is
 * safe, taken out.
 *
 * WHY. A folder is shown in a machine by the VM manager's own file server
 * (multipass: sshfs in the machine, its SFTP server on this host). That
 * server, not the machine, decides; root in the machine counts for nothing.
 * It judges a link BY ITS TARGET: the target must lie in the folder and
 * belong to the account the folder is mapped from (`-u`/`-g` of the mount).
 * A link whose target is missing, loops, or lies elsewhere on this host has
 * no such owner: reading it, renaming it and often removing it are refused
 * ("Permission denied"), and what it says of it is nonsense ("Value too
 * large"). Seen 07-11: app/node_modules made a link by a worktree, then
 * committed, in a read-write folder its machine could not repair.
 *
 * WHAT IS DONE, here, where the folder is plain files:
 *   - a link named node_modules that the share cannot serve: removed (the
 *     link, never what it points to); its tool is told it may install its
 *     dependencies again;
 *   - a link that loops, or points nowhere outside the folder: removed;
 *   - any other (an absolute target, one outside the folder, one inside it
 *     not there yet): said, and left.
 *
 * BOUNDED: a few levels deep, so many entries, so long; .git and real
 * node_modules folders are not walked. A folder looked at recently is not
 * looked at again unless asked (`force`).
 */
import { opendir, lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CAPS = Object.freeze({ depth: 6, entries: 20_000, ms: 2_000, links: 50 });
/* A folder is looked at again by the clock this often at most. */
export const EVERY_MS = 10 * 60_000;
/* A removal is said to a conversation once a day at most, should the link come back. */
export const SAY_AGAIN_MS = 24 * 60 * 60_000;
const NOT_WALKED = new Set(['.git', 'node_modules']);
export const KINDS = ['loop', 'dangling', 'absolute', 'outside'];

const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);

/* What is wrong with the link at `full` (under the real path `root`), or null. */
export async function judgeLink(root, full) {
    let target;
    try { target = await readlink(full); } catch { return null; }
    let real;
    try { real = await realpath(full); } catch (error) {
        if (error.code === 'ELOOP') return { kind: 'loop', target };
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            /* Where it would point, as written: outside the folder, it points nowhere the share serves. */
            const aim = isAbsolute(target) ? target : resolve(dirname(full), target);
            return { kind: 'dangling', target, escapes: isAbsolute(target) || !inside(root, aim) };
        }
        return { kind: 'outside', target };
    }
    /* An absolute target is a path of THIS host: in the machine it names something else, or nothing. */
    if (isAbsolute(target)) return { kind: 'absolute', target };
    if (!inside(root, real)) return { kind: 'outside', target };
    return null;
}

/* Taken out without asking: a node_modules link, a loop, a link to nowhere outside the folder. */
export function removable(link) {
    const base = link.path.split('/').pop();
    return base === 'node_modules' || link.kind === 'loop' || (link.kind === 'dangling' && link.escapes === true);
}

/* The links of one folder the share cannot serve: { links: [{ path, kind, target }], cut }.
   `cut`: why the look stopped early ('depth', 'entries', 'time', 'links'), or null. */
export async function scanFolder(folder, caps = CAPS, now = () => Date.now()) {
    const root = await realpath(folder);
    const until = now() + caps.ms;
    const links = []; let entries = 0; let cut = null; let deeper = false;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && !cut) {
        const { dir, depth } = stack.pop();
        let handle;
        /* A folder swapped for a link since it was listed is not followed out. */
        try { if (dir !== root && (await realpath(dir)) !== dir) continue; handle = await opendir(dir); } catch { continue; }
        try {
            for (let entry = await handle.read(); entry !== null; entry = await handle.read()) {
                if (++entries > caps.entries) { cut = 'entries'; break; }
                if (now() > until) { cut = 'time'; break; }
                const full = join(dir, entry.name);
                if (entry.isSymbolicLink()) {
                    const wrong = await judgeLink(root, full);
                    if (!wrong) continue;
                    if (links.length >= caps.links) { cut = 'links'; break; }
                    links.push({ path: relative(root, full).split(sep).join('/'), ...wrong });
                } else if (entry.isDirectory() && !NOT_WALKED.has(entry.name)) {
                    if (depth + 1 < caps.depth) stack.push({ dir: full, depth: depth + 1 });
                    else deeper = true;
                }
            }
        } finally { await handle.close().catch(() => {}); }
    }
    return { links, cut: cut ?? (deeper ? 'depth' : null) };
}

/* Removes the link `path` of `folder`: '' when done, or why not. Only a link,
   and only where its folder is still the one walked (a folder on the way
   swapped for a link meanwhile is not followed). */
export async function removeLink(folder, path) {
    const root = await realpath(folder);
    const full = join(root, ...path.split('/'));
    if (!inside(root, full) || full === root) return 'not in the folder';
    try {
        if ((await realpath(dirname(full))) !== dirname(full)) return 'its folder moved';
        if (!(await lstat(full)).isSymbolicLink()) return 'not a link any more';
        await unlink(full);
        return '';
    } catch (error) { return error.code === 'ENOENT' ? 'already gone' : error.message; }
}

/* THE GUARD, for each conversation's attached folders.
     `resources`: of(conversation) [{ name }], folder(name), attachedTo(name) [conversation]
     `removed(conversation, { folder, path, kind, target })`: told once per removal, to each
     conversation the folder is attached to (its chat, its tool: main.mjs). */
export class LinkGuard {
    #resources; #caps; #everyMs; #now; #last = new Map(); #going = new Map(); #said = new Map();
    removed = () => {};
    constructor({ resources, caps = CAPS, everyMs = EVERY_MS, now = () => Date.now() }) {
        this.#resources = resources; this.#caps = caps; this.#everyMs = everyMs; this.#now = now;
    }

    /* Looks at the folders of `conversation`: { found, removed, cut }, each with its folder's name. */
    async check(conversation, { force = false } = {}) {
        const out = { found: [], removed: [], cut: [] };
        for (const { name } of this.#resources.of(conversation)) {
            /* A mailbox is written by this server alone. */
            if (this.#resources.get?.(name)?.type === 'mailbox') continue;
            const r = await this.#folder(name, force).catch(() => null);
            if (!r) continue;
            out.found.push(...r.found.map((l) => ({ folder: name, ...l })));
            out.removed.push(...r.removed.map((l) => ({ folder: name, ...l })));
            if (r.cut) out.cut.push({ folder: name, why: r.cut });
        }
        return out;
    }

    /* One folder, one look at a time (two conversations may share it). */
    #folder(name, force) {
        const last = this.#last.get(name);
        if (!force && last && this.#now() - last.at < this.#everyMs) return Promise.resolve({ ...last.result, removed: [] });
        const going = this.#going.get(name);
        if (going) return going;
        const look = this.#look(name).finally(() => this.#going.delete(name));
        this.#going.set(name, look);
        return look;
    }

    async #look(name) {
        const folder = this.#resources.folder(name);
        const { links, cut } = await scanFolder(folder, this.#caps, this.#now);
        const found = []; const removed = [];
        for (const link of links) {
            if (removable(link) && (await removeLink(folder, link.path)) === '') removed.push(link);
            else found.push(link);
        }
        const result = { found, removed, cut };
        this.#last.set(name, { at: this.#now(), result: { found, removed: [], cut } });
        for (const link of removed) this.#tell(name, link);
        return result;
    }

    #tell(name, link) {
        const conversations = this.#resources.attachedTo?.(name) ?? [];
        for (const conversation of conversations) {
            const key = `${conversation}\0${name}\0${link.path}`;
            if (this.#now() - (this.#said.get(key) ?? -Infinity) < SAY_AGAIN_MS) continue;
            this.#said.set(key, this.#now());
            try { this.removed(conversation, { folder: name, ...link }); } catch { /* told, nothing more */ }
        }
    }

    forget(name) { this.#last.delete(name); }
}

/* What it says, in French, in the conversation's chat (one line). */
export function removedLine({ folder, path }) {
    const where = path.includes('/') ? ` (${path})` : '';
    return path.split('/').pop() === 'node_modules'
        ? `Un lien node_modules cassé dans ${folder}${where} a été retiré ; ses dépendances sont à réinstaller.`
        : `Un lien cassé dans ${folder} (${path}) a été retiré : il ne menait nulle part.`;
}
/* What its tool is told, when the link was a node_modules (in English, as its other lines). */
export function toolLine({ folder, path }) {
    const dir = path.split('/').slice(0, -1).join('/');
    const at = `/resources/${folder}${dir ? `/${dir}` : ''}`;
    return `Clavarium: ${at}/node_modules was a link your machine could not use; it was removed on the server (what it pointed to was left as it was). You may install the dependencies again now: run npm ci (or npm install) in ${at}. If your rules forbid npm install, ask the operator to allow it.`;
}
/* Why a link is said, in a few words. */
export const WHY = Object.freeze({ loop: 'it loops', dangling: 'its target is missing', absolute: 'its target is an absolute path of the server', outside: 'its target is outside the folder' });
