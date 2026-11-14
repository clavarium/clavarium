/* SIGNING IN TO AN EXTERNAL MCP SERVER WITH OAUTH (14-11). Some services offer no key, only a sign-in. This is
 * the MCP authorization spec (2025-06-18) seen from the client: the server's 401 names its protected resource
 * metadata (RFC 9728), that names its authorization server, whose metadata (RFC 8414) gives the endpoints; a
 * client is registered by itself where the server offers it (RFC 7591), else the owner pastes a client id; then
 * an authorization code with PKCE (S256), the `resource` said at each step (RFC 8707), and refresh tokens.
 *
 * WHO DOES WHAT. The owner allows it in their own browser, from a link the Access page opens; the provider
 * sends the browser back to THIS server's own address (/api/tether/mcp-oauth/back, behind the same sign-in as
 * the page), which trades the code. Nothing to paste.
 *
 * THE TOKENS STAY HERE, like a key: one host-only secret of the vault (secrets.mjs: never put in a machine,
 * never listed on the page), named MCP_<ID>_TOK, holding the access token, the refresh token and what is needed
 * to refresh. Tether is handed only that NAME; when its connector asks for it (tethers.mjs, reveal), access()
 * answers a fresh access token, refreshed here first when it is near its end. No token is ever logged, said in
 * an error or returned by a route.
 *
 * `fetch` is injected, so the tests run against a fake authorization server with no network. */
import { Refusal } from './conversations.mjs';
import { pkcePair, newState } from './oauth.mjs';
import { KEY_PREFIX, keyName, oauthName } from './mcpx.mjs';

export const TOKEN_SUFFIX = '_TOK';
export const BACK_PATH = '/api/tether/mcp-oauth/back';
const PROTOCOL = '2025-06-18';
const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 20;
const FETCH_MS = 15_000;
/* Refreshed this long before its end: a call that starts now still has a valid token when it lands. */
const EARLY_MS = 60_000;
const KIND = 'mcp-oauth';

/* The vault's name for a server's tokens: as long as its key's name, so every server id fits. */
export const tokenName = oauthName;
export const isTokenName = (name) => typeof name === 'string' && name.startsWith(KEY_PREFIX) && name.endsWith(TOKEN_SUFFIX);

const oneLine = (x, n = 200) => String(x ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, n);

/* https only, but plain http where the owner allowed it for that server (a local network), or on this machine. */
function safeUrl(raw, allowHttp) {
    let u;
    try { u = new URL(String(raw ?? '')); } catch { return null; }
    if (u.username || u.password || u.hash) return null;
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (allowHttp || local))) return u;
    return null;
}

/* The resource a metadata names is this server: its origin, and its path or a parent of it. */
function sameResource(server, resource) {
    let r;
    try { r = new URL(String(resource)); } catch { return false; }
    const path = r.pathname.replace(/\/+$/, '');
    return r.origin === server.origin && (!path || server.pathname === path || server.pathname.startsWith(`${path}/`) || server.pathname === `${path}/`);
}

/* One field of a WWW-Authenticate: Bearer header, quoted or not. */
function authParam(header, key) {
    const m = new RegExp(`(?:^|[\\s,])${key}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, 'i').exec(String(header ?? ''));
    return m ? (m[1] ?? m[2]) : '';
}

/* The well-known addresses to try for a URL with a path (RFC 8414 / RFC 9728: inserted before the path). */
function wellKnown(base, suffix) {
    const u = new URL(base);
    const path = u.pathname.replace(/\/+$/, '');
    return path ? [`${u.origin}/.well-known/${suffix}${path}`, `${u.origin}/.well-known/${suffix}`] : [`${u.origin}/.well-known/${suffix}`];
}

export class McpOAuth {
    #secrets; #fetch; #now; #pending = new Map(); #refreshing = new Map();

    constructor({ secrets, fetch = globalThis.fetch, now = () => Date.now() }) {
        this.#secrets = secrets; this.#fetch = fetch; this.#now = now;
    }

    async #get(url, init = {}) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), FETCH_MS); timer.unref?.();
        try { return await this.#fetch(url, { redirect: 'manual', ...init, signal: abort.signal }); }
        finally { clearTimeout(timer); }
    }
    async #json(url, allowHttp) {
        if (!safeUrl(url, allowHttp)) return null;
        let res;
        try { res = await this.#get(url, { headers: { accept: 'application/json', 'mcp-protocol-version': PROTOCOL } }); } catch { return null; }
        if (!res.ok) return null;
        try { const j = await res.json(); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
    }

    /* FROM THE SERVER'S ADDRESS TO ITS AUTHORIZATION SERVER: { resource, meta, scope }. */
    async discover(serverUrl, { allowHttp = false } = {}) {
        const server = safeUrl(serverUrl, allowHttp);
        if (!server) throw new Refusal(400, 'The server\'s address must be https.');
        /* Asked as a client would, without a token: an OAuth server answers 401 and says where its metadata is. */
        let res;
        try {
            res = await this.#get(server.href, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
                body: JSON.stringify({ jsonrpc: '2.0', id: 'clv-oauth', method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Clavarium', version: '1' } } }) });
        } catch { throw new Refusal(502, 'The server could not be reached.'); }
        try { await res.body?.cancel?.(); } catch { /* nothing to read */ }
        if (res.ok) throw new Refusal(409, 'This server answers without signing in: no OAuth needed.');
        const challenge = res.status === 401 ? String(res.headers.get('www-authenticate') ?? '') : '';
        const scope = oneLine(authParam(challenge, 'scope'), 1000);
        const named = authParam(challenge, 'resource_metadata');
        const tries = [...(named ? [named] : []), ...wellKnown(server.href, 'oauth-protected-resource')];
        let prm = null;
        for (const at of tries) { prm = await this.#json(at, allowHttp); if (prm) break; }
        /* The metadata must be about this server (RFC 9728 s.3.3): another resource's would send its token here. */
        if (prm?.resource && !sameResource(server, prm.resource)) throw new Refusal(502, 'The server\'s metadata names another address: refused.');
        /* An older server (MCP 2025-03-26) has no such metadata: its own origin is its authorization server. */
        const issuer = Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length ? String(prm.authorization_servers[0]) : server.origin;
        if (!safeUrl(issuer, allowHttp)) throw new Refusal(502, 'The server\'s sign-in address is not https.');
        let meta = null;
        for (const at of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration'), `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`]) {
            meta = await this.#json(at, allowHttp); if (meta) break;
        }
        if (!meta || !safeUrl(meta.authorization_endpoint, allowHttp) || !safeUrl(meta.token_endpoint, allowHttp)) throw new Refusal(502, 'This server does not say how to sign in (no OAuth metadata).');
        if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes('S256')) throw new Refusal(502, 'This server does not offer PKCE (S256): refused.');
        const resource = oneLine(prm?.resource || server.href, 1000);
        return { resource, meta, scope: scope || (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.map(String).join(' ').slice(0, 1000) : '') };
    }

    /* A client registered by itself (RFC 7591), public (no secret) where the server allows it. */
    async #register(meta, redirectUri, allowHttp) {
        if (!safeUrl(meta.registration_endpoint, allowHttp)) return null;
        let res;
        try {
            res = await this.#get(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ client_name: 'Clavarium', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
        } catch { throw new Refusal(502, 'The server\'s registration could not be reached.'); }
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.client_id) throw new Refusal(502, `The server refused to register this Clavarium (HTTP ${res.status}).`);
        return { clientId: oneLine(j.client_id, 500), clientSecret: typeof j.client_secret === 'string' ? j.client_secret : '' };
    }

    /* START: { target, clientId?, clientSecret? } and this server's address -> { url } to open, or { need: 'client' }
       when the server registers no client by itself (the page then asks for its id). */
    async start({ tethers }, body = {}, origin = '') {
        const t = tethers.store().target(String(body.target ?? ''));
        if (!t || t.kind !== 'mcp') throw new Refusal(404, 'No such MCP server.');
        const allowHttp = t.config?.allowHttp === true;
        const back = safeUrl(`${String(origin).replace(/\/+$/, '')}${BACK_PATH}`, true);
        if (!back) throw new Refusal(500, 'This server does not know its own address.');
        const redirectUri = back.href;
        const { resource, meta, scope } = await this.discover(t.config?.url, { allowHttp });
        let client = null;
        const given = oneLine(body.clientId, 500);
        if (given) client = { clientId: given, clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '' };
        else client = await this.#register(meta, redirectUri, allowHttp);
        if (!client) return { need: 'client' };
        this.#sweep();
        if (this.#pending.size >= PENDING_MAX) throw new Refusal(429, 'Too many sign-ins in progress; try again shortly.');
        const state = newState();
        const { verifier, challenge } = pkcePair();
        const url = new URL(meta.authorization_endpoint);
        const ask = { response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', resource, ...(scope ? { scope } : {}) };
        for (const [k, v] of Object.entries(ask)) url.searchParams.set(k, v);
        const methods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : [];
        const auth = !client.clientSecret ? 'none' : methods.includes('client_secret_post') || !methods.length ? 'post' : 'basic';
        this.#pending.set(state, { target: t.id, title: t.title, url: t.config.url, allowHttp, redirectUri, verifier, resource, scope, token: meta.token_endpoint, ...client, auth, at: this.#now() });
        return { url: url.href };
    }

    #sweep() { for (const [k, p] of this.#pending) if (this.#now() - p.at > PENDING_MS) this.#pending.delete(k); }

    /* The token endpoint, by the client's way of proving itself. Never says back what it was sent or answered. */
    async #token(rec, params, allowHttp) {
        if (!safeUrl(rec.token, allowHttp)) throw new Refusal(502, 'The sign-in address is not https.');
        const form = new URLSearchParams({ ...params, ...(rec.resource ? { resource: rec.resource } : {}) });
        const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
        if (rec.auth === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(rec.clientId)}:${encodeURIComponent(rec.clientSecret)}`).toString('base64')}`;
        else { form.set('client_id', rec.clientId); if (rec.auth === 'post') form.set('client_secret', rec.clientSecret); }
        let res;
        try { res = await this.#get(rec.token, { method: 'POST', headers, body: form.toString() }); } catch { throw new Refusal(502, 'The sign-in server could not be reached.'); }
        const j = await res.json().catch(() => null);
        if (!res.ok || typeof j?.access_token !== 'string' || !j.access_token) {
            const why = /^[a-z_]{1,40}$/.test(String(j?.error ?? '')) ? j.error : `HTTP ${res.status}`;
            throw Object.assign(new Refusal(502, `The sign-in server refused (${why}).`), { grant: why === 'invalid_grant' });
        }
        if (/[\r\n]/.test(j.access_token)) throw new Refusal(502, 'The sign-in server answered a token that is not one line.');
        const life = Number(j.expires_in);
        return { access: j.access_token, refresh: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : '', expiresAt: life > 0 ? this.#now() + life * 1000 : null };
    }

    #keep(name, rec) {
        const { access, refresh, expiresAt, token, clientId, clientSecret, auth, resource, allowHttp } = rec;
        this.#secrets.set({ name, value: JSON.stringify({ kind: KIND, access, refresh, expiresAt, token, clientId, clientSecret, auth, resource, allowHttp }), hostOnly: true });
    }
    #open(name) {
        let raw;
        try { raw = this.#secrets.reveal(name); } catch { return null; }
        if (typeof raw !== 'string') return null;
        try { const r = JSON.parse(raw); return r?.kind === KIND ? r : null; } catch { return null; }
    }

    /* BACK FROM THE PROVIDER (the owner's browser, /api/tether/mcp-oauth/back?code&state): trade the code, keep the
       tokens host-only, and point the server's target at them. -> { target, title }. */
    async finish({ tethers }, { code, state, error } = {}) {
        this.#sweep();
        const p = state ? this.#pending.get(String(state)) : null;
        if (!p) throw new Refusal(400, 'This sign-in has expired or was already used; start it again.');
        this.#pending.delete(String(state));
        if (error) throw new Refusal(400, /^[a-z_]{1,40}$/.test(String(error)) ? `The sign-in was not allowed (${error}).` : 'The sign-in was not allowed.');
        if (!code) throw new Refusal(400, 'The provider sent back no code.');
        const got = await this.#token(p, { grant_type: 'authorization_code', code: String(code), redirect_uri: p.redirectUri, code_verifier: p.verifier }, p.allowHttp);
        const name = tokenName(p.target);
        this.#keep(name, { ...p, ...got });
        const before = tethers.store().target(p.target);
        /* Its key, if it had one kept here, is no longer used: it goes. The header for a key goes too (a token is Bearer). */
        const r = await tethers.act('mcp-add', { id: p.target, name: before?.title ?? p.title, url: before?.config?.url ?? p.url, secret: name, ...(p.allowHttp ? { allowHttp: true } : {}) }, '');
        if (!r.ok) throw new Refusal(400, 'Signed in, but the server could not be set again.');
        if (before?.secrets?.token === keyName(p.target)) { try { this.#secrets.remove(keyName(p.target)); } catch { /* not there */ } }
        return { target: p.target, title: before?.title ?? p.title };
    }

    /* THE CONNECTOR'S TOKEN (tethers.mjs, reveal): a fresh access token for a name of ours, refreshed first when near
       its end; undefined for any other secret (revealed as it is). One refresh at a time per server. */
    async access(name) {
        if (!isTokenName(name)) return undefined;
        const rec = this.#open(name);
        if (!rec) return undefined;
        if (!rec.expiresAt || rec.expiresAt - EARLY_MS > this.#now()) return rec.access;
        if (!rec.refresh) throw new Error('signed out of this server: sign in again in Assets > Access');
        let running = this.#refreshing.get(name);
        if (!running) {
            running = (async () => {
                try {
                    const got = await this.#token(rec, { grant_type: 'refresh_token', refresh_token: rec.refresh }, rec.allowHttp);
                    /* A server that rotates refresh tokens sends a new one; one that does not keeps the old one valid. */
                    this.#keep(name, { ...rec, ...got, refresh: got.refresh || rec.refresh });
                    return got.access;
                } catch (e) {
                    if (e?.grant) throw new Error('signed out of this server: sign in again in Assets > Access');
                    throw new Error(`could not refresh the sign-in: ${e?.message ?? 'failed'}`);
                } finally { this.#refreshing.delete(name); }
            })();
            this.#refreshing.set(name, running);
        }
        return running;
    }
}

/* The page the owner's browser lands on: said plainly, nothing to copy, no script. */
export function backPage({ ok, title = '', message = '' }) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const said = ok ? `Signed in to ${esc(title)}. You can close this tab.` : esc(message || 'The sign-in failed.');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clavarium</title>`
        + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fff;color:#222}@media (prefers-color-scheme: dark){body{background:#16181c;color:#eee}}main{max-width:32rem;margin:auto}</style>'
        + `</head><body><main><p>${said}</p></main></body></html>`;
}
