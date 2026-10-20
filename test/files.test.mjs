import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { list, download, importFile, inside, isFileName, make, renameIn, move, remove, readText, saveText, picture, taken, walk, changeRoute, EDIT_MAX, THUMB_MAX, DEPTH_MAX, BATCH_FILES } from '../server/files.mjs';
import { existsSync, statSync, utimesSync } from 'node:fs';

function folder(t) {
    const base = mkdtempSync(join(tmpdir(), 'clv-files-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'reports');
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(base, 'secret.txt'), 'host secret');
    writeFileSync(join(root, 'q3.txt'), 'q3 is fine');
    writeFileSync(join(root, 'out', 'chart.png'), 'PNG');
    writeFileSync(join(root, '.hidden'), 'x');
    /* What a hostile agent would leave behind. */
    symlinkSync(join(base, 'secret.txt'), join(root, 'link-to-secret'));
    symlinkSync(base, join(root, 'link-to-parent'));
    return { base, root };
}
const body = (text, headers = {}) => Object.assign(Readable.from([Buffer.from(text)]), { headers });
const text = async (stream) => { let s = ''; for await (const c of stream) s += c; return s; };

test('a listing shows folders then files, and never a hidden file or a symbolic link', async (t) => {
    const { root } = folder(t);
    const top = await list(root, '');
    assert.deepEqual(top.entries.map((e) => [e.name, e.folder, e.size]), [['out', true, 0], ['q3.txt', false, 10]]);
    assert.deepEqual((await list(root, 'out')).entries.map((e) => e.name), ['chart.png']);
    assert.equal((await list(root, 'out/../out')).path, 'out', 'the path is given back clean');
});

test('no path leaves the folder: not by "..", not by a link, not by an absolute path', async (t) => {
    const { root } = folder(t);
    for (const bad of ['..', '../secret.txt', 'out/../../secret.txt', 'link-to-parent', 'link-to-parent/secret.txt']) {
        await assert.rejects(inside(root, bad), /leaves the folder/, bad);
    }
    await assert.rejects(download(root, 'link-to-secret'), /leaves the folder/);
    await assert.rejects(list(root, 'nope'), /No such/);
    await assert.rejects(list(root, 'q3.txt'), /Not a folder/);
});

test('a download is one regular file; a folder or a link is not', async (t) => {
    const { root } = folder(t);
    const file = await download(root, 'out/chart.png');
    assert.deepEqual([file.name, file.size, await text(file.stream)], ['chart.png', 3, 'PNG']);
    await assert.rejects(download(root, 'out'), /Not a file/);
    /* A link INSIDE the folder to a file inside it is still a link: refused. */
    symlinkSync(join(root, 'q3.txt'), join(root, 'alias.txt'));
    await assert.rejects(download(root, 'alias.txt'), /Not a file/);
});

test('an import lands under its own name, never over an existing file, and leaves no partial file', async (t) => {
    const { root } = folder(t);
    assert.deepEqual(await importFile(root, 'out', 'photo.jpg', body('JPEG')), { name: 'photo.jpg', size: 4 });
    assert.deepEqual(await importFile(root, 'out', 'photo.jpg', body('SECOND')), { name: 'photo (2).jpg', size: 6 });
    assert.equal(readFileSync(join(root, 'out', 'photo.jpg'), 'utf8'), 'JPEG');
    assert.deepEqual(readdirSync(join(root, 'out')).sort(), ['chart.png', 'photo (2).jpg', 'photo.jpg']);
});

test('an import is refused for a bad name, a path outside, or a declared size over the limit', async (t) => {
    const { root } = folder(t);
    for (const bad of ['', '.env', 'a/b.txt', '..', 'x\ny', 'a'.repeat(121)]) assert.equal(isFileName(bad), false, JSON.stringify(bad));
    assert.equal(isFileName('Report final (v2).pdf'), true);
    await assert.rejects(importFile(root, '', '../evil.txt', body('x')), /file name/);
    await assert.rejects(importFile(root, 'link-to-parent', 'evil.txt', body('x')), /through a link/);
    await assert.rejects(importFile(root, '', 'big.bin', body('x', { 'content-length': String(51 * 1024 * 1024) })), /at most 50 MB/);
    assert.deepEqual(readdirSync(root).filter((n) => n.includes('importing') || n === 'evil.txt'), []);
});

test('a page written by a tool is answered with rules of its own: nobody, no network, only inside this site', async (t) => {
    const { page, PAGE_HEADERS, PAGE_MAX } = await import('../server/files.mjs');
    const csp = PAGE_HEADERS['content-security-policy'];
    assert.match(csp, /^sandbox allow-scripts;/, 'a sandbox, and not the same origin');
    assert.ok(!csp.includes('allow-same-origin') && !csp.includes('allow-top-navigation') && !csp.includes('allow-forms') && !csp.includes('allow-popups'));
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/https?:|\*/.test(csp), 'nothing from anywhere');
    assert.match(csp, /form-action 'none'/); assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(PAGE_HEADERS['x-content-type-options'], 'nosniff');
    const b = folder(t);
    writeFileSync(join(b.root, 'report.html'), '<h1>done</h1>');
    writeFileSync(join(b.root, 'notes.txt'), 'x');
    const file = await page(b.root, 'report.html');
    assert.equal(file.name, 'report.html');
    let text = ''; for await (const piece of file.stream) text += piece;
    assert.equal(text, '<h1>done</h1>');
    await assert.rejects(page(b.root, 'notes.txt'), /Only an HTML file/);
    await assert.rejects(page(b.root, '../outside.html'), /leaves the folder|No such/);
    writeFileSync(join(b.root, 'huge.html'), Buffer.alloc(PAGE_MAX + 1, 32));
    await assert.rejects(page(b.root, 'huge.html'), /too large/);
});

/* ---------- changes made by hand ---------- */

test('every change walks its path name by name: no "..", no hidden name, no link anywhere on the way', async (t) => {
    const { base, root } = folder(t);
    mkdirSync(join(base, 'outside')); writeFileSync(join(base, 'outside', 'x.txt'), 'outside');
    symlinkSync(join(base, 'outside'), join(root, 'out', 'way-out'));
    const tries = [
        () => make(root, '..', 'evil.txt', false), () => make(root, 'link-to-parent', 'evil.txt', false), () => make(root, 'out/way-out', 'evil.txt', true),
        () => renameIn(root, 'link-to-secret', 'renamed'), () => renameIn(root, '../secret.txt', 'x'), () => renameIn(root, 'out/way-out/x.txt', 'y.txt'),
        () => move(root, 'q3.txt', 'link-to-parent'), () => move(root, 'q3.txt', '..'), () => move(root, 'out/way-out/x.txt', ''),
        () => remove(root, 'link-to-parent/secret.txt'), () => remove(root, '..'), () => remove(root, 'out/way-out'), () => remove(root, '.hidden'),
        () => readText(root, 'link-to-secret'), () => readText(root, 'out/way-out/x.txt'), () => readText(root, '/etc/passwd'),
        () => saveText(root, 'link-to-secret', body('x'), { version: 'any' }), () => saveText(root, 'out/way-out/x.txt', body('x'), { version: 'any' }),
        () => picture(root, 'link-to-parent/a.png'), () => importFile(root, '', 'a.txt', body('x'), { dir: 'out/way-out' }),
        () => importFile(root, 'out/way-out', 'a.txt', body('x')), () => importFile(root, '', 'a.txt', body('x'), { dir: '../up' }),
    ];
    for (const [i, attempt] of tries.entries()) await assert.rejects(attempt(), (e) => e.status === 403 || e.status === 400, `attempt ${i}`);
    assert.equal(readFileSync(join(base, 'secret.txt'), 'utf8'), 'host secret');
    assert.equal(readFileSync(join(base, 'outside', 'x.txt'), 'utf8'), 'outside');
    assert.deepEqual(readdirSync(join(base, 'outside')), ['x.txt']);
    assert.ok(existsSync(join(root, 'link-to-parent')) && existsSync(join(root, '.hidden')));
    /* The folder itself is never renamed, moved or removed. */
    await assert.rejects(remove(root, ''), /folder itself/);
    await assert.rejects(renameIn(root, '', 'x'), /folder itself/);
    assert.equal((await walk(root, 'out/chart.png')).info.size, 3);
});

test('make, rename, move, remove: each where asked, never over something else, never a folder into itself', async (t) => {
    const { root } = folder(t);
    assert.deepEqual(await make(root, 'out', 'notes.md', false), { name: 'notes.md', folder: false });
    assert.equal(readFileSync(join(root, 'out', 'notes.md'), 'utf8'), '');
    await make(root, '', 'drafts', true);
    await assert.rejects(make(root, '', 'drafts', false), (e) => e.status === 409);
    await assert.rejects(make(root, '', '.env', false), /name/);
    await assert.rejects(make(root, '', 'a/b', true), /name/);
    assert.deepEqual(await renameIn(root, 'q3.txt', 'q3 final.txt'), { name: 'q3 final.txt' });
    await assert.rejects(renameIn(root, 'q3 final.txt', 'out'), (e) => e.status === 409);
    await assert.rejects(renameIn(root, 'q3 final.txt', '.bashrc'), /name/);
    assert.deepEqual(await move(root, 'q3 final.txt', 'out'), { name: 'q3 final.txt', to: 'out' });
    assert.equal(readFileSync(join(root, 'out', 'q3 final.txt'), 'utf8'), 'q3 is fine');
    await assert.rejects(move(root, 'out', 'out'), /into itself/);
    await make(root, 'out', 'deep', true);
    await assert.rejects(move(root, 'out', 'out/deep'), /into itself/);
    await assert.rejects(move(root, 'out/deep', 'out'), /already in that folder/);
    writeFileSync(join(root, 'drafts', 'chart.png'), 'other');
    await assert.rejects(move(root, 'drafts/chart.png', 'out'), (e) => e.status === 409);
    assert.equal(readFileSync(join(root, 'out', 'chart.png'), 'utf8'), 'PNG');
    await move(root, 'out/deep', '');
    /* A folder is removed with what it holds; a link inside is removed as a link, its target untouched. */
    symlinkSync(join(root, '..', 'secret.txt'), join(root, 'drafts', 'link'));
    await remove(root, 'drafts');
    assert.equal(existsSync(join(root, 'drafts')), false);
    assert.equal(readFileSync(join(root, '..', 'secret.txt'), 'utf8'), 'host secret');
    await remove(root, 'out/notes.md');
    assert.deepEqual(readdirSync(join(root, 'out')).sort(), ['chart.png', 'q3 final.txt']);
});

test('a text is edited at the version it was read: written meanwhile, it is not overwritten unless asked; a copy is offered', async (t) => {
    const { root } = folder(t);
    const read = await readText(root, 'q3.txt');
    assert.equal(read.text, 'q3 is fine');
    const saved = await saveText(root, 'q3.txt', body('q3 is great\n'), { version: read.version });
    assert.equal(readFileSync(join(root, 'q3.txt'), 'utf8'), 'q3 is great\n');
    assert.notEqual(saved.version, read.version);
    /* The agent writes it meanwhile: same size, other content, other time. */
    writeFileSync(join(root, 'q3.txt'), 'agent wrote!\n');
    utimesSync(join(root, 'q3.txt'), new Date(), new Date(Date.now() + 5000));
    await assert.rejects(saveText(root, 'q3.txt', body('mine\n'), { version: saved.version }), (e) => e.status === 409 && e.kind === 'changed');
    assert.equal(readFileSync(join(root, 'q3.txt'), 'utf8'), 'agent wrote!\n', 'what the agent wrote is still there');
    const copy = await saveText(root, 'q3.txt', body('mine\n'), { version: saved.version, copy: true });
    assert.equal(copy.name, 'q3 (2).txt');
    assert.equal(readFileSync(join(root, 'q3 (2).txt'), 'utf8'), 'mine\n');
    await saveText(root, 'q3.txt', body('mine anyway\n'), { version: 'any' });
    assert.equal(readFileSync(join(root, 'q3.txt'), 'utf8'), 'mine anyway\n');
    /* No version at all is not "any". */
    await assert.rejects(saveText(root, 'q3.txt', body('x'), {}), (e) => e.kind === 'changed');
    assert.deepEqual(readdirSync(root).filter((n) => n.includes('saving')), [], 'no partial file left');
});

test('only text is edited, and only up to its limit; a binary or an oversized text is refused both ways', async (t) => {
    const { root } = folder(t);
    writeFileSync(join(root, 'data.bin'), Buffer.from([0x50, 0x00, 0x01]));
    writeFileSync(join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(EDIT_MAX + 1));
    await assert.rejects(readText(root, 'data.bin'), (e) => e.status === 415);
    await assert.rejects(readText(root, 'latin.txt'), (e) => e.status === 415);
    await assert.rejects(readText(root, 'big.txt'), (e) => e.status === 413);
    await assert.rejects(readText(root, 'out'), /Not a file/);
    const v = (await readText(root, 'q3.txt')).version;
    await assert.rejects(saveText(root, 'q3.txt', body('a\u0000b'), { version: v }), (e) => e.status === 415);
    await assert.rejects(saveText(root, 'q3.txt', Readable.from([Buffer.alloc(EDIT_MAX + 1, 0x61)]), { version: v }), (e) => e.status === 413);
    assert.equal(readFileSync(join(root, 'q3.txt'), 'utf8'), 'q3 is fine');
});

test('a thumbnail is a picture its first bytes prove, never SVG, never too large', async (t) => {
    const { root } = folder(t);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYQQwAHhYCAPmBfFgAAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(root, 'red.png'), png);
    writeFileSync(join(root, 'named.jpg'), png);
    writeFileSync(join(root, 'fake.png'), '<html><script>alert(1)</script>');
    writeFileSync(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    writeFileSync(join(root, 'huge.png'), Buffer.concat([png, Buffer.alloc(THUMB_MAX)]));
    assert.equal((await picture(root, 'red.png')).type, 'image/png');
    assert.equal((await picture(root, 'named.jpg')).type, 'image/png', 'what it is, not what it is called');
    await assert.rejects(picture(root, 'fake.png'), (e) => e.status === 415);
    await assert.rejects(picture(root, 'logo.svg'), (e) => e.status === 415);
    await assert.rejects(picture(root, 'huge.png'), (e) => e.status === 413);
});

test('a drop: subfolders made, a taken name kept beside, replaced or skipped as asked, and bounded as a whole', async (t) => {
    const { root } = folder(t);
    const one = await importFile(root, '', 'a.txt', body('A'), { dir: 'trip/day 1' });
    assert.deepEqual(one, { name: 'a.txt', size: 1 });
    assert.equal(readFileSync(join(root, 'trip', 'day 1', 'a.txt'), 'utf8'), 'A');
    assert.deepEqual((await taken(root, '', ['trip/day 1/a.txt', 'trip/day 1/b.txt', 'q3.txt/x.txt', 'out'])).taken,
        [{ name: 'trip/day 1/a.txt', as: 'file' }, { name: 'q3.txt/x.txt', as: 'blocked' }, { name: 'out', as: 'folder' }]);
    assert.equal((await importFile(root, '', 'a.txt', body('B'), { dir: 'trip/day 1', exists: 'keep' })).name, 'a (2).txt');
    assert.deepEqual(await importFile(root, '', 'a.txt', body('C'), { dir: 'trip/day 1', exists: 'replace' }), { name: 'a.txt', size: 1, replaced: true });
    assert.equal(readFileSync(join(root, 'trip', 'day 1', 'a.txt'), 'utf8'), 'C');
    assert.equal((await importFile(root, '', 'a.txt', body('D'), { dir: 'trip/day 1', exists: 'skip' })).skipped, true);
    assert.equal(readFileSync(join(root, 'trip', 'day 1', 'a.txt'), 'utf8'), 'C');
    await assert.rejects(importFile(root, '', 'out', body('x'), { exists: 'replace' }), (e) => e.status === 409, 'a folder is never replaced by a file');
    await assert.rejects(importFile(root, '', 'x.txt', body('x'), { dir: 'q3.txt' }), (e) => e.status === 409);
    await assert.rejects(importFile(root, '', 'x.txt', body('x'), { dir: Array(DEPTH_MAX + 1).fill('d').join('/') }), (e) => e.status === 413);
    await assert.rejects(importFile(root, '', 'x.txt', body('x'), { dir: 'a/.git' }), /name/);
    await assert.rejects(importFile(root, '', 'x.txt', body('x'), { exists: 'overwrite' }), (e) => e.status === 400);
    /* One drop: so many files at most. */
    const batch = 'drop-0123456789';
    for (let i = 0; i < BATCH_FILES; i++) await importFile(root, 'out', `f${i}.txt`, body(''), { batch, exists: 'keep' }).catch(() => {});
    await assert.rejects(importFile(root, 'out', 'one-more.txt', body('x'), { batch }), (e) => e.status === 413);
    await assert.rejects(importFile(root, 'out', 'one-more.txt', body('x'), { batch: '../x' }), (e) => e.status === 400);
    assert.equal(existsSync(join(root, 'out', 'one-more.txt')), false);
    assert.deepEqual(readdirSync(join(root, 'out')).filter((n) => n.startsWith('.')), [], 'no partial file left');
});

test('a picture the person attached in a chat has its thumbnail, by that one shape in the hidden bridge folder; nothing else hidden, and never through a link', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'clv-attached-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const id = '0f350d03-5980-4933-909f-7e60ba9e727a';
    mkdirSync(join(root, '.parley', 'files', id), { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    writeFileSync(join(root, '.parley', 'files', id, 'shot.png'), png);
    writeFileSync(join(root, '.parley', 'to-agent.jsonl'), '{}');
    const thumb = (p) => changeRoute('GET', '/files/thumb', new URLSearchParams({ p }), {}, () => root);
    const got = await thumb(`.parley/files/${id}/shot.png`);
    assert.equal(got.picture.type, 'image/png');
    await assert.rejects(thumb('.parley/to-agent.jsonl'), /hidden/);
    await assert.rejects(thumb(`.parley/files/${id}/../../to-agent.jsonl`), /hidden|leaves/);
    await assert.rejects(thumb('.parley/files/not-an-id/shot.png'), /hidden/);
    /* Its bridge folder made a link elsewhere: refused. */
    const other = mkdtempSync(join(tmpdir(), 'clv-elsewhere-'));
    t.after(() => rmSync(other, { recursive: true, force: true }));
    mkdirSync(join(other, 'files', id), { recursive: true });
    writeFileSync(join(other, 'files', id, 'shot.png'), png);
    rmSync(join(root, '.parley'), { recursive: true, force: true });
    symlinkSync(other, join(root, '.parley'));
    await assert.rejects(thumb(`.parley/files/${id}/shot.png`), /No such file/);
});
