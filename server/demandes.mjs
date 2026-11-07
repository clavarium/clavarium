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

/* EACH TEXT A WORD AND ITS VALUES ({k, v}), said by each screen in its own language (Parley's
 * dictionary, the req-* words): the interface language may be each device's, so none is chosen
 * here. Data stays as it is (subjects, addresses, names, paths); a day and time is {at, end} (ISO),
 * written by the screen the locale's way; a count picks its word, one or several. */
const w = (k, v) => (v ? { k, v } : { k });
const count = (n, key) => w(n === 1 ? `${key}-one` : key, { count: n });
const when = (at, end) => (/^\d{4}-\d{2}-\d{2}/.test(String(at ?? '')) ? { at: String(at), ...(end ? { end: String(end) } : {}) } : String(at ?? ''));
const nameOfAddr = (a) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(String(a ?? '')); return m && m[1] ? m[1] : String(a ?? '').split('@')[0]; };
const quoted = (s, none) => (s ? w('req-quoted', { text: String(s) }) : w(none));
const sizeOf = (kb) => (kb >= 1024 ? w('req-size-mb', { n: Math.round((kb / 1024) * 10) / 10 }) : w('req-size-kb', { n: kb }));
const filesLine = (files) => ({ list: (files ?? []).map((f) => (f.kb ? w('req-file-size', { name: String(f.name), size: sizeOf(f.kb) }) : String(f.name))) });
/* Whom: the first, and how many more. */
const whom = (list) => (list.length ? `${list[0]}${list.length > 1 ? ` +${list.length - 1}` : ''}` : '');
/* The body as it will read: the Markdown marks taken off. */
const plain = (body) => String(body ?? '').replace(/\*\*(\S[^*\n]*?)\*\*/g, '$1').replace(/__(\S[^_\n]*?)__/g, '$1').replace(/(^|[^*\w])\*(\S[^*\n]*?)\*(?!\w)/g, '$1$2')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)').replace(/^#{1,6}\s+/gm, '');

/* A CALL OF AN EXTERNAL MCP SERVER'S TOOL (Tether's card { kind: 'mcp', action: 'call', server, tool, title?, class, open?,
 * fresh?, args }, 07-11): which server, which tool, its class, its arguments in short, the AI's why. Parley has no card
 * of this kind nor its words yet: drawn as its generic card (kind 'other'), each word with its English (`t`), which an
 * older or unknowing screen says as it is. A tool that deletes or overwrites: irreversible (amber, never in Accept all). */
export const MCP_CLASS_SAID = { read: 'Reads only', write: 'Writes', destructive: 'Deletes or overwrites' };
const MCP_ARGS_MAX = 6; const MCP_ARG_MAX = 160;
const said = (k, t, v) => ({ k, ...(v ? { v } : {}), t });
function mcpCard(c, v, sub) {
    const server = String(c.server ?? '') || 'an MCP server';
    const tool = String(c.title || c.tool || 'a tool');
    const cls = Object.hasOwn(MCP_CLASS_SAID, c.class) ? c.class : 'destructive';
    v.title = said('req-mcp-call', `Use ${tool} on ${server}`, { tool, server });
    sub.push(server, said(`req-mcp-class-${cls}`, MCP_CLASS_SAID[cls]));
    v.facts.push([said('req-fact-server', 'Server'), server]);
    v.facts.push([said('req-fact-tool', 'Tool'), c.title && c.tool && c.title !== c.tool ? `${c.title} (${c.tool})` : tool]);
    v.facts.push([said('req-fact-class', 'Kind'), said(`req-mcp-class-${cls}`, MCP_CLASS_SAID[cls])]);
    if (c.fresh === true) v.risk.push(said('req-risk-mcp-fresh', 'New or changed on its server'));
    if (cls === 'destructive') v.risk.push(said('req-risk-mcp-destructive', 'May delete or overwrite'));
    if (c.open === true && cls !== 'read') v.risk.push(said('req-risk-mcp-open', 'Reaches outside'));
    /* Its arguments, in short: a name and its value on a line each, the first few. */
    const args = Array.isArray(c.args) ? c.args.filter((a) => a && typeof a.name === 'string') : [];
    if (args.length) {
        const line = (a) => { const t = String(a.value ?? '').replace(/\s+/g, ' ').trim(); return `${a.name}: ${t.length > MCP_ARG_MAX ? `${t.slice(0, MCP_ARG_MAX - 1)}…` : t}`; };
        v.code = [...args.slice(0, MCP_ARGS_MAX).map(line), ...(args.length > MCP_ARGS_MAX ? [`… +${args.length - MCP_ARGS_MAX}`] : [])].join('\n');
    }
    v.irreversible = cls === 'destructive';
}

export function demandeView(q) {
    const c = q?.card ?? {}; const about = c.about ?? {};
    const kind = KINDS.has(c.kind) ? c.kind : 'other';
    const own = String(c.self ?? '').split('@')[1] ?? '';
    const outside = (list) => (own ? (list ?? []).filter((x) => !String(x).toLowerCase().endsWith(`@${own}`)) : []);
    const chips = (list, ext = []) => (list ?? []).map((x) => ({ text: String(x), ...(ext.includes(x) ? { ext: true } : {}) }));
    const fact = (key, value) => [w(`req-fact-${key}`), value];
    const where = q?.target?.title ?? '';
    const v = { kind, title: '', risk: [], facts: [], irreversible: false, yes: 'accept' };
    const sub = [];
    const raw = (action) => `${action} ${q?.detail ?? ''}`.trim();
    if (c.kind === 'mail') {
        const recipients = [...(c.to ?? []), ...(c.cc ?? []), ...(c.bcc ?? [])];
        const ext = outside(recipients);
        const sending = ['send', 'reply', 'forward'].includes(c.action);
        if (sending && ext.length) v.risk.push(w('req-risk-outside'));
        const sendWord = c.draft ? 'save-draft' : c.at ? 'schedule' : 'send';
        const to = whom(c.to ?? []);
        const subject = quoted(c.subject, 'req-a-message');
        const aboutSubject = quoted(about.subject, 'req-a-message');
        if (c.action === 'send') { const verb = c.draft ? 'draft' : c.at ? 'schedule' : 'send'; v.title = w(`req-mail-${verb}${to ? '-to' : ''}`, { subject, ...(to ? { to } : {}) }); v.yes = sendWord; }
        else if (c.action === 'reply') { v.title = w(`req-mail-reply${c.all ? '-all' : ''}${about.subject ? '-on' : ''}`, { who: about.from ? nameOfAddr(about.from) : w('req-a-message'), ...(about.subject ? { subject: quoted(about.subject) } : {}) }); v.yes = sendWord; }
        else if (c.action === 'forward') {
            v.title = w(`req-mail-forward${to ? '-to' : ''}`, { subject: aboutSubject, ...(to ? { to } : {}) }); v.yes = c.draft ? 'save-draft' : 'forward';
            const k = String(c.keep ?? 'all').toLowerCase();
            v.facts.push(fact('keeps', /^(none|false|no)$/.test(k) ? w('req-keeps-none') : /^(all|true|yes|)$/.test(k) ? (about.files?.length ? filesLine(about.files) : w('req-keeps-files')) : String(c.keep)));
        } else if (c.action === 'move') { v.title = w('req-mail-move', { subject: aboutSubject, folder: c.mailbox ?? w('req-a-folder') }); v.yes = 'move'; }
        else if (c.action === 'flag') { v.title = w('req-mail-flag', { subject: aboutSubject, flag: String(c.flag ?? '') }); v.yes = 'mark'; }
        else if (c.action === 'delete') { v.title = w('req-mail-delete', { subject: aboutSubject }); v.yes = 'delete'; v.irreversible = true; }
        else v.title = raw(c.action ?? 'mail');
        if (sending && !c.draft && ext.length) v.irreversible = true;
        if (about.from && c.action !== 'reply') v.facts.push(fact('from', String(about.from)));
        if (about.date && !sending) v.facts.push(fact('date', when(about.date)));
        /* A reply goes to the original's sender (and, to all, to its other recipients): said with their addresses even
           when the act names none itself (06-11, the owner: « à qui, avec l'adresse mail »); outside the domain, said so. */
        if (!c.to?.length && c.action === 'reply' && about.from) {
            const addr = (x) => (/<([^>]+)>/.exec(String(x))?.[1] ?? String(x)).trim();
            const me = String(c.self ?? '').toLowerCase();
            const back = [String(about.from)];
            const others = c.all ? [...(about.to ?? []), ...(about.cc ?? [])].map(String).filter((x) => x && addr(x).toLowerCase() !== me) : [];
            const away = new Set(outside([...back, ...others].map(addr)));
            const mark = (list) => list.map((x) => ({ text: x, ...(away.has(addr(x)) ? { ext: true } : {}) }));
            v.facts.push(fact('to', mark(back)));
            if (others.length) v.facts.push(fact('cc', mark(others)));
            if (away.size && !c.draft) { if (!v.risk.includes(w('req-risk-outside'))) v.risk.push(w('req-risk-outside')); v.irreversible = true; }
        }
        /* A reply carries the original quoted under it, as mail programs do (Tether's quoteReply): said in one line (06-11). */
        if (c.action === 'reply') v.facts.push(fact('quoted', w('req-quoted-original')));
        if (c.to?.length) v.facts.push(fact('to', chips(c.to, ext)));
        if (c.cc?.length) v.facts.push(fact('cc', chips(c.cc, ext)));
        if (c.bcc?.length) v.facts.push(fact('bcc', chips(c.bcc, ext)));
        if (c.files?.length) v.facts.push(fact('joined', filesLine(c.files)));
        if (c.at) v.facts.push(fact('leaves', w('req-leaves', { when: when(c.at) })));
        if (where) sub.push(where);
        if (c.body) { sub.push(count(String(c.body).split('\n').length, 'req-lines')); v.quote = plain(c.body); }
        if (c.files?.length) sub.push(count(c.files.length, 'req-attachments'));
        /* The mail it answers, forwards or acts on (Tether's about.ref, 06-11): a chip under the title, « en réponse à
           ✉ Subject · sender », opened in the mail viewer (Parley's `re`, app.js openMailRef) -- read only when tapped. */
        if (typeof about.ref === 'string' && about.ref.startsWith('mail:') && ['reply', 'forward', 'move', 'flag', 'delete'].includes(c.action)) {
            v.re = { ref: about.ref, label: about.subject ? String(about.subject) : w('req-a-message'), ...(about.from ? { note: nameOfAddr(about.from) } : {}),
                ...(c.action === 'reply' ? {} : { lead: w(c.action === 'forward' ? 'request-re-forward' : 'request-re-mail') }) };
        }
    } else if (c.kind === 'calendar') {
        const answer = { accept: 'accept', yes: 'accept', decline: 'decline', no: 'decline', refuse: 'decline', tentative: 'maybe', maybe: 'maybe' }[String(c.answer ?? '').toLowerCase()] ?? '';
        const was = c.action === 'create' ? null : about;
        const ev = c.action === 'create' ? c : { ...about, ...Object.fromEntries(Object.entries(c).filter(([k]) => ['title', 'start', 'end', 'where'].includes(k))) };
        const name = quoted(was?.title || c.title, 'req-an-event');
        const guests = c.action === 'create' || c.action === 'update' ? (c.with?.length ? c.with : (about.attendees ?? [])) : (about.attendees ?? []);
        const ext = outside(c.with ?? []);
        if (c.action === 'respond') v.title = w(`req-cal-respond${about.start ? '-when' : ''}`, { answer: w(`req-yes-${answer || 'answer'}`), name: quoted(about.title, 'req-an-invitation'), ...(about.start ? { when: when(about.start, about.end) } : {}) });
        else if (c.action === 'create') v.title = w(`req-cal-create${c.start ? '-when' : ''}`, { name: c.title ? quoted(c.title) : w('req-new-event'), ...(c.start ? { when: when(c.start, c.end) } : {}) });
        else if (c.action === 'delete') v.title = w(`req-cal-delete${about.start ? '-when' : ''}`, { name, ...(about.start ? { when: when(about.start, about.end) } : {}) });
        else if (c.action === 'update') v.title = (c.start && c.start !== about.start) ? w('req-cal-move', { name, when: when(c.start, c.end ?? about.end) }) : w('req-cal-change', { name });
        else if (c.action === 'attach') v.title = w('req-cal-attach', { files: filesLine(c.files), name });
        else v.title = raw(c.action ?? 'calendar');
        /* Before -> after: what changes of a change, and the event itself otherwise. */
        if (c.action === 'update' && was?.start) {
            v.before = [when(was.start, was.end), was.where].filter(Boolean);
            v.after = [when(ev.start, ev.end), ev.where].filter(Boolean);
            sub.push(w('req-was', { when: when(was.start, was.end) }));
        } else if (ev.start) { if (c.action !== 'respond' && c.action !== 'delete' && c.action !== 'create') sub.push(when(ev.start, ev.end)); if (ev.where) v.facts.push(fact('where', String(ev.where))); }
        if (guests.length && ['update', 'delete'].includes(c.action)) { sub.push(count(guests.length, 'req-guests-told')); v.irreversible = true; }
        if (about.clashes?.length) v.risk.push(w('req-risk-clash', { what: { list: about.clashes.map(String) } }));
        if (ext.length) v.risk.push(w('req-risk-invites-outside'));
        if (about.organizer && c.action === 'respond') v.facts.push(fact('from', String(about.organizer)));
        if (guests.length) v.facts.push(fact('guests', chips(guests, ext)));
        if (c.online === 'teams' || (c.action === 'create' && (c.with ?? []).length && !c.online)) v.facts.push(fact('online', w('req-teams')));
        if (where) sub.unshift(where);
        if (c.notes) v.quote = String(c.notes);
        v.yes = c.action === 'respond' ? (answer || 'answer') : c.action === 'create' ? ((c.with ?? []).length ? 'create-invite' : 'create') : c.action === 'delete' ? 'delete' : c.action === 'update' ? (v.before ? 'move' : 'change') : 'accept';
        if (c.action === 'delete') v.irreversible = true;
    } else if (c.kind === 'contacts') {
        const who = (x) => (x ? String(x) : w('req-a-contact'));
        v.title = c.action === 'create' ? w('req-contact-add', { who: who(c.name || c.email) }) : c.action === 'update' ? w('req-contact-update', { who: who(about.name || c.name) }) : c.action === 'delete' ? w('req-contact-delete', { who: who(about.name || c.name) }) : c.action === 'attach' ? w('req-contact-photo', { who: who(about.name || c.name) }) : raw(c.action ?? 'contacts');
        /* Who it is now (Tether reads the contact before a change or a delete, 05-11), then what changes. */
        if (about.name && c.action !== 'create') v.facts.push(fact('name', String(about.name)));
        if (about.email && c.action !== 'create' && about.email !== c.email) v.facts.push(fact('email', String(about.email)));
        if (c.name && c.action !== 'create' && c.name !== about.name) v.facts.push(fact('name', String(c.name)));
        if (c.email) v.facts.push(fact('email', String(c.email)));
        if (c.phone) v.facts.push(fact('phone', String(c.phone)));
        if (where) sub.push(where);
        if (c.email && c.action === 'create') sub.push(String(c.email));
        v.yes = c.action === 'create' ? 'add' : c.action === 'delete' ? 'delete' : 'update';
        if (c.action === 'delete') v.irreversible = true;
    } else if (c.kind === 'terminal') {
        const on = where || w('req-a-machine');
        v.title = w(c.action === 'run' ? 'req-term-run' : c.action === 'type' ? 'req-term-type' : 'req-term-open', { on });
        if (/^\s*sudo\b/.test(c.command ?? '')) v.risk.push(w('req-risk-admin'));
        if (c.command || c.text) { v.code = String(c.command ?? c.text); sub.push(v.code.split('\n')[0].slice(0, 60)); }
        v.yes = c.action === 'run' ? 'run' : c.action === 'type' ? 'type' : 'open';
        if (c.action === 'run') v.irreversible = true;
    } else if (c.kind === 'files') {
        v.title = c.action === 'write' ? w('req-files-write', { path: String(c.path) }) : c.action === 'delete' ? w('req-files-delete', { path: String(c.path) }) : c.action === 'move' ? w('req-files-move', { from: String(c.from), to: String(c.to) }) : `${c.action ?? 'files'} ${c.path ?? ''}`.trim();
        if (where) sub.push(where);
        if (c.bytes !== undefined) { const size = c.bytes >= 1024 ? w('req-size-kb', { n: Math.round(c.bytes / 1024) }) : w('req-size-bytes', { n: c.bytes }); sub.push(size); v.facts.push(fact('size', size)); }
        if (c.action === 'move') { v.before = [String(c.from ?? '')]; v.after = [String(c.to ?? '')]; }
        else if (c.path) v.facts.push(fact('path', String(c.path)));
        v.yes = c.action === 'delete' ? 'delete' : c.action === 'move' ? 'move' : 'write';
        if (c.action === 'delete') { v.irreversible = true; v.risk.push(w('req-risk-final')); }
    } else if (c.kind === 'browser' && c.action === 'open') { v.title = w('req-browser-open', { url: String(c.url) }); v.yes = 'open'; if (where) sub.push(where); }
    else if (c.kind === 'mcp') mcpCard(c, v, sub);
    else { v.title = `${q?.verb ?? 'action'}${q?.detail ? ` ${q.detail}` : ''}`; if (where) sub.push(where); }
    const id = String(q?.id ?? '');
    return {
        kind, title: v.title || (q?.verb ? String(q.verb) : w('req-a-request')), sub: sub.filter(Boolean).slice(0, 3),
        ...(v.risk.length ? { risk: v.risk } : {}), ...(v.facts.length ? { facts: v.facts } : {}),
        ...(v.before ? { before: v.before, after: v.after } : {}),
        ...(v.quote ? { quote: v.quote } : {}), ...(v.code ? { code: v.code } : {}), ...(v.re ? { re: v.re } : {}),
        ...(q?.why ? { why: String(q.why) } : {}),
        /* The technical line, in "See all" only. */
        detail: [q?.verb, q?.detail].filter(Boolean).join(' — '),
        irreversible: v.irreversible,
        yes: { id: `allow:${id}`, label: w(`req-yes-${v.yes}`) }, no: { id: `deny:${id}`, label: w('req-no') },
        /* "Always allow ...": behind "⋯", as before. */
        ...(q?.rule ? { others: [{ id: `always:${id}`, label: q.rule.value ? w('req-always', { what: String(q.rule.value) }) : w('req-always-this') }] } : {}),
        hold: HOLD_S,
    };
}
