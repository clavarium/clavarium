/* VOICE BOXES: a small speaker in a room, bound to one conversation.
 *
 * A press on its button, a sentence: the box streams it here, the dictation
 * engine (voice.mjs) turns it into text, and the text is said in the box's
 * conversation by the box itself, in its own name (Parley's speakers, #215). What the tool
 * then says or asks there is read aloud (speech.mjs) and played by the box.
 * Protocol v1: DEVICES.md.
 *
 *   code      the operator asks for a pairing code for a conversation: 8
 *             characters, one use, CODE_MINUTES
 *   pair      the box gives the code: it gets an id and a key, once. Only
 *             the key's SHA-256 is kept
 *   link      the box connects to /c/api/box/ws with its key; a withdrawn
 *             key gets 401 and the box goes back to its setup
 *
 * Both are under /c/: the edge lets them through without sign-on, as the
 * device door. Nothing is kept of the audio, here or on the box -- but the wake word's own
 * 1.6 s of a box set to learn it (wakelearn.mjs).
 */
import { spawn as spawnProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Refusal } from './conversations.mjs';
import { WIRE, cutoffOf, scoreOf } from './wakelearn.mjs';

export const CODE_MINUTES = 10;
export const PAIR_PATH = '/c/api/box/pair';
export const LINK_PATH = '/c/api/box/ws';
/* A firmware a box downloads to update itself: a one-use address, kept a few minutes. */
export const FIRMWARE_PATH = '/c/api/box/firmware/';
export const FIRMWARE_MINUTES = 10;
/* THE WAKE WORD HEARD AGAIN (03-11): « Mésange » and what a dictation makes of it (mes anges, mais sange...). */
export const CLIP_MAX_BYTES = 16_000 * 2 * 3;
export const WAKE_HEARD = /\bm[ae]i?s+\s?an?ge?s?\b|\bmes anges?\b|\bmesange|\bmaisange|\bmessage?s?\b|\bmessenge?s?\b/;   /* « Messenges »: Whisper's reading of the server's own voice saying it */
export const WAKE_DROP = process.env.CLAVARIUM_WAKE_DROP === '1';
const plainWords = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
export const SENTENCE_MAX = 300 * 32_000 + 32_000;      /* 5 min of 16 kHz 16-bit mono, and some slack */
export const TRIES_PER_MINUTE = 10;
export const NAME_MAX = 40;
/* The volume a box is given when it connects, until someone sets another (its own default was soft). */
export const VOLUME_DEFAULT = 80;
/* Where a box in setup answers, on its own Wi-Fi: ESP-IDF's access point address, the same on
   every box (written from its parts: it is no machine of anybody's). */
export const SETUP_ADDRESS = `http://${[192, 168, 4, 1].join('.')}/`;

/* The setup key: this server's address, the room, a pairing code -- one paste, or one link. */
export function setupKey(origin, room, code) {
    return `GAMBELI-${Buffer.from(JSON.stringify({ u: origin, r: room, c: code })).toString('base64url')}`;
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';    /* nothing read two ways: no 0/O, 1/I */

export const hashOf = (key) => createHash('sha256').update(String(key)).digest('hex');

export function newCode() {
    const bytes = randomBytes(8);
    const s = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const plainCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* A WAV header for 16 kHz, 16-bit mono PCM: what the dictation engine is given. */
export function wavOf(pcm, rate = 16_000) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

/* A .wav (16-bit PCM, any rate, mono or stereo) as a box plays it: 16 kHz mono, a minute at most. */
export const PLAY_SECONDS = 70;
export function pcmOfWav(wav) {
    const b = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Refusal(400, 'Not a .wav file.');
    let at = 12; let fmt = null; let data = null;
    while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4); const size = b.readUInt32LE(at + 4);
        if (id === 'fmt ') fmt = { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
        if (id === 'data') { data = b.subarray(at + 8, Math.min(b.length, at + 8 + size)); break; }
        at += 8 + size + (size & 1);
    }
    if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.rate) throw new Refusal(400, 'A .wav of 16-bit PCM, please.');
    const frames = Math.floor(data.length / (2 * fmt.channels));
    const n = Math.min(Math.floor(frames * 16_000 / fmt.rate), PLAY_SECONDS * 16_000);
    const out = Buffer.alloc(n * 2);
    const sample = (f) => { let sum = 0; for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((f * fmt.channels + c) * 2); return sum / fmt.channels; };
    for (let i = 0; i < n; i++) {
        const x = i * fmt.rate / 16_000; const j = Math.floor(x); const k = Math.min(j + 1, frames - 1);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample(j) + (sample(k) - sample(j)) * (x - j)))), i * 2);
    }
    return out;
}

/* Text for the ear: what a written message holds and a voice should not read. */
export function forSpeech(text, { callOthers = false } = {}) {
    const said = String(text ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_#>|~]+/g, ' ')
        /* Times as said: "14h30" -> "14 heures 30", "14h" -> "14 heures" (read "14 H" otherwise, 31-10). */
        .replace(/\b([01]?\d|2[0-3])\s?[hH](?:\s?([0-5]\d))?\b/g, (_, h, m) => `${h} heure${h === '1' || h === '0' ? '' : 's'}${m ? ` ${m}` : ''}`)
        /* Never its own wake word aloud: the box heard itself and cut its own sentence (31-10). */
        .replace(/\b(?:hey|hé|eh)[\s,]+jarvis\b/giu, 'le mot d\'éveil')
        .replace(/(?<![\p{L}])m[ée]sanges?(?![\p{L}])/giu, 'le mot d\'éveil')
        .replace(/(?<![\p{L}])m[eéè]s[\s-]+anges?(?![\p{L}])/giu, 'le mot d\'éveil')   /* what sounds like it: « mes anges » woke it (31-10) */
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
    /* Nor another assistant's call: « OK Google » said in an example woke the Google Home beside it (31-10).
       Only speakTo() calls it, on purpose. */
    return callOthers ? said : said.replace(/\b(?:ok|okay|hey|dis)[\s,]+(?:google|siri|alexa)\b/giu, 'l\'appel de l\'enceinte');
}

/* THE BOX'S CLOCK: its lights follow the hours of its place. The time zone is the page's that made its code
   (its browser's), else this server's; the box is told its offset from UTC at each connection and every hour
   after, so summer time comes by itself. */
export function zoneOf(zone) {
    const z = String(zone ?? '').trim();
    try { if (z && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(z)) { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } } catch { /* unknown */ }
    return '';
}
export function offsetOf(zone, now) {
    const z = zoneOf(zone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return Math.round((local - Math.floor(now / 60_000) * 60_000) / 60_000);
}

export const RELAY_WITHIN_MS = 20_000;
/* Sentences to say one by one: cut after . ! ? … and kept at 40 characters at least (a tiny one joins the next). */
export function sentencesOf(text) {
    const out = [];
    for (const piece of String(text).split(/(?<=[.!?…])\s+/)) {
        if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += ` ${piece}`; else out.push(piece);
    }
    return out.filter(Boolean);
}

/* The words said while an answer is awaited (« Hmm… », « ça prend plus de temps ») -- off (01-11: heard all
   the time while the box misheard, they made it worse; back once the sound path is sound). */
/* 03-11: on again, but only the sentence made for THIS request (never a stock phrase), and only when the agent has
   said nothing within THINKING_AFTER_MS. */
export const WAITING_WORDS = true;
/* WHAT THE BOX MEASURED, its sentence ended (firmware 0.1.38): how long, when a voice was heard, the bar it
   used -- beside the message, with what reached this side. */
export function endOf(ep, reason = '') {
    if (!ep || typeof ep !== 'object') return '';
    const n = (v) => Number.isFinite(v);
    const sec = (v) => `${v.toFixed(1).replace('.', ',')} s`;
    const parts = [`fin ${String(reason).slice(0, 12)}${n(ep.s) ? ` ${sec(ep.s)}` : ''}`.replace(/\s+/g, ' ').trim()];
    /* The four slots of the chip, when the box says them (0.1.43): which one carries the voice. Short, the line is short. */
    if (Array.isArray(ep.slots) && ep.slots.length === 4) { parts.push(`voies ${ep.slots.map((v) => Math.round(Number(v) || 0)).join('/')}`); if (n(ep.voice) && ep.voice > 0) parts.push(`voix ${Math.round(ep.voice)}`); return parts.join(' · '); }
    parts.push(n(ep.heard_at) && ep.heard_at >= 0 ? `voix dès ${sec(ep.heard_at)}` : 'sans voix');
    if (n(ep.bar)) parts.push(`seuil ${Math.round(ep.bar)}`);
    if (n(ep.voice) && ep.voice > 0) parts.push(`voix ${Math.round(ep.voice)}`);
    if (n(ep.mean)) parts.push(`moy ${Math.round(ep.mean)}`);
    return parts.join(' · ');
}
/* 02-11: the light turning says it is at work; a word only when it really takes long. */
export const THINKING_AFTER_MS = 5_000;
export const LONGER_AFTER_MS = 12_000;
export const THINKING = ['Hmm…', 'Voyons…', 'Hmm, voyons voir…'];
/* WHY A BOX LISTENED, in a few words beside the message (01-11): what woke it (and the wake word's score), and
   what it cut short. */
export function whyOf(m) {
    const reason = { wake: 'éveil', button: 'bouton', follow: 'suite', knock: 'toc-toc' }[m?.reason] ?? (m?.reason ? String(m.reason).slice(0, 20) : 'inconnu');
    const score = Number.isFinite(m?.score) ? ` ${Math.round(m.score * 100)} %` : '';
    const cut = m?.cut ? ` · a coupé ${String(m.cut) === 'its own speech' ? 'sa phrase' : 'un son'}` : '';
    return `${reason}${score}${cut}`;
}

/* HOW LOUD WHAT THE BOX SENT WAS (01-11): beside the message, so a sentence that came empty (a wake, then
   silence: Whisper then invents « Sous-titrage ») is seen at once, and where it went wrong told apart --
   the box sent nothing, or the dictation misheard. */
export function levelOf(pcm) {
    const n = pcm.length >> 1; if (!n) return 0;
    let sum = 0; for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
    return Math.round(Math.sqrt(sum / n));
}
export const QUIET_LEVEL = 150;
export function soundOf(pcm) {
    const level = levelOf(pcm);
    return `reçu ${(pcm.length / 32_000).toFixed(1).replace('.', ',')} s niv ${level}${level < QUIET_LEVEL ? ' (silence)' : ''}`;
}

export const DOING_WITHIN_MS = 120_000;
export const CHAT_IN = /\b(?:mode conversation|on discute|discutons|let'?s (?:talk|chat))\b/i;
export const CHAT_OUT = /\b(?:merci,? c'est tout|c'est tout pour (?:moi|l'instant)|(?:fin|arr[eê]te|stop)\w*\b.{0,20}\b(?:conversation|[ée]couter)|that'?s all)\b/i;
export const TEST_SOUND = 'Test du son. Un, deux, trois. Si tu m\'entends, le son marche.';
export const TEST_MIC = 'Test du micro. Parle-moi, je t\'écoute.';
export const TEST_MIC_MS = 45_000;
/* A LONG RECORDING (a meeting, a class): asked in words, stopped by the button or the wake word. */
export const RECORD_ASKED = /\b(?:lance|d[ée]marre|commence|d[ée]bute)\w*\b.{0,25}\benregistrement\b|\benregistre\b.{0,20}\b(?:r[ée]union|conversation|cours|discussion|consultation)\b/i;
/* Off (01-11): a recording started without being asked, twice in a morning; back once it is asked for on
   purpose (a button on the page). */
export const RECORD_BY_VOICE = false;
export const RECORD_MAX_BYTES = 4 * 3600 * 32_000;   /* four hours */
export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/* THE MIXER of a box that plays a stream: words said meanwhile go over it, the stream lowered to DUCK while
   they last, with a fade down and up (a quarter of a second) rather than a jump. One 20 ms chunk at a time. */
export const DUCK = 0.2;
/* LEVELS (01-11): like a phone, one volume for the whole box (set, and eased to the room by the box itself),
   and under it each kind of sound brought to its own steady level -- a loud radio and a quiet one played alike
   (ffmpeg's loudnorm, EBU R128), the radio a step below the box's voice, its voice always at one loudness. */
export const STREAM_LUFS = -26;
export const STREAM_LEVEL = 1;
export const VOICE_RMS = 3300;   /* about -20 dBFS: the loudness the voice was found right at */
export function levelled(pcm, target = VOICE_RMS) {
    let sum = 0; let n = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) { const v = pcm.readInt16LE(i); if (Math.abs(v) > 300) { sum += v * v; n++; } }
    if (n < 100) return pcm;
    const gain = Math.min(4, target / Math.sqrt(sum / n));
    if (Math.abs(gain - 1) < 0.05) return pcm;
    const out = Buffer.alloc(pcm.length & ~1);
    for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
    return out;
}
export function mix(stream, chunk) {
    const words = stream.over[0];
    const target = words ? DUCK : 1;
    const out = Buffer.alloc(chunk.length);
    const step = (1 - DUCK) / (0.25 * 16_000);
    for (let i = 0; i < chunk.length; i += 2) {
        stream.gain += Math.max(-step, Math.min(step, target - stream.gain));
        let v = chunk.readInt16LE(i) * stream.gain * STREAM_LEVEL;
        if (words && stream.gain <= DUCK + 0.05) {
            stream.at ??= 0;
            if (stream.at + 1 < words.length) { v += words.readInt16LE(stream.at); stream.at += 2; }
        }
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i);
    }
    if (words && stream.at + 1 >= words.length) { stream.over.shift(); stream.at = 0; }
    return out;
}

export const ANSWER_WITHIN_MS = 90_000;
export const CHAT_WITHIN_MS = 3 * 60_000;
export const LISTEN_AHEAD = 3 * 32_000;   /* bytes: what a box is sent ahead of what it plays (its buffer holds 16 s) */

/* A LONG SENTENCE, IN PIECES: dictation takes 16 s at most (voice.mjs, AUDIO_MAX), a box a minute; five
   long sentences were lost so (31-10). Each piece ends at the quietest 20 ms between 8 and 14 s: a pause,
   most often, rather than a word cut in two. PCM 16 kHz 16-bit mono in, pieces out. */
export function piecesOf(pcm, { least = 8, most = 14 } = {}) {
    const second = 32_000; const step = 640; const out = [];
    let at = 0;
    while (pcm.length - at > most * second) {
        let best = at + most * second; let quietest = Infinity;
        for (let i = at + least * second; i + step <= at + most * second; i += step) {
            let e = 0;
            for (let k = i; k < i + step; k += 2) { const v = pcm.readInt16LE(k); e += v * v; }
            if (e < quietest) { quietest = e; best = i + step / 2; }
        }
        best -= best % 2;
        out.push(pcm.subarray(at, best)); at = best;
    }
    out.push(pcm.subarray(at));
    return out;
}

export class Boxes {
    #file; #codes = new Map(); #links = new Map(); #tries = []; #now;
    #exists; #hear; #say; #speak; #log; #changed; #images = new Map(); #origin; #spawn; #fetch; #streams = new Map(); #recordDir; #parts; #keep; #react; #learn;

    /* file: a JsonFile holding [{ id, name, conversation, keyHash, firmware, createdAt, seenAt }].
       exists(conversation), hear(wav) -> text, say(conversation, text, room), speak(text) -> PCM 16 kHz. */
    constructor({ file, exists = () => true, hear, say, speak, changed = () => {}, origin = () => null, now = () => Date.now(), log = () => {}, spawn = spawnProcess, fetcher = fetch, recordDir = null, parts = null, keep = null, react = async () => null, learn = null }) {
        this.#react = react; this.#learn = learn;
        this.#spawn = spawn; this.#fetch = fetcher; this.#recordDir = recordDir; this.#parts = parts; this.#keep = keep;
        this.#file = file; this.#changed = changed; this.#origin = origin; this.#exists = exists; this.#hear = hear; this.#say = say; this.#speak = speak; this.#now = now; this.#log = log;
    }

    #all() { const v = this.#file.get(); return Array.isArray(v) ? v : []; }
    #save(list) { this.#file.set(list); try { this.#changed(); } catch { /* the caller's */ } }

    /* The boxes of one conversation, as its thread names them: { id, name, place }. */
    speakersOf(conversation) { return this.#all().filter((b) => b.conversation === conversation).map((b) => ({ id: b.id, name: b.name, ...(b.place ? { place: b.place } : {}) })); }

    /* What the operator sees: never the key, nor its hash. */
    all() {
        return this.#all().map(({ keyHash, ...b }) => ({ ...b, online: this.#links.has(b.id), muted: this.#links.get(b.id)?.muted ?? null, volume: b.volume ?? this.#links.get(b.id)?.volume ?? VOLUME_DEFAULT }));
    }

    code(conversation, name, zone = '') {
        if (!this.#exists(conversation)) throw new Refusal(404, 'No such conversation.');
        const code = newCode();
        const label = String(name ?? '').trim().slice(0, NAME_MAX);
        this.#codes.set(plainCode(code), { conversation, name: label, zone: zoneOf(zone), until: this.#now() + CODE_MINUTES * 60_000 });
        return { code, minutes: CODE_MINUTES };
    }

    pair(body) {
        const now = this.#now();
        this.#tries = this.#tries.filter((t) => t > now - 60_000);
        if (this.#tries.length >= TRIES_PER_MINUTE) throw new Refusal(429, 'Too many tries: wait a minute.');
        this.#tries.push(now);
        for (const [c, v] of this.#codes) if (v.until < now) this.#codes.delete(c);
        const wanted = this.#codes.get(plainCode(body?.code));
        if (!wanted) throw new Refusal(403, 'Unknown or expired code.');
        this.#codes.delete(plainCode(body.code));
        const key = randomBytes(32).toString('base64url');
        const name = wanted.name || String(body.room ?? '').trim().slice(0, NAME_MAX) || 'Voice box';
        const box = {
            id: randomUUID(), name, conversation: wanted.conversation, keyHash: hashOf(key),
            type: String(body.type ?? '').slice(0, 40), firmware: String(body.firmware ?? '').slice(0, 20),
            capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String).slice(0, 20) : [],
            createdAt: new Date(now).toISOString(), seenAt: null,
            ...(wanted.zone ? { zone: wanted.zone } : {}),
        };
        this.#save([...this.#all(), box]);
        this.#log(`voice box paired: ${name} (${box.conversation})`);
        return { id: box.id, key, name };
    }

    byKey(key) {
        if (!key) return undefined;
        const h = Buffer.from(hashOf(key), 'hex');
        return this.#all().find((b) => timingSafeEqual(Buffer.from(b.keyHash, 'hex'), h));
    }

    rename(id, name) {
        const label = String(name ?? '').trim().slice(0, NAME_MAX);
        if (!label) throw new Refusal(400, 'A name, please.');
        this.#change(id, { name: label });
    }

    /* Louder or softer: kept, and given to the box now if it is connected. */
    async setVolume(id, level) {
        const n = Math.round(Number(level));
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new Refusal(400, 'A volume from 0 to 100.');
        this.#change(id, { volume: n });
        const link = this.#links.get(id);
        if (!link) return { ok: true, offline: true };
        const a = await this.command(id, { t: 'volume', level: n });
        if (a?.ok !== false) link.volume = n;
        return a;
    }

    /* TESTED FROM ITS CARD (01-11): the sound -- it says a test sentence -- and the microphone -- it listens
       once, and what it heard is shown on the page, not sent to the conversation. */
    async testSound(id) {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        link.play(await this.#speak(TEST_SOUND));
        return { ok: true };
    }
    async testMic(id) {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        link.testing = { until: this.#now() + TEST_MIC_MS, state: 'listening', text: '' };
        link.play(await this.#speak(TEST_MIC), 'listen');
        return { ok: true };
    }
    testResult(id) {
        const t = this.#links.get(id)?.testing;
        if (!t) return { state: 'none', text: '' };
        if (t.state === 'listening' && this.#now() > t.until) t.state = 'nothing';
        return { state: t.state, text: t.text };
    }
    #tested(link, state, text = '') {
        const t = link.testing;
        if (!t || t.state !== 'listening' || this.#now() > t.until) return false;
        t.state = state; t.text = text;
        return true;
    }

    /* A sound played on a box (a sample, a recorded message), as its answers are. */
    play(id, wav) {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        const pcm = pcmOfWav(wav);
        link.play(pcm);
        return { seconds: Math.round(pcm.length / 32_000) };
    }

    /* UPDATED OVER ITS WI-FI: the image is offered at a one-use address on this server (under /c/,
       no sign-on: the token is the right), the box told to fetch it with its sha256; it answers
       once installed, then restarts. */
    async update(id, image, version = '') {
        if (!this.#links.has(id)) throw new Refusal(409, 'This voice box is not connected: it is updated when it is online.');
        const bytes = Buffer.isBuffer(image) ? image : Buffer.from(String(image ?? ''), 'base64');
        if (bytes.length < 1024 || bytes[0] !== 0xe9) throw new Refusal(400, 'Not an ESP32 program image (it starts with 0xE9; a merged image is for a cable flash only).');
        const origin = this.#origin();
        if (!origin) throw new Refusal(409, 'This server does not know its public address: the box could not fetch the image.');
        const token = randomBytes(24).toString('base64url');
        this.#images.set(token, { bytes, until: this.#now() + FIRMWARE_MINUTES * 60_000 });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        try {
            const a = await this.command(id, { t: 'ota', url: `${origin}${FIRMWARE_PATH}${token}.bin`, sha256 }, 5 * 60_000);
            if (a?.ok === false) throw new Refusal(502, `The box did not install it: ${a.detail ?? 'no reason given'}.`);
            this.#log(`voice box ${this.#all().find((b) => b.id === id)?.name ?? id}: updated${version ? ` to ${version}` : ''}, restarting`);
            return { ok: true };
        } finally { this.#images.delete(token); }
    }
    image(token) {
        const now = this.#now();
        for (const [k, v] of this.#images) if (v.until < now) this.#images.delete(k);
        return this.#images.get(String(token).replace(/\.bin$/, ''))?.bytes;
    }

    /* SPEAKING TO ANOTHER DEVICE in the room (a Google Home: « OK Google, baisse la clim »): said as given, its
       call included, then the box listens; what it hears within twenty seconds comes back to the conversation as
       that device's answer, not as the person's words (31-10: the box set the heating that way). */
    async speakTo(id, text) {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        const words = forSpeech(text, { callOthers: true });
        if (!words) throw new Refusal(400, 'Nothing to say.');
        link.play(await this.#speak(words), 'listen');
        link.relay = this.#now();
        this.#log(`voice box ${link.box().name}: spoke to a device in the room`);
        return { ok: true };
    }

    /* LISTENING TO THE INTERNET: a radio, a podcast, a music file, a playlist, read by this server (ffmpeg,
       any format it knows) and sent on to the box at the pace it is played, a few seconds ahead -- until it
       ends, stop(), or the person presses the button or says the wake word (the box then starts a sentence). */
    async listen(id, url, name = '') {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        this.stop(id);
        const source = await this.#resolve(url);
        let child;
        try { child = this.#spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', source, '-vn', '-af', `loudnorm=I=${STREAM_LUFS}:TP=-3:LRA=11`, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { throw new Refusal(501, 'This server cannot read sounds: ffmpeg is not installed (an update installs it).'); }
        const box = link.box(); const label = name || new URL(url).host;
        const stream = { child, queue: [], queued: 0, sent: 0, started: this.#now(), timer: null, ended: false, failed: '', over: [], gain: 1 };
        this.#streams.set(id, stream);
        link.send({ t: 'speak.start', rate: 16_000, kind: 'stream' });   /* not its own voice: the box still hears its word, near-certain only */
        child.stdout.on('data', (d) => { stream.queue.push(d); stream.queued += d.length; if (stream.queued > LISTEN_AHEAD * 4) child.stdout.pause(); });
        child.stderr.on('data', (d) => { stream.failed = `${stream.failed}${d}`.slice(-300); });
        child.on('error', (e) => { stream.failed = e.code === 'ENOENT' ? 'ffmpeg is not installed on this server' : e.message; stream.ended = true; });
        child.on('close', () => { stream.ended = true; });
        let carry = Buffer.alloc(0);
        stream.timer = setInterval(() => {
            if (this.#streams.get(id) !== stream) return;
            const due = (this.#now() - stream.started) * 32 + LISTEN_AHEAD;   /* bytes the box should have by now, a few seconds ahead */
            while (stream.sent + 640 <= due && (carry.length >= 640 || stream.queue.length)) {
                if (carry.length < 640) { const d = stream.queue.shift(); stream.queued -= d.length; carry = Buffer.concat([carry, d]); continue; }
                if (link.socket.readyState === 1) link.socket.send(mix(stream, carry.subarray(0, 640)));
                carry = carry.subarray(640); stream.sent += 640;
            }
            if (stream.queued < LISTEN_AHEAD) child.stdout.resume();
            if (stream.ended && !stream.queue.length && carry.length < 640) {
                this.#log(`voice box ${box.name}: ${label} ended after ${Math.round(stream.sent / 32_000)} s${stream.failed && stream.sent < 32_000 ? ` (${stream.failed.trim().split('\n').pop()})` : ''}`);
                this.stop(id);
            }
        }, 100);
        stream.timer.unref?.();
        this.#log(`voice box ${box.name}: plays ${label}`);
        return { ok: true };
    }
    stop(id) {
        const stream = this.#streams.get(id);
        if (!stream) return false;
        this.#streams.delete(id);
        clearInterval(stream.timer);
        try { stream.child.kill('SIGTERM'); } catch { /* gone */ }
        this.#links.get(id)?.send({ t: 'speak.end' });
        return true;
    }
    /* A playlist (.m3u, .pls) is a list of addresses: its first one. */
    async #resolve(url) {
        if (!/\.(m3u|pls)(\?|$)/i.test(new URL(url).pathname)) return url;
        try {
            const r = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
            const text = await r.text();
            return text.split(/\r?\n/).map((l) => l.replace(/^File\d+=/i, '').trim()).find((l) => /^https?:\/\//.test(l)) ?? url;
        } catch { return url; }
    }

    /* Where it is (a home, a family house): grouped by it, named with it. */
    zone(id, zone, lang) {
        const z = zoneOf(zone);
        if (!z) throw new Refusal(400, 'Not a time zone.');
        /* Its language too, from the page that manages it (02-11: unsaid, the dictation guessed Danish on a
           short French sentence). A tag such as fr or fr-FR, nothing else. */
        const l = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(lang ?? '')) ? String(lang) : null;
        this.#change(id, { zone: z, ...(l ? { lang: l } : {}) });
        this.#links.get(id)?.send({ t: 'clock', offset: offsetOf(z, this.#now()) });
    }
        place(id, place) { this.#change(id, { place: String(place ?? '').trim().slice(0, NAME_MAX) }); }

    move(id, conversation) {
        if (!this.#exists(conversation)) throw new Refusal(404, 'No such conversation.');
        this.#change(id, { conversation });
    }

    /* Withdrawn: its link closes now, and its key opens nothing any more. */
    revoke(id) {
        const list = this.#all();
        if (!list.some((b) => b.id === id)) throw new Refusal(404, 'No such voice box.');
        this.#save(list.filter((b) => b.id !== id));
        this.#links.get(id)?.socket.close(4001, 'withdrawn');
        try { this.#learn?.forget(id); } catch { /* nothing kept */ }
    }

    /* THE WAKE WORD THAT LEARNS (wakelearn.mjs): "normal" keeps nothing, "learn" keeps each wake clip with
       its label. Its counts are made either way. */
    #box(id) { const b = this.#all().find((x) => x.id === id); if (!b) throw new Refusal(404, 'No such voice box.'); return b; }
    #learning() { if (!this.#learn) throw new Refusal(501, 'This server keeps no wake clips.'); return this.#learn; }
    wakeMode(id, mode) {
        if (!['normal', 'learn'].includes(mode)) throw new Refusal(400, 'A mode: normal or learn.');
        this.#change(id, { wake: mode });
        return this.wakeStats(id);
    }
    wakeStats(id) { const b = this.#box(id); return { ...this.#learning().stats(id, b.wake ?? 'normal'), cutoff: this.#cutoff(b), wakeModel: b.model ?? null, modelProblem: b.modelProblem ?? null }; }
    #cutoff(b) { return cutoffOf(b.cutoff) ?? WIRE.firmwareCutoff; }
    wakeErase(id) { const b = this.#box(id); const n = this.#learning().erase(id); this.#log(`voice box ${b.name}: ${n} wake clip(s) erased`); return this.wakeStats(id); }
    /* "Improve now": the threshold tuned at once; nothing better, the trainer (phase 2) is asked. */
    wakeImprove(id) {
        const b = this.#box(id);
        const tuning = this.wakeTune(id, 'asked');
        if (tuning.better) return { queued: false, at: tuning.at, tuning };
        const at = this.#learning().improve(id); this.#log(`voice box ${b.name}: a better wake word asked`);
        return { queued: true, at, tuning };
    }
    /* THRESHOLD TUNING (wakelearn.mjs, tuneCutoff): a better cutoff found is sent to the box (wake.cutoff);
       once it confirms (its ack, or its hello showing it), said in its conversation. Not connected: sent at
       its next hello. */
    wakeTune(id, why = 'asked') {
        const b = this.#box(id);
        const r = this.#learning().tune(id, this.#cutoff(b));
        const t = this.#learn.tuned(id, { ...r, why, state: r.better ? 'sent' : 'none' });
        this.#log(`voice box ${b.name}: wake threshold tuning (${why}): ${r.better ? `${r.from} -> ${r.to}` : r.reason}`);
        if (r.better) this.#sendCutoff(id, r.to);
        return t;
    }
    #sendCutoff(id, value) {
        if (!this.#links.get(id)?.tunable) return;   /* not connected, or a firmware without wake.cutoff (its hello says none) */
        this.command(id, { t: WIRE.cutoff, value }).then(
            (a) => { if (a?.ok === false) this.#tuneState(id, 'refused'); else void this.#cutoffSet(id, value); },
            () => { /* no answer: sent again at its next hello */ });
    }
    #tuneState(id, state) { const t = this.#learn?.tuning(id); if (t) this.#learn.tuned(id, { ...t, state }); }
    /* The box holds `value` (its ack, or its hello): kept; a tuning sent for it is said, once. */
    async #cutoffSet(id, value) {
        let b; try { b = this.#box(id); } catch { return null; }
        if (b.cutoff !== value) this.#change(id, { cutoff: value });
        const t = this.#learn?.tuning(id);
        if (!t || t.state !== 'sent' || t.to !== value) return null;
        this.#learn.tuned(id, { ...t, state: 'applied', appliedAt: new Date(this.#now()).toISOString() });
        const fr = /^fr/.test(b.lang ?? '');
        const n = (v, d = 1) => String(Math.round(Number(v) * 10 ** d) / 10 ** d).replace('.', fr ? ',' : '.');
        const c = (v) => Number(v).toFixed(2).replace('.', fr ? ',' : '.');
        const text = fr
            ? `Mot d'éveil réglé : seuil ${c(t.from)} → ${c(t.to)} (faux réveils ${n(t.falsePerDayBefore)} → ${n(t.falsePerDayAfter)} par jour sur tes ${t.clips} extraits ; appels manqués ${t.missedBefore} → ${t.missedAfter}).`
            : `Wake word tuned: threshold ${c(t.from)} → ${c(t.to)} (false wakes ${n(t.falsePerDayBefore)} → ${n(t.falsePerDayAfter)} a day on your ${t.clips} clips; missed calls ${t.missedBefore} → ${t.missedAfter}).`;
        this.#log(`voice box ${b.name}: wake threshold now ${value}`);
        try { await this.#say(b.conversation, text, { id: b.id, name: b.name, ...(b.place ? { place: b.place } : {}) }); } catch (error) { this.#log(`voice box ${b.name}: the tuning not said (${error.message})`); }
        return text;
    }
    /* WEEKLY (Sunday from 03:00, the box's own time): each learning box tuned once a week. Called often. */
    wakeWeekly() {
        const now = this.#now(); const ran = [];
        for (const b of this.#all()) {
            if (b.wake !== 'learn' || !this.#learn) continue;
            const local = new Date(now + offsetOf(b.zone, now) * 60_000);
            if (local.getUTCDay() !== 0 || local.getUTCHours() < 3) continue;
            if (now - (Date.parse(b.wakeWeeklyAt ?? '') || 0) < 6 * 86_400_000) continue;
            this.#change(b.id, { wakeWeeklyAt: new Date(now).toISOString() });
            try { ran.push(this.wakeTune(b.id, 'weekly')); } catch (error) { this.#log(`voice box ${b.name}: weekly tuning failed (${error.message})`); }
        }
        return ran;
    }
    /* Phase 2's trainer put a better model on the box: kept, and said in its conversation in its name. */
    async modelInstalled(id, { before, after }) {
        const b = this.#box(id);
        const m = this.#learning().installed(id, { before, after });
        const { kept } = this.#learn.stats(id, b.wake);
        const n = (v) => String(Math.round(Number(v) * 10) / 10).replace('.', /^fr/.test(b.lang ?? '') ? ',' : '.');
        const text = /^fr/.test(b.lang ?? '')
            ? `Nouveau mot d'éveil installé (faux réveils ${n(before)} \u2192 ${n(after)} par jour sur tes ${kept} extraits).`
            : `New wake word installed (false wakes ${n(before)} \u2192 ${n(after)} a day on your ${kept} clips).`;
        this.#log(`voice box ${b.name}: new wake word installed`);
        try { await this.#say(b.conversation, text, { id: b.id, name: b.name, ...(b.place ? { place: b.place } : {}) }); } catch (error) { this.#log(`voice box ${b.name}: the new wake word not said (${error.message})`); }
        return { ...m, text };
    }

    /* A conversation removed or renamed: its boxes follow, or are left without one. */
    conversationRenamed(from, to) { for (const b of this.#all()) if (b.conversation === from) this.#change(b.id, { conversation: to }); }

    #change(id, changes) {
        const list = this.#all();
        const i = list.findIndex((b) => b.id === id);
        if (i < 0) throw new Refusal(404, 'No such voice box.');
        list[i] = { ...list[i], ...changes };
        this.#save(list);
    }

    /* A command to a box (led, volume, wifi.scan, wifi.join, alert, reboot): resolves with its answer. */
    command(id, message, timeoutMs = 30_000) {
        const link = this.#links.get(id);
        if (!link) return Promise.reject(new Refusal(409, 'This voice box is not connected.'));
        const ask = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { link.waiting.delete(ask); reject(new Refusal(504, 'The voice box did not answer.')); }, timeoutMs);
            timer.unref?.();
            link.waiting.set(ask, (answer) => { clearTimeout(timer); resolve(answer); });
            link.send({ ...message, id: ask });
        });
    }

    /* The tool said or asked something in a conversation: said aloud only by the boxes it is
       addressed to (`to`: box ids, #215). Anything else stays in the thread, silent -- a box
       read a whole technical message aloud once (31-10), which nobody wants. */
    /* WHILE THE ANSWER IS THOUGHT (01-11): no long silence after a sentence. A short « hmm » if nothing has
       come after a little while, then a word that it takes longer; whatever the assistant says first (an answer,
       what it is doing) ends the wait. A longer question (many words) is told sooner that it takes a moment. */
    #waitFor(link, text = '') {
        clearTimeout(link.thinkingA); clearTimeout(link.thinkingB);
        const said = link.heardAt;
        const still = () => link.heardAt === said && !((link.answeredAt ?? 0) >= said);
        const long = String(text).length > 160;   /* a long question: told sooner that it takes a moment */
        const say = async (words) => { if (!still() || link.recording || this.#streams.has(link.box().id)) return; try { link.play(await this.#speak(words)); } catch { /* the light says it */ } };
        /* Made at once, used if the answer is still not there: a reaction to THIS sentence, in its language. */
        let made = null;
        this.#react(text).then((t) => { made = t; }).catch(() => {});
        link.thinkingA = setTimeout(() => { if (made) void say(made); }, THINKING_AFTER_MS);
        /* One word of waiting, not two (02-11: « je regarde, un instant » again and again). */
        link.thinkingA.unref?.();
    }

    async agentSaid(conversation, text, to = null, { doing = false, asked = false } = {}) {
        /* What it is doing is written for a screen ("Tâche de fond : bêta 0.2.113…"): read aloud, it was words
           from nowhere (31-10). Aloud, only a short plain one; otherwise a word that it is at work. */
        const plain = forSpeech(text);
        /* 02-11: not even « Je regarde, un instant » in its place -- said each time the agent wrote what it does, it
           came back again and again. A long or technical one is not said at all. */
        /* Sent to a box on purpose (03-11: "dis au plus tôt ce que tu vas faire"): said as it is written. */
        const aimed = doing && Array.isArray(to) && to.length > 0;
        const words = doing && !aimed && (plain.length > 70 || /[\d:;/()[\]→=_]/.test(plain)) ? '' : plain;
        if (!words) return;
        let boxes;
        if (aimed) boxes = [...this.#links.values()].filter((l) => l.box().conversation === conversation && to.includes(l.box().id));
        else if (doing) {
            /* "I'm looking in the calendar": once per sentence heard, on the box that heard it, within two minutes. */
            /* 02-11: what it really does, in its words (« je regarde dans ton agenda »); never a stock phrase. */
            boxes = [...this.#links.values()].filter((l) => l.box().conversation === conversation && l.heardAt && !l.doingSaid && this.#now() - l.heardAt < DOING_WITHIN_MS);
            for (const l of boxes) l.doingSaid = true;
        } else {
            if (!Array.isArray(to) || to.length === 0) return;
            boxes = [...this.#links.values()].filter((l) => l.box().conversation === conversation && to.includes(l.box().id));
        }
        if (boxes.length === 0) return;
        /* A question: the box listens again right after, no wake word needed. So does a box in CONVERSATION:
           asked for ("mode conversation") -- never by itself any more (01-11);
           it ends when nobody answers, or on "fin de la conversation". */
        /* Only a question asked on purpose (parley ask) opens listening; one that merely ends in « ? » does not
           any more (01-11: each follow-up listen took in the room and came back as invented words). */
        const question = !doing && asked;
        for (const l of boxes) { l.answeredAt = this.#now(); clearTimeout(l.thinkingA); clearTimeout(l.thinkingB); }
        for (const l of boxes) {
            /* An answer -- to a sentence heard within a minute -- may open the conversation; something said
               of itself (a news item, a reminder) does not: the box listened after it for nothing (31-10). */
            const answering = l.heardAt && this.#now() - l.heardAt < ANSWER_WITHIN_MS;
            const chatting = !doing && answering && this.#chatting(l);
            const opening = chatting && !l.chat;
            if (chatting && !l.chat) l.send({ t: 'chat', on: true });
            if (chatting) l.chat = true;
            /* SENTENCE BY SENTENCE: the first is said while the next ones are made -- the answer starts sooner
               (31-10: a few seconds of silence before each answer). The box queues them, one after the other. */
            const parts = sentencesOf(opening ? `On discute. ${words}` : words);
            let next = this.#speak(parts[0]);
            for (const [i, part] of parts.entries()) {
                let pcm;
                try { pcm = await next; } catch (error) { this.#log(`voice box: no voice for the answer (${error.message})`); l.send({ t: 'cue', name: 'error' }); break; }
                if (i + 1 < parts.length) { next = this.#speak(parts[i + 1]); next.catch(() => {}); }
                /* Listened after only when what it says calls for an answer (03-11: "en fonction de la réponse"): the
                   agent says so by asking (parley ask), not the box by guessing. */
                l.play(pcm, i + 1 === parts.length && (question || chatting) ? 'listen' : null);
            }
        }
    }
    /* Only when asked ("mode conversation"): opened by itself after two sentences, it stayed listening and
       took in the room's talk -- the circle kept lit, stray words sent (01-11). */
    #chatting(link) {
        return Boolean(link.chat);
    }

    /* A box connected with its key: speaks protocol v1 on `socket` (a ws WebSocket). */
    accept(socket, box) {
        this.#links.get(box.id)?.socket.close(4000, 'replaced');
        const send = (o) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
        const link = {
            socket, send, waiting: new Map(), heardAt: 0, muted: null, volume: null,
            box: () => this.#all().find((b) => b.id === box.id) ?? box,
            play: (pcm, then = null) => {
                pcm = levelled(pcm.subarray(0, pcm.length & ~1));   /* whole samples only (an odd byte shifts every sample after it), at the voice's level */
                /* Something is playing (a radio): the words go over it, the radio lowered meanwhile (the mixer, listen()). */
                const playing = this.#streams.get(box.id);
                if (playing) { playing.over.push(pcm); return; }
                send({ t: 'speak.start', rate: 16_000 });
                for (let at = 0; at < pcm.length; at += 640) if (socket.readyState === 1) socket.send(pcm.subarray(at, at + 640));
                send({ t: 'speak.end', ...(then ? { then } : {}) });
            },
        };
        this.#links.set(box.id, link);
        this.#log(`voice box ${box.name}: connected`);
        let sentence = null; let size = 0;
        const seen = () => { try { this.#change(box.id, { seenAt: new Date(this.#now()).toISOString() }); } catch { /* withdrawn meanwhile */ } };
        seen();
        socket.on('message', (data, binary) => {
            if (binary) {
                if (link.recording) {
                    const r = link.recording;
                    if (r.bytes + data.length > RECORD_MAX_BYTES) { if (!r.full) { r.full = true; send({ t: 'record', on: false }); } return; }
                    r.out.write(data); r.bytes += data.length;
                    return;
                }
                /* The wake word's own 1.6 s (wake.clip): kept apart, heard again before the word is trusted. */
                if (link.clip) { if (link.clip.bytes < CLIP_MAX_BYTES) { link.clip.parts.push(Buffer.from(data)); link.clip.bytes += data.length; } return; }
                if (link.near) { if (link.near.bytes < CLIP_MAX_BYTES) { link.near.parts.push(Buffer.from(data)); link.near.bytes += data.length; } return; }
                if (!sentence || link.muted) return;
                size += data.length;
                if (size <= SENTENCE_MAX) sentence.push(Buffer.from(data));
                return;
            }
            let m;
            try { m = JSON.parse(String(data)); } catch { return; }
            if (!m || typeof m !== 'object') return;
            if (m.t === 'ping') { send({ t: 'pong' }); return; }
            if (m.t === 'hello' && typeof m.problem === 'string' && m.problem) this.#log(`voice box ${box.name}: back online after ${Number(m.tries) || '?'} tries; it had: ${m.problem.slice(0, 160)}`);
            if (m.t === 'hello') {
                /* Its volume, as set here: given at each connection (a box keeps its own, softer, otherwise). */
                const wanted = link.box().volume ?? VOLUME_DEFAULT;
                if (m.volume !== wanted) { send({ t: 'volume', id: randomUUID(), level: wanted }); m.volume = wanted; }
            }
            if (m.t === 'hello') send({ t: 'clock', offset: offsetOf(link.box().zone, this.#now()) });
            if (m.t === 'ping' && this.#now() - (link.clockAt ?? 0) > 3_600_000) { link.clockAt = this.#now(); send({ t: 'clock', offset: offsetOf(link.box().zone, this.#now()) }); }
            if (m.t === 'hello') {
                /* Its threshold and model (0.1.49): a tuning it holds is confirmed; one it missed, sent again. */
                const cut = cutoffOf(m.cutoff); link.tunable = cut !== null;
                const model = typeof m.model === 'string' ? m.model.slice(0, 40) : null;
                const modelProblem = typeof m.model_problem === 'string' && m.model_problem ? m.model_problem.slice(0, 160) : null;
                const was = link.box();
                if (model !== (was.model ?? null) || modelProblem !== (was.modelProblem ?? null)) this.#change(box.id, { model, modelProblem });
                if (modelProblem) this.#log(`voice box ${box.name}: its wake model: ${modelProblem}`);
                const t = this.#learn?.tuning(box.id);
                if (cut !== null) void this.#cutoffSet(box.id, cut);
                else if (was.cutoff != null) this.#change(box.id, { cutoff: null });   /* an older firmware: 0.94, built in */
                if (t?.state === 'sent' && t.to !== cut) this.#sendCutoff(box.id, t.to);
            }
            if (m.t === 'hello') { link.muted = m.muted === true; link.volume = Number.isFinite(m.volume) ? m.volume : null; this.#change(box.id, { firmware: String(m.firmware ?? '').slice(0, 20) }); seen(); return; }
            if (m.t === 'record.start' && this.#recordDir) {
                mkdirSync(this.#recordDir, { recursive: true });
                const file = `${this.#recordDir}/${box.id}-${this.#now()}.pcm`;
                link.recording = { file, out: createWriteStream(file), bytes: 0, at: this.#now() };
                this.#log(`voice box ${box.name}: recording`);
                return;
            }
            if (m.t === 'record.end' && link.recording) {
                const r = link.recording; link.recording = null;
                r.out.end(() => { void this.#recorded(link, r); });
                return;
            }
            if (m.t === WIRE.clip && m.edge === 'start') { link.clip = { parts: [], bytes: 0, score: scoreOf(m.score) };   /* none (before 0.1.49): unknown, left out of tuning */ return; }
            if (m.t === WIRE.clip && m.edge === 'end' && link.clip) { const { parts, score } = link.clip; link.clip = null; link.wakeCheck = this.#checkWake(link, Buffer.concat(parts), { score }); return; }
            if (m.t === WIRE.near && m.edge === 'start') { link.near = { parts: [], bytes: 0, score: scoreOf(m.score) }; return; }
            if (m.t === WIRE.near && m.edge === 'end' && link.near) { const { parts, score } = link.near; link.near = null; void this.#checkNear(link, Buffer.concat(parts), score); return; }
            if (m.t === 'event' && m.name === 'wake.own') { this.#log(`voice box ${box.name}: heard its own voice say the wake word, ignored`); return; }
            if (m.t === 'event' && m.name === 'noise.dropped') { this.#log(`voice box ${box.name}: a sound near full scale was cut by its noise guard`); return; }
            /* The box listens for a sentence while this side still records: the two disagree (a reconnection, a
               lost record.end). The recording is closed here, or the sentence would go into it and arrive empty. */
            if (m.t === 'listen.start' && link.recording) {
                const r = link.recording; link.recording = null;
                this.#log(`voice box ${box.name}: a sentence while recording here, the recording closed`);
                r.out.end(() => { void this.#recorded(link, r); });
            }
            if (m.t === 'listen.start') { link.why = whyOf(m); link.wakeCheck = null; }   /* its clip, if any, comes after listen.start: an older check never carries over */
            if (m.t === 'listen.start') { if (this.stop(box.id)) this.#log(`voice box ${box.name}: stopped playing, someone speaks`); sentence = []; size = 0; return; }
            if (m.t === 'listen.end' && sentence && m.reason === 'nobody') {
                /* Listened again, nobody spoke: a conversation ends there, in silence. */
                sentence = null;
                if (this.#tested(link, 'nothing')) { link.send({ t: 'cue', name: 'done' }); return; }
                if (link.chat) { this.#log(`voice box ${box.name}: conversation ended, nobody answered`); link.send({ t: 'chat', on: false }); }
                link.chat = false; link.recent = [];
                link.send({ t: 'cue', name: 'done' });
                return;
            }
            if (m.t === 'listen.end' && m.ep) {
                const end = endOf(m.ep, m.reason ?? '');
                link.why = `${link.why ? `${link.why} · ` : ''}${end}`;
                this.#log(`voice box ${box.name}: ${end}`);
            }
            if (m.t === 'listen.end' && sentence) {
                const pcm = Buffer.concat(sentence);
                sentence = null;
                /* RADIO OR TV IN A CONVERSATION (03-11): a "sentence" that never stopped (cut by its length) is not
                   talk to it -- asked once « Tu me parles ? »; a second one ends the conversation. Nothing sent. */
                if (link.chat && m.reason === 'timeout') {
                    if (link.chatDoubt) { link.chat = false; link.chatDoubt = false; link.recent = []; link.send({ t: 'chat', on: false }); this.#log(`voice box ${box.name}: conversation ended, the room talks`); link.send({ t: 'cue', name: 'done' }); return; }
                    link.chatDoubt = true;
                    void (async () => { try { link.play(await this.#speak('Tu me parles ?'), 'listen'); } catch { link.send({ t: 'cue', name: 'done' }); } })();
                    return;
                }
                link.chatDoubt = false;
                void this.#heard(link, pcm);
                return;
            }
            if (m.t === 'event') {
                if (m.name === 'mute.on') link.muted = true;
                if (m.name === 'mute.off') link.muted = false;
                return;
            }
            if ((m.t === 'ack' || m.t === 'wifi.scan.result') && typeof m.id === 'string') { link.waiting.get(m.id)?.(m); link.waiting.delete(m.id); }
        });
        socket.on('close', () => { if (link.recording) { const r = link.recording; link.recording = null; r.out.end(() => { void this.#recorded(link, r); }); }
            if (this.#links.get(box.id) === link) { this.stop(box.id); this.#links.delete(box.id); this.#log(`voice box ${box.name}: disconnected`); } });
        socket.on('error', () => {});
    }

    /* A recording ended: transcribed in parts of five minutes (cut at a quiet moment), who speaks noted when the
       engine tells voices apart; the text kept beside the conversation, and said there in a short line, so its
       assistant writes what was asked of it. The sound itself is not kept. */
    async #recorded(link, r) {
        const box = link.box();
        const minutes = Math.round(r.bytes / 32_000 / 60);
        this.#log(`voice box ${box.name}: recording ended, ${minutes} min, transcribing`);
        try { if (link.socket.readyState === 1) link.play(await this.#speak(`Enregistrement terminé, ${minutes} minute${minutes > 1 ? 's' : ''}. Je transcris, je te dis quand c'est prêt.`)); } catch { /* the light says it */ }
        let pcm;
        try { pcm = readFileSync(r.file); } catch (error) { this.#log(`voice box ${box.name}: the recording cannot be read (${error.message})`); return; }
        const lines = []; let offset = 0; let failed = 0;
        const pieces = piecesOf(pcm, { least: 270, most: 300 });
        for (const [i, piece] of pieces.entries()) {
            try {
                const parts = await this.#parts(wavOf(piece));
                for (const p of parts) lines.push(`[${mmss(offset + p.start)}]${p.speaker === null ? '' : ` Voix ${p.speaker + 1}${pieces.length > 1 ? ` (partie ${i + 1})` : ''}`} : ${p.text}`);
            } catch (error) { failed++; lines.push(`[${mmss(offset)}] (cette partie n'a pas pu être transcrite : ${error.message})`); }
            offset += piece.length / 32_000;
        }
        rmSync(r.file, { force: true });
        const stamp = new Date(r.at).toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const head = `Enregistrement du boîtier ${box.name}${box.place ? ` (${box.place})` : ''}, ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${minutes} min.\nLes voix sont numérotées par partie de 5 minutes : une même personne peut changer de numéro d'une partie à l'autre.\n\n`;
        let path = null;
        try { path = this.#keep?.(box.conversation, `enregistrement-${stamp}.txt`, head + lines.join('\n')) ?? null; } catch (error) { this.#log(`voice box ${box.name}: the transcript cannot be kept (${error.message})`); }
        this.#log(`voice box ${box.name}: recording transcribed (${lines.length} lines${failed ? `, ${failed} part(s) failed` : ''})`);
        const note = path ? `Enregistrement de ${minutes} min terminé et transcrit (qui parle, minute par minute) : ${path}. Fais-en ce que la personne demande ; sinon un compte rendu court : sujets, décisions, choses à faire.` : `Enregistrement de ${minutes} min terminé, mais la transcription n'a pas pu être rangée.`;
        try { await this.#say(box.conversation, note, { id: box.id, name: box.name, ...(box.place ? { place: box.place } : {}) }); } catch (error) { this.#log(`voice box ${box.name}: the recording's line not said (${error.message})`); }
    }

    /* Each step said in the server's log, never what was said: its length only. */
    /* The 1.6 s before the sentence, heard again: is the wake word in it? Its words, and whether it reads as the word. */
    async #checkWake(link, pcm, { score = null, near = false } = {}) {
        if (pcm.length < 8_000) return null;
        const heard = String(await this.#hear(wavOf(pcm), link.box().lang) ?? '').trim();
        const ok = WAKE_HEARD.test(plainWords(heard));
        /* Counted, and kept when the box learns (the clip only: never the sentence), with the box's score. */
        const box = link.box();
        try { this.#learn?.checked(box.id, pcm, ok, { keep: box.wake === 'learn', heard, score, near }); } catch (error) { this.#log(`voice box ${box.name}: wake clip not kept (${error.message})`); }
        return { heard, ok };
    }
    /* A NEAR MISS (wake.near): checked the same way, only when the box learns; one at a time; nothing said. */
    async #checkNear(link, pcm, score) {
        if (link.box().wake !== 'learn' || link.nearBusy) return;
        link.nearBusy = true;
        try { await this.#checkWake(link, pcm, { score, near: true }); } catch { /* not heard: not kept */ } finally { link.nearBusy = false; }
    }
    async #heard(link, pcm) {
        const box0 = link.box();
        const seconds = (pcm.length / 32_000).toFixed(1);
        if (pcm.length < 16_000) { this.#log(`voice box ${box0.name}: ${seconds} s heard, too short for a sentence`); this.#tested(link, 'nothing'); link.send({ t: 'cue', name: 'done' }); return; }   /* under half a second: a press, not a sentence */
        link.send({ t: 'cue', name: 'thinking' });
        /* Its sound, kept beside its conversation (the ten last, a week): its assistant can listen to what the box
           really sent when the dictation goes wrong (02-11: "regarde la qualité de l'audio arrivant"). */
        try { this.#keep?.(box0.conversation, 'phrase-boitier.wav', wavOf(pcm)); } catch { /* its chat may be off */ }
        let text;
        /* A sentence that goes nowhere is said so, in words, rather than with a beep nobody can read (31-10). */
        const lost = async (words) => {
            try { link.play(await this.#speak(words)); } catch { link.send({ t: 'cue', name: 'error' }); }   /* not listened after: a loop of « pardon » on room noise (01-11) */
        };
        try {
            const said = [];
            /* The dictation fails now and then (the network, the engine): tried again by itself, twice, before
               anything is said to the person -- who should not have to repeat (31-10). */
            const hear = async (wav) => {
                for (let attempt = 0; ; attempt++) {
                    try { return await this.#hear(wav, box0.lang); } catch (error) {
                        if (attempt >= 2 || error?.status === 413 || error?.status === 400) throw error;
                        this.#log(`voice box ${box0.name}: dictation failed (${error.message}), tried again`);
                        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
                    }
                }
            };
            /* A part the engine fails on is left out (02-11: « la dictée ne répond pas » said while the rest was
               understood); only when every part fails is it said. */
            let failed = null;
            for (const piece of piecesOf(pcm)) { try { said.push(String(await hear(wavOf(piece)) ?? '').trim()); } catch (error) { failed = error; } }
            if (failed && !said.some(Boolean)) throw failed;
            text = said.filter(Boolean).join(' ');
        } catch (error) { this.#log(`voice box ${box0.name}: ${seconds} s heard, dictation failed (${error.message})`); try { this.#keep?.(box0.conversation, 'dictee-echec.txt', `${new Date(this.#now()).toISOString()} ${seconds} s: ${error.message}\n`); } catch { /* its chat may be off */ } if (this.#tested(link, 'failed', error.message)) { link.send({ t: 'cue', name: 'error' }); return; } await lost('Pardon, la dictée ne répond pas. Tu peux répéter ?'); return; }
        if (link.testing?.state === 'listening' && this.#now() <= link.testing.until) {
            this.#tested(link, text ? 'heard' : 'nothing', text);
            this.#log(`voice box ${box0.name}: microphone test, ${seconds} s heard`);
            link.send({ t: 'cue', name: 'done' });
            return;
        }
        if (!text) { this.#log(`voice box ${box0.name}: ${seconds} s heard, nothing recognised (${soundOf(pcm)})`); await lost("Pardon, je n'ai rien compris. Tu peux répéter ?"); return; }
        const box = link.box();
        /* The wake word heard again (wake.clip): said beside the message; dropped in silence only once that is
           turned on (WAKE_DROP), after its results were looked at -- a real call must never be lost to it. */
        const check = link.wakeCheck ? await link.wakeCheck.catch(() => null) : null; link.wakeCheck = null;
        if (check) {
            /* First in the line: Parley keeps 120 characters of `why`, and the end stats after it can pass that. */
            link.why = `mot ${check.ok ? '\u2713' : '\u2717'} « ${check.heard.slice(0, 30)} »${link.why ? ` · ${link.why}` : ''}`;
            this.#log(`voice box ${box.name}: wake word heard again: ${check.ok ? 'yes' : 'NO'} (« ${check.heard.slice(0, 40)} »)`);
            if (!check.ok && WAKE_DROP) { link.send({ t: 'cue', name: 'done' }); return; }
        }
        /* Only a short order starts a recording ("lance l'enregistrement de la réunion"): a sentence that merely
           mentions recording does not (01-11). */
        if (RECORD_BY_VOICE && RECORD_ASKED.test(text) && text.split(/\s+/).length <= 10 && this.#recordDir && this.#parts) {
            this.#log(`voice box ${box.name}: a recording asked`);
            try { link.play(await this.#speak("J'enregistre. Pour arrêter, appuie sur le bouton ou dis le mot d'éveil.")); } catch { /* no voice: the light says it */ }
            link.send({ t: 'record', on: true });
            return;
        }
        if (link.relay && this.#now() - link.relay < RELAY_WITHIN_MS) {
            link.relay = 0;
            text = `(réponse entendue de l'appareil, pas de la personne) ${text}`;
        }
        try { await this.#say(box.conversation, text, { id: box.id, name: box.name, kind: 'box', ...(box.place ? { place: box.place } : {}), why: `${(link.chat || CHAT_IN.test(text)) && !CHAT_OUT.test(text) ? 'en conversation : réponse courte, parlée · ' : ''}${link.why ? `${link.why} · ` : ''}${soundOf(pcm)}` }); } catch (error) { this.#log(`voice box ${box.name}: ${seconds} s heard and dictated, but not said in ${box.conversation} (${error.message})`); await lost("Pardon, je n'ai pas pu transmettre ta phrase. Tu peux répéter ?"); return; }
        this.#log(`voice box ${box.name}: ${seconds} s heard, said in ${box.conversation}`);
        link.heardAt = this.#now();
        if (WAITING_WORDS) this.#waitFor(link, text);
        link.recent = [...(link.recent ?? []), link.heardAt];
        /* CONVERSATION MODE (03-11, as he set it): in by « on discute » (or « mode conversation »), out by « merci,
           c'est tout » (or « fin de la conversation »), or by nobody speaking after an answer. */
        if (CHAT_IN.test(text) && !link.chat) { link.chat = true; link.send({ t: 'chat', on: true }); }   /* its ring, its chime (0.1.46) */
        if (CHAT_OUT.test(text) && link.chat) { link.chat = false; link.recent = []; link.send({ t: 'chat', on: false }); }
        link.doingSaid = false;
    }

    /* Wires the box link on an HTTP server: the key in Authorization, else 401. */
    attach(server, WebSocketServer) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
        server.on('upgrade', (request, socket, head) => {
            const { pathname } = new URL(request.url ?? '/', 'http://local');
            if (pathname !== LINK_PATH) return;
            const key = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
            const box = this.byKey(key);
            if (!box) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
            wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, box));
        });
        return wss;
    }
}

/* The operator's side, behind the sign-on:
 *   GET  /api/boxes                       the boxes, online or not
 *   POST /api/boxes/code                  {conversation, name?, origin?} -> {code, minutes, key?, link?, qr?}
 *   POST /api/boxes/<id>/rename           {name}
 *   POST /api/boxes/<id>/move             {conversation}: one conversation at a time
 *   POST /api/boxes/<id>/place            {place}: where it is (a home), shown with its name
 *   POST /api/boxes/<id>/zone             {zone}: its time zone (IANA), for its clock; the page gives its own
 *   POST /api/boxes/<id>/test-sound       it says a test sentence
 *   POST /api/boxes/<id>/test-mic         it listens once; what it heard stays here, not in the conversation
 *   POST /api/boxes/<id>/test-result      -> {state: listening|heard|nothing|failed|none, text}
 *   POST /api/boxes/<id>/revoke
 *   POST /api/boxes/<id>/volume           {level 0-100}
 *   POST /api/boxes/<id>/wifi-scan        -> {networks}
 *   POST /api/boxes/<id>/wifi-join        {ssid, password}: the password goes to the box, and is kept nowhere here;
 *                                          the box ADDS it to the networks it knows (8 at most) and goes to the strongest
 *   POST /api/boxes/<id>/wifi-known       -> {networks, current}: the names it knows (never a password)
 *   POST /api/boxes/<id>/wifi-forget      {ssid}: not the one it uses now
 *   POST /api/boxes/<id>/alert            {text?}
 *   POST /api/boxes/<id>/reboot
 *   GET  /api/boxes/<id>/wake            -> {mode, kept, real, false, near, missed, oldest, falsePerDay, missedPerDay,
 *                                          cutoff, wakeModel, tuning: {at, why, state, better, reason, from, to, clips,
 *                                          falsePerDayBefore, falsePerDayAfter, missedBefore, missedAfter} | null,
 *                                          model: {installedAt, falsePerDayBefore, falsePerDayAfter} | null, improveAsked}
 *   POST /api/boxes/<id>/wake-mode       {mode: normal|learn} -> the same
 *   POST /api/boxes/<id>/wake-erase      every clip of the box deleted -> the same
 *   POST /api/boxes/<id>/wake-improve    -> 202 {queued, at, tuning}: the threshold tuned now; nothing better, the
 *                                          trainer asked (queued)
 */
export async function handleBoxes(request, response, boxes, originOk, headers = {}, qr = null) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    const send = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body)); return true; };
    try {
        if (request.method === 'GET' && pathname === '/api/boxes') return send(200, boxes.all());
        const asked = request.method === 'GET' && /^\/api\/boxes\/([0-9a-f-]{36})\/wake$/.exec(pathname);
        if (asked) return send(200, boxes.wakeStats(asked[1]));
        if (request.method !== 'POST') return false;
        if (!originOk(request.headers)) return send(403, { error: 'This request does not come from this site.' });
        let text = '';
        for await (const piece of request) { text += piece; if (text.length > 8192) return send(413, { error: 'Too long.' }); }
        const body = text ? JSON.parse(text) : {};
        if (pathname === '/api/boxes/code') {
            const made = boxes.code(String(body.conversation ?? ''), body.name, body.zone);
            /* With this page's address: the key, and a link (its QR code) that opens the box's page filled in. */
            const origin = /^https?:\/\/[^/\s]+$/.test(String(body.origin ?? '')) ? String(body.origin) : '';
            if (!origin) return send(201, made);
            const key = setupKey(origin, String(body.name ?? '').trim().slice(0, NAME_MAX), made.code);
            const link = `${SETUP_ADDRESS}?k=${key}`;
            return send(201, { ...made, key, link, qr: qr ? await qr(link) : undefined });
        }
        const m = /^\/api\/boxes\/([0-9a-f-]{36})\/([a-z-]+)$/.exec(pathname);
        if (!m) return false;
        const [, id, what] = m;
        const answered = (a) => send(a?.ok === false ? 502 : 200, a?.ok === false ? { error: `The voice box said: ${a.detail ?? 'no'}.` } : { ok: true });
        switch (what) {
        case 'rename': boxes.rename(id, body.name); return send(200, { ok: true });
        case 'move': boxes.move(id, String(body.conversation ?? '')); return send(200, { ok: true });
        case 'place': boxes.place(id, body.place); return send(200, { ok: true });
        case 'zone': boxes.zone(id, body.zone, body.lang); return send(200, { ok: true });
        case 'revoke': boxes.revoke(id); return send(200, { ok: true });
        case 'volume': return answered(await boxes.setVolume(id, body.level));
        case 'wifi-scan': { const r = await boxes.command(id, { t: 'wifi.scan' }); return send(200, { networks: Array.isArray(r.networks) ? r.networks : [] }); }
        case 'wifi-known': { const r = await boxes.command(id, { t: 'wifi.list' }); return send(200, { networks: Array.isArray(r.networks) ? r.networks.map(String) : [], current: String(r.current ?? '') }); }
        case 'wifi-forget': return answered(await boxes.command(id, { t: 'wifi.forget', ssid: String(body.ssid ?? '').slice(0, 32) }));
        case 'wifi-join': return answered(await boxes.command(id, { t: 'wifi.join', ssid: String(body.ssid ?? ''), password: String(body.password ?? '') }, 90_000));
        case 'alert': return answered(await boxes.command(id, { t: 'alert', text: String(body.text ?? '').slice(0, 300) }, 10 * 60_000));
        case 'test-sound': return send(200, await boxes.testSound(id));
        case 'test-mic': return send(200, await boxes.testMic(id));
        case 'test-result': return send(200, boxes.testResult(id));
        case 'reboot': return answered(await boxes.command(id, { t: 'reboot' }));
        case 'wake-mode': return send(200, boxes.wakeMode(id, String(body.mode ?? '')));
        case 'wake-erase': return send(200, boxes.wakeErase(id));
        case 'wake-improve': return send(202, boxes.wakeImprove(id));
        default: return false;
        }
    } catch (error) {
        return send(error.status ?? (error instanceof SyntaxError ? 400 : 500), { error: error instanceof SyntaxError ? 'Not JSON.' : error.message });
    }
}

/* VOICE BOXES AS TETHER TARGETS (kind voicebox): what an assistant may do to the boxes of its
   own conversation -- louder, softer, an alert -- through Tether's rights and journal. One
   target per box, given to its conversation at "free" (nothing in it is risky), taken back when
   the box moves or goes. */
export const targetOf = (box) => `voicebox-${box.id.slice(0, 8)}`;
export function voiceboxConnector(boxes) {
    return {
        async run(verb, t, a = {}) {
            const id = t.config?.box;
            if (verb === 'voicebox.volume') { const r = await boxes.setVolume(id, a.level); return { text: r?.offline ? `Volume ${a.level} kept: the box is offline, it gets it when it comes back.` : `Volume set to ${a.level}.` }; }
            if (verb === 'voicebox.listen') { await boxes.listen(id, String(a.url), String(a.name ?? '')); return { text: `Playing ${a.name || a.url}: it goes on until it ends, voicebox-stop, or the person presses the button or says the wake word.` }; }
            if (verb === 'voicebox.speak') { await boxes.speakTo(id, String(a.text ?? '')); return { text: 'Said aloud; the box listens now: what it hears in the next 20 s comes back in the conversation, marked as the device\'s answer.' }; }
            if (verb === 'voicebox.stop') return { text: boxes.stop(id) ? 'Stopped.' : 'Nothing was playing.' };
            if (verb === 'voicebox.play') { const r = boxes.play(id, Buffer.from(String(a.image ?? ''), 'base64')); return { text: `Played (${r.seconds} s).` }; }
            if (verb === 'voicebox.update') { await boxes.update(id, a.image, a.version); return { text: `Installed${a.version ? ` (${a.version})` : ''}: the box restarts and comes back in a moment.` }; }
            if (verb === 'voicebox.alert') { await boxes.command(id, { t: 'alert', text: String(a.text ?? '').slice(0, 300) }, 10 * 60_000); return { text: 'The alert was seen: someone pressed its button.' }; }
            throw new Error(`${verb} is not for a voice box`);
        },
    };
}
export function syncTargets(store, list) {
    const wanted = new Map(list.map((b) => [targetOf(b), b]));
    for (const t of store.targets()) if (t.kind === 'voicebox' && !wanted.has(t.id)) store.removeTarget(t.id);
    for (const [id, b] of wanted) {
        const before = store.target(id);
        store.putTarget({ id, title: `Voice box ${b.name}${b.place ? ` (${b.place})` : ''}`, kind: 'voicebox', connector: 'voicebox', config: { box: b.id } });
        const agent = `conversation:${b.conversation}`;
        for (const who of Object.keys(store.target(id)?.grants ?? {})) if (who !== agent) store.grant(id, who, null);
        if (!before || !store.target(id)?.grants?.[agent]) store.grant(id, agent, 'free');
    }
}
