/* The git runner: the one way an agent's commits come in (a bundle read by
   the host program, treated as hostile), and the builder every server-side
   git goes through. With a real git; the host program's read is played by
   the real reader script (git-stand-in.mjs) or by a process that writes
   chosen bytes. Design: blueprint/git-runner-core.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    GitRunner, GitFailure, HeaderReader, capFor, hostFailure, strictOption, waiversProblem, gitArgs, gitEnv, runGit, Mutex, Slots,
    CAP_MIN, CAP_MAX, CAP_EXTRA, MiB, LINE_MAX, HEADER_MAX, READ_BRANCHES_MAX, EMPTY_BUNDLE, FSCK_WAIVABLE, branchProblem,
} from '../server/gitrunner.mjs';
import { git, standInRead, bytesRead, bundleOf, committed, ENV } from './git-stand-in.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-runner-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const repo = join(dir, 'resources', 'site');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--quiet', '--initial-branch=main');
    const folder = (name) => join(dir, 'resources', name);
    const runner = (options = {}) => new GitRunner({ dataDir: join(dir, 'data'), reserveBytes: 0, spawnRead: standInRead(folder), ...options });
    return { dir, repo, folder, runner };
}
const failsWith = async (promise, kind, pattern) => {
    const error = await promise.then(() => assert.fail('it was read'), (e) => e);
    assert.ok(error instanceof GitFailure, String(error));
    assert.equal(error.kind, kind, error.message);
    if (pattern) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /nothing to send/i, 'no failure reads "nothing to send"');
    return error;
};
const header = (lines) => Buffer.from(`${lines.join('\n')}\n\n`, 'latin1');

test('a read lands every branch in a fresh workspace, checked, and the workspace goes away when asked', async (t) => {
    const b = bench(t);
    const one = committed(b.repo, 'a.txt', 'a\n', 'one');
    git(b.repo, 'checkout', '--quiet', '-b', 'feat/x');
    const two = committed(b.repo, 'b.txt', 'b\n', 'two');
    const runner = b.runner();
    const got = await runner.read('site');
    assert.deepEqual(got.branches.sort((x, y) => x.name.localeCompare(y.name)), [{ name: 'feat/x', id: two }, { name: 'main', id: one }]);
    assert.deepEqual(got.dropped, []);
    assert.ok(got.path.startsWith(runner.workRoot));
    assert.equal(git(got.path, 'rev-parse', 'refs/heads/feat/x'), two);
    assert.equal(existsSync(join(got.path, 'objects', 'info', 'alternates')), false, 'no alternates while receiving');
    got.remove();
    assert.deepEqual(readdirSync(runner.workRoot), []);
    /* A workspace left by a server that stopped is gone at the next start, and so are the copies an earlier version kept. */
    mkdirSync(join(runner.workRoot, 'left-over'));
    mkdirSync(join(b.dir, 'data', 'git-review', 'site.git'), { recursive: true });
    const again = b.runner();
    assert.deepEqual(readdirSync(again.workRoot), []);
    assert.equal(existsSync(join(b.dir, 'data', 'git-review')), false);
});

test('no branches is said as such; every host code is a failure of its own, never "nothing to send"', async (t) => {
    const b = bench(t);
    await failsWith(b.runner().read('site'), 'empty', /No branches/);
    const cases = [[66, 'git'], [67, 'unreadable'], [78, 'refused'], [79, 'host'], [80, 'timeout'], [81, 'memory'], [82, 'killed'], [1, 'host'], [65, 'git']];
    for (const [code, kind] of cases) {
        const runner = b.runner({ spawnRead: standInRead(b.folder, { code }) });
        const error = await failsWith(runner.read('site'), kind);
        assert.deepEqual(readdirSync(runner.workRoot), [], `workspace removed after ${code}`);
        if (code === 79) assert.equal(error.alert, true, 'the host failing alerts at once');
    }
    /* 65 with exactly the 17 bytes of an empty bundle is "no branches"; with any other bytes it is a failure. */
    assert.equal(hostFailure(65, '', EMPTY_BUNDLE.length).kind, 'empty');
    assert.equal(hostFailure(65, '', 18).kind, 'git');
    assert.equal(hostFailure(65, '', 0).kind, 'git');
    assert.match(hostFailure(66, 'fatal: \u001b[31mevil\n', 0).message, /text from the agent's repository: fatal: \?\[31mevil/);
    assert.equal(hostFailure(80, '', 0).ai, 'your repository could not be read in 300 s; pack it (git gc)');
});

test('the header is read here, on bytes, before any git: each refusal at its limit and one byte over', async (t) => {
    const b = bench(t);
    const id = 'a'.repeat(40);
    const parse = (bytes) => { const r = new HeaderReader(); return r.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'latin1')); };
    assert.deepEqual(parse(header(['# v2 git bundle', `${id} refs/heads/main`])).refs, [{ name: 'main', id }]);
    assert.equal(parse('# v2 git bundle\n'), undefined, 'more is needed');
    const refuses = (bytes, kind, pattern) => assert.throws(() => parse(bytes), (e) => e instanceof GitFailure && e.kind === kind && pattern.test(e.message));
    refuses(header(['# v3 git bundle', '@object-format=sha256']), 'v3', /version 3/);
    refuses(header(['# v2 git bundle', `-${id} a commit`]), 'prerequisite', /shallow/);
    refuses(header(['# v2 git bundle', `${id} refs/tags/x`]), 'header', /not a branch/);
    refuses(header(['# v2 git bundle', `${id} HEAD`]), 'header', /not a branch/);
    refuses(header(['# v2 git bundle', `${id} refs/heads/main`, `${'b'.repeat(40)} refs/heads/main`]), 'header', /two commits/);
    /* A name git allows but this server does not take ("café"): that branch dropped and said, the read goes on. */
    const accented = parse(Buffer.from(`# v2 git bundle\n${id} refs/heads/main\n${id} refs/heads/café\n\n`, 'utf8'));
    assert.deepEqual([accented.refs, accented.dropped.map((d) => d.name)], [[{ name: 'main', id }], ['café']]);
    refuses(header(['# v2 git bundle', `${id} refs/heads/a\tb`]), 'header', /control byte/);
    refuses(header(['# v2 git bundle', `${id} refs/heads/a\u007fb`]), 'header', /control byte/);
    refuses(header(['# git bundle']), 'header', /version 2/);
    /* A line: 4096 bytes pass, 4097 do not. */
    const name = (n) => 'x'.repeat(n - `${id} refs/heads/`.length);
    assert.equal(parse(header(['# v2 git bundle', `${id} refs/heads/${name(LINE_MAX)}`])).dropped.length, 1, 'read (and dropped: too long a branch name)');
    refuses(header(['# v2 git bundle', `${id} refs/heads/${name(LINE_MAX + 1)}`]), 'header', /longer than 4 KiB/);
    /* The whole header: 128 KiB at most. */
    const many = (count) => ['# v2 git bundle', ...Array.from({ length: count }, (_, i) => `${id} refs/heads/b${String(i).padStart(4, '0')}${'y'.repeat(150)}`)];
    const lineLength = `${id} refs/heads/b0000${'y'.repeat(150)}\n`.length;
    const near = many(Math.floor((HEADER_MAX - 20) / lineLength));
    assert.ok(header(near).length <= HEADER_MAX);
    assert.equal(parse(header(near)).refs.length, near.length - 1);
    refuses(header(many(Math.ceil(HEADER_MAX / lineLength) + 1)), 'header', /larger than 128 KiB/);
    /* 1000 branches pass, 1001 do not. */
    const names = (count) => ['# v2 git bundle', ...Array.from({ length: count }, (_, i) => `${id} refs/heads/b${i}`)];
    assert.equal(parse(header(names(READ_BRANCHES_MAX))).refs.length, READ_BRANCHES_MAX);
    refuses(header(names(READ_BRANCHES_MAX + 1)), 'many', /more than 1000 branches/);
    /* Exact duplicates are one; names git would take for something else are dropped and said. */
    const odd = parse(header(['# v2 git bundle', `${id} refs/heads/main`, `${id} refs/heads/main`, `${id} refs/heads/--upload-pack=x`, `${id} refs/heads/-f`, `${id} refs/heads/a/../b`, `${id} refs/heads/${'c'.repeat(40)}`, `${id} refs/heads/v/${'d'.repeat(64)}`]));
    assert.deepEqual(odd.refs, [{ name: 'main', id }]);
    assert.deepEqual(odd.dropped.map((d) => d.name), ['--upload-pack=x', '-f', 'a/../b', 'c'.repeat(40), `v/${'d'.repeat(64)}`]);
    /* Fed byte by byte, the same. */
    const r = new HeaderReader(); let done;
    for (const byte of header(['# v2 git bundle', `${id} refs/heads/main`])) done = r.push(Buffer.from([byte])) ?? done;
    assert.deepEqual(done.refs, [{ name: 'main', id }]);

    /* Through a whole read: forged bundles are refused and leave nothing. */
    committed(b.repo, 'a.txt', 'a\n', 'one');
    const real = bundleOf(b.repo);
    const forged = async (bytes, kind, pattern, options) => {
        const runner = b.runner({ spawnRead: bytesRead(b.dir, bytes, options) });
        await failsWith(runner.read('site'), kind, pattern);
        assert.deepEqual(readdirSync(runner.workRoot), []);
    };
    await forged(Buffer.concat([Buffer.from(real.header.replace('# v2', '# v3'), 'latin1'), real.pack]), 'v3', /version 3/);
    await forged(Buffer.concat([Buffer.from(real.header.replace('refs/heads/main', 'refs/tags/x'), 'latin1'), real.pack]), 'header', /not a branch/);
    await forged(Buffer.from(real.header, 'latin1'), 'header', /no pack follows/);
    await forged(Buffer.concat([Buffer.from(real.header, 'latin1'), Buffer.from('JUNKJUNK')]), 'header', /no pack follows/);
    await forged(Buffer.concat([Buffer.from(real.header, 'latin1'), real.pack.subarray(0, real.pack.length - 30)]), 'header', /pack was refused/);
    await forged(Buffer.from('# v2 git bundle\n'.padEnd(5000, 'z')), 'header', /longer than 4 KiB/, { endless: true });
    await forged(Buffer.from('# v2 git bundle\n0000'), 'header', /ended inside its header/);
});

test('every object is checked in an empty repository: a tip that is not a commit, an object left out, an fsck error', async (t) => {
    const b = bench(t);
    const one = committed(b.repo, 'a.txt', 'a\n', 'one');
    const two = committed(b.repo, 'b.txt', 'b\n', 'two');
    const real = bundleOf(b.repo);
    const forged = async (bytes, kind, pattern) => { const runner = b.runner({ spawnRead: bytesRead(b.dir, bytes) }); const e = await failsWith(runner.read('site'), kind, pattern); assert.deepEqual(readdirSync(runner.workRoot), []); return e; };
    /* A tip that is a blob of the pack, not a commit. */
    const blob = git(b.repo, 'rev-parse', `${two}:b.txt`);
    await forged(Buffer.concat([Buffer.from(real.header.replace(two, blob), 'latin1'), real.pack]), 'fsck', /not a commit/);
    /* A tip the bundle does not carry (a commit only the remote has, say). */
    await forged(Buffer.concat([Buffer.from(real.header.replace(two, 'e'.repeat(40)), 'latin1'), real.pack]), 'fsck', /not a commit/);
    /* A pack that lacks the parent: a thin pack against one the receiver does not have. */
    const pack = (await runGit(['pack-objects', '--stdout', '--revs', '--thin'], { cwd: b.repo, env: { GIT_DIR: join(b.repo, '.git') }, input: `${two}\n^${one}\n` })).stdout;
    const lacking = await forged(Buffer.concat([Buffer.from(real.header, 'latin1'), pack]), 'incomplete', /lacks objects/);
    assert.match(lacking.ai, /unshallow/, 'the agent is told what usually causes it');
    /* "a" and "a/b" cannot both be: refused, both named. */
    const clash = Buffer.concat([Buffer.from(`# v2 git bundle\n${two} refs/heads/a\n${two} refs/heads/a/b\n\n`, 'latin1'), real.pack]);
    await forged(clash, 'clash', /a and a\/b/);
});

test('fsck waivers: only for the ids of old histories, never for what guards a checkout, and offered only for those', async (t) => {
    const b = bench(t);
    committed(b.repo, 'a.txt', 'a\n', 'one');
    /* A tree with a zero-padded mode, as an old tool wrote them. */
    const blob = git(b.repo, 'rev-parse', 'HEAD:a.txt');
    const raw = Buffer.concat([Buffer.from('040000 sub\0'), Buffer.from(git(b.repo, 'rev-parse', 'HEAD^{tree}'), 'hex'), Buffer.from('100644 z.txt\0'), Buffer.from(blob, 'hex')]);
    const tree = runGitSync(b.repo, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], raw);
    const old = runGitSync(b.repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'old history'], '');
    git(b.repo, 'update-ref', 'refs/heads/main', old);
    const refused = await failsWith(b.runner().read('site'), 'fsck', /zeroPaddedFilemode/);
    assert.equal(refused.offer, 'zeroPaddedFilemode');
    const got = await b.runner().read('site', { waivers: { zeroPaddedFilemode: 'ignore' } });
    assert.equal(got.branches[0].id, old);
    got.remove();
    /* A tree entry named .git: refused, and no waiver is offered or accepted. */
    const evil = runGitSync(b.repo, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat([Buffer.from('100644 .git\0'), Buffer.from(blob, 'hex')]));
    git(b.repo, 'update-ref', 'refs/heads/main', runGitSync(b.repo, ['commit-tree', evil, '-m', 'evil'], ''));
    const dotgit = await failsWith(b.runner().read('site', { waivers: { zeroPaddedFilemode: 'ignore' } }), 'fsck', /hasDotgit/);
    assert.equal(dotgit.offer, null);
    for (const id of ['hasDotgit', 'gitmodulesUrl', 'symlinkPointsToGitDir', 'hasDotdot', 'fullPathname', 'badTree', 'nulInHeader']) assert.match(waiversProblem({ [id]: 'ignore' }), /cannot be waived/);
    assert.equal(waiversProblem({ zeroPaddedFilemode: 'warn', badTimezone: 'ignore' }), '');
    assert.match(waiversProblem({ badDate: 'error' }), /ignore.*warn/);
    assert.equal(strictOption({ zeroPaddedFilemode: 'ignore', hasDotgit: 'ignore' }), '--strict=zeroPaddedFilemode=ignore');
    assert.equal(strictOption({}), '--strict');
    assert.deepEqual([...FSCK_WAIVABLE].sort(), ['badDate', 'badFilemode', 'badTimezone', 'missingEmail', 'missingNameBeforeEmail', 'missingSpaceBeforeDate', 'missingSpaceBeforeEmail', 'zeroPaddedFilemode']);
});
const runGitSync = (cwd, argv, input) => execFileSync('git', argv, { cwd, env: ENV, input, encoding: 'utf8' }).trim();

test('R measured while a refresh rewrites the reference: the last good measure, never 0 for a reference that exists', async (t) => {
    const b = bench(t);
    let failing = false;
    const runner = b.runner({ git: (argv, options) => (failing && argv.includes('--disk-usage') ? Promise.resolve({ code: 128, signal: null, stdout: Buffer.alloc(0), stderr: 'fatal: bad object', killed: null }) : runGit(argv, options)) });
    const reference = join(b.dir, 'reference.git');
    git(b.dir, 'init', '--quiet', '--bare', reference);
    committed(b.repo, 'a.txt', 'a\n', 'one');
    git(reference, 'fetch', '--quiet', b.repo, '+refs/heads/*:refs/heads/*');
    const r = await runner.sizeOf(reference);
    assert.ok(r > 0);
    failing = true;
    assert.equal(await runner.sizeOf(reference), r);
});

test('a pack refused partway (fsck) is said at once, with its offer: never as the time limit', async (t) => {
    /* index-pack --strict stops at the first bad object; the pack carries the
       commit first and megabytes of blob after it. The read must not wait,
       paused on a pipe nobody empties, for its time limit. */
    const b = bench(t);
    committed(b.repo, 'a.txt', 'a\n', 'one');
    writeFileSync(join(b.repo, 'big.bin'), randomBytes(8 * MiB));
    git(b.repo, 'add', 'big.bin');
    const tree = git(b.repo, 'write-tree');
    const parent = git(b.repo, 'rev-parse', 'HEAD');
    const raw = `tree ${tree}\nparent ${parent}\nauthor Old Tool <> 1100000000 +99999\ncommitter Old Tool <> 1100000000 +99999\n\nfrom an old history\n`;
    git(b.repo, 'update-ref', 'refs/heads/main', runGitSync(b.repo, ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], raw));
    const runner = b.runner({ readDeadlineMs: 60_000 });
    const started = Date.now();
    const refusedRead = await failsWith(runner.read('site'), 'fsck', /badTimezone/);
    assert.equal(refusedRead.offer, 'badTimezone', 'the waiver is offered');
    assert.ok(Date.now() - started < 20_000, `said at once, not at the time limit (${Date.now() - started} ms)`);
    assert.deepEqual(readdirSync(runner.workRoot), []);
    /* Waived, the same history is read whole. */
    const got = await runner.read('site', { waivers: { badTimezone: 'ignore' } });
    assert.equal(got.branches[0].name, 'main');
    got.remove();
});

test('a .git git cannot open is refused: the folder is never read as a bare repository in its place', async (t) => {
    /* git that finds .git unusable tries the folder itself as a bare
       repository; the reader's checks of .git (shallow, commondir, refs)
       would then be of a repository git does not read. */
    const b = bench(t);
    const src = join(b.dir, 'src');
    mkdirSync(src);
    git(src, 'init', '--quiet', '--initial-branch=main');
    for (const n of ['1', '2', '3']) committed(src, 'f.txt', `${n}\n`, `c${n}`);
    const top = b.folder('bare');
    git(b.dir, 'clone', '--quiet', '--bare', '--depth', '1', `file://${src}`, top);
    const id = git(top, 'rev-parse', 'HEAD');
    mkdirSync(join(top, '.git', 'objects'), { recursive: true }); mkdirSync(join(top, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(top, '.git', 'HEAD'), 'junk\n');
    writeFileSync(join(top, '.git', 'refs', 'heads', 'main'), `${id}\n`);
    await failsWith(b.runner().read('bare'), 'git', /Git failed to read/);
});

test('the cap: from the remote\'s size only, bytes counted from the first, cap-1 / cap / cap+1', async (t) => {
    const b = bench(t);
    assert.equal(capFor(0), CAP_MIN, 'no reference yet: R = 0');
    assert.equal(capFor(100 * MiB), CAP_MIN);
    assert.equal(capFor(200 * MiB), 2 * 200 * MiB + CAP_EXTRA);
    assert.equal(capFor(10 * 1024 * MiB), CAP_MAX);
    const runner = b.runner();
    assert.equal(await runner.sizeOf(undefined), 0);
    assert.equal(await runner.sizeOf(join(b.dir, 'nowhere')), 0);
    /* The reference's size: what the agent commits never changes it. */
    const reference = join(b.dir, 'reference.git');
    git(b.dir, 'init', '--quiet', '--bare', reference);
    committed(b.repo, 'a.txt', 'a\n', 'one');
    git(reference, 'fetch', '--quiet', b.repo, '+refs/heads/*:refs/heads/*');
    const r = await runner.sizeOf(reference);
    assert.ok(r > 0);
    for (let i = 0; i < 5; i++) committed(b.repo, `f${i}.txt`, 'x'.repeat(10_000 + i), `more ${i}`);
    (await runner.read('site', { reference })).remove();
    assert.equal(await runner.sizeOf(reference), r);
    /* Every byte counts, header included. */
    const size = bundleOf(b.repo); const total = size.header.length + size.pack.length;
    for (const [cap, ok] of [[total - 1, false], [total, true], [total + 1, true]]) {
        const capped = b.runner({ cap });
        if (ok) (await capped.read('site')).remove();
        else await failsWith(capped.read('site'), 'cap', /over the cap/);
        assert.deepEqual(readdirSync(capped.workRoot), []);
    }
    /* Not enough room: refused before anything is read, the owner alerted. */
    const reads = [];
    const tight = new GitRunner({ dataDir: join(b.dir, 'data'), reserveBytes: Number.MAX_SAFE_INTEGER, spawnRead: standInRead(b.folder, { reads }) });
    const room = await failsWith(tight.read('site'), 'space', /MB free/);
    assert.equal(room.alert, true);
    assert.deepEqual(reads, []);
});

test('a read past the deadline is stopped, the host is told, the workspace removed', async (t) => {
    const b = bench(t);
    const runner = b.runner({ readDeadlineMs: 300, spawnRead: bytesRead(b.dir, Buffer.from('# v2 git bundle\n'), { code: 0, endless: false }) });
    /* A reader that never ends: it writes a header line, then hangs. */
    const hang = new GitRunner({ dataDir: join(b.dir, 'data'), reserveBytes: 0, readDeadlineMs: 300,
        spawnRead: () => spawnNode('process.stdout.write("# v2 git bundle\\n"); setInterval(() => {}, 1000);') });
    await failsWith(hang.read('site'), 'deadline', /time limit/);
    assert.deepEqual(readdirSync(hang.workRoot), []);
    await failsWith(runner.read('site'), 'header', /ended inside its header/);
});
const spawnNode = (code) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });

test('the builder: an argument array, an environment from nothing, everything that runs a program turned off', async (t) => {
    const b = bench(t);
    const args = gitArgs(['status'], { allow: ['https'], receive: true });
    for (const setting of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.allow=never', 'protocol.https.allow=always', 'transfer.fsckObjects=true', 'core.attributesFile=/dev/null', 'gc.auto=0', 'http.followRedirects=false']) {
        assert.equal(args[args.indexOf(setting) - 1], '-c', setting);
    }
    assert.equal(args.includes('protocol.file.allow=always'), false);
    assert.equal(args.join(' ').includes('safe.directory'), false, 'never safe.directory');
    process.env.GIT_DIR = '/somewhere/else'; process.env.GIT_SSH_COMMAND = 'evil';
    try {
        const env = gitEnv('/empty');
        assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort(), ['GIT_ATTR_SOURCE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS', 'GIT_TERMINAL_PROMPT']);
        assert.deepEqual([env.HOME, env.XDG_CONFIG_HOME, env.LC_ALL, env.GIT_CONFIG_GLOBAL], ['/empty', '/empty', 'C', '/dev/null']);
    } finally { delete process.env.GIT_DIR; delete process.env.GIT_SSH_COMMAND; }
    /* The deadline kills git's whole group, and close is waited for. */
    const pidFile = join(b.dir, 'pid');
    const slow = join(b.dir, 'slow-ssh');
    writeFileSync(slow, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`); chmodSync(slow, 0o755);
    const started = Date.now();
    const r = await runGit(['ls-remote', '--end-of-options', 'ssh://example.com/x.git'], { allow: ['ssh'], env: { GIT_SSH_COMMAND: slow }, deadlineMs: 700 });
    assert.equal(r.killed, 'deadline');
    assert.ok(Date.now() - started < 10_000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((done) => setTimeout(done, 200));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child of git was killed too');
    /* Output past its bound is cut and said. */
    committed(b.repo, 'big.txt', 'z'.repeat(5000), 'big');
    const cut = await runGit(['cat-file', '-p', 'HEAD:big.txt'], { cwd: b.repo, env: { GIT_DIR: join(b.repo, '.git') }, maxBytes: 100 });
    assert.equal(cut.killed, 'size'); assert.equal(cut.stdout.length, 100);
});

test('waiting in line: a lock waited for a bounded time, two host reads at a time', async () => {
    const m = new Mutex();
    const release = await m.acquire(100);
    await assert.rejects(m.acquire(50), (e) => e.kind === 'busy');
    const next = m.acquire(1000);
    release(); release();
    const second = await next;
    assert.equal(m.held, true);
    second();
    assert.equal(m.held, false);
    const slots = new Slots(2); const order = [];
    const a = await slots.take(); const c = await slots.take();
    const waiting = slots.take().then((r) => { order.push('third'); return r; });
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(order, []);
    a(); (await waiting)(); c();
    assert.deepEqual(order, ['third']);
});

test('branch names: check-ref-format and ours, and no part that looks like an object id', () => {
    assert.equal(branchProblem('main'), '');
    assert.match(branchProblem('a'.repeat(40)), /commit id/);
    assert.match(branchProblem(`x/${'b'.repeat(64)}`), /commit id/);
    assert.equal(branchProblem('a'.repeat(39)), '');
    assert.equal(branchProblem('a'.repeat(41)), '');
});
