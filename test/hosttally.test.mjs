/* What this server asks of the host, by 5-minute window, kept for Settings (vm.mjs HostTally; Diagnostics, Load). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostTally, Vms, LOAD_KEPT, COUNT_EVERY_MS, runner } from '../server/vm.mjs';

test('each window closed is said in the log and kept, the newest first, the last LOAD_KEPT only', () => {
    let now = 1_000_000;
    const lines = [];
    const t = new HostTally({ now: () => now, log: (l) => lines.push(l) });
    assert.deepEqual(t.windows().windows.map((w) => [w.open, w.commands]), [[true, 0]], 'nothing yet: one open window, empty');
    t.count(['vm', 'states'], 2000);
    t.count(['vm', 'exec', 'clv-demo', '--', 'sudo', '-n', 'fstrim', '--all'], 500);
    t.count(['vm', 'states'], 7000);
    t.noteBeat(true);
    const open = t.windows().windows[0];
    assert.equal(open.open, true); assert.equal(open.commands, 3); assert.equal(open.ms, 9500);
    assert.deepEqual(open.kinds[0], { kind: 'vm states', count: 2, ms: 9000, maxMs: 7000 }, 'the busiest first');
    assert.deepEqual(open.kinds[1], { kind: 'vm exec fstrim', count: 1, ms: 500, maxMs: 500 });
    assert.deepEqual(open.beats, { read: 1, fallback: 0 });
    assert.equal(open.loop, null, 'not measured unless asked');
    now += COUNT_EVERY_MS;
    t.count(['server', 'logs', 'clavarium', '1'], 100);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^host: 4 commands in 5 min, 10 s spent; vm states 2x 9s max 7s; vm exec fstrim 1x 1s max 1s; server logs 1x 0s max 0s; beat read 1x, fallback 0x$/);
    const after = t.windows().windows;
    assert.deepEqual(after.map((w) => Boolean(w.open)), [true, false]);
    assert.equal(after[1].commands, 4);
    for (let i = 0; i < LOAD_KEPT + 3; i++) { now += COUNT_EVERY_MS; t.count(['vm', 'states'], 1); }
    const many = t.windows().windows;
    assert.equal(many.length, LOAD_KEPT + 1, 'the open one and LOAD_KEPT closed');
    assert.ok(many[1].to > many[2].to, 'the newest first');
});

test('an idle server still closes its window when asked; event-loop delay is measured when asked', async () => {
    let now = 5_000_000;
    const t = new HostTally({ now: () => now, log: () => {} });
    t.count(['vm', 'states'], 10);
    now += 3 * COUNT_EVERY_MS;
    const w = t.windows().windows;
    assert.equal(w.length, 2); assert.equal(w[1].commands, 1); assert.equal(w[0].commands, 0);
    const looped = new HostTally({ log: () => {}, loop: true });
    await new Promise((ok) => setTimeout(ok, 120));
    const l = looped.windows().windows[0].loop;
    assert.ok(l && Number.isInteger(l.p50) && Number.isInteger(l.p99) && l.p99 >= l.p50, JSON.stringify(l));
    assert.ok(Number.isInteger(l.cpuMs) && l.cpuMs >= 0, 'its own processor time with it');
});

test('one tally for every command to the host: the wrapped runner and the machines\' commands, never counted twice', async () => {
    const t = new HostTally({ log: () => {} });
    const raw = async () => ({ code: 0, stdout: '', stderr: '' });
    const asHost = t.wrap(raw);
    const vms = new Vms(raw, [], { tally: t });
    await asHost(['server', 'usage']);
    await vms.run(['vm', 'info', 'clv-demo']);
    vms.noteBeat(false);
    const w = t.windows().windows[0];
    assert.equal(w.commands, 2);
    assert.deepEqual(w.kinds.map((k) => k.kind).sort(), ['server usage', 'vm info']);
    assert.deepEqual(w.beats, { read: 0, fallback: 1 });
});

test('a runner says a command cut at its time apart from one that failed', async () => {
    const run = runner([]);
    const cut = await run(['sleep', '5'], { timeoutMs: 100 });
    assert.equal(cut.timedOut, true);
    const failed = await run(['false']);
    assert.equal(failed.code, 1); assert.equal('timedOut' in failed, false);
});
