/* A TETHER CALL WAITING FOR THE OWNER, AS PLAIN DATA FOR PARLEY'S REQUEST CARD (05-11, "B enrichie").
 *
 * One sentence that says what will happen ("Send “Quote” to sales@example.com"), one or two key
 * facts, what should make one think (someone outside, a time already taken, administrator
 * rights), and, unfolded, the facts, before -> after, the first lines of the text. Parley draws it
 * (requestCard, docs/protocol.md "A request, as a card") wherever it is shown: in the thread
 * (tethers.mjs puts it on the line that asks) and in Assets › Demandes (GET /api/tether gives it
 * with each call). Built from `q.card`, the facts Tether attaches (server/cards.mjs), and
 * `q.card.about`, what the act is about when its connector can tell (the event before a change).
 *
 * IRREVERSIBLE (an amber edge, unfolded when newest, never in "Accept all"): a mail that leaves
 * the owner's domain (not a draft), any delete, a change or delete of an event others are invited
 * to, a command run on a machine. The accept waits HOLD_S seconds with Undo before it is sent to
 * Tether (the page holds it; Tether has no undo once decided). */
export const HOLD_S = 5;
const KINDS = new Set(['mail', 'calendar', 'contacts', 'files', 'terminal', 'browser', 'screen', 'device']);

const hhmm = (when) => /[T ](\d{2}:\d{2})/.exec(String(when ?? ''))?.[1] ?? '';
const dayWords = (when) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(when ?? '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : String(when ?? ''); };
const span = (from, to) => [hhmm(from), hhmm(to)].filter(Boolean).join('–');
const whenWords = (from, to) => [dayWords(from), span(from, to)].filter(Boolean).join(' · ');
const nameOfAddr = (a) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(String(a ?? '')); return m && m[1] ? m[1] : String(a ?? '').split('@')[0]; };
const subj = (s) => (s ? `“${s}”` : 'a message');
const sizeOf = (kb) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);
const filesLine = (files) => (files?.length ? files.map((f) => `${f.name}${f.kb ? ` (${sizeOf(f.kb)})` : ''}`).join(', ') : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/* Whom: the first, and how many more. */
const whom = (list) => (list.length ? `${list[0]}${list.length > 1 ? ` +${list.length - 1}` : ''}` : '');
/* The body as it will read: the Markdown marks taken off. */
const plain = (body) => String(body ?? '').replace(/\*\*(\S[^*\n]*?)\*\*/g, '$1').replace(/__(\S[^_\n]*?)__/g, '$1').replace(/(^|[^*\w])\*(\S[^*\n]*?)\*(?!\w)/g, '$1$2')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)').replace(/^#{1,6}\s+/gm, '');

export function demandeView(q) {
    const c = q?.card ?? {}; const about = c.about ?? {};
    const kind = KINDS.has(c.kind) ? c.kind : 'other';
    const own = String(c.self ?? '').split('@')[1] ?? '';
    const outside = (list) => (own ? (list ?? []).filter((x) => !String(x).toLowerCase().endsWith(`@${own}`)) : []);
    const chips = (list, ext = []) => (list ?? []).map((x) => ({ text: String(x), ...(ext.includes(x) ? { ext: true } : {}) }));
    const where = q?.target?.title ?? '';
    const v = { kind, title: '', sub: '', risk: [], facts: [], irreversible: false, yes: 'Accept' };
    const sub = [];
    if (c.kind === 'mail') {
        const recipients = [...(c.to ?? []), ...(c.cc ?? []), ...(c.bcc ?? [])];
        const ext = outside(recipients);
        const sending = ['send', 'reply', 'forward'].includes(c.action);
        if (sending && ext.length) v.risk.push('Goes outside your domain');
        const sendWord = c.draft ? 'Save draft' : c.at ? 'Schedule' : 'Send';
        const to = whom(c.to ?? []);
        if (c.action === 'send') { v.title = c.draft ? `Draft ${subj(c.subject)}${to ? ` to ${to}` : ''}` : `${sendWord} ${subj(c.subject)}${to ? ` to ${to}` : ''}`; v.yes = sendWord; }
        else if (c.action === 'reply') { v.title = `${c.all ? 'Reply to all on' : 'Reply to'} ${about.from ? nameOfAddr(about.from) : 'a message'}${about.subject ? ` on “${about.subject}”` : ''}`; v.yes = sendWord; }
        else if (c.action === 'forward') {
            v.title = `Forward ${subj(about.subject)}${to ? ` to ${to}` : ''}`; v.yes = c.draft ? 'Save draft' : 'Forward';
            const k = String(c.keep ?? 'all').toLowerCase();
            v.facts.push(['Keeps', /^(none|false|no)$/.test(k) ? 'without its files' : /^(all|true|yes|)$/.test(k) ? (about.files?.length ? filesLine(about.files) : 'its files') : String(c.keep)]);
        } else if (c.action === 'move') { v.title = `Move ${subj(about.subject)} to ${c.mailbox ?? 'a folder'}`; v.yes = 'Move'; }
        else if (c.action === 'flag') { v.title = `Mark ${subj(about.subject)} ${c.flag ?? ''}`.trim(); v.yes = 'Mark'; }
        else if (c.action === 'delete') { v.title = `Delete ${subj(about.subject)}`; v.yes = 'Delete'; v.irreversible = true; }
        else v.title = `${c.action ?? 'mail'} ${q?.detail ?? ''}`.trim();
        if (sending && !c.draft && ext.length) v.irreversible = true;
        if (about.from && c.action !== 'reply') v.facts.push(['From', String(about.from)]);
        if (about.date && !sending) v.facts.push(['Date', String(about.date)]);
        if (c.to?.length) v.facts.push(['To', chips(c.to, ext)]);
        if (c.cc?.length) v.facts.push(['Cc', chips(c.cc, ext)]);
        if (c.bcc?.length) v.facts.push(['Bcc', chips(c.bcc, ext)]);
        if (c.files?.length) v.facts.push(['Joined', filesLine(c.files)]);
        if (c.at) v.facts.push(['Leaves', `${whenWords(c.at)} (waits in Drafts)`]);
        if (where) sub.push(where);
        if (c.body) { const lines = String(c.body).split('\n').length; sub.push(plural(lines, 'line')); v.quote = plain(c.body); }
        if (c.files?.length) sub.push(plural(c.files.length, 'attachment'));
    } else if (c.kind === 'calendar') {
        const answer = { accept: 'Accept', yes: 'Accept', decline: 'Decline', no: 'Decline', refuse: 'Decline', tentative: 'Maybe', maybe: 'Maybe' }[String(c.answer ?? '').toLowerCase()] ?? '';
        const was = c.action === 'create' ? null : about;
        const ev = c.action === 'create' ? c : { ...about, ...Object.fromEntries(Object.entries(c).filter(([k]) => ['title', 'start', 'end', 'where'].includes(k))) };
        const name = was?.title || c.title || 'an event';
        const guests = c.action === 'create' || c.action === 'update' ? (c.with?.length ? c.with : (about.attendees ?? [])) : (about.attendees ?? []);
        const ext = outside(c.with ?? []);
        if (c.action === 'respond') v.title = `${answer || 'Answer'} “${about.title || 'an invitation'}”${about.start ? ` (${whenWords(about.start, about.end)})` : ''}`;
        else if (c.action === 'create') v.title = `Create “${c.title ?? 'New event'}”${c.start ? ` ${whenWords(c.start, c.end)}` : ''}`;
        else if (c.action === 'delete') v.title = `Delete “${name}”${about.start ? ` (${whenWords(about.start, about.end)})` : ''}`;
        else if (c.action === 'update') v.title = (c.start && c.start !== about.start) ? `Move “${name}” to ${whenWords(c.start, c.end ?? about.end)}` : `Change “${name}”`;
        else if (c.action === 'attach') v.title = `Attach ${filesLine(c.files)} to “${name}”`;
        else v.title = `${c.action ?? 'calendar'} ${q?.detail ?? ''}`.trim();
        /* Before -> after: what changes of a change, and the event itself otherwise. */
        if (c.action === 'update' && was?.start) {
            v.before = [whenWords(was.start, was.end), was.where].filter(Boolean);
            v.after = [whenWords(ev.start, ev.end), ev.where].filter(Boolean);
            sub.push(`was ${whenWords(was.start, was.end)}`);
        } else if (ev.start) { if (c.action !== 'respond' && c.action !== 'delete' && c.action !== 'create') sub.push(whenWords(ev.start, ev.end)); if (ev.where) v.facts.push(['Where', String(ev.where)]); }
        if (guests.length && ['update', 'delete'].includes(c.action)) { sub.push(`${plural(guests.length, 'guest')} told`); v.irreversible = true; }
        if (about.clashes?.length) v.risk.push(`Clashes with ${about.clashes.join(', ')}`);
        if (ext.length) v.risk.push('Invites someone outside your domain');
        if (about.organizer && c.action === 'respond') v.facts.push(['From', String(about.organizer)]);
        if (guests.length) v.facts.push(['Guests', chips(guests, ext)]);
        if (c.online === 'teams' || (c.action === 'create' && (c.with ?? []).length && !c.online)) v.facts.push(['Online', 'Teams meeting']);
        if (where) sub.unshift(where);
        if (c.notes) v.quote = String(c.notes);
        v.yes = c.action === 'respond' ? (answer || 'Answer') : c.action === 'create' ? ((c.with ?? []).length ? 'Create and invite' : 'Create') : c.action === 'delete' ? 'Delete' : c.action === 'update' ? (v.before ? 'Move' : 'Change') : 'Accept';
        if (c.action === 'delete') v.irreversible = true;
    } else if (c.kind === 'contacts') {
        v.title = c.action === 'create' ? `Add ${c.name || c.email || 'a contact'}` : c.action === 'update' ? `Update ${c.name || 'a contact'}` : c.action === 'delete' ? `Delete ${c.name || 'a contact'}` : c.action === 'attach' ? `Set ${c.name ? `${c.name}'s` : 'a contact\'s'} photo` : `${c.action ?? 'contacts'} ${q?.detail ?? ''}`.trim();
        if (c.name && c.action !== 'create') v.facts.push(['Name', String(c.name)]);
        if (c.email) v.facts.push(['Email', String(c.email)]);
        if (c.phone) v.facts.push(['Phone', String(c.phone)]);
        if (where) sub.push(where);
        if (c.email && c.action === 'create') sub.push(String(c.email));
        v.yes = c.action === 'create' ? 'Add' : c.action === 'delete' ? 'Delete' : 'Update';
        if (c.action === 'delete') v.irreversible = true;
    } else if (c.kind === 'terminal') {
        const on = where || 'a machine';
        v.title = c.action === 'run' ? `Run a command on ${on}` : c.action === 'type' ? `Type into a terminal on ${on}` : `Open a terminal on ${on}`;
        if (/^\s*sudo\b/.test(c.command ?? '')) v.risk.push('As administrator');
        if (c.command || c.text) { v.code = String(c.command ?? c.text); sub.push(v.code.split('\n')[0].slice(0, 60)); }
        v.yes = c.action === 'run' ? 'Run' : c.action === 'type' ? 'Type' : 'Open';
        if (c.action === 'run') v.irreversible = true;
    } else if (c.kind === 'files') {
        v.title = c.action === 'write' ? `Write ${c.path}` : c.action === 'delete' ? `Delete ${c.path}` : c.action === 'move' ? `Move ${c.from} → ${c.to}` : `${c.action ?? 'files'} ${c.path ?? ''}`.trim();
        if (where) sub.push(where);
        if (c.bytes !== undefined) { const size = c.bytes >= 1024 ? `${Math.round(c.bytes / 1024)} KB` : `${c.bytes} bytes`; sub.push(size); v.facts.push(['Size', size]); }
        if (c.action === 'move') { v.before = [String(c.from ?? '')]; v.after = [String(c.to ?? '')]; }
        else if (c.path) v.facts.push(['Path', String(c.path)]);
        v.yes = c.action === 'delete' ? 'Delete' : c.action === 'move' ? 'Move' : 'Write';
        if (c.action === 'delete') { v.irreversible = true; v.risk.push('Cannot be undone'); }
    } else if (c.kind === 'browser' && c.action === 'open') { v.title = `Open ${c.url}`; v.yes = 'Open'; if (where) sub.push(where); }
    else { v.title = `${q?.verb ?? 'action'}${q?.detail ? ` ${q.detail}` : ''}`; if (where) sub.push(where); }
    const id = String(q?.id ?? '');
    return {
        kind, title: v.title || String(q?.verb ?? 'A request'), sub: sub.filter(Boolean).slice(0, 3).join(' · '),
        ...(v.risk.length ? { risk: v.risk } : {}), ...(v.facts.length ? { facts: v.facts } : {}),
        ...(v.before ? { before: v.before, after: v.after } : {}),
        ...(v.quote ? { quote: v.quote } : {}), ...(v.code ? { code: v.code } : {}),
        ...(q?.why ? { why: String(q.why) } : {}),
        /* The technical line, in "See all" only. */
        detail: [q?.verb, q?.detail].filter(Boolean).join(' — '),
        irreversible: v.irreversible,
        yes: { id: `allow:${id}`, label: v.yes }, no: { id: `deny:${id}`, label: 'Refuse' },
        /* "Always allow ...": behind "⋯", as before. */
        ...(q?.rule ? { others: [{ id: `always:${id}`, label: `Always allow ${q.rule.value ?? 'this'}` }] } : {}),
        hold: HOLD_S,
    };
}
