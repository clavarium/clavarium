/* WHAT CLAVARIUM IS DOING (14-11): a conversation built is a job, ended done and kept for the day; with nothing
   under way and nothing failed, the badge by the list's title is not there, and the page says nothing wrong. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

test('a conversation built is a job done of the day; nothing under way, no badge', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('clavarium-dev');
    const page = me.page;
    let jobs;
    await me.until('its build said done', async () => {
        jobs = await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()));
        return jobs.done.some((x) => x.what.startsWith('Building') && x.result === 'done');
    });
    assert.deepEqual(jobs.running, []);
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#jobs-open').isVisible(), false);
    assert.deepEqual(me.errors, []);
});
