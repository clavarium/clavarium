/* THE RELAY'S MAINTENANCE PROGRAM (relay/clavarium-relay) and the script that
   installs it (deploy/relay.sh), run on a folder that stands for "/", with
   stand-ins for the system's programs (useradd, sshd, systemctl, sudo...) and
   a registry made of files. What is written, what the door lets through, and
   that an update is refused unless the registry's sha512 matches. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM = fileURLToPath(new URL('../relay/clavarium-relay', import.meta.url));
const RELAY_SH = fileURLToPath(new URL('../deploy/relay.sh', import.meta.url));
const key = (c, name) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${c.repeat(43)} ${name}`;
const TUNNEL = key('T', 'clavarium-tunnel');
const KEEPER = key('K', 'clavarium-keeper');

function place() {
    const dir = mkdtempSync(join(tmpdir(), 'clavarium-relay-'));
    const root = join(dir, 'root'); const bin = join(dir, 'bin'); const reg = join(dir, 'registry');
    for (const d of [root, bin, reg, join(root, 'etc', 'ssh'), join(root, 'usr', 'local', 'sbin')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(root, 'etc', 'os-release'), 'ID=ubuntu\nPRETTY_NAME="Ubuntu 26.04"\n');
    writeFileSync(join(root, 'etc', 'ssh', 'sshd_config'), 'Include /etc/ssh/sshd_config.d/*.conf\n');
    writeFileSync(join(root, 'etc', 'ssh', 'ssh_host_ed25519_key.pub'), 'x');
    const log = join(dir, 'calls.log');
    const shim = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    shim('id', `[ "$1" = "-u" ] && exec /usr/bin/id -u; [ -e "${root}/.users/$1" ]`);
    shim('useradd', `mkdir -p "${root}/.users"; touch "${root}/.users/\${@: -1}"`);
    for (const n of ['sshd', 'visudo', 'apt-get', 'nft', 'systemctl']) shim(n, 'exit 0');
    shim('ss', 'exit 0');
    shim('sudo', 'exit 0');
    shim('ssh-keygen', 'echo "256 SHA256:relayprint x (ED25519)"');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAVARIUM_RELAY_ROOT: root, CLAVARIUM_RELAY_REGISTRY: `file://${reg}` };
    const run = (file, args, extra = {}) => { const r = spawnSync('/bin/bash', [file, ...args], { encoding: 'utf8', env: { ...env, ...extra } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
    /* A version of the program, published in the registry made of files. */
    const publish = (version, { tamper = false } = {}) => {
        const work = join(dir, `pack-${version}`); mkdirSync(join(work, 'package'), { recursive: true });
        writeFileSync(join(work, 'package', 'clavarium-relay'), readFileSync(PROGRAM, 'utf8').replace(/^VERSION_OF_THIS=".*"$/m, `VERSION_OF_THIS="${version}"`));
        writeFileSync(join(work, 'package', 'package.json'), JSON.stringify({ name: 'clavarium-relay', version }));
        mkdirSync(join(reg, 'clavarium-relay', '-'), { recursive: true });
        const tgz = join(reg, 'clavarium-relay', '-', `clavarium-relay-${version}.tgz`);
        execFileSync('tar', ['-czf', tgz, '-C', work, 'package']);
        let integrity = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`;
        if (tamper) integrity = `sha512-${createHash('sha512').update('something else').digest('base64')}`;
        writeFileSync(join(reg, 'clavarium-relay', version), JSON.stringify({ name: 'clavarium-relay', version, dist: { integrity, tarball: 'ignored' } }));
        rmSync(work, { recursive: true, force: true });
    };
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    return { dir, root, run, publish, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('setup: two accounts bounded by their key lines and by the SSH server, one sudo rule, the ports, automatic updates', () => {
    const p = place();
    try {
        const r = p.run(PROGRAM, ['setup', '--key', TUNNEL, '--keeper-key', KEEPER]);
        assert.equal(r.code, 0, r.err);
        const keys = join(p.root, 'etc', 'ssh', 'clavarium-relay');
        assert.equal(readFileSync(join(keys, 'clavarium-tunnel'), 'utf8'), `restrict,port-forwarding,permitlisten="8443",permitlisten="8080" ${TUNNEL}\n`);
        assert.equal(readFileSync(join(keys, 'clavarium-keeper'), 'utf8'), `restrict ${KEEPER}\n`);
        const sshd = readFileSync(join(p.root, 'etc', 'ssh', 'sshd_config.d', '10-clavarium-relay.conf'), 'utf8');
        for (const line of ['AllowTcpForwarding remote', 'PermitOpen none', 'ForceCommand /bin/false', 'Match User clavarium-keeper', 'AllowTcpForwarding no', 'ForceCommand /usr/local/sbin/clavarium-relay door', 'PasswordAuthentication no']) assert.ok(sshd.includes(line), line);
        /* A tunnel that died without a word (a cut at home) gives its ports back within 20 to 30 s. */
        assert.ok(sshd.includes('ClientAliveInterval 10') && sshd.includes('ClientAliveCountMax 2'));
        assert.match(readFileSync(join(p.root, 'etc', 'sudoers.d', 'clavarium-relay'), 'utf8'), /^clavarium-keeper ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/clavarium-relay$/m);
        assert.match(readFileSync(join(p.root, 'etc', 'clavarium-relay.nft'), 'utf8'), /tcp dport 443 redirect to :8443/);
        assert.match(readFileSync(join(p.root, 'etc', 'apt', 'apt.conf.d', '52clavarium-relay'), 'utf8'), /Unattended-Upgrade "1"/);
        assert.match(p.calls(), /apt-get install -y -qq\s+unattended-upgrades/);
        assert.match(p.calls(), /useradd .*--shell \/bin\/sh clavarium-keeper/);
        assert.match(p.calls(), /useradd .*--shell \/usr\/sbin\/nologin clavarium-tunnel/);
        const status = p.run(PROGRAM, ['status']);
        assert.equal(status.code, 0, status.out);
        assert.match(status.out, /os-updates\s+automatic/);
        assert.match(status.out, /tunnel\s+waiting for home/);
        for (const bad of [['setup', '--key', 'ssh-rsa AAAA'], ['setup', '--key', `no-pty ${TUNNEL}`], ['setup', '--key', TUNNEL, '--keeper-key', `${KEEPER}\nssh-ed25519 x`]]) assert.equal(p.run(PROGRAM, bad).code, 64, bad.join(' '));
    } finally { p.done(); }
});

test('the door lets through the verbs, with parameters of the right shape, to sudo and this program only', () => {
    const p = place();
    try {
        const door = (cmd) => p.run(PROGRAM, ['door'], { SSH_ORIGINAL_COMMAND: cmd });
        for (const cmd of ['status', 'repair', 'version', 'update-os', 'update-os --reboot', 'update-relay 0.2.0', `rotate-key tunnel ${TUNNEL}`]) assert.equal(door(cmd).code, 0, cmd);
        const sudo = p.calls().split('\n').filter((l) => l.startsWith('sudo '));
        assert.deepEqual(sudo.slice(0, 3), ['sudo -n /usr/local/sbin/clavarium-relay status', 'sudo -n /usr/local/sbin/clavarium-relay repair', 'sudo -n /usr/local/sbin/clavarium-relay version']);
        assert.ok(sudo.includes('sudo -n /usr/local/sbin/clavarium-relay update-relay 0.2.0'));
        for (const cmd of ['', 'bash', 'status; id', 'status --x', 'update-relay latest', 'update-relay 0.2.0;id', 'update-os --now', 'rotate-key root x', 'rotate-key tunnel ssh-rsa AAAA', 'setup --key x', 'door']) {
            assert.equal(door(cmd).code, 64, JSON.stringify(cmd));
        }
    } finally { p.done(); }
});

test('update-relay: fetched from the registry by the relay itself, installed only if the sha512 matches', () => {
    const p = place();
    try {
        assert.equal(p.run(PROGRAM, ['setup', '--key', TUNNEL]).code, 0);
        const installed = join(p.root, 'usr', 'local', 'sbin', 'clavarium-relay');
        copyFileSync(PROGRAM, installed);
        p.publish('0.2.0');
        const r = p.run(installed, ['update-relay', '0.2.0']);
        assert.equal(r.code, 0, r.err);
        assert.match(readFileSync(installed, 'utf8'), /^VERSION_OF_THIS="0\.2\.0"$/m);
        assert.match(r.out, /repaired/, 'the new version writes its rules');
        p.publish('0.3.0', { tamper: true });
        const bad = p.run(installed, ['update-relay', '0.3.0']);
        assert.equal(bad.code, 78);
        assert.match(bad.err, /sha512/);
        assert.match(readFileSync(installed, 'utf8'), /^VERSION_OF_THIS="0\.2\.0"$/m, 'unchanged');
        assert.equal(p.run(installed, ['update-relay', '9.9.9']).code, 78, 'not in the registry');
        assert.equal(p.run(installed, ['update-relay', '../x']).code, 64);
    } finally { p.done(); }
});

test('rotate-key replaces one key; status says what is missing', () => {
    const p = place();
    try {
        assert.equal(p.run(PROGRAM, ['status']).code, 1);
        assert.equal(p.run(PROGRAM, ['setup', '--key', TUNNEL, '--keeper-key', KEEPER]).code, 0);
        const fresh = key('N', 'clavarium-tunnel');
        assert.equal(p.run(PROGRAM, ['rotate-key', 'tunnel', fresh]).code, 0);
        assert.ok(readFileSync(join(p.root, 'etc', 'ssh', 'clavarium-relay', 'clavarium-tunnel'), 'utf8').endsWith(`${fresh}\n`));
        assert.equal(p.run(PROGRAM, ['rotate-key', 'tunnel', 'nope']).code, 64);
        assert.equal(p.run(PROGRAM, ['rotate-key', 'root', fresh]).code, 64);
    } finally { p.done(); }
});

test('relay.sh: fetches the program at the version it names, checks it, and sets the relay up with it', () => {
    const p = place();
    try {
        const pinned = /^RELAY_VERSION="([^"]+)"$/m.exec(readFileSync(RELAY_SH, 'utf8'))[1];
        p.publish(pinned);
        const r = p.run(RELAY_SH, ['--key', TUNNEL, '--keeper-key', KEEPER]);
        assert.equal(r.code, 0, r.err);
        assert.ok(existsSync(join(p.root, 'usr', 'local', 'sbin', 'clavarium-relay')));
        assert.ok(existsSync(join(p.root, 'etc', 'ssh', 'clavarium-relay', 'clavarium-keeper')));
        assert.match(r.out, /This machine is a relay/);
        const q = place();
        try {
            q.publish(pinned, { tamper: true });
            const bad = q.run(RELAY_SH, ['--key', TUNNEL]);
            assert.equal(bad.code, 78);
            assert.ok(!existsSync(join(q.root, 'usr', 'local', 'sbin', 'clavarium-relay')));
        } finally { q.done(); }
    } finally { p.done(); }
});

test('the fetching code is the same, word for word, in the program and in relay.sh', () => {
    const cut = (text) => text.slice(text.indexOf('# --- fetch_relay:'), text.indexOf('# --- end of fetch_relay ---'));
    const a = cut(readFileSync(PROGRAM, 'utf8')); const b = cut(readFileSync(RELAY_SH, 'utf8'));
    assert.ok(a.length > 500);
    assert.equal(a, b);
    /* Outside the tests, the registry is npm's and only https is spoken. */
    assert.match(readFileSync(PROGRAM, 'utf8'), /\[ -z "\$ROOT" \] \|\| REGISTRY=/);
});
