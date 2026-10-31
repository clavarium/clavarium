import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDictation, withoutLoop, transcribe, voiceConfig, Dictation, PROVIDERS, dictationProblem, isPrivateHost, withoutCharLoop, withoutPhantoms, capToDuration, wavSeconds, languageOf, deviceLanguage } from '../server/voice.mjs';
import { Detector, Segmenter, toWav, loudness, BLOCK, BLOCK_MS, RATE, MAXIMUM_MS, SOFT_MAXIMUM_MS } from '../web/voice-core.js';

const wav = Buffer.from(toWav([new Float32Array(BLOCK).fill(0.1)]));

test('what an engine returns is cleaned before it can be typed: nothing a terminal would obey', () => {
    assert.equal(cleanDictation('hello\r\nrm -rf /\n'), 'hello rm -rf /', 'a line break is Enter: it becomes a space');
    assert.equal(cleanDictation('a\x1b[2Jb\x00c‮d​e'), 'a[2Jbcde');
    assert.equal(cleanDictation('  spaced   out  '), 'spaced out');
    assert.equal(cleanDictation('ab cd '.repeat(1000)).length <= 2000, true);
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
function dictation({ env = {}, secrets = { STT_KEY: 'the-key-value' }, lookup = PUBLIC, expired = () => false } = {}) {
    const sent = [];
    const fetcher = async (url, init) => { sent.push({ url, auth: init.headers.authorization, model: init.body.get('model'), language: init.body.get('language'), redirect: init.redirect }); return new Response(JSON.stringify({ text: 'heard' })); };
    return { d: new Dictation({ env, secret: (n) => secrets[n], expired, lookup, fetcher }), sent };
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

/* WHAT AN ENGINE GETS WRONG, whichever it is: nothing here is known of one model alone (asked 22-10). */
test('a loop inside a word is brought back to once', () => {
    assert.equal(cleanDictation(`il parle de l'${'érit'.repeat(300)} et voilà`), "il parle de l'érit et voilà");
    assert.equal(withoutCharLoop('bonjour, ça va'), 'bonjour, ça va');
    assert.equal(withoutCharLoop('haha'), 'haha');
    assert.equal(withoutCharLoop('1000 personnes en 2020'), '1000 personnes en 2020');
});
test('the credits an engine writes on silence (learned from subtitles) are removed, and only those', () => {
    assert.equal(withoutPhantoms("Sous-titrage ST' 501"), '');
    assert.equal(withoutPhantoms("Sous-titres réalisés par la communauté d'Amara.org"), '');
    assert.equal(withoutPhantoms("Lance les tests. Sous-titrage ST' 501"), 'Lance les tests.');
    assert.equal(withoutPhantoms('Bonjour, quelle heure est-il dans le salon ? Sous-titrage FR ?'), 'Bonjour, quelle heure est-il dans le salon ?');
    assert.equal(withoutPhantoms('Le sous-titrage de la vidéo est faux'), 'Le sous-titrage de la vidéo est faux');
});
test('those credits in any language the engine learned them in', () => {
    for (const credit of ['Untertitel der Amara.org-Community', 'Subtítulos por la comunidad de Amara.org', 'Sottotitoli creati dalla comunità Amara.org', 'Ondertiteling door de Amara.org gemeenschap', 'Untertitelung im Auftrag des ZDF, 2017']) assert.equal(withoutPhantoms(credit), '', credit);
    assert.equal(withoutPhantoms('Starte die Tests. Untertitel der Amara.org-Community'), 'Starte die Tests.');
});
test('no more text than the audio could hold', () => {
    assert.equal(capToDuration('a b c', 0.5), 'a b c');
    assert.ok(capToDuration('mot '.repeat(500), 2).length <= 80);
    assert.equal(Math.round(wavSeconds(Buffer.from(toWav([new Float32Array(RATE)])))), 1);
});

/* WHAT A PERSON SAYS IS LEFT AS IT IS: sentences any engine may return, French and English, through the whole
   cleaning, at the length of audio they would take (about 12 characters a second, slower than anyone speaks). */
const SAID = [
    "Lance les tests unitaires, puis les tests navigateur, et dis-moi ce qui casse.",
    "Non, non, pas celui-là : l'autre fichier, celui de la configuration.",
    "Oui.",
    "Hahaha, d'accord, c'est drôle.",
    "Le sous-titrage de la vidéo est décalé de deux secondes.",
    "On a 1000 utilisateurs en 2020, 2500 en 2024, et 10 000 visés en 2026.",
    "Ajoute trois points : un, deux, trois.",
    "Very very good, ship it.",
    "Please run npm test and tell me what fails.",
    "Le numéro est le 06 12 34 56 78.",
    "Bonbon, dodo, coucou : des mots qui se répètent.",
    "C'est bien bien mieux comme ça.",
    /* Other languages, other scripts: the cleaning knows none of them. */
    'Starte bitte die Tests und sag mir, was fehlschlägt.',
    'Los subtítulos de la película están desfasados.',
    'Esegui i test, per favore.',
    'Запусти тесты и скажи, что не работает.',
    'テストを実行して、失敗した箇所を教えてください。',
    '请运行测试，然后告诉我哪里失败了。',
    'اختبر التطبيق من فضلك.',
];
test('what a person says comes back as it was said: no cleaning takes a word away', () => {
    for (const said of SAID) assert.equal(cleanDictation(said, said.length / 12), said, said);
});
/* WHAT ENGINES ARE KNOWN TO RETURN WRONG, whichever model: each comes back short and readable. */
test('what engines return wrong is brought back: loops in a word, loops of words, credits on silence, text longer than the audio', () => {
    const cases = [
        [`On parle de l'${'éritér'.repeat(200)}`, 2, /^On parle de l'éritér$/],
        [`${'je vais voir '.repeat(40)}demain`, 3, /^je vais voir/],
        ["Sous-titrage ST' 501", 0.8, /^$/],
        ['Subtitles by the Amara.org community', 0.8, /^$/],
        [`Bonjour. ${'Merci. '.repeat(100)}`, 1.5, /^Bonjour\. Merci\./],
    ];
    for (const [raw, seconds, wanted] of cases) {
        const out = cleanDictation(raw, seconds);
        assert.match(out, wanted, raw.slice(0, 40));
        assert.ok(out.length <= 30 + 25 * seconds, `${raw.slice(0, 30)}: ${out.length} characters for ${seconds} s`);
    }
});

/* EVERY PROVIDER OFFERED gets the same request, one any OpenAI-compatible engine reads. */
test('every provider gets the same request: its file, its model, the language when set, JSON, greedy decoding', async () => {
    for (const [id, p] of Object.entries(PROVIDERS)) {
        if (!p.url) continue;
        let got;
        const text = await transcribe({ url: p.url, model: p.model, language: 'fr', provider: id }, wav, async (url, init) => { got = { url, fields: Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : 'a file'])) }; return new Response('{"text":"Bonjour."}'); });
        assert.equal(text, 'Bonjour.', id);
        assert.deepEqual(got, { url: p.url, fields: { file: 'a file', model: p.model, language: 'fr', response_format: 'json', temperature: '0' } }, id);
    }
});
test('an engine that refuses greedy decoding is asked again at once without it, and not asked with it again', async () => {
    const config = { url: 'https://stt.example.com/refuses', model: 'm', provider: 'other' };
    const asked = [];
    const engine = async (url, init) => { const t = init.body.get('temperature'); asked.push(t); return t === null ? new Response('{"text":"Bonjour."}') : new Response('{"error":"unknown field temperature"}', { status: 422 }); };
    assert.equal(await transcribe(config, wav, engine), 'Bonjour.');
    assert.deepEqual(asked, ['0', null]);
    assert.equal(await transcribe(config, wav, engine), 'Bonjour.');
    assert.deepEqual(asked, ['0', null, null], 'remembered');
    /* Another refusal is not that: said as it is. */
    await assert.rejects(transcribe({ ...config, url: 'https://stt.example.com/down' }, wav, async () => new Response('', { status: 401 })), /answered 401/);
});

/* THE PAGE SENDS PIECES THE ENGINE CAN TAKE: never longer than the server accepts, never a near-silence. */
test('a phrase is cut at a short pause past 12 s, and at 15 s whatever: never longer than the server takes', () => {
    const second = Math.round(1000 / BLOCK_MS);
    const talk = (pattern) => { const sizes = []; const d = new Detector(); const sg = new Segmenter({ onPhrase: (b) => sizes.push(b.length) }); let n = 0;
        for (const [level, count] of pattern) for (let i = 0; i < count; i++) { const x = new Float32Array(BLOCK).fill(level); sg.feed(d.hear(loudness(x)), n++ * BLOCK_MS, x); } return sizes; };
    const longest = Math.max(...talk([[0.005, 2 * second], [0.2, 40 * second], [0.005, second]]));
    assert.ok(longest * BLOCK_MS <= MAXIMUM_MS + 400, String(longest * BLOCK_MS));
    assert.ok(Buffer.from(toWav([new Float32Array(Math.ceil((MAXIMUM_MS + 400) / 1000 * RATE))])).length <= 512 * 1024, 'within AUDIO_MAX');
    /* Speech with short breaths: cut at a breath once past 12 s. */
    const breaths = []; for (let i = 0; i < 20; i++) breaths.push([0.2, second], [0.005, 8]);
    const pieces = talk([[0.005, 2 * second], ...breaths, [0.005, second]]);
    assert.ok(pieces.length >= 2 && pieces[0] * BLOCK_MS >= SOFT_MAXIMUM_MS - 1000 && pieces[0] * BLOCK_MS <= MAXIMUM_MS + 400, String(pieces.map((p) => p * BLOCK_MS)));
});
test('clicks and keys in a quiet room are not a phrase; a short word is', () => {
    const second = Math.round(1000 / BLOCK_MS);
    const talk = (pattern) => { let count = 0; const d = new Detector(); const sg = new Segmenter({ onPhrase: () => { count++; } }); let n = 0;
        for (const [level, k] of pattern) for (let i = 0; i < k; i++) { const x = new Float32Array(BLOCK).fill(level); sg.feed(d.hear(loudness(x)), n++ * BLOCK_MS, x); } return count; };
    const typing = []; for (let i = 0; i < 12; i++) typing.push([0.3, 2], [0.005, 6]);
    assert.equal(talk([[0.005, 2 * second], ...typing, [0.005, second]]), 0, 'keys: loud, short, many: no phrase');
    assert.equal(talk([[0.005, 2 * second], [0.2, 9], [0.005, second]]), 1, '"oui": about 300 ms');
});

test('a key past its expiry day is never sent: dictation refuses in one line, and the page is told', async () => {
    const gone = new Set();
    const { d, sent } = dictation({ expired: (n) => gone.has(n) });
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY' });
    assert.equal(await d.transcribe(wav), 'heard');
    assert.equal(d.about().secretExpired, false);
    gone.add('STT_KEY');
    const before = sent.length;
    await assert.rejects(d.transcribe(wav), (e) => e.status === 409 && e.message === 'Dictation key expired: replace it in Assets > Secrets.');
    await assert.rejects(d.try({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY' }, wav), /Dictation key expired/);
    assert.equal(sent.length, before, 'nothing went to the engine');
    assert.equal(d.about().secretExpired, true);
    assert.equal(d.model, PROVIDERS.groq.model, 'still offered: the line is seen when it is used');
    gone.delete('STT_KEY');
    assert.equal(await d.transcribe(wav), 'heard', 'a new expiry: used again');
});

test('the language: the one chosen, else the device\'s; guessed by the engine only when "auto" is chosen', () => {
    assert.equal(languageOf('', 'fr-FR'), 'fr', 'nothing chosen: the device\'s, cut to its language');
    assert.equal(languageOf(undefined, 'fr_CA'), 'fr');
    assert.equal(languageOf('de', 'fr-FR'), 'de', 'chosen: wins over the device');
    assert.equal(languageOf('pt-BR', 'fr'), 'pt-BR');
    assert.equal(languageOf('auto', 'fr-FR'), undefined, '"auto": left to the engine');
    assert.equal(languageOf('', undefined), undefined, 'nothing known: left to the engine');
    assert.equal(languageOf('', 'not a tag!'), undefined);
    assert.equal(deviceLanguage('EN-us'), 'en');
    assert.equal(deviceLanguage('*'), undefined);
    assert.equal(dictationProblem({ provider: 'openai', url: PROVIDERS.openai.url, model: 'whisper-1', language: 'auto' }), undefined);
});

test('a French device gets French asked of the engine, never a guess per phrase', async () => {
    const { d, sent } = dictation({ env: { CLAVARIUM_TRANSCRIPTION_URL: 'https://env.example.com/v1/audio/transcriptions' } });
    await d.transcribe(wav, 'fr-FR');
    assert.equal(sent.at(-1).language, 'fr', 'the environment\'s engine, no language set: the device\'s');
    await d.transcribe(wav);
    assert.equal(sent.at(-1).language, null, 'no device language: none sent');
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY', language: '' });
    await d.transcribe(wav, 'fr-FR');
    assert.equal(sent.at(-1).language, 'fr', 'Settings, "Each device\'s": the device\'s');
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY', language: 'en' });
    await d.transcribe(wav, 'fr-FR');
    assert.equal(sent.at(-1).language, 'en', 'a language chosen: that one');
    d.set({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY', language: 'auto' });
    await d.transcribe(wav, 'fr-FR');
    assert.equal(sent.at(-1).language, null, '"Automatic": the engine guesses');
    await d.try({ provider: 'groq', url: PROVIDERS.groq.url, model: PROVIDERS.groq.model, secret: 'STT_KEY', language: '' }, wav, 'fr-BE');
    assert.equal(sent.at(-1).language, 'fr', '"Try it" too');
    const auto = dictation({ env: { CLAVARIUM_TRANSCRIPTION_URL: 'https://env.example.com/v1/audio/transcriptions', CLAVARIUM_TRANSCRIPTION_LANGUAGE: 'auto' } });
    await auto.d.transcribe(wav, 'fr-FR');
    assert.equal(auto.sent.at(-1).language, null, 'the environment may ask for "auto" too');
});
