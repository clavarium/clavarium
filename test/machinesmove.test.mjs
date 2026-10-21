/* All the machines to another disk, from Settings (server/machinesmove.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachinesMove } from '../server/machinesmove.mjs';

const answer = 'now /var/snap/multipass/common 2049 20000 9000\nplace /mnt/disk2 1800 7000 6800\nplace /mnt/tiny 1900 2000 1500\nplace /home 2049 20000 9000\n';
function bench(usedMb = 4000) {
    const asked = [];
    const host = async (argv) => { asked.push(argv.join(' ')); if (argv[1] === 'places') return { code: 0, stdout: answer, stderr: '' }; if (argv[1] === 'moving') return { code: 0, stdout: 'state inactive\nsaid == copying\nsaid Done: the machines are on /mnt/disk2/clavarium-machines (2.8G free there).\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; };
    return { m: new MachinesMove({ host, usedMb: () => usedMb }), asked };
}

test('the disks they may go to, and why not the others: the same disk, too small', async () => {
    const { m } = bench();
    const p = await m.places();
    assert.equal(p.now.device, 2049);
    assert.deepEqual(p.places.map((x) => [x.at, x.why]), [['/mnt/disk2', ''], ['/mnt/tiny', 'too small: 1 GB free, about 5 GB needed'], ['/home', 'the machines are on this disk already']]);
});

test('moved only to a disk they may go to; how it went is read back', async () => {
    const { m, asked } = bench();
    await assert.rejects(m.move('/mnt/tiny'), /too small/);
    await assert.rejects(m.move('/etc'), /not one the machines can go to/);
    assert.deepEqual(await m.move('/mnt/disk2'), { started: true, to: '/mnt/disk2/clavarium-machines' });
    assert.ok(asked.includes('machines move /mnt/disk2'));
    const how = await m.moving();
    assert.equal(how.done, true); assert.equal(how.failed, false);
});

test('the copy a move left behind: its size, and removed on request', async () => {
    const asked = [];
    let left = 'old 4300\n';
    const host = async (argv) => {
        asked.push(argv.join(' '));
        if (argv[1] === 'places') return { code: 0, stdout: answer, stderr: '' };
        if (argv[1] === 'old') return { code: 0, stdout: left, stderr: '' };
        if (argv[1] === 'forget-old') { left = ''; return { code: 0, stdout: '', stderr: '' }; }
        return { code: 0, stdout: '', stderr: '' };
    };
    const m = new MachinesMove({ host, usedMb: () => 4000 });
    assert.equal((await m.places()).oldMb, 4300);
    assert.deepEqual(await m.forgetOld(), { removed: true });
    assert.ok(asked.includes('machines forget-old'));
    assert.equal((await m.places()).oldMb, null);
    const refusing = new MachinesMove({ host: async (argv) => (argv[1] === 'forget-old' ? { code: 78, stdout: '', stderr: 'REFUSED: a machine still runs from the old copy: not removed' } : { code: 0, stdout: '', stderr: '' }) });
    await assert.rejects(refusing.forgetOld(), /still runs from the old copy/);
});
