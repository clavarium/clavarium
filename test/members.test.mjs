/* ACCOUNTS AND RIGHTS (people.mjs, #419): administrators as before, members through their own door only.
   A whole server behind the edge, three accounts, two ready conversations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startHome, FILES } from '../server/main.mjs';
import { People } from '../server/people.mjs';
import { Grants } from '../server/grants.mjs';

const OWNER = 'owner@example.com'; const KID = 'kid@example.com'; const AUNT = 'aunt@example.com';
const ORIGIN = 'https://clav.example.com';

async function bench(t, { accounts = [OWNER, KID, AUNT], roles } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-members-'));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([
        { name: 'family', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }, { name: 'work', tool: 'shell', memoryMb: 768, phase: 'ready', work: 'kept' }]));
    mkdirSync(join(dir, 'resources', 'photos'), { recursive: true }); writeFileSync(join(dir, 'resources', 'photos', 'beach.txt'), 'sea');
    writeFileSync(join(dir, 'resources.json'), JSON.stringify([{ name: 'photos', type: 'folder', attachments: { family: 'write' } }]));
    if (roles) writeFileSync(join(dir, 'people.json'), JSON.stringify({ roles }));
    const server = await startHome({ port: 0, host: ['true'], dataDir: dir, operators: accounts, publicOrigin: ORIGIN });
    t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const as = (who, path, { body, method } = {}) => fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
        headers: { ...(who ? { 'x-forwarded-email': who } : {}), origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const terminal = (who, path) => new Promise((done) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers: { origin: ORIGIN, ...(who ? { 'x-forwarded-email': who } : {}) } });
        ws.on('open', () => { ws.close(); done('opened'); });
        ws.on('error', () => done('refused'));
    });
    return { dir, base, as, terminal };
}

/* ---------- RULE ONE: nothing changes for the accounts already there ---------- */

test('an update changes nothing: with no roles written, every account is an administrator, as before', async (t) => {
    const b = await bench(t);
    for (const who of [OWNER, KID, AUNT]) {
        assert.equal((await b.as(who, '/api/conversations')).status, 200, who);
        assert.equal((await b.as(who, '/')).status, 200, who);
    }
    assert.equal(existsSync(join(b.dir, 'people.json')), false, 'nothing written by itself');
    const list = (await (await b.as(OWNER, '/api/operators')).json()).operators;
    assert.deepEqual(list.map((o) => [o.email, o.role]), [[OWNER, 'admin'], [KID, 'admin'], [AUNT, 'admin']]);
    assert.equal(await b.terminal(KID, '/terminal?c=family'), 'opened', 'an administrator\'s terminal, as before');
});

test('one account alone is an administrator, whatever was written', async (t) => {
    const b = await bench(t, { accounts: [OWNER], roles: { [OWNER]: 'member' } });
    assert.equal((await b.as(OWNER, '/api/conversations')).status, 200);
});

test('a damaged roles file never hands a member everything; its good copy is read instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-people-'));
    try {
        const accounts = () => [{ email: OWNER }, { email: KID }];
        const path = join(dir, 'people.json');
        const p = new People({ path, accounts });
        p.setRole(KID, 'member'); p.setRole(AUNT === KID ? KID : KID, 'member');
        writeFileSync(path, '{ broken');
        assert.equal(new People({ path, accounts }).roleOf(KID), 'member', 'the last good copy (.bak) is read');
        writeFileSync(`${path}.bak`, 'broken too');
        const told = [];
        const damaged = new People({ path, accounts, tell: (title) => told.push(title) });
        assert.equal(damaged.roleOf(KID), 'member'); assert.equal(damaged.roleOf(OWNER), 'member', 'nobody taken for an administrator');
        assert.equal(told.length, 1, 'and it is said');
        assert.equal(new People({ path, accounts: () => [{ email: OWNER }] }).roleOf(OWNER), 'admin', 'an account alone stays an administrator');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the last administrator stays one: not made a member, not disabled, not removed; nor oneself', async (t) => {
    const b = await bench(t, { roles: { [AUNT]: 'member' } });
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/role`, { body: { role: 'member' } })).status, 200);
    /* Now OWNER is the last administrator. */
    assert.equal((await b.as(OWNER, `/api/operators/${OWNER}/role`, { body: { role: 'member' } })).status, 409, 'not oneself');
    const p = new People({ path: join(b.dir, 'people.json'), accounts: () => [{ email: OWNER }, { email: KID }, { email: AUNT }] });
    assert.throws(() => p.setRole(OWNER, 'member'), /last administrator/);
    assert.equal(p.isLastAdmin(OWNER), true);
    /* Counted over every account, enabled or not: a member never becomes an administrator by having the others locked out. */
    const two = new People({ path: join(b.dir, 'people.json'), accounts: () => [{ email: OWNER, enabled: false }, { email: KID }, { email: AUNT }] });
    assert.equal(two.roleOf(KID), 'member');
});

/* ---------- A MEMBER: its own door, and nothing else ---------- */

test('a member: its page at /m/, every other page and API refused (marked, so an old page goes to its own)', async (t) => {
    const b = await bench(t, { roles: { [KID]: 'member' } });
    const root = await b.as(KID, '/');
    assert.equal(root.status, 302); assert.equal(root.headers.get('location'), '/m/');
    const page = await b.as(KID, '/m/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-door="member"/); assert.match(html, /member\.js/); assert.doesNotMatch(html, /device\.js/);
    const api = await b.as(KID, '/api/conversations');
    assert.equal(api.status, 403); assert.equal(api.headers.get('x-clavarium-role'), 'member');
    assert.equal((await b.as(KID, '/m/api/me')).status, 200);
    /* The administrator is not touched. */
    assert.equal((await b.as(OWNER, '/api/conversations')).status, 200);
    /* A pairing's own routes mean nothing to a member. */
    for (const route of ['/pair', '/challenge', '/session', '/leave']) assert.equal((await b.as(KID, `/m/api${route}`, { body: {} })).status, 404, route);
    /* Nobody else reaches /m/: no sign-in, an unknown address. */
    assert.equal((await b.as(undefined, '/m/api/me')).status, 403);
    assert.equal((await b.as('stranger@example.com', '/m/')).status, 403);
});

test('EVERY route of this server, by every method, is refused to a member: the API, its static files, the device door\'s pages', async (t) => {
    const b = await bench(t, { roles: { [KID]: 'member' } });
    /* The API: every path named in the code, whatever it is, found by reading the code (a new one is in by itself). */
    const code = ['server/api.mjs', 'server/main.mjs', 'server/desktop.mjs', 'server/features.mjs', 'server/apikeys.mjs', 'server/boxes.mjs']
        .map((f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n');
    const paths = [...new Set([...code.matchAll(/'(\/api\/[a-z0-9/_-]*)/g)].map((m) => m[1].replace(/\/$/, '')))].filter((p) => !p.startsWith('/api/ext'));
    assert.ok(paths.length > 60, `found ${paths.length} API paths`);
    const open = [];
    for (const path of paths) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
            const r = await b.as(KID, path, method === 'GET' ? {} : { method, body: {} });
            if (r.status !== 403) open.push(`${method} ${path} -> ${r.status}`);
        }
    }
    assert.deepEqual(open, [], 'nothing of the administrators\' API answers a member');
    /* The administrators' page and every file of it. */
    const files = Object.keys(FILES).filter((f) => f !== '/');
    const served = [];
    for (const f of files) { const r = await b.as(KID, f); if (r.status !== 403) served.push(`${f} -> ${r.status}`); }
    assert.deepEqual(served, []);
    /* The terminal and the console of administrators. */
    assert.equal(await b.terminal(KID, '/terminal?c=family'), 'refused');
    assert.equal(await b.terminal(KID, '/terminal?c=family&resume=1'), 'refused');
    assert.equal(await b.terminal(KID, '/api/tether/console?t=x'), 'refused');
});

test('a member sees what it was given and nothing else: its chat, its terminal, by name only', async (t) => {
    const b = await bench(t, { roles: { [KID]: 'member' } });
    let me = await (await b.as(KID, '/m/api/me')).json();
    assert.deepEqual(me.conversations, [], 'nothing given yet');
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'refused');
    /* Given the chat of `family`, to write in. */
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'family', chat: 'write' } })).status, 200);
    me = await (await b.as(KID, '/m/api/me')).json();
    assert.deepEqual([me.name, me.conversations, me.chat, me.terminal], ['family', ['family'], 'write', false]);
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'refused', 'the chat is not the terminal');
    const other = await (await b.as(KID, '/m/api/me?c=work')).json();
    assert.equal(other.name ?? null, null, 'a conversation it was not given: nothing of it'); assert.deepEqual(other.conversations, ['family']);
    assert.equal((await b.as(KID, '/m/api/files?c=work&r=photos&p=')).status, 404);
    assert.equal(await b.terminal(KID, '/m/terminal?c=work'), 'refused');
    /* Its terminal too. */
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'family', chat: 'write', terminal: true } })).status, 200);
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'opened');
    assert.equal(await b.terminal(KID, '/m/terminal'), 'refused', 'never guessed: named only');
    /* Another member was given nothing of it. */
    assert.equal((await b.as(OWNER, `/api/operators/${AUNT}/role`, { body: { role: 'member' } })).status, 200);
    assert.equal(await b.terminal(AUNT, '/m/terminal?c=family'), 'refused');
    assert.deepEqual((await (await b.as(AUNT, '/m/api/me')).json()).conversations, []);
    /* Taken back: at the next request. */
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/take`, { body: { conversation: 'family' } })).status, 200);
    assert.deepEqual((await (await b.as(KID, '/m/api/me')).json()).conversations, []);
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'refused');
});

test('a terminal held when its right goes, or when its administrator is made a member, ends at once', async (t) => {
    const b = await bench(t, { roles: { [KID]: 'member' } });
    await b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'family', terminal: true } });
    const held = (who, path) => new Promise((done) => {
        const ws = new WebSocket(`${b.base.replace('http', 'ws')}${path}`, { headers: { origin: ORIGIN, 'x-forwarded-email': who } });
        ws.on('open', () => done(ws)); ws.on('error', () => done(null));
    });
    const closed = (ws) => new Promise((done) => { if (ws.readyState === WebSocket.CLOSED) done(true); ws.on('close', () => done(true)); setTimeout(() => done(false), 4000); });
    const kid = await held(KID, '/m/terminal?c=family');
    assert.ok(kid);
    await b.as(OWNER, `/api/operators/${KID}/take`, { body: { conversation: 'family' } });
    assert.equal(await closed(kid), true, 'the member\'s terminal');
    const aunt = await held(AUNT, '/terminal?c=family');
    assert.ok(aunt, 'an administrator\'s terminal');
    await b.as(OWNER, `/api/operators/${AUNT}/role`, { body: { role: 'member' } });
    assert.equal(await closed(aunt), true, 'made a member: its administrator\'s terminal ends');
});

test('only a member is given conversations, and only conversations; an account removed takes its rights with it', async (t) => {
    const b = await bench(t, { roles: { [KID]: 'member' } });
    assert.equal((await b.as(OWNER, `/api/operators/${AUNT}/give`, { body: { conversation: 'family', chat: 'read' } })).status, 409, 'an administrator has them all');
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'nope', chat: 'read' } })).status, 404);
    const g = new Grants();
    for (const asset of ['folder:photos', 'secret:KEY', 'server:status', 'mailbox:box', 'git:repo']) assert.throws(() => g.give(`person:${KID}`, asset, asset.startsWith('secret') ? 'x' : 'r'), /./, asset);
    assert.throws(() => g.give(`person:${KID}`, 'conversation:family', 'rwm'), /API key only/);
    assert.equal(g.give(`person:${KID}`, 'conversation:family', 'rwx'), 'rwx');
    /* A member's role and its rights go when its account is removed. */
    await b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'family', chat: 'write' } });
    await b.as(OWNER, `/api/operators/${KID}/remove`, { body: {} });
    const grants = JSON.parse(readFileSync(join(b.dir, 'grants.json'), 'utf8'));
    assert.equal(grants.some((x) => x.subject === `person:${KID}`), false);
    const roles = JSON.parse(readFileSync(join(b.dir, 'people.json'), 'utf8')).roles;
    assert.equal(KID in roles, false);
});

test('a new account comes as a member unless said otherwise; its role is said when it is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-people-'));
    try {
        const all = [{ email: OWNER }, { email: KID }];
        const p = new People({ path: join(dir, 'people.json'), accounts: () => all });
        assert.equal(p.defaultRole(), 'member');
        assert.equal(p.roleOf(KID), 'admin', 'an account already there is not touched');
        all.push({ email: AUNT }); p.added(AUNT, 'admin');
        assert.equal(p.roleOf(AUNT), 'admin');
        all.push({ email: 'new@example.com' }); p.added('new@example.com', p.defaultRole());
        assert.equal(p.roleOf('new@example.com'), 'member');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

