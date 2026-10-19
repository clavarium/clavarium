import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDictation, withoutLoop, transcribe, voiceConfig, Dictation, PROVIDERS, dictationProblem, isPrivateHost } from '../server/voice.mjs';
import { Detector, Segmenter, toWav, loudness, BLOCK, BLOCK_MS, RATE } from '../web/voice-core.js';

const wav = Buffer.from(toWav([new Float32Array(BLOCK).fill(0.1)]));

test('what an engine returns is cleaned before it can be typed: nothing a terminal would obey', () => {
    assert.equal(cleanDictation('hello\r\nrm -rf /\n'), 'hello rm -rf /', 'a line break is Enter: it becomes a space');
    assert.equal(cleanDictation('a\x1b[2Jb\x00c‮d​e'), 'a[2Jbcde');
    assert.equal(cleanDictation('  spaced   out  '), 'spaced out');
    assert.equal(cleanDictation('x'.repeat(5000)).length, 2000);
    assert.equal(cleanDictation(undefined), '');
});

test('the loop of the engine is brought back to once; a wanted repetition stays', () => {
    assert.equal(withoutLoop('how to say how to say how to say how to say it'), 'how to say it');
    assert.equal(withoutLoop('no, no'), 'no, no');
    assert.equal(withoutLoop('yes yes yes yes'), 'yes');
});

test('a phrase goes to the engine as a WAV file with the key in a header, and comes back clean', async () => {
    let seen;
    const fetcher = async (url, init) => { seen = { url, auth: init.headers.authorization, model: init.body.get('model'), file: init.body.get('file') }; return new Response(JSON.stringify({ text: ' run the tests\n' })); };
    const config = voiceConfig({ CLAVARIUM_TRANSCRIPTION_URL: 'https://stt.example.com/v1/audio/transcriptions', CLAVARIUM_TRANSCRIPTION_KEY: 'k' });
    assert.equal(await transcribe(config, wav, fetcher), 'run the tests');
    assert.deepEqual([seen.url, seen.auth, seen.model, seen.file.type], ['https://stt.example.com/v1/audio/transcriptions', 'Bearer k', 'whisper-large-v3-turbo', 'audio/wav']);
});

test('no engine, not a WAV, too long, an engine that fails: each is said, and no address leaks', async () => {
    const config = voiceConfig({ CLAVARIUM_TRANSCRIPTION_URL: 'https://stt.example.com/secret-path' });
    assert.equal(voiceConfig({}), undefined);
    await assert.rejects(transcribe(undefined, wav), /No speech-to-text engine/);
    await assert.rejects(transcribe(config, Buffer.from('not audio at all')), /not a WAV/);
    await assert.rejects(transcribe(config, Buffer.concat([wav, Buffer.alloc(600 * 1024)])), /too long/);
    const failing = transcribe(config, wav, async () => { throw new Error('connect ECONNREFUSED https://stt.example.com/secret-path'); });
    await assert.rejects(failing, (e) => /cannot be reached/.test(e.message) && !e.message.includes('secret-path'));
    await assert.rejects(transcribe(config, wav, async () => new Response('x', { status: 500 })), /answered 500/);
});

/* A room: quiet, then somebody speaks, then quiet again. */
function hear(pattern) {
    const phrases = []; let starts = 0;
    const detector = new Detector();
    const segmenter = new Segmenter({ onPhrase: (blocks) => phrases.push(blocks.length), onStart: () => { starts++; } });
    let n = 0;
    for (const [level, blocks] of pattern) {
        for (let i = 0; i < blocks; i++) {
            const samples = new Float32Array(BLOCK).fill(level);
            segmenter.feed(detector.hear(loudness(samples)), n++ * BLOCK_MS, samples);
        }
    }
    return { phrases, starts, segmenter };
}

test('speech after a quiet second becomes ONE phrase, closed by half a second of silence, with its pre-roll', () => {
    const second = Math.round(1000 / BLOCK_MS);
    const { phrases, starts } = hear([[0.005, 2 * second], [0.2, second], [0.005, second]]);
    assert.equal(starts, 1);
    assert.equal(phrases.length, 1);
    /* about one second of speech + 320 ms before + 500 ms of closing silence */
    assert.ok(phrases[0] > second && phrases[0] < 2 * second, String(phrases[0]));
});

test('a click is not a phrase; two phrases separated by a pause are two', () => {
    const second = Math.round(1000 / BLOCK_MS);
    assert.equal(hear([[0.005, 2 * second], [0.3, 3], [0.005, second]]).phrases.length, 0, 'a 96 ms click');
    assert.equal(hear([[0.005, 2 * second], [0.2, second], [0.005, second], [0.2, second], [0.005, second]]).phrases.length, 2);
});

test('the room sets the bar: the same voice is not heard under a loud steady noise it does not exceed', () => {
    const second = Math.round(1000 / BLOCK_MS);
    assert.equal(hear([[0.05, 4 * second], [0.06, second], [0.05, second]]).phrases.length, 0);
    assert.equal(hear([[0.05, 4 * second], [0.3, second], [0.05, second]]).phrases.length, 1);
});

test('a WAV file is 44 bytes of header and two bytes per sample, at the stated rate', () => {
    const bytes = toWav([new Float32Array([0, 1, -1, 2]), new Float32Array([0.5])]);
    const view = new DataView(bytes.buffer);
    assert.equal(bytes.length, 44 + 5 * 2);
    assert.equal(view.getUint32(24, true), RATE);
    assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)], [0, 32767, -32768, 32767], 'clipped, never wrapped');
});

/* ---------- the engine chosen in Settings ---------- */
const PUBLIC = async () => [{ address: '2001:db8::1' }];
const lan = ['10', '1', '2', '3'].join('.');
function dictation({ env = {}, secrets = { STT_KEY: 'the-key-value' }, lookup = PUBLIC } = {}) {
    const sent = [];
    const fetcher = async (url, init) => { sent.push({ url, auth: init.headers.authorization, model: init.body.get('model'), language: init.body.get('language'), redirect: init.redirect }); return new Response(JSON.stringify({ text: 'heard' })); };
    return { d: new Dictation({ env, secret: (n) => secrets[n], lookup, fetcher }), sent };
}

test('Settings win over the environment, which stays the fallback; off gives the environment back, at once', async () => {
    const { d, sent } = dictation({ env: { CLAVARIUM_TRANSCRIPTION_URL: 'https://env.example.com/v1/audio/transcriptions', CLAVARIUM_TRANSCRIPTION_MODEL: 'env-model' } });
    assert.deepEqual([d.about().source, d.about().env, d.model], ['env', { model: 'env-model' }, 'env-model']);
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY', language: 'fr' });
    assert.equal(d.about().source, 'settings');
    assert.equal(await d.transcribe(wav), 'heard');
    assert.deepEqual(sent.at(-1), { url: PROVIDERS.groq.url, auth: 'Bearer the-key-value', model: 'whisper-large-v3-turbo', language: 'fr', redirect: 'error' });
    d.off();
    assert.equal(d.about().source, 'env');
    await d.transcribe(wav);
    assert.equal(sent.at(-1).url, 'https://env.example.com/v1/audio/transcriptions');
    assert.equal(dictation().d.current(), undefined, 'neither: none');
});

test('the key is a secret, resolved by name when transcribing; never in what the page is given', async () => {
    const { d, sent } = dictation();
    assert.throws(() => d.set({ provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1', secret: 'NOPE' }), /No secret has this name/);
    d.set({ provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1', secret: 'STT_KEY' });
    const about = JSON.stringify(d.about());
    assert.equal(about.includes('the-key-value'), false);
    assert.equal(d.about().secret, 'STT_KEY');
    await d.try({ provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1', secret: 'STT_KEY' }, wav);
    assert.equal(sent.at(-1).auth, 'Bearer the-key-value');
    /* A failing engine: neither the key nor the address is passed on. */
    const failing = new Dictation({ secret: () => 'the-key-value', lookup: PUBLIC, fetcher: async () => { throw new Error('the-key-value at https://api.openai.com'); } });
    await assert.rejects(failing.try({ provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1', secret: 'STT_KEY' }, wav), (e) => !e.message.includes('the-key-value') && !e.message.includes('openai'));
});

test('where it may send: https, never this server\'s own network but with "Other"; checked again on what the name resolves to', async () => {
    const ok = { provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1' };
    assert.equal(dictationProblem(ok), undefined);
    assert.match(dictationProblem({ ...ok, url: 'http://api.openai.com/v1/audio/transcriptions' }), /https/);
    assert.match(dictationProblem({ ...ok, url: 'https://localhost:9000/v1' }), /only with "Other/);
    assert.match(dictationProblem({ ...ok, url: `https://${lan}/v1` }), /only with "Other/);
    assert.match(dictationProblem({ ...ok, url: 'https://[fd00::1]/v1' }), /only with "Other/);
    assert.match(dictationProblem({ ...ok, url: 'https://u:p@example.com/v1' }), /password/);
    assert.match(dictationProblem({ ...ok, provider: 'google' }), /provider/);
    assert.match(dictationProblem({ ...ok, language: 'french!' }), /language/);
    assert.match(dictationProblem({ ...ok, model: '' }), /model/);
    assert.equal(dictationProblem({ provider: 'other', url: `http://${lan}:8000/v1/audio/transcriptions`, model: 'local' }), undefined, 'an engine of one\'s own');
    assert.equal(dictationProblem({ provider: 'other', url: 'http://localhost:8000/v1', model: 'local' }), undefined);
    assert.match(dictationProblem({ provider: 'other', url: 'http://stt.example.com/v1', model: 'm' }), /https/, 'plain http only on its own network');
    assert.deepEqual(['localhost', '127.0.0.1', '::1', 'fe80::1', 'printer', 'nas.local', '::ffff:127.0.0.1'].map(isPrivateHost), [true, true, true, true, true, true, true]);
    assert.deepEqual(['api.openai.com', '2001:db8::1'].map(isPrivateHost), [false, false]);
    /* A public name that resolves into the server's network: refused at use. */
    const { d, sent } = dictation({ lookup: async () => [{ address: lan }] });
    await assert.rejects(d.try(ok, wav), /own network/);
    d.set(ok);
    await assert.rejects(d.transcribe(wav), /own network/);
    assert.equal(sent.length, 0, 'nothing was sent');
});
