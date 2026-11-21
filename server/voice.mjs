/* VOICE: a spoken phrase comes in as audio, goes out as text to type.
 *
 * The audio is handed to a speech-to-text engine that speaks the usual
 * "audio transcriptions" HTTP interface: a local one, or a hosted open model.
 * Nothing is kept: not the audio, not the text.
 *
 * WHAT COMES BACK IS TYPED STRAIGHT INTO A TERMINAL, so it is treated as what
 * it is: text chosen by a third party. Everything a terminal would obey
 * rather than display is removed -- control characters, line breaks included
 * (a line break is Enter), direction marks, zero-width characters -- and the
 * length is bounded: a dictation is a sentence, not a file.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Refusal } from './conversations.mjs';
import { JsonFile } from './store.mjs';
import { isSecretName } from './secrets.mjs';
import { PROVIDERS, Engines } from './dictation-engines.mjs';

export { PROVIDERS };

export const AUDIO_MAX = 512 * 1024;
export const TEXT_MAX = 2000;
export const TIMEOUT_MS = 60_000;
export const DEFAULT_MODEL = 'whisper-large-v3-turbo';

/* The engine's settings come from the environment, never from arguments: the
   key must not show in a process list. */
/* `prefix`: CLAVARIUM_TRANSCRIPTION_FALLBACK_ names a backup engine, asked when the main one is down. */
export function voiceConfig(env = process.env, prefix = 'CLAVARIUM_TRANSCRIPTION_') {
    const url = (env[`${prefix}URL`] ?? '').trim();
    if (url === '') return undefined;
    return {
        url,
        key: (env[`${prefix}KEY`] ?? '').trim() || undefined,
        model: (env[`${prefix}MODEL`] ?? '').trim() || DEFAULT_MODEL,
        language: (env[`${prefix}LANGUAGE`] ?? '').trim() || undefined,
    };
}
/* THE ENGINE IS DOWN, not the audio wrong: unreachable or too slow (0), key refused or credits used up
   (401, 402), busy (429), failing (5xx). A 400 is the audio's: no backup for it. */
export const engineDown = (error) => [0, 401, 402, 429].includes(error?.engine) || error?.engine >= 500;
const engineError = (message, engine) => Object.assign(new Refusal(502, message), { engine });

// eslint-disable-next-line no-control-regex
const NOT_TYPED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const REPEATS_MAX = 2;

/* THE ENGINE'S LOOP, brought back to once. Measured on real voices with the
   former system: a hesitant two-second segment came back as the same few
   words repeated dozens of times. A run of 1 to 8 words repeated at least 3
   times in a row is kept once; a wanted repetition ("no, no") is two, and stays. */
export function withoutLoop(text) {
    const words = text.split(/\s+/).filter(Boolean);
    const norm = (w) => w.toLowerCase().replace(/[.,;:!?…]+$/u, '');
    const out = [];
    let i = 0;
    while (i < words.length) {
        let skip = 0;
        for (let n = 1; n <= 8 && i + n * (REPEATS_MAX + 1) <= words.length; n++) {
            const motif = words.slice(i, i + n).map(norm).join(' ');
            let k = 1;
            while (i + (k + 1) * n <= words.length && words.slice(i + k * n, i + (k + 1) * n).map(norm).join(' ') === motif) k++;
            if (k > REPEATS_MAX) { out.push(...words.slice(i, i + n)); skip = k * n; break; }
        }
        if (skip > 0) { i += skip; continue; }
        out.push(words[i]);
        i++;
    }
    return out.join(' ');
}

/* A LOOP INSIDE A WORD: "l'éritéritéritérit..." has no space, so withoutLoop
   cannot see it. A run of 2 to 20 characters repeated 4 times or more in a
   row is kept once. */
export function withoutCharLoop(text) {
    return text.replace(/(.{2,20}?)\1{3,}/gsu, '$1');
}

/* WHAT WHISPER WRITES ON SILENCE: credits of the subtitles it learned from.
   Nobody dictates these; they are removed wherever they appear. */
const PHANTOMS = [
    /* Any sentence that credits Amara.org, in whatever language ("Sous-titres réalisés par la communauté
       d'Amara.org", "Untertitel der Amara.org-Community", "Subtítulos por la comunidad de Amara.org"...). */
    /[^.!?。]*amara\.org[^.!?。]*[.!?。]?/giu,
    /sous[- ]titrage\s*st\b\s*'?\s*\d*[.!]?/giu,
    /sous[- ]titrage\s+fr(?:ançais)?\s*[.!?]?/giu,
    /sous[- ]titr(?:age|es?)\s+(?:par\s+)?(?:la\s+)?société\s+radio[- ]canada[.!]?/giu,
    /* A credit to a person, when it is all that was "heard" ("Sous-titres par Jérémy Diaz", 31-10). */
    /^\s*[Ss]ous[- ]titr(?:age|es?)(?:\s+réalisés?)?\s+par\s+(?:\p{Lu}[\p{L}'-]*\s*){1,3}[.!]?\s*$/gu,
    /* YouTube endings, heard on a button press with nothing said (01-11: "Thank you for watching and see
       you in the next video!"): only when they are all of it. */
    /* « There you go. » alone, on a near silence (03-11, 5 a.m., nobody spoke): only when it is all of it. */
    /^\s*there you go[.!]?\s*$/giu,
    /^\s*(?:thank(?:s| you) (?:so much )?for watching[.!,]?\s*(?:(?:and )?see you (?:in the |on the )?next (?:video|time)[.!]?)?|see you (?:in the )?next (?:video|time)[.!]?|merci d'avoir regardé(?: cette vidéo)?\s*[.!]?(?:\s*[àa] bient[ôo]t[.!]?)?)\s*$/giu,
    /untertitel(?:ung)?\s+(?:im\s+auftrag\s+)?des\s+zdf(?:\s+für\s+funk)?,?\s*\d{0,4}[.!]?/giu,
];
/* Chinese, Japanese or Korean mixed into Latin words: written on a room's silence (01-11: « Sous 谢谢 大家 »);
   a sentence wholly in one of them is kept. And the « Sous » its credits leave behind, when it is all. */
const FOREIGN_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
export function withoutPhantoms(text) {
    let t = text;
    for (const re of PHANTOMS) t = t.replace(re, ' ');
    if (/\p{Script=Latin}/u.test(t)) t = t.replace(FOREIGN_SCRIPT, ' ');
    t = t.replace(/\s+/gu, ' ').trim();
    return /^sous[.!,…]*$/iu.test(t) ? '' : t;
}

/* SPEECH HAS A SPEED: nobody says more than ~25 characters a second. More
   text than the audio could hold is the engine running on; it is cut at a
   word. `seconds` undefined: no cap but TEXT_MAX. */
export const CHARS_PER_SECOND = 25;
export function capToDuration(text, seconds) {
    if (!Number.isFinite(seconds)) return text;
    const max = Math.ceil(30 + CHARS_PER_SECOND * seconds);
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/* The length of a WAV, in seconds, from its header (bytes per second at 28). */
export function wavSeconds(audio) {
    const rate = audio.length >= 44 ? audio.readUInt32LE(28) : 0;
    return rate > 0 ? Math.max(0, audio.length - 44) / rate : undefined;
}

export function cleanDictation(raw, seconds) {
    const flat = String(raw ?? '').replace(/[\r\n\t]+/gu, ' ').replace(NOT_TYPED, '');
    return capToDuration(withoutLoop(withoutPhantoms(withoutCharLoop(flat))), seconds).slice(0, TEXT_MAX).trim();
}

/* The engines (address and model) that refused "temperature": not asked with it again while this server runs. */
const noTemperature = new Set();

/* `audio` is a WAV file, as bytes. Resolves with the text to type. */
/* ONE VOICE: a voice box hears a room, a TV included. OVH's engine tells voices apart (diarize): only the
   voice that spoke first -- the person who called the box -- is kept (31-10). Other engines: the whole text. */
const DIARIZES = /^https:\/\/oai\.endpoints\.kepler\.ai\.cloud\.ovh\.net\//;
export function firstVoice(body) {
    const parts = Array.isArray(body?.diarization) ? body.diarization.filter((p) => typeof p?.text === 'string') : [];
    if (parts.length === 0) return null;
    const who = parts[0].speaker;
    return parts.filter((p) => p.speaker === who).map((p) => p.text.trim()).join(' ');
}

export async function transcribe(config, audio, fetcher = fetch, { oneVoice = false, withLanguage = false } = {}) {
    if (!config) throw new Refusal(503, 'No speech-to-text engine is configured.');
    if (audio.length === 0) throw new Refusal(400, 'The recording is empty.');
    if (audio.length > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.');
    if (audio.subarray(0, 4).toString('latin1') !== 'RIFF' || audio.subarray(8, 12).toString('latin1') !== 'WAVE') {
        throw new Refusal(400, 'The recording is not a WAV file.');
    }
    /* Greedy decoding asked of every engine: sampling is what lets a loop run. An engine that refuses the field
       (a 400 or 422: not every one takes it) is asked again without it, at once, and not asked with it again --
       the same for every engine, nothing known of any in advance. */
    const strict = !noTemperature.has(`${config.url} ${config.model}`);
    const ask = (withTemperature) => {
        const form = new FormData();
        form.append('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
        form.append('model', config.model);
        if (config.language) form.append('language', config.language);
        const diarize = oneVoice && DIARIZES.test(String(config.url));
        form.append('response_format', diarize ? 'verbose_json' : 'json');
        if (diarize) form.append('diarize', 'true');
        if (withTemperature) form.append('temperature', '0');
        return fetcher(config.url, { method: 'POST', redirect: 'error', headers: config.key ? { authorization: `Bearer ${config.key}` } : {}, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    };
    let response;
    try {
        response = await ask(strict);
        if (strict && (response.status === 400 || response.status === 422)) {
            const again = await ask(false);
            if (again.ok) noTemperature.add(`${config.url} ${config.model}`);
            response = again;
        }
    } catch {
        /* The error of a failed request repeats the address it was sent to:
           it is not passed on. */
        throw engineError('The speech-to-text engine cannot be reached.', 0);
    }
    if (!response.ok) throw engineError(`The speech-to-text engine answered ${response.status}.`, response.status);
    const body = await response.json().catch(() => undefined);
    if (typeof body?.text !== 'string') throw new Refusal(502, 'The speech-to-text engine gave no text.');
    const text = cleanDictation((oneVoice && firstVoice(body)) || body.text, wavSeconds(audio));
    /* The language the engine heard, when asked for (a voice box checks it, 02-11). */
    return withLanguage ? { text, language: codeOfLanguage(body.language) } : text;
}
/* "french" or "fr" -> "fr": the engines name it either way. */
const LANGUAGE_NAMES = { french: 'fr', english: 'en', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', danish: 'da', norwegian: 'no', swedish: 'sv', chinese: 'zh', japanese: 'ja', russian: 'ru', polish: 'pl', arabic: 'ar' };
export function codeOfLanguage(given) {
    const g = String(given ?? '').trim().toLowerCase();
    if (!g) return null;
    return LANGUAGE_NAMES[g] ?? (/^[a-z]{2,3}(-|$)/.test(g) ? g.slice(0, 2) : null);
}
/* A VOICE BOX'S SENTENCE (02-11): heard in any language -- but a short sentence is sometimes taken for
   another (Danish for French): when the engine heard neither the box's language nor English, it is heard
   again in the box's language. Universal, and not fooled. */
export async function hearBox(dictation, wav, lang) {
    const first = await dictation.transcribe(wav, undefined, { oneVoice: true, withLanguage: true });
    const want = codeOfLanguage(lang); const got = codeOfLanguage(first?.language);
    if (!want || !got || got === want || got === 'en') return first?.text ?? first;
    return dictation.transcribe(wav, lang, { oneVoice: true });
}

/* A LONG RECORDING, in parts of a few minutes (a voice box records a meeting): each part's text, with who
   speaks when the engine tells voices apart (OVH: diarize). Parts up to 24 MB: what the engines take. */
export const PART_MAX = 24 * 1024 * 1024;
export async function transcribeParts(config, audio, fetcher = fetch) {
    if (!config) throw new Refusal(503, 'No speech-to-text engine is configured.');
    if (audio.length > PART_MAX) throw new Refusal(413, 'The part is too long.');
    const diarize = DIARIZES.test(String(config.url));
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
    form.append('model', config.model);
    if (config.language) form.append('language', config.language);
    form.append('response_format', diarize ? 'verbose_json' : 'json');
    if (diarize) form.append('diarize', 'true');
    let response;
    try { response = await fetcher(config.url, { method: 'POST', redirect: 'error', headers: config.key ? { authorization: `Bearer ${config.key}` } : {}, body: form, signal: AbortSignal.timeout(10 * 60_000) }); }
    catch { throw engineError('The speech-to-text engine cannot be reached.', 0); }
    if (!response.ok) throw engineError(`The speech-to-text engine answered ${response.status}.`, response.status);
    const body = await response.json().catch(() => undefined);
    if (Array.isArray(body?.diarization) && body.diarization.length) return body.diarization.map((p) => ({ speaker: Number(p.speaker) || 0, start: Number(p.start) || 0, text: withoutPhantoms(String(p.text ?? '')) })).filter((p) => p.text);
    if (typeof body?.text !== 'string') throw new Refusal(502, 'The speech-to-text engine gave no text.');
    const text = withoutPhantoms(body.text);
    return text ? [{ speaker: null, start: 0, text }] : [];
}

/* A SHORT REACTION while the answer is thought (a voice box, 01-11): a few words in the person's language that
   acknowledge what was said without answering it -- « bonne question, voyons… ». Only where the dictation's
   service also offers a fast chat model (OVH AI Endpoints); null otherwise, or when it is not quick. */
export const REACTION_MODEL = 'Mistral-Small-3.2-24B-Instruct-2506';
export async function quickReaction(config, said, fetcher = fetch) {
    if (!config?.key || !DIARIZES.test(String(config.url))) return null;
    const base = String(config.url).replace(/\/audio\/transcriptions\/?$/, '');
    try {
        const r = await fetcher(`${base}/chat/completions`, {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(3000),
            body: JSON.stringify({ model: REACTION_MODEL, temperature: 0.8, max_tokens: 40, messages: [
                /* 03-11: what it is going to do, in context, with a little life ("je fouille dans tes mails, je reviens vers
                   toi"), never the same stock phrase. */
                { role: 'system', content: 'Someone just spoke to a voice assistant, which needs some time to answer. Write ONE short spoken sentence (4 to 14 words) in the SAME language as what they said, saying what the assistant is now going to do for THIS request, warm and a little playful, never the same wording twice: e.g. "Je fouille dans tes mails, je reviens vers toi.", "Je jette un œil à ton agenda de demain.", "Let me dig through your files for that.". Never answer the question itself, never invent a result, never promise a time. No quotes, no emoji. Answer with the sentence only.' },
                { role: 'user', content: String(said).slice(0, 600) }] }),
        });
        if (!r.ok) return null;
        const t = String((await r.json())?.choices?.[0]?.message?.content ?? '').replace(/["«»]/g, '').trim();
        return t && t.length <= 60 && !/\n/.test(t) ? t : null;
    } catch { return null; }
}

/* The same small fast model, for a short answer to a given instruction (quick actions on a card, 02-11). */
export async function quickChat(config, system, user, fetcher = fetch, { maxTokens = 160, timeoutMs = 6000 } = {}) {
    if (!config?.key || !DIARIZES.test(String(config.url))) return null;
    const base = String(config.url).replace(/\/audio\/transcriptions\/?$/, '');
    const r = await fetcher(`${base}/chat/completions`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: REACTION_MODEL, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: String(user).slice(0, 3000) }] }),
    });
    if (!r.ok) return null;
    return String((await r.json())?.choices?.[0]?.message?.content ?? '');
}

/* ---------- THE ENGINE CHOSEN IN SETTINGS ----------
 * Settings > Dictation: a provider fills in the address and the model (both
 * may be changed); the key is one of the SECRETS already kept (Assets >
 * Secrets), named, never shown, never sent to a page: it is opened here, at
 * the moment of transcribing, and goes nowhere but in the request's header.
 * What is set there wins; the CLAVARIUM_TRANSCRIPTION_* environment stays
 * the fallback. Applied at once, without a restart.
 *
 * WHERE IT MAY SEND: the address is chosen in a page, and this server would
 * then post to it -- with a key. So: HTTPS only, and never an address of the
 * server's own network (loopback, private, link-local), checked again on what
 * the name resolves to at each use; except with "Other (compatible)", made
 * for an engine of one's own, where a local or private address is allowed,
 * plain HTTP included. */
/* PROVIDERS: dictation-engines.mjs. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
export const AUTOMATIC = 'auto';

/* WHICH LANGUAGE IS ASKED FOR. Left to the engine, the language is guessed
   again on every phrase -- a few seconds of audio, often hesitant -- and a
   French phrase came back as Icelandic. So a language is always given: the
   one chosen (Settings, else CLAVARIUM_TRANSCRIPTION_LANGUAGE), else the
   language of the device that dictates (its browser's first, sent with each
   phrase). Guessed only when "auto" is chosen, or nothing is known.
   The device's tag is cut to its language ("fr-CA" -> "fr"): what the engines take. */
export function deviceLanguage(tag) {
    const primary = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}
export function languageOf(chosen, device) {
    const c = String(chosen ?? '').trim();
    if (c === AUTOMATIC) return undefined;
    if (c !== '' && LANGUAGE.test(c)) return c;
    return deviceLanguage(device);
}
const MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;

/* An address of this server's own network, written as such. */
export function isPrivateHost(host) {
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
    const kind = isIP(h);
    if (kind === 0) return !h.includes('.');
    if (kind === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
        if (mapped) return isPrivateHost(mapped[1]);
        return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
    }
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/* What is wrong with a choice, in a sentence; undefined when it is fine. */
export function dictationProblem(c) {
    if (!c || typeof c !== 'object') return 'Choose an engine.';
    if (!Object.hasOwn(PROVIDERS, c.provider)) return 'Choose a provider among those offered.';
    let url;
    try { url = new URL(String(c.url ?? '')); } catch { return 'The address is not a web address.'; }
    if (url.username || url.password) return 'The address cannot carry a name or a password: the key is a secret.';
    const own = isPrivateHost(url.hostname);
    if (own && c.provider !== 'other') return 'An address of this server\'s own network is allowed only with "Other (compatible)", for an engine of your own.';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && own)) return 'The address must start with https:// (plain http only for an engine on this server\'s own network).';
    if (!MODEL.test(String(c.model ?? ''))) return 'Give the name of a model.';
    if (c.secret !== undefined && c.secret !== '' && !isSecretName(c.secret)) return 'The key is the name of a secret.';
    if (c.language !== undefined && c.language !== '' && c.language !== AUTOMATIC && !LANGUAGE.test(String(c.language))) return 'The language is a code such as en or fr, or automatic.';
    return undefined;
}

export const KEY_EXPIRED = 'Dictation key expired: replace it in Assets > Secrets.';

/* THE SETTINGS, kept in dictation.json: {on, language, main, backup}, each engine {provider, url, model, secret}.
   A file of before (one engine, its fields at the top) is read as the main one: nothing changes for it. */
const engineOf = (e) => (e && typeof e === 'object' && e.provider && e.provider !== 'none'
    ? { provider: e.provider, url: e.url ?? '', model: e.model ?? '', secret: e.secret ?? '' } : null);
export function migrated(kept) {
    const k = kept && typeof kept === 'object' ? kept : {};
    const shaped = 'main' in k || 'backup' in k;
    return { on: k.on === true, language: k.language ?? '', main: engineOf(shaped ? k.main : k), backup: shaped ? engineOf(k.backup) : null };
}
/* A main engine that fails is skipped this long, the backup asked at once, before being tried again. */
export const MAIN_RETRY_MS = 60_000;
const shortName = (c) => PROVIDERS[c?.provider]?.short || (() => { try { return new URL(c.url).hostname; } catch { return 'the engine'; } })();

export class Dictation {
    #file; #env; #secret; #expired; #lookup; #fetcher; #names; #notice; #now; #engines;
    /* The main engine down since: {name, last}; said once when it starts, once when it ends. */
    #down = null;
    /* `secret(name)`: the value of a secret, or undefined. `expired(name)`: past its expiry
       day (secrets.mjs): then not used. `lookup(host)`: the addresses a name resolves to.
       `names()`: the secrets' names (suggestions). `notice(text)`: a line for What happened. */
    constructor({ file = new JsonFile(undefined, {}), env = process.env, secret = () => undefined, expired = () => false, lookup = (host) => dnsLookup(host, { all: true }), fetcher = fetch, names = () => [], notice = () => {}, now = Date.now } = {}) {
        this.#file = file; this.#env = env; this.#secret = secret; this.#expired = expired; this.#lookup = lookup; this.#fetcher = fetcher;
        this.#names = names; this.#notice = notice; this.#now = now; this.#engines = new Engines({ fetcher, now });
    }
    #kept() { return migrated(this.#file.get()); }
    /* A secret renamed: the keys of dictation follow it. */
    secretRenamed(from, to) {
        const k = this.#kept();
        let changed = false;
        for (const e of [k.main, k.backup]) if (e?.secret === from) { e.secret = to; changed = true; }
        if (changed) this.#file.set(k);
    }
    #valid(e, language) { return e && !dictationProblem({ ...e, language }) ? e : undefined; }
    #saved() { const k = this.#kept(); return k.on ? this.#valid(k.main, k.language) && { ...k.main, language: k.language } : undefined; }
    #configOf(c, language = c.language) {
        return { url: c.url, model: c.model, language: language || undefined, key: c.secret ? this.#secret(c.secret) : undefined, provider: c.provider, secret: c.secret || undefined };
    }
    /* What transcribes now: the one set in Settings, else the environment's. */
    current() {
        const saved = this.#saved();
        return saved ? this.#configOf(saved) : voiceConfig(this.#env);
    }
    /* The backup: the one set in Settings (with a main one set there), else CLAVARIUM_TRANSCRIPTION_FALLBACK_*. */
    backup() {
        const k = this.#kept();
        const b = this.#saved() && this.#valid(k.backup, k.language);
        if (b) return this.#configOf(b, k.language);
        const env = voiceConfig(this.#env, 'CLAVARIUM_TRANSCRIPTION_FALLBACK_');
        const main = this.current();
        return env && !(main && env.url === main.url && env.model === main.model) ? env : undefined;
    }
    get model() { return this.current()?.model; }
    #aboutEngine(e) {
        if (!e) return null;
        return { ...e, secretMissing: Boolean(e.secret) && this.#secret(e.secret) === undefined, secretExpired: Boolean(e.secret) && this.#expired(e.secret) };
    }
    /* For the page: never a key, nor the environment's address (it may carry one). The main engine's fields
       are also at the top, as before. */
    about() {
        const k = this.#kept();
        const env = voiceConfig(this.#env);
        const main = this.#aboutEngine(k.main);
        return {
            on: this.#saved() !== undefined,
            provider: main?.provider ?? null, url: main?.url ?? '', model: main?.model ?? '', secret: main?.secret ?? '', language: k.language,
            secretMissing: main?.secretMissing ?? false, secretExpired: main?.secretExpired ?? false,
            main, backup: this.#aboutEngine(k.backup),
            down: this.#down ? this.#down.name : null,
            env: env ? { model: env.model } : null,
            source: this.#saved() ? 'settings' : env ? 'env' : null,
            providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p })),
        };
    }
    #checked(body, language) {
        const c = { provider: body?.provider, url: String(body?.url ?? '').trim(), model: String(body?.model ?? '').trim(), secret: String(body?.secret ?? '').trim() };
        const problem = dictationProblem({ ...c, language });
        if (problem) throw new Refusal(400, problem);
        if (c.secret && this.#secret(c.secret) === undefined) throw new Refusal(400, 'No secret has this name: add it in Assets, Secrets.');
        return c;
    }
    /* {language, main, backup}: backup absent, or its provider "none", means no backup. A body of before
       ({provider, url, model, secret, language}) sets the main one and keeps the backup. */
    set(body) {
        const language = String(body?.language ?? '').trim();
        const shaped = body && typeof body === 'object' && 'main' in body;
        const main = this.#checked(shaped ? body.main : body, language);
        let backup;
        if (!shaped) backup = this.#kept().backup;
        else if (!body.backup || !body.backup.provider || body.backup.provider === 'none') backup = null;
        else {
            try { backup = this.#checked(body.backup, ''); } catch (error) { throw new Refusal(error.status ?? 400, `Backup: ${error.message}`); }
        }
        this.#file.set({ on: true, language, main, backup });
        this.#down = null;
        return this.about();
    }
    /* Turned off: the environment's engine, if any, takes over again. The choice is kept, to be turned on again. */
    off() { this.#file.set({ ...this.#kept(), on: false }); this.#down = null; return this.about(); }
    /* A name resolving to this server's own network is refused unless "Other" was chosen. */
    async #guard(config) {
        if (!config.provider || config.provider === 'other') return;
        const host = new URL(config.url).hostname;
        let addresses;
        try { addresses = isIP(host.replace(/^\[|\]$/g, '')) ? [{ address: host }] : await this.#lookup(host); } catch { throw Object.assign(new Refusal(502, 'The speech-to-text engine cannot be reached.'), { engine: 0 }); }
        if (addresses.some((a) => isPrivateHost(a.address))) throw new Refusal(400, 'This address leads into this server\'s own network: only "Other (compatible)" may.');
    }
    /* An expired key is never sent: said in one line instead (still offered, so the line is seen). */
    #fresh(c) { if (c?.secret && this.#expired(c.secret)) throw new Refusal(409, KEY_EXPIRED); }
    /* `device`: the language of the device that dictates (a tag such as fr-FR), if it said. */
    async reaction(said) {
        const config = this.current();
        return config ? quickReaction(config, said, this.#fetcher) : null;
    }
    /* null when no such model is set: the caller then does without. */
    chat() {
        const config = this.current();
        if (!config?.key || !DIARIZES.test(String(config.url))) return null;
        return (system, user) => quickChat(config, system, user, this.#fetcher);
    }
    /* THE MAIN ENGINE, ELSE THE BACKUP: the main one down (engineDown, or its key expired), the same audio goes
       at once to the backup; for MAIN_RETRY_MS after, straight to it. Said once when it starts, once when the
       main one answers again -- not at every sentence. */
    async #run(hear) {
        const main = this.current();
        const second = this.backup();
        const skip = second && this.#down && this.#now() - this.#down.last < MAIN_RETRY_MS;
        if (!skip) {
            try {
                this.#fresh(this.#saved());
                if (main) await this.#guard(main);
                const out = await hear(main);
                if (this.#down) { this.#notice(`Dictation: ${this.#down.name} back`); this.#down = null; }
                return out;
            } catch (error) {
                if (!second || !(engineDown(error) || error?.message === KEY_EXPIRED)) throw error;
                if (this.#down) this.#down.last = this.#now();
                else {
                    this.#down = { name: shortName(main), last: this.#now() };
                    this.#notice(`Dictation: ${this.#down.name} down, ${shortName(second)} took over`);
                }
            }
        }
        this.#fresh(second);
        await this.#guard(second);
        return hear(second);
    }
    async transcribeParts(audio) {
        return this.#run((c) => transcribeParts(c && { ...c, language: languageOf(c.language, undefined) }, audio, this.#fetcher));
    }
    async transcribe(audio, device, how = {}) {
        return this.#run((c) => transcribe(c && { ...c, language: languageOf(c.language, device) }, audio, this.#fetcher, how));
    }
    /* "Try it": what is in the form, not saved, on one short recording (either engine). */
    async try(body, audio, device) {
        const language = String(body?.language ?? '').trim();
        const checked = this.#checked(body, language);
        this.#fresh(checked);
        const config = this.#configOf(checked, language);
        await this.#guard(config);
        return transcribe({ ...config, language: languageOf(config.language, device) }, audio, this.#fetcher);
    }
    /* A provider's speech-to-text models, read with the key named (when there is one), else its base list. */
    async models(provider, secret) {
        if (!Object.hasOwn(PROVIDERS, provider)) throw new Refusal(400, 'Choose a provider among those offered.');
        const name = isSecretName(secret) && !this.#expired(secret) ? secret : '';
        return this.#engines.models(provider, name ? this.#secret(name) : undefined, `${provider} ${name}`);
    }
    /* For whatever sets dictation up: every provider with its models and the secrets that look like its keys,
       and a choice for each slot not set yet. Names only, never a value. */
    async suggestions() {
        const names = (this.#names() ?? []).filter((n) => isSecretName(n) && !this.#expired(n));
        const k = this.#kept();
        const reveal = (n) => this.#secret(n);
        const providers = await this.#engines.catalogue(names, reveal);
        const slots = { main: this.#saved() ? k.main : (voiceConfig(this.#env) ? { provider: null } : null), backup: this.#saved() ? k.backup : null };
        return { providers, suggestions: await this.#engines.suggestions(slots, names, reveal) };
    }
}
