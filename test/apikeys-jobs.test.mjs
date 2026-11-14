import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeys, handleExternal } from '../server/apikeys.mjs';
import { Grants, MemoryStore, apiKeySubject } from '../server/grants.mjs';
import { Jobs, withUpdates } from '../server/jobs.mjs';
import { Store } from '../server/store.mjs';

/* The scope "jobs" (14-11): another AI reads what this Clavarium does and each job's log, over the API and MCP. */
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'clv-apikeys-jobs-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const bearer = (secret) => `Bearer ${secret}`;
const SECRET_LIKE = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD';

async function call(opts, { method = 'GET', path, secret, body, headers = {} }) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const request = { method, url: path, headers: { ...(secret ? { authorization: bearer(secret) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        async *[Symbol.asyncIterator]() { if (text) yield text; } };
    const out = { status: 0, text: '', headers: {} };
    const response = { writeHead(code, h = {}) { out.status = code; out.headers = h; return response; }, end(t) { out.text = t ?? ''; } };
    await handleExternal(request, response, opts);
    return { status: out.status, headers: out.headers, body: out.text ? JSON.parse(out.text) : null };
}

/* A copy under way, a build that failed (a secret in its error), and an update of Clavarium today. */
function home(t) {
    const dir = folder(t);
    let now = Date.parse('2026-11-14T10:00:00Z');
    const jobs = new Jobs({ now: () => now });
    jobs.seen(undefined, { name: 'beta', phase: 'building', step: 'Making the machine' });
    now += 1000;
    jobs.seen({ name: 'beta', phase: 'building' }, { name: 'beta', phase: 'failed', error: `no room (key ${SECRET_LIKE})` });
    now += 1000;
    const records = [{ name: 'gamma', title: 'Gamma', phase: 'building', copyOf: 'alpha', step: 'Copying files' }];
    jobs.seen(undefined, records[0]);
    const history = [{ at: new Date(now - 500).toISOString(), action: 'update', from: '0.2.1', to: '0.2.2', result: 'done' }];
    const grants = new Grants(new MemoryStore());
    const keys = new ApiKeys({ store: new Store(join(dir, 'apikeys.json')), grants, journal: join(dir, 'apikeys.log'), now: () => now });
    const opts = { keys, status: async () => ({ conversations: [], versions: { clavarium: '0.2.2' } }), version: '0.2.2',
        chats: { list: () => [{ id: 'gamma', name: 'Gamma' }], chatOn: () => true, read: () => ({ messages: [{ from: 'ai', text: 'hello' }] }), say: async () => ({}) },
        jobs: { list: () => withUpdates(jobs, records, history, now), log: (id) => jobs.log(id) } };
    return { dir, keys, grants, opts };
}

test('the scope "jobs": a line server:jobs r in the one table of rights, offered with its words', (t) => {
    const { keys, grants } = home(t);
    const { key } = keys.create({ label: 'Watcher', scopes: ['jobs'] });
    assert.deepEqual(grants.of(apiKeySubject(key.id)), [{ asset: 'server:jobs', type: 'server', name: 'jobs', rights: 'r' }]);
    assert.deepEqual(key.scopes, ['jobs']);
    assert.ok(keys.scopes().some((s) => s.id === 'jobs' && s.label === 'Jobs: read what Clavarium does and its logs'));
    assert.throws(() => grants.give(apiKeySubject(key.id), 'server:jobs', 'w'), /rights/, 'read only');
});

test('GET /api/ext/v1/jobs and /jobs/<id>: what it does, its updates among the done, a log; masked; 403 without the scope', async (t) => {
    const { keys, opts, dir } = home(t);
    const watcher = keys.create({ label: 'Watcher', scopes: ['jobs'] });
    const other = keys.create({ label: 'Status only', scopes: ['status'] });
    const listed = await call(opts, { path: '/api/ext/v1/jobs', secret: watcher.secret });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.running.map((j) => j.what), ['Copy Gamma']);
    assert.equal(listed.body.running[0].step, 'Copying files');
    assert.deepEqual(listed.body.done.map((j) => j.what), ['Clavarium updated to 0.2.2', 'Building beta'], 'newest first, the update among them');
    assert.equal('log' in listed.body.done[1], false, 'the list without logs');
    assert.equal(JSON.stringify(listed.body).includes(SECRET_LIKE), false, 'a secret in an error is masked');
    const failed = listed.body.done[1];
    const one = await call(opts, { path: `/api/ext/v1/jobs/${encodeURIComponent(failed.id)}`, secret: watcher.secret });
    assert.equal(one.status, 200);
    assert.equal(one.body.result, 'failed');
    assert.deepEqual(one.body.log.map((l) => l.text.startsWith('Failed') ? 'Failed' : l.text), ['Making the machine', 'Failed']);
    assert.equal(JSON.stringify(one.body).includes(SECRET_LIKE), false, 'masked in the log too');
    assert.equal((await call(opts, { path: '/api/ext/v1/jobs/nobody-2026', secret: watcher.secret })).status, 404);
    assert.equal((await call(opts, { path: '/api/ext/v1/jobs/a%2Fb', secret: watcher.secret })).status, 404, 'not an id');
    assert.equal((await call(opts, { path: '/api/ext/v1/jobs', secret: other.secret })).status, 403, 'without the scope');
    assert.equal((await call(opts, { path: `/api/ext/v1/jobs/${failed.id}`, secret: other.secret })).status, 403);
    assert.equal((await call(opts, { path: '/api/ext/v1/jobs' })).status, 401, 'without a key');
    assert.equal((await call(opts, { method: 'POST', path: '/api/ext/v1/jobs', secret: watcher.secret, body: {} })).status, 405, 'read only');
    const journal = readFileSync(join(dir, 'apikeys.log'), 'utf8');
    assert.match(journal, /"route":"\/v1\/jobs","status":200/);
    assert.equal(journal.includes(watcher.secret.slice(4, 16)), false);
});

test('MCP at /api/ext/v1/mcp: initialize, tools listed by scope, status, jobs and a log; refused without key or scope; 405 on GET', async (t) => {
    const { keys, opts, grants, dir } = home(t);
    const both = keys.create({ label: 'Peer AI', scopes: ['status', 'jobs'] });
    const bare = keys.create({ label: 'Bare' });
    grants.give(apiKeySubject(bare.key.id), 'conversation:gamma', 'r');
    const mcp = (secret, body, more = {}) => call(opts, { method: 'POST', path: '/api/ext/v1/mcp', secret, body: { jsonrpc: '2.0', ...body }, headers: { accept: 'application/json, text/event-stream' }, ...more });
    const tool = (secret, name, args = {}) => mcp(secret, { id: 9, method: 'tools/call', params: { name, arguments: args } });

    const init = await mcp(both.secret, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'peer', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.body.result.serverInfo.name, 'clavarium');
    assert.equal(init.body.result.serverInfo.version, '0.2.2');
    assert.ok(init.body.result.capabilities.tools);
    const initialized = await mcp(both.secret, { method: 'notifications/initialized' });
    assert.equal(initialized.status, 202); assert.equal(initialized.body, null);
    assert.deepEqual((await mcp(both.secret, { id: 2, method: 'ping' })).body.result, {});

    const names = async (secret) => (await mcp(secret, { id: 3, method: 'tools/list' })).body.result.tools;
    const full = await names(both.secret);
    for (const n of ['clavarium_status', 'clavarium_jobs', 'clavarium_job_log', 'clavarium_conversations', 'clavarium_read']) assert.ok(full.some((x) => x.name === n), n);
    for (const n of ['clavarium_status', 'clavarium_jobs', 'clavarium_job_log']) {
        const x = full.find((y) => y.name === n);
        assert.equal(x.annotations.readOnlyHint, true, n); assert.equal(x.inputSchema.type, 'object', n);
    }
    assert.deepEqual(full.find((x) => x.name === 'clavarium_job_log').inputSchema.required, ['id']);
    const few = (await names(bare.secret)).map((x) => x.name);
    for (const n of ['clavarium_status', 'clavarium_jobs', 'clavarium_job_log', 'clavarium_room_create']) assert.equal(few.includes(n), false, `${n} hidden without its scope`);
    assert.ok(few.includes('clavarium_conversations') && few.includes('clavarium_read'));

    const status = await tool(both.secret, 'clavarium_status');
    assert.equal(status.body.result.isError, false);
    assert.deepEqual(JSON.parse(status.body.result.content[0].text).versions, { clavarium: '0.2.2' });
    const listed = await tool(both.secret, 'clavarium_jobs');
    assert.equal(listed.body.result.content[0].type, 'text');
    const said = JSON.parse(listed.body.result.content[0].text);
    assert.deepEqual(said.running.map((j) => j.what), ['Copy Gamma']);
    assert.equal(said.done.length, 2);
    const log = await tool(both.secret, 'clavarium_job_log', { id: said.running[0].id });
    assert.deepEqual(JSON.parse(log.body.result.content[0].text).log.map((l) => l.text), ['Copying files']);
    const unknown = await tool(both.secret, 'clavarium_job_log', { id: 'nobody-2026' });
    assert.equal(unknown.status, 200); assert.equal(unknown.body.result.isError, true);
    assert.match(unknown.body.result.content[0].text, /No such job/);
    assert.equal((await tool(both.secret, 'clavarium_job_log', {})).body.error.code, -32602);
    const read = await tool(bare.secret, 'clavarium_read', { conversation: 'gamma' });
    assert.equal(read.status, 200); assert.equal(read.body.result.isError, false);

    /* Refused: a tool without its scope (as the API, 403), no key or a key nobody has (401), GET (405). */
    for (const n of ['clavarium_jobs', 'clavarium_job_log', 'clavarium_status']) {
        const r = await tool(bare.secret, n, { id: said.running[0].id });
        assert.equal(r.status, 403, n); assert.equal(r.body.error.code, -32001);
        assert.equal(JSON.stringify(r.body).includes(bare.secret), false);
    }
    assert.equal((await mcp(undefined, { id: 4, method: 'tools/list' })).status, 401);
    assert.equal((await mcp(`clv_${'E'.repeat(43)}`, { id: 5, method: 'tools/list' })).status, 401);
    const get = await call(opts, { path: '/api/ext/v1/mcp', secret: both.secret });
    assert.equal(get.status, 405); assert.equal(get.headers.allow, 'POST');
    /* Journaled with its address and tool, never the secret. */
    const journal = readFileSync(join(dir, 'apikeys.log'), 'utf8');
    assert.match(journal, /"route":"\/v1\/mcp tools\/call clavarium_job_log [^"]*","status":200/);
    assert.equal(journal.includes(both.secret.slice(4, 16)), false);
});
