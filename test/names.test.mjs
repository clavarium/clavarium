import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConversationName, titleProblem, identifierFrom, TITLE_MAX } from '../server/names.mjs';

test('a conversation name is letters, digits and hyphens, and nothing a command line could misread', () => {
    for (const good of ['a', 'demo', 'website-redesign', 'q3', 'a'.repeat(32)]) assert.equal(isConversationName(good), true, good);
    for (const bad of ['', 'Demo', '-x', 'x-', '3d', 'a b', 'a;b', 'a/b', '../x', 'a'.repeat(33), 'été', 'a\n', '=x', 12, null, undefined]) {
        assert.equal(isConversationName(bad), false, String(bad));
    }
});

test('the name a person reads is free, but nothing in it hides or reorders what is seen', () => {
    for (const good of ['Location voiture', 'Été 2026', 'Car 🚗 rental', 'Q3 – Budget', 'x'.repeat(TITLE_MAX)]) assert.equal(titleProblem(good), '', good);
    const unseen = [0x202e, 0x200b, 0x200f, 0x2066, 0xfeff, 0x00ad, 0x7f].map((c) => `a${String.fromCodePoint(c)}b`);
    for (const bad of ['', ' lead', 'trail ', 'two\nlines', 'tab\there', 'x'.repeat(TITLE_MAX + 1), ...unseen, 3, null]) {
        assert.notEqual(titleProblem(bad), '', JSON.stringify(bad));
    }
    assert.equal(titleProblem('🚗'.repeat(TITLE_MAX)), '', 'counted in characters, not in code units');
});

test('the identifier is drawn from the name: plain letters, a number when it is taken, always a valid identifier', () => {
    assert.equal(identifierFrom('Location voiture'), 'location-voiture');
    assert.equal(identifierFrom('Location voiture', (x) => x === 'location-voiture'), 'location-voiture-2');
    assert.equal(identifierFrom('Location voiture', (x) => ['location-voiture', 'location-voiture-2'].includes(x)), 'location-voiture-3');
    assert.equal(identifierFrom('Été 2026 🚗'), 'ete-2026');
    assert.equal(identifierFrom('2026 plans'), 'plans');
    assert.equal(identifierFrom('🚗🚗'), 'conversation');
    const first = identifierFrom('A very long name for a conversation about many things');
    const long = identifierFrom('A very long name for a conversation about many things', (x) => x === first);
    assert.ok(first.length <= 32 && isConversationName(long) && long.endsWith('-2') && long.length <= 32, long);
});
