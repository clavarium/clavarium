/* The curves of the resources (server/history.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { History, BLOCK_MS } from '../server/history.mjs';
import { handleApi } from '../server/api.mjs';

const room = (ticks, idle, vmTicks, rss = 900) => ({ places: [{ what: 'machines', sizeMb: 1000, freeMb: 250 }], memory: { totalMb: 8000, availableMb: 2000 }, machines: [{ vm: 'clv-demo', rssMb: rss }], cpu: { ticks, idle, cores: 4 }, machineCpu: { 'clv-demo': vmTicks } });
const at = (t) => new Date(t).toISOString();

test('the server and each machine, one look a minute: memory, CPU since the last look, disk', () => {
    let clock = Date.UTC(2026, 9, 21, 10, 0);
    const h = new History({ now: () => clock });
    const machine = (health) => [{ name: 'demo', vm: 'clv-demo', cores: 2, memoryMb: 2048, health }];
    h.sample(room(10_000, 6_000, 1_000), machine(null));
    clock += 60_000;
    /* In a minute, 4 cores tick 24 000 times: 12 000 of them busy; the machine took 12 000 (its 2 cores, fully). */
    h.sample(room(34_000, 18_000, 13_000), machine({ at: at(clock), memory: { totalMb: 2000, availableMb: 500 }, disks: { '/': { sizeMb: 8000, availableMb: 6000 } }, oomKills: 0 }));
    const s = h.series('server', '1h');
    assert.deepEqual(s.memory, [75, 75]);
    assert.deepEqual(s.cpu, [null, 50], 'none at the first look: CPU is a difference of two');
    assert.deepEqual(s.disk, [75, 75]);
    const m = h.series('demo', '1h');
    assert.deepEqual(m.cpu, [null, 100]);
    assert.deepEqual(m.memory, [43.9, 75], 'what its process holds here first; then what is used inside, once seen');
    assert.deepEqual(m.disk, [null, 25]);
    assert.deepEqual(m.marks, []);
});

test('a program stopped for lack of memory is a mark; a machine not running is a gap', () => {
    let clock = Date.UTC(2026, 9, 21, 10, 0);
    const h = new History({ now: () => clock });
    const look = (oomKills, running = true) => { h.sample(running ? room(clock, 0, 0) : { ...room(clock, 0, 0), machines: [] }, [{ name: 'demo', vm: 'clv-demo', cores: 1, memoryMb: 1024, health: { at: at(clock), oomKills, memory: { totalMb: 1000, availableMb: 100 } } }]); clock += 60_000; };
    look(0); look(0); look(1); look(1, false);
    const m = h.series('demo', '1h');
    assert.equal(m.marks.length, 1);
    assert.equal(m.marks[0], Date.UTC(2026, 9, 21, 10, 2));
    assert.equal(m.memory.at(-1), null);
});

test('a day of minutes, then a week of fifteen-minute blocks holding their highest; kept in a file', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-history-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let clock = Date.UTC(2026, 9, 21, 0, 0);
    const file = join(dir, 'history.json');
    const h = new History({ file, now: () => clock });
    for (let i = 0; i < 60 * 30; i += 1) { h.sample({ ...room(0, 0, 0), memory: { totalMb: 100, availableMb: i % 15 === 7 ? 10 : 90 } }); clock += 60_000; }
    const day = h.series('server', '24h');
    assert.equal(day.t.length, 24 * 60, 'a day of minutes, no more');
    const week = h.series('server', '7d');
    assert.ok(week.t.every((x) => x % BLOCK_MS === 0));
    assert.ok(week.memory.every((v) => v === 90), 'each block holds its highest: a peak stays seen');
    assert.equal(h.series('server', '1h').t.length, 60);
    h.save();
    assert.ok(existsSync(file));
    const again = new History({ file, now: () => clock });
    assert.equal(again.series('server', '24h').t.length, 24 * 60, 'read back after a restart');
    assert.deepEqual(new History({ now: () => clock }).series('nobody', '1h').t, []);
});

test('together: one time axis, in gigabytes and cores; a machine asleep keeps its disk; the server itself is what is left', () => {
    let clock = Date.UTC(2026, 9, 21, 10, 0);
    const h = new History({ now: () => clock });
    const two = [{ name: 'demo', vm: 'clv-demo', cores: 2, memoryMb: 2048 }, { name: 'quiet', vm: 'clv-quiet', cores: 1, memoryMb: 1024 }];
    /* Only demo runs; quiet is asleep (no process here). */
    const look = (ticks, idle, vmTicks) => { h.sample(room(ticks, idle, vmTicks), two.map((m) => ({ ...m, health: m.name === 'demo' ? { at: at(clock), memory: { totalMb: 2048, availableMb: 1024 }, disks: { '/': { sizeMb: 8192, availableMb: 6144 } } } : null }))); clock += 60_000; };
    look(10_000, 6_000, 1_000); look(34_000, 18_000, 7_000);
    clock -= 60_000;
    const r = h.together('1h', [
        { name: 'demo', memoryMb: 2048, cores: 2, diskMb: 8192, hostDiskMb: 3072 },
        { name: 'quiet', memoryMb: 1024, cores: 1, diskMb: 8192, hostDiskMb: 1536, asleep: true },
        { name: 'new', memoryMb: 1024, cores: 1, diskMb: 8192, hostDiskMb: 512 },
    ], { memoryMb: 8192, cores: 4, diskMb: 4096 });
    assert.deepEqual(r.t, [Date.UTC(2026, 9, 21, 10, 0), Date.UTC(2026, 9, 21, 10, 1)]);
    assert.deepEqual(r.capacity, { memoryGb: 8, cores: 4, diskGb: 4 });
    assert.deepEqual(r.server.memory, [6, 6], '75 % of 8 GB');
    assert.deepEqual(r.server.cpu, [null, 2], 'half of 4 cores');
    assert.deepEqual(r.server.disk, [3, 3]);
    const [demo, quiet, fresh] = r.machines;
    assert.deepEqual(demo.alloc, { memoryGb: 2, cores: 2, diskGb: 8 });
    assert.deepEqual(demo.memory, [1, 1], 'half of its 2 GB');
    assert.deepEqual(demo.cpu, [null, 1], '6 000 ticks of 12 000 for its 2 cores: one core');
    assert.deepEqual(demo.disk, [2, 2]);
    assert.equal(demo.asleep, false); assert.equal(demo.since, null);
    assert.deepEqual(quiet.memory, [null, null]);
    assert.deepEqual(quiet.disk, [1.5, 1.5], 'asleep, its disk is what it holds on the server');
    assert.equal(quiet.asleep, true); assert.equal(quiet.since, null, 'never seen running');
    assert.deepEqual(fresh.disk, [null, null], 'nothing before its first look');
    assert.deepEqual(r.itself.memory, [5, 5], 'the server less its machines');
    assert.deepEqual(r.itself.disk, [0, 0], 'never below nothing');
    assert.deepEqual(r.itself.cpu, [null, 1]);
});

test('together, over a week: the blocks of the machines line up with the server; marks kept; last seen running', () => {
    let clock = Date.UTC(2026, 9, 21, 0, 0);
    const h = new History({ now: () => clock });
    for (let i = 0; i < 90; i += 1) {
        const running = i < 60;
        h.sample(running ? room(i * 1000, 0, 0) : { ...room(i * 1000, 0, 0), machines: [] }, [{ name: 'demo', vm: 'clv-demo', cores: 1, memoryMb: 1024, health: { at: at(clock), oomKills: i < 20 ? 0 : 1, memory: { totalMb: 1024, availableMb: i === 10 ? 0 : 512 } } }]);
        clock += 60_000;
    }
    clock -= 60_000;
    const r = h.together('7d', [{ name: 'demo', memoryMb: 1024, cores: 1, diskMb: 8192, asleep: true }], { memoryMb: 8000, cores: 4, diskMb: 1000 });
    assert.equal(r.t.length, 6);
    assert.ok(r.t.every((x) => x % BLOCK_MS === 0));
    const [demo] = r.machines;
    assert.equal(demo.memory.length, r.t.length);
    assert.deepEqual(demo.memory, [1, 0.5, 0.5, 0.5, null, null], 'a block holds its highest; asleep: nothing');
    assert.deepEqual(demo.marks, [Date.UTC(2026, 9, 21, 0, 15)]);
    assert.deepEqual(demo.disk, [null, null, null, null, null, null], 'no size known on the server: no disk said');
    assert.equal(demo.since, Date.UTC(2026, 9, 21, 0, 59), 'last seen running at its last minute');
});

test('GET /api/history/all: every machine with a disk (asleep too), with what it was given and what it holds here', async () => {
    let clock = Date.UTC(2026, 9, 21, 10, 0);
    const h = new History({ now: () => clock });
    h.sample(room(10_000, 6_000, 1_000), [{ name: 'demo', vm: 'clv-demo', cores: 2, memoryMb: 2048, health: null }]);
    let status, text;
    const args = new Array(43).fill(undefined);
    args[0] = Object.assign(Readable.from([]), { method: 'GET', url: '/api/history/all?span=24h', headers: {} });
    args[1] = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
    args[2] = { list: () => [
        { name: 'demo', phase: 'ready', memoryMb: 2048, cpus: 2, diskGb: 16 },
        { name: 'quiet', phase: 'ready', asleep: true, memoryMb: 1024 },
        { name: 'half-made', phase: 'building', memoryMb: 1024 },
    ] };
    args[3] = {}; args[5] = () => true;
    args[22] = { of: (name) => (name === 'demo' ? { disks: { '/': { sizeMb: 16_384, availableMb: 8192 } } } : null) };
    args[26] = { about: async () => ({ memory: { totalMb: 8192 }, disk: { sizeMb: 102_400 }, usage: { machines: { each: [{ name: 'quiet', mb: 2048 }] } } }), room: async () => ({ cpu: { cores: 4 } }) };
    args[34] = h;
    assert.equal(await handleApi(...args), true);
    assert.equal(status, 200);
    const r = JSON.parse(text);
    assert.equal(r.span, '24h');
    assert.deepEqual(r.capacity, { memoryGb: 8, cores: 4, diskGb: 100 });
    assert.deepEqual(r.machines.map((m) => m.name), ['demo', 'quiet'], 'a machine still being made has nothing to show');
    assert.deepEqual(r.machines[0].alloc, { memoryGb: 2, cores: 2, diskGb: 16 });
    assert.deepEqual(r.machines[1].alloc, { memoryGb: 1, cores: 1, diskGb: 8 }, 'the defaults when none was chosen');
    assert.equal(r.machines[1].asleep, true);
    assert.equal(r.server.memory.length, r.t.length);
});
