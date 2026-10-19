/* The owner's page sits behind the sign-in: the browser asks for its manifest
   WITHOUT the sign-in cookie unless told otherwise, gets the sign-in page,
   and installs a nameless shortcut instead of the app (seen on a real
   deployment by the acceptance run). The device's page is public: no need. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the owner page asks for its manifest with its credentials', () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const link = /<link rel="manifest"[^>]*>/.exec(html)?.[0] ?? '';
    assert.match(link, /crossorigin="use-credentials"/);
});
