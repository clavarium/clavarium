/* What the page loads from elsewhere is kept here: pinned, with its licence,
   served by this server, and no address of another site in the page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FILES } from '../server/main.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('the review draws its diff with diff2html, pinned and vendored with its licence', () => {
    const licence = read('web/vendor/diff2html/LICENSE');
    assert.match(licence, /^diff2html 3\.4\.56 /);
    assert.match(licence, /== diff2html: MIT ==/);
    assert.match(licence, /== highlight\.js: BSD-3-Clause ==/);
    for (const [path, file] of [['/vendor/diff2html.js', 'web/vendor/diff2html/diff2html-ui-slim.min.js'], ['/vendor/diff2html.css', 'web/vendor/diff2html/diff2html.min.css'], ['/gitgraph.js', 'web/gitgraph.js']]) {
        assert.equal(FILES[path]?.[0], file, path);
        assert.ok(existsSync(new URL(file, root)), file);
    }
});

test('the page loads nothing from another site', () => {
    const html = read('web/index.html');
    for (const [, src] of html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)) assert.doesNotMatch(src, /^(https?:)?\/\//, src);
});
