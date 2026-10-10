import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vault } from '../server/vault.mjs';
import { Secrets, isSecretName, RUNNER_SCRIPT, RUNNER, SECRETS_DIR } from '../server/secrets.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-sec-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const vms = new Vms(async (argv, options) => { calls.push({ argv: argv.join(' '), input: options?.input }); return { code: 0, stdout: '', stderr: '' }; }, ['vmm']);
    const secrets = new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms });
    return { dir, calls, secrets };
}

test('at rest a value is sealed: the data file shows the name and not the value; the key file is private', (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'MODEL_KEY', value: 'sk-very-secret-value' });
    const onDisk = readFileSync(join(b.dir, 'secrets.json'), 'utf8');
    assert.ok(onDisk.includes('MODEL_KEY'));
    assert.ok(!onDisk.includes('sk-very-secret-value'));
    assert.equal(statSync(join(b.dir, 'vault.key')).mode & 0o777, 0o600);
    assert.deepEqual(b.secrets.list().map((s) => Object.keys(s).sort()), [['conversations', 'createdAt', 'name']], 'a listing never carries a value');
});

test('a sealed value opens only with its key, and not if a single byte was changed', (t) => {
    const b = bench(t);
    const vault = new Vault(join(b.dir, 'vault.key'));
    const sealed = vault.seal('hello');
    assert.equal(vault.open(sealed), 'hello');
    assert.notEqual(vault.seal('hello'), sealed, 'sealed twice, it differs');
    const raw = Buffer.from(sealed, 'base64'); raw[raw.length - 1] ^= 1;
    assert.throws(() => vault.open(raw.toString('base64')));
    writeFileSync(join(b.dir, 'other.key'), Buffer.alloc(32, 7));
    assert.throws(() => new Vault(join(b.dir, 'other.key')).open(sealed));
});

test('delivery: the value travels on standard input, never in an argument; only what is attached NOW is in the VM', async (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'MODEL_KEY', value: 'sk-very-secret-value' });
    b.secrets.set({ name: 'OTHER', value: 'not for this one' });
    b.secrets.attach('alpha', 'MODEL_KEY', true);
    await b.secrets.deliver('alpha');
    assert.deepEqual(b.calls.map((c) => c.argv), [
        `exec clv-alpha -- sudo -n install -m 0755 /dev/stdin ${RUNNER}`,
        `exec clv-alpha -- sudo -n install -d -m 0755 ${SECRETS_DIR}`,
        `exec clv-alpha -- sudo -n find ${SECRETS_DIR} -mindepth 1 -delete`,
        `exec clv-alpha -- sudo -n install -m 0600 -o ubuntu -g ubuntu /dev/stdin ${SECRETS_DIR}/MODEL_KEY`,
    ]);
    assert.equal(b.calls[3].input, 'sk-very-secret-value');
    assert.ok(!b.calls.some((c) => c.argv.includes('sk-very-secret-value') || c.argv.includes('not for this one')));
    /* Detached: the next delivery wipes the directory and writes nothing. */
    b.secrets.attach('alpha', 'MODEL_KEY', false);
    b.calls.length = 0;
    await b.secrets.deliver('alpha');
    assert.equal(b.calls.length, 3);
});

test('a secret is named like a variable, and cannot take the place of one the tool needs to start', (t) => {
    const b = bench(t);
    for (const good of ['A', 'MODEL_KEY', 'KEY2']) assert.equal(isSecretName(good), true, good);
    for (const bad of ['', 'lower', '2X', 'A-B', 'A B', 'PATH', 'LD_PRELOAD', 'HOME', '../X', 'A'.repeat(41), 5]) assert.equal(isSecretName(bad), false, String(bad));
    assert.throws(() => b.secrets.set({ name: 'PATH', value: 'x' }), /named like a variable/);
    assert.throws(() => b.secrets.set({ name: 'OK', value: '' }), /between 1 byte/);
    assert.throws(() => b.secrets.set({ name: 'OK', value: 'x'.repeat(9000) }), /between 1 byte/);
    assert.throws(() => b.secrets.attach('alpha', 'NOPE', true), /No such secret/);
});

test('replacing a value keeps where it is attached; archiving a conversation detaches it', (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'K', value: 'one' });
    b.secrets.attach('alpha', 'K', true); b.secrets.attach('beta', 'K', true);
    b.secrets.set({ name: 'K', value: 'two' });
    assert.deepEqual(b.secrets.list()[0].conversations.sort(), ['alpha', 'beta']);
    b.secrets.forget('alpha');
    assert.deepEqual([b.secrets.of('alpha'), b.secrets.of('beta')], [[], ['K']]);
});

test('the runner, for real: each delivered file becomes a variable of the tool, and no shell stays behind', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-run-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'MODEL_KEY'), 'sk-1');
    writeFileSync(join(dir, 'MULTI'), 'line one\nline two');
    const script = join(dir, 'run.sh');
    writeFileSync(script, RUNNER_SCRIPT.replaceAll(SECRETS_DIR, dir), { mode: 0o755 });
    const out = execFileSync(script, ['sh', '-c', 'echo "$MODEL_KEY|$MULTI|$0"; ps -o comm= -p $PPID'], { encoding: 'utf8' });
    assert.ok(out.startsWith('sk-1|line one\nline two|sh\n'), out);
    assert.ok(!/run\.sh/.test(out.split('\n').pop() ?? ''), 'the runner became the tool: it is not its parent');
});

test('the signature of a delivery changes when, and only when, a delivery would differ', (t) => {
    const b = bench(t);
    const empty = b.secrets.signature('alpha');
    b.secrets.set({ name: 'K', value: 'one' });
    assert.equal(b.secrets.signature('alpha'), empty, 'a secret that is not attached changes nothing');
    b.secrets.attach('alpha', 'K', true);
    const attached = b.secrets.signature('alpha');
    assert.notEqual(attached, empty);
    assert.equal(b.secrets.signature('alpha'), attached, 'asked twice, it is the same');
    b.secrets.set({ name: 'K', value: 'two' });
    assert.notEqual(b.secrets.signature('alpha'), attached, 'a new value is a new delivery');
    assert.ok(!b.secrets.signature('alpha').includes('two'), 'and the signature carries no value in clear');
});
