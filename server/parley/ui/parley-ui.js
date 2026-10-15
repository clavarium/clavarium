/* THE EXCHANGE, SHOWN. One file, no framework, for any page.
 *
 *   import { mount } from './parley-ui.js';
 *   mount(element, { load, send, words, open, terminal, remind, view, onView, locale });
 *
 *   load()                 resolves with what parley-host.mjs read() gives
 *   send(text, answers)    the person wrote; `answers` is the id of the
 *                          question a choice answers
 *   words                  the words of the screen: texts(lang, own) of
 *                          parley-host.mjs, or any object with those keys
 *   open(file)             optional: opens a file the agent showed (`file`
 *                          is { path, open }: `open` is the application's
 *                          own reference, null when it cannot be opened)
 *   terminal()             optional: shows the agent's terminal
 *   remind()               optional: tells the agent again that a message waits
 *   view                   'simple' or 'detailed'; onView(view) when changed
 *   locale                 optional: how times and days are written (the
 *                          device's own way when not given)
 *
 * WHILE IT WORKS, WHAT IT DOES NOW. The agent says in one line what it is
 * doing (`parley doing`); the newest line is shown under the last message,
 * moving, until its next message comes: then it goes, and the steps that led
 * there are one click away: on that message in the simple view, unfolded
 * above it in the detailed one.
 *
 * TIMES, as a chat shows them: the day when it changes, the time when long
 * passed between two messages, and the time of each message on hover (a long
 * press on a touch screen).
 *
 * TWO VIEWS OF ONE EXCHANGE. Simple: bubbles, the one line of what it does
 * now, the choices to answer with, the files that can be opened, times on
 * hover, steps folded into the message they led to (a click on it opens
 * them) -- nothing the person cannot act on. Detailed: every
 * step unfolded between the messages with its time and state, the time of
 * every message, where the agent says it is, every file it showed with its
 * path (one that cannot be opened is said so), and a way to its terminal.
 *
 * EVERYTHING AN AGENT WROTE, AND EVERY WORD OF THE DICTIONARY, IS PUT ON THE
 * PAGE AS TEXT, never as markup: the first is chosen by a program, the
 * second by whoever wrote the dictionary.
 */
export const VIEWS = Object.freeze(['simple', 'detailed']);
/* The words this screen uses: a dictionary needs these keys. */
export const KEYS = Object.freeze(['send', 'placeholder', 'empty', 'view', 'simple', 'detailed', 'working', 'waiting', 'done', 'no-status', 'asks', 'open', 'outside',
    'not-read', 'read', 'remind', 'reminded', 'steps', 'no-steps', 'files', 'no-files', 'terminal', 'not-sent', 'step-one', 'steps-many', 'today', 'yesterday', 'quiet']);
/* Narrower than this, the detailed view folds its files into one line. */
export const NARROW_PX = 736;
/* Between two messages further apart than this, the time is said. */
export const GAP_MS = 60 * 60 * 1000;
/* What it does now stops moving when nothing came for this long: it may have stopped. */
export const STALE_MS = 15 * 60 * 1000;
/* A press this long on a touch screen shows a message's time. */
export const PRESS_MS = 450;

const fill = (word, values = {}) => String(word ?? '').replace(/\{([a-z]+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));
const said = (words, key, values) => fill(typeof words?.[key] === 'string' ? words[key] : key, values);
const nameOf = (path) => String(path ?? '').split('/').pop();
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

/* WHAT IS SHOWN, as plain data: the page is built from this and from nothing
   else, so it can be checked without a page. `rows`, in order: `day` and
   `gap` (a divider), `message` (in the simple view with `trail`: the steps
   that led to it, folded), `steps` (a group of steps, unfolded in the
   detailed view; in the simple one only those after its last message when
   it stopped), `now` (what it does now, with the steps of this turn before
   it). `items`: the messages alone. */
export function view(data, { words = {}, view: as = 'simple', now = Date.now(), locale } = {}) {
    const detailed = as === 'detailed';
    const all = Array.isArray(data?.messages) ? data.messages : [];
    const answered = new Set(all.map((m) => m.answers).filter(Boolean));
    /* Simple shows nothing the person cannot act on: a file that cannot be opened is in the detailed view only. */
    const messages = detailed ? all : all.filter((m) => !(m.kind === 'show' && typeof m.open !== 'string'));
    const status = data?.status ?? null;
    const state = (s) => said(words, ['working', 'waiting', 'done'].includes(s) ? s : 'working');
    const asking = messages.some((m) => m.kind === 'ask' && !answered.has(m.id));
    /* "Not read yet" only where it is plainly true: the person's last word, nothing from the agent after it. */
    const last = messages.at(-1);
    const unseen = last?.from === 'person' && last.seen === false ? last.id : undefined;
    const steps = (Array.isArray(data?.steps) ? data.steps : []).filter((s) => s && typeof s === 'object');
    const files = Array.isArray(data?.files) ? data.files : [];
    const items = messages.map((m) => {
        const show = m.kind === 'show';
        const open = m.kind === 'ask' && !answered.has(m.id);
        const reach = typeof m.open === 'string' ? m.open : null;
        const t = stamp(m.at);
        return {
            type: 'message', key: `m:${String(m.id ?? '')}`,
            id: String(m.id ?? ''), from: m.from === 'person' ? 'person' : 'agent', kind: String(m.kind ?? 'say'),
            text: show ? String(m.text || nameOf(m.path)) : String(m.text ?? ''),
            time: clock(t, locale), when: whole(t, locale), at: t,
            label: open ? said(words, 'asks') : '',
            file: show ? { path: String(m.path ?? ''), open: reach, name: nameOf(m.path), shown: detailed ? String(m.path ?? '') : (m.text ? nameOf(m.path) : '') } : null,
            outside: show && reach === null ? said(words, 'outside', { path: String(m.path ?? '') }) : '',
            choices: open ? (m.choices ?? []).map(String) : [],
            open,
            mark: m.from === 'person' && m.id === unseen ? said(words, 'not-read') : '',
        };
    });
    /* A step, as shown: a state is said with its word, what it does with its own words. */
    const step = (s) => {
        const t = stamp(s.at);
        const doing = s.kind === 'doing';
        const note = String(s.note ?? '');
        return { kind: doing ? 'doing' : 'status', state: ['working', 'waiting', 'done'].includes(s.state) ? s.state : 'working',
            text: doing ? note : `${state(s.state)}${note ? ` - ${note}` : ''}`, time: clock(t, locale), when: whole(t, locale), at: t };
    };
    /* While it works, where it is is what it does now: its newest step, when newer than the state it said. */
    const doingNow = (st) => { const n = steps.at(-1); return st?.state === 'working' && n?.kind === 'doing' && String(n.at ?? '') >= String(st.at ?? '') ? String(n.note ?? '') : ''; };
    const count = (n) => (n === 1 ? said(words, 'step-one') : said(words, 'steps-many', { count: n }));
    const group = (list, i) => ({ type: 'steps', key: `s:${String(list[0].id ?? i)}`, label: count(list.length), open: detailed, steps: list.map(step), at: stamp(list[0].at), end: stamp(list.at(-1).at) });
    /* The steps between two messages go between them; those after the last one are this turn's. */
    const rows = [];
    let next = 0;
    items.forEach((item, i) => {
        const before = [];
        while (item.at !== null && next < steps.length && (stamp(steps[next].at) ?? 0) <= item.at) before.push(steps[next++]);
        /* Simple: on the message they led to, no line of their own; detailed: unfolded above it. */
        if (before.length && detailed) rows.push(group(before, i));
        const trail = before.length && !detailed ? (({ type, at: a, end, ...g }) => g)(group(before, i)) : null;
        rows.push({ ...item, trail, end: item.at });
    });
    const turn = steps.slice(next);
    const newest = turn.at(-1);
    if (newest && (newest.kind === 'doing' || (newest.kind === 'status' && newest.state === 'working'))) {
        const t = stamp(newest.at);
        const fresh = t !== null && now - t < STALE_MS;
        const earlier = turn.slice(0, -1);
        rows.push({ type: 'now', key: `n:${String(turn[0].id ?? '')}`, ...step(newest), text: String(newest.note ?? '') || state('working'), live: fresh, quiet: fresh ? '' : said(words, 'quiet', { time: clock(t, locale) }),
            label: earlier.length ? count(earlier.length) : '', open: detailed, steps: earlier.map(step), at: stamp(turn[0].at), end: t });
    } else if (turn.length) rows.push(group(turn, items.length));
    /* The day when it changes, the time when long passed. */
    const shown = [];
    let previous = null;
    for (const row of rows) {
        if (row.at !== null && row.at !== undefined) {
            if (previous === null || dayKey(row.at) !== dayKey(previous)) shown.push({ type: 'day', key: `d:${dayKey(row.at)}`, text: dayText(row.at, now, words, locale) });
            else if (row.at - previous > GAP_MS) shown.push({ type: 'gap', key: `g:${row.key}`, text: clock(row.at, locale) });
        }
        shown.push(row);
        if (row.end !== null && row.end !== undefined) previous = row.end;
    }
    return {
        view: detailed ? 'detailed' : 'simple',
        /* Simple says only what asks for the person, and not twice: that it waits, when no question already says so. */
        status: detailed
            ? { state: status?.state ?? 'none', text: status ? `${state(status.state)}${(doingNow(status) || status.note) ? ` - ${doingNow(status) || status.note}` : ''}` : said(words, 'no-status'), when: status ? whole(stamp(status.at), locale) : '' }
            : status?.state === 'waiting' && !asking ? { state: 'waiting', text: `${state('waiting')}${status.note ? ` - ${status.note}` : ''}`, when: '' } : null,
        empty: messages.length === 0 && rows.length === 0 ? said(words, 'empty') : null,
        rows: shown.map(({ at, end, ...row }) => row),
        items: items.map(({ at, type, key, ...item }) => item),
        unread: Number(data?.unread) || 0,
        files: detailed ? files.map((f) => ({ path: String(f.path ?? ''), name: nameOf(f.path), note: String(f.note ?? ''), open: typeof f.open === 'string' ? f.open : null, when: whole(stamp(f.at), locale) })) : [],
        summary: detailed ? `${said(words, 'files')} (${files.length})` : '',
    };
}

const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const button = (text, className, act) => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', act); return b; };

export function mount(root, { load, send, words = {}, open, terminal, remind, view: first = 'simple', onView, every = 3000, locale } = {}) {
    let as = VIEWS.includes(first) ? first : 'simple';
    let shown = '';
    let count = 0;
    let latest;
    let folded = true;
    /* Steps the person opened or closed, by group: kept while the page is drawn again. */
    const unfolded = new Map();
    let revealed = '';
    /* Kept at the newest, as a chat is, until the reader scrolls up; and again once back down. */
    let sticky = true;
    root.classList.add('parley');
    const top = el('div', 'parley-top');
    const status = el('p', 'parley-status'); status.setAttribute('role', 'status');
    const switcher = el('div', 'parley-views'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', said(words, 'view'));
    const repaint = () => { shown = ''; if (latest) paint(latest); };
    const choose = (v) => { if (v === as) return; as = v; root.dataset.view = as; unfolded.clear(); try { onView?.(as); } catch { /* the page's business */ } repaint(); void refresh(); };
    const toggles = VIEWS.map((v) => { const b = button(said(words, v), '', () => choose(v)); b.dataset.view = v; return b; });
    switcher.append(...toggles);
    top.append(status, switcher);
    const main = el('div', 'parley-main');
    const thread = el('div', 'parley-thread'); thread.setAttribute('aria-live', 'polite');
    const aside = el('aside', 'parley-aside');
    main.append(thread, aside);
    const form = el('form', 'parley-form'); form.autocomplete = 'off';
    const box = el('textarea', 'parley-box'); box.rows = 2; box.maxLength = 4000; box.placeholder = said(words, 'placeholder'); box.setAttribute('aria-label', said(words, 'placeholder'));
    const go = el('button', 'parley-send', said(words, 'send')); go.type = 'submit';
    const problem = el('p', 'parley-problem'); problem.hidden = true; problem.setAttribute('role', 'alert');
    form.append(box, go);
    root.replaceChildren(top, main, form, problem);
    root.dataset.view = as;
    const narrow = () => root.clientWidth > 0 && root.clientWidth < NARROW_PX;
    let wasNarrow = narrow();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); repaint(); } }) : null;
    watch?.observe(root);
    const say = async (text, answers) => {
        problem.hidden = true;
        try { await send(text, answers); await refresh(); } catch (error) { problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) }); problem.hidden = false; }
    };
    const fileButton = (file) => (file.open === null || !open ? null : button(said(words, 'open'), 'parley-open', () => open(file)));
    const time = (text, when) => { const t = el('time', 'parley-time', text); if (when) t.title = when; return t; };
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
        if (row.type === 'now') {
            const holder = el('div', 'parley-now'); holder.dataset.live = String(row.live);
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
        const bubble = el('div', 'parley-said'); bubble.dataset.from = item.from; bubble.dataset.kind = item.kind; bubble.dataset.id = item.id; if (item.open) bubble.dataset.open = 'true';
        if (item.id && item.id === revealed) bubble.dataset.reveal = 'true';
        if (item.when) bubble.title = item.when;
        if (item.label) bubble.append(el('p', 'parley-label', item.label));
        bubble.append(el('p', 'parley-text', item.text));
        if (item.file) {
            const row2 = el('div', 'parley-file');
            if (item.file.shown) row2.append(el('span', 'parley-path', item.file.shown));
            const b = fileButton(item.file); if (b) row2.append(b);
            if (row2.childNodes.length) bubble.append(row2);
            if (item.outside) bubble.append(el('p', 'parley-outside', item.outside));
        }
        if (item.choices.length > 0) {
            const choices = el('div', 'parley-choices');
            for (const choice of item.choices) choices.append(button(choice, '', () => { for (const x of choices.children) x.disabled = true; void say(choice, item.id); }));
            bubble.append(choices);
        }
        if (item.mark) {
            const foot = el('p', 'parley-foot', item.mark);
            if (remind && v.view === 'detailed') {
                foot.append(' ', button(said(words, 'remind'), 'parley-remind', async (event) => { event.target.disabled = true; try { await remind(); event.target.textContent = said(words, 'reminded'); } catch { event.target.disabled = false; } }));
            }
            bubble.append(foot);
        }
        if (item.time) bubble.append(time(item.trail ? `${item.time} - ${item.trail.label}` : item.time, item.when));
        if (!item.trail) return bubble;
        /* The steps that led to it, opened by a click on it: above it, as they came. */
        const list = trail(item.trail.steps);
        list.dataset.for = item.id;
        bubble.dataset.steps = 'true'; bubble.tabIndex = 0;
        folding(item.trail, bubble, bubble, list, { only: (event) => !(event.target instanceof Element && event.target.closest('button, a')) && !String(globalThis.getSelection?.() ?? '') });
        return [list, bubble];
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
    function paint(data) {
        latest = data;
        const v = view(data, { words, view: as, locale });
        const small = narrow();
        const mark = JSON.stringify([v, small]);
        if (mark === shown) return;
        shown = mark;
        for (const b of toggles) b.setAttribute('aria-pressed', String(b.dataset.view === v.view));
        status.hidden = !v.status;
        if (v.status) { status.dataset.state = v.status.state; status.textContent = v.status.text; status.title = [v.status.text, v.status.when].filter(Boolean).join(' - '); }
        /* The newest is shown: when something new came, and when the reader was at the bottom already. */
        const atBottom = sticky || v.items.length > count;
        count = v.items.length;
        thread.replaceChildren(...v.rows.flatMap((row) => rowOf(row, v)));
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
                fold.append(el('summary', '', v.summary), sideOf(v));
                aside.replaceChildren(fold, ...way);
            } else aside.replaceChildren(sideOf(v), ...way);
        }
        if (atBottom) { bottom(); sticky = true; requestAnimationFrame(bottom); }
    }
    thread.addEventListener('scroll', () => { sticky = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40; }, { passive: true });
    /* The page around it settles (fonts, a keyboard, a turned phone): the newest stays in sight. */
    const settle = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (sticky) bottom(); }) : null;
    settle?.observe(thread);
    async function refresh() { try { paint(await load()); } catch { /* shown again at the next look */ } }
    /* A long press on a touch screen shows a message's time, as hovering does with a mouse. */
    let pressing;
    let hiding;
    const unpress = () => { clearTimeout(pressing); pressing = undefined; };
    thread.addEventListener('pointerdown', (event) => {
        const bubble = event.target instanceof Element ? event.target.closest('.parley-said') : null;
        if (!bubble || event.pointerType === 'mouse') return;
        unpress();
        pressing = setTimeout(() => {
            for (const other of thread.querySelectorAll('.parley-said[data-reveal]')) delete other.dataset.reveal;
            bubble.dataset.reveal = 'true'; revealed = bubble.dataset.id ?? '';
            clearTimeout(hiding);
            hiding = setTimeout(() => { revealed = ''; for (const other of thread.querySelectorAll('.parley-said[data-reveal]')) delete other.dataset.reveal; }, 4000);
        }, PRESS_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) thread.addEventListener(type, unpress, { passive: true });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        void say(text);
    });
    /* With a keyboard, Enter sends and Shift+Enter is a new line, as in every
       chat; on a touch screen Enter is a new line and the button sends. */
    const keyboard = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    box.addEventListener('keydown', (event) => { if (keyboard && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    /* What it does now stops moving once it is old: looked at again now and then, data or not. */
    const timer = every > 0 ? setInterval(() => { if (!document.hidden) void refresh(); }, every) : null;
    void refresh();
    return { refresh, get view() { return as; }, set view(v) { if (VIEWS.includes(v)) choose(v); }, destroy() { if (timer) clearInterval(timer); clearTimeout(hiding); unpress(); watch?.disconnect(); settle?.disconnect(); root.replaceChildren(); root.classList.remove('parley'); delete root.dataset.view; } };
}
