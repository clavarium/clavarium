/* A STAND-IN FOR THE ssh PROGRAM: a "remote" that is a directory here.
 *
 * Git runs `ssh [options] host "git-upload-pack '/path'"`. This plays the far
 * end with the local git, so that cloning and sending over ssh can be tested
 * with no network and no ssh server. It also does what a test needs to SEE:
 *
 *   - each call is written to <root>/ssh-log (the arguments, whether the key
 *     file existed with mode 0600, and the PUBLIC key that ssh-keygen derives
 *     from it -- never the key itself);
 *   - <root>/authorized_keys, when present, lists the public keys let in, as a
 *     hosting service's deploy keys would; another key is refused;
 *   - a host not yet in the known_hosts file it is given is added there, as
 *     "accept-new" does on first contact.
 *
 * `installFakeSsh(root)` writes a small launcher and returns its path: the
 * launcher carries <root>, because git runs ssh with the server's narrow
 * environment, where no variable of the test survives.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* A fixed host key for the pretend server (an ed25519 public key blob). */
export const FAKE_HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIEXhkskpnGeXf5GHL/qiRGWf74nxFTcj1l3J7D70VXlO';

export function installFakeSsh(root) {
    mkdirSync(join(root, 'remotes'), { recursive: true });
    const launcher = join(root, 'ssh');
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    writeFileSync(launcher, `#!/bin/sh\nexec ${q(process.execPath)} ${q(fileURLToPath(import.meta.url))} ${q(root)} "$@"\n`);
    chmodSync(launcher, 0o755);
    return launcher;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [root, ...argv] = process.argv.slice(2);
    let keyFile; let knownHosts; const rest = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-i') keyFile = argv[++i];
        else if (a === '-o') { const o = argv[++i]; if (o.startsWith('UserKnownHostsFile=')) knownHosts = o.slice('UserKnownHostsFile='.length); }
        else if (a === '-F' || a === '-p') i += 1;
        else rest.push(a);
    }
    const [target, ...command] = rest;
    const host = target.includes('@') ? target.slice(target.indexOf('@') + 1) : target;
    const keyMode = keyFile && existsSync(keyFile) ? (statSync(keyFile).mode & 0o777).toString(8) : null;
    const derived = keyFile && existsSync(keyFile) ? spawnSync('ssh-keygen', ['-y', '-f', keyFile], { encoding: 'utf8' }).stdout.trim() : null;
    appendFileSync(join(root, 'ssh-log'), `${JSON.stringify({ argv, keyFile: keyFile ?? null, keyMode, derived, host, command: command.join(' ') })}\n`);
    if (knownHosts) {
        const known = existsSync(knownHosts) ? readFileSync(knownHosts, 'utf8') : '';
        if (!known.split('\n').some((l) => l.split(' ')[0] === host)) appendFileSync(knownHosts, `${host} ssh-ed25519 ${FAKE_HOST_KEY}\n`);
    }
    const allowed = existsSync(join(root, 'authorized_keys')) ? readFileSync(join(root, 'authorized_keys'), 'utf8').split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')).filter(Boolean) : null;
    const offered = derived ? derived.split(' ').slice(0, 2).join(' ') : null;
    if (!offered || (allowed && !allowed.includes(offered))) { process.stderr.write(`git@${host}: Permission denied (publickey).\n`); process.exit(255); }
    const asked = /^(git-upload-pack|git-receive-pack) '([^']+)'$/.exec(command.join(' '));
    if (!asked) { process.stderr.write('fake ssh: only git commands are played\n'); process.exit(255); }
    const dir = join(root, 'remotes', asked[2].replace(/^\/+/, ''));
    const r = spawnSync('git', [asked[1].slice(4), dir], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
}
