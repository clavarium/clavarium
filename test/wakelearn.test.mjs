import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boxes, handleBoxes } from '../server/boxes.mjs';
import { WakeLearn, CLIPS_MAX, NEAR_MAX, WIRE, tuneCutoff, heldOut } from '../server/wakelearn.mjs';

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
const rig = ({ clip = 'Mésange', lang, zone = 'Europe/Paris', hello = { t: 'hello', firmware: '0.1.49', cutoff: 0.94, model: 'builtin' } } = {}) => {
    const clock = { t: T0 };
    const said = [];
    const where = dir();
    const learn = new WakeLearn({ dir: where, now: () => clock.t });
    const words = { clip }; let heard = 0;
    const boxes = new Boxes({
        file: new MemoryFile([]), exists: (c) => c === 'kitchen-help', now: () => clock.t, learn,
        hear: async (wav) => { heard++; return wav.length - 44 === 40 * 640 ? 'allume la lumière' : words.clip; },
        say: async (c, text, by) => { said.push({ c, text, by }); }, speak: async () => Buffer.alloc(1600, 1),
    });
    const box = boxes.pair({ code: boxes.code('kitchen-help', 'Salon').code });
    boxes.zone(box.id, zone, lang);
    const connect = (h = hello) => { const s = new FakeSocket(); boxes.accept(s, boxes.byKey(box.key)); if (h) s.box(h); return s; };
    let s = connect();
    const wake = async ({ sentence = true, score } = {}) => {
        s.box({ t: 'listen.start', reason: 'wake', score: 0.9 });
        s.box({ t: 'wake.clip', edge: 'start', ...(score === undefined ? {} : { score }) });
        for (let i = 0; i < 80; i++) s.emit('message', Buffer.alloc(640, 7), true);
        s.box({ t: 'wake.clip', edge: 'end' });
        if (sentence) for (let i = 0; i < 40; i++) s.emit('message', Buffer.alloc(640, 1), true);
        s.box({ t: 'listen.end', reason: sentence ? 'silence' : 'nobody' });
        for (let k = 0; k < 8; k++) await tick();
    };
    /* A near miss (wake.near): the ring, the box not woken. */
    const near = async (score = 0.9) => {
        s.box({ t: 'wake.near', edge: 'start', score });
        for (let i = 0; i < 80; i++) s.emit('message', Buffer.alloc(640, 5), true);
        s.box({ t: 'wake.near', edge: 'end' });
        for (let k = 0; k < 8; k++) await tick();
    };
    return { boxes, id: box.id, where, clock, said, words, wake, near, learn, get s() { return s; }, reconnect: (h) => { s.close(); s = connect(h); return s; }, get heard() { return heard; } };
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
    assert.deepEqual(Object.keys(a.body).sort(), ['cutoff', 'false', 'falsePerDay', 'improveAsked', 'kept', 'missed', 'missedPerDay', 'mode', 'model', 'modelProblem', 'near', 'oldest', 'real', 'tuning', 'wakeModel']);
    assert.equal(a.body.cutoff, 0.94); assert.equal(a.body.wakeModel, 'builtin'); assert.equal(a.body.modelProblem, null);
    assert.equal((await call('POST', `${base}/wake-mode`, { mode: 'learn' }, false)).status, 403);
    assert.equal(r.boxes.all()[0].wake, undefined);
    a = await call('POST', `${base}/wake-mode`, { mode: 'learn' });
    assert.equal(a.status, 200); assert.equal(a.body.mode, 'learn');
    assert.equal((await call('POST', `${base}/wake-mode`, { mode: 'x' })).status, 400);
    await r.wake();
    assert.equal((await call('GET', `${base}/wake`)).body.kept, 1);
    a = await call('POST', `${base}/wake-improve`, {});
    assert.equal(a.status, 202); assert.equal(a.body.queued, true); assert.equal(a.body.tuning.reason, 'not-enough');
    assert.equal((await call('GET', `${base}/wake`)).body.tuning.state, 'none');
    a = await call('POST', `${base}/wake-erase`, {});
    assert.equal(a.status, 200); assert.equal(a.body.kept, 0);
    assert.equal((await call('GET', '/api/boxes/00000000-0000-4000-8000-00000000dead/wake')).status, 404);
    rmSync(r.where, { recursive: true, force: true });
});

/* ---- scores, near misses, threshold tuning ---- */

test('each kept clip keeps the box\'s score; none from an older box: unknown, left out of tuning', async () => {
    const r = rig();
    r.boxes.wakeMode(r.id, 'learn');
    await r.wake({ score: 0.973 });
    r.clock.t += 1000; await r.wake();
    const index = JSON.parse(readFileSync(join(r.where, r.id, 'index.json'), 'utf8'));
    assert.deepEqual(index.clips.map((c) => c.score), [0.973, null]);
    assert.equal(tuneCutoff(index.clips, 0.94).clips, 1, 'the one without a score not counted');
    rmSync(r.where, { recursive: true, force: true });
});

test('near misses: kept under near/ in learn mode only, labelled missed or ignored by the same check, nothing said', async () => {
    const r = rig();
    await r.near(0.91);
    assert.equal(r.heard, 0, 'normal: a near miss is not even heard again');
    assert.deepEqual(wavsOf(r.where, r.id, 'near'), []);
    r.boxes.wakeMode(r.id, 'learn');
    await r.near(0.91);
    r.clock.t += 1000; r.words.clip = 'la météo de demain'; await r.near(0.85);
    const files = wavsOf(r.where, r.id, 'near');
    assert.equal(files.length, 2);
    assert.equal(readFileSync(join(r.where, r.id, 'near', files[0])).length - 44, 80 * 640, 'the ring only');
    const index = JSON.parse(readFileSync(join(r.where, r.id, 'index.json'), 'utf8'));
    assert.deepEqual(index.clips.map((c) => [c.label, c.score]), [['missed', 0.91], ['ignored', 0.85]]);
    assert.equal(r.said.length, 0, 'a near miss is never a sentence');
    assert.equal(r.s.sent.filter((m) => m.t === 'cue').length, 0);
    /* A near miss does not count as the next wake's check. */
    r.words.clip = 'Mésange'; r.clock.t += 1000; await r.wake();
    assert.match(r.said.at(-1).by.why ?? '', /^mot ✓/);
    const st = r.boxes.wakeStats(r.id);
    assert.deepEqual({ kept: st.kept, real: st.real, false: st.false, near: st.near, missed: st.missed, missedPerDay: st.missedPerDay }, { kept: 3, real: 1, false: 0, near: 2, missed: 1, missedPerDay: 1 });
    r.boxes.wakeErase(r.id);
    assert.deepEqual(wavsOf(r.where, r.id, 'near'), [], 'erased with the others');
    rmSync(r.where, { recursive: true, force: true });
});

test('near misses have their own cap: they never push the wake clips out', () => {
    const where = dir(); const clock = { t: T0 };
    const learn = new WakeLearn({ dir: where, now: () => clock.t });
    const pcm = Buffer.alloc(800, 3);
    for (let i = 0; i < 3; i++) { clock.t += 1000; learn.checked(ID, pcm, true, { keep: true, score: 0.97 }); }
    for (let i = 0; i < NEAR_MAX + 5; i++) { clock.t += 1000; learn.checked(ID, pcm, false, { keep: true, near: true, score: 0.85 }); }
    const st = learn.stats(ID, 'learn');
    assert.deepEqual({ real: st.real, near: st.near, kept: st.kept }, { real: 3, near: NEAR_MAX, kept: NEAR_MAX + 3 });
    assert.equal(wavsOf(where, ID, 'near').length, NEAR_MAX);
    rmSync(where, { recursive: true, force: true });
});

/* Clips with names; `score(label, i, held)` sets each one's score. */
const clipsOf = (counts, score) => {
    const out = [];
    for (const [label, n] of Object.entries(counts)) for (let i = 0; i < n; i++) { const file = `${label}/c${i}.wav`; out.push({ file, label, score: score(label, i, heldOut(file)) }); }
    return out;
};
const spread = (lo, hi, i, n = 97) => Math.round((lo + ((i * 37) % n) / n * (hi - lo)) * 1000) / 1000;

test('held out: 1 in 5, by the file\'s name, stable', () => {
    const names = Array.from({ length: 1000 }, (_, i) => `real/2026-11-0${i % 9}T10-00-${i}.wav`);
    const n = names.filter(heldOut).length;
    assert.ok(n > 150 && n < 250, `about a fifth (${n})`);
    assert.equal(heldOut('real/x.wav'), heldOut('false/x.wav'), 'the name, not its folder');
    assert.equal(heldOut(names[7]), heldOut(names[7]));
});

test('tuning: too few clips in the held-out fifth -> not enough clips yet', () => {
    const t = tuneCutoff(clipsOf({ real: 30, false: 30 }, (l) => (l === 'real' ? 0.99 : 0.95)), 0.94);
    assert.equal(t.better, false); assert.equal(t.reason, 'not-enough'); assert.equal(t.to, 0.94);
    assert.ok(t.heldOut.real < 10 || t.heldOut.false < 10);
});

test('tuning: a higher threshold that drops the false wakes and keeps every real one', () => {
    const clips = clipsOf({ real: 120, false: 120 }, (l, i) => (l === 'real' ? spread(0.96, 1, i) : spread(0.94, 0.955, i)));
    const t = tuneCutoff(clips, 0.94, { days: 30 });
    assert.equal(t.reason, 'better'); assert.equal(t.better, true);
    assert.equal(t.from, 0.94); assert.equal(t.to, 0.96, 'the first that drops them all; 0.97 would lose real ones');
    assert.equal(t.falsePerDayBefore, 4); assert.equal(t.falsePerDayAfter, 0);
    assert.equal(t.clips, 240); assert.deepEqual([t.missedBefore, t.missedAfter], [0, 0]);
    assert.ok(t.heldOut.real >= 10 && t.heldOut.false >= 10);
});

test('tuning: never loses a real wake the current threshold catches', () => {
    const clips = clipsOf({ real: 120, false: 120 }, (l, i) => (l === 'real' ? (i % 3 ? 0.999 : 0.945) : 0.96));
    const t = tuneCutoff(clips, 0.94);
    assert.equal(t.better, false); assert.equal(t.reason, 'no-better'); assert.equal(t.to, 0.94);
});

test('tuning: lower, to catch the missed calls, when false wakes do not rise', () => {
    const clips = clipsOf({ real: 80, missed: 60, false: 60, ignored: 80 }, (l, i) => ({ real: spread(0.95, 1, i), missed: spread(0.90, 0.93, i), false: 0.995, ignored: spread(0.80, 0.85, i) })[l]);
    const t = tuneCutoff(clips, 0.94, { days: 10 });
    assert.equal(t.reason, 'better');
    assert.equal(t.to, 0.9, 'catches every missed call; the nearest to 0.94 of those');
    assert.deepEqual([t.missedBefore, t.missedAfter], [60, 0]);
    assert.equal(t.falsePerDayBefore, t.falsePerDayAfter);
});

test('tuning: chosen on four fifths, kept only if the held-out fifth agrees', () => {
    /* Four fifths: real from 0.96, so 0.96 looks safe; the held-out fifth has real ones at 0.955 it would lose. */
    const clips = clipsOf({ real: 120, false: 120 }, (l, i, held) => (l === 'real' ? (held && i % 2 ? 0.955 : spread(0.96, 1, i)) : spread(0.94, 0.95, i)));
    const t = tuneCutoff(clips, 0.94);
    assert.equal(t.reason, 'not-confirmed'); assert.equal(t.better, false); assert.equal(t.to, 0.94);
});

/* A box with labelled clips that a higher threshold makes better (real from 0.96, false under 0.955). */
const seeded = (r) => {
    r.boxes.wakeMode(r.id, 'learn');
    const pcm = Buffer.alloc(800, 3);
    for (let i = 0; i < 100; i++) {
        r.clock.t += 1000; r.learn.checked(r.id, pcm, true, { keep: true, score: spread(0.96, 1, i) });
        r.clock.t += 1000; r.learn.checked(r.id, pcm, false, { keep: true, score: spread(0.94, 0.955, i) });
    }
};
const cutoffsSent = (s) => s.sent.filter((m) => m.t === WIRE.cutoff);

test('improve now: a better threshold is sent to the box; its ack makes it said in the conversation', async () => {
    const r = rig(); seeded(r);
    r.said.length = 0;
    const a = r.boxes.wakeImprove(r.id);
    assert.equal(a.queued, false, 'tuned: the trainer is not asked');
    assert.equal(existsSync(join(r.where, r.id, 'improve-asked')), false);
    assert.equal(a.tuning.state, 'sent'); assert.equal(a.tuning.to, 0.96);
    const [sent] = cutoffsSent(r.s);
    assert.equal(sent.value, 0.96);
    assert.equal(r.said.length, 0, 'nothing said before the box confirms');
    r.s.box({ t: 'ack', id: sent.id, ok: true });
    for (let k = 0; k < 4; k++) await tick();
    const t = a.tuning;
    assert.deepEqual(r.said.map((x) => x.text), [`Wake word tuned: threshold 0.94 → 0.96 (false wakes ${t.falsePerDayBefore} → 0 a day on your 200 clips; missed calls 0 → 0).`]);
    assert.deepEqual(r.said[0].by, { id: r.id, name: 'Salon' });
    const st = r.boxes.wakeStats(r.id);
    assert.equal(st.cutoff, 0.96); assert.equal(st.tuning.state, 'applied');
    /* The same seen again at its next hello: not said twice. */
    r.reconnect({ t: 'hello', cutoff: 0.96 }); await tick();
    assert.equal(r.said.length, 1);
    assert.equal(cutoffsSent(r.s).length, 0);
    rmSync(r.where, { recursive: true, force: true });
});

test('a box away, or on a firmware without wake.cutoff: sent at its next hello; its hello showing it confirms it', async () => {
    const r = rig({ lang: 'fr-FR', hello: { t: 'hello', firmware: '0.1.48' } }); seeded(r);
    r.said.length = 0;
    const t = r.boxes.wakeTune(r.id, 'asked');
    assert.equal(t.state, 'sent'); assert.equal(cutoffsSent(r.s).length, 0, 'its hello had no cutoff: not sent');
    const s = r.reconnect({ t: 'hello', firmware: '0.1.49', cutoff: 0.94 });
    const [again] = cutoffsSent(s);
    assert.equal(again.value, 0.96, 'sent again, it still has 0.94');
    r.reconnect({ t: 'hello', firmware: '0.1.49', cutoff: 0.96 }); await tick();
    assert.equal(r.said.length, 1);
    assert.equal(r.said[0].text, `Mot d'éveil réglé : seuil 0,94 → 0,96 (faux réveils ${String(t.falsePerDayBefore).replace('.', ',')} → 0 par jour sur tes 200 extraits ; appels manqués 0 → 0).`);
    assert.equal(r.boxes.wakeStats(r.id).cutoff, 0.96);
    rmSync(r.where, { recursive: true, force: true });
});

test('a threshold the box refuses is kept as refused, never said', async () => {
    const r = rig(); seeded(r); r.said.length = 0;
    r.boxes.wakeTune(r.id);
    const [sent] = cutoffsSent(r.s);
    r.s.box({ t: 'ack', id: sent.id, ok: false });
    for (let k = 0; k < 4; k++) await tick();
    assert.equal(r.said.length, 0);
    const st = r.boxes.wakeStats(r.id);
    assert.equal(st.tuning.state, 'refused'); assert.equal(st.cutoff, 0.94);
    rmSync(r.where, { recursive: true, force: true });
});

test('weekly: Sunday from 03:00 at the box\'s place, once a week, learning boxes only', () => {
    const r = rig(); seeded(r);
    r.clock.t = Date.parse('2026-11-08T01:30:00Z');   /* Sunday 02:30 in Paris */
    assert.equal(r.boxes.wakeWeekly().length, 0);
    r.clock.t = Date.parse('2026-11-08T02:10:00Z');   /* 03:10 */
    const [t] = r.boxes.wakeWeekly();
    assert.equal(t.why, 'weekly'); assert.equal(t.to, 0.96);
    r.clock.t += 10 * 60_000;
    assert.equal(r.boxes.wakeWeekly().length, 0, 'once');
    r.clock.t = Date.parse('2026-11-14T02:10:00Z');   /* Saturday */
    assert.equal(r.boxes.wakeWeekly().length, 0);
    r.clock.t = Date.parse('2026-11-15T02:10:00Z');
    assert.equal(r.boxes.wakeWeekly().length, 1, 'the next Sunday');
    r.boxes.wakeMode(r.id, 'normal');
    r.clock.t = Date.parse('2026-11-22T02:10:00Z');
    assert.equal(r.boxes.wakeWeekly().length, 0, 'a normal box is not tuned');
    rmSync(r.where, { recursive: true, force: true });
});

test('hello: cutoff, model and its problem kept on the box record; an older box is 0.94', async () => {
    const r = rig({ hello: { t: 'hello', firmware: '0.1.49', cutoff: 0.92, model: '2026-11-10', model_problem: 'crc mismatch, builtin used' } });
    await tick();
    const b = r.boxes.all()[0];
    assert.deepEqual({ firmware: b.firmware, cutoff: b.cutoff, model: b.model, modelProblem: b.modelProblem }, { firmware: '0.1.49', cutoff: 0.92, model: '2026-11-10', modelProblem: 'crc mismatch, builtin used' });
    r.reconnect({ t: 'hello', firmware: '0.1.48' }); await tick();
    const st = r.boxes.wakeStats(r.id);
    assert.deepEqual({ cutoff: st.cutoff, model: st.wakeModel, problem: st.modelProblem }, { cutoff: 0.94, model: null, problem: null });
    rmSync(r.where, { recursive: true, force: true });
});
