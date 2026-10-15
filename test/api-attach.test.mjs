import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleApi } from '../server/api.mjs';
import { Refusal } from '../server/conversations.mjs';

/* One POST through the API, with stand-ins: { status, body }. */
async function post(path, body, { resources, keeper }) {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: { 'content-type': 'application/json' } });
    let status; let text = '';
    const response = { writeHead: (s) => { status = s; return { end: (t) => { text = t; } }; } };
    const conversations = { list: () => [{ name: 'alpha', phase: 'ready' }] };
    await handleApi(request, response, conversations, {}, resources, () => true, ...Array(14).fill(undefined), keeper);
    return { status, body: JSON.parse(text) };
}

/* A switch from write that failed half-way used to keep the automatic
   sending settings, which came back at the next write attachment. */
for (const access of ['read', 'none']) {
    test(`a change of a repository to ${access} forgets its automatic sending even when the change fails half-way`, async () => {
        const forgotten = []; const asked = [];
        const keeper = { forgetAttachment: (name, c) => forgotten.push([name, c]), beforeWriter: (...a) => asked.push(a) };
        const resources = { attach: async () => { throw new Refusal(502, 'The folder could not be attached: lost'); }, of: () => [] };
        const r = await post('/api/conversations/alpha/resources', { resource: 'site', access }, { resources, keeper });
        assert.equal(r.status, 502);
        assert.deepEqual(forgotten, [['site', 'alpha']]);
        assert.deepEqual(asked, [], 'only a write attachment is asked about');
    });
}

test('a write attachment is asked about first (a second writer next to automatic sending), with the owner\'s confirmation passed on', async () => {
    const asked = []; const attached = []; const forgotten = [];
    const keeper = { forgetAttachment: (...a) => forgotten.push(a), beforeWriter: (...a) => asked.push(a) };
    const resources = { attach: async (...a) => { attached.push(a); }, of: () => [] };
    assert.equal((await post('/api/conversations/alpha/resources', { resource: 'site', access: 'write', shared: true }, { resources, keeper })).status, 200);
    assert.deepEqual(asked, [['site', 'alpha', true]]);
    assert.deepEqual(forgotten, []);
    const refusing = { ...keeper, beforeWriter: () => { throw Object.assign(new Refusal(409, 'Confirm: shared'), { kind: 'confirm-shared' }); } };
    const r = await post('/api/conversations/alpha/resources', { resource: 'site', access: 'write' }, { resources, keeper: refusing });
    assert.deepEqual([r.status, r.body.kind], [409, 'confirm-shared']);
    assert.equal(attached.length, 1, 'refused: nothing attached');
});
