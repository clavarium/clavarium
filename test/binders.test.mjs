import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Binders } from '../server/binders.mjs';

function bench(t, { now = () => Date.now() } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-binders-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const posted = [];
    const names = ['coder', 'writer'];
    for (const n of names) mkdirSync(join(dir, 'work', n), { recursive: true });
    const b = new Binders({ dataDir: join(dir, 'data'), resources: { workFolder: (n) => join(dir, 'work', n) }, conversations: () => names,
        dockets: { post: (name, e) => posted.push([name, e.text]) }, now });
    return { b, dir, posted };
}

test('each conversation is given its .binder; one that is a link is left out', (t) => {
    const { b, dir } = bench(t);
    rmSync(join(dir, 'work', 'writer'), { recursive: true });
    mkdirSync(join(dir, 'work', 'writer'));
    symlinkSync(tmpdir(), join(dir, 'work', 'writer', '.binder'));
    b.pump();
    assert.ok(lstatSync(join(dir, 'work', 'coder', '.binder')).isDirectory());
    assert.ok(lstatSync(join(dir, 'work', 'writer', '.binder')).isSymbolicLink(), 'left as it was, and not used');
    assert.equal(existsSync(join(dir, 'data', 'binder', 'state.json')), false);
});

test('the owner acts as a person; a tool is told by its docket when given a record, when it is approved, when it comes due', (t) => {
    let clock = Date.parse('2026-11-04T08:00:00');
    const { b, posted } = bench(t, { now: () => clock });
    const l = b.act('create-list', { template: 'batches' }, 'owner@example.com').data;
    assert.equal(b.act('create-list', {}, '').ok, true, 'without sign-in, the owner');
    const r = b.act('add', { list: l.id, title: 'Dark mode', due: '2026-11-04 09:00' }, 'owner@example.com').data;
    assert.equal(r.by, 'person:owner@example.com');
    b.act('edit', { id: r.id, owners: ['conversation:coder'] }, 'owner@example.com');
    b.act('approve', { id: r.id }, 'owner@example.com');
    assert.deepEqual(posted.map(([n]) => n), ['coder', 'coder']);
    assert.match(posted[0][1], /Given to you in Binder: #1 Dark mode/);
    assert.match(posted[1][1], /Approved in Binder: #1 Dark mode/);
    assert.ok(b.changes() >= 4);
    assert.deepEqual(b.people('').map((p) => p.id), ['person:owner', 'conversation:coder', 'conversation:writer']);
    clock = Date.parse('2026-11-04T09:05:00');
    assert.equal(posted.length, 2);
});
