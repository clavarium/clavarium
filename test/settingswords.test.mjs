/* The words of the settings pages in French (server/settingswords.mjs): every key the page asks for has its French,
   one short line each; English is the page's own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_WORDS_FR, settingsWords } from '../server/settingswords.mjs';

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

test('every settings word the page asks for has its French; English is the page\'s own', () => {
    const asked = new Set([
        ...[...web('index.html').matchAll(/data-said="(set-[a-z0-9-]+)"/g)].map((m) => m[1]),
        ...[...web('app.js').matchAll(/uiSaid\('(set-[a-z0-9-]+)'/g)].map((m) => m[1]),
        ...[...web('app.js').matchAll(/\? '(set-[a-z0-9-]+)' : '(set-[a-z0-9-]+)'/g)].flatMap((m) => [m[1], m[2]]),
    ]);
    assert.ok(asked.size > 40, `${asked.size} keys`);
    const missing = [...asked].filter((k) => !(k in SETTINGS_WORDS_FR));
    assert.deepEqual(missing, []);
    assert.deepEqual(settingsWords('en-GB'), {});
    assert.equal(settingsWords('fr-FR')['set-tab-chat'], 'Chat et voix');
});

test('one short line each, the same {fills} as in English', () => {
    for (const [key, fr] of Object.entries(SETTINGS_WORDS_FR)) {
        assert.ok(fr.length <= 48 && !fr.includes('\n'), `${key}: ${fr}`);
        const en = web('app.js').match(new RegExp(`uiSaid\\('${key}', '((?:[^'\\\\]|\\\\.)*)'`))?.[1];
        if (en) assert.deepEqual([...fr.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key);
    }
});
