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

/* ------------------------------ several homes ------------------------------ */
const HOME_A = key('A', 'clavarium-tunnel');
const HOME_B = key('B', 'clavarium-tunnel');
const LEGACY_LINE = `restrict,port-forwarding,permitlisten="8443",permitlisten="8080" ${TUNNEL}\n`;
const homesOf = (p) => readFileSync(join(p.root, 'etc', 'clavarium-relay', 'homes'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const tunnelKeys = (p) => readFileSync(join(p.root, 'etc', 'ssh', 'clavarium-relay', 'clavarium-tunnel'), 'utf8');
const sshdOf = (p) => readFileSync(join(p.root, 'etc', 'ssh', 'sshd_config.d', '10-clavarium-relay.conf'), 'utf8');
/* A relay as 0.1.1 left it: one key file, the kernel rule, no list. */
function legacy(p) {
    const keys = join(p.root, 'etc', 'ssh', 'clavarium-relay');
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, 'clavarium-tunnel'), LEGACY_LINE);
    writeFileSync(join(keys, 'clavarium-keeper'), `restrict ${KEEPER}\n`);
}

test('an existing relay of one home moves to the list at its update, and works as before', () => {
    const p = place();
    try {
        legacy(p);
        const installed = join(p.root, 'usr', 'local', 'sbin', 'clavarium-relay');
        copyFileSync(PROGRAM, installed);
        p.publish('0.2.0');
        const r = p.run(installed, ['update-relay', '0.2.0']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /now the first of its list/);
        assert.deepEqual(homesOf(p), [`- 8443 8080 ${TUNNEL}`], 'the principal, no name yet, the same ports and key');
        assert.equal(tunnelKeys(p), LEGACY_LINE, 'its key line word for word');
        assert.match(sshdOf(p), /PermitListen 8443 8080\n/);
        assert.match(readFileSync(join(p.root, 'etc', 'clavarium-relay.nft'), 'utf8'), /tcp dport 443 redirect to :8443/, 'no name: the kernel rule, as before');
        assert.ok(!existsSync(join(p.root, 'etc', 'systemd', 'system', 'clavarium-relay-router.service')));
        assert.equal(p.run(installed, ['repair']).code, 0, 'again: nothing moves');
        assert.deepEqual(homesOf(p), [`- 8443 8080 ${TUNNEL}`]);
        /* No home is added while the principal has no name: the router could not find it. */
        const refused = p.run(installed, ['add-home', 'b.example.com', '--key', HOME_B]);
        assert.equal(refused.code, 78);
        assert.match(refused.err, /name-principal/);
    } finally { p.done(); }
});

test('add-home: its own key, its own two ports on the loopback only, the router in place of the kernel rule; remove-home', () => {
    const p = place();
    try {
        legacy(p);
        assert.equal(p.run(PROGRAM, ['repair']).code, 0);
        assert.equal(p.run(PROGRAM, ['name-principal', 'clav.example.com']).code, 0);
        const a = p.run(PROGRAM, ['add-home', 'a.example.com', '--key', HOME_A]);
        assert.equal(a.code, 0, a.err);
        assert.equal(a.out, 'home a.example.com\ntls-port 8444\nhttp-port 8081\nfingerprint SHA256:relayprint\n');
        const b = p.run(PROGRAM, ['add-home', 'b.example.com,www.b.example.com', '--key', HOME_B]);
        assert.match(b.out, /tls-port 8445\nhttp-port 8082/);
        assert.deepEqual(homesOf(p), [`clav.example.com 8443 8080 ${TUNNEL}`, `a.example.com 8444 8081 ${HOME_A}`, `b.example.com,www.b.example.com 8445 8082 ${HOME_B}`]);
        /* Each key line bounded to its own ports; the principal's line unchanged. */
        assert.deepEqual(tunnelKeys(p).split('\n').filter(Boolean), [
            LEGACY_LINE.trim(),
            `restrict,port-forwarding,permitlisten="127.0.0.1:8444",permitlisten="127.0.0.1:8081" ${HOME_A}`,
            `restrict,port-forwarding,permitlisten="127.0.0.1:8445",permitlisten="127.0.0.1:8082" ${HOME_B}`,
        ]);
        assert.match(sshdOf(p), /PermitListen 8443 8080 127\.0\.0\.1:8444 127\.0\.0\.1:8081 127\.0\.0\.1:8445 127\.0\.0\.1:8082\n/);
        /* Every home named: the router takes 443 and 80, the kernel rule is gone. */
        assert.ok(!existsSync(join(p.root, 'etc', 'clavarium-relay.nft')));
        assert.ok(!existsSync(join(p.root, 'etc', 'systemd', 'system', 'clavarium-relay-ports.service')));
        const unit = readFileSync(join(p.root, 'etc', 'systemd', 'system', 'clavarium-relay-router.service'), 'utf8');
        for (const line of ['DynamicUser=yes', 'AmbientCapabilities=CAP_NET_BIND_SERVICE', 'NoNewPrivileges=yes', 'ProtectSystem=strict']) assert.ok(unit.includes(line), line);
        assert.match(readFileSync(join(p.root, 'usr', 'local', 'lib', 'clavarium-relay', 'router.js'), 'utf8'), /THE ROUTER OF A CLAVARIUM RELAY/);
        assert.match(p.calls(), /systemctl disable --quiet --now clavarium-relay-ports\.service/);
        /* The same home asking again: the same ports, nothing added. Anything else that collides: refused. */
        assert.match(p.run(PROGRAM, ['add-home', 'a.example.com', '--key', HOME_A]).out, /tls-port 8444/);
        assert.equal(homesOf(p).length, 3);
        for (const [args, why] of [
            [['add-home', 'c.example.com', '--key', HOME_A], /key of another home/],
            [['add-home', 'a.example.com', '--key', key('C', 'x')], /served by this relay already/],
            [['add-home', 'www.b.example.com', '--key', key('C', 'x')], /served by this relay already/],
            [['add-home', 'c.example.com', '--key', TUNNEL], /key of another home/],
            [['add-home', 'clav.example.com', '--key', key('C', 'x')], /served by this relay already/],
            [['remove-home', 'clav.example.com'], /principal/],
            [['remove-home', 'nothere.example.com'], /no home/],
            [['name-principal', 'a.example.com'], /another home/],
        ]) { const r = p.run(PROGRAM, args); assert.equal(r.code, 78, args.join(' ')); assert.match(r.err, why); }
        for (const args of [['add-home', 'A.example.com', '--key', HOME_A], ['add-home', 'a.example.com', '--key', 'ssh-rsa AAAA'], ['add-home', 'a.example.com;id', '--key', HOME_A], ['remove-home', '../x']]) assert.equal(p.run(PROGRAM, args).code, 64, args.join(' '));
        const gone = p.run(PROGRAM, ['remove-home', 'a.example.com']);
        assert.equal(gone.code, 0, gone.err);
        assert.ok(!tunnelKeys(p).includes(HOME_A), 'its key opens nothing any more');
        assert.match(p.calls(), /ss -ltnpH \( sport = :8444 or sport = :8081 \)/, 'a tunnel still open is looked for, to be cut');
        /* Its ports are free again for the next one. */
        assert.match(p.run(PROGRAM, ['add-home', 'd.example.com', '--key', key('D', 'x')]).out, /tls-port 8444\nhttp-port 8081/);
        const homes = p.run(PROGRAM, ['homes']);
        assert.match(homes.out, /^principal\s+clav\.example\.com\s+tls 8443\s+http 8080\s+waiting$/m);
        assert.match(p.run(PROGRAM, ['status']).out, /router\s+ok[\s\S]*homes:/);
        /* The principal's key rotated: the other homes stay. */
        assert.equal(p.run(PROGRAM, ['rotate-key', 'tunnel', key('N', 'clavarium-tunnel')]).code, 0);
        assert.equal(homesOf(p).length, 3);
        assert.equal(p.run(PROGRAM, ['rotate-key', 'tunnel', HOME_B]).code, 78, 'not another home\'s key');
    } finally { p.done(); }
});

test('a relay set up with its principal\'s name routes by name from the start; setup again keeps the other homes', () => {
    const p = place();
    try {
        assert.equal(p.run(PROGRAM, ['setup', '--key', TUNNEL, '--keeper-key', KEEPER, '--name', 'clav.example.com']).code, 0);
        assert.deepEqual(homesOf(p), [`clav.example.com 8443 8080 ${TUNNEL}`]);
        assert.ok(existsSync(join(p.root, 'etc', 'systemd', 'system', 'clavarium-relay-router.service')));
        assert.equal(p.run(PROGRAM, ['add-home', 'a.example.com', '--key', HOME_A]).code, 0);
        const fresh = key('N', 'clavarium-tunnel');
        assert.equal(p.run(PROGRAM, ['setup', '--key', fresh, '--name', 'clav.example.com']).code, 0);
        assert.deepEqual(homesOf(p).map((l) => l.split(' ')[0]), ['clav.example.com', 'a.example.com']);
        assert.ok(homesOf(p)[0].endsWith(fresh));
        assert.equal(p.run(PROGRAM, ['setup', '--key', HOME_A]).code, 78, 'another home\'s key never becomes the principal\'s');
    } finally { p.done(); }
});

test('the door lets the principal add, remove and list homes, with names and keys of the right shape only', () => {
    const p = place();
    try {
        const door = (cmd) => p.run(PROGRAM, ['door'], { SSH_ORIGINAL_COMMAND: cmd });
        for (const cmd of ['homes', `add-home a.example.com ${HOME_A}`, 'remove-home a.example.com', 'name-principal clav.example.com']) assert.equal(door(cmd).code, 0, cmd);
        const sudo = p.calls().split('\n').filter((l) => l.startsWith('sudo '));
        assert.ok(sudo.includes(`sudo -n /usr/local/sbin/clavarium-relay add-home a.example.com --key ${HOME_A}`));
        assert.ok(sudo.includes('sudo -n /usr/local/sbin/clavarium-relay remove-home a.example.com'));
        for (const cmd of ['homes x', 'add-home a.example.com', `add-home a.example.com;id ${HOME_A}`, `add-home A.example.com ${HOME_A}`, 'add-home a.example.com ssh-rsa AAAA',
            `add-home a.example.com ${HOME_A} extra`, 'remove-home', 'remove-home a.example.com b.example.com', 'name-principal $(id)']) assert.equal(door(cmd).code, 64, cmd);
    } finally { p.done(); }
});

test('relay.sh run again on a relay: its own router on 443 is not "something else"', () => {
    const p = place();
    try {
        const pinned = /^RELAY_VERSION="([^"]+)"$/m.exec(readFileSync(RELAY_SH, 'utf8'))[1];
        p.publish(pinned);
        writeFileSync(join(p.dir, 'bin', 'ss'), '#!/bin/bash\necho \'LISTEN 0 511 *:443 *:* users:(("node",pid=7,fd=18))\'\n', { mode: 0o755 });
        const first = p.run(RELAY_SH, ['--key', TUNNEL, '--name', 'clav.example.com']);
        assert.equal(first.code, 78, 'a machine that is no relay: 443 is someone else\'s');
        legacy(p);
        const again = p.run(RELAY_SH, ['--key', TUNNEL, '--keeper-key', KEEPER, '--name', 'clav.example.com']);
        assert.equal(again.code, 0, again.err);
        assert.match(again.out, /CAA record to your DNS FOR EACH NAME/);
        assert.deepEqual(homesOf(p), [`clav.example.com 8443 8080 ${TUNNEL}`]);
    } finally { p.done(); }
});
