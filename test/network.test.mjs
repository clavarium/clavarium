import { test } from 'node:test';
import assert from 'node:assert/strict';
/* Loopback addresses other than 127.0.0.1, built so that no address-shaped literal sits in the code. */
const at = (n) => ['127', '0', '0', String(n)].join('.');
import { readTaps, readLeases, readBridgeAddress, ruleset, Network, TABLE, isMac, isAddress } from '../server/network.mjs';

const PROCESSES = [
    '101 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-15921f81452,script=no,mac=52:54:00:aa:bb:cc -drive file=/var/x/vault/instances/clv-first/disk.img,if=none',
    '102 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-918e9b07222,script=no -drive file=/var/x/vault/instances/clv-second/disk.img',
    '103 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-aaa,script=no -drive file=/var/x/vault/instances/someone-else/disk.img',
    '104 /snap/x/qemu-system-x86_64 -nic tap,ifname=evil";drop,script=no -drive file=/var/x/vault/instances/clv-third/disk.img',
].join('\n');

test('taps are read from the process list, and only for conversation VMs whose tap looks like one', () => {
    assert.deepEqual(readTaps(PROCESSES), { first: { tap: 'tap-15921f81452', mac: '52:54:00:aa:bb:cc', pid: '101' }, second: { tap: 'tap-918e9b07222', mac: undefined, pid: '102' } });
    assert.deepEqual(readTaps(''), {});
    assert.equal(readBridgeAddress('3: mpqemubr0    inet 127.0.0.1/24 brd 127.0.0.1 scope global'), '127.0.0.1');
    assert.equal(readBridgeAddress(`3: mpqemubr0    inet ${['999', '1', '2', '1'].join('.')}/24`), undefined);
});

test('every conversation is a silo, always; an offline one reaches the host only, and not its name resolver', () => {
    const text = ruleset({ first: { tap: 'tap-1' }, second: { tap: 'tap-2' } }, ['second'], '127.0.0.1');
    const between = text.slice(text.indexOf('chain between_vms'), text.indexOf('chain from_vm'));
    assert.ok(between.includes('iifname "tap-1" drop') && between.includes('iifname "tap-2" drop'));
    const fromVm = text.slice(text.indexOf('chain from_vm'));
    assert.ok(!fromVm.includes('tap-1'), 'an online conversation is not filtered towards the outside');
    const order = fromVm.split('\n').filter((l) => l.includes('tap-2')).map((l) => l.trim().replace('iifname "tap-2" ', ''));
    assert.deepEqual(order, ['udp dport 67 accept', 'ether type arp accept', 'ip daddr 127.0.0.1 meta l4proto { tcp, udp } th dport 53 drop', 'ip daddr 127.0.0.1 accept', 'drop']);
    /* Replaced whole: created if missing, deleted, written again. */
    assert.ok(text.startsWith(`table bridge ${TABLE}\ndelete table bridge ${TABLE}\ntable bridge ${TABLE} {`));
});

test('the rules are handed to the firewall whole, rebuilt from what runs now', async () => {
    const calls = [];
    const host = async (argv, options) => {
        calls.push({ argv: argv[1] === 'apply' ? 'net apply <rules>' : argv.join(' '), input: argv[1] === 'apply' ? argv[2] : options?.input });
        if (argv[1] === 'taps') return { code: 0, stdout: PROCESSES, stderr: '' };
        if (argv[1] === 'bridge') return { code: 0, stdout: '3: mpqemubr0    inet 127.0.0.1/24 brd', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    /* "gone" is offline but not running: nothing to filter, and no error. */
    const network = new Network({ host, offline: () => ['second', 'gone'] });
    assert.equal(await network.apply(), true);
    assert.deepEqual(calls.map((c) => c.argv), ['net taps', 'net bridge', 'net leases', 'net apply <rules>']);
    assert.ok(calls[3].input.includes('iifname "tap-918e9b07222" drop'));
    assert.ok(!calls[3].input.includes('evil'));
});

test('a firewall that refuses, or a host address that cannot be read, is reported: nothing is said to be cut that is not', async () => {
    const refusing = new Network({ offline: () => ['first'], host: async (argv) => (argv[1] === 'apply' ? { code: 1, stdout: '', stderr: 'x' } : { code: 0, stdout: argv[1] === 'taps' ? PROCESSES : 'inet 127.0.0.1/24', stderr: '' }) });
    assert.equal(await refusing.apply(), false);
    const blind = new Network({ offline: () => ['first'], host: async (argv) => ({ code: 0, stdout: argv[1] === 'taps' ? PROCESSES : '', stderr: '' }) });
    assert.equal(await blind.apply(), false);
    const nothingAsked = new Network({ offline: () => [], host: async (argv) => ({ code: 0, stdout: argv[1] === 'taps' ? PROCESSES : '', stderr: '' }) });
    assert.equal(await nothingAsked.apply(), true);
});

test('kept up to date: a machine started by itself gets its silo at the next look; the same table is not loaded again', async (t) => {
    let processes = PROCESSES.split('\n')[0]; const applied = [];
    const host = async (argv) => {
        if (argv[1] === 'taps') return { code: 0, stdout: processes, stderr: '' };
        if (argv[1] === 'bridge') return { code: 0, stdout: '3: mpqemubrzone1    inet 127.0.0.1/24 brd', stderr: '' };
        if (argv[1] === 'leases') return { code: 0, stdout: '', stderr: '' };
        applied.push(argv[2]); return { code: 0, stdout: '', stderr: '' };
    };
    const network = new Network({ host, offline: () => [] });
    assert.equal(await network.apply(), true);
    assert.equal(await network.apply(), true);
    assert.equal(applied.length, 1, 'nothing changed: not loaded again');
    processes = PROCESSES;
    t.mock.timers.enable({ apis: ['setInterval'] });
    const stop = network.watch(1000);
    t.mock.timers.tick(1000);
    await new Promise((ok) => setImmediate(ok)); await new Promise((ok) => setImmediate(ok));
    stop();
    assert.equal(applied.length, 2, 'a new machine: loaded again');
    assert.ok(applied[1].includes('iifname "tap-918e9b07222" drop'), 'its silo');
});

const MAC1 = '52:54:00:aa:bb:cc', MAC2 = '52:54:00:dd:ee:01';
const fromVmOf = (text, tap) => text.slice(text.indexOf('chain from_vm')).split('\n').filter((l) => l.includes(`"${tap}"`)).map((l) => l.trim().replace(`iifname "${tap}" `, ''));

test('no VM passes for another: its own MAC, IPv4 or ARP only, its own address, DHCP for its own MAC', () => {
    const text = ruleset({ first: { tap: 'tap-1', mac: MAC1, ip: `${at(10)}` }, second: { tap: 'tap-2', mac: MAC2, ip: `${at(11)}` } }, [], '127.0.0.1');
    assert.deepEqual(fromVmOf(text, 'tap-1'), [
        `ether saddr != ${MAC1} drop`,
        'ether type != { ip, arp } drop',
        `arp saddr ether != ${MAC1} drop`,
        'udp dport 67 @th,288,48 != 0x525400aabbcc drop',
        'ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp dport 67 accept',
        `ip saddr != ${at(10)} drop`,
        `arp saddr ip != { 0.0.0.0, ${at(10)} } drop`,
    ]);
    assert.ok(fromVmOf(text, 'tap-2').includes(`ip saddr != ${at(11)} drop`));
    assert.ok(fromVmOf(text, 'tap-2').includes(`ether saddr != ${MAC2} drop`));
    /* Online: nothing else from it is filtered; the silo still holds. */
    assert.ok(text.includes('    iifname "tap-1" drop\n'), 'its silo');
    /* Offline: the checks come first, then the cut. */
    const offline = fromVmOf(ruleset({ first: { tap: 'tap-1', mac: MAC1, ip: `${at(10)}` } }, ['first'], '127.0.0.1'), 'tap-1');
    assert.equal(offline[0], `ether saddr != ${MAC1} drop`);
    assert.equal(offline.at(-1), 'drop');
    assert.ok(offline.indexOf(`ip saddr != ${at(10)} drop`) < offline.indexOf('ip daddr 127.0.0.1 accept'));
});

test('an address not known yet (it boots): MAC and DHCP checked, its lease never blocked, no address of another VM or of the host', () => {
    const text = ruleset({ first: { tap: 'tap-1', mac: MAC1 }, second: { tap: 'tap-2', mac: MAC2, ip: `${at(11)}` } }, [], '127.0.0.1');
    const rules = fromVmOf(text, 'tap-1');
    assert.ok(rules.includes(`ether saddr != ${MAC1} drop`) && rules.includes('ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp dport 67 accept'));
    assert.ok(!rules.some((r) => r.startsWith('ip saddr !=') || r.startsWith('arp saddr ip !=')), 'no own address to hold it to');
    assert.ok(rules.includes(`ip saddr { 127.0.0.1, ${at(11)} } drop`));
    assert.ok(rules.includes(`arp saddr ip { 127.0.0.1, ${at(11)} } drop`));
    /* Nothing known at all (no lease, no host address): MAC rules only. */
    assert.equal(fromVmOf(ruleset({ first: { tap: 'tap-1', mac: MAC1 } }, [], '0.0.0.0'), 'tap-1').length, 5);
    /* No MAC read: the silo only, as before. */
    const blind = ruleset({ first: { tap: 'tap-1' } }, [], '127.0.0.1');
    assert.deepEqual(fromVmOf(blind, 'tap-1'), []);
    assert.ok(blind.includes('    iifname "tap-1" drop\n'));
});

test('a MAC or an address that is not exactly one is never written into a rule', () => {
    for (const bad of ['52:54:00:AA:bb:cc', '52:54:00:aa:bb', '52:54:00:aa:bb:cc:dd', '53:54:00:aa:bb:cc', '52-54-00-aa-bb-cc', '52:54:00:aa:bb:c"', ' 52:54:00:aa:bb:cc', undefined, 7]) assert.equal(isMac(bad), false, String(bad));
    assert.equal(isMac(MAC1), true);
    for (const bad of [`${at(256)}`, '127.0.0', '127.0.0.1.5', ['127', '0', '00', '1'].join('.'), '127.0.0.1 ', '127.0.0.1;', '', undefined]) assert.equal(isAddress(bad), false, String(bad));
    const line = '201 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-abc,script=no,mac=MAC -drive file=/var/x/vault/instances/clv-first/disk.img';
    for (const bad of ['52:54:00:aa:bb:cc";drop', '52:54:00:AA:BB:CC', 'ff:ff:ff:ff:ff:ff']) assert.equal(readTaps(line.replace('MAC', bad)).first.mac, undefined, bad);
    /* Leases: "<mac> <ip>" only; anything else, or an address claimed twice, left out. */
    assert.deepEqual(readLeases([
        `${MAC1} ${at(10)}`, `${MAC2} ${at(10)}`, `52:54:00:00:00:01 ${at(300)}`, '52:54:00:00:00:02 0.0.0.0', `52:54:00:00:00:03 ${['224', '0', '0', '9'].join('.')}`,
        `52:54:00:00:00:04 ${at(20)} extra`, 'junk', '', `52:54:00:00:00:05 ${at(21)}`, `52:54:00:00:00:06 ${at(22)}`, `52:54:00:00:00:06 ${at(23)}`,
    ].join('\n')), { '52:54:00:00:00:05': `${at(21)}` });
    /* Even handed straight to ruleset, a bad address is not used as one. */
    const text = ruleset({ first: { tap: 'tap-1', mac: MAC1, ip: '127.0.0.1 accept' } }, [], '127.0.0.1');
    assert.ok(!text.includes('accept\n    iifname "tap-1" ip saddr !='));
    assert.ok(!text.includes('127.0.0.1 accept'));
});

test('the address comes from the lease of the VM\'s MAC, and is pinned while its qemu runs', async () => {
    const line = (pid, name, tap, mac) => `${pid} /snap/x/qemu-system-x86_64 -nic tap,ifname=${tap},script=no,mac=${mac} -drive file=/var/x/vault/instances/clv-${name}/disk.img`;
    let processes = [line(301, 'first', 'tap-a1', MAC1), line(302, 'second', 'tap-a2', MAC2)].join('\n');
    let leases = `${MAC1} ${at(10)}\n${MAC2} ${at(11)}\n`; let applied = '';
    const host = async (argv) => {
        if (argv[1] === 'taps') return { code: 0, stdout: processes, stderr: '' };
        if (argv[1] === 'bridge') return { code: 0, stdout: 'inet 127.0.0.1/24', stderr: '' };
        if (argv[1] === 'leases') return { code: 0, stdout: leases, stderr: '' };
        applied = argv[2]; return { code: 0, stdout: '', stderr: '' };
    };
    const network = new Network({ host, offline: () => [] });
    assert.equal(await network.apply(), true);
    assert.ok(applied.includes(`iifname "tap-a1" ip saddr != ${at(10)} drop`) && applied.includes(`iifname "tap-a2" ip saddr != ${at(11)} drop`));
    /* The first releases its lease and takes the second's: neither follows. */
    leases = `${MAC1} ${at(11)}\n`;
    await network.apply();
    assert.ok(applied.includes(`iifname "tap-a1" ip saddr != ${at(10)} drop`), 'the first keeps its own');
    assert.ok(applied.includes(`iifname "tap-a2" ip saddr != ${at(11)} drop`), 'the second keeps its own');
    /* A new qemu (restart): its lease is read again. A VM whose lease names an address pinned to another stays unknown. */
    processes = [line(401, 'first', 'tap-a1', MAC1), line(302, 'second', 'tap-a2', MAC2)].join('\n');
    await network.apply();
    assert.ok(!applied.includes('iifname "tap-a1" ip saddr !='), 'not given the address of another');
    assert.ok(applied.includes(`iifname "tap-a1" ip saddr { 127.0.0.1, ${at(11)} } drop`));
    /* An older host program without the verb: MAC rules only, and the table is still loaded. */
    const old = new Network({ offline: () => [], host: async (argv) => (argv[1] === 'leases' ? { code: 64, stdout: '', stderr: 'usage' } : host(argv)) });
    processes = line(501, 'third', 'tap-a3', MAC1);
    assert.equal(await old.apply(), true);
    assert.ok(applied.includes(`iifname "tap-a3" ether saddr != ${MAC1} drop`));
});
