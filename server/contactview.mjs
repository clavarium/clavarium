/* AN ADDRESS BOOK, SEEN BY ITS OWNER (16-11): the contacts of a contacts asset (a Tether target of kind contacts:
 * Microsoft over Graph, Google or a classic book over CardDAV), shown in its asset panel, as the agenda is (agenda.mjs).
 *
 *   POST /api/tether/contacts   {target, text?}   the contacts, or those whose name or email matches (Tether's
 *                               contacts.search). -> { target, title, text, contacts: [{id, name, emails, phones,
 *                               company}], more, partial }
 *   POST /api/tether/contact    {target, id}      one contact. -> { target, id, name, emails, phones, company,
 *                               facts: [[word, value]], notes, partial }
 *
 * READ THROUGH TETHER, as an agent's contacts-list is: the sign-in stays in this server, never in the answer, never
 * in the browser; the read is the owner's own in Tether's journal, never an agent's. READ ONLY. Nothing is kept here.
 *
 * A Tether that hands its contacts as data (`data.contacts`, `data.contact`: the fields below) gives them all; one that
 * gives only its text lines (0.1.0-next.69) gives name, emails and phones in one line, no company: `partial`. */
import { Refusal } from './conversations.mjs';
import { handed } from './agenda.mjs';
import { READ_MS } from './mailview.mjs';

export const CONTACTS_MAX = 200;
export const SEARCH_MAX = 200;
export const NOTES_MAX = 4000;
const LINE_MAX = 400;
const refused = (status, kind, message) => Object.assign(new Refusal(status, message), { kind });
const line = (v, max = LINE_MAX) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const lines = (v, max = 20) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => line(x)).filter(Boolean).slice(0, max);

function bookOf(tethers, target) {
    if (!tethers) throw refused(503, 'unreachable', 'Address books are not reached from this server.');
    const t = tethers.store().target(String(target ?? ''));
    if (!t || t.kind !== 'contacts') throw refused(404, 'gone', 'No such address book.');
    return t;
}
async function asked(tethers, t, verb, args, who, wait) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), wait); timer.unref?.(); });
    let got;
    try { got = await Promise.race([tethers.read(verb, { target: t.id, ...args }, who), late]); }
    finally { clearTimeout(timer); }
    if (got === null) throw refused(504, 'late', `${t.title} did not answer in time. Try again.`);
    if (!got?.ok) throw refused(/no such contact/.test(String(got?.text)) ? 404 : 502, 'unreachable', `${t.title} could not be read: ${line(got?.text, 300) || 'no answer'}.`);
    return handed(got);
}

/* One contact Tether handed as data, kept to what the list shows. */
export function contactOf(c) {
    const id = line(c?.id, 2048);
    if (!id) return null;
    return { id, name: line(c.name) || '(no name)', emails: lines(c.emails ?? c.email), phones: lines(c.phones ?? c.phone), company: line(c.company) || null };
}
/* The text lines Tether's contacts-list and contacts-search say ("ID", then "  Name  <a, b>  tel 1 2"), read back.
   Its phones are joined by spaces, which a phone has too: they stay one line. */
export function contactsOfText(text) {
    const out = [];
    const all = String(text ?? '').split('\n');
    for (let i = 0; i < all.length; i++) {
        const head = all[i];
        if (!head || head.startsWith(' ') || head.startsWith('(') || /^No contact/.test(head)) continue;
        const next = all[i + 1] ?? '';
        if (!next.startsWith('  ') || next.startsWith('   ')) continue;
        i++;
        const m = /^ {2}(.*?)(?: {2}<([^>]*)>)?(?: {2}tel (.*))?$/.exec(next);
        out.push(contactOf({ id: head, name: m[1] === '(no name)' ? '' : m[1], emails: (m[2] ?? '').split(', '), phones: m[3] ? [m[3]] : [] }));
    }
    return out.filter(Boolean);
}
const cutSaid = (text) => /\((Showing the first|Looked at the first) \d+/.test(String(text ?? ''));

/* THE CONTACTS OF AN ADDRESS BOOK TARGET, or those matching `text`, read now. */
export async function readContacts(tethers, { target, text } = {}, { who, wait = READ_MS } = {}) {
    const t = bookOf(tethers, target);
    const q = line(text, SEARCH_MAX);
    const got = await asked(tethers, t, q ? 'contacts.search' : 'contacts.list', q ? { text: q } : {}, who, wait);
    const given = Array.isArray(got.data?.contacts);
    const all = (given ? got.data.contacts.map(contactOf).filter(Boolean) : contactsOfText(got.text))
        .sort((a, b) => a.name.localeCompare(b.name));
    const more = all.length > CONTACTS_MAX || got.data?.more === true || cutSaid(got.text);
    return { target: t.id, title: t.title, text: q, contacts: all.slice(0, CONTACTS_MAX), more, partial: !given };
}

/* ---------- one contact ---------- */
const notesOf = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, NOTES_MAX);
const vcardValue = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
/* The text Tether's contacts-read says, read back: the name, then "  email: x", "  tel (mobile): x", "  company: X, T",
   "  address (work): ...", "  birthday: ..."; then (Microsoft) its notes and "id: ..."; (CardDAV) its vCard, of
   which only the company, title and note are kept. */
export function contactOfText(text, id) {
    const all = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const c = { id, name: all[0] === '(no name)' ? '' : all[0] ?? '', emails: [], phones: [], company: '', facts: [], notes: '' };
    let i = 1;
    for (; i < all.length && all[i].startsWith('  '); i++) {
        const kv = /^ {2}([a-z]+)(?: \(([^)]*)\))?: (.*)$/.exec(all[i]);
        if (!kv) continue;
        const [, k, kind, v] = kv;
        if (k === 'email') c.emails.push(v);
        else if (k === 'tel') c.phones.push(kind ? `${v} (${kind})` : v);
        else if (k === 'company') c.company = v;
        else c.facts.push([kind ? `${k} (${kind})` : k, v]);
    }
    const rest = all.slice(i).join('\n').trim();
    if (/^BEGIN:VCARD/i.test(rest)) {
        const card = rest.replace(/\n[ \t]/g, '');
        const one = (name) => { const m = new RegExp(`^${name}[^:\\n]*:(.*)$`, 'im').exec(card); return m ? vcardValue(m[1].trim()) : ''; };
        const org = one('ORG').split(';').filter(Boolean).join(', ');
        if (org) c.company = org;
        const title = one('TITLE'); if (title) c.facts.push(['title', title]);
        c.notes = one('NOTE');
    } else c.notes = rest.replace(/\n*id: \S+$/, '');
    return c;
}
/* ONE CONTACT OF AN ADDRESS BOOK TARGET, read now: its fields as text. */
export async function readContact(tethers, { target, id } = {}, { who, wait = READ_MS } = {}) {
    const t = bookOf(tethers, target);
    const cid = String(id ?? '').trim();
    if (!cid || cid.length > 2048 || /[\s\0]/.test(cid)) throw refused(400, 'bad-contact', 'No such contact.');
    const got = await asked(tethers, t, 'contacts.read', { id: cid }, who, wait);
    const given = got.data?.contact && typeof got.data.contact === 'object';
    const c = given ? got.data.contact : contactOfText(got.text, cid);
    const facts = (Array.isArray(c.facts) ? c.facts : []).filter((f) => Array.isArray(f) && f[1]).map(([k, v]) => [line(k, 60), line(v, 1000)]).slice(0, 40);
    if (given) for (const k of ['title', 'birthday']) if (c[k]) facts.push([k, line(c[k], 1000)]);
    if (given) for (const a of lines(c.addresses, 5)) facts.push(['address', a]);
    return { target: t.id, id: cid, name: line(c.name) || '(no name)', emails: lines(c.emails), phones: lines(c.phones), company: line(c.company) || null, facts, notes: notesOf(c.notes), partial: !given };
}
