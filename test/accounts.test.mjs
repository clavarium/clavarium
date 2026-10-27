import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../server/vault.mjs';
import { Secrets } from '../server/secrets.mjs';
import { Store } from '../server/store.mjs';
import { Grants } from '../server/grants.mjs';
import { Vms } from '../server/vm.mjs';
import { Accounts } from '../server/accounts.mjs';

/* A real vault + secret store, a tiny in-memory Tether target store, and a fetch
   that answers the token exchange with a refresh token. */
function bench(t, { token = 'refresh-abc-123', tokenCalls } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-acc-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vms = new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']);
    const secrets = new Secrets({ store: new Store(join(dir, 'secrets.json')), vault: new Vault(join(dir, 'vault.key')), vms, grants: new Grants() });
    const made = new Map();
    const targets = { put: (spec) => { made.set(spec.id, structuredClone(spec)); return structuredClone(spec); }, all: () => [...made.values()] };
    const fetch = async () => {
        tokenCalls?.push(true);
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: token === null ? undefined : token, expires_in: 3600, scope: 'x' }) };
    };
    return { dir, secrets, targets, made, accounts: new Accounts({ secrets, targets, fetch }) };
}

/* Drive a consent through to the pasted redirect: returns the connect() result. */
async function connect(accounts, { provider, user, kinds }) {
    const { url } = accounts.consent({ provider, user, kinds });
    const state = new URL(url).searchParams.get('state');
    return accounts.connect({ redirected: `http://127.0.0.1:47813/?code=the-code&state=${state}` });
}

test('consent builds the provider page with the scopes for the kinds asked, and keeps a state', (t) => {
    const b = bench(t);
    const { url } = b.accounts.consent({ provider: 'google', user: 'alice@example.com', kinds: ['mail', 'calendar', 'contacts'] });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/auth');
    const scope = u.searchParams.get('scope');
    assert.ok(scope.includes('https://mail.google.com/'), 'mail scope');
    assert.ok(scope.includes('/auth/calendar'), 'calendar scope');
    assert.ok(scope.includes('/auth/carddav'), 'contacts scope');
    assert.ok(u.searchParams.get('state'), 'a state ties the consent to its reply');
    assert.equal(u.searchParams.get('login_hint'), 'alice@example.com');
    assert.equal(u.searchParams.get('access_type'), 'offline', 'offline, so a refresh token comes back');
});

test('both providers consent on the same copy-pastable loopback redirect', (t) => {
    const b = bench(t);
    const g = new URL(b.accounts.consent({ provider: 'google', user: 'a@example.com', kinds: ['mail'] }).url);
    assert.match(g.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:47813\//);
    const m = new URL(b.accounts.consent({ provider: 'microsoft', user: 'a@example.com', kinds: ['mail'] }).url);
    assert.match(m.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:47813\//);
});

test('a Google connect keeps the token host-only and makes one target per kind, all naming it', async (t) => {
    const calls = [];
    const b = bench(t, { tokenCalls: calls });
    const res = await connect(b.accounts, { provider: 'google', user: 'alice@example.com', kinds: ['mail', 'calendar', 'contacts'] });
    assert.equal(calls.length, 1, 'the code was traded once');
    assert.deepEqual(res.targets.map((x) => x.kind).sort(), ['calendar', 'contacts', 'mail']);
    /* One host-only secret, named by each target, holding the refresh token. */
    const secretRow = b.secrets.list({ held: true }).find((s) => s.hostOnly);
    assert.ok(secretRow, 'a host-only secret was created');
    assert.equal(b.secrets.reveal(secretRow.name), 'refresh-abc-123', 'the token is kept, revealed host-side');
    for (const t2 of b.made.values()) assert.equal(t2.secrets.refresh, secretRow.name, 'every target names that one secret');
    /* It can never reach a machine. */
    assert.throws(() => b.secrets.attach('alpha', secretRow.name, true), /held by the server/);
    /* The mail target carries the address; calendar does not need it. */
    const mail = [...b.made.values()].find((x) => x.kind === 'mail');
    assert.equal(mail.config.user, 'alice@example.com');
    assert.equal(mail.config.provider, 'google');
    /* The minting client is pinned on every target, so refresh uses the same one. */
    for (const t2 of b.made.values()) assert.ok(t2.config.clientId, 'the client id is pinned on the target');
    assert.equal([...b.made.values()].find((x) => x.kind === 'calendar').config.user, undefined);
});

test('a created target is given to no conversation: the person grants it afterwards', async (t) => {
    const b = bench(t);
    await connect(b.accounts, { provider: 'google', user: 'bob@example.com', kinds: ['mail'] });
    for (const target of b.made.values()) assert.deepEqual(target.grants ?? {}, {}, 'no grant at birth');
});

test('Microsoft connects mail, calendar and contacts (all over Graph)', async (t) => {
    const b = bench(t);
    const res = await connect(b.accounts, { provider: 'microsoft', user: 'carol@example.com', kinds: ['mail', 'calendar', 'contacts'] });
    assert.deepEqual(res.targets.map((x) => x.kind).sort(), ['calendar', 'contacts', 'mail']);
});

test('a partial grant makes a target only for the kinds actually allowed, and names the denied', async (t) => {
    const b = bench(t);
    /* The provider grants only the mail scope, though all three were asked. */
    const accounts = new Accounts({ secrets: b.secrets, targets: b.targets, fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'r', expires_in: 3600, scope: 'https://mail.google.com/' }) }) });
    const res = await connect(accounts, { provider: 'google', user: 'grace@example.com', kinds: ['mail', 'calendar', 'contacts'] });
    assert.deepEqual(res.targets.map((x) => x.kind), ['mail'], 'only the mail target is made');
    assert.deepEqual(res.authorized, ['mail']);
    assert.deepEqual([...res.denied].sort(), ['calendar', 'contacts'], 'the two it did not grant are reported');
});

test('verify reads an account\'s current permissions live and records them on its targets', async (t) => {
    const b = bench(t);
    await connect(b.accounts, { provider: 'google', user: 'ivan@example.com', kinds: ['mail', 'calendar', 'contacts'] });
    const target = [...b.made.values()][0];
    /* A later check where the provider now reports only the mail scope. */
    const accounts = new Accounts({ secrets: b.secrets, targets: b.targets, fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'r2', expires_in: 3600, scope: 'https://mail.google.com/' }) }) });
    const res = await accounts.verify({ id: target.id });
    assert.deepEqual(res.authorized, ['mail'], 'it reads what is allowed now');
    assert.deepEqual([...res.all].sort(), ['calendar', 'contacts', 'mail']);
    for (const x of b.made.values()) assert.deepEqual(x.config.authorizedKinds, ['mail'], 'every target of the account records it');
    await assert.rejects(accounts.verify({ id: 'nope' }), /No such connexion/);
});

test('when the scope cannot be read, every asked kind is trusted (no false denial)', async (t) => {
    const b = bench(t);
    /* The default bench returns scope:"x" -- unmatched; fall back to the request. */
    const res = await connect(b.accounts, { provider: 'google', user: 'heidi@example.com', kinds: ['mail', 'calendar'] });
    assert.deepEqual(res.targets.map((x) => x.kind).sort(), ['calendar', 'mail']);
    assert.deepEqual(res.denied, []);
});

test('reconnecting the same account reuses the secret name and replaces the token', async (t) => {
    const first = bench(t, { token: 'token-one' });
    await connect(first.accounts, { provider: 'google', user: 'dave@example.com', kinds: ['mail'] });
    const name = first.secrets.list({ held: true }).find((s) => s.hostOnly).name;
    /* A second connect for the same account, with a new token value. */
    const again = new Accounts({ secrets: first.secrets, targets: first.targets, fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'token-two', expires_in: 3600 }) }) });
    await connect(again, { provider: 'google', user: 'dave@example.com', kinds: ['mail'] });
    assert.deepEqual(first.secrets.list({ held: true }).filter((s) => s.hostOnly).map((s) => s.name), [name], 'the same one host-only secret');
    assert.equal(first.secrets.reveal(name), 'token-two', 'its value is the new token');
});

test('a stray or expired reply is refused; a bad provider or address too', async (t) => {
    const b = bench(t);
    await assert.rejects(b.accounts.connect({ redirected: 'http://127.0.0.1:47813/?code=x&state=never-seen' }), /expired or was already used/);
    await assert.rejects(b.accounts.connect({ redirected: 'not a url' }), /whole address/);
    assert.throws(() => b.accounts.consent({ provider: 'yahoo', user: 'a@example.com' }), /Google or Microsoft/);
    assert.throws(() => b.accounts.consent({ provider: 'google', user: 'not-an-email' }), /email address/);
});

test('a consent used once cannot be used again', async (t) => {
    const b = bench(t);
    const { url } = b.accounts.consent({ provider: 'google', user: 'eve@example.com', kinds: ['mail'] });
    const state = new URL(url).searchParams.get('state');
    const redirected = `http://127.0.0.1:47813/?code=c&state=${state}`;
    await b.accounts.connect({ redirected });
    await assert.rejects(b.accounts.connect({ redirected }), /expired or was already used/);
});

test('a provider that returns no refresh token is a clear refusal', async (t) => {
    const b = bench(t, { token: null });
    await assert.rejects(connect(b.accounts, { provider: 'google', user: 'frank@example.com', kinds: ['mail'] }), /could not be completed|no lasting token/);
});
