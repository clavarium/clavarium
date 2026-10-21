/* A flow with its files (server/bundle.mjs): packed, checked, unpacked; never a link, never out of place. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, createReadStream, createWriteStream, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Bundles } from '../server/bundle.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-bundle-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const folders = join(dir, 'resources'); mkdirSync(folders);
    const b = new Bundles({ dir: join(dir, 'imports'), folder: (name) => join(folders, name) });
    mkdirSync(join(dir, 'imports'));
    return { dir, folders, b };
}

test('packed: the setup and the folders\' files; a link a tool made is left out; unpacked into an empty folder only', async (t) => {
    const { dir, folders, b } = bench(t);
    mkdirSync(join(folders, 'notes', 'deep'), { recursive: true });
    writeFileSync(join(folders, 'notes', 'a.txt'), 'hello');
    writeFileSync(join(folders, 'notes', 'deep', 'b.txt'), 'world!');
    symlinkSync('/etc/passwd', join(folders, 'notes', 'evil'));
    mkdirSync(join(folders, 'notes2')); writeFileSync(join(folders, 'notes2', 'c.txt'), 'x');
    assert.deepEqual(b.folderStats(['notes', 'notes2', '../x']), [{ name: 'notes', files: 2, bytes: 11 }, { name: 'notes2', files: 1, bytes: 1 }]);
    const out = join(dir, 'out.tar.gz');
    await b.pack('{"clavarium":"flow"}\n', ['notes', 'notes2'], createWriteStream(out));
    const listed = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(listed, ['flow.json', 'folders/notes/', 'folders/notes/a.txt', 'folders/notes/deep/', 'folders/notes/deep/b.txt', 'folders/notes2/', 'folders/notes2/c.txt']);
    const { id } = await b.receive(createReadStream(out));
    const opened = b.open(id);
    assert.equal(opened.text, '{"clavarium":"flow"}\n');
    assert.deepEqual(opened.folders, [{ name: 'notes', files: 2, bytes: 11 }, { name: 'notes2', files: 1, bytes: 1 }]);
    const target = join(dir, 'new-notes'); mkdirSync(target);
    assert.equal(b.fill(id, 'notes', target), 2);
    assert.equal(readFileSync(join(target, 'deep', 'b.txt'), 'utf8'), 'world!');
    assert.equal(existsSync(join(target, 'evil')), false);
    assert.throws(() => b.fill(id, 'notes', target), /not empty/);
    b.forget(id);
    assert.throws(() => b.open(id), /no longer here/);
});

test('refused whole: a link, a path out of place, something else, no flow.json; an id not ours', async (t) => {
    const { dir, b } = bench(t);
    const make = (name, build) => { const root = join(dir, name); mkdirSync(root, { recursive: true }); build(root); const out = join(dir, `${name}.tar.gz`); spawnSync('tar', ['-czf', out, '-C', root, ...readdirSync(root)], {}); return out; };
    const cases = [
        [make('link', (r) => { writeFileSync(join(r, 'flow.json'), '{}'); mkdirSync(join(r, 'folders', 'a'), { recursive: true }); symlinkSync('/etc', join(r, 'folders', 'a', 'x')); }), /not a plain file or folder/],
        [make('stray', (r) => { writeFileSync(join(r, 'flow.json'), '{}'); writeFileSync(join(r, 'run.sh'), 'x'); }), /out of place/],
        [make('noflow', (r) => { mkdirSync(join(r, 'folders', 'a'), { recursive: true }); }), /no flow\.json|out of place/],
    ];
    for (const [file, why] of cases) {
        const { id } = await b.receive(createReadStream(file));
        assert.throws(() => b.open(id), why, file);
    }
    const dots = join(dir, 'dots.tar.gz');
    mkdirSync(join(dir, 'd', 'folders', 'a'), { recursive: true }); writeFileSync(join(dir, 'd', 'flow.json'), '{}'); writeFileSync(join(dir, 'd', 'folders', 'a', 'f'), 'x');
    spawnSync('tar', ['-czf', dots, '-C', join(dir, 'd'), '--transform=s,^folders/a/f,folders/a/../../escape,', 'flow.json', 'folders/a/f'], {});
    const { id } = await b.receive(createReadStream(dots));
    assert.throws(() => b.open(id), /out of place/);
    assert.throws(() => b.open('../../etc'), /Not a file sent here/);
    assert.ok(readdirSync(join(dir, 'imports')).length > 0);
});
