/* Signing in to an external MCP server with OAuth (mcpoauth.mjs), against a fake authorization server: discovery
 * from the 401, a client registered by itself (or a client id pasted), the code with PKCE and `resource`, back to
 * this server's own address; the tokens kept host-only as MCP_<ID>_TOK, Tether handed only that name, the
 * connector given a fresh access token, refreshed when due; no token in an answer, a page, a log or Tether's files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { McpOAuth, tokenName, BACK_PATH } from '../server/mcpoauth.mjs';

const SERVER = 'https://mcp.example.com/mcp';
const AUTH = 'https://auth.example.com';
const ORIGIN = 'https://clav.example.com';
const KEY = 'sk-old-key-never-shown-0123456789';

/* A fake MCP server and its authorization server, answering by URL. Every token it mints is remembered, so a test
   can look for each of them where none may be. */
function provider({ register = true, rotate = true, life = 3600, prmResource = SERVER, s256 = true } = {}) {
    const minted = [];
    const seen = { registered: [], codes: new Map(), tokenCalls: [] };
    let n = 0;
    const mint = (kind) => { const v = `${kind}-${++n}-${'x'.repeat(24)}`; minted.push(v); return v; };
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    async function fetch(url, init = {}) {
        const u = new URL(url);
        const method = init.method ?? 'GET';
        if (u.href === SERVER && method === 'POST') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="crm.read crm.write"` });
        if (u.href === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') return json(200, { resource: prmResource, authorization_servers: [AUTH] });
        if (u.href === `${AUTH}/.well-known/oauth-authorization-server`) {
            return json(200, { issuer: AUTH, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token`, ...(register ? { registration_endpoint: `${AUTH}/register` } : {}),
                code_challenge_methods_supported: s256 ? ['S256'] : ['plain'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'] });
        }
        if (u.href === `${AUTH}/register` && method === 'POST') { const b = JSON.parse(init.body); seen.registered.push(b); return json(201, { client_id: 'client-made-1', redirect_uris: b.redirect_uris }); }
        if (u.href === `${AUTH}/token` && method === 'POST') {
            const f = Object.fromEntries(new URLSearchParams(init.body));
            seen.tokenCalls.push(f);
            if (f.grant_type === 'authorization_code') {
                const c = seen.codes.get(f.code);
                if (!c || c.redirect_uri !== f.redirect_uri || c.client_id !== f.client_id || f.resource !== SERVER) return json(400, { error: 'invalid_grant' });
                if (createHash('sha256').update(f.code_verifier).digest('base64url') !== c.code_challenge) return json(400, { error: 'invalid_grant' });
                seen.codes.delete(f.code);
                return json(200, { access_token: mint('at'), refresh_token: mint('rt'), expires_in: life, token_type: 'Bearer' });
            }
            if (f.grant_type === 'refresh_token') {
                if (!minted.includes(f.refresh_token) || seen.revoked) return json(400, { error: 'invalid_grant' });
                return json(200, { access_token: mint('at'), ...(rotate ? { refresh_token: mint('rt') } : {}), expires_in: life });
            }
        }
        return json(404, { error: 'not_found' });
    }
    /* The owner allows it in their browser: the provider sends a code back to the redirect. */
    function allow(consent) {
        const q = new URL(consent).searchParams;
        const code = mint('code');
        seen.codes.set(code, { redirect_uri: q.get('redirect_uri'), client_id: q.get('client_id'), code_challenge: q.get('code_challenge') });
        return { code, state: q.get('state') };
    }
    return { fetch, allow, minted, seen };
}

const PARAMS = /handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.split('=')[0].trim());

function bench(t, options) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mcpoauth-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vms = new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']);
    const secrets = new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms, grants: new Grants() });
    const p = provider(options);
    let clock = Date.parse('2026-11-14T10:00:00Z');
    const now = () => clock;
    /* A fake MCP connector: what it is handed for its Authorization header, host-side. */
    const handed = [];
    const mcp = {
        name: 'mcp',
        async discover(target, ctx) { handed.push(target.secrets?.token ? await ctx.secret('token') : ''); return [{ name: 'search', annotations: { readOnlyHint: true } }]; },
        async run() { return { text: 'ok', size: 2 }; },
        forget() {}, attach() {},
    };
    const work = join(dir, 'work'); mkdirSync(work);
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha'], secrets, connectors: { mcp } });
    tethers.oauth = new McpOAuth({ secrets, fetch: p.fetch, now });
    const call = async (method, path, body) => {
        const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json', host: 'clav.example.com' } });
        let status; let text = ''; let type = '';
        const response = { writeHead: (s, h) => { status = s; type = h?.['content-type'] ?? ''; return { end: (x) => { text = String(x); } }; } };
        const named = { conversations: { list: () => [{ name: 'alpha', phase: 'ready' }] }, headers: {}, originOk: () => true, secrets, tethers, sharing: { origin: () => ORIGIN } };
        await handleApi(request, response, ...PARAMS.slice(2).map((x) => named[x]));
        let parsed = null; try { parsed = JSON.parse(text); } catch { /* a page */ }
        return { status, text, type, body: parsed };
    };
    return { dir, secrets, tethers, p, handed, call, tick: (ms) => { clock += ms; } };
}

function capture(t) {
    const lines = [];
    for (const k of ['log', 'error', 'warn', 'info', 'debug']) { const was = console[k]; console[k] = (...a) => { lines.push(a.map(String).join(' ')); }; t.after(() => { console[k] = was; }); }
    return lines;
}
const filesOf = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, 'utf8'));
const noToken = (b, text, what) => { for (const v of b.p.minted) assert.ok(!String(text).includes(v), `${what}: no token`); };

/* Added with a key, then signed in: the whole way, through the routes. */
async function signedIn(t, b) {
    const add = await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: SERVER, key: KEY });
    assert.equal(add.status, 201, add.text);
    const start = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    assert.equal(start.status, 200, start.text);
    const back = b.p.allow(start.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${encodeURIComponent(back.code)}&state=${encodeURIComponent(back.state)}`);
    return { start, page };
}

test('signed in through the routes: discovery from the 401, a client registered, PKCE and resource, back to this server\'s own address', async (t) => {
    const lines = capture(t);
    const b = bench(t);
    const { start, page } = await signedIn(t, b);
    const q = new URL(start.body.url).searchParams;
    assert.equal(new URL(start.body.url).origin + new URL(start.body.url).pathname, `${AUTH}/authorize`);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), 'client-made-1', 'registered by itself');
    assert.equal(q.get('redirect_uri'), `${ORIGIN}${BACK_PATH}`, 'back to this server, nothing to paste');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('resource'), SERVER);
    assert.equal(q.get('scope'), 'crm.read crm.write', 'the scope the 401 asked for');
    assert.deepEqual(b.p.seen.registered[0].redirect_uris, [`${ORIGIN}${BACK_PATH}`]);
    assert.equal(b.p.seen.registered[0].token_endpoint_auth_method, 'none', 'a public client');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /Signed in to Sales CRM/);
    const name = tokenName('sales-crm');
    assert.equal(name, 'MCP_SALES_CRM_TOK');
    assert.equal(b.tethers.store().target('sales-crm').secrets.token, name, 'Tether holds the name');
    assert.equal(b.secrets.list({ held: true }).find((s) => s.name === name).hostOnly, true);
    assert.ok(!b.secrets.list().some((s) => s.name === name), 'never among what a machine can be handed');
    assert.equal(b.secrets.reveal('MCP_SALES_CRM_KEY'), undefined, 'the key it replaced is gone');
    assert.equal(b.handed.at(-1), b.p.minted.find((v) => v.startsWith('at-')), 'the connector got the access token, host-side');
    const state = await b.call('GET', '/api/tether');
    noToken(b, state.text, 'the page\'s state'); noToken(b, start.text, 'the start'); noToken(b, page.text, 'the page back');
    for (const text of filesOf(join(b.dir, 'tether'))) noToken(b, text, 'Tether\'s store and journal');
    for (const l of lines) { noToken(b, l, 'a log line'); assert.ok(!l.includes(KEY)); }
});

test('the connector is given a fresh token: refreshed when near its end, once for calls at the same time, a rotated refresh token kept', async (t) => {
    const b = bench(t, { life: 600 });
    await signedIn(t, b);
    const name = tokenName('sales-crm');
    const first = await b.tethers.oauth.access(name);
    assert.equal(await b.tethers.oauth.access(name), first, 'still valid: no refresh');
    b.tick(560_000);
    const [x, y] = await Promise.all([b.tethers.oauth.access(name), b.tethers.oauth.access(name)]);
    assert.equal(x, y);
    assert.notEqual(x, first, 'refreshed');
    assert.equal(b.p.seen.tokenCalls.filter((c) => c.grant_type === 'refresh_token').length, 1, 'one refresh');
    assert.equal(b.p.seen.tokenCalls.at(-1).resource, SERVER);
    b.tick(600_000);
    const third = await b.tethers.oauth.access(name);
    assert.notEqual(third, x, 'refreshed again with the rotated refresh token');
    assert.equal(await b.tethers.oauth.access('SOME_OTHER_SECRET'), undefined, 'not ours: revealed as it is');
    const refreshed = await b.call('POST', '/api/tether/mcp-refresh', { target: 'sales-crm' });
    assert.equal(b.handed.at(-1), third, 'Tether reaches the server with the current token');
    noToken(b, refreshed.text, 'a refresh of its tools');
});

test('signed out at the provider: said plainly, never a token in the error', async (t) => {
    const b = bench(t, { life: 60 });
    await signedIn(t, b);
    b.p.seen.revoked = true;
    b.tick(120_000);
    await assert.rejects(b.tethers.oauth.access(tokenName('sales-crm')), (e) => { noToken(b, e.message, 'the error'); return /sign in again/.test(e.message); });
});

test('no registration offered: the page is asked for a client id, then it goes on with it', async (t) => {
    const b = bench(t, { register: false });
    await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: SERVER });
    const need = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    assert.deepEqual(need.body, { need: 'client' });
    const start = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm', clientId: 'pasted-client' });
    assert.equal(new URL(start.body.url).searchParams.get('client_id'), 'pasted-client');
    const back = b.p.allow(start.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${back.code}&state=${back.state}`);
    assert.match(page.text, /Signed in/);
});

test('refused: a forged or used state, a denied consent, metadata about another address, no PKCE', async (t) => {
    const b = bench(t);
    const { start } = await signedIn(t, b);
    const again = await b.call('GET', `${BACK_PATH}?code=whatever&state=${new URL(start.body.url).searchParams.get('state')}`);
    assert.match(again.text, /expired or was already used/, 'a state serves once');
    const forged = await b.call('GET', `${BACK_PATH}?code=whatever&state=forged`);
    assert.match(forged.text, /expired or was already used/);
    const s2 = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    const denied = await b.call('GET', `${BACK_PATH}?error=access_denied&state=${new URL(s2.body.url).searchParams.get('state')}`);
    assert.match(denied.text, /not allowed \(access_denied\)/);
    const none = await b.call('POST', '/api/tether/mcp-oauth', { target: 'nope' });
    assert.equal(none.status, 404);
    const other = bench(t, { prmResource: 'https://elsewhere.example.com/mcp' });
    await other.call('POST', '/api/tether/mcp-add', { name: 'crm', url: SERVER });
    const mismatch = await other.call('POST', '/api/tether/mcp-oauth', { target: 'crm' });
    assert.equal(mismatch.status, 502);
    assert.match(mismatch.body.error, /another address/);
    const plain = bench(t, { s256: false });
    await plain.call('POST', '/api/tether/mcp-add', { name: 'crm', url: SERVER });
    const noPkce = await plain.call('POST', '/api/tether/mcp-oauth', { target: 'crm' });
    assert.match(noPkce.body.error, /PKCE/);
});

test('a server taken away: its tokens go too; a key given again replaces them', async (t) => {
    const b = bench(t);
    await signedIn(t, b);
    const name = tokenName('sales-crm');
    const keyed = await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: SERVER, key: KEY });
    assert.equal(keyed.status, 201);
    assert.equal(b.secrets.reveal(name), undefined, 'the key replaced the tokens');
    await signedIn(t, b);
    assert.ok(b.secrets.reveal(name));
    const gone = await b.call('POST', '/api/tether/remove-target', { target: 'sales-crm' });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(b.secrets.reveal(name), undefined);
});
