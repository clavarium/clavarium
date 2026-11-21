import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Groups, labelProblem, isMember, LABEL_MAX } from '../server/groups.mjs';
import { handleApi } from '../server/api.mjs';

/* The grants MemoryStore has the same small shape as the file Store
   (all/get/put/remove, keyed by .name), so groups run on it in tests. */
import { MemoryStore } from '../server/grants.mjs';

const make = () => new Groups({ store: new MemoryStore() });

/* Drive the real routes through handleApi. `groups` is its last positional
   argument; the few before it that the asset-group routes touch are filled. */
async function call(groups, method, path, body) {
    let status, text;
    const request = Object.assign(Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body ?? {}))] : []),
        { method, url: path, headers: { 'content-type': 'application/json' } });
    const response = { writeHead: (s) => { status = s; return { end: (x) => { text = x; } }; } };
    const args = new Array(43).fill(undefined);
    args[0] = request; args[1] = response;
    args[2] = { list: () => [] };   // conversations
    args[3] = {};                   // headers
    args[4] = { of: () => [] };     // resources
    args[5] = () => true;           // originOk
    args[42] = groups;              // groups (last positional)
    const handled = await handleApi(...args);
    return { handled, status, data: text ? JSON.parse(text) : undefined };
}

test('a group is created empty, listed, renamed and removed', () => {
    const groups = make();
    const g = groups.create('Site web');
    assert.equal(g.label, 'Site web');
    assert.deepEqual(g.members, []);
    assert.match(g.id, /^[0-9a-f]{12}$/);
    assert.deepEqual(groups.list(), [{ id: g.id, label: 'Site web', members: [] }]);

    groups.rename(g.id, 'Site');
    assert.equal(groups.list()[0].label, 'Site');

    groups.remove(g.id);
    assert.deepEqual(groups.list(), []);
});

test('an asset sits in at most one group (a folder move)', () => {
    const groups = make();
    const a = groups.create('A');
    const b = groups.create('B');
    groups.place('git:site', a.id);
    assert.equal(groups.groupOf('git:site'), a.id);

    groups.place('git:site', b.id);
    assert.equal(groups.groupOf('git:site'), b.id);
    assert.deepEqual(groups.list().find((g) => g.id === a.id).members, []);
    assert.deepEqual(groups.list().find((g) => g.id === b.id).members, ['git:site']);

    groups.place('git:site', null);
    assert.equal(groups.groupOf('git:site'), null);
});

test('a group holds mixed asset types', () => {
    const groups = make();
    const g = groups.create('Projet');
    for (const a of ['git:site', 'secret:MODEL_KEY', 'connexion:ab12cd', 'mailbox:news']) groups.place(a, g.id);
    assert.deepEqual(groups.list()[0].members.sort(), ['connexion:ab12cd', 'git:site', 'mailbox:news', 'secret:MODEL_KEY']);
});

test('forget drops a member whose asset is gone; renamed moves it', () => {
    const groups = make();
    const g = groups.create('G');
    groups.place('folder:reports', g.id);
    groups.place('git:site', g.id);

    groups.forget('folder:reports');
    assert.deepEqual(groups.list()[0].members, ['git:site']);

    groups.renamed('git:site', 'git:website');
    assert.deepEqual(groups.list()[0].members, ['git:website']);
});

test('a bad label is refused', () => {
    const groups = make();
    assert.throws(() => groups.create(''), /name/i);
    assert.throws(() => groups.create('x'.repeat(LABEL_MAX + 1)), /characters/);
    assert.throws(() => groups.create(' leading'), /space/);
    assert.equal(labelProblem('Fine'), '');
    assert.ok(labelProblem(''));
});

test('the API creates, lists, places into, renames and removes a group', async () => {
    const groups = make();

    let r = await call(groups, 'POST', '/api/asset-groups', { label: 'Site' });
    assert.equal(r.status, 201);
    const id = r.data.id;
    assert.match(id, /^[0-9a-f]{12}$/);

    r = await call(groups, 'GET', '/api/asset-groups');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, [{ id, label: 'Site', members: [] }]);

    r = await call(groups, 'POST', '/api/asset-groups/place', { asset: 'git:site', group: id });
    assert.equal(r.status, 200);
    assert.deepEqual(groups.list()[0].members, ['git:site']);

    r = await call(groups, 'POST', `/api/asset-groups/${id}/rename`, { label: 'Website' });
    assert.equal(r.status, 200);
    assert.equal(groups.list()[0].label, 'Website');

    r = await call(groups, 'POST', '/api/asset-groups/place', { asset: 'git:site', group: null });
    assert.equal(groups.groupOf('git:site'), null);

    r = await call(groups, 'POST', `/api/asset-groups/${id}/remove`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(groups.list(), []);
});

test('a bad member or group id is refused', () => {
    const groups = make();
    const g = groups.create('G');
    assert.throws(() => groups.place('notanasset', g.id), /asset/);
    assert.throws(() => groups.place('git:site', 'nope'), /group/i);
    assert.throws(() => groups.rename('nope', 'X'), /group/i);
    assert.ok(isMember('git:site'));
    assert.ok(!isMember('git site'));
    assert.ok(!isMember('x'));
});
