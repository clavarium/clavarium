import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boxes, handleBoxes } from '../server/boxes.mjs';
import { WakeLearn, CLIPS_MAX } from '../server/wakelearn.mjs';

class MemoryFile { #v; constructor(v) { this.#v = v; } get() { return structuredClone(this.#v); } set(v) { this.#v = structuredClone(v); } }
class FakeSocket extends EventEmitter {
    readyState = 1; sent = []; closed = null;
    send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : { bytes: data.length }); }
    close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
    box(o) { this.emit('message', Buffer.from(JSON.stringify(o)), false); }
}
const tick = () => new Promise((r) => setImmediate(r));
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const ID = '00000000-0000-4000-8000-000000000001';
const dir = () => mkdtempSync(join(tmpdir(), 'wakelearn-'));

/* A box with its link; the clip reads as the wake word or not as `clip` says. */
const rig = ({ clip = 'Mésange', lang } = {}) => {
    const clock = { t: T0 };
    const said = [];
    const where = dir();
    const learn = new WakeLearn({ dir: where, now: () => clock.t });
    const words = { clip };
    const boxes = new Boxes({
        file: new MemoryFile([]), exists: (c) => c === 'kitchen-help', now: () => clock.t, learn,
        hear: async (wav) => (wav.length - 44 === 40 * 640 ? 'allume la lumière' : words.clip),
        say: async (c, text, by) => { said.push({ c, text, by }); }, speak: async () => Buffer.alloc(1600, 1),
    });
    const box = boxes.pair({ code: boxes.code('kitchen-help', 'Salon').code });
    if (lang) boxes.zone(box.id, 'Europe/Paris', lang);
    const s = new FakeSocket();
    boxes.accept(s, boxes.byKey(box.key));
    const wake = async ({ sentence = true } = {}) => {
        s.box({ t: 'listen.start', reason: 'wake', score: 0.9 });
        s.box({ t: 'wake.clip', edge: 'start' });
        for (let i = 0; i < 80; i++) s.emit('message', Buffer.alloc(640, 7), true);
        s.box({ t: 'wake.clip', edge: 'end' });
        if (sentence) for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640, 1), true);
        s.box({ t: 'listen.end', reason: sentence ? 'silence' : 'nobody' });
        for (let k = 0; k < 8; k++) await tick();
    };
    return { boxes, id: box.id, where, clock, said, words, wake, learn };
};
const wavsOf = (where, id, label) => { try { return readdirSync(join(where, id, label)); } catch { return []; } };

test('normal: wake checks are counted, no clip is kept', async () => {
    const r = rig();
    assert.equal(r.boxes.wakeStats(r.id).mode, 'normal');
    await r.wake();
    r.words.clip = 'Bonjour'; await r.wake();
    assert.deepEqual(wavsOf(r.where, r.id, 'real'), []);
    assert.deepEqual(wavsOf(r.where, r.id, 'false'), []);
    const st = r.boxes.wakeStats(r.id);
    assert.equal(st.kept, 0);
    assert.equal(st.falsePerDay, 1, 'one false wake on its one day counted');
    assert.equal(st.model, null);
    rmSync(r.where, { recursive: true, force: true });
});

test('learns: each clip is kept as a 16 kHz WAV with its label; the sentence never', async () => {
    const r = rig();
    r.boxes.wakeMode(r.id, 'learn');
    await r.wake();
    r.clock.t += 1000; r.words.clip = 'Bonjour à tous'; await r.wake();
    const real = wavsOf(r.where, r.id, 'real'); const bad = wavsOf(r.where, r.id, 'false');
    assert.equal(real.length, 1); assert.equal(bad.length, 1);
    const wav = readFileSync(join(r.where, r.id, 'real', real[0]));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16_000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.length - 44, 80 * 640, 'the clip only, not the sentence');
    assert.equal(wav.readInt16LE(44), 0x0707);
    const index = JSON.parse(readFileSync(join(r.where, r.id, 'index.json'), 'utf8'));
    assert.deepEqual(index.clips.map((c) => c.label), ['real', 'false']);
    assert.equal(index.clips[1].heard, 'Bonjour à tous');
    const st = r.boxes.wakeStats(r.id);
    assert.deepEqual({ mode: st.mode, kept: st.kept, real: st.real, false: st.false, oldest: st.oldest }, { mode: 'learn', kept: 2, real: 1, false: 1, oldest: new Date(T0).toISOString() });
    assert.equal(r.said.length, 2, 'both sentences still said (dropping is off)');
    /* A wake with no sentence after it is kept too: the check is the clip's. */
    await r.wake({ sentence: false });
    assert.equal(r.boxes.wakeStats(r.id).kept, 3);
    rmSync(r.where, { recursive: true, force: true });
});

test('back to normal keeps nothing new; the clips kept stay until erased', async () => {
    const r = rig();
    r.boxes.wakeMode(r.id, 'learn'); await r.wake();
    r.boxes.wakeMode(r.id, 'normal'); r.clock.t += 1000; await r.wake();
    assert.equal(r.boxes.wakeStats(r.id).kept, 1);
    assert.equal(r.boxes.all()[0].wake, 'normal', 'the setting is kept with the box');
    assert.throws(() => r.boxes.wakeMode(r.id, 'always'), { status: 400 });
    const after = r.boxes.wakeErase(r.id);
    assert.equal(after.kept, 0);
    assert.deepEqual(wavsOf(r.where, r.id, 'real'), []);
    assert.equal(after.falsePerDay, 0, 'its counts stay: they hold no sound');
    rmSync(r.where, { recursive: true, force: true });
});

test('at most CLIPS_MAX clips, the oldest first dropped; none older than 30 days', () => {
    const where = dir(); const clock = { t: T0 };
    const learn = new WakeLearn({ dir: where, now: () => clock.t });
    const pcm = Buffer.alloc(800, 3);
    for (let i = 0; i < CLIPS_MAX + 3; i++) { clock.t = T0 + i * 1000; learn.checked(ID, pcm, i % 2 === 0, { keep: true }); }
    let st = learn.stats(ID, 'learn');
    assert.equal(st.kept, CLIPS_MAX);
    assert.equal(st.oldest, new Date(T0 + 3000).toISOString());
    assert.equal(wavsOf(where, ID, 'real').length + wavsOf(where, ID, 'false').length, CLIPS_MAX, 'their files gone with them');
    clock.t = T0 + 30 * DAY + 3500;   /* past 30 days for the four oldest still kept */
    st = learn.stats(ID, 'learn');
    assert.equal(st.kept, CLIPS_MAX - 1);
    clock.t = T0 + 40 * DAY;
    st = learn.stats(ID, 'learn');
    assert.equal(st.kept, 0); assert.equal(st.oldest, null);
    assert.equal(wavsOf(where, ID, 'real').length, 0);
    rmSync(where, { recursive: true, force: true });
});

test('false wakes a day over the last 7 days', () => {
    const where = dir(); const clock = { t: T0 - 9 * DAY };
    const learn = new WakeLearn({ dir: where, now: () => clock.t });
    const pcm = Buffer.alloc(800);
    for (let d = 9; d >= 0; d--) { clock.t = T0 - d * DAY; for (let k = 0; k < (d >= 7 ? 10 : 2); k++) learn.checked(ID, pcm, false); learn.checked(ID, pcm, true); }
    clock.t = T0;
    assert.equal(learn.falsePerDay(ID), 2, 'the days before the last seven do not count');
    const young = new WakeLearn({ dir: join(where, 'young'), now: () => T0 });
    young.checked(ID, pcm, false); young.checked(ID, pcm, false); young.checked(ID, pcm, false);
    assert.equal(young.falsePerDay(ID), 3, 'a box counted for one day: its one day');
    rmSync(where, { recursive: true, force: true });
});

test('improve asks the trainer with a file; a model installed is said in the conversation, in the box\'s name', async () => {
    const r = rig();
    r.boxes.wakeMode(r.id, 'learn'); await r.wake(); r.clock.t += 1000; await r.wake();
    const asked = r.boxes.wakeImprove(r.id);
    assert.equal(asked.queued, true);
    assert.ok(existsSync(join(r.where, r.id, 'improve-asked')));
    assert.equal(r.boxes.wakeStats(r.id).improveAsked, asked.at);
    r.said.length = 0;
    const m = await r.boxes.modelInstalled(r.id, { before: 4, after: 1 });
    assert.equal(m.text, 'New wake word installed (false wakes 4 → 1 a day on your 2 clips).');
    assert.deepEqual(r.said, [{ c: 'kitchen-help', text: m.text, by: { id: r.id, name: 'Salon' } }]);
    assert.equal(existsSync(join(r.where, r.id, 'improve-asked')), false, 'the request answered');
    const st = r.boxes.wakeStats(r.id);
    assert.deepEqual({ ...st.model, installedAt: undefined }, { installedAt: undefined, falsePerDayBefore: 4, falsePerDayAfter: 1 });
    assert.equal(st.model.installedAt, new Date(r.clock.t).toISOString());
    const fr = rig({ lang: 'fr-FR' });
    const said = await fr.boxes.modelInstalled(fr.id, { before: 4.5, after: 1 });
    assert.equal(said.text, 'Nouveau mot d\'éveil installé (faux réveils 4,5 → 1 par jour sur tes 0 extraits).');
    rmSync(r.where, { recursive: true, force: true }); rmSync(fr.where, { recursive: true, force: true });
});

test('a box withdrawn takes its clips with it', async () => {
    const r = rig();
    r.boxes.wakeMode(r.id, 'learn'); await r.wake();
    r.boxes.revoke(r.id);
    assert.equal(existsSync(join(r.where, r.id)), false);
    rmSync(r.where, { recursive: true, force: true });
});

test('the API: stats, mode, erase, improve, behind the same-site guard', async () => {
    const r = rig();
    const call = async (method, url, body, ok = true) => {
        const request = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method, url, headers: {} });
        let status; let out = '';
        await handleBoxes(request, { writeHead(s) { status = s; return this; }, end(b) { out = b; } }, r.boxes, () => ok);
        return { status, body: JSON.parse(out) };
    };
    const base = `/api/boxes/${r.id}`;
    let a = await call('GET', `${base}/wake`);
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(a.body).sort(), ['false', 'falsePerDay', 'improveAsked', 'kept', 'mode', 'model', 'oldest', 'real']);
    assert.equal((await call('POST', `${base}/wake-mode`, { mode: 'learn' }, false)).status, 403);
    assert.equal(r.boxes.all()[0].wake, undefined);
    a = await call('POST', `${base}/wake-mode`, { mode: 'learn' });
    assert.equal(a.status, 200); assert.equal(a.body.mode, 'learn');
    assert.equal((await call('POST', `${base}/wake-mode`, { mode: 'x' })).status, 400);
    await r.wake();
    assert.equal((await call('GET', `${base}/wake`)).body.kept, 1);
    a = await call('POST', `${base}/wake-improve`, {});
    assert.equal(a.status, 202); assert.equal(a.body.queued, true);
    a = await call('POST', `${base}/wake-erase`, {});
    assert.equal(a.status, 200); assert.equal(a.body.kept, 0);
    assert.equal((await call('GET', '/api/boxes/00000000-0000-4000-8000-00000000dead/wake')).status, 404);
    rmSync(r.where, { recursive: true, force: true });
});
