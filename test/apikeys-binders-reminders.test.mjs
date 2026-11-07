import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeys, handleExternal, handleApiKeys, REMINDER_MAX } from '../server/apikeys.mjs';
import { Grants, MemoryStore, apiKeySubject } from '../server/grants.mjs';
import { Binders } from '../server/binders.mjs';
import { Dockets } from '../server/dockets.mjs';
import { Store } from '../server/store.mjs';

/* API keys reach BINDERS and REMINDERS (07-11): a binder list given one by one, Off / Read / Write, kept on the list
   by Binder as a conversation's are, the key asking as an agent signed with its name -- Binder's gates hold; and a
   conversation's reminders (its Docket), folded into its level: seen at Read, set at Talk, taken back at Act. The
   key's rights are the security: no approval card, and three limits, always. */
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'clv-apikeys-br-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const statusOfError = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.status; } };
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function call(opts, { method = 'GET', path, secret, body, headers = {} }) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const request = { method, url: path, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        async *[Symbol.asyncIterator]() { if (text) yield text; } };
    const out = { status: 0, text: '' };
    const response = { writeHead(code) { out.status = code; return response; }, end(x) { out.text = x ?? ''; } };
    await handleExternal(request, response, opts);
    return { status: out.status, body: out.text ? JSON.parse(out.text) : null };
}
async function admin(keys, { path, body }) {
    const text = JSON.stringify(body);
    const request = { method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-forwarded-email': 'admin@example.com' }, async *[Symbol.asyncIterator]() { yield text; } };
    const out = { status: 0, text: '' };
    const response = { writeHead(code) { out.status = code; return response; }, end(x) { out.text = x ?? ''; } };
    const events = [];
    await handleApiKeys(request, response, keys, () => true, {}, { add: (e) => events.push(e) });
    return { status: out.status, body: JSON.parse(out.text), events };
}

/* Two conversations (hugo, compta) with their work folders; real Binder and Docket behind the door. */
function home(t, { chatOn = () => true } = {}) {
    const dir = folder(t);
    const convs = ['hugo', 'compta'];
    for (const c of convs) mkdirSync(join(dir, 'work', c), { recursive: true });
    const resources = { workFolder: (name) => join(dir, 'work', name) };
    const binders = new Binders({ dataDir: dir, resources, conversations: () => convs });
    const lines = [];
    const dockets = new Dockets({ store: new Store(join(dir, 'dockets.json')), resources, say: async () => true, event: (name, line) => lines.push([name, line.text]), chatOn, listenEveryMs: 10 });
    t.after(() => dockets.stop());
    /* The owner's lists: batches (with a gate), tasks (simple), an archived one. */
    const owner = (op, args) => { const r = binders.act(op, args, 'owner@example.com'); assert.ok(r.ok, r.text); return r.data; };
    const batches = owner('create-list', { template: 'batches', title: 'Batches' });
    const tasks = owner('create-list', { template: 'simple', title: 'Tasks' });
    const old = owner('create-list', { template: 'simple', title: 'Old' });
    owner('archive-list', { list: old.id });
    const card = owner('add', { list: tasks.id, title: 'Water the plants', description: 'Every evening' });
    owner('note', { id: card.id, text: 'The code is clv_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' });
    const proposed = owner('add', { list: batches.id, title: 'A batch' });
    const grants = new Grants(new MemoryStore());
    const keys = new ApiKeys({ store: new Store(join(dir, 'apikeys.json')), grants, journal: join(dir, 'apikeys.log'), exists: (n) => convs.includes(n),
        binders: { lists: () => binders.lists(), grant: (list, subject, level, who) => binders.grant(list, subject, level, who) } });
    const events = [];
    const opts = { keys, status: async () => ({}), events: { add: (e) => events.push(e) },
        chats: { list: () => convs.map((c) => ({ id: c, name: c })), chatOn: () => true, read: () => ({ on: true, messages: [] }), say: async () => ({}) },
        reminders: { of: (name) => dockets.of(name), set: (name, asked, by) => dockets.remind(name, asked, by), cancel: (name, plan) => dockets.cancel(name, plan) },
        binder: { act: (op, args, who) => binders.asKey(op, args, who) } };
    const mcp = (secret, name, args) => call(opts, { method: 'POST', path: '/api/ext/mcp', secret, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    /* Everything a key holds: its lines in the table, and its binder lists. */
    const held = () => keys.list().map((k) => ({ id: k.id, lines: grants.of(apiKeySubject(k.id)).map((g) => `${g.asset} ${g.rights}`).sort(), binders: k.binders }));
    return { dir, binders, dockets, owner, batches, tasks, old, card, proposed, grants, keys, events, lines, opts, mcp, held };
}
/* A time three days ahead, as Docket reads one: "2026-11-10 09:00". */
const ahead = () => { const d = new Date(Date.now() + 3 * 86_400_000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:00`; };

test('a binder list is given one by one, Off until chosen, read or write; kept on the list; archived not given; revoked: gone', async (t) => {
    const { keys, binders, batches, tasks, old } = home(t);
    const none = keys.create({ label: 'Nothing' });
    assert.deepEqual(none.key.binders, [], 'Off until chosen');
    const { key } = keys.create({ label: 'Planner', binders: { [tasks.id]: 'write', [batches.id]: 'read' } });
    assert.deepEqual(key.binders, [{ id: batches.id, level: 'read' }, { id: tasks.id, level: 'write' }]);
    assert.equal(binders.lists().find((l) => l.id === tasks.id).grants[apiKeySubject(key.id)], 'write', 'on the list itself');
    assert.equal(keys.setBinder(key.id, batches.id, 'write').binders.find((l) => l.id === batches.id).level, 'write');
    assert.deepEqual(keys.setBinder(key.id, batches.id, null).binders, [{ id: tasks.id, level: 'write' }], 'taken back');
    assert.equal(statusOfError(() => keys.setBinder(key.id, tasks.id, 'manage')), 400);
    assert.equal(statusOfError(() => keys.setBinder(key.id, 'nowhere', 'read')), 404);
    assert.equal(statusOfError(() => keys.setBinder(key.id, old.id, 'read')), 404, 'an archived list is not given');
    assert.equal(statusOfError(() => keys.create({ label: 'Bad', binders: { [tasks.id]: 'act' } })), 400);
    assert.equal(statusOfError(() => keys.create({ label: 'Bad', binders: ['tasks'] })), 400);
    assert.throws(() => binders.grant(tasks.id, 'conversation:hugo', 'write'), /API key only/, 'only a key is given a list this way');

    /* The page: given, changed, taken back -- said in What happened, by whom. */
    const set = await admin(keys, { path: `/api/apikeys/${key.id}/binders`, body: { binder: batches.id, level: 'read' } });
    assert.equal(set.status, 200); assert.deepEqual(set.body.key.binders.map((l) => l.level), ['read', 'write']);
    assert.match(set.events[0].text, /API key "Planner": binder batches read/); assert.equal(set.events[0].who, 'admin@example.com');
    assert.equal((await admin(keys, { path: `/api/apikeys/${key.id}/binders`, body: { binder: batches.id, level: 'approve' } })).status, 400);

    keys.revoke(key.id);
    for (const l of binders.lists()) assert.equal(l.grants[apiKeySubject(key.id)], undefined, `${l.id}: gone with the key`);
});

test('the door, binders: Read lists and reads (notes, secrets masked); Write adds, changes, moves, notes, archives -- signed with the key; 403 below', async (t) => {
    const { keys, binders, tasks, batches, card, events, opts, mcp } = home(t);
    const none = keys.create({ label: 'Nothing' });
    const reader = keys.create({ label: 'Reader', binders: { [tasks.id]: 'read' } });
    const writer = keys.create({ label: 'Planner', binders: { [tasks.id]: 'write', [batches.id]: 'read' } });
    const ext = (secret, path, method = 'GET', body) => call(opts, { method, path: `/api/ext/v1${path}`, secret, body });

    assert.deepEqual((await ext(none.secret, '/binders')).body, { binders: [] });
    const listed = (await ext(writer.secret, '/binders')).body.binders;
    assert.deepEqual(listed.map((l) => [l.id, l.title, l.level]), [[batches.id, 'Batches', 'read'], [tasks.id, 'Tasks', 'write']]);
    assert.ok(listed[0].states.find((s) => s.id === 'approved').gate, 'its gate is said');
    for (const k of [none]) assert.equal((await ext(k.secret, `/binders/${tasks.id}/records`)).status, 403);
    for (const ref of ['nowhere', 'old', '..%2F..']) assert.equal((await ext(writer.secret, `/binders/${ref}/records`)).status, 403, ref);

    /* Read: its records, one with its notes; a secret in it masked. */
    const records = (await ext(reader.secret, `/binders/${tasks.id}/records`)).body.records;
    assert.deepEqual(records.map((r) => [r.id, r.title, r.state]), [[card.id, 'Water the plants', 'open']]);
    const one = (await ext(reader.secret, `/binders/${tasks.id}/records/${card.id}`)).body.record;
    assert.equal(one.description, 'Every evening');
    assert.equal(one.notes.length, 1); assert.equal(one.notes[0].by, 'owner@example.com');
    assert.equal(one.notes[0].text.includes('clv_abcdef'), false, 'a secret is masked');
    /* A record of another list is not reached through this one. */
    const other = binders.act('add', { list: batches.id, title: 'Elsewhere' }, 'owner@example.com').data;
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${other.id}`)).status, 404);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/999`)).status, 404);

    /* Read cannot write: each write refused, nothing changed. */
    const writes = [[`/binders/${tasks.id}/records`, { title: 'No' }], [`/binders/${tasks.id}/records/${card.id}`, { title: 'No' }], [`/binders/${tasks.id}/records/${card.id}/move`, { state: 'done' }],
        [`/binders/${tasks.id}/records/${card.id}/notes`, { text: 'No' }], [`/binders/${tasks.id}/records/${card.id}/archive`, undefined]];
    for (const [path, body] of writes) {
        assert.equal((await ext(reader.secret, path, 'POST', body)).status, 403, path);
        assert.equal((await ext(none.secret, path, 'POST', body)).status, 403, path);
    }
    assert.equal((await ext(writer.secret, `/binders/${batches.id}/records`, 'POST', { title: 'No' })).status, 403, 'a list at Read');
    assert.match((await ext(reader.secret, `/binders/${tasks.id}/records`, 'POST', { title: 'No' })).body.error, /not change it/);
    assert.equal(binders.act('show', { list: tasks.id }, 'owner@example.com').data.records.length, 1, 'nothing added');

    /* Write: added, changed, moved, noted, archived, restored -- each signed with the key's name. */
    const added = await ext(writer.secret, `/binders/${tasks.id}/records`, 'POST', { title: 'Buy bulbs', description: 'Two of them', due: '2026-12-01' });
    assert.equal(added.status, 201);
    const id = added.body.record.id;
    assert.equal(added.body.record.title, 'Buy bulbs'); assert.equal(added.body.record.due, '2026-12-01');
    const kept = binders.act('get', { id }, 'owner@example.com').data;
    assert.equal(kept.record.by, apiKeySubject(writer.key.id), 'made by the key');
    assert.deepEqual(kept.history.map((h) => [h.op, h.by.name, h.by.kind]), [['add', 'Planner', 'agent']], 'signed with its name, an agent');
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}`, 'POST', { title: 'Buy three bulbs', due: null })).body.record.title, 'Buy three bulbs');
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}/move`, 'POST', { state: 'Done' })).body.record.state, 'done');
    const noted = await ext(writer.secret, `/binders/${tasks.id}/records/${id}/notes`, 'POST', { text: 'Bought' });
    assert.equal(noted.status, 201); assert.deepEqual(noted.body.record.notes.map((n) => [n.by, n.text]), [['Planner', 'Bought']]);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}/archive`, 'POST')).body.record.archived, true);
    assert.deepEqual((await ext(writer.secret, `/binders/${tasks.id}/records?archived=1`)).body.records.map((r) => r.id), [id]);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}/restore`, 'POST')).body.record.archived, undefined);
    assert.deepEqual(binders.act('get', { id }, 'owner@example.com').data.history.map((h) => [h.op, h.by.name]),
        [['add', 'Planner'], ['edit', 'Planner'], ['move', 'Planner'], ['note', 'Planner'], ['archive', 'Planner'], ['restore', 'Planner']]);
    /* Only these fields: never owners, access, a list's columns. */
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}`, 'POST', { owners: ['me'] })).status, 400);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records`, 'POST', { title: 'x', access: 'write' })).status, 400);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}/move`, 'POST', { state: 'nowhere' })).status, 400);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}`, 'GET')).status, 200);
    assert.equal((await ext(writer.secret, `/binders/${tasks.id}/records/${id}/move`)).status, 405, 'POST only');
    assert.equal((await ext(writer.secret, '/binders', 'POST', {})).status, 405);

    /* What happened: each write, with the key's name; the journal says each call. */
    assert.ok(events.length >= 6);
    assert.ok(events.every((e) => e.kind === 'asset' && e.who === 'API key "Planner"'));
    assert.equal(events[0].text, `Binder "Tasks": #${id} added`);
    assert.ok(events.some((e) => e.text === `Binder "Tasks": #${id} moved to Done`));
    const journal = keys.journal(writer.key.id).map((u) => [u.method, u.route, u.status]);
    assert.ok(journal.some(([m, r, s]) => m === 'POST' && r === `/v1/binders/${tasks.id}/records` && s === 201));
    assert.ok(keys.journal(reader.key.id).some((u) => u.route === `/v1/binders/${tasks.id}/records` && u.status === 403));

    /* MCP: the same, at the same levels. */
    assert.deepEqual((await mcp(reader.secret, 'clavarium_binders', {})).body.result.structuredContent.binders.map((l) => [l.id, l.level]), [[tasks.id, 'read']]);
    assert.equal((await mcp(reader.secret, 'clavarium_binder_records', { binder: tasks.id })).body.result.structuredContent.records.length, 2);
    assert.equal((await mcp(reader.secret, 'clavarium_binder_record', { binder: tasks.id, record: card.id })).body.result.structuredContent.record.notes.length, 1);
    for (const [tool, args] of [['clavarium_binder_add', { title: 'No' }], ['clavarium_binder_edit', { record: card.id, title: 'No' }], ['clavarium_binder_move', { record: card.id, state: 'done' }],
        ['clavarium_binder_note', { record: card.id, text: 'No' }], ['clavarium_binder_archive', { record: card.id }]]) {
        const r = await mcp(reader.secret, tool, { binder: tasks.id, ...args });
        assert.equal(r.status, 403, tool); assert.equal(r.body.error.code, -32001, tool);
    }
    assert.equal((await mcp(none.secret, 'clavarium_binder_records', { binder: tasks.id })).status, 403);
    assert.equal((await mcp(writer.secret, 'clavarium_binder_record', { binder: tasks.id })).body.error.code, -32602);
    const viaMcp = await mcp(writer.secret, 'clavarium_binder_add', { binder: tasks.id, title: 'From MCP' });
    assert.equal(viaMcp.status, 200);
    const mid = viaMcp.body.result.structuredContent.record.id;
    assert.equal((await mcp(writer.secret, 'clavarium_binder_edit', { binder: tasks.id, record: mid, description: 'Said' })).body.result.structuredContent.record.description, 'Said');
    assert.equal((await mcp(writer.secret, 'clavarium_binder_move', { binder: tasks.id, record: mid, state: 'done' })).body.result.structuredContent.record.state, 'done');
    assert.equal((await mcp(writer.secret, 'clavarium_binder_note', { binder: tasks.id, record: mid, text: 'Hi' })).body.result.structuredContent.record.notes[0].by, 'Planner');
    assert.equal((await mcp(writer.secret, 'clavarium_binder_archive', { binder: tasks.id, record: mid })).body.result.structuredContent.record.archived, true);
    assert.equal((await mcp(writer.secret, 'clavarium_binder_archive', { binder: tasks.id, record: mid, restore: true })).body.result.structuredContent.record.archived, undefined);
    assert.ok(keys.journal(writer.key.id).some((u) => u.route === `/mcp tools/call clavarium_binder_add ${tasks.id}` && u.status === 201));
});

test('binder gates hold: a key never adds nor moves past a gate a person did not tick; once ticked, it moves on; never approves nor deletes', async (t) => {
    const { keys, binders, batches, proposed, opts, mcp } = home(t);
    const writer = keys.create({ label: 'Planner', binders: { [batches.id]: 'write' } });
    const ext = (path, method = 'GET', body) => call(opts, { method, path: `/api/ext/v1${path}`, secret: writer.secret, body });
    for (const state of ['approved', 'doing', 'Done']) {
        const r = await ext(`/binders/${batches.id}/records/${proposed.id}/move`, 'POST', { state });
        assert.equal(r.status, 403, state); assert.match(r.body.error, /only a person approves/);
    }
    assert.equal((await ext(`/binders/${batches.id}/records`, 'POST', { title: 'Sneaky', state: 'approved' })).status, 403, 'not added past the gate');
    assert.equal((await mcp(writer.secret, 'clavarium_binder_move', { binder: batches.id, record: proposed.id, state: 'doing' })).status, 403);
    assert.equal(binders.act('get', { id: proposed.id }, 'owner@example.com').data.record.state, 'proposed', 'it stays');
    /* No route approves, deletes, gives access or changes a list. */
    for (const verb of ['approve', 'delete', 'grant']) assert.equal((await ext(`/binders/${batches.id}/records/${proposed.id}/${verb}`, 'POST', {})).status, 404, verb);
    assert.equal((await ext(`/binders/${batches.id}`, 'POST', { title: 'Mine' })).status, 404);
    assert.equal((await ext(`/binders/${batches.id}/records/${proposed.id}`, 'POST', { approved: true })).status, 400);
    /* Ticked by a person: the key moves it on. */
    assert.ok(binders.act('approve', { id: proposed.id }, 'owner@example.com').ok);
    assert.equal((await ext(`/binders/${batches.id}/records/${proposed.id}/move`, 'POST', { state: 'doing' })).body.record.state, 'doing');
    assert.equal((await ext(`/binders/${batches.id}/records/${proposed.id}`)).body.record.approved, true);
    /* Binder itself refuses an agent's approval or delete: the key is one. */
    const who = keys.binderWho(writer.key.id);
    assert.equal(binders.asKey('approve', { id: proposed.id }, who).ok, false);
    assert.equal(binders.asKey('delete', { id: proposed.id }, who).ok, false);
    assert.equal(binders.asKey('grant', { list: batches.id, to: who.id, access: 'write' }, who).ok, false);
    assert.throws(() => binders.asKey('lists', {}, { id: 'person:x', kind: 'person', name: 'x' }), /Not an API key/);
});

test('reminders, folded into a conversation\'s level: Read sees them, Talk sets one (at, cron), Act takes one back; 403 below; said with the key\'s name', async (t) => {
    const { keys, dockets, events, lines, opts, mcp } = home(t);
    const none = keys.create({ label: 'Nothing' });
    const reader = keys.create({ label: 'Reader', conversations: { hugo: 'read' } });
    const talker = keys.create({ label: 'Talker', conversations: { hugo: 'talk' } });
    const actor = keys.create({ label: 'Steering', conversations: { hugo: 'act' } });
    const ext = (secret, path, method = 'GET', body) => call(opts, { method, path: `/api/ext/v1/conversations${path}`, secret, body });

    assert.deepEqual((await ext(reader.secret, '/hugo/reminders')).body, { reminders: [] });
    assert.equal((await ext(none.secret, '/hugo/reminders')).status, 403);
    assert.equal((await ext(talker.secret, '/compta/reminders')).status, 403, 'a conversation not given');
    assert.equal((await ext(talker.secret, '/nobody/reminders')).status, 403);
    assert.equal((await ext(reader.secret, '/hugo/reminders', 'POST', { text: 'No', at: ahead() })).status, 403, 'Read only sees');

    const at = ahead();
    const once = await ext(talker.secret, '/hugo/reminders', 'POST', { text: 'Water the plants', at });
    assert.equal(once.status, 201); assert.equal(once.body.reminder.text, 'Water the plants'); assert.equal(once.body.reminder.cron, null);
    const weekly = await ext(talker.secret, '/hugo/reminders', 'POST', { text: 'Weekly review', cron: '0 9 * * 1' });
    assert.equal(weekly.status, 201); assert.equal(weekly.body.reminder.cron, '0 9 * * 1');
    for (const body of [{ text: 'x' }, { text: 'x', at, cron: '0 9 * * 1' }, { text: '', at }, { text: 'x'.repeat(REMINDER_MAX + 1), at }, { text: 'x', at: '2001-01-01 09:00' },
        { text: 'x', cron: 'every day' }, { text: 'x', in: '2h' }, { text: 'x', at, plan: 'mine' }]) {
        assert.equal((await ext(talker.secret, '/hugo/reminders', 'POST', body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    const listed = (await ext(reader.secret, '/hugo/reminders')).body.reminders;
    assert.deepEqual(listed.map((r) => [r.text, r.cron]).sort(), [['Water the plants', null], ['Weekly review', '0 9 * * 1']]);
    assert.equal(dockets.of('hugo').plans.length, 2, 'in its Docket, as the tool\'s are');

    /* Taken back: Act only. */
    const plan = once.body.reminder.id;
    assert.equal((await ext(talker.secret, `/hugo/reminders/${plan}/cancel`, 'POST')).status, 403);
    assert.equal((await ext(actor.secret, `/hugo/reminders/${plan}/cancel`, 'POST')).body.cancelled, plan);
    assert.equal((await ext(actor.secret, '/hugo/reminders/nothing-here/cancel', 'POST')).status, 404);
    assert.deepEqual((await ext(actor.secret, '/hugo/reminders')).body.reminders.map((r) => r.text), ['Weekly review']);
    assert.equal((await ext(actor.secret, `/hugo/reminders/${plan}/cancel`)).status, 405);

    /* What happened, its chat, the journal: the key's name. */
    assert.deepEqual(events.map((e) => [e.text, e.who]), [['hugo: reminder set "Water the plants"', 'API key "Talker"'], ['hugo: reminder set "Weekly review"', 'API key "Talker"'],
        ['hugo: reminder taken back "Water the plants"', 'API key "Steering"']]);
    await pause(80);
    assert.ok(lines.some(([name, text]) => name === 'hugo' && /^Reminder set by API key "Talker": Water the plants/.test(text)), 'its chat says who set it');
    assert.ok(keys.journal(talker.key.id).some((u) => u.method === 'POST' && u.route === '/v1/conversations/hugo/reminders' && u.status === 201));

    /* MCP: the same levels. */
    assert.equal((await mcp(reader.secret, 'clavarium_reminders', { conversation: 'hugo' })).body.result.structuredContent.reminders.length, 1);
    assert.equal((await mcp(reader.secret, 'clavarium_remind', { conversation: 'hugo', text: 'No', at })).status, 403);
    const r = await mcp(talker.secret, 'clavarium_remind', { conversation: 'hugo', text: 'From MCP', cron: '30 8 * * *' });
    assert.equal(r.status, 200); const mid = r.body.result.structuredContent.reminder.id;
    assert.equal((await mcp(talker.secret, 'clavarium_reminder_cancel', { conversation: 'hugo', reminder: mid })).status, 403);
    assert.equal((await mcp(actor.secret, 'clavarium_reminder_cancel', { conversation: 'hugo', reminder: mid })).body.result.structuredContent.cancelled, mid);
    assert.equal((await mcp(talker.secret, 'clavarium_remind', { conversation: 'hugo', text: 'x' })).body.result.isError, true, 'neither at nor cron');
    assert.equal((await mcp(none.secret, 'clavarium_reminders', { conversation: 'hugo' })).status, 403);
});

test('reminders: none where its chat is off (409)', async (t) => {
    const { keys, opts } = home(t, { chatOn: () => false });
    const talker = keys.create({ label: 'Talker', conversations: { hugo: 'act' } });
    const ext = (path, method = 'GET', body) => call(opts, { method, path: `/api/ext/v1/conversations${path}`, secret: talker.secret, body });
    assert.equal((await ext('/hugo/reminders')).status, 409);
    assert.equal((await ext('/hugo/reminders', 'POST', { text: 'x', at: ahead() })).status, 409);
    assert.equal((await ext('/hugo/reminders/abc/cancel', 'POST')).status, 409);
});

test('the three limits hold with binders and reminders: no secret, no key or account made, no right changed -- whatever was given', async (t) => {
    const { keys, tasks, batches, card, opts, mcp, held } = home(t);
    const all = keys.create({ label: 'Everything', scopes: ['status', 'create-rooms'], conversations: { hugo: 'act', compta: 'act' }, binders: { [tasks.id]: 'write', [batches.id]: 'write' } });
    const before = held();
    const ext = (path, method = 'GET', body) => call(opts, { method, path: `/api/ext/v1${path}`, secret: all.secret, body });
    /* Every way it might try, through its binders and reminders: refused, or nothing of the kind. */
    const tries = [
        ['POST', `/binders/${tasks.id}/grant`, { to: 'apikey:x', access: 'write' }], ['POST', `/binders/${tasks.id}/records/${card.id}/grant`, {}],
        ['POST', `/binders/${tasks.id}/records`, { title: 'x', grants: { x: 'write' } }], ['POST', `/binders/${tasks.id}/records/${card.id}`, { access: 'write' }],
        ['POST', '/binders', { title: 'Mine' }], ['POST', '/apikeys', { label: 'Another' }], ['POST', '/accounts', { email: 'a@example.com' }],
        ['GET', '/secrets'], ['POST', '/hugo/reminders', {}], ['POST', '/conversations/hugo/reminders', { text: 'x', at: ahead(), level: 'act' }],
        ['POST', `/conversations/hugo/reminders/${'0'.repeat(8)}/give`, {}],
    ];
    for (const [method, path, body] of tries) assert.ok([400, 403, 404, 405].includes((await ext(path, method, body)).status), `${method} ${path}`);
    for (const name of ['clavarium_apikey_create', 'clavarium_grant', 'clavarium_secret', 'clavarium_binder_grant', 'clavarium_binder_delete', 'clavarium_binder_approve']) {
        assert.equal((await mcp(all.secret, name, { binder: tasks.id })).body.error.code, -32602, name);
    }
    assert.equal((await mcp(all.secret, 'clavarium_binder_add', { binder: tasks.id, title: 'x', access: 'write' })).body.result?.isError ?? true, true);
    assert.equal(keys.list().length, 1, 'no key made');
    assert.deepEqual(held(), before, 'no right changed, its own nor any');
});
