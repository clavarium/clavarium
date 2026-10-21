/* The curves of the resources (server/history.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, BLOCK_MS } from '../server/history.mjs';

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
