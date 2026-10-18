#!/usr/bin/env node
/* THE COMMAND OF THE PACKAGE: the installer, at this exact version.
 *
 *   sudo npx clavarium@X.Y.Z install --domain clav.example.com --operator you@example.com
 *   sudo npx clavarium@X.Y.Z install --local
 *   npx clavarium --version
 *
 * `install` runs deploy/install.sh of this package, which installs THIS
 * version from npm (checked) into /opt/clavarium/releases/X.Y.Z; every other
 * parameter is the installer's (install.sh --help-like usage on a bad one).
 * The server itself runs from there, as a service: not from here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [verb, ...rest] = process.argv.slice(2);
if (verb === '--version' || verb === '-v') { console.log(version); process.exit(0); }
if (verb !== 'install') {
    console.error(`Clavarium ${version}: each AI agent in its own machine, with only what you attach.\n\n`
        + `  sudo npx clavarium@${version} install --domain NAME --operator EMAIL   on an Ubuntu server\n`
        + `  sudo npx clavarium@${version} install --local                          to try it on this machine\n\n`
        + 'https://github.com/clavarium/clavarium');
    process.exit(verb ? 64 : 0);
}
const script = fileURLToPath(new URL('./install.sh', import.meta.url));
const args = rest.some((a) => a === '--version' || a === '--from-dir') ? rest : ['--version', version, ...rest];
const r = spawnSync('/bin/bash', [script, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
