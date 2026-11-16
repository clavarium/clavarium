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
function provider({ register = true, rotate = true, life = 3600, prmResource = SERVER, s256 = true, methods = ['none', 'client_secret_post'], secret = '', slack = false, refuse = '' } = {}) {
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
                code_challenge_methods_supported: s256 ? ['S256'] : ['plain'], ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}) });
        }
        if (u.href === `${AUTH}/register` && method === 'POST') { const b = JSON.parse(init.body); seen.registered.push(b); return json(201, { client_id: 'client-made-1', redirect_uris: b.redirect_uris }); }
        if (u.href === `${AUTH}/token` && method === 'POST') {
            const f = Object.fromEntries(new URLSearchParams(init.body));
            const basic = /^Basic (.+)$/.exec(String(init.headers?.authorization ?? ''));
            if (basic) { const [id, pw] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent); f.client_id = id; f.basic_secret = pw; }
            seen.tokenCalls.push(f);
            /* A confidential client (16-11): its secret, by post or basic; Slack's way of refusing, 200 { ok: false }. */
            if (secret && (f.client_secret ?? f.basic_secret) !== secret) return slack ? json(200, { ok: false, error: 'bad_client_secret' }) : json(401, { error: 'invalid_client' });
            if (refuse) return slack ? json(200, { ok: false, error: refuse }) : json(400, { error: refuse });
            if (f.grant_type === 'authorization_code') {
                const c = seen.codes.get(f.code);
                if (!c || c.redirect_uri !== f.redirect_uri || c.client_id !== f.client_id || f.resource !== SERVER) return json(400, { error: 'invalid_grant' });
                if (createHash('sha256').update(f.code_verifier).digest('base64url') !== c.code_challenge) return json(400, { error: 'invalid_grant' });
                seen.codes.delete(f.code);
                if (slack) return json(200, { ok: true, authed_user: { id: 'U1', access_token: mint('at'), token_type: 'user', ...(rotate ? { refresh_token: mint('rt'), expires_in: life } : {}) } });
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
    assert.match(page.text, /Connected to Sales CRM/);
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
    await assert.rejects(b.tethers.oauth.access(tokenName('sales-crm')), (e) => { noToken(b, e.message, 'the error'); return /reconnect/.test(e.message) && e.reconnect === true; });
});

test('no registration offered: the page is asked for a client id, then it goes on with it', async (t) => {
    const b = bench(t, { register: false });
    await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: SERVER });
    const need = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    assert.equal(need.body.need, 'client');
    assert.equal(need.body.secret, false, 'this service takes public clients');
    const start = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm', clientId: 'pasted-client' });
    assert.equal(new URL(start.body.url).searchParams.get('client_id'), 'pasted-client');
    const back = b.p.allow(start.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${back.code}&state=${back.state}`);
    assert.match(page.text, /Connected to Sales CRM/);
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

/* A CONFIDENTIAL CLIENT (16-11), as Slack's: no registration, only client_secret_post. The page is asked for the id
   AND the secret, given the address its app must name and the permissions offered; the secret goes to the token
   endpoint, is kept host-only with the id, never said back; a second sign-in needs no paste; only the permissions
   the owner kept are asked. */
const SECRET = 'client-secret-never-shown-0123456789';
test('a confidential client: id and secret asked, the secret kept host-only and sent as the service says, the kept permissions only', async (t) => {
    const lines = capture(t);
    const b = bench(t, { register: false, methods: ['client_secret_post'], secret: SECRET });
    await b.call('POST', '/api/tether/mcp-add', { name: 'Sales CRM', url: SERVER });
    const need = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    assert.equal(need.body.need, 'client');
    assert.equal(need.body.secret, true, 'a secret is asked: the service takes no public client');
    assert.equal(need.body.redirect, `${ORIGIN}${BACK_PATH}`, 'the address its app must name');
    assert.deepEqual(need.body.scopes, ['crm.read', 'crm.write']);
    const half = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm', clientId: 'app-1' });
    assert.equal(half.body.missing, 'secret', 'an id alone is not enough here');
    const start = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm', clientId: 'app-1', clientSecret: ` ${SECRET} `, scope: 'crm.read', lang: 'fr', back: '/?c=alpha' });
    assert.equal(start.status, 200, start.text);
    assert.equal(new URL(start.body.url).searchParams.get('scope'), 'crm.read', 'only what the owner kept');
    const back = b.p.allow(start.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${back.code}&state=${back.state}`);
    assert.match(page.text, /Connecté à Sales CRM/, 'said in the page\'s language');
    assert.match(page.text, /lang="fr"/);
    assert.match(page.text, /href="\/\?c=alpha"/, 'a way back to where the owner was');
    const call = b.p.seen.tokenCalls.at(-1);
    assert.equal(call.client_secret, SECRET, 'sent by post, as the metadata says');
    const kept = b.secrets.list({ held: true }).find((s) => s.name === 'MCP_SALES_CRM_CLI');
    assert.equal(kept?.hostOnly, true, 'the client kept host-only');
    assert.ok(!b.secrets.list().some((s) => s.name === 'MCP_SALES_CRM_CLI'));
    /* Again, nothing pasted: the client kept, its permissions too. */
    const again = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm' });
    assert.equal(new URL(again.body.url).searchParams.get('client_id'), 'app-1');
    assert.equal(new URL(again.body.url).searchParams.get('scope'), 'crm.read');
    const state = await b.call('GET', '/api/tether');
    for (const text of [need.text, half.text, start.text, again.text, page.text, state.text, ...filesOf(join(b.dir, 'tether')), ...lines]) assert.ok(!text.includes(SECRET), 'the secret never said back');
    /* Taken away: its client goes too. */
    await b.call('POST', '/api/tether/remove-target', { target: 'sales-crm' });
    assert.equal(b.secrets.reveal('MCP_SALES_CRM_CLI'), undefined);
});

test('basic where the service says only basic; Slack\'s answers: the token under authed_user, a refusal in a 200, said plainly', async (t) => {
    const b = bench(t, { register: false, methods: ['client_secret_basic'], secret: SECRET, slack: true, rotate: false });
    await b.call('POST', '/api/tether/mcp-add', { name: 'Chat', url: SERVER });
    const start = await b.call('POST', '/api/tether/mcp-oauth', { target: 'chat', clientId: 'app:2', clientSecret: SECRET });
    const back = b.p.allow(start.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${back.code}&state=${back.state}`);
    assert.match(page.text, /Connected to Chat/);
    const call = b.p.seen.tokenCalls.at(-1);
    assert.equal(call.basic_secret, SECRET, 'by basic');
    assert.equal(call.client_secret, undefined, 'not in the form too');
    assert.ok(await b.tethers.oauth.access(tokenName('chat')), 'the token read under authed_user');
    /* No refresh token, refused at once: the owner must reconnect, said so. */
    await assert.rejects(b.tethers.oauth.access(tokenName('chat'), { fresh: true }), (e) => e.reconnect === true);
    const wrong = bench(t, { register: false, methods: ['client_secret_post'], secret: SECRET, slack: true });
    await wrong.call('POST', '/api/tether/mcp-add', { name: 'Chat', url: SERVER });
    const s2 = await wrong.call('POST', '/api/tether/mcp-oauth', { target: 'chat', clientId: 'app', clientSecret: 'not-it', lang: 'fr' });
    const b2 = wrong.p.allow(s2.body.url);
    const p2 = await wrong.call('GET', `${BACK_PATH}?code=${b2.code}&state=${b2.state}`);
    assert.match(p2.text, /identifiant ou le secret client/, 'the client refused, said in French');
    assert.match(p2.text, /bad_client_secret/, 'the service\'s word under it');
    const scope = bench(t, { register: false, methods: ['client_secret_post'], secret: SECRET, slack: true, refuse: 'invalid_scope' });
    await scope.call('POST', '/api/tether/mcp-add', { name: 'Chat', url: SERVER });
    const s3 = await scope.call('POST', '/api/tether/mcp-oauth', { target: 'chat', clientId: 'app', clientSecret: SECRET });
    const b3 = scope.p.allow(s3.body.url);
    assert.match((await scope.call('GET', `${BACK_PATH}?code=${b3.code}&state=${b3.state}`)).text, /refused the permissions asked/);
});

test('a token refused before its end: refreshed at once when asked fresh; a way back only to this site; in the same tab, back by itself', async (t) => {
    const b = bench(t);
    await signedIn(t, b);
    const name = tokenName('sales-crm');
    const first = await b.tethers.oauth.access(name);
    const fresh = await b.tethers.oauth.access(name, { fresh: true });
    assert.notEqual(fresh, first, 'refreshed although not due');
    assert.equal(await b.tethers.oauth.access(name), fresh);
    b.p.seen.revoked = true;
    await assert.rejects(b.tethers.oauth.access(name, { fresh: true }), (e) => e.reconnect === true && /reconnect/.test(e.message));
    const s = await b.call('POST', '/api/tether/mcp-oauth', { target: 'sales-crm', back: '//elsewhere.example.com/x', tab: 'same' });
    const back = b.p.allow(s.body.url);
    const page = await b.call('GET', `${BACK_PATH}?code=${back.code}&state=${back.state}`);
    assert.match(page.text, /http-equiv="refresh" content="1;url=\/"/, 'back by itself, to this site only');
    assert.ok(!page.text.includes('elsewhere'));
    assert.ok(!page.text.includes('close this tab'), 'nothing to close: it is the page\'s own tab');
});
