/* A FLOW WITH ITS FILES (Access, Flows, Export with the files): the setup file
 * (setup.mjs) and the files of the flow's folders, in one .tar.gz -- and back.
 *
 *   flow.json                 the setup, as Export makes it
 *   folders/<name>/...        each folder's files
 *
 * Only regular files and folders go in, and only those come out: a link is
 * never followed when packing (a tool may have made one pointing anywhere),
 * and a file holding anything else (a link, a device, an absolute path, a
 * "..") is refused whole before anything is unpacked. Packed and unpacked by
 * GNU tar, never as root, never keeping owners or modes from the file.
 *
 *   folderStats(names)          [{ name, files, bytes }]: what Export would take
 *   pack(text, names, out)      the .tar.gz written to the stream `out`
 *   receive(stream, maxBytes)   a file uploaded, kept aside -> { id, bytes }
 *   open(id)                    -> { text, folders: [{ name, files, bytes }] }, or refused
 *   fill(id, name, target)      that folder's files put in `target`, which must be empty -> files
 *   forget(id)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, lstatSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Refusal } from './conversations.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID = /^[a-f0-9]{24}$/;
export const UPLOAD_MAX = 20 * 1024 ** 3;
const KEEP_MS = 24 * 3600_000;

/* Every regular file and folder under `root`, as paths relative to `base`; links and the rest left out. */
function walk(root, base, out, stats) {
    let names;
    try { names = readdirSync(root); } catch { return; }
    for (const n of names) {
        const at = join(root, n);
        let st; try { st = lstatSync(at); } catch { continue; }
        if (st.isDirectory()) { out.push(at.slice(base.length + 1)); walk(at, base, out, stats); } else if (st.isFile()) { out.push(at.slice(base.length + 1)); stats.files += 1; stats.bytes += st.size; }
    }
}

export class Bundles {
    #dir; #folder; #tar;
    /* `dir`: where uploads wait (this server's data); `folder(name)`: a folder's directory. */
    constructor({ dir, folder, tar = 'tar' }) { this.#dir = dir; this.#folder = folder; this.#tar = tar; }

    folderStats(names) {
        return names.filter((n) => NAME.test(n)).map((name) => { const s = { files: 0, bytes: 0 }; walk(this.#folder(name), this.#folder(name), [], s); return { name, ...s }; });
    }

    async pack(text, names, out) {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        const stage = mkdtempSync(join(this.#dir, 'pack-'));
        try {
            writeFileSync(join(stage, 'flow.json'), text);
            const args = ['--create', '--gzip', '--file=-', '--no-recursion', '--null', `--directory=${stage}`, 'flow.json'];
            for (const name of names.filter((n) => NAME.test(n))) {
                const dir = this.#folder(name); const parent = join(dir, '..');
                const list = [name]; walk(dir, parent, list, { files: 0, bytes: 0 });
                /* The folder's directory has its own name on the disk: named here as it is in the setup. */
                const real = dir.slice(parent.length + 1);
                const files = join(stage, `${name}.list`);
                writeFileSync(files, list.map((p) => (p === name ? real : `${real}${p.slice(name.length)}`)).join('\0'));
                args.push(`--directory=${parent}`, `--transform=s,^${real}\\(/\\|$\\),folders/${name}\\1,`, `--files-from=${files}`);
            }
            const child = spawn(this.#tar, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let said = ''; child.stderr.on('data', (d) => { said += d; });
            const ended = new Promise((resolve) => child.on('close', resolve));
            await pipeline(child.stdout, out);
            const code = await ended;
            if (code !== 0) throw new Error(`tar: ${said.trim().split('\n').pop()}`);
        } finally { rmSync(stage, { recursive: true, force: true }); }
    }

    async receive(stream, maxBytes = UPLOAD_MAX) {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        this.#tidy();
        const id = randomBytes(12).toString('hex');
        const file = join(this.#dir, `${id}.tar.gz`);
        let bytes = 0;
        stream.on('data', (d) => { bytes += d.length; if (bytes > maxBytes) stream.destroy(new Refusal(413, `The file is larger than ${Math.round(maxBytes / 1024 ** 3)} GB.`)); });
        try { await pipeline(stream, createWriteStream(file, { mode: 0o600 })); } catch (error) { rmSync(file, { force: true }); throw error instanceof Refusal ? error : new Refusal(400, 'The file did not arrive whole.'); }
        return { id, bytes };
    }

    /* What it holds, checked whole: refused at the first thing that is not a plain file or folder of ours. */
    open(id) {
        const file = this.#file(id);
        const names = spawnSync(this.#tar, ['--list', '--gzip', '--quoting-style=escape', `--file=${file}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        const kinds = spawnSync(this.#tar, ['--list', '--verbose', '--gzip', '--quoting-style=escape', `--file=${file}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        if (names.status !== 0 || kinds.status !== 0) throw new Refusal(400, 'Not a file made by Export with the files (a .tar.gz).');
        const list = names.stdout.split('\n').filter(Boolean); const types = kinds.stdout.split('\n').filter(Boolean);
        if (list.length !== types.length) throw new Refusal(400, 'This file could not be read whole.');
        const folders = new Map(); let hasFlow = false;
        list.forEach((path, i) => {
            const type = types[i][0];
            const clean = path.replace(/\/$/, '');
            if (type !== '-' && type !== 'd') throw new Refusal(400, `Refused: it holds something that is not a plain file or folder (${clean.slice(0, 120)}).`);
            if (clean.startsWith('/') || clean.split('/').some((p) => p === '..' || p === '.' || p === '') || /\\/.test(clean)) throw new Refusal(400, `Refused: a path out of place (${clean.slice(0, 120)}).`);
            if (clean === 'flow.json' && type === '-') { hasFlow = true; return; }
            if (clean === 'folders' && type === 'd') return;
            const m = /^folders\/([a-z0-9][a-z0-9-]{0,31})(\/.*)?$/.exec(clean);
            if (!m) throw new Refusal(400, `Refused: something out of place (${clean.slice(0, 120)}).`);
            const f = folders.get(m[1]) ?? { name: m[1], files: 0, bytes: 0 }; folders.set(m[1], f);
            if (type === '-') { f.files += 1; f.bytes += Number(/^\S+\s+\S+\s+(\d+)\s/.exec(types[i])?.[1] ?? 0); }
        });
        if (!hasFlow) throw new Refusal(400, 'Not a file made by Export with the files: it has no flow.json.');
        const text = spawnSync(this.#tar, ['--extract', '--gzip', '--to-stdout', `--file=${file}`, 'flow.json'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
        if (text.status !== 0) throw new Refusal(400, 'Its flow.json could not be read.');
        return { text: text.stdout, folders: [...folders.values()] };
    }

    /* Into `target`, only when it is empty: what is already there is never written over. */
    fill(id, name, target) {
        if (!NAME.test(name)) throw new Refusal(400, 'Not a folder name.');
        const file = this.#file(id);
        if (!existsSync(target) || readdirSync(target).length > 0) throw new Refusal(409, `${name} is not empty here: its files were not put in.`);
        const r = spawnSync(this.#tar, ['--extract', '--gzip', `--file=${file}`, `--directory=${target}`, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir', '--strip-components=2', `folders/${name}`], { encoding: 'utf8' });
        if (r.status !== 0) throw new Refusal(502, `Its files could not be put in: ${String(r.stderr).trim().split('\n').pop()}`);
        const s = { files: 0, bytes: 0 }; walk(target, target, [], s);
        return s.files;
    }

    forget(id) { if (ID.test(id ?? '')) rmSync(join(this.#dir, `${id}.tar.gz`), { force: true }); }

    #file(id) {
        if (!ID.test(id ?? '')) throw new Refusal(400, 'Not a file sent here.');
        const file = join(this.#dir, `${id}.tar.gz`);
        if (!existsSync(file)) throw new Refusal(404, 'That file is no longer here: send it again.');
        return file;
    }
    /* Uploads left over a day are dropped. */
    #tidy() {
        try { for (const n of readdirSync(this.#dir)) { const at = join(this.#dir, n); if (Date.now() - statSync(at).mtimeMs > KEEP_MS) rmSync(at, { recursive: true, force: true }); } } catch { /* none yet */ }
    }
}
