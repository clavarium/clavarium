/* The Guichet's fixed parts (config/launch/guichet.mjs): secrets masked, passages found. The model
 * call is the claude command with no tool; it is not run here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GUICHET_NO_MAIN = '1';
const { mask, passagesOf, search } = await import('../config/launch/guichet.mjs');

test('the guichet masks secrets: keys, tokens, a password in a setting or a URL', () => {
    const m = mask('password = Hunter2Secret ; key ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ; https://bob:pw123456@host/x');
    assert.equal(m.masked, 3);
    assert.doesNotMatch(m.text, /Hunter2|ghp_a|pw123456/);
    assert.match(m.text, /password = \[secret masked\]/);
});

test('the guichet finds the passages of a question, secrets already masked in them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guichet-'));
    writeFileSync(join(dir, 'frais.md'), 'Note de frais : au-delà de 500 €, deux validations.\npassword: Hunter2Secret');
    writeFileSync(join(dir, 'conges.md'), 'Congés : quinze jours avant, dans l\'outil RH.');
    const index = passagesOf(dir);
    assert.deepEqual(search(index, 'validation note de frais').map((p) => p.name), ['frais.md']);
    assert.ok(!index.list.some((p) => p.body.includes('Hunter2')), 'the model never sees it');
});
