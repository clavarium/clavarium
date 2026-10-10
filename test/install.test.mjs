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
