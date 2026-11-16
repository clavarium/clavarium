/* A MAILBOX, SEEN BY ITS OWNER (16-11): the latest messages of a mailbox asset (a Tether target of kind mail:
 * Microsoft over Graph, Google or a classic box over IMAP), shown in its asset panel, as the agenda is (agenda.mjs).
 *
 *   POST /api/tether/mail-list   {target, folder?, text?}   the newest messages of a folder (inbox by default), or
 *                                those whose text matches (Tether's mail.search). -> { target, title, folder, text,
 *                                folders, messages: [...], more, partial }
 *   POST /api/tether/mail-read   {target, id, folder?}      one message, as text. -> { target, id, ref, from, to, cc,
 *                                date, subject, text, attachments: [{name, type, size}], cut, partial }
 *
 * READ THROUGH TETHER, as an agent's mail-list is: the same connector, the same sign-in -- which stays in this server,
 * never in the answer, never in the browser. The read is the owner's own in Tether's journal, never an agent's, never
 * asked of anyone. Nothing is kept here.
 *
 * NEVER MARKED READ: Tether reads with EXAMINE and BODY.PEEK over IMAP, a GET over Graph -- as the mail viewer's
 * mail.open (mailref.mjs). READ ONLY: nothing is moved, flagged or sent.
 *
 * TEXT ONLY: a message's words come as text from Tether (its HTML made text there); one still in HTML here is made
 * text again. Attachments are named with their size, never opened. Pictures are never loaded.
 *
 * A Tether that hands its messages as data (`data.messages`, `data.message`: the fields below) gives them all; one
 * that gives only its text lines (0.1.0-next.69) gives who, subject, date, and no unread or attachment mark: the
 * answer says `partial`. */
import { Refusal } from './conversations.mjs';

export const MESSAGES_MAX = 25;
export const READ_MS = 30_000;
export const TEXT_MAX = 100_000;        /* a message's words shown at most */
export const SEARCH_MAX = 200;
/* The folders offered: Graph knows them by these words; an IMAP box names its own, so only its inbox is offered. */
export const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'];
const LINE_MAX = 400;
const refused = (status, kind, message) => Object.assign(new Refusal(status, message), { kind });
const line = (v, max = LINE_MAX) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/* ---------- a target, a folder ---------- */
export function boxOf(tethers, target) {
    if (!tethers) throw refused(503, 'unreachable', 'Mailboxes are not reached from this server.');
    const t = tethers.store().target(String(target ?? ''));
    if (!t || t.kind !== 'mail') throw refused(404, 'gone', 'No such mailbox.');
    return t;
}
/* Microsoft over Graph: the folders by their common words. Else (IMAP): the inbox alone. */
export const foldersOf = (t) => (String(t?.config?.provider ?? '') === 'microsoft' ? FOLDERS : ['inbox']);
export function folderOf(t, folder) {
    const f = String(folder ?? '').trim().toLowerCase() || 'inbox';
    if (!foldersOf(t).includes(f)) throw refused(400, 'bad-folder', 'No such folder here.');
    return f;
}
/* What Tether is given: the inbox is the mailbox's own (its config may name another); Graph takes the other words. */
const mailboxArg = (f) => (f === 'inbox' ? {} : { mailbox: f });

/* ---------- times ---------- */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/* An instant as ISO (UTC): Graph's ISO times, IMAP's INTERNALDATE ("16-Nov-2026 09:30:00 +0100"), a Date header. */
export function dateOf(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const imap = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
    if (imap) {
        const [, d, mon, y, h, mi, se, sign, oh, om] = imap;
        const m = MONTHS[mon.toLowerCase()];
        if (!m) return null;
        const off = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
        return new Date(Date.UTC(Number(y), m - 1, Number(d), Number(h), Number(mi), Number(se)) - off * 60_000).toISOString();
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/* ---------- words, as text ---------- */
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
/* HTML made text: what runs or draws dropped, line breaks kept, the rest of the tags taken away, entities read. */
export function textOfHtml(html) {
    return String(html ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\s*(script|style|head|title|template|svg|object|iframe)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, e) => ENTITIES[e.toLowerCase()])
        .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
        .replace(/[ \t\u00a0]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const looksHtml = (s) => /<\s*(html|body|div|table|p|br|span|img|a)\b[^>]*>/i.test(s);
/* A message's words: text, control characters dropped, lines kept, short enough. Still HTML: made text. */
export function wordsOf(v) {
    let s = String(v ?? '').replace(/\r\n?/g, '\n');
    if (looksHtml(s)) s = textOfHtml(s);
    s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: s.slice(0, TEXT_MAX), cut: s.length > TEXT_MAX };
}

/* ---------- a list ---------- */
const markOf = (v) => (v === true || v === false ? v : null);
/* One message Tether handed as data, kept to what the page shows. */
export function messageOf(m) {
    const id = line(m?.id ?? m?.uid, 2048);
    if (!id) return null;
    const n = Number(m.attachments);
    return {
        id, ref: line(m.ref, 2048) || null, from: line(m.from), subject: line(m.subject) || '(no subject)', date: dateOf(m.date),
        unread: markOf(m.unread), attachments: Array.isArray(m.attachments) ? m.attachments.length > 0 : m.attachments === true || m.attachments === false ? m.attachments : Number.isInteger(n) ? n > 0 : null,
    };
}
/* The text lines Tether's mail-list and mail-search say, read back. IMAP: "#uid  date" then "  From:", "  Subject:",
   "  ref:"; Graph: "#id", then "  date", "  From:", "  Subject:", "  ref:". */
export function messagesOfText(text) {
    const out = [];
    let at = null;
    for (const raw of String(text ?? '').split('\n')) {
        const head = /^#(\S+)(?: {2}(.*))?$/.exec(raw);
        if (head) { at = { id: head[1], date: head[2] ?? '' }; out.push(at); continue; }
        if (!at || !raw.startsWith('  ')) { if (raw.trim()) at = null; continue; }
        const l = raw.slice(2);
        const kv = /^(From|Subject|ref): ?(.*)$/.exec(l);
        if (kv) at[kv[1].toLowerCase()] = kv[2];
        else if (!at.date) at.date = l;
    }
    return out.map(messageOf).filter(Boolean);
}
const said = (text) => String(text ?? '');
const cutSaid = (text) => /\(Showing the (first )?\d+ most recent/.test(said(text));

/* Tether asked, waited for at most `wait`: its answer, or a refusal in plain words. */
async function asked(tethers, t, verb, args, who, wait) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), wait); timer.unref?.(); });
    let got;
    try { got = await Promise.race([tethers.read(verb, { target: t.id, ...args }, who), late]); }
    finally { clearTimeout(timer); }
    if (got === null) throw refused(504, 'late', `${t.title} did not answer in time. Try again.`);
    if (!got?.ok) throw refused(got?.code === 'gone' ? 404 : 502, got?.code === 'gone' ? 'gone' : 'unreachable', `${t.title} could not be read: ${line(got?.text, 300) || 'no answer'}.`);
    return got;
}

/* THE LATEST MESSAGES OF A MAILBOX TARGET, or those matching `text`, read now. `who`: { id, name }, said in Tether's
   journal. */
export async function readMailList(tethers, { target, folder, text } = {}, { who, wait = READ_MS } = {}) {
    const t = boxOf(tethers, target);
    const f = folderOf(t, folder);
    const q = line(text, SEARCH_MAX);
    const got = await asked(tethers, t, q ? 'mail.search' : 'mail.list', q ? { text: q, ...mailboxArg(f) } : mailboxArg(f), who, wait);
    const given = Array.isArray(got.data?.messages);
    const all = (given ? got.data.messages.map(messageOf).filter(Boolean) : messagesOfText(got.text))
        .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    const more = all.length > MESSAGES_MAX || got.data?.more === true || cutSaid(got.text);
    return { target: t.id, title: t.title, folder: f, text: q, folders: foldersOf(t), messages: all.slice(0, MESSAGES_MAX), more, partial: !given };
}

/* ---------- one message ---------- */
const attachmentOf = (a) => {
    const name = line(a?.name, 300);
    if (!name) return null;
    const n = Number(a.size);
    return { name, type: line(a.type, 100) || null, size: Number.isFinite(n) && n >= 0 ? Math.round(n) : null };
};
/* "name (type, N KB)" or "name (type, ~N KB)", as Tether's mail-read lists them. */
const attachmentOfText = (l) => {
    const m = /^\s*(?:- )?(.*?) \(([^,()]*), ~?(\d+) KB\)\s*$/.exec(l);
    return m ? attachmentOf({ name: m[1], type: m[2], size: Number(m[3]) * 1024 }) : null;
};
/* The text Tether's mail-read says, read back: "ref:", the head (From, To, Cc, Date, Subject), a blank line, the words,
   then an invitation, then "Attachments:" (Graph) or "--- Attachments (n) ---" (IMAP), then a cut said last. */
export function messageOfText(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const head = {};
    let i = 0;
    for (; i < lines.length; i++) {
        const kv = /^(ref|From|To|Cc|Date|Subject): ?(.*)$/.exec(lines[i]);
        if (!kv) break;
        head[kv[1].toLowerCase()] = kv[2];
    }
    if (lines[i] === '') i++;
    let body = lines.slice(i);
    let cut = false;
    while (body.length && !body.at(-1).trim()) body.pop();
    if (/^\(Large message/.test(body.at(-1) ?? '')) { cut = true; body.pop(); }
    const attachments = [];
    const mark = body.findIndex((l) => /^(Attachments:|--- Attachments \(\d+\) ---)$/.test(l));
    if (mark >= 0) {
        for (const l of body.slice(mark + 1)) { const a = attachmentOfText(l); if (a) attachments.push(a); }
        body = body.slice(0, mark);
        while (body.length && !body.at(-1).trim()) body.pop();
    }
    return { ...head, text: body.join('\n'), attachments, cut };
}
/* ONE MESSAGE OF A MAILBOX TARGET, read now, as text. `id`: its number (IMAP uid) or Graph's id, as the list gave it;
   `folder`: the one it was listed in. */
export async function readMail(tethers, { target, id, folder } = {}, { who, wait = READ_MS } = {}) {
    const t = boxOf(tethers, target);
    const f = folderOf(t, folder);
    const uid = String(id ?? '').trim();
    if (!uid || uid.length > 1024 || /[\s\0]/.test(uid)) throw refused(400, 'bad-message', 'No such message.');
    const got = await asked(tethers, t, 'mail.read', { uid, ...mailboxArg(f) }, who, wait);
    const given = got.data?.message && typeof got.data.message === 'object';
    const m = given ? got.data.message : messageOfText(got.text);
    const words = wordsOf(m.text ?? m.body);
    return {
        target: t.id, id: uid, ref: line(m.ref, 2048) || null, from: line(m.from), to: line(m.to, 2000), cc: line(m.cc, 2000),
        date: dateOf(m.date), subject: line(m.subject) || '(no subject)', text: words.text,
        attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(attachmentOf).filter(Boolean).slice(0, 100),
        cut: words.cut || m.cut === true, partial: !given,
    };
}
