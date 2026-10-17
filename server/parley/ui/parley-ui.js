/* THE EXCHANGE, SHOWN. One file, no framework, for any page.
 *
 *   import { mount } from './parley-ui.js';
 *   mount(element, { load, send, words, open, terminal, remind, view, onView, locale,
 *                    voice, autoSend, onAutoSend, replies, enter, touch, attach, act,
 *                    markdown, picture, diagram, highlight, agentName, agentTool, react, reactions });
 *
 *   load()                 resolves with what parley-host.mjs read() gives;
 *                          the application may add lines of its own to its
 *                          messages: { from: 'system', id, at, text, level,
 *                          tone, topic, brief, actions: [{ id, label }] } (see
 *                          LINES OF THE APPLICATION, below)
 *   send(text, answers, files)
 *                          the person wrote; `answers` is the id of the
 *                          question it answers (a choice, or a text written
 *                          in reply); `files`, what `attach` gave back for
 *                          the files they attached
 *   words                  the words of the screen: texts(lang, own) of
 *                          parley-host.mjs, or any object with those keys
 *   open(file)             optional: opens a file the agent showed or cited
 *                          (`file` is { path, open }: `open` is the
 *                          application's own reference, null when it cannot
 *                          be opened)
 *   terminal()             optional: shows the agent's terminal
 *   remind()               optional: tells the agent again that a message waits
 *   view                   'simple' or 'detailed'; onView(view) when changed
 *   locale                 optional: how times and days are written (the
 *                          device's own way when not given)
 *   agentName              optional: the agent's name, said above its messages
 *                          (default: the neutral word of the dictionary)
 *   agentTool              optional: which tool it is, said small beside its
 *                          name in the detailed view
 *   react(to, reaction)    optional: puts a reaction of the set on a message
 *                          of the agent (null: takes it back); `reactions`
 *                          replaces the set, [{ id, icon }] (REACTIONS)
 *   (data.about)           optional, given with the data: [{ label, text,
 *                          tone }], its machine, on the side of the detailed
 *                          view
 *
 * WHAT THE AGENT WRITES, RENDERED (`markdown: true`; without it, plain text).
 * Its Markdown is read into plain data (markdown(), below), then the page is
 * built from that data node by node: never a string of markup, from the
 * agent or from anywhere. Headings, lists, tasks, emphasis, ==highlight==,
 * tables (wide ones scroll in their message), quotes, the alerts of GitHub
 * (> [!IMPORTANT] ... as coloured boxes), badges ([ok] [todo] [blocked]
 * [warn]), code blocks with a Copy button. A link opens only when it is
 * http or https (in a new tab, sending nothing of this page), or a path the
 * application can open (`open`); any other is its text. A picture is shown
 * only from a path the application can open (`picture`): never from
 * anywhere else, since loading it would tell that place who reads. Slots of
 * the application, each optional:
 *   picture(file)          the address of a picture the person may see
 *                          (`file` as for open), or null; pictures the agent
 *                          showed, cited, or the person attached are shown
 *                          in the thread, a click opens them large, to zoom
 *   diagram(code)          resolves with the SVG text of a ```mermaid block,
 *                          drawn by the application's own renderer; it is
 *                          shown as a picture (an <img>: a picture runs
 *                          nothing and loads nothing); no slot, or a
 *                          failure: the block is shown as code
 *   highlight(code, lang)  resolves with a token tree (strings, and
 *                          { type, alias, content } as Prism.tokenize
 *                          gives) to colour a code block; spans are made
 *                          here from it, never its markup
 *
 * TWO VERSIONS OF A MESSAGE. An agent may give a long message a short one
 * (`short`: a title of one or two lines). The simple view shows the short
 * one, and "See the details" unfolds the rest (kept unfolded for that
 * message); a long message without one is folded after about twelve lines.
 * Either way its > [!IMPORTANT] boxes stay in sight. A question is never
 * folded. The detailed view unfolds everything.
 *
 * SLOTS THE APPLICATION FILLS, each optional; without them, none is shown:
 *   voice                  { listen(on) }: dictation. listen opens the
 *                          microphone and resolves with a function that
 *                          closes it; it calls on.phrase(text) for each
 *                          phrase understood, on.state(word) with
 *                          calibrating, listening, hearing or transcribing,
 *                          on.speech() when speech begins, on.error(message).
 *                          A button beside Send; what is said goes into the
 *                          box. Changed later with `handle.voice = ...`.
 *                          Dictating moves nothing on the screen: what the
 *                          microphone does is said inside the box (its
 *                          placeholder, and a small label on its frame that
 *                          takes no room), never on a line of its own.
 *   autoSend, onAutoSend   "send when I stop": what was said is sent once the
 *                          person stops talking. A choice of the device, not
 *                          of the moment: it is in the small menu of settings
 *                          beside the view, shown only with `voice`, and the
 *                          microphone wears a dot while it is on. The
 *                          person's choice is told to onAutoSend(on), for the
 *                          application to keep.
 *   replies                [{ label, text, send }]: ready answers, above the
 *                          box, after the choices of the question the agent
 *                          asks now. `send: true` sends the text at once,
 *                          otherwise it is put in the box to be completed.
 *                          Changed later with `handle.replies = [...]`.
 *   enter                  'auto' (default: Enter sends where there is a fine
 *                          pointer, a new line on a touch screen), 'send' or
 *                          'newline'. Shift+Enter is always a new line, and
 *                          Ctrl+Enter always sends.
 *   attach                 { upload(file, name) }: files the person attaches
 *                          to a message: picked with a button beside the
 *                          box, pasted into it, or dropped on the chat. Each
 *                          is shown above the box until it is sent (a
 *                          picture as a picture), and on Send each is given
 *                          to upload (a File), which resolves with
 *                          { path, name, size }: where the agent will find
 *                          it. Then the message goes, with them. A message
 *                          may be files alone.
 *   act(id, line)          a button of a line of the application was pressed
 *   touch                  true on a touch screen (default: any coarse
 *                          pointer). The box is then never focused by the
 *                          page, only by the person's finger, so that the
 *                          keyboard never comes up by itself; and a tap on a
 *                          button of the box leaves it open.
 *
 * WHILE IT WORKS, WHAT IT DOES NOW. The agent says in one line what it is
 * doing (`parley doing`); the newest line is shown at the end of the thread,
 * moving, until ITS next message comes (a message of the person does not
 * take it away): then it goes, and the steps that led there are one click
 * away: on that message in the simple view, unfolded above it in the
 * detailed one. When it waits for the person, that is said once, at the end
 * of the thread, until the person writes: a state is not a step.
 *
 * EACH MESSAGE OF THE PERSON says where it is, by a small sign in its corner
 * (its words on hover): sent, not read yet; read; being worked on; handled
 * (the agent answered after reading it, or said it was done). The simple
 * view signs only what is not handled yet; the detailed one signs all.
 *
 * TIMES, as a chat shows them: the day when it changes, the time when long
 * passed between two messages, and the time of each message on hover (a long
 * press on a touch screen).
 *
 * TWO VIEWS OF ONE EXCHANGE. Simple: the agent's messages across a reading
 * column, the person's in bubbles on the right, the one line of what it does
 * now, the choices to answer with, the files that can be opened, times on
 * hover, steps folded into the message they led to (a click on it opens
 * them) -- nothing the person cannot act on. Detailed: every step unfolded
 * between the messages with its time and state, the time of every message,
 * where the agent says it is, every file it showed with its path (one that
 * cannot be opened is said so), and a way to its terminal.
 *
 * LINES OF THE APPLICATION. What happens around the agent (its machine short
 * of memory, restarted, its work sent somewhere) is said in the thread where
 * it happened, as a grey line across with its time and the application's
 * buttons, not as a bubble of either side. The application keeps them, gives
 * them with the messages, and gives each a neutral LEVEL; nothing else is
 * decided here: 'needs-you' is shown in both views; 'news' in both, as a
 * compact line in the simple one where a run of lines of one `topic` is one
 * line ("Sent (3): dev, preprod, dev", each `brief`); 'trace' in the
 * detailed view only. ('warn' and 'bad' read as needs-you, 'info' as news.)
 *
 * EVERYTHING AN AGENT WROTE, AND EVERY WORD OF THE DICTIONARY, IS PUT ON THE
 * PAGE AS TEXT, never as markup: the first is chosen by a program, the
 * second by whoever wrote the dictionary.
 */
import { icon, fileIcon } from './parley-icons.js';

export const VIEWS = Object.freeze(['simple', 'detailed']);
/* The words this screen uses: a dictionary needs these keys. */
export const KEYS = Object.freeze(['send', 'placeholder', 'empty', 'view', 'simple', 'detailed', 'working', 'waiting', 'done', 'no-status', 'asks', 'open', 'outside',
    'not-read', 'read', 'remind', 'reminded', 'steps', 'no-steps', 'files', 'no-files', 'terminal', 'not-sent', 'step-one', 'steps-many', 'today', 'yesterday', 'quiet',
    'mic', 'mic-stop', 'auto-send', 'auto-on', 'settings', 'voice-placeholder', 'voice-calibrating', 'voice-listening', 'voice-hearing', 'voice-transcribing', 'voice-wait', 'voice-off', 'replies', 'replies-more', 'replies-less',
    'attach', 'remove-file', 'sending-files', 'attach-where',
    'copy', 'copied', 'see-details', 'see-more', 'see-less', 'note', 'tip', 'important', 'warning', 'caution', 'badge-ok', 'badge-todo', 'badge-blocked', 'badge-warn',
    'waits-you', 'waits-you-note', 'busy', 'state-sent', 'state-read', 'state-working', 'state-done', 'sent-at', 'read-at', 'done-at',
    'reply', 'replying', 'not-a-reply', 'in-reply', 'closed', 'you', 'agent', 'drop', 'picture', 'diagram', 'not-shown', 'grouped',
    'zoom-in', 'zoom-out', 'zoom-actual', 'zoom-fit', 'zoom-actual-short', 'zoom-fit-short', 'close', 'previous', 'next', 'search', 'found', 'newest', 'dictation', 'auto-send-off',
    'react', 'react-remove', 'react-agree', 'react-go', 'react-disagree', 'react-unclear', 'react-stop', 'react-redo', 'react-later', 'react-love',
    'react-agree-hint', 'react-go-hint', 'react-disagree-hint', 'react-unclear-hint', 'react-stop-hint', 'react-redo-hint', 'react-later-hint', 'react-love-hint',
    'decide', 'media', 'media-pictures', 'media-files', 'media-none', 'see-in-thread', 'done-end', 'done-end-note', 'dictated', 'side-now', 'side-machine', 'side-nothing']);
/* THE REACTIONS offered by default, each with its Lucide icon; their words
   are "react-<id>" (shown under the icon) and "react-<id>-hint" (on hover).
   The same ids as REACTIONS of parley-host.mjs, which says which wake. */
export const REACTIONS = Object.freeze([
    { id: 'agree', icon: 'thumbs-up' }, { id: 'go', icon: 'circle-check' }, { id: 'disagree', icon: 'thumbs-down' }, { id: 'unclear', icon: 'circle-question-mark' },
    { id: 'stop', icon: 'octagon-x' }, { id: 'redo', icon: 'refresh-ccw' }, { id: 'later', icon: 'hourglass' }, { id: 'love', icon: 'heart' },
].map(Object.freeze));
/* The order of the reactions in their choice: "Go ahead" first, "Stop" always last, far from it. */
const PICKER_ORDER = Object.freeze(['go', 'agree', 'unclear', 'love', 'later', 'redo', 'disagree']);
/* Narrower than this, the choice of reactions is a panel that rises from the bottom. */
export const SHEET_PX = 600;
/* Narrower than this, the detailed view folds its files into one line. */
export const NARROW_PX = 736;
/* Between two messages further apart than this, the time is said. */
export const GAP_MS = 60 * 60 * 1000;
/* What it does now stops moving when nothing came for this long: it may have stopped. */
export const STALE_MS = 15 * 60 * 1000;
/* "Remind it" is offered only for a message not read this long, when the agent did nothing for as long. */
export const IDLE_MS = 2 * 60 * 1000;
/* A press this long on a touch screen shows a message's time. */
export const PRESS_MS = 450;
/* Dictating with "send when I stop": sent this long after the last phrase was written, unless the person speaks again. */
export const AUTO_SEND_MS = 1200;
/* Send pressed while a phrase is still being written: sent once it is, or after this long with what is there. */
export const WRITE_WAIT_MS = 15_000;
/* Ready answers: so many at most, each label so long. */
export const REPLIES_MAX = 40;
export const LABEL_MAX = 40;
export const TEXT_MAX = 4000;
/* Files attached to one message, at most; buttons on a line of the application. */
export const FILES_MAX = 10;
export const ACTIONS_MAX = 4;
/* A message without a short version is folded beyond about so many lines (simple view). */
export const FOLD_LINES = 12;
/* Read no deeper than this: quotes in lists in quotes... */
const DEPTH_MAX = 8;
export const LEVELS = Object.freeze(['needs-you', 'news', 'trace']);
export const ALERTS = Object.freeze(['note', 'tip', 'important', 'warning', 'caution']);
export const BADGES = Object.freeze(['ok', 'todo', 'blocked', 'warn']);
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
/* A file's name as a title, when it was given none: no extension, no dashes. */
export const titleOf = (name) => { const t = String(name ?? '').split('/').pop().replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : String(name ?? ''); };

const fill = (word, values = {}) => String(word ?? '').replace(/\{([a-z]+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));
const said = (words, key, values) => fill(typeof words?.[key] === 'string' ? words[key] : key, values);
const nameOf = (path) => String(path ?? '').split('/').pop();
/* A size, as a person reads it. */
export const sizeText = (n) => (!Number.isInteger(n) || n < 0 ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const stamp = (at) => { const t = Date.parse(at); return Number.isNaN(t) ? null : t; };
/* Written the device's way, or the given locale's; a locale that is not one is the device's. */
const format = (t, locale, options) => { if (t === null) return ''; const d = new Date(t); try { return d.toLocaleString(locale, options); } catch { return d.toLocaleString(undefined, options); } };
const clock = (t, locale) => format(t, locale, { timeStyle: 'short' });
const whole = (t, locale) => format(t, locale, { dateStyle: 'full', timeStyle: 'short' });
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayText(t, now, words, locale) {
    if (dayKey(t) === dayKey(now)) return said(words, 'today');
    const before = new Date(now); before.setDate(before.getDate() - 1);
    if (dayKey(t) === dayKey(before.getTime())) return said(words, 'yesterday');
    return format(t, locale, new Date(t).getFullYear() === new Date(now).getFullYear() ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
const cut = (text, n) => { const one = String(text ?? '').replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1)}…` : one; };

/* ---- MARKDOWN, READ INTO PLAIN DATA ----
   Blocks: { t: 'p'|'h'|'hr'|'code'|'quote'|'alert'|'list'|'table', ... }.
   Inlines: { t: 'text'|'br'|'code'|'em'|'strong'|'del'|'mark'|'link'|'img'|'badge', ... }.
   Nothing here is markup: an HTML tag the agent wrote is text, and is shown as such. */

/* A link the page may follow: http or https only, made whole by the URL parser
   (so that "jav&#x61;script:", " javascript:", "JaVaScRiPt:" and the like are
   what they are: not http). Anything else: null. */
export function safeLink(href) {
    const raw = String(href ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return null;
    try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~=<>"']/;
const URL_AT = /^https?:\/\/[^\s<>()[\]"'`]+(?:\([^\s<>()]*\)[^\s<>()[\]"'`]*)*/i;
const PAIRS = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['==', 'mark'], ['*', 'em'], ['_', 'em']];

export function inline(text, depth = 0) {
    const s = String(text ?? '');
    const out = [];
    let buffer = '';
    const flush = () => { if (buffer) { out.push({ t: 'text', v: buffer }); buffer = ''; } };
    const word = (ch) => /[\p{L}\p{N}]/u.test(ch ?? '');
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) { buffer += s[i + 1]; i += 2; continue; }
        if (c === '\n') { flush(); out.push({ t: 'br' }); i += 1; continue; }
        if (c === '`') {
            const run = /^`+/.exec(s.slice(i))[0];
            const end = s.indexOf(run, i + run.length);
            if (end > 0) { flush(); let v = s.slice(i + run.length, end).replace(/\n/g, ' '); if (/^ .* $/.test(v)) v = v.slice(1, -1); out.push({ t: 'code', v }); i = end + run.length; continue; }
            buffer += run; i += run.length; continue;
        }
        if (c === '!' && s[i + 1] === '[') {
            const m = /^!\[([^\]\n]{0,300})\]\(\s*<?([^\s()<>]{1,2000})>?(?:\s+"[^"\n]*")?\s*\)/.exec(s.slice(i));
            if (m) { flush(); out.push({ t: 'img', alt: m[1], src: m[2] }); i += m[0].length; continue; }
        }
        if (c === '[') {
            const badge = /^\[(ok|todo|blocked|warn)\]/i.exec(s.slice(i));
            if (badge && s[i + badge[0].length] !== '(') { flush(); out.push({ t: 'badge', kind: badge[1].toLowerCase() }); i += badge[0].length; continue; }
            const m = /^\[((?:[^[\]\n]|\[[^[\]\n]*\]){0,500})\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\)){1,2000})>?(?:\s+"[^"\n]*")?\s*\)/.exec(s.slice(i));
            if (m && depth < DEPTH_MAX) { flush(); out.push({ t: 'link', href: m[2], c: inline(m[1], depth + 1) }); i += m[0].length; continue; }
        }
        if (c === '<') {
            const m = /^<(https?:\/\/[^\s<>]{1,2000})>/i.exec(s.slice(i));
            if (m) { flush(); out.push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
        }
        /* A bare address, not one given to an attribute of a tag written as text. */
        if ((c === 'h' || c === 'H') && !word(s[i - 1]) && s[i - 1] !== '=' && !(/["']/.test(s[i - 1] ?? '') && s[i - 2] === '=')) {
            const m = URL_AT.exec(s.slice(i));
            if (m) { const url = m[0].replace(/[.,;:!?]+$/, ''); flush(); out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue; }
        }
        const pair = depth < DEPTH_MAX && PAIRS.find(([d]) => s.startsWith(d, i));
        if (pair) {
            const [d, t] = pair;
            const after = s[i + d.length];
            /* Opens only before a non-space; "_" only at the start of a word; "*" not doubled into the next. */
            const opens = after && !/\s/.test(after) && !(d.length === 1 && after === d) && !(d.length === 1 && word(s[i - 1]));
            if (opens) {
                let end = -1;
                for (let j = i + d.length + 1; j <= s.length - d.length; j += 1) {
                    if (s[j] === '\\') { j += 1; continue; }
                    if (s[j] === '`') { const run = /^`+/.exec(s.slice(j))[0]; const close = s.indexOf(run, j + run.length); if (close > 0) { j = close + run.length - 1; continue; } }
                    if (s.startsWith(d, j) && !/\s/.test(s[j - 1]) && !(d.length === 1 && (s[j + 1] === d || s[j - 1] === d)) && !(d.length === 1 && word(s[j + d.length]))) { end = j; break; }
                }
                if (end > 0) { flush(); out.push({ t, c: inline(s.slice(i + d.length, end), depth + 1) }); i = end + d.length; continue; }
            }
            buffer += d; i += d.length; continue;
        }
        buffer += c; i += 1;
    }
    flush();
    return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:\s+(.*)|$)/;
const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/* The cells of a row of a table: a "|" in a code span, or written "\|", is text. */
function cells(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    const out = [];
    let cell = '';
    for (let k = 0; k < l.length; k += 1) {
        const ch = l[k];
        if (ch === '\\' && l[k + 1] === '|') { cell += '\\|'; k += 1; continue; }
        if (ch === '`') { const run = /^`+/.exec(l.slice(k))[0]; const end = l.indexOf(run, k + run.length); if (end > 0) { cell += l.slice(k, end + run.length); k = end + run.length - 1; continue; } }
        if (ch === '|') { out.push(cell); cell = ''; continue; }
        cell += ch;
    }
    if (cell.trim() || !l.endsWith('|')) out.push(cell);
    return out.map((x) => x.trim());
}
const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes('|') && next !== undefined && DELIMITER.test(next) && next.includes('-'));

/* The blocks of a text; each top block says on which line it starts (`line`). */
export function markdown(text, depth = 0) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const at = i;
        if (!line.trim()) { i += 1; continue; }
        let m = FENCE.exec(line);
        if (m) {
            const fence = m[1];
            const body = [];
            i += 1;
            while (i < lines.length && !(new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i]))) body.push(lines[i++]);
            i += 1;
            blocks.push({ t: 'code', lang: m[2].toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 30), text: body.join('\n'), line: at });
            continue;
        }
        if ((m = HEADING.exec(line))) { blocks.push({ t: 'h', level: m[1].length, c: inline(m[2] ?? '', depth), line: at }); i += 1; continue; }
        if (RULE.test(line) && !ITEM.exec(line)?.[3]) { blocks.push({ t: 'hr', line: at }); i += 1; continue; }
        if (QUOTE.test(line)) {
            const inner = [];
            while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
            const alert = /^\s*\[!(note|tip|important|warning|caution)\]\s*(.*)$/i.exec(inner[0] ?? '');
            if (depth >= DEPTH_MAX) { blocks.push({ t: 'p', c: [{ t: 'text', v: inner.join(' ') }], line: at }); continue; }
            if (alert) blocks.push({ t: 'alert', kind: alert[1].toLowerCase(), c: markdown([alert[2], ...inner.slice(1)].join('\n'), depth + 1), line: at });
            else blocks.push({ t: 'quote', c: markdown(inner.join('\n'), depth + 1), line: at });
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length && DELIMITER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            const head = cells(line);
            const align = cells(lines[i + 1]).map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : ''));
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < 500) rows.push(cells(lines[i++]));
            const width = Math.min(30, head.length);
            blocks.push({ t: 'table', align: align.slice(0, width), head: head.slice(0, width).map((x) => inline(x, depth)), rows: rows.map((r) => Array.from({ length: width }, (_, k) => inline(r[k] ?? '', depth))), line: at });
            continue;
        }
        if ((m = ITEM.exec(line)) && depth < DEPTH_MAX) {
            const ordered = /\d/.test(m[2]);
            const indent = m[1].length;
            const items = [];
            const start = ordered ? Number.parseInt(m[2], 10) : undefined;
            while (i < lines.length) {
                const it = ITEM.exec(lines[i]);
                if (!it || it[1].length !== indent || /\d/.test(it[2]) !== ordered) break;
                const pad = indent + it[2].length + 1;
                const body = [it[3] ?? ''];
                i += 1;
                while (i < lines.length) {
                    const l = lines[i];
                    if (!l.trim()) {
                        /* A blank line stays in the item only when what follows is indented under it. */
                        const next = lines.slice(i + 1).find((x) => x.trim());
                        if (next !== undefined && /^\s*/.exec(next)[0].length >= pad) { body.push(''); i += 1; continue; }
                        break;
                    }
                    const lead = /^\s*/.exec(l)[0].length;
                    if (lead >= pad || (lead > indent && ITEM.test(l))) { body.push(l.slice(Math.min(lead, pad))); i += 1; continue; }
                    if (lead <= indent && (ITEM.test(l) || startsBlock(l, lines[i + 1]))) break;
                    /* A line that just goes on: the same paragraph. */
                    body.push(l.trim()); i += 1;
                }
                const task = /^\[([ xX])\]\s+/.exec(body[0]);
                if (task) body[0] = body[0].slice(task[0].length);
                items.push({ task: task ? task[1] !== ' ' : null, c: markdown(body.join('\n'), depth + 1) });
                while (i < lines.length && !lines[i].trim()) {
                    const next = lines.slice(i).find((x) => x.trim());
                    const it2 = next === undefined ? null : ITEM.exec(next);
                    if (it2 && it2[1].length === indent && /\d/.test(it2[2]) === ordered) i += 1; else break;
                }
            }
            blocks.push({ t: 'list', ordered, ...(ordered && start !== 1 ? { start } : {}), items, line: at });
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
        blocks.push({ t: 'p', c: inline(para.join('\n'), depth), line: at });
    }
    return blocks;
}
/* All the text of a run of inlines, as it reads. */
export const plainOf = (nodes) => (nodes ?? []).map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : n.t === 'img' ? n.alt : n.t === 'badge' ? `[${n.kind}]` : plainOf(n.c))).join('');
/* About how many lines a text takes in a reading column. */
export const linesOf = (text) => String(text ?? '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 90)), 0);

/* A level of a line of the application, as given or as it was once said. */
const levelOf = (level) => (LEVELS.includes(level) ? level : level === 'warn' || level === 'bad' ? 'needs-you' : 'news');
/* A question still open: neither answered nor closed. */
const openQuestion = (m, answered) => m.kind === 'ask' && m.from !== 'person' && m.from !== 'system' && !answered.has(m.id) && !m.closed;

/* WHAT IS SHOWN, as plain data: the page is built from this and from nothing
   else, so it can be checked without a page. `rows`, in order: `day` and
   `gap` (a divider), `message` (in the simple view with `trail`: the steps
   that led to it, folded), `steps` (a group of steps, unfolded in the
   detailed view; in the simple one only those after its last message when
   it stopped), `group` (lines of the application of one topic, in the simple
   view), `now` (what it does now, with the steps of this turn before it),
   `waits` (it waits for the person). `items`: the messages alone. */
export function view(data, { words = {}, view: as = 'simple', now = Date.now(), locale, agentName, agentTool } = {}) {
    const detailed = as === 'detailed';
    const all = Array.isArray(data?.messages) ? data.messages.filter((m) => m && typeof m === 'object') : [];
    const answered = new Set(all.filter((m) => m.from === 'person').map((m) => m.answers).filter(Boolean));
    /* Simple shows nothing the person cannot act on: a file that cannot be opened, a trace, are in the detailed view only. */
    const messages = all.filter((m) => detailed || !((m.kind === 'show' && (Array.isArray(m.files) && m.files.length ? !m.files.some((f) => f && typeof f.open === 'string') : typeof m.open !== 'string')) || (m.from === 'system' && levelOf(m.level) === 'trace')));
    const status = data?.status ?? null;
    const state = (s) => said(words, ['working', 'waiting', 'done'].includes(s) ? s : 'working');
    /* A state of waiting, or done, is not a step: it is said once, at the end. */
    const allSteps = (Array.isArray(data?.steps) ? data.steps : []).filter((s) => s && typeof s === 'object');
    const steps = allSteps.filter((s) => !(s.kind === 'status' && (s.state === 'waiting' || s.state === 'done')));
    const files = Array.isArray(data?.files) ? data.files : [];
    const agentSaid = (m) => m.from !== 'person' && m.from !== 'system';
    /* What the agent did after a time: its messages and its steps. */
    const agentTimes = [...all.filter(agentSaid).map((m) => stamp(m.at)), ...steps.map((s) => stamp(s.at))].filter((t) => t !== null).sort((a, b) => a - b);
    const lastAgent = agentTimes.at(-1) ?? null;
    const firstAfter = (list, t) => list.find((x) => x >= t) ?? null;
    const replies = all.filter(agentSaid).map((m) => stamp(m.at)).filter((t) => t !== null).sort((a, b) => a - b);
    const doneAt = allSteps.filter((s) => s.kind === 'status' && s.state === 'done').map((s) => stamp(s.at)).filter((t) => t !== null);
    const stepTimes = steps.map((s) => stamp(s.at)).filter((t) => t !== null);
    const unreadIds = all.filter((m) => m.from === 'person' && m.seen === false).map((m) => m.id);
    const lastUnread = unreadIds.at(-1);
    const agentName2 = String(agentName || said(words, 'agent'));
    /* It said it is done: said once, at the end, while it is the last thing that happened (a message of either side, or a step, after it: gone). */
    const doneStatus = status?.state === 'done' ? stamp(status.at) : null;
    const lastEvent = Math.max(-Infinity, ...all.filter((m) => m.from !== 'system').map((m) => stamp(m.at) ?? -Infinity), ...allSteps.filter((s) => !(s.kind === 'status' && s.state === 'done')).map((s) => stamp(s.at) ?? -Infinity));
    const doneEnd = doneStatus !== null && lastEvent <= doneStatus;
    /* The newest message of the agent: never folded, so that nothing seems left below it. */
    const newestAgent = [...messages].reverse().find((m) => m.from !== 'person' && m.from !== 'system')?.id;
    const items = messages.map((m) => {
        const t = stamp(m.at);
        if (m.from === 'system') {
            return { type: 'message', key: `y:${String(m.id ?? '')}`, id: String(m.id ?? ''), from: 'system', kind: 'system', level: levelOf(m.level), tone: ['warn', 'bad'].includes(m.tone) ? m.tone : ['warn', 'bad'].includes(m.level) ? m.level : '',
                topic: cut(m.topic, 40), brief: cut(m.brief, 60),
                text: String(m.text ?? ''), time: clock(t, locale), when: whole(t, locale), at: t, label: '', file: null, files: [], outside: '', choices: [], open: false, mark: '',
                actions: (Array.isArray(m.actions) ? m.actions : []).filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string' && a.label.trim()).slice(0, ACTIONS_MAX).map((a) => ({ id: a.id, label: a.label.trim().slice(0, LABEL_MAX) })) };
        }
        const show = m.kind === 'show';
        const open = openQuestion(m, answered);
        const reach = typeof m.open === 'string' ? m.open : null;
        const person = m.from === 'person';
        const item = {
            type: 'message', key: `m:${String(m.id ?? '')}`,
            id: String(m.id ?? ''), from: person ? 'person' : 'agent', kind: String(m.kind ?? 'say'),
            text: show ? String(m.text || nameOf(m.path)) : String(m.text ?? ''),
            short: !person && typeof m.short === 'string' ? cut(m.short, 200) : '',
            refs: (Array.isArray(m.refs) ? m.refs : []).filter((r) => r && typeof r.path === 'string' && typeof r.open === 'string').slice(0, 20).map((r) => ({ path: r.path, open: r.open })),
            time: clock(t, locale), when: whole(t, locale), at: t,
            label: open ? said(words, 'asks') : '',
            file: show && !(Array.isArray(m.files) && m.files.length) ? { path: String(m.path ?? ''), open: reach, name: nameOf(m.path), shown: detailed ? String(m.path ?? '') : (m.text ? nameOf(m.path) : ''), picture: PICTURE.test(String(m.path ?? '')) } : null,
            /* Several files shown at once (or one with a title): one gallery, each with its title; simple shows those that open. */
            gallery: show && Array.isArray(m.files) ? m.files.slice(0, 12).filter((f) => f && typeof f.path === 'string' && (detailed || typeof f.open === 'string')).map((f) => ({ path: f.path, open: typeof f.open === 'string' ? f.open : null, name: nameOf(f.path), title: String(f.title || '') || titleOf(f.path), picture: PICTURE.test(f.path), shown: detailed ? f.path : '' })) : [],
            reaction: !person && m.reaction && typeof m.reaction.id === 'string' ? m.reaction.id : '',
            last: !person && m.id === newestAgent,
            decide: false,
            dictated: person && m.via === 'voice',
            tool: detailed && !person && agentTool ? String(agentTool) : '',
            /* What the person attached: by name, opened the application's way; its whole path in the detailed view. */
            files: (person && Array.isArray(m.files) ? m.files : []).slice(0, FILES_MAX).filter((f) => f && typeof f === 'object').map((f) => ({ path: String(f.path ?? ''), name: String(f.name || nameOf(f.path)), open: typeof f.open === 'string' ? f.open : null, shown: detailed ? String(f.path ?? '') : '', size: sizeText(f.size), picture: PICTURE.test(String(f.name || f.path || '')) })),
            actions: [],
            outside: show && !(Array.isArray(m.files) && m.files.length) && reach === null ? said(words, 'outside', { path: String(m.path ?? '') }) : show && Array.isArray(m.files) && m.files.some((f) => f && typeof f.open !== 'string') && detailed ? said(words, 'outside', { path: m.files.filter((f) => f && typeof f.open !== 'string').map((f) => f.path).join(', ') }) : '',
            choices: m.kind === 'ask' && !answered.has(m.id) ? (m.choices ?? []).map(String) : [],
            open,
            closed: m.kind === 'ask' && m.closed && !answered.has(m.id) ? said(words, 'closed', { answer: cut(m.closed.text, 300) }) : '',
            reply: person && (m.answers || m.re) ? said(words, 'in-reply', { question: cut(m.question || m.quote, 90) }) : '',
            mark: '',
        };
        if (person) {
            /* Where it is: sent; read; worked on; handled -- each with its time. */
            const seenAt = m.seen === false ? null : stamp(m.seenAt) ?? t;
            const handled = seenAt === null ? null : [firstAfter(replies, Math.max(seenAt, t ?? 0)), firstAfter(doneAt, seenAt)].filter((x) => x !== null).sort((a, b) => a - b)[0] ?? null;
            const working = seenAt !== null && handled === null && firstAfter(stepTimes, seenAt) !== null && status?.state !== 'done';
            item.state = seenAt === null ? 'sent' : handled !== null ? 'done' : working ? 'working' : 'read';
            item.sign = detailed || item.state !== 'done' ? item.state : '';
            item.signText = [said(words, `state-${item.state}`), said(words, 'sent-at', { time: item.time }), seenAt !== null ? said(words, 'read-at', { time: clock(seenAt, locale) }) : '', handled !== null ? said(words, 'done-at', { time: clock(handled, locale) }) : ''].filter(Boolean).join(' · ');
            /* "Remind it": only for the newest message not read, long unread, while the agent seems idle. */
            item.remind = m.id === lastUnread && t !== null && now - t >= IDLE_MS && (lastAgent === null || now - lastAgent >= IDLE_MS);
        }
        return item;
    });
    /* Who says it: once above each run of messages of one side. */
    let side = '';
    for (const item of items) {
        const who = item.from === 'system' ? '' : item.from;
        item.name = who && who !== side ? (who === 'person' ? said(words, 'you') : agentName2) : '';
        side = who;
    }
    /* It waits, its last word a message that is not a question with choices: a
       decision on that message, offered under it (Go ahead / Disagree) until
       the person reacts or writes. */
    const waitsSince = status?.state === 'waiting' ? stamp(status.at) : null;
    const lastTalk = items.filter((x) => x.from !== 'system').at(-1);
    if (waitsSince !== null && lastTalk?.from === 'agent' && (lastTalk.kind === 'say' || lastTalk.kind === 'show') && !lastTalk.reaction
        && !all.some((m) => m.from === 'person' && (stamp(m.at) ?? 0) >= waitsSince)) lastTalk.decide = true;
    /* A step, as shown: a state is said with its word, what it does with its own words. */
    const step = (s) => {
        const t = stamp(s.at);
        const doing = s.kind === 'doing';
        const note = String(s.note ?? '');
        return { kind: doing ? 'doing' : 'status', state: ['working', 'waiting', 'done'].includes(s.state) ? s.state : 'working',
            text: doing ? note : `${state(s.state)}${note ? ` - ${note}` : ''}`, time: clock(t, locale), when: whole(t, locale), at: t };
    };
    const count = (n) => (n === 1 ? said(words, 'step-one') : said(words, 'steps-many', { count: n }));
    const group = (list, i) => ({ type: 'steps', key: `s:${String(list[0].id ?? i)}`, label: count(list.length), open: detailed, steps: list.map(step), at: stamp(list[0].at), end: stamp(list.at(-1).at) });
    /* The newest step, when it says what it does now: the line at the end. */
    const newest = allSteps.at(-1);
    const lastAgentMessage = Math.max(-Infinity, ...items.filter((x) => x.from === 'agent' && x.at !== null).map((x) => x.at));
    const live = newest && (newest.kind === 'doing' || (newest.kind === 'status' && newest.state === 'working')) && (stamp(newest.at) ?? 0) > lastAgentMessage ? newest : null;
    /* The state at the top, in the detailed view, is not said again at the end. */
    const topState = detailed && status && !live && status.state !== 'waiting' && !(status.state === 'done' && doneEnd) ? status : null;
    const kept = steps.filter((s) => s !== live && !(topState && s === steps.filter((x) => x.kind === 'status').at(-1) && s.at === status.at));
    /* The steps go to the next message of the AGENT; in the detailed view, between the messages, as they came. */
    const rows = [];
    let next = 0;
    items.forEach((item, i) => {
        if (item.from === 'system' || (item.from === 'person' && !detailed)) { rows.push({ ...item, trail: null, end: item.at }); return; }
        const before = [];
        while (item.at !== null && next < kept.length && (stamp(kept[next].at) ?? 0) <= item.at) before.push(kept[next++]);
        /* Simple: on the message they led to, no line of their own; detailed: unfolded above it. */
        if (before.length && detailed) rows.push(group(before, i));
        const trail = before.length && !detailed ? (({ type, at: a, end, ...g }) => g)(group(before, i)) : null;
        rows.push({ ...item, trail, end: item.at });
    });
    const turn = kept.slice(next);
    const busy = unreadIds.length > 0;
    if (live) {
        const t = stamp(live.at);
        const fresh = t !== null && now - t < STALE_MS;
        const doing = String(live.note ?? '') || state('working');
        rows.push({ type: 'now', key: `n:${String((turn[0] ?? live).id ?? '')}`, ...step(live), text: busy && fresh ? said(words, 'busy', { doing }) : doing, busy: busy && fresh, live: fresh, quiet: fresh ? '' : said(words, 'quiet', { time: clock(t, locale) }),
            label: turn.length ? count(turn.length) : '', open: detailed, steps: turn.map(step), at: stamp((turn[0] ?? live).at), end: t });
    } else if (turn.length) rows.push(group(turn, items.length));
    /* It waits for the person: said once, at the end, until they write; not when its last word is a question, which says so. */
    const lastSaid = items.filter((x) => x.from !== 'system').at(-1);
    const waitsAt = status?.state === 'waiting' ? stamp(status.at) : null;
    if (waitsAt !== null && !all.some((m) => m.from === 'person' && (stamp(m.at) ?? 0) >= waitsAt) && !(lastSaid?.open)) {
        const note = String(status.note ?? '').trim();
        rows.push({ type: 'waits', key: 'w', text: note ? said(words, 'waits-you-note', { note }) : said(words, 'waits-you'), time: clock(waitsAt, locale), when: whole(waitsAt, locale), at: null, end: null });
    }
    if (doneEnd) {
        const note = String(status.note ?? '').trim();
        rows.push({ type: 'done', key: 'D', text: note ? said(words, 'done-end-note', { note }) : said(words, 'done-end'), time: clock(doneStatus, locale), when: whole(doneStatus, locale), at: null, end: null });
    }
    /* Simple: a run of news of one topic is one compact line. */
    const packed = [];
    for (const row of rows) {
        const prev = packed.at(-1);
        if (!detailed && row.from === 'system' && row.level === 'news' && row.topic) {
            if (prev?.type === 'group' && prev.topic === row.topic) { prev.lines.push(row); prev.end = row.at; continue; }
            if (prev?.from === 'system' && prev.level === 'news' && prev.topic === row.topic && prev.type === 'message') { packed[packed.length - 1] = { type: 'group', key: `G:${prev.id}`, topic: row.topic, lines: [prev, row], at: prev.at, end: row.at }; continue; }
        }
        packed.push(row);
    }
    for (const row of packed) if (row.type === 'group') { row.text = said(words, 'grouped', { topic: row.topic, count: row.lines.length, briefs: row.lines.map((l) => l.brief || l.text).join(', ') }); row.time = row.lines.at(-1).time; row.lines = row.lines.map(({ at, end, trail, ...l }) => l); }
    /* The day when it changes, the time when long passed. */
    const shown = [];
    let previous = null;
    for (const row of packed) {
        if (row.at !== null && row.at !== undefined) {
            if (previous === null || dayKey(row.at) !== dayKey(previous)) shown.push({ type: 'day', key: `d:${dayKey(row.at)}`, text: dayText(row.at, now, words, locale) });
            else if (row.at - previous > GAP_MS) shown.push({ type: 'gap', key: `g:${row.key}`, text: clock(row.at, locale) });
        }
        shown.push(row);
        if (row.end !== null && row.end !== undefined) previous = row.end;
    }
    const doingNow = live ? String(live.note ?? '') : '';
    return {
        view: detailed ? 'detailed' : 'simple',
        /* Detailed only, and only what the end of the thread does not say already. */
        status: !detailed ? null
            : topState ? { state: topState.state, text: `${state(topState.state)}${topState.note ? ` - ${topState.note}` : ''}`, when: whole(stamp(topState.at), locale) }
                : live ? { state: 'working', text: `${state('working')}${doingNow ? ` - ${doingNow}` : ''}`, when: whole(stamp(live.at), locale) }
                    : status ? null : { state: 'none', text: said(words, 'no-status'), when: '' },
        empty: messages.length === 0 && shown.length === 0 ? said(words, 'empty') : null,
        rows: shown.map(({ at, end, ...row }) => row),
        items: items.map(({ at, type, key, ...item }) => item),
        unread: Number(data?.unread) || 0,
        /* The one question that waits, for what is typed to answer by default. */
        asking: (() => { const open = all.filter((m) => openQuestion(m, answered)); return open.length === 1 ? { id: String(open[0].id ?? ''), text: cut(open[0].short || open[0].text, 90) } : null; })(),
        files: detailed ? files.map((f) => ({ path: String(f.path ?? ''), name: nameOf(f.path), note: String(f.note ?? ''), open: typeof f.open === 'string' ? f.open : null, when: whole(stamp(f.at), locale) })) : [],
        summary: detailed ? `${said(words, 'files')} (${files.length})` : '',
        /* Detailed, on the side: what it does now and the steps of this turn; what the application says of its machine. */
        side: detailed ? { now: live ? { text: String(live.note ?? '') || state('working'), steps: turn.map(step) } : null,
            about: (Array.isArray(data?.about) ? data.about : []).filter((a) => a && typeof a.label === 'string' && typeof a.text === 'string').slice(0, 8).map((a) => ({ label: cut(a.label, 40), text: cut(a.text, 200), tone: ['warn', 'bad', 'ok'].includes(a.tone) ? a.tone : '' })) } : null,
    };
}

/* THE MEDIA OF THE THREAD, as plain data: every picture and every other file
   the person can open -- shown by the agent, placed or cited in its messages,
   attached by the person --, once each (where it came last), newest first.
   Each says the message it came with (`id`), to find it in the thread. */
export function media(data, { locale } = {}) {
    const all = (Array.isArray(data?.messages) ? data.messages : []).filter((m) => m && typeof m === 'object' && m.from !== 'system');
    const found = new Map();
    const put = (f, m, title) => {
        if (!f || typeof f.path !== 'string' || typeof f.open !== 'string') return;
        const t = stamp(m.at);
        found.delete(f.path);
        found.set(f.path, { path: f.path, open: f.open, name: nameOf(f.path), title: String(title || '') || titleOf(f.path), picture: PICTURE.test(f.path), id: String(m.id ?? ''), when: whole(t, locale), at: t });
    };
    for (const m of [...all].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
        if (m.kind === 'show') { if (Array.isArray(m.files) && m.files.length) for (const f of m.files) put(f, m, f?.title); else put({ path: m.path, open: m.open }, m, ''); }
        /* A picture placed in a message: its caption is its title. */
        const alts = new Map([...String(m.text ?? '').matchAll(/!\[([^\]\n]{0,300})\]\(\s*<?([^\s()<>]{1,2000})/g)].map((x) => [x[2], x[1]]));
        for (const r of Array.isArray(m.refs) ? m.refs : []) put(r, m, alts.get(r?.path));
        for (const f of Array.isArray(m.files) && m.from === 'person' ? m.files : []) put(f, m, '');
    }
    /* Newest message first; within one, in the order it gave them. */
    const list = [...found.values()].map((x, i) => ({ x, i })).sort((a, b) => (b.x.at ?? 0) - (a.x.at ?? 0) || a.i - b.i).map(({ x: { at, ...x } }) => x);
    return { pictures: list.filter((x) => x.picture), files: list.filter((x) => !x.picture) };
}

/* THE QUICK ANSWERS ABOVE THE BOX, as plain data: the choices of the
   question the agent asks now (the newest one not answered nor closed),
   first; then the application's ready answers, as many as are well formed. */
export function quick(data, replies = []) {
    const all = Array.isArray(data?.messages) ? data.messages : [];
    const answered = new Set(all.map((m) => m?.answers).filter(Boolean));
    const asks = [...all].reverse().find((m) => m && openQuestion(m, answered) && Array.isArray(m.choices) && m.choices.length > 0);
    const out = asks ? asks.choices.map((c) => ({ kind: 'choice', label: String(c), text: String(c), send: true, answers: String(asks.id ?? '') })) : [];
    for (const r of Array.isArray(replies) ? replies.slice(0, REPLIES_MAX) : []) {
        if (!r || typeof r.label !== 'string' || typeof r.text !== 'string' || !r.label.trim() || !r.text.trim()) continue;
        out.push({ kind: 'reply', label: r.label.trim().slice(0, LABEL_MAX), text: r.text.slice(0, TEXT_MAX), send: r.send === true });
    }
    return out;
}

/* Does this key, pressed in the box, send? Shift+Enter is a new line and
   Ctrl+Enter sends, always; Enter alone as `enter` says ('auto': where there
   is a fine pointer, a keyboard is likely). A key that composes a character
   (an accent, a syllable) is the composer's. */
export function sends(event, enter = 'auto', fine = false) {
    if (event?.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
    if (event.shiftKey || event.altKey) return false;
    if (event.ctrlKey || event.metaKey) return true;
    return enter === 'send' || (enter !== 'newline' && fine);
}

/* What dictation said joins what is in the box, with one space. */
export const joined = (before, said2) => {
    const add = String(said2 ?? '').replace(/\s+/g, ' ').trim();
    if (!add) return String(before ?? '');
    const was = String(before ?? '');
    return was === '' || /\s$/.test(was) ? `${was}${add}` : `${was} ${add}`;
};

/* A picture pasted without a name of its own is named by its time. */
export function pastedName(file, now = new Date()) {
    const name = String(file?.name ?? '');
    if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name;
    const p = (n) => String(n).padStart(2, '0');
    const ext = /\/(png|jpeg|gif|webp)$/.exec(String(file?.type ?? ''))?.[1]?.replace('jpeg', 'jpg') ?? 'png';
    return `screenshot-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const button = (text, className, act) => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', act); return b; };

const SVG = 'http://www.w3.org/2000/svg';
/* The drawn signs, made here: never markup from anywhere. */
const SIGNS = {
    mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7' }]],
    prefs: [['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }], ['circle', { cx: 15, cy: 7, r: 2 }], ['circle', { cx: 9, cy: 17, r: 2 }]],
    clip: [['path', { d: 'M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6' }]],
    stop: [['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }]],
    copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], ['path', { d: 'M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8' }]],
    sent: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'M12 12V7.5', class: 'parley-hand' }], ['path', { d: 'M12 12h3' }]],
    read: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    working: [['path', { d: 'M12 4a8 8 0 1 1-8 8', class: 'parley-turn' }]],
    done: [['path', { d: 'M2.5 12.5L7 17l9.5-9.5M11.5 16l1 1L22 7.5' }]],
    note: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
    tip: [['path', { d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z' }]],
    important: [['path', { d: 'M4 5h16v11H9l-5 4z' }], ['path', { d: 'M12 8v4M12 14.5v.5' }]],
    warning: [['path', { d: 'M12 3.5l9.5 16.5h-19z' }], ['path', { d: 'M12 10v4.5M12 17v.5' }]],
    caution: [['path', { d: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z' }], ['path', { d: 'M12 8v5M12 15.5v.5' }]],
    down: [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
    search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'M16 16l4.5 4.5' }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    minus: [['path', { d: 'M5 12h14' }]],
    left: [['path', { d: 'M15 5l-7 7 7 7' }]],
    right: [['path', { d: 'M9 5l7 7-7 7' }]],
    up: [['path', { d: 'M6 15l6-6 6 6' }]],
    file: [['path', { d: 'M6 3h8l5 5v13H6z' }], ['path', { d: 'M14 3v5h5' }]],
};
function sign(kind) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', `parley-sign parley-sign-${kind}`);
    for (const [tag, attributes] of SIGNS[kind] ?? SIGNS.stop) {
        const shape = document.createElementNS(SVG, tag);
        for (const [k, v] of Object.entries(attributes)) shape.setAttribute(k, String(v));
        svg.append(shape);
    }
    return svg;
}

/* Puts a text in the clipboard, within the click that asked: said "Copied" a
   moment. Refused: what was to be copied is selected, for the person to copy. */
function copying(b, text, words, select) {
    const done = () => { const was = b.dataset.label ?? b.textContent; b.dataset.label = was; b.dataset.copied = 'true'; b.lastChild.textContent = said(words, 'copied'); setTimeout(() => { b.lastChild.textContent = said(words, 'copy'); delete b.dataset.copied; }, 1500); };
    const fallback = () => { try { const range = document.createRange(); range.selectNodeContents(select); const s = globalThis.getSelection(); s.removeAllRanges(); s.addRange(range); } catch { /* nothing more to do */ } };
    try {
        const w = globalThis.navigator?.clipboard?.writeText?.(text);
        if (w && typeof w.then === 'function') w.then(done, fallback); else fallback();
    } catch { fallback(); }
}

/* THE PAGE, MADE FROM THE DATA OF markdown(): element by element, text as text. */
function painter(ctx) {
    const { words, refs, open, picture, diagram, highlight, cache } = ctx;
    const fileOf = (path) => (refs.has(path) ? { path, open: refs.get(path) } : null);
    const pathLink = (file, text) => { const b = button('', 'parley-pathlink', () => open?.(file)); b.append(text ?? file.path); b.title = file.path; return b; };
    function inlines(nodes, into) {
        for (const n of nodes) {
            if (n.t === 'text') into.append(...splitPaths(n.v));
            else if (n.t === 'br') into.append(el('br'));
            else if (n.t === 'code') { const f = fileOf(n.v.trim()); const c = el('code', '', n.v); into.append(f && open ? pathLink(f, c) : c); }
            else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'mark') { const e = el(n.t === 'del' ? 's' : n.t); inlines(n.c, e); into.append(e); }
            else if (n.t === 'badge') { const b = el('span', 'parley-badge', said(words, `badge-${n.kind}`)); b.dataset.kind = n.kind; into.append(b); }
            else if (n.t === 'link') {
                const href = safeLink(n.href);
                const f = n.href.startsWith('/') ? fileOf(n.href) : null;
                if (href) { const a = el('a', 'parley-link'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.title = href; inlines(n.c, a); into.append(a); }
                else if (f && open) { const holder = el('span'); inlines(n.c, holder); into.append(pathLink(f, holder)); }
                else inlines(n.c, into);
            } else if (n.t === 'img') into.append(imageOf(n));
        }
        return into;
    }
    /* The paths it cited that can be opened, in a run of text: each a link. */
    function splitPaths(text) {
        if (!refs.size || !open) return [text];
        const out = [];
        let rest = text;
        for (;;) {
            let best = null;
            for (const path of refs.keys()) { const at = rest.indexOf(path); if (at >= 0 && (best === null || at < best.at || (at === best.at && path.length > best.path.length))) best = { at, path }; }
            if (!best) break;
            const end = best.at + best.path.length;
            /* A path is whole: not the start of a longer one. */
            if (/[^\s.,;:!?)\]'"]/.test(rest[end] ?? ' ')) { out.push(rest.slice(0, end)); rest = rest.slice(end); continue; }
            if (best.at) out.push(rest.slice(0, best.at));
            out.push(pathLink({ path: best.path, open: refs.get(best.path) }));
            rest = rest.slice(end);
        }
        if (rest) out.push(rest);
        return out;
    }
    function imageOf(n) {
        const f = n.src.startsWith('/') ? fileOf(n.src) : null;
        const url = f && picture && PICTURE.test(n.src) ? ctx.pictureUrl(f) : null;
        if (url) return thumb(f, url, n.alt);
        /* Never loaded from anywhere else: its caption, said not shown. */
        const off = el('span', 'parley-noimg', n.alt || nameOf(n.src)); off.title = said(words, 'not-shown');
        return off;
    }
    /* A picture, its title under it (the caption it was given), its file's name on hover. */
    function thumb(file, url, alt) {
        const b = el('button', 'parley-thumb'); b.type = 'button';
        const name = file.path.split('/').pop();
        const img = el('img'); img.src = url; img.alt = alt || name; img.loading = 'lazy'; img.decoding = 'async'; img.dataset.zoom = url; img.dataset.name = name; img.dataset.title = alt || '';
        b.title = alt ? `${alt} - ${name}` : file.path; b.append(img);
        b.addEventListener('click', () => ctx.zoom(img));
        if (alt) { const fig = el('span', 'parley-figure'); fig.append(b, el('span', 'parley-caption', alt)); return fig; }
        return b;
    }
    function code(block) {
        const holder = el('div', 'parley-code');
        const bar = el('div', 'parley-code-bar');
        bar.append(el('span', 'parley-code-lang', block.lang));
        const pre = el('pre');
        const c = el('code', '', block.text);
        pre.append(c);
        const b = el('button', 'parley-copy'); b.type = 'button'; b.append(sign('copy'), el('span', '', said(words, 'copy')));
        b.addEventListener('click', () => copying(b, block.text, words, c));
        bar.append(b);
        holder.append(bar, pre);
        if (highlight && block.lang && block.text.length <= 40_000) {
            const key = `h:${block.lang}:${block.text}`;
            const paint = (tree) => { if (Array.isArray(tree)) c.replaceChildren(...tokens(tree, 0)); };
            if (cache.has(key)) paint(cache.get(key));
            else Promise.resolve().then(() => highlight(block.text, block.lang)).then((tree) => { if (Array.isArray(tree)) { cache.set(key, tree); paint(tree); } }, () => {});
        }
        return holder;
    }
    /* A token tree, as spans: its type a class, its text text. */
    function tokens(list, depth) {
        const out = [];
        for (const t of list) {
            if (typeof t === 'string') { out.push(t); continue; }
            if (!t || typeof t !== 'object' || depth > 12) continue;
            const span = el('span', 'parley-tok');
            for (const name of [t.type, ...(Array.isArray(t.alias) ? t.alias : [t.alias])]) if (typeof name === 'string' && /^[a-z][a-z-]{0,30}$/.test(name)) span.classList.add(`parley-tok-${name}`);
            span.append(...(Array.isArray(t.content) ? tokens(t.content, depth + 1) : [String(t.content ?? '')]));
            out.push(span);
        }
        return out;
    }
    function drawing(block) {
        if (!diagram || block.text.length > 20_000) return code(block);
        const fig = el('figure', 'parley-diagram');
        fig.append(el('span', 'parley-diagram-wait', said(words, 'diagram')));
        const key = `d:${block.text}`;
        const show = (url) => { const img = el('img'); img.src = url; img.alt = said(words, 'diagram'); img.dataset.zoom = url; img.dataset.name = said(words, 'diagram'); img.dataset.title = said(words, 'diagram'); const b = el('button', 'parley-thumb'); b.type = 'button'; b.append(img); b.addEventListener('click', () => ctx.zoom(img)); fig.replaceChildren(b); };
        const failed = () => fig.replaceWith(code({ ...block, lang: block.lang }));
        if (cache.has(key)) { const u = cache.get(key); if (u) show(u); else return code(block); }
        else {
            Promise.resolve().then(() => diagram(block.text)).then((svg) => {
                if (typeof svg !== 'string' || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) throw new Error('not a drawing');
                /* A picture runs nothing and loads nothing: the drawing is shown as one. */
                const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
                cache.set(key, url); ctx.urls.add(url); show(url);
            }).catch(() => { cache.set(key, null); failed(); });
        }
        return fig;
    }
    function blocks(list, into) {
        for (const b of list) into.append(block(b));
        return into;
    }
    function block(b) {
        if (b.t === 'p') {
            const p = inlines(b.c, el('p'));
            /* Pictures alone on a line: side by side. */
            if (b.c.some((n) => n.t === 'img') && b.c.every((n) => n.t === 'img' || n.t === 'br' || (n.t === 'text' && !n.v.trim()))) p.className = 'parley-pictures';
            return p;
        }
        if (b.t === 'h') { const h = el(`h${Math.min(6, b.level + 2)}`, `parley-h parley-h${b.level}`); return inlines(b.c, h); }
        if (b.t === 'hr') return el('hr');
        if (b.t === 'code') return b.lang === 'mermaid' ? drawing(b) : code(b);
        if (b.t === 'quote') return blocks(b.c, el('blockquote'));
        if (b.t === 'alert') {
            const box = el('div', 'parley-callout'); box.dataset.kind = b.kind; box.setAttribute('role', 'note');
            const head = el('p', 'parley-callout-head'); head.append(sign(b.kind), el('span', '', said(words, b.kind)));
            box.append(head);
            return blocks(b.c, box);
        }
        if (b.t === 'list') {
            const list = el(b.ordered ? 'ol' : 'ul');
            if (b.start !== undefined && Number.isInteger(b.start)) list.start = b.start;
            for (const item of b.items) {
                const li = el('li');
                if (item.task !== null) { li.className = 'parley-task'; const box = el('span', 'parley-check', item.task ? '☑' : '☐'); box.dataset.done = String(item.task); li.append(box); }
                /* A list of single lines stays tight. */
                if (item.c.length === 1 && item.c[0].t === 'p') inlines(item.c[0].c, li); else blocks(item.c, li);
                list.append(li);
            }
            return list;
        }
        if (b.t === 'table') {
            const wrap = el('div', 'parley-table'); wrap.tabIndex = 0;
            const table = el('table');
            const head = el('thead'); const tr = el('tr');
            b.head.forEach((cell, k) => { const th = el('th'); if (b.align[k]) th.style.textAlign = b.align[k]; tr.append(inlines(cell, th)); });
            head.append(tr);
            const body = el('tbody');
            for (const row of b.rows) { const r = el('tr'); row.forEach((cell, k) => { const td = el('td'); if (b.align[k]) td.style.textAlign = b.align[k]; r.append(inlines(cell, td)); }); body.append(r); }
            table.append(head, body); wrap.append(table);
            return wrap;
        }
        return el('span');
    }
    return { blocks, inlines, thumb };
}

/* A PICTURE, LARGE, as a chat app shows it: it grows out of its thumbnail
   (briefly; not at all for whoever asked for less motion); zoomed with a
   pinch, a double tap, the wheel, + and - (up to ZOOM_MAX times the fitted
   size), moved when zoomed (drag); the previous or next picture with the
   arrows, a swipe, or the strip of small pictures at the bottom; closed
   simply: a tap on the picture not zoomed, or on the ground around it, a
   swipe down on a touch screen, Escape, or its button. A pinch on it
   zooms the picture alone, never the page: two fingers on the stage are
   kept from the browser (touch events not passive, as touch-action is not
   always obeyed: a browser set to "force zoom" ignores it); and if the
   page is zoomed all the same while it is open, the viewer is sized back
   to the screen (visualViewport), its bars keeping their size. */
const ZOOM_MAX = 8;
const OPEN_MS = 220;
function zoomer(root, words) {
    const box = el('div', 'parley-zoom'); box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
    const bar = el('div', 'parley-zoom-bar');
    const title = el('span', 'parley-zoom-name');
    /* Each button says what it does: an icon only where it is plain (- + < >), and
       its word next to it where there is room; "1:1" and "Fit" in words; Close
       apart, at the end, with its word always. */
    const tool = (kind, key, act, short) => {
        const b = el('button', `parley-zoom-${kind}`); b.type = 'button'; b.title = said(words, key); b.setAttribute('aria-label', b.title);
        if (kind === 'left') b.append(icon('chevron-left', 'parley-sign'));
        else if (kind === 'right') b.append(icon('chevron-right', 'parley-sign'));
        else if (kind === 'close') b.append(icon('x', 'parley-sign'));
        else if (kind === 'minus' || kind === 'plus') b.append(sign(kind));
        b.append(el('span', short ? 'parley-zoom-short' : 'parley-zoom-word', short ? said(words, short) : said(words, key)));
        b.addEventListener('click', act); return b;
    };
    const stage = el('div', 'parley-zoom-stage');
    const img = el('img'); img.alt = ''; img.draggable = false;
    stage.append(img);
    const strip = el('div', 'parley-zoom-strip'); strip.setAttribute('role', 'group');
    let list = [];
    let at = 0;
    let s = 1; let tx = 0; let ty = 0; let fit = 1;
    let back = null;
    let from = null;
    const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* Sizes in the stage's own pixels; `k`, screen pixels per stage pixel (other than 1 only while the page is zoomed). */
    const size = () => ({ w: stage.offsetWidth || stage.getBoundingClientRect().width || 1, h: stage.offsetHeight || stage.getBoundingClientRect().height || 1 });
    const k = () => { const w = stage.offsetWidth; const r = stage.getBoundingClientRect().width; return w && r ? r / w : 1; };
    const natural = () => ({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    const max = () => Math.max(fit * ZOOM_MAX, 2);
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; box.dataset.zoomed = String(s > fit * 1.01); };
    const clamp = () => {
        const { w, h } = size(); const n = natural();
        const iw = n.w * s; const ih = n.h * s;
        tx = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, tx));
        ty = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, ty));
    };
    const zoomTo = (next, px, py) => {
        const { w, h } = size();
        const x = px ?? w / 2; const y = py ?? h / 2;
        const to = Math.min(max(), Math.max(fit * 0.5, next));
        tx = x - (x - tx) * (to / s); ty = y - (y - ty) * (to / s); s = to;
        clamp(); apply();
    };
    const fitIn = () => { const { w, h } = size(); const n = natural(); fit = Math.min(1, w / n.w, h / n.h); s = fit; tx = 0; ty = 0; clamp(); apply(); };
    /* Grows out of the thumbnail it was opened from: from its place and size to the fitted ones. */
    const grow = () => {
        const r = from; from = null;
        if (!r || still() || !r.width) return;
        const st = stage.getBoundingClientRect(); const n = natural();
        const q = k(); const g = r.width / q / (n.w * s);
        const fx = tx; const fy = ty; const fs = s;
        img.style.transition = 'none';
        img.style.transform = `translate(${(r.left - st.left) / q}px, ${(r.top - st.top) / q}px) scale(${fs * g})`;
        box.dataset.opening = 'true';
        void img.getBoundingClientRect();
        img.style.transition = `transform ${OPEN_MS}ms cubic-bezier(.2,.8,.2,1)`;
        img.style.transform = `translate(${fx}px, ${fy}px) scale(${fs})`;
        setTimeout(() => { img.style.transition = ''; delete box.dataset.opening; }, OPEN_MS + 30);
    };
    img.addEventListener('load', () => { fitIn(); grow(); });
    const go = (step) => { if (list.length < 2) return; at = (at + step + list.length) % list.length; load(); };
    const prev = tool('left', 'previous', () => go(-1));
    const next = tool('right', 'next', () => go(1));
    const tools = el('div', 'parley-zoom-tools'); tools.setAttribute('role', 'group');
    tools.append(tool('minus', 'zoom-out', () => zoomTo(s / 1.5)), tool('plus', 'zoom-in', () => zoomTo(s * 1.5)), tool('actual', 'zoom-actual', () => zoomTo(1), 'zoom-actual-short'), tool('fit', 'zoom-fit', fitIn, 'zoom-fit-short'), prev, next);
    const shut = tool('close', 'close', () => close(), 'close');
    bar.append(title, tools, shut);
    box.append(bar, stage, strip);
    function paintStrip() {
        strip.hidden = list.length < 2;
        if (strip.hidden) { strip.replaceChildren(); return; }
        strip.replaceChildren(...list.map((item, i) => {
            const b = el('button', 'parley-zoom-thumb'); b.type = 'button'; b.title = item.title || item.name; b.setAttribute('aria-label', b.title);
            if (i === at) b.setAttribute('aria-current', 'true');
            const small = el('img'); small.src = item.url; small.alt = ''; small.loading = 'lazy'; b.append(small);
            b.addEventListener('click', () => { at = i; load(); });
            return b;
        }));
        strip.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    }
    function load() {
        const item = list[at];
        title.textContent = `${item.title || item.name}${list.length > 1 ? ` (${at + 1}/${list.length})` : ''}`;
        title.title = item.name;
        prev.hidden = next.hidden = list.length < 2;
        img.style.transition = ''; box.style.opacity = ''; delete box.dataset.dragging;
        img.src = item.url; img.alt = item.title || item.name;
        paintStrip();
        if (img.complete && img.naturalWidth) { fitIn(); grow(); }
    }
    /* The page zoomed while it is open: the viewer covers the screen at its own size again. */
    const view = () => (typeof window !== 'undefined' ? window.visualViewport : null);
    const keep = () => {
        const v = view();
        if (box.hidden || !v || Math.abs(v.scale - 1) < 0.01) { box.style.transform = ''; box.style.transformOrigin = ''; box.style.width = ''; box.style.height = ''; box.style.right = ''; box.style.bottom = ''; box.dataset.kept = 'false'; }
        else {
            box.style.transformOrigin = '0 0'; box.style.right = 'auto'; box.style.bottom = 'auto';
            box.style.width = `${v.width * v.scale}px`; box.style.height = `${v.height * v.scale}px`;
            box.style.transform = `translate(${v.offsetLeft}px, ${v.offsetTop}px) scale(${1 / v.scale})`;
            box.dataset.kept = 'true';
        }
        if (!box.hidden && img.naturalWidth) { if (s <= fit * 1.01) fitIn(); else { clamp(); apply(); } }
    };
    const watch = (on) => { const v = view(); if (!v) return; for (const type of ['resize', 'scroll']) (on ? v.addEventListener : v.removeEventListener).call(v, type, keep); };
    function close() { clearTimeout(tapping); watch(false); box.hidden = true; keep(); box.style.opacity = ''; img.removeAttribute('src'); try { back?.focus?.({ preventScroll: true }); } catch { /* gone */ } }
    box.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (event.key === 'ArrowLeft') go(-1);
        else if (event.key === 'ArrowRight') go(1);
        else if (event.key === '+' || event.key === '=') zoomTo(s * 1.5);
        else if (event.key === '-') zoomTo(s / 1.5);
        else if (event.key === '0') fitIn();
    });
    stage.addEventListener('wheel', (event) => { event.preventDefault(); const r = stage.getBoundingClientRect(); const q = k(); zoomTo(s * Math.exp(-event.deltaY * 0.0015), (event.clientX - r.left) / q, (event.clientY - r.top) / q); }, { passive: false });
    /* Two fingers on the picture are the picture's: the browser does not zoom the page with them. */
    const mine = (event) => { if (event.touches && event.touches.length >= 2 && event.cancelable) event.preventDefault(); };
    stage.addEventListener('touchstart', mine, { passive: false });
    stage.addEventListener('touchmove', mine, { passive: false });
    stage.addEventListener('gesturestart', (event) => event.preventDefault?.(), { passive: false });
    /* Fingers and a mouse: one moves (or swipes), two pinch, a double tap zooms, one tap closes. */
    const pointers = new Map();
    let pinch = null; let start = null; let lastTap = 0; let tapping;
    const onPicture = (x, y) => { const r = img.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
    stage.addEventListener('pointerdown', (event) => {
        stage.setPointerCapture?.(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 1) start = { x: event.clientX, y: event.clientY, tx, ty, t: Date.now(), touch: event.pointerType !== 'mouse' };
        if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s }; start = null; }
    });
    stage.addEventListener('pointermove', (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const r = stage.getBoundingClientRect(); const q = k();
        if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), ((a.x + b.x) / 2 - r.left) / q, ((a.y + b.y) / 2 - r.top) / q); return; }
        if (pointers.size !== 1 || !start) return;
        if (s > fit * 1.01) { tx = start.tx + (event.clientX - start.x) / q; ty = start.ty + (event.clientY - start.y) / q; clamp(); apply(); return; }
        /* Not zoomed, pulled down by a finger: it follows, and fades. */
        const dy = event.clientY - start.y;
        if (start.touch && dy > 10 && Math.abs(dy) > Math.abs(event.clientX - start.x)) { box.dataset.dragging = 'true'; img.style.transform = `translate(${start.tx}px, ${start.ty + dy / q}px) scale(${s})`; box.style.opacity = String(Math.max(0.35, 1 - dy / 600)); }
    });
    const up = (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size > 0 || !start) return;
        const dx = event.clientX - start.x; const dy = event.clientY - start.y;
        const was = start; start = null;
        if (box.dataset.dragging) { delete box.dataset.dragging; if (dy > 90) { close(); return; } box.style.opacity = ''; apply(); return; }
        if (s <= fit * 1.01 && Math.abs(dx) > 60 && Math.abs(dy) < 80) { go(dx < 0 ? 1 : -1); return; }
        if (Math.hypot(dx, dy) >= 10 || Date.now() - was.t >= 300) return;
        const now = Date.now();
        const r = stage.getBoundingClientRect();
        if (now - lastTap < 320) {
            clearTimeout(tapping); lastTap = 0;
            if (s > fit * 1.01) fitIn(); else zoomTo(Math.max(fit * 2.5, 1), (event.clientX - r.left) / k(), (event.clientY - r.top) / k());
            return;
        }
        lastTap = now;
        /* One tap: on the ground, or on the picture not zoomed, it closes -- once it is sure no second tap follows. */
        const ground = !onPicture(event.clientX, event.clientY);
        if (ground || s <= fit * 1.01) { clearTimeout(tapping); tapping = setTimeout(() => { if (!box.hidden) close(); }, 330); }
    };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', (event) => { pointers.delete(event.pointerId); start = null; pinch = null; delete box.dataset.dragging; box.style.opacity = ''; apply(); });
    return {
        box,
        /* `all`: [{ url, name, title }]; `thumb`: the element it was opened from, to grow out of. */
        show(all, index, thumb) {
            if (!all.length) return;
            back = document.activeElement; list = all; at = Math.max(0, Math.min(all.length - 1, index));
            try { from = thumb?.getBoundingClientRect?.() ?? null; } catch { from = null; }
            box.hidden = false; watch(true); keep(); load(); box.focus?.({ preventScroll: true });
        },
        get open() { return !box.hidden; },
        close,
    };
}

/* The kind of a file, as a short tag on its card. */
const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? '')); return m ? m[1].toUpperCase() : ''; };
/* The icon of a file's kind, and its kind and size in a word under its name. */
const fileGlyph = (name) => { const holder = el('span', 'parley-card-icon'); holder.dataset.kind = fileIcon(name); holder.append(icon(fileIcon(name), 'parley-sign')); return holder; };
const kindLine = (name, size) => el('span', 'parley-size', [extOf(name), size].filter(Boolean).join(' · '));
function card(file, words, open, size, title) {
    const c = el('span', 'parley-card');
    const about = el('span', 'parley-card-about'); about.append(el('span', 'parley-name', title || file.name));
    if (title && title !== file.name) about.title = file.name;
    about.append(kindLine(file.name, size));
    c.append(fileGlyph(file.name), about);
    if (open && file.open !== null) c.append(button(said(words, 'open'), 'parley-open', () => open(file)));
    return c;
}

export function mount(root, { load, send, words = {}, open, terminal, remind, view: first = 'simple', onView, every = 3000, locale,
    voice: speaking, autoSend = false, onAutoSend, replies: ready = [], enter = 'auto', touch, attach, act,
    markdown: rich = false, picture, diagram, highlight, agentName, agentTool, react, reactions: offered = REACTIONS } = {}) {
    /* The set of reactions offered: well formed, each with an icon this file has. */
    const reactions = (Array.isArray(offered) ? offered : REACTIONS).filter((r) => r && /^[a-z][a-z0-9-]{0,29}$/.test(r.id) && typeof r.icon === 'string').slice(0, 12);
    let as = VIEWS.includes(first) ? first : 'simple';
    let shown = '';
    let count = 0;
    let latest;
    let folded = true;
    /* Steps the person opened or closed, by group; messages unfolded: kept while the page is drawn again. */
    const unfolded = new Map();
    const expanded = new Set();
    /* Drawings and coloured code, made once each; the addresses of drawings, let go at the end. */
    const cache = new Map();
    const urls = new Set();
    let revealed = '';
    /* Kept at the newest, as a chat is, until the reader scrolls up; and again once back down. */
    let sticky = true;
    let awayCount = 0;
    root.classList.add('parley');
    const top = el('div', 'parley-top');
    const status = el('p', 'parley-status'); status.setAttribute('role', 'status');
    const repaint = () => { shown = ''; if (latest) paint(latest); };
    /* ONE button of settings, beside the state: the view, "send when I stop", the search. */
    const prefs = el('div', 'parley-prefs');
    const prefsButton = el('button', 'parley-prefs-open'); prefsButton.type = 'button'; prefsButton.title = said(words, 'settings'); prefsButton.setAttribute('aria-label', prefsButton.title);
    prefsButton.setAttribute('aria-expanded', 'false'); prefsButton.setAttribute('aria-haspopup', 'true'); prefsButton.append(sign('prefs'));
    const prefsMenu = el('div', 'parley-prefs-menu'); prefsMenu.hidden = true; prefsMenu.setAttribute('role', 'group'); prefsMenu.setAttribute('aria-label', said(words, 'settings'));
    const showPrefs = (on) => { prefsMenu.hidden = !on; prefsButton.setAttribute('aria-expanded', String(on)); };
    const switcher = el('div', 'parley-views'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', said(words, 'view'));
    const choose = (v) => { if (v === as) return; as = v; root.dataset.view = as; unfolded.clear(); seenKeys = null; try { onView?.(as); } catch { /* the page's business */ } repaint(); void refresh(); };
    const toggles = VIEWS.map((v) => { const b = button(said(words, v), '', () => { choose(v); showPrefs(false); }); b.dataset.view = v; return b; });
    switcher.append(...toggles);
    /* "Send when I stop", a switch: on, what is said is sent by itself. */
    const autoButton = el('button', 'parley-auto'); autoButton.type = 'button';
    const autoWord = el('span', 'parley-auto-word', said(words, 'auto-send'));
    const autoOff = el('span', 'parley-auto-off', said(words, 'auto-send-off'));
    autoButton.append(autoWord, autoOff);
    /* Under a heading of its own: it is about dictation. */
    const dictation = el('div', 'parley-dictation'); dictation.append(el('p', 'parley-menu-head', said(words, 'dictation')), autoButton);
    const searchButton = el('button', 'parley-search-open'); searchButton.type = 'button'; searchButton.append(sign('search'), el('span', '', said(words, 'search')));
    /* Every picture and file of the thread, as a gallery. */
    const mediaButton = el('button', 'parley-media-open'); mediaButton.type = 'button'; mediaButton.append(icon('images', 'parley-sign'), el('span', '', said(words, 'media')));
    prefsMenu.append(switcher, searchButton, mediaButton, dictation);
    prefs.append(prefsButton, prefsMenu);
    prefsButton.addEventListener('click', () => showPrefs(prefsMenu.hidden));
    prefs.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !prefsMenu.hidden) { showPrefs(false); prefsButton.focus(); } });
    const away = (event) => { if (!prefsMenu.hidden && !(event.target instanceof Node && prefs.contains(event.target))) showPrefs(false); };
    document.addEventListener('pointerdown', away);
    top.append(status, prefs);
    /* SEARCH IN THE THREAD: plain text, both sides; "n of m", previous, next. */
    const finder = el('div', 'parley-search'); finder.hidden = true; finder.setAttribute('role', 'search');
    const query = el('input', 'parley-search-box'); query.type = 'search'; query.placeholder = said(words, 'search'); query.setAttribute('aria-label', said(words, 'search'));
    const found = el('span', 'parley-search-count'); found.setAttribute('aria-live', 'polite');
    const findTool = (kind, key, act2) => { const b = el('button', `parley-search-${kind}`); b.type = 'button'; b.title = said(words, key); b.setAttribute('aria-label', b.title); b.append(sign(kind === 'prev' ? 'up' : kind === 'next' ? 'down' : 'close')); b.addEventListener('click', act2); return b; };
    let matches = [];
    let current = 0;
    finder.append(sign('search'), query, found, findTool('prev', 'previous', () => step(-1)), findTool('next', 'next', () => step(1)), findTool('close', 'close', () => closeSearch()));
    const main = el('div', 'parley-main');
    const thread = el('div', 'parley-thread'); thread.setAttribute('aria-live', 'polite'); thread.tabIndex = -1;
    const aside = el('aside', 'parley-aside');
    /* Back to the newest, when the reader scrolled up: with how many came meanwhile. */
    const jump = el('button', 'parley-jump'); jump.type = 'button'; jump.hidden = true; jump.title = said(words, 'newest'); jump.setAttribute('aria-label', jump.title);
    const jumpCount = el('span', 'parley-jump-count'); jump.append(sign('down'), jumpCount);
    const column = el('div', 'parley-column'); column.append(thread, jump);
    main.append(column, aside);
    /* Quick answers, above the box: one line, the rest one tap away. */
    const quickRow = el('div', 'parley-quick'); quickRow.hidden = true; quickRow.dataset.open = 'false';
    const chips = el('div', 'parley-replies'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', said(words, 'replies'));
    const moreChips = el('button', 'parley-replies-more'); moreChips.type = 'button'; moreChips.hidden = true; moreChips.setAttribute('aria-expanded', 'false');
    quickRow.append(chips, moreChips);
    /* What is typed answers this question: said above the box, one click to take away. */
    const replyRow = el('div', 'parley-replying'); replyRow.hidden = true;
    let replyTo = null;
    const dismissed = new Set();
    const form = el('form', 'parley-form'); form.autocomplete = 'off';
    /* The box, and on its frame what the microphone does: over it, taking no room. */
    const field = el('div', 'parley-field');
    const box = el('textarea', 'parley-box'); box.rows = 1; box.maxLength = TEXT_MAX; box.placeholder = said(words, 'placeholder'); box.setAttribute('aria-label', said(words, 'placeholder'));
    const mic = el('button', 'parley-mic'); mic.type = 'button'; mic.setAttribute('aria-pressed', 'false');
    /* Listening, it says in a word that a touch stops it. */
    const micWord = el('span', 'parley-mic-word', said(words, 'mic-stop'));
    /* "Send when I stop" is on: a dot on the microphone, said in its label. */
    const micAuto = el('span', 'parley-mic-auto'); micAuto.setAttribute('aria-hidden', 'true');
    mic.append(sign('mic'), sign('stop'), micWord, micAuto);
    const go = el('button', 'parley-send', said(words, 'send')); go.type = 'submit';
    /* Files to attach: picked beside the box, pasted, dropped; shown above it until they are sent. */
    const clip = el('button', 'parley-attach'); clip.type = 'button'; clip.title = said(words, 'attach'); clip.setAttribute('aria-label', clip.title); clip.append(sign('clip'));
    clip.hidden = !attach?.upload;
    const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.tabIndex = -1;
    const pendingRow = el('div', 'parley-attached'); pendingRow.hidden = true; pendingRow.setAttribute('aria-live', 'polite');
    let pending = [];
    /* While dictating, what the microphone does: a label on the box's frame,
       seen; the same words in a status for whoever does not see it. */
    const heard = el('div', 'parley-voice'); heard.hidden = true; heard.setAttribute('aria-hidden', 'true');
    const heardText = el('span', 'parley-voice-text');
    heard.append(heardText);
    const heardSaid = el('span', 'parley-voice-said'); heardSaid.setAttribute('role', 'status');
    field.append(box, heard, heardSaid);
    const problem = el('p', 'parley-problem'); problem.hidden = true; problem.setAttribute('role', 'alert');
    form.append(field, clip, mic, go, picker);
    const dropZone = el('div', 'parley-drop', said(words, 'drop')); dropZone.hidden = true;
    const zoom = zoomer(root, words);
    /* What floats over the chat first; then the chat, top to bottom. */
    /* The box and what goes with it: apart from the thread, by a line and some room. */
    const composer = el('div', 'parley-composer');
    composer.append(quickRow, replyRow, pendingRow, form, problem);
    const reacting = reactionPicker();
    const shelf = mediaShelf();
    root.replaceChildren(zoom.box, shelf.box, reacting.box, dropZone, top, finder, main, composer);
    root.dataset.view = as;
    const narrow = () => root.clientWidth > 0 && root.clientWidth < NARROW_PX;
    let wasNarrow = narrow();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); repaint(); } }) : null;
    watch?.observe(root);
    /* Part of what is in the box was dictated: the message says so (via: voice), once. */
    let dictatedNow = false;
    const say = async (text, answers, files, via) => {
        problem.hidden = true;
        try { await send(text, answers, ...(files?.length || via ? [files?.length ? files : undefined] : []), ...(via ? [{ via }] : [])); await refresh(); return true; } catch (error) { problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) }); problem.hidden = false; return false; }
    };
    const fileButton = (file) => (file.open === null || !open ? null : button(said(words, 'open'), 'parley-open', () => open(file)));
    const time = (text, when) => { const t = el('time', 'parley-time', text); if (when) t.title = when; return t; };
    const pictureUrl = (file) => { try { const u = picture?.(file); return typeof u === 'string' && u ? u : null; } catch { return null; } };
    /* The pictures of the thread, each once: one shown in a gallery and cited in a text is one picture, as in the media. */
    const zoomFrom = (img) => {
        const seen = new Map();
        for (const i of thread.querySelectorAll('img[data-zoom]')) if (!seen.has(i.dataset.zoom)) seen.set(i.dataset.zoom, { url: i.dataset.zoom, name: i.dataset.name || i.alt || '', title: i.dataset.title || '' });
        const all = [...seen.values()];
        zoom.show(all, Math.max(0, all.findIndex((x) => x.url === img.dataset.zoom)), img);
    };
    /* A list of steps, each with its time. */
    function trail(list) {
        const ol = el('ol', 'parley-trail');
        for (const s of list) {
            const li = el('li'); li.dataset.kind = s.kind; li.dataset.state = s.state;
            li.append(el('span', 'parley-step', s.text), time(s.time, s.when));
            ol.append(li);
        }
        return ol;
    }
    const bottom = () => { thread.scrollTop = thread.scrollHeight; };
    /* Opened or folded with one click; remembered while the page is drawn
       again. What was in sight stays in sight: the newest, when the reader
       was there; else the line clicked. */
    function folding(row, holder, opener, list, { only = () => true } = {}) {
        const set = (on) => { holder.dataset.open = String(on); opener.setAttribute('aria-expanded', String(on)); list.hidden = !on; };
        set(unfolded.has(row.key) ? unfolded.get(row.key) : row.open);
        const flip = () => {
            const was = sticky;
            const on = holder.dataset.open !== 'true'; unfolded.set(row.key, on); set(on);
            if (was) bottom(); else opener.scrollIntoView?.({ block: 'nearest' });
        };
        opener.addEventListener('click', (event) => { if (only(event)) flip(); });
        if (opener.tagName !== 'BUTTON') opener.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === opener) { event.preventDefault(); flip(); } });
    }
    /* What the agent wrote: rendered, or as plain text. */
    function body(item, v) {
        if (!rich) return [el('p', 'parley-text', item.text)];
        const refs = new Map(item.refs.map((r) => [r.path, r.open]));
        const paint2 = painter({ words, refs, open, picture: picture ? pictureUrl : null, pictureUrl, diagram, highlight, cache, urls, zoom: zoomFrom });
        const blocks = markdown(item.text);
        const whole2 = () => paint2.blocks(blocks, el('div', 'parley-md'));
        const shortLine = () => paint2.inlines(inline(item.short), el('p', 'parley-short'));
        const important = (list) => list.filter((b) => b.t === 'alert' && b.kind === 'important');
        const more = (key, open2) => { const b = button(said(words, open2 ? 'see-less' : key), 'parley-unfold', () => { if (open2) expanded.delete(item.id); else expanded.add(item.id); repaint(); }); b.setAttribute('aria-expanded', String(open2)); return b; };
        /* A question is never folded; the detailed view and a search unfold everything. */
        /* Nor is the newest message of the agent: nothing seems left below it, nothing to scroll for. */
        if (item.kind === 'ask' || item.last || v.view === 'detailed' || searching) return item.short ? [shortLine(), whole2()] : [whole2()];
        const isOpen = expanded.has(item.id);
        if (item.short) {
            if (isOpen) return [shortLine(), whole2(), more('see-details', true)];
            return [shortLine(), ...important(blocks).map((b) => paint2.blocks([b], el('div', 'parley-md'))), more('see-details', false)];
        }
        if (linesOf(item.text) > FOLD_LINES + 2) {
            if (isOpen) return [whole2(), more('see-more', true)];
            const md = whole2(); md.dataset.clip = 'true';
            /* Its IMPORTANT boxes below the fold stay in sight. */
            const below = important(blocks).filter((b) => b.line >= FOLD_LINES);
            return [md, ...below.map((b) => paint2.blocks([b], el('div', 'parley-md'))), more('see-more', false)];
        }
        return [whole2()];
    }
    /* A picture the person may see, large on a click; else a card. */
    function fileView(f, size) {
        const url = f.picture && f.open !== null ? pictureUrl(f) : null;
        if (url) return painter({ words, refs: new Map(), open, cache, urls, zoom: zoomFrom }).thumb(f, url, '');
        return card(f, words, open, size);
    }
    const item0 = (row) => (row.type === 'message' ? row : {});
    function systemLine(row) {
        const line = el('div', 'parley-system'); line.dataset.from = 'system'; line.dataset.level = row.level; if (row.tone) line.dataset.tone = row.tone; line.dataset.id = row.id;
        if (row.when) line.title = row.when;
        line.append(el('p', 'parley-system-text', row.text), time(row.time, row.when));
        if (row.actions.length && act) {
            const buttons = el('div', 'parley-system-actions');
            for (const a of row.actions) { const b = button(a.label, 'parley-act', () => { try { act(a.id, { id: row.id, text: row.text }); } catch { /* the application's business */ } }); b.dataset.act = a.id; buttons.append(b); }
            line.append(buttons);
        }
        return line;
    }
    function rowOf(row, v) {
        if (row.type === 'day' || row.type === 'gap') { const p = el('p', 'parley-divider'); p.dataset.kind = row.type; p.append(el('span', '', row.text)); return p; }
        if (row.type === 'steps') {
            const holder = el('div', 'parley-steps');
            const chip = button(row.label, 'parley-chip', () => {});
            const list = trail(row.steps);
            holder.append(chip, list);
            folding(row, holder, chip, list);
            return holder;
        }
        if (row.type === 'waits') { const p = el('p', 'parley-waits', row.text); p.title = row.when; p.setAttribute('role', 'status'); return p; }
        /* Done: said once, quietly, at the end. */
        if (row.type === 'done') { const p = el('p', 'parley-done', row.text); p.title = row.when; p.setAttribute('role', 'status'); return p; }
        if (row.type === 'group') {
            /* A run of news of one topic: one line, unfolded on a click. */
            const holder = el('div', 'parley-group'); holder.dataset.level = 'news';
            const line = button('', 'parley-group-line', () => {});
            line.append(el('span', 'parley-system-text', row.text), time(row.time, ''));
            const list = el('div', 'parley-group-lines');
            for (const l of row.lines) list.append(systemLine(l));
            holder.append(line, list);
            folding({ key: row.key, open: false }, holder, line, list);
            return holder;
        }
        if (item0(row).from === 'system') return systemLine(row);
        if (row.type === 'now') {
            const holder = el('div', 'parley-now'); holder.dataset.live = String(row.live); if (row.busy) holder.dataset.busy = 'true';
            const line = el(row.steps.length ? 'button' : 'p', 'parley-doing');
            if (row.steps.length) line.type = 'button';
            const dots = el('span', 'parley-dots'); dots.setAttribute('aria-hidden', 'true'); dots.append(el('i'), el('i'), el('i'));
            line.append(dots, el('span', 'parley-step', row.text));
            if (row.quiet) line.append(el('span', 'parley-quiet', row.quiet));
            else line.append(time(row.time, row.when));
            /* What came before, one click away: said by a mark, and in words to whoever does not see it. */
            if (row.label) { const more = el('span', 'parley-more'); more.title = row.label; more.append(el('span', 'parley-unseen', row.label)); line.append(more); }
            if (row.steps.length) { const list = trail(row.steps); holder.append(list, line); folding(row, holder, line, list); } else holder.append(line);
            return holder;
        }
        const item = row;
        const bubble = el('div', 'parley-said'); bubble.dataset.from = item.from; bubble.dataset.kind = item.kind; bubble.dataset.id = item.id; if (item.open) bubble.dataset.asking = 'true'; if (item.closed) bubble.dataset.closed = 'true';
        if (item.id && item.id === revealed) bubble.dataset.reveal = 'true';
        if (item.when) bubble.title = item.when;
        if (item.from === 'agent') {
            const head = el('p', 'parley-who');
            if (item.name) head.append(el('span', 'parley-name', item.name));
            /* Which tool it is: small, in the detailed view only. */
            if (item.name && item.tool && item.tool !== item.name) head.append(el('span', 'parley-tool', item.tool));
            if (item.time) head.append(time(item.trail ? `${item.time} - ${item.trail.label}` : item.time, item.when));
            bubble.append(head);
            /* React to it: a button that shows on hover (a right click, or a long press, too). */
            if (react && reactions.length && ['say', 'ask', 'show'].includes(item.kind)) {
                const r = el('button', 'parley-react-open'); r.type = 'button'; r.title = said(words, 'react'); r.setAttribute('aria-label', r.title); r.setAttribute('aria-haspopup', 'true');
                r.append(icon('smile-plus', 'parley-sign'));
                r.addEventListener('click', (event) => { event.stopPropagation(); reacting.open(item, bubble); });
                bubble.append(r);
            }
        } else if (item.name) bubble.append(el('p', 'parley-who-person', item.name));
        if (item.label) bubble.append(el('p', 'parley-label', item.label));
        if (item.reply) bubble.append(el('p', 'parley-inreply', item.reply));
        if (item.closed) bubble.append(el('p', 'parley-closed', item.closed));
        if (item.from === 'agent') bubble.append(...body(item, v)); else if (item.text) bubble.append(el('p', 'parley-text', item.text));
        if (item.file) {
            if (item.file.open !== null && item.file.picture && pictureUrl(item.file)) bubble.append(fileView(item.file));
            else {
                const row2 = el('div', 'parley-file');
                row2.append(card({ ...item.file, name: item.file.name }, words, open));
                if (item.file.shown && v.view === 'detailed') row2.append(el('span', 'parley-path', item.file.shown));
                bubble.append(row2);
            }
            if (item.outside) bubble.append(el('p', 'parley-outside', item.outside));
        }
        if (item.gallery?.length) {
            /* Shown together: one gallery, each its title under it; its pictures go large one after the other. */
            const gallery = el('div', 'parley-gallery'); gallery.dataset.count = String(item.gallery.length);
            for (const f of item.gallery) {
                const url = f.picture && f.open !== null ? pictureUrl(f) : null;
                const cell = el('figure', 'parley-gallery-item');
                if (url) cell.append(painter({ words, refs: new Map(), open, cache, urls, zoom: zoomFrom }).thumb(f, url, f.title));
                else { cell.append(card(f, words, open, '', f.title)); }
                if (f.shown) cell.append(el('span', 'parley-path', f.shown));
                gallery.append(cell);
            }
            bubble.append(gallery);
            if (item.outside) bubble.append(el('p', 'parley-outside', item.outside));
        }
        if (item.files?.length) {
            const pictures = el('div', 'parley-pictures');
            for (const f of item.files) {
                const url = f.picture && f.open !== null ? pictureUrl(f) : null;
                if (url) { pictures.append(fileView(f)); continue; }
                const row2 = el('div', 'parley-file'); row2.dataset.attached = 'true';
                row2.append(card(f, words, open, f.size));
                if (f.shown) row2.append(el('span', 'parley-path', f.shown));
                bubble.append(row2);
            }
            if (pictures.childNodes.length) bubble.append(pictures);
        }
        if (item.choices.length > 0) {
            const choices = el('div', 'parley-choices');
            for (const choice of item.choices) choices.append(button(choice, '', () => { for (const x of choices.children) x.disabled = true; void say(choice, item.id); }));
            bubble.append(choices);
        }
        /* A question: answered by what is typed, once Reply is pressed. */
        if ((item.open || item.closed) && send) {
            const r = button(said(words, 'reply'), 'parley-reply-to', () => { replyTo = { id: item.id, text: cut(item.short || item.text, 90), auto: false }; dismissed.delete(item.id); paintReply(); focusBox(); });
            bubble.append(r);
        }
        if (item.sign) {
            const s = el('span', 'parley-sign-state'); s.dataset.state = item.sign; s.title = item.signText; s.setAttribute('role', 'img'); s.setAttribute('aria-label', item.signText);
            s.append(sign(item.sign));
            bubble.append(s);
        }
        if (item.remind && remind) {
            bubble.append(button(said(words, 'remind'), 'parley-remind', async (event) => { event.target.disabled = true; try { await remind(); event.target.textContent = said(words, 'reminded'); } catch { event.target.disabled = false; } }));
        }
        /* Its reaction: an icon and its word, under it; a click opens the choice again. */
        if (item.reaction) {
            const r = reactions.find((x) => x.id === item.reaction);
            const chip = el('button', 'parley-reaction'); chip.type = 'button'; chip.dataset.reaction = item.reaction;
            chip.title = said(words, `react-${item.reaction}-hint`);
            chip.append(icon(r?.icon ?? 'smile-plus', 'parley-sign'), el('span', '', said(words, `react-${item.reaction}`)));
            if (react) chip.addEventListener('click', (event) => { event.stopPropagation(); reacting.open(item, bubble); }); else chip.disabled = true;
            bubble.append(chip);
        }
        /* A decision it waits for on this message: the two answers in sight, under it. */
        if (item.decide && react) {
            const two = ['go', 'disagree'].map((id) => reactions.find((r) => r.id === id)).filter(Boolean);
            if (two.length === 2) {
                const row2 = el('div', 'parley-decide'); row2.setAttribute('role', 'group'); row2.setAttribute('aria-label', said(words, 'decide'));
                for (const r of two) {
                    const b = el('button', 'parley-decide-choice'); b.type = 'button'; b.dataset.reaction = r.id; b.title = said(words, `react-${r.id}-hint`);
                    b.append(icon(r.icon, 'parley-sign'), el('span', '', said(words, `react-${r.id}`)));
                    b.addEventListener('click', async (event) => {
                        event.stopPropagation();
                        for (const x of row2.querySelectorAll('button')) x.disabled = true;
                        problem.hidden = true;
                        try { await react(item.id, r.id); await refresh(); } catch (error) { for (const x of row2.querySelectorAll('button')) x.disabled = false; problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) }); problem.hidden = false; }
                    });
                    row2.append(b);
                }
                bubble.append(row2);
            }
        }
        /* Dictated: a small microphone, said in words to whoever does not see it. */
        if (item.dictated) { const d = el('span', 'parley-dictated'); d.title = said(words, 'dictated'); d.setAttribute('role', 'img'); d.setAttribute('aria-label', d.title); d.append(icon('mic', 'parley-sign')); bubble.append(d); }
        if (item.from === 'person' && item.time) bubble.append(time(item.time, item.when));
        if (!item.trail) return bubble;
        /* The steps that led to it, opened by a click on it: above it, as they came. */
        const list = trail(item.trail.steps);
        list.dataset.for = item.id;
        bubble.dataset.steps = 'true'; bubble.tabIndex = 0;
        folding(item.trail, bubble, bubble, list, { only: (event) => !(event.target instanceof Element && event.target.closest('button, a, img, pre, table, .parley-md code, figure')) && !String(globalThis.getSelection?.() ?? '') });
        return [list, bubble];
    }
    /* REACTIONS: one choice over the page, near the message -- each icon with
       its word under it, its meaning on hover; the one standing is pressed,
       pressed again it is taken back. Reply is there too: what is typed next
       answers that message. Opened by the button on the message, a right
       click, or a long press. */
    function reactionPicker() {
        const box = el('div', 'parley-react'); box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', said(words, 'react')); box.tabIndex = -1;
        const grid = el('div', 'parley-react-grid');
        const replyB = el('button', 'parley-react-reply'); replyB.type = 'button'; replyB.append(icon('reply', 'parley-sign'), el('span', '', said(words, 'reply')));
        box.append(grid, replyB);
        let target = null;
        let marked = null;
        const close = () => {
            box.hidden = true; target = null;
            if (marked) { delete marked.dataset.reacting; marked = null; }
            if (box.dataset.sheet === 'true') { thread.style.paddingBottom = ''; delete box.dataset.sheet; }
        };
        const choose2 = async (id) => {
            const t = target; close();
            if (!t || !react) return;
            problem.hidden = true;
            try { await react(t.id, id); await refresh(); } catch (error) { problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) }); problem.hidden = false; }
        };
        replyB.addEventListener('click', () => { const t = target; close(); if (!t) return; replyTo = { id: t.id, text: cut(t.short || t.text, 90), auto: false }; dismissed.delete(t.id); paintReply(); focusBox(); });
        box.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
        document.addEventListener('pointerdown', (event) => { if (!box.hidden && !(event.target instanceof Node && box.contains(event.target)) && !(event.target instanceof Element && event.target.closest('.parley-react-open, .parley-reaction'))) close(); });
        return {
            box,
            open(item, bubble) {
                if (!react || !reactions.length) return;
                if (marked) delete marked.dataset.reacting;
                target = item; marked = bubble; bubble.dataset.reacting = 'true';
                /* "Go ahead" first, "Stop" last: the two never side by side. */
                const rank = (r, i) => { const k = PICKER_ORDER.indexOf(r.id); return r.id === 'stop' ? 1e6 : k < 0 ? 100 + i : k; };
                const ordered = reactions.map((r, i) => ({ r, k: rank(r, i) })).sort((x, y) => x.k - y.k).map((x) => x.r);
                grid.replaceChildren(...ordered.map((r) => {
                    const b = el('button', 'parley-react-choice'); b.type = 'button'; b.dataset.reaction = r.id;
                    b.title = said(words, `react-${r.id}-hint`);
                    b.setAttribute('aria-pressed', String(item.reaction === r.id));
                    b.append(icon(r.icon, 'parley-sign'), el('span', 'parley-react-word', said(words, `react-${r.id}`)));
                    if (item.reaction === r.id) b.title = `${said(words, 'react-remove')} - ${b.title}`;
                    b.addEventListener('click', () => void choose2(item.reaction === r.id ? null : r.id));
                    return b;
                }));
                replyB.hidden = !send;
                box.style.left = ''; box.style.top = '';
                /* On a narrow screen: a panel that rises from the bottom, the message kept in sight above it. */
                const sheet = root.getBoundingClientRect().width < SHEET_PX;
                if (sheet) box.dataset.sheet = 'true'; else delete box.dataset.sheet;
                box.hidden = false;
                if (sheet) {
                    /* Where it ends up, not where its rising starts. */
                    const top2 = root.getBoundingClientRect().bottom - box.offsetHeight; const area2 = thread.getBoundingClientRect();
                    thread.style.paddingBottom = `${Math.max(0, area2.bottom - top2) + 32}px`;
                    const at2 = bubble.getBoundingClientRect(); const room = top2 - 12 - area2.top;
                    const by = at2.height > room ? at2.top - area2.top - 8 : at2.bottom - (top2 - 12);
                    if (by > 0 || at2.height > room) thread.scrollTop += by;
                    box.focus?.({ preventScroll: true });
                    return;
                }
                /* Near the message, inside the chat. */
                const area = root.getBoundingClientRect(); const at = bubble.getBoundingClientRect(); const me = box.getBoundingClientRect();
                const left = Math.max(8, Math.min(area.width - me.width - 8, at.right - area.left - me.width));
                const below = at.top - area.top + 28;
                const top = below + me.height > area.height - 8 ? Math.max(8, at.top - area.top - me.height + 24) : below;
                box.style.left = `${left}px`; box.style.top = `${Math.max(8, Math.min(top, area.height - me.height - 8))}px`;
                /* The choice itself takes the keys (Tab goes through it), none looks chosen that is not. */
                box.focus?.({ preventScroll: true });
            },
            close,
            get open2() { return !box.hidden; },
        };
    }
    /* THE MEDIA OF THE THREAD: its pictures as a grid, newest first, and its
       other files as a list; a picture goes large, with all the others of the
       thread one after the other; "See in the thread" finds where it came. */
    function mediaShelf() {
        const box = el('div', 'parley-media'); box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', said(words, 'media')); box.tabIndex = -1;
        const head = el('div', 'parley-media-head');
        const tabs = el('div', 'parley-media-tabs'); tabs.setAttribute('role', 'tablist');
        const tab = (key) => { const b = el('button', 'parley-media-tab', said(words, key)); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = key; return b; };
        const tPictures = tab('media-pictures'); const tFiles = tab('media-files');
        tabs.append(tPictures, tFiles);
        const shut = el('button', 'parley-media-close'); shut.type = 'button'; shut.title = said(words, 'close'); shut.setAttribute('aria-label', shut.title); shut.append(icon('x', 'parley-sign'));
        head.append(el('h3', '', said(words, 'media')), tabs, shut);
        const body2 = el('div', 'parley-media-body');
        box.append(head, body2);
        let on = 'media-pictures';
        const close = () => { box.hidden = true; };
        const find = (id) => {
            close();
            const row = [...thread.querySelectorAll('.parley-said')].find((b) => b.dataset.id === id);
            if (!row) return;
            sticky = false; row.scrollIntoView?.({ block: 'center' });
            row.dataset.found = 'true'; setTimeout(() => { delete row.dataset.found; }, 1800);
            paintJump();
        };
        function paint3() {
            const m = media(latest, { locale });
            for (const b of [tPictures, tFiles]) b.setAttribute('aria-selected', String(b.dataset.tab === on));
            tPictures.textContent = `${said(words, 'media-pictures')} (${m.pictures.length})`; tFiles.textContent = `${said(words, 'media-files')} (${m.files.length})`;
            if (on === 'media-pictures') {
                const shown2 = m.pictures.map((f) => ({ f, url: picture ? pictureUrl(f) : null })).filter((x) => x.url);
                if (!shown2.length) { body2.replaceChildren(el('p', 'parley-empty', said(words, 'media-none'))); return; }
                /* Large: in the order of the thread, the oldest first. */
                const inOrder = [...shown2].reverse();
                const grid = el('div', 'parley-media-grid');
                for (const x of shown2) {
                    const cell = el('figure', 'parley-media-item');
                    const b = el('button', 'parley-media-thumb'); b.type = 'button'; b.title = `${x.f.title} - ${x.f.name}`;
                    const img = el('img'); img.src = x.url; img.alt = x.f.title; img.loading = 'lazy'; b.append(img);
                    b.addEventListener('click', () => zoom.show(inOrder.map((y) => ({ url: y.url, name: y.f.name, title: y.f.title })), inOrder.indexOf(x), img));
                    const where = button(said(words, 'see-in-thread'), 'parley-media-where', () => find(x.f.id));
                    where.title = x.f.when;
                    cell.append(b, el('figcaption', '', x.f.title), where);
                    grid.append(cell);
                }
                body2.replaceChildren(grid);
            } else {
                if (!m.files.length) { body2.replaceChildren(el('p', 'parley-empty', said(words, 'media-none'))); return; }
                const list = el('ul', 'parley-media-files');
                for (const f of m.files) {
                    const li = el('li');
                    li.append(card(f, words, open, '', f.title));
                    li.append(button(said(words, 'see-in-thread'), 'parley-media-where', () => find(f.id)));
                    list.append(li);
                }
                body2.replaceChildren(list);
            }
        }
        tPictures.addEventListener('click', () => { on = 'media-pictures'; paint3(); });
        tFiles.addEventListener('click', () => { on = 'media-files'; paint3(); });
        shut.addEventListener('click', close);
        box.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !zoom.open) { event.preventDefault(); close(); } });
        return { box, show() { box.hidden = false; paint3(); box.focus?.({ preventScroll: true }); }, close, get open() { return !box.hidden; } };
    }
    /* The side of the detailed view: what it does now with the steps of this turn, its machine as the application says, its files. */
    function sideNow(v) {
        const out = [];
        const now = el('section', 'parley-side-now');
        now.append(el('h3', '', said(words, 'side-now')));
        if (v.side?.now) { now.append(el('p', 'parley-side-doing', v.side.now.text)); if (v.side.now.steps.length) now.append(trail(v.side.now.steps)); }
        else now.append(el('p', 'parley-empty', said(words, 'side-nothing')));
        out.push(now);
        if (v.side?.about?.length) {
            const about = el('section', 'parley-side-about');
            about.append(el('h3', '', said(words, 'side-machine')));
            const dl = el('dl');
            for (const a of v.side.about) { const dt = el('dt', '', a.label); const dd = el('dd', '', a.text); if (a.tone) dd.dataset.tone = a.tone; dl.append(dt, dd); }
            about.append(dl);
            out.push(about);
        }
        return out;
    }
    function sideOf(v) {
        const files = el('section', 'parley-files');
        files.append(el('h3', '', said(words, 'files')));
        if (v.files.length === 0) files.append(el('p', 'parley-empty', said(words, 'no-files')));
        else {
            const list = el('ul');
            for (const f of v.files) {
                const li = el('li'); li.append(el('span', 'parley-name', f.name));
                const b = fileButton(f); if (b) li.append(' ', b);
                li.append(el('span', 'parley-path', f.open === null ? said(words, 'outside', { path: f.path }) : f.note || f.path));
                if (f.open === null) li.dataset.outside = 'true';
                li.title = f.path;
                list.append(li);
            }
            files.append(list);
        }
        return files;
    }
    /* The rows already seen: null before the first look. */
    let seenKeys = null;
    const wrap = (row, made) => {
        const r = el('div', 'parley-row'); r.dataset.type = row.type; if (row.key) r.dataset.key = row.key;
        if (row.type === 'message') r.dataset.from = row.from;
        r.append(...(Array.isArray(made) ? made : [made]));
        return r;
    };
    function paint(data) {
        latest = data;
        paintQuick();
        const v = view(data, { words, view: as, locale, agentName, agentTool });
        paintReply(v);
        const small = narrow();
        const mark = JSON.stringify([v, small, [...expanded], searching ? query.value : '']);
        if (mark === shown) return;
        shown = mark;
        for (const b of toggles) b.setAttribute('aria-pressed', String(b.dataset.view === v.view));
        status.hidden = !v.status;
        if (v.status) { status.dataset.state = v.status.state; status.textContent = v.status.text; status.title = [v.status.text, v.status.when].filter(Boolean).join(' - '); }
        /* The newest is shown: when the reader was at the bottom already, or when they wrote. */
        const wrote = v.items.length > count && v.items.at(-1)?.from === 'person';
        const atBottom = sticky || wrote;
        const keep = atBottom ? 0 : thread.scrollTop;
        if (!atBottom && v.items.length > count) { awayCount += v.items.length - count; paintJump(); }
        count = v.items.length;
        /* What arrives while the thread is open comes in softly, and is marked a moment: never on the first look, nor what was there. */
        const made = v.rows.map((row) => { const r = wrap(row, rowOf(row, v)); if (seenKeys !== null && row.key && !seenKeys.has(row.key) && !['day', 'gap'].includes(row.type)) r.dataset.arrived = row.type === 'message' && row.from !== 'system' ? 'message' : 'line'; return r; });
        const firstLook = seenKeys === null;
        seenKeys = new Set([...(seenKeys ?? []), ...v.rows.map((row) => row.key).filter(Boolean)]);
        if (firstLook && !v.rows.length) seenKeys = new Set();
        thread.replaceChildren(...made);
        for (const r of made) if (r.dataset.arrived) setTimeout(() => { delete r.dataset.arrived; }, 1700);
        watchChoices();
        if (v.empty) thread.append(el('p', 'parley-empty', v.empty));
        aside.hidden = v.view !== 'detailed';
        aside.dataset.narrow = String(small);
        if (v.view !== 'detailed') aside.replaceChildren();
        else {
            const way = terminal ? [button(said(words, 'terminal'), 'parley-terminal', () => terminal())] : [];
            if (small) {
                /* One line on a narrow screen, unfolded on demand; the way to the terminal stays in sight. */
                const fold = el('details', 'parley-fold'); fold.open = !folded;
                fold.addEventListener('toggle', () => { folded = !fold.open; });
                fold.append(el('summary', '', v.summary), ...sideNow(v), sideOf(v));
                aside.replaceChildren(fold, ...way);
            } else aside.replaceChildren(...sideNow(v), sideOf(v), ...way);
        }
        if (searching) { mark2(moveToLast); moveToLast = false; }
        if (atBottom && !searching) { bottom(); sticky = true; awayCount = 0; paintJump(); requestAnimationFrame(bottom); } else if (!searching) thread.scrollTop = keep;
    }
    const paintJump = () => { jump.hidden = sticky; jumpCount.textContent = awayCount > 0 ? String(awayCount) : ''; jumpCount.hidden = awayCount === 0; };
    jump.addEventListener('click', () => { sticky = true; awayCount = 0; bottom(); paintJump(); });
    thread.addEventListener('scroll', () => { const was = sticky; sticky = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40; if (sticky) awayCount = 0; if (was !== sticky || sticky) paintJump(); }, { passive: true });
    /* The page around it settles (fonts, a keyboard, a turned phone): the newest stays in sight. */
    const settle = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (sticky) bottom(); }) : null;
    settle?.observe(thread);
    /* A picture that arrives after the page was drawn makes it taller: the newest stays in sight. */
    thread.addEventListener('load', () => { if (sticky) bottom(); }, true);
    async function refresh() { try { paint(await load()); } catch { /* shown again at the next look */ } }
    /* The messages as last drawn. */
    const latestItems = () => (latest ? view(latest, { words, view: as, locale, agentName, agentTool }).items : []);
    /* ---- the search ---- */
    let searching = false;
    let moveToLast = false;
    /* Every place the words sought are, in what was said: each marked. */
    function mark2(move) {
        const q = query.value.trim().toLowerCase();
        matches = [];
        if (q) {
            const walk = (node) => {
                for (const child of [...node.childNodes]) {
                    if (child.nodeType === 3 || (child.childNodes.length === 0 && typeof child.data === 'string')) {
                        const text = child.textContent; const low = text.toLowerCase();
                        if (!low.includes(q)) continue;
                        const parts = [];
                        let from = 0; let at;
                        while ((at = low.indexOf(q, from)) >= 0) { if (at > from) parts.push(text.slice(from, at)); const m = el('mark', 'parley-found', text.slice(at, at + q.length)); parts.push(m); matches.push(m); from = at + q.length; }
                        if (from < text.length) parts.push(text.slice(from));
                        const holder = document.createDocumentFragment ? document.createDocumentFragment() : null;
                        if (holder) { holder.append(...parts); child.replaceWith(holder); } else { const s = el('span'); s.append(...parts); child.replaceWith?.(s); }
                    } else if (child.nodeType === 1 && !['BUTTON', 'svg', 'SVG', 'TIME', 'MARK'].includes(child.tagName)) walk(child);
                }
            };
            for (const said2 of thread.querySelectorAll('.parley-said, .parley-system')) walk(said2);
        }
        if (move) current = matches.length ? matches.length - 1 : 0;
        current = Math.min(current, Math.max(0, matches.length - 1));
        found.textContent = q ? said(words, 'found', { n: matches.length ? current + 1 : 0, m: matches.length }) : '';
        matches.forEach((m, i) => { if (i === current) m.dataset.now = 'true'; });
        matches[current]?.scrollIntoView?.({ block: 'center' });
    }
    const step = (n) => { if (!matches.length) return; matches[current].dataset.now = 'false'; current = (current + n + matches.length) % matches.length; matches[current].dataset.now = 'true'; found.textContent = said(words, 'found', { n: current + 1, m: matches.length }); matches[current].scrollIntoView?.({ block: 'center' }); };
    function openSearch() { searching = true; finder.hidden = false; showPrefs(false); query.focus(); query.select?.(); repaint(); }
    function closeSearch() { searching = false; finder.hidden = true; query.value = ''; matches = []; repaint(); sticky = true; bottom(); paintJump(); }
    searchButton.addEventListener('click', openSearch);
    mediaButton.addEventListener('click', () => { showPrefs(false); shelf.show(); });
    /* A right click on a message of the agent: its reactions. */
    thread.addEventListener('contextmenu', (event) => {
        if (!react || !reactions.length) return;
        const bubble = event.target instanceof Element ? event.target.closest('.parley-said[data-from="agent"]') : null;
        if (!bubble || (event.target instanceof Element && event.target.closest('a, img, pre, code')) || String(globalThis.getSelection?.() ?? '')) return;
        const item = latestItems().find((i) => i.id === bubble.dataset.id && ['say', 'ask', 'show'].includes(i.kind));
        if (!item) return;
        event.preventDefault(); reacting.open(item, bubble);
    });
    let typing2;
    query.addEventListener('input', () => { clearTimeout(typing2); typing2 = setTimeout(() => { moveToLast = true; repaint(); }, 150); });
    query.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closeSearch(); } else if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } });
    root.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'f') { event.preventDefault(); openSearch(); }
        else if (event.key === 'Escape' && searching && !zoom.open) closeSearch();
    });
    /* A long press on a touch screen shows a message's time, as hovering does with a mouse. */
    let pressing;
    let hiding;
    const unpress = () => { clearTimeout(pressing); pressing = undefined; };
    thread.addEventListener('pointerdown', (event) => {
        const bubble = event.target instanceof Element ? event.target.closest('.parley-said') : null;
        if (!bubble || event.pointerType === 'mouse') return;
        unpress();
        pressing = setTimeout(() => {
            /* On a message of the agent, a long press also offers its reactions. */
            const item = bubble.dataset.from === 'agent' && react && reactions.length ? latestItems().find((i) => i.id === bubble.dataset.id && ['say', 'ask', 'show'].includes(i.kind)) : null;
            if (item && !(event.target instanceof Element && event.target.closest('a, button, img'))) reacting.open(item, bubble);
            for (const other of thread.querySelectorAll('.parley-said[data-reveal]')) delete other.dataset.reveal;
            bubble.dataset.reveal = 'true'; revealed = bubble.dataset.id ?? '';
            clearTimeout(hiding);
            hiding = setTimeout(() => { revealed = ''; for (const other of thread.querySelectorAll('.parley-said[data-reveal]')) delete other.dataset.reveal; }, 4000);
        }, PRESS_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) thread.addEventListener(type, unpress, { passive: true });
    /* ---- the reply to a question ---- */
    function paintReply(v) {
        if (v) {
            const asking = v.asking;
            if (replyTo?.auto && (!asking || asking.id !== replyTo.id)) replyTo = null;
            if (replyTo && !replyTo.auto && !v.items.some((i) => i.id === replyTo.id && i.from === 'agent')) replyTo = null;
            if (!replyTo && asking && !dismissed.has(asking.id) && send) replyTo = { ...asking, auto: true };
        }
        replyRow.hidden = !replyTo;
        if (!replyTo) { replyRow.replaceChildren(); return; }
        const x = button('×', 'parley-unreply', () => { dismissed.add(replyTo.id); replyTo = null; paintReply(); stayIn(); });
        x.title = said(words, 'not-a-reply'); x.setAttribute('aria-label', x.title);
        replyRow.replaceChildren(el('span', 'parley-replying-text', said(words, 'replying', { question: replyTo.text })), x);
    }
    /* ---- the box: the keyboard, the ready answers, the voice ---- */
    const mediaQuery = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
    const touching = typeof touch === 'boolean' ? touch : mediaQuery('(any-pointer: coarse)');
    /* With a keyboard, Enter sends and Shift+Enter is a new line, as in every
       chat; on a touch screen Enter is a new line and the button sends. */
    const keyboard = mediaQuery('(pointer: fine)');
    /* The box grows with what is in it, up to a few lines, then scrolls. */
    const grow = () => {
        box.style.height = '';
        /* No higher than it is while what it holds fits: no pixel won or lost by rounding. */
        const full = box.scrollHeight + 2;
        if (full > box.getBoundingClientRect().height + 1) box.style.height = `${full}px`;
    };
    box.addEventListener('input', () => { grow(); if (!box.value.trim()) dictatedNow = false; });
    /* The page puts the cursor in the box only where no keyboard comes up
       with it; on a touch screen, only the person's finger does. */
    const focusBox = () => { if (!touching && document.activeElement !== box) box.focus({ preventScroll: true }); };
    /* A tap on a button of the box does not take the focus from it: the
       keyboard of a phone, open, stays open after sending; closed, it is not
       opened. Should a browser move the focus all the same, it is given back
       in the same gesture. */
    let typing = false;
    const keep = (event) => {
        if (!(event.target instanceof Element) || !event.target.closest('button')) return;
        typing = document.activeElement === box;
        if (typing) event.preventDefault();
    };
    for (const zone of [form, quickRow, prefs, thread, pendingRow, replyRow]) { zone.addEventListener('pointerdown', keep); zone.addEventListener('mousedown', keep); }
    const stayIn = () => { if (typing && document.activeElement !== box) box.focus({ preventScroll: true }); typing = false; };
    /* What is about to go with the message: pictures as pictures, other files as cards; each can be taken away. */
    const previews = new Map();
    const previewOf = (file) => {
        if (!previews.has(file)) { let url = null; try { if (/^image\/(png|jpeg|gif|webp)$/.test(file.type) && typeof URL?.createObjectURL === 'function') url = URL.createObjectURL(file); } catch { url = null; } previews.set(file, url); }
        return previews.get(file);
    };
    const letGo = (keep2) => { for (const [file, url] of previews) if (!keep2.includes(file)) { if (url) try { URL.revokeObjectURL(url); } catch { /* gone */ } previews.delete(file); } };
    const paintPending = () => {
        letGo(pending);
        pendingRow.hidden = pending.length === 0;
        /* Where they go, and who opens them: said where they are chosen. */
        const where = el('p', 'parley-where', said(words, 'attach-where'));
        pendingRow.replaceChildren(where, ...pending.map((file, i) => {
            const url = previewOf(file);
            const chip = el('span', url ? 'parley-pending parley-pending-picture' : 'parley-pending');
            if (url) { const img = el('img'); img.src = url; img.alt = file.name; chip.append(img); chip.title = `${file.name} (${sizeText(file.size)})`; }
            else { const about = el('span', 'parley-card-about'); about.append(el('span', 'parley-name', file.name), kindLine(file.name, sizeText(file.size))); chip.append(fileGlyph(file.name), about); }
            const x = button('\u00d7', 'parley-unattach', () => { pending = pending.filter((_, j) => j !== i); paintPending(); stayIn(); });
            x.title = said(words, 'remove-file', { name: file.name }); x.setAttribute('aria-label', x.title);
            chip.append(x);
            return chip;
        }));
    };
    /* Files from the button, pasted, or dropped: the same way, the same limits. */
    const add = (files) => { if (!attach?.upload) return; const list = [...files].filter((f) => f && typeof f.name === 'string'); if (!list.length) return; pending = [...pending, ...list].slice(0, FILES_MAX); paintPending(); };
    let uploading = false;
    const sendBox = async () => {
        const text = box.value.trim();
        if ((!text && pending.length === 0) || uploading) return;
        const answers = replyTo?.id;
        const answered = () => { if (replyTo && replyTo.id === answers) { dismissed.add(answers); replyTo = null; paintReply(); } };
        const via = dictatedNow ? 'voice' : undefined;
        if (pending.length === 0) { box.value = ''; grow(); dictatedNow = false; if (await say(text, answers, undefined, via)) answered(); else dictatedNow = Boolean(via); return; }
        /* The files go first, one after the other; the message only once they all went. */
        uploading = true; go.disabled = clip.disabled = true;
        problem.hidden = false; problem.dataset.kind = 'sending'; problem.textContent = said(words, 'sending-files');
        const files = [];
        try {
            for (const file of pending) files.push(await attach.upload(file, file.name));
        } catch (error) {
            problem.dataset.kind = ''; problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) });
            uploading = false; go.disabled = clip.disabled = false;
            return;
        }
        problem.hidden = true; problem.dataset.kind = '';
        const sent = await say(text, answers, files, via);
        if (sent) dictatedNow = false;
        uploading = false; go.disabled = clip.disabled = false;
        if (sent) { answered(); pending = []; paintPending(); if (box.value.trim() === text) { box.value = ''; grow(); } }
    };
    clip.addEventListener('click', () => { if (attach?.upload) picker.click(); });
    picker.addEventListener('change', () => { add(picker.files); picker.value = ''; });
    /* A picture pasted in the box (a screenshot) is attached, named by its time. */
    box.addEventListener('paste', (event) => {
        if (!attach?.upload) return;
        const data = event.clipboardData;
        const files = [...(data?.files ?? [])];
        if (!files.length) for (const item of data?.items ?? []) if (item.kind === 'file') { const f = item.getAsFile?.(); if (f) files.push(f); }
        if (!files.length) return;
        event.preventDefault();
        add(files.map((f) => { const name = pastedName(f); return name === f.name || typeof File !== 'function' ? f : new File([f], name, { type: f.type }); }));
    });
    /* Files dropped anywhere on the chat; where they can be dropped is said while they are carried. */
    let carried = 0;
    const carrying = (event) => attach?.upload && [...(event.dataTransfer?.types ?? [])].includes('Files');
    root.addEventListener('dragenter', (event) => { if (!carrying(event)) return; event.preventDefault(); carried += 1; dropZone.hidden = false; });
    root.addEventListener('dragover', (event) => { if (!carrying(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragleave', (event) => { if (!carrying(event)) return; carried = Math.max(0, carried - 1); if (carried === 0) dropZone.hidden = true; });
    root.addEventListener('drop', (event) => { if (!carrying(event)) return; event.preventDefault(); carried = 0; dropZone.hidden = true; add(event.dataTransfer.files); });
    /* ---- dictation ---- */
    let voice = speaking?.listen ? speaking : null;
    let stopping = null;
    let starting = false;
    let hearing = '';
    let auto = autoSend === true;
    let autoTimer;
    let writing = null;
    let hush;
    let gone = false;
    /* What the microphone does, said in the box: shown, and told. */
    const tell = (state, text) => { heard.hidden = false; heard.dataset.state = state; heardText.textContent = text; heardSaid.textContent = text; };
    const paintVoice = () => {
        const on = Boolean(stopping);
        mic.hidden = !voice;
        dictation.hidden = !voice;
        autoOff.hidden = auto;
        mic.setAttribute('aria-pressed', String(on));
        mic.dataset.state = on ? hearing || 'listening' : '';
        mic.dataset.auto = String(auto);
        const label = said(words, on ? 'mic-stop' : 'mic');
        mic.title = auto ? `${label} - ${said(words, 'auto-on')}` : label; mic.setAttribute('aria-label', mic.title); micWord.hidden = !on;
        autoButton.setAttribute('aria-pressed', String(auto));
        field.dataset.voice = on ? hearing || 'listening' : '';
        box.placeholder = said(words, on ? 'voice-placeholder' : 'placeholder');
        if (on) tell(hearing || 'listening', writing ? said(words, 'voice-wait') : said(words, `voice-${hearing || 'listening'}`));
        else if (!hush) { heard.hidden = true; heard.dataset.state = ''; heardSaid.textContent = ''; }
    };
    const sendWritten = () => { clearTimeout(writing); writing = null; void sendBox(); paintVoice(); };
    const quiet = () => {
        const was = stopping; stopping = null;
        try { was?.(); } catch { /* the application's business */ }
        clearTimeout(autoTimer);
        if (writing) sendWritten();
        hearing = ''; paintVoice();
    };
    const listened = {
        phrase: (text) => {
            if (!stopping) return;
            box.value = joined(box.value, text).slice(0, TEXT_MAX); grow();
            dictatedNow = true;
            box.scrollTop = box.scrollHeight;
            if (writing) { sendWritten(); return; }
            if (auto) { clearTimeout(autoTimer); autoTimer = setTimeout(() => void sendBox(), AUTO_SEND_MS); }
        },
        state: (word) => {
            if (!stopping) return;
            hearing = ['calibrating', 'listening', 'hearing', 'transcribing'].includes(word) ? word : 'listening';
            /* Nothing more to write: what is there goes. */
            if (writing && hearing === 'listening') { sendWritten(); return; }
            paintVoice();
        },
        speech: () => clearTimeout(autoTimer),
        error: (message) => { if (stopping) tell('error', String(message ?? '')); },
    };
    mic.addEventListener('click', async () => {
        if (stopping) { quiet(); stayIn(); return; }
        if (starting || !voice) return;
        starting = true;
        clearTimeout(hush); hush = undefined;
        try {
            const closing = await voice.listen(listened);
            /* Taken off the page while the microphone was opening: it is closed at once. */
            if (gone) { try { closing?.(); } catch { /* as above */ } return; }
            stopping = typeof closing === 'function' ? closing : () => {};
            hearing = hearing || 'calibrating';
        } catch {
            stopping = null;
            tell('error', said(words, 'voice-off'));
            hush = setTimeout(() => { hush = undefined; paintVoice(); }, 6000);
        }
        starting = false;
        paintVoice();
        stayIn();
    });
    autoButton.addEventListener('click', () => {
        auto = !auto;
        if (!auto) clearTimeout(autoTimer);
        try { onAutoSend?.(auto); } catch { /* the application's business */ }
        paintVoice(); stayIn();
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        clearTimeout(autoTimer);
        /* Send pressed while a phrase is still being heard or written: it goes with it. */
        if (stopping && (hearing === 'hearing' || hearing === 'transcribing')) {
            if (!writing) writing = setTimeout(sendWritten, WRITE_WAIT_MS);
            paintVoice(); stayIn();
            return;
        }
        void sendBox();
        stayIn();
    });
    box.addEventListener('keydown', (event) => { if (sends(event, enter, keyboard)) { event.preventDefault(); form.requestSubmit(); } });
    /* ---- the quick answers ---- */
    let replies = Array.isArray(ready) ? ready : [];
    let quickShown = '';
    let quickOpen = false;
    const fold = () => {
        quickRow.dataset.open = String(quickOpen);
        chips.style.maxHeight = '';
        /* Those shown: the choices of the question are not, while its own buttons are in sight. */
        const kids = [...chips.children].filter((k) => !(quickRow.dataset.choices === 'seen' && k.classList.contains('parley-answer')));
        quickRow.dataset.empty = String(kids.length === 0);
        if (kids.length === 0) { moreChips.hidden = true; return; }
        const line = kids[0].getBoundingClientRect();
        const below = kids.filter((k) => k.getBoundingClientRect().top > line.top + line.height / 2).length;
        moreChips.hidden = below === 0 && !quickOpen;
        moreChips.setAttribute('aria-expanded', String(quickOpen));
        moreChips.textContent = quickOpen ? said(words, 'replies-less') : said(words, 'replies-more', { count: below });
        /* Folded: the first line alone, measured, so that it follows the size of the text. */
        if (!quickOpen && below > 0) chips.style.maxHeight = `${Math.ceil(line.height) + 2}px`;
    };
    moreChips.addEventListener('click', () => { quickOpen = !quickOpen; fold(); stayIn(); });
    const use = (q) => {
        if (q.send) {
            if (q.kind === 'choice') for (const b of chips.querySelectorAll('.parley-answer')) b.disabled = true;
            void say(q.text, q.kind === 'choice' ? q.answers : undefined);
        } else {
            box.value = joined(box.value, q.text).slice(0, TEXT_MAX); grow();
            focusBox();
            box.setSelectionRange?.(box.value.length, box.value.length);
        }
        stayIn();
    };
    function paintQuick() {
        const list = quick(latest, replies);
        const mark = JSON.stringify(list);
        if (mark === quickShown) return;
        quickShown = mark;
        chips.replaceChildren(...list.map((q) => {
            const b = button(q.label, q.kind === 'choice' ? 'parley-answer' : 'parley-reply', () => use(q));
            b.dataset.send = String(q.send);
            if (q.kind === 'reply' && q.text !== q.label) b.title = q.text;
            return b;
        }));
        quickRow.hidden = list.length === 0;
        if (!quickRow.hidden) fold();
    }
    const watchQuick = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!quickRow.hidden) fold(); }) : null;
    watchQuick?.observe(quickRow);
    /* The choices of the question it asks are near the thumb when its own
       buttons have scrolled away (or a keyboard took the room), and only then:
       never twice on the screen. */
    const seeing = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => { for (const e of entries) quickRow.dataset.choices = e.isIntersecting ? 'seen' : ''; if (!quickRow.hidden) fold(); }, { root: thread, threshold: 0.5 })
        : null;
    const watchChoices = () => {
        if (!seeing) return;
        seeing.disconnect();
        const asked = [...thread.querySelectorAll('.parley-choices')].at(-1);
        /* Until it is seen again, as it was: no flicker when the page is drawn again. */
        if (asked) seeing.observe(asked); else quickRow.dataset.choices = '';
    };
    paintVoice();
    paintQuick();
    /* What it does now stops moving once it is old: looked at again now and then, data or not. */
    const timer = every > 0 ? setInterval(() => { if (!document.hidden) void refresh(); }, every) : null;
    void refresh();
    return {
        refresh,
        get view() { return as; }, set view(v) { if (VIEWS.includes(v)) choose(v); },
        get voice() { return voice; }, set voice(v) { if (!v?.listen) quiet(); voice = v?.listen ? v : null; paintVoice(); },
        search: openSearch,
        get replies() { return replies; }, set replies(list) { replies = Array.isArray(list) ? list : []; paintQuick(); },
        get listening() { return Boolean(stopping); },
        get attach() { return attach; }, set attach(a) { attach = a?.upload ? a : undefined; clip.hidden = !attach; if (!attach) { pending = []; paintPending(); } },
        destroy() { gone = true; quiet(); letGo([]); for (const u of urls) try { URL.revokeObjectURL(u); } catch { /* gone */ } document.removeEventListener('pointerdown', away); clearTimeout(hush); if (timer) clearInterval(timer); clearTimeout(hiding); unpress(); watch?.disconnect(); settle?.disconnect(); watchQuick?.disconnect(); seeing?.disconnect(); root.replaceChildren(); root.classList.remove('parley'); delete root.dataset.view; },
    };
}
