/* Sending a repository's commits, beyond the first Send: choosing the branch,
   the origin kept up to date where the tool can fetch it with no key, the
   checks run in the machine, and automatic sending to the branches the
   owner listed -- all from the review panel, as the owner would. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Robin', GIT_AUTHOR_EMAIL: 'robin@example.com', GIT_COMMITTER_NAME: 'Robin', GIT_COMMITTER_EMAIL: 'robin@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the owner chooses the branch, sees the checks from the machine, refreshes the origin, and lets listed branches go by themselves', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    /* The origin: main and staging. */
    const remote = join(b.dir, 'remote.git');
    git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const seed = join(b.dir, 'seed');
    git(b.dir, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), '# site\n'); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:staging');
    const start = git(seed, 'rev-parse', 'HEAD');

    const me = await b.person();
    await me.create('coder');
    await me.api('/api/resources', { name: 'site', type: 'git' });
    await me.api('/api/git/site/remote', { url: remote });
    await me.api('/api/conversations/coder/resources', { resource: 'site', access: 'write' });

    /* The origin is kept by the server and shown in the machine: the tool fetches it with no key. */
    await me.until('the origin is kept', async () => (await me.api('/api/git/site/keep')).body.origin?.ok === true, 20_000);
    await me.type('cd ../resources/site && git fetch -q ../site-origin "+refs/heads/*:refs/remotes/origin/*" && git reset -q --hard origin/main && git branch -r && cd - >/dev/null');
    await me.sees('origin/staging');
    const work = join(b.dir, 'data', 'resources', 'site');
    /* The project's own pre-push hook, which the checks run in the machine. */
    const hook = join(work, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\nread line\necho "hook saw: $line"\nexit 0\n`); chmodSync(hook, 0o755);
    writeFileSync(join(work, 'page.html'), '<p>hi</p>\n'); git(work, 'add', 'page.html'); git(work, 'commit', '--quiet', '-m', 'Add a page');
    const mine = git(work, 'rev-parse', 'HEAD');

    await me.page.locator('#folders').click();
    await me.page.locator('#panel-rows .folder[data-name="site"]').locator('button', { hasText: 'Review & send' }).click();
    await me.until('the commit is shown', async () => /1 commit\(s\) would be sent to main/.test(await me.page.locator('#gitview-state').innerText()));
    /* Where the tool finds the origin, said plainly. */
    assert.match(await me.page.locator('#gitview-origin').innerText(), /\/resources\/site-origin in the agent's machine, read-only/);
    assert.equal(await me.page.locator('#gitview-origin-fetch').innerText(), "git fetch /resources/site-origin '+refs/heads/*:refs/remotes/origin/*'");
    /* The checks ran in the machine, before Send is shown; said to be a safeguard, not a proof. */
    await me.until('the checks passed', async () => /Checks passed in the agent's machine \(machine of coder\)/.test(await me.page.locator('#gitview-checks-state').innerText()));
    assert.match(await me.page.locator('#gitview-checks-output').innerText(), new RegExp(`hook saw: refs/heads/main ${mine} refs/heads/main ${start}`));
    assert.match(await me.page.locator('#gitview-checks').innerText(), /a safeguard, not a proof/);
    /* The branches of the origin, the same name first. */
    assert.deepEqual(await me.page.locator('#gitview-target option').allInnerTexts(), ['main', 'staging', 'A new branch...']);
    assert.equal(await me.page.locator('#gitview-target').inputValue(), 'main');

    /* Another existing branch: looked at again, then sent there, and only there. */
    await me.page.locator('#gitview-target').selectOption('staging');
    await me.until('staging is shown', async () => /1 commit\(s\) would be sent to staging/.test(await me.page.locator('#gitview-state').innerText()));
    await me.until('Send names staging', async () => (await me.page.locator('#gitview-push').innerText()) === 'Send 1 commit to staging');
    await me.page.locator('#gitview-push').click();
    assert.match(await me.page.locator('#gitview-push').innerText(), /send to staging: this cannot be undone/);
    await me.page.locator('#gitview-push').click();
    await me.until('it says it was sent', async () => /Sent: 1 commit to staging/.test(await me.page.locator('#gitview-state').innerText()));
    assert.equal(git(remote, 'rev-parse', 'refs/heads/staging'), mine);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), start, 'main is untouched');

    /* A new branch: a bad name is refused, a good one is made. */
    await me.page.locator('#gitview-target').selectOption({ label: 'A new branch...' });
    await me.page.fill('#gitview-newbranch', 'bad..name');
    await me.page.locator('#gitview-newbranch-go').click();
    await me.until('the name is refused', async () => /no "\.\."/.test(await me.page.locator('#gitview-error').innerText()));
    await me.page.locator('#gitview-target').selectOption({ label: 'A new branch...' });
    await me.page.fill('#gitview-newbranch', 'try/idea');
    await me.page.locator('#gitview-newbranch-go').click();
    await me.until('the new branch is offered', async () => (await me.page.locator('#gitview-push').innerText().catch(() => '')) === 'Make the branch try/idea');
    assert.equal(await me.page.locator('#gitview-target').inputValue(), 'try/idea');
    await me.page.locator('#gitview-push').click(); await me.page.locator('#gitview-push').click();
    await me.until('it was made', async () => /Made the branch try\/idea on the remote/.test(await me.page.locator('#gitview-state').innerText()));
    assert.equal(git(remote, 'rev-parse', 'refs/heads/try/idea'), mine);

    /* A hook that fails: said; Send is still the owner's choice, unless the owner requires passing checks. */
    writeFileSync(hook, '#!/bin/sh\necho "tests are red"\nexit 1\n');
    writeFileSync(join(work, 'two.html'), '<p>two</p>\n'); git(work, 'add', 'two.html'); git(work, 'commit', '--quiet', '-m', 'Second page');
    await me.page.locator('#gitview-target').selectOption('main');
    await me.until('the checks failed', async () => /Checks FAILED/.test(await me.page.locator('#gitview-checks-state').innerText()));
    assert.match(await me.page.locator('#gitview-checks-output').innerText(), /tests are red/);
    assert.equal(await me.page.locator('#gitview-push').isVisible(), true);
    await me.page.locator('#gitview-keep-box summary').click();
    assert.equal(await me.page.locator('#gitview-autobranches').inputValue(), '', 'no branch is sent to by itself, to begin with');
    assert.equal(await me.page.locator('#gitview-quietminutes').inputValue(), '10');
    assert.equal(await me.page.locator('#gitview-refreshminutes').inputValue(), '5');
    await me.page.locator('#gitview-require').check();
    await me.page.locator('#gitview-keep button[type=submit]').click();
    await me.until('saved', async () => (await me.page.locator('#gitview-keep-said').innerText()) === 'Saved.');
    assert.equal(await me.page.locator('#gitview-push').isVisible(), false, 'Send waits for passing checks');
    assert.equal((await me.api('/api/git/site/push', { head: git(work, 'rev-parse', 'HEAD'), target: 'main' })).status, 409);

    /* Refresh now. */
    await me.page.locator('#gitview-refresh').click();
    await me.until('refreshed', async () => /Refreshed .*Up to date with the origin/.test(await me.page.locator('#gitview-origin-state').innerText()));

    /* Automatic sending to the branches listed: the tool commits on try/idea, the hook passes again. */
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    await me.page.fill('#gitview-autobranches', 'try/*');
    await me.page.fill('#gitview-quietminutes', '0');
    await me.page.locator('#gitview-keep button[type=submit]').click();
    await me.until('saved again', async () => (await me.page.locator('#gitview-autobranches').inputValue()) === 'try/*');
    git(work, 'checkout', '--quiet', '-b', 'try/idea');
    writeFileSync(join(work, 'three.html'), '<p>three</p>\n'); git(work, 'add', 'three.html'); git(work, 'commit', '--quiet', '-m', 'Third page');
    const third = git(work, 'rev-parse', 'HEAD');
    await me.until('it was sent by itself', async () => { try { return git(remote, 'rev-parse', 'refs/heads/try/idea') === third; } catch { return false; } }, 20_000);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), start, 'never to a branch outside the list');
    /* The server writes its log line after the refresh that follows the
       push, so a moment after the remote has the commit: the page is asked
       again once the server has written it. */
    await me.until('the server logged it', async () => (await me.api('/api/git/site/keep')).body?.log?.some((e) => /Sent automatically/.test(e.what)));
    await me.page.locator('#gitview-again').click();
    await me.until('the log says it', async () => /Sent automatically: 2 commit\(s\) to try\/idea, checks passed/.test(await me.page.locator('#gitview-log').innerText()));
    assert.deepEqual(me.errors, []);
});

test('the review shows the agent\'s branches, what the changes alone hide, asks once more when it cannot show it all, and says why a repository cannot be read', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const remote = join(b.dir, 'remote.git');
    git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const me = await b.person();
    await me.create('coder');
    await me.api('/api/resources', { name: 'site', type: 'git' });
    await me.api('/api/git/site/remote', { url: remote });
    await me.api('/api/conversations/coder/resources', { resource: 'site', access: 'write' });
    const work = join(b.dir, 'data', 'resources', 'site');
    writeFileSync(join(work, 'a.txt'), 'a\n'); git(work, 'add', 'a.txt'); git(work, 'commit', '--quiet', '-m', 'one');
    git(work, 'checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(work, 'secret.bin'), 'x'.repeat(5000)); git(work, 'add', 'secret.bin'); git(work, 'commit', '--quiet', '-m', 'add');
    git(work, 'rm', '--quiet', 'secret.bin'); git(work, 'commit', '--quiet', '-m', 'Tidy up\n\nNothing to see here.');

    await me.page.locator('#folders').click();
    await me.page.locator('#panel-rows .folder[data-name="site"]').locator('button', { hasText: 'Review & send' }).click();
    await me.until('a review is shown', async () => /would be sent to/.test(await me.page.locator('#gitview-state').innerText()));
    assert.deepEqual(await me.page.locator('#gitview-branch option').allInnerTexts(), ['feature', 'main']);
    await me.page.locator('#gitview-branch').selectOption('feature');
    await me.until('feature is shown', async () => /3 commit\(s\) would be sent to feature/.test(await me.page.locator('#gitview-state').innerText()));
    const guards = await me.page.locator('#gitview-guards').innerText();
    assert.match(guards, /Changed and changed back, so not in the changes below: secret\.bin/);
    assert.match(guards, /Largest new files: secret\.bin \(5 KB\)/);
    assert.match(await me.page.locator('#gitview-commits').innerText(), /Nothing to see here\./, 'the whole message is shown');
    await me.page.locator('#gitview-branch').selectOption('main');
    await me.until('main is shown', async () => /1 commit\(s\) would be sent to main/.test(await me.page.locator('#gitview-state').innerText()));

    /* More than a page lists: a third click. */
    git(work, 'checkout', '--quiet', 'main');
    for (let i = 0; i < 101; i++) git(work, 'commit', '--quiet', '--allow-empty', '-m', `c${i}`);
    await me.page.locator('#gitview-again').click();
    await me.until('102 commits', async () => /102 commit\(s\) would be sent to main/.test(await me.page.locator('#gitview-state').innerText()));
    assert.match(await me.page.locator('#gitview-guards').innerText(), /102 commits in all: only the last 100 are listed below/);
    await me.until('Send is offered', async () => await me.page.locator('#gitview-push').isVisible());
    await me.page.locator('#gitview-push').click();
    await me.page.locator('#gitview-push').click();
    assert.match(await me.page.locator('#gitview-push').innerText(), /Not all of it could be shown here: send it all to main anyway/);
    await me.page.locator('#gitview-push').click();
    await me.until('it was sent', async () => /Sent: 102 commits to main/.test(await me.page.locator('#gitview-state').innerText()));
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(work, 'rev-parse', 'main'));

    /* A repository the server will not read: why, said. */
    rmSync(join(work, '.git'), { recursive: true, force: true });
    writeFileSync(join(work, '.git'), 'gitdir: /somewhere/else\n');
    await me.page.locator('#gitview-again').click();
    await me.until('the reason is said', async () => /NOT A PLAIN \.git DIRECTORY/.test(await me.page.locator('#gitview-error').innerText()));
    assert.deepEqual(me.errors, []);
});
