/* The privileged program, tried for real in its "say only" mode: what it
   would run for what the server asks, and what it refuses whoever asks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ruleset } from '../server/network.mjs';

const PROGRAM = fileURLToPath(new URL('../deploy/clavarium-host', import.meta.url));
const host = (...args) => {
    const r = spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('each thing the server needs has one verb, turned into one exact command', () => {
    const cases = [
        [['vm', 'launch', 'clv-demo', '1024'], 'multipass launch 24.04 --name clv-demo --memory 1024M --disk 8G --cpus 1 --timeout 900'],
        [['vm', 'exec', 'clv-demo', '--', 'tmux', '-L', 'clavarium', 'has-session'], 'multipass exec clv-demo -- tmux -L clavarium has-session'],
        [['vm', 'info', 'clv-demo'], 'multipass info clv-demo --format json'],
        [['vm', 'start', 'clv-demo'], 'multipass start clv-demo'],
        [['vm', 'suspend', 'clv-demo'], 'multipass suspend clv-demo'],
        [['vm', 'delete', 'clv-demo'], 'multipass delete --purge clv-demo'],
        [['vm', 'mount', 'clv-demo', 'folder', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/resources/reports clv-demo:/resources/reports'],
        [['vm', 'mount', 'clv-demo', 'view', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/views/reports clv-demo:/resources/reports'],
        [['vm', 'umount', 'clv-demo', 'reports'], 'multipass umount clv-demo:/resources/reports'],
        [['view', 'make', 'reports'], 'bindfs -r -o allow_other /var/lib/clavarium/resources/reports /var/lib/clavarium/views/reports'],
        [['view', 'close', 'reports'], 'umount /var/lib/clavarium/views/reports'],
        [['folder', 'make', 'reports'], 'install -d -o OWNER -g GROUP -m 0755 /var/lib/clavarium/resources/reports'],
        [['net', 'taps'], 'pgrep -a qemu-system'],
        [['net', 'bridge'], 'ip -4 -o addr show mpqemubr0'],
    ];
    for (const [args, expected] of cases) assert.deepEqual(host(...args), { code: 0, out: expected, err: '' }, args.join(' '));
});

test('a mount is of a folder of the data directory, and of nothing else on the host', () => {
    for (const args of [
        ['vm', 'mount', 'clv-demo', 'folder', '../../etc', '0', '0'],
        ['vm', 'mount', 'clv-demo', 'folder', '/etc', '0', '0'],
        ['vm', 'mount', 'clv-demo', 'path', 'reports', '0', '0'],
        ['vm', 'mount', 'clv-demo', 'folder', 'reports', '0;id', '0'],
        ['vm', 'umount', 'clv-demo', '../x'],
        ['view', 'make', '../../etc'],
        ['view', 'make', 'Reports'],
    ]) {
        const r = host(...args);
        assert.equal(r.code, 78, args.join(' '));
        assert.equal(r.out, '', 'nothing would run');
    }
});

test('only our VMs, only known verbs: the VM manager is not handed over', () => {
    for (const args of [
        ['vm', 'exec', 'primary', '--', 'id'], ['vm', 'delete', 'someone-else'], ['vm', 'stop', 'clv-'], ['vm', 'start', 'clv-Bad'],
        ['vm', 'launch', 'clv-demo', '64'], ['vm', 'launch', 'clv-demo', '1024M'], ['vm', 'exec', 'clv-demo', 'id'],
        ['vm', 'shell', 'clv-demo'], ['vm', 'set', 'local.driver=lxd'], ['vm', 'transfer', '/etc/shadow', 'clv-demo:/tmp/x'],
        ['net', 'flush'], ['host', 'run', 'id'], ['folder', 'make', '../x'], ['folder', 'aside', '/etc'], ['folder', 'erase', 'reports'],
    ]) assert.equal(host(...args).code, 78, args.join(' '));
    assert.equal(host('vm').code, 64);
    const aside = host('folder', 'aside', 'reports');
    assert.match(aside.out, /^mv -T -n \/var\/lib\/clavarium\/resources\/reports \/var\/lib\/clavarium\/removed\/reports-\d{8}T\d{6}Z-\d+$/, 'moved aside, never erased');
    /* Outside "say only", the data directory cannot be chosen by the caller. */
    const real = spawnSync('/bin/bash', [PROGRAM, '--data', '/tmp', 'net', 'taps'], { encoding: 'utf8' });
    assert.equal(real.status, 78);
});

test('the network rules the server writes are accepted whole; one foreign line refuses everything', () => {
    const good = ruleset({ first: 'tap-15921f81452', second: 'tap-918e9b07222' }, ['second'], '127.0.0.1');
    const accepted = host('net', 'apply', good);
    assert.equal(accepted.code, 0, accepted.err);
    assert.ok(accepted.out.startsWith('nft table bridge clavarium'));
    for (const extra of ['flush ruleset', 'table ip filter', '    iifname "tap-1" accept', '    iifname "eth0" drop', 'include "/etc/shadow"', '    iifname "tap-1" ip daddr 127.0.0.1 tcp dport 22 accept']) {
        const r = host('net', 'apply', `${good}${extra}\n`);
        assert.equal(r.code, 78, extra);
        assert.equal(r.out, '');
    }
});
