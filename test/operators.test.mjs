/* Who may sign in: the operators of the identity file, changed as root by deploy/operators.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operators, parse, format } from '../deploy/operators.mjs';

const HEAD = `# Who may sign in to Clavarium on THIS machine. Written by install.sh.
issuer: https://clav.example.com/dex
enablePasswordDB: true
staticPasswords:
`;
const entry = (email, hash) => `  - email: "${email}"\n    hash: "${hash}"\n    username: "${email.split('@')[0]}"\n    userID: "00000000-0000-4000-8000-000000000000"\n`;
function bench(t, { restartOk = () => true, journal = '' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-ops-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = join(dir, 'config.yaml'); const disabled = join(dir, 'disabled.json');
    writeFileSync(config, HEAD + entry('owner@example.com', '$2a$14$owner'));
    let restarts = 0;
    const ops = operators({ config, disabled, hash: (p) => { if (String(p).length < 12) throw new Error('short'); return `$2a$14$h-${p}`; }, restart: () => { restarts += 1; return restartOk(); }, journal: () => journal });
    return { ops, config, disabled, restarts: () => restarts, text: () => readFileSync(config, 'utf8') };
}

test('the identity file is read and written in the one form install.sh writes; nothing else of it changes', () => {
    const text = HEAD + entry('a@example.com', 'h1') + entry('b@example.com', 'h2');
    assert.equal(format(parse(text)), text);
    assert.deepEqual(parse(text).entries.map((x) => x.email), ['a@example.com', 'b@example.com']);
    assert.throws(() => parse(`${HEAD}  - email: "a@example.com"\n    hash: weird\n`), /not in the form/);
    assert.throws(() => parse('issuer: x\n'), /no list of operators/);
});

test('added, its password changed, disabled and enabled again with the same password, removed; the last one never goes', (t) => {
    const b = bench(t);
    b.ops.add('second@example.com', 'a-long-password-1');
    assert.deepEqual(b.ops.list(), [{ email: 'owner@example.com', enabled: true }, { email: 'second@example.com', enabled: true }]);
    assert.ok(b.text().includes('hash: "$2a$14$h-a-long-password-1"'));
    assert.ok(b.text().startsWith(HEAD), 'the rest of the file as it was');
    assert.throws(() => b.ops.add('second@example.com', 'another-long-pass'), /operator already/);
    b.ops.password('second@example.com', 'a-new-password-22');
    assert.ok(b.text().includes('$2a$14$h-a-new-password-22'));
    b.ops.disable('second@example.com');
    assert.deepEqual(b.ops.list(), [{ email: 'owner@example.com', enabled: true }, { email: 'second@example.com', enabled: false }]);
    assert.ok(!b.text().includes('second@example.com'), 'out of the identity file: it cannot sign in');
    b.ops.enable('second@example.com');
    assert.ok(b.text().includes('$2a$14$h-a-new-password-22'), 'back with its password');
    b.ops.disable('owner@example.com');
    assert.throws(() => b.ops.disable('second@example.com'), /last operator/, 'nobody could sign in any more');
    b.ops.enable('owner@example.com');
    b.ops.remove('second@example.com');
    assert.throws(() => b.ops.remove('owner@example.com'), /last operator cannot be removed/);
    assert.throws(() => b.ops.add('not an address', 'a-long-password-1'), /not an e-mail/);
    assert.throws(() => b.ops.add('third@example.com', 'short'), /short/);
    assert.ok(b.restarts() >= 5, 'Dex restarted after each change');
});

test('a change Dex does not start with is undone; failed sign-ins are counted from its log', (t) => {
    let ok = true;
    const b = bench(t, { restartOk: () => ok, journal: 'level=ERROR msg="failed login attempt: Invalid credentials." user=owner@example.com request_id=1\nlevel=ERROR msg="failed login attempt: Invalid credentials." user=Owner@Example.com request_id=2\nlevel=INFO msg="login successful" user=x@example.com\n' });
    const before = b.text();
    ok = false;
    assert.throws(() => b.ops.add('second@example.com', 'a-long-password-1'), /did not start with the change/);
    assert.equal(b.text(), before, 'the file as it was');
    assert.deepEqual(b.ops.failures(15), { 'owner@example.com': 2 });
});
