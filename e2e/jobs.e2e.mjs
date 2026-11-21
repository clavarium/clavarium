/* WHAT CLAVARIUM IS DOING (14-11): a conversation built is a job, ended done and kept for the day; with nothing
   under way and nothing failed, the badge by the list's title is not there, and the page says nothing wrong;
   Settings, Jobs, has it, its log opened. */
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
    /* Its list opened, then Escape: the list closed, the conversation still open under it. */
    await page.evaluate(() => { document.getElementById('jobs-open').hidden = false; });
    await page.locator('#jobs-open').click();
    await me.until('its list open', async () => page.locator('#jobs').isVisible());
    assert.match(await page.locator('#jobs').innerText(), /Today[\s\S]*Building/);
    await page.keyboard.press('Escape');
    await me.until('its list closed', async () => !(await page.locator('#jobs').isVisible()));
    assert.equal(await page.locator('#name').innerText(), 'clavarium-dev');
    /* Settings, Jobs: its build there, opened to its log -- its steps, timed, then done. */
    await page.locator('#nav-settings').click();
    await me.chapter('s-jobs');
    const build = page.locator('#jobs-list details.job-line[data-result="done"]').filter({ hasText: 'Building' }).first();
    await me.until('its build in Jobs', async () => (await build.count()) === 1);
    await build.locator(':scope > summary').click();
    await me.until('its log read', async () => (await build.locator('.job-log time').count()) >= 2);
    const lines = await build.locator('.job-log li').allInnerTexts();
    assert.match(lines.at(-1), /^\d\d:\d\d:\d\d\s+Done$/);
    const id = await build.getAttribute('data-job');
    assert.equal((await page.evaluate((x) => fetch(`/api/jobs/log?id=${encodeURIComponent(x)}`).then((r) => r.json()), id)).log.at(-1).text, 'Done');
    assert.equal(await page.evaluate(() => fetch('/api/jobs/log?id=none').then((r) => r.status)), 404);
    assert.deepEqual(me.errors, []);
});
