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
