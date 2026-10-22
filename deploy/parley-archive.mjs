#!/usr/bin/env node
/* THE ARCHIVES OF THE MACHINES' TOOLS (Parley, Docket: MACHINE_TOOLS in
 * server/parley.mjs), fetched from the registry at the exact version and
 * integrity npm recorded in the lock file, into <app>/toolbox/. The server offers it to machines only if it still has
 * that integrity (server/toolbox.mjs). Machines never reach npm.
 *
 *   node deploy/parley-archive.mjs [--app DIR] [--registry URL]
 *
 * Run by the installer and the updater (deploy/updater.mjs) for each release,
 * and by hand in a working tree: `npm run toolbox`.
 */
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, ARCHIVES, PARLEY, MACHINE_TOOLS, archiveName, locked } from '../server/parley.mjs';
import { integrityOf } from '../server/toolbox.mjs';

export const REGISTRY = 'https://registry.npmjs.org';

/* `registry`: where the archive is asked for; the lock file's address is kept
   for the path only, so a stand-in registry can serve it in tests. */
export async function fetchParleyArchive(options = {}) { return fetchArchive(PARLEY, options); }

/* Each tool's, in turn; then only those versions are kept there. Resolves with what each gave. */
export async function fetchToolArchives({ app = APP, ...options } = {}) {
    const done = [];
    for (const tool of MACHINE_TOOLS) done.push(await fetchArchive(tool.pkg, { app, ...options, keep: false }));
    const wanted = new Set(done.map((d) => d.file.split('/').pop()));
    for (const name of readdirSync(join(app, ARCHIVES))) if (!wanted.has(name)) rmSync(join(app, ARCHIVES, name), { force: true });
    return done;
}

export async function fetchArchive(pkg, { app = APP, registry = REGISTRY, fetcher = fetch, keep = true } = {}) {
    const lock = locked(pkg, app);
    if (!lock?.resolved) throw new Error(`the lock file of ${app} does not record ${pkg}`);
    const to = join(app, ARCHIVES, archiveName(lock.version, pkg));
    if (existsSync(to) && integrityOf(readFileSync(to)) === lock.integrity) return { file: to, version: lock.version, fetched: false };
    const url = new URL(new URL(lock.resolved).pathname, registry.endsWith('/') ? registry : `${registry}/`);
    const answer = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!answer.ok) throw new Error(`the registry answered ${answer.status} for ${url}`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (integrityOf(bytes) !== lock.integrity) throw new Error(`${pkg} ${lock.version} from the registry does not have the integrity of the lock file`);
    mkdirSync(join(app, ARCHIVES), { recursive: true });
    /* Only this version of it is kept there (fetchToolArchives keeps each tool's). */
    if (keep) for (const name of readdirSync(join(app, ARCHIVES))) if (name.startsWith(`${pkg}-`) && name !== archiveName(lock.version, pkg)) rmSync(join(app, ARCHIVES, name), { force: true });
    writeFileSync(`${to}.new`, bytes);
    renameSync(`${to}.new`, to);
    return { file: to, version: lock.version, fetched: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    try {
        for (const done of await fetchToolArchives({ app: value('--app') ?? APP, registry: value('--registry') ?? REGISTRY })) console.log(`archive: ${done.file}${done.fetched ? '' : ' (already there)'}`);
    } catch (error) { console.error(`parley-archive: ${error.message}`); process.exitCode = 1; }
}
