/* The OAuth side of a mailbox: settings built from a provider, and the auth step
 * that spends a refresh token for an access token and signs in with XOAUTH2.
 * No network and no real account: `fetch` is injected, the IMAP side is a stub. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oauthSettings, imapAuthenticate, PROVIDER_IMAP } from '../server/signin.mjs';

const okToken = () => new Response(JSON.stringify({ access_token: 'ACCESS', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });

test('oauthSettings derives the provider host and keeps the refresh token as the secret', () => {
    assert.deepEqual(oauthSettings({ provider: 'google', user: ' Me@Example.com ', refresh: 'R' }),
        { host: 'imap.gmail.com', port: 993, user: 'Me@Example.com', provider: 'google', password: 'R' });
    assert.equal(oauthSettings({ provider: 'microsoft', user: 'a@example.com', refresh: 'R' }).host, 'outlook.office365.com');
    assert.equal(PROVIDER_IMAP.google.port, 993);
    assert.throws(() => oauthSettings({ provider: 'yahoo', user: 'a@example.com', refresh: 'R' }), /Gmail or Microsoft/);
    assert.throws(() => oauthSettings({ provider: 'google', user: '', refresh: 'R' }), /email address/);
    assert.throws(() => oauthSettings({ provider: 'google', user: 'a@example.com', refresh: '' }), /usable token/);
});

test('imapAuthenticate classic: a LOGIN with the password, no token', async () => {
    let login = null;
    const imap = { async command(text) { login = text; return ['c1 OK']; }, async authenticateXoauth2() { throw new Error('should not XOAUTH2'); } };
    await imapAuthenticate(imap, { user: 'u', password: 'p' });
    assert.ok(login.startsWith('LOGIN "u" "p"'), 'classic LOGIN');
});

test('imapAuthenticate OAuth: refreshes an access token and signs in with XOAUTH2', async () => {
    let xoauth = null; let logged = false; let grant = null;
    const imap = {
        async authenticateXoauth2(initial) { xoauth = initial; return ['c1 OK']; },
        async command() { logged = true; return ['c1 OK']; },
    };
    const fetch = async (url, opts) => { grant = new URLSearchParams(opts.body).get('grant_type'); return okToken(); };
    await imapAuthenticate(imap, { provider: 'google', user: 'me@example.com', password: 'REFRESH' }, { fetch });
    assert.equal(grant, 'refresh_token', 'the refresh token is spent');
    assert.equal(logged, false, 'no LOGIN for an OAuth mailbox');
    assert.equal(Buffer.from(xoauth, 'base64').toString('utf8'), 'user=me@example.com\x01auth=Bearer ACCESS\x01\x01');
});

test('imapAuthenticate OAuth: a refused refresh asks to reconnect (no token leaked)', async () => {
    const imap = { async authenticateXoauth2() { return ['c1 OK']; }, async command() {} };
    const fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad' }), { status: 400, headers: { 'content-type': 'application/json' } });
    await assert.rejects(imapAuthenticate(imap, { provider: 'google', user: 'me@example.com', password: 'BADREFRESH' }, { fetch }),
        (e) => /must be reconnected/.test(e.message) && !e.message.includes('BADREFRESH'));
});
