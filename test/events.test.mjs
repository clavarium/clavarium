/* What happened (server/events.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events } from '../server/events.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-events-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let clock = Date.UTC(2026, 9, 21, 8, 0);
    const file = join(dir, 'events.log');
    return { file, e: new Events({ file, now: () => (clock += 1000) }) };
}

test('the owner\'s requests worth saying, in words; a secret by its name only; the rest not said', (t) => {
    const { e, file } = bench(t);
    e.fromRequest('/api/conversations', { title: 'Site', tool: 'claude-code' }, 'ops@example.org', { name: 'site', title: 'Site', tool: 'claude-code' });
    e.fromRequest('/api/conversations/site/machine', { memoryMb: 4096, cpus: 2 }, 'ops@example.org');
    e.fromRequest('/api/secrets', { name: 'GITHUB_TOKEN', value: 'ghp_shouldneverbeseen' }, 'ops@example.org');
    e.fromRequest('/api/conversations/site/talk', { text: 'hello' }, 'ops@example.org');
    e.fromRequest('/api/files/save', {}, 'ops@example.org');
    const all = e.list();
    assert.deepEqual(all.map((x) => [x.kind, x.text, x.conversation ?? null]), [
        ['asset', 'Secret GITHUB_TOKEN set', null],
        ['machine', 'Machine of site resized: 4096 MB of memory, 2 cores', 'site'],
        ['conversation', 'Conversation "Site" made (claude-code)', 'site'],
    ]);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ghp_/);
    assert.equal(all[0].who, 'ops@example.org');
});

test('a secret replaced is said by its name and its expiry, never its value', (t) => {
    const { e, file } = bench(t);
    e.fromRequest('/api/secrets/GITHUB_TOKEN/replace', { value: 'ghp_shouldneverbeseen', expires: '2027-01-31' });
    e.fromRequest('/api/secrets/GITHUB_TOKEN/replace', { expires: '' });
    assert.deepEqual(e.list().map((x) => x.text), ['Secret GITHUB_TOKEN: no expiry', 'Secret GITHUB_TOKEN: value replaced, expires 2027-01-31']);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /ghp_/);
});

test('a size chosen while it sleeps is said kept for its wake, and given up', (t) => {
    const { e } = bench(t);
    e.fromRequest('/api/conversations/site/machine', { memoryMb: 3072 }, '', { name: 'site', phase: 'ready', asleep: true, sizeAtWake: { memoryMb: 3072, cpus: 1, diskGb: 8 } });
    e.fromRequest('/api/conversations/site/machine/cancel', {}, '', { name: 'site', phase: 'ready' });
    assert.deepEqual(e.list().map((x) => [x.text, x.conversation]), [
        ['Machine of site: the size kept for its wake given up', 'site'],
        ['Machine of site to be resized as it wakes: 3072 MB of memory', 'site'],
    ]);
});

test('chosen by kind, by conversation, by words; older ones a page at a time; a sign-in said once in a while', (t) => {
    const { e } = bench(t);
    for (let i = 0; i < 5; i += 1) e.add({ kind: 'machine', text: `look ${i}`, conversation: i % 2 ? 'a' : 'b' });
    e.add({ kind: 'update', text: 'Update 0.2.5 → 0.2.6: done' });
    assert.equal(e.list({ kind: 'machine' }).length, 5);
    assert.deepEqual(e.list({ conversation: 'a' }).map((x) => x.text), ['look 3', 'look 1']);
    assert.deepEqual(e.list({ q: 'UPDATE' }).map((x) => x.kind), ['update']);
    const first = e.list({ limit: 2 });
    assert.deepEqual(e.list({ limit: 2, before: first.at(-1).at }).map((x) => x.text), ['look 3', 'look 2']);
    assert.ok(e.seen('ops@example.org'));
    assert.equal(e.seen('ops@example.org'), null, 'not again so soon');
    assert.equal(e.seen(''), null, 'nobody: this machine alone');
    assert.equal(e.add({ kind: 'nonsense', text: 'x' }), null);
    assert.equal(e.fromRequest('/api/instance', { name: '' }).text, 'This Clavarium given back the name drawn from its address');
    assert.equal(e.fromRequest('/api/instance', { name: 'Home' }).text, 'This Clavarium named "Home"');
});
