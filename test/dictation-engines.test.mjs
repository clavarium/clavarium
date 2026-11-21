import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dictation, PROVIDERS, migrated, engineDown, MAIN_RETRY_MS } from '../server/voice.mjs';
import { Engines, isSpeechToText, keysFor, newKeyName, MODELS_TTL_MS } from '../server/dictation-engines.mjs';

const PUBLIC = async () => [{ address: '2001:db8::1' }];
function wavOf(samples = 1600) {
    const b = Buffer.alloc(44 + samples * 2);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'latin1'); b.writeUInt32LE(samples * 2, 40);
    return b;
}
const wav = wavOf();
const memory = (value = {}) => { let v = value; return { get: () => v, set: (x) => { v = x; }, peek: () => v }; };
const SECRETS = { OVH_AI_ENDPOINTS_KEY: 'ovh-value', MISTRAL_DICTATION_KEY: 'mistral-value', GROQ_KEY: 'groq-value' };
const MAIN = { provider: 'ovh', url: PROVIDERS.ovh.url, model: 'whisper-large-v3-turbo', secret: 'OVH_AI_ENDPOINTS_KEY' };
const BACKUP = { provider: 'mistral', url: PROVIDERS.mistral.url, model: 'voxtral-mini-latest', secret: 'MISTRAL_DICTATION_KEY' };

/* A fake web: each address answers from its own queue of statuses (200 = a text); the last one repeats. */
function web(plan) {
    const asked = [];
    const fetcher = async (url, init) => {
        asked.push(url);
        const queue = plan[url] ?? [404];
        const step = queue.length > 1 ? queue.shift() : queue[0];
        if (step === 'unreachable') throw new Error('connect ECONNREFUSED');
        if (step === 200) return new Response(JSON.stringify({ text: url.includes('mistral') ? 'from the backup' : 'from the main' }));
        if (typeof step === 'object') return new Response(JSON.stringify(step));
        return new Response('{}', { status: step });
    };
    return { asked, fetcher };
}

test('a dictation.json of before (one engine) is read as the main one, unchanged; a backup "none" is no backup', () => {
    const before = { provider: 'groq', url: PROVIDERS.groq.url, model: 'whisper-large-v3-turbo', secret: 'GROQ_KEY', language: 'fr', on: true };
    assert.deepEqual(migrated(before), { on: true, language: 'fr', main: { provider: 'groq', url: PROVIDERS.groq.url, model: 'whisper-large-v3-turbo', secret: 'GROQ_KEY' }, backup: null });
    assert.deepEqual(migrated({}), { on: false, language: '', main: null, backup: null });
    assert.equal(migrated({ on: true, main: MAIN, backup: { provider: 'none' } }).backup, null);
    const sent = [];
    const d = new Dictation({ file: memory(before), secret: (n) => SECRETS[n], lookup: PUBLIC, fetcher: async (url, init) => { sent.push([url, init.headers.authorization, init.body.get('language')]); return new Response('{"text":"ok"}'); } });
    assert.equal(d.about().source, 'settings');
    assert.equal(d.about().provider, 'groq', 'the main engine\'s fields stay at the top');
    assert.equal(d.about().backup, null);
    return d.transcribe(wav).then((text) => { assert.equal(text, 'ok'); assert.deepEqual(sent, [[PROVIDERS.groq.url, 'Bearer groq-value', 'fr']]); });
});

test('main and backup are checked alike; a body of before sets the main one and keeps the backup', () => {
    const file = memory();
    const d = new Dictation({ file, secret: (n) => SECRETS[n], lookup: PUBLIC });
    d.set({ language: 'fr', main: MAIN, backup: BACKUP });
    assert.deepEqual(file.peek(), { on: true, language: 'fr', main: MAIN, backup: BACKUP });
    assert.throws(() => d.set({ main: MAIN, backup: { ...BACKUP, url: 'http://api.mistral.ai/v1/audio/transcriptions' } }), /^Refusal: Backup: .*https|Backup: .*https/);
    assert.throws(() => d.set({ main: MAIN, backup: { ...BACKUP, secret: 'NOPE' } }), /Backup: No secret/);
    assert.throws(() => d.set({ main: { ...MAIN, provider: 'google' }, backup: BACKUP }), /provider/);
    assert.throws(() => d.set({ main: { ...MAIN, model: 'a b' } }), /model/);
    assert.deepEqual(file.peek().backup, BACKUP, 'a refused choice changes nothing');
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: 'whisper-large-v3', secret: 'GROQ_KEY', language: 'en' });
    assert.deepEqual([file.peek().main.provider, file.peek().backup?.provider, file.peek().language], ['groq', 'mistral', 'en']);
    d.set({ main: MAIN, backup: { provider: 'none' } });
    assert.equal(file.peek().backup, null);
    /* A secret renamed: both slots follow it. */
    d.set({ main: MAIN, backup: { ...BACKUP, secret: 'OVH_AI_ENDPOINTS_KEY' } });
    d.secretRenamed('OVH_AI_ENDPOINTS_KEY', 'OVH_AI_ENDPOINTS_KEY_2');
    assert.deepEqual([file.peek().main.secret, file.peek().backup.secret], ['OVH_AI_ENDPOINTS_KEY_2', 'OVH_AI_ENDPOINTS_KEY_2']);
});

test('the engine is down on unreachable, timeout, 401, 402, 429, 5xx; not on 400', () => {
    for (const code of [0, 401, 402, 429, 500, 503]) assert.equal(engineDown({ engine: code }), true, String(code));
    for (const code of [400, 413, 422, undefined]) assert.equal(engineDown({ engine: code }), false, String(code));
});

test('the main engine down: the same audio goes at once to the backup; said once per outage, and once when it is back', async () => {
    let now = 1_000_000;
    const notices = [];
    const { asked, fetcher } = web({ [MAIN.url]: [500, 'unreachable', 429, 200], [BACKUP.url]: [200] });
    const d = new Dictation({ file: memory({ on: true, main: MAIN, backup: BACKUP }), secret: (n) => SECRETS[n], lookup: PUBLIC, fetcher, notice: (t) => notices.push(t), now: () => now });
    assert.equal(await d.transcribe(wav, 'fr-FR'), 'from the backup');
    assert.deepEqual(asked, [MAIN.url, BACKUP.url]);
    assert.deepEqual(notices, ['Dictation: OVH down, Mistral took over']);
    assert.equal(d.about().down, 'OVH');
    /* Within the minute: straight to the backup, nothing said again. */
    asked.length = 0; now += 10_000;
    assert.equal(await d.transcribe(wav), 'from the backup');
    assert.deepEqual(asked, [BACKUP.url]);
    /* Past it: the main is tried again; still down (unreachable, then 429): the backup, still one line. */
    for (const _ of [1, 2]) { now += MAIN_RETRY_MS + 1; asked.length = 0; assert.equal(await d.transcribe(wav), 'from the backup'); assert.deepEqual(asked, [MAIN.url, BACKUP.url]); }
    assert.equal(notices.length, 1);
    /* The main answers again: said once. */
    now += MAIN_RETRY_MS + 1;
    assert.equal(await d.transcribe(wav), 'from the main');
    assert.deepEqual(notices, ['Dictation: OVH down, Mistral took over', 'Dictation: OVH back']);
    assert.equal(await d.transcribe(wav), 'from the main');
    assert.equal(notices.length, 2);
    assert.equal(d.about().down, null);
});

test('a 400 (the audio refused) does not go to the backup; no backup: the error goes up as before', async () => {
    const { asked, fetcher } = web({ [MAIN.url]: [400], [BACKUP.url]: [200] });
    const notices = [];
    const d = new Dictation({ file: memory({ on: true, main: MAIN, backup: BACKUP }), secret: (n) => SECRETS[n], lookup: PUBLIC, fetcher, notice: (t) => notices.push(t) });
    await assert.rejects(d.transcribe(wav), /answered 400/);
    assert.equal(asked.every((u) => u === MAIN.url), true);
    assert.deepEqual(notices, []);
    const alone = new Dictation({ file: memory({ on: true, main: MAIN }), secret: (n) => SECRETS[n], lookup: PUBLIC, fetcher: web({ [MAIN.url]: [503] }).fetcher });
    await assert.rejects(alone.transcribe(wav), (e) => e.status === 502 && e.engine === 503);
    /* Credits used up (402) on the main: the backup. A long recording (parts) too. */
    const both = web({ [MAIN.url]: [402], [BACKUP.url]: [200] });
    const d2 = new Dictation({ file: memory({ on: true, main: MAIN, backup: BACKUP }), secret: (n) => SECRETS[n], lookup: PUBLIC, fetcher: both.fetcher });
    assert.deepEqual(await d2.transcribeParts(wav), [{ speaker: null, start: 0, text: 'from the backup' }]);
});

test('the environment\'s backup (CLAVARIUM_TRANSCRIPTION_FALLBACK_*) when Settings name none', async () => {
    const env = { CLAVARIUM_TRANSCRIPTION_URL: 'https://first.example.com/v1/audio/transcriptions', CLAVARIUM_TRANSCRIPTION_FALLBACK_URL: 'https://second.example.com/v1/audio/transcriptions', CLAVARIUM_TRANSCRIPTION_FALLBACK_KEY: 'k2' };
    const notices = [];
    const { asked, fetcher } = web({ [env.CLAVARIUM_TRANSCRIPTION_URL]: [500], [env.CLAVARIUM_TRANSCRIPTION_FALLBACK_URL]: [{ text: 'second' }] });
    const d = new Dictation({ env, lookup: PUBLIC, fetcher, notice: (t) => notices.push(t) });
    assert.equal(await d.transcribe(wav), 'second');
    assert.deepEqual(asked, [env.CLAVARIUM_TRANSCRIPTION_URL, env.CLAVARIUM_TRANSCRIPTION_FALLBACK_URL]);
    assert.deepEqual(notices, ['Dictation: first.example.com down, second.example.com took over']);
});

test('models: the provider\'s listing kept to speech-to-text, known ones first with their label; kept 24 h; any failure gives the base list', async () => {
    let now = 0; let calls = 0; let answer = 200;
    const listing = { data: ['whisper-large-v3', 'nvr-tts-en-us', 'Mistral-Small-3.2-24B-Instruct-2506', 'whisper-large-v3-turbo', 'gpt-4o-mini-tts', 'voxtral-mini-transcribe-realtime-26-02', 'distil-speech-to-text'].map((id) => ({ id })) };
    const fetcher = async (url, init) => {
        calls++;
        assert.equal(url, 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models');
        assert.equal(init.headers.authorization, 'Bearer ovh-value');
        return answer === 200 ? new Response(JSON.stringify(listing)) : new Response('{}', { status: answer });
    };
    const e = new Engines({ fetcher, now: () => now });
    assert.deepEqual(await e.models('ovh', 'ovh-value'), [{ id: 'whisper-large-v3-turbo', label: 'fast' }, { id: 'whisper-large-v3', label: 'more accurate' }, { id: 'distil-speech-to-text', label: '' }]);
    now += MODELS_TTL_MS - 1;
    await e.models('ovh', 'ovh-value');
    assert.equal(calls, 1, 'kept 24 h');
    now += 2; answer = 500;
    assert.deepEqual(await e.models('ovh', 'ovh-value'), Engines.base('ovh'), 'a failure: the base list, silently');
    assert.equal(calls, 2);
    const unreachable = new Engines({ fetcher: async () => { throw new Error('down'); } });
    assert.deepEqual(await unreachable.models('mistral', 'k'), [{ id: 'voxtral-mini-latest', label: 'fast' }, { id: 'voxtral-small-latest', label: 'more accurate' }]);
    assert.deepEqual(await unreachable.models('groq'), Engines.base('groq'), 'no key: the base list, nothing asked');
    assert.deepEqual(await unreachable.models('other', 'k'), [], '"Other": a model typed in');
    assert.deepEqual(Engines.base('openai').map((m) => m.id), ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe']);
    assert.equal(isSpeechToText('gpt-4o-transcribe'), true);
    assert.equal(isSpeechToText('voxtral-mini-tts-3-0'), false);
    /* Through Dictation: by the secret's name, opened on this server. */
    const d = new Dictation({ secret: (n) => SECRETS[n], fetcher });
    answer = 200;
    assert.equal((await d.models('ovh', 'OVH_AI_ENDPOINTS_KEY'))[0].id, 'whisper-large-v3-turbo');
    await assert.rejects(d.models('google', 'X'), /provider/);
});

test('suggestions: keys by their names, a choice for each slot not set, the backup with another provider; never a value', async () => {
    assert.deepEqual(keysFor('ovh', ['OVH_AI_ENDPOINTS_KEY', 'OVH_OTHER', 'MISTRAL_X']), ['OVH_AI_ENDPOINTS_KEY']);
    assert.equal(newKeyName('mistral', ['MISTRAL_DICTATION_KEY']), 'MISTRAL_DICTATION_KEY_2');
    assert.equal(newKeyName('ovh', []), 'OVH_AI_ENDPOINTS_DICTATION_KEY');
    const fetcher = async () => { throw new Error('offline'); };
    const names = ['OVH_AI_ENDPOINTS_KEY', 'MISTRAL_DICTATION_KEY', 'ELEVENLABS_API_KEY', 'GROQ_KEY'];
    const fresh = new Dictation({ secret: (n) => SECRETS[n], names: () => names, fetcher });
    const all = await fresh.suggestions();
    assert.deepEqual(all.suggestions, [
        { slot: 'main', provider: 'ovh', model: 'whisper-large-v3-turbo', secret: 'OVH_AI_ENDPOINTS_KEY' },
        { slot: 'backup', provider: 'mistral', model: 'voxtral-mini-latest', secret: 'MISTRAL_DICTATION_KEY' },
    ]);
    assert.deepEqual(all.providers.find((p) => p.id === 'groq').keys, ['GROQ_KEY']);
    assert.equal(JSON.stringify(all).includes('-value'), false, 'never a value');
    /* The main one set (Mistral): only the backup is suggested, another provider. */
    const set = new Dictation({ file: memory({ on: true, main: BACKUP }), secret: (n) => SECRETS[n], names: () => names, fetcher, lookup: PUBLIC });
    assert.deepEqual((await set.suggestions()).suggestions, [{ slot: 'backup', provider: 'ovh', model: 'whisper-large-v3-turbo', secret: 'OVH_AI_ENDPOINTS_KEY' }]);
    const full = new Dictation({ file: memory({ on: true, main: BACKUP, backup: MAIN }), secret: (n) => SECRETS[n], names: () => names, fetcher, lookup: PUBLIC });
    assert.deepEqual((await full.suggestions()).suggestions, []);
});
