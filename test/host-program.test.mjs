/* The privileged program, tried for real in its "say only" mode: what it
   would run for what the server asks, and what it refuses whoever asks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        [['vm', 'ping'], 'timeout 25 multipass list --format csv'],
        [['vm', 'revive'], 'timeout 170 snap restart multipass.multipassd'],
        [['vm', 'start', 'clv-demo'], 'multipass start clv-demo'],
        [['vm', 'suspend', 'clv-demo'], 'multipass suspend clv-demo'],
        [['vm', 'delete', 'clv-demo'], 'multipass delete --purge clv-demo'],
        [['vm', 'mount', 'clv-demo', 'folder', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/resources/reports clv-demo:/resources/reports'],
        [['vm', 'mount', 'clv-demo', 'view', 'reports', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/views/reports clv-demo:/resources/reports'],
        [['vm', 'umount', 'clv-demo', 'reports'], 'multipass umount clv-demo:/resources/reports'],
        [['view', 'make', 'reports'], 'bindfs -r -o allow_other /var/lib/clavarium/resources/reports /var/lib/clavarium/views/reports'],
        [['view', 'close', 'reports'], 'umount /var/lib/clavarium/views/reports'],
        [['mounts', 'repair'], 'umount -l <each FUSE view under /var/lib/clavarium that does not answer>'],
        [['folder', 'make', 'reports'], 'install -d -o OWNER -g GROUP -m 0755 /var/lib/clavarium/resources/reports'],
        [['work', 'make', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img 10240M mounted at /var/lib/clavarium/work/demo'],
        [['work', 'aside', 'demo'], 'disk /var/lib/clavarium/work-disks/demo.img put aside in /var/lib/clavarium/removed'],
        [['vm', 'mount', 'clv-demo', 'work', 'demo', '998', '997'], 'multipass mount -u 998:1000 -g 997:1000 /var/lib/clavarium/work/demo clv-demo:/work'],
        [['vm', 'unwork', 'clv-demo'], 'multipass umount clv-demo:/work'],
        [['work', 'room', 'demo'], 'df /var/lib/clavarium/work/demo /var/lib/clavarium/work-disks'],
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
        [['vm', 'stop', 'clv-demo'], 'multipass stop clv-demo'],
        [['vm', 'kill', 'clv-demo'], 'multipass stop --force clv-demo'],
        [['vm', 'set', 'clv-demo', 'memory', '2048'], 'multipass set local.clv-demo.memory=2048M'],
        [['vm', 'set', 'clv-demo', 'disk', '16'], 'multipass set local.clv-demo.disk=16G'],
        [['vm', 'size', 'clv-demo'], 'multipass get local.clv-demo.memory\nmultipass get local.clv-demo.disk'],
        [['tools', 'make'], 'install -d -o OWNER -g GROUP -m 0755 /var/lib/clavarium/toolbox/files\nbindfs -r -o allow_other /var/lib/clavarium/toolbox/files /var/lib/clavarium/toolbox/view'],
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
        ['vm', 'shell', 'clv-demo'], ['vm', 'set', 'local.driver=lxd'], ['vm', 'transfer', '/etc/shadow', 'clv-demo:/tmp/x'],
        ['net', 'flush'], ['host', 'run', 'id'], ['folder', 'make', '../x'], ['work', 'make', '../x'], ['work', 'aside', '/etc'], ['work', 'erase', 'demo'], ['work', 'room', '../x'], ['vm', 'unwork', 'primary'],
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
        [['view', 'make', 'site'], 'bindfs -r -o allow_other /srv/clavarium-mnt/resources/site /srv/clavarium-mnt/views/site'],
        [['view', 'close', 'site'], 'umount /srv/clavarium-mnt/views/site'],
        [['folder', 'make', 'site'], 'install -d -o OWNER -g GROUP -m 0755 /srv/clavarium-mnt/resources/site'],
        [['work', 'make', 'demo'], 'disk /srv/clavarium-mnt/work-disks/demo.img 10240M mounted at /srv/clavarium-mnt/work/demo'],
        [['work', 'room', 'demo'], 'df /srv/clavarium-mnt/work/demo /srv/clavarium-mnt/work-disks'],
        [['work', 'aside', 'demo'], 'disk /srv/clavarium-mnt/work-disks/demo.img put aside in /srv/clavarium-mnt/removed'],
        [['tools', 'make'], 'install -d -o OWNER -g GROUP -m 0755 /srv/clavarium-mnt/toolbox/files\nbindfs -r -o allow_other /srv/clavarium-mnt/toolbox/files /srv/clavarium-mnt/toolbox/view'],
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
    assert.equal(say('update', 'apply', '0.2.0-next.3').stdout, 'echo apply 0.2.0-next.3 > /var/lib/clavarium/update/request\nsystemctl start --no-block clavarium-update.service\n');
    assert.equal(say('update', 'rollback', 'local-20261018-010203').status, 0);
    for (const bad of [['update', 'check', 'x'], ['update', 'set', 'mode', 'always'], ['update', 'set', 'channel', 'beta'], ['update', 'set', 'window', '03:00-03:00'], ['update', 'set', 'registry', 'http://x'],
        ['update', 'apply', '1.0'], ['update', 'apply', '1.0.0 --registry=x'], ['update', 'apply', 'local-20261018-010203'], ['update', 'rollback', '../1.0.0'], ['update', 'install', '1.0.0']]) {
        const r = say(...bad);
        assert.ok(r.status === 78 || r.status === 64, `${bad.join(' ')}: ${r.status}`);
        assert.equal(r.stdout, '', bad.join(' '));
    }
});
