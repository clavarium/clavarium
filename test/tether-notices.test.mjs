import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';

/* TETHER'S NOTICES (something that happened later to what an agent did): said once in the thread of the
   conversation whose agent did it, and that agent woken once through its docket. A fake keeper hands
   them, as Tether's keeper does through `notify`. */
function setup(dir, { chatOn = true } = {}) {
    const work = join(dir, 'work'); mkdirSync(work, { recursive: true });
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const hooks = {};
    const make = (_dir, options) => {
        Object.assign(hooks, options);
        const targets = new Map();
        return {
            onChange() {}, approvals: () => [], jobs: () => [], pump() {},
            store: { target: (id) => targets.get(id), putTarget: (t) => { targets.set(t.id, t); return t; }, targets: () => [...targets.values()] },
        };
    };
    const said = []; const posted = [];
    const dockets = { on: () => chatOn, post: (name, e) => { posted.push({ name, ...e }); return e; } };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha', 'beta'], secrets: { reveal: () => undefined }, dockets, make });
    tethers.announce = (name, e) => said.push({ name, ...e });
    return { tethers, hooks, said, posted };
}
const bounce = (over = {}) => ({ id: 'n1', at: '2026-11-05T10:00:00.000Z', agent: 'conversation:beta', target: { id: 'box', title: 'Work mail' }, kind: 'mail.bounced', text: 'The mail "Quote" to bob@example.com came back: no such mailbox.', ref: '<m1@example.com>', ...over });

test('a bounce is a warning in its conversation and wakes its agent once', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir);
    assert.equal(typeof hooks.notify, 'function', 'Tether is given a notify hook');
    hooks.notify(bounce());
    assert.equal(said.length, 1);
    assert.equal(said[0].name, 'beta');
    assert.equal(said[0].kind, 'tether-notice');
    assert.equal(said[0].tone, 'warn');
    assert.equal(said[0].level, 'needs-you');
    assert.equal(said[0].text, 'Mail came back (Work mail): The mail "Quote" to bob@example.com came back: no such mailbox.');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].name, 'beta');
    assert.equal(posted[0].kind, 'tether-notice');
    assert.match(posted[0].text, /^Mail came back .*no such mailbox\. See more: tether notices\.$/);
    assert.deepEqual(posted[0].data, { notice: 'n1', kind: 'mail.bounced', ref: '<m1@example.com>', target: 'box' });
});

test('the same notice twice, even after a restart, is said once', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = setup(dir);
    first.hooks.notify(bounce());
    first.hooks.notify(bounce());
    assert.equal(first.said.length, 1); assert.equal(first.posted.length, 1);
    const again = setup(dir);
    again.hooks.notify(bounce());
    assert.equal(again.said.length, 0, 'remembered across a restart'); assert.equal(again.posted.length, 0);
    again.hooks.notify(bounce({ id: 'n2' }));
    assert.equal(again.said.length, 1, 'a new notice is said');
});

test('a delay is news, not a warning; a chat that is off is not woken', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir, { chatOn: false });
    hooks.notify(bounce({ kind: 'mail.delayed', text: 'Not delivered yet; still trying.' }));
    assert.equal(said.length, 1);
    assert.equal(said[0].tone, undefined); assert.equal(said[0].level, undefined);
    assert.match(said[0].text, /^Mail delayed/);
    assert.equal(posted.length, 0);
});

test('an unknown agent, or one that is no conversation, gives nothing and never throws', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir);
    hooks.notify(bounce({ agent: 'conversation:nobody' }));
    hooks.notify(bounce({ id: 'n3', agent: 'agent:other' }));
    hooks.notify(bounce({ id: 'n4', agent: null }));
    hooks.notify(null);
    hooks.notify({});
    assert.equal(said.length, 0); assert.equal(posted.length, 0);
});
