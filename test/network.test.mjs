import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTaps, readBridgeAddress, ruleset, Network, TABLE } from '../server/network.mjs';

const PROCESSES = [
    '101 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-15921f81452,script=no,mac=52:54:00:aa:bb:cc -drive file=/var/x/vault/instances/clv-first/disk.img,if=none',
    '102 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-918e9b07222,script=no -drive file=/var/x/vault/instances/clv-second/disk.img',
    '103 /snap/x/qemu-system-x86_64 -nic tap,ifname=tap-aaa,script=no -drive file=/var/x/vault/instances/someone-else/disk.img',
    '104 /snap/x/qemu-system-x86_64 -nic tap,ifname=evil";drop,script=no -drive file=/var/x/vault/instances/clv-third/disk.img',
].join('\n');

test('taps are read from the process list, and only for conversation VMs whose tap looks like one', () => {
    assert.deepEqual(readTaps(PROCESSES), { first: 'tap-15921f81452', second: 'tap-918e9b07222' });
    assert.deepEqual(readTaps(''), {});
    assert.equal(readBridgeAddress('3: mpqemubr0    inet 10.1.2.1/24 brd 10.1.2.255 scope global'), '10.1.2.1');
    assert.equal(readBridgeAddress('3: mpqemubr0    inet 999.1.2.1/24'), undefined);
});

test('every conversation is a silo, always; an offline one reaches the host only, and not its name resolver', () => {
    const text = ruleset({ first: 'tap-1', second: 'tap-2' }, ['second'], '10.1.2.1');
    const between = text.slice(text.indexOf('chain between_vms'), text.indexOf('chain from_vm'));
    assert.ok(between.includes('iifname "tap-1" drop') && between.includes('iifname "tap-2" drop'));
    const fromVm = text.slice(text.indexOf('chain from_vm'));
    assert.ok(!fromVm.includes('tap-1'), 'an online conversation is not filtered towards the outside');
    const order = fromVm.split('\n').filter((l) => l.includes('tap-2')).map((l) => l.trim().replace('iifname "tap-2" ', ''));
    assert.deepEqual(order, ['udp dport 67 accept', 'ether type arp accept', 'ip daddr 10.1.2.1 meta l4proto { tcp, udp } th dport 53 drop', 'ip daddr 10.1.2.1 accept', 'drop']);
    /* Replaced whole: created if missing, deleted, written again. */
    assert.ok(text.startsWith(`table bridge ${TABLE}\ndelete table bridge ${TABLE}\ntable bridge ${TABLE} {`));
});

test('the rules are handed to the firewall on standard input, rebuilt from what runs now', async () => {
    const calls = [];
    const host = async (argv, options) => {
        calls.push({ argv: argv.join(' '), input: options?.input });
        if (argv[0] === 'pgrep') return { code: 0, stdout: PROCESSES, stderr: '' };
        if (argv[0] === 'ip') return { code: 0, stdout: '3: mpqemubr0    inet 10.1.2.1/24 brd', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    /* "gone" is offline but not running: nothing to filter, and no error. */
    const network = new Network({ host, offline: () => ['second', 'gone'] });
    assert.equal(await network.apply(), true);
    assert.deepEqual(calls.map((c) => c.argv), ['pgrep -a qemu-system', 'ip -4 -o addr show mpqemubr0', 'nft -f -']);
    assert.ok(calls[2].input.includes('iifname "tap-918e9b07222" drop'));
    assert.ok(!calls[2].input.includes('evil'));
});

test('a firewall that refuses, or a host address that cannot be read, is reported: nothing is said to be cut that is not', async () => {
    const refusing = new Network({ offline: () => ['first'], host: async (argv) => (argv[0] === 'nft' ? { code: 1, stdout: '', stderr: 'x' } : { code: 0, stdout: argv[0] === 'pgrep' ? PROCESSES : 'inet 10.1.2.1/24', stderr: '' }) });
    assert.equal(await refusing.apply(), false);
    const blind = new Network({ offline: () => ['first'], host: async (argv) => ({ code: 0, stdout: argv[0] === 'pgrep' ? PROCESSES : '', stderr: '' }) });
    assert.equal(await blind.apply(), false);
    const nothingAsked = new Network({ offline: () => [], host: async (argv) => ({ code: 0, stdout: argv[0] === 'pgrep' ? PROCESSES : '', stderr: '' }) });
    assert.equal(await nothingAsked.apply(), true);
});
