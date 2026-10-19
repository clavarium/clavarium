/* The acceptance run's own rules, without a browser: what it needs, where its
   report may go, and that its report shows text as text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, renderReport, MESSAGE } from '../acceptance/run.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ENV = { CLAVARIUM_ACCEPT_EMAIL: 'you@example.com', CLAVARIUM_ACCEPT_PASSWORD: 'x' };

test('acceptance: a real target over https, credentials from the environment', () => {
    assert.throws(() => parseArgs([], ENV), /--target/);
    assert.throws(() => parseArgs(['--target', 'http://clav.example.com'], ENV), /https/);
    assert.throws(() => parseArgs(['--target', 'https://clav.example.com'], {}), /CLAVARIUM_ACCEPT_EMAIL/);
    assert.throws(() => parseArgs(['--target', 'https://clav.example.com', '--nope'], ENV), /unknown argument/);
    const o = parseArgs(['--target', 'https://clav.example.com/some/where', '--dry'], ENV);
    assert.equal(o.target, 'https://clav.example.com');
    assert.equal(o.conversation, 'intranet-website');
    assert.equal(o.dry, true);
    assert.ok(o.report.startsWith(tmpdir()), 'the report goes under the temporary folder by default');
    assert.equal(parseArgs(['--target', 'https://clav.example.com', '--conversation', 'other'], ENV).conversation, 'other');
});

test('acceptance: its report is never written inside the repository', () => {
    for (const inside of [REPO, join(REPO, 'acceptance', 'out')]) {
        assert.throws(() => parseArgs(['--target', 'https://clav.example.com', '--report', inside], ENV), /never written inside the repository/);
    }
    assert.ok(parseArgs(['--target', 'https://clav.example.com', '--report', join(tmpdir(), 'acc')], ENV));
});

test('acceptance: the report says the verdict, and shows what it was told as text', () => {
    const base = { target: 'https://clav.example.com', started: 'a', ended: 'b', version: '1.0.0', dry: false };
    const pass = { name: 'One <b>check</b>', result: 'pass', detail: '<img src=x onerror=alert(1)>', shots: ['01-a.png'], ms: 1200 };
    const html = renderReport({ ...base, checks: [pass] });
    assert.match(html, /class="v PASSED"/);
    assert.ok(!html.includes('<b>check</b>') && !html.includes('<img src=x'), 'never markup from a check');
    assert.match(html, /<img src="01-a.png"/);
    assert.match(renderReport({ ...base, checks: [pass, { ...pass, result: 'fail' }] }), /class="v FAILED"/);
    assert.match(renderReport({ ...base, checks: [] }), /class="v FAILED"/, 'nothing checked is not a pass');
    assert.match(MESSAGE, /^\[Clavarium acceptance test\]/);
    assert.match(MESSAGE, /Do not change any file/);
});
