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
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Refusal } from './conversations.mjs';

export const CODE_MINUTES = 10;
export const PAIR_PATH = '/c/api/box/pair';
export const LINK_PATH = '/c/api/box/ws';
export const SENTENCE_MAX = 15 * 32_000 + 32_000;      /* 15 s of 16 kHz 16-bit mono, and some slack */
export const ANSWER_MINUTES = 5;                        /* after a sentence, what the tool says is spoken */
export const TRIES_PER_MINUTE = 10;
export const NAME_MAX = 40;
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

/* Text for the ear: what a written message holds and a voice should not read. */
export function forSpeech(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_#>|~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1500);
}

export class Boxes {
    #file; #codes = new Map(); #links = new Map(); #tries = []; #now;
    #exists; #hear; #say; #speak; #log; #changed;

    /* file: a JsonFile holding [{ id, name, conversation, keyHash, firmware, createdAt, seenAt }].
       exists(conversation), hear(wav) -> text, say(conversation, text, room), speak(text) -> PCM 16 kHz. */
    constructor({ file, exists = () => true, hear, say, speak, changed = () => {}, now = () => Date.now(), log = () => {} }) {
        this.#file = file; this.#changed = changed; this.#exists = exists; this.#hear = hear; this.#say = say; this.#speak = speak; this.#now = now; this.#log = log;
    }

    #all() { const v = this.#file.get(); return Array.isArray(v) ? v : []; }
    #save(list) { this.#file.set(list); try { this.#changed(); } catch { /* the caller's */ } }

    /* The boxes of one conversation, as its thread names them: { id, name, place }. */
    speakersOf(conversation) { return this.#all().filter((b) => b.conversation === conversation).map((b) => ({ id: b.id, name: b.name, ...(b.place ? { place: b.place } : {}) })); }

    /* What the operator sees: never the key, nor its hash. */
    all() {
        return this.#all().map(({ keyHash, ...b }) => ({ ...b, online: this.#links.has(b.id), muted: this.#links.get(b.id)?.muted ?? null, volume: this.#links.get(b.id)?.volume ?? null }));
    }

    code(conversation, name) {
        if (!this.#exists(conversation)) throw new Refusal(404, 'No such conversation.');
        const code = newCode();
        const label = String(name ?? '').trim().slice(0, NAME_MAX);
        this.#codes.set(plainCode(code), { conversation, name: label, until: this.#now() + CODE_MINUTES * 60_000 });
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

    /* Where it is (a home, a family house): grouped by it, named with it. */
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

    /* The tool said or asked something in a conversation. Addressed (`to`: box ids, #215): said by
       those boxes of this conversation. Not addressed: said by its boxes that were just talked to. */
    async agentSaid(conversation, text, to = null) {
        const words = forSpeech(text);
        if (!words) return;
        const now = this.#now();
        const mine = [...this.#links.values()].filter((l) => l.box().conversation === conversation);
        const boxes = Array.isArray(to) && to.length ? mine.filter((l) => to.includes(l.box().id)) : mine.filter((l) => l.heardAt > now - ANSWER_MINUTES * 60_000);
        if (boxes.length === 0) return;
        let pcm;
        try { pcm = await this.#speak(words); } catch (error) { this.#log(`voice box: no voice for the answer (${error.message})`); for (const l of boxes) l.send({ t: 'cue', name: 'error' }); return; }
        for (const l of boxes) l.play(pcm);
    }

    /* A box connected with its key: speaks protocol v1 on `socket` (a ws WebSocket). */
    accept(socket, box) {
        this.#links.get(box.id)?.socket.close(4000, 'replaced');
        const send = (o) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
        const link = {
            socket, send, waiting: new Map(), heardAt: 0, muted: null, volume: null,
            box: () => this.#all().find((b) => b.id === box.id) ?? box,
            play: (pcm) => {
                send({ t: 'speak.start', rate: 16_000 });
                for (let at = 0; at < pcm.length; at += 640) if (socket.readyState === 1) socket.send(pcm.subarray(at, at + 640));
                send({ t: 'speak.end' });
            },
        };
        this.#links.set(box.id, link);
        let sentence = null; let size = 0;
        const seen = () => { try { this.#change(box.id, { seenAt: new Date(this.#now()).toISOString() }); } catch { /* withdrawn meanwhile */ } };
        seen();
        socket.on('message', (data, binary) => {
            if (binary) {
                if (!sentence || link.muted) return;
                size += data.length;
                if (size <= SENTENCE_MAX) sentence.push(Buffer.from(data));
                return;
            }
            let m;
            try { m = JSON.parse(String(data)); } catch { return; }
            if (!m || typeof m !== 'object') return;
            if (m.t === 'ping') { send({ t: 'pong' }); return; }
            if (m.t === 'hello') { link.muted = m.muted === true; link.volume = Number.isFinite(m.volume) ? m.volume : null; this.#change(box.id, { firmware: String(m.firmware ?? '').slice(0, 20) }); seen(); return; }
            if (m.t === 'listen.start') { sentence = []; size = 0; return; }
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
        socket.on('close', () => { if (this.#links.get(box.id) === link) this.#links.delete(box.id); });
        socket.on('error', () => {});
    }

    async #heard(link, pcm) {
        if (pcm.length < 16_000) { link.send({ t: 'cue', name: 'done' }); return; }   /* under half a second: a press, not a sentence */
        link.send({ t: 'cue', name: 'thinking' });
        let text;
        try { text = String(await this.#hear(wavOf(pcm)) ?? '').trim(); } catch (error) { this.#log(`voice box: dictation failed (${error.message})`); link.send({ t: 'cue', name: 'error' }); return; }
        if (!text) { link.send({ t: 'cue', name: 'error' }); return; }
        const box = link.box();
        try { await this.#say(box.conversation, text, { id: box.id, name: box.name, ...(box.place ? { place: box.place } : {}) }); } catch (error) { this.#log(`voice box: not said in ${box.conversation} (${error.message})`); link.send({ t: 'cue', name: 'error' }); return; }
        link.heardAt = this.#now();
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
            const made = boxes.code(String(body.conversation ?? ''), body.name);
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
        case 'revoke': boxes.revoke(id); return send(200, { ok: true });
        case 'volume': return answered(await boxes.command(id, { t: 'volume', level: Math.round(Number(body.level)) }));
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
