import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, pickedOf, rulesFor, CATALOGUE } from '../server/suggest.mjs';

test('a model may only choose in the catalogue: three at most, no repeat, a short why (02-11)', () => {
    assert.deepEqual(pickedOf('Here: [{"key":"reply-mail","why":"mail sans réponse"},{"key":"rm -rf","why":"x"},{"key":"reply-mail"},{"key":"done","why":"fini"},{"key":"split"},{"key":"related"}]'),
        [{ key: 'reply-mail', why: 'mail sans réponse' }, { key: 'done', why: 'fini' }, { key: 'split', why: '' }]);
    assert.deepEqual(pickedOf('nothing useful'), []);
});

test('without a model, rules: a passed due date, a mail, files', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    assert.deepEqual(rulesFor({ due: '2026-11-01', attached: [{ kind: 'mail' }, { kind: 'file' }] }, now).map((x) => x.key), ['postpone-day', 'reply-mail', 'summarise']);
    assert.deepEqual(rulesFor({ title: 'x' }, now), []);
});

test('suggest: the model first, the rules when it says nothing; each with its label and what it acts on', async () => {
    const card = { id: '3', title: 'Devis cuisine', attached: [{ kind: 'mail', title: 'Devis' }] };
    const viaModel = await suggest(card, { title: 'Lots' }, { chat: async (system, user) => { assert.match(system, /reply-mail/); assert.match(user, /Devis cuisine/); return '[{"key":"make-event","why":"rendez-vous jeudi"}]'; } });
    assert.deepEqual(viaModel, [{ key: 'make-event', label: CATALOGUE['make-event'].label, why: 'rendez-vous jeudi', on: 'agent', ask: CATALOGUE['make-event'].ask }]);
    const viaRules = await suggest(card, { title: 'Lots' }, { chat: async () => { throw new Error('down'); } });
    assert.equal(viaRules[0].key, 'reply-mail');
    assert.deepEqual(await suggest({ title: 'x' }, {}, {}), []);
});

test('the API really loads it: its import is a line of its own, not lost in a comment (02-11)', async () => {
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(new URL('../server/api.mjs', import.meta.url), 'utf8'), /^import \{ suggest \} from '\.\/suggest\.mjs';$/m);
});

test('archive is offered: a card no longer of use, or made by mistake -- archived, never deleted (02-11)', async () => {
    assert.equal(CATALOGUE.archive.on, 'card');
    assert.ok(!Object.keys(CATALOGUE).some((k) => /delete/.test(k)), 'nothing deletes');
    const got = await suggest({ id: '9', title: 'Doublon' }, {}, { chat: async (system) => { assert.match(system, /archive/); return '[{"key":"archive","why":"doublon"}]'; } });
    assert.deepEqual(got.map((x) => x.key), ['archive']);
});
