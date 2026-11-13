/* The privileged program, tried for real in its "say only" mode: what it
   would run for what the server asks, and what it refuses whoever asks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, lstatSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* Loopback addresses other than 127.0.0.1, built so that no address-shaped literal sits in the code. */
const at = (n) => ['127', '0', '0', String(n)].join('.');
import { ruleset } from '../server/network.mjs';

const PROGRAM = fileURLToPath(new URL('../deploy/clavarium-host', import.meta.url));
const host = (...args) => {
    const r = spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('each thing the server needs has one verb, turned into one exact command', () => {
    const cases = [
        [['vm', 'launch', 'clv-demo', '1024'], 'multipass launch 24.04 --name clv-demo --memory 1024M --disk 8G --cpus 1 --timeout 900'],
        [['vm', 'launch', 'clv-demo', '1024', '16', '1'], 'multipass launch 24.04 --name clv-demo --memory 1024M --disk 16G --cpus 1 --timeout 900'],
        [['vm', 'exec', 'clv-demo', '--', 'tmux', '-L', 'clavarium', 'has-session'], 'multipass exec clv-demo -- tmux -L clavarium has-session'],
        [['vm', 'info', 'clv-demo'], 'multipass info clv-demo --format json'],
        [['vm', 'ping'], 'timeout 30 multipass list --format csv'],
        [['vm', 'revive'], 'timeout 170 snap restart multipass.multipassd'],
        [['vm', 'start', 'clv-demo'], 'timeout 180 multipass start clv-demo'],
        [['vm', 'suspend', 'clv-demo'], 'timeout 120 multipass suspend clv-demo\nif its qemu still holds the RAM: multipass start clv-demo && multipass suspend clv-demo (wake+resleep)\nif it still does: multipass stop clv-demo (free it; it wakes by a boot)'],
        [['vm', 'reclaim', 'clv-demo'], "if clv-demo's qemu still holds the RAM: multipass start clv-demo && multipass suspend clv-demo (wake+resleep)\nif it still does: multipass stop clv-demo (free it; it wakes by a boot)"],
        [['vm', 'delete', 'clv-demo'], 'multipass delete --purge clv-demo'],
        [['vm', 'mount', 'clv-demo', 'folder', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/resources/reports clv-demo:/resources/reports'],
        [['vm', 'mount', 'clv-demo', 'view', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/views/reports clv-demo:/resources/reports'],
        [['vm', 'umount', 'clv-demo', 'reports'], 'multipass umount clv-demo:/resources/reports'],
        /* In a service of its own, never in the server's: a stop of the server leaves it be. */
        [['view', 'make', 'reports'], 'systemd-run --unit=clavarium-view-reports --collect bindfs -f -r -o allow_other /var/lib/clavarium/resources/reports /var/lib/clavarium/views/reports'],
        [['view', 'close', 'reports'], 'umount /var/lib/clavarium/views/reports'],
        [['mounts', 'repair'], 'umount -l <each FUSE view under /var/lib/clavarium that does not answer>'],
        [['folder', 'make', 'reports'], 'install -d -o OWNER -g GROUP -m 0755 /var/lib/clavarium/resources/reports'],
        [['work', 'make', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img 10240M mounted at /var/lib/clavarium/work/demo'],
        [['work', 'aside', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img put aside in /var/lib/clavarium/removed'],
        /* Deleted for good or reset by its owner (01-11): that one disk erased, nothing else. */
        [['work', 'erase', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img erased'],
        [['vm', 'mount', 'clv-demo', 'work', 'demo', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/work/demo clv-demo:/work'],
        [['vm', 'unwork', 'clv-demo'], 'multipass umount clv-demo:/work'],
        [['work', 'room', 'demo'], 'df /var/lib/clavarium/work/demo /var/lib/clavarium/work-disks'],
        [['net', 'taps'], 'pgrep -a qemu-system'],
        [['net', 'bridge'], 'ip -4 -o addr show <the bridge of the taps, else mpqemubr0>'],
        [['net', 'leases'], '<mac> <ip> of each lease in /var/snap/multipass/common/data/multipassd/network/dnsmasq.leases'],
        [['vm', 'clone', 'clvshelf-20261014-120000', 'clv-demo', '1024'], 'multipass clone clvshelf-20261014-120000 --name clv-demo\nmultipass set local.clv-demo.memory=1024M'],
        [['shelf', 'launch', 'clvshelf-20261014-120000'], 'multipass launch 24.04 --name clvshelf-20261014-120000 --memory 1536M --disk 8G --cpus 1 --timeout 900'],
        [['shelf', 'exec', 'clvshelf-20261014-120000', '--', 'sudo', '-n', 'snap', 'install', 'multipass-sshfs'], 'multipass exec clvshelf-20261014-120000 -- sudo -n snap install multipass-sshfs'],
        [['shelf', 'seal', 'clvshelf-20261014-120000'], 'multipass exec clvshelf-20261014-120000 -- sudo -n cloud-init clean --logs --machine-id\nmultipass stop clvshelf-20261014-120000'],
        [['shelf', 'info', 'clvshelf-20261014-120000'], 'multipass info clvshelf-20261014-120000 --format json'],
        [['shelf', 'delete', 'clvshelf-20261014-120000'], 'multipass delete --purge clvshelf-20261014-120000'],
        [['shelf', 'size', 'clvshelf-20261014-120000'], 'du -sm /var/snap/multipass/common/data/multipassd/vault/instances/clvshelf-20261014-120000'],
        [['shelf', 'room'], 'df /var/snap/multipass/common'],
        [['shelf', 'list'], 'multipass list --format csv (ready-made machines only)'],
        [['vm', 'stop', 'clv-demo'], 'timeout 120 multipass stop clv-demo'],
        [['vm', 'kill', 'clv-demo'], 'timeout 60 multipass stop --force clv-demo'],
        [['vm', 'set', 'clv-demo', 'memory', '2048'], 'multipass set local.clv-demo.memory=2048M'],
        [['vm', 'set', 'clv-demo', 'disk', '16'], 'multipass set local.clv-demo.disk=16G'],
        [['vm', 'size', 'clv-demo'], 'multipass get local.clv-demo.memory\nmultipass get local.clv-demo.disk\nmultipass get local.clv-demo.cpus'],
        [['tools', 'make'], 'install -d -o OWNER -g GROUP -m 0755 /var/lib/clavarium/toolbox/files\nsystemd-run --unit=clavarium-tools-view --collect bindfs -f -r -o allow_other /var/lib/clavarium/toolbox/files /var/lib/clavarium/toolbox/view'],
        [['vm', 'mount', 'clv-demo', 'tools', 'tools', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/toolbox/view clv-demo:/tools'],
        [['vm', 'untools', 'clv-demo'], 'multipass umount clv-demo:/tools'],
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
        /* Launch with a size: disk and cores within bounds, or refused (cores capped at this host's). */
        ['vm', 'launch', 'clv-demo', '1024', '3', '1'], ['vm', 'launch', 'clv-demo', '1024', '99999', '1'], ['vm', 'launch', 'clv-demo', '1024', '16', '99'], ['vm', 'launch', 'clv-demo', '1024', '16', '0'],
        ['vm', 'shell', 'clv-demo'], ['vm', 'set', 'local.driver=lxd'], ['vm', 'transfer', '/etc/shadow', 'clv-demo:/tmp/x'],
        ['net', 'flush'], ['host', 'run', 'id'], ['folder', 'make', '../x'], ['work', 'make', '../x'], ['work', 'aside', '/etc'], ['work', 'erase', '../x'], ['work', 'erase', '/etc'], ['work', 'room', '../x'], ['vm', 'unwork', 'primary'],
        /* A work folder goes to its own conversation's machine, never to another. */
        ['vm', 'mount', 'clv-other', 'work', 'demo', '0', '0'], ['vm', 'mount', 'clv-demo', 'work', '../demo', '0', '0'], ['folder', 'aside', '/etc'], ['folder', 'erase', 'reports'],
        /* Memory and disk only, of our machines only, within bounds; nothing else of the VM manager's settings. */
        ['vm', 'set', 'primary', 'memory', '2048'], ['vm', 'set', 'clv-demo', 'cpus', '8'], ['vm', 'set', 'clv-demo', 'memory', '100'], ['vm', 'set', 'clv-demo', 'memory', '2G'],
        ['vm', 'set', 'clv-demo', 'disk', '2'], ['vm', 'set', 'clv-demo', 'disk', '16G'], ['vm', 'set', 'clv-demo', 'disk', '99999'], ['vm', 'kill', 'primary'], ['vm', 'size', 'clvshelf-20261014-120000'],
        /* The tools: their read-only view only, under that one name, in our machines only. */
        ['vm', 'mount', 'clv-demo', 'tools', 'reports', '0', '0'], ['vm', 'mount', 'clv-demo', 'tools', '../toolbox', '0', '0'], ['vm', 'mount', 'primary', 'tools', 'tools', '0', '0'], ['vm', 'untools', 'primary'], ['vm', 'untools', 'clv-demo:/work'], ['tools', 'erase'],
    ]) assert.equal(host(...args).code, 78, args.join(' '));
    assert.equal(host('tools', 'make', 'reports').code, 64, 'it takes nothing');
    assert.equal(host('vm').code, 64);
    const aside = host('folder', 'aside', 'reports');
    assert.match(aside.out, /^mv -T -n \/var\/lib\/clavarium\/resources\/reports \/var\/lib\/clavarium\/removed\/reports-\d{8}T\d{6}Z-\d+$/, 'moved aside, never erased');
    /* Outside "say only", the data directory cannot be chosen by the caller. */
    const real = spawnSync('/bin/bash', [PROGRAM, '--data', '/tmp', 'net', 'taps'], { encoding: 'utf8' });
    assert.equal(real.status, 78);
});

test('the network rules the server writes are accepted whole; one foreign line refuses everything', () => {
    const good = ruleset({
        first: { tap: 'tap-15921f81452', mac: '52:54:00:aa:bb:cc', ip: `${at(10)}` },
        second: { tap: 'tap-918e9b07222', mac: '52:54:00:dd:ee:01' },
        third: { tap: 'tap-918e9b07333' },
    }, ['second'], '127.0.0.1');
    /* Every shape the anti-spoofing writes is in it: own address, unknown address, no MAC. */
    for (const shape of ['ether saddr != 52:54:00:aa:bb:cc drop', 'ether type != { ip, arp } drop', 'arp saddr ether != 52:54:00:aa:bb:cc drop',
        '@th,288,48 != 0x525400aabbcc drop', 'ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp dport 67 accept', `ip saddr != ${at(10)} drop`,
        `arp saddr ip != { 0.0.0.0, ${at(10)} } drop`, `ip saddr { 127.0.0.1, ${at(10)} } drop`, `arp saddr ip { 127.0.0.1, ${at(10)} } drop`]) assert.ok(good.includes(shape), shape);
    const accepted = host('net', 'apply', good);
    assert.equal(accepted.code, 0, accepted.err);
    assert.ok(accepted.out.startsWith('nft table bridge clavarium'));
    for (const extra of ['flush ruleset', 'table ip filter', '    iifname "tap-1" accept', '    iifname "eth0" drop', 'include "/etc/shadow"', '    iifname "tap-1" ip daddr 127.0.0.1 tcp dport 22 accept',
        /* Near misses of the anti-spoofing shapes: an accept for a drop, a capital, a field elsewhere, a set that lets in. */
        '    iifname "tap-1" ether saddr != 52:54:00:aa:bb:cc accept', '    iifname "tap-1" ether saddr 52:54:00:aa:bb:cc accept', '    iifname "tap-1" ether saddr != 52:54:00:AA:bb:cc drop',
        '    iifname "tap-1" ether type != { ip, arp, ip6 } drop', '    iifname "tap-1" ether type { ip, arp } accept', '    iifname "tap-1" arp saddr ether 52:54:00:aa:bb:cc accept',
        '    iifname "tap-1" udp dport 67 @th,0,48 != 0x525400aabbcc drop', '    iifname "tap-1" udp dport 68 @th,288,48 != 0x525400aabbcc drop',
        '    iifname "tap-1" ip saddr 0.0.0.0 udp dport 67 accept', '    iifname "tap-1" ip saddr 0.0.0.0 ip daddr 255.255.255.255 accept', `    iifname "tap-1" ip saddr ${at(10)} accept`,
        `    iifname "tap-1" ip saddr != { ${at(10)} } accept`, `    iifname "tap-1" arp saddr ip != { 0.0.0.0, ${at(10)} } accept`, '    iifname "tap-1" ip saddr { 127.0.0.1, } drop',
        '    iifname "tap-1" ip saddr { 127.0.0.1; flush ruleset } drop', `    iifname "tap-1" ip saddr != ${at(10)} drop; flush ruleset`]) {
        const r = host('net', 'apply', `${good}${extra}\n`);
        assert.equal(r.code, 78, extra);
        assert.equal(r.out, '');
    }
});

test('net leases takes nothing, and is not logged as a change', () => {
    assert.equal(host('net', 'leases', 'x').code, 64);
    const program = readFileSync(PROGRAM, 'utf8');
    assert.match(program, /"net taps"\|"net leases"\|/, 'a reading verb, polled: kept out of the system log');
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

/* THE GIT READER (deploy/clavarium-host "git read", deploy/git-read).
   What can be seen without root: the exact sandbox, the refusals, the
   mapping of how a unit ended to the codes the server trusts. What the
   sandbox really stops was tried as root: see the trial at the end of
   blueprint/git-runner-core.md. */
const withMnt = (...args) => {
    const r = spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', '--mnt', '/srv/clavarium-mnt', ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('git read: one sandbox, exactly this one, around one fixed script', () => {
    const r = withMnt('git', 'read', 'site');
    assert.equal(r.code, 0, r.err);
    const v = r.out.split('\n');
    assert.deepEqual(v.slice(0, 6), ['systemd-run', '--quiet', '--wait', '--pipe', '--service-type=exec', '--unit=clvread-site_RANDOM16']);
    assert.deepEqual(v.slice(-2), ['/usr/lib/clavarium/git-read', 'site']);
    const props = v.filter((x, i) => v[i - 1] === '-p');
    const envs = v.filter((x, i) => v[i - 1] === '-E');
    assert.deepEqual(props, [
        'DynamicUser=yes', 'RootDirectory=/var/lib/clavarium/runner-root', 'MountAPIVFS=no',
        /* /resources:ro: the sandbox's root keeps a mount point for every
           folder ever read; an empty /resources over it shows only this one. */
        'TemporaryFileSystem=/dev:ro /tmp:ro /var/tmp:ro /resources:ro', 'BindPaths=/dev/null /dev/zero /dev/urandom',
        'DevicePolicy=closed', 'DeviceAllow=/dev/null rw', 'DeviceAllow=/dev/zero r', 'DeviceAllow=/dev/urandom r',
        'BindReadOnlyPaths=/usr /usr/bin:/bin /usr/lib:/lib /usr/lib64:/lib64 /srv/clavarium-mnt/resources/site:/resources/site',
        'PrivateNetwork=yes', 'RestrictAddressFamilies=AF_UNIX', 'NoNewPrivileges=yes',
        'CapabilityBoundingSet=', 'AmbientCapabilities=', 'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes',
        'RestrictRealtime=yes', 'LockPersonality=yes', 'MemoryDenyWriteExecute=yes',
        'SystemCallArchitectures=native', 'SystemCallFilter=@system-service',
        'SystemCallFilter=~@aio @keyring @setuid @chown @memlock @privileged @resources userfaultfd kcmp process_vm_readv process_vm_writev msgget msgsnd msgrcv msgctl semget semop semctl shmget shmat shmdt shmctl mq_open mq_unlink',
        'SystemCallErrorNumber=EPERM',
        'RuntimeMaxSec=300', 'MemoryMax=1G', 'MemorySwapMax=0', 'TasksMax=8', 'CPUQuota=100%',
        'LimitFSIZE=0', 'LimitCORE=0', 'LimitNOFILE=256', 'WorkingDirectory=/resources/site',
    ]);
    assert.deepEqual(envs, ['PATH=/usr/bin', 'HOME=/nonexistent', 'XDG_CONFIG_HOME=/nonexistent', 'LC_ALL=C', 'GIT_CONFIG_NOSYSTEM=1',
        'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CEILING_DIRECTORIES=/resources', 'GIT_NO_LAZY_FETCH=1', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0', 'GIT_NO_REPLACE_OBJECTS=1']);
    /* Settings that were tried and bring back the host's /dev, /proc, IPC or root: never there. */
    for (const never of ['ProtectKernelTunables', 'ProtectControlGroups', 'ProtectProc', 'PrivateDevices', 'PrivateIPC', 'ProtectHostname', 'TemporaryFileSystem=/:', '--collect', '-G']) {
        assert.equal(r.out.includes(never), false, never);
    }
    /* Every line is one argument: none can be split into two. */
    assert.equal(v.length, 6 + 2 * props.length + 2 * envs.length + 2);
    assert.deepEqual(withMnt('git', 'stop', 'site').out.split('\n'), ['systemctl stop clvread-site_*.service', 'systemctl reset-failed clvread-site_*.service']);
});

test('everything root mounts, unmounts or moves is under MNT, never under the data directory the server owns', () => {
    /* The server owns the data directory: it could swap any directory there
       for a link between a check and a mount. So the folders, their views,
       the work folders, their disks and what is put aside all live on MNT. */
    const cases = [
        [['vm', 'mount', 'clv-demo', 'folder', 'site', '1', '2'], 'multipass mount -u 1:1000 -g 2:1000 /srv/clavarium-mnt/resources/site clv-demo:/resources/site'],
        [['vm', 'mount', 'clv-demo', 'view', 'site', '1', '2'], 'multipass mount -u 1:1000 -g 2:1000 /srv/clavarium-mnt/views/site clv-demo:/resources/site'],
        [['vm', 'mount', 'clv-demo', 'work', 'demo', '1', '2'], 'multipass mount -u 1:1000 -g 2:1000 /srv/clavarium-mnt/work/demo clv-demo:/work'],
        [['view', 'make', 'site'], 'systemd-run --unit=clavarium-view-site --collect bindfs -f -r -o allow_other /srv/clavarium-mnt/resources/site /srv/clavarium-mnt/views/site'],
        [['view', 'close', 'site'], 'umount /srv/clavarium-mnt/views/site'],
        [['folder', 'make', 'site'], 'install -d -o OWNER -g GROUP -m 0755 /srv/clavarium-mnt/resources/site'],
        [['work', 'make', 'demo'], 'disk /srv/clavarium-mnt/work-disks/demo.img 10240M mounted at /srv/clavarium-mnt/work/demo'],
        [['work', 'room', 'demo'], 'df /srv/clavarium-mnt/work/demo /srv/clavarium-mnt/work-disks'],
        [['work', 'aside', 'demo'], 'disk /srv/clavarium-mnt/work-disks/demo.img put aside in /srv/clavarium-mnt/removed'],
        [['tools', 'make'], 'install -d -o OWNER -g GROUP -m 0755 /srv/clavarium-mnt/toolbox/files\nsystemd-run --unit=clavarium-tools-view --collect bindfs -f -r -o allow_other /srv/clavarium-mnt/toolbox/files /srv/clavarium-mnt/toolbox/view'],
        [['vm', 'mount', 'clv-demo', 'tools', 'tools', '1', '2'], 'multipass mount -u 1:1000 -g 2:1000 /srv/clavarium-mnt/toolbox/view clv-demo:/tools'],
    ];
    for (const [args, expected] of cases) assert.deepEqual(withMnt(...args), { code: 0, out: expected, err: '' }, args.join(' '));
    assert.match(withMnt('folder', 'aside', 'site').out, /^mv -T -n \/srv\/clavarium-mnt\/resources\/site \/srv\/clavarium-mnt\/removed\/site-/);
    /* Outside "say only", every one of these directories is checked by `held`, with the chain above it. */
    const text = readFileSync(PROGRAM, 'utf8');
    const body = text.slice(text.indexOf('kept() {'), text.indexOf('# A folder of ours'));
    assert.match(body, /local d="\$MNT\/\$1"/);
    assert.match(body, /\n {4}held "\$d"\n/, 'kept holds every directory, not only resources');
    assert.doesNotMatch(text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n'), /\$DATA\/(views|work|work-disks|removed|resources|toolbox)/, 'no root path under the data directory');
});

test('held: the check before each use refuses a link, a component of another account, one others may write', { skip: process.getuid() === 0 ? 'run as root: the refusals tried here are of an ordinary account' : process.env.CI ? 'reads the layout of this very machine (/usr, /home, /tmp): a CI runner\'s is not a server\'s; run on the server by npm run check' : false }, () => {
    const held = (path) => withMnt('path', 'held', path);
    assert.deepEqual(held('/usr/share'), { code: 0, out: 'held: /usr/share', err: '' }, 'root\'s from / down');
    /* /tmp may be written by anyone: nothing under it is held. */
    const dir = mkdtempSync(join(tmpdir(), 'clv-held-'));
    try {
        mkdirSync(join(dir, 'views', 'site'), { recursive: true });
        assert.equal(held(join(dir, 'views', 'site')).code, 78);
        assert.match(held(join(dir, 'views', 'site')).err, /\/tmp may be written by others than root|does not belong to root/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    /* A component that belongs to this account (the checkout itself, under a home). */
    const mine = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
    assert.match(held(`${mine}/test`).err, /does not belong to root|has an access list|may be written by others than root/, "refused: not root's, or a list lets others write it (a checkout under /tmp: /tmp itself)");
    /* A link anywhere on the way (merged /usr: /bin is one). */
    let binIsLink = false; try { binIsLink = lstatSync('/bin').isSymbolicLink(); } catch { /* none */ }
    if (binIsLink) assert.match(held('/bin/anything').err, /\/bin is not a plain directory/);
    assert.match(held('/usr/share/no-such-entry-here').err, /not a plain directory/);
    assert.equal(spawnSync('/bin/bash', [PROGRAM, 'path', 'held', '/usr/share']).status, 78, 'only in "say only"');
});

test('git read refuses any name but a folder\'s, never reads a reference, and takes nothing else', () => {
    for (const args of [
        ['git', 'read', '../etc'], ['git', 'read', '-f'], ['git', 'read', 'a_b'], ['git', 'read', 'Site'], ['git', 'read', 'site-origin'],
        ['git', 'read', ''], ['git', 'read', 'a/b'], ['git', 'read', 'x'.repeat(33)], ['git', 'read', 'site;id'], ['git', 'stop', '../x'], ['git', 'stop', 'a_b'],
        ['git', 'clone', 'site'], ['git', 'push', 'site'],
    ]) {
        const r = withMnt(...args);
        assert.equal(r.code, 78, args.join(' '));
        assert.equal(r.out, '', `nothing would run: ${args.join(' ')}`);
    }
    for (const args of [['git', 'read'], ['git', 'read', 'site', 'extra'], ['git', 'stop']]) assert.equal(withMnt(...args).code, 64, args.join(' '));
    /* The two other ways, and only them: --tips alone; --have and 1 to 256 full object ids. */
    const ID = 'a'.repeat(40);
    assert.deepEqual(withMnt('git', 'read', 'site', '--tips').out.split('\n').slice(-3), ['/usr/lib/clavarium/git-read', 'site', '--tips']);
    assert.deepEqual(withMnt('git', 'read', 'site', '--have', ID, 'b'.repeat(40)).out.split('\n').slice(-5), ['/usr/lib/clavarium/git-read', 'site', '--have', ID, 'b'.repeat(40)]);
    assert.equal(withMnt('git', 'read', 'site', '--have', ...Array(256).fill(ID)).code, 0);
    for (const args of [['--tips', 'x'], ['--have'], ['--have', ...Array(257).fill(ID)], ['--tips', '--have', ID], ['--pack']]) assert.equal(withMnt('git', 'read', 'site', ...args).code, 64, args.join(' ').slice(0, 60));
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)};`, '-x', '']) {
        const r = withMnt('git', 'read', 'site', '--have', ID, bad);
        assert.deepEqual([r.code, r.out], [78, ''], `refused, nothing run: ${bad}`);
    }
    /* MNT is a path of plain characters, honoured only in "say only". */
    for (const bad of ['relative', '/a b', '/a:b', '/a/../b']) assert.equal(spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/x', '--mnt', bad, 'net', 'taps']).status, 78, bad);
    assert.equal(spawnSync('/bin/bash', [PROGRAM, '--mnt', '/tmp', 'net', 'taps']).status, 78);
    /* "git code" exists only to be tested: it does nothing, and nothing outside "say only". */
    assert.equal(spawnSync('/bin/bash', [PROGRAM, 'git', 'code', 'exit-code', '1', '0']).status, 78);
});

test('how a read ended is said from what systemd recorded: fixed codes only', () => {
    const code = (...args) => withMnt('git', 'code', ...args).out;
    assert.equal(code('exit-code', '1', '128'), '65');
    assert.equal(code('exit-code', '1', '3'), '67');
    for (const status of ['1', '2', '66', '78', '127', '199', '244', '255']) assert.equal(code('exit-code', '1', status), '66', status);
    for (const status of ['200', '203', '226', '243']) assert.equal(code('exit-code', '1', status), '79', `systemd's own ${status}`);
    assert.equal(code('timeout', '1', '0'), '80');
    assert.equal(code('oom-kill', '2', '9'), '81');
    assert.equal(code('signal', '2', '13'), '82');
    assert.equal(code('core-dump', '3', '11'), '82');
    for (const [result, how, status] of [['resources', '0', '0'], ['', '', ''], ['start-limit-hit', '0', '0'], ['exit-code', '2', '9'], ['exit-code', '1', 'x']]) assert.equal(code(result, how, status), '79', `${result}/${how}/${status}`);
});

test('the reader script, with a real git: healthy shapes of refs are read, never said to be broken', () => {
    const READER = fileURLToPath(new URL('../deploy/git-read', import.meta.url));
    const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
    const dir = mkdtempSync(join(tmpdir(), 'clv-reader-real-'));
    const g = (cwd, ...argv) => { const r = spawnSync('git', argv, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    /* A repository with main and next as loose refs, as an agent leaves it. */
    const made = (name) => {
        const repo = join(dir, name); mkdirSync(repo);
        g(repo, 'init', '--quiet', '--initial-branch=main');
        writeFileSync(join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '--quiet', '-m', 'one');
        const first = g(repo, 'rev-parse', 'HEAD');
        g(repo, 'switch', '--quiet', '-c', 'next');
        writeFileSync(join(repo, 'b.txt'), 'b\n'); g(repo, 'add', 'b.txt'); g(repo, 'commit', '--quiet', '-m', 'two');
        g(repo, 'switch', '--quiet', 'main');
        writeFileSync(join(repo, 'c.txt'), 'c\n'); g(repo, 'add', 'c.txt'); g(repo, 'commit', '--quiet', '-m', 'three');
        return { repo, first, main: g(repo, 'rev-parse', 'main'), next: g(repo, 'rev-parse', 'next') };
    };
    const read = (repo, name, ...how) => spawnSync('sh', [READER, name, ...how], { cwd: repo, env, encoding: 'latin1' });
    const header = (r) => r.stdout.slice(0, r.stdout.indexOf('\n\nPACK'));
    try {
        /* Loose main and next; packed-refs holds its header line and a remote's branch only. */
        const docket = made('docket');
        writeFileSync(join(docket.repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${docket.first} refs/remotes/origin/main\n`);
        let r = read(docket.repo, 'docket');
        assert.deepEqual([r.status, r.stderr], [0, ''], r.stderr);
        assert.equal(header(r), `# v2 git bundle\n${docket.main} refs/heads/main\n${docket.next} refs/heads/next`);
        /* Loose main and next, and an older main in packed-refs: the loose one wins, for git and here. */
        const gambeli = made('gambeli');
        writeFileSync(join(gambeli.repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${gambeli.first} refs/heads/main\n`);
        r = read(gambeli.repo, 'gambeli');
        assert.deepEqual([r.status, r.stderr], [0, ''], r.stderr);
        assert.equal(header(r), `# v2 git bundle\n${gambeli.main} refs/heads/main\n${gambeli.next} refs/heads/next`);
        /* Loose main and main-clean; packed-refs holds main and next, next nowhere else (HEAD on it): next is read. */
        const gregoire = made('gregoire');
        g(gregoire.repo, 'branch', 'main-clean', gregoire.next);
        writeFileSync(join(gregoire.repo, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${gregoire.next} refs/heads/main\n${gregoire.next} refs/heads/next\n`);
        rmSync(join(gregoire.repo, '.git', 'refs', 'heads', 'next'));
        writeFileSync(join(gregoire.repo, '.git', 'HEAD'), 'ref: refs/heads/next\n');
        r = read(gregoire.repo, 'gregoire');
        assert.deepEqual([r.status, r.stderr], [0, ''], r.stderr);
        assert.equal(header(r), `# v2 git bundle\n${gregoire.main} refs/heads/main\n${gregoire.next} refs/heads/main-clean\n${gregoire.next} refs/heads/next`);
        /* LIST ONLY: the header and nothing more, after the same checks. */
        r = read(gregoire.repo, 'gregoire', '--tips');
        assert.deepEqual([r.status, r.stdout], [0, `# v2 git bundle\n${gregoire.main} refs/heads/main\n${gregoire.next} refs/heads/main-clean\n${gregoire.next} refs/heads/next\n\n`], r.stderr);
        /* PARTIAL: what the commits had reach is left out; the header is the same whole list. */
        const all = read(docket.repo, 'docket');
        const part = read(docket.repo, 'docket', '--have', docket.first, 'f'.repeat(40));
        assert.equal(part.status, 0, part.stderr);
        assert.equal(header(part), header(all), 'every branch listed, moved or not');
        const objects = (bytes) => bytes.readUInt32BE(bytes.indexOf('PACK', 0, 'latin1') + 8);
        const wholeCount = objects(Buffer.from(all.stdout, 'latin1')); const partCount = objects(Buffer.from(part.stdout, 'latin1'));
        assert.ok(partCount < wholeCount, `fewer objects travel (${partCount} of ${wholeCount})`);
        /* Into a repository that has what was left out, the partial pack is whole; into an empty one, it is refused. */
        const into = (alternate) => {
            const ws = join(dir, `ws-${Math.random().toString(16).slice(2)}`);
            g(dir, 'init', '--quiet', '--bare', ws);
            if (alternate) writeFileSync(join(ws, 'objects', 'info', 'alternates'), `${join(alternate, '.git', 'objects')}\n`);
            const pack = Buffer.from(part.stdout, 'latin1'); const at = pack.indexOf('PACK', 0, 'latin1');
            return spawnSync('git', ['index-pack', '--stdin', '--strict'], { cwd: ws, env: { ...env, GIT_DIR: ws }, input: pack.subarray(at) }).status;
        };
        const had = join(dir, 'had'); mkdirSync(had);
        g(had, 'init', '--quiet'); g(had, 'fetch', '--quiet', docket.repo, `${docket.first}:refs/heads/had`);
        assert.deepEqual([into(had), into(null)], [0, 128]);
        /* Every have it does not know (another id, not a commit) is dropped, never an error: a pack of all. */
        const tree = g(docket.repo, 'rev-parse', `${docket.first}^{tree}`);
        const none = read(docket.repo, 'docket', '--have', 'f'.repeat(40), tree);
        assert.deepEqual([none.status, objects(Buffer.from(none.stdout, 'latin1'))], [0, wholeCount]);
        /* Its arguments, checked by the reader too; and its refusals are a read's. */
        for (const args of [['--have'], ['--have', 'xyz'], ['--have', 'A'.repeat(40)], ['--tips', 'x'], ['--other'], ['--have', ...Array(257).fill(docket.first)]]) {
            const bad = read(docket.repo, 'docket', ...args);
            assert.deepEqual([bad.status, bad.stderr.trim(), bad.stdout], [66, 'BAD ARGUMENTS', ''], args.join(' ').slice(0, 60));
        }
        for (const how of [['--tips'], ['--have', docket.first]]) {
            writeFileSync(join(docket.repo, '.git', 'refs', 'heads', 'broken'), 'not an id\n');
            let bad = read(docket.repo, 'docket', ...how);
            assert.deepEqual([bad.status, bad.stderr.trim().split('\n').pop(), bad.stdout], [66, 'BROKEN OR CHANGING REFS', ''], how[0]);
            rmSync(join(docket.repo, '.git', 'refs', 'heads', 'broken'));
            writeFileSync(join(docket.repo, '.git', 'shallow'), `${docket.first}\n`);
            bad = read(docket.repo, 'docket', ...how);
            assert.deepEqual([bad.status, bad.stderr.trim(), bad.stdout], [66, 'SHALLOW REPOSITORY', ''], how[0]);
            rmSync(join(docket.repo, '.git', 'shallow'));
            renameSync(join(docket.repo, '.git'), join(docket.repo, 'moved'));
            writeFileSync(join(docket.repo, '.git'), 'gitdir: moved\n');
            bad = read(docket.repo, 'docket', ...how);
            assert.deepEqual([bad.status, bad.stderr.trim(), bad.stdout], [66, 'NOT A PLAIN .git DIRECTORY', ''], how[0]);
            rmSync(join(docket.repo, '.git')); renameSync(join(docket.repo, 'moved'), join(docket.repo, '.git'));
        }
        /* No branch: listed as none, 128, the 17 bytes, in both ways. */
        const bare = join(dir, 'bare'); mkdirSync(bare); g(bare, 'init', '--quiet');
        for (const how of [['--tips'], ['--have', docket.first]]) assert.deepEqual([read(bare, 'bare', ...how).status, read(bare, 'bare', ...how).stdout], [128, '# v2 git bundle\n\n'], how[0]);
        /* A ref file replaced while still open, kept by a shared folder (FUSE) under a dot name, and a dot folder: no refs, for git either. */
        writeFileSync(join(gambeli.repo, '.git', 'refs', 'heads', '.fuse_hidden0000002a00000003'), `${gambeli.first}\n`);
        mkdirSync(join(gambeli.repo, '.git', 'refs', 'heads', '.hidden'));
        writeFileSync(join(gambeli.repo, '.git', 'refs', 'heads', '.hidden', 'x'), `${gambeli.first}\n`);
        r = read(gambeli.repo, 'gambeli');
        assert.deepEqual([r.status, header(r)], [0, `# v2 git bundle\n${gambeli.main} refs/heads/main\n${gambeli.next} refs/heads/next`], r.stderr);
        /* What git does skip is still refused: a broken file, a symbolic ref pointing nowhere. */
        for (const [file, text] of [['broken', 'not an id\n'], ['nowhere', 'ref: refs/heads/gone\n']]) {
            writeFileSync(join(gambeli.repo, '.git', 'refs', 'heads', file), text);
            r = read(gambeli.repo, 'gambeli');
            assert.deepEqual([r.status, r.stderr.trim().split('\n').pop(), r.stdout], [66, 'BROKEN OR CHANGING REFS', ''], file);
            rmSync(join(gambeli.repo, '.git', 'refs', 'heads', file));
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the reader script: a plain .git only, readable refs only, every ref git skips refused, and git\'s own codes folded into the fixed ones', () => {
    const READER = fileURLToPath(new URL('../deploy/git-read', import.meta.url));
    const text = readFileSync(READER, 'utf8');
    for (const setting of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.pager=cat', 'core.alternateRefsCommand=', 'protocol.allow=never', 'pack.threads=1', 'pack.windowMemory=256m', 'pack.useBitmaps=false']) assert.ok(text.includes(`-c ${setting}`), setting);
    /* The bundle is built from one listing, never by `git bundle create`, which resolves each name again and may leave one out. */
    assert.match(text, /for-each-ref --format='%\(objectname\) %\(refname\)' refs\/heads\//);
    assert.match(text, /pack-objects --stdout --revs/);
    assert.doesNotMatch(text.split('\n').filter((l) => !l.startsWith('#')).join('\n'), /bundle create/);
    const ID = 'a'.repeat(40);
    /* A stand-in git: the object format, a listing, and a pack-objects that ends with `pack`. */
    const standIn = (dir, { format = 'sha1', listing = `${ID} refs/heads/main`, pack = 'exit 0' } = {}) => {
        writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$*" in\n  *rev-parse*) echo ${format} ;;\n  *for-each-ref*) ${listing ? `echo "${listing}"` : 'true'} ;;\n  *pack-objects*) cat >/dev/null; printf PACK; ${pack} ;;\nesac\n`);
        chmodSync(join(dir, 'git'), 0o755);
        writeFileSync(join(dir, 'reader'), text.replace('/usr/bin/git', join(dir, 'git')));
    };
    const dir = mkdtempSync(join(tmpdir(), 'clv-reader-'));
    try {
        mkdirSync(join(dir, 'repo', '.git', 'refs', 'heads'), { recursive: true });
        writeFileSync(join(dir, 'repo', '.git', 'refs', 'heads', 'main'), `${ID}\n`);
        const run = () => spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'latin1' });
        /* git's exit codes: only 0 passes; a signal stays a signal. */
        for (const [exit, expected] of [['exit 0', 0], ['exit 3', 66], ['exit 128', 66], ['exit 78', 66], ['exit 200', 66], ['exit 1', 66], ['kill -s 9 $$', null]]) {
            standIn(dir, { pack: exit });
            const r = run();
            assert.equal(r.status, expected, exit);
            if (expected === null) assert.equal(r.signal, 'SIGKILL');
            else assert.ok(r.stdout.startsWith(`# v2 git bundle\n${ID} refs/heads/main\n\nPACK`), r.stdout);
        }
        /* A ref on disk that the listing does not have (git skipped it): refused, never left out. */
        writeFileSync(join(dir, 'repo', '.git', 'refs', 'heads', 'loop'), 'ref: refs/heads/loop\n');
        standIn(dir);
        let r = run();
        assert.deepEqual([r.status, r.stderr.trim(), r.stdout], [66, 'BROKEN OR CHANGING REFS', '']);
        rmSync(join(dir, 'repo', '.git', 'refs', 'heads', 'loop'));
        /* A lock file is not a ref, for git either. */
        writeFileSync(join(dir, 'repo', '.git', 'refs', 'heads', 'main.lock'), `${ID}\n`);
        assert.equal(run().status, 0);
        rmSync(join(dir, 'repo', '.git', 'refs', 'heads', 'main.lock'));
        /* A packed branch counts as on disk. */
        writeFileSync(join(dir, 'repo', '.git', 'packed-refs'), `# pack-refs with: peeled\n${ID} refs/heads/side\n`);
        assert.equal(run().stderr.trim(), 'BROKEN OR CHANGING REFS');
        standIn(dir, { listing: `${ID} refs/heads/main\n${ID} refs/heads/side` });
        assert.equal(run().status, 0);
        /* Nothing of coreutils needed: with a sort and a cut that crash (as the Rust ones did in the sandbox),
           the same repository is read, its two branches compared and packed. */
        mkdirSync(join(dir, 'crash'));
        /* One call in two crashes: one list made, the other empty -- what refused healthy repositories. */
        for (const tool of ['sort', 'cut', 'uniq', 'wc', 'head', 'tr']) { writeFileSync(join(dir, 'crash', tool), `#!/bin/sh\nn=$(cat "${join(dir, 'crash', 'count')}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${join(dir, 'crash', 'count')}"\nif [ $((n % 2)) -eq 0 ]; then echo "Aborted (core dumped)" >&2; exit 134; fi\nexec /usr/bin/${tool} "$@"\n`); chmodSync(join(dir, 'crash', tool), 0o755); }
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'latin1', env: { ...process.env, PATH: `${join(dir, 'crash')}:${process.env.PATH}` } });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.startsWith(`# v2 git bundle\n${ID} refs/heads/main\n${ID} refs/heads/side\n\nPACK`), r.stdout);
        rmSync(join(dir, 'repo', '.git', 'packed-refs'));
        /* No branch: exactly the 17 bytes of an empty bundle, and 128. */
        rmSync(join(dir, 'repo', '.git', 'refs', 'heads', 'main'));
        standIn(dir, { listing: '' });
        r = run();
        assert.deepEqual([r.status, r.stdout], [128, '# v2 git bundle\n\n']);
        writeFileSync(join(dir, 'repo', '.git', 'refs', 'heads', 'main'), `${ID}\n`);
        /* Not SHA-1; shallow; grafts: said, nothing written. */
        standIn(dir, { format: 'sha256' });
        assert.deepEqual([run().status, run().stderr.trim(), run().stdout], [66, 'NOT SHA-1', '']);
        standIn(dir);
        for (const file of ['shallow', 'info/grafts']) {
            mkdirSync(join(dir, 'repo', '.git', 'info'), { recursive: true });
            writeFileSync(join(dir, 'repo', '.git', file), `${ID}\n`);
            r = run();
            assert.deepEqual([r.status, r.stderr.trim(), r.stdout], [66, 'SHALLOW REPOSITORY', ''], file);
            rmSync(join(dir, 'repo', '.git', file));
        }
        /* A gitfile, a link, a commondir: refused before git runs. */
        writeFileSync(join(dir, 'git'), '#!/bin/sh\necho RAN >&2\nexit 0\n');
        writeFileSync(join(dir, 'reader'), text.replace('/usr/bin/git', join(dir, 'git')));
        writeFileSync(join(dir, 'repo', '.git', 'commondir'), '../elsewhere');
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'utf8' });
        assert.deepEqual([r.status, r.stderr.trim()], [66, 'NOT A PLAIN .git DIRECTORY']);
        rmSync(join(dir, 'repo', '.git'), { recursive: true });
        writeFileSync(join(dir, 'repo', '.git'), 'gitdir: /elsewhere\n');
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'utf8' });
        assert.deepEqual([r.status, r.stderr.trim()], [66, 'NOT A PLAIN .git DIRECTORY']);
        rmSync(join(dir, 'repo', '.git'));
        mkdirSync(join(dir, 'real', 'refs', 'heads'), { recursive: true });
        symlinkSync(join(dir, 'real'), join(dir, 'repo', '.git'));
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'utf8' });
        assert.deepEqual([r.status, r.stderr.trim()], [66, 'NOT A PLAIN .git DIRECTORY']);
        /* A ref directory that cannot be read: 3, said, never an empty repository. */
        rmSync(join(dir, 'repo', '.git'));
        mkdirSync(join(dir, 'repo', '.git', 'refs', 'heads', 'feat'), { recursive: true });
        chmodSync(join(dir, 'repo', '.git', 'refs', 'heads', 'feat'), 0o000);
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'utf8' });
        chmodSync(join(dir, 'repo', '.git', 'refs', 'heads', 'feat'), 0o755);
        assert.deepEqual([r.status, r.stderr.trim()], [3, 'REFS UNREADABLE']);
        /* A ref directory linked elsewhere is checked where git reads it. */
        rmSync(join(dir, 'repo', '.git', 'refs'), { recursive: true });
        mkdirSync(join(dir, 'other', 'heads', 'x'), { recursive: true });
        symlinkSync(join(dir, 'other'), join(dir, 'repo', '.git', 'refs'));
        chmodSync(join(dir, 'other', 'heads', 'x'), 0o000);
        r = spawnSync('sh', [join(dir, 'reader'), 'repo'], { cwd: join(dir, 'repo'), encoding: 'utf8' });
        chmodSync(join(dir, 'other', 'heads', 'x'), 0o755);
        assert.equal(r.status, 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* The host allowed a disk of 2048 GB while the server stops at 256, and grew
   one whatever room was left where the VM manager keeps its disks. */
test('a disk grows only within the server\'s bound, and only when the host has the room for it', () => {
    assert.equal(host('vm', 'set', 'clv-demo', 'disk', '256').code, 0);
    assert.equal(host('vm', 'set', 'clv-demo', 'disk', '257').code, 78);
    assert.equal(host('vm', 'set', 'clv-demo', 'disk', '2048').code, 78);
    /* What it grows by may all be filled, and 6144 MB must stay free. */
    assert.equal(host('disk', 'room', '8', '20', String(12 * 1024 + 6144)).code, 0);
    const short = host('disk', 'room', '8', '20', String(12 * 1024 + 6143));
    assert.equal(short.code, 78);
    assert.match(short.err, /growing this disk from 8 to 20 GB needs 18432 MB/);
    assert.equal(host('disk', 'room', '8', '8', '6144').code, 0, 'nothing more: only the minimum');
    assert.equal(spawnSync('/bin/bash', [PROGRAM, 'disk', 'room', '8', '20', '999999']).status, 78, 'only in "say only"');
    /* The size the VM manager says, in whole gigabytes. */
    const sizes = spawnSync('/bin/bash', ['-c', `source <(sed -n '/^size_gb()/,/^}/p' "$0"); for v in 8.0GiB 16G 20480M 10737418240 1T bad; do printf '%s=%s\\n' "$v" "$(size_gb "$v")"; done`, PROGRAM], { encoding: 'utf8' });
    assert.equal(sizes.stdout, '8.0GiB=8\n16G=16\n20480M=20\n10737418240=10\n1T=1024\nbad=\n');
});

test('what the server has left and what takes the room: two read-only verbs that take no argument at all', () => {
    assert.deepEqual(host('server', 'room'), { code: 0, out: 'df /var/snap/multipass/common /var/lib/clavarium /var/lib/clavarium\n/proc/meminfo\nresident memory of the processes of our machines', err: '' });
    assert.match(host('server', 'usage').out, /^du \/var\/lib\/clavarium \/var\/lib\/clavarium\/resources .*\ndu \/var\/snap\/multipass\/common\/data\/multipassd\/vault\/instances \/var\/snap\/multipass\/common\/cache$/);
    for (const verb of ['room', 'usage']) {
        for (const extra of [['/etc'], ['clv-demo'], ['--', 'sh']]) assert.equal(host('server', verb, ...extra).code, 64, `${verb} ${extra.join(' ')}`);
    }
    assert.equal(host('server', 'clean').code, 78, 'nothing but these two');
});

test('updates: the updater of the release that runs, asked only in the forms it knows; apply and rollback go to its own service', () => {
    const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    assert.equal(say('update', 'check').stdout, '/opt/clavarium/current/node/bin/node /opt/clavarium/current/app/deploy/updater.mjs check\n');
    assert.equal(say('update', 'set', 'window', '01:00-04:30').stdout, '/opt/clavarium/current/node/bin/node /opt/clavarium/current/app/deploy/updater.mjs set window 01:00-04:30\n');
    assert.equal(say('update', 'set', 'channel', 'beta').stdout, '/opt/clavarium/current/node/bin/node /opt/clavarium/current/app/deploy/updater.mjs set channel beta\n');
    assert.equal(say('update', 'apply', '0.2.0-next.3').stdout, 'echo apply 0.2.0-next.3 > /var/lib/clavarium/update/request\nsystemctl start --no-block clavarium-update.service\n');
    assert.equal(say('update', 'rollback', 'local-20261018-010203').status, 0);
    for (const bad of [['update', 'check', 'x'], ['update', 'set', 'mode', 'always'], ['update', 'set', 'channel', 'alpha'], ['update', 'set', 'window', '03:00-03:00'], ['update', 'set', 'registry', 'http://x'],
        ['update', 'apply', '1.0'], ['update', 'apply', '1.0.0 --registry=x'], ['update', 'apply', 'local-20261018-010203'], ['update', 'rollback', '../1.0.0'], ['update', 'install', '1.0.0']]) {
        const r = say(...bad);
        assert.ok(r.status === 78 || r.status === 64, `${bad.join(' ')}: ${r.status}`);
        assert.equal(r.stdout, '', bad.join(' '));
    }
});

test('machines old / forget-old: read-only size, and no removal when nothing was moved', () => {
    const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    assert.equal(say('machines', 'old').status, 0);
    assert.equal(say('machines', 'old', 'x').status, 64);
    const f = say('machines', 'forget-old');
    assert.ok(f.status === 78 || f.status === 0, String(f.status));
    if (f.status === 0) assert.match(f.stdout, /rm -rf \/var\/snap\/multipass\/common\/data\/multipassd\/vault/);
});

test('server logs / restart: a source and a span from fixed lists only', () => {
    const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    assert.match(say('server', 'logs', 'system', 'boot').stdout, /journalctl -k -b/);
    assert.match(say('server', 'logs', 'machines', '24').stdout, /snap\.multipass\.multipassd\.service --since -24h/);
    for (const bad of [['clavarium', '2'], ['../x', '1'], ['clavarium', '1;id']]) assert.equal(say('server', 'logs', ...bad).status, 78, bad.join(' '));
    assert.equal(say('server', 'logs', 'clavarium').status, 64);
    assert.match(say('server', 'restart').stdout, /systemctl restart clavarium\.service/);
    assert.equal(say('server', 'restart', 'now').status, 64);
    assert.match(say('server', 'reboot').stdout, /systemctl reboot/);
    assert.equal(say('server', 'reboot', 'now').status, 64);
    assert.match(say('server', 'protect').stdout, /OOMScoreAdjust=-900 for clavarium caddy dex oauth2-proxy ssh/);
    assert.equal(say('server', 'protect', 'x').status, 64);
});

test('disks room / grow: read-only, and grown only at the system or under /mnt, /media, /home', () => {
    const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    assert.equal(say('disks', 'room').status, 0);
    assert.equal(say('disks', 'room', 'x').status, 64);
    assert.match(say('disks', 'grow', '/').stdout, /lvextend -r -l \+100%FREE/);
    for (const bad of ['/etc', '/var/lib', 'relative', '/mnt/../etc', '/mnt/a b']) assert.equal(say('disks', 'grow', bad).status, 78, bad);
});

test('meshcentral: each verb maps to one exact thing, and the turn-on runs in a unit of its own', () => {
    const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { encoding: 'utf8' });
    assert.match(say('meshcentral', 'install').stdout, /npm install --prefix \/var\/lib\/clavarium-meshcentral --omit=dev meshcentral@/);
    assert.match(say('meshcentral', 'start').stdout, /ProtectSystem=strict/);
    assert.match(say('meshcentral', 'start').stdout, /import \/etc\/caddy\/clavarium-meshcentral\.caddy/);
    assert.match(say('meshcentral', 'stop').stdout, /systemctl disable --now clavarium-meshcentral\.service/);
    assert.match(say('meshcentral', 'enable').stdout, /systemd-run --unit=clavarium-meshcentral-setup --collect/);
    assert.match(say('meshcentral', 'uninstall').stdout, /rm -rf \/var\/lib\/clavarium-meshcentral/);
    /* No argument is taken by any of them. */
    for (const v of ['status', 'install', 'start', 'stop', 'enable', 'disable', 'uninstall']) assert.equal(say('meshcentral', v, 'x').status, 64, v);
    assert.equal(say('meshcentral', 'nonsense').status, 78);
});

test('meshcentral status: installed, running, version, url read from the real files; the route added and removed in the front', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mesh-'));
    const run = (...args) => spawnSync('/bin/bash', [PROGRAM, '--test', dir, 'meshcentral', ...args], { encoding: 'utf8' });
    /* Nothing installed yet. */
    let s = run('status');
    assert.match(s.stdout, /installed no/); assert.match(s.stdout, /running no/); assert.match(s.stdout, /version none/);
    /* Made to look installed, with a front that names the server. */
    mkdirSync(join(dir, 'mesh', 'node_modules', 'meshcentral'), { recursive: true });
    mkdirSync(join(dir, 'mesh', 'meshcentral-data'), { recursive: true });
    writeFileSync(join(dir, 'mesh', 'node_modules', 'meshcentral', 'package.json'), '{"version":"1.1.35"}');
    writeFileSync(join(dir, 'mesh', 'meshcentral-data', 'config.json'), '{}');
    writeFileSync(join(dir, 'Caddyfile'), 'clav.example.com {\n\thandle {\n\t\treverse_proxy 127.0.0.1:4180\n\t}\n}\n');
    s = run('status');
    assert.match(s.stdout, /installed yes/);
    assert.match(s.stdout, /version 1\.1\.35/);
    assert.match(s.stdout, /url https:\/\/clav\.example\.com\/meshcentral-test\//);
    /* A turn-on recorded but no unit running is read as interrupted, not still going. */
    mkdirSync(join(dir, 'meshcentral'), { recursive: true });
    writeFileSync(join(dir, 'meshcentral', 'last'), 'step installing 1792000000\n');
    assert.match(run('status').stdout, /step interrupted/);
    rmSync(dir, { recursive: true, force: true });
});

/* THE WAY DOWN (vm halt, vm hardstop), said first: the plan, step by step, in "say only". */
test('vm halt and vm hardstop say their steps; a step out of order or a VM not ours is refused', () => {
    const HALT = [
        'before each step: if no qemu is left for clv-demo (and it is not asleep), straight to the check',
        'step polite: timeout 60 multipass stop clv-demo',
        'step force: timeout 30 multipass stop --force clv-demo',
        'step term: kill -TERM <the qemu of clv-demo, proven by its disk>, waited 5s',
        'step kill: kill -KILL <the qemu of clv-demo, proven by its disk>, waited 5s',
        'step check: no qemu left for clv-demo, and multipass says Stopped (within 10s)',
    ];
    assert.deepEqual(host('vm', 'halt', 'clv-demo'), { code: 0, out: HALT.join('\n'), err: '' });
    assert.deepEqual(host('vm', 'halt', 'clv-demo', 'polite', 'force').out, [...HALT.slice(0, 3), HALT[5]].join('\n'), 'its own ways only, for an owner who asked so');
    assert.deepEqual(host('vm', 'halt', 'clv-demo', 'term').out, [HALT[0], ...HALT.slice(3)].join('\n'));
    assert.deepEqual(host('vm', 'hardstop', 'clv-demo'), { code: 0, out: [HALT[0], ...HALT.slice(3)].join('\n'), err: '' }, 'nothing is asked of the VM manager');
    for (const args of [['vm', 'halt', 'primary'], ['vm', 'hardstop', 'primary'], ['vm', 'hardstop', 'clv-'], ['vm', 'halt', 'clv-demo', 'nuke'], ['vm', 'halt', 'clv-demo', 'polite', 'term'],
        ['vm', 'halt', 'clv-demo', 'kill', 'force'], ['vm', 'halt', 'clv-demo', 'term', 'force'], ['vm', 'halt', 'clv-demo', 'polite;id']]) assert.equal(host(...args).code, 78, args.join(' '));
    assert.equal(host('vm', 'hardstop', 'clv-demo', 'kill').code, 64);
    assert.equal(host('vm', 'halt', 'clv-demo', 'polite', 'kill', 'x').code, 64);
});

/* ...then run for real, as a plain account (--test): a stand-in multipass and stand-in qemus (a
   script named qemu-system-x86_64 whose command line holds a disk of the instance), first on PATH. */
const ROOT = process.getuid?.() === 0 ? 'run as root: --test is refused to root, by design' : false;
let halts = 0;
/* `frozen`: its qemu stopped by SIGSTOP. `stuck`: its qemu's parent never reaps it (a VM manager that
   hangs): once ended, it stays a zombie. Otherwise its parent is gone and it is reaped as it ends. */
async function haltBench(t, { polite = 'ok', force = 'ok', ignoreTerm = false, mute = false, saysRunning = false, frozen = false, stuck = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-halt-'));
    const vm = `clv-hs${process.pid}x${++halts}`;
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'instances', vm), { recursive: true });
    /* It says it is ready (its traps set) before it is frozen or signalled. */
    writeFileSync(join(dir, 'bin', 'qemu-system-x86_64'), `#!/bin/bash\n${ignoreTerm ? "trap '' TERM\n" : ''}: > "${dir}/ready.$$"\nwhile :; do sleep 0.1; done\n`);
    /* The VM manager: what it does with a stop is the test's; a qemu gone is seen as Stopped (unless it says Running for ever). */
    writeFileSync(join(dir, 'bin', 'multipass'), `#!/bin/bash
D="${dir}"; echo "$*" >> "$D/calls"
case "$1" in
  list) [ -e "$D/mute" ] && exec sleep 30
        s="$(cat "$D/state")"; z="$(sed -n 's/^State:[[:space:]]*\\([A-Z]\\).*/\\1/p' "/proc/$(cat "$D/pid")/status" 2>/dev/null)"
        if [ "$s" = Running ] && { [ -z "$z" ] || [ "$z" = Z ]; } && [ ! -e "$D/says-running" ]; then s=Stopped; fi
        echo "Name,State,IPv4,IPv6,Release,AliasesForInstance"; echo "${vm},$s,,,,"; echo "clv-other,Running,,,," ;;
  stop) b="$(cat "$D/$([ "$2" = --force ] && echo force || echo polite)")"
        case "$b" in hang) exec sleep 30 ;; fail) exit 2 ;; ok) kill -KILL "$(cat "$D/pid")" 2>/dev/null; echo Stopped > "$D/state" ;; esac ;;
esac
`);
    chmodSync(join(dir, 'bin', 'qemu-system-x86_64'), 0o755); chmodSync(join(dir, 'bin', 'multipass'), 0o755);
    writeFileSync(join(dir, 'polite'), polite); writeFileSync(join(dir, 'force'), force); writeFileSync(join(dir, 'state'), 'Running');
    if (mute) writeFileSync(join(dir, 'mute'), '');
    if (saysRunning) writeFileSync(join(dir, 'says-running'), '');
    const parents = [];
    const qemu = (name, keep) => new Promise((resolve) => {
        const line = `"${join(dir, 'bin', 'qemu-system-x86_64')}" -name ${name} -drive "file=${join(dir, 'instances', name, 'disk.img')}" >/dev/null 2>&1 & echo $!; ${keep ? 'exec sleep 600' : 'exit 0'}`;
        const parent = spawn('/bin/bash', ['-c', line], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (keep) parents.push(parent);
        /* Given back once it IS the qemu, ready, not the shell about to become it. */
        parent.stdout.once('data', async (d) => {
            const pid = Number(String(d).trim());
            for (let i = 0; i < 250 && !existsSync(join(dir, `ready.${pid}`)); i++) await new Promise((r) => setTimeout(r, 20));
            resolve({ pid });
        });
    });
    const mine = await qemu(vm, stuck); writeFileSync(join(dir, 'pid'), String(mine.pid));
    if (frozen) process.kill(mine.pid, 'SIGSTOP');
    mkdirSync(join(dir, 'instances', 'clv-other'), { recursive: true });
    const other = await qemu('clv-other', false);
    t.after(() => { for (const p of [mine, other, ...parents]) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
    /* Still there and not ended (a zombie is ended). */
    const state = (p) => { try { return /^State:\s*([A-Za-z])/m.exec(readFileSync(`/proc/${p.pid}/status`, 'utf8'))[1]; } catch { return ''; } };
    const alive = (p) => !['', 'Z'].includes(state(p));
    const run = async (...args) => {
        await new Promise((r) => setTimeout(r, 200));
        const r = spawnSync('/bin/bash', [PROGRAM, '--test', dir, 'vm', ...args.map((a) => (a === 'VM' ? vm : a))], { encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` } });
        /* Each line without its seconds, which vary. */
        return { code: r.status, steps: r.stdout.trim().split('\n').map((l) => l.replace(/ \d+s\b/, '')), err: r.stderr };
    };
    const calls = () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter((l) => !l.startsWith('list')) : []);
    return { vm, dir, run, alive, state, mine, other, calls };
}

test('vm hardstop: its own qemu ends on SIGTERM, without the VM manager; another machine is not touched', { skip: ROOT }, async (t) => {
    const b = await haltBench(t);
    const r = await b.run('hardstop', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step term start', 'step term ok', 'step kill skip gone', 'step check start', 'step check ok freed 0.0G']);
    assert.equal(b.alive(b.mine), false); assert.equal(b.alive(b.other), true, 'the other machine runs on');
    assert.deepEqual(b.calls(), [], 'no stop was asked of the VM manager');
});

test('vm hardstop: a qemu that ignores SIGTERM gets SIGKILL', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { ignoreTerm: true });
    const r = await b.run('hardstop', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step term start', 'step term timeout', 'step kill start', 'step kill ok', 'step check start', 'step check ok freed 0.0G']);
    assert.equal(b.alive(b.mine), false); assert.equal(b.alive(b.other), true);
});

test('vm halt: a polite stop that works ends there; the rest is skipped', { skip: ROOT }, async (t) => {
    const b = await haltBench(t);
    const r = await b.run('halt', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step polite start', 'step polite ok', 'step force skip gone', 'step check start', 'step check ok freed 0.0G']);
    assert.deepEqual(b.calls(), [`stop ${b.vm}`]);
});

test('vm halt: a VM manager that hangs on both stops, then its qemu ended by SIGTERM', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { polite: 'hang', force: 'fail' });
    const r = await b.run('halt', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step polite start', 'step polite timeout', 'step force start', 'step force fail', 'step term start', 'step term ok', 'step kill skip gone', 'step check start', 'step check ok freed 0.0G']);
    assert.equal(b.alive(b.other), true);
});

test('vm halt until force: a qemu that stays is said, and nothing is killed', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { polite: 'hang', force: 'hang' });
    const r = await b.run('halt', 'VM', 'polite', 'force');
    assert.equal(r.code, 1);
    assert.deepEqual(r.steps, ['step polite start', 'step polite timeout', 'step force start', 'step force timeout', 'step check start', 'step check fail qemu-left freed 0.0G']);
    assert.equal(b.alive(b.mine), true, 'its qemu was not signalled');
});

test('vm halt: a mute VM manager -- its qemu still ended, the check says it could not be confirmed', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { polite: 'hang', force: 'hang', mute: true });
    const r = await b.run('halt', 'VM', 'force');
    assert.equal(r.code, 1);
    assert.deepEqual(r.steps, ['step force start', 'step force timeout', 'step term start', 'step term ok', 'step kill skip gone', 'step check start', 'step check fail mute freed 0.0G']);
    assert.equal(b.alive(b.mine), false);
});

test('vm halt: a VM manager that still says Running after its qemu is gone fails the check', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { saysRunning: true });
    const r = await b.run('halt', 'VM', 'term');
    assert.equal(r.code, 1);
    assert.equal(r.steps.at(-1), 'step check fail state Running freed 0.0G');
});

test('vm halt ended by the server ("Force now"): its step ends at once, not at its bound', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { polite: 'hang' });
    const { dir, vm } = b;
    const child = spawn('/bin/bash', [PROGRAM, '--test', dir, 'vm', 'halt', vm], { env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin` } });
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    /* Ended once its polite step has begun -- not after a fixed time, which a loaded machine may not reach (12-11). */
    const closed = new Promise((r) => child.on('close', (c, sig) => r(c ?? sig)));
    for (let i = 0; i < 300 && !out.includes('step polite start'); i += 1) await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    child.kill('SIGTERM');
    const code = await closed;
    assert.equal(code, 143);
    assert.ok(Date.now() - started < 1800, 'ended at once, not at its two seconds');
    assert.equal(out.trim(), 'step polite start');
});

test('vm hardstop: a FROZEN qemu (SIGSTOP) is let run so that SIGTERM ends it', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { frozen: true });
    assert.equal(b.state(b.mine), 'T', 'frozen');
    const r = await b.run('hardstop', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step term start', 'step term ok', 'step kill skip gone', 'step check start', 'step check ok freed 0.0G']);
    assert.equal(b.alive(b.mine), false); assert.equal(b.alive(b.other), true);
});

test('vm hardstop: a FROZEN qemu that ignores SIGTERM gets SIGKILL within its bound', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { frozen: true, ignoreTerm: true });
    const r = await b.run('hardstop', 'VM');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.steps, ['step term start', 'step term timeout', 'step kill start', 'step kill ok', 'step check start', 'step check ok freed 0.0G']);
    assert.equal(b.alive(b.mine), false);
});

test('a qemu ended but left unreaped by a VM manager that hangs: never taken for "gone"; the check says so', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { frozen: true, stuck: true, polite: 'hang', force: 'hang' });
    const first = await b.run('hardstop', 'VM');
    assert.equal(first.code, 1);
    assert.equal(b.state(b.mine), 'Z', 'ended, not reaped');
    assert.equal(first.steps.at(-1), 'step check fail qemu-unreaped freed 0.0G');
    /* Asked to stop after it: the polite step is tried, not skipped as "gone"; no signal can do more. */
    const again = await b.run('halt', 'VM');
    assert.equal(again.code, 1);
    assert.deepEqual(again.steps, ['step polite start', 'step polite timeout', 'step force start', 'step force timeout', 'step term skip unreaped', 'step kill skip unreaped', 'step check start', 'step check fail qemu-unreaped freed 0.0G']);
});

test('vm suspend of a FROZEN qemu is refused at once (it would hang the VM manager): Force stop is what frees it', { skip: ROOT }, async (t) => {
    const b = await haltBench(t, { frozen: true });
    const r = await b.run('suspend', 'VM');
    assert.equal(r.code, 78);
    assert.deepEqual(r.steps, ['step suspend start', 'step suspend fail frozen']);
    assert.match(r.err, /frozen: a suspend would hang the VM manager; use Force stop/);
    assert.deepEqual(b.calls(), [], 'nothing was asked of the VM manager');
});

/* A SHARED MACHINE (#221): its conversations listed by the host itself; a work folder or a resource goes only into
   the place, in that machine, of a conversation that lives in it -- never another's, never a machine of its own. */
test('a shared machine: share records who lives in it; smount only for one of them, into its own place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-shared-'));
    try {
        mkdirSync(join(dir, 'shared')); mkdirSync(join(dir, 'work', 'mail'), { recursive: true }); mkdirSync(join(dir, 'resources', 'docs'), { recursive: true });
        writeFileSync(join(dir, 'shared', 'clv-assist'), 'mail\n');
        const say = (...args) => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', dir, '--mnt', dir, ...args], { encoding: 'utf8' });
        assert.equal(say('vm', 'smount', 'clv-assist', 'mail', 'work', 'mail', '1000', '1000', '1001', '1001').stdout.trim(), `multipass mount -u 1000:1001 -g 1000:1001 ${dir}/work/mail clv-assist:/srv/clavarium/mail/work`);
        assert.equal(say('vm', 'smount', 'clv-assist', 'mail', 'folder', 'docs', '1000', '1000', '1001', '1001').stdout.trim(), `multipass mount -u 1000:1001 -g 1000:1001 ${dir}/resources/docs clv-assist:/srv/clavarium/mail/resources/docs`);
        for (const [args, why] of [
            [['vm', 'smount', 'clv-assist', 'diary', 'work', 'diary', '1000', '1000', '1001', '1001'], /diary does not live in clv-assist/],
            [['vm', 'smount', 'clv-assist', 'mail', 'work', 'mail', '1000', '1000', '1000', '1000'], /not the machine's admin/],
            [['vm', 'smount', 'clv-assist', 'mail', 'work', 'other', '1000', '1000', '1001', '1001'], /belongs to its own conversation/],
            [['vm', 'smount', 'clv-assist', 'mail', 'tools', 'tools', '1000', '1000', '1001', '1001'], /a shared mount is of/],
            [['vm', 'share', 'clv-mail', 'mail'], /of its own is not shared/],
            [['vm', 'share', 'other', 'mail'], /not one of our VMs/],
        ]) { const r = say(...args); assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, why); }
        assert.equal(say('vm', 'sumount', 'clv-assist', 'mail', 'work').stdout.trim(), 'multipass umount clv-assist:/srv/clavarium/mail/work');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
