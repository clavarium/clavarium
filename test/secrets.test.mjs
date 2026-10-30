import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Vault } from '../server/vault.mjs';
import { Secrets, isSecretName, expiryOf, daysTo, RUNNER_SCRIPT, RUNNER, SECRETS_DIR, EPHEMERAL_PREFIX, TTL_MAX_MS } from '../server/secrets.mjs';
import { Grants } from '../server/grants.mjs';
import { Readable } from 'node:stream';
import { handleApi } from '../server/api.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';

function bench(t, { now } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-sec-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const vms = new Vms(async (argv, options) => { calls.push({ argv: argv.slice(1).join(' '), input: options?.input }); return { code: 0, stdout: '', stderr: '' }; }, ['vmm']);
    const clock = { at: now ?? new Date(2026, 9, 24, 12, 0) };
    const make = () => new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms, grants: clock.grants ??= new Grants(), now: () => clock.at });
    return { dir, calls, secrets: make(), clock, make };
}

test('at rest a value is sealed: the data file shows the name and not the value; the key file is private', (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'MODEL_KEY', value: 'sk-very-secret-value' });
    const onDisk = readFileSync(join(b.dir, 'secrets.json'), 'utf8');
    assert.ok(onDisk.includes('MODEL_KEY'));
    assert.ok(!onDisk.includes('sk-very-secret-value'));
    assert.equal(statSync(join(b.dir, 'vault.key')).mode & 0o777, 0o600);
    assert.deepEqual(b.secrets.list().map((s) => Object.keys(s).sort()), [['conversations', 'createdAt', 'days', 'expired', 'expires', 'name']], 'a listing never carries a value');
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

test('a host-only secret is held by the server: it cannot be attached, never reaches a machine, yet is revealed host-side', async (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'MAIL_TOKEN', value: 'refresh-token-value', hostOnly: true });
    b.secrets.set({ name: 'PLAIN', value: 'ordinary' });
    /* It cannot be handed to a conversation: the guarantee is structural, not a matter of no one attaching it. */
    assert.throws(() => b.secrets.attach('alpha', 'MAIL_TOKEN', true), /held by the server/);
    /* Even so, it never reaches a VM: not in the delivery set, not in a delivered file. */
    b.secrets.attach('alpha', 'PLAIN', true);
    await b.secrets.deliver('alpha');
    assert.ok(!b.calls.some((c) => c.argv.includes('MAIL_TOKEN') || c.input === 'refresh-token-value'), 'never delivered');
    assert.deepEqual(b.secrets.given('alpha'), ['PLAIN'], 'not in what a machine is given');
    assert.deepEqual(b.secrets.of('alpha'), ['PLAIN'], 'not among a conversation Assets');
    /* The server uses it on the agent behalf: revealed by name, host-side, like any secret. */
    assert.equal(b.secrets.reveal('MAIL_TOKEN'), 'refresh-token-value');
    /* The ordinary listing leaves it out entirely (never a giveable secret on the page);
       `held` reveals it for a management view, marked host-only. */
    assert.equal(b.secrets.list().find((s) => s.name === 'MAIL_TOKEN'), undefined, 'not in the page listing');
    assert.equal(b.secrets.list().find((s) => s.name === 'PLAIN').hostOnly, undefined);
    assert.equal(b.secrets.list({ held: true }).find((s) => s.name === 'MAIL_TOKEN').hostOnly, true);
    /* Detaching (take) is always allowed; it is attaching that is refused. */
    assert.doesNotThrow(() => b.secrets.attach('alpha', 'MAIL_TOKEN', false));
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

test('renamed: its value (still sealed) and the conversations it is handed to go with it; what else names it is told', (t) => {
    const { secrets } = bench(t);
    secrets.set({ name: 'OLD_KEY', value: 'v1' });
    secrets.attach('alpha', 'OLD_KEY', true);
    const told = [];
    secrets.renamed = (from, to) => told.push(`${from}>${to}`);
    assert.deepEqual(secrets.rename('OLD_KEY', 'NEW_KEY'), { name: 'NEW_KEY' });
    assert.deepEqual(secrets.list().map((s) => [s.name, s.conversations]), [['NEW_KEY', ['alpha']]]);
    assert.equal(secrets.reveal('NEW_KEY'), 'v1');
    assert.equal(secrets.reveal('OLD_KEY'), undefined);
    assert.deepEqual(secrets.of('alpha'), ['NEW_KEY']);
    assert.deepEqual(told, ['OLD_KEY>NEW_KEY']);
    secrets.set({ name: 'TAKEN', value: 'x' });
    assert.throws(() => secrets.rename('NEW_KEY', 'TAKEN'), /already named TAKEN/);
    assert.throws(() => secrets.rename('NEW_KEY', 'bad name'), /named like a variable/);
    assert.throws(() => secrets.rename('NOPE', 'OTHER'), /No such secret/);
});

test('an expiry is a day, YYYY-MM-DD, optional; kept, changed, removed; past days are allowed and mean expired at once', (t) => {
    const b = bench(t);
    for (const bad of ['2026-13-01', '2026-02-30', '26-11-01', '2026-11-1', 'tomorrow', '2026-11-01T00:00', 20261101]) assert.throws(() => b.secrets.set({ name: 'K', value: 'v', expires: bad }), /YYYY-MM-DD/, String(bad));
    assert.equal(expiryOf(''), null); assert.equal(expiryOf(undefined), null); assert.equal(expiryOf('2026-02-28'), '2026-02-28');
    b.secrets.set({ name: 'K', value: 'v', expires: '2026-10-27' });
    assert.deepEqual(b.secrets.list().map(({ expires, days, expired }) => ({ expires, days, expired })), [{ expires: '2026-10-27', days: 3, expired: false }]);
    b.secrets.set({ name: 'K', value: 'w' });
    assert.equal(b.secrets.list()[0].expires, '2026-10-27', 'a new value without an expiry keeps the one it had');
    b.secrets.set({ name: 'K', value: 'w', expires: '' });
    assert.deepEqual([b.secrets.list()[0].expires, b.secrets.list()[0].days, b.secrets.list()[0].expired], [null, null, false]);
    b.secrets.set({ name: 'OLD', value: 'v', expires: '2020-01-01' });
    assert.equal(b.secrets.list().find((s) => s.name === 'OLD').expired, true);
    assert.equal(daysTo('2026-10-24', new Date(2026, 9, 24, 23, 59)), 0, 'its own day: expired');
    assert.equal(daysTo('2026-10-25', new Date(2026, 9, 24, 0, 1)), 1);
    assert.equal(JSON.parse(readFileSync(join(b.dir, 'secrets.json'), 'utf8')).find((s) => s.name === 'K').expires, undefined, 'removed from the file too');
});

test('expired: kept, still handed, but no longer delivered nor named in what the tool is told; said once', async (t) => {
    const b = bench(t);
    const said = [];
    b.secrets.expired = (name, users) => said.push(`${name}:${users.join(',')}`);
    b.secrets.set({ name: 'TOKEN', value: 'sk-expiring-value', expires: '2026-10-26' });
    b.secrets.set({ name: 'OTHER', value: 'still-good' });
    b.secrets.attach('alpha', 'TOKEN', true); b.secrets.attach('alpha', 'OTHER', true);
    const before = b.secrets.signature('alpha');
    await b.secrets.deliver('alpha');
    assert.ok(b.calls.some((c) => c.argv.endsWith(`${SECRETS_DIR}/TOKEN`)), 'delivered before its day');
    b.clock.at = new Date(2026, 9, 26, 8, 0);
    b.secrets.check(); b.secrets.check();
    assert.deepEqual(said, ['TOKEN:alpha'], 'said once, with who had it');
    assert.notEqual(b.secrets.signature('alpha'), before, 'a delivery would differ: it is done again at the next opening');
    b.calls.length = 0;
    await b.secrets.deliver('alpha');
    assert.ok(!b.calls.some((c) => c.argv.includes('TOKEN') || c.input === 'sk-expiring-value'), 'not delivered once expired');
    assert.ok(b.calls.some((c) => c.argv.endsWith(`${SECRETS_DIR}/OTHER`)), 'the others still are');
    assert.deepEqual(b.secrets.of('alpha').sort(), ['OTHER', 'TOKEN'], 'still handed: its Assets show it');
    assert.deepEqual(b.secrets.given('alpha'), ['OTHER']);
    assert.equal(b.secrets.list().find((s) => s.name === 'TOKEN').expired, true);
    assert.deepEqual([b.secrets.isExpired('TOKEN'), b.secrets.isExpired('OTHER'), b.secrets.isExpired('NONE')], [true, false, false]);
    assert.equal(b.secrets.reveal('TOKEN'), 'sk-expiring-value', 'kept: never deleted by itself');
    /* A server started again does not say it twice. */
    const again = b.make(); const said2 = [];
    again.expired = (name) => said2.push(name); again.check();
    assert.deepEqual(said2, []);
    /* A new day, then past again: said again. */
    again.replace('TOKEN', { expires: '2026-11-30' });
    assert.equal(again.list().find((s) => s.name === 'TOKEN').expired, false);
    assert.deepEqual(again.given('alpha').sort(), ['OTHER', 'TOKEN']);
});

test('replaced without being seen: the name and the conversations stay; a new value or a new expiry, or both; nothing returned carries a value', async (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'K', value: 'first-value', expires: '2026-10-25' });
    b.secrets.attach('alpha', 'K', true); b.secrets.attach('beta', 'K', true);
    const sealed = JSON.parse(readFileSync(join(b.dir, 'secrets.json'), 'utf8'))[0].sealed;
    const answer = b.secrets.replace('K', { value: 'second-value', expires: '2027-01-31' });
    assert.deepEqual(answer, { name: 'K', expires: '2027-01-31' });
    assert.equal(b.secrets.reveal('K'), 'second-value');
    assert.deepEqual(b.secrets.list().map((s) => [s.name, s.conversations.sort(), s.expires]), [['K', ['alpha', 'beta'], '2027-01-31']]);
    b.secrets.replace('K', { expires: '' });
    assert.equal(b.secrets.reveal('K'), 'second-value', 'an expiry alone keeps the value');
    assert.equal(b.secrets.list()[0].expires, null);
    b.secrets.replace('K', { value: 'third-value' });
    assert.equal(b.secrets.list()[0].expires, null, 'a value alone keeps the expiry');
    const onDisk = readFileSync(join(b.dir, 'secrets.json'), 'utf8');
    assert.ok(!/first-value|second-value|third-value/.test(onDisk), 'sealed at rest');
    assert.notEqual(JSON.parse(onDisk)[0].sealed, sealed);
    assert.throws(() => b.secrets.replace('K', {}), /Nothing to change/);
    assert.throws(() => b.secrets.replace('K', { value: 'x'.repeat(9000) }), /between 1 byte/);
    assert.throws(() => b.secrets.replace('K', { expires: '31/01/2027' }), /YYYY-MM-DD/);
    assert.throws(() => b.secrets.replace('NOPE', { value: 'x' }), /No such secret/);
    assert.ok(!JSON.stringify([b.secrets.list(), b.secrets.of('alpha'), b.secrets.given('alpha')]).includes('third-value'), 'what the page reads carries no value');
    await b.secrets.deliver('alpha');
    assert.equal(b.calls.at(-1).input, 'third-value', 'the next start gets the new one');
});

test('through the API: made with an expiry, replaced in place; no answer ever carries a value', async (t) => {
    const b = bench(t);
    const call = async (method, path, body) => {
        const request = Object.assign(Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body ?? {}))] : []), { method, url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        const conversations = { list: () => [{ name: 'alpha', phase: 'ready' }] };
        await handleApi(request, response, conversations, {}, { of: () => [] }, () => true, undefined, undefined, undefined, b.secrets);
        return { status, text };
    };
    const answers = [];
    const made = await call('POST', '/api/secrets', { name: 'API_KEY', value: 'sk-api-one', expires: '2026-10-27' }); answers.push(made.text);
    assert.equal(made.status, 201);
    assert.equal((await call('POST', '/api/secrets', { name: 'BAD', value: 'x', expires: '2026-1-1' })).status, 400);
    const replaced = await call('POST', '/api/secrets/API_KEY/replace', { value: 'sk-api-two', expires: '' }); answers.push(replaced.text);
    assert.equal(replaced.status, 200);
    assert.equal((await call('POST', '/api/secrets/NONE/replace', { value: 'x' })).status, 404);
    const listed = await call('GET', '/api/secrets'); answers.push(listed.text);
    assert.deepEqual(JSON.parse(listed.text).map((s) => [s.name, s.expires]), [['API_KEY', null]]);
    assert.equal(b.secrets.reveal('API_KEY'), 'sk-api-two');
    for (const text of answers) assert.ok(!/sk-api|sealed/.test(text), text);
});

test('an ephemeral secret: random name, sealed, handed to its conversation, listed as short-lived', (t) => {
    const b = bench(t);
    const { name, expiresAt } = b.secrets.stash('alice', 'npm_realtokenvalue123');
    assert.ok(name.startsWith(EPHEMERAL_PREFIX) && isSecretName(name), name);
    assert.ok(Date.parse(expiresAt) > b.clock.at.getTime());
    const onDisk = readFileSync(join(b.dir, 'secrets.json'), 'utf8');
    assert.ok(onDisk.includes(name) && !onDisk.includes('npm_realtokenvalue123'), 'name kept, value sealed');
    assert.deepEqual(b.secrets.given('alice'), [name], 'handed to the conversation it came from');
    assert.deepEqual(b.secrets.given('bob'), [], 'not to another conversation');
    const row = b.secrets.list().find((s) => s.name === name);
    assert.equal(row.ephemeral, true);
    assert.ok(row.expiresInMs > 0 && row.expiresInMs <= TTL_MAX_MS);
});

test('an ephemeral secret is delivered to the running machine like any other', async (t) => {
    const b = bench(t);
    const { name } = b.secrets.stash('alice', 'the-secret-value');
    b.calls.length = 0;
    await b.secrets.deliver('alice');
    const wrote = b.calls.find((c) => c.argv.includes(`${SECRETS_DIR}/${name}`));
    assert.ok(wrote, 'a file is installed for it');
    assert.equal(wrote.input, 'the-secret-value', 'its value is delivered, never in an argument');
    assert.ok(!b.calls.some((c) => c.argv.includes('the-secret-value')), 'the value is never in an argument list');
});

test('an ephemeral secret stops being delivered once its minute passes', (t) => {
    const b = bench(t);
    const { name } = b.secrets.stash('alice', 'short-lived', { ttlMs: 5 * 60_000 });
    assert.deepEqual(b.secrets.given('alice'), [name]);
    assert.equal(b.secrets.isExpired(name), false);
    b.clock.at = new Date(b.clock.at.getTime() + 6 * 60_000);
    assert.equal(b.secrets.isExpired(name), true);
    assert.deepEqual(b.secrets.given('alice'), [], 'gone from the delivery set');
    assert.equal(b.secrets.signature('alice'), '', 'a changed signature triggers a re-delivery');
});

test('dropping an ephemeral secret removes it and rewrites the machine', async (t) => {
    const b = bench(t);
    const { name } = b.secrets.stash('alice', 'to-forget');
    b.calls.length = 0;
    await b.secrets.drop('alice', name);
    assert.equal(b.secrets.reveal(name), undefined, 'value gone from the vault');
    assert.ok(!b.secrets.list().some((s) => s.name === name));
    assert.ok(b.calls.some((c) => c.argv.includes(RUNNER) || c.argv.includes(SECRETS_DIR)), 'the machine was rewritten');
    await assert.rejects(b.secrets.drop('alice', name), /No such short-lived secret/);
});

test('a restart drops ephemeral secrets that ran out, keeps those still alive', (t) => {
    const b = bench(t);
    const live = b.secrets.stash('alice', 'still-good', { ttlMs: 30 * 60_000 }).name;
    const dead = b.secrets.stash('alice', 'too-late', { ttlMs: 5 * 60_000 }).name;
    b.clock.at = new Date(b.clock.at.getTime() + 10 * 60_000);
    const reborn = b.make();                                   /* same store + grants, after the clock moved */
    assert.deepEqual(reborn.given('alice'), [live], 'the live one stays, the dead one is swept');
    assert.ok(!reborn.list().some((s) => s.name === dead));
});

test('liveFor lists only live ephemeral secrets, with time left', (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'MODEL_KEY', value: 'sk-x' }); b.secrets.attach('alice', 'MODEL_KEY', true);
    const { name } = b.secrets.stash('alice', 'tok', { ttlMs: 10 * 60_000 });
    const live = b.secrets.liveFor('alice');
    assert.deepEqual(live.map((x) => x.name), [name], 'only the ephemeral one, never the ordinary secret');
    assert.ok(live[0].expiresInMs > 0 && live[0].expiresInMs <= 10 * 60_000);
    b.clock.at = new Date(b.clock.at.getTime() + 11 * 60_000);
    assert.deepEqual(b.secrets.liveFor('alice'), [], 'an expired one drops out');
});

test('through the API: forgetting an ephemeral secret of a conversation drops it', async (t) => {
    const b = bench(t);
    const call = async (method, path, body) => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { method, url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        const conversations = { list: () => [{ name: 'alpha', phase: 'ready' }] };
        await handleApi(request, response, conversations, {}, { of: () => [] }, () => true, undefined, undefined, undefined, b.secrets);
        return { status, text };
    };
    const { name } = b.secrets.stash('alpha', 'npm_token-value');
    assert.deepEqual(b.secrets.liveFor('alpha').map((x) => x.name), [name]);
    const gone = await call('POST', `/api/conversations/alpha/secrets/${name}/forget`, {});
    assert.equal(gone.status, 200);
    assert.equal(b.secrets.reveal(name), undefined, 'the value is gone from the vault');
    assert.deepEqual(b.secrets.liveFor('alpha'), []);
    assert.equal((await call('POST', '/api/conversations/alpha/secrets/SECRET_FFFFFFFFFF/forget', {})).status, 404);
});

test('through the API: a secret given to a running conversation reaches its machine at once; an asleep one waits for its next opening', async (t) => {
    const b = bench(t);
    let asleep = false;
    const call = async (path, body) => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { method: 'POST', url: path, headers: { 'content-type': 'application/json' } });
        let status;
        const response = { writeHead: (s) => { status = s; return { end: () => {} }; } };
        const conversations = { list: () => [{ name: 'alpha', phase: 'ready', asleep }] };
        await handleApi(request, response, conversations, {}, { of: () => [] }, () => true, undefined, undefined, undefined, b.secrets);
        return status;
    };
    b.secrets.set({ name: 'OVH_KEY', value: 'ovh-value-123' });
    b.calls.length = 0;
    assert.equal(await call('/api/conversations/alpha/secrets', { secret: 'OVH_KEY', attached: true }), 200);
    assert.ok(b.calls.some((c) => c.argv.includes('/run/secrets/OVH_KEY') && c.input === 'ovh-value-123'), 'written in the machine now');
    b.calls.length = 0;
    assert.equal(await call('/api/conversations/alpha/secrets', { secret: 'OVH_KEY', attached: false }), 200);
    assert.ok(b.calls.some((c) => c.argv.includes('find /run/secrets')) && !b.calls.some((c) => c.argv.includes('/run/secrets/OVH_KEY')), 'and taken away now');
    asleep = true; b.calls.length = 0;
    await call('/api/conversations/alpha/secrets', { secret: 'OVH_KEY', attached: true });
    assert.equal(b.calls.length, 0, 'an asleep machine is not woken for it');
    /* A new value: its running machines get it now too. */
    asleep = false; b.calls.length = 0;
    assert.equal(await call('/api/secrets/OVH_KEY/replace', { value: 'ovh-value-456' }), 200);
    assert.ok(b.calls.some((c) => c.argv.includes('/run/secrets/OVH_KEY') && c.input === 'ovh-value-456'), 'the new value, at once');
});

test('the guard: a machine missing a secret, holding one too many, or holding an old value is put right; one in order is left alone', async (t) => {
    const b = bench(t);
    let listing = '';
    const calls = [];
    const vms = { exec: async (name, argv, options) => { calls.push({ argv: argv.join(' '), input: options?.input }); return argv[0] === 'sh' ? { code: 0, stdout: listing, stderr: '' } : { code: 0, stdout: '', stderr: '' }; } };
    const s = new Secrets({ store: new Store(join(b.dir, 'g.json')), vault: new Vault(join(b.dir, 'g.key')), vms, grants: new Grants(), now: () => b.clock.at });
    s.set({ name: 'OVH_KEY', value: 'v1' }); s.attach('alpha', 'OVH_KEY', true);
    const delivered = () => calls.some((c) => c.argv.includes('/run/secrets/OVH_KEY'));
    /* Missing in the machine: put there. */
    let last = await s.reconcile('alpha', undefined);
    assert.ok(delivered(), 'missing: delivered');
    /* In order: nothing written. */
    listing = 'OVH_KEY\n'; calls.length = 0;
    assert.equal(await s.reconcile('alpha', last), last);
    assert.equal(calls.length, 1, 'only looked at');
    /* One too many there (taken away elsewhere): rewritten without it. */
    listing = 'OVH_KEY\nOLD_ONE\n'; calls.length = 0;
    await s.reconcile('alpha', last);
    assert.ok(calls.some((c) => c.argv.includes('find /run/secrets')), 'cleared and written again');
    /* A new value: delivered. */
    listing = 'OVH_KEY\n'; s.replace('OVH_KEY', { value: 'v2' }); calls.length = 0;
    last = await s.reconcile('alpha', last);
    assert.ok(calls.some((c) => c.input === 'v2'));
    /* A machine that cannot be looked at: left for the next look. */
    const down = new Secrets({ store: new Store(join(b.dir, 'g.json')), vault: new Vault(join(b.dir, 'g.key')), vms: { exec: async () => { throw new Error('asleep'); } }, grants: new Grants(), now: () => b.clock.at });
    assert.equal(await down.reconcile('alpha', last), null);
});
