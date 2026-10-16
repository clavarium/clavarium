/* This server's disk and memory (capacity.mjs): read from two read-only
   verbs, shown, and a reserve that refuses, in words, what would eat into it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Capacity, readRoom, readUsage, RESERVE_DISK_MB, RESERVE_MEMORY_MB, ROOM_MS, NEW_MACHINE_MB } from '../server/capacity.mjs';

function bench(t, { room, usage, conversations = [{ name: 'alpha', memoryMb: 2048 }, { name: 'beta', memoryMb: 4096 }], shelfMb } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-capacity-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const world = { clock: 1_000_000, room: room ?? ['place machines 7 102400 51200', 'place data 7 102400 51200', 'place folders 9 20480 18432', 'memory 16384 10240', 'machine clv-alpha 1024'].join('\n'), usage: usage ?? 'used data 100\nused folders 2000\nused work 3000\nused machine clv-alpha 4000\nused machine clv-gone 1000\nused shelf 3500\nused images 700\nused others 0' };
    const asked = [];
    const run = async (argv) => { asked.push(argv.join(' ')); if (argv[1] === 'room') return world.room === null ? { code: 1, stdout: '' } : { code: 0, stdout: world.room }; return { code: 0, stdout: world.usage }; };
    const capacity = new Capacity({ run, store: new Store(join(dir, 'server.json')), conversations: { list: () => conversations }, shelf: shelfMb ? { about: () => ({ current: { sizeMb: shelfMb } }) } : null, now: () => world.clock });
    return { capacity, world, asked };
}

test('only lines of the expected shape are read: numbers, our machines, known places', () => {
    const room = readRoom(['place machines 7 100 40', 'place elsewhere 7 1 1', 'place data x 1 1', 'memory 8192 4096', 'memory -1 2', 'machine clv-a 512', 'machine evil 1', 'machine clv-a 9', 'machine clvshelf-20261014-120000 300', 'junk'].join('\n'));
    assert.deepEqual(room, { places: [{ what: 'machines', device: 7, sizeMb: 100, freeMb: 40 }], memory: { totalMb: 8192, availableMb: 4096 }, machines: [{ vm: 'clv-a', rssMb: 512 }, { vm: 'clvshelf-20261014-120000', rssMb: 300 }] });
    assert.deepEqual(readUsage('used data 5\nused machine clv-a 7\nused machine ../x 1\nused nonsense 3\nused images 1e9'), { data: 5, machines: { a: 7 } });
});

test('what Settings shows: each disk once with what it holds, memory with what running machines may still take, what takes the room', async (t) => {
    const b = bench(t);
    const about = await b.capacity.about();
    assert.deepEqual(about.reserve, { diskMb: RESERVE_DISK_MB, memoryMb: RESERVE_MEMORY_MB });
    assert.deepEqual(about.disk, { sizeMb: 102400, freeMb: 51200, usedPercent: 50, disks: [{ holds: ['machines', 'data'], sizeMb: 102400, freeMb: 51200, usedPercent: 50 }, { holds: ['folders'], sizeMb: 20480, freeMb: 18432, usedPercent: 10 }] });
    /* alpha was given 2 GB and holds 1: 1 GB more will be taken. */
    assert.deepEqual(about.memory, { totalMb: 16384, freeMb: 10240, promisedMb: 1024, spareMb: 9216, usedPercent: 44 });
    assert.deepEqual(about.machines, [{ name: 'alpha', shelf: false, rssMb: 1024, sizeMb: 2048 }]);
    assert.deepEqual(about.high, { disk: false, memory: false });
    assert.equal(about.usage.machines.disksMb, 5000);
    assert.deepEqual(about.usage.machines.each, [{ name: 'alpha', mb: 4000 }, { name: 'gone', mb: 1000 }]);
    assert.deepEqual(about.usage.clavarium, { dataMb: 100, foldersMb: 2000, workMb: 3000, removedMb: null, toolsMb: null });
    assert.equal(about.usage.machines.shelfMb, 3500);
    /* Asked again only once old. */
    await b.capacity.about();
    assert.equal(b.asked.filter((a) => a === 'server room').length, 1);
    b.world.clock += ROOM_MS;
    await b.capacity.about();
    assert.equal(b.asked.filter((a) => a === 'server room').length, 2);
    assert.equal(b.asked.filter((a) => a === 'server usage').length, 1);
});

test('high, for the small gauge: fuller than 85 %, or less free than one and a half times the reserve', async (t) => {
    for (const [room, high] of [
        ['place machines 1 100000 50000\nmemory 16384 10000', { disk: false, memory: false }],
        ['place machines 1 100000 14000\nmemory 16384 10000', { disk: true, memory: false }],
        ['place machines 1 1000000 4000\nmemory 16384 10000', { disk: true, memory: false }],
        ['place machines 1 100000 50000\nmemory 16384 2000', { disk: false, memory: true }],
        ['place machines 1 100000 50000\nmemory 65536 1400', { disk: false, memory: true }],
    ]) {
        const b = bench(t, { room, conversations: [] });
        assert.deepEqual((await b.capacity.about()).high, high, room);
        assert.equal((await b.capacity.brief()).high, high.disk || high.memory);
    }
    const short = await bench(t, { room: 'place machines 1 100000 50000\nplace folders 2 20000 3500\nmemory 16384 1400', conversations: [] }).capacity.brief();
    assert.deepEqual(short.disk, { usedPercent: 83, freeMb: 3500, aboveMb: 428, high: true, level: 'bad' }, 'the shortest disk is the one said');
    assert.deepEqual(short.memory, { usedPercent: 91, freeMb: 1400, aboveMb: 376, high: true, level: 'bad' });
    /* Not readable: not high. */
    const b = bench(t);
    b.world.room = null;
    assert.deepEqual(await b.capacity.brief(), { known: false, high: false });
});

test('the reserve: refuses what would eat into it, in words that say why and what to do; a start is never refused for disk', async (t) => {
    const b = bench(t, { room: 'place machines 1 100000 5000\nmemory 16384 3500', conversations: [] });
    /* 3.5 GB free, 1 GB kept: 2.5 GB can be given. */
    await b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 2048 });
    await assert.rejects(b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 3072 }), (e) => e.status === 409 && e.message === 'Not started: this server cannot spare 3.0 GB of memory for alpha. It has 3.4 GB free for machines and keeps 1.0 GB in reserve. Put a conversation you are not using to sleep, or lower the reserve in Settings, This server.');
    await assert.rejects(b.capacity.check({ kind: 'create', memoryMb: 3072 }), /^Error: Not created: this server cannot spare 3\.0 GB of memory for a new machine\..* choose less memory, or lower the reserve/);
    /* Disk: a new machine takes what a ready-made one does, or NEW_MACHINE_MB; 5 GB free, 3 kept. */
    await assert.rejects(b.capacity.check({ kind: 'create', memoryMb: 1024 }), (e) => e.message === `Not created: this server cannot spare the ${(NEW_MACHINE_MB / 1024).toFixed(1)} GB of disk a new machine takes. It has 4.9 GB of disk free and keeps 3.0 GB in reserve. Archive conversations you no longer need, or lower the reserve in Settings, This server.`);
    await b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 1024 });
    await b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 1024 });
    await assert.rejects(b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 4096 }), /^Error: Not changed: this server cannot spare 4\.0 GB more disk for alpha\./);
    await assert.rejects(b.capacity.check({ kind: 'grow', name: 'alpha', memoryMb: 3072 }), /Not changed: this server cannot spare 3\.0 GB more memory for alpha\..*or give it less, or lower/);
    /* Lowered by the owner: allowed. */
    assert.deepEqual(b.capacity.setReserve({ diskMb: 0, memoryMb: 0 }), { diskMb: 0, memoryMb: 0 });
    await b.capacity.check({ kind: 'create', memoryMb: 3072 });
    assert.throws(() => b.capacity.setReserve({ diskMb: -1 }), /whole number of megabytes/);
    assert.throws(() => b.capacity.setReserve({ memoryMb: 1.5 }), /whole number/);
    assert.deepEqual(b.capacity.setReserve({ memoryMb: 512 }), { diskMb: 0, memoryMb: 512 }, 'what is not given stays');
    /* Each check reads what is free afresh. */
    assert.ok(b.asked.filter((a) => a === 'server room').length >= 8);
    /* A ready-made machine says what a copy takes. */
    const s = bench(t, { room: 'place machines 1 100000 9000\nmemory 16384 8000', conversations: [], shelfMb: 6500 });
    await assert.rejects(s.capacity.check({ kind: 'create', memoryMb: 1024 }), /the 6\.3 GB of disk a new machine takes/);
});

test('figures that cannot be read refuse nothing', async (t) => {
    const b = bench(t);
    b.world.room = null;
    await b.capacity.check({ kind: 'create', memoryMb: 999_999 });
    assert.equal((await b.capacity.about()).known, false);
});
