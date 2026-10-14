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
        [['work', 'make', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img 10240M mounted at /var/lib/clavarium/work/demo'],
        [['work', 'aside', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img put aside in /var/lib/clavarium/removed'],
        [['vm', 'mount', 'clv-demo', 'work', 'demo', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/work/demo clv-demo:/work'],
        [['vm', 'unwork', 'clv-demo'], 'multipass umount clv-demo:/work'],
        [['work', 'room', 'demo'], 'df /var/lib/clavarium/work/demo /var/lib/clavarium'],
        [['net', 'taps'], 'pgrep -a qemu-system'],
        [['net', 'bridge'], 'ip -4 -o addr show mpqemubr0'],
        [['vm', 'clone', 'clvshelf-20261014-120000', 'clv-demo', '1024'], 'multipass clone clvshelf-20261014-120000 --name clv-demo\nmultipass set local.clv-demo.memory=1024M'],
        [['shelf', 'launch', 'clvshelf-20261014-120000'], 'multipass launch 24.04 --name clvshelf-20261014-120000 --memory 1536M --disk 8G --cpus 1 --timeout 900'],
        [['shelf', 'exec', 'clvshelf-20261014-120000', '--', 'sudo', '-n', 'snap', 'install', 'multipass-sshfs'], 'multipass exec clvshelf-20261014-120000 -- sudo -n snap install multipass-sshfs'],
        [['shelf', 'seal', 'clvshelf-20261014-120000'], 'multipass exec clvshelf-20261014-120000 -- sudo -n cloud-init clean --logs --machine-id\nmultipass stop clvshelf-20261014-120000'],
        [['shelf', 'info', 'clvshelf-20261014-120000'], 'multipass info clvshelf-20261014-120000 --format json'],
        [['shelf', 'delete', 'clvshelf-20261014-120000'], 'multipass delete --purge clvshelf-20261014-120000'],
        [['shelf', 'size', 'clvshelf-20261014-120000'], 'du -sm /var/snap/multipass/common/data/multipassd/vault/instances/clvshelf-20261014-120000'],
        [['shelf', 'room'], 'df /var/snap/multipass/common'],
        [['shelf', 'list'], 'multipass list --format csv (ready-made machines only)'],
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
        ['net', 'flush'], ['host', 'run', 'id'], ['folder', 'make', '../x'], ['work', 'make', '../x'], ['work', 'aside', '/etc'], ['work', 'erase', 'demo'], ['work', 'room', '../x'], ['vm', 'unwork', 'primary'],
        /* A work folder goes to its own conversation's machine, never to another. */
        ['vm', 'mount', 'clv-other', 'work', 'demo', '0', '0'], ['vm', 'mount', 'clv-demo', 'work', '../demo', '0', '0'], ['folder', 'aside', '/etc'], ['folder', 'erase', 'reports'],
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

test('the ready-made machine: its own names only, and a conversation is copied from it and from nothing else', () => {
    const shelf = 'clvshelf-20261014-120000';
    for (const args of [
        /* A shelf verb never reaches a conversation's machine, nor any other. */
        ['shelf', 'delete', 'clv-demo'], ['shelf', 'exec', 'clv-demo', '--', 'id'], ['shelf', 'launch', 'primary'], ['shelf', 'seal', 'clv-demo'],
        ['shelf', 'info', 'clvshelf-1'], ['shelf', 'delete', 'clvshelf-20261014-120000x'], ['shelf', 'delete', 'clvshelf-20261014-12000a'],
        ['shelf', 'size', '../../etc'], ['shelf', 'launch', 'clvshelf-20261014-120000;id'],
        /* exec needs its separator; a shelf takes no memory or image of the caller's choosing. */
        ['shelf', 'exec', shelf, 'id', 'x'], ['shelf', 'launch', shelf, '--image', 'file:///etc/shadow'],
        ['shelf', 'erase', shelf], ['shelf', 'shell', shelf], ['shelf', 'room', 'extra'], ['shelf', 'list', 'all'],
        /* A conversation's verb never reaches a shelf. */
        ['vm', 'delete', shelf], ['vm', 'exec', shelf, '--', 'id'], ['vm', 'start', shelf],
        /* A clone: from a shelf, to one of our machines, with memory in bounds. */
        ['vm', 'clone', 'clv-other', 'clv-demo', '1024'], ['vm', 'clone', 'primary', 'clv-demo', '1024'], ['vm', 'clone', shelf, 'someone-else', '1024'],
        ['vm', 'clone', shelf, shelf, '1024'], ['vm', 'clone', shelf, 'clv-demo', '64'], ['vm', 'clone', shelf, 'clv-demo', '1024M'], ['vm', 'clone', shelf, 'clv-demo', '99999'],
        ['vm', 'clone', shelf, 'clv-demo'], ['vm', 'clone', shelf, 'clv-demo', '1024', '--extra'],
    ]) {
        const r = host(...args);
        assert.ok(r.code === 78 || r.code === 64, `${args.join(' ')} -> ${r.code}`);
        assert.equal(r.out, '', `nothing would run: ${args.join(' ')}`);
    }
});
