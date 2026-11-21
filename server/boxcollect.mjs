/* A COLLECT SESSION (07-11): a box's false wakes gathered on purpose, to train its next wake-word model (v3).
 *
 * For a set time (an empty home: the owner's go), each time the box listens nothing goes to its conversation and
 * nothing is answered: the wake clip (wake.clip: the exact 1.6 s the box sends, 16 kHz 16-bit mono) and the first
 * seconds after it are kept here, with one line of what is known -- no one labels them, no one listens:
 *
 *   <dir>/<YYYY-MM-DD>/<n>.wav          the wake clip, as sent (UTC day)
 *   <dir>/<YYYY-MM-DD>/<n>-suite.wav    the next AFTER_MAX seconds at most (a radio: more of the same)
 *   <dir>/<YYYY-MM-DD>/index.jsonl      { n, at, box, tag, reason, score, heard, word, voice, end, station, clip, after }
 *   <dir>/state.json                    { <boxId>: { from, until, tag, after, radio, volume, station, ... } }
 *   <dir>/ended.json                    { <boxId>: the last session, ended (shown on the box's card: « Exporter ») }
 *
 * RADIO (optional): the box asks the Google Home beside it, aloud, for one French station after another
 * (« Ok Google, mets France Inter »), every `every` minutes, and « Ok Google, stop » at the end. No wake for
 * QUIET_WARN_MS after a station was asked: said in the log (the speaker may not have obeyed).
 *
 * Off by itself at its end time, at COUNT_MAX entries or BYTES_MAX bytes on disk. Started and stopped by the
 * operator only (/api/boxes/<id>/collect, behind the sign-on), never by a tool. exportZip(): the clips, laid out
 * as the training notebook (v2, cell 7 bis) takes its negative examples: folders of 16 kHz WAV.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './conversations.mjs';
import { wavOf } from './boxes.mjs';

export const COUNT_MAX = 1500;
export const BYTES_MAX = 300 * 1024 * 1024;
export const AFTER_DEFAULT = 8;
export const AFTER_MAX = 30;
export const HOURS_MAX = 12;
export const EVERY_DEFAULT = 60;
export const QUIET_WARN_MS = 20 * 60_000;
export const GRACE_MS = 5 * 60_000;
export const VOLUME_DEFAULT = 4;    /* the Google Home's own scale, 0-10: a radio heard across the room, not loud */
/* French talk and music stations, as a Google Home knows them by name. */
export const STATIONS = ['France Inter', 'France Info', 'RTL', 'Europe 1', 'France Culture', 'Nostalgie', 'FIP', 'RMC'];
export const TAG = /^[a-z0-9-]{1,20}$/;
const BOX_ID = /^[0-9a-f-]{36}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const timeOf = (v) => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : NaN; };

export const stationPhrase = (name) => `Ok Google, mets ${name}`;
export const volumePhrase = (level) => `Ok Google, mets le volume à ${level}`;
export const STOP_PHRASE = 'Ok Google, stop';

export class BoxCollect {
    #dir; #now; #log; #state; #countMax; #bytesMax; #usage = null; #next = new Map(); #ended = {};

    constructor({ dir, now = () => Date.now(), log = () => {}, countMax = COUNT_MAX, bytesMax = BYTES_MAX }) {
        this.#dir = dir; this.#now = now; this.#log = log; this.#countMax = countMax; this.#bytesMax = bytesMax;
        try { this.#state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); } catch { this.#state = {}; }
        if (!this.#state || typeof this.#state !== 'object') this.#state = {};
        try { this.#ended = JSON.parse(readFileSync(join(dir, 'ended.json'), 'utf8')) ?? {}; } catch { this.#ended = {}; }
    }

    #save() {
        mkdirSync(this.#dir, { recursive: true });
        const file = join(this.#dir, 'state.json');
        writeFileSync(`${file}.tmp`, JSON.stringify(this.#state, null, 1)); renameSync(`${file}.tmp`, file);
    }

    /* What is on disk, counted once, then kept up to date. */
    #used() {
        if (this.#usage) return this.#usage;
        let count = 0; let bytes = 0;
        for (const day of existsSync(this.#dir) ? readdirSync(this.#dir).filter((d) => DAY.test(d)) : []) {
            for (const f of readdirSync(join(this.#dir, day))) {
                try { bytes += statSync(join(this.#dir, day, f)).size; } catch { /* gone meanwhile */ }
                if (/^\d+\.wav$/.test(f)) count++;
            }
        }
        this.#usage = { count, bytes };
        return this.#usage;
    }

    /* {from?, until, tag?, after?, radio?, every?, volume?, stations?} -> the state. */
    start(boxId, body = {}) {
        if (!BOX_ID.test(String(boxId))) throw new Refusal(400, 'Not a box id.');
        const now = this.#now();
        const from = body.from == null ? now : timeOf(body.from);
        const until = timeOf(body.until);
        if (!Number.isFinite(from) || !Number.isFinite(until)) throw new Refusal(400, 'An end time, please (until: ISO date).');
        if (until <= Math.max(now, from)) throw new Refusal(400, 'The end time is already past.');
        if (until - Math.max(now, from) > HOURS_MAX * 3_600_000) throw new Refusal(400, `${HOURS_MAX} hours at most.`);
        const tag = String(body.tag ?? 'radio');
        if (!TAG.test(tag)) throw new Refusal(400, 'A tag of a-z, 0-9 and -, 20 characters at most.');
        const after = Math.round(Number(body.after ?? AFTER_DEFAULT));
        if (!Number.isFinite(after) || after < 0 || after > AFTER_MAX) throw new Refusal(400, `after: 0 to ${AFTER_MAX} seconds.`);
        const every = Math.round(Number(body.every ?? EVERY_DEFAULT));
        if (!Number.isFinite(every) || every < 10 || every > 240) throw new Refusal(400, 'every: 10 to 240 minutes.');
        const volume = Math.round(Number(body.volume ?? VOLUME_DEFAULT));
        if (!Number.isFinite(volume) || volume < 1 || volume > 10) throw new Refusal(400, 'volume: 1 to 10 (the speaker\'s scale).');
        const stations = Array.isArray(body.stations) && body.stations.length
            ? body.stations.map((s) => String(s).replace(/[^\p{L}\p{N} '-]/gu, '').trim().slice(0, 40)).filter(Boolean).slice(0, 12)
            : STATIONS;
        if (!stations.length) throw new Refusal(400, 'No station.');
        this.#state[boxId] = {
            from: new Date(from).toISOString(), until: new Date(until).toISOString(), tag, after, radio: body.radio === true,
            every, volume, stations, startedAt: new Date(now).toISOString(),
            station: null, stationAt: null, stationIndex: -1, volumeSaid: false, lastWakeAt: null, warnedAt: null,
            kept: 0, wakes: 0, answers: [], warnings: [],
        };
        this.#save();
        this.#log(`voice box ${boxId.slice(0, 8)}: collect on (${tag}) until ${new Date(until).toISOString()}${body.radio === true ? ', radio' : ''}`);
        return this.state(boxId);
    }

    /* Off: by the operator, at its end, or full. Returns what was on (to say « stop » to the speaker), or null. */
    stop(boxId, why = 'asked') {
        const s = this.#state[boxId];
        if (!s) return null;
        delete this.#state[boxId]; this.#save();
        this.#log(`voice box ${String(boxId).slice(0, 8)}: collect off (${why}), ${s.kept} kept`);
        this.#ended = { ...this.#ended, [boxId]: { ...s, endedAt: new Date(this.#now()).toISOString(), why } };
        try { writeFileSync(join(this.#dir, 'ended.json'), JSON.stringify(this.#ended)); } catch { /* shown until a restart only */ }
        return s;
    }

    /* On now: begun, not yet ended. With the radio, GRACE_MS more: the radio plays until the box has told the
       speaker to stop (the clock waits for a box busy listening), and its wakes must not reach the AI meanwhile. */
    on(boxId) {
        const s = this.#state[boxId];
        if (!s) return false;
        const now = this.#now();
        return now >= Date.parse(s.from) && now < Date.parse(s.until) + (s.radio ? GRACE_MS : 0);
    }

    state(boxId) {
        const s = this.#state[boxId]; const u = this.#used();
        if (!s) return { on: false, last: this.#ended[boxId] ?? null, count: u.count, bytes: u.bytes };
        return { on: this.on(boxId), ...s, count: u.count, bytes: u.bytes, countMax: this.#countMax, bytesMax: this.#bytesMax };
    }

    /* One listen of the box, during a session: kept (wake, button, knock), or null when full or off. */
    keep(boxId, { clip = null, after = Buffer.alloc(0), reason = '', score = null, heard = null, word = null, voice = null, end = '' } = {}) {
        const s = this.#state[boxId];
        if (!s || !this.on(boxId)) return null;
        const now = this.#now();
        if (reason === 'wake') { s.wakes++; s.lastWakeAt = new Date(now).toISOString(); }
        const u = this.#used();
        const tail = after.subarray(0, (s.after * 32_000) & ~1);
        const size = (clip?.length ? clip.length + 44 : 0) + (tail.length ? tail.length + 44 : 0);
        if (u.count >= this.#countMax || u.bytes + size > this.#bytesMax) { this.#save(); return null; }
        const day = dayOf(now); const dir = join(this.#dir, day);
        mkdirSync(dir, { recursive: true });
        const n = this.#nextOf(day);
        const line = {
            n, at: new Date(now).toISOString(), box: boxId, tag: s.tag, reason: String(reason).slice(0, 12),
            score: Number.isFinite(score) ? score : null, heard: heard == null ? null : String(heard).slice(0, 200),
            word: typeof word === 'boolean' ? word : null, voice: Number.isFinite(voice) && voice > 0 ? Math.round(voice) : null,
            end: String(end).slice(0, 12), station: s.radio ? s.station : null, clip: null, after: null,
        };
        if (clip?.length) { writeFileSync(join(dir, `${n}.wav`), wavOf(clip)); line.clip = `${n}.wav`; }
        if (tail.length) { writeFileSync(join(dir, `${n}-suite.wav`), wavOf(tail)); line.after = `${n}-suite.wav`; }
        appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(line)}\n`);
        u.count++; u.bytes += size; s.kept++;
        this.#save();
        return line;
    }
    #nextOf(day) {
        if (!this.#next.has(day)) {
            let n = 0;
            try { for (const l of readFileSync(join(this.#dir, day, 'index.jsonl'), 'utf8').split('\n')) { try { n = Math.max(n, JSON.parse(l).n); } catch { /* a torn line */ } } } catch { /* a new day */ }
            this.#next.set(day, n);
        }
        const n = this.#next.get(day) + 1; this.#next.set(day, n);
        return n;
    }
    full() { const u = this.#used(); return u.count >= this.#countMax || u.bytes >= this.#bytesMax - 400_000; }   /* no room for one more (a clip and AFTER_DEFAULT s) */

    /* What the speaker answered when asked for a station (the box listened after it spoke). */
    answered(boxId, text) {
        const s = this.#state[boxId]; if (!s) return;
        s.answers = [...s.answers, { at: new Date(this.#now()).toISOString(), station: s.station, text: String(text).slice(0, 120) }].slice(-20);
        this.#save();
    }

    /* THE CLOCK (every half minute): what is due now, for one box -- { end } | { say, station? } | { warn } | null.
       online: the box is connected; busy: it is listening now (a phrase then waits for the next tick). */
    due(boxId, { online = true, busy = false } = {}) {
        const s = this.#state[boxId];
        if (!s) return null;
        const now = this.#now();
        if (this.full()) return { end: 'full', radio: s.radio };
        if (now >= Date.parse(s.until) && (!busy || !online || now >= Date.parse(s.until) + GRACE_MS - 60_000)) return { end: 'time', radio: s.radio };
        if (now >= Date.parse(s.until)) return null;
        if (!s.radio || !online || busy || now < Date.parse(s.from)) return null;
        if (!s.volumeSaid) { s.volumeSaid = true; this.#save(); return { say: volumePhrase(s.volume) }; }
        if (s.stationIndex < 0 || now - Date.parse(s.stationAt) >= s.every * 60_000) {
            s.stationIndex = (s.stationIndex + 1) % s.stations.length;
            s.station = s.stations[s.stationIndex]; s.stationAt = new Date(now).toISOString(); s.warnedAt = null;
            this.#save();
            return { say: stationPhrase(s.station), station: s.station };
        }
        const quietSince = Math.max(Date.parse(s.stationAt), Date.parse(s.lastWakeAt ?? '') || 0);
        if (!s.warnedAt && now - quietSince >= QUIET_WARN_MS) {
            s.warnedAt = new Date(now).toISOString();
            const text = `no wake for ${Math.round((now - quietSince) / 60_000)} min since ${s.station} was asked: the Google Home may not have obeyed`;
            s.warnings = [...s.warnings, { at: s.warnedAt, station: s.station, text }].slice(-20);
            this.#save();
            return { warn: text };
        }
        return null;
    }
    boxes() { return Object.keys(this.#state); }

    /* THE EXPORT: one zip, laid out for the training notebook (v2, cell 7 bis: a folder of 16 kHz WAV per source):
         <tag>/<day>-<n>.wav          the wake clips (1.6 s): the hard negatives
         <tag>_suite/<day>-<n>.wav    what came after them: more negative speech and music
         index.csv                    file, at, reason, score, heard, word, voice, end, station
         LISEZMOI.txt                 how the notebook takes them
       Only the box's wakes (not a button or a knock) of that tag; days: all, or those given. */
    exportZip({ tag = 'radio', days = null } = {}) {
        if (!TAG.test(String(tag))) throw new Refusal(400, 'Not a tag.');
        const files = []; const rows = [['file', 'suite', 'at', 'reason', 'score', 'heard', 'word', 'voice', 'end', 'station'].join(',')];
        const wanted = Array.isArray(days) && days.length ? new Set(days.filter((d) => DAY.test(String(d)))) : null;
        const csv = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        for (const day of existsSync(this.#dir) ? readdirSync(this.#dir).filter((d) => DAY.test(d) && (!wanted || wanted.has(d))).sort() : []) {
            let lines = [];
            try { lines = readFileSync(join(this.#dir, day, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { continue; }
            for (const l of lines) {
                if (l.tag !== tag || l.reason !== 'wake' || !l.clip) continue;
                const name = `${day}-${l.n}.wav`;
                try { files.push({ name: `${tag}/${name}`, data: readFileSync(join(this.#dir, day, l.clip)) }); } catch { continue; }
                let suite = '';
                if (l.after) { try { files.push({ name: `${tag}_suite/${name}`, data: readFileSync(join(this.#dir, day, l.after)) }); suite = `${tag}_suite/${name}`; } catch { /* the clip alone */ } }
                rows.push([`${tag}/${name}`, suite, l.at, l.reason, l.score, l.heard, l.word, l.voice, l.end, l.station].map(csv).join(','));
            }
        }
        files.push({ name: 'index.csv', data: Buffer.from(`${rows.join('\n')}\n`) });
        files.push({ name: 'LISEZMOI.txt', data: Buffer.from(readme(tag, rows.length - 1)) });
        return { zip: zipOf(files, this.#now()), clips: rows.length - 1 };
    }
}

const readme = (tag, n) => `${n} faux réveils du boîtier (session « ${tag} »), sans étiquetage : personne à la maison, tout réveil est un faux.

${tag}/        les 1,6 s qui ont réveillé le boîtier (wav 16 kHz, 16 bits, mono) : les contre-exemples durs
${tag}_suite/  les secondes d'après (même format) : de la radio française en plus
index.csv     score d'éveil, réécoute du serveur (word = le mot entendu), niveau de voix, station

Dans le carnet v2 (cellule 7 bis) :
1. décompresser ce zip dans /content ;
2. ajouter à la boucle c) : ('${tag}', 'negative_datasets/${tag}'), ('${tag}_suite', 'negative_datasets/${tag}_suite') ;
3. ajouter à config["features"] (cellule 8) deux entrées « truth: False, truncation_strategy: random »,
   ${tag} avec penalty_weight 2.0 (comme near_words), ${tag}_suite avec sampling_weight 6.0.
`;

/* A ZIP, stored (WAV does not compress): enough for a few hundred megabytes, no dependency. */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipOf(files, at = Date.now()) {
    const d = new Date(at);
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const parts = []; const central = []; let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8'); const crc = crc32(f.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
        local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
        c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24);
        c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
        parts.push(local, name, f.data); central.push(c, name);
        offset += 30 + name.length + f.data.length;
    }
    const size = central.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...central, end]);
}
