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
        say: async (c, text, room) => { said.push({ c, text, room }); },
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
    await boxes.agentSaid('kitchen-help', 'C\'est **fait** : voir https://example.com');
    const start = s.sent.findIndex((m) => m.t === 'speak.start');
    assert.ok(start > 0);
    assert.deepEqual(s.sent.slice(start + 1, start + 4), [{ bytes: 640 }, { bytes: 640 }, { bytes: 320 }]);
    assert.deepEqual(s.sent.at(-1), { t: 'speak.end' });
});

test('a box nobody talked to stays quiet; a press too short is not a sentence', async () => {
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

test('a dictation that fails is said to the box as an error', async () => {
    const { boxes } = make({ hear: async () => { throw new Error('engine down'); } });
    const box = boxes.pair({ code: boxes.code('kitchen-help').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    s.box({ t: 'listen.start' });
    for (let i = 0; i < 30; i++) s.emit('message', Buffer.alloc(640), true);
    s.box({ t: 'listen.end' });
    await tick(); await tick();
    assert.deepEqual(s.sent.at(-1), { t: 'cue', name: 'error' });
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
