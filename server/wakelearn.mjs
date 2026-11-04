/* THE WAKE WORD THAT LEARNS (phase 1): what each box's wake word was, kept to train a better one.
 *
 * Every wake check (boxes.mjs, #checkWake: the box's 1.6 s before the word, dictated again) is COUNTED,
 * real or false, whatever the box's setting: the false wakes a day are measured before and after a model.
 * A box set to "learns from home" also KEEPS that clip -- never the sentence after it -- as a 16 kHz
 * 16-bit mono WAV, labelled by the check:
 *
 *   <dir>/<boxId>/real/<time>.wav     the word was heard again (mot ✓)
 *   <dir>/<boxId>/false/<time>.wav    it was not (mot ✗)
 *   <dir>/<boxId>/index.json          { clips: [{ file, label, at, heard }] }, oldest first
 *   <dir>/<boxId>/checks.json         { days: { 'YYYY-MM-DD': { real, false } } }, the last DAYS_KEPT days
 *   <dir>/<boxId>/model.json          { installedAt, falsePerDayBefore, falsePerDayAfter }: the model in use
 *   <dir>/<boxId>/improve-asked       { at }: "Improve now" was asked; the trainer (phase 2) takes it away
 *
 * At most CLIPS_MAX clips or CLIPS_DAYS days per box, the oldest dropped first. Nothing of it leaves this
 * server.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { wavOf } from './boxes.mjs';

export const CLIPS_MAX = 500;
export const CLIPS_DAYS = 30;
export const RATE_DAYS = 7;
const DAYS_KEPT = 60;
const DAY = 86_400_000;
export const MODES = ['normal', 'learn'];
export const IMPROVE_FILE = 'improve-asked';

const BOX_ID = /^[0-9a-f-]{36}$/;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

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
        const keep = clips.filter((c) => Date.parse(c.at) >= since);
        while (keep.length > CLIPS_MAX) keep.shift();
        if (keep.length === clips.length) return clips;
        const kept = new Set(keep.map((c) => c.file));
        for (const c of clips) if (!kept.has(c.file)) rmSync(join(this.#of(id), c.file), { force: true });
        this.#write(id, 'index.json', { clips: keep });
        return keep;
    }

    /* One wake check of a box: counted always; its clip kept only when `keep` (the box learns). */
    checked(id, pcm, ok, { keep = false, heard = '' } = {}) {
        const now = this.#now();
        const checks = this.#read(id, 'checks.json', { days: {} });
        const days = checks.days && typeof checks.days === 'object' ? checks.days : {};
        const today = dayOf(now);
        const d = days[today] ?? { real: 0, false: 0 };
        d[ok ? 'real' : 'false']++;
        days[today] = d;
        const oldest = dayOf(now - DAYS_KEPT * DAY);
        for (const k of Object.keys(days)) if (k < oldest) delete days[k];
        this.#write(id, 'checks.json', { days });
        if (!keep) return null;
        const label = ok ? 'real' : 'false';
        mkdirSync(join(this.#of(id), label), { recursive: true });
        const stamp = new Date(now).toISOString().replace(/:/g, '-');
        let file = `${label}/${stamp}.wav`;
        for (let n = 2; existsSync(join(this.#of(id), file)); n++) file = `${label}/${stamp}-${n}.wav`;
        writeFileSync(join(this.#of(id), file), wavOf(pcm.subarray(0, pcm.length & ~1)));
        const clip = { file, label, at: new Date(now).toISOString(), heard: String(heard).slice(0, 40) };
        this.#write(id, 'index.json', { clips: [...this.#clips(id), clip] });
        this.#pruned(id, this.#clips(id));
        return clip;
    }

    /* False wakes a day over the last RATE_DAYS days (fewer when the box counts for less long). */
    falsePerDay(id) {
        const days = this.#read(id, 'checks.json', { days: {} }).days ?? {};
        const now = this.#now();
        const span = Array.from({ length: RATE_DAYS }, (_, i) => dayOf(now - i * DAY));
        const counted = Object.keys(days).sort();
        if (!counted.length) return 0;
        const first = counted[0];
        const within = span.filter((k) => k >= first);
        const sum = within.reduce((n, k) => n + (Number(days[k]?.false) || 0), 0);
        return Math.round((sum / Math.max(1, within.length)) * 10) / 10;
    }

    stats(id, mode = 'normal') {
        const clips = this.#pruned(id, this.#clips(id));
        const real = clips.filter((c) => c.label === 'real').length;
        const m = this.#read(id, 'model.json', null);
        const asked = this.#read(id, IMPROVE_FILE, null);
        return {
            mode: MODES.includes(mode) ? mode : 'normal',
            kept: clips.length, real, false: clips.length - real,
            oldest: clips[0]?.at ?? null,
            falsePerDay: this.falsePerDay(id),
            model: m && m.installedAt ? { installedAt: m.installedAt, falsePerDayBefore: m.falsePerDayBefore ?? null, falsePerDayAfter: m.falsePerDayAfter ?? null } : null,
            improveAsked: asked?.at ?? null,
        };
    }

    /* Every clip of the box gone; its counts and its model stay (they hold no sound). */
    erase(id) {
        const n = this.#clips(id).length;
        for (const label of ['real', 'false']) rmSync(join(this.#of(id), label), { recursive: true, force: true });
        rmSync(join(this.#of(id), 'index.json'), { force: true });
        return n;
    }

    /* The box withdrawn: nothing of it is kept. */
    forget(id) { rmSync(this.#of(id), { recursive: true, force: true }); }

    /* "Improve now": a request the trainer picks up (phase 2), a file it removes once done. */
    improve(id) { const at = new Date(this.#now()).toISOString(); this.#write(id, IMPROVE_FILE, { at }); return at; }

    /* A model put in place (phase 2): kept to compare. */
    installed(id, { before, after }) {
        const m = { installedAt: new Date(this.#now()).toISOString(), falsePerDayBefore: Number(before), falsePerDayAfter: Number(after) };
        this.#write(id, 'model.json', m);
        rmSync(join(this.#of(id), IMPROVE_FILE), { force: true });
        return m;
    }
}
