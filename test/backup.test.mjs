/* Backup and restore, run for real on a small tree (--root): what goes in the
   archive, what stays out, and what restore refuses before touching anything. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = (name) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));
const run = (name, ...args) => { const r = spawnSync('/bin/bash', [script(name), ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

function house(t, { secrets = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-backup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'root'); const out = join(dir, 'out');
    for (const d of ['home/clavarium/resources/notes', 'home/clavarium-mnt/resources/site', 'home/clavarium/views/notes', 'var/lib/clavarium-vault', 'etc/clavarium', 'etc/dex']) mkdirSync(join(root, d), { recursive: true });
    mkdirSync(out);
    writeFileSync(join(root, 'home/clavarium/conversations.json'), JSON.stringify([{ name: 'first', tool: 'shell' }, { name: 'second', tool: 'shell' }], null, 2));
    writeFileSync(join(root, 'home/clavarium/secrets.json'), JSON.stringify(secrets ? [{ name: 'MODEL_KEY', sealed: 'xx' }] : [], null, 2));
    writeFileSync(join(root, 'home/clavarium/resources/notes/kept.txt'), 'precious');
    /* Where the shared folders live since the git runner: on root's own chain. */
    writeFileSync(join(root, 'home/clavarium-mnt/resources/site/page.html'), 'shared');
    writeFileSync(join(root, 'home/clavarium/views/notes/mirror.txt'), 'a mirror, not content');
    writeFileSync(join(root, 'var/lib/clavarium-vault/vault.key'), Buffer.alloc(32, 7));
    writeFileSync(join(root, 'etc/dex/config.yaml'), 'issuer: https://clav.example.com/dex\n');
    return { dir, root, out };
}
const files = (out) => { const all = readdirSync(out); return { archive: join(out, all.find((f) => f.endsWith('.tgz'))), key: join(out, all.find((f) => f.endsWith('.vault-key')) ?? 'none') }; };
const listing = (archive) => spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout;

test('a backup is two files: the archive without the key, and the key apart', (t) => {
    const h = house(t);
    const r = run('backup.sh', '--to', h.out, '--root', h.root);
    assert.equal(r.code, 0, r.err);
    const { archive, key } = files(h.out);
    const inside = listing(archive);
    assert.ok(inside.includes('home/clavarium/conversations.json'));
    assert.ok(inside.includes('home/clavarium/resources/notes/kept.txt'));
    assert.ok(inside.includes('home/clavarium-mnt/resources/site/page.html'));
    assert.ok(inside.includes('etc/dex/config.yaml'));
    assert.ok(!inside.includes('vault'), 'the key is not in the archive');
    assert.ok(!inside.includes('views/'), 'mirrors are not content');
    assert.deepEqual(readFileSync(key), Buffer.alloc(32, 7));
    assert.equal(statSync(archive).mode & 0o077, 0, 'readable by its owner only');
    assert.equal(statSync(key).mode & 0o077, 0);
    assert.match(r.out, /two different places/);
    assert.match(r.out, /Not in the backup: the conversations' machines/);
});

test('restore puts back what was lost, sets aside what was there, and says whose machines are not in it', (t) => {
    const h = house(t);
    run('backup.sh', '--to', h.out, '--root', h.root);
    const { archive, key } = files(h.out);
    /* The disaster: data gone, a different list in its place. */
    rmSync(join(h.root, 'home/clavarium/resources'), { recursive: true });
    rmSync(join(h.root, 'home/clavarium-mnt'), { recursive: true });
    rmSync(join(h.root, 'var/lib/clavarium-vault'), { recursive: true });
    writeFileSync(join(h.root, 'home/clavarium/conversations.json'), '[]');
    const checked = run('restore.sh', archive, '--vault-key', key, '--check', '--root', h.root);
    assert.equal(checked.code, 0, checked.err);
    assert.match(checked.out, /first\n {2}second/);
    assert.equal(readFileSync(join(h.root, 'home/clavarium/conversations.json'), 'utf8'), '[]', '--check changes nothing');
    const r = run('restore.sh', archive, '--vault-key', key, '--root', h.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(readFileSync(join(h.root, 'home/clavarium/conversations.json'), 'utf8')).length, 2);
    /* A folder the archive held where an older house kept it comes back where folders live now. */
    assert.equal(readFileSync(join(h.root, 'home/clavarium-mnt/resources/notes/kept.txt'), 'utf8'), 'precious');
    assert.equal(readFileSync(join(h.root, 'home/clavarium-mnt/resources/site/page.html'), 'utf8'), 'shared');
    assert.deepEqual(readFileSync(join(h.root, 'var/lib/clavarium-vault/vault.key')), Buffer.alloc(32, 7));
    const aside = readdirSync(join(h.root, 'var/backups'));
    assert.equal(aside.length, 1);
    assert.ok(existsSync(join(h.root, 'var/backups', aside[0], 'state.tgz')));
});

test('restore refuses, before touching anything: no key for sealed secrets, a wrong key, a foreign archive, a path that leaves', (t) => {
    const h = house(t);
    run('backup.sh', '--to', h.out, '--root', h.root);
    const { archive } = files(h.out);
    const before = readFileSync(join(h.root, 'home/clavarium/conversations.json'), 'utf8');
    const noKey = run('restore.sh', archive, '--root', h.root);
    assert.equal(noKey.code, 78);
    assert.match(noKey.err, /sealed secrets/);
    const short = join(h.dir, 'short.key'); writeFileSync(short, 'too short');
    assert.equal(run('restore.sh', archive, '--vault-key', short, '--root', h.root).code, 78);
    /* An archive made by something else. */
    const foreign = join(h.dir, 'foreign.tgz');
    mkdirSync(join(h.dir, 'x/etc'), { recursive: true }); writeFileSync(join(h.dir, 'x/etc/passwd'), 'x');
    spawnSync('tar', ['-czf', foreign, '-C', join(h.dir, 'x'), 'etc']);
    assert.equal(run('restore.sh', foreign, '--root', h.root).code, 78);
    /* One made to look like ours, with a file for somewhere else. */
    mkdirSync(join(h.dir, 'y/home/clavarium'), { recursive: true }); mkdirSync(join(h.dir, 'y/etc/sudoers.d'), { recursive: true });
    writeFileSync(join(h.dir, 'y/BACKUP.txt'), 'x'); writeFileSync(join(h.dir, 'y/home/clavarium/conversations.json'), '[]'); writeFileSync(join(h.dir, 'y/etc/sudoers.d/all'), 'x');
    const planted = join(h.dir, 'planted.tgz');
    spawnSync('tar', ['-czf', planted, '-C', join(h.dir, 'y'), 'BACKUP.txt', 'home', 'etc']);
    const r = run('restore.sh', planted, '--root', h.root);
    assert.equal(r.code, 78);
    assert.match(r.err, /not part of a backup/);
    assert.equal(run('restore.sh', join(h.dir, 'nowhere.tgz'), '--root', h.root).code, 64);
    assert.equal(readFileSync(join(h.root, 'home/clavarium/conversations.json'), 'utf8'), before);
    assert.equal(existsSync(join(h.root, 'var/backups')), false, 'nothing was even set aside');
});

test('an archive made before the move to root\'s chain comes back on it: folders, work and what was put aside under MNT, and MNT declared', (t) => {
    /* Before, host.conf said only DATA, and everything lived under home/clavarium:
       restored as it was, the host program would refuse every verb. */
    const h = house(t, { secrets: false });
    rmSync(join(h.root, 'home/clavarium-mnt'), { recursive: true });
    mkdirSync(join(h.root, 'home/clavarium/work/alpha'), { recursive: true });
    writeFileSync(join(h.root, 'home/clavarium/work/alpha/made.txt'), 'made by the tool');
    mkdirSync(join(h.root, 'home/clavarium/removed/old-1'), { recursive: true });
    mkdirSync(join(h.root, 'home/clavarium/work-disks'), { recursive: true });
    writeFileSync(join(h.root, 'home/clavarium/work-disks/alpha.img'), 'a disk, never in an archive');
    /* A link inside a folder is the agent's: its target is never rewritten. */
    symlinkSync('home/clavarium/resources/notes/kept.txt', join(h.root, 'home/clavarium/resources/notes/link'));
    writeFileSync(join(h.root, 'etc/clavarium/host.conf'), 'DATA=/home/clavarium\n');
    assert.equal(run('backup.sh', '--to', h.out, '--root', h.root).code, 0);
    const { archive } = files(h.out);
    /* The new house: install.sh wrote MNT; the old data are gone. */
    rmSync(join(h.root, 'home/clavarium'), { recursive: true });
    writeFileSync(join(h.root, 'etc/clavarium/host.conf'), 'DATA=/home/clavarium\nMNT=/home/clavarium-mnt\n');
    const r = run('restore.sh', archive, '--root', h.root);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(h.root, 'home/clavarium-mnt/resources/notes/kept.txt'), 'utf8'), 'precious');
    assert.equal(readFileSync(join(h.root, 'home/clavarium-mnt/work/alpha/made.txt'), 'utf8'), 'made by the tool');
    assert.ok(existsSync(join(h.root, 'home/clavarium-mnt/removed/old-1')));
    assert.equal(readlinkSync(join(h.root, 'home/clavarium-mnt/resources/notes/link')), 'home/clavarium/resources/notes/kept.txt');
    for (const d of ['resources', 'work', 'removed', 'views', 'work-disks']) assert.equal(existsSync(join(h.root, 'home/clavarium', d)), false, `nothing left in home/clavarium/${d}`);
    assert.equal(readFileSync(join(h.root, 'home/clavarium/conversations.json'), 'utf8').length > 0, true, 'the server\'s own files stay in its data directory');
    /* The old host.conf came back with the archive, and MNT was added to it. */
    assert.match(readFileSync(join(h.root, 'etc/clavarium/host.conf'), 'utf8'), /^DATA=\/home\/clavarium\nMNT=\/home\/clavarium-mnt\n$/);
});

test('a backup with no secret stored needs no key to come back', (t) => {
    const h = house(t, { secrets: false });
    rmSync(join(h.root, 'var/lib/clavarium-vault'), { recursive: true });
    const made = run('backup.sh', '--to', h.out, '--root', h.root);
    assert.match(made.out, /vault key\s+none yet/);
    assert.equal(run('restore.sh', files(h.out).archive, '--root', h.root).code, 0);
});

test('--server-only, taken before each update: the server\'s own data and settings, not the folders given to machines', (t) => {
    const h = house(t);
    const r = run('backup.sh', '--server-only', '--to', h.out, '--root', h.root);
    assert.equal(r.code, 0, r.err);
    const inside = listing(files(h.out).archive);
    assert.ok(inside.includes('home/clavarium/conversations.json'));
    assert.ok(inside.includes('etc/clavarium/'));
    for (const out of ['home/clavarium/resources', 'home/clavarium-mnt', 'etc/dex', 'home/clavarium/views']) assert.ok(!inside.includes(out), out);
    /* restore.sh takes it as a backup. */
    assert.equal(run('restore.sh', files(h.out).archive, '--vault-key', files(h.out).key, '--check').code, 0);
});
