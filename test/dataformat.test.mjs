/* The format of the data, as a number, and the migrations at start (server/dataformat.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateData, dataFormat, DATA_FORMAT } from '../server/dataformat.mjs';

const dir = (t) => { const d = mkdtempSync(join(tmpdir(), 'clv-format-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('the number is the one package.json says, so that the updater can read it in a release', () => {
    assert.equal(DATA_FORMAT, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).clavarium.dataFormat);
});

test('a new data directory gets the current format; one from before the number is format 1', (t) => {
    const fresh = dir(t);
    assert.deepEqual(migrateData(fresh, { format: 3, migrations: {} }), { from: 3, to: 3, ran: [] });
    assert.equal(dataFormat(fresh), 3);
    const old = dir(t);
    writeFileSync(join(old, 'conversations.json'), '[]');
    const ran = [];
    const r = migrateData(old, { format: 3, migrations: { 1: () => ran.push(1), 2: (d) => { ran.push(2); writeFileSync(join(d, 'two'), 'x'); } } });
    assert.deepEqual(r, { from: 1, to: 3, ran: [1, 2] });
    assert.deepEqual(ran, [1, 2], 'in order, each once');
    assert.equal(dataFormat(old), 3);
    assert.deepEqual(migrateData(old, { format: 3, migrations: {} }).ran, [], 'nothing again at the next start');
});

test('data from a newer version: refused, with the way back; a missing step: refused', (t) => {
    const d = dir(t);
    writeFileSync(join(d, 'data-format.json'), '{"format":5}');
    assert.throws(() => migrateData(d, { format: 2, migrations: {} }), /in format 5, written by a newer Clavarium; this one reads format 2 at most\. Go back to the newer version/);
    writeFileSync(join(d, 'data-format.json'), '{"format":1}');
    assert.throws(() => migrateData(d, { format: 2, migrations: {} }), /No migration from data format 1 to 2/);
});
