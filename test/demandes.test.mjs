/* A Tether call waiting for the owner, as the data of Parley's request card (demandes.mjs):
 * one sentence of what will happen, key facts, what to look at twice, the act's own verb;
 * irreversible when it leaves the owner's domain, deletes, or tells guests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandeView, HOLD_S } from '../server/demandes.mjs';
import { requestOf } from 'clavarium-parley/ui';

const id = '11111111-2222-3333-4444-555555555555';
const q = (card, more = {}) => ({ id, verb: `${card.kind}.${card.action}`, detail: 'detail', target: { title: 'Work mailbox' }, card, ...more });

test('a mail sent outside: its sentence, its recipients marked, its text; irreversible, held with Undo', () => {
    const v = demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['sales@example.com'], cc: ['books@example.org'], subject: 'Quote', body: 'Hello,\n**Yes** to option B.', files: [{ name: 'plan.pdf', kb: 240 }] }, { why: 'you asked' }));
    assert.equal(v.kind, 'mail');
    assert.equal(v.title, 'Send “Quote” to sales@example.com');
    assert.equal(v.sub, 'Work mailbox · 2 lines · 1 attachment');
    assert.deepEqual(v.risk, ['Goes outside your domain']);
    assert.deepEqual(v.facts.find(([k]) => k === 'To'), ['To', [{ text: 'sales@example.com', ext: true }]]);
    assert.deepEqual(v.facts.find(([k]) => k === 'Cc'), ['Cc', [{ text: 'books@example.org' }]]);
    assert.equal(v.quote, 'Hello,\nYes to option B.', 'the Markdown marks taken off');
    assert.equal(v.irreversible, true);
    assert.deepEqual(v.yes, { id: `allow:${id}`, label: 'Send' });
    assert.deepEqual(v.no, { id: `deny:${id}`, label: 'Refuse' });
    assert.equal(v.hold, HOLD_S);
    assert.equal(v.why, 'you asked');
    assert.ok(requestOf(v), 'Parley takes it as it is');
});

test('a mail inside the domain, or a draft: reversible', () => {
    assert.equal(demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['you@example.org'], subject: 'Hi' })).irreversible, false);
    const draft = demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['x@example.com'], subject: 'Hi', draft: true }));
    assert.equal(draft.irreversible, false);
    assert.equal(draft.yes.label, 'Save draft');
});

test('an event moved: before -> after, its guests told; irreversible', () => {
    const v = demandeView(q({ kind: 'calendar', action: 'update', start: '2030-01-10T15:00', end: '2030-01-10T16:00', about: { title: 'Project', start: '2030-01-08T10:00', end: '2030-01-08T11:00', where: 'Room 2', attendees: ['team@example.com', 'client@example.net'] } }));
    assert.match(v.title, /^Move “Project” to Thu 10 Jan · 15:00–16:00$/);
    assert.deepEqual(v.before, ['Tue 8 Jan · 10:00–11:00', 'Room 2']);
    assert.deepEqual(v.after, ['Thu 10 Jan · 15:00–16:00', 'Room 2']);
    assert.match(v.sub, /was Tue 8 Jan · 10:00–11:00 · 2 guests told/);
    assert.equal(v.yes.label, 'Move');
    assert.equal(v.irreversible, true);
});

test('a contact added is reversible; a file deleted is not; a rule offers "Always allow" behind the dots', () => {
    const add = demandeView(q({ kind: 'contacts', action: 'create', name: 'Ann Example', email: 'ann@example.com' }));
    assert.equal(add.title, 'Add Ann Example');
    assert.equal(add.yes.label, 'Add');
    assert.equal(add.irreversible, false);
    const del = demandeView(q({ kind: 'files', action: 'delete', path: 'drafts/old.txt' }, { rule: { value: 'drafts/' } }));
    assert.equal(del.title, 'Delete drafts/old.txt');
    assert.equal(del.irreversible, true);
    assert.deepEqual(del.others, [{ id: `always:${id}`, label: 'Always allow drafts/' }]);
    const run = demandeView(q({ kind: 'terminal', action: 'run', command: 'sudo apt update' }, { target: { title: 'box' } }));
    assert.equal(run.title, 'Run a command on box');
    assert.equal(run.code, 'sudo apt update');
    assert.deepEqual(run.risk, ['As administrator']);
});

test('a call without a card keeps its technical words', () => {
    const v = demandeView({ id, verb: 'screen.type', detail: 'hello' });
    assert.equal(v.title, 'screen.type hello');
    assert.equal(v.kind, 'other');
});
