/* THE TOOLS AT HAND: one folder every machine sees at /tools, read-only.
 *
 * An archive per tool, and an index that says what each one is.
 *
 * PARLEY IS INSTALLED BY THIS SERVER, never by the agent (decided after an
 * agent rightly refused to install "code it had not checked"): in every
 * machine, at each start of its tool when it is missing or not the version
 * of the index, chat on or off. Its archive's sha256, as the machine reads
 * it in /tools, is compared with the index first; then npm installs it
 * offline, as root (no script of the package runs: it has none).
 *
 *   /tools/index.json                  { tools: [{ name, version, file, sha256, usage }] }
 *   /tools/clavarium-parley-0.9.0.tgz  Parley, the first of them, as the registry
 *                                      served it (checked: parley.mjs)
 *   /tools/launch/<tool>.sh            how each tool is started (config/tools.json,
 *                                      "launch"), and json-set.mjs for their settings
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, ARCHIVES, PARLEY, archiveName, locked, parleyDir, parleyVersion } from './parley.mjs';

export const TOOLS_PATH = '/tools';
export const NOTES = 'CLAVARIUM.md';
/* THE LAUNCHERS of the tools (launch/ of this code): copied as they are into /tools/launch. */
export const LAUNCH = 'launch';
export const LAUNCHERS = fileURLToPath(new URL('../launch', import.meta.url));
/* What is put there: { name, archive (a path here), integrity, usage(file) }.
   Parley's archive as the registry served it, next to the code (see
   parley.mjs), with the integrity npm recorded for the version installed:
   prepare() refuses an archive that is not that one. Missing, it is said
   once and nothing is offered: no machine gets a Parley nobody checked. */
export function parleySource({ app = APP, dir } = {}) {
    let version;
    try { version = parleyVersion(dir ?? parleyDir()); } catch (error) { console.error(`Parley: ${error.message}`); return []; }
    const archive = join(app, ARCHIVES, archiveName(version));
    if (!existsSync(archive)) { console.error(`Parley: ${archive} is missing (npm run toolbox): no machine is given Parley`); return []; }
    const lock = locked(PARLEY, app);
    if (lock?.version !== version) { console.error(`Parley: the lock file does not record version ${version}: no machine is given Parley`); return []; }
    return [{ name: 'parley', archive, integrity: lock.integrity, usage: () => 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.' }];
}

/* "sha512-<base64>", as npm writes an integrity. */
export const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';

export class Toolbox {
    #host; #vms; #mnt; #uid; #gid; #sources; #notes; #launchers; #index = null;
    /* What is known of Parley in each machine, as the index is now:
       conversation -> { sha256, why } (why: '' installed, or why it cannot be,
       such as a machine without npm: not asked again at each opening). */
    #installed = new Map(); #installing = new Map();

    /* `host(argv)`: the host program. `mntDir`: where it keeps the folder.
       `notes(find)`: the text of /tools/CLAVARIUM.md, given how to find a
       tool of the index; none when not given. Nothing of one conversation
       may be in it: every machine reads it. */
    constructor({ host, vms, mntDir, uid = process.getuid(), gid = process.getgid(), sources = parleySource(), notes = null, launchers = LAUNCHERS }) {
        this.#host = host; this.#vms = vms; this.#mnt = mntDir; this.#uid = uid; this.#gid = gid; this.#sources = sources; this.#notes = notes; this.#launchers = launchers;
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
            if (source.integrity && integrityOf(bytes) !== source.integrity) { console.error(`${source.archive} is not the archive npm recorded (integrity differs): not given to machines`); continue; }
            const file = source.archive.split('/').pop();
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const there = existsSync(`${dir}/${file}`) ? createHash('sha256').update(readFileSync(`${dir}/${file}`)).digest('hex') : '';
            if (there !== sha256) { writeFileSync(`${dir}/.${file}.new`, bytes); renameSync(`${dir}/.${file}.new`, `${dir}/${file}`); }
            const version = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/.exec(file)?.[1] ?? '';
            tools.push({ name: source.name, version, file, sha256, usage: source.usage(`${TOOLS_PATH}/${file}`) });
        }
        /* The launchers, each copied when it differs; one no longer here taken away. */
        const launch = `${dir}/${LAUNCH}`;
        mkdirSync(launch, { recursive: true });
        const wanted = existsSync(this.#launchers) ? readdirSync(this.#launchers).filter((n) => /^[a-z][a-z0-9-]*\.(sh|mjs)$/.test(n)) : [];
        for (const n of wanted) {
            const bytes = readFileSync(join(this.#launchers, n));
            const there = existsSync(`${launch}/${n}`) ? readFileSync(`${launch}/${n}`) : null;
            if (!there || !there.equals(bytes)) { writeFileSync(`${launch}/.${n}.new`, bytes, { mode: 0o755 }); renameSync(`${launch}/.${n}.new`, `${launch}/${n}`); }
        }
        for (const n of readdirSync(launch)) if (!wanted.includes(n)) rmSync(`${launch}/${n}`, { recursive: true, force: true });
        const kept = new Set([...tools.map((t) => t.file), 'index.json', LAUNCH, ...(this.#notes ? [NOTES] : [])]);
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

    /* PARLEY IN ITS MACHINE (one that runs), installed if it is not there
       as the index has it. Resolves with '' or why it could not be. Asked
       at each opening: once it is known to be there, nothing is asked of
       the machine (forget() when its disk may have changed). */
    installIn(conversation) {
        const going = this.#installing.get(conversation);
        if (going) return going;
        const run = this.#install(conversation).catch((error) => error.message || 'failed').finally(() => this.#installing.delete(conversation));
        this.#installing.set(conversation, run);
        return run;
    }

    /* Its machine was built again, or restarted: looked at again at its next opening. */
    forget(conversation) { this.#installed.delete(conversation); }

    async #install(conversation) {
        const tool = this.find('parley');
        if (!tool) return 'the tools folder is not in place';
        const known = this.#installed.get(conversation);
        if (known?.sha256 === tool.sha256) return known.why;
        const exec = (argv, timeoutMs = 30_000) => this.#vms.exec(conversation, argv, { timeoutMs }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
        const there = async () => { const v = await exec(['parley', '--version']); return v.code === 0 && v.stdout.trim() === tool.version; };
        if (await there()) { this.#installed.set(conversation, { sha256: tool.sha256, why: '' }); return ''; }
        if ((await exec(['which', 'npm'])).code !== 0) {
            /* A machine without node (a plain shell): said once, until it is built again or restarted. */
            const why = 'there is no npm in this machine';
            this.#installed.set(conversation, { sha256: tool.sha256, why });
            return why;
        }
        /* The archive as the machine reads it, against the index; /tools mounted again once if it is not there. */
        const sum = async () => /^([0-9a-f]{64})\s/.exec((await exec(['sha256sum', '--', tool.path], 60_000)).stdout ?? '')?.[1];
        let seen = await sum();
        if (seen === undefined && (await this.show(conversation)) === '') seen = await sum();
        if (seen === undefined) return `${tool.path} cannot be read in the machine`;
        if (seen !== tool.sha256) return `${tool.path} in the machine is not the archive of the index (sha256 differs): not installed`;
        const r = await exec(['sudo', '-n', 'npm', 'install', '-g', '--offline', '--no-audit', '--no-fund', tool.path], 180_000);
        if (r.code !== 0) return `npm: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`;
        if (!(await there())) return 'installed, but "parley --version" does not say the version of the index';
        this.#installed.set(conversation, { sha256: tool.sha256, why: '' });
        return '';
    }

    /* THE LAUNCHER OF A TOOL, there in its machine before the tool starts: when /tools is
       missing or came loose, it is repaired (below) and looked at again. '' or why not --
       then the tool does not start: never a start in a half-made state. */
    async launcherIn(conversation, file) {
        const at = `${TOOLS_PATH}/${LAUNCH}/${file}`;
        const there = async () => (await this.#vms.exec(conversation, ['test', '-r', at], { timeoutMs: 15_000 }).catch(() => ({ code: 1 }))).code === 0;
        if (await there()) return '';
        const why = await this.repair(conversation);
        if (await there()) return '';
        return why ? `/tools could not be put in place: ${why}` : `${at} is not in its machine, even after /tools was mounted again`;
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
