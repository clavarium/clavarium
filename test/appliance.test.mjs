/* The appliance script, as far as it can be tried without a VM manager. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../deploy/appliance.sh', import.meta.url));
const appliance = (...args) => { const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const BASE = ['--domain', 'clav.example.com', '--operator', 'owner@example.com'];

test('it says what VM it would start and what would be installed inside, and does nothing', () => {
    const r = appliance(...BASE, '--relay', 'relay.example.net', '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /a VM named clavarium \(Ubuntu 24\.04, 4 processors, 8G of memory, 60G of disk\)/);
    assert.match(r.out, /https:\/\/clav\.example\.com/);
    assert.match(r.out, /through the relay relay\.example\.net/);
    const sized = appliance(...BASE, '--name', 'home', '--cpus', '8', '--memory', '16G', '--disk', '200G', '--release', '26.04', '--dry-run');
    assert.match(sized.out, /named home \(Ubuntu 26\.04, 8 processors, 16G of memory, 200G of disk\)/);
});

test('the installer checks its own parameters here, before any VM exists', () => {
    for (const args of [['--domain', 'Bad Domain', '--operator', 'owner@example.com'], ['--domain', 'clav.example.com'], [...BASE, '--relay', 'a b']]) {
        const r = appliance(...args, '--dry-run');
        assert.equal(r.code, 64, args.join(' '));
        assert.equal(r.out, '');
    }
});

test('a VM that could not hold conversations, or a name that is not one, is refused', () => {
    for (const extra of [['--cpus', '1'], ['--memory', '2G'], ['--memory', '8'], ['--disk', '5G'], ['--name', 'clv-home'], ['--name', 'Home VM'], ['--name', 'x; id'], ['--release', 'latest'], ['--core-only'], ['--shell']]) {
        assert.equal(appliance(...BASE, ...extra, '--dry-run').code, 64, extra.join(' '));
    }
});
