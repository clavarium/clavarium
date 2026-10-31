import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Boxes, forSpeech, wavOf, newCode, handleBoxes } from '../server/boxes.mjs';
import { toPcm16k } from '../server/speech.mjs';

class MemoryFile { #v; constructor(v) { this.#v = v; } get() { return structuredClone(this.#v); } set(v) { this.#v = structuredClone(v); } }

/* A ws WebSocket, as far as a box link uses it. */
class FakeSocket extends EventEmitter {
    readyState = 1; sent = []; closed = null;
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : { bytes: data.length }); }
    close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
    box(o) { this.emit('message', Buffer.from(JSON.stringify(o)), false); }
}

const make = (over = {}) => {
    const said = [];
    const boxes = new Boxes({
        file: new MemoryFile([]), exists: (c) => c === 'kitchen-help',
        hear: async (wav) => { assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); return 'allume la lumière'; },
        say: async (c, text, by) => { said.push({ c, text, room: by.name }); },
        speak: async (text) => Buffer.alloc(1600, 1),
        ...over,
    });
    return { boxes, said };
};
const tick = () => new Promise((r) => setImmediate(r));

test('a code pairs one box, once; the key is given once and only its hash kept', () => {
    const { boxes } = make();
    assert.throws(() => boxes.code('nowhere'), { status: 404 });
    const { code, minutes } = boxes.code('kitchen-help', 'Salon');
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(minutes, 10);
    assert.throws(() => boxes.pair({ code: 'AAAA-AAAA' }), { status: 403 });
    const box = boxes.pair({ code: code.toLowerCase().replace('-', ''), room: 'ignored', type: 'voice-box/1', firmware: '0.1.0' });
    assert.equal(box.name, 'Salon');
    assert.equal(box.key.length, 43);
    assert.throws(() => boxes.pair({ code }), { status: 403 });
    assert.equal(boxes.byKey(box.key).id, box.id);
    assert.equal(boxes.byKey('nope'), undefined);
    const listed = boxes.all();
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(box.key), false);
    assert.equal('keyHash' in listed[0], false);
});

test('pairing tries are bounded', () => {
    const { boxes } = make();
    for (let i = 0; i < 10; i++) assert.throws(() => boxes.pair({ code: 'AAAA-AAAA' }), { status: 403 });
    assert.throws(() => boxes.pair({ code: 'AAAA-AAAA' }), { status: 429 });
});

test('a sentence is heard, said in the conversation with the room, and the answer is spoken back', async () => {
    const { boxes, said } = make();
    const box = boxes.pair({ code: boxes.code('kitchen-help', 'Salon').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'hello', firmware: '0.1.0', volume: 60, muted: false });
    assert.equal(boxes.all()[0].online, true);
    s.box({ t: 'ping' });
    assert.deepEqual(s.sent.at(-1), { t: 'pong' });
    s.box({ t: 'listen.start', reason: 'button' });
    for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640), true);
    s.box({ t: 'listen.end', reason: 'silence' });
    await tick(); await tick();
    assert.deepEqual(s.sent.at(-1), { t: 'cue', name: 'thinking' });
    assert.deepEqual(said, [{ c: 'kitchen-help', text: 'allume la lumière', room: 'Salon' }]);

    await boxes.agentSaid('other-conversation', 'Not for this box.');
    assert.equal(s.sent.filter((m) => m.t === 'speak.start').length, 0);
    await boxes.agentSaid('kitchen-help', 'Not addressed: stays silent.');
    assert.equal(s.sent.filter((m) => m.t === 'speak.start').length, 0);
    await boxes.agentSaid('kitchen-help', 'C\'est **fait** : voir https://example.com', [box.id]);
    const start = s.sent.findIndex((m) => m.t === 'speak.start');
    assert.ok(start > 0);
    assert.deepEqual(s.sent.slice(start + 1, start + 4), [{ bytes: 640 }, { bytes: 640 }, { bytes: 320 }]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' });

    /* What it is doing: said once, by the box just spoken to; a question: the box listens again after. */
    const starts = () => s.sent.filter((m) => m.t === 'speak.start').length;
    await boxes.agentSaid('kitchen-help', 'Je regarde dans le calendrier.', null, { doing: true });
    assert.equal(starts(), 2);
    await boxes.agentSaid('kitchen-help', 'Encore un instant.', null, { doing: true });
    assert.equal(starts(), 2);
    await boxes.agentSaid('kitchen-help', 'À quelle heure ?', [box.id]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end', then: 'listen' });
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end', then: 'listen' });
});

test('a box not addressed stays quiet; a press too short is not a sentence', async () => {
    const { boxes, said } = make();
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    await boxes.agentSaid('kitchen-help', 'Hello');
    assert.equal(s.sent.length, 0);
    s.box({ t: 'listen.start', reason: 'button' });
    s.emit('message', Buffer.alloc(640), true);
    s.box({ t: 'listen.end', reason: 'button' });
    await tick();
    assert.deepEqual(s.sent, [{ t: 'cue', name: 'done' }]);
    assert.equal(said.length, 0);
});

test('a dictation that fails is said to the box in words, and it listens again; without a voice, a beep', async () => {
    const { boxes } = make({ hear: async () => { throw new Error('engine down'); } });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'listen.start' });
    for (let i = 0; i < 30; i++) s.emit('message', Buffer.alloc(640), true);
    s.box({ t: 'listen.end' });
    for (let i = 0; i < 60 && !s.sent.some((m) => m.t === 'speak.end'); i++) await new Promise((r) => setTimeout(r, 100));   /* tried twice more first */
    assert.ok(s.sent.some((m) => m.t === 'speak.start'));
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end', then: 'listen' });

    const mute = make({ hear: async () => { throw new Error('engine down'); }, speak: async () => { throw new Error('no voice'); } });
    const b2 = mute.boxes.pair({ code: mute.boxes.code('kitchen-help').code });
    const s2 = new FakeSocket();
    mute.boxes.accept(s2, mute.boxes.byKey(b2.key));
    s2.box({ t: 'listen.start' });
    for (let i = 0; i < 30; i++) s2.emit('message', Buffer.alloc(640), true);
    s2.box({ t: 'listen.end' });
    for (let i = 0; i < 60 && !s2.sent.some((m) => m.t === 'cue' && m.name === 'error'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(s2.sent.at(-1), { t: 'cue', name: 'error' });
});

test('commands get their answer; a withdrawn box is closed and its key opens nothing', async () => {
    const { boxes } = make();
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    const asked = boxes.command(box.id, { t: 'volume', level: 30 });
    const sent = s.sent.at(-1);
    assert.equal(sent.t, 'volume');
    s.box({ t: 'ack', id: sent.id, ok: true });
    assert.equal((await asked).ok, true);
    boxes.revoke(box.id);
    assert.equal(s.closed, 4001);
    assert.equal(boxes.byKey(box.key), undefined);
    await assert.rejects(boxes.command(box.id, { t: 'reboot' }), { status: 409 });
});

test('the operator side refuses a request from elsewhere and gives codes', async () => {
    const { boxes } = make();
    const call = async (method, url, body, ok = true) => {
        const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
        let status; let out = '';
        const response = { writeHead(s) { status = s; return this; }, end(b) { out = b; } };
        await handleBoxes(request, response, boxes, () => ok);
        return { status, body: JSON.parse(out) };
    };
    assert.equal((await call('POST', '/api/boxes/code', { conversation: 'kitchen-help' }, false)).status, 403);
    const made = await call('POST', '/api/boxes/code', { conversation: 'kitchen-help', name: 'Bureau' });
    assert.equal(made.status, 201);
    boxes.pair({ code: made.body.code });
    const list = await call('GET', '/api/boxes');
    assert.equal(list.body[0].name, 'Bureau');
    assert.equal(list.body[0].online, false);
});

test('text for the ear, audio for the box', () => {
    assert.equal(forSpeech('**Bien** : voir `ls` et [la page](https://example.com/x) ```code```'), 'Bien : voir ls et la page');
    assert.equal(wavOf(Buffer.alloc(10)).length, 54);
    assert.notEqual(newCode(), newCode());
    const pcm = toPcm16k(new Float32Array(22050).fill(0.5), 22050);
    assert.equal(pcm.length, 32000);
    assert.equal(pcm.readInt16LE(100), 16384);
});


test('a code asked from the page comes with the setup key and a link that opens the box\'s page filled in', async () => {
    const { setupKey, SETUP_ADDRESS } = await import('../server/boxes.mjs');
    const { boxes } = make();
    let out; let status;
    const request = Object.assign(Readable.from([JSON.stringify({ conversation: 'kitchen-help', name: 'Salon', origin: 'https://clavarium.example.org' })]), { method: 'POST', url: '/api/boxes/code', headers: {} });
    await handleBoxes(request, { writeHead(s) { status = s; return this; }, end(b) { out = JSON.parse(b); } }, boxes, () => true, {}, async (text) => `<svg>${text.length}</svg>`);
    assert.equal(status, 201);
    assert.equal(out.key, setupKey('https://clavarium.example.org', 'Salon', out.code));
    assert.deepEqual(JSON.parse(Buffer.from(out.key.slice('GAMBELI-'.length), 'base64url').toString()), { u: 'https://clavarium.example.org', r: 'Salon', c: out.code });
    assert.equal(out.link, `${SETUP_ADDRESS}?k=${out.key}`);
    assert.match(out.qr, /^<svg>/);
    assert.equal(boxes.pair({ code: out.code }).name, 'Salon');
});

test('addressed by its id, a box says the answer; boxes are named with their place, and the thread is told', async () => {
    let told = 0;
    const { boxes } = make({ changed: () => { told++; } });
    const a = boxes.pair({ code: boxes.code('kitchen-help', 'Kitchen').code });
    const b = boxes.pair({ code: boxes.code('kitchen-help', 'Garden').code });
    assert.ok(told >= 2);
    boxes.place(a.id, 'Lake house');
    assert.deepEqual(boxes.speakersOf('kitchen-help'), [{ id: a.id, name: 'Kitchen', place: 'Lake house' }, { id: b.id, name: 'Garden' }]);
    const sa = new FakeSocket(); const sb = new FakeSocket();
    boxes.accept(sa, boxes.byKey(a.key)); boxes.accept(sb, boxes.byKey(b.key));
    await boxes.agentSaid('kitchen-help', 'Dinner is ready.', [b.id]);
    assert.equal(sa.sent.filter((m) => m.t === 'speak.start').length, 0, 'not addressed: silent');
    assert.equal(sb.sent.filter((m) => m.t === 'speak.start').length, 1);
});

test('the volume is kept and given to the box; each box is a Tether target of its own conversation', async () => {
    const { syncTargets, targetOf, voiceboxConnector, VOLUME_DEFAULT } = await import('../server/boxes.mjs');
    const { boxes } = make();
    const a = boxes.pair({ code: boxes.code('kitchen-help', 'Kitchen').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(a.key));
    s.box({ t: 'hello', volume: 60, muted: false });
    assert.equal(s.sent.find((m) => m.t === 'volume').level, VOLUME_DEFAULT, 'given the default at once');
    const setting = boxes.setVolume(a.id, 95);
    const asked = s.sent.at(-1); assert.equal(asked.level, 95);
    s.box({ t: 'ack', id: asked.id, ok: true });
    await setting;
    assert.equal(boxes.all()[0].volume, 95);
    await assert.rejects(boxes.setVolume(a.id, 140), { status: 400 });

    const targets = new Map();
    const store = { targets: () => [...targets.values()], target: (id) => targets.get(id), putTarget: (t) => targets.set(t.id, { grants: targets.get(t.id)?.grants ?? {}, ...t }), removeTarget: (id) => targets.delete(id), grant: (id, who, level) => { const t = targets.get(id); if (level === null) delete t.grants[who]; else t.grants[who] = { level }; } };
    syncTargets(store, boxes.all());
    const t = store.target(targetOf(boxes.all()[0]));
    assert.equal(t.kind, 'voicebox');
    assert.deepEqual(t.grants, { 'conversation:kitchen-help': { level: 'free' } });
    const run = voiceboxConnector(boxes).run('voicebox.volume', t, { level: 70 });
    const v = s.sent.at(-1); s.box({ t: 'ack', id: v.id, ok: true });
    assert.match((await run).text, /Volume set to 70/);
    syncTargets(store, []);
    assert.equal(store.targets().length, 0, 'a box gone: its target too');
});

test('updated over its Wi-Fi: a one-use address for the image, its sha256, the box answers once installed', async () => {
    const { createHash } = await import('node:crypto');
    const { FIRMWARE_PATH } = await import('../server/boxes.mjs');
    const { boxes } = make({ origin: () => 'https://clavarium.example.org' });
    const a = boxes.pair({ code: boxes.code('kitchen-help', 'Kitchen').code });
    await assert.rejects(boxes.update(a.id, Buffer.alloc(2048, 0xe9)), { status: 409 }, 'offline: not now');
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(a.key));
    await assert.rejects(boxes.update(a.id, Buffer.alloc(2048, 0x00)), { status: 400 }, 'not a program image');
    const image = Buffer.alloc(4096, 7); image[0] = 0xe9;
    const going = boxes.update(a.id, image.toString('base64'), '0.1.4');
    const ota = s.sent.at(-1);
    assert.equal(ota.t, 'ota');
    assert.equal(ota.sha256, createHash('sha256').update(image).digest('hex'));
    const prefix = `https://clavarium.example.org${FIRMWARE_PATH}`;
    assert.ok(ota.url.startsWith(prefix));
    const token = ota.url.slice(prefix.length);
    assert.deepEqual(boxes.image(token), image, 'served while it updates');
    s.box({ t: 'ack', id: ota.id, ok: true });
    assert.deepEqual(await going, { ok: true });
    assert.equal(boxes.image(token), undefined, 'one use');
});

test('a .wav played on a box: mixed to mono, brought to 16 kHz', async () => {
    const { pcmOfWav } = await import('../server/boxes.mjs');
    const frames = 22_050; const stereo = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) { stereo.writeInt16LE(1000, i * 4); stereo.writeInt16LE(3000, i * 4 + 2); }
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + stereo.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(22_050, 24); h.writeUInt32LE(22_050 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(stereo.length, 40);
    const pcm = pcmOfWav(Buffer.concat([h, stereo]));
    assert.equal(pcm.length, 32_000, 'one second at 16 kHz');
    assert.equal(pcm.readInt16LE(200), 2000, 'the two channels mixed');
    assert.throws(() => pcmOfWav(Buffer.from('not a wav at all, no')), { status: 400 });
    const { boxes } = make();
    const a = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket(); boxes.accept(s, boxes.byKey(a.key));
    assert.deepEqual(boxes.play(a.id, Buffer.concat([h, stereo])), { seconds: 1 });
    assert.equal(s.sent.filter((m) => m.t === 'speak.start').length, 1);
});

test('with an ElevenLabs key among the secrets, the boxes speak with its voice', async () => {
    const { Speech, ELEVEN_SECRET, ELEVEN_VOICE } = await import('../server/speech.mjs');
    let asked;
    const speech = new Speech({ dir: '/nonexistent', secret: (name) => (name === ELEVEN_SECRET ? 'k-test' : undefined),
        fetcher: async (url, init) => { asked = { url, init }; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }; } });
    const pcm = await speech.speak('Bonjour');
    assert.deepEqual([...pcm], [1, 2, 3, 4]);
    assert.match(asked.url, new RegExp(`${ELEVEN_VOICE}\\?output_format=pcm_16000`));
    assert.equal(asked.init.headers['xi-api-key'], 'k-test');
    assert.equal(JSON.parse(asked.init.body).text, 'Bonjour');
});

test('a long sentence is dictated in pieces of 14 s at most, cut at its quietest moment', async () => {
    const { piecesOf } = await import('../server/boxes.mjs');
    const pcm = Buffer.alloc(32_000 * 40);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(3000 * Math.sin(i / 7), i);
    pcm.fill(0, 32_000 * 11, 32_000 * 11 + 3200);   /* a pause at 11 s */
    const pieces = piecesOf(pcm);
    assert.ok(pieces.length >= 3);
    assert.ok(pieces.every((p) => p.length <= 32_000 * 14));
    assert.equal(pieces.reduce((n, p) => n + p.length, 0), pcm.length);
    assert.ok(Math.abs(pieces[0].length - (32_000 * 11 + 1600)) <= 1600, 'cut in the pause');
    assert.equal(piecesOf(Buffer.alloc(32_000 * 5)).length, 1);
});

test('an internet sound plays on a box at its pace, a few seconds ahead, until someone speaks', async () => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const { LISTEN_AHEAD } = await import('../server/boxes.mjs');
    let clock = 1_000_000; const spawned = [];
    const spawn = (cmd, args) => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => { c.killed = true; }; spawned.push({ cmd, args, c }); return c; };
    const fetcher = async () => ({ text: async () => '[playlist]\nFile1=https://radio.example.org/live.mp3\n' });
    const { boxes } = make({ spawn, fetcher, now: () => clock });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    await boxes.listen(box.id, 'https://radio.example.org/station.pls', 'Radio');
    assert.equal(spawned[0].cmd, 'ffmpeg');
    assert.ok(spawned[0].args.includes('https://radio.example.org/live.mp3'), 'the playlist read: its first address');
    assert.deepEqual(s.sent.at(-1), { t: 'speak.start', rate: 16_000 });
    spawned[0].c.stdout.write(Buffer.alloc(32_000 * 20));
    await new Promise((r) => setTimeout(r, 250));
    const bytes = () => s.sent.filter((m) => m.bytes).reduce((n, m) => n + m.bytes, 0);
    assert.ok(bytes() >= LISTEN_AHEAD - 640 && bytes() <= LISTEN_AHEAD + 640, `a few seconds ahead, not all at once (${bytes()})`);
    clock += 2000;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(bytes() >= LISTEN_AHEAD + 2 * 32_000 - 640, 'then at its pace');
    s.box({ t: 'listen.start', reason: 'wake' });
    assert.equal(spawned[0].c.killed, true, 'someone speaks: it stops');
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' });
    assert.equal(boxes.stop(box.id), false);
});

test('conversation: after two sentences within three minutes the box stays listening, until nobody answers', async () => {
    const spoken = [];
    const { boxes } = make({ speak: async (t) => { spoken.push(t); return Buffer.alloc(1600, 1); } });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    const sentence = async () => { s.box({ t: 'listen.start', reason: 'wake' }); for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640), true); s.box({ t: 'listen.end', reason: 'silence' }); await tick(); await tick(); };
    await sentence();
    await boxes.agentSaid('kitchen-help', 'Il fait beau.', [box.id]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' }, 'one sentence: no conversation yet');
    await sentence();
    await boxes.agentSaid('kitchen-help', 'Vingt degrés.', [box.id]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end', then: 'listen' });
    assert.match(spoken.at(-1), /^Je passe en mode conversation/);
    await boxes.agentSaid('kitchen-help', 'Et du soleil.', [box.id]);
    assert.equal(spoken.at(-1), 'Et du soleil.', 'said once');
    s.box({ t: 'listen.start', reason: 'follow' }); s.box({ t: 'listen.end', reason: 'nobody' }); await tick();
    assert.deepEqual(s.sent.at(-1), { t: 'cue', name: 'done' });
    await boxes.agentSaid('kitchen-help', 'Bonne soirée.', [box.id]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' }, 'nobody answered: the conversation is over');
});

test('what it is doing, written for a screen, is not read aloud: a short word instead', async () => {
    const spoken = [];
    const { boxes } = make({ speak: async (t) => { spoken.push(t); return Buffer.alloc(1600, 1); } });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'listen.start', reason: 'wake' }); for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640), true); s.box({ t: 'listen.end', reason: 'silence' }); await tick(); await tick();
    await boxes.agentSaid('kitchen-help', 'Tâche de fond : bêta 0.2.113 après publication (test-c)', null, { doing: true });
    assert.equal(spoken.at(-1), 'Je regarde, un instant.');
});

test('a long recording: asked in words, written to disk, transcribed in parts with who speaks, kept and said in a line', async (t) => {
    const { mkdtempSync, rmSync: rm, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/rec-`); t.after(() => rm(dir, { recursive: true, force: true }));
    const kept = []; const partsAsked = [];
    const { boxes, said } = make({
        hear: async () => 'Lance l\'enregistrement de la réunion',
        recordDir: dir,
        parts: async (wav) => { partsAsked.push(wav.length); return [{ speaker: 0, start: 1, text: 'Bonjour à tous.' }, { speaker: 1, start: 4, text: 'On commence.' }]; },
        keep: (c, file, text) => { kept.push({ c, file, text }); return `/work/.parley/files/x/${file}`; },
    });
    const box = boxes.pair({ code: boxes.code('kitchen-help', 'Salon').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'listen.start', reason: 'wake' }); for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640), true); s.box({ t: 'listen.end', reason: 'silence' });
    await tick(); await tick(); await tick();
    assert.deepEqual(s.sent.at(-1), { t: 'record', on: true });
    assert.equal(said.length, 0, 'the order is not said in the thread');
    s.box({ t: 'record.start' });
    for (let i = 0; i < 100; i++) s.emit('message', Buffer.alloc(640, 1), true);
    s.box({ t: 'record.end' });
    for (let i = 0; i < 20 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(partsAsked.length, 1);
    assert.match(kept[0].text, /\[00:01\] Voix 1 : Bonjour à tous\.\n\[00:04\] Voix 2 : On commence\./);
    assert.match(said[0].text, /^Enregistrement de 0 min terminé et transcrit .*enregistrement-\d+\.txt/);
    assert.deepEqual(readdirSync(dir), [], 'the sound is not kept');
});

test('the mixer: words over a stream, the stream lowered with a fade, then back', async () => {
    const { mix, DUCK } = await import('../server/boxes.mjs');
    const radio = Buffer.alloc(640); for (let i = 0; i < 640; i += 2) radio.writeInt16LE(10_000, i);
    const words = Buffer.alloc(640 * 30); for (let i = 0; i < words.length; i += 2) words.writeInt16LE(1000, i);
    const stream = { over: [words], gain: 1 };
    const first = mix(stream, radio);
    assert.ok(first.readInt16LE(0) > 9_000, 'no jump: it fades');
    let out; for (let i = 0; i < 20; i++) out = mix(stream, radio);
    assert.equal(out.readInt16LE(0), Math.round(10_000 * DUCK) + 1000, 'lowered, the words over it');
    for (let i = 0; i < 60; i++) out = mix(stream, radio);
    assert.equal(stream.over.length, 0);
    assert.equal(out.readInt16LE(638), 10_000, 'back to full');
});

test('something said of itself, long after the last sentence, does not open a conversation', async () => {
    let clock = 1_000_000;
    const { boxes } = make({ now: () => clock });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    const sentence = async () => { s.box({ t: 'listen.start', reason: 'wake' }); for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640), true); s.box({ t: 'listen.end', reason: 'silence' }); await tick(); await tick(); };
    await sentence(); await sentence();
    clock += 5 * 60_000;
    await boxes.agentSaid('kitchen-help', 'Coucou, il est 21 heures.', [box.id]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' });
});

test('a dictation that fails once is tried again by itself: the person need not repeat', async () => {
    let calls = 0;
    const { boxes, said } = make({ hear: async () => { if (++calls === 1) throw new Error('engine busy'); return 'quelle heure est-il'; } });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'listen.start' }); for (let i = 0; i < 30; i++) s.emit('message', Buffer.alloc(640), true); s.box({ t: 'listen.end' });
    for (let i = 0; i < 40 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 2);
    assert.equal(said[0].text, 'quelle heure est-il');
});
