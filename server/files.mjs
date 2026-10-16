/* FILES: what the Files panel may list, download and import.
 *
 * "Files" means the folders kept by this server and attached to the
 * conversation. Not the device's storage, not the rest of the VM's disk.
 *
 * WHATEVER IS IN THESE FOLDERS MAY HAVE BEEN WRITTEN BY AN AGENT, as root in
 * its VM. So nothing here trusts a name or a link:
 *   - a path is resolved for real (symbolic links followed) and must still be
 *     inside the folder, or it is refused;
 *   - symbolic links are not listed and cannot be downloaded: a link is how
 *     a folder would be made to show a file of the host;
 *   - a download is always an attachment of an opaque type: the browser
 *     saves it, it never opens it as a page of this site.
 */
import { lstat, readdir, realpath, open, rename, unlink, mkdir, rm } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';
import { Refusal } from './conversations.mjs';

export const IMPORT_MAX = 50 * 1024 * 1024;
export const LIST_MAX = 500;
const NAME_MAX = 120;

/* A file name somebody imports: one path segment, visible, printable. */
export function isFileName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) return false;
    if (name.startsWith('.') || name.includes('/') || name.includes('\\')) return false;
    return ![...name].some((c) => { const p = c.codePointAt(0); return p < 0x20 || (p >= 0x7f && p < 0xa0); });
}

/* The real path of `relative` under `root`, or a refusal. */
export async function inside(root, relative) {
    const base = await realpath(root);
    let real;
    try { real = await realpath(join(base, String(relative ?? ''))); }
    catch { throw new Refusal(404, 'No such file or folder.'); }
    if (real !== base && !real.startsWith(base + sep)) throw new Refusal(403, 'This path leaves the folder.');
    return { base, real, relative: real === base ? '' : real.slice(base.length + 1) };
}

export async function list(root, relative) {
    const { real, relative: clean } = await inside(root, relative);
    if (!(await lstat(real)).isDirectory()) throw new Refusal(400, 'Not a folder.');
    const entries = [];
    for (const name of (await readdir(real)).sort((a, b) => a.localeCompare(b))) {
        if (name.startsWith('.')) continue;
        const info = await lstat(join(real, name)).catch(() => undefined);
        if (!info || info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) continue;
        entries.push({ name, folder: info.isDirectory(), size: info.isFile() ? info.size : 0, modified: info.mtime.toISOString() });
        if (entries.length >= LIST_MAX) break;
    }
    /* Folders first, each group by name. */
    entries.sort((a, b) => Number(b.folder) - Number(a.folder));
    return { path: clean, entries };
}

/* A readable stream of one regular file, with its name and size. */
export async function download(root, relative) {
    const { base, real } = await inside(root, relative);
    const info = await lstat(real);
    /* `inside` followed links: comparing with the unresolved path catches a
       link as the LAST segment, which realpath would have silently crossed. */
    const asked = join(base, String(relative ?? ''));
    if (!info.isFile() || (await lstat(asked)).isSymbolicLink()) throw new Refusal(400, 'Not a file that can be downloaded.');
    return { name: real.split(sep).pop(), size: info.size, stream: createReadStream(real) };
}

/* A PAGE WRITTEN BY A TOOL, SHOWN AS A PAGE -- in a box it cannot leave.
 *
 * A tool can hand over its work as an HTML page: that is how somebody who
 * does not read a terminal sees a result. But such a page is written by the
 * tool, perhaps from what strangers wrote. So it is never a page OF THIS
 * SITE. The answer carries its own rules, which the browser enforces:
 *
 *   - "sandbox" without same-origin: the page is nobody. It has no cookie,
 *     no storage, no session of the owner, and cannot ask this server for
 *     anything in the owner's name;
 *   - no network at all: it can load nothing and send nothing -- no script,
 *     style, picture or font from anywhere but itself (written in the page,
 *     or as data:);
 *   - no form goes anywhere; it can only be shown inside this site's own
 *     window.
 *
 * So only a self-contained page works, and that is the point.
 * WHAT THIS DOES NOT CLOSE: a page can still send the reader's browser to
 * another address (a link, a redirect), and an address can carry data out.
 * A tool with a network can do that by itself anyway; one whose network was
 * cut could use this as a way out. So a conversation that is OFFLINE has its
 * pages shown as text, never run: see the routes.
 */
export const PAGE_MAX = 5 * 1024 * 1024;
export const PAGE_HEADERS = Object.freeze({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
});
export async function page(root, relative) {
    const file = await download(root, relative);
    file.stream.on('error', () => {});
    if (!/\.html?$/i.test(file.name)) { file.stream.destroy(); throw new Refusal(400, 'Only an HTML file is shown as a page.'); }
    if (file.size > PAGE_MAX) { file.stream.destroy(); throw new Refusal(413, 'This page is too large to be shown here. Download it.'); }
    return file;
}

/* Writes an imported file under `relative` (a folder). By default it never
   overwrites: a taken name becomes "name (2).ext". Returns the name it was given.
   `exists`: 'keep' (both kept, the default), 'replace' (a FILE of that name
   is replaced; a folder never is), 'skip' (nothing written).
   `dir`: subfolders under `relative` to make first (a folder dropped whole).
   `batch`: an id the page gives one drop, bounded as a whole (see BATCH_MAX). */
export async function importFile(root, relative, name, request, { exists = 'keep', dir = '', batch } = {}) {
    if (!isFileName(name)) throw new Refusal(400, 'A file name has no slash, does not start with a dot, and is at most 120 characters.');
    if (!['keep', 'replace', 'skip'].includes(exists)) throw new Refusal(400, 'A name already taken is kept beside, replaced or skipped.');
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > IMPORT_MAX) throw new Refusal(413, `A file is at most ${IMPORT_MAX / 1024 / 1024} MB.`);
    const spent = counted(batch, Number.isFinite(declared) ? declared : 0);
    const { base, path: folderPath } = await made(root, relative, dir);
    const taken = await lstat(join(folderPath, name)).catch(() => undefined);
    if (taken && exists === 'skip') { request.resume(); return { name, size: 0, skipped: true }; }
    if (taken && exists === 'replace' && !taken.isFile()) throw new Refusal(409, `"${name}" is a folder here: it is not replaced by a file.`);
    const partial = join(folderPath, `.${name}.${randomBytes(4).toString('hex')}.importing`);
    const file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    let size = 0;
    try {
        for await (const chunk of request) {
            size += chunk.length;
            if (size > IMPORT_MAX) throw new Refusal(413, `A file is at most ${IMPORT_MAX / 1024 / 1024} MB.`);
            spent.add(chunk.length);
            await file.write(chunk);
        }
    } catch (error) {
        await file.close(); await unlink(partial).catch(() => {});
        throw error;
    }
    await file.close();
    try {
        await still(base, folderPath);
        let final = name;
        if (exists !== 'replace' || (taken && !taken.isFile())) {
            const dot = name.lastIndexOf('.');
            const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
            for (let i = 2; await lstat(join(folderPath, final)).then(() => true, () => false); i++) final = `${stem} (${i})${ext}`;
        } else if ((await lstat(join(folderPath, name)).catch(() => undefined))?.isDirectory()) throw new Refusal(409, `"${name}" is a folder here: it is not replaced by a file.`);
        await rename(partial, join(folderPath, final));
        return { name: final, size, ...(taken && exists === 'replace' && final === name ? { replaced: true } : {}) };
    } catch (error) { await unlink(partial).catch(() => {}); throw error; }
}

/* ---------- CHANGES MADE BY HAND in a folder: make, rename, move, remove, edit ----------
 *
 * Everything below takes a path the page sends, in a folder an agent may
 * have filled with traps. So a path is never resolved by the system: it is
 * WALKED, one name at a time, and each name is looked at (lstat) before the
 * next is taken. A link anywhere on the way is refused, a ".." or a hidden
 * name cannot even be written, and the walk starts at the real folder. The
 * moment before a change, the folder it happens in is checked again: still
 * itself, not a link put there meanwhile.
 */
export const EDIT_MAX = 1024 * 1024;
export const THUMB_MAX = 8 * 1024 * 1024;
/* One drop of files or of a folder: as a whole, this many bytes and files at most. */
export const BATCH_MAX = 2 * 1024 * 1024 * 1024;
export const BATCH_FILES = 2000;
/* How deep a dropped folder goes, below where it is dropped. */
export const DEPTH_MAX = 16;
const SEGMENT_MAX = 255;

/* A name already there (written by anyone): one segment, not hidden. */
const isSegment = (name) => typeof name === 'string' && name.length > 0 && name.length <= SEGMENT_MAX && !name.startsWith('.') && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
function segments(relative) {
    const text = String(relative ?? '');
    if (text === '') return [];
    const parts = text.split('/');
    if (parts.length > 64 || parts.some((p) => !isSegment(p))) throw new Refusal(403, 'This path leaves the folder, or names something hidden.');
    return parts;
}

/* `relative` walked from the folder: { base, path, parent, name, info } --
   `info` undefined when the last name is not there (yet). */
export async function walk(root, relative) {
    const base = await realpath(root);
    const parts = segments(relative);
    let here = base;
    for (const [i, part] of parts.entries()) {
        const next = join(here, part);
        const info = await lstat(next).catch(() => undefined);
        const last = i === parts.length - 1;
        if (info?.isSymbolicLink()) throw new Refusal(403, 'This path goes through a link: refused.');
        if (last) return { base, path: next, parent: here, name: part, info };
        if (!info) throw new Refusal(404, 'No such file or folder.');
        if (!info.isDirectory()) throw new Refusal(400, 'Not a folder.');
        here = next;
    }
    return { base, path: base, parent: undefined, name: '', info: await lstat(base) };
}
/* Just before a change: the folder it happens in is still itself. */
async function still(base, folder) {
    const real = await realpath(folder).catch(() => '');
    if (real !== folder || (real !== base && !real.startsWith(base + sep))) throw new Refusal(409, 'The folder changed while this was done: nothing was changed.');
}
async function folderAt(root, relative) {
    const at = await walk(root, relative);
    if (!at.info) throw new Refusal(404, 'No such folder.');
    if (!at.info.isDirectory()) throw new Refusal(400, 'Not a folder.');
    return at;
}
/* An existing file or folder, never the folder itself. */
async function thingAt(root, relative) {
    const at = await walk(root, relative);
    if (at.name === '') throw new Refusal(400, 'The folder itself is not changed here.');
    if (!at.info) throw new Refusal(404, 'No such file or folder.');
    if (!at.info.isFile() && !at.info.isDirectory()) throw new Refusal(400, 'Only a file or a folder is changed here.');
    return at;
}
const fileNameRule = 'A name has no slash, does not start with a dot, and is at most 120 characters.';

/* The folder `relative`, with `dir` (subfolders, made when missing) under it. */
async function made(root, relative, dir) {
    const at = await folderAt(root, relative);
    const parts = dir ? String(dir).split('/') : [];
    if (parts.length > DEPTH_MAX) throw new Refusal(413, `A folder dropped here goes ${DEPTH_MAX} levels deep at most.`);
    if (parts.some((p) => !isFileName(p))) throw new Refusal(400, fileNameRule);
    let here = at.path;
    for (const part of parts) {
        const next = join(here, part);
        const info = await lstat(next).catch(() => undefined);
        if (info?.isSymbolicLink()) throw new Refusal(403, 'This path goes through a link: refused.');
        if (info && !info.isDirectory()) throw new Refusal(409, `"${part}" is a file here: the folder of that name cannot be made.`);
        if (!info) { await still(at.base, here); await mkdir(next, 0o755).catch((e) => { if (e.code !== 'EEXIST') throw e; }); }
        here = next;
    }
    await still(at.base, here);
    return { base: at.base, path: here };
}

/* The bytes and files of one drop, counted on this server. */
const batches = new Map();
function counted(id, declared) {
    const none = { add() {} };
    if (id === undefined || id === null || id === '') return none;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id))) throw new Refusal(400, 'Not a valid drop.');
    const now = Date.now();
    for (const [k, v] of batches) if (now - v.at > 3600_000) batches.delete(k);
    const b = batches.get(id) ?? { bytes: 0, files: 0, at: now };
    if (b.files + 1 > BATCH_FILES) throw new Refusal(413, `One drop is ${BATCH_FILES} files at most.`);
    if (b.bytes + declared > BATCH_MAX) throw new Refusal(413, `One drop is ${BATCH_MAX / 1024 / 1024 / 1024} GB at most.`);
    b.files += 1; b.at = now; batches.set(id, b);
    return { add(n) { b.bytes += n; if (b.bytes > BATCH_MAX) throw new Refusal(413, `One drop is ${BATCH_MAX / 1024 / 1024 / 1024} GB at most.`); } };
}

/* Which of `names` (paths under `relative`, as a drop would write them) are already taken. */
export async function taken(root, relative, names) {
    if (!Array.isArray(names) || names.length > BATCH_FILES) throw new Refusal(413, `One drop is ${BATCH_FILES} files at most.`);
    const at = await folderAt(root, relative);
    const out = [];
    for (const name of names) {
        const parts = String(name).split('/');
        if (parts.length > DEPTH_MAX + 1 || parts.some((p) => !isFileName(p))) continue;
        let here = at.path; let found;
        for (const [i, part] of parts.entries()) {
            const info = await lstat(join(here, part)).catch(() => undefined);
            if (!info) break;
            /* A file (or a link) where a folder of the drop goes: that name is taken too. */
            if (i < parts.length - 1 && !info.isDirectory()) { found = 'blocked'; break; }
            if (i === parts.length - 1) found = info.isDirectory() ? 'folder' : 'file';
            here = join(here, part);
        }
        if (found) out.push({ name, as: found });
    }
    return { taken: out };
}

/* A new empty file, or a new folder, named `name` in the folder `relative`. */
export async function make(root, relative, name, folder) {
    if (!isFileName(name)) throw new Refusal(400, fileNameRule);
    const at = await folderAt(root, relative);
    const target = join(at.path, name);
    if (await lstat(target).then(() => true, () => false)) throw new Refusal(409, `"${name}" already exists here.`);
    await still(at.base, at.path);
    if (folder) await mkdir(target, 0o755).catch((e) => { throw e.code === 'EEXIST' ? new Refusal(409, `"${name}" already exists here.`) : e; });
    else await (await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644).catch((e) => { throw e.code === 'EEXIST' ? new Refusal(409, `"${name}" already exists here.`) : e; })).close();
    return { name, folder: Boolean(folder) };
}

/* Renamed in its own folder. Never over something else. */
export async function renameIn(root, relative, name) {
    if (!isFileName(name)) throw new Refusal(400, fileNameRule);
    const at = await thingAt(root, relative);
    if (name === at.name) return { name };
    const target = join(at.parent, name);
    /* A change of case only, on a disk that ignores case, finds itself: not a clash. */
    const there = await lstat(target).catch(() => undefined);
    if (there && !(there.ino === at.info.ino && there.dev === at.info.dev)) throw new Refusal(409, `"${name}" already exists here.`);
    await still(at.base, at.parent);
    await rename(at.path, target);
    return { name };
}

/* Moved into the folder `to` (a path from the top; '' is the top). Never over something else, never into itself. */
export async function move(root, relative, to) {
    const at = await thingAt(root, relative);
    const into = await folderAt(root, to);
    if (into.path === at.parent) throw new Refusal(400, 'It is already in that folder.');
    if (at.info.isDirectory() && (into.path === at.path || into.path.startsWith(at.path + sep))) throw new Refusal(400, 'A folder cannot be moved into itself.');
    const target = join(into.path, at.name);
    if (await lstat(target).then(() => true, () => false)) throw new Refusal(409, `"${at.name}" already exists in that folder.`);
    await still(at.base, at.parent); await still(at.base, into.path);
    await rename(at.path, target);
    return { name: at.name, to: into.path === at.base ? '' : into.path.slice(at.base.length + 1) };
}

/* Removed, a folder with all it holds. A link inside is removed as a link: never followed. */
export async function remove(root, relative) {
    const at = await thingAt(root, relative);
    await still(at.base, at.parent);
    await rm(at.path, { recursive: at.info.isDirectory(), force: false });
    return { removed: at.name };
}

/* What tells one state of a file from another: changed by anyone, it changes. */
const versionOf = (info) => `${info.ino}-${info.size}-${Math.round(info.mtimeMs * 1000)}`;
/* Text a person may edit here: UTF-8, no NUL, at most EDIT_MAX. */
function asText(bytes) {
    if (bytes.includes(0)) throw new Refusal(415, 'This file is not text: it is not edited here.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Refusal(415, 'This file is not UTF-8 text: it is not edited here.'); }
}
async function regular(root, relative) {
    const at = await walk(root, relative);
    if (!at.info) throw new Refusal(404, 'No such file.');
    if (!at.info.isFile()) throw new Refusal(400, 'Not a file.');
    return at;
}
async function readAll(handle, size) {
    const bytes = Buffer.alloc(size);
    let done = 0;
    while (done < size) { const { bytesRead } = await handle.read(bytes, done, size - done, done); if (bytesRead === 0) break; done += bytesRead; }
    return bytes.subarray(0, done);
}

/* A text file, to edit: { text, version, size }. */
export async function readText(root, relative) {
    const at = await regular(root, relative);
    if (at.info.size > EDIT_MAX) throw new Refusal(413, `This file is too large to be edited here (${EDIT_MAX / 1024 / 1024} MB at most).`);
    const handle = await open(at.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > EDIT_MAX) throw new Refusal(413, `This file is too large to be edited here (${EDIT_MAX / 1024 / 1024} MB at most).`);
        return { text: asText(await readAll(handle, info.size)), version: versionOf(info), size: info.size, modified: info.mtime.toISOString() };
    } finally { await handle.close(); }
}

/* An edited text saved. `version`: the one it was read at -- if the file is
   not at that version any more (the agent wrote it meanwhile), nothing is
   written and the answer says so (409, kind "changed"); 'any' writes over
   it all the same. `copy`: written beside it under a free name instead. */
export async function saveText(root, relative, request, { version, copy = false } = {}) {
    const parts = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > EDIT_MAX) throw new Refusal(413, `A text edited here is ${EDIT_MAX / 1024 / 1024} MB at most.`); parts.push(chunk); }
    const bytes = Buffer.concat(parts);
    asText(bytes);
    const at = await regular(root, relative);
    const changed = () => Object.assign(new Refusal(409, 'This file changed since it was opened: the tool may have written it.'), { kind: 'changed' });
    let target = at.path; let name = at.name;
    if (copy) {
        const dot = at.name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [at.name.slice(0, dot), at.name.slice(dot)] : [at.name, ''];
        for (let i = 2; ; i++) { name = `${stem} (${i})${ext}`; target = join(at.parent, name); if (!(await lstat(target).then(() => true, () => false))) break; }
    } else if (version !== 'any' && versionOf(at.info) !== version) throw changed();
    const partial = join(at.parent, `.${at.name}.${randomBytes(4).toString('hex')}.saving`);
    const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, at.info.mode & 0o777);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    try {
        await still(at.base, at.parent);
        /* Looked at again, the moment before: a write of the agent in between is not lost silently. */
        if (!copy && version !== 'any') { const now = await lstat(at.path).catch(() => undefined); if (!now?.isFile() || versionOf(now) !== version) throw changed(); }
        if (copy && await lstat(target).then(() => true, () => false)) throw new Refusal(409, `"${name}" was just made by someone else: try again.`);
        await rename(partial, target);
    } catch (error) { await unlink(partial).catch(() => {}); throw error; }
    return { name, version: versionOf(await lstat(target)), size: bytes.length };
}

/* A PICTURE, for its thumbnail: only what its first bytes prove it is (never
   its name), never SVG, bounded; answered with rules that run nothing. */
const SIGNATURES = [
    ['image/png', (b) => b.length >= 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG'],
    ['image/jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/gif', (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))],
    ['image/webp', (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
export const IMAGE_HEADERS = Object.freeze({
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=300',
});
export async function picture(root, relative) {
    const at = await regular(root, relative);
    if (!/\.(png|jpe?g|gif|webp)$/i.test(at.name)) throw new Refusal(415, 'Only a PNG, JPEG, GIF or WebP picture has a thumbnail.');
    if (at.info.size > THUMB_MAX) throw new Refusal(413, 'This picture is too large for a thumbnail.');
    const handle = await open(at.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > THUMB_MAX) throw new Refusal(413, 'This picture is too large for a thumbnail.');
        const bytes = await readAll(handle, info.size);
        const type = SIGNATURES.find(([, is]) => is(bytes))?.[0];
        if (!type) throw new Refusal(415, 'This file is not the picture its name says.');
        return { type, bytes, version: versionOf(info) };
    } finally { await handle.close(); }
}

/* THE ROUTES of the changes above, the same for the owner (api.mjs) and for a
 * device (door.mjs), under their own prefix:
 *   GET  .../files/thumb?p=      a picture, for its thumbnail
 *   GET  .../files/text?p=       {text, version, size}: a text file to edit
 *   POST .../files/save?p=&version=|&copy=1   the body IS the text (octet-stream)
 *   POST .../files/make?p=       {name, folder}: in the folder p
 *   POST .../files/rename?p=     {name}
 *   POST .../files/move?p=       {to}: a folder, from the top
 *   POST .../files/remove?p=
 *   POST .../files/taken?p=      {names}: which of these a drop would find taken
 * `folder(need)`: the folder this request may reach, 'write' to change it --
 * the caller's own rules (who may write where) are in it. The caller has
 * already checked that a POST comes from this site.
 * Answers [status, body], or { picture }, or undefined: not one of these. */
export const CHANGE_ROUTES = ['/files/thumb', '/files/text', '/files/save', '/files/make', '/files/rename', '/files/move', '/files/remove', '/files/taken'];
export async function changeRoute(method, route, params, request, folder) {
    if (!CHANGE_ROUTES.includes(route)) return undefined;
    const p = params.get('p') ?? '';
    if (method === 'GET' && route === '/files/thumb') return { picture: await picture(folder(), p) };
    if (method === 'GET' && route === '/files/text') return [200, await readText(folder(), p)];
    if (method !== 'POST') return [405, { error: 'Not this way.' }];
    const type = String(request.headers['content-type'] ?? '');
    if (route === '/files/save') {
        if (type !== 'application/octet-stream') return [400, { error: 'A text saved is sent as it is.' }];
        return [200, await saveText(folder('write'), p, request, { version: params.get('version') ?? '', copy: params.get('copy') === '1' })];
    }
    if (!type.startsWith('application/json')) return [400, { error: 'The request is not JSON.' }];
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) throw new Refusal(413, 'Request too large.'); chunks.push(chunk); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Refusal(400, 'The request is not JSON.'); }
    if (!body || typeof body !== 'object') body = {};
    const root = folder('write');
    if (route === '/files/make') return [201, await make(root, p, String(body.name ?? ''), body.folder === true)];
    if (route === '/files/rename') return [200, await renameIn(root, p, String(body.name ?? ''))];
    if (route === '/files/move') return [200, await move(root, p, String(body.to ?? ''))];
    if (route === '/files/remove') return [200, await remove(root, p)];
    return [200, await taken(root, p, body.names)];
}
