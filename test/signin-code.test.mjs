import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { handleApi } from '../server/api.mjs';
import { SigninHelp } from '../server/signinhelp.mjs';
import { startHome } from '../server/main.mjs';
import { JsonFile } from '../server/store.mjs';

const CODE = 'fieldCODE123_value#state-xyz';
const PROMPT = 'Paste code here if prompted >';
const ID = '12345678-0000-4000-8000-000000000000';

function world(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-signin-code-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const chat = join(dir, 'work', 'alpha', '.parley');
    mkdirSync(chat, { recursive: true });
    const w = { screen: PROMPT, types: true, typed: [], lines: [], now: Date.parse('2026-11-22T10:00:00.000Z'), chat, dir };
    const tools = [{ id: 'claude-code', label: 'Claude Code', signin: { senders: ['claude.ai'], links: ['claude.ai'], screen: ['code:Paste code here'] } }];
    w.help = new SigninHelp({ store: new JsonFile(join(dir, 'companion.json'), {}), conversations: () => [{ name: 'alpha', tool: 'claude-code' }], tools: () => tools,
        awake: () => ['alpha'], chatOn: () => true, workFolder: (n) => join(dir, 'work', n), browsers: () => [], post: () => ({ id: 'e' }),
        type: async (n, text) => { w.typed.push([n, text]); if (w.types && w.accepts !== false) w.screen = '> ready'; return w.types; }, event: (n, line) => w.lines.push(line), now: () => w.now,
        exec: async () => ({ code: 0, stdout: w.screen, stderr: '' }) });
    w.help.codeSettleMs = 0;
    w.ask = (extra = {}) => writeFileSync(join(chat, 'signin-ask.json'), JSON.stringify({ id: ID, at: new Date(w.now).toISOString(), link: 'https://claude.ai/oauth', around: '', told: true, field: true, ...extra }));
    w.post = async (body, { origin = true, name = 'alpha' } = {}) => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: `/api/conversations/${name}/signin-code`, headers: { 'content-type': 'application/json' } });
        let status; let text = '';
        const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
        await handleApi(request, response, { list: () => [{ name: 'alpha', phase: 'ready' }], signinHelp: w.help }, {}, undefined, () => origin);
        return { status, text };
    };
    return w;
}
const everyFile = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? everyFile(p) : [p]; });

test('the code goes once into the tool at its prompt, and is kept nowhere', async (t) => {
    const w = world(t);
    const said = []; const keep = {};
    for (const k of ['log', 'info', 'warn', 'error']) { keep[k] = console[k]; console[k] = (...a) => said.push(a.join(' ')); }
    t.after(() => Object.assign(console, keep));
    w.ask();
    const r = await w.post({ code: `  ${CODE}\n` });
    assert.equal(r.status, 200);
    assert.deepEqual(w.typed, [['alpha', CODE]], 'typed once, trimmed');
    assert.equal(r.text.includes(CODE), false, 'not in the answer');
    assert.equal(existsSync(join(w.chat, 'signin-ask.json')), false, 'the ask is over');
    for (const f of everyFile(w.dir)) assert.equal(readFileSync(f, 'utf8').includes(CODE), false, f);
    assert.equal(JSON.stringify(w.lines).includes(CODE), false, 'not in the chat');
    assert.equal(said.join('\n').includes(CODE), false, 'not logged');
    assert.equal((await w.post({ code: CODE })).status, 409, 'sent again: nothing is waiting');
    assert.equal(w.typed.length, 1);
});

test('two sends at once: typed once', async (t) => {
    const w = world(t);
    w.ask();
    const both = await Promise.all([w.post({ code: CODE }), w.post({ code: CODE })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
    assert.equal(w.typed.length, 1);
});

test('refused: another site, not a code, no sign-in, handed to a companion, too late, not at its prompt; the value never said back', async (t) => {
    const w = world(t);
    const refused = async (status, body, options) => { const r = await w.post(body, options); assert.equal(r.status, status, r.text); assert.equal(r.text.includes(String(body.code)), false); assert.deepEqual(w.typed, []); };
    w.ask();
    await refused(403, { code: CODE }, { origin: false });
    await refused(404, { code: CODE }, { name: 'nobody' });
    for (const code of ['short', 'has a space in it', 'x'.repeat(301)]) await refused(400, { code });
    const r = await w.post({ code: 12345678901 }); assert.equal(r.status, 400);
    rmSync(join(w.chat, 'signin-ask.json'));
    await refused(409, { code: CODE });
    w.ask({ told: false });
    writeFileSync(join(w.chat, 'signin-route.json'), JSON.stringify({ id: ID, route: 'companion', companion: 'beta' }));
    await refused(409, { code: CODE });
    w.ask(); w.now += 31 * 60_000;
    await refused(409, { code: CODE });
    w.now -= 31 * 60_000; w.screen = '> ready';
    await refused(409, { code: CODE });
});

test('not typed: said, and the ask stays for another try', async (t) => {
    const w = world(t);
    w.ask(); w.types = false;
    const r = await w.post({ code: CODE });
    assert.equal(r.status, 502);
    assert.equal(r.text.includes(CODE), false);
    assert.equal(existsSync(join(w.chat, 'signin-ask.json')), true);
});

test('the door: only a device given its terminal reaches the field', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-signin-door-'));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([{ name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }, { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }]));
    const origin = 'https://clav.example.com';
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: ['owner@example.com'], publicOrigin: origin });
    t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    const pair = async (grants) => {
        const shared = await (await call('/api/shares', { grants }, { 'x-forwarded-email': 'owner@example.com' })).json();
        const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const { device } = await (await call('/c/api/pair', { code: new URL(shared.url).hash.slice(1), key: publicKey.export({ format: 'jwk' }), label: 'Phone' })).json();
        const { nonce } = await (await call('/c/api/challenge', { device })).json();
        const opened = await call('/c/api/session', { device, signature: sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') });
        return { id: device, cookie: opened.headers.get('set-cookie').split(';')[0] };
    };
    const asset = 'conversation:family';
    const chatOnly = await pair([{ asset, rights: 'rw' }]);
    assert.equal((await call(`/c/api/${chatOnly.id}/conversations/family/signin-code?c=family`, { code: CODE }, { cookie: chatOnly.cookie })).status, 403);
    const hands = await pair([{ asset, rights: 'rwx' }]);
    assert.equal((await call(`/c/api/${hands.id}/conversations/family/signin-code?c=family`, { code: CODE }, { cookie: hands.cookie })).status, 409, 'its terminal: reached, nothing waiting');
    assert.equal((await call(`/c/api/${hands.id}/conversations/work/signin-code?c=family`, { code: CODE }, { cookie: hands.cookie })).status, 403, 'another conversation named');
    assert.equal((await call(`/c/api/${hands.id}/conversations/family/signin-code?c=family`, { code: CODE })).status, 401, 'no session');
});

test('a code the tool does not accept: said, the ask stays, the field works again', async (t) => {
    const w = world(t);
    w.ask(); w.accepts = false;
    const first = await w.post({ code: CODE });
    assert.equal(first.status, 422);
    assert.equal(first.text.includes(CODE), false, 'not in the answer');
    assert.equal(existsSync(join(w.chat, 'signin-ask.json')), true, 'the ask stays');
    assert.equal(await w.help.atCodePrompt('alpha', async () => ({ code: 0, stdout: w.screen, stderr: '' })), true, 'nothing else is typed there meanwhile');
    w.accepts = true;
    assert.equal((await w.post({ code: `${CODE}2` })).status, 200);
    assert.equal(w.typed.length, 2);
    assert.equal(existsSync(join(w.chat, 'signin-ask.json')), false, 'accepted: the ask is over');
});

test('a prompt the tool has moved on from, still higher on its screen, is not a refused code', async (t) => {
    const w = world(t);
    w.ask();
    w.help.codeSettleMs = 0;
    const type = w.typed;
    w.accepts = false; const before = w.screen;
    w.screen = `${before}`;
    const done = w.post({ code: CODE });
    w.screen = `${PROMPT}\n${CODE.length}\nok\nready>`;
    assert.equal((await done).status, 200);
    assert.equal(type.length, 1);
});
