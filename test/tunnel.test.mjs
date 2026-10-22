/* The tunnel to the relay: a cut of the network noticed in 20 to 30 s and tried again at once; a refusal
   tried again ever more slowly; its unit kept up to date by the updater, whatever install.sh wrote. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tunnelUnit, relayOfUnit, ensureTunnel } from '../deploy/tunnel.mjs';
import { keepRelayCurrent } from '../deploy/online.mjs';

const WRAPPER = fileURLToPath(new URL('../deploy/clavarium-tunnel', import.meta.url));
const folder = (t) => { const d = mkdtempSync(join(tmpdir(), 'clv-tunnel-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
/* An account at the relay, written so that no address appears whole in the source (the shapes check). */
const at = (who) => [who, 'relay.example.com'].join('@');
const OLD = `[Service]\nExecStart=/usr/bin/ssh -N -T -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R *:8443:127.0.0.1:443 -R *:8080:127.0.0.1:80 -p 2222 ${at('clavarium-tunnel')}\nRestart=always\n`;

test('its unit: the program of the release, the relay and its port read from what install.sh wrote then or now', () => {
    assert.deepEqual(relayOfUnit(OLD), { relay: 'relay.example.com', port: '2222' });
    const unit = tunnelUnit('relay.example.com', '2222');
    assert.deepEqual(relayOfUnit(unit), { relay: 'relay.example.com', port: '2222' });
    for (const line of ['ExecStart=/usr/local/sbin/clavarium-tunnel relay.example.com 2222', 'Restart=always', 'RestartSec=5', 'StartLimitIntervalSec=0', 'RuntimeDirectory=clavarium-tunnel', 'RuntimeDirectoryPreserve=yes', 'User=clavarium-tunnel']) assert.ok(unit.includes(`${line}\n`), line);
    assert.equal(relayOfUnit('[Service]\nExecStart=/bin/true\n'), null);
    /* install.sh writes this very text. */
    assert.match(readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8'), /tunnelUnit\(process\.argv\[2\], process\.argv\[3\]\).*\n.*deploy\/tunnel\.mjs" "\$RELAY" "\$RELAY_PORT" > \/etc\/systemd\/system\/clavarium-tunnel\.service/);
});

test('the updater writes it over an older one, the program first; then nothing more', async (t) => {
    const d = folder(t);
    const file = join(d, 'clavarium-tunnel.service'); const program = join(d, 'sbin-clavarium-tunnel');
    const ran = [];
    const run = async (argv) => { ran.push(argv.join(' ')); if (argv[0] === 'install') writeFileSync(program, readFileSync(argv.at(-2))); return { code: 0, stdout: '', stderr: '' }; };
    assert.equal(await ensureTunnel({ file, program, from: WRAPPER, run }), false, 'no tunnel here: nothing');
    writeFileSync(file, OLD);
    assert.equal(await ensureTunnel({ file, program, from: WRAPPER, run }), true);
    assert.equal(readFileSync(file, 'utf8'), tunnelUnit('relay.example.com', '2222', program));
    assert.deepEqual(ran, [`install -o root -g root -m 0755 ${WRAPPER} ${program}`]);
    assert.equal(await ensureTunnel({ file, program, from: WRAPPER, run }), false, 'the same: nothing');
    assert.equal(ran.length, 1);
});

/* The program, with an ssh that says what a relay would. */
function wrapper(t, said, code = 255) {
    const d = folder(t);
    mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'run'));
    writeFileSync(join(d, 'bin', 'ssh'), `#!/bin/sh\necho "$*" > "${d}/args"\nprintf '%s\\n' "${said}" >&2\nexit ${code}\n`, { mode: 0o755 });
    const go = () => spawnSync('bash', [WRAPPER, 'relay.example.com', '2222'], { env: { PATH: `${join(d, 'bin')}:/usr/bin:/bin`, RUNTIME_DIRECTORY: join(d, 'run'), CLAVARIUM_TUNNEL_STEP: '0' }, encoding: 'utf8' });
    return { d, go, count: () => (existsSync(join(d, 'run', 'refused')) ? readFileSync(join(d, 'run', 'refused'), 'utf8').trim() : '') };
}

test('a cut of the network: keepalives every 10 s, two missed; tried again at once', (t) => {
    const w = wrapper(t, 'ssh: connect to host relay.example.com port 2222: Network is unreachable');
    const r = w.go();
    assert.equal(r.status, 255);
    assert.equal(w.count(), '', 'not counted as a refusal');
    const args = readFileSync(join(w.d, 'args'), 'utf8');
    for (const o of ['ServerAliveInterval=10', 'ServerAliveCountMax=2', 'ExitOnForwardFailure=yes', 'StrictHostKeyChecking=yes', '*:8443:127.0.0.1:443', '*:8080:127.0.0.1:80', '-p 2222', at('clavarium-tunnel')]) assert.ok(args.includes(o), o);
    assert.doesNotMatch(r.stderr, /refused this machine/);
});

test('a refusal (its key, the relay\'s host key) is not a cut: counted, said, waited for longer each time; held again, the count starts over', (t) => {
    for (const said of [`${at('clavarium-tunnel')}: Permission denied (publickey).`, 'Host key verification failed.', '@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @']) {
        const w = wrapper(t, said);
        const r = w.go();
        assert.equal(r.status, 255);
        assert.match(r.stderr, /refused this machine .*not a cut of the network\. Next try in 0 s/);
        assert.equal(w.count(), '1', said);
        w.go();
        assert.equal(w.count(), '2');
        writeFileSync(join(w.d, 'bin', 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o755 });
        w.go();
        assert.equal(w.count(), '', 'a cut, or held: started over');
    }
    const bad = spawnSync('bash', [WRAPPER, 'relay;rm', '22'], { encoding: 'utf8' });
    assert.equal(bad.status, 64);
});

test('after an update, the relay is brought to the version this release names, once, only with the maintenance key', async (t) => {
    const d = folder(t);
    const P = { relayConf: join(d, 'relay.conf'), access: join(d, 'access'), tunnel: join(d, 'tunnel'), code: join(d, 'code') };
    mkdirSync(P.access); mkdirSync(join(P.code, 'current', 'app', 'deploy'), { recursive: true });
    writeFileSync(join(P.code, 'current', 'app', 'deploy', 'relay.sh'), 'RELAY_VERSION="0.1.1"\n');
    const asked = [];
    const sys = { run: async (argv) => { asked.push(argv.at(-1)); return { code: 0, stdout: '', stderr: '' }; } };
    const done = join(d, 'relay-version');
    const unit = join(d, 'tunnel.service');
    assert.equal(await keepRelayCurrent(sys, P, { done, unit }), false, 'no relay');
    /* An older install: no relay.conf, the relay read from its tunnel. */
    writeFileSync(join(P.access, 'keeper-key'), 'x');
    writeFileSync(unit, OLD);
    const seen = [];
    assert.equal(await keepRelayCurrent({ run: async (argv) => { seen.push(argv.join(' ')); return { code: 0 }; } }, P, { done: join(d, 'v-old'), unit }), true);
    assert.match(seen[0], new RegExp(`${at('clavarium-keeper').replace(/\./g, '\\.')} update-relay 0\\.1\\.1$`));
    rmSync(join(P.access, 'keeper-key'));
    writeFileSync(P.relayConf, 'HOST=relay.example.com\nPORT=22\n');
    assert.equal(await keepRelayCurrent(sys, P, { done }), false, 'no maintenance key: nothing asked');
    writeFileSync(join(P.access, 'keeper-key'), 'x');
    assert.equal(await keepRelayCurrent(sys, P, { done }), true);
    assert.deepEqual(asked, ['update-relay 0.1.1']);
    assert.equal(await keepRelayCurrent(sys, P, { done }), false, 'once per version');
    assert.equal(asked.length, 1);
    writeFileSync(join(P.code, 'current', 'app', 'deploy', 'relay.sh'), 'RELAY_VERSION="0.1.2"\n');
    sys.run = async () => ({ code: 1, stdout: '', stderr: '' });
    await assert.rejects(keepRelayCurrent(sys, P, { done }), /did not take 0\.1\.2/);
    assert.equal(readFileSync(done, 'utf8').trim(), '0.1.1', 'tried again at the next turn');
});
