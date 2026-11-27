/* THE VOICE OF THE DEMO VIDEOS: one take per line, said by Kyutai's Pocket TTS (the voice the boxes use, in
 * English here), quiet ends cut, a short fade at both ends so that nothing clicks. Out: 16-bit mono WAV files
 * and how long each lasts.
 *
 * Pocket TTS serves on loopback: POCKET_URL (default http://127.0.0.1:8765), started beforehand with
 *   pocket-tts serve --host 127.0.0.1 --port 8765 --language english
 * Voice: VOICE (default alba, the one chosen for the explainer, 25-11). */
import { writeFileSync } from 'node:fs';

const URL_ = process.env.POCKET_URL || 'http://127.0.0.1:8765';
export const VOICE = process.env.VOICE || 'alba';

/* A WAV of 16-bit mono PCM. */
export function wav(pcm, rate) {
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
    head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36);
    head.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([head, pcm]);
}

/* Quiet at both ends cut (a little kept so no word is clipped), then 30 ms fades. */
export function trimmed(pcm, rate, { floor = 300 } = {}) {
    const n = pcm.length >> 1; let a = -1; let b = -1;
    for (let i = 0; i < n; i++) if (Math.abs(pcm.readInt16LE(i * 2)) > floor) { if (a < 0) a = i; b = i; }
    if (a < 0) return Buffer.alloc(0);
    const out = Buffer.from(pcm.subarray(Math.max(0, a - 400) * 2, Math.min(n, b + 1600) * 2));
    const m = out.length >> 1; const fade = Math.min(Math.floor(rate * 0.03), m >> 1);
    for (let i = 0; i < fade; i++) {
        const g = i / fade;
        out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * g), i * 2);
        out.writeInt16LE(Math.round(out.readInt16LE((m - 1 - i) * 2) * g), (m - 1 - i) * 2);
    }
    return out;
}

/* One line said: its PCM and rate. */
export async function say(text, voice = VOICE) {
    const form = new FormData(); form.append('text', text); form.append('voice_url', voice);
    const r = await fetch(`${URL_}/tts`, { method: 'POST', body: form, signal: AbortSignal.timeout(600_000) });
    if (!r.ok) throw new Error(`Pocket TTS answered ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    const rate = b.readUInt32LE(24);
    return { rate, pcm: trimmed(b.subarray(44, 44 + ((b.length - 44) & ~1)), rate) };
}

/* Every line of a scenario: files <dir>/line-NN.wav, and their lengths in seconds. */
export async function voiceLines(lines, dir) {
    const out = [];
    for (const [i, text] of lines.entries()) {
        const { rate, pcm } = await say(text);
        const file = `${dir}/line-${String(i + 1).padStart(2, '0')}.wav`;
        writeFileSync(file, wav(pcm, rate));
        out.push({ text, file, seconds: pcm.length / 2 / rate });
    }
    return out;
}

/* Is Pocket TTS there? */
export async function ready() {
    try { return (await fetch(`${URL_}/`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}
