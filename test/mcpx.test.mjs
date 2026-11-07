/* External MCP servers through Tether (mcpx.mjs, the /api/tether/mcp-* routes): the key kept host-only in the vault,
 * Tether handed only its name; never in an answer, an error or a log line; a pasted mcpServers block with its keys
 * named, a program to start (stdio) refused; a conversation's rights set and read back; new tools marked seen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../server/api.mjs';
import { Vault } from '../server/vault.mjs';
import { Secrets } from '../server/secrets.mjs';
import { Store } from '../server/store.mjs';
import { Grants } from '../server/grants.mjs';
import { Vms } from '../server/vm.mjs';
import { Tethers } from '../server/tethers.mjs';
import { serverId, keyName, mcpSeen } from '../server/mcpx.mjs';

const KEY = 'sk-test-0123456789abcdef-never-shown';
const TOOLS = [
    { name: 'search', description: 'Find a contact', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'update', description: 'Change a contact', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: 'erase', description: 'Delete a contact' },
];

/* handleApi's arguments by name (it takes them in a row). */
const PARAMS = /handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.split('=')[0].trim());

function bench(t, { fail = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mcpx-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vms = new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']);
    const secrets = new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms, grants: new Grants() });
    /* A fake MCP connector: it is handed the key host-side (and, failing, says it back as a careless server would). */
    const handed = [];
    const mcp = {
        name: 'mcp',
        async discover(target, ctx) {
            const key = target.secrets?.token ? await ctx.secret('token') : '';
            handed.push(key);
            if (fail) throw new Error(`401 for key ${key}`);
            return TOOLS;
        },
        async run() { return { text: 'ok', size: 2 }; },
        forget() {}, attach() {},
    };
    const work = join(dir, 'work'); mkdirSync(work);
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha'], secrets, connectors: { mcp } });
    const call = async (method, path, body) => {
        const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        const named = { conversations: { list: () => [{ name: 'alpha', phase: 'ready' }] }, headers: {}, originOk: () => true, secrets, tethers };
        await handleApi(request, response, ...PARAMS.slice(2).map((p) => named[p]));
        return { status, text, body: JSON.parse(text) };
    };
    return { dir, secrets, tethers, handed, call };
}

/* Every line written to the console meanwhile. */
function capture(t) {
    const lines = [];
    for (const k of ['log', 'error', 'warn', 'info', 'debug']) { const was = console[k]; console[k] = (...a) => { lines.push(a.map(String).join(' ')); }; t.after(() => { console[k] = was; }); }
    for (const s of [process.stdout, process.stderr]) { const was = s.write; s.write = function (chunk, ...rest) { lines.push(String(chunk)); return was.call(this, chunk, ...rest); }; t.after(() => { s.write = was; }); }
    return lines;
}
/* Every file of a folder, read whole. */
const filesOf = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, 'utf8'));

test('a server is added with its key: kept host-only as MCP_<ID>_KEY, Tether given its name; the key in no answer, log or Tether file', async (t) => {
    const lines = capture(t);
    const b = bench(t);
    const r = await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: 'https://mcp.example.com/mcp', key: KEY });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.id, 'sales-crm');
    assert.equal(r.body.kind, 'mcp');
    assert.deepEqual(r.body.secrets, ['token'], 'the slot\'s name only');
    assert.deepEqual(r.body.catalog.tools.map((x) => [x.name, x.class]), [['search', 'read'], ['update', 'write'], ['erase', 'destructive']], 'a tool without annotations is destructive');
    assert.ok(!r.text.includes(KEY));
    assert.deepEqual(b.handed, [KEY], 'the connector got it, host-side');
    assert.equal(keyName('sales-crm'), 'MCP_SALES_CRM_KEY');
    assert.equal(b.secrets.reveal('MCP_SALES_CRM_KEY'), KEY);
    assert.equal(b.secrets.list({ held: true }).find((s) => s.name === 'MCP_SALES_CRM_KEY').hostOnly, true);
    assert.ok(!b.secrets.list().some((s) => s.name === 'MCP_SALES_CRM_KEY'), 'not among the secrets a machine can be handed');
    assert.equal(b.tethers.store().target('sales-crm').secrets.token, 'MCP_SALES_CRM_KEY', 'Tether holds the name');
    const state = await b.call('GET', '/api/tether');
    assert.ok(!state.text.includes(KEY));
    for (const text of filesOf(join(b.dir, 'tether'))) assert.ok(!text.includes(KEY), 'never in the keeper\'s store or journal');
    assert.ok(!lines.some((l) => l.includes(KEY)), 'never in a log line');
});

test('a server that says the key back in its error: the answer never shows it, and a key kept for nothing goes', async (t) => {
    const lines = capture(t);
    const b = bench(t, { fail: true });
    const r = await b.call('POST', '/api/tether/mcp-add', { name: 'crm', url: 'https://mcp.example.com/mcp', key: KEY });
    assert.ok(!r.text.includes(KEY), r.text);
    assert.ok(r.body.error, 'not reached: said');
    const bad = await b.call('POST', '/api/tether/mcp-add', { name: 'other', url: 'ftp://mcp.example.com', key: KEY });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes(KEY));
    assert.equal(b.secrets.reveal('MCP_OTHER_KEY'), undefined, 'nothing made: its key not kept');
    assert.ok(!lines.some((l) => l.includes(KEY)));
});

test('an import: keys named as secrets; a stdio command, env or a written value refused', async (t) => {
    const b = bench(t);
    b.secrets.set({ name: 'CRM_KEY', value: KEY, hostOnly: true });
    const stdio = await b.call('POST', '/api/tether/mcp-import', { config: JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['some-server'] } } }) });
    assert.equal(stdio.status, 400);
    assert.match(stdio.body.error, /stdio/);
    const value = await b.call('POST', '/api/tether/mcp-import', { config: { mcpServers: { crm: { url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${KEY}` } } } } });
    assert.equal(value.status, 400);
    assert.ok(!value.text.includes(KEY), 'the value is never said back');
    const unknown = await b.call('POST', '/api/tether/mcp-import', { config: { mcpServers: { crm: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${NOPE_KEY}' } } } } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /NOPE_KEY/);
    assert.equal(b.tethers.store().targets().filter((x) => x.kind === 'mcp').length, 0, 'nothing made');
    const ok = await b.call('POST', '/api/tether/mcp-import', { config: JSON.stringify({ mcpServers: { crm: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${CRM_KEY}' } } } }) });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(ok.body.servers.map((s) => s.id), ['crm']);
    assert.equal(b.tethers.store().target('crm').secrets.token, 'CRM_KEY');
    assert.deepEqual(b.handed, [KEY]);
    assert.ok(!ok.text.includes(KEY));
});

test('a conversation\'s rights: its level, then Custom by kind of tool, read back; Refresh lists again', async (t) => {
    const b = bench(t);
    await b.call('POST', '/api/tether/mcp-add', { name: 'crm', url: 'https://mcp.example.com/mcp', key: KEY });
    const agent = 'conversation:alpha';
    assert.equal((await b.call('POST', '/api/tether/mcp-rights', { target: 'crm', agent, classes: { write: 'yes' } })).status, 400, 'not given yet');
    assert.equal((await b.call('POST', '/api/tether/level', { target: 'crm', agent, level: 'frame' })).status, 200);
    const set = await b.call('POST', '/api/tether/mcp-rights', { target: 'crm', agent, classes: { write: 'yes', destructive: 'no' }, tools: { erase: 'ask' } });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.body.classes, { read: 'yes', write: 'yes', destructive: 'no' });
    const back = (await b.call('GET', '/api/tether')).body.targets.find((x) => x.id === 'crm').grants[agent];
    assert.equal(back.level, 'frame');
    assert.deepEqual(back.classes, { write: 'yes', destructive: 'no' });
    assert.deepEqual(back.tools, { erase: 'ask' });
    const undo = await b.call('POST', '/api/tether/mcp-rights', { target: 'crm', agent, classes: { destructive: null } });
    assert.deepEqual(undo.body.classes, { read: 'yes', write: 'yes', destructive: 'ask' }, 'null takes it back');
    assert.equal((await b.call('POST', '/api/tether/mcp-rights', { target: 'crm', agent, classes: { write: 'maybe' } })).status, 400);
    assert.equal((await b.call('POST', '/api/tether/mcp-rights', { target: 'crm', agent: 'person:x', classes: { write: 'yes' } })).status, 400);
    const again = await b.call('POST', '/api/tether/mcp-refresh', { target: 'crm' });
    assert.equal(again.status, 200);
    assert.equal(again.body.catalog.tools.length, 3);
    assert.equal(b.handed.length, 2);
    assert.equal((await b.call('POST', '/api/tether/mcp-refresh', { target: 'nope' })).status, 404);
});

test('a server taken away takes its key with it', async (t) => {
    const b = bench(t);
    await b.call('POST', '/api/tether/mcp-add', { name: 'crm', url: 'https://mcp.example.com/mcp', key: KEY });
    assert.equal((await b.call('POST', '/api/tether/remove-target', { target: 'crm' })).status, 200);
    assert.equal(b.tethers.store().target('crm'), null);
    assert.equal(b.secrets.reveal('MCP_CRM_KEY'), undefined);
});

test('new tools marked seen: the op passed on, its answer given back; a Tether without it said plainly', async () => {
    const asked = [];
    const target = { id: 'crm', kind: 'mcp' };
    const tethers = (answer) => ({ store: () => ({ target: (id) => (id === 'crm' ? target : null) }), act: async (op, args) => { asked.push([op, args]); return answer; } });
    assert.deepEqual(await mcpSeen({ tethers: tethers({ ok: true, data: { seen: ['erase'] } }) }, { target: 'crm' }), { seen: ['erase'] });
    assert.deepEqual(await mcpSeen({ tethers: tethers({ ok: true, data: { seen: [] } }) }, { target: 'crm', tools: ['update'] }), { seen: [] });
    assert.deepEqual(asked, [['mcp-seen', { target: 'crm' }], ['mcp-seen', { target: 'crm', tools: ['update'] }]]);
    await assert.rejects(mcpSeen({ tethers: tethers({ ok: false, text: 'there is no mcp-seen' }) }, { target: 'crm' }), (e) => e.status === 501);
    await assert.rejects(mcpSeen({ tethers: tethers({ ok: true }) }, { target: 'nope' }), (e) => e.status === 404);
    await assert.rejects(mcpSeen({ tethers: tethers({ ok: true }) }, { target: 'crm', tools: 'erase' }), (e) => e.status === 400);
});

test('a server\'s id and key name, from its name', () => {
    assert.equal(serverId('  Équipe CRM / Ventes '), 'equipe-crm-ventes');
    assert.equal(keyName(serverId('Équipe CRM')), 'MCP_EQUIPE_CRM_KEY');
    assert.ok(keyName(serverId('x'.repeat(200))).length <= 40);
});
