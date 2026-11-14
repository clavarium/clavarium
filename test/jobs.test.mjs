/* WHAT CLAVARIUM IS DOING (jobs.mjs): a busy phase is a job under way; leaving it ends it, done or failed with why. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jobs } from '../server/jobs.mjs';
import { Store } from '../server/store.mjs';

test('a copy built is a job under way with its step, then done; a failed build says why', () => {
    let now = Date.parse('2026-11-14T08:00:00Z');
    const jobs = new Jobs({ now: () => now });
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'jobs-')), 'c.json'), { onChange: (b, a) => jobs.seen(b, a) });
    store.put({ name: 'b', title: 'Assistant (copy)', phase: 'building', copyOf: 'a', sharedMachine: 'assistants' });
    store.patch('b', { step: 'Copying its work: 12 files, 3 MB' });
    let seen = jobs.list(store.all());
    assert.equal(seen.running.length, 1);
    assert.equal(seen.running[0].what, 'Copy Assistant (copy) in « assistants »');
    assert.equal(seen.running[0].step, 'Copying its work: 12 files, 3 MB');
    now += 60_000;
    store.patch('b', { phase: 'ready', step: undefined });
    store.put({ name: 'c', title: 'Test', phase: 'building' });
    store.patch('c', { phase: 'failed', error: 'Disk full' });
    seen = jobs.list(store.all());
    assert.deepEqual(seen.running, []);
    assert.deepEqual(seen.done.map((j) => [j.what, j.result, j.why]), [['Building Test', 'failed', 'Disk full'], ['Copy Assistant (copy) in « assistants »', 'done', undefined]]);
    /* A day later, gone. */
    now += 25 * 3600_000;
    assert.deepEqual(jobs.list(store.all()).done, []);
});

test('a conversation busy before a server restart is under way, and its end is kept on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
    const jobs = new Jobs({ path: join(dir, 'jobs.json') });
    assert.equal(jobs.list([{ name: 'm', title: 'M', phase: 'moving', sharedMachine: 'x' }]).running[0].what, 'Moving M into « x »');
    jobs.seen({ name: 'm', phase: 'moving' }, { name: 'm', title: 'M', phase: 'ready' });
    assert.equal(new Jobs({ path: join(dir, 'jobs.json') }).list([]).done[0].result, 'done');
});

test('a sleep or a rename is no job', () => {
    const jobs = new Jobs();
    jobs.seen({ name: 'a', phase: 'ready' }, { name: 'a', phase: 'ready', asleep: true, title: 'New' });
    assert.deepEqual(jobs.list([]), { running: [], done: [] });
});
