#!/usr/bin/env node
/* PARLEY'S ARCHIVE FOR THE MACHINES, fetched from the registry at the exact
 * version and integrity npm recorded in the lock file (server/parley.mjs),
 * into <app>/toolbox/. The server offers it to machines only if it still has
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
import { APP, ARCHIVES, PARLEY, archiveName, locked } from '../server/parley.mjs';
import { integrityOf } from '../server/toolbox.mjs';

export const REGISTRY = 'https://registry.npmjs.org';

/* `registry`: where the archive is asked for; the lock file's address is kept
   for the path only, so a stand-in registry can serve it in tests. */
export async function fetchParleyArchive({ app = APP, registry = REGISTRY, fetcher = fetch } = {}) {
    const lock = locked(PARLEY, app);
    if (!lock?.resolved) throw new Error(`the lock file of ${app} does not record ${PARLEY}`);
    const to = join(app, ARCHIVES, archiveName(lock.version));
    if (existsSync(to) && integrityOf(readFileSync(to)) === lock.integrity) return { file: to, version: lock.version, fetched: false };
    const url = new URL(new URL(lock.resolved).pathname, registry.endsWith('/') ? registry : `${registry}/`);
    const answer = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!answer.ok) throw new Error(`the registry answered ${answer.status} for ${url}`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (integrityOf(bytes) !== lock.integrity) throw new Error(`${PARLEY} ${lock.version} from the registry does not have the integrity of the lock file`);
    mkdirSync(join(app, ARCHIVES), { recursive: true });
    /* Only this version is kept there. */
    for (const name of readdirSync(join(app, ARCHIVES))) if (name !== archiveName(lock.version)) rmSync(join(app, ARCHIVES, name), { force: true });
    writeFileSync(`${to}.new`, bytes);
    renameSync(`${to}.new`, to);
    return { file: to, version: lock.version, fetched: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    try {
        const done = await fetchParleyArchive({ app: value('--app') ?? APP, registry: value('--registry') ?? REGISTRY });
        console.log(`parley: ${done.file}${done.fetched ? '' : ' (already there)'}`);
    } catch (error) { console.error(`parley-archive: ${error.message}`); process.exitCode = 1; }
}
