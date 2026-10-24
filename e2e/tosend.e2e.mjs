/* To send: every repository of a conversation on one screen, as the owner
   uses it -- each ticked when its agent committed something, the checks run
   by themselves, one review of them all, one button that sends them one
   after the other; one refused (its remote moved) does not hold the other
   back, and each says what became of it. With CLAVARIUM_SHOTS set to a
   directory, each page is also saved there as a picture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Robin', GIT_AUTHOR_EMAIL: 'robin@example.com', GIT_COMMITTER_NAME: 'Robin', GIT_COMMITTER_EMAIL: 'robin@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

/* A repository with its remote (main), given to the conversation for writing; its agent's main one commit ahead. */
async function repository(b, me, name, file) {
    const remote = join(b.dir, `${name}.git`);
    git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const seed = join(b.dir, `${name}-seed`);
    git(b.dir, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), `# ${name}\n`); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    await me.api('/api/resources', { name, type: 'git' });
    await me.api(`/api/git/${name}/remote`, { url: remote });
    await me.api('/api/conversations/coder/resources', { resource: name, access: 'write' });
    await me.until(`the origin of ${name} is kept`, async () => (await me.api(`/api/git/${name}/keep`)).body.origin?.ok === true, 20_000);
    const work = join(b.dir, 'data', 'resources', name);
    git(work, 'fetch', '-q', join(b.dir, 'data', 'resources', `${name}-origin`), '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(work, file), `${file} of ${name}\n`); git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', `Add ${file}`);
    return { remote, seed, work, head: git(work, 'rev-parse', 'HEAD'), start: git(seed, 'rev-parse', 'HEAD') };
}

test('To send: two repositories reviewed together and sent with one button; one refused, the other sent', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    const site = await repository(b, me, 'site', 'contact.html');
    const styles = await repository(b, me, 'styles', 'forms.css');
    const page = me.page;
    await page.setViewportSize({ width: 1024, height: 768 });

    /* In its Assets, first: To send. */
    await page.locator('#view-assets').click();
    const entry = page.locator('#cassets-rows .as-row[data-asset="send:all"]');
    await me.until('To send is offered', async () => await entry.isVisible());
    await entry.click();
    const row = (name) => page.locator(`#cassets-detail .ts-row[data-repo="${name}"]`);
    /* Read repository by repository, said as it goes; then both, to update on the remote, ticked -- nothing checked yet. */
    const progress = page.locator('#cassets-detail .ts-progress');
    await me.until('all read', async () => /all read$/.test(await progress.innerText().catch(() => '')), 30_000);
    assert.equal(await progress.innerText(), '2 to update · 0 new · all read');
    assert.equal(await page.locator('#cassets-detail .ts-filters button[aria-pressed="true"]').innerText(), 'To update 2');
    for (const name of ['site', 'styles']) assert.equal(await row(name).locator('input[type=checkbox]').isChecked(), true, name);
    assert.match(await row('site').innerText(), /site[\s\S]*main[\s\S]*1 commit[\s\S]*\+1[\s\S]*to check/);
    assert.equal(await row('site').locator('select').inputValue(), 'main');
    const go = page.locator('#cassets-detail [data-act="send-all"]');
    /* The checks, of what is ticked, on a click; then Send. */
    assert.equal(await go.innerText(), 'Check the 2');
    /* The hook of styles fails: said, and why one tap away, with what to do; checked again once fixed. */
    const hook = join(styles.work, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho "tests are red"\nexit 1\n', { mode: 0o755 });
    await go.click();
    await me.until('styles failed', async () => /Checks failed/.test(await row('styles').locator('.ts-state').innerText().catch(() => '')), 30_000);
    assert.match(await row('site').locator('.ts-state').innerText(), /Nothing to check/);
    await row('styles').locator('.ts-why-open').click();
    const why = row('styles').locator('.ts-why-box');
    assert.match(await why.innerText(), /tests are red/);
    assert.match(await why.locator('[data-act="tell-agent"]').innerText(), /its agent/);
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await why.locator('[data-act="check-again"]').click();
    await me.until('checked', async () => (await go.innerText()) === 'Send the 2 to main', 30_000);
    assert.match(await row('styles').locator('.ts-state').innerText(), /Checks passed/);
    await shot(page, 'tablet-to-send');

    /* One review of both: the files of each under its name, the changes of each. */
    await page.locator('#cassets-detail [data-act="send-review"]').click();
    await me.until('the review of both', async () => (await page.locator('#cassets-detail .ts-diff').count()) === 2);
    assert.deepEqual((await page.locator('#cassets-detail .ts-tree-repo b').allInnerTexts()).map((x) => x.toLowerCase()), ['site', 'styles']);
    assert.match(await page.locator('#cassets-detail .ts-diff[data-repo="styles"]').innerText(), /forms\.css of styles/);
    await shot(page, 'tablet-to-send-review');
    /* Escape closes the review, as Back does; the rows stay. */
    await page.locator('#cassets-detail h2').click();
    await page.keyboard.press('Escape');
    await me.until('the review is closed', async () => !(await page.locator('#cassets-detail .ts-review').isVisible()));
    assert.equal(await row('site').isVisible(), true);

    /* From a repository with others beside it, "Send to main..." leads here too. */
    await page.locator('#cassets-rows .as-row[data-asset="git:site"]').click();
    const send = page.locator('#cassets-detail [data-act="send"]');
    await me.until('its Send', async () => await send.isVisible(), 20_000);
    await send.click();
    await me.until('To send again, all read', async () => /all read$/.test(await progress.innerText().catch(() => '')), 30_000);
    /* Left and come back: the checks of these very commits are kept, said with their age -- nothing run again. */
    await me.until('the checks kept', async () => (await go.innerText()) === 'Send the 2 to main', 30_000);
    assert.match(await row('styles').locator('.ts-state').innerText(), /Checks passed · just now/);
    assert.equal(await page.locator('#cassets-rows .as-row[aria-current="true"]').getAttribute('data-asset'), 'send:all');

    /* Unticked: left out, and said by the button. */
    await row('styles').locator('input[type=checkbox]').uncheck();
    assert.equal(await go.innerText(), 'Send it to main');
    await row('styles').locator('input[type=checkbox]').check();

    /* Meanwhile, the remote of styles moves: styles is refused, site goes. */
    writeFileSync(join(styles.seed, 'other.txt'), 'someone else\n'); git(styles.seed, 'add', '.'); git(styles.seed, 'commit', '--quiet', '-m', 'Someone else'); git(styles.seed, 'push', '--quiet', 'origin', 'HEAD:main');
    const moved = git(styles.seed, 'rev-parse', 'HEAD');
    await go.click();
    assert.equal(await go.innerText(), 'Yes, send the 2 to main: this cannot be undone');
    await go.click();
    await me.until('it says what became of each', async () => /1 of 2 sent; the others say why\./.test(await page.locator('#cassets-detail .ts-said').innerText().catch(() => '')), 30_000);
    assert.match(await row('site').locator('.ts-state').innerText(), /Sent to main/);
    assert.match(await row('styles').locator('.ts-state').innerText(), /Not sent/);
    assert.match(await row('styles').locator('.ts-note').innerText(), /^Not sent: the remote's main moved since you looked/);
    assert.equal(git(site.remote, 'rev-parse', 'refs/heads/main'), site.head, 'site went');
    assert.equal(git(styles.remote, 'rev-parse', 'refs/heads/main'), moved, 'styles did not: the remote kept what it had');
    await shot(page, 'tablet-to-send-sent');

    /* A phone: one row under the other, nothing wider than the screen. */
    const phone = await b.person({ phone: true, at: '/?c=coder' });
    await phone.page.locator('#view-assets').click();
    await phone.page.locator('#cassets-rows .as-row[data-asset="send:all"]').click();
    await phone.until('the rows on a phone', async () => /all read$/.test(await phone.page.locator('#cassets-detail .ts-progress').innerText().catch(() => '')), 30_000);
    await phone.page.locator('#cassets-detail .ts-filters button[data-filter="all"]').click();
    assert.equal(await phone.page.locator('#cassets-detail .ts-row').count(), 2);
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'never sideways');
    await shot(phone.page, 'phone-to-send');
});

test('To send: two branches of one repository, both moved lately, both ticked and sent at once, each to its own branch', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    const site = await repository(b, me, 'site', 'contact.html');
    /* A second branch of its agent, with a commit of its own. */
    git(site.work, 'checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(site.work, 'feature.html'), 'feature\n'); git(site.work, 'add', '.'); git(site.work, 'commit', '--quiet', '-m', 'A feature');
    const feature = git(site.work, 'rev-parse', 'HEAD');
    git(site.work, 'checkout', '--quiet', 'main');
    const page = me.page;
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator('#view-assets').click();
    await page.locator('#cassets-rows .as-row[data-asset="send:all"]').click();
    const row = (branch) => page.locator(`#cassets-detail .ts-row[data-repo="site"][data-branch="${branch}"]`);
    await me.until('all read', async () => /all read$/.test(await page.locator('#cassets-detail .ts-progress').innerText().catch(() => '')), 40_000);
    /* By default, what the remote has to update: main; the new branch, one touch away. */
    assert.equal(await row('main').count(), 1);
    assert.equal(await row('feature').count(), 0, 'a new branch is not shown by default');
    await page.locator('#cassets-detail .ts-filters button[data-filter="all"]').click();
    assert.match(await row('feature').innerText(), /feature[\s\S]*→[\s\S]*feature \(new branch\)[\s\S]*new branch/);
    await row('feature').locator('input[type=checkbox]').check();
    await shot(page, 'tablet-to-send-branches');
    const go = page.locator('#cassets-detail [data-act="send-all"]');
    assert.equal(await go.innerText(), 'Check the 2');
    await go.click();
    await me.until('checked', async () => (await go.innerText()) === 'Send the 2', 30_000);
    await go.click(); await go.click();
    await me.until('both sent', async () => /all 2 went/.test(await page.locator('#cassets-detail .ts-said').innerText().catch(() => '')), 30_000);
    assert.equal(git(site.remote, 'rev-parse', 'refs/heads/main'), site.head);
    assert.equal(git(site.remote, 'rev-parse', 'refs/heads/feature'), feature);
});
