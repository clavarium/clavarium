/* PARLEY, AS CLAVARIUM HAS IT: an npm dependency at an exact version
 * (package.json), no longer a copy in this tree.
 *
 *   - this server imports its host side and serves its page side from the
 *     installed package (node_modules, wherever npm put it);
 *   - the MACHINES get Parley's archive as the registry serves it, put next
 *     to this server's code in toolbox/ (deploy/parley-archive.mjs, run by
 *     the installer and the updater: `npm run toolbox` in a working tree),
 *     and checked here against the integrity npm recorded in the lock file
 *     before it is offered (server/toolbox.mjs). Machines never reach npm.
 *
 * Bumping Parley is bumping that one line of package.json: it reaches the
 * machines with the next update of Clavarium.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const APP = fileURLToPath(new URL('..', import.meta.url));
export const PARLEY = 'clavarium-parley';
export const DOCKET = 'clavarium-docket';
export const BINDER = 'clavarium-binder';
/* THE TOOLS EVERY MACHINE IS GIVEN, each an npm dependency at an exact version, as Parley is:
   installed by this server in every machine (toolbox.mjs), from its archive here. `usage`
   is what /tools/index.json says of it. Adding one is adding a line here and its dependency. */
export const MACHINE_TOOLS = Object.freeze([
    { name: 'parley', pkg: PARLEY, usage: 'Installed in every machine: parley --help. Talk with the person you work for, on their screen, when their chat is on.' },
    { name: 'docket', pkg: DOCKET, usage: 'Installed in every machine: docket --help. What woke you, waiting until you say done or failed; and reminders you set yourself.' },
    { name: 'binder', pkg: BINDER, usage: 'Installed in every machine: binder --help. The lists you were given (batches, tasks, customers...): read them, add to them, note and attach; a person approves.' },
]);

/* Where an installed package is, by the lookup Node itself makes from here
   (its own node_modules, then each parent's), without asking its "exports":
   files are read from it, not imported. */
export function packageDir(name, from = APP) {
    for (const at of require.resolve.paths(name) ?? []) {
        if (!at.startsWith('/')) continue;
        if (existsSync(join(at, name, 'package.json'))) return join(at, name);
    }
    const near = join(from, 'node_modules', name);
    if (existsSync(join(near, 'package.json'))) return near;
    throw new Error(`${name} is not installed (npm ci)`);
}

/* A file of an installed package, as an absolute path. */
export const packageFile = (name, path) => join(packageDir(name), path);

export function parleyDir() { return packageDir(PARLEY); }
export function parleyVersion(dir = parleyDir()) { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version; }
export function packageVersion(name, dir = packageDir(name)) { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version; }
/* Where its archive for the machines sits, next to the code. */
export const ARCHIVES = 'toolbox';
export const archiveName = (version, pkg = PARLEY) => `${pkg}-${version}.tgz`;

/* WHAT NPM RECORDED of a dependency: { version, resolved, integrity } from
   the lock file of this tree (a working tree, a local install), the
   shrinkwrap it was published with, or the lock file of the release that
   installed it (deploy/updater.mjs: releases/<id>/package-lock.json, with
   this tree at releases/<id>/node_modules/clavarium). */
export function locked(name, app = APP) {
    const files = [join(app, 'package-lock.json'), join(app, 'npm-shrinkwrap.json'), join(app, 'node_modules', '.package-lock.json'),
        join(dirname(dirname(app)), 'package-lock.json'), join(dirname(dirname(app)), 'node_modules', '.package-lock.json')];
    for (const file of files) {
        let lock;
        try { lock = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
        for (const [key, value] of Object.entries(lock.packages ?? {})) {
            if ((key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) && value.integrity && value.version) return { version: value.version, resolved: value.resolved, integrity: value.integrity };
        }
    }
    return undefined;
}
