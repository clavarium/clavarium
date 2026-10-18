/* The installer, as far as it can be tried without being root: what it
   accepts, what it refuses, and what it says it would do. The rest is tried
   on a fresh machine (see CONVENTIONS: a real trial for what tests cannot reach). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION } from '../server/tools.mjs';

const SCRIPT = fileURLToPath(new URL('../deploy/install.sh', import.meta.url));
const install = (...args) => { const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const GOOD = ['--domain', 'clav.example.com', '--operator', 'owner@example.com', '--core-only', '--dry-run'];

test('with good parameters it says what it would do, and does nothing', () => {
    const r = install(...GOOD, '--operator', 'second@example.org');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /https:\/\/clav\.example\.com/);
    assert.match(r.out, /operators\s+owner@example\.com,second@example\.org/);
    assert.match(r.out, /may run \/usr\/local\/sbin\/clavarium-host, and nothing else/);
    /* The server runs on the Node.js the VMs get: one place says which. */
    assert.ok(r.out.includes(`Node.js ${NODE_VERSION}`));
});

test('a parameter that would end up in a command line is refused unless it is exactly what it should be', () => {
    const cases = [
        ['--domain', 'clav.example.com; id', '--operator', 'owner@example.com'],
        ['--domain', 'Clav.Example.com', '--operator', 'owner@example.com'],
        ['--domain', 'localhost', '--operator', 'owner@example.com'],
        ['--domain', 'clav.example.com', '--operator', 'owner@example.com --port 1'],
        ['--domain', 'clav.example.com', '--operator', 'owner'],
        ['--domain', 'clav.example.com'],
        ['--operator', 'owner@example.com'],
        ['--domain', 'clav.example.com', '--operator', 'owner@example.com', '--port', '80'],
        ['--domain', 'clav.example.com', '--operator', 'owner@example.com', '--port', '7717 --x'],
        ['--domain', 'clav.example.com', '--operator', 'owner@example.com', '--shell'],
    ];
    for (const args of cases) {
        const r = install(...args, '--core-only', '--dry-run');
        assert.equal(r.code, 64, args.join(' '));
        assert.equal(r.out, '', 'nothing is said to be done');
    }
});

test('the edge is part of it unless --core-only says the machine has its own', () => {
    const whole = install('--domain', 'clav.example.com', '--operator', 'owner@example.com', '--dry-run');
    assert.equal(whole.code, 0, whole.err);
    assert.match(whole.out, /edge\s+caddy .*oauth2-proxy .*dex /);
    assert.match(install(...GOOD).out, /edge\s+none \(--core-only\)/);
});

test('every program of the edge is pinned by a checksum written in the script', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    for (const name of ['CADDY_SHA256', 'PROXY_SHA256', 'DEX_LAYER', 'DEX_SHA256']) assert.match(text, new RegExp(`^${name}="[0-9a-f]{64}"$`, 'm'), name);
    /* A password or a secret never sits on a command line. */
    assert.ok(!/--plaintext|--client-secret|--cookie-secret/.test(text));
});

test('it will not go further than its parameters unless it is root', { skip: process.getuid() === 0 }, () => {
    const r = install(...GOOD.filter((a) => a !== '--dry-run'));
    assert.equal(r.code, 78);
    assert.match(r.err, /as root/);
});

test('behind a relay it says so; a relay without the edge, or a relay that is not a machine name, is refused', () => {
    const base = ['--domain', 'clav.example.com', '--operator', 'owner@example.com', '--dry-run'];
    const r = install(...base, '--relay', 'relay.example.net');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /through the relay relay\.example\.net .*nothing here listens to the outside/);
    assert.match(install(...base).out, /reached\s+directly/);
    for (const extra of [['--relay', 'relay.example.net', '--core-only'], ['--relay', 'relay.example.net -o ProxyCommand=id'], ['--relay', ['user', 'relay.example.net'].join('@')], ['--relay', 'relay.example.net', '--relay-port', '22 -v']]) {
        assert.equal(install(...base, ...extra).code, 64, extra.join(' '));
    }
});

test('to try it: --local needs no domain and no operator, sets up nothing of the outside, and says who may come in', () => {
    const r = install('--local', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /address\s+http:\/\/127\.0\.0\.1:7717, from this machine only \(--local\)/);
    assert.match(r.out, /operators\s+whoever can open a page on this machine: no sign-in/);
    assert.match(r.out, /edge\s+none \(--local\)/);
    assert.match(r.out, /reached\s+from this machine only/);
    assert.ok(!/caddy|443/.test(r.out), 'nothing listens to the outside');
    assert.equal(install('--local', '--port', '8123', '--dry-run').out.includes('127.0.0.1:8123'), true);
    /* It is one or the other: a name and people, or this machine alone. */
    for (const extra of [['--domain', 'clav.example.com'], ['--operator', 'owner@example.com'], ['--relay', 'relay.example.net']]) {
        const mixed = install('--local', ...extra, '--dry-run');
        assert.equal(mixed.code, 64, extra.join(' ')); assert.match(mixed.err, /--local is this machine only/);
    }
    /* The service it writes is started without operators and without a public address. */
    const text = readFileSync(SCRIPT, 'utf8');
    assert.match(text, /--port \$PORT\$\(\[ "\$LOCAL" = "yes" \] \|\| echo " --operators \$OPERATORS --public-origin https:\/\/\$DOMAIN"\)/);
    /* Without --local, a domain and an operator are still required. */
    assert.equal(install('--dry-run').code, 64);
});

test('what is installed: an exact version from npm, checked, or a working tree for development; how it updates', () => {
    const npm = install('--local', '--version', '0.2.0-next.1', '--dry-run');
    assert.equal(npm.code, 0, npm.err);
    assert.match(npm.out, /release\s+clavarium@0\.2\.0-next\.1 from npm, checked \(integrity, provenance from github\.com\/clavarium\/clavarium, npm audit signatures\)/);
    assert.match(npm.out, /updates\s+automatic, between 02:00 and 05:00, channel next/, 'a pre-release follows "next" unless told');
    assert.match(install('--local', '--dry-run').out, /release\s+the working tree .*\(development: not checked\)/, 'from a working tree: that tree');
    const asked = install('--local', '--version', '1.0.0', '--updates', 'ask', '--channel', 'latest', '--dry-run');
    assert.match(asked.out, /updates\s+said in Settings, done when you say, channel latest/);
    assert.match(install('--local', '--updates', 'auto', '--update-window', '23:30-01:00', '--dry-run').out, /automatic, between 23:30 and 01:00/);
    for (const bad of [['--version', '1.0'], ['--version', 'latest'], ['--version', '1.0.0', '--from-dir', '.'], ['--from-dir', '/nonexistent'], ['--updates', 'always'], ['--update-window', '2-5'], ['--update-window', '02:00-02:00'], ['--channel', 'beta']]) {
        const r = install('--local', ...bad, '--dry-run');
        assert.equal(r.code, 64, bad.join(' ')); assert.equal(r.out, '');
    }
    /* The service runs the release the link names; the timer runs its updater. */
    const text = readFileSync(SCRIPT, 'utf8');
    assert.match(text, /^WorkingDirectory=\$CODE\/current\/app$/m);
    assert.match(text, /^ExecStart=\$CODE\/current\/node\/bin\/node \$CODE\/current\/app\/deploy\/updater\.mjs run$/m);
});

test('going online later: the settings change, the release that runs stays; local mode ends with the keys and the next command', () => {
    const r = install('--domain', 'clav.example.com', '--operator', 'you@example.com', '--relay', 'relay.example.net', '--relay-installed', '--keep-release', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /release\s+the one that runs, kept \(--keep-release\)/);
    const text = readFileSync(SCRIPT, 'utf8');
    /* The command for the keyboard is the package's, from the release that runs. */
    assert.ok(text.includes('"$CODE/current/node/bin/node" "$CODE/current/app/deploy/clavarium.mjs" > /usr/local/bin/clavarium'));
    assert.match(text, /\/usr\/local\/bin\/clavarium key/);
    assert.match(text, /sudo clavarium online --relay RELAY_HOST --domain/);
    assert.match(text, /sudo clavarium online --port --domain/);
    /* The edge's programs are on the machine in local mode too, switched off, for the test from the internet. */
    assert.match(text, /if \[ "\$LOCAL" = "yes" \] \|\| \[ "\$CORE_ONLY" = "no" \]; then\nstep "edge: programs"/);
    assert.ok(text.indexOf('step "edge: programs"') < text.indexOf('Clavarium is installed, in local mode'));
    assert.match(text, /qrencode openssh-client/);
});

/* THE ONE LINE OF THE SITE: curl -fsSL https://clavarium.org/install.sh | sudo bash */
const BOOT = fileURLToPath(new URL('../docs/install.sh', import.meta.url));
const boot = (...args) => { const r = spawnSync('/bin/bash', [BOOT, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test('install.sh of the site: the same pinned Node.js, local mode first, options passed on; asked to go online, it hands over to clavarium online (which waits for the relay)', () => {
    const text = readFileSync(BOOT, 'utf8');
    assert.ok(text.includes(`NODE_VERSION="${NODE_VERSION}"`));
    const sha = /^export const NODE_SHA256 = '([0-9a-f]{64})';$/m.exec(readFileSync(new URL('../server/tools.mjs', import.meta.url), 'utf8'))[1];
    assert.ok(text.includes(`NODE_SHA256="${sha}"`));
    assert.match(text, /sha256sum -c -/);
    assert.match(text, /bash "\$work\/package\/deploy\/install\.sh" --local --version "\$got" "\$\{PASS\[@\]\}"/);
    assert.ok(!/\bread\b -/.test(text), 'it asks nothing');
    assert.match(text, /exec \/usr\/local\/bin\/clavarium online "\$\{ONLINE\[@\]\}" <\/dev\/tty/);
    for (const bad of [['--channel', 'beta'], ['--domain'], ['--relay'], ['--version', 'latest'], ['--operator', 'x@example.com']]) {
        const r = boot(...bad);
        assert.equal(r.code, 64, bad.join(' '));
    }
});

test('install.sh of the site will not go further unless it is root', { skip: process.getuid() === 0 }, () => {
    const r = boot('--channel', 'next');
    assert.equal(r.code, 78);
    assert.match(r.err, /sudo bash/);
});
