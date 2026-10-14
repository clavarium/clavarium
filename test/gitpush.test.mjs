/* The push review, with a real git: a tool's repository, a remote, and what goes between them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitReview, branchProblem } from '../server/gitpush.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8' }).trim();

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-push-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = join(dir, 'resources', 'site'); const remote = join(dir, 'remote.git');
    mkdirSync(work, { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    git(work, 'init', '--quiet', '--initial-branch=main');
    const commit = (file, text, subject) => { writeFileSync(join(work, file), text); git(work, 'add', file); git(work, 'commit', '--quiet', '-m', subject); return git(work, 'rev-parse', 'HEAD'); };
    const resources = { get: (name) => (name === 'site' ? { name: 'site', type: 'git' } : name === 'notes' ? { name: 'notes', type: 'folder' } : undefined), folder: (name) => join(dir, 'resources', name) };
    const review = new GitReview({ store: new Store(join(dir, 'git.json')), vault: new Vault(join(dir, 'vault.key')), resources, dataDir: dir, localRemotes: true });
    return { dir, work, remote, commit, review };
}

test('what would go out is shown -- commits, files, changes -- and exactly that is sent', async (t) => {
    const b = bench(t);
    assert.equal((await b.review.outgoing('site')).state, 'empty');
    const first = b.commit('README.md', '# site\n', 'Start the site');
    assert.equal((await b.review.outgoing('site')).state, 'no-remote');
    b.review.setRemote('site', { url: b.remote });
    const seen = await b.review.outgoing('site');
    assert.deepEqual([seen.state, seen.branch, seen.head, seen.commits.map((c) => c.subject)], ['ahead', 'main', first, ['Start the site']]);
    assert.match(seen.stat, /README\.md/);
    assert.match(seen.diff, /^\+# site$/m);
    assert.equal(seen.commits[0].author, 'Tool');
    /* The tool commits again after the owner looked: what was looked at is not what would go. */
    const second = b.commit('page.html', '<h1>hi</h1>\n', 'Add a page');
    await assert.rejects(b.review.push('site', { head: first }), /changed since you looked/);
    const again = await b.review.outgoing('site');
    assert.equal(again.commits.length, 2);
    assert.deepEqual(await b.review.push('site', { head: second }), { ok: true, branch: 'main', from: 'main', head: second, commits: 2, made: true });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), second, 'the remote has exactly that commit');
    assert.equal((await b.review.outgoing('site')).state, 'up-to-date');
    await assert.rejects(b.review.push('site', { head: second }), /already there/);
});

test('a remote that moved on is said, and nothing is forced over it', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.push('site', { head: first });
    /* Somebody else pushes to the remote. */
    const other = join(b.dir, 'other');
    git(b.dir, 'clone', '--quiet', b.remote, other);
    writeFileSync(join(other, 'b.txt'), 'b\n'); git(other, 'add', 'b.txt'); git(other, 'commit', '--quiet', '-m', 'theirs'); git(other, 'push', '--quiet');
    const theirs = git(b.remote, 'rev-parse', 'refs/heads/main');
    const mine = b.commit('c.txt', 'c\n', 'mine');
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'diverged');
    assert.match(seen.message, /has 1 commit\(s\) that this repository does not have/);
    await assert.rejects(b.review.push('site', { head: mine }), /bring them in first/);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), theirs, 'the remote is untouched');
});

test('a repository rigged by its tool runs nothing here: no hook, no filter, no program named in its settings', async (t) => {
    const b = bench(t);
    const proof = join(b.dir, 'ran');
    const trap = join(b.dir, 'trap.sh');
    writeFileSync(trap, `#!/bin/sh\ntouch ${proof}\nexit 0\n`); chmodSync(trap, 0o755);
    b.commit('a.txt', 'a\n', 'one');
    /* Everything a tool could plant to be run by whoever touches its repository. */
    for (const hook of ['pre-push', 'post-checkout', 'pre-commit', 'reference-transaction', 'post-update', 'pre-receive', 'update']) { writeFileSync(join(b.work, '.git', 'hooks', hook), `#!/bin/sh\ntouch ${proof}\n`); chmodSync(join(b.work, '.git', 'hooks', hook), 0o755); }
    for (const [key, value] of [['core.fsmonitor', trap], ['core.pager', trap], ['core.sshCommand', trap], ['core.editor', trap], ['uploadpack.packObjectsHook', trap], ['diff.external', trap], ['core.hooksPath', join(b.work, '.git', 'hooks')], ['filter.x.clean', trap], ['filter.x.smudge', trap], ['diff.x.textconv', trap], ['core.alternateRefsCommand', trap], ['credential.helper', `!${trap}`]]) git(b.work, 'config', key, value);
    writeFileSync(join(b.work, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(b.work, 'b.txt'), 'b\n');
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.x.clean=cat', 'add', '.gitattributes', 'b.txt'], { cwd: b.work, env: ENV });
    const head = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'commit', '--quiet', '-m', 'rigged'], { cwd: b.work, env: ENV }) && git(b.work, '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD');
    rmSync(proof, { force: true });
    b.review.setRemote('site', { url: b.remote });
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'ahead');
    assert.match(seen.diff, /^\+b$/m);
    await b.review.push('site', { head });
    assert.equal(existsSync(proof), false, 'nothing of the tool\'s was run');
});

test('the key is sealed and never said back; only a git repository has a push, and only to an https address', async (t) => {
    const b = bench(t);
    b.review.setRemote('site', { url: b.remote, user: 'me', key: 'very-secret-token' });
    assert.deepEqual(b.review.settings('site'), { remote: b.remote, user: 'me', hasKey: true, sshKey: null });
    assert.equal(readFileSync(join(b.dir, 'git.json'), 'utf8').includes('very-secret-token'), false);
    b.review.setRemote('site', { url: b.remote });
    assert.equal(b.review.settings('site').hasKey, true, 'an empty key keeps the one there is');
    await assert.rejects(b.review.outgoing('notes'), /No such repository/);
    assert.throws(() => b.review.setRemote('nope', { url: b.remote }), /No such repository/);
    /* ssh is an address commits may go to (with a key made here: see gitaccess.test); a local file is not. */
    assert.equal(b.review.setRemote('site', { url: 'ssh://git@example.com/x.git' }).remote, 'ssh://git@example.com/x.git');
    assert.throws(() => b.review.setRemote('site', { url: 'file:///etc' }), /repository address is https/);
    assert.throws(() => b.review.setRemote('site', { url: 'http://example.com/x.git' }), /repository address is https/);
    b.review.setRemote('site', { url: b.remote });
    assert.throws(() => b.review.setRemote('site', { url: b.remote, key: 'two\nlines' }), /one line/);
    assert.throws(() => b.review.setRemote('site', { url: b.remote, user: 'a:b' }), /no space and no colon/);
    /* Outside tests, a directory of this machine is not a remote. */
    const strict = new GitReview({ store: new Store(join(b.dir, 'g2.json')), vault: new Vault(join(b.dir, 'vault.key')), resources: { get: () => ({ name: 'site', type: 'git' }), folder: () => b.work }, dataDir: b.dir });
    assert.throws(() => strict.setRemote('site', { url: b.remote }), /repository address is https/);
});

test('the branch to send to: the remote\'s branches are listed, the same name is the default, another or a new one can be chosen -- and what goes is exactly what was shown', async (t) => {
    const b = bench(t);
    const first = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.push('site', { head: first });
    /* The remote gets a second branch from somebody else. */
    git(b.remote, 'branch', 'staging', first);
    const mine = b.commit('b.txt', 'b\n', 'two');
    const seen = await b.review.outgoing('site');
    assert.deepEqual([seen.target, seen.branches, seen.targetExists, seen.remoteTip], ['main', ['main', 'staging'], true, first]);
    /* Another existing branch. */
    const staging = await b.review.outgoing('site', { target: 'staging' });
    assert.deepEqual([staging.state, staging.target, staging.commits.map((c) => c.subject)], ['ahead', 'staging', ['two']]);
    assert.match(staging.message, /1 commit\(s\) would be sent to staging/);
    assert.deepEqual(await b.review.push('site', { head: mine, target: 'staging' }), { ok: true, branch: 'staging', from: 'main', head: mine, commits: 1, made: false });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/staging'), mine);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first, 'only the branch that was shown');
    /* A new branch: only what the remote does not have travels; the changes are shown from where it left main. */
    const third = b.commit('c.txt', 'c\n', 'three');
    const fresh = await b.review.outgoing('site', { target: 'try/new-idea' });
    assert.deepEqual([fresh.state, fresh.targetExists, fresh.commits.map((c) => c.subject)], ['ahead', false, ['three']]);
    assert.match(fresh.message, /would be sent to try\/new-idea, a new branch/);
    assert.match(fresh.stat, /b\.txt/); assert.match(fresh.stat, /c\.txt/);
    assert.doesNotMatch(fresh.stat, /a\.txt/);
    /* What was shown for one branch is not sent to another: Send says where, and that is looked at again. */
    await assert.rejects(b.review.push('site', { head: third, target: 'staging..x' }), /no "\.\."/);
    await assert.rejects(b.review.push('site', { head: third, target: '-f' }), /does not start with "-"/);
    assert.equal((await b.review.push('site', { head: third, target: 'try/new-idea' })).made, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/try/new-idea'), third);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first);
    /* Sent: nothing is left for that branch. */
    const behind = await b.review.outgoing('site', { target: 'try/new-idea' });
    assert.equal(behind.state, 'up-to-date');
    await assert.rejects(b.review.outgoing('site', { target: 'a b' }), /letters, digits/);
});

test('branch names follow the rules of git check-ref-format, and ours: no leading "-", bounded', () => {
    const names = ['main', 'try/one', 'release-1.2', 'a.b/c_d', 'feature/x.y', '-x', 'a..b', 'a/', '/a', 'a//b', 'a.lock', 'a/.b', '.a', 'a.', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', '@', 'HEAD', 'x'.repeat(201), ''];
    for (const name of names) {
        const ours = branchProblem(name) === '';
        let gits = false;
        try { execFileSync('git', ['check-ref-format', `refs/heads/${name}`], { stdio: 'ignore' }); gits = true; } catch { gits = false; }
        /* Never more lenient than git; stricter only on purpose. */
        if (ours) assert.equal(gits, true, `${name} is accepted here but not by git`);
        if (gits && !ours) assert.ok(name.startsWith('-') || name.length > 200 || name === 'HEAD' || /[^A-Za-z0-9._/-]/.test(name), `${name} is refused here for no reason`);
    }
    assert.equal(branchProblem('try/one'), '');
});
