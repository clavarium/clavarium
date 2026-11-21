/* THE WAKE WORD THAT LEARNS (phase 1): what each box's wake word was, kept to train a better one.
 *
 * Every wake check (boxes.mjs, #checkWake: the box's 1.6 s before the word, dictated again) is COUNTED,
 * real or false, whatever the box's setting: the false wakes a day are measured before and after a model.
 * A box set to "learns from home" also KEEPS that clip -- never the sentence after it -- as a 16 kHz
 * 16-bit mono WAV, labelled by the check:
 *
 *   <dir>/<boxId>/real/<time>.wav     the box woke, the word was heard again (mot ✓)
 *   <dir>/<boxId>/false/<time>.wav    the box woke, it was not (mot ✗)
 *   <dir>/<boxId>/near/<time>.wav     a NEAR MISS (wake.near, a score just under its cutoff): the box did not
 *                                     wake; labelled "missed" (mot ✓: a call it missed) or "ignored" (mot ✗)
 *   <dir>/<boxId>/index.json          { clips: [{ file, label, at, heard, score }] }, oldest first
 *   <dir>/<boxId>/checks.json         { days: { 'YYYY-MM-DD': { real, false, missed, ignored } } }, DAYS_KEPT days
 *   <dir>/<boxId>/model.json          { installedAt, falsePerDayBefore, falsePerDayAfter }: the model in use
 *   <dir>/<boxId>/tuning.json         the last THRESHOLD TUNING (tuneCutoff) and where it stands
 *   <dir>/<boxId>/improve-asked       { at }: "Improve now" found no better cutoff; the trainer (phase 2) takes it
 *
 * At most CLIPS_MAX wake clips and NEAR_MAX near misses (a separate cap: a talking TV makes many, they must not
 * push the real ones out), none older than CLIPS_DAYS days, the oldest dropped first. Nothing of it leaves this
 * server.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { wavOf } from './boxes.mjs';

/* WHAT THE BOX SAYS AND IS TOLD (firmware 0.1.49), in one place to adjust:
     {t:'wake.clip', edge:'start', score}, binary, {t:'wake.clip', edge:'end'}   the 1.6 s before a wake
     {t:'wake.near', edge:'start', score}, binary (<= 51 200 bytes), {t:'wake.near', edge:'end'}   a near miss:
         the box did NOT wake; its score the highest mean reached
     Both scores are the 5-inference window MEAN, the value the box compares with its cutoff; none (before
     0.1.49): unknown, the clip left out of tuning.
     {t:'wake.cutoff', id, value} -> {t:'ack', id, ok} (ok:false, detail "value 0.80-0.99")   saved on the box
     {t:'hello', cutoff, model: 'builtin'|<version>, model_problem?}   none (older): 0.94, built in */
export const WIRE = { clip: 'wake.clip', near: 'wake.near', cutoff: 'wake.cutoff', min: 0.80, max: 0.99, firmwareCutoff: 0.94 };
export const scoreOf = (v) => { const n = typeof v === 'number' ? v : NaN; return n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : null; };
export const cutoffOf = (v) => { const n = typeof v === 'number' ? Math.round(v * 100) / 100 : NaN; return n >= WIRE.min && n <= WIRE.max ? n : null; };

export const CLIPS_MAX = 500;
export const NEAR_MAX = 200;
export const CLIPS_DAYS = 30;
export const RATE_DAYS = 7;
const DAYS_KEPT = 60;
const DAY = 86_400_000;
export const MODES = ['normal', 'learn'];
export const IMPROVE_FILE = 'improve-asked';

const BOX_ID = /^[0-9a-f-]{36}$/;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/* A clip's label -> is the wake word in it (the server's check), and did the box wake. */
const LABELS = { real: { word: true, woke: true }, false: { word: false, woke: true }, missed: { word: true, woke: false }, ignored: { word: false, woke: false } };
const isNear = (c) => c.label === 'missed' || c.label === 'ignored';

/* HELD OUT for judging, never for choosing: 1 in 5, by the SHA-1 of the file's name (stable across runs). */
export const heldOut = (file) => BigInt(`0x${createHash('sha1').update(basename(String(file))).digest('hex')}`) % 5n === 0n;

export const MIN_EACH = 10;
/* THRESHOLD TUNING (stage A, mot-eveil-apprentissage.md §3): from the box's own scores, no model run.
   clips: [{ file, label, score }]; current: the box's cutoff; days: how many days the clips cover.
   At a cutoff c a clip wakes the box when score >= c. The cutoff is CHOSEN on the 4 in 5 not held out:
   among c in 0.80..0.99 that are better than the current one there -- no word clip it catches is lost, and
   strictly fewer false wakes, or as many (or fewer) with more missed calls caught -- the fewest false wakes,
   then the most words caught, then the nearest to the current. It is kept only if the held-out fifth says
   the same (better, by the same rule). Needs MIN_EACH word clips (real + missed) and MIN_EACH others
   (false + ignored) in the held-out fifth; else "not-enough". */
export function tuneCutoff(clips, current, { days = 1 } = {}) {
    const from = cutoffOf(current) ?? WIRE.firmwareCutoff;
    const all = (Array.isArray(clips) ? clips : []).filter((c) => LABELS[c?.label] && scoreOf(c.score) !== null)
        .map((c) => ({ word: LABELS[c.label].word, s: scoreOf(c.score), test: heldOut(c.file) }));
    const test = all.filter((x) => x.test); const train = all.filter((x) => !x.test);
    const at = (set, c) => ({ real: set.filter((x) => x.word && x.s >= c).length, false: set.filter((x) => !x.word && x.s >= c).length });
    const better = (set, c) => {
        const a = at(set, from); const b = at(set, c);
        if (set.some((x) => x.word && x.s >= from && x.s < c)) return false;
        return b.false < a.false || (b.false <= a.false && b.real > a.real);
    };
    const held = { real: test.filter((x) => x.word).length, false: test.filter((x) => !x.word).length };
    const span = Math.max(1, Number(days) || 1);
    const perDay = (n) => Math.round((n / span) * 10) / 10;
    const report = (to, reason) => ({
        better: to !== from, reason, from, to, clips: all.length, heldOut: held,
        falsePerDayBefore: perDay(at(all, from).false), falsePerDayAfter: perDay(at(all, to).false),
        missedBefore: all.filter((x) => x.word && x.s < from).length, missedAfter: all.filter((x) => x.word && x.s < to).length,
    });
    if (held.real < MIN_EACH || held.false < MIN_EACH) return report(from, 'not-enough');
    let best = null;
    for (let n = Math.round(WIRE.min * 100); n <= Math.round(WIRE.max * 100); n++) {
        const c = n / 100;
        if (c === from || !better(train, c)) continue;
        const k = at(train, c);
        if (!best || k.false < best.k.false || (k.false === best.k.false && (k.real > best.k.real || (k.real === best.k.real && Math.abs(c - from) < Math.abs(best.c - from))))) best = { c, k };
    }
    if (!best) return report(from, 'no-better');
    if (!better(test, best.c)) return report(from, 'not-confirmed');
    return report(best.c, 'better');
}

export class WakeLearn {
    #dir; #now;

    constructor({ dir, now = () => Date.now() }) { this.#dir = dir; this.#now = now; }

    #of(id) { if (!BOX_ID.test(String(id))) throw new Error('not a box id'); return join(this.#dir, id); }
    #read(id, file, empty) { try { return JSON.parse(readFileSync(join(this.#of(id), file), 'utf8')); } catch { return empty; } }
    #write(id, file, value) {
        const dir = this.#of(id); mkdirSync(dir, { recursive: true });
        const to = join(dir, file);
        writeFileSync(`${to}.tmp`, JSON.stringify(value)); renameSync(`${to}.tmp`, to);
    }
    #clips(id) { const v = this.#read(id, 'index.json', null); return Array.isArray(v?.clips) ? v.clips : []; }

    /* Too many, or too old: the oldest go, their files with them. */
    #pruned(id, clips) {
        const since = this.#now() - CLIPS_DAYS * DAY;
        const young = clips.filter((c) => Date.parse(c.at) >= since);
        const left = { wake: CLIPS_MAX, near: NEAR_MAX };
        const keep = young.reverse().filter((c) => left[isNear(c) ? 'near' : 'wake']-- > 0).reverse();
        if (keep.length === clips.length) return clips;
        const kept = new Set(keep.map((c) => c.file));
        for (const c of clips) if (!kept.has(c.file)) rmSync(join(this.#of(id), c.file), { force: true });
        this.#write(id, 'index.json', { clips: keep });
        return keep;
    }

    /* One wake check of a box: counted always; its clip kept only when `keep` (the box learns). A near miss
       (`near`: the box did not wake) is labelled missed or ignored, its clip under near/. */
    checked(id, pcm, ok, { keep = false, heard = '', score = null, near = false } = {}) {
        const now = this.#now();
        const checks = this.#read(id, 'checks.json', { days: {} });
        const days = checks.days && typeof checks.days === 'object' ? checks.days : {};
        const today = dayOf(now);
        const d = days[today] ?? { real: 0, false: 0 };
        const label = near ? (ok ? 'missed' : 'ignored') : (ok ? 'real' : 'false');
        d[label] = (Number(d[label]) || 0) + 1;
        days[today] = d;
        const oldest = dayOf(now - DAYS_KEPT * DAY);
        for (const k of Object.keys(days)) if (k < oldest) delete days[k];
        this.#write(id, 'checks.json', { days });
        if (!keep) return null;
        const folder = near ? 'near' : label;
        mkdirSync(join(this.#of(id), folder), { recursive: true });
        const stamp = new Date(now).toISOString().replace(/:/g, '-');
        let file = `${folder}/${stamp}.wav`;
        for (let n = 2; existsSync(join(this.#of(id), file)); n++) file = `${folder}/${stamp}-${n}.wav`;
        writeFileSync(join(this.#of(id), file), wavOf(pcm.subarray(0, pcm.length & ~1)));
        const clip = { file, label, at: new Date(now).toISOString(), heard: String(heard).slice(0, 40), score: scoreOf(score) };
        this.#write(id, 'index.json', { clips: [...this.#clips(id), clip] });
        this.#pruned(id, this.#clips(id));
        return clip;
    }

    /* False wakes a day over the last RATE_DAYS days (fewer when the box counts for less long); `what` another count. */
    falsePerDay(id, what = 'false') {
        const days = this.#read(id, 'checks.json', { days: {} }).days ?? {};
        const now = this.#now();
        const span = Array.from({ length: RATE_DAYS }, (_, i) => dayOf(now - i * DAY));
        const counted = Object.keys(days).sort();
        if (!counted.length) return 0;
        const first = counted[0];
        const within = span.filter((k) => k >= first);
        const sum = within.reduce((n, k) => n + (Number(days[k]?.[what]) || 0), 0);
        return Math.round((sum / Math.max(1, within.length)) * 10) / 10;
    }

    stats(id, mode = 'normal') {
        const clips = this.#pruned(id, this.#clips(id));
        const n = (label) => clips.filter((c) => c.label === label).length;
        const m = this.#read(id, 'model.json', null);
        const asked = this.#read(id, IMPROVE_FILE, null);
        return {
            mode: MODES.includes(mode) ? mode : 'normal',
            kept: clips.length, real: n('real'), false: n('false'), near: n('missed') + n('ignored'), missed: n('missed'),
            oldest: clips[0]?.at ?? null,
            falsePerDay: this.falsePerDay(id),
            missedPerDay: this.falsePerDay(id, 'missed'),
            tuning: this.tuning(id),
            model: m && m.installedAt ? { installedAt: m.installedAt, falsePerDayBefore: m.falsePerDayBefore ?? null, falsePerDayAfter: m.falsePerDayAfter ?? null } : null,
            improveAsked: asked?.at ?? null,
        };
    }

    /* Every clip of the box gone; its counts and its model stay (they hold no sound). */
    erase(id) {
        const n = this.#clips(id).length;
        for (const label of ['real', 'false', 'near']) rmSync(join(this.#of(id), label), { recursive: true, force: true });
        rmSync(join(this.#of(id), 'index.json'), { force: true });
        return n;
    }

    /* The box withdrawn: nothing of it is kept. */
    forget(id) { rmSync(this.#of(id), { recursive: true, force: true }); }

    /* "Improve now": a request the trainer picks up (phase 2), a file it removes once done. */
    improve(id) { const at = new Date(this.#now()).toISOString(); this.#write(id, IMPROVE_FILE, { at }); return at; }

    /* The threshold tuning on this box's clips (tuneCutoff), the days they cover counted from the oldest. */
    tune(id, current) {
        const clips = this.#pruned(id, this.#clips(id));
        const first = Date.parse(clips[0]?.at ?? '');
        const days = Number.isFinite(first) ? Math.max(1, (this.#now() - first) / DAY) : 1;
        return tuneCutoff(clips, current, { days });
    }
    /* The last tuning and where it stands (state: none, sent, applied, refused): kept, shown on the card. */
    tuning(id) { return this.#read(id, 'tuning.json', null); }
    tuned(id, result) { const t = { ...result, at: result.at ?? new Date(this.#now()).toISOString() }; this.#write(id, 'tuning.json', t); return t; }

    /* A model put in place (phase 2): kept to compare. */
    installed(id, { before, after }) {
        const m = { installedAt: new Date(this.#now()).toISOString(), falsePerDayBefore: Number(before), falsePerDayAfter: Number(after) };
        this.#write(id, 'model.json', m);
        rmSync(join(this.#of(id), IMPROVE_FILE), { force: true });
        return m;
    }
}
