/* SPEECH: text read aloud, for the voice boxes (boxes.mjs).
 *
 * On this server, with nothing sent anywhere: a Piper voice (open, French by
 * default: UPMC, its first speaker) run by sherpa-onnx. The voice is fetched once, the first time it is
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
    fr: 'vits-piper-fr_FR-upmc-medium',   /* chosen by ear on the real box (31-10), over Siwis, Tom, Gilles and Kokoro */
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

/* A NICER VOICE, ONLINE: ElevenLabs, when the owner put its key among the secrets (by this name).
   The text then leaves this server for theirs; without the key, or when it fails (quota, network),
   the voice of this server answers instead. The voice: chosen by ear on the real box (31-10). */
export const ELEVEN_SECRET = 'ELEVENLABS_API_KEY';
export const ELEVEN_VOICE = 'onwK4e9ZLuTAKqWW03F9';   /* "Daniel" */
export const ELEVEN_MODEL = 'eleven_multilingual_v2';
export const SPEED = 1.1;   /* a little quicker than the voices' own pace: found slow on the real box (31-10) */

/* A moment before the main voice is asked again (a sentence it missed). */
export const AGAIN_MS = 700;
export class Speech {
    #dir; #lang; #engine = null; #loading = null; #fetch; #log; #secret; #pocket; #pocketDown = 0;

    /* `pocket`: the default voice (pocket.mjs), else null. Then ElevenLabs when its key is set, then Piper. */
    constructor({ dir, lang = 'fr', fetcher = fetch, log = () => {}, secret = () => undefined, pocket = null }) {
        this.#dir = dir; this.#lang = VOICES[lang] ? lang : 'fr'; this.#fetch = fetcher; this.#log = log; this.#secret = secret; this.#pocket = pocket;
    }

    async #eleven(text) {
        const key = this.#secret(ELEVEN_SECRET);
        if (!key) return null;
        try {
            const r = await this.#fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=pcm_16000`, {
                method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' },
                body: JSON.stringify({ text, model_id: ELEVEN_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: SPEED } }), signal: AbortSignal.timeout(20_000),
            });
            if (!r.ok) { this.#log(`speech: ElevenLabs answered ${r.status}, this server's voice instead`); return null; }
            return Buffer.from(await r.arrayBuffer());
        } catch (error) { this.#log(`speech: ElevenLabs unreachable (${error.message}), this server's voice instead`); return null; }
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
        /* Pocket first; failed, it rests five minutes and the next voice answers meanwhile. */
        /* One voice from the start of an answer to its end (03-11: "tu as bougé de voix au milieu"): a sentence it
           misses is asked of it once more, a moment later, before another voice says it. */
        if (this.#pocket && Date.now() - this.#pocketDown > 5 * 60_000) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try { const pcm = await this.#pocket.speak(text); if (pcm.length) return pcm; } catch (error) {
                    if (attempt === 1 && !/getting ready/.test(error.message)) { this.#pocketDown = Date.now(); this.#log(`speech: Pocket TTS failed (${error.message}), another voice meanwhile`); }
                }
                if (attempt === 0) await new Promise((r) => setTimeout(r, AGAIN_MS));
            }
        }
        const online = await this.#eleven(text);
        if (online && online.length) return online;
        const engine = await this.#load();
        const audio = engine.generate({ text, sid: 0, speed: SPEED });
        return toPcm16k(audio.samples, audio.sampleRate);
    }
}
