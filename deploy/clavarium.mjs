#!/usr/bin/env node
/* THE COMMAND OF THE PACKAGE: the installer, at this exact version.
 *
 *   sudo npx clavarium@X.Y.Z install --domain clav.example.com --operator you@example.com
 *   sudo npx clavarium@X.Y.Z install --local
 *   npx clavarium --version
 *
 * Once installed, the same program is the command `clavarium` (install.sh
 * puts it in /usr/local/bin), with what is done from the keyboard:
 *
 *   sudo clavarium online --relay HOST --domain NAME [...]   see deploy/online.mjs
 *   sudo clavarium online --port --domain NAME [...]
 *   sudo clavarium key                                       the public keys, text and QR
 *   sudo clavarium relay status | repair | update-os | update-relay | forget-setup-key
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
if (['online', 'key', 'relay'].includes(verb)) {
    const o = await import('./online.mjs');
    if (process.getuid?.() !== 0) { console.error(`clavarium ${verb}: run it as root: sudo clavarium ${verb} ...`); process.exit(78); }
    const sys = o.realSys();
    try {
        if (verb === 'online') await o.online(o.parseOnline(rest), sys);
        else if (verb === 'key') {
            if (rest.length > 1 || (rest[0] && !['setup', 'tunnel'].includes(rest[0]))) throw new o.Bad('usage: sudo clavarium key [setup|tunnel]');
            await o.showKeys(sys, o.PATHS, { which: rest[0] ?? 'all' });
        } else await o.relayCommand(rest, sys);
        process.exit(0);
    } catch (error) {
        if (error instanceof o.Bad) { console.error(`clavarium ${verb}: ${error.message}`); if (verb === 'online') console.error(o.USAGE); process.exit(64); }
        console.error(`clavarium ${verb}: ${error instanceof o.Refused ? 'REFUSED: ' : ''}${error.message}`);
        process.exit(error instanceof o.Refused ? 78 : 1);
    }
}
if (verb !== 'install') {
    console.error(`Clavarium ${version}: each AI agent in its own machine, with only what you attach.\n\n`
        + '  curl -fsSL https://clavarium.org/install.sh | sudo bash          install, on Ubuntu 24.04 or 26.04 (local mode)\n'
        + '  sudo clavarium online --relay HOST --domain NAME                  then online, through a relay of yours\n'
        + '  sudo clavarium online --port --domain NAME                        or with ports 80 and 443 open\n'
        + '  sudo clavarium key                                                the public keys again (text and QR)\n'
        + '  sudo clavarium relay status|repair|update-os|update-relay|forget-setup-key\n\n'
        + 'https://clavarium.org');
    process.exit(verb ? 64 : 0);
}
const script = fileURLToPath(new URL('./install.sh', import.meta.url));
const args = rest.some((a) => a === '--version' || a === '--from-dir') ? rest : ['--version', version, ...rest];
const r = spawnSync('/bin/bash', [script, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
