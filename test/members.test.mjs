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
    mkdirSync(join(dir, 'resources', 'bank'), { recursive: true }); writeFileSync(join(dir, 'resources', 'bank', 'statement.txt'), 'money');
    writeFileSync(join(dir, 'resources.json'), JSON.stringify([{ name: 'photos', type: 'folder', attachments: { family: 'write' } }, { name: 'bank', type: 'folder', attachments: { work: 'write', family: 'read' } }]));
    /* `roles`: { email: 'member' } (the others administrators), or the lists as written ({ admins, members }). */
    if (roles) writeFileSync(join(dir, 'people.json'), JSON.stringify(roles.admins ? roles : { admins: accounts.filter((e) => roles[e] !== 'member'), members: accounts.filter((e) => roles[e] === 'member') }));
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

test('a damaged roles file: its good copy is read; both bad, the accounts it was installed with are the administrators, never everybody', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-people-'));
    try {
        const accounts = () => [{ email: OWNER }, { email: KID }, { email: AUNT }];
        const path = join(dir, 'people.json');
        const p = new People({ path, accounts, install: [OWNER] });
        p.setRole(KID, 'member'); p.setRole(AUNT, 'member'); p.setRole(AUNT, 'admin');
        writeFileSync(path, '{ broken');
        const fromCopy = new People({ path, accounts, install: [OWNER] });
        assert.equal(fromCopy.roleOf(KID), 'member', 'the last good copy (.bak) is read');
        writeFileSync(`${path}.bak`, 'broken too');
        const told = [];
        const damaged = new People({ path, accounts, install: [OWNER], tell: (title) => told.push(title) });
        assert.deepEqual([damaged.roleOf(OWNER), damaged.roleOf(KID), damaged.roleOf(AUNT)], ['admin', 'member', 'member'], 'the installed account stays an administrator; no member made one');
        assert.equal(told.length, 1, 'and it is said');
        assert.throws(() => damaged.setRole(KID, 'admin'), /repair it first/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an account in neither list (added outside the page) is a member once there are members; before any, everybody stays an administrator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-people-'));
    try {
        const all = [{ email: OWNER }, { email: KID }];
        const p = new People({ path: join(dir, 'people.json'), accounts: () => all });
        all.push({ email: AUNT });
        assert.equal(p.roleOf(AUNT), 'admin', 'no member yet: as before');
        p.setRole(KID, 'member');
        assert.deepEqual([p.roleOf(OWNER), p.roleOf(AUNT), p.roleOf(KID)], ['admin', 'admin', 'member'], 'the accounts there were stay administrators');
        all.push({ email: 'outside@example.com' });
        assert.equal(p.roleOf('outside@example.com'), 'member', 'nothing given by default');
        p.adding('new@example.com', 'member'); all.push({ email: 'new@example.com' });
        assert.equal(p.roleOf('new@example.com'), 'member', 'its role said before it exists');
        p.removed(KID); all.splice(all.findIndex((a) => a.email === KID), 1); all.push({ email: KID });
        assert.equal(p.roleOf(KID), 'member', 'removed then back outside the page: not an administrator');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('the last administrator stays one: not made a member, not disabled, not removed; nor oneself, even with others', async (t) => {
    const b = await bench(t);
    /* Three administrators: changing one's own role is refused for itself, not as the last one. */
    assert.equal((await b.as(OWNER, `/api/operators/${OWNER}/role`, { body: { role: 'member' } })).status, 409, 'not oneself');
    assert.equal((await b.as(OWNER, `/api/operators/${KID}/role`, { body: { role: 'member' } })).status, 200);
    assert.equal((await b.as(OWNER, `/api/operators/${AUNT}/role`, { body: { role: 'member' } })).status, 200);
    /* OWNER is now the last administrator: a member cannot touch it, and nothing takes it away. */
    assert.equal((await b.as(KID, `/api/operators/${OWNER}/disable`, { body: {} })).status, 403);
    const p = new People({ path: join(b.dir, 'people.json'), accounts: () => [{ email: OWNER }, { email: KID }, { email: AUNT }] });
    assert.throws(() => p.setRole(OWNER, 'member'), /last administrator/);
    assert.equal(p.isLastAdmin(OWNER), true);
});

test('counted over every account, enabled or not: a member never becomes an administrator by having the others locked out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-people-'));
    try {
        const all = [{ email: OWNER }, { email: KID }];
        const p = new People({ path: join(dir, 'people.json'), accounts: () => all });
        p.setRole(KID, 'member');
        all[0].enabled = false;
        assert.equal(p.roleOf(KID), 'member', 'two accounts, the administrator disabled: still a member');
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('EVERY route of this server, by every method, is refused to a member BY THE GATE: the API, unknown paths, its static files; /c/ and /api/ext as for anybody', async (t) => {
    const b = await bench(t, { roles: { admins: [OWNER, AUNT], members: [KID] } });
    const code = ['server/api.mjs', 'server/main.mjs', 'server/desktop.mjs', 'server/features.mjs', 'server/apikeys.mjs', 'server/boxes.mjs', 'server/mcpoauth.mjs']
        .map((f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch { return ''; } }).join('\n');
    /* Quoted paths, and the fixed head of every regex route (\/api\/conversations\/(...)\/talk -> /api/conversations/x/talk). */
    const quoted = [...code.matchAll(/'(\/api\/[a-z0-9/_-]*)/g)].map((m) => m[1]);
    const regexed = [...code.matchAll(/\^\\\/api((?:\\\/[a-z0-9_-]+|\\\/\([^)]*\))+)/g)].map((m) => `/api${m[1].replace(/\\\//g, '/').replace(/\([^)]*\)/g, 'x')}`);
    const paths = [...new Set([...quoted, ...regexed, '/api/zzz', '/api/rooms/00000000-0000-4000-8000-000000000000/talk'].map((p) => p.replace(/\/$/, '')))].filter((p) => !p.startsWith('/api/ext'));
    assert.ok(paths.length > 100, `found ${paths.length} API paths`);
    const open = [];
    for (const path of paths) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
            const r = await b.as(KID, path, ['GET', 'HEAD', 'OPTIONS'].includes(method) ? { method } : { method, body: {} });
            if (r.status !== 403 || r.headers.get('x-clavarium-role') !== 'member') open.push(`${method} ${path} -> ${r.status}`);
        }
    }
    assert.deepEqual(open, [], 'every one refused by the gate itself, tagged');
    /* The control: the same bench answers an administrator. */
    assert.equal((await b.as(AUNT, '/api/conversations')).status, 200);
    /* The administrators' page, every file of it, and paths nobody serves. */
    const served = [];
    for (const f of [...Object.keys(FILES).filter((x) => x !== '/'), '/zzz', '/vendor/zzz', '/c', '/m']) {
        for (const method of ['GET', 'HEAD']) { const r = await b.as(KID, f, { method }); if (r.status !== 403) served.push(`${method} ${f} -> ${r.status}`); }
    }
    assert.deepEqual(served, []);
    /* /c/ (a device's own door) and /api/ext (a program's key): a member's sign-in changes nothing there. */
    for (const path of ['/c/api/00000000-0000-4000-8000-000000000000/me', '/api/ext/status']) {
        const [withIt, without] = [await b.as(KID, path), await b.as(undefined, path)];
        assert.equal(withIt.status, without.status, path);
    }
    /* The terminal of administrators. */
    assert.equal(await b.terminal(KID, '/terminal?c=family'), 'refused');
    assert.equal(await b.terminal(KID, '/terminal?c=family&resume=1'), 'refused');
    assert.equal(await b.terminal(AUNT, '/terminal?c=family'), 'opened', 'the control');
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

test('each level, by the server: read only cannot write, the chat is not the terminal, the terminal is not the chat; folders by the conversation only', async (t) => {
    const b = await bench(t, { roles: { admins: [OWNER, AUNT], members: [KID] } });
    assert.equal((await b.as(OWNER, '/api/conversations/family/talk', { body: { on: true } })).status, 200);
    const give = (rights) => b.as(OWNER, `/api/operators/${KID}/give`, { body: { conversation: 'family', chat: rights.includes('w') ? 'write' : rights.includes('r') ? 'read' : null, terminal: rights.includes('x') } });
    /* Read only. */
    await give('r');
    assert.equal((await b.as(KID, '/m/api/conversations/family/talk?c=family')).status, 200);
    assert.equal((await b.as(KID, '/m/api/conversations/family/talk?c=family', { body: { text: 'hello' } })).status, 403, 'read only: no writing');
    assert.equal((await b.as(KID, '/m/api/terminal/repair?c=family', { body: {} })).status, 403);
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'refused');
    /* Chat: its words reach the tool as a member's, never as its owner's. */
    await give('rw');
    assert.equal((await b.as(KID, '/m/api/conversations/family/talk?c=family', { body: { text: 'hello there' } })).status, 201);
    const thread = JSON.stringify(await (await b.as(OWNER, '/api/conversations/family/talk')).json());
    assert.match(thread, new RegExp(`\\[${KID.replace('.', '\\.')}, a member\\] hello there`));
    /* Terminal only: no chat at all. */
    await give('x');
    assert.equal((await b.as(KID, '/m/api/conversations/family/talk?c=family')).status, 403);
    assert.equal((await b.as(KID, '/m/api/talk/words?c=family')).status, 403);
    assert.equal(await b.terminal(KID, '/m/terminal?c=family'), 'opened');
    /* Folders: those of the conversation given, with its terminal; never those of another. */
    assert.equal((await b.as(KID, '/m/api/files?c=family&r=photos&p=')).status, 200);
    assert.equal((await b.as(KID, '/m/api/files?c=work&r=bank&p=')).status, 404, 'work was not given, though it has a folder');
    assert.equal((await b.as(KID, '/m/api/files/download?c=family&r=photos&p=../bank/statement.txt')).ok, false, 'never out of its folder');
    /* The answers carry the version, as the administrators' do. */
    const me = await b.as(KID, '/m/api/me');
    assert.ok(me.headers.get('x-clavarium-version'));
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
    const lists = JSON.parse(readFileSync(join(b.dir, 'people.json'), 'utf8'));
    assert.equal([...lists.admins, ...lists.members].includes(KID), false);
});

test('a new account comes as a member unless said otherwise, through the page too', async (t) => {
    const b = await bench(t);
    const list = async () => (await (await b.as(OWNER, '/api/operators')).json());
    assert.equal((await list()).defaultRole, 'member');
    /* The host program of this bench says yes and lists nobody new: the role is what is checked. */
    await b.as(OWNER, '/api/operators', { body: { email: 'new@example.com' } });
    const lists = JSON.parse(readFileSync(join(b.dir, 'people.json'), 'utf8'));
    assert.ok(lists.members.includes('new@example.com'), 'written as a member before it exists');
    assert.deepEqual(lists.admins.sort(), [AUNT, KID, OWNER].sort(), 'the accounts there were stay administrators');
});



test('going back: the data is format 2, which a release from before accounts and rights refuses to read', async () => {
    const { migrateData, dataFormat } = await import('../server/dataformat.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'clv-format-'));
    try {
        writeFileSync(join(dir, 'conversations.json'), '[]');
        assert.deepEqual(migrateData(dir), { from: 1, to: 2, ran: [1] });
        assert.equal(dataFormat(dir), 2);
        assert.throws(() => migrateData(dir, { format: 1, migrations: {} }), /newer Clavarium/, 'the release before refuses: it would take members for administrators');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
