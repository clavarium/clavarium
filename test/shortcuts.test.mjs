import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shortcuts, DEFAULTS, SHORTCUTS_MAX } from '../server/shortcuts.mjs';
import { Store } from '../server/store.mjs';

function fresh(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-short-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'shortcuts.json');
}

test('a new installation starts with a few shortcuts, and they are not put back once removed', (t) => {
    const path = fresh(t);
    const first = new Shortcuts(new Store(path));
    assert.deepEqual(first.list().map((s) => s.label), DEFAULTS.map((d) => d.label));
    for (const shortcut of first.list()) first.remove(shortcut.id);
    assert.deepEqual(new Shortcuts(new Store(path)).list(), [], 'all removed stays all removed');
});

test('the two kinds: sent with Enter, or left to be completed', (t) => {
    const s = new Shortcuts(new Store(fresh(t)));
    const sent = s.add({ label: 'Compact', text: '/compact', enter: true });
    const left = s.add({ label: 'Fix', text: 'Fix the bug in ', enter: false });
    assert.deepEqual([sent.enter, left.enter, left.text], [true, false, 'Fix the bug in ']);
    assert.equal(s.add({ label: 'plain', text: 'y' }).enter, false, 'Enter is never pressed unless asked');
});

test('a text with a line break is refused: it would press Enter early', (t) => {
    const s = new Shortcuts(new Store(fresh(t)));
    for (const bad of [{ label: 'x', text: 'rm -rf /\nyes' }, { label: 'x', text: 'a\rb' }, { label: 'x\ny', text: 'ok' }, { label: '', text: 'ok' }, { label: 'x', text: ' ' }, { label: 'x', text: 'a\x1b[2J' }, { label: 'x'.repeat(41), text: 'ok' }, { label: 'x', text: 12 }]) {
        assert.throws(() => s.add(bad), /one line/, JSON.stringify(bad));
    }
});

test('there is a ceiling, and removing an unknown shortcut says so', (t) => {
    const s = new Shortcuts(new Store(fresh(t)));
    for (let i = 0; s.list().length < SHORTCUTS_MAX; i++) s.add({ label: `x${i}`, text: 'y' });
    assert.throws(() => s.add({ label: 'one more', text: 'y' }), /already 30/);
    assert.throws(() => s.add({ label: 'x0', text: 'z' }), /already has this label/);
    assert.throws(() => s.remove('00000000-0000-4000-8000-000000000000'), /No such/);
});
