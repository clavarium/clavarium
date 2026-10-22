/* The disks of this server, whole, formatted or not (server/machinesmove.mjs, readDisks). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDisks, MachinesMove } from '../server/machinesmove.mjs';

const G = 1024 ** 3;
const dev = (name, type, size, extra = {}) => ({ name, path: `/dev/${name}`, type, size, fstype: null, label: null, uuid: null, mountpoint: null, model: null, ro: false, rm: false, pkname: null, tran: null, ...extra });
const LSBLK = JSON.stringify({ blockdevices: [
    dev('fd0', 'disk', 4096, { rm: true }),
    dev('sr0', 'rom', 2 * G, { rm: true, ro: true }),
    dev('loop1', 'loop', 70 * 1024 ** 2, { fstype: 'squashfs', mountpoint: '/snap/core24/1', ro: true }),
    dev('loop8', 'loop', 10 * G, { fstype: 'ext4', mountpoint: '/srv/clavarium-mnt/work/demo' }),
    dev('loop0', 'loop', 11 * G, { fstype: 'ext4', mountpoint: '/mnt/disk2' }),
    dev('sda', 'disk', 100 * G, { model: 'Samsung SSD', children: [dev('sda1', 'part', 99 * G, { fstype: 'ext4', mountpoint: '/' }), dev('sda15', 'part', 100 * 1024 ** 2, { fstype: 'vfat', mountpoint: '/boot/efi' })] }),
    dev('sdb', 'disk', 500 * G, { model: 'WD Blue  ' }),
    dev('sdc', 'disk', 1000 * G, { children: [dev('sdc1', 'part', 1000 * G, { fstype: 'ext4', label: 'photos' })] }),
    dev('sdd', 'disk', 2000 * G, { children: [dev('sdd1', 'part', 2000 * G, { fstype: 'ext4', mountpoint: '/mnt/data' })] }),
    dev('nvme0n1', 'disk', 256 * G, { children: [dev('nvme0n1p1', 'part', 256 * G, { fstype: 'LVM2_member', children: [dev('vg-root', 'lvm', 256 * G, { fstype: 'ext4', mountpoint: '/srv' })] })] }),
] });

test('the disks: whole disks, formatted or not; never a floppy, a CD, a snap or a work disk', () => {
    const d = readDisks(LSBLK);
    assert.deepEqual(d.map((x) => x.name), ['loop0', 'sda', 'sdb', 'sdc', 'sdd', 'nvme0n1']);
    const by = Object.fromEntries(d.map((x) => [x.name, x]));
    assert.equal(by.sda.system, true); assert.equal(by.sda.prepare, "it is the system's disk");
    assert.deepEqual(by.sdb.parts.map((p) => p.state), ['empty']); assert.equal(by.sdb.prepare, ''); assert.equal(by.sdb.erases, false); assert.equal(by.sdb.model, 'WD Blue');
    assert.deepEqual(by.sdc.parts.map((p) => [p.name, p.state, p.label]), [['sdc1', 'mountable', 'photos']]); assert.equal(by.sdc.erases, true, 'what it erases is said');
    assert.deepEqual(by.sdd.parts.map((p) => [p.state, p.mount]), [['place', '/mnt/data']]); assert.equal(by.sdd.prepare, 'something on it is in use');
    assert.equal(by.nvme0n1.parts[0].state, 'part-of-more'); assert.notEqual(by.nvme0n1.prepare, '');
    assert.deepEqual(readDisks('not json'), []);
});

test('mount and prepare only what may be: the name typed again to erase', async () => {
    const asked = [];
    const host = async (argv) => {
        asked.push(argv.join(' '));
        if (argv.join(' ') === 'disks list') return { code: 0, stdout: LSBLK, stderr: '' };
        if (argv[1] === 'places') return { code: 0, stdout: 'now /var/snap/multipass/common 2049 100000 50000\nplace /mnt/data 3000 2000000 1900000\nplace /mnt/disk2 3001 11000 7000\n', stderr: '' };
        return { code: 0, stdout: argv[1] === 'prepare' ? 'prepared /dev/sdb1, mounted /mnt/sdb\n' : 'mounted /mnt/sdc1\n', stderr: '' };
    };
    const m = new MachinesMove({ host, usedMb: () => 4000 });
    const { disks } = await m.disks();
    assert.equal(disks.find((x) => x.name === 'sdd').parts[0].why, '', 'a place the machines may go to');
    await assert.rejects(m.prepare('/dev/sdb', 'sdc'), /Type its name, sdb/);
    await assert.rejects(m.prepare('/dev/sda', 'sda'), /system's disk/);
    await assert.rejects(m.prepare('/dev/nvme0n1', 'nvme0n1'), /Not this one/);
    assert.deepEqual(await m.prepare('/dev/sdb', 'sdb'), { prepared: 'prepared /dev/sdb1, mounted /mnt/sdb' });
    await assert.rejects(m.mount('/dev/sdd1'), /cannot be mounted here/);
    assert.deepEqual(await m.mount('/dev/sdc1'), { mounted: '/mnt/sdc1' });
    assert.ok(asked.includes('disks prepare /dev/sdb sdb') && asked.includes('disks mount /dev/sdc1'));
    assert.ok(!asked.some((a) => /prepare \/dev\/(sda|nvme)/.test(a)), 'never asked of the host');
});

test('room set aside and not used: read from the host, said on its disk, given only where there is some', async () => {
    const { readRooms } = await import('../server/machinesmove.mjs');
    assert.deepEqual(readRooms('lvroom / /dev/mapper/ubuntu--vg-ubuntu--lv ubuntu-vg 1740000 ext4\nlvroom ../x a b 1 ext4\njunk\n'), [{ mount: '/', volume: '/dev/mapper/ubuntu--vg-ubuntu--lv', group: 'ubuntu-vg', freeMb: 1740000, fs: 'ext4' }]);
    const asked = [];
    const host = async (argv) => {
        asked.push(argv.join(' '));
        if (argv.join(' ') === 'disks list') return { code: 0, stdout: LSBLK, stderr: '' };
        if (argv.join(' ') === 'disks room') return { code: 0, stdout: 'lvroom / /dev/mapper/vg-root ubuntu-vg 1740000 ext4\nlvroom /mnt/data /dev/mapper/vg-data vg2 300 ext4\n', stderr: '' };
        if (argv[1] === 'grow') return { code: 0, stdout: 'grown / 1840000\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const m = new MachinesMove({ host, usedMb: () => 4000 });
    const { disks } = await m.disks();
    assert.deepEqual(disks.find((d) => d.name === 'sda').unused.map((u) => [u.mount, u.freeMb]), [['/', 1740000]], 'the system\'s, on the system\'s disk');
    assert.deepEqual(disks.find((d) => d.name === 'sdd').unused.map((u) => u.mount), ['/mnt/data']);
    assert.deepEqual(await m.grow('/'), { grown: '/', sizeMb: 1840000 });
    await assert.rejects(m.grow('/mnt/data'), /Less than 1 GB/);
    await assert.rejects(m.grow('/etc'), /no room set aside/);
    assert.equal(asked.filter((a) => a.startsWith('disks grow')).length, 1, 'asked of the host only where there is room');
});

test('a room that could not be read is said on its disk, as it was read', async () => {
    const host = async (argv) => {
        if (argv.join(' ') === 'disks list') return { code: 0, stdout: LSBLK, stderr: '' };
        if (argv.join(' ') === 'disks room') return { code: 0, stdout: 'lvwhy / 1756345_00x\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
    };
    const { disks } = await new MachinesMove({ host, usedMb: () => 4000 }).disks();
    const sda = disks.find((d) => d.name === 'sda');
    assert.deepEqual(sda.unused, []);
    assert.deepEqual(sda.unreadable, [{ mount: '/', read: '1756345_00x' }]);
});
