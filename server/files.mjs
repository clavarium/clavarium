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
import { lstat, readdir, realpath, open, rename, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
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

/* Writes an imported file under `relative` (a folder). Never overwrites: a
   taken name becomes "name (2).ext". Returns the name it was given. */
export async function importFile(root, relative, name, request) {
    if (!isFileName(name)) throw new Refusal(400, 'A file name has no slash, does not start with a dot, and is at most 120 characters.');
    const { real } = await inside(root, relative);
    if (!(await lstat(real)).isDirectory()) throw new Refusal(400, 'Not a folder.');
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > IMPORT_MAX) throw new Refusal(413, `A file is at most ${IMPORT_MAX / 1024 / 1024} MB.`);
    const partial = join(real, `.${name}.importing`);
    const file = await open(partial, 'w', 0o644);
    let size = 0;
    try {
        for await (const chunk of request) {
            size += chunk.length;
            if (size > IMPORT_MAX) throw new Refusal(413, `A file is at most ${IMPORT_MAX / 1024 / 1024} MB.`);
            await file.write(chunk);
        }
    } catch (error) {
        await file.close(); await unlink(partial).catch(() => {});
        throw error;
    }
    await file.close();
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let final = name;
    for (let i = 2; await lstat(join(real, final)).then(() => true, () => false); i++) final = `${stem} (${i})${ext}`;
    await rename(partial, join(real, final));
    return { name: final, size };
}
