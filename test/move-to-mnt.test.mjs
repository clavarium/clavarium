/* The one-time move of what the machines are given, from the data directory
   (the server's) to MNT (root's chain): deploy/move-to-mnt.sh, run for real
   on a small tree, with stand-ins for the VM manager, mount and the host
   program that record what they are asked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../deploy/move-to-mnt.sh', import.meta.url));

function house(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-move-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const data = join(dir, 'data'); const mnt = join(dir, 'mnt'); const bin = join(dir, 'bin'); const said = join(dir, 'said');
    for (const d of ['resources/notes', 'resources/site', 'views/notes', 'work/alpha', 'work-disks', 'removed/old-1']) mkdirSync(join(data, d), { recursive: true });
    for (const d of ['resources', 'views', 'work', 'work-disks', 'removed']) mkdirSync(join(mnt, d), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(data, 'conversations.json'), '[]');
    writeFileSync(join(data, 'resources/notes/kept.txt'), 'precious');
    writeFileSync(join(data, 'resources/site/.hidden'), 'hidden too');
    writeFileSync(join(data, 'work/alpha/made.txt'), 'made by the tool');
    writeFileSync(join(data, 'work-disks/alpha.img'), 'a disk');
    /* The VM manager: one machine, given the view of notes and its work folder. */
    const info = { errors: [], info: { 'clv-alpha': { mounts: {
        '/resources/notes': { source_path: join(data, 'views/notes'), uid_mappings: ['998:1000'], gid_mappings: ['997:1000'] },
        '/work': { source_path: join(data, 'work/alpha'), uid_mappings: ['998:1000'], gid_mappings: ['997:1000'] },
        '/elsewhere': { source_path: '/srv/other', uid_mappings: ['1:1000'], gid_mappings: ['1:1000'] },
    } } } };
    const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${said}\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub('multipass', `case "$1" in list) printf 'Name,State\\nclv-alpha,Running\\nprimary,Running\\n' ;; info) cat ${join(dir, 'info.json')} ;; esac; exit 0`);
    writeFileSync(join(dir, 'info.json'), JSON.stringify(info));
    /* Mounted: the view of notes and the work disk of alpha, until unmounted. */
    writeFileSync(join(dir, 'mounted'), `${join(data, 'views/notes')}\n${join(data, 'work/alpha')}\n`);
    stub('mountpoint', `grep -qxF -- "$2" ${join(dir, 'mounted')}`);
    stub('umount', `grep -vxF -- "$1" ${join(dir, 'mounted')} > ${join(dir, 'mounted.new')}; mv ${join(dir, 'mounted.new')} ${join(dir, 'mounted')}`);
    stub('host', 'exit 0');
    const run = () => {
        const r = spawnSync('/bin/bash', [SCRIPT, '--data', data, '--mnt', mnt, '--host', join(bin, 'host'), '--node', process.execPath], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
        return { code: r.status, out: r.stdout, err: r.stderr, said: existsSync(said) ? readFileSync(said, 'utf8').trim().split('\n') : [] };
    };
    return { dir, data, mnt, run };
}

test('moved, never copied: every folder, work folder, disk and what was put aside ends under MNT, and the data directory keeps only the server\'s files', (t) => {
    const h = house(t);
    const r = h.run();
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(h.mnt, 'resources/notes/kept.txt'), 'utf8'), 'precious');
    assert.equal(readFileSync(join(h.mnt, 'resources/site/.hidden'), 'utf8'), 'hidden too');
    assert.equal(readFileSync(join(h.mnt, 'work/alpha/made.txt'), 'utf8'), 'made by the tool');
    assert.equal(readFileSync(join(h.mnt, 'work-disks/alpha.img'), 'utf8'), 'a disk');
    assert.ok(existsSync(join(h.mnt, 'removed/old-1')));
    assert.deepEqual(readdirSync(h.data), ['conversations.json']);
    /* Let go of, closed, unmounted -- then given back from the new places, through the host program. */
    assert.deepEqual(r.said.filter((l) => !/^multipass (list|info)|^mountpoint/.test(l)), [
        'multipass umount clv-alpha:/resources/notes', 'multipass umount clv-alpha:/work',
        `umount ${join(h.data, 'views/notes')}`, `umount ${join(h.data, 'work/alpha')}`,
        'host view make notes', 'host vm mount clv-alpha view notes 998 997',
        'host work make alpha', 'host vm mount clv-alpha work alpha 998 997',
    ]);
    /* A machine that is not ours, and a mount from elsewhere, are not touched. */
    assert.ok(!r.said.some((l) => /primary|elsewhere/.test(l)));
    /* Run again (a second install): nothing to do. */
    const again = h.run();
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(again.said, r.said, 'nothing more asked of anyone');
});

test('a name on both sides refuses the whole move, before anything is let go of or moved', (t) => {
    const h = house(t);
    mkdirSync(join(h.mnt, 'resources/notes'));
    const r = h.run();
    assert.equal(r.code, 78);
    assert.match(r.err, /resources\/notes .*both exist/);
    assert.ok(existsSync(join(h.data, 'resources/notes/kept.txt')), 'nothing moved');
    assert.ok(!r.said.some((l) => /umount/.test(l)), 'no machine let go of anything');
});

test('a link in place of a directory of the data directory is never followed', (t) => {
    const h = house(t);
    rmSync(join(h.data, 'removed'), { recursive: true });
    spawnSync('ln', ['-s', '/etc', join(h.data, 'removed')]);
    const r = h.run();
    assert.equal(r.code, 78);
    assert.match(r.err, /removed is a link/);
    assert.ok(existsSync(join(h.data, 'resources/notes/kept.txt')));
});
