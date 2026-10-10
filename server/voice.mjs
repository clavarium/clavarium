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
import { Refusal } from './conversations.mjs';

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

export function cleanDictation(raw) {
    return withoutLoop(String(raw ?? '').replace(/[\r\n\t]+/gu, ' ').replace(NOT_TYPED, '')).slice(0, TEXT_MAX).trim();
}

/* `audio` is a WAV file, as bytes. Resolves with the text to type. */
export async function transcribe(config, audio, fetcher = fetch) {
    if (!config) throw new Refusal(503, 'No speech-to-text engine is configured.');
    if (audio.length === 0) throw new Refusal(400, 'The recording is empty.');
    if (audio.length > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.');
    if (audio.subarray(0, 4).toString('latin1') !== 'RIFF' || audio.subarray(8, 12).toString('latin1') !== 'WAVE') {
        throw new Refusal(400, 'The recording is not a WAV file.');
    }
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
    form.append('model', config.model);
    if (config.language) form.append('language', config.language);
    form.append('response_format', 'json');
    let response;
    try {
        response = await fetcher(config.url, { method: 'POST', headers: config.key ? { authorization: `Bearer ${config.key}` } : {}, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        /* The error of a failed request repeats the address it was sent to:
           it is not passed on. */
        throw new Refusal(502, 'The speech-to-text engine cannot be reached.');
    }
    if (!response.ok) throw new Refusal(502, `The speech-to-text engine answered ${response.status}.`);
    const body = await response.json().catch(() => undefined);
    if (typeof body?.text !== 'string') throw new Refusal(502, 'The speech-to-text engine gave no text.');
    return cleanDictation(body.text);
}
