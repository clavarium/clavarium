/* A CALENDAR, SEEN BY ITS OWNER (16-11): the agenda of a calendar asset (a Tether target of kind calendar), shown
 * in its asset panel, so Outlook need not stay open beside Clavarium.
 *
 *   POST /api/tether/agenda   {target, from?, to?}   from/to: days (YYYY-MM-DD), in the calendar's zone; to is
 *                             not in the window. Default: today and the next 7 days. -> { target, title, zone,
 *                             from, to, events: [...], more, partial }
 *
 * READ THROUGH TETHER, as an agent's calendar-list is: the same connector, the same sign-in -- which stays in this
 * server (the keeper reveals it to the connector alone), never in the answer, never in the browser. The read is the
 * owner's own in Tether's journal (keeper read, as a mail opened by its reference: mailref.mjs), never an agent's,
 * never asked of anyone. Nothing is kept here.
 *
 * EACH EVENT: { id, title, start, end, allDay, location, organizer, online, attendees, show }. Times are the
 * calendar's wall clock (Europe/Paris, Tether's zone): 'YYYY-MM-DDTHH:MM', or 'YYYY-MM-DD' all day.
 * A Tether that hands its events as data (`data.events`, the same fields) gives them all; one that gives only its
 * text lines (0.1.0-next.67) gives id, start, title and place: the answer says `partial`. */
import { Refusal } from './conversations.mjs';

/* Tether's own zone (connectors/calendar.mjs TZ): its times are said in it. */
export const ZONE = 'Europe/Paris';
export const EVENTS_MAX = 200;
export const DAYS_DEFAULT = 7;          /* one week from today: the pages follow each other, no day twice */
export const DAYS_MAX = 42;             /* six weeks at most in one read */
export const READ_MS = 30_000;
const TEXT_MAX = 400;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const refused = (status, kind, message) => Object.assign(new Refusal(status, message), { kind });

/* ---------- days, in the calendar's zone ---------- */
const partsAt = (ms, zone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
/* The day it is now there: 'YYYY-MM-DD'. */
export function todayIn(zone = ZONE, now = Date.now()) {
    const p = partsAt(now, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
/* A day plus n days. */
export function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/* The instant a day starts there (its midnight), as an ISO time: a summer or winter hour made right. */
export function startOf(day, zone = ZONE) {
    const [y, m, d] = day.split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d);
    let at = wall;
    for (let i = 0; i < 2; i++) {
        const p = partsAt(at, zone);
        at -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wall;
    }
    return new Date(at).toISOString();
}
const isDay = (s) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/* The window asked, checked: days, from before to, six weeks at most. */
export function windowOf({ from, to } = {}, { zone = ZONE, now = Date.now() } = {}) {
    const f = from === undefined || from === null || from === '' ? todayIn(zone, now) : String(from);
    if (!isDay(f)) throw refused(400, 'bad-window', 'The first day is not a date (YYYY-MM-DD).');
    const t = to === undefined || to === null || to === '' ? addDays(f, DAYS_DEFAULT) : String(to);
    if (!isDay(t)) throw refused(400, 'bad-window', 'The last day is not a date (YYYY-MM-DD).');
    const days = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000;
    if (days < 1) throw refused(400, 'bad-window', 'The last day comes before the first.');
    if (days > DAYS_MAX) throw refused(400, 'bad-window', `${DAYS_MAX} days at most at once.`);
    return { from: f, to: t };
}

/* ---------- events ---------- */
const line = (v, max = TEXT_MAX) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
/* A time as the page reads it: 'YYYY-MM-DDTHH:MM', 'YYYY-MM-DD', or null. */
const timeOf = (v) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v ?? '').trim());
    return !m ? null : m[2] ? `${m[1]}T${m[2]}:${m[3]}` : m[1];
};
/* An online meeting's link: a web address, nothing else (never a script's). */
const linkOf = (v) => { try { const u = new URL(String(v ?? '')); return u.protocol === 'https:' ? u.href.slice(0, 2000) : null; } catch { return null; } };
const SHOW = { busy: 'busy', free: 'free', tentative: 'tentative', oof: 'away', away: 'away', workingelsewhere: 'elsewhere', elsewhere: 'elsewhere' };

/* One event Tether handed as data, kept to the fields the page shows. */
export function eventOf(e) {
    const start = timeOf(e?.start);
    if (!start) return null;
    const allDay = e.allDay === true || (start.length === 10 && e.allDay !== false);
    const n = Number(e.attendees);
    return {
        id: line(e.id, 2048), title: line(e.title) || '(no title)', start, end: timeOf(e.end), allDay,
        location: line(e.location), organizer: line(e.organizer, 320), online: linkOf(e.online),
        attendees: Number.isInteger(n) && n >= 0 ? n : null, show: SHOW[String(e.show ?? '').toLowerCase()] ?? null,
    };
}

/* The text lines Tether's calendar-list says (an id, then "  start — title  @ place  [categories]"), read back. */
export function eventsOfText(text) {
    const out = [];
    const lines = String(text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const head = lines[i];
        if (!head || head.startsWith(' ') || head.startsWith('(')) continue;
        const m = /^ {2}(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) — (.*)$/.exec(lines[i + 1] ?? '');
        if (!m) continue;
        i++;
        const [, title, location] = /^(.*?)(?: {2}@ (.*?))?(?: {2}\[[^\]]*\])?$/.exec(m[2]);
        const id = head.replace(/ {2}\(repeats:.*\)$/, '');
        out.push(eventOf({ id, title, start: m[1], location }));
    }
    return out.filter(Boolean);
}

/* THE AGENDA OF A CALENDAR TARGET, read now. `tethers`: Tethers (tethers.mjs). `who`: { id, name }, said in
   Tether's journal. `wait`: how long the calendar is waited for. */
export async function readAgenda(tethers, { target, from, to } = {}, { who, zone = ZONE, now = Date.now(), wait = READ_MS } = {}) {
    if (!tethers) throw refused(503, 'unreachable', 'Calendars are not reached from this server.');
    const t = tethers.store().target(String(target ?? ''));
    if (!t || t.kind !== 'calendar') throw refused(404, 'gone', 'No such calendar.');
    const w = windowOf({ from, to }, { zone, now });
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), wait); timer.unref?.(); });
    let got;
    try { got = await Promise.race([tethers.read('calendar.list', { target: t.id, from: startOf(w.from, zone), to: startOf(w.to, zone) }, who), late]); }
    finally { clearTimeout(timer); }
    if (got === null) throw refused(504, 'late', `${t.title} did not answer in time. Try again.`);
    if (!got?.ok) throw refused(502, 'unreachable', `${t.title} could not be read: ${line(got?.text, 300) || 'no answer'}.`);
    const given = Array.isArray(got.data?.events);
    const all = (given ? got.data.events.map(eventOf).filter(Boolean) : eventsOfText(got.text))
        .sort((a, b) => a.start.localeCompare(b.start));
    const more = all.length > EVENTS_MAX || got.data?.more === true || /\(Showing the first \d+ events/.test(String(got.text ?? ''));
    return { target: t.id, title: t.title, zone, from: w.from, to: w.to, events: all.slice(0, EVENTS_MAX), more, partial: !given };
}
