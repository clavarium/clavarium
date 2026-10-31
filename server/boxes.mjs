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
 * device door. Nothing is kept of the audio, here or on the box.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Refusal } from './conversations.mjs';

export const CODE_MINUTES = 10;
export const PAIR_PATH = '/c/api/box/pair';
export const LINK_PATH = '/c/api/box/ws';
/* A firmware a box downloads to update itself: a one-use address, kept a few minutes. */
export const FIRMWARE_PATH = '/c/api/box/firmware/';
export const FIRMWARE_MINUTES = 10;
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
export function forSpeech(text) {
    return String(text ?? '')
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
        /* Nor another assistant's call: « OK Google » said in an example woke the Google Home beside it (31-10). */
        .replace(/\b(?:ok|okay|hey|dis)[\s,]+(?:google|siri|alexa)\b/giu, 'l\'appel de l\'enceinte')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
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

export const DOING_WITHIN_MS = 120_000;
/* A LONG RECORDING (a meeting, a class): asked in words, stopped by the button or the wake word. */
export const RECORD_ASKED = /\b(?:lance|d[ée]marre|commence|d[ée]bute)\w*\b.{0,25}\benregistrement\b|\benregistre\b.{0,20}\b(?:r[ée]union|conversation|cours|discussion|consultation)\b/i;
export const RECORD_MAX_BYTES = 4 * 3600 * 32_000;   /* four hours */
export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/* THE MIXER of a box that plays a stream: words said meanwhile go over it, the stream lowered to DUCK while
   they last, with a fade down and up (a quarter of a second) rather than a jump. One 20 ms chunk at a time. */
export const DUCK = 0.2;
export function mix(stream, chunk) {
    const words = stream.over[0];
    const target = words ? DUCK : 1;
    const out = Buffer.alloc(chunk.length);
    const step = (1 - DUCK) / (0.25 * 16_000);
    for (let i = 0; i < chunk.length; i += 2) {
        stream.gain += Math.max(-step, Math.min(step, target - stream.gain));
        let v = chunk.readInt16LE(i) * stream.gain;
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
    #exists; #hear; #say; #speak; #log; #changed; #images = new Map(); #origin; #spawn; #fetch; #streams = new Map(); #recordDir; #parts; #keep;

    /* file: a JsonFile holding [{ id, name, conversation, keyHash, firmware, createdAt, seenAt }].
       exists(conversation), hear(wav) -> text, say(conversation, text, room), speak(text) -> PCM 16 kHz. */
    constructor({ file, exists = () => true, hear, say, speak, changed = () => {}, origin = () => null, now = () => Date.now(), log = () => {}, spawn = spawnProcess, fetcher = fetch, recordDir = null, parts = null, keep = null }) {
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

    /* LISTENING TO THE INTERNET: a radio, a podcast, a music file, a playlist, read by this server (ffmpeg,
       any format it knows) and sent on to the box at the pace it is played, a few seconds ahead -- until it
       ends, stop(), or the person presses the button or says the wake word (the box then starts a sentence). */
    async listen(id, url, name = '') {
        const link = this.#links.get(id);
        if (!link) throw new Refusal(409, 'This voice box is not connected.');
        this.stop(id);
        const source = await this.#resolve(url);
        let child;
        try { child = this.#spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
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
    zone(id, zone) {
        const z = zoneOf(zone);
        if (!z) throw new Refusal(400, 'Not a time zone.');
        this.#change(id, { zone: z });
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
    async agentSaid(conversation, text, to = null, { doing = false, asked = false } = {}) {
        /* What it is doing is written for a screen ("Tâche de fond : bêta 0.2.113…"): read aloud, it was words
           from nowhere (31-10). Aloud, only a short plain one; otherwise a word that it is at work. */
        const plain = forSpeech(text);
        const words = doing && (plain.length > 70 || /[\d:;/()[\]→=_]/.test(plain)) ? 'Je regarde, un instant.' : plain;
        if (!words) return;
        let boxes;
        if (doing) {
            /* "I'm looking in the calendar": once per sentence heard, on the box that heard it, within two minutes. */
            boxes = [...this.#links.values()].filter((l) => l.box().conversation === conversation && l.heardAt && !l.doingSaid && this.#now() - l.heardAt < DOING_WITHIN_MS);
            for (const l of boxes) l.doingSaid = true;
        } else {
            if (!Array.isArray(to) || to.length === 0) return;
            boxes = [...this.#links.values()].filter((l) => l.box().conversation === conversation && to.includes(l.box().id));
        }
        if (boxes.length === 0) return;
        /* A question: the box listens again right after, no wake word needed. So does a box in CONVERSATION:
           asked for ("mode conversation"), or by itself after two sentences within three minutes (31-10);
           it ends when nobody answers, or on "fin de la conversation". */
        const question = !doing && (asked || /\?\s*$/.test(words));
        for (const l of boxes) {
            /* An answer -- to a sentence heard within a minute -- may open the conversation; something said
               of itself (a news item, a reminder) does not: the box listened after it for nothing (31-10). */
            const answering = l.heardAt && this.#now() - l.heardAt < ANSWER_WITHIN_MS;
            const chatting = !doing && answering && this.#chatting(l);
            const opening = chatting && !l.chat;
            if (chatting) l.chat = true;
            let pcm;
            try { pcm = await this.#speak(opening ? `Je passe en mode conversation : je reste à l'écoute. ${words}` : words); } catch (error) { this.#log(`voice box: no voice for the answer (${error.message})`); l.send({ t: 'cue', name: 'error' }); continue; }
            l.play(pcm, question || chatting ? 'listen' : null);   /* a question is always listened after: an answer is expected */
        }
    }
    #chatting(link) {
        if (link.chat) return true;
        const now = this.#now();
        link.recent = (link.recent ?? []).filter((t) => now - t < CHAT_WITHIN_MS);
        return link.recent.length >= 2;
    }

    /* A box connected with its key: speaks protocol v1 on `socket` (a ws WebSocket). */
    accept(socket, box) {
        this.#links.get(box.id)?.socket.close(4000, 'replaced');
        const send = (o) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
        const link = {
            socket, send, waiting: new Map(), heardAt: 0, muted: null, volume: null,
            box: () => this.#all().find((b) => b.id === box.id) ?? box,
            play: (pcm, then = null) => {
                pcm = pcm.subarray(0, pcm.length & ~1);   /* whole samples only: an odd byte shifts every sample after it */
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
            if (m.t === 'listen.start') { if (this.stop(box.id)) this.#log(`voice box ${box.name}: stopped playing, someone speaks`); sentence = []; size = 0; return; }
            if (m.t === 'listen.end' && sentence && m.reason === 'nobody') {
                /* Listened again, nobody spoke: a conversation ends there, in silence. */
                sentence = null;
                if (link.chat) this.#log(`voice box ${box.name}: conversation ended, nobody answered`);
                link.chat = false; link.recent = [];
                link.send({ t: 'cue', name: 'done' });
                return;
            }
            if (m.t === 'listen.end' && sentence) {
                const pcm = Buffer.concat(sentence);
                sentence = null;
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
    async #heard(link, pcm) {
        const box0 = link.box();
        const seconds = (pcm.length / 32_000).toFixed(1);
        if (pcm.length < 16_000) { this.#log(`voice box ${box0.name}: ${seconds} s heard, too short for a sentence`); link.send({ t: 'cue', name: 'done' }); return; }   /* under half a second: a press, not a sentence */
        link.send({ t: 'cue', name: 'thinking' });
        let text;
        /* A sentence that goes nowhere is said so, in words, rather than with a beep nobody can read (31-10). */
        const lost = async (words) => {
            try { link.play(await this.#speak(words), 'listen'); } catch { link.send({ t: 'cue', name: 'error' }); }
        };
        try {
            const said = [];
            /* The dictation fails now and then (the network, the engine): tried again by itself, twice, before
               anything is said to the person -- who should not have to repeat (31-10). */
            const hear = async (wav) => {
                for (let attempt = 0; ; attempt++) {
                    try { return await this.#hear(wav); } catch (error) {
                        if (attempt >= 2 || error?.status === 413 || error?.status === 400) throw error;
                        this.#log(`voice box ${box0.name}: dictation failed (${error.message}), tried again`);
                        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
                    }
                }
            };
            for (const piece of piecesOf(pcm)) said.push(String(await hear(wavOf(piece)) ?? '').trim());
            text = said.filter(Boolean).join(' ');
        } catch (error) { this.#log(`voice box ${box0.name}: ${seconds} s heard, dictation failed (${error.message})`); await lost('Pardon, la dictée ne répond pas. Tu peux répéter ?'); return; }
        if (!text) { this.#log(`voice box ${box0.name}: ${seconds} s heard, nothing recognised (silence?)`); await lost("Pardon, je n'ai rien compris. Tu peux répéter ?"); return; }
        const box = link.box();
        if (RECORD_ASKED.test(text) && this.#recordDir && this.#parts) {
            this.#log(`voice box ${box.name}: a recording asked`);
            try { link.play(await this.#speak("J'enregistre. Pour arrêter, appuie sur le bouton ou dis le mot d'éveil.")); } catch { /* no voice: the light says it */ }
            link.send({ t: 'record', on: true });
            return;
        }
        try { await this.#say(box.conversation, text, { id: box.id, name: box.name, ...(box.place ? { place: box.place } : {}) }); } catch (error) { this.#log(`voice box ${box.name}: ${seconds} s heard and dictated, but not said in ${box.conversation} (${error.message})`); await lost("Pardon, je n'ai pas pu transmettre ta phrase. Tu peux répéter ?"); return; }
        this.#log(`voice box ${box.name}: ${seconds} s heard, said in ${box.conversation}`);
        link.heardAt = this.#now();
        link.recent = [...(link.recent ?? []), link.heardAt];
        if (/\bmode conversation\b/i.test(text)) link.chat = true;
        if (/\b(?:fin|arr[eê]te|stop)\w*\b.{0,20}\b(?:conversation|[ée]couter)\b/i.test(text)) { link.chat = false; link.recent = []; }
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
 *   POST /api/boxes/<id>/revoke
 *   POST /api/boxes/<id>/volume           {level 0-100}
 *   POST /api/boxes/<id>/wifi-scan        -> {networks}
 *   POST /api/boxes/<id>/wifi-join        {ssid, password}: the password goes to the box, and is kept nowhere here
 *   POST /api/boxes/<id>/alert            {text?}
 *   POST /api/boxes/<id>/reboot
 */
export async function handleBoxes(request, response, boxes, originOk, headers = {}, qr = null) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    const send = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body)); return true; };
    try {
        if (request.method === 'GET' && pathname === '/api/boxes') return send(200, boxes.all());
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
        case 'zone': boxes.zone(id, body.zone); return send(200, { ok: true });
        case 'revoke': boxes.revoke(id); return send(200, { ok: true });
        case 'volume': return answered(await boxes.setVolume(id, body.level));
        case 'wifi-scan': { const r = await boxes.command(id, { t: 'wifi.scan' }); return send(200, { networks: Array.isArray(r.networks) ? r.networks : [] }); }
        case 'wifi-join': return answered(await boxes.command(id, { t: 'wifi.join', ssid: String(body.ssid ?? ''), password: String(body.password ?? '') }, 90_000));
        case 'alert': return answered(await boxes.command(id, { t: 'alert', text: String(body.text ?? '').slice(0, 300) }, 10 * 60_000));
        case 'reboot': return answered(await boxes.command(id, { t: 'reboot' }));
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
