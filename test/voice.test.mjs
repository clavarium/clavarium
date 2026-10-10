import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDictation, withoutLoop, transcribe, voiceConfig } from '../server/voice.mjs';
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
