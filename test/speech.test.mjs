import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Speech, elevenRefusal } from '../server/speech.mjs';

test('why ElevenLabs refused is read from its answer: credits used up, key refused, permission missing', () => {
    assert.equal(elevenRefusal(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }), 'credits used up');
    assert.equal(elevenRefusal(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }), 'key refused');
    assert.equal(elevenRefusal(401, { detail: { code: 'unauthorized', status: 'missing_permissions', message: 'missing the permission text_to_speech' } }), 'key lacks the text-to-speech permission');
    assert.equal(elevenRefusal(401, undefined), 'key refused');
    assert.equal(elevenRefusal(500, undefined), 'answered 500');
});

test('credits used up: said once in the log, and ElevenLabs is not asked again for each sentence', async () => {
    const lines = []; let asked = 0;
    const fetcher = async (url) => {
        if (String(url).startsWith('https://api.elevenlabs.io/')) { asked++; return new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } }), { status: 401 }); }
        return new Response('', { status: 404 });   /* this server's voice is not fetched in a test: speak() then fails, which is fine here */
    };
    const speech = new Speech({ dir: mkdtempSync(join(tmpdir(), 'speech-')), fetcher, log: (l) => lines.push(l), secret: () => 'the-key' });
    for (let i = 0; i < 3; i++) await speech.speak('Bonjour.').catch(() => {});
    assert.equal(asked, 1, 'asked once, then left alone');
    assert.deepEqual(lines.filter((l) => /ElevenLabs/.test(l)), ["speech: ElevenLabs: credits used up, this server's voice instead"]);
});
