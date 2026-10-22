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

export const AUDIO_MAX = 512 * 1024;
export const TEXT_MAX = 2000;
export const TIMEOUT_MS = 60_000;
export const DEFAULT_MODEL = 'whisper-large-v3-turbo';

/* The engine's settings come from the environment, never from arguments: the
   key must not show in a process list. */
export function voiceConfig(env = process.env) {
    const url = (env.CLAVARIUM_TRANSCRIPTION_URL ?? '').trim();
    if (url === '') return undefined;
    return {
        url,
        key: (env.CLAVARIUM_TRANSCRIPTION_KEY ?? '').trim() || undefined,
        model: (env.CLAVARIUM_TRANSCRIPTION_MODEL ?? '').trim() || DEFAULT_MODEL,
        language: (env.CLAVARIUM_TRANSCRIPTION_LANGUAGE ?? '').trim() || undefined,
    };
}

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
    /sous[- ]titrage\s*st\s*'?\s*\d+[.!]?/giu,
    /sous[- ]titr(?:age|es?)\s+(?:par\s+)?(?:la\s+)?société\s+radio[- ]canada[.!]?/giu,
    /untertitel(?:ung)?\s+(?:im\s+auftrag\s+)?des\s+zdf(?:\s+für\s+funk)?,?\s*\d{0,4}[.!]?/giu,
];
export function withoutPhantoms(text) {
    let t = text;
    for (const re of PHANTOMS) t = t.replace(re, ' ');
    return t.replace(/\s+/gu, ' ').trim();
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
export async function transcribe(config, audio, fetcher = fetch) {
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
        form.append('response_format', 'json');
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
        throw new Refusal(502, 'The speech-to-text engine cannot be reached.');
    }
    if (!response.ok) throw new Refusal(502, `The speech-to-text engine answered ${response.status}.`);
    const body = await response.json().catch(() => undefined);
    if (typeof body?.text !== 'string') throw new Refusal(502, 'The speech-to-text engine gave no text.');
    return cleanDictation(body.text, wavSeconds(audio));
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
export const PROVIDERS = {
    ovh: { label: 'OVH AI Endpoints', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
    openai: { label: 'OpenAI', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
    groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
    mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1/audio/transcriptions', model: 'voxtral-mini-latest' },
    other: { label: 'Other (compatible)', url: '', model: '' },
};
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
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
    if (c.language !== undefined && c.language !== '' && !LANGUAGE.test(String(c.language))) return 'The language is a code such as en or fr, or automatic.';
    return undefined;
}

export class Dictation {
    #file; #env; #secret; #lookup; #fetcher;
    /* `secret(name)`: the value of a secret, or undefined. `lookup(host)`: the addresses a name resolves to. */
    constructor({ file = new JsonFile(undefined, {}), env = process.env, secret = () => undefined, lookup = (host) => dnsLookup(host, { all: true }), fetcher = fetch } = {}) {
        this.#file = file; this.#env = env; this.#secret = secret; this.#lookup = lookup; this.#fetcher = fetcher;
    }
    /* A secret renamed: the key of dictation follows it. */
    secretRenamed(from, to) {
        const kept = this.#file.get();
        if (kept?.secret === from) this.#file.set({ ...kept, secret: to });
    }
    #saved() { const kept = this.#file.get(); return kept?.on === true && !dictationProblem(kept) ? kept : undefined; }
    #configOf(c) {
        return { url: c.url, model: c.model, language: c.language || undefined, key: c.secret ? this.#secret(c.secret) : undefined, provider: c.provider };
    }
    /* What transcribes now: the one set in Settings, else the environment's. */
    current() {
        const saved = this.#saved();
        return saved ? this.#configOf(saved) : voiceConfig(this.#env);
    }
    get model() { return this.current()?.model; }
    /* For the page: never a key, nor the environment's address (it may carry one). */
    about() {
        const saved = this.#file.get() ?? {};
        const env = voiceConfig(this.#env);
        return {
            on: this.#saved() !== undefined,
            provider: saved.provider ?? null, url: saved.url ?? '', model: saved.model ?? '', secret: saved.secret ?? '', language: saved.language ?? '',
            secretMissing: Boolean(saved.secret) && this.#secret(saved.secret) === undefined,
            env: env ? { model: env.model } : null,
            source: this.#saved() ? 'settings' : env ? 'env' : null,
            providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p })),
        };
    }
    #checked(body) {
        const c = { provider: body?.provider, url: String(body?.url ?? '').trim(), model: String(body?.model ?? '').trim(), secret: String(body?.secret ?? '').trim(), language: String(body?.language ?? '').trim() };
        const problem = dictationProblem(c);
        if (problem) throw new Refusal(400, problem);
        if (c.secret && this.#secret(c.secret) === undefined) throw new Refusal(400, 'No secret has this name: add it in Assets, Secrets.');
        return c;
    }
    set(body) { this.#file.set({ ...this.#checked(body), on: true }); return this.about(); }
    /* Turned off: the environment's engine, if any, takes over again. The choice is kept, to be turned on again. */
    off() { const kept = this.#file.get() ?? {}; this.#file.set({ ...kept, on: false }); return this.about(); }
    /* A name resolving to this server's own network is refused unless "Other" was chosen. */
    async #guard(config) {
        if (!config.provider || config.provider === 'other') return;
        const host = new URL(config.url).hostname;
        let addresses;
        try { addresses = isIP(host.replace(/^\[|\]$/g, '')) ? [{ address: host }] : await this.#lookup(host); } catch { throw new Refusal(502, 'The speech-to-text engine cannot be reached.'); }
        if (addresses.some((a) => isPrivateHost(a.address))) throw new Refusal(400, 'This address leads into this server\'s own network: only "Other (compatible)" may.');
    }
    async transcribe(audio) {
        const config = this.current();
        if (config) await this.#guard(config);
        return transcribe(config, audio, this.#fetcher);
    }
    /* "Try it": what is in the form, not saved, on one short recording. */
    async try(body, audio) {
        const config = this.#configOf(this.#checked(body));
        await this.#guard(config);
        return transcribe(config, audio, this.#fetcher);
    }
}
