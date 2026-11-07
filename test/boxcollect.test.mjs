import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boxes, handleBoxes, voiceboxConnector } from '../server/boxes.mjs';
import { BoxCollect, STATIONS, STOP_PHRASE, QUIET_WARN_MS, AFTER_DEFAULT, crc32, stationPhrase, volumePhrase } from '../server/boxcollect.mjs';

class MemoryFile { #v; constructor(v) { this.#v = v; } get() { return structuredClone(this.#v); } set(v) { this.#v = structuredClone(v); } }
class FakeSocket extends EventEmitter {
    readyState = 1; sent = [];
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : { bytes: data.length }); }
    close() { this.readyState = 3; this.emit('close'); }
    box(o) { this.emit('message', Buffer.from(JSON.stringify(o)), false); }
}
const settle = async () => { for (let k = 0; k < 12; k++) await new Promise((r) => setImmediate(r)); };
const T0 = Date.parse('2026-11-07T08:00:00Z');
const CLIP = 51_200;   /* the 1.6 s the box sends */

const rig = ({ countMax, bytesMax } = {}) => {
    const clock = { t: T0 - 60_000 };
    const now = () => clock.t;
    const dir = mkdtempSync(join(tmpdir(), 'boxcollect-'));
    const said = []; const spoken = []; const heard = []; const checked = []; const logs = [];
    const collect = new BoxCollect({ dir, now, ...(countMax ? { countMax } : {}), ...(bytesMax ? { bytesMax } : {}) });
    const boxes = new Boxes({
        file: new MemoryFile([]), exists: (c) => c === 'living-room', now, log: (l) => logs.push(l), collect,
        hear: async (wav) => { const n = wav.length - 44; heard.push(n); return n === CLIP ? 'Mes anges' : 'D\'accord, voici la radio'; },
        say: async (c, text) => { said.push(text); },
        speak: async (text) => { spoken.push(text); return Buffer.alloc(1600, 1); },
        learn: { checked: (...a) => checked.push(a), tuning: () => null },
    });
    const box = boxes.pair({ code: boxes.code('living-room', 'Salon').code });
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    const listen = async ({ reason = 'wake', clip = CLIP, seconds = 12, end = 'timeout', voice = 900, open = false } = {}) => {
        s.box({ t: 'listen.start', reason, ...(reason === 'wake' ? { score: 0.95 } : {}) });
        if (clip) {
            s.box({ t: 'wake.clip', edge: 'start', score: 0.96 });
            for (let sent = 0; sent < clip; sent += 640) s.emit('message', Buffer.alloc(Math.min(640, clip - sent), 5), true);
            s.box({ t: 'wake.clip', edge: 'end' });
        }
        for (let i = 0; i < seconds * 50; i++) s.emit('message', Buffer.alloc(640, 9), true);
        if (open) return;
        s.box({ t: 'listen.end', reason: end, ep: { voice } });
        await settle();
    };
    return { boxes, collect, box, s, dir, clock, said, spoken, heard, checked, logs, listen };
};
const day = '2026-11-07';

test('collect on: a wake is not sent to the AI nor answered; its clip and what follows are kept, with one line', async () => {
    const r = rig();
    r.boxes.collectStart(r.box.id, { from: new Date(T0).toISOString(), until: '2026-11-07T16:00:00Z', tag: 'radio' });
    await r.listen();   /* before its start: as ever */
    assert.equal(r.said.length, 1, 'before the start time the box works as usual');
    r.clock.t = T0 + 60_000;
    const cues = r.s.sent.length;
    await r.listen({ voice: 1234 });
    assert.equal(r.said.length, 1, 'nothing sent on');
    assert.deepEqual(r.s.sent.slice(cues).filter((m) => m.t === 'cue').map((m) => m.name), ['done'], 'only « done »: no thinking, no answer');
    assert.equal(r.spoken.length, 0, 'nothing said aloud');
    assert.deepEqual(r.heard.slice(-1), [CLIP], 'only the clip heard again, never the sentence');
    assert.equal(r.checked.length, 1, 'the wake learning counts the wake before the session only');
    const files = readdirSync(join(r.dir, day)).sort();
    assert.deepEqual(files, ['1-suite.wav', '1.wav', 'index.jsonl']);
    assert.equal(readFileSync(join(r.dir, day, '1.wav')).length, 44 + CLIP, 'the exact clip');
    assert.equal(readFileSync(join(r.dir, day, '1-suite.wav')).length, 44 + AFTER_DEFAULT * 32_000, 'the sentence cut at `after` seconds');
    const line = JSON.parse(readFileSync(join(r.dir, day, 'index.jsonl'), 'utf8'));
    assert.deepEqual({ ...line, at: undefined }, { n: 1, at: undefined, box: r.box.id, tag: 'radio', reason: 'wake', score: 0.96, heard: 'Mes anges', word: true, voice: 1234, end: 'timeout', station: null, clip: '1.wav', after: '1-suite.wav' });
    await r.listen({ reason: 'button', clip: 0, seconds: 2, end: 'silence' });
    assert.equal(r.said.length, 1, 'a button neither');
    assert.equal(r.collect.state(r.box.id).kept, 2);
});

test('collect turns itself off at its end time: the next wake goes to the AI again', async () => {
    const r = rig();
    r.clock.t = T0;
    r.boxes.collectStart(r.box.id, { until: new Date(T0 + 3_600_000).toISOString() });
    await r.listen();
    assert.equal(r.said.length, 0);
    r.clock.t = T0 + 3_600_000;
    assert.equal(r.collect.on(r.box.id), false, 'past its end, off at once (no radio: no grace)');
    await r.listen();
    assert.equal(r.said.length, 1, 'answered as usual');
    await r.boxes.collectTick();
    assert.equal(r.collect.state(r.box.id).on, false);
    assert.equal(r.collect.state(r.box.id).last.why, 'time');
    assert.equal(new BoxCollect({ dir: r.dir, now: () => r.clock.t }).state(r.box.id).last.kept, 1, 'the ended session is still shown after a restart');
    assert.equal(r.spoken.length, 0, 'no radio: nothing to stop');
});

test('the radio: the volume, then a station every hour, a warning after 20 quiet minutes, « stop » at the end once the box is free', async () => {
    const r = rig();
    r.clock.t = T0;
    r.boxes.collectStart(r.box.id, { until: new Date(T0 + 3 * 3_600_000).toISOString(), radio: true });
    await r.boxes.collectTick();
    await r.boxes.collectTick();
    assert.deepEqual(r.spoken, [volumePhrase(4), stationPhrase(STATIONS[0])], 'its call kept: « Ok Google » is said on purpose');
    assert.ok(r.spoken[1].startsWith('Ok Google, mets France Inter'));
    /* the speaker's answer (the box listens after speaking): dictated, logged, never sent on */
    await r.listen({ reason: 'follow', clip: 0, seconds: 2, end: 'silence' });
    assert.equal(r.said.length, 0);
    assert.equal(r.collect.state(r.box.id).answers.at(-1).text, 'D\'accord, voici la radio');
    r.clock.t += 10 * 60_000; await r.listen();
    assert.equal(JSON.parse(readFileSync(join(r.dir, day, 'index.jsonl'), 'utf8').trim()).station, 'France Inter');
    r.clock.t += QUIET_WARN_MS; await r.boxes.collectTick();
    assert.ok(r.logs.some((l) => /no wake for 20 min since France Inter was asked/.test(l)), 'said in the log');
    assert.equal(r.collect.state(r.box.id).warnings.length, 1);
    await r.boxes.collectTick();
    assert.equal(r.collect.state(r.box.id).warnings.length, 1, 'once per station');
    r.clock.t = T0 + 3_600_000;
    await r.listen({ open: true });   /* listening: the next station waits */
    await r.boxes.collectTick();
    assert.equal(r.spoken.length, 2);
    r.s.box({ t: 'listen.end', reason: 'timeout' }); await settle();
    await r.boxes.collectTick();
    assert.equal(r.spoken.at(-1), stationPhrase(STATIONS[1]));
    r.clock.t = T0 + 3 * 3_600_000 + 1000;
    assert.equal(r.collect.on(r.box.id), true, 'a radio session keeps its wakes away from the AI until the speaker is stopped');
    await r.listen({ open: true });
    await r.boxes.collectTick();
    assert.ok(r.collect.state(r.box.id).on, 'not ended while the box listens');
    r.s.box({ t: 'listen.end', reason: 'timeout' }); await settle();
    assert.equal(r.said.length, 0);
    await r.boxes.collectTick();
    assert.equal(r.collect.state(r.box.id).on, false);
    assert.equal(r.spoken.at(-1), STOP_PHRASE);
    assert.equal(r.s.sent.filter((m) => m.t === 'speak.end').at(-1).then, undefined, 'it does not listen after « stop »');
});

test('the caps: a full collect keeps nothing more and ends; « stop » said to the speaker', async () => {
    const r = rig({ countMax: 2 });
    r.clock.t = T0;
    r.boxes.collectStart(r.box.id, { until: new Date(T0 + 3_600_000).toISOString(), radio: true });
    await r.listen(); await r.listen(); await r.listen();
    assert.equal(r.collect.state(r.box.id).count, 2);
    assert.equal(readdirSync(join(r.dir, day)).filter((f) => /^\d+\.wav$/.test(f)).length, 2);
    assert.equal(r.said.length, 0, 'still not sent on');
    await r.boxes.collectTick();
    assert.equal(r.collect.state(r.box.id).last.why, 'full');
    assert.equal(r.spoken.at(-1), STOP_PHRASE);

    const b = rig({ bytesMax: 200_000 });
    b.clock.t = T0;
    b.boxes.collectStart(b.box.id, { until: new Date(T0 + 3_600_000).toISOString() });
    await b.listen(); await b.listen();
    assert.equal(b.collect.state(b.box.id).count, 0, 'a clip and its suite would pass the byte cap');
});

test('bad starts are refused: no end, an end past, too long, a bad tag', () => {
    const r = rig();
    r.clock.t = T0;
    assert.throws(() => r.boxes.collectStart(r.box.id, {}), { status: 400 });
    assert.throws(() => r.boxes.collectStart(r.box.id, { until: new Date(T0 - 1).toISOString() }), { status: 400 });
    assert.throws(() => r.boxes.collectStart(r.box.id, { until: new Date(T0 + 13 * 3_600_000).toISOString() }), { status: 400 });
    assert.throws(() => r.boxes.collectStart(r.box.id, { until: new Date(T0 + 3_600_000).toISOString(), tag: '../x' }), { status: 400 });
    assert.throws(() => r.boxes.collectStart('0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), { until: new Date(T0 + 3_600_000).toISOString() }), { status: 404 });
});

test('owner only: the signed-in page starts and stops it, a request from elsewhere is refused, and no tool can', async () => {
    const r = rig();
    r.clock.t = T0;
    const call = async (method, url, body, ok = true) => {
        const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
        let status; let out = ''; let head = {};
        const response = { writeHead(st, h) { status = st; head = h ?? {}; return this; }, end(b) { out = b; } };
        await handleBoxes(request, response, r.boxes, () => ok);
        return { status, head, out };
    };
    const url = `/api/boxes/${r.box.id}/collect`;
    assert.equal((await call('POST', url, { until: new Date(T0 + 3_600_000).toISOString() }, false)).status, 403);
    assert.equal(r.collect.state(r.box.id).on, false);
    const on = await call('POST', url, { until: new Date(T0 + 3_600_000).toISOString(), tag: 'radio' });
    assert.equal(on.status, 200); assert.equal(JSON.parse(on.out).on, true);
    assert.equal(JSON.parse((await call('GET', url)).out).tag, 'radio');
    await r.listen();
    const zip = await call('GET', '/api/boxes/collect-export?tag=radio');
    assert.equal(zip.status, 200); assert.equal(zip.head['content-type'], 'application/zip'); assert.equal(zip.head['x-clips'], '1');
    const off = await call('POST', url, { on: false });
    assert.equal(JSON.parse(off.out).on, false);
    await assert.rejects(voiceboxConnector(r.boxes).run('voicebox.collect', { config: { box: r.box.id } }, {}), /not for a voice box/);
});

test('the export: a zip laid out for the notebook -- <tag>/ clips, <tag>_suite/, index.csv; wakes of that tag only', async () => {
    const r = rig();
    r.clock.t = T0;
    r.boxes.collectStart(r.box.id, { until: new Date(T0 + 3_600_000).toISOString(), radio: true });
    await r.boxes.collectTick(); await r.boxes.collectTick();
    await r.listen(); await r.listen({ reason: 'button', clip: 0, seconds: 2, end: 'silence' }); await r.listen({ seconds: 0, end: 'nobody' });
    const { zip, clips } = r.collect.exportZip({ tag: 'radio' });
    assert.equal(clips, 2, 'the two wakes, not the button');
    /* read back its central directory, and every entry's CRC */
    const end = zip.length - 22;
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    const names = []; let at = zip.readUInt32LE(end + 16);
    for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
        const n = zip.readUInt16LE(at + 28); const off = zip.readUInt32LE(at + 42); const size = zip.readUInt32LE(at + 20);
        const name = zip.toString('utf8', at + 46, at + 46 + n); names.push(name);
        const data = zip.subarray(off + 30 + zip.readUInt16LE(off + 26), off + 30 + zip.readUInt16LE(off + 26) + size);
        assert.equal(crc32(data), zip.readUInt32LE(at + 16), name);
        if (name.endsWith('.wav')) assert.equal(data.toString('ascii', 0, 4), 'RIFF');
        at += 46 + n;
    }
    assert.deepEqual(names, [`radio/${day}-1.wav`, `radio_suite/${day}-1.wav`, `radio/${day}-3.wav`, 'index.csv', 'LISEZMOI.txt']);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const csv = zip.toString('utf8').split('file,suite,at')[1];
    assert.match(csv, /radio\/2026-11-07-1\.wav,radio_suite\/2026-11-07-1\.wav,[^,]+,wake,0\.96,Mes anges,true,900,timeout,France Inter/);
    assert.equal(r.collect.exportZip({ tag: 'other' }).clips, 0);
    assert.ok(existsSync(join(r.dir, 'state.json')), 'the session outlives a restart');
    assert.equal(new BoxCollect({ dir: r.dir, now: () => r.clock.t }).on(r.box.id), true);
});
