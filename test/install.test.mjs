/* The installer, as far as it can be tried without being root: what it
   accepts, what it refuses, and what it says it would do. The rest is tried
   on a fresh machine (see CONVENTIONS: a real trial for what tests cannot reach). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('without --core-only it stops and says why: the edge step is not written yet', () => {
    const r = install('--domain', 'clav.example.com', '--operator', 'owner@example.com', '--dry-run');
    assert.equal(r.code, 64);
    assert.match(r.err, /edge step .* not written yet/);
});

test('it will not go further than its parameters unless it is root', { skip: process.getuid() === 0 }, () => {
    const r = install(...GOOD.filter((a) => a !== '--dry-run'));
    assert.equal(r.code, 78);
    assert.match(r.err, /as root/);
});
