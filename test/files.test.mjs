import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { list, download, importFile, inside, isFileName } from '../server/files.mjs';

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
    await assert.rejects(importFile(root, 'link-to-parent', 'evil.txt', body('x')), /leaves the folder/);
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
