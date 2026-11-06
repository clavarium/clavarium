/* THE KIT (05-11): the small pieces every screen shares, one implementation each -- a screen is only a
 * frame that places them (05-11: the kit, then the conversation card).
 *
 *   StatusDot      the point of a state: problem · wait · work · busy · ok · sleep (the list's six)
 *   Avatar         an initial on a colour drawn from the name (always the same for the same name)
 *   Chips          small pills: what waits, its room, its boxes, a mark
 *   Switch         yes / no (role=switch, aria-checked)
 *   Segmented      one of a few (pressed buttons, aria-pressed)
 *   InlineConfirm  confirm in place of the button: Keep, then the action
 *   ConvCard       ONE CONVERSATION, three sizes: `row` (the list, Recent), `card` (the home deck),
 *                  `member` (a room's members, and the one that welcomes it). Same dot, name, line
 *                  of what it does now, chips; each place adds its own gestures (`actions`).
 *   StepFlow       the steps of a gesture, the one at hand marked, "2 / 3"
 *   SecretPicker   a key to choose, or "+ New key…" made in place
 *   NewAsset       ONE BOX to make an asset (05-11, step 3): kinds, the kind's form, one ending;
 *                  opened with a context (a conversation it will be attached to). A voice box and
 *                  a device are two of its kinds too (step 4).
 *   ShareDonut     who takes a whole (memory, a disk): a small donut, its slices from shareSlices, the main
 *                  figure in its middle; ShareKey, a slice's swatch beside its row in the list
 *
 * No framework: each piece is a function that returns an element. Words: English here; the page
 * hands its own (`setWords`, app.js `uiSaid`) for the few the kit says by itself.
 * Loaded before app.js (index.html, device.html): window.clavariumKit. */
(() => {
    /* THE STATES, worst first (the order a folded group sums them in). */
    const STATES = ['problem', 'wait', 'work', 'busy', 'ok', 'sleep'];
    const STATE_WORDS = { problem: 'a problem', wait: 'waits for you', work: 'at work', busy: 'busy', ok: 'fine', sleep: 'asleep' };
    /* Older names some places used for the same states: one vocabulary from now on. */
    const ALIASES = { ready: 'ok', online: 'ok', idle: 'ok', done: 'ok', waits: 'wait', waiting: 'wait', working: 'work', asleep: 'sleep', off: 'sleep', failed: 'problem', bad: 'problem' };
    const stateOf = (s) => (STATES.includes(s) ? s : ALIASES[s] ?? 'ok');

    let words = (key, fallback) => fallback;
    const say = (key, fallback) => { try { const w = words(key, fallback); return typeof w === 'string' && w ? w : fallback; } catch { return fallback; } };

    /* A colour of its own, from its name: the same name, the same colour, on every screen. */
    const hueOf = (text) => { let h = 0; for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; };
    const initialOf = (name) => ([...String(name ?? '').trim()][0] ?? '?').toUpperCase();

    const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };

    function StatusDot({ state = 'ok', label = '' } = {}) {
        const d = node('span', 'state-dot'); d.dataset.state = stateOf(state);
        if (label) d.title = label;
        return d;
    }

    /* `glyph`: an element drawn in place of the initial (a room's sign). */
    function Avatar({ name = '', glyph = null, hue } = {}) {
        const a = node('span', 'kit-av'); a.setAttribute('aria-hidden', 'true');
        a.style.setProperty('--h', String(hue ?? hueOf(name)));
        if (glyph) a.append(glyph); else a.textContent = initialOf(name);
        return a;
    }

    /* A chip: { text, cls?, tone?: 'need' | 'note', icon?: 'room' | 'box', title? }. Empty: nothing. */
    function Chips(list = []) {
        const shown = list.filter((c) => c && c.text !== undefined && c.text !== '');
        if (!shown.length) return null;
        const box = node('span', 'kit-chips');
        for (const c of shown) {
            const chip = node('small', `kit-chip${c.cls ? ` ${c.cls}` : ''}`);
            if (c.tone) chip.dataset.tone = c.tone;
            if (c.icon) { const i = node('span', `kit-chip-ic kit-ic-${c.icon}`); i.setAttribute('aria-hidden', 'true'); chip.append(i); }
            chip.append(String(c.text));
            if (c.title) chip.title = c.title;
            box.append(chip);
        }
        return box;
    }

    /* Yes / no. `onChange(on)`; the page paints again, or calls `.set(on)`. */
    function Switch({ on = false, label = '', onChange = () => {}, disabled = false } = {}) {
        const b = node('button', 'kit-switch'); b.type = 'button';
        b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(Boolean(on)));
        if (label) b.setAttribute('aria-label', label);
        if (disabled) b.disabled = true;
        b.set = (v) => b.setAttribute('aria-checked', String(Boolean(v)));
        b.addEventListener('click', () => { const next = b.getAttribute('aria-checked') !== 'true'; b.set(next); onChange(next); });
        return b;
    }

    /* One of a few: `options` [{ value, label }], the chosen one pressed. `onChange(value)`. */
    function Segmented({ options = [], value, label = '', onChange = () => {} } = {}) {
        const g = node('div', 'kit-seg'); g.setAttribute('role', 'group');
        if (label) g.setAttribute('aria-label', label);
        const buttons = options.map((o) => {
            const b = node('button', '', o.label ?? o.value); b.type = 'button'; b.dataset.value = String(o.value);
            b.addEventListener('click', () => { g.set(o.value); onChange(o.value); });
            return b;
        });
        g.set = (v) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(v))); };
        g.append(...buttons); g.set(value);
        return g;
    }

    /* Confirm in place of `button`: the question, Keep (focused), then the action. Escape keeps.
       Returns { close }. `onYes()` may be async; the action stays pressed till it is done. */
    function InlineConfirm(button, { question = '', yes = 'Remove', keep, danger = true, onYes = () => {} } = {}) {
        const ask = node('span', 'kit-confirm'); ask.setAttribute('role', 'alertdialog');
        if (question) ask.append(node('span', 'kit-confirm-q', question));
        const k = node('button', '', keep ?? say('kit-keep', 'Keep')); k.type = 'button';
        const y = node('button', danger ? 'danger' : 'primary', yes); y.type = 'button';
        ask.append(k, y);
        const close = () => { if (ask.isConnected) { ask.replaceWith(button); button.focus?.(); } };
        k.addEventListener('click', close);
        ask.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
        y.addEventListener('click', async () => { y.disabled = k.disabled = true; try { await onYes(); } finally { y.disabled = k.disabled = false; } });
        button.replaceWith(ask); k.focus?.();
        return { close, element: ask };
    }

    /* ONE CONVERSATION (or a room, drawn the same). `m`, what the page knows of it, said once:
         title     its free name                       state, stateLabel   its point
         avatar    { name, glyph?, hue? }              when                when it was last used ('' : none)
         last      its last words ('' : none)          now                 what it does now ('' : nothing to say)
         who       its assistant · its tool            chips               [{ text, cls?, tone?, icon?, wide? }]
       `size`: 'row' | 'card' | 'member'. A `wide` chip (its room, its boxes) is said on a card only; a
       member says only what waits for you (tone 'need' or 'count').
       `tag`: 'button' (opens it: `onOpen`) or 'div' (a member: its gestures are `actions`). `cls`: the
       page's own classes, kept for its rules and tests. */
    function ConvCard(m, { size = 'row', tag, cls = '', onOpen = null, actions = [] } = {}) {
        const t = tag ?? (size === 'member' ? 'div' : 'button');
        const root = node(t, `kit-conv kit-conv-${size}${cls ? ` ${cls}` : ''}`);
        if (t === 'button') root.type = 'button';
        const state = stateOf(m.state);
        root.append(Avatar(m.avatar ?? { name: m.title }), StatusDot({ state, label: m.stateLabel ?? STATE_WORDS[state] }));
        const main = node('span', 'kit-conv-main');
        const head = node('span', 'kit-conv-head');
        head.append(node('b', '', m.title ?? ''));
        /* A row (05-11, the designers' review): its unread count beside its time, its marks as small words on
           the line below, beside its last words -- one line less than pills. */
        const counts = size === 'row' ? (m.chips ?? []).filter((c) => c && !c.wide && c.tone === 'count') : [];
        const countChips = Chips(counts);
        if (countChips) head.append(countChips);
        if (m.when) head.append(node('small', 'when', m.when));
        main.append(head);
        const lines = [];
        if (size === 'row') {
            const marks = Chips((m.chips ?? []).filter((c) => c && !c.wide && c.tone !== 'count'));
            const sub = [m.last ? node('small', 'last', m.last) : null, m.now ? node('small', 'kit-conv-now', m.now) : null].filter(Boolean);
            if (marks && sub.length) { const line = node('span', 'kit-conv-sub'); line.append(sub[0], marks); lines.push(line, ...sub.slice(1)); }
            else if (marks) lines.push(marks);
            else lines.push(...sub);
        } else if (size === 'card') {
            if (m.last) lines.push(node('small', 'last', m.last));
            const what = [m.now, m.who].filter(Boolean).join(' · ');
            if (what) lines.push(node('small', 'kit-conv-now', what));
        } else {
            const what = [m.who, m.now].filter(Boolean).join(' · ');
            if (what) lines.push(node('small', 'kit-conv-now', what));
        }
        main.append(...lines);
        /* Its chips by place: all on a card; a row leaves out the wide ones; a member only what waits for you. */
        const chips = size === 'row' ? null : Chips((m.chips ?? []).filter((c) => c && (size === 'card' || c.tone === 'need' || c.tone === 'count')));
        if (chips) main.append(chips);
        root.append(main);
        if (actions.length) { const acts = node('span', 'kit-conv-acts'); acts.append(...actions.filter(Boolean)); root.append(acts); }
        if (onOpen && t === 'button') root.addEventListener('click', () => onOpen());
        return root;
    }

    /* The steps of a gesture: done ones ticked, the one at hand `aria-current="step"`, and "2 / 3".
       `at`: the step at hand (0 is the first); `steps.length`: all done. */
    function StepFlow({ steps = [], at = 0, label = '' } = {}) {
        const box = node('div', 'kit-steps');
        const list = node('ol', 'kit-steps-list');
        if (label) list.setAttribute('aria-label', label);
        steps.forEach((s, i) => {
            const li = node('li', i < at ? 'done' : '');
            if (i === at) li.setAttribute('aria-current', 'step');
            const n = node('span', 'kit-step-n', i < at ? '✓' : String(i + 1)); n.setAttribute('aria-hidden', 'true');
            li.append(n, node('span', 'kit-step-w', s));
            list.append(li);
        });
        box.append(list, node('small', 'kit-steps-count', `${Math.min(at + 1, steps.length)} / ${steps.length}`));
        return box;
    }

    /* A KEY TO CHOOSE, or one made in place: its keys, then "+ New key…" opens a name and Create right
       there. `ids` keeps the page's names for its parts { select, add, row, name, go }. `keys` [{ value,
       label }]; `none`: said when there is none. `suggest()`: the name offered; `onMake(name)`: the page
       makes it (and calls `.set` with the new list). `.set(keys, chosen)` fills it again, the chosen kept. */
    function SecretPicker({ ids = {}, keys = [], value = '', label = '', none = '', addLabel, makeLabel, nameLabel = '', nameAttrs = {}, suggest = () => '', onMake = async () => {}, onChange = () => {} } = {}) {
        const box = node('div', 'kit-secret');
        const select = node('select'); if (ids.select) select.id = ids.select;
        if (label) select.setAttribute('aria-label', label);
        const add = node('button', 'kit-secret-add', addLabel ?? say('kit-new-key', '+ New key…')); add.type = 'button'; if (ids.add) add.id = ids.add;
        const pick = node('div', 'row'); pick.append(select, add);
        const make = node('div', 'row kit-secret-make'); if (ids.row) make.id = ids.row; make.hidden = true;
        const name = node('input'); if (ids.name) name.id = ids.name;
        if (nameLabel) name.setAttribute('aria-label', nameLabel);
        for (const [k, v] of Object.entries(nameAttrs)) name.setAttribute(k, v);
        const go = node('button', 'primary', makeLabel ?? say('kit-create', 'Create')); go.type = 'button'; if (ids.go) go.id = ids.go;
        make.append(name, go);
        box.append(pick, make);
        box.set = (list, chosen = select.value) => {
            select.replaceChildren();
            if (!list.length && none) { const o = node('option', '', none); o.value = ''; select.append(o); }
            for (const k of list) { const o = node('option', '', k.label ?? k.value); o.value = k.value; select.append(o); }
            if (list.some((k) => k.value === chosen)) select.value = chosen;
        };
        box.set(keys, value);
        select.addEventListener('change', () => onChange(select.value));
        add.addEventListener('click', () => { name.value = suggest() ?? ''; make.hidden = false; name.focus?.(); });
        go.addEventListener('click', async () => {
            go.disabled = true;
            try { if ((await onMake(name.value.trim())) !== false) make.hidden = true; } finally { go.disabled = false; }
        });
        return box;
    }

    /* NEW ASSET: ONE BOX, wherever an asset is made (Assets, a conversation's Attach). Its kinds, then
       that kind's form (the page's own: `form(kind)`), then one ending: "✓ <name> created", Create
       another, Done. Opened with a context, it says it on top (`context`: { line, level? }, `level` a
       Segmented's options) and the page attaches what is made at the end. `existing`: what is there
       already, offered above "or a new one". `made`: { said, note? } draws the ending.
         kinds  [{ kind, label, icon? }]     kind   '' : choose one       words  { title, there, orNew, steps[3], back, another, done }
       `onBack`: a way back to the kinds from a form, where the frame has none of its own.
       `at`: the step at hand, for a kind of more steps than one (a voice box: where, plug it, pair it). */
    function NewAsset({ kinds = [], kind = '', made = null, context = null, existing = null, form = () => null, words: w = {}, at = null, onKind = () => {}, onBack = null, onAnother = () => {}, onDone = () => {} } = {}) {
        const root = node('div', 'kit-newasset');
        root.dataset.step = made ? 'done' : kind ? 'form' : 'kind';
        const steps = w.steps ?? [say('kit-step-kind', 'Kind'), say('kit-step-set', 'Set up'), say('kit-step-made', 'Created')];
        if (context) {
            const top = node('div', 'kit-na-context');
            top.append(node('span', '', context.line ?? ''));
            if (context.level) top.append(Segmented(context.level));
            root.append(top);
        }
        const head = node('div', 'kit-na-head');
        const title = w.title ?? say('kit-new-asset', 'New asset');
        if (!kind && !made && title) head.append(node('h3', '', title));
        head.append(StepFlow({ steps, at: made ? steps.length : kind ? (Number.isInteger(at) ? at : 1) : 0 }));
        root.append(head);
        if (made) {
            const end = node('div', 'kit-na-made');
            const line = node('p', ''); line.setAttribute('role', 'status');
            line.append(StatusDot({ state: 'ok' }), node('span', '', `✓ ${made.said}`));
            end.append(line);
            if (made.note) end.append(node('p', 'hint', made.note));
            const acts = node('div', 'row kit-na-acts');
            const again = node('button', '', w.another ?? say('kit-create-another', 'Create another')); again.type = 'button'; again.dataset.act = 'another';
            const done = node('button', 'primary', w.done ?? say('kit-done', 'Done')); done.type = 'button'; done.dataset.act = 'done';
            again.addEventListener('click', () => onAnother());
            done.addEventListener('click', () => onDone());
            acts.append(again, done); end.append(acts);
            root.append(end);
            return root;
        }
        if (kind) {
            /* Back to the kinds, when the frame has no way back of its own. */
            if (onBack) { const back = node('button', 'as-link kit-na-back', `\u2039 ${w.back ?? say('kit-back', 'Back')}`); back.type = 'button'; back.addEventListener('click', () => onBack()); root.append(back); }
            const f = form(kind); if (f) root.append(f);
            return root;
        }
        if (existing) root.append(node('h4', 'kit-na-sub', w.there ?? say('kit-already-there', 'Already there')), existing, node('h4', 'kit-na-sub', w.orNew ?? say('kit-or-new', 'or a new one')));
        /* `.as-kinds`, `data-kind`: the names the page's rules and tests know. */
        const list = node('div', 'as-kinds');
        for (const k of kinds) {
            const b = node('button', '', k.label ?? k.kind); b.type = 'button'; b.dataset.kind = k.kind;
            if (k.icon) b.prepend(k.icon);
            b.addEventListener('click', () => onKind(k.kind));
            list.append(b);
        }
        root.append(list);
        return root;
    }

    /* WHO TAKES IT (06-11): one whole -- a server's memory or a disk -- split by who takes it: each machine
       (the largest first, at most `max`, the rest folded into "Others"), the rest of the system, and what is
       free. `parts` [{ key, label, mb }]. A machine keeps its colour while the page lives (`slots`, shared by
       the memory and the disks: a colour follows the machine, never its rank). Slots 1..6 are Parley's chart
       colours (--parley-s1..s6); 0 is "Others"; 'rest' and 'free' are neutral. */
    function shareSlices(parts, { restMb = 0, freeMb = 0, max = 6, slots = new Map(), words: w = {} } = {}) {
        const most = Math.max(1, Math.min(6, max));
        const sorted = (parts ?? []).filter((x) => Number.isFinite(x?.mb) && x.mb > 0).sort((a, b) => b.mb - a.mb);
        const shown = sorted.length > most ? sorted.slice(0, most) : sorted;
        const folded = sorted.slice(shown.length);
        const used = new Set();
        const held = new Set(slots.values());
        const out = shown.map((x) => {
            let s = slots.get(x.key);
            if (!s || used.has(s)) s = [1, 2, 3, 4, 5, 6].find((n) => !used.has(n) && !held.has(n)) ?? [1, 2, 3, 4, 5, 6].find((n) => !used.has(n));
            slots.set(x.key, s); held.add(s); used.add(s);
            return { key: x.key, label: x.label, mb: x.mb, slot: s };
        });
        if (folded.length) out.push({ key: 'others', label: w.others ?? 'Others', mb: folded.reduce((a, x) => a + x.mb, 0), slot: 0, keys: folded.map((x) => x.key) });
        if (restMb > 0) out.push({ key: 'rest', label: w.rest ?? 'System and others', mb: restMb, slot: 'rest' });
        if (freeMb > 0) out.push({ key: 'free', label: w.free ?? 'Free', mb: freeMb, slot: 'free' });
        const total = out.reduce((a, x) => a + x.mb, 0);
        for (const x of out) x.share = total > 0 ? x.mb / total : 0;
        return out;
    }
    const sharePct = (x) => `${x.share > 0 && x.share < 0.01 ? '<1' : Math.round(x.share * 100)} %`;
    /* The swatch of a slice, beside its row in the list (the list is the legend). */
    function ShareKey(slot) { const k = node('span', 'share-key'); k.dataset.s = String(slot); k.setAttribute('aria-hidden', 'true'); return k; }
    const SVG = 'http://www.w3.org/2000/svg';
    const svgNode = (tag, cls) => { const e = document.createElementNS(SVG, tag); if (cls) e.setAttribute('class', cls); return e; };
    /* A SMALL DONUT of those slices (a "camembert"), its size set by the page's style; in its middle the main
       figure (`center`: { top, main, sub }), or the slice under the pointer or the finger: its name, its size,
       its share. Said whole to a screen reader. */
    function ShareDonut({ slices = [], label = '', fmt = (mb) => `${mb} MB`, center = {} } = {}) {
        const root = node('div', 'share-donut');
        const svg = svgNode('svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${label}: ${slices.map((x) => `${x.label} ${fmt(x.mb)} ${sharePct(x)}`).join('; ')}`);
        const R = 40; const C = 2 * Math.PI * R; const gap = slices.length > 1 ? 1.2 : 0;
        const mid = node('div', 'share-mid'); mid.setAttribute('aria-hidden', 'true');
        const top = node('span', 'share-mid-top'); const main = node('b', 'share-mid-main'); const sub = node('span', 'share-mid-sub');
        mid.append(top, main, sub);
        const say = (t, m, b) => { top.textContent = t ?? ''; main.textContent = m ?? ''; sub.textContent = b ?? ''; };
        const rest = () => { say(center.top, center.main, center.sub); for (const a of arcs) a.removeAttribute('data-on'); svg.removeAttribute('data-on'); };
        let at = 0; let on = null;
        const arcs = slices.map((x) => {
            const len = x.share * C;
            const a = svgNode('circle', 'share-arc'); a.dataset.s = String(x.slot);
            for (const [k, v] of [['cx', 50], ['cy', 50], ['r', R], ['stroke-dasharray', `${Math.max(0.6, len - gap).toFixed(2)} ${C.toFixed(2)}`], ['stroke-dashoffset', (-at).toFixed(2)], ['transform', 'rotate(-90 50 50)']]) a.setAttribute(k, String(v));
            at += len;
            const show = () => { on = x.key; for (const o of arcs) o.setAttribute('data-on', String(o === a)); svg.setAttribute('data-on', 'true'); say(x.label, fmt(x.mb), sharePct(x)); };
            a.addEventListener('pointerenter', (event) => { if (event?.pointerType !== 'touch') show(); });
            /* A tap shows it; a second tap on the same slice puts the main figure back (a mouse's click only shows). */
            a.addEventListener('click', (event) => { if (event?.pointerType !== 'mouse' && on === x.key && svg.getAttribute('data-on')) { on = null; rest(); } else show(); });
            return a;
        });
        svg.addEventListener('pointerleave', (event) => { if (event?.pointerType !== 'touch') { on = null; rest(); } });
        svg.append(...arcs);
        rest();
        root.append(svg, mid);
        return root;
    }

    window.clavariumKit = {
        shareSlices, ShareDonut, ShareKey,
        STATES, STATE_WORDS, stateOf, hueOf, initialOf,
        setWords(fn) { if (typeof fn === 'function') words = fn; },
        StatusDot, Avatar, Chips, Switch, Segmented, InlineConfirm, ConvCard, StepFlow, SecretPicker, NewAsset,
    };
})();
