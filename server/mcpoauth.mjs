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
 * A CLIENT THE OWNER PASTED (16-11): a service that registers no client by itself (Slack, GitHub...) is given an
 * app once by its owner, its client id AND secret pasted in the page. Both are kept host-only in the vault
 * (MCP_<ID>_CLI), never sent back to the page, never to an AI; the token endpoint is shown the secret the way
 * the service's metadata says (token_endpoint_auth_methods_supported: client_secret_post, else _basic, the
 * default of RFC 8414). The permissions asked are those the owner kept (by default those the server's metadata
 * lists); a refusal for them is said plainly.
 *
 * RECONNECT (16-11): Tether, refused with a token, asks once for a fresh one (access(name, { fresh: true })):
 * refreshed here when it can be; when it cannot, the error carries `reconnect` and Tether shows the server as
 * "to reconnect". Reconnecting is always the owner's own click (the same sign-in, the client kept).
 *
 * `fetch` is injected, so the tests run against a fake authorization server with no network. */
import { Refusal } from './conversations.mjs';
import { pkcePair, newState } from './oauth.mjs';
import { KEY_PREFIX, keyName, oauthName, clientName } from './mcpx.mjs';

export const TOKEN_SUFFIX = '_TOK';
export const BACK_PATH = '/api/tether/mcp-oauth/back';
const PROTOCOL = '2025-06-18';
const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 20;
const FETCH_MS = 15_000;
/* Refreshed this long before its end: a call that starts now still has a valid token when it lands. */
const EARLY_MS = 60_000;
const KIND = 'mcp-oauth';
const CLIENT_KIND = 'mcp-client';
/* A scope as RFC 6749 s.3.3 writes one: printable, no space, no quote or backslash. */
const SCOPE_OK = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;
const scopeList = (x) => [...new Set((Array.isArray(x) ? x : String(x ?? '').split(/[\s,]+/)).map((v) => String(v).trim()).filter((v) => SCOPE_OK.test(v)))].slice(0, 100);
/* Where the owner's browser goes back to after (a path of this site only), and the language it is said in. */
const backOf = (x) => { const b = String(x ?? ''); return /^\/(?![/\\])[^\s]{0,499}$/.test(b) ? b : '/'; };
const langOf = (x) => (String(x ?? '').toLowerCase().split('-')[0] === 'fr' ? 'fr' : 'en');
/* An error code a provider says back, kept only when it is one plain word. */
const codeOf = (x) => (/^[a-z_.]{1,60}$/.test(String(x ?? '')) ? String(x) : '');
/* What a provider's refusal means for the owner: the page says it in their words (backPage). */
function whyOf(code) {
    if (code === 'invalid_scope') return 'scope';
    if (['invalid_client', 'unauthorized_client', 'bad_client_secret', 'invalid_client_id', 'bad_redirect_uri', 'invalid_redirect_uri'].includes(code)) return 'client';
    if (code === 'access_denied') return 'denied';
    return 'failed';
}

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
        /* What may be asked: the 401's scope, else what the resource's metadata lists (never the authorization
           server's whole list: a service's app holds only some of them). */
        const listed = scopeList(prm?.scopes_supported);
        const scopes = scope ? scopeList(scope) : listed;
        return { resource, meta, scope: scopes.join(' ').slice(0, 1000), scopes: [...new Set([...scopes, ...listed])] };
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
        return { clientId: oneLine(j.client_id, 500), clientSecret: typeof j.client_secret === 'string' ? j.client_secret : '', registered: true };
    }

    /* START: { target, clientId?, clientSecret?, scope?, lang?, back?, tab? } and this server's address -> { url } to
       open, or { need: 'client', secret, redirect, scopes } when the server registers no client by itself: the page
       then asks for its id and, when the service wants one, its secret (`redirect`: the address its app must name;
       `missing: 'secret'` when only the secret lacks). A client pasted once is kept host-only: no paste after. */
    async start({ tethers }, body = {}, origin = '') {
        const t = tethers.store().target(String(body.target ?? ''));
        if (!t || t.kind !== 'mcp') throw new Refusal(404, 'No such MCP server.');
        const allowHttp = t.config?.allowHttp === true;
        const back = safeUrl(`${String(origin).replace(/\/+$/, '')}${BACK_PATH}`, true);
        if (!back) throw new Refusal(500, 'This server does not know its own address.');
        const redirectUri = back.href;
        const { resource, meta, scope: asked, scopes } = await this.discover(t.config?.url, { allowHttp });
        const methods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.map(String) : [];
        /* A secret is needed unless the service says it takes public clients ("none"). */
        const wantsSecret = !methods.includes('none');
        const need = { need: 'client', secret: wantsSecret, redirect: redirectUri, scopes };
        const kept = this.#client(t.id);
        const given = oneLine(body.clientId, 500);
        const secret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
        if (/[\r\n]/.test(secret) || secret.length > 2000) throw new Refusal(400, 'A client secret is one line.');
        let client = null;
        if (given) client = { clientId: given, clientSecret: secret || (kept?.clientId === given ? kept.clientSecret : '') };
        else if (kept) client = { clientId: kept.clientId, clientSecret: kept.clientSecret };
        else client = await this.#register(meta, redirectUri, allowHttp);
        if (!client) return need;
        if (wantsSecret && !client.clientSecret && !client.registered) return { ...need, missing: 'secret' };
        /* The permissions: those the owner kept now, else those kept with the client, else what the server asks. */
        const keptScope = body.scope !== undefined ? scopeList(body.scope) : null;
        const scope = (keptScope ?? (kept?.scope !== undefined ? scopeList(kept.scope) : scopeList(asked))).join(' ').slice(0, 2000);
        const auth = !client.clientSecret ? 'none' : methods.includes('client_secret_post') ? 'post' : methods.includes('client_secret_basic') || !methods.length ? 'basic' : '';
        if (!auth) throw new Refusal(502, 'This service wants a way of proving the client that Clavarium does not offer.');
        /* Pasted: kept host-only, with the permissions kept, for every sign-in after. */
        if (given || (keptScope && kept)) this.#keepClient(t.id, { clientId: client.clientId, clientSecret: client.clientSecret, scope });
        this.#sweep();
        if (this.#pending.size >= PENDING_MAX) throw new Refusal(429, 'Too many sign-ins in progress; try again shortly.');
        const state = newState();
        const { verifier, challenge } = pkcePair();
        const url = new URL(meta.authorization_endpoint);
        const ask = { response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', resource, ...(scope ? { scope } : {}) };
        for (const [k, v] of Object.entries(ask)) url.searchParams.set(k, v);
        const { registered, ...plain } = client;
        this.#pending.set(state, { target: t.id, title: t.title, url: t.config.url, allowHttp, redirectUri, verifier, resource, scope, token: meta.token_endpoint, ...plain, auth,
            lang: langOf(body.lang), back: backOf(body.back), sameTab: body.tab === 'same', at: this.#now() });
        return { url: url.href };
    }

    /* The client the owner pasted for a server, from the vault: { clientId, clientSecret, scope? } or null. */
    #client(id) {
        let raw;
        try { raw = this.#secrets.reveal(clientName(id)); } catch { return null; }
        try { const r = JSON.parse(String(raw ?? '')); return r?.kind === CLIENT_KIND && typeof r.clientId === 'string' && r.clientId ? r : null; } catch { return null; }
    }
    #keepClient(id, { clientId, clientSecret, scope }) {
        this.#secrets.set({ name: clientName(id), value: JSON.stringify({ kind: CLIENT_KIND, clientId, clientSecret, scope }), hostOnly: true });
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
        const raw = await res.json().catch(() => null);
        /* Some services answer 200 { ok: false, error } (Slack); some put a user's token under authed_user. */
        const j = raw && typeof raw.access_token !== 'string' && raw.authed_user && typeof raw.authed_user.access_token === 'string' ? { ...raw.authed_user, ok: raw.ok } : raw;
        if (!res.ok || j?.ok === false || typeof j?.access_token !== 'string' || !j.access_token) {
            const code = codeOf(j?.error);
            const why = whyOf(code);
            const said = why === 'client' ? 'The service refused the client id or secret' : why === 'scope' ? 'The service refused the permissions asked' : 'The sign-in server refused';
            throw Object.assign(new Refusal(502, `${said} (${code || `HTTP ${res.status}`}).`), { grant: code === 'invalid_grant' || code === 'invalid_refresh_token', why });
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
        if (!p) throw Object.assign(new Refusal(400, 'This sign-in has expired or was already used; start it again.'), { why: 'expired' });
        this.#pending.delete(String(state));
        /* Said in the owner's language, and back to where they were, whatever comes next. */
        const said = (e) => Object.assign(e, { lang: p.lang, back: p.back, sameTab: p.sameTab, why: e.why ?? 'failed' });
        if (error) { const c = codeOf(error); throw said(Object.assign(new Refusal(400, c ? `The sign-in was not allowed (${c}).` : 'The sign-in was not allowed.'), { why: whyOf(c || 'access_denied') })); }
        if (!code) throw said(new Refusal(400, 'The provider sent back no code.'));
        let got;
        try { got = await this.#token(p, { grant_type: 'authorization_code', code: String(code), redirect_uri: p.redirectUri, code_verifier: p.verifier }, p.allowHttp); } catch (e) { throw said(e); }
        const name = tokenName(p.target);
        this.#keep(name, { ...p, ...got });
        const before = tethers.store().target(p.target);
        /* Its key, if it had one kept here, is no longer used: it goes. The header for a key goes too (a token is Bearer). */
        const r = await tethers.act('mcp-add', { id: p.target, name: before?.title ?? p.title, url: before?.config?.url ?? p.url, secret: name, ...(p.allowHttp ? { allowHttp: true } : {}) }, '');
        if (!r.ok) throw said(new Refusal(400, 'Signed in, but the server could not be set again.'));
        if (before?.secrets?.token === keyName(p.target)) { try { this.#secrets.remove(keyName(p.target)); } catch { /* not there */ } }
        return { target: p.target, title: before?.title ?? p.title, lang: p.lang, back: p.back, sameTab: p.sameTab };
    }

    /* THE CONNECTOR'S TOKEN (tethers.mjs, reveal): a fresh access token for a name of ours, refreshed first when near
       its end -- or at once with `fresh` (the server refused the one it had: revoked before its end); undefined for
       any other secret (revealed as it is). One refresh at a time per server. Signed out for good: an error that
       carries `reconnect` (Tether then shows the server as to reconnect, and tells its AIs so). */
    async access(name, { fresh = false } = {}) {
        if (!isTokenName(name)) return undefined;
        const rec = this.#open(name);
        if (!rec) return undefined;
        if (!fresh && (!rec.expiresAt || rec.expiresAt - EARLY_MS > this.#now())) return rec.access;
        const out = () => Object.assign(new Error('signed out of this server: its owner must reconnect it (Assets > Access)'), { reconnect: true });
        if (!rec.refresh) throw out();
        let running = this.#refreshing.get(name);
        if (!running) {
            running = (async () => {
                try {
                    const got = await this.#token(rec, { grant_type: 'refresh_token', refresh_token: rec.refresh }, rec.allowHttp);
                    /* A server that rotates refresh tokens sends a new one; one that does not keeps the old one valid. */
                    this.#keep(name, { ...rec, ...got, refresh: got.refresh || rec.refresh });
                    return got.access;
                } catch (e) {
                    if (e?.grant || e?.why === 'client') throw out();
                    throw new Error(`could not refresh the sign-in: ${e?.message ?? 'failed'}`);
                } finally { this.#refreshing.delete(name); }
            })();
            this.#refreshing.set(name, running);
        }
        return running;
    }
}

/* The page the owner's browser lands on: said plainly in their language (16-11), nothing to copy, no script. Opened
   in its own tab, it says to go back; in the page's own tab (a phone that opened no new one), it goes back by itself
   to where the owner was (`back`, a path of this site). */
const BACK_WORDS = {
    en: { ok: 'Connected to {title}.', close: 'You can close this tab and go back to Clavarium.', go: 'Back to Clavarium', expired: 'This sign-in has expired or was already used. Start it again.',
        denied: 'Sign-in cancelled. Nothing changed.', scope: 'The service refused the permissions asked. Keep only those its app has, then try again.',
        client: 'The service refused the client id or secret. Check them, then try again.', failed: 'The sign-in failed.' },
    fr: { ok: 'Connecté à {title}.', close: 'Vous pouvez fermer cet onglet et revenir à Clavarium.', go: 'Revenir à Clavarium', expired: 'Cette connexion a expiré ou a déjà servi. Recommencez.',
        denied: 'Connexion annulée. Rien n\'a changé.', scope: 'Le service refuse les autorisations demandées. Gardez seulement celles de son appli, puis réessayez.',
        client: 'Le service refuse l\'identifiant ou le secret client. Vérifiez-les, puis réessayez.', failed: 'La connexion a échoué.' },
};
export function backPage({ ok, title = '', message = '', why = '', lang = 'en', back = '', sameTab = false }) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const w = BACK_WORDS[langOf(lang)];
    const to = backOf(back);
    const lead = ok ? w.ok.replace('{title}', title) : (w[why] && why !== 'failed' ? w[why] : (message || w.failed));
    /* The provider's own word (its error code), under the plain sentence. */
    const detail = !ok && w[why] && why !== 'failed' && message ? `<p class="d">${esc(message)}</p>` : '';
    const more = ok && !sameTab ? `<p>${esc(w.close)}</p>` : '';
    const refresh = ok && sameTab ? `<meta http-equiv="refresh" content="1;url=${esc(to)}">` : '';
    return `<!doctype html><html lang="${langOf(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>Clavarium</title>`
        + '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fff;color:#222}a{color:inherit}.d{opacity:.7;font-size:14px}@media (prefers-color-scheme: dark){body{background:#16181c;color:#eee}}main{max-width:32rem;margin:auto}</style>'
        + `</head><body><main><p>${esc(lead)}</p>${detail}${more}<p><a href="${esc(to)}">${esc(w.go)}</a></p></main></body></html>`;
}
