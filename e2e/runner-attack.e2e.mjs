/* RED TEAM, FOR REAL: the agent's attacks that only the sandbox of
   `clavarium-host git read` stops -- a .git whose parts are links to another
   repository of this server, alternates pointing at it, hostile settings, a
   FIFO -- run against the real systemd unit, as root, on a development box.

   OPT-IN: CLAVARIUM_REAL_SANDBOX=1, and `sudo -n` must work. It starts
   transient units (clvread-attack<random>_*) and stops and forgets each one;
   everything it makes is under a scratch folder it removes. Never run it on
   a machine that matters.

   The vector is the host program's own (`--say-only git read`), changed only
   where the trial of the blueprint changed it: the runner root and the
   reader script point into the scratch folder (the real ones are installed
   by install.sh). Exit codes are mapped by the host program's own table
   (`git code`). The bytes then go through the real GitRunner. Each test
   passes when the attack fails safely. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitRunner, GitFailure } from '../server/gitrunner.mjs';
import { git, committed } from '../test/git-stand-in.mjs';

const HOST = fileURLToPath(new URL('../deploy/clavarium-host', import.meta.url));
const READER = fileURLToPath(new URL('../deploy/git-read', import.meta.url));
const sudoWorks = () => spawnSync('sudo', ['-n', 'true']).status === 0 && spawnSync('systemd-run', ['--version']).status === 0;
const SKIP = process.env.CLAVARIUM_REAL_SANDBOX === '1' ? (sudoWorks() ? false : 'sudo -n or systemd-run is not available') : 'set CLAVARIUM_REAL_SANDBOX=1 to run the real sandbox';

/* Runs the unit, then says its end as the host program would. */
const WRAPPER = `unit="$1"; host="$2"; shift 2
sudo -n "$@"
rc=$?
code=0
if [ "$rc" -ne 0 ]; then
  props="$(sudo -n systemctl show -p Result -p ExecMainCode -p ExecMainStatus "$unit.service" 2>/dev/null)"
  code="$(bash "$host" --say-only --data /nowhere git code "$(sed -n 's/^Result=//p' <<< "$props")" "$(sed -n 's/^ExecMainCode=//p' <<< "$props")" "$(sed -n 's/^ExecMainStatus=//p' <<< "$props")")"
fi
sudo -n systemctl stop "$unit.service" >/dev/null 2>&1
sudo -n systemctl reset-failed "$unit.service" >/dev/null 2>&1
exit "$code"`;

function bench(t, { extra = [] } = {}) {
    const base = join('/tmp', `claude-${process.getuid()}`, `clv-sandbox-attack-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(base, 'resources'), { recursive: true, mode: 0o755 });
    const root = join(base, 'runner-root');
    execFileSync('sudo', ['-n', 'install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', root]);
    t.after(() => { spawnSync('sudo', ['-n', 'rm', '-rf', '--one-file-system', base]); });
    const folder = (name) => join(base, 'resources', name);
    const units = [];
    const sandboxRead = (name, more = []) => {
        const unit = `clvread-attack${randomBytes(3).toString('hex')}_${randomBytes(8).toString('hex')}`;
        units.push(unit);
        const vector = execFileSync('bash', [HOST, '--say-only', '--data', base, '--mnt', base, 'git', 'read', name], { encoding: 'utf8' }).split('\n').filter((l) => l !== '');
        const changed = vector.map((a) => (a.startsWith('--unit=') ? `--unit=${unit}` : a.startsWith('RootDirectory=') ? `RootDirectory=${root}` : a));
        const script = changed.indexOf('/usr/lib/clavarium/git-read');
        assert.ok(script > 0, 'the vector names the reader');
        changed.splice(script, 1, '-p', `BindReadOnlyPaths=${READER}:/git-read`, ...[...extra, ...more].flatMap((p) => ['-p', p]), '/git-read');
        return spawn('bash', ['-c', WRAPPER, 'sandbox-read', unit, HOST, ...changed], { stdio: ['ignore', 'pipe', 'pipe'] });
    };
    t.after(() => {
        /* No unit left behind, whatever happened. */
        for (const unit of units) { spawnSync('sudo', ['-n', 'systemctl', 'stop', `${unit}.service`]); spawnSync('sudo', ['-n', 'systemctl', 'reset-failed', `${unit}.service`]); }
    });
    const runner = (spawnRead = sandboxRead) => new GitRunner({ dataDir: join(base, 'data'), reserveBytes: 0, spawnRead });
    const site = folder('site'); const vault = folder('vault');
    mkdirSync(site, { mode: 0o755 }); mkdirSync(vault, { mode: 0o755 });
    git(site, 'init', '--quiet', '--initial-branch=main');
    git(vault, 'init', '--quiet', '--initial-branch=main');
    const secret = committed(vault, 'secret.txt', 'the vault content\n', 'vault only');
    return { base, folder, site, vault, secret, runner, sandboxRead, units };
}
const failsSafely = async (b, runner, what) => {
    const got = await runner.read('site').catch((e) => e);
    if (!(got instanceof GitFailure)) { got.remove(); assert.fail(`${what}: it was read: ${JSON.stringify(got.branches)}`); }
    assert.notEqual(got.kind, 'empty', `${what}: "${got.message}"`);
    assert.doesNotMatch(JSON.stringify(got), new RegExp(b.secret), `${what}: the vault's commit was seen`);
    return got;
};

test('real sandbox: a plain repository is read (the bench itself works)', { skip: SKIP }, async (t) => {
    const b = bench(t);
    const one = committed(b.site, 'a.txt', 'a\n', 'one');
    const got = await b.runner().read('site');
    assert.deepEqual(got.branches, [{ name: 'main', id: one }]);
    got.remove();
});

test('real sandbox: .git parts as links to another repository of this server, absolute and relative', { skip: SKIP }, async (t) => {
    const b = bench(t);
    committed(b.site, 'a.txt', 'a\n', 'mine');
    const dotgit = join(b.site, '.git');
    const vaultGit = join(b.vault, '.git');
    git(b.vault, 'pack-refs', '--all');
    const tries = {
        'absolute links': (part) => join(vaultGit, part),
        'relative links': (part) => join('..', '..', 'vault', '.git', part),
    };
    for (const [what, target] of Object.entries(tries)) {
        for (const part of ['refs', 'objects', 'packed-refs']) { rmSync(join(dotgit, part), { recursive: true, force: true }); symlinkSync(target(part), join(dotgit, part)); }
        await failsSafely(b, b.runner(), what);
    }
});

test('real sandbox: alternates and a loose ref linked to another repository of this server', { skip: SKIP }, async (t) => {
    const b = bench(t);
    committed(b.site, 'a.txt', 'a\n', 'mine');
    const info = join(b.site, '.git', 'objects', 'info');
    mkdirSync(info, { recursive: true });
    /* A branch at the vault's commit: only alternates could supply its objects. */
    writeFileSync(join(b.site, '.git', 'refs', 'heads', 'steal'), `${b.secret}\n`);
    for (const line of [join(b.vault, '.git', 'objects'), join('..', '..', '..', 'vault', '.git', 'objects')]) {
        writeFileSync(join(info, 'alternates'), `${line}\n`);
        await failsSafely(b, b.runner(), `alternates ${line.startsWith('/') ? 'absolute' : 'relative'}`);
    }
    rmSync(join(info, 'alternates'));
    rmSync(join(b.site, '.git', 'refs', 'heads', 'steal'));
    /* A loose ref that is a link to the vault's ref file. */
    symlinkSync(join(b.vault, '.git', 'refs', 'heads', 'main'), join(b.site, '.git', 'refs', 'heads', 'linked'));
    const error = await failsSafely(b, b.runner(), 'linked ref');
    assert.equal(error.kind, 'unreadable', error.message);
});

test('real sandbox: gitfile, .git link and commondir to the vault', { skip: SKIP }, async (t) => {
    const b = bench(t);
    committed(b.site, 'a.txt', 'a\n', 'mine');
    const dotgit = join(b.site, '.git');
    rmSync(dotgit, { recursive: true, force: true });
    writeFileSync(dotgit, `gitdir: ${join(b.vault, '.git')}\n`);
    assert.equal((await failsSafely(b, b.runner(), 'gitfile')).kind, 'git');
    rmSync(dotgit);
    symlinkSync(join('..', 'vault', '.git'), dotgit);
    assert.equal((await failsSafely(b, b.runner(), '.git link')).kind, 'git');
});

test('real sandbox: hostile settings run nothing, and the read still works', { skip: SKIP }, async (t) => {
    const b = bench(t);
    const one = committed(b.site, 'a.txt', 'a\n', 'one');
    /* A folder anybody could write: if anything ran inside the unit with a
       way out, it would leave a file here. */
    const markers = join(b.base, 'markers');
    mkdirSync(markers); execFileSync('chmod', ['0777', markers]);
    const touch = (what) => `touch ${markers}/${what}`;
    for (const [key, value] of Object.entries({
        'core.fsmonitor': touch('fsmonitor'), 'core.sshCommand': touch('ssh'), 'core.pager': touch('pager'), 'pager.bundle': touch('pager-bundle'),
        'alias.bundle': `!${touch('alias')}`, 'credential.helper': `!${touch('credential')}`, 'core.alternateRefsCommand': touch('alternate-refs'),
        'uploadpack.packObjectsHook': touch('pack-hook'), 'gpg.program': touch('gpg'), 'core.hooksPath': markers,
    })) git(b.site, 'config', key, value);
    /* Last: once it is there, git outside the sandbox cannot read this config any more (the file is root's). */
    git(b.site, 'config', 'include.path', '/etc/shadow');
    const got = await b.runner().read('site');
    assert.deepEqual(got.branches, [{ name: 'main', id: one }]);
    got.remove();
    assert.deepEqual(readdirSync(markers), []);
});

test('real sandbox: a FIFO packed-refs is stopped by the unit\'s time limit, and the next read works', { skip: SKIP }, async (t) => {
    const b = bench(t, { extra: ['RuntimeMaxSec=5'] });
    const one = committed(b.site, 'a.txt', 'a\n', 'one');
    execFileSync('mkfifo', [join(b.site, '.git', 'packed-refs')]);
    const error = await failsSafely(b, b.runner(), 'FIFO');
    assert.equal(error.kind, 'timeout', error.message);
    rmSync(join(b.site, '.git', 'packed-refs'));
    const got = await b.runner().read('site');
    assert.deepEqual(got.branches, [{ name: 'main', id: one }]);
    got.remove();
    const left = spawnSync('systemctl', ['list-units', '--all', '--no-legend', 'clvread-attack*'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(left, '', 'a unit was left behind');
});

test('real sandbox: a looping symbolic ref as the only branch reads as "no branches"', { skip: SKIP }, async (t) => {
    /* The same finding as the unit test, through the real unit: the
       repository is broken, the owner and the agent are told nothing was
       committed. */
    const b = bench(t);
    committed(b.site, 'a.txt', 'a\n', 'one');
    writeFileSync(join(b.site, '.git', 'refs', 'heads', 'main'), 'ref: refs/heads/main\n');
    await failsSafely(b, b.runner(), 'symref loop');
});

test('real sandbox: the scratch folder holds nothing the unit wrote', { skip: SKIP }, async (t) => {
    const b = bench(t);
    committed(b.site, 'a.txt', 'a\n', 'one');
    const before = execFileSync('find', [b.site, '-newer', join(b.site, '.git', 'HEAD'), '-print'], { encoding: 'utf8' });
    const got = await b.runner().read('site');
    got.remove();
    const after = execFileSync('find', [b.site, '-newer', join(b.site, '.git', 'HEAD'), '-print'], { encoding: 'utf8' });
    assert.equal(after, before, 'the read changed the agent\'s folder');
    assert.equal(existsSync(join(b.base, 'runner-root', 'resources', 'site', '.git')), false, 'the folder leaked into the runner root');
});
