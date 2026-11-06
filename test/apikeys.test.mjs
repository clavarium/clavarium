import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeys, statusOf, KEY_PREFIX, RATE_PER_MIN, DEFAULT_DAYS } from '../server/apikeys.mjs';
import { Grants, MemoryStore, apiKeySubject, pairingSubject } from '../server/grants.mjs';
import { Devices } from '../server/devices.mjs';
import { Store } from '../server/store.mjs';
import { startHome } from '../server/main.mjs';
import { withExtRoute, ensureProxySettings, EXT_ROUTE } from '../deploy/updater.mjs';

const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'clv-apikeys-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const bearer = (secret) => `Bearer ${secret}`;
const statusOfError = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.status; } };

function made(t, now = () => Date.now()) {
    const dir = folder(t);
    const grants = new Grants(new MemoryStore());
    const keys = new ApiKeys({ store: new Store(join(dir, 'apikeys.json')), grants, journal: join(dir, 'apikeys.log'), now });
    return { dir, grants, keys };
}

test('a key: its secret made here, high entropy and prefixed, shown once; only its hash is kept, nowhere in clear', (t) => {
    const { dir, keys } = made(t);
    const { key, secret } = keys.create({ label: 'Home automation', scopes: ['status'] }, 'owner@example.com');
    assert.match(secret, /^clv_[A-Za-z0-9_-]{43}$/);
    assert.ok(secret.startsWith(KEY_PREFIX));
    const other = keys.create({ label: 'Another' }).secret;
    assert.notEqual(secret, other, 'two keys, two secrets');
    /* Shown once: nothing that lists or reads a key gives it back, nor its hash. */
    for (const shown of [key, keys.get(key.id), ...keys.list()]) {
        assert.equal(JSON.stringify(shown).includes(secret), false);
        assert.equal('hash' in shown || 'secret' in shown, false, 'neither the secret nor its hash');
    }
    assert.deepEqual(key.scopes, ['status']);
    assert.equal(key.createdBy, 'owner@example.com');
    /* 90 days by default. */
    assert.equal(Math.round((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86_400_000), DEFAULT_DAYS);
    /* The store: the hash, never the secret, nor any long piece of it. */
    keys.check(bearer(secret), 'status');
    keys.note({ key: key.id, route: '/v1/status', status: 200 });
    for (const file of ['apikeys.json', 'apikeys.log']) {
        const text = readFileSync(join(dir, file), 'utf8');
        assert.equal(text.includes(secret.slice(KEY_PREFIX.length, KEY_PREFIX.length + 12)), false, `${file} holds no part of the secret`);
    }
    assert.match(readFileSync(join(dir, 'apikeys.json'), 'utf8'), /"hash": "[0-9a-f]{64}"/);
});

test('a key starts with no right: no scope ticked, the status is refused (403); its line in the one table of rights', (t) => {
    const { keys, grants } = made(t);
    const bare = keys.create({ label: 'Nothing yet' });
    assert.deepEqual(bare.key.scopes, []);
    assert.deepEqual(grants.of(apiKeySubject(bare.key.id)), []);
    assert.equal(statusOfError(() => keys.check(bearer(bare.secret), 'status')), 403);
    assert.equal(keys.check(bearer(bare.secret)), bare.key.id, 'a valid key, only not this scope');
    const reader = keys.create({ label: 'Reader', scopes: ['status'] });
    assert.deepEqual(grants.of(apiKeySubject(reader.key.id)), [{ asset: 'server:status', type: 'server', name: 'status', rights: 'r' }]);
    assert.equal(keys.check(bearer(reader.secret), 'status'), reader.key.id);
});

test('unknown, revoked or expired: 401 with a plain word; revoked is at once', (t) => {
    let clock = Date.parse('2026-11-06T10:00:00Z');
    const { keys, grants } = made(t, () => clock);
    const { key, secret } = keys.create({ label: 'Short', scopes: ['status'], days: 1 });
    assert.equal(keys.check(bearer(secret), 'status'), key.id);
    for (const header of [undefined, '', 'Basic abc', `Bearer ${KEY_PREFIX}${'A'.repeat(43)}`, `Bearer ${secret}x`, secret]) {
        assert.equal(statusOfError(() => keys.check(header, 'status')), 401, String(header).slice(0, 20));
    }
    try { keys.check(`Bearer ${KEY_PREFIX}${'B'.repeat(43)}`); } catch (error) { assert.match(error.message, /not valid: unknown, revoked or expired/); }
    /* Expired: a day later. */
    clock += 86_400_000;
    assert.equal(statusOfError(() => keys.check(bearer(secret), 'status')), 401);
    assert.equal(keys.list()[0].expired, true);
    /* Never: it does not expire. */
    const forever = keys.create({ label: 'Forever', scopes: ['status'], days: null });
    assert.equal(forever.key.expiresAt, null);
    clock += 3650 * 86_400_000;
    assert.equal(keys.check(bearer(forever.secret), 'status'), forever.key.id);
    /* Revoked: the next call is refused, its rights gone. */
    keys.revoke(forever.key.id);
    assert.equal(statusOfError(() => keys.check(bearer(forever.secret), 'status')), 401);
    assert.deepEqual(grants.of(apiKeySubject(forever.key.id)), []);
    assert.throws(() => keys.revoke(forever.key.id), /No such key/);
});

test('the secret is compared in constant time, every key looked at', () => {
    const source = readFileSync(new URL('../server/apikeys.mjs', import.meta.url), 'utf8');
    const find = /#find\(secret\) \{[\s\S]*?\n {4}\}/.exec(source)[0];
    assert.match(find, /timingSafeEqual\(Buffer\.from\(k\.hash, 'hex'\), asked\)/);
    assert.doesNotMatch(find, /hash\s*===|===\s*k\.hash|\.find\(|return k\b/, 'no early exit, no plain comparison');
    assert.match(find, /for \(const k of this\.#store\.all\(\)\)/);
});

test('a key is limited to its calls a minute: then 429, and again after the minute; unknown keys are limited together', (t) => {
    let clock = Date.parse('2026-11-06T10:00:00Z');
    const { keys } = made(t, () => clock);
    const a = keys.create({ label: 'A', scopes: ['status'] });
    const b = keys.create({ label: 'B', scopes: ['status'] });
    for (let i = 0; i < RATE_PER_MIN; i += 1) keys.check(bearer(a.secret), 'status');
    let refused;
    try { keys.check(bearer(a.secret), 'status'); } catch (error) { refused = error; }
    assert.equal(refused?.status, 429); assert.ok(refused.retry >= 1);
    assert.equal(keys.check(bearer(b.secret), 'status'), b.key.id, 'another key is not held back');
    clock += 61_000;
    assert.equal(keys.check(bearer(a.secret), 'status'), a.key.id);
    const wrong = `Bearer ${KEY_PREFIX}${'C'.repeat(43)}`;
    const codes = Array.from({ length: 70 }, () => statusOfError(() => keys.check(wrong, 'status')));
    assert.equal(codes.filter((c) => c === 401).length, 60); assert.equal(codes.at(-1), 429);
});

test('rights: a key is given the status alone; a device never; a key never a secret, a conversation or a folder', () => {
    const grants = new Grants(new MemoryStore());
    const key = apiKeySubject('11111111-2222-4333-8444-555555555555');
    const device = pairingSubject('11111111-2222-4333-8444-666666666666');
    assert.equal(grants.give(key, 'server:status', 'r'), 'r');
    for (const asset of ['secret:MODEL_KEY', 'conversation:alpha', 'folder:reports', 'git:code', 'mailbox:home']) assert.throws(() => grants.give(key, asset, 'r'), /API key|secret|conversation/, asset);
    assert.throws(() => grants.give(device, 'server:status', 'r'), /API key/);
    assert.throws(() => grants.give('conversation:alpha', 'server:status', 'r'), /API key/);
    assert.throws(() => grants.give(key, 'server:status', 'w'), /rights/);
    assert.throws(() => grants.give(key, 'server:anything', 'r'), /Not an asset/);
    const devices = new Devices(new MemoryStore(), undefined, grants);
    assert.throws(() => devices.share([{ asset: 'server:status', rights: 'r' }]), /API key, not to a device/);
});

test('the status says the state and never what a conversation says: no message, no secret, no file', async () => {
    const said = 'SECRET-CONTENT the tool wrote in its chat';
    const conversations = { list: () => [
        { name: 'alpha', title: 'Alpha jobs', tool: 'claude', toolLabel: 'Claude Code', phase: 'ready', asleep: false, resources: [{ name: 'private-folder' }], secrets: ['MODEL_KEY'], guide: said },
        { name: 'beta', tool: 'shell', toolLabel: 'Shell', phase: 'ready', asleep: true },
        { name: 'gamma', title: 'Gamma', tool: 'shell', toolLabel: 'Shell', phase: 'ready' },
        { name: 'delta', title: 'Delta', tool: 'shell', toolLabel: 'Shell', phase: 'ready' },
    ] };
    const talk = { brief: (name) => ({ alpha: { waiting: 1, state: 'waiting', needs: true, lastText: said, lastFrom: 'agent' }, gamma: { state: 'working', needs: false, lastText: said } }[name] ?? null) };
    const capacity = { brief: async () => ({ known: true, high: false, memory: { usedPercent: 40, freeMb: 9000, high: false, aboveMb: 1 }, disk: { usedPercent: 60, freeMb: 90_000, high: false } }), room: async () => ({ cpu: { cores: 8 } }) };
    const history = { series: () => ({ cpu: [10, null, 23, null] }) };
    const s = await statusOf({ conversations, talk, health: { of: () => null }, answerer: { of: () => null }, capacity, history, platform: { version: '0.2.335' }, components: { parley: '0.17.71' } });
    assert.deepEqual(s.conversations.map((c) => [c.id, c.name, c.state]), [['alpha', 'Alpha jobs', 'needs-you'], ['beta', 'beta', 'asleep'], ['gamma', 'Gamma', 'working'], ['delta', 'Delta', 'awake']]);
    assert.deepEqual(Object.keys(s.conversations[0]).sort(), ['id', 'name', 'phase', 'state', 'tool']);
    assert.equal(s.server.memory.usedPercent, 40); assert.equal(s.server.cpu.usedPercent, 23); assert.equal(s.server.cpu.cores, 8);
    assert.equal(s.versions.clavarium, '0.2.335'); assert.equal(s.versions.parley, '0.17.71');
    assert.deepEqual(s.counts, { awake: 1, working: 1, 'needs-you': 1, asleep: 1 });
    const text = JSON.stringify(s);
    for (const never of ['SECRET-CONTENT', 'MODEL_KEY', 'private-folder', 'lastText']) assert.equal(text.includes(never), false, never);
});

test('a real server: administrators manage keys, a program reads the status with one, revoked is 401; the secret is never logged', async (t) => {
    const dir = folder(t);
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: ['owner@example.com'], publicOrigin: 'https://clav.example.com', startWaitMs: 2000 });
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const owner = { 'x-forwarded-email': 'owner@example.com' };
    const page = { ...owner, origin: 'https://clav.example.com', 'content-type': 'application/json' };
    const post = (path, body, headers = page) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

    /* Managing keys: an administrator, from this site's own pages; nobody else, nor a device. */
    assert.equal((await fetch(`${base}/api/apikeys`)).status, 403, 'no identity');
    assert.equal((await fetch(`${base}/api/apikeys`, { headers: { 'x-forwarded-email': 'guest@example.com' } })).status, 403, 'a stranger');
    assert.equal((await post('/api/apikeys', { label: 'x' }, { 'x-forwarded-email': 'guest@example.com', origin: 'https://clav.example.com', 'content-type': 'application/json' })).status, 403);
    assert.equal((await post('/api/apikeys', { label: 'x' }, { ...page, origin: 'https://evil.example' })).status, 403, 'from another site');
    for (const path of ['/c/api/apikeys', '/c/api/11111111-2222-4333-8444-555555555555/apikeys']) {
        const r = await fetch(base + path, { method: 'POST', headers: page, body: '{"label":"x"}' });
        assert.ok([401, 403, 404].includes(r.status), `${path}: ${r.status}`);
    }
    assert.equal((await fetch(`${base}/api/apikeys`, { headers: owner })).status, 200);
    const r = await post('/api/apikeys', { label: 'Steering AI', scopes: ['status'] });
    assert.equal(r.status, 201);
    const { key, secret } = await r.json();
    const none = await (await post('/api/apikeys', { label: 'No scope' })).json();
    const listed = await (await fetch(`${base}/api/apikeys`, { headers: owner })).json();
    assert.equal(JSON.stringify(listed).includes(secret), false, 'listed without its secret');
    assert.deepEqual(listed.keys.map((k) => k.label).sort(), ['No scope', 'Steering AI']);

    /* The door for programs: the key, never an identity. */
    const ext = (path, secretUsed, more = {}) => fetch(base + path, { ...more, headers: { ...(secretUsed ? { authorization: bearer(secretUsed) } : {}), ...(more.headers ?? {}) } });
    const ok = await ext('/api/ext/v1/status', secret);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(Array.isArray(body.conversations)); assert.ok(body.server); assert.equal(typeof body.versions.clavarium, 'string');
    assert.equal((await ext('/api/ext/v1/status', none.secret)).status, 403, 'no scope');
    assert.equal((await ext('/api/ext/v1/status')).status, 401, 'no key');
    assert.equal((await ext('/api/ext/v1/status', undefined, { headers: owner })).status, 401, 'an identity is not a key');
    const unknown = await ext('/api/ext/v1/status', `${KEY_PREFIX}${'D'.repeat(43)}`);
    assert.equal(unknown.status, 401); assert.match((await unknown.json()).error, /not valid/);
    assert.equal(unknown.headers.get('www-authenticate'), 'Bearer realm="clavarium"');
    assert.equal(unknown.headers.get('x-clavarium-version'), null, 'the version is not said to whoever asks');
    assert.equal((await ext('/api/ext/v1/status', secret, { headers: { origin: 'https://evil.example' } })).status, 403, 'a page of another site');

    /* MCP: the same, as one read tool. */
    const mcp = (message, s = secret) => fetch(`${base}/api/ext/mcp`, { method: 'POST', headers: { authorization: bearer(s), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) });
    const init = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools);
    assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.deepEqual(tools.result.tools.map((x) => x.name), ['clavarium_status']);
    assert.equal(tools.result.tools[0].annotations.readOnlyHint, true);
    const called = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clavarium_status', arguments: {} } })).json();
    assert.ok(Array.isArray(called.result.structuredContent.conversations));
    assert.deepEqual(JSON.parse(called.result.content[0].text).versions, called.result.structuredContent.versions);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'clavarium_status' } }, none.secret)).status, 403, 'MCP without the scope');
    assert.equal((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, `${KEY_PREFIX}${'E'.repeat(43)}`)).status, 401);
    assert.equal((await fetch(`${base}/api/ext/mcp`, { headers: { authorization: bearer(secret) } })).status, 405, 'no event stream');

    /* Revoked: at once. */
    assert.equal((await post(`/api/apikeys/${key.id}/revoke`, {})).status, 200);
    assert.equal((await ext('/api/ext/v1/status', secret)).status, 401);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/list' })).status, 401);

    /* Journaled: the key's id, the route, the answer -- never the secret; What happened says made and revoked. */
    const journal = readFileSync(join(dir, 'apikeys.log'), 'utf8');
    assert.match(journal, new RegExp(`"key":"${key.id}","method":"GET","route":"/v1/status","status":200`));
    assert.match(journal, /"route":"\/v1\/status","status":401/);
    for (const file of ['apikeys.log', 'apikeys.json', 'events.log', 'grants.json']) {
        if (!existsSync(join(dir, file))) continue;
        const text = readFileSync(join(dir, file), 'utf8');
        for (const s of [secret, none.secret]) assert.equal(text.includes(s.slice(4, 20)), false, `${file} holds no part of a secret`);
    }
    assert.match(readFileSync(join(dir, 'events.log'), 'utf8'), /API key \\"Steering AI\\" revoked/);
});

test('the front: the updater adds /api/ext/ to the routes that skip sign-on, once, and nothing else', async (t) => {
    const before = '# A paired device...\nskip_auth_routes = ["^/c/"]\nskip_auth_strip_headers = true\n';
    const after = withExtRoute(before);
    assert.match(after, /^skip_auth_routes = \["\^\/c\/", "\^\/api\/ext\/"\]$/m);
    assert.equal(withExtRoute(after), after, 'once');
    assert.equal(after.replace(/^# \/api\/ext\/.*\n/m, '').replace(`, "${EXT_ROUTE}"`, ''), before, 'nothing else touched');
    assert.equal(withExtRoute('upstreams = ["x"]\n'), 'upstreams = ["x"]\n', 'no such line: left as it is');
    const multi = 'skip_auth_routes = [\n  "^/c/",\n]\n';
    assert.equal(withExtRoute(multi), multi, 'a list over several lines: left as it is');
    assert.match(withExtRoute('skip_auth_routes = []\n'), /skip_auth_routes = \["\^\/api\/ext\/"\]/);

    const dir = folder(t);
    const file = join(dir, 'oauth2-proxy.cfg');
    writeFileSync(file, `provider = "oidc"\n${before}cookie_csrf_per_request = true\ncookie_csrf_expire = "30m"\n`);
    const ran = [];
    const run = async (argv) => { ran.push(argv.join(' ')); return { code: 0 }; };
    assert.equal(await ensureProxySettings({ file, run }), true);
    assert.match(readFileSync(file, 'utf8'), /"\^\/api\/ext\/"/);
    assert.equal(await ensureProxySettings({ file, run }), false, 'once');
    assert.match(readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8'), /^skip_auth_routes = \["\^\/c\/", "\^\/api\/ext\/"\]$/m, 'install.sh writes it too');
});
