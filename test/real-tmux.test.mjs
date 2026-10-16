/* THE REAL THING, when tmux is on the machine: a real PTY, a real tmux, a real
   program. Skipped where tmux is absent, and it says so. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { start } from '../server/main.mjs';
import { killCommand, SOCKET } from '../server/tmux.mjs';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const NAME = `selftest-${process.pid}`;

test('a real program in a real tmux: typed text reaches it, and a second screen finds the SAME session', { skip: !hasTmux && 'tmux is not installed' }, async (t) => {
    const server = await start({ port: 0, command: ['cat'], cwd: process.cwd() });
    t.after(() => { server.close(); const [p, ...a] = killCommand(NAME); spawnSync(p, a); });
    const host = `127.0.0.1:${server.address().port}`;
    const open = () => new WebSocket(`ws://${host}/terminal?c=${NAME}&cols=80&rows=24`, { headers: { origin: `http://${host}` } });
    const seen = (ws) => { let s = ''; ws.on('message', (d, binary) => { if (binary) s += d.toString(); }); return () => s; };
    const until = async (cond, what) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(cond(), what); };

    const first = open();
    const firstSaw = seen(first);
    await once(first, 'open');
    await new Promise((r) => setTimeout(r, 400));
    first.send(Buffer.from('marker-one\r'));
    /* `cat` echoes the line back: twice on screen, once typed and once printed. */
    await until(() => firstSaw().split('marker-one').length >= 3, 'the program never answered');

    const second = open();
    const secondSaw = seen(second);
    await once(second, 'open');
    await until(() => secondSaw().includes('marker-one'), 'the second screen did not find the running session');
    const sessions = spawnSync('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).stdout;
    assert.equal(sessions.split('\n').filter((s) => s === NAME).length, 1, 'one session, not two');
    second.close();
});

test('the line the server types and its Enter reach the program in two reads, in one tmux command, and a last ";" stays', { skip: !hasTmux && 'tmux is not installed' }, async (t) => {
    const { typeCommand } = await import('../server/talk.mjs');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'clv-type-'));
    const socket = `clvtype-${process.pid}`;
    t.after(() => { spawnSync('tmux', ['-L', socket, 'kill-server']); rmSync(dir, { recursive: true, force: true }); });
    /* A program that writes each read it gets on a line of its own, raw. */
    const program = `stty raw -echo; while true; do dd bs=4096 count=1 status=none | od -An -c | tr -s ' ' >> ${dir}/reads; done`;
    assert.equal(spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'main', 'sh', '-c', program]).status, 0);
    await new Promise((r) => setTimeout(r, 300));
    const argv = typeCommand('Read it;').map((a) => (a === 'clavarium' ? socket : a));
    assert.equal(spawnSync(argv[0], argv.slice(1)).status, 0);
    let reads = '';
    for (let i = 0; i < 100 && !reads.includes('\\r'); i++) { await new Promise((r) => setTimeout(r, 20)); try { reads = readFileSync(join(dir, 'reads'), 'utf8'); } catch { /* not yet */ } }
    const lines = reads.trim().split('\n').map((l) => l.trim());
    assert.deepEqual(lines, ['R e a d i t ;', '\\r'], 'the line in one read, Enter in another, the ";" kept');
});
