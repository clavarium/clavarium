import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providersOf, openCodeConfig, Catalogue } from '../server/catalog.mjs';

const RAW = { mistral: { name: 'Mistral', env: ['MISTRAL_API_KEY'], models: { 'devstral-latest': { name: 'Devstral' }, 'bad id!': {} } }, empty: { name: 'Empty', models: {} }, 'x y': { models: { a: {} } } };

test('the catalogue of models: providers with models, their key, names sorted; anything malformed left out (03-11)', () => {
    assert.deepEqual(providersOf(RAW), [{ id: 'mistral', name: 'Mistral', env: ['MISTRAL_API_KEY'], models: [{ id: 'devstral-latest', name: 'Devstral' }] }]);
    assert.deepEqual(providersOf(null), []);
});

test('what OpenCode reads: the model chosen, its key read from the secret given; nothing from a bad name (03-11)', () => {
    assert.deepEqual(openCodeConfig({ provider: 'mistral', model: 'devstral-latest', secret: 'MISTRAL_API_KEY' }), { $schema: 'https://opencode.ai/config.json', model: 'mistral/devstral-latest', provider: { mistral: { options: { apiKey: '{env:MISTRAL_API_KEY}' } } } });
    assert.equal(openCodeConfig({ provider: 'mistral', model: 'x', secret: 'not a name' }), null);
    assert.equal(openCodeConfig({ provider: '../x', model: 'x', secret: 'K' }), null);
});

test('the catalogue read once a day, the last one kept when it cannot be reached (03-11)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let asked = 0; let up = true; let now = 0;
    const fetcher = async () => { asked++; if (!up) throw new Error('down'); return { ok: true, json: async () => RAW }; };
    const c = new Catalogue({ file: join(dir, 'c.json'), fetcher, now: () => now });
    assert.equal((await c.providers()).length, 1); await c.providers(); assert.equal(asked, 1, 'once a day');
    up = false; const again = new Catalogue({ file: join(dir, 'c.json'), fetcher, now: () => now });
    assert.equal((await again.providers()).length, 1, 'the last one, from its file');
});
