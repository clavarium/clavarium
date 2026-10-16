/* THE TOOLS AT HAND: one folder every machine sees at /tools, read-only.
 *
 * What an agent may install by itself, when it is asked to: an archive, and
 * an index that says what each one is. Nothing is installed from here, and
 * nothing in a machine is changed: the agent is told where the archive is
 * (see talk.mjs) and installs it, as it would install anything.
 *
 *   /tools/index.json                  { tools: [{ name, version, file, sha256, usage }] }
 *   /tools/clavarium-parley-0.5.0.tgz  Parley, the first of them (npm pack)
 *   /tools/CLAVARIUM.md                where a tool is, the same for every
 *                                      machine (see guide.mjs): `notes`
 *
 * Adding a tool is putting its archive in SOURCES with one line of usage.
 *
 * THE FOLDER IS KEPT BY THIS SERVER and shown in each machine through a
 * read-only view made by the host program ("tools make": the same bindfs
 * view that holds a read attachment against root in the machine). It is
 * mounted with the machine's other folders, looked at by the health checks
 * like them, and mounted again when it came loose.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOOLS_PATH = '/tools';
export const NOTES = 'CLAVARIUM.md';
const PARLEY = fileURLToPath(new URL('./parley/', import.meta.url));

/* What is put there: { name, archive (a path here), usage(file) }. */
export function parleySource(dir = PARLEY) {
    const file = readdirSync(dir).find((f) => /^clavarium-parley-\d+\.\d+\.\d+\.tgz$/.test(f));
    if (!file) return [];
    return [{ name: 'parley', archive: `${dir}${file}`, usage: (at) => `npm install -g ${at}, then parley --help: talk with the person you work for, on their screen.` }];
}

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Toolbox {
    #host; #vms; #mnt; #uid; #gid; #sources; #notes; #index = null;

    /* `host(argv)`: the host program. `mntDir`: where it keeps the folder.
       `notes(find)`: the text of /tools/CLAVARIUM.md, given how to find a
       tool of the index; none when not given. Nothing of one conversation
       may be in it: every machine reads it. */
    constructor({ host, vms, mntDir, uid = process.getuid(), gid = process.getgid(), sources = parleySource(), notes = null }) {
        this.#host = host; this.#vms = vms; this.#mnt = mntDir; this.#uid = uid; this.#gid = gid; this.#sources = sources; this.#notes = notes;
    }

    folder() { return `${this.#mnt}/toolbox/files`; }
    /* Is it in place (made, and filled)? Until then nothing is mounted. */
    get ready() { return this.#index !== null; }
    /* What is there, as the index says it. */
    list() { return this.#index?.tools ?? []; }
    /* One tool of the index, by name: { name, version, file, sha256, usage, path }. */
    find(name) { const t = this.list().find((x) => x.name === name); return t ? { ...t, path: `${TOOLS_PATH}/${t.file}` } : undefined; }

    /* Made by the host program, then filled: each archive copied when it
       differs, what is no longer listed taken away, the index written last.
       Asked at each start of this server. */
    async prepare() {
        const made = await this.#host(['tools', 'make']);
        if (made.code !== 0) throw new Error(`The tools folder could not be made: ${firstLine(made.stderr) || `exit ${made.code}`}`);
        const dir = this.folder();
        mkdirSync(dir, { recursive: true });
        const tools = [];
        for (const source of this.#sources) {
            const bytes = readFileSync(source.archive);
            const file = source.archive.split('/').pop();
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const there = existsSync(`${dir}/${file}`) ? createHash('sha256').update(readFileSync(`${dir}/${file}`)).digest('hex') : '';
            if (there !== sha256) { writeFileSync(`${dir}/.${file}.new`, bytes); renameSync(`${dir}/.${file}.new`, `${dir}/${file}`); }
            const version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(file)?.[1] ?? '';
            tools.push({ name: source.name, version, file, sha256, usage: source.usage(`${TOOLS_PATH}/${file}`) });
        }
        const kept = new Set([...tools.map((t) => t.file), 'index.json', ...(this.#notes ? [NOTES] : [])]);
        for (const name of readdirSync(dir)) if (!kept.has(name)) rmSync(`${dir}/${name}`, { recursive: true, force: true });
        const index = { tools };
        writeFileSync(`${dir}/.index.json.new`, `${JSON.stringify(index, null, 2)}\n`);
        renameSync(`${dir}/.index.json.new`, `${dir}/index.json`);
        this.#index = index;
        if (this.#notes) {
            writeFileSync(`${dir}/.${NOTES}.new`, this.#notes((name) => this.find(name)));
            renameSync(`${dir}/.${NOTES}.new`, `${dir}/${NOTES}`);
        }
        return index;
    }

    /* Shown in one conversation's machine (one that runs). "Already mounted"
       is not a failure. Resolves with '' or what went wrong. */
    async show(conversation) {
        if (!this.ready) return 'the tools folder is not in place';
        const r = await this.#vms.mountTools(conversation, this.#uid, this.#gid);
        return r.code === 0 || /already mounted/i.test(`${r.stderr}${r.stdout}`) ? '' : firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
    }

    /* It came loose: unmounted whatever the VM manager believes, its view
       made again if it went, and mounted again. */
    async repair(conversation) {
        if (!this.ready) return 'the tools folder is not in place';
        await this.#vms.unmountTools(conversation);
        const made = await this.#host(['tools', 'make']);
        if (made.code !== 0) return firstLine(made.stderr) || `exit ${made.code}`;
        const r = await this.#vms.mountTools(conversation, this.#uid, this.#gid);
        return r.code === 0 ? '' : firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
    }
}
