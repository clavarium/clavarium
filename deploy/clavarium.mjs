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
 *   sudo clavarium doctor [--fix]                            what works, what does not, what to do
 *   sudo clavarium password EMAIL                            a new password for an administrator
 *   sudo clavarium client-id [ID]                            the sign-in client id (no ID: a random one)
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
if (['doctor', 'password', 'client-id'].includes(verb)) {
    const { doctor, newPassword, certificateWatch, installWatch } = await import('./doctor.mjs');
    if (process.getuid?.() !== 0) { console.error(`clavarium ${verb}: run it as root: sudo clavarium ${verb} ...`); process.exit(78); }
    const sys = (await import('./online.mjs')).realSys();
    try {
        if (verb === 'client-id') {
            if (rest.length > 1) throw new Error('usage: sudo clavarium client-id [ID]   (no ID: a random one)');
            const { setClientId } = await import('./oidc.mjs');
            const r = await setClientId({ value: rest[0], run: sys.run, isRoot: true });
            sys.print(r.changed.length ? `The sign-in client id is now "${r.id}" (dex and the proxy restarted).` : `The sign-in client id is already "${r.id}".`);
            process.exit(0);
        }
        if (verb === 'password') { await newPassword(sys, rest[0]); process.exit(0); }
        if (rest.length === 1 && rest[0] === '--certificate') process.exit(await certificateWatch(sys));
        if (rest.length === 1 && rest[0] === '--install-watch') { await installWatch(sys); process.exit(0); }
        if (rest.some((a) => a !== '--fix')) throw new Error('usage: sudo clavarium doctor [--fix]');
        process.exit((await doctor(sys, { fix: rest.includes('--fix') })) ? 1 : 0);
    } catch (error) { console.error(`clavarium ${verb}: ${error.message}`); process.exit(1); }
}
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
        + '  sudo clavarium relay status|repair|update-os|update-relay|forget-setup-key\n'
        + '  sudo clavarium doctor [--fix]                                     what works, what does not, what to do\n'
        + '  sudo clavarium password EMAIL                                     a new password for an administrator\n'
        + '  sudo clavarium client-id [ID]                                     the sign-in client id (no ID: a random one)\n\n'
        + 'https://clavarium.org');
    process.exit(verb ? 64 : 0);
}
const script = fileURLToPath(new URL('./install.sh', import.meta.url));
const args = rest.some((a) => a === '--version' || a === '--from-dir') ? rest : ['--version', version, ...rest];
const r = spawnSync('/bin/bash', [script, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
