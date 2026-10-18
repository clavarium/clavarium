/* A private repository, added from Assets as the owner would: a key made
   here, its public half copied to "the hosting service", the clone, and the
   key listed with the repository it opens. The hosting service is a stand-in
   ssh (fake-ssh.mjs) that lets in only the keys it was given. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';
import { FAKE_HOST_KEY } from './fake-ssh.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Robin', GIT_AUTHOR_EMAIL: 'robin@example.com', GIT_COMMITTER_NAME: 'Robin', GIT_COMMITTER_EMAIL: 'robin@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('a private repository is added with a new key: its public half is shown and copied, its private half is nowhere', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    /* What the hosting service holds: a private repository with one commit. */
    const bare = join(b.sshRoot, 'remotes', 'team', 'site.git');
    mkdirSync(bare, { recursive: true });
    git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
    const seed = join(b.dir, 'seed');
    git(b.dir, 'clone', '--quiet', bare, seed);
    writeFileSync(join(seed, 'README.md'), '# private site\n'); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    writeFileSync(join(b.sshRoot, 'authorized_keys'), '');

    const context = await b.browser.newContext({ viewport: { width: 1200, height: 760 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const me = await b.person({ context });
    /* Everything the server answered, to look for the private key in it afterwards. */
    const answers = [];
    me.page.on('response', async (r) => { if (r.url().includes('/api/')) answers.push(await r.text().catch(() => '')); });
    await me.create('coder');
    await me.openAccess('assets');
    await me.page.locator('#git-box summary').click();
    await me.page.fill('#git-name', 'site');
    await me.page.fill('#git-from', 'git@example.com:team/site.git');

    /* The ways in, the safest first and chosen; a password is said to be a poor one. */
    const ways = me.page.locator('#git-via input[name="git-via"]');
    assert.deepEqual(await ways.evaluateAll((all) => all.map((r) => r.value)), ['ssh-key', 'token', 'password', 'none']);
    assert.equal(await me.page.locator('#git-via input[value="ssh-key"]').isChecked(), true);
    assert.match(await me.page.locator('#git-via label', { hasText: 'password' }).innerText(), /not recommended/);
    await me.page.locator('#git-via input[value="token"]').check();
    assert.equal(await me.page.locator('#git-token').isVisible(), true);
    assert.equal(await me.page.locator('#git-key').isVisible(), false);
    await me.page.locator('#git-via input[value="password"]').check();
    assert.equal(await me.page.locator('#git-pass').isVisible(), true);
    assert.match(await me.page.locator('#git-via-password').innerText(), /Not recommended/);
    await me.page.locator('#git-via input[value="ssh-key"]').check();

    /* A new key, made here; its public half is shown, with what to do with it. */
    await me.page.locator('#git-key-new').click();
    assert.equal(await me.page.locator('#git-key-name').inputValue(), 'site', 'a name is offered');
    await me.page.fill('#git-key-name', 'deploy-a');
    await me.page.locator('#git-key-make-go').click();
    await me.until('the public key is shown', async () => (await me.page.locator('#git-key-public').inputValue()).startsWith('ssh-ed25519 '));
    const publicKey = await me.page.locator('#git-key-public').inputValue();
    assert.match(publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} clavarium-deploy-a$/);
    assert.equal(await me.page.locator('#git-key').inputValue(), 'deploy-a');
    assert.match(await me.page.locator('#git-key-shown').innerText(), /GitHub a deploy key works for one repository only.*GitLab one deploy key can be enabled on several projects/s);
    await me.page.locator('#git-key-copy').click();
    await me.until('it is copied', async () => (await me.page.locator('#git-key-copy').innerText()) === 'Copied');
    const copied = await me.page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, publicKey);

    /* The owner pastes it into the hosting service; then Add clones, on the server. */
    writeFileSync(join(b.sshRoot, 'authorized_keys'), `${copied}\n`);
    await me.page.locator('#git-new button[type=submit]').click();
    await me.until('the repository is listed', async () => (await me.page.locator('#assets-git .asset[data-name="site"]').count()) === 1, 30_000);
    assert.match(await me.page.locator('#git-said').innerText(), /First contact with example\.com: its host key \(ssh-ed25519 SHA256:[A-Za-z0-9+/]+\) was recorded/);
    assert.match(await me.page.locator('#assets-git .asset[data-name="site"]').innerText(), /from example\.com, with the SSH key deploy-a/);
    assert.equal(await me.page.locator('#git-token').inputValue(), '', 'nothing typed is kept in the form');

    /* The key is listed with the repository it opens, and cannot be removed while it does. */
    const key = me.page.locator('#git-keys .git-key[data-name="deploy-a"]');
    await me.until('the key says it is used', async () => /used by site/.test(await key.innerText()));
    assert.equal(await key.locator('textarea').inputValue(), publicKey);
    assert.equal(await key.locator('button', { hasText: 'Remove' }).isDisabled(), true);
    assert.match(await key.innerText(), /would cut site off/);
    assert.equal((await me.api('/api/git-keys/deploy-a/remove', {})).status, 409);
    await me.page.locator('#access-close').click();

    /* The tool reads the repository; it never sees the key. */
    await me.access('site', 'Read');
    /* (Written in two halves, so that the command itself on the screen does not say it.) */
    await me.type('cat ../resources/site/README.md; grep -rl "PRIVATE"" KEY" ../resources /work 2>/dev/null | wc -l');
    await me.sees('# private site');
    await me.sees('\n0\n');
    /* Nor does the page, nor anything the server answered. */
    assert.equal((await me.page.content()).includes('PRIVATE KEY'), false);
    assert.ok(answers.length > 5);
    for (const body of answers) assert.equal(body.includes('PRIVATE KEY') || body.includes('"sealed"'), false, body.slice(0, 200));
    assert.deepEqual(me.errors, []);
});

test('a git server\'s recorded key is forgotten from Settings, deep down, after asking twice', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    /* Two servers met before (as a first clone would have recorded them). */
    const knownHosts = join(b.dir, 'data', 'git-ssh', 'known_hosts');
    mkdirSync(join(b.dir, 'data', 'git-ssh'), { recursive: true });
    writeFileSync(knownHosts, `example.com ssh-ed25519 ${FAKE_HOST_KEY}\ngit.example.org ssh-ed25519 ${FAKE_HOST_KEY}\n`);
    const me = await b.person();
    await me.create('settler');
    await me.page.locator('#nav-settings').click();
    /* Out of the way: under Advanced, closed. */
    assert.equal(await me.page.locator('#git-hosts').isVisible(), false);
    await me.chapter('s-advanced');
    const row = me.page.locator('#git-hosts .folder[data-host="example.com"]');
    await me.until('the hosts are listed', async () => (await row.count()) === 1);
    assert.match(await row.innerText(), /ssh-ed25519 SHA256:[A-Za-z0-9+/]+/);
    await row.locator('button').click();
    assert.match(await row.locator('button').innerText(), /the next contact will trust whatever key this server shows/);
    assert.match(readFileSync(knownHosts, 'utf8'), /^example\.com /m, 'not yet: one click only asks');
    await row.locator('button').click();
    await me.until('it is forgotten', async () => (await row.count()) === 0);
    assert.equal(readFileSync(knownHosts, 'utf8'), `git.example.org ssh-ed25519 ${FAKE_HOST_KEY}\n`, 'the other host is kept');
    assert.equal(await me.page.locator('#git-hosts .folder').count(), 1);
    assert.deepEqual(me.errors, []);
});
