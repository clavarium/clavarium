/* A Tether call waiting for the owner, as the data of Parley's request card (demandes.mjs):
 * one sentence of what will happen, key facts, what to look at twice, the act's own verb;
 * irreversible when it leaves the owner's domain, deletes, or tells guests. Each text is a word
 * and its values ({k, v}): each screen says it in its own language (Parley's requestOf). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandeView, HOLD_S } from '../server/demandes.mjs';
import { requestOf } from 'clavarium-parley/ui';
import { texts } from 'clavarium-parley/host';

const id = '11111111-2222-3333-4444-555555555555';
const q = (card, more = {}) => ({ id, verb: `${card.kind}.${card.action}`, detail: 'detail', target: { title: 'Work mailbox' }, card, ...more });
const en = (v) => requestOf(v, { words: texts('en'), locale: 'en-GB' });
const fr = (v) => requestOf(v, { words: texts('fr'), locale: 'fr-FR' });
const fact = (r, label) => r.facts.find((f) => f.label === label);
/* Every word it uses is in both dictionaries: none shows as its key. */
const keysOf = (x, found = new Set()) => { if (Array.isArray(x)) x.forEach((y) => keysOf(y, found)); else if (x && typeof x === 'object') { if (typeof x.k === 'string') found.add(x.k); Object.values(x).forEach((y) => keysOf(y, found)); } return found; };
const known = (v) => { for (const k of keysOf(v)) { assert.ok(Object.hasOwn(texts('en'), k), `en: ${k}`); assert.ok(Object.hasOwn(texts('fr'), k), `fr: ${k}`); } };

test('a mail sent outside: its sentence, its recipients marked, its text; irreversible, held with Undo', () => {
    const v = demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['sales@example.com'], cc: ['books@example.org'], subject: 'Quote', body: 'Hello,\n**Yes** to option B.', files: [{ name: 'plan.pdf', kb: 240 }] }, { why: 'you asked' }));
    known(v);
    assert.equal(v.kind, 'mail');
    assert.deepEqual(v.title, { k: 'req-mail-send-to', v: { subject: { k: 'req-quoted', v: { text: 'Quote' } }, to: 'sales@example.com' } }, 'a word and its values; the data as it is');
    const r = en(v);
    assert.equal(r.title, 'Send “Quote” to sales@example.com');
    assert.equal(r.sub, 'Work mailbox · 2 lines · 1 attachment');
    assert.deepEqual(r.risk, ['Goes outside your domain']);
    assert.deepEqual(fact(r, 'To'), { label: 'To', chips: [{ text: 'sales@example.com', ext: true }] });
    assert.deepEqual(fact(r, 'Cc'), { label: 'Cc', chips: [{ text: 'books@example.org', ext: false }] });
    assert.equal(fact(r, 'Joined').text, 'plan.pdf (240 KB)');
    assert.equal(r.quote, 'Hello,\nYes to option B.', 'the Markdown marks taken off');
    assert.equal(r.irreversible, true);
    assert.deepEqual(r.yes, { id: `allow:${id}`, label: 'Send' });
    assert.deepEqual(r.no, { id: `deny:${id}`, label: 'Refuse' });
    assert.equal(v.hold, HOLD_S);
    assert.equal(r.why, 'you asked');
    const f = fr(v);
    assert.equal(f.title, 'Envoyer « Quote » à sales@example.com');
    assert.equal(f.sub, 'Work mailbox · 2 lignes · 1 pièce jointe');
    assert.deepEqual(f.risk, ['Part hors de votre domaine']);
    assert.deepEqual([fact(f, 'À').chips[0].text, fact(f, 'Pièces jointes').text], ['sales@example.com', 'plan.pdf (240 Ko)']);
    assert.deepEqual([f.yes.label, f.no.label], ['Envoyer', 'Refuser']);
});

test('a mail inside the domain, or a draft: reversible', () => {
    assert.equal(demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['you@example.org'], subject: 'Hi' })).irreversible, false);
    const draft = demandeView(q({ kind: 'mail', action: 'send', self: 'me@example.org', to: ['x@example.com'], subject: 'Hi', draft: true }));
    assert.equal(draft.irreversible, false);
    assert.equal(en(draft).yes.label, 'Save draft');
    assert.equal(fr(draft).yes.label, 'Enregistrer le brouillon');
});

test('an event moved: before -> after, its guests told; irreversible; days said by the screen', () => {
    const v = demandeView(q({ kind: 'calendar', action: 'update', start: '2030-01-10T15:00', end: '2030-01-10T16:00', about: { title: 'Project', start: '2030-01-08T10:00', end: '2030-01-08T11:00', where: 'Room 2', attendees: ['team@example.com', 'client@example.net'] } }));
    known(v);
    assert.deepEqual(v.before, [{ at: '2030-01-08T10:00', end: '2030-01-08T11:00' }, 'Room 2'], 'a day as ISO: the screen writes it');
    const r = en(v);
    assert.equal(r.title, 'Move “Project” to Thu 10 Jan · 15:00–16:00');
    assert.deepEqual(r.before, ['Tue 8 Jan · 10:00–11:00', 'Room 2']);
    assert.deepEqual(r.after, ['Thu 10 Jan · 15:00–16:00', 'Room 2']);
    assert.match(r.sub, /was Tue 8 Jan · 10:00–11:00 · 2 guests told/);
    assert.equal(r.yes.label, 'Move');
    assert.equal(r.irreversible, true);
    const f = fr(v);
    assert.equal(f.title, 'Déplacer « Project » au jeu. 10 janv. · 15:00–16:00');
    assert.match(f.sub, /avant : mar\. 8 janv\. · 10:00–11:00 · 2 invités prévenus/);
    assert.equal(f.yes.label, 'Déplacer');
});

test('a contact added is reversible; a file deleted is not; a rule offers "Always allow" behind the dots', () => {
    const add = demandeView(q({ kind: 'contacts', action: 'create', name: 'Ann Example', email: 'ann@example.com' }));
    assert.equal(en(add).title, 'Add Ann Example');
    assert.equal(fr(add).title, 'Ajouter Ann Example');
    assert.equal(en(add).yes.label, 'Add');
    assert.equal(add.irreversible, false);
    const del = demandeView(q({ kind: 'files', action: 'delete', path: 'drafts/old.txt' }, { rule: { value: 'drafts/' } }));
    known(del);
    assert.equal(en(del).title, 'Delete drafts/old.txt');
    assert.equal(del.irreversible, true);
    assert.deepEqual(en(del).others, [{ id: `always:${id}`, label: 'Always allow drafts/' }]);
    assert.deepEqual(fr(del).others, [{ id: `always:${id}`, label: 'Toujours autoriser drafts/' }]);
    const run = demandeView(q({ kind: 'terminal', action: 'run', command: 'sudo apt update' }, { target: { title: 'box' } }));
    assert.equal(en(run).title, 'Run a command on box');
    assert.equal(run.code, 'sudo apt update');
    assert.deepEqual(en(run).risk, ['As administrator']);
    assert.deepEqual(fr(run).risk, ['En administrateur']);
});

test('every kind and act: only words both dictionaries know', () => {
    const about = { title: 'Project', subject: 'Plan', from: 'Ann <ann@example.com>', date: '2030-01-08T10:00', start: '2030-01-08T10:00', end: '2030-01-08T11:00', attendees: ['a@example.com'], clashes: ['Lunch'], files: [{ name: 'a.pdf', kb: 2048 }], organizer: 'b@example.com' };
    const cards = [
        ...['send', 'reply', 'forward', 'move', 'flag', 'delete'].flatMap((action) => [{ kind: 'mail', action, about, to: ['x@example.com'], subject: 'S', at: '2030-01-09T08:00' }, { kind: 'mail', action, all: true, keep: 'none', draft: true }]),
        ...['respond', 'create', 'delete', 'update', 'attach'].flatMap((action) => [{ kind: 'calendar', action, about, answer: 'maybe', start: '2030-01-09T09:00', with: ['x@example.com'], self: 'me@example.org', files: [{ name: 'b.txt' }] }, { kind: 'calendar', action }]),
        ...['create', 'update', 'delete', 'attach'].map((action) => ({ kind: 'contacts', action })),
        ...['run', 'type', 'open'].map((action) => ({ kind: 'terminal', action })),
        ...['write', 'delete', 'move'].map((action) => ({ kind: 'files', action, path: 'a.txt', from: 'a', to: 'b', bytes: 12 })),
        { kind: 'browser', action: 'open', url: 'https://example.com' },
    ];
    for (const card of cards) {
        const v = demandeView(q(card, { rule: {} }));
        known(v);
        for (const r of [en(v), fr(v)]) assert.ok(r && r.title && !/req-/.test(JSON.stringify(r)), `${card.kind}.${card.action}: said, no key left`);
    }
    assert.equal(en(demandeView(q({ kind: 'calendar', action: 'respond', answer: 'decline', about }))).title, 'Decline “Project” (Tue 8 Jan · 10:00–11:00)');
    assert.equal(fr(demandeView(q({ kind: 'calendar', action: 'respond', answer: 'decline', about }))).title, 'Décliner « Project » (mar. 8 janv. · 10:00–11:00)');
});

test('a call without a card keeps its technical words', () => {
    const v = demandeView({ id, verb: 'screen.type', detail: 'hello' });
    assert.equal(v.title, 'screen.type hello');
    assert.equal(v.kind, 'other');
});
