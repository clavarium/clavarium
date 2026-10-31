/* SPEECH: text read aloud, for the voice boxes (boxes.mjs).
 *
 * On this server, with nothing sent anywhere: a Piper voice (open, French by
 * default) run by sherpa-onnx. The voice is fetched once, the first time it is
 * needed, into the data folder; then it works offline. About 0.3 s of work for
 * 4 s of speech on one core.
 *
 * Out: PCM 16 kHz, 16-bit, mono, little-endian -- what a box plays.
 */
import { existsSync, mkdirSync, createWriteStream, rmSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const VOICES = Object.freeze({
    fr: 'vits-piper-fr_FR-siwis-medium',
    en: 'vits-piper-en_US-amy-medium',
});
export const VOICE_URL = (name) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${name}.tar.bz2`;
export const RATE = 16_000;

/* Float samples at `from` Hz -> 16-bit PCM at 16 kHz (linear interpolation: speech, not music). */
export function toPcm16k(samples, from) {
    const n = Math.floor(samples.length * RATE / from);
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const x = i * from / RATE;
        const j = Math.floor(x);
        const a = samples[j] ?? 0;
        const b = samples[j + 1] ?? a;
        const v = Math.max(-1, Math.min(1, a + (b - a) * (x - j)));
        out.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return out;
}

export class Speech {
    #dir; #lang; #engine = null; #loading = null; #fetch; #log;

    constructor({ dir, lang = 'fr', fetcher = fetch, log = () => {} }) {
        this.#dir = dir; this.#lang = VOICES[lang] ? lang : 'fr'; this.#fetch = fetcher; this.#log = log;
    }

    get voice() { return VOICES[this.#lang]; }

    async #voiceFolder() {
        const name = this.voice;
        const folder = `${this.#dir}/${name}`;
        if (existsSync(`${folder}/tokens.txt`)) return folder;
        mkdirSync(this.#dir, { recursive: true });
        const archive = `${this.#dir}/${name}.tar.bz2`;
        this.#log(`speech: fetching the voice ${name}`);
        const response = await this.#fetch(VOICE_URL(name));
        if (!response.ok || !response.body) throw new Error(`the voice could not be fetched (${response.status})`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
        const unpacking = `${this.#dir}/.unpacking`;
        rmSync(unpacking, { recursive: true, force: true });
        mkdirSync(unpacking);
        await promisify(execFile)('tar', ['xjf', archive, '-C', unpacking]);
        renameSync(`${unpacking}/${name}`, folder);
        rmSync(unpacking, { recursive: true, force: true });
        rmSync(archive, { force: true });
        return folder;
    }

    async #load() {
        if (this.#engine) return this.#engine;
        this.#loading ??= (async () => {
            const folder = await this.#voiceFolder();
            const { default: sherpa } = await import('sherpa-onnx-node');
            const model = `${folder}/${this.voice.replace(/^vits-piper-/, '')}.onnx`;
            this.#engine = new sherpa.OfflineTts({
                model: { vits: { model, tokens: `${folder}/tokens.txt`, dataDir: `${folder}/espeak-ng-data` }, numThreads: 1 },
                maxNumSentences: 1,
            });
            return this.#engine;
        })().finally(() => { this.#loading = null; });
        return this.#loading;
    }

    /* Text -> PCM 16 kHz. */
    async speak(text) {
        const engine = await this.#load();
        const audio = engine.generate({ text, sid: 0, speed: 1.0 });
        return toPcm16k(audio.samples, audio.sampleRate);
    }
}
