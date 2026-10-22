/* HEARING WHERE A PHRASE STARTS AND ENDS, without any network: the pure half
   of dictation, shared by the page and by the tests.
 *
 * The microphone gives blocks of samples. Each block gets one number, its
 * loudness; a detector decides "speech or not" against the ROOM, not against
 * an absolute level; a segmenter cuts phrases at the silences. A phrase is
 * then one WAV file. */
export const RATE = 16_000;
export const BLOCK = 512;
export const BLOCK_MS = (BLOCK / RATE) * 1000;      /* 32 ms */
export const PRE_ROLL_MS = 320;      /* kept from before the first word, or its attack is cut */
export const SILENCE_MS = 500;       /* a pause this long ends the phrase */
export const MINIMUM_MS = 250;       /* less SPEECH than this is a noise, not a phrase */
/* A phrase is cut rather than growing for ever: past SOFT_MAXIMUM_MS at its next short pause, at MAXIMUM_MS whatever.
   Long pieces are where an engine runs on in loops; and the server takes 16 s of audio at most (AUDIO_MAX). */
export const SOFT_MAXIMUM_MS = 12_000;
export const MAXIMUM_MS = 15_000;
export const SHORT_PAUSE_MS = 200;
/* SPEECH IS HELD, A NOISE IS NOT: a syllable lasts this long at least (a click, a key, a breath do not), and
   between its first and last sound, a phrase is speech this much of the time at least. What is sent of a
   near-silence is what an engine fills with what it learned ("Sous-titrage ST' 501"). */
export const HELD_MS = 160;
export const SPEECH_SHARE = 0.3;
/* Kept after the last sound: enough for its end, not a silence for the engine to fill. */
export const TAIL_MS = 200;

export function loudness(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    return Number.isFinite(rms) ? rms : 0;
}

/* THE THRESHOLD FOLLOWS THE ROOM. An absolute threshold measures the world;
   what matters is what rises above the noise HERE. The floor is a low
   quantile of the last thirty seconds; speech is three times the floor. */
export const ABSOLUTE_FLOOR = 0.004;
const SPEECH_RATIO = 3;
const MEMORY = 940;        /* blocks: about thirty seconds */
const READY_AFTER = 32;    /* blocks: about one second of listening first */
const SHORT = 94;          /* blocks: about three seconds */

export class Detector {
    constructor() { this.background = []; this.recent = []; this.floor = ABSOLUTE_FLOOR; this.since = 0; }
    ready() { return this.background.length >= READY_AFTER; }
    /* true when this block is speech */
    hear(rms) {
        if (typeof rms !== 'number' || !Number.isFinite(rms) || rms < 0) return false;
        this.background.push(rms); if (this.background.length > MEMORY) this.background.shift();
        this.recent.push(rms); if (this.recent.length > SHORT) this.recent.shift();
        if (++this.since >= 16 && this.ready()) {
            this.since = 0;
            const sorted = [...this.background].sort((a, b) => a - b);
            this.floor = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];
        }
        if (!this.ready()) return false;
        /* A steady noise that started recently (a fan) raises the bar at once. */
        const steady = this.recent.length >= SHORT ? Math.min(...this.recent) : 0;
        return rms >= Math.max(this.floor, steady, ABSOLUTE_FLOOR) * SPEECH_RATIO;
    }
}

export class Segmenter {
    /* `onPhrase(blocks)` receives the blocks of one phrase; `onStart()` is
       told the moment speech begins. */
    constructor({ onPhrase, onStart = () => {} }) { this.onPhrase = onPhrase; this.onStart = onStart; this.reset(); }
    reset() { this.ring = []; this.current = null; this.silentSince = null; }
    get speaking() { return this.current !== null; }
    feed(speech, at, samples) {
        if (this.current === null) {
            if (!speech) {
                this.ring.push(samples);
                while (this.ring.length > Math.ceil(PRE_ROLL_MS / BLOCK_MS)) this.ring.shift();
                return;
            }
            this.current = { start: at, blocks: [...this.ring, samples], spoken: 1, first: this.ring.length, last: this.ring.length, run: 1, held: 1 };
            this.ring = []; this.silentSince = null;
            this.onStart();
            return;
        }
        const c = this.current;
        c.blocks.push(samples);
        if (speech) { c.spoken++; c.last = c.blocks.length - 1; c.run++; c.held = Math.max(c.held, c.run); this.silentSince = null; }
        else { c.run = 0; if (this.silentSince === null) this.silentSince = at; else if (at - this.silentSince >= SILENCE_MS) { this.close(); return; } }
        const long = at - c.start;
        if (long >= MAXIMUM_MS || (long >= SOFT_MAXIMUM_MS && this.silentSince !== null && at - this.silentSince >= SHORT_PAUSE_MS)) this.close();
    }
    close() {
        const phrase = this.current;
        this.current = null; this.silentSince = null; this.ring = [];
        if (phrase === null) return;
        /* Counted in blocks of SPEECH, never in length: a cough followed by
           half a second of silence is long, and is not a phrase. */
        if (phrase.spoken * BLOCK_MS < MINIMUM_MS) return;
        if (phrase.held * BLOCK_MS < HELD_MS) return;
        if (phrase.spoken / (phrase.last - phrase.first + 1) < SPEECH_SHARE) return;
        this.onPhrase(phrase.blocks.slice(0, phrase.last + 1 + Math.ceil(TAIL_MS / BLOCK_MS)));
    }
}

/* Blocks of samples in [-1, 1] -> a 16-bit mono WAV file, as bytes. */
export function toWav(blocks, rate = RATE) {
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const bytes = new ArrayBuffer(44 + total * 2);
    const view = new DataView(bytes);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, total * 2, true);
    let at = 44;
    for (const block of blocks) {
        for (let i = 0; i < block.length; i++) {
            const v = Math.max(-1, Math.min(1, block[i]));
            view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
            at += 2;
        }
    }
    return new Uint8Array(bytes);
}
