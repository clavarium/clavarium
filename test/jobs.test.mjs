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

test('each job keeps a log: its steps once each, a count going on kept every 10 s and its last, the lines noted, its end', () => {
    let now = Date.parse('2026-11-14T08:00:00Z');
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
    const jobs = new Jobs({ path: join(dir, 'jobs.json'), now: () => now });
    const store = new Store(join(dir, 'c.json'), { onChange: (b, a) => jobs.seen(b, a) });
    store.put({ name: 'b', title: 'B', phase: 'building', copyOf: 'a', step: 'Making its machine' });
    store.patch('b', { title: 'B (copy)' });   /* the same step: not again */
    store.patch('b', { step: "Copying Claude Code's memory" });
    for (let mb = 1; mb <= 30; mb++) { now += 1000; store.patch('b', { step: `Copying Claude Code's memory: ${mb} MB read` }); }
    jobs.note('b', "Its original's reading: tar 12 D");
    jobs.note('nobody', 'lost, and nothing breaks');
    const { id } = jobs.list(store.all()).running[0];
    assert.match(id, /^b-2026-11-14T08-00-00-000Z$/);
    assert.equal(jobs.list(store.all()).running[0].log, undefined, 'the list stays light');
    now += 1000;
    store.patch('b', { phase: 'failed', error: 'its original stopped sending' });
    const texts = jobs.log(id).log.map((l) => l.text);
    assert.deepEqual(texts, ['Making its machine', "Copying Claude Code's memory", ...[1, 11, 21, 30].map((mb) => `Copying Claude Code's memory: ${mb} MB read`), "Its original's reading: tar 12 D", 'Failed: its original stopped sending']);
    assert.equal(jobs.log(id).result, 'failed');
    assert.equal(jobs.list([]).done[0].log, undefined);
    assert.equal(jobs.log('nothing-such'), undefined);
    /* Kept on disk with its log, read back by a server started again. */
    assert.deepEqual(new Jobs({ path: join(dir, 'jobs.json'), now: () => now }).log(id).log.map((l) => l.text), texts);
});

test('a log has 300 lines at most, its newest, each 300 characters at most; at most 50 jobs are kept', () => {
    let now = Date.parse('2026-11-14T08:00:00Z');
    const jobs = new Jobs({ now: () => now });
    jobs.seen(undefined, { name: 'x', phase: 'building' });
    for (let i = 0; i < 400; i++) jobs.note('x', `line ${String.fromCharCode(97 + (i % 26))}${i}`.padEnd(i === 399 ? 500 : 0, '.'));
    const { id } = jobs.list([{ name: 'x', phase: 'building' }]).running[0];
    const { log } = jobs.log(id);
    assert.equal(log.length, 300);
    assert.equal(log.at(-1).text.length, 300);
    assert.match(log[0].text, /^line \w100$/);
    for (let i = 0; i < 60; i++) { now += 1000; jobs.seen(undefined, { name: `j${i}`, phase: 'building' }); jobs.seen({ name: `j${i}` }, { name: `j${i}`, phase: 'ready' }); }
    assert.equal(jobs.list([]).done.length, 50);
    assert.deepEqual(jobs.log(jobs.list([]).done[0].id).log.map((l) => l.text), ['Done']);
});
