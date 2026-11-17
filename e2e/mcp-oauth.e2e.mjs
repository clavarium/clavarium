import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { bench, SKIP } from './bench.mjs';

/* SIGNING IN TO AN MCP SERVER THAT REGISTERS NO CLIENT (16-11), on a phone: the provider's tab opened in the click
   itself (a phone opens none after a wait); the client id AND secret asked once, with the address its app must
   name; the secret never in the page after; back from the provider, signed in, the panel painted again by itself.
   A browser that opens no tab at all: the page's own tab goes there and comes back. The provider is a fake MCP
   server and authorization server on this machine (client_secret_post only, as Slack's). */
const SECRET = 'e2e-client-secret-never-in-the-page';

async function provider() {
    const seen = { authorize: [], token: [] };
    let origin = '';
    const srv = createServer((req, res) => {
        const u = new URL(req.url, origin);
        const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
        if (u.pathname === '/mcp') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['chat:read', 'chat:write', 'canvas:write'] });
        if (u.pathname === '/.well-known/oauth-authorization-server') {
            return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
        }
        /* The owner allows it at once: back to the redirect with a code. */
        if (u.pathname === '/authorize') {
            seen.authorize.push(Object.fromEntries(u.searchParams));
            const back = new URL(u.searchParams.get('redirect_uri'));
            back.searchParams.set('code', `code-${seen.authorize.length}`); back.searchParams.set('state', u.searchParams.get('state'));
            res.writeHead(302, { location: back.href }); return res.end();
        }
        if (u.pathname === '/token' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const f = Object.fromEntries(new URLSearchParams(body));
                seen.token.push(f);
                if (f.client_secret !== SECRET) return json(401, { error: 'invalid_client' });
                return json(200, { access_token: `at-${seen.token.length}`, refresh_token: `rt-${seen.token.length}`, expires_in: 3600 });
            });
            return undefined;
        }
        return json(404, { error: 'not_found' });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${srv.address().port}`;
    return { origin, seen, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test('an MCP server signed in from a phone: its tab opened in the click, its client id and secret once, back by itself', { skip: SKIP }, async (t) => {
    const p = await provider();
    t.after(() => p.close());
    const handed = [];
    const mcp = {
        discover: async (target, ctx) => { if (target.secrets?.token) handed.push(await ctx.secret('token')); return [{ name: 'read_channel', description: 'Read a channel.' }]; },
        run: async () => ({ text: 'done', size: 4 }),
        forget() {}, attach() {},
    };
    const CHAT = { id: 'chat', title: 'Chat', kind: 'mcp', connector: 'mcp', config: { url: `${p.origin}/mcp`, allowHttp: true } };
    const b = await bench(t, { tetherTargets: [CHAT], tetherConnectors: { mcp } });
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${b.origin}/`);
    await me.openAccess('assets');
    const row = page.locator('#assets-rows .as-row[data-asset="connexion:chat"]');
    await me.until('Chat listed', async () => (await row.count()) === 1, 30_000);
    await row.click();
    const panel = page.locator('#assets-detail');
    const signIn = panel.locator('button[data-act="mcp-oauth"]');
    await me.until('its Sign in', async () => (await signIn.count()) === 1);

    /* First: no client yet. A tab opened in the click, closed again; the client form open, its redirect shown. */
    const first = page.waitForEvent('popup');
    await signIn.click();
    const blank = await first;
    await me.until('the empty tab closed', async () => blank.isClosed(), 15_000);
    const box = panel.locator('details.mcp-client');
    await me.until('the client form, open', async () => (await box.getAttribute('open').catch(() => null)) !== null, 15_000);
    assert.equal(await box.locator('input[name="mcp-redirect"]').inputValue(), `${b.origin}/api/tether/mcp-oauth/back`, 'the address its app must name');
    assert.equal(await box.locator('input[name="mcp-scopes"]').inputValue(), 'chat:read chat:write canvas:write');

    /* The id, the secret, fewer permissions: the provider's page in that tab, back signed in. */
    await box.locator('input[name="mcp-client-id"]').fill('app-1');
    await box.locator('input[name="mcp-client-secret"]').fill(SECRET);
    await box.locator('input[name="mcp-scopes"]').fill('chat:read chat:write');
    const second = page.waitForEvent('popup');
    await signIn.click();
    const tab = await second;
    /* Its address shown too, to copy or open in another browser. */
    const link = panel.locator('input[name="mcp-sign-link"]');
    await me.until('the sign-in link shown', async () => (await link.inputValue().catch(() => '')).startsWith(`${p.origin}/`), 5_000);
    assert.ok((await link.inputValue()).includes('client_id=app-1'));
    assert.equal(await panel.locator('.mcp-sign-link a').getAttribute('href'), await link.inputValue());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the link fits a phone');
    if (process.env.CLAVARIUM_SHOTS) { mkdirSync(process.env.CLAVARIUM_SHOTS, { recursive: true }); await page.screenshot({ path: join(process.env.CLAVARIUM_SHOTS, 'mcp-sign-link-phone.png') }); }
    await me.until('back from the provider', async () => /Connected to Chat/.test(await tab.content().catch(() => '')), 20_000);
    assert.equal(p.seen.authorize.at(-1).client_id, 'app-1');
    assert.equal(p.seen.authorize.at(-1).scope, 'chat:read chat:write', 'only the permissions kept');
    assert.equal(p.seen.token.at(-1).client_secret, SECRET, 'the secret sent from the server');
    await me.until('signed in: its token handed to the connector', async () => handed.includes('at-1'), 15_000);
    assert.equal((await me.api('/api/tether')).body.targets.find((x) => x.id === 'chat')?.secrets?.includes('token'), true);
    await tab.close();
    await page.bringToFront();
    assert.equal(await box.locator('input[name="mcp-client-secret"]').inputValue().catch(() => ''), '', 'the secret field emptied');
    assert.ok(!(await page.content()).includes(SECRET), 'the secret never in the page');
    assert.ok(!JSON.stringify((await me.api('/api/tether')).body).includes(SECRET));

    /* No tab opened at all (a blocked pop-up): this tab goes, and comes back by itself; nothing pasted again. */
    await page.evaluate(() => { window.open = () => null; });
    await panel.locator('button[data-act="mcp-oauth"]').click();
    await me.until('back in the page, by itself', async () => p.seen.token.length === 2 && new URL(page.url()).origin === b.origin && !page.url().includes('/api/'), 20_000);
    assert.equal(p.seen.authorize.at(-1).client_id, 'app-1', 'the client kept');
    assert.deepEqual(me.errors, [], 'no error in the page');
});
