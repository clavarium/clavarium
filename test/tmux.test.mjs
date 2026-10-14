import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCommand, killCommand, SOCKET } from '../server/tmux.mjs';

test('the tool is the only program of its session: no shell stands behind it', () => {
    const argv = attachCommand('demo', ['mytool', '--flag'], '/work');
    assert.deepEqual(argv.slice(0, 11), ['tmux', '-L', SOCKET, 'new-session', '-A', '-s', 'demo', '-c', '/work', 'mytool', '--flag']);
    assert.equal(argv.some((a) => /^(ba|z|da)?sh$/.test(a) || a === '-c' && false), false);
    /* After the command, only tmux settings, each introduced by a lone ";". */
    const rest = argv.slice(11).join(' ');
    assert.equal(rest, '; set -sg escape-time 10 ; set -g status off ; set -g mouse on ; set -g focus-events on ; set -as terminal-features ,xterm*:hyperlinks');
});

test('a command cannot smuggle a tmux command, and a name is checked before it reaches tmux', () => {
    assert.throws(() => attachCommand('demo', ['tool', ';', 'kill-server']), /bare ";"/);
    assert.throws(() => attachCommand('demo', []), /needs a command/);
    assert.throws(() => attachCommand('demo', ['tool', '']), /needs a command/);
    assert.throws(() => attachCommand('Demo; rm', ['tool']), /not a conversation name/);
    assert.throws(() => killCommand('x y'), /not a conversation name/);
    /* "=" asks tmux for an exact match: "demo" must never end "demo-2". */
    assert.deepEqual(killCommand('demo'), ['tmux', '-L', SOCKET, 'kill-session', '-t', '=demo']);
});
