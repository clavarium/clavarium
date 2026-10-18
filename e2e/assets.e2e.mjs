/* The bar of a conversation (Chat | Terminal | Assets N, its settings), its
   own Assets, the server's Assets, the branch diagram and the review page --
   as the owner uses them, on a tablet and on a phone. With CLAVARIUM_SHOTS
   set to a directory, each page is also saved there as a picture. */
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

/* A repository with a remote (main), the agent's main one commit ahead, and a branch dev. */
async function setUp(b, me) {
    const remote = join(b.dir, 'remote.git');
    git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const seed = join(b.dir, 'seed');
    git(b.dir, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), '# site\n'); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    await me.create('coder');
    await me.api('/api/resources', { name: 'site', type: 'git' });
    await me.api('/api/git/site/remote', { url: remote });
    await me.api('/api/resources', { name: 'notes' });
    await me.api('/api/conversations/coder/resources', { resource: 'site', access: 'write' });
    await me.api('/api/conversations/coder/resources', { resource: 'notes', access: 'read' });
    await me.until('the origin is kept', async () => (await me.api('/api/git/site/keep')).body.origin?.ok === true, 20_000);
    const work = join(b.dir, 'data', 'resources', 'site');
    git(work, 'fetch', '-q', join(b.dir, 'data', 'resources', 'site-origin'), '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'reset', '-q', '--hard', 'origin/main');
    /* What the agent wrote is text: a subject and a file that look like markup stay text. */
    writeFileSync(join(work, 'light.js'), 'export function lightFor(job) {\n  const late = 10 * 60_000;\n  return job.age > late ? "orange" : "green";\n}\n');
    writeFileSync(join(work, 'page.html'), '<img src=x onerror="document.title=\'pwned\'">\n');
    git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'Adaptive <b>threshold</b> for the light');
    git(work, 'checkout', '--quiet', '-b', 'dev');
    writeFileSync(join(work, 'dev.txt'), 'dev\n'); git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'Work on dev');
    git(work, 'checkout', '--quiet', 'main');
    return { work, head: git(work, 'rev-parse', 'main') };
}

test('a conversation\'s bar, its Assets, the branch diagram and the review page', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const { head } = await setUp(b, me);
    const page = me.page;
    await page.setViewportSize({ width: 1024, height: 768 });
    /* The bar: no tool badge, no "live" in words, no pills, no Files; Chat | Terminal | Assets N; its settings. */
    for (const gone of ['#tool', '#chips', '#files-open', '#menu']) assert.equal(await page.locator(gone).isVisible(), false, gone);
    await me.until('Assets counts what it was given', async () => (await page.locator('#assets-count').innerText()) === '3', 'its work folder, a repository, a folder');
    assert.equal(await page.locator('#view-terminal').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#folders').isVisible(), true, 'its settings, at the end of the bar');
    /* Chat, then Terminal again. */
    await page.locator('#view-chat').click();
    await me.until('the chat is shown', async () => (await page.locator('#view-chat').getAttribute('aria-pressed')) === 'true' && await page.locator('#simple').isVisible());
    await page.locator('#view-terminal').click();
    await me.until('the terminal is back', async () => !(await page.locator('#simple').isVisible()));
    /* Its Assets: by kind, the repository first and opened. */
    await page.locator('#view-assets').click();
    const rows = page.locator('#cassets-rows .as-row');
    await me.until('its assets are listed', async () => (await rows.count()) === 3);
    assert.match(await page.locator('#cassets-rows .as-row[data-asset="folder:work"]').innerText(), /where its tool works/);
    assert.deepEqual(await page.locator('#cassets-rows .as-kind h3').allTextContents(), ['Git repositories', 'Folders']);
    assert.match(await page.locator('#cassets-rows .as-row[data-asset="git:site"]').innerText(), /site\s*write/);
    assert.match(await page.locator('#cassets-rows .as-row[data-asset="folder:notes"]').innerText(), /notes\s*read/);
    await me.until('the repository is opened, its branches drawn', async () => (await page.locator('#cassets-detail .gg-row').count()) >= 3, 20_000);
    assert.match(await page.locator('#cassets-detail .as-line').innerText(), /Its agent works on dev; you send to dev\./);
    assert.match(await page.locator('#cassets-detail .as-cards').innerText(), /To send\s*2 commits/);
    const subjects = await page.locator('#cassets-detail .gg-subject').allInnerTexts();
    assert.ok(subjects.includes('Adaptive <b>threshold</b> for the light'), 'a subject is text, never markup');
    assert.equal(await page.locator('#cassets-detail .gg-row b').count(), 0);
    assert.deepEqual((await page.locator('#cassets-detail .gg-ref').allInnerTexts()).sort(), ['dev', 'main', 'main'], 'the agent\'s branches, and the remote\'s main');
    await shot(page, 'tablet-conversation-assets');
    /* A commit of the diagram opens the review on it. */
    await page.locator('#cassets-detail .gg-row', { hasText: 'Adaptive' }).click();
    await me.until('the review of that commit', async () => (await page.locator('#gitview-from').innerText()) === head.slice(0, 7));
    await me.until('its diff is drawn', async () => (await page.locator('#gitview-diff .d2h-file-wrapper').count()) === 2);
    assert.equal(await page.locator('#gitview-diff img').count(), 0, 'no markup from the diff');
    assert.match(await page.locator('#gitview-diff').innerText(), /<img src=x onerror=/);
    assert.notEqual(await page.title(), 'pwned');
    assert.deepEqual(await page.locator('#gitview-tree button .rv-path').allInnerTexts(), ['light.js', 'page.html']);
    assert.equal(await page.locator('#gitview-push').isVisible(), false, 'a commit looked at is never sent from here');
    assert.equal(await page.locator('#gitview-diff .d2h-file-side-diff').count() > 0, true, 'side by side');
    await page.locator('#gitview-layout button[data-layout="line-by-line"]').click();
    await me.until('unified', async () => (await page.locator('#gitview-diff .d2h-file-side-diff').count()) === 0 && (await page.locator('#gitview-diff .d2h-file-diff').count()) > 0);
    await page.locator('#gitview-layout button[data-layout="side-by-side"]').click();
    await page.locator('#gitview-close').click();
    await me.until('back in its Assets', async () => !(await page.locator('#gitview').isVisible()) && await page.locator('#cassets').isVisible());
    /* "Open the review": what would go, with its checks, Send to main. */
    await me.until('the detail is drawn again', async () => (await page.locator('#cassets-detail button[data-act="review"]').count()) === 1, 20_000);
    await page.locator('#cassets-detail button[data-act="review"]').click();
    await me.until('what would go', async () => /2 commit\(s\) would be sent to dev, a new branch/.test(await page.locator('#gitview-state').innerText()), 20_000);
    await me.until('Send is offered', async () => /Send 2 commits to dev/.test(await page.locator('#gitview-push').innerText()));
    assert.match(await page.locator('#gitview-numbers').innerText(), /2 commits\s*· 4 files/);
    await page.locator('#gitview-tabs [data-tab="commits"]').click();
    assert.match(await page.locator('#gitview-commits').innerText(), /Adaptive <b>threshold<\/b> for the light/);
    await page.locator('#gitview-tabs [data-tab="changes"]').click();
    await shot(page, 'tablet-review');
    await page.locator('#gitview-close').click();
    /* A folder: its files, here. */
    await page.locator('#cassets-rows .as-row[data-asset="folder:notes"]').click();
    await me.until('its files are shown in the detail', async () => await page.locator('#cassets-detail #files').isVisible());
    assert.equal(await page.locator('#files-tabs').isVisible(), false);
    /* Chat again: the Assets view gives way, the files go back to their sheet. */
    await page.locator('#view-terminal').click();
    await me.until('the Assets view is shut', async () => !(await page.locator('#cassets').isVisible()) && !(await page.locator('#files').isVisible()));

    /* THE SERVER'S ASSETS: a place of its own; Access is the map alone. */
    await page.locator('#nav-assets').click();
    await me.until('the Assets place', async () => await page.locator('#assets').isVisible());
    await me.until('everything is listed', async () => (await page.locator('#assets-rows .as-row').count()) === 2);
    assert.equal(await page.locator('#assets-rows .as-row[data-asset="git:site"] .as-badge').innerText(), '1', 'how many conversations use it');
    await page.fill('#assets-search', 'not');
    await me.until('searched', async () => (await page.locator('#assets-rows .as-row').count()) === 1);
    await page.fill('#assets-search', '');
    await page.locator('#assets-rows .as-kind[data-kind="folder"] .as-add').click();
    await page.fill('#folder-name', 'seeds');
    await page.locator('#folder-new button[type=submit]').click();
    await me.until('the new folder is opened', async () => /seeds/.test(await page.locator('#assets-detail h2').innerText()));
    assert.match(await page.locator('#assets-detail').innerText(), /No conversation uses it/);
    await page.locator('#assets-detail .as-chapter .as-add').click();
    await page.locator('#assets-detail .as-picker .given-row[data-conversation="coder"] button', { hasText: 'Read' }).click();
    await me.until('it is used by coder', async () => (await page.locator('#assets-rows .as-row[data-asset="folder:seeds"] .as-badge').innerText()) === '1');
    await me.until('Delete waits until nobody uses it', async () => await page.locator('#assets-detail .danger-link').isDisabled());
    await page.locator('#assets-rows .as-row[data-asset="git:site"]').click();
    await me.until('the repository: its settings', async () => /Remote/.test(await page.locator('#assets-detail .as-settings').innerText()));
    await me.until('its branches, here too', async () => (await page.locator('#assets-detail .gg-row').count()) >= 3, 20_000);
    await shot(page, 'tablet-server-assets');
    await page.locator('#nav-access').click();
    await me.until('the map', async () => await page.locator('#links').isVisible());
    for (const gone of ['#tab-devices', '#tab-assets', '#flows-export']) assert.equal(await page.locator(gone).isVisible(), false, gone);
    assert.equal(await page.locator('#map-new-device').isVisible(), true);
    await shot(page, 'tablet-access');

    /* A PHONE: the list, then one asset with "All assets"; the review unified, file by file. */
    const phone = await b.person({ phone: true, at: '/?c=coder' });
    await phone.page.locator('#view-assets').click();
    await phone.until('the list first', async () => (await phone.page.locator('#cassets-rows .as-row').count()) === 4 && !(await phone.page.locator('#cassets-detail').isVisible()));
    await shot(phone.page, 'phone-conversation-assets-list');
    await phone.page.locator('#cassets-rows .as-row[data-asset="git:site"]').tap();
    await phone.until('then the repository', async () => (await phone.page.locator('#cassets-detail .gg-row').count()) >= 3, 20_000);
    assert.equal(await phone.page.locator('#cassets-detail .as-back').isVisible(), true);
    await shot(phone.page, 'phone-conversation-assets-git');
    await phone.page.locator('#cassets-detail .gg-row', { hasText: 'Adaptive' }).tap();
    await phone.until('one file at a time', async () => (await phone.page.locator('#gitview-picker-at').innerText()) === '1 / 2');
    assert.equal(await phone.page.locator('#gitview-layout').isVisible(), false, 'unified only');
    assert.equal(await phone.page.locator('#gitview-diff .d2h-file-wrapper:visible').count(), 1);
    await shot(phone.page, 'phone-review');
    await phone.page.locator('#gitview-picker button[data-step="1"]').tap();
    await phone.until('the second file', async () => (await phone.page.locator('#gitview-picker-at').innerText()) === '2 / 2');
    await phone.page.locator('#gitview-close').tap();
    await phone.page.locator('#cassets-detail .as-back').tap();
    await phone.until('the list again', async () => await phone.page.locator('#cassets-rows').isVisible());
    await phone.page.locator('#back').tap();
    await phone.page.locator('#nav-assets').tap();
    await phone.until('the server\'s assets, on a phone', async () => (await phone.page.locator('#assets-rows .as-row').count()) === 3, 'site, notes, seeds');
    await shot(phone.page, 'phone-server-assets');
    assert.deepEqual(me.errors, []);
    assert.deepEqual(phone.errors, []);
});
