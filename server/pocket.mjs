/* THE VOICE BY DEFAULT: Kyutai's Pocket TTS (chosen by ear on the real box, 01-11, over Piper, Kokoro and
 * ElevenLabs' free credits). Open: its program is MIT, its weights CC-BY-4.0 -- Kyutai is credited
 * (docs/CREDITS). Runs on this server, nothing sent anywhere: the program is fetched once from Kyutai's
 * releases (its sha256 checked), its French model once from Hugging Face, then it serves on loopback.
 *
 * Said "posée" (01-11: « elle parle un peu vite et marque peu les espaces »): each clause made on its own,
 * slowed by a tenth at the same pitch (ffmpeg atempo), with a silence after it -- longer after a sentence.
 * Out: PCM 16 kHz, 16-bit, mono. */
import { existsSync, mkdirSync, createWriteStream, rmSync, readFileSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

export const POCKET_VERSION = '3.3.0';
export const POCKET_RELEASE = 'https://github.com/kyutai-labs/pocket-tts/releases/download/v4.0.1';
export const POCKET_SHA256 = Object.freeze({
    x64: '9abff0aa138a804e44052952d8c3bdaae247fb267ca8f4b83fe178897d1a0559',
    arm64: '2b9a727bffd86ea6d73370d675cbd91a7db118f11b7f5a60343c2d5da12b187a',
});
export const TEMPO = 0.96;   /* 01-11: 0.9 sounded sleepy; a touch slower than its own pace */
export const GAP_S = Object.freeze({ sentence: 0.42, pause: 0.25, comma: 0.16 });

/* A text in clauses, each with the silence that follows it. */
export function clausesOf(text) {
    const out = [];
    for (const piece of String(text).match(/[^.!?…;:,]+[.!?…;:,]*/g) ?? []) {
        const t = piece.trim();
        if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
        const end = t.at(-1);
        out.push({ text: t, gap: '.!?…'.includes(end) ? GAP_S.sentence : ';:'.includes(end) ? GAP_S.pause : end === ',' ? GAP_S.comma : GAP_S.sentence });
    }
    return out;
}

/* Quiet at both ends cut, a little kept so no word is clipped. */
export function trimmed(pcm, { floor = 200, before = 800, after = 1600 } = {}) {
    const n = pcm.length >> 1; let a = -1; let b = -1;
    for (let i = 0; i < n; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > floor) { if (a < 0) a = i; b = i; }
    if (a < 0) return Buffer.alloc(0);
    return pcm.subarray(Math.max(0, a - before) * 2, Math.min(n, b + after) * 2);
}

const free = () => new Promise((ok, ko) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', ko); });

export class Pocket {
    #dir; #fetch; #log; #spawn; #ffmpeg; #port = 0; #child = null; #starting = null; #language;

    constructor({ dir, fetcher = fetch, log = () => {}, spawn = spawnProcess, ffmpeg = 'ffmpeg', language = 'french' }) {
        this.#dir = dir; this.#fetch = fetcher; this.#log = log; this.#spawn = spawn; this.#ffmpeg = ffmpeg; this.#language = language;
    }

    /* The program, fetched once and checked: only Linux on x64 or arm64. */
    async #program() {
        const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
        if (process.platform !== 'linux' || !arch) throw new Error('Pocket TTS runs on Linux x64 or arm64 only');
        const name = `pocket-tts-${POCKET_VERSION}-${arch}-unknown-linux-gnu`;
        const bin = `${this.#dir}/${name}/pocket-tts`;
        if (existsSync(bin)) return bin;
        mkdirSync(this.#dir, { recursive: true });
        const archive = `${this.#dir}/${name}.tar.gz`;
        this.#log('speech: fetching Kyutai\'s Pocket TTS');
        const r = await this.#fetch(`${POCKET_RELEASE}/${name}.tar.gz`);
        if (!r.ok || !r.body) throw new Error(`Pocket TTS could not be fetched (${r.status})`);
        await pipeline(Readable.fromWeb(r.body), createWriteStream(archive));
        const sum = createHash('sha256').update(readFileSync(archive)).digest('hex');
        if (sum !== POCKET_SHA256[process.arch]) { rmSync(archive, { force: true }); throw new Error('Pocket TTS: the download is not the expected one (sha256)'); }
        const unpacking = `${this.#dir}/.unpacking-pocket`;
        rmSync(unpacking, { recursive: true, force: true }); mkdirSync(unpacking);
        await promisify(execFile)('tar', ['xzf', archive, '-C', unpacking]);
        renameSync(`${unpacking}/${name}`, `${this.#dir}/${name}`);
        rmSync(unpacking, { recursive: true, force: true }); rmSync(archive, { force: true });
        return bin;
    }

    /* Its server on loopback, started once, kept; ready when it answers. */
    async #ready() {
        if (this.#child && this.#port) return this.#port;
        this.#starting ??= (async () => {
            const bin = await this.#program();
            const port = await free();
            const child = this.#spawn(bin, ['serve', '--host', '127.0.0.1', '--port', String(port), '--language', this.#language, '--quantize'], { env: { ...process.env, HF_HOME: `${this.#dir}/pocket-hf` }, stdio: ['ignore', 'ignore', 'pipe'] });
            let said = ''; child.stderr?.on('data', (d) => { said = `${said}${d}`.slice(-500); });
            child.on('exit', () => { if (this.#child === child) { this.#child = null; this.#port = 0; } });
            for (let i = 0; i < 300; i++) {   /* the first time, its model comes from Hugging Face: a few minutes */
                await new Promise((ok) => setTimeout(ok, 1000));
                if (child.exitCode !== null) throw new Error(`Pocket TTS stopped: ${said.trim().split('\n').pop() ?? ''}`);
                try { if ((await this.#fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok) { this.#child = child; this.#port = port; this.#log('speech: Pocket TTS ready'); return port; } } catch { /* not yet */ }
            }
            child.kill(); throw new Error('Pocket TTS did not start');
        })().finally(() => { this.#starting = null; });
        return this.#starting;
    }

    async #clause(text) {
        const port = await this.#ready();
        const form = new FormData(); form.append('text', text);
        const r = await this.#fetch(`http://127.0.0.1:${port}/tts`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`Pocket TTS answered ${r.status}`);
        const wav = Buffer.from(await r.arrayBuffer());
        const rate = wav.readUInt32LE(24);
        const pcm = wav.subarray(44, 44 + ((wav.length - 44) & ~1));
        return trimmed(await this.#slowed(pcm, rate));
    }

    /* Slower by a tenth, at the same pitch, to 16 kHz (ffmpeg, which the voice boxes use already). */
    #slowed(pcm, rate) {
        return new Promise((resolve, reject) => {
            const c = this.#spawn(this.#ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', '-', '-af', `atempo=${TEMPO}`, '-ar', '16000', '-f', 's16le', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
            const out = [];
            c.stdout.on('data', (d) => out.push(d));
            c.on('error', reject);
            c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg could not slow the voice'))));
            c.stdin.end(pcm);
        });
    }

    /* Text -> PCM 16 kHz, clause by clause, with its silences. */
    async speak(text) {
        const parts = [];
        for (const c of clausesOf(text)) { parts.push(await this.#clause(c.text), Buffer.alloc(Math.round(c.gap * 16_000) * 2)); }
        return Buffer.concat(parts);
    }

    stop() { this.#child?.kill(); this.#child = null; this.#port = 0; }
}
