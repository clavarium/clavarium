/* What a terminal says by itself is no one typing (server/bridge.mjs, byHand). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byHand } from '../server/bridge.mjs';

test('the focus, its answers to the program (what it is, where its cursor is, its colours) are not typing', () => {
    for (const x of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b[I\x1b[O']) assert.equal(byHand(x), false, JSON.stringify(x));
});

test('keys are: a letter, Enter, an arrow, Ctrl-C, a paste, and a key among answers', () => {
    for (const x of ['a', '\r', '\x1b[A', '\x03', 'git status\r', '\x1b[I\x1b[Oh']) assert.equal(byHand(x), true, JSON.stringify(x));
});
