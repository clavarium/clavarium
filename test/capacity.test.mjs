/* This server's disk and memory (capacity.mjs): read from two read-only
   verbs, shown, and a reserve that refuses, in words, what would eat into it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { MIN_FREE_MB } from '../server/shelf.mjs';
import { Capacity, readRoom, readUsage, RESERVE_DISK_MB, RESERVE_MEMORY_MB, RESERVE_DISK_PERCENT, RESERVE_MEMORY_PERCENT, ROOM_MS, NEW_MACHINE_MB } from '../server/capacity.mjs';

function bench(t, { room, usage, conversations = [{ name: 'alpha', memoryMb: 2048 }, { name: 'beta', memoryMb: 4096 }], shelfMb, awake = [], reclaim } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-capacity-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const world = { clock: 1_000_000, room: room ?? ['place machines 7 102400 51200', 'place data 7 102400 51200', 'place folders 9 20480 18432', 'memory 16384 10240', 'machine clv-alpha 1024'].join('\n'), usage: usage ?? 'used data 100\nused folders 2000\nused work 3000\nused machine clv-alpha 4000\nused machine clv-gone 1000\nused shelf 3500\nused images 700\nused others 0' };
    const asked = [];
    const run = async (argv) => { asked.push(argv.join(' ')); if (argv[1] === 'room') return world.room === null ? { code: 1, stdout: '' } : { code: 0, stdout: world.room }; return { code: 0, stdout: world.usage }; };
    const slept = []; const alerts = []; const said = []; const reclaimed = [];
    const capacity = new Capacity({ run, store: new Store(join(dir, 'server.json')), conversations: { list: () => conversations, awake: () => awake }, shelf: shelfMb ? { about: () => ({ current: { sizeMb: shelfMb } }) } : null, now: () => world.clock,
        sleep: async (name) => { slept.push(name); }, alert: (payload) => { alerts.push(payload); }, say: (name, text) => { said.push([name, text]); },
        reclaim: reclaim ?? (async (name) => { reclaimed.push(name); }) });
    return { capacity, world, asked, slept, alerts, said, reclaimed };
}

test('only lines of the expected shape are read: numbers, our machines, known places', () => {
    const room = readRoom(['place machines 7 100 40', 'place elsewhere 7 1 1', 'place data x 1 1', 'memory 8192 4096', 'memory -1 2', 'machine clv-a 512', 'machine evil 1', 'machine clv-a 9', 'machine clvshelf-20261014-120000 300', 'cpu 1000 400 4', 'cpu x 1 1', 'machinecpu clv-a 120', 'machinecpu evil 5', 'junk'].join('\n'));
    assert.deepEqual(room, { places: [{ what: 'machines', device: 7, sizeMb: 100, freeMb: 40 }], memory: { totalMb: 8192, availableMb: 4096 }, machines: [{ vm: 'clv-a', rssMb: 512 }, { vm: 'clvshelf-20261014-120000', rssMb: 300 }], cpu: { ticks: 1000, idle: 400, cores: 4 }, machineCpu: { 'clv-a': 120 } });
    assert.deepEqual(readUsage('used data 5\nused machine clv-a 7\nused machine ../x 1\nused nonsense 3\nused images 1e9'), { data: 5, machines: { a: 7 } });
});

test('what Settings shows: each disk once with what it holds, memory as the system says it, what was promised, what takes the room', async (t) => {
    const b = bench(t);
    const about = await b.capacity.about();
    /* The reserve kept: the larger of the fixed amount and the share (5 GB or 5 % of 100 GB; 1 GB or 5 % of 16 GB). */
    assert.deepEqual(about.reserve, { diskMb: Math.max(RESERVE_DISK_MB, 5120), memoryMb: RESERVE_MEMORY_MB });
    assert.deepEqual(about.settings, { diskMb: RESERVE_DISK_MB, diskPercent: RESERVE_DISK_PERCENT, memoryMb: RESERVE_MEMORY_MB, memoryPercent: RESERVE_MEMORY_PERCENT });
    assert.deepEqual(about.disk, { sizeMb: 102400, freeMb: 51200, usedPercent: 50, disks: [{ holds: ['machines', 'data'], sizeMb: 102400, freeMb: 51200, usedPercent: 50 }, { holds: ['folders'], sizeMb: 20480, freeMb: 18432, usedPercent: 10 }] });
    assert.deepEqual(about.memory, { totalMb: 16384, freeMb: 10240, usedPercent: 38 });
    /* Only said: two disks of 8 GB at their largest; 2 GB given to the one running machine. */
    assert.deepEqual(about.promised, { disk: { mb: 16384, totalMb: 102400, over: false }, memory: { mb: 2048, totalMb: 16384, over: false } });
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
    assert.deepEqual(short.disk, { usedPercent: 83, freeMb: 3500, aboveMb: -1620, high: true, level: 'bad' }, 'the shortest disk is the one said');
    assert.deepEqual(short.memory, { usedPercent: 91, freeMb: 1400, aboveMb: 376, high: true, level: 'bad' });
    /* Not readable: not high. */
    const b = bench(t);
    b.world.room = null;
    assert.deepEqual(await b.capacity.brief(), { known: false, high: false });
});

test('the reserve: refuses what would eat into it, in words that say why and what to do; a start is never refused for disk', async (t) => {
    const b = bench(t, { room: 'place machines 1 100000 8000\nmemory 16384 3500', conversations: [] });
    /* 3.5 GB free, 1 GB kept: 2.5 GB can be given. */
    await b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 2048 });
    await assert.rejects(b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 3072 }), (e) => e.status === 409 && e.message === 'Not started: this server cannot spare 3.0 GB of memory for alpha. It has 3.4 GB of memory free and keeps 1.0 GB in reserve. Put a conversation you are not using to sleep, or lower the reserve in Settings, This server.');
    await assert.rejects(b.capacity.check({ kind: 'create', memoryMb: 3072 }), /^Error: Not created: this server cannot spare 3\.0 GB of memory for a new machine\..* choose less memory, or lower the reserve/);
    /* Disk: a new machine takes what a ready-made one does, or NEW_MACHINE_MB; 7.8 GB free, 5 kept. */
    await assert.rejects(b.capacity.check({ kind: 'create', memoryMb: 1024 }), (e) => e.message === `Not created: this server cannot spare the ${(NEW_MACHINE_MB / 1024).toFixed(1)} GB of disk a new machine takes. It has 7.8 GB of disk free and keeps 5.0 GB in reserve. Archive conversations you no longer need, or lower the reserve in Settings, This server.`);
    await b.capacity.check({ kind: 'start', name: 'alpha', memoryMb: 1024 });
    await b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 1024 });
    await assert.rejects(b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 4096 }), (e) => e.status === 409 && e.message === 'Not changed: 7.8 GB of disk free, 10.0 GB needed.');
    await assert.rejects(b.capacity.check({ kind: 'grow', name: 'alpha', memoryMb: 3072 }), /Not changed: this server cannot spare 3\.0 GB more memory for alpha\..*or give it less, or lower/);
    /* Lowered by the owner: allowed. */
    assert.deepEqual(b.capacity.setReserve({ diskMb: 0, memoryMb: 0 }), { diskMb: 0, diskPercent: 5, memoryMb: 0, memoryPercent: 5 });
    /* The share still holds (5 % of 16 GB): */
    await assert.rejects(b.capacity.check({ kind: 'create', memoryMb: 3072 }), /keeps 0\.8 GB in reserve/);
    b.capacity.setReserve({ diskPercent: 0, memoryPercent: 0 });
    await b.capacity.check({ kind: 'create', memoryMb: 3072 });
    assert.throws(() => b.capacity.setReserve({ diskPercent: 101 }), /whole number of percent/);
    assert.throws(() => b.capacity.setReserve({ diskMb: -1 }), /whole number of megabytes/);
    assert.throws(() => b.capacity.setReserve({ memoryMb: 1.5 }), /whole number/);
    assert.deepEqual(b.capacity.setReserve({ memoryMb: 512 }), { diskMb: 0, diskPercent: 0, memoryMb: 512, memoryPercent: 0 }, 'what is not given stays');
    /* A share larger than the fixed amount is what is kept. */
    b.capacity.setReserve({ diskPercent: 20 });
    assert.equal((await b.capacity.about()).reserve.diskMb, 20000);
    /* Each check reads what is free afresh. */
    assert.ok(b.asked.filter((a) => a === 'server room').length >= 8);
    /* A ready-made machine says what a copy takes. */
    const s = bench(t, { room: 'place machines 1 100000 9000\nmemory 16384 8000', conversations: [], shelfMb: 6500 });
    await assert.rejects(s.capacity.check({ kind: 'create', memoryMb: 1024 }), /the 6\.3 GB of disk a new machine takes/);
});

/* The server kept 5 GB under a grown disk where the host program keeps 6:
   it accepted a resize the host then refused, once the machine was stopped. */
test('a disk grown: the floor of the host program, whatever reserve is set, at the same boundary as the host', async (t) => {
    const host = fileURLToPath(new URL('../deploy/clavarium-host', import.meta.url));
    assert.match(readFileSync(host, 'utf8'), new RegExp(`^SHELF_MIN_FREE_MB="${MIN_FREE_MB}"$`, 'm'), 'one floor, the same on both sides');
    const hostSays = (has, wants, free) => spawnSync('/bin/bash', [host, '--say-only', '--data', '/var/lib/clavarium', 'disk', 'room', String(has), String(wants), String(free)]).status === 0;
    for (const free of [12 * 1024 + MIN_FREE_MB - 1, 12 * 1024 + MIN_FREE_MB, 5 * 1024 + 12 * 1024 + 100]) {
        const b = bench(t, { room: `place machines 1 100000 ${free}\nmemory 16384 8000`, conversations: [] });
        b.capacity.setReserve({ diskMb: 0, diskPercent: 0 });
        const server = await b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 12 * 1024 }).then(() => true, () => false);
        assert.equal(server, hostSays(8, 20, free), `${free} MB free`);
    }
    /* A larger reserve set here still holds. */
    const b = bench(t, { room: 'place machines 1 100000 20000\nmemory 16384 8000', conversations: [] });
    b.capacity.setReserve({ diskMb: 10 * 1024 });
    await assert.rejects(b.capacity.check({ kind: 'grow', name: 'alpha', diskMb: 12 * 1024 }), (e) => e.message === 'Not changed: 19.5 GB of disk free, 22.0 GB needed.');
});

test('figures that cannot be read refuse nothing', async (t) => {
    const b = bench(t);
    b.world.room = null;
    await b.capacity.check({ kind: 'create', memoryMb: 999_999 });
    assert.equal((await b.capacity.about()).known, false);
});

test('what was promised is only said: more than there is is a warning, never a refusal', async (t) => {
    const b = bench(t, { room: 'place machines 1 20480 15000\nmemory 4096 3500\nmachine clv-alpha 500\nmachine clv-beta 500', conversations: [{ name: 'alpha', memoryMb: 2048, diskGb: 16 }, { name: 'beta', memoryMb: 4096 }] });
    const about = await b.capacity.about();
    assert.deepEqual(about.promised, { disk: { mb: 24 * 1024, totalMb: 20480, over: true }, memory: { mb: 6144, totalMb: 4096, over: true } });
    await b.capacity.check({ kind: 'create', memoryMb: 1024 });
});

test('watched: under the reserve, the owner is told and the running machine that takes the most is put to sleep, once', async (t) => {
    const b = bench(t, { room: 'place machines 1 102400 50000\nmemory 16384 800\nmachine clv-alpha 1024\nmachine clv-beta 3000', awake: ['alpha', 'beta'] });
    assert.deepEqual(await b.capacity.watch(), [{ what: 'memory', slept: 'beta' }]);
    assert.deepEqual(b.slept, ['beta']);
    assert.deepEqual(b.alerts, [{ title: 'This server is short of memory', body: '0.8 GB free, 1.0 GB kept in reserve. beta was put to sleep.', url: '/?open=settings&at=resources' }]);
    assert.equal(b.said[0][0], 'beta');
    assert.match(b.said[0][1], /^This server ran short of memory \(0\.8 GB free, 1\.0 GB kept in reserve\)\. This machine took the most, so it was put to sleep\./);
    /* Still under: nothing more. Back above, then under again: once more. */
    assert.deepEqual(await b.capacity.watch(), []);
    b.world.room = 'place machines 1 102400 50000\nmemory 16384 8000\nmachine clv-alpha 1024';
    assert.deepEqual(await b.capacity.watch(), []);
    b.world.room = 'place machines 1 102400 4000\nmemory 16384 8000\nmachine clv-alpha 1024\nmachine clv-beta 3000';
    /* Disk: the one whose disk is largest (alpha, by the last measure), though beta holds more memory. */
    await b.capacity.about();
    assert.deepEqual(await b.capacity.watch(), [{ what: 'disk', slept: 'alpha' }]);
    assert.equal(b.alerts.length, 2);
    /* Nothing running: the owner is told all the same. */
    const n = bench(t, { room: 'place machines 1 102400 50000\nmemory 16384 500' });
    assert.deepEqual(await n.capacity.watch(), [{ what: 'memory', slept: null }]);
    assert.deepEqual(n.slept, []);
    assert.equal(n.alerts.length, 1);
});

test('reclaimSleepers frees a sleeping machine still holding RAM, tells its owner, leaves the rest', async (t) => {
    const FREED = ['place machines 7 102400 51200', 'memory 16384 10240'].join('\n');
    let b;
    b = bench(t, {
        room: ['place machines 7 102400 51200', 'memory 16384 10240', 'machine clv-alpha 1024', 'machine clv-beta 50'].join('\n'),
        conversations: [{ name: 'alpha', memoryMb: 2048 }, { name: 'beta', memoryMb: 1024 }],
        awake: [],   // both asleep; alpha holds 1024MB (the bug), beta only 50MB (< floor)
        reclaim: async (name) => { b.reclaimed.push(name); b.world.room = FREED; },   // reclaim frees it
    });
    const done = await b.capacity.reclaimSleepers();
    assert.deepEqual(b.reclaimed, ['alpha'], 'only alpha (holds >=128MB); beta (50MB) is left alone');
    assert.deepEqual(done.map((d) => [d.name, d.freed]), [['alpha', true]]);
    assert.ok(b.alerts.some((a) => /Reclaimed/.test(a.title)), 'owner is told it was reclaimed');
    assert.ok(b.said.some(([n]) => n === 'alpha'), 'and it is said in its conversation');
    assert.ok(b.asked.includes('vm reclaim clv-alpha') === false, 'the host verb is behind the injected reclaim (unit level)');
});

test('reclaimSleepers never touches an awake machine', async (t) => {
    let b;
    b = bench(t, {
        room: ['place machines 7 102400 51200', 'memory 16384 10240', 'machine clv-alpha 1024'].join('\n'),
        awake: ['alpha'],
        reclaim: async (name) => { b.reclaimed.push(name); },
    });
    assert.deepEqual(await b.capacity.reclaimSleepers(), [], 'alpha is awake (in use) -> never reclaimed');
    assert.deepEqual(b.reclaimed, []);
});

test('reclaimSleepers does not loop on a stubborn machine (rate-limited, reported once)', async (t) => {
    let b;
    b = bench(t, {
        room: ['place machines 7 102400 51200', 'memory 16384 10240', 'machine clv-alpha 1024'].join('\n'),
        awake: [],
        reclaim: async (name) => { b.reclaimed.push(name); },   // never frees it: room keeps clv-alpha
    });
    await b.capacity.reclaimSleepers();
    await b.capacity.reclaimSleepers();   // same clock -> inside the cooldown
    assert.deepEqual(b.reclaimed, ['alpha'], 'tried once; not again within the cooldown');
    assert.ok(b.alerts.some((a) => /still holds memory/.test(a.title)), 'reported as not freed');
});
